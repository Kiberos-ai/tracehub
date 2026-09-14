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

Most recently active first. \`?limit=\` is 1-1000, default 50.

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
	"sdk-ts.md": `# TracHub TypeScript SDK

\`@tracehub/sdk\` — zero dependencies, native \`fetch\`, MIT.

It never throws into your code. Every entry point swallows its own errors: a
TracHub outage must not become an outage of the service being traced.

## Install

\`\`\`bash
bun add @tracehub/sdk   # or: npm install @tracehub/sdk
\`\`\`

## Initialize once, at startup

\`\`\`ts
import { init } from "@tracehub/sdk";

init({
  url: "https://tracehub.muid.io",
  secret: process.env.TRACEHUB_SECRET,  // required if the server has one
  sourceId: "MA",                       // two letters, see source-ids.md
  batchSize: 10,                        // flush after this many checkpoints
  flushInterval: 1000,                  // ...or after this many milliseconds
  adaptiveTracing: true,                // long-poll /tracing/config (default)
});
\`\`\`

| Option | Default | What it does |
|---|---|---|
| \`url\` | required | Base URL of the TracHub instance |
| \`secret\` | none | Sent as \`X-TraceHub-Secret\` on ingest |
| \`sourceId\` | \`"unknown"\` | Two-letter code identifying this service |
| \`clientId\` | \`"sdk-default"\` | Identifies this client to rate limiting |
| \`batchSize\` | \`10\` | Checkpoints per request |
| \`flushInterval\` | \`1000\` | Milliseconds between flushes |
| \`adaptiveTracing\` | \`true\` | Set \`false\` to send every checkpoint always |
| \`logger\` | none | \`(event, details) => void\` for SDK diagnostics |

## Mark the operation, then record its steps

A checkpoint without a correlation id is dropped — the id is what ties the run
together across machines, so set it at the edge of each request.

\`\`\`ts
import { checkpoint, setCorrelationId } from "@tracehub/sdk";

setCorrelationId(req.headers["x-correlation-id"] ?? crypto.randomUUID());

checkpoint("->", "REST", "/api/users", { id: "123" });
// ... do the work ...
checkpoint("<-", "REST", "/api/users", { status: "ok" });
\`\`\`

## Flush before the process exits

\`\`\`ts
import { close } from "@tracehub/sdk";
await close();   // sends whatever is still buffered
\`\`\`

Without it the last batch dies with the process — which is exactly the batch
describing whatever made the process exit.

## What the SDK fills in for you

\`source_id\`, \`timestamp\`, \`suffix\` and \`hostname\` are added automatically;
see trace-format.md for the shape that reaches the server.

## Adaptive decisions happen here, not on the server

With \`adaptiveTracing\` on, the SDK long-polls \`/tracing/config\` and drops
checkpoints for correlations the server has not marked interesting. The server
stores everything it is given — the saving is in traffic never sent. Call
\`shouldTrace(corrId)\` yourself if you want to skip expensive work that only
exists to build the \`data\` payload.
`,

	"sdk-python.md": `# TracHub Python SDK — checktrace

\`checktrace\` on pip.muid.io, source at github.com/Kiberos-ai/checktrace.

## Install

\`\`\`bash
pip install checktrace --index-url https://pip.muid.io/simple
\`\`\`

## Initialize

\`\`\`python
from checktrace import CheckTraceConfig, init_tracing, get_checkpoint_logger, set_correlation_id

init_tracing(CheckTraceConfig(
    url="https://tracehub.muid.io",
    secret=os.environ["TRACEHUB_SECRET"],
    source_id="MA",
))
\`\`\`

## Record checkpoints

\`\`\`python
set_correlation_id(request.headers.get("x-correlation-id", str(uuid4())))

log = get_checkpoint_logger("MA")
log.checkpoint_entry("REST", "/api/users", {"id": "123"})
log.checkpoint_exit("REST", "/api/users", {"status": "ok"})
\`\`\`

Or wrap a function, which records entry and exit around it:

\`\`\`python
from checktrace import checkpoint

@checkpoint("MA", "process_order")
def process_order(order_id: str) -> None:
    ...
\`\`\`

## What it does on its own

It long-polls \`/tracing/config\` with \`Prefer: wait=30\` and an ETag, honours
\`Retry-After\` when the server answers 429, falls back to COLD on any error, and
identifies itself with an \`X-TraceHub-Client\` header. As with the TypeScript
SDK, failures stay inside the SDK — tracing a service must never break it.

## A second client lives in the TracHub repository

\`tracehub.client.TraceHubClient\` (package \`tracehub\`, standard library plus
httpx) is the minimal sender used where a dependency on checktrace is not
wanted — kiberos-commander imports it, and its VM builder copies the single
file into each machine it creates.
`,

	"adaptive.md": `# Adaptive tracing — HOT, WARM, COLD

Full tracing of everything is the wrong default: it costs traffic and disk for
runs nobody will ever read. TracHub inverts it. A correlation becomes
interesting **because someone asked about it**, and quietens down by itself
afterwards.

## The three states

| State | Rate | Lives for | Entered when |
|---|---|---|---|
| HOT | 1.0 — send everything | 300s | somebody queries that correlation |
| WARM | 0.1 — send a tenth | 1500s | the HOT window expires |
| COLD | 0.0 — send nothing | — | the WARM window expires |

Defaults; every number is an environment variable (\`ADAPTIVE_HOT_TTL\`,
\`ADAPTIVE_WARM_TTL\`, \`ADAPTIVE_WARM_RATE\`, \`ADAPTIVE_COLD_RATE\`).

## Who decides

The **client** decides, from the config the server publishes. The ingest door
stores every trace it is handed, without condition — so a client that ignores
the config, or is configured with \`adaptiveTracing: false\`, can never have a
trace dropped on the server side. That matters for a producer whose whole point
is completeness: switch adaptive off and TracHub keeps all of it.

## How a client learns the current state

By long-polling \`/tracing/config\` — see long-poll.md. There is no polling
interval to tune: the request simply waits until something changes.

## The state is in memory

A restart forgets which correlations were hot. This is deliberate: the state is
a hint about what somebody is debugging right now, and after a restart nobody
is debugging anything yet.
`,

	"long-poll.md": `# Long polling — asking once and waiting

Two routes hold a connection open instead of answering immediately, so a client
learns about a change the moment it happens without asking repeatedly.

## Config: GET /tracing/config

\`\`\`bash
curl -H 'Prefer: wait=55' -H 'If-None-Match: "<etag>"' \\
     https://tracehub.muid.io/tracing/config
\`\`\`

The request waits up to \`wait\` seconds. If nothing changed it answers **304 Not
Modified** with no body; if the config changed it answers 200 with the new
config and a new ETag. Maximum wait is \`MAX_LONGPOLL_WAIT\` (60s by default),
and at most \`MAX_LONGPOLL_CONNECTIONS\` (200) may wait at once.

## Reading traces: GET /traces/{correlation_id}

The same header works when reading a run that is still in progress:

\`\`\`bash
curl -H 'Prefer: wait=30' \\
     'https://tracehub.muid.io/traces/req-123?since_ts=1706803200'
\`\`\`

It holds **only** when the slice would be empty and the chain is unfinished.
A non-empty slice, a complete chain, or no \`Prefer\` header at all answers
straight away — so no existing caller changes behaviour by upgrading.

\`since_ts\` makes the read incremental: only traces newer than that timestamp
come back. Completeness is still computed over the whole correlation, so a
slice never reports a finished chain as unfinished. A non-numeric \`since_ts\`
is a 400 rather than a silent zero.

## Why the idle timeout is derived, not chosen

The runtime closes an idle connection after 12 seconds by default, which
silently killed both mechanisms: a client asking for 60s saw a dropped socket,
reconnected, and long polling degraded into the busy polling it exists to
replace. \`SERVER_IDLE_TIMEOUT\` is therefore computed from \`MAX_LONGPOLL_WAIT\`
and \`SSE_HEARTBEAT_INTERVAL\` — raise a wait without raising the timeout and the
wait is unreachable, with nothing in the logs to say so.

## The streaming alternative

\`GET /stream/{correlation_id}\` is Server-Sent Events for the same data, with a
heartbeat every \`SSE_HEARTBEAT_INTERVAL\` seconds. It writes a \`: connected\`
comment first, so a subscription to a correlation with no traces yet still
delivers response headers immediately.
`,

	"source-ids.md": `# Source IDs

Every trace carries a \`source_id\`: a short code naming the service that
recorded it. Two letters is the convention — a trace list is read by a person
scanning a column, and full service names turn that column into a wall.

| Code | Service |
|---|---|
| MA | manager |
| WS | websocket gateway |
| WK | worker |
| TH | TracHub itself |

## Choosing one

Pick two uppercase letters that a person reading a mixed trace will map back to
your service without a lookup table, and check the existing codes first — two
services sharing a code make a run unreadable exactly where several services
meet, which is the only place traces matter.

The field is a free string; nothing enforces the length. The convention is the
whole mechanism, so a longer code works but costs every future reader.

## Where it is set

Once, in SDK configuration (\`sourceId\` in TypeScript, \`source_id\` in Python) —
not per checkpoint. A service that sets it per call will eventually set it
inconsistently.

## What uses it

\`/sources\` reports ingest rates per source, and rate limiting counts per
source, so a noisy service is visible by name rather than as an anonymous
share of the total.
`,

	"trace-format.md": `# Trace format

One checkpoint is one JSON object. A batch is \`{"traces": [ ... ]}\` posted to
\`/ingest\`.

\`\`\`json
{
  "source_id": "MA",
  "correlation_id": "req-12345-abc",
  "timestamp": 1706803200.123,
  "suffix": "x7K",
  "direction": "->",
  "operation": "REST",
  "endpoint": "/api/users",
  "data": {"id": "123"},
  "hostname": "myhost"
}
\`\`\`

| Field | Type | Required | What it is |
|---|---|---|---|
| source_id | string | yes | Which service recorded this (see source-ids.md) |
| correlation_id | string | yes | The one id that ties the whole run together |
| timestamp | number | yes | Seconds since the epoch |
| suffix | string | yes | Short unique marker for this checkpoint |
| direction | string | yes | \`->\` entering, \`<-\` leaving |
| operation | string | yes | REST, WS, GRPC, DB, … |
| endpoint | string | yes | What was operated on |
| data | object | no | Anything else worth keeping |
| hostname | string | no | Defaults to \`"unknown"\` |
| raw_line | string | no | The original log line, if there was one |

## The two fields that carry the meaning

\`correlation_id\` is the whole point: it is what makes six services' logs into
one story, so it must travel across every hop — usually as a header the caller
sets and the callee reads.

\`direction\` is what lets TracHub tell a finished run from an abandoned one. A
\`->\` without its \`<-\` is an operation that entered and never came back, which
is normally the thing being looked for.

## A batch is one transaction

Every trace in a request commits together. This is a measured decision, not a
detail: per-statement commits cost an fsync each, at roughly 18ms per trace,
turning a 500-trace batch into a nine-second request.

## What you get back

\`\`\`json
{"success": true, "ingested": 25, "correlation_ids": ["req-12345-abc"]}
\`\`\`
`,

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

List correlation IDs, most recently active first, with the trace count, the
first and last timestamp, the span between them, and the sources that
contributed. \`?limit=\` is clamped to 1-1000 (default 50).

Chains that share one second are returned in correlation_id order: \`created_at\`
is second-grained, and ordering them by true recency would mean reading every
trace of that second.

The cost is proportional to the answer, not to the stored data — the newest
chains are reached by seeks into an index rather than by grouping the table, so
a busy instance answers a browse as fast as an idle one.

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
