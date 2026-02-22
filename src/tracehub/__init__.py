"""
TraceHub - Centralized Checkpoint Trace Collection

https://muid.io | LifeAiTools Dev Team
Apache License 2.0
"""

__version__ = "0.2.0"

# Client exports (always available - minimal deps)
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


def get_app():
    """
    Get FastAPI app instance (requires server extras).

    Install with: pip install tracehub[server]
    """
    from .app import app
    return app
