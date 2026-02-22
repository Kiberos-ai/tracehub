"""
Script: endpoints.py
Created: 2026-02-22
Purpose: All HTTP route handlers for TraceHub server
Keywords: endpoints, routes, api, fastapi, tracehub
Status: active
Prerequisites:
  - fastapi, aiosqlite
Changelog:
  - 2026-02-22: Extracted from server.py during package refactor
See-Also: .claude/CLAUDE.md ##Управление скриптами
"""

import asyncio
import json
import os
import time
from typing import AsyncGenerator, Optional

import aiosqlite
from fastapi import APIRouter, Query, HTTPException, Depends
from fastapi.responses import StreamingResponse

from .config import (
    TRACEHUB_DB, TRACEHUB_RETENTION_HOURS,
    _subscribers, _stats, _recent_rate_window,
    _source_ingest_window, _source_ingest_totals,
)
from .adaptive import mark_hot, get_state
from .db import insert_trace, query_traces, list_recent_correlations, cleanup_old_traces
from .models import TraceEntry, TraceIngestRequest, TraceQueryResponse, verify_secret
from .streaming import subscribe, unsubscribe, notify_subscribers


router = APIRouter()


@router.post("/ingest", tags=["ingest"], dependencies=[Depends(verify_secret)])
async def ingest_traces(request: TraceIngestRequest):
    """
    Ingest batch of traces from checkpoint loggers.

    Requires X-TraceHub-Secret header if TRACEHUB_SECRET is configured.

    Called by checkpoint_logger when TRACEHUB_URL is set.
    Deduplicates by (correlation_id, timestamp, suffix).
    """
    inserted = 0
    now = time.time()
    for trace in request.traces:
        if await insert_trace(trace):
            inserted += 1
            await notify_subscribers(trace)
        # Track per-source rates
        sid = trace.source_id
        _source_ingest_window.setdefault(sid, []).append(now)
        _source_ingest_totals[sid] = _source_ingest_totals.get(sid, 0) + 1

    _stats["ingest_total"] += inserted
    _stats["ingest_duplicates"] += len(request.traces) - inserted

    return {
        "accepted": len(request.traces),
        "inserted": inserted,
        "duplicates": len(request.traces) - inserted,
    }


@router.post("/ingest/single", tags=["ingest"], dependencies=[Depends(verify_secret)])
async def ingest_single_trace(trace: TraceEntry):
    """Ingest single trace entry. Requires X-TraceHub-Secret header if configured."""
    inserted = await insert_trace(trace)
    if inserted:
        await notify_subscribers(trace)
    return {"inserted": inserted}


@router.get("/recent", tags=["query"])
async def get_recent_traces(
    limit: int = Query(200, description="Max traces to return", le=1000),
    since_id: Optional[int] = Query(None, description="Return traces with id > since_id"),
    source: Optional[str] = Query(None, description="Filter by source ID prefix"),
):
    """Get most recent traces across all correlations. Fast — uses id index."""
    now = time.time()
    _recent_rate_window.append(now)
    _stats["recent_requests"] += 1
    # Rate limit: max 30 requests per 60 seconds
    recent_count = sum(1 for t in _recent_rate_window if now - t < 60)
    if recent_count > 30:
        raise HTTPException(status_code=429, detail="Rate limit exceeded: max 30 requests/minute")
    async with aiosqlite.connect(TRACEHUB_DB) as db:
        db.row_factory = aiosqlite.Row
        query = "SELECT * FROM traces"
        params: list = []
        conditions = []
        if since_id is not None:
            conditions.append("id > ?")
            params.append(since_id)
        if source:
            conditions.append("source_id LIKE ?")
            params.append(f"{source}%")
        # Exclude catch-all correlation
        conditions.append("correlation_id != '-'")
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        async with db.execute(query, params) as cursor:
            rows = await cursor.fetchall()
            traces = []
            for row in rows:
                traces.append({
                    "id": row["id"],
                    "source_id": row["source_id"],
                    "correlation_id": row["correlation_id"],
                    "timestamp": row["timestamp"],
                    "direction": row["direction"],
                    "operation": row["operation"],
                    "endpoint": row["endpoint"],
                    "data": json.loads(row["data"]) if row["data"] else None,
                })
            traces.reverse()  # oldest first
            return {"traces": traces, "count": len(traces)}


@router.get("/traces/{correlation_id}", tags=["query"])
async def get_traces(
    correlation_id: str,
    source: Optional[str] = Query(None, description="Filter by source ID"),
):
    """
    Get all traces for a correlation ID.

    Returns traces ordered by timestamp ascending.
    Auto-activates HOT tracing on query (adaptive tracing).
    """
    previous_state = get_state(correlation_id)
    mark_hot(correlation_id)

    traces = await query_traces(correlation_id, source_id=source)

    # Check if trace appears complete (has matching entry/exit for main operation)
    entries = sum(1 for t in traces if t.direction == "->")
    exits = sum(1 for t in traces if t.direction == "<-")
    complete = entries > 0 and entries == exits

    result = TraceQueryResponse(
        correlation_id=correlation_id,
        traces=traces,
        count=len(traces),
        complete=complete,
    )
    response_data = result.model_dump()
    if previous_state == "cold":
        response_data["adaptive_hint"] = {
            "previous_state": "cold",
            "current_state": "hot",
            "message": "Tracing activated. Previous traces may be incomplete (COLD mode). Full recording started.",
            "retry_after_seconds": 45,
        }
    return response_data


@router.get("/traces/{correlation_id}/stream", tags=["query"])
async def stream_traces(
    correlation_id: str,
    timeout: int = Query(60, description="Stream timeout in seconds"),
):
    """
    Stream traces for a correlation ID in real-time (SSE).

    Use this for CLI real-time trace display.
    First sends all existing traces, then streams new ones.
    """
    async def event_generator() -> AsyncGenerator[str, None]:
        # Send existing traces first
        existing = await query_traces(correlation_id)
        for trace in existing:
            yield f"data: {trace.model_dump_json()}\n\n"

        # Subscribe to new traces
        queue = await subscribe(correlation_id)
        try:
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    trace = await asyncio.wait_for(queue.get(), timeout=1.0)
                    yield f"data: {trace.model_dump_json()}\n\n"
                except asyncio.TimeoutError:
                    # Send keepalive
                    yield f": keepalive\n\n"
        finally:
            unsubscribe(correlation_id, queue)

        yield f"data: {{\"type\": \"timeout\"}}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@router.get("/correlations", tags=["query"])
async def list_correlations(
    limit: int = Query(50, description="Max correlations to return"),
):
    """
    List recent correlation IDs with summary info.

    Useful for browsing recent traces.
    """
    correlations = await list_recent_correlations(limit)
    return {
        "correlations": correlations,
        "count": len(correlations),
    }


def _get_rss_mb() -> float:
    """Get current process RSS in MB."""
    try:
        with open(f"/proc/{os.getpid()}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except Exception:
        pass
    return 0.0


@router.get("/stats", tags=["admin"])
async def stats():
    """Server stats for monitoring. Shows memory usage, subscriber count, request rates."""
    now = time.time()
    uptime = now - _stats["started_at"]
    recent_rpm = sum(1 for t in _recent_rate_window if now - t < 60)

    # DB size
    db_size_mb = 0
    try:
        db_size_mb = round(os.path.getsize(TRACEHUB_DB) / (1024 * 1024), 2)
    except OSError:
        pass

    return {
        "uptime_seconds": int(uptime),
        "subscribers": {
            "active_correlations": len(_subscribers),
            "total_queues": sum(len(qs) for qs in _subscribers.values()),
        },
        "requests": {
            "ingest_total": _stats["ingest_total"],
            "ingest_duplicates": _stats["ingest_duplicates"],
            "recent_requests_total": _stats["recent_requests"],
            "recent_rpm": recent_rpm,
        },
        "database": {
            "path": TRACEHUB_DB,
            "size_mb": db_size_mb,
            "retention_hours": TRACEHUB_RETENTION_HOURS,
        },
        "memory": {
            "rss_mb": round(_get_rss_mb(), 1),
        },
        "top_sources": [
            {"source_id": sid, "rpm": sum(1 for t in _source_ingest_window.get(sid, []) if now - t < 60)}
            for sid in sorted(_source_ingest_totals, key=lambda s: _source_ingest_totals[s], reverse=True)[:5]
        ],
    }


@router.get("/stats/sources", tags=["admin"])
async def stats_sources():
    """Per-source ingest rates. Identifies top spammers."""
    now = time.time()
    sources = []
    for sid in sorted(
        set(list(_source_ingest_totals.keys()) + list(_source_ingest_window.keys()))
    ):
        window = _source_ingest_window.get(sid, [])
        rpm = sum(1 for t in window if now - t < 60)
        rp5m = len(window)
        sources.append({
            "source_id": sid,
            "total": _source_ingest_totals.get(sid, 0),
            "rpm": rpm,
            "rp5m": rp5m,
        })
    # Sort by rpm descending (highest spammers first)
    sources.sort(key=lambda s: s["rpm"], reverse=True)
    return {"sources": sources, "window_seconds": 300}


@router.get("/health", tags=["health"])
async def health():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "tracehub",
        "db": TRACEHUB_DB,
        "retention_hours": TRACEHUB_RETENTION_HOURS,
    }


@router.delete("/cleanup", tags=["admin"])
async def force_cleanup():
    """Force cleanup of old traces."""
    deleted = await cleanup_old_traces()
    return {"deleted": deleted}
