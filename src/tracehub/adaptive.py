"""
Script: adaptive.py
Created: 2026-02-22
Purpose: Adaptive tracing state machine with /tracing/* endpoints
Keywords: adaptive, tracing, state-machine, hot, warm, cold, etag
Status: active
Prerequisites:
  - fastapi
Changelog:
  - 2026-02-22: Initial version — state machine + 4 endpoints (see CHANGELOG.md #Task-1)
See-Also: .claude/CLAUDE.md ##Управление скриптами
"""

import os
import time
from typing import Dict, Optional

from fastapi import APIRouter, Header, Response


# =============================================================================
# Configuration (env-configurable)
# =============================================================================

ADAPTIVE_HOT_TTL = int(os.getenv("ADAPTIVE_HOT_TTL", "300"))
ADAPTIVE_WARM_TTL = int(os.getenv("ADAPTIVE_WARM_TTL", "1500"))
ADAPTIVE_WARM_RATE = float(os.getenv("ADAPTIVE_WARM_RATE", "0.1"))
ADAPTIVE_COLD_RATE = float(os.getenv("ADAPTIVE_COLD_RATE", "0.0"))
ADAPTIVE_TICK_INTERVAL = int(os.getenv("ADAPTIVE_TICK_INTERVAL", "10"))


# =============================================================================
# In-memory state
# =============================================================================

_adaptive_state: Dict[str, dict] = {}
# {corr_id: {"state": "hot"|"warm", "expires_at": float, "queried_at": float}}

_config_etag: int = 0


# =============================================================================
# State machine functions
# =============================================================================

def mark_hot(corr_id: str) -> str:
    """Set or extend HOT state for a correlation ID.

    Returns previous state: "hot", "warm", or "cold".
    """
    global _config_etag
    now = time.time()
    prev = get_state(corr_id)
    _adaptive_state[corr_id] = {
        "state": "hot",
        "expires_at": now + ADAPTIVE_HOT_TTL,
        "queried_at": now,
    }
    _config_etag += 1
    return prev


def get_state(corr_id: str) -> str:
    """Return current state for a correlation ID: 'hot', 'warm', or 'cold'."""
    entry = _adaptive_state.get(corr_id)
    if entry is None:
        return "cold"
    return entry["state"]


def get_trace_rate(corr_id: str) -> float:
    """Return sampling rate based on current state."""
    state = get_state(corr_id)
    if state == "hot":
        return 1.0
    elif state == "warm":
        return ADAPTIVE_WARM_RATE
    return ADAPTIVE_COLD_RATE


def cooldown_tick() -> None:
    """Iterate state dict, transition HOT->WARM (expired) and WARM->remove (expired).

    Called periodically by background task.
    """
    global _config_etag
    now = time.time()
    changed = False
    to_remove = []

    for corr_id, entry in _adaptive_state.items():
        if entry["expires_at"] > now:
            continue
        if entry["state"] == "hot":
            entry["state"] = "warm"
            entry["expires_at"] = now + ADAPTIVE_WARM_TTL
            changed = True
        elif entry["state"] == "warm":
            to_remove.append(corr_id)
            changed = True

    for corr_id in to_remove:
        del _adaptive_state[corr_id]

    if changed:
        _config_etag += 1


# =============================================================================
# API Router
# =============================================================================

router = APIRouter()


@router.get("/tracing/config", tags=["tracing"])
async def tracing_config(
    response: Response,
    if_none_match: Optional[str] = Header(None),
):
    """Return adaptive tracing configuration. Pure in-memory, no DB queries (CN-01)."""
    etag_str = str(_config_etag)

    if if_none_match is not None and if_none_match.strip('"') == etag_str:
        return Response(status_code=304, headers={"ETag": f'"{etag_str}"'})

    now = time.time()
    hot_correlations = {}
    for corr_id, entry in _adaptive_state.items():
        if entry["state"] == "hot":
            hot_correlations[corr_id] = {
                "rate": 1.0,
                "ttl": max(0, int(entry["expires_at"] - now)),
            }

    response.headers["ETag"] = f'"{etag_str}"'
    return {
        "mode": "adaptive",
        "default_rate": ADAPTIVE_COLD_RATE,
        "warm_rate": ADAPTIVE_WARM_RATE,
        "hot_correlations": hot_correlations,
        "etag": etag_str,
    }


@router.get("/tracing/status", tags=["tracing"])
async def tracing_status():
    """Return all HOT/WARM entries with remaining TTL."""
    now = time.time()
    correlations = []
    for corr_id, entry in _adaptive_state.items():
        correlations.append({
            "correlation_id": corr_id,
            "state": entry["state"],
            "remaining_ttl": max(0, int(entry["expires_at"] - now)),
            "queried_at": entry["queried_at"],
        })
    return {
        "correlations": correlations,
        "count": len(correlations),
    }


@router.post("/tracing/enable/{corr_id}", tags=["tracing"])
async def tracing_enable(corr_id: str):
    """Enable HOT tracing for a correlation ID."""
    previous = mark_hot(corr_id)
    return {
        "correlation_id": corr_id,
        "state": "hot",
        "previous_state": previous,
        "ttl": ADAPTIVE_HOT_TTL,
    }


@router.post("/tracing/disable/{corr_id}", tags=["tracing"])
async def tracing_disable(corr_id: str):
    """Disable tracing for a correlation ID (set to cold)."""
    global _config_etag
    previous = get_state(corr_id)
    if corr_id in _adaptive_state:
        del _adaptive_state[corr_id]
        _config_etag += 1
    return {
        "correlation_id": corr_id,
        "state": "cold",
        "previous_state": previous,
    }
