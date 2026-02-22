"""
Script: streaming.py
Created: 2026-02-22
Purpose: SSE subscriber management for real-time trace streaming
Keywords: streaming, sse, subscribers, realtime, tracehub
Status: active
Prerequisites:
  - asyncio
Changelog:
  - 2026-02-22: Extracted from server.py during package refactor
See-Also: .claude/CLAUDE.md ##Управление скриптами
"""

import asyncio
import time

from .config import _subscribers, _subscriber_timestamps
from .models import TraceEntry


async def subscribe(correlation_id: str) -> asyncio.Queue:
    """Subscribe to real-time updates for a correlation ID."""
    if correlation_id not in _subscribers:
        _subscribers[correlation_id] = []
    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers[correlation_id].append(queue)
    _subscriber_timestamps[correlation_id] = time.time()
    return queue


def unsubscribe(correlation_id: str, queue: asyncio.Queue):
    """Unsubscribe from updates."""
    if correlation_id in _subscribers:
        try:
            _subscribers[correlation_id].remove(queue)
            if not _subscribers[correlation_id]:
                del _subscribers[correlation_id]
        except ValueError:
            pass


async def notify_subscribers(trace: TraceEntry):
    """Notify all subscribers for a correlation ID."""
    corr_id = trace.correlation_id
    if corr_id in _subscribers:
        dead_queues = []
        for queue in _subscribers[corr_id]:
            try:
                queue.put_nowait(trace)
            except asyncio.QueueFull:
                dead_queues.append(queue)
            except Exception:
                dead_queues.append(queue)
        for q in dead_queues:
            try:
                _subscribers[corr_id].remove(q)
            except ValueError:
                pass
        if not _subscribers[corr_id]:
            del _subscribers[corr_id]
            _subscriber_timestamps.pop(corr_id, None)


async def cleanup_stale_subscribers():
    """Remove subscriber entries older than 5 minutes with no active queues."""
    cutoff = time.time() - 300
    stale = [
        cid for cid, ts in _subscriber_timestamps.items()
        if ts < cutoff
    ]
    for cid in stale:
        if cid in _subscribers:
            del _subscribers[cid]
        _subscriber_timestamps.pop(cid, None)
