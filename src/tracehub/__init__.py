"""
TraceHub — the Python client for sending checkpoint traces to a TraceHub server.

The server itself is TypeScript on Bun and lives in this same repository under
src/; this package is the client and nothing else. The version below is the one
and only place it is declared — pyproject.toml reads it from here.

https://muid.io | LifeAiTools Dev Team
Apache License 2.0
"""

__version__ = "0.2.0"

from tracehub.client import (
    TraceEntry,
    TraceHubClient,
    TraceHubQueryClient,
    get_tracehub_client,
    send_trace,
    create_trace_entry,
    is_tracehub_enabled,
)

__all__ = [
    # Version
    "__version__",
    # Client classes
    "TraceEntry",
    "TraceHubClient",
    "TraceHubQueryClient",
    # Client functions
    "get_tracehub_client",
    "send_trace",
    "create_trace_entry",
    "is_tracehub_enabled",
]
