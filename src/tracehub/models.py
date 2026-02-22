"""
Script: models.py
Created: 2026-02-22
Purpose: Pydantic models and authentication for TraceHub server
Keywords: models, pydantic, auth, tracehub
Status: active
Prerequisites:
  - fastapi, pydantic
Changelog:
  - 2026-02-22: Extracted from server.py during package refactor
See-Also: .claude/CLAUDE.md ##Управление скриптами
"""

from typing import Dict, List, Optional

from fastapi import HTTPException, Header
from pydantic import BaseModel, Field

from .config import TRACEHUB_SECRET


# =============================================================================
# Authentication
# =============================================================================

async def verify_secret(x_tracehub_secret: Optional[str] = Header(None, alias="X-TraceHub-Secret")):
    """
    Verify TraceHub secret for protected endpoints.

    If TRACEHUB_SECRET is set, all ingest requests must include
    X-TraceHub-Secret header with matching value.

    Query endpoints are public (read-only).
    """
    if not TRACEHUB_SECRET:
        # No secret configured - allow all
        return True

    if not x_tracehub_secret:
        raise HTTPException(
            status_code=401,
            detail="X-TraceHub-Secret header required"
        )

    if x_tracehub_secret != TRACEHUB_SECRET:
        raise HTTPException(
            status_code=403,
            detail="Invalid TraceHub secret"
        )

    return True


# =============================================================================
# Models
# =============================================================================

class TraceEntry(BaseModel):
    """Single trace entry from checkpoint logger."""
    source_id: str = Field(..., description="Two-letter source ID (MA, WS, WK, VM, MB)")
    correlation_id: str = Field(..., description="Correlation ID for request chain")
    timestamp: float = Field(..., description="Unix timestamp in milliseconds")
    suffix: str = Field(..., description="Unique suffix for deduplication")
    direction: str = Field(..., description="Entry (->) or exit (<-)")
    operation: str = Field(..., description="Operation type (REST, WS, RPC)")
    endpoint: str = Field(..., description="Endpoint or method name")
    data: Optional[Dict] = Field(None, description="Additional data (redacted)")
    hostname: str = Field("unknown", description="Source hostname")
    raw_line: Optional[str] = Field(None, description="Original log line")


class TraceIngestRequest(BaseModel):
    """Batch ingest request."""
    traces: List[TraceEntry]


class TraceQueryResponse(BaseModel):
    """Query response with traces."""
    correlation_id: str
    traces: List[TraceEntry]
    count: int
    complete: bool = Field(False, description="True if trace chain appears complete")
