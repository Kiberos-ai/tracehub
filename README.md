# TraceHub

Centralized checkpoint trace collection and query service for distributed systems.

**License:** Apache 2.0

## Overview

TraceHub collects checkpoint traces from distributed services and provides:

- **Centralized Storage**: All traces in one place (SQLite)
- **Real-time Streaming**: SSE endpoint for live trace updates
- **Correlation Tracking**: Query all traces for a request chain
- **Auto-cleanup**: Configurable retention (default: 24 hours)

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│   Manager (muid.io) │     │  Worker (kiberos.ai)│
│                     │     │                     │
│  checkpoint_logger  │     │  checkpoint_logger  │
│         │           │     │         │           │
└─────────┼───────────┘     └─────────┼───────────┘
          │                           │
          └─────────┬─────────────────┘
                    │
                    ▼
           ┌────────────────┐
           │   TraceHub     │
           │   (FastAPI)    │
           │                │
           │  SQLite + SSE  │
           └───────┬────────┘
                   │
                   ▼
           ┌────────────────┐
           │  CLI / Grafana │
           │   (Query API)  │
           └────────────────┘
```

## Quick Start

### 1. Start TraceHub Server

```bash
# Using Python directly
cd tracehub
pip install -r requirements.txt
python server.py --port 8099

# Or via Docker (coming soon)
docker run -p 8099:8099 tracehub
```

### 2. Configure Services

Set environment variables on services using checkpoint_logger:

```bash
# On Manager (muid.io)
export TRACEHUB_URL=http://tracehub-host:8099
export CHECKPOINT_TRACING=1

# On Worker (kiberos.ai)
export TRACEHUB_URL=http://tracehub-host:8099
export CHECKPOINT_TRACING=1
```

### 3. Query Traces

```bash
# List recent correlation IDs
curl http://tracehub:8099/correlations

# Get traces for specific correlation ID
curl http://tracehub:8099/traces/cli-12345-abc

# Stream traces in real-time
curl http://tracehub:8099/traces/cli-12345-abc/stream
```

## API Endpoints

### Ingest

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ingest` | POST | Batch ingest traces |
| `/ingest/single` | POST | Ingest single trace |

### Query

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/traces/{corr_id}` | GET | Get all traces for correlation ID |
| `/traces/{corr_id}/stream` | GET | SSE stream for real-time traces |
| `/correlations` | GET | List recent correlation IDs |

### Admin

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/cleanup` | DELETE | Force cleanup old traces |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TRACEHUB_DB` | `/tmp/tracehub.db` | SQLite database path |
| `TRACEHUB_PORT` | `8099` | Server port |
| `TRACEHUB_RETENTION_HOURS` | `24` | Trace retention period |

### Client Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TRACEHUB_URL` | `` | TraceHub server URL (empty = disabled) |
| `TRACEHUB_BATCH_SIZE` | `10` | Traces per batch |
| `TRACEHUB_FLUSH_INTERVAL` | `1.0` | Flush interval in seconds |

## Integration

### With checkpoint_logger (Automatic)

When `TRACEHUB_URL` is set, checkpoint_logger automatically sends traces:

```python
from checkpoint_logger import get_checkpoint_logger, set_correlation_id

# Enable tracing
os.environ['CHECKPOINT_TRACING'] = '1'
os.environ['TRACEHUB_URL'] = 'http://tracehub:8099'

# Use as normal - traces auto-sent to TraceHub
log = get_checkpoint_logger("MA")
set_correlation_id("req-12345")
log.checkpoint_entry("REST", "/api/agents", {"id": "123"})
log.checkpoint_exit("REST", "/api/agents", {"status": "ok"})
```

### Manual Integration

```python
from tracehub.client import TraceHubClient, TraceEntry

client = TraceHubClient("http://tracehub:8099")

entry = TraceEntry(
    source_id="MY",
    correlation_id="req-12345",
    timestamp=time.time() * 1000,
    suffix="abc",
    direction="->",
    operation="HTTP",
    endpoint="/api/test",
)
client.send(entry)
```

## CLI Usage

```bash
# Via kbc
kbc tracehub start              # Start TraceHub server
kbc tracehub status             # Check status
kbc trace show                  # Show recent traces (uses TraceHub if available)

# Via kiberos CLI
kiberos trace list              # List traces from TraceHub
kiberos trace current           # Show current trace ID
```

## Trace Format

Each trace entry contains:

```json
{
  "source_id": "MA",
  "correlation_id": "cli-12345-abc",
  "timestamp": 1706803200123,
  "suffix": "x7K",
  "direction": "->",
  "operation": "REST",
  "endpoint": "/api/agents",
  "data": {"binding_id": "123"},
  "hostname": "muid.io"
}
```

## Source IDs

| ID | Component |
|----|-----------|
| MA | Manager API (REST) |
| WS | WebSocket handlers |
| WK | Worker client |
| VM | VM Agent |
| MB | MessageBridge |
| JW | JWT Authority |
| SP | Spawner |

## License

Apache License 2.0 - see [LICENSE](LICENSE)
