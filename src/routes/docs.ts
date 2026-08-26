import { Hono } from "hono";

// =============================================================================
// AI-friendly documentation endpoints (llms.txt standard)
// Content-Type: text/plain for all docs — agents consume markdown directly
// =============================================================================

export const docsRouter = new Hono();

// -----------------------------------------------------------------------------
// GET /llms.txt — compact index (llmstxt.org spec)
// -----------------------------------------------------------------------------

const LLMS_TXT = `# TracHub

> Centralized checkpoint trace collection and query service for distributed systems.

TracHub collects checkpoint traces from distributed services, provides real-time SSE streaming, adaptive sampling (HOT/WARM/COLD), and long-poll config delivery. Deploy once, trace from any language via TS or Python SDK.

## Getting Started
- [Quick Integration Guide](https://tracehub.muid.io/docs/integration.md): Step-by-step setup for TypeScript and Python
- [API Reference](https://tracehub.muid.io/docs/api.md): All endpoints with curl examples

## SDKs
- [TypeScript SDK](https://tracehub.muid.io/docs/sdk-ts.md): @tracehub/sdk — zero-dep, batch sender, long-poll config
- [Python SDK](https://tracehub.muid.io/docs/sdk-python.md): checktrace — decorator, middleware, manual checkpoints

## Concepts
- [Adaptive Tracing](https://tracehub.muid.io/docs/adaptive.md): HOT/WARM/COLD model — traces only when debugging
- [Long-Poll Config](https://tracehub.muid.io/docs/long-poll.md): Zero-traffic config delivery via Prefer: wait

## Optional
- [Source IDs](https://tracehub.muid.io/docs/source-ids.md): Two-letter codes for service identification
- [Trace Format](https://tracehub.muid.io/docs/trace-format.md): JSON trace entry schema
`;

docsRouter.get("/llms.txt", (c) => {
	return c.text(LLMS_TXT);
});

// -----------------------------------------------------------------------------
// GET /llms-full.txt — complete self-contained documentation
// -----------------------------------------------------------------------------

const LLMS_FULL_TXT = `# TracHub — Complete Documentation

> Centralized checkpoint trace collection and query service for distributed systems.

## Overview

TracHub collects checkpoint traces from distributed services into a single SQLite store. Features: real-time SSE streaming, adaptive sampling (HOT/WARM/COLD), long-poll config delivery, and abuse protection with three-tier rate limiting. Deploy once, trace from TypeScript or Python.

## Quick Start (TypeScript)

\`\`\`bash
bun add @tracehub/sdk   # or: npm install @tracehub/sdk
\`\`\`

\`\`\`ts
import { init, checkpoint, setCorrelationId, close } from "@tracehub/sdk";

init({ url: "https://tracehub.muid.io", secret: "your-secret", sourceId: "MA", projectName: "myapp" });
setCorrelationId("req-12345");
checkpoint("->", "REST", "/api/users", { id: "123" });
// ... work ...
checkpoint("<-", "REST", "/api/users", { status: "ok" });
await close();
\`\`\`

## Quick Start (Python)

\`\`\`bash
pip install checktrace
\`\`\`

\`\`\`python
from checktrace import CheckTraceConfig, init_tracing, get_checkpoint_logger, set_correlation_id

config = CheckTraceConfig(
    tracehub_url="https://tracehub.muid.io",
    tracehub_secret="your-secret",
    default_source_id="MA",
    project_name="myapp"
)
init_tracing(config)
log = get_checkpoint_logger("MA")
set_correlation_id("req-12345")
log.checkpoint_entry("REST", "/api/users", {"id": "123"})
log.checkpoint_exit("REST", "/api/users", {"status": "ok"})
\`\`\`

### Python Decorator

\`\`\`python
from checktrace import checkpoint

@checkpoint("MA", "process_order")
async def process_order(order_id: str):
    return await do_work(order_id)
\`\`\`

### Python Middleware (FastAPI)

\`\`\`python
from checktrace import CheckpointMiddleware
app.add_middleware(CheckpointMiddleware, source_id="MA")
\`\`\`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| TRACEHUB_URL | "" | TracHub server URL (empty=disabled) |
| TRACEHUB_SECRET | "" | Auth secret for ingest |
| CHECKTRACE_PROJECT | "default" | Project name for client ID |
| CHECKTRACE_SOURCE_ID | "XX" | 2-letter source code |
| CHECKPOINT_TRACING | "true" | Master on/off |
| CHECKTRACE_ADAPTIVE | "false" | Enable adaptive tracing |
| TRACEHUB_BATCH_SIZE | "10" | Traces per batch |
| TRACEHUB_FLUSH_INTERVAL | "1.0" | Flush interval seconds |

## API Reference

### POST /ingest — batch ingest traces

\`\`\`bash
curl -X POST https://tracehub.muid.io/ingest \\
  -H "Content-Type: application/json" \\
  -H "X-TraceHub-Secret: your-secret" \\
  -d '{"traces": [{"source_id":"MA","correlation_id":"req-123","timestamp":1706803200123,"suffix":"x7K","direction":"->","operation":"REST","endpoint":"/api/users","data":{"id":"123"},"hostname":"myhost"}]}'
\`\`\`

### POST /ingest/single — single trace

\`\`\`bash
curl -X POST https://tracehub.muid.io/ingest/single \\
  -H "Content-Type: application/json" \\
  -H "X-TraceHub-Secret: your-secret" \\
  -d '{"source_id":"MA","correlation_id":"req-123","timestamp":1706803200123,"suffix":"x7K","direction":"->","operation":"REST","endpoint":"/api/users","data":{},"hostname":"myhost"}'
\`\`\`

### GET /traces/:corrId — query traces

Returns traces for a correlation ID. First query auto-activates HOT tracing and returns \`adaptive_hint\`.

\`\`\`bash
curl https://tracehub.muid.io/traces/req-123
\`\`\`

Supports long-poll via \`Prefer: wait=N\`: with nothing newer than \`since_ts\` and the chain
unfinished, the request is held until the next trace arrives instead of answering empty.

\`\`\`bash
curl -H "Prefer: wait=30" "https://tracehub.muid.io/traces/req-123?since_ts=1700000000"
\`\`\`

### GET /traces/:corrId/stream — SSE real-time stream

\`\`\`bash
curl -N https://tracehub.muid.io/traces/req-123/stream
\`\`\`

### GET /tracing/config — adaptive config (long-poll)

Supports long-poll via \`Prefer: wait=N\` header. Use \`If-None-Match\` ETag for change detection.

\`\`\`bash
curl https://tracehub.muid.io/tracing/config \\
  -H "Prefer: wait=30" \\
  -H "If-None-Match: \\"prev-etag\\""
\`\`\`

### POST /tracing/enable/:corrId — activate HOT tracing

\`\`\`bash
curl -X POST https://tracehub.muid.io/tracing/enable/req-123
\`\`\`

### POST /tracing/disable/:corrId — deactivate tracing

\`\`\`bash
curl -X POST https://tracehub.muid.io/tracing/disable/req-123
\`\`\`

### GET /correlations — list recent correlation IDs

\`\`\`bash
curl https://tracehub.muid.io/correlations?limit=50
\`\`\`

### GET /recent — recent traces across all correlations

\`\`\`bash
curl https://tracehub.muid.io/recent?limit=200
\`\`\`

### GET /stats — server statistics

\`\`\`bash
curl https://tracehub.muid.io/stats
\`\`\`

### GET /health — health check

\`\`\`bash
curl https://tracehub.muid.io/health
\`\`\`

## Trace Entry JSON Schema

\`\`\`json
{
  "source_id": "MA",
  "correlation_id": "req-12345-abc",
  "timestamp": 1706803200123,
  "suffix": "x7K",
  "direction": "->",
  "operation": "REST",
  "endpoint": "/api/users",
  "data": {"id": "123"},
  "hostname": "myhost"
}
\`\`\`

Fields: \`source_id\` (2-letter code), \`correlation_id\` (request chain ID), \`timestamp\` (epoch ms), \`suffix\` (unique 3-char), \`direction\` (\`->\` entry, \`<-\` exit), \`operation\` (REST/WS/GRPC), \`endpoint\` (path), \`data\` (arbitrary JSON), \`hostname\`.

## Adaptive Tracing

Three states: **HOT** (100% sampling, 5min after query) -> **WARM** (10% sampling, 25min) -> **COLD** (0%, default). Querying \`/traces/:corrId\` auto-activates HOT. SDK \`shouldTrace()\` gates emission client-side.

## Source IDs

Standard codes: MA=Manager API, WS=WebSocket, WK=Worker, VM=VM Agent, MB=MessageBridge, JW=JWT, SP=Spawner. Pick any unique 2-letter code for your service.
`;

docsRouter.get("/llms-full.txt", (c) => {
	return c.text(LLMS_FULL_TXT);
});

// -----------------------------------------------------------------------------
// GET /docs/:page.md — individual doc pages
// -----------------------------------------------------------------------------

export const DOC_PAGES: Record<string, string> = {
	"integration.md": `# TracHub Integration Guide

## Overview

TracHub is a centralized trace collection service for distributed systems. This guide covers integrating your TypeScript or Python service.

## Prerequisites

- A running TracHub instance (e.g. https://tracehub.muid.io)
- An ingest secret (set via TRACEHUB_SECRET on the server)

## TypeScript Integration

### 1. Install the SDK

\`\`\`bash
bun add @tracehub/sdk   # or: npm install @tracehub/sdk
\`\`\`

### 2. Initialize

\`\`\`ts
import { init, checkpoint, setCorrelationId, close } from "@tracehub/sdk";

init({
  url: "https://tracehub.muid.io",
  secret: "your-secret",
  sourceId: "MA",
  projectName: "myapp"
});
\`\`\`

### 3. Add checkpoints

\`\`\`ts
setCorrelationId("req-12345");
checkpoint("->", "REST", "/api/users", { id: "123" });
// ... your logic ...
checkpoint("<-", "REST", "/api/users", { status: "ok" });
\`\`\`

### 4. Graceful shutdown

\`\`\`ts
await close(); // flushes remaining traces
\`\`\`

## Python Integration

### 1. Install the SDK

\`\`\`bash
pip install checktrace
\`\`\`

### 2. Initialize

\`\`\`python
from checktrace import CheckTraceConfig, init_tracing, get_checkpoint_logger, set_correlation_id

config = CheckTraceConfig(
    tracehub_url="https://tracehub.muid.io",
    tracehub_secret="your-secret",
    default_source_id="MA",
    project_name="myapp"
)
init_tracing(config)
log = get_checkpoint_logger("MA")
\`\`\`

### 3. Manual checkpoints

\`\`\`python
set_correlation_id("req-12345")
log.checkpoint_entry("REST", "/api/users", {"id": "123"})
# ... your logic ...
log.checkpoint_exit("REST", "/api/users", {"status": "ok"})
\`\`\`

### 4. Decorator (async functions)

\`\`\`python
from checktrace import checkpoint

@checkpoint("MA", "process_order")
async def process_order(order_id: str):
    return await do_work(order_id)
\`\`\`

### 5. FastAPI Middleware

\`\`\`python
from checktrace import CheckpointMiddleware
app.add_middleware(CheckpointMiddleware, source_id="MA")
\`\`\`

This auto-generates correlation IDs per request and logs entry/exit checkpoints.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| TRACEHUB_URL | "" | TracHub server URL (empty=tracing disabled) |
| TRACEHUB_SECRET | "" | Auth secret for ingest |
| CHECKTRACE_PROJECT | "default" | Project name for client ID |
| CHECKTRACE_SOURCE_ID | "XX" | 2-letter source code |
| CHECKPOINT_TRACING | "true" | Master on/off switch |
| CHECKTRACE_ADAPTIVE | "false" | Enable adaptive tracing |
| TRACEHUB_BATCH_SIZE | "10" | Traces per batch |
| TRACEHUB_FLUSH_INTERVAL | "1.0" | Flush interval in seconds |

## Verifying Integration

\`\`\`bash
# Check health
curl https://tracehub.muid.io/health

# After sending traces, query them
curl https://tracehub.muid.io/traces/req-12345

# List all recent correlation IDs
curl https://tracehub.muid.io/correlations

# Stream traces in real-time
curl -N https://tracehub.muid.io/traces/req-12345/stream
\`\`\`

## Adaptive Tracing

By default, TracHub uses adaptive sampling to minimize overhead:
- **COLD** (default): 0% sampling — no traces recorded
- **HOT**: 100% sampling for 5 minutes — activated when someone queries traces
- **WARM**: 10% sampling for 25 minutes — gradual cooldown after HOT

Querying \`/traces/:corrId\` auto-activates HOT mode. The SDK's \`shouldTrace()\` function checks the server config and gates trace emission client-side.

## Source IDs

Pick a unique 2-letter code for your service. Standard codes:

| ID | Service |
|---|---|
| MA | Manager API |
| WS | WebSocket |
| WK | Worker |
| VM | VM Agent |
| MB | MessageBridge |
| JW | JWT Authority |
| SP | Spawner |
`,

	"api.md": `# TracHub API Reference

Base URL: \`https://tracehub.muid.io\`

All ingest endpoints require \`X-TraceHub-Secret\` header. Query endpoints are open.

## Ingest

### POST /ingest

Batch ingest traces.

\`\`\`bash
curl -X POST https://tracehub.muid.io/ingest \\
  -H "Content-Type: application/json" \\
  -H "X-TraceHub-Secret: your-secret" \\
  -d '{
    "traces": [
      {
        "source_id": "MA",
        "correlation_id": "req-123",
        "timestamp": 1706803200123,
        "suffix": "x7K",
        "direction": "->",
        "operation": "REST",
        "endpoint": "/api/users",
        "data": {"id": "123"},
        "hostname": "myhost"
      }
    ]
  }'
\`\`\`

Response: \`{"accepted": 1}\`

### POST /ingest/single

Ingest a single trace entry.

\`\`\`bash
curl -X POST https://tracehub.muid.io/ingest/single \\
  -H "Content-Type: application/json" \\
  -H "X-TraceHub-Secret: your-secret" \\
  -d '{
    "source_id": "MA",
    "correlation_id": "req-123",
    "timestamp": 1706803200123,
    "suffix": "x7K",
    "direction": "->",
    "operation": "REST",
    "endpoint": "/api/users",
    "data": {},
    "hostname": "myhost"
  }'
\`\`\`

Response: \`{"accepted": 1}\`

## Query

### GET /traces/:correlationId

Get all traces for a correlation ID. First query auto-activates HOT tracing.

\`\`\`bash
curl https://tracehub.muid.io/traces/req-123
\`\`\`

Response:
\`\`\`json
{
  "correlation_id": "req-123",
  "traces": [...],
  "count": 4,
  "complete": true,
  "adaptive_hint": {
    "previous_state": "cold",
    "current_state": "hot",
    "message": "Tracing activated. Previous traces may be incomplete.",
    "retry_after_seconds": 45
  }
}
\`\`\`

Query params: \`?source=MA\` — filter by source ID prefix. \`?since_ts=…\` — return only
traces newer than that timestamp; \`complete\` is still judged on the whole chain.

Header \`Prefer: wait=N\` (seconds, capped server-side) turns the read into a long poll: it
answers the moment the next trace of this correlation is stored. It returns immediately
when the slice is non-empty, when the chain is already \`complete\`, or when the header is
absent.

\`\`\`bash
curl -H "Prefer: wait=30" "https://tracehub.muid.io/traces/req-123?since_ts=1700000000"
\`\`\`

### GET /traces/:correlationId/stream

SSE real-time stream. Sends existing traces immediately, then streams new ones as they arrive.

\`\`\`bash
curl -N https://tracehub.muid.io/traces/req-123/stream?timeout=60
\`\`\`

Events: \`data: {"source_id":"MA",...}\` per trace. Heartbeat \`: ping\` every 15s. Final \`data: {"type":"timeout"}\` on expiry.

### GET /correlations

List recent correlation IDs.

\`\`\`bash
curl https://tracehub.muid.io/correlations?limit=50
\`\`\`

### GET /recent

Recent traces across all correlations.

\`\`\`bash
curl https://tracehub.muid.io/recent?limit=200&source=MA
\`\`\`

Query params: \`limit\` (max 1000), \`since_id\`, \`source\`.

## Adaptive Tracing

### GET /tracing/config

Get current adaptive tracing configuration. Supports long-poll via \`Prefer: wait=N\` header and ETag-based change detection.

\`\`\`bash
# Immediate response
curl https://tracehub.muid.io/tracing/config

# Long-poll: wait up to 30s for config change
curl https://tracehub.muid.io/tracing/config \\
  -H "Prefer: wait=30" \\
  -H "If-None-Match: \\"prev-etag\\""
\`\`\`

Returns 304 if no change within the wait period.

### GET /tracing/status

Get adaptive tracing status for all active correlations.

\`\`\`bash
curl https://tracehub.muid.io/tracing/status
\`\`\`

### POST /tracing/enable/:corrId

Manually activate HOT tracing for a correlation ID.

\`\`\`bash
curl -X POST https://tracehub.muid.io/tracing/enable/req-123
\`\`\`

Response: \`{"correlation_id":"req-123","state":"hot","previous_state":"cold","ttl":300}\`

### POST /tracing/disable/:corrId

Deactivate tracing for a correlation ID.

\`\`\`bash
curl -X POST https://tracehub.muid.io/tracing/disable/req-123
\`\`\`

## Admin

### GET /stats

Server statistics: trace count, active correlations, adaptive state counts, rate limit status.

\`\`\`bash
curl https://tracehub.muid.io/stats
\`\`\`

### GET /health

Health check.

\`\`\`bash
curl https://tracehub.muid.io/health
\`\`\`

Response: \`{"status":"healthy","service":"tracehub",...}\`

## Trace Entry Schema

\`\`\`json
{
  "source_id": "MA",
  "correlation_id": "req-12345-abc",
  "timestamp": 1706803200123,
  "suffix": "x7K",
  "direction": "->",
  "operation": "REST",
  "endpoint": "/api/users",
  "data": {"id": "123"},
  "hostname": "myhost"
}
\`\`\`

| Field | Type | Description |
|---|---|---|
| source_id | string | 2-letter service code (MA, WS, WK, etc.) |
| correlation_id | string | Request chain identifier |
| timestamp | number | Epoch milliseconds |
| suffix | string | Unique 3-char suffix |
| direction | string | \`->\` (entry) or \`<-\` (exit) |
| operation | string | REST, WS, GRPC, etc. |
| endpoint | string | Operation path |
| data | object | Arbitrary metadata (optional) |
| hostname | string | Originating host |
`,
};

docsRouter.get("/docs/:page", (c) => {
	const page = c.req.param("page");
	const content = DOC_PAGES[page];
	if (!content) {
		return c.text(
			`# 404 Not Found\n\nPage \`${page}\` not found. See /llms.txt for available pages.`,
			404,
		);
	}
	return c.text(content);
});
