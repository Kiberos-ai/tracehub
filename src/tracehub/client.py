#!/usr/bin/env python3
"""
Script: client.py
Created: 2026-02-01
Purpose: TraceHub client SDK for sending traces from checkpoint_logger
Keywords: tracing, client, sdk, async, http
Status: active
Prerequisites:
  - httpx (async HTTP client)
See-Also: server.py, checkpoint_logger.py
Changelog:
  - 2026-02-01: Initial version - async batch sender with retry
"""

import asyncio
import atexit
import os
import socket
import threading
import time
from dataclasses import dataclass, field
from queue import Queue, Empty
from typing import Any, Dict, List, Optional

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False


# =============================================================================
# Configuration
# =============================================================================

TRACEHUB_URL = os.getenv("TRACEHUB_URL", "")  # e.g., "http://muid.io:8099"
TRACEHUB_SECRET = os.getenv("TRACEHUB_SECRET", "")  # Auth secret for ingest
TRACEHUB_BATCH_SIZE = int(os.getenv("TRACEHUB_BATCH_SIZE", "10"))
TRACEHUB_FLUSH_INTERVAL = float(os.getenv("TRACEHUB_FLUSH_INTERVAL", "1.0"))
TRACEHUB_TIMEOUT = float(os.getenv("TRACEHUB_TIMEOUT", "5.0"))
TRACEHUB_RETRY_COUNT = int(os.getenv("TRACEHUB_RETRY_COUNT", "2"))

_HOSTNAME = socket.gethostname()


# =============================================================================
# Trace Entry
# =============================================================================

@dataclass
class TraceEntry:
    """Single trace entry to send to TraceHub."""
    source_id: str
    correlation_id: str
    timestamp: float  # Unix ms
    suffix: str
    direction: str  # "->" or "<-"
    operation: str
    endpoint: str
    data: Optional[Dict[str, Any]] = None
    hostname: str = field(default_factory=lambda: _HOSTNAME)
    raw_line: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source_id": self.source_id,
            "correlation_id": self.correlation_id,
            "timestamp": self.timestamp,
            "suffix": self.suffix,
            "direction": self.direction,
            "operation": self.operation,
            "endpoint": self.endpoint,
            "data": self.data,
            "hostname": self.hostname,
            "raw_line": self.raw_line,
        }


# =============================================================================
# Async Batch Sender
# =============================================================================

class TraceHubClient:
    """
    Async client for sending traces to TraceHub.

    Uses background thread with queue for non-blocking sends.
    Batches traces and flushes periodically or when batch is full.

    Usage:
        client = TraceHubClient("http://tracehub:8099")
        client.send(TraceEntry(...))
        # Traces are batched and sent asynchronously

        # On shutdown
        client.flush()
        client.close()
    """

    def __init__(
        self,
        base_url: str,
        secret: str = TRACEHUB_SECRET,
        batch_size: int = TRACEHUB_BATCH_SIZE,
        flush_interval: float = TRACEHUB_FLUSH_INTERVAL,
        timeout: float = TRACEHUB_TIMEOUT,
        retry_count: int = TRACEHUB_RETRY_COUNT,
    ):
        self.base_url = base_url.rstrip("/")
        self.secret = secret
        self.batch_size = batch_size
        self.flush_interval = flush_interval
        self.timeout = timeout
        self.retry_count = retry_count

        self._queue: Queue[TraceEntry] = Queue()
        self._running = True
        self._thread: Optional[threading.Thread] = None

        if HTTPX_AVAILABLE and self.base_url:
            self._start_sender()

    def _start_sender(self):
        """Start background sender thread."""
        self._thread = threading.Thread(target=self._sender_loop, daemon=True)
        self._thread.start()
        atexit.register(self._shutdown)

    def _sender_loop(self):
        """Background loop that batches and sends traces."""
        batch: List[TraceEntry] = []
        last_flush = time.time()

        while self._running or not self._queue.empty():
            try:
                # Try to get item with timeout
                try:
                    entry = self._queue.get(timeout=0.1)
                    batch.append(entry)
                except Empty:
                    pass

                # Flush if batch full or interval elapsed
                now = time.time()
                should_flush = (
                    len(batch) >= self.batch_size or
                    (batch and now - last_flush >= self.flush_interval)
                )

                if should_flush and batch:
                    self._send_batch(batch)
                    batch = []
                    last_flush = now

            except Exception as e:
                # Don't crash the sender thread
                print(f"[TraceHub] Sender error: {e}")

        # Final flush
        if batch:
            self._send_batch(batch)

    def _send_batch(self, batch: List[TraceEntry]):
        """Send batch of traces to TraceHub."""
        if not batch:
            return

        payload = {"traces": [t.to_dict() for t in batch]}
        headers = {}
        if self.secret:
            headers["X-TraceHub-Secret"] = self.secret

        for attempt in range(self.retry_count + 1):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    response = client.post(
                        f"{self.base_url}/ingest",
                        json=payload,
                        headers=headers,
                    )
                    if response.status_code == 200:
                        return
                    elif response.status_code in (401, 403):
                        print(f"[TraceHub] Auth failed: {response.status_code} - check TRACEHUB_SECRET")
                        return  # Don't retry auth errors
                    else:
                        print(f"[TraceHub] Ingest failed: {response.status_code}")
            except Exception as e:
                if attempt == self.retry_count:
                    print(f"[TraceHub] Failed after {self.retry_count + 1} attempts: {e}")
                else:
                    time.sleep(0.1 * (attempt + 1))

    def send(self, entry: TraceEntry):
        """Queue trace entry for sending."""
        if self._running and self.base_url:
            self._queue.put(entry)

    def flush(self):
        """Flush pending traces (blocking)."""
        if not self._thread:
            return

        # Wait for queue to drain
        deadline = time.time() + 5.0
        while not self._queue.empty() and time.time() < deadline:
            time.sleep(0.1)

    def close(self):
        """Stop the sender thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)

    def _shutdown(self):
        """Called at process exit."""
        self.flush()
        self.close()


# =============================================================================
# Global Client Instance
# =============================================================================

_client: Optional[TraceHubClient] = None


def get_tracehub_client() -> Optional[TraceHubClient]:
    """Get or create global TraceHub client."""
    global _client

    if _client is None and TRACEHUB_URL and HTTPX_AVAILABLE:
        _client = TraceHubClient(TRACEHUB_URL)

    return _client


def send_trace(entry: TraceEntry):
    """Send trace via global client (if configured)."""
    client = get_tracehub_client()
    if client:
        client.send(entry)


def is_tracehub_enabled() -> bool:
    """Check if TraceHub is configured and available."""
    return bool(TRACEHUB_URL and HTTPX_AVAILABLE)


# =============================================================================
# Convenience Functions
# =============================================================================

def create_trace_entry(
    source_id: str,
    correlation_id: str,
    timestamp_ms: float,
    suffix: str,
    direction: str,
    operation: str,
    endpoint: str,
    data: Optional[Dict] = None,
    raw_line: Optional[str] = None,
) -> TraceEntry:
    """Create trace entry with defaults."""
    return TraceEntry(
        source_id=source_id,
        correlation_id=correlation_id,
        timestamp=timestamp_ms,
        suffix=suffix,
        direction=direction,
        operation=operation,
        endpoint=endpoint,
        data=data,
        hostname=_HOSTNAME,
        raw_line=raw_line,
    )


# =============================================================================
# CLI Query Client
# =============================================================================

class TraceHubQueryClient:
    """
    Sync client for querying traces from TraceHub.

    Used by CLI to retrieve and display traces.
    """

    def __init__(self, base_url: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get_traces(
        self,
        correlation_id: str,
        source_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get traces for correlation ID."""
        params = {}
        if source_id:
            params["source"] = source_id

        with httpx.Client(timeout=self.timeout) as client:
            response = client.get(
                f"{self.base_url}/traces/{correlation_id}",
                params=params,
            )
            response.raise_for_status()
            return response.json()

    def list_correlations(self, limit: int = 50) -> Dict[str, Any]:
        """List recent correlation IDs."""
        with httpx.Client(timeout=self.timeout) as client:
            response = client.get(
                f"{self.base_url}/correlations",
                params={"limit": limit},
            )
            response.raise_for_status()
            return response.json()

    def stream_traces(
        self,
        correlation_id: str,
        callback,
        timeout: int = 60,
    ):
        """
        Stream traces in real-time.

        Args:
            correlation_id: Correlation ID to stream
            callback: Function to call with each trace dict
            timeout: Stream timeout in seconds
        """
        with httpx.Client(timeout=None) as client:
            with client.stream(
                "GET",
                f"{self.base_url}/traces/{correlation_id}/stream",
                params={"timeout": timeout},
            ) as response:
                for line in response.iter_lines():
                    if line.startswith("data: "):
                        import json
                        data = json.loads(line[6:])
                        if data.get("type") == "timeout":
                            break
                        callback(data)


# =============================================================================
# Testing
# =============================================================================

if __name__ == "__main__":
    import json

    print("TraceHub Client Test")
    print(f"TRACEHUB_URL: {TRACEHUB_URL or '(not set)'}")
    print(f"HTTPX available: {HTTPX_AVAILABLE}")
    print(f"TraceHub enabled: {is_tracehub_enabled()}")

    if is_tracehub_enabled():
        # Test sending
        entry = create_trace_entry(
            source_id="TS",
            correlation_id="test-12345",
            timestamp_ms=time.time() * 1000,
            suffix="abc",
            direction="->",
            operation="TEST",
            endpoint="/test",
            data={"key": "value"},
        )
        send_trace(entry)
        print(f"Sent test trace: {entry.to_dict()}")

        # Flush
        client = get_tracehub_client()
        if client:
            client.flush()
            print("Flushed")
    else:
        print("Set TRACEHUB_URL to enable TraceHub")
