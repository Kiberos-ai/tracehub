"""
Script: app.py
Created: 2026-02-22
Purpose: FastAPI application factory and lifespan management for TraceHub
Keywords: fastapi, app, lifespan, cors, tracehub
Status: active
Prerequisites:
  - fastapi
Changelog:
  - 2026-02-22: Extracted from server.py during package refactor
See-Also: .claude/CLAUDE.md ##Управление скриптами
"""

import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .adaptive import router as adaptive_router, cooldown_tick, ADAPTIVE_TICK_INTERVAL
from .config import _recent_rate_window, _source_ingest_window
from .db import init_db, cleanup_old_traces
from .streaming import cleanup_stale_subscribers
from .endpoints import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup."""
    await init_db()

    # Start cleanup task
    async def cleanup_loop():
        tick = 0
        while True:
            await asyncio.sleep(ADAPTIVE_TICK_INTERVAL)
            tick += 1
            # Cooldown tick every iteration (every ADAPTIVE_TICK_INTERVAL seconds)
            cooldown_tick()
            # Subscriber cleanup every ~60s (6 ticks at 10s interval)
            if tick % 6 == 0:
                await cleanup_stale_subscribers()
                # Rate window cleanup
                now = time.time()
                _recent_rate_window[:] = [t for t in _recent_rate_window if now - t < 60]
                # Source window cleanup (keep last 5 min)
                for sid in list(_source_ingest_window):
                    _source_ingest_window[sid] = [t for t in _source_ingest_window[sid] if now - t < 300]
                    if not _source_ingest_window[sid]:
                        del _source_ingest_window[sid]
            # DB cleanup every hour (360 ticks at 10s interval)
            if tick % 360 == 0:
                deleted = await cleanup_old_traces()
                if deleted:
                    print(f"[TraceHub] Cleaned up {deleted} old traces")

    cleanup_task = asyncio.create_task(cleanup_loop())

    yield

    cleanup_task.cancel()


app = FastAPI(
    title="TraceHub",
    description="Centralized checkpoint trace collection and query service",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(adaptive_router)
