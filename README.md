# TraceHub

Centralized checkpoint trace collection and query service for distributed systems.

**License:** Apache 2.0 · **Live:** https://tracehub.muid.io

## Overview

Services scattered across hosts each log their own checkpoints, and reconstructing one
request from those separate logs is the problem TraceHub exists to remove. Every service
tags its checkpoints with a shared `correlation_id` and ships them here; you then ask for
that one id and get the whole chain back, in order, across every host that touched it.

- **Centralized storage** — one SQLite database, WAL mode, deduplicated on ingest
- **Real-time streaming** — SSE per correlation id
- **Adaptive sampling** — traces are collected in full only for requests someone is
  actually looking at; everything else decays to nothing
- **Auto-cleanup** — configurable retention (default 24 h), reclaiming disk as it goes

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│  Manager (muid.io)  │     │ Worker (kiberos.ai) │
│  checkpoint_logger  │     │  checkpoint_logger  │
└──────────┬──────────┘     └──────────┬──────────┘
           │                           │
           └─────────────┬─────────────┘
                         ▼
                ┌──────────────────┐
                │     TraceHub     │
                │   Bun + Hono +   │
                │  Drizzle/SQLite  │
                └────────┬─────────┘
                         ▼
                ┌──────────────────┐
                │  CLI / Grafana   │
                │   (Query API)    │
                └──────────────────┘
```

The server is TypeScript on Bun (Hono for routing, Drizzle over `bun:sqlite`). It was
rewritten from the original Python/FastAPI implementation in `812da1e`; the Python files
under `src/tracehub/` are that retired server, kept only because `client.py` still ships as
the `tracehub` PyPI package.

## Running it

```bash
bun install
bun run dev      # watch mode
bun run start    # plain run
bun run lint     # biome
```

Or with Docker, which is how it runs in production:

```bash
docker compose up -d
```

## API

### Ingest — requires `X-TraceHub-Secret` when a secret is configured

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ingest` | POST | Batch ingest (`{"traces": [...]}`) |
| `/ingest/single` | POST | Ingest one trace |

### Query

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/traces/{corr_id}` | GET | All traces for a correlation id — also marks it HOT. `?source=` filters by source, `?since_ts=` returns only traces newer than that timestamp (completeness is still judged on the whole chain), `Prefer: wait=N` holds the request until the next trace arrives instead of answering empty |
| `/traces/{corr_id}/stream` | GET | SSE stream of new traces |
| `/correlations` | GET | Recent correlation ids with counts and sources, most recently active first. `?limit=` (1–1000, default 50). Chains sharing one second come in id order — `created_at` is second-grained, and resolving finer would mean reading every row of that second |
| `/recent` | GET | Most recent traces across all correlations |

### Adaptive tracing

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tracing/config` | GET | Current sampling config; supports `Prefer: wait=N` long-poll + ETag |
| `/tracing/status` | GET | Every tracked correlation id with its state and remaining TTL |
| `/tracing/enable/{corr_id}` | POST | Force HOT |
| `/tracing/disable/{corr_id}` | POST | Force COLD |

### Admin & docs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/stats` | GET | Uptime, ingest counters, database size, memory |
| `/stats/sources` | GET | Per-source ingest rates |
| `/cleanup` | DELETE | Force retention cleanup |
| `/llms.txt`, `/llms-full.txt` | GET | AI-readable documentation |
| `/docs/{page}` | GET | Documentation pages as Markdown |
| `/help/api/{manifest,export}` | GET | context777 docs-provider contract |

## Adaptive tracing, in practice

Tracing everything is expensive and tracing nothing is useless, so TraceHub decides per
correlation id and lets attention drive the decision. Asking for a trace is the signal:
the moment you `GET /traces/{corr_id}`, that id becomes **HOT** and its services start
sending everything.

| State | Sampling rate | Duration | Entered when |
|-------|--------------|----------|--------------|
| HOT | 1.0 | 300 s | someone queries the correlation id |
| WARM | 0.1 | 1500 s | the HOT window expires |
| COLD | 0.0 | — | the WARM window expires |

Clients hold a long-poll on `/tracing/config` with `Prefer: wait=30` and an `If-None-Match`
ETag, so a state change reaches them in about a second without any polling loop. Clients
that send no `Prefer` header get an immediate answer, which keeps older SDKs working.

Reading takes the same header. `GET /traces/{corr_id}?since_ts=…` with `Prefer: wait=30`
answers the moment the next trace of that correlation is stored; with nothing new and the
chain unfinished it holds instead of returning an empty body, so a caller following a live
chain stops asking in a loop. It never holds pointlessly: a slice that already has
something to return, or a chain already `complete`, answers at once — as does a request
with no `Prefer` header, which is exactly the old behaviour.

This state lives in memory only — restarting the server returns every correlation id to
COLD.

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `TRACEHUB_PORT` | `8099` | Server port |
| `TRACEHUB_DB` | `./data/tracehub.db` | SQLite path — must be a persistent volume, never `/tmp` |
| `TRACEHUB_SECRET` | *(empty)* | Ingest secret; empty disables ingest auth |
| `TRACEHUB_RETENTION_HOURS` | `24` | Trace retention |
| `ADAPTIVE_HOT_TTL` / `ADAPTIVE_WARM_TTL` | `300` / `1500` | State durations (seconds) |
| `ADAPTIVE_WARM_RATE` / `ADAPTIVE_COLD_RATE` | `0.1` / `0.0` | Sampling rates |
| `MAX_LONGPOLL_CONNECTIONS` | `200` | Long-poll ceiling; beyond it clients get an immediate answer |
| `TRACEHUB_RATE_INGEST` / `_CONFIG` / `_QUERY` | `120` / `10` / `60` | Per-client requests per minute |
| `TRACEHUB_BAN_WARNING` / `_HARD` | `60` / `300` | Ban durations (seconds) |
| `TRACEHUB_DOCS_CENTRAL_URL` | `https://context777.com` | Docs federation target; empty serves `/help/api` without registering |
| `TRACEHUB_DOCS_SOURCE_SECRET` | *(empty)* | Shared secret for docs registration |

## Clients

**TypeScript** — `sdk/` in this repository, zero runtime dependencies.

**Python** — the `checktrace` package (1.0.0) is the current client, with long-poll config
polling and `429`/`Retry-After` backoff. The older `tracehub` package in this repo ships
`tracehub.client.TraceHubClient`, which is what `checkpoint_logger` imports today.

```python
from tracehub.client import TraceHubClient, TraceEntry

client = TraceHubClient("https://tracehub.muid.io")
client.send(TraceEntry(
    source_id="MA",
    correlation_id="req-12345",
    timestamp=time.time() * 1000,
    suffix="x7K",
    direction="->",
    operation="REST",
    endpoint="/api/agents",
))
```

Services using `checkpoint_logger` need no code change — set `TRACEHUB_URL` and
`CHECKPOINT_TRACING=1` and traces are sent automatically.

## Trace format

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

Traces are deduplicated two ways: a `UNIQUE(correlation_id, timestamp, suffix)` constraint,
and a five-minute window in which a repeat of the same
`(source_id, correlation_id, endpoint, direction)` updates the existing row instead of
adding one.

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

## Deployment

Production runs on muid.io from `/opt/tracehub`, a clone of this repository. `src/` is
bind-mounted read-only into the container, so deploying is a pull and a restart with no
image rebuild:

```bash
ssh root@muid.io
cd /opt/tracehub
git fetch origin && git reset --hard origin/main
docker compose restart tracehub
curl -s https://tracehub.muid.io/health
```

Secrets live in `/opt/tracehub/.env` and are referenced from `docker-compose.yml` as
`${VAR}` — never inline them into a tracked file. Never edit the deployed tree directly:
changes made there are invisible to everyone else and are lost on the next deploy.

The container is a kibctl bundle (`tracehub` in `/opt/kiberos/bundles.yaml`), so kibctl
owns its restart policy and boot order: `kibctl restart tracehub` is the door, and the
restart policy belongs in the bundle rather than in `docker update --restart`.

### When a rebuild is needed, name the build

Only `src/` is mounted; `node_modules` is baked into the image. A change that adds or
bumps a dependency therefore needs a rebuild, not a restart — a restart would run the new
code against the old dependency tree and fail at import time.

A rebuild overwrites the `latest` tag, and the build it displaces keeps its layers only
while some container still references them. That is exactly what happened on 2026-08-28:
the running container was the sole holder of the 28 May build, which had disappeared from
the machine's image list entirely, so a reboot would have brought the service back on
different code. Give every build a second, immutable name so the rollback point survives
independently of `latest` and of whichever container happens to be alive:

```bash
cd /opt/tracehub
docker compose build tracehub
docker tag tracehub-tracehub:latest "tracehub-tracehub:$(git rev-parse --short HEAD)"
kibctl restart tracehub
curl -s https://tracehub.muid.io/health
```

Rolling back then means pointing the container at the previous tag — which is still there
because it was named, not because something was still running it. The build now in service
is tagged `tracehub-tracehub:2026-05-28-known-good`.

## Documentation federation

TraceHub is the first adopter of the context777 docs-provider model. It embeds
`@context777/provider`, serves its own documentation through `/help/api/manifest` and
`/help/api/export`, and registers with context777 so the central index can ingest it.
Startup logs `registered with central as source 1` when this succeeds. The provider starts
gracefully: if registration fails, trace collection is unaffected.

## License

Apache License 2.0 — see [LICENSE](LICENSE)
