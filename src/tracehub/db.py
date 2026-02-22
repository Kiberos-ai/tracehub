"""
Script: db.py
Created: 2026-02-22
Purpose: SQLite database operations for TraceHub
Keywords: database, sqlite, storage, tracehub
Status: active
Prerequisites:
  - aiosqlite
Changelog:
  - 2026-02-22: Extracted from server.py during package refactor
See-Also: .claude/CLAUDE.md ##Управление скриптами
"""

import json
import time
from typing import Dict, List, Optional

import aiosqlite

from .config import TRACEHUB_DB, TRACEHUB_RETENTION_HOURS, _stats
from .models import TraceEntry


async def init_db():
    """Initialize SQLite database with traces table."""
    async with aiosqlite.connect(TRACEHUB_DB) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS traces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT NOT NULL,
                correlation_id TEXT NOT NULL,
                timestamp REAL NOT NULL,
                suffix TEXT NOT NULL,
                direction TEXT NOT NULL,
                operation TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                data TEXT,
                hostname TEXT,
                raw_line TEXT,
                created_at REAL DEFAULT (strftime('%s', 'now')),
                UNIQUE(correlation_id, timestamp, suffix)
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_correlation_id ON traces(correlation_id)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_timestamp ON traces(timestamp)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_source_id ON traces(source_id)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_dedup ON traces(source_id, correlation_id, endpoint, direction)
        """)
        await db.commit()


async def cleanup_old_traces():
    """Remove traces older than retention period."""
    cutoff = time.time() - (TRACEHUB_RETENTION_HOURS * 3600)
    async with aiosqlite.connect(TRACEHUB_DB) as db:
        result = await db.execute(
            "DELETE FROM traces WHERE created_at < ?",
            (cutoff,)
        )
        await db.commit()
        return result.rowcount


async def insert_trace(trace: TraceEntry) -> bool:
    """Insert single trace, return True if inserted (not duplicate).

    Polling dedup: if the same (source_id, correlation_id, endpoint, direction)
    was seen within the last 5 minutes, UPDATE that row instead of inserting.
    """
    now = time.time()
    async with aiosqlite.connect(TRACEHUB_DB) as db:
        try:
            cursor = await db.execute("""
                UPDATE traces SET timestamp = ?, created_at = ?
                WHERE source_id = ? AND correlation_id = ? AND endpoint = ? AND direction = ?
                AND created_at > ?
            """, (
                trace.timestamp, now,
                trace.source_id, trace.correlation_id,
                trace.endpoint, trace.direction,
                now - 300,
            ))
            await db.commit()
            if cursor.rowcount > 0:
                _stats.setdefault("ingest_deduped", 0)
                _stats["ingest_deduped"] += 1
                return False

            await db.execute("""
                INSERT OR IGNORE INTO traces
                (source_id, correlation_id, timestamp, suffix, direction,
                 operation, endpoint, data, hostname, raw_line)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                trace.source_id,
                trace.correlation_id,
                trace.timestamp,
                trace.suffix,
                trace.direction,
                trace.operation,
                trace.endpoint,
                json.dumps(trace.data) if trace.data else None,
                trace.hostname,
                trace.raw_line,
            ))
            await db.commit()
            return db.total_changes > 0
        except Exception:
            return False


async def query_traces(
    correlation_id: str,
    source_id: Optional[str] = None,
    since_ts: Optional[float] = None,
) -> List[TraceEntry]:
    """Query traces by correlation ID."""
    async with aiosqlite.connect(TRACEHUB_DB) as db:
        db.row_factory = aiosqlite.Row

        query = "SELECT * FROM traces WHERE correlation_id = ?"
        params = [correlation_id]

        if source_id:
            query += " AND source_id = ?"
            params.append(source_id)

        if since_ts:
            query += " AND timestamp > ?"
            params.append(since_ts)

        query += " ORDER BY timestamp ASC"

        async with db.execute(query, params) as cursor:
            rows = await cursor.fetchall()
            return [
                TraceEntry(
                    source_id=row["source_id"],
                    correlation_id=row["correlation_id"],
                    timestamp=row["timestamp"],
                    suffix=row["suffix"],
                    direction=row["direction"],
                    operation=row["operation"],
                    endpoint=row["endpoint"],
                    data=json.loads(row["data"]) if row["data"] else None,
                    hostname=row["hostname"],
                    raw_line=row["raw_line"],
                )
                for row in rows
            ]


async def list_recent_correlations(limit: int = 50) -> List[Dict]:
    """List recent correlation IDs with trace counts."""
    async with aiosqlite.connect(TRACEHUB_DB) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT correlation_id,
                   COUNT(*) as trace_count,
                   MIN(timestamp) as first_ts,
                   MAX(timestamp) as last_ts,
                   GROUP_CONCAT(DISTINCT source_id) as sources
            FROM traces
            GROUP BY correlation_id
            ORDER BY MAX(created_at) DESC
            LIMIT ?
        """, (limit,)) as cursor:
            rows = await cursor.fetchall()
            return [
                {
                    "correlation_id": row["correlation_id"],
                    "trace_count": row["trace_count"],
                    "first_ts": row["first_ts"],
                    "last_ts": row["last_ts"],
                    "duration_ms": int((row["last_ts"] - row["first_ts"])) if row["last_ts"] and row["first_ts"] else 0,
                    "sources": row["sources"].split(",") if row["sources"] else [],
                }
                for row in rows
            ]
