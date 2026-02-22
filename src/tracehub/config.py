"""
Script: config.py
Created: 2026-02-22
Purpose: TraceHub server configuration and in-memory state
Keywords: config, environment, state, tracehub
Status: active
Prerequisites:
  - None
Changelog:
  - 2026-02-22: Extracted from server.py during package refactor
See-Also: .claude/CLAUDE.md ##Управление скриптами
"""

import asyncio
import os
import time
from typing import Dict, List


# =============================================================================
# Configuration
# =============================================================================

TRACEHUB_DB = os.getenv("TRACEHUB_DB", "/tmp/tracehub.db")
TRACEHUB_PORT = int(os.getenv("TRACEHUB_PORT", "8099"))
TRACEHUB_RETENTION_HOURS = int(os.getenv("TRACEHUB_RETENTION_HOURS", "24"))
TRACEHUB_SECRET = os.getenv("TRACEHUB_SECRET", "")  # Empty = no auth required

# In-memory buffer for real-time streaming (correlation_id -> list of subscribers)
_subscribers: Dict[str, List[asyncio.Queue]] = {}
_subscriber_timestamps: Dict[str, float] = {}  # correlation_id -> last activity time
_stats = {
    "ingest_total": 0,
    "ingest_duplicates": 0,
    "queries_total": 0,
    "recent_requests": 0,
    "started_at": time.time(),
}
_recent_rate_window: List[float] = []  # timestamps of /recent requests for rate tracking
# Per-source tracking: source_id -> list of ingest timestamps (last 5 min window)
_source_ingest_window: Dict[str, List[float]] = {}
_source_ingest_totals: Dict[str, int] = {}  # source_id -> total count since start
