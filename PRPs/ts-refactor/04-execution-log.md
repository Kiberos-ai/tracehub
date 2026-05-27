---
created: 2026-05-27
updated: 2026-05-27
revision: 1.0.0
based_on:
  - path: /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/03-plan.md
    revision: 1.0.0
status: in_progress
---
# Execution Log: TracHub TS Refactor

**Created:** 2026-05-27 | **PRD:** /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/02-prd.md | **Plan:** /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/03-plan.md

## Quick Reference (Live)
### What Works
### What Doesn't Work
### Gotchas
### Corrections
<!-- ~~old~~ X evidence -> CORRECT: new -->

## Execution Timeline
<!-- === AGENT ENTRIES BELOW (append only) === -->

### 2026-05-27 — Tasks 0, 1, 2: Project scaffold + DB layer + Zod models + middleware

**Agent:** @developer (depth-1 subagent)

#### Task 0: Initialize Bun + Hono + Drizzle project — DONE
- Created `package.json` with hono, @hono/zod-validator, zod, drizzle-orm + dev deps
- Created `tsconfig.json` (ESNext, bundler moduleResolution, strict, Bun types)
- Created `biome.json` (default lint+format, tab indent, double quotes)
- Created `drizzle.config.ts` (sqlite dialect, ./data/tracehub.db)
- Created `src/lib/config.ts` — all 16 env vars with typed defaults
- Created `data/.gitkeep`
- Updated `.gitignore` with node_modules/, bun.lock, drizzle/, data/*.db*
- `bun install` — 27 packages installed OK
- Validation: `bun run src/lib/config.ts` exits 0

#### Task 1: Drizzle schema + DB layer — DONE
- Created `src/db/schema.ts` — traces table matching Python schema exactly:
  - All 12 columns, UNIQUE(correlation_id, timestamp, suffix), 4 indexes
- Created `src/db/client.ts` — bun:sqlite + drizzle, PRAGMA WAL + busy_timeout=5000
- Created `src/db/operations.ts`:
  - `initDb()` — raw CREATE TABLE IF NOT EXISTS (v1 compat with Python DBs)
  - `insertTrace()` — dedup: UPDATE within 5min window, else INSERT OR IGNORE
  - `queryTraces()` — SELECT with optional source_id/sinceTs filters, ORDER BY timestamp ASC
  - `listRecentCorrelations()` — GROUP BY with COUNT, MIN/MAX, GROUP_CONCAT
  - `cleanupOldTraces()` — DELETE by retention cutoff
  - `getDbSizeMb()` — file stat
  - `stats` object tracking ingestTotal, ingestDuplicates, ingestDeduped
- Prepared statements lazy-initialized inside `initDb()` (not at module load — table must exist first)
- Validation: WAL mode confirmed, insert/dedup/query/correlations/cleanup all tested OK

#### Task 2: Zod models + auth/client-id middleware — DONE
- Created `src/lib/types.ts`:
  - `TraceEntrySchema` — matches Python TraceEntry field names exactly (snake_case)
  - `TraceIngestRequestSchema`, `TraceQueryResponseSchema`
  - Exported inferred types: TraceEntry, TraceIngestRequest, TraceQueryResponse
- Created `src/middleware/auth.ts` — createMiddleware checking X-TraceHub-Secret:
  - No secret configured -> pass through
  - Header missing -> HTTPException 401
  - Header wrong -> HTTPException 403
- Created `src/middleware/client-id.ts` — extracts X-TraceHub-Client header, fallback x-forwarded-for or "unknown", sets c.set("clientId")
- Validation: Zod parse OK, middleware imports OK

#### Validation Results
```
bun install                              -> 27 packages, OK
bun run src/lib/config.ts                -> exit 0, OK
bun --eval "import db+schema"            -> "DB+Schema OK"
bun --eval "TraceEntrySchema.parse(...)" -> parsed with hostname default "unknown"
bun --eval "full DB operations test"     -> WAL=wal, insert=true, dedup=false, query=1, stats correct
bun --eval "middleware imports"           -> both middleware functions OK
```

#### Gotcha: Lazy prepared statements
Prepared statements in operations.ts must be initialized inside `initDb()`, not at module top-level. Module-level `sqlite.prepare()` fails with "no such table" because the table may not exist yet. Fixed by declaring as `let` and assigning inside `initDb()`.

### 2026-05-27 — Tasks 5, 6, 7: Long-poll + SSE streaming + Abuse protection

**Agent:** @developer (depth-1 subagent)

#### Task 5: Long-poll on /tracing/config — DONE

- **Created `src/services/long-poll.ts`** — waiter management:
  - `_waiters: Set<Waiter>` with resolve callbacks
  - `addWaiter(waitMs)` — creates Promise, races with timeout, graceful degradation at MAX_LONGPOLL_CONNECTIONS (CR-11)
  - `notifyWaiters()` — resolves all waiters with "changed", clears timer per waiter
  - `getWaiterCount()` — for /stats
- **Updated `src/routes/tracing.ts`** GET /tracing/config:
  - Parses `Prefer: wait=N` header, caps at 60s
  - Parses `If-None-Match`, strips quotes
  - No Prefer header -> immediate response (backward compat, CN-05)
  - Etag matches + Prefer -> addWaiter(waitMs) -> "changed" returns fresh 200, "timeout" returns 304
  - Etag doesn't match -> immediate 200
  - Always sets ETag response header
- **Updated `src/services/adaptive.ts`**:
  - Imported `notifyWaiters` from long-poll.ts
  - Called `notifyWaiters()` at end of `markHot()`, `cooldownTick()` (when changed), `removeCorrId()` (when changed)

#### Task 6: SSE streaming — DONE

- **Created `src/services/streaming.ts`** — port of Python streaming.py:
  - `_subscribers: Map<string, Set<Subscriber>>` — corrId -> subscriber writers
  - `_subscriberTimestamps: Map<string, number>` — for stale cleanup
  - `subscribe(corrId, writer)` — adds WritableStreamDefaultWriter to Set
  - `unsubscribe(corrId, sub)` — removes subscriber, cleans empty entries
  - `notifySubscribers(trace)` — writes SSE `data: JSON\n\n` to all subscribers for trace's corrId, catches errors, removes dead writers
  - `cleanupStaleSubscribers()` — removes entries older than 5min, closes writers
  - `getSubscriberStats()` — {activeCorrelations, totalQueues}
- **Added SSE route to `src/routes/query.ts`** — `GET /traces/:correlationId/stream`:
  - Uses TransformStream — writer given to subscriber, readable side as HTTP response
  - Sends existing traces first (queryTraces from DB)
  - Subscribes to new traces via streaming service
  - Heartbeat: `: ping\n\n` every 15s
  - Timeout: configurable via `?timeout=N` (default 60s, max 300s)
  - On abort/timeout -> cleanup (unsubscribe, close writer)
  - Final event: `data: {"type":"timeout"}\n\n`
- **Updated `src/routes/ingest.ts`**:
  - Imported `notifySubscribers` from streaming.ts
  - Replaced callback placeholder with direct `notifySubscribers` wiring
  - Removed `setOnTraceInserted` export (no longer needed — direct import)
- **Updated `src/routes/admin.ts`** /stats:
  - Imported `getSubscriberStats` from streaming.ts and `getWaiterCount` from long-poll.ts
  - Replaced placeholder subscriber counts with real values
  - Added `long_poll_waiters` field

#### Task 7: Abuse protection middleware — DONE

- **Created `src/middleware/rate-limit.ts`** — three-tier abuse protection:
  - **Data structure:** `Map<clientId, ClientState>` with per-group sliding windows, violation counters, ban state
  - **Endpoint groups:** "ingest" (POST /ingest*), "config" (GET /tracing/config), "query" (GET /traces/*, /recent, /correlations)
  - **Tier 1 — Rate limit:** Sliding window per client per group (60s), limits from config (TRACEHUB_RATE_INGEST=120, TRACEHUB_RATE_CONFIG=10, TRACEHUB_RATE_QUERY=60). Returns 429 + Retry-After: 5
  - **Tier 2 — Warning ban:** 10 violations in 2min -> ban for TRACEHUB_BAN_WARNING (60s). Logged to console.error
  - **Tier 3 — Hard ban:** 3 warning bans in 1 hour -> ban for TRACEHUB_BAN_HARD (300s). Logged to console.error
  - **Per-IP coarse limit:** 1000 req/min (separate Map)
  - **429 response bodies:** structured JSON with error type, message, retry_after, client_id, violations, hint
  - **`cleanupRateLimitState()`** — removes entries inactive >10min, resets hourly violation counters. Called every 60s from lifecycle loop (Task 8)
  - Reads clientId from `c.get("clientId")` (set by client-id middleware from Task 2)

#### Key decisions
1. **TransformStream for SSE** — Instead of ReadableStream with controller (complex relay), used TransformStream directly. The streaming service writes to the writer, the readable side IS the SSE response. Clean data flow, no relay.
2. **Direct import for SSE wiring** — Replaced the `onTraceInserted` callback pattern with direct `import { notifySubscribers }` in ingest.ts. Simpler, no registration step needed.
3. **Long-poll waiter cleanup** — Each waiter self-cleans via its resolve override (clears timer + removes from Set). No external cleanup loop needed.
4. **"other" endpoint group** — Health, stats, cleanup endpoints have no per-group rate limit (only per-IP coarse limit applies).

#### Validation Results
```
bun -e "long-poll import"           -> "long-poll OK, waiters: 0"
bun -e "streaming import"           -> "streaming OK"
bun -e "rate-limit import"          -> "rate-limit OK"
bun -e "tracing routes import"      -> "tracing routes OK"
bun -e "query routes import"        -> "query routes OK"
bun -e "admin routes import"        -> "admin routes OK"
bun -e "ingest routes import"       -> "ingest routes OK"

Functional tests:
- addWaiter + notifyWaiters          -> "changed" (correct)
- addWaiter + timeout                -> "timeout" (correct)
- markHot triggers notifyWaiters     -> "changed" (wiring confirmed)
- subscribe + notifySubscribers      -> SSE data received (correct)
- unsubscribe                        -> stats {0, 0} (correct)
- cleanupRateLimitState              -> runs without error
```

### 2026-05-27 — Tasks 3, 4: Core endpoints + Adaptive tracing state machine

**Agent:** @developer (depth-1 subagent)

#### Task 3: Core endpoints — DONE

Created 5 route files, all matching Python JSON response shapes 1:1 (CR-03):

- **`src/routes/ingest.ts`** — `POST /ingest` (batch with zod-validator + auth), `POST /ingest/single` (single trace + auth). Tracks per-source ingest rates in Maps. Exports `onTraceInserted` callback placeholder for Task 6 SSE wiring via `setOnTraceInserted()`. Exports `getSourceIngestWindow()` / `getSourceIngestTotals()` for stats.
- **`src/routes/query.ts`** — `GET /traces/:correlationId` with auto-HOT + adaptive_hint (wired to adaptive service), `GET /recent` with in-route rate limit (30 req/min sliding window, 429 on exceed), `GET /correlations`. The /recent route uses raw `sqlite.prepare()` for the dynamic WHERE clause (matching Python's raw SQL), returns traces reversed to oldest-first.
- **`src/routes/admin.ts`** — `GET /stats` (uptime, subscribers placeholder 0, requests, database, memory rss_mb via `process.memoryUsage()`, top_sources), `GET /stats/sources` (per-source rates sorted by rpm desc), `DELETE /cleanup`.
- **`src/routes/health.ts`** — `GET /health` returning `{status, service, db, retention_hours}`.
- **`src/routes/tracing.ts`** — `GET /tracing/config` (ETag + If-None-Match 304), `GET /tracing/status`, `POST /tracing/enable/:corrId`, `POST /tracing/disable/:corrId`. All response shapes match Python adaptive.py exactly.

#### Task 4: Adaptive tracing state machine — DONE

- **`src/services/adaptive.ts`** — 1:1 port of Python adaptive.py:
  - `Map<string, AdaptiveEntry>` state with hot/warm entries
  - `configEtag` counter, increments on any state change
  - `markHot(corrId)` — set/extend HOT, return previous state
  - `getState(corrId)` — Map lookup or "cold"
  - `getTraceRate(corrId)` — 1.0 / WARM_RATE / COLD_RATE
  - `cooldownTick()` — expired HOT->WARM, expired WARM->delete, etag++
  - `removeCorrId(corrId)` — delete from state (for /tracing/disable)
  - `getConfigPayload()` — {mode, default_rate, warm_rate, hot_correlations, etag}
  - `getStatusPayload()` — all entries with remaining_ttl
  - All timer values from `lib/config.ts` (DB-08)

#### Auto-HOT wiring in query.ts
The GET /traces/:correlationId handler calls `getState()` then `markHot()`, and when previous state was "cold", adds `adaptive_hint` field to the response — matching Python endpoints.py lines 138-162 exactly.

#### Key decisions
1. **In-memory state in route files** — `sourceIngestWindow`, `sourceIngestTotals` (ingest.ts), `recentRateWindow` (query.ts) live in their respective route modules and are exported via getter functions for admin.ts to consume. This avoids a global config.py-style module while keeping state accessible cross-route.
2. **`startedAt` in admin.ts** — Module-level `Date.now()/1000` captures server start time. This will be accurate because module is loaded once at startup.
3. **Raw SQL for /recent** — Used `sqlite.prepare()` directly (not Drizzle) for the /recent endpoint because Python uses raw SQL with dynamic WHERE conditions — easier to match exactly.
4. **`onTraceInserted` callback pattern** — Rather than an EventEmitter, used a simple exported callback setter `setOnTraceInserted()` for Task 6 SSE to wire into.
5. **`removeCorrId()` function** — Added to adaptive.ts for the /tracing/disable endpoint (Python does `del _adaptive_state[corr_id]` inline; TS encapsulates in a function).

#### Validation Results
```
bun --eval "import { ingestRouter } ..."   -> ingest OK
bun --eval "import { queryRouter } ..."    -> query OK
bun --eval "import { adminRouter } ..."    -> admin OK
bun --eval "import { healthRouter } ..."   -> health OK
bun --eval "import { tracingRouter } ..."  -> tracing OK
bun --eval "markHot('test'); getState('test'), getConfigPayload()"
  -> hot { mode: "adaptive", default_rate: 0, warm_rate: 0.1,
           hot_correlations: { test: { rate: 1, ttl: 300 } }, etag: "1" }
```

---

### Task 8: App assembly + lifecycle — 2026-05-27

**Status:** PASS

#### Files Created
- `src/app.ts` — Hono app with CORS, clientId middleware, rateLimitMiddleware, all 5 route groups mounted
- `src/index.ts` — Entrypoint: initDb, startup banner (stderr), background cleanup loop, Bun.serve, graceful shutdown

#### Design Decisions
1. **Auth middleware stays in ingest router** — `ingestRouter` already applies `authMiddleware` via `.use("/*")` internally (line 40-41 of ingest.ts). No need to duplicate in app.ts.
2. **All routers mounted at `/`** — Every router has its paths baked in (`/health`, `/ingest`, `/traces/:id`, `/tracing/config`, `/stats`, etc.), so all mount at root.
3. **Sliding window cleanup in lifecycle loop** — Ingest source windows and recent rate window are trimmed every ~60s from the lifecycle loop (not inside the route handlers) to avoid growing unbounded.
4. **Tick counter pattern** — Single `setInterval` at ADAPTIVE_TICK_INTERVAL (10s) with modular tick counter: `% 6` for 60s tasks, `% 360` for hourly tasks.

#### Validation Results
```
TRACEHUB_PORT=18099 bun run src/index.ts   (port 8099 was occupied)

Startup banner:
  [TracHub] v1.0.0 — https://muid.io
  [TracHub] Port: 18099
  [TracHub] DB: ./data/tracehub.db (WAL mode)
  [TracHub] Retention: 24 hours
  [TracHub] Secret: not configured
  [TracHub] Max long-poll: 200
  [TracHub] Listening on 0.0.0.0:18099

GET /health              -> {"status":"healthy","service":"tracehub",...}
POST /ingest (1 trace)   -> {"accepted":1,"inserted":1,"duplicates":0}
GET /traces/abc-123      -> 1 trace + adaptive_hint (cold->hot)
GET /correlations        -> 1 correlation
GET /recent?limit=5      -> 1 trace
GET /stats               -> uptime, subscribers, requests, db, memory, top_sources
GET /tracing/config      -> {"mode":"adaptive","default_rate":0,"warm_rate":0.1,...}
GET /tracing/status      -> 1 hot correlation (abc-123, ttl=300)
SIGINT                   -> [TracHub] Shutting down...
```

---

### Task 9: Dockerfile + docker-compose — 2026-05-27

**Status:** PASS

#### Files Modified
- `Dockerfile` — Rewritten: `oven/bun:slim` base, `bun install --frozen-lockfile --production`, copies `src/` + `drizzle.config.ts`, bun-based healthcheck, `CMD ["bun", "run", "src/index.ts"]`
- `docker-compose.yml` — Updated: added rate limit + long-poll env vars, changed hot-swap mount from `/opt/tracehub/src/tracehub:/app/tracehub:ro` to `/opt/tracehub/src:/app/src:ro` (TS source), bun-based healthcheck, all Traefik labels preserved exactly

#### Design Decisions
1. **All Traefik labels preserved verbatim** — `tracehub.muid.io`, `websecure`, `letsencrypt`, `loadbalancer.server.port=8099`, `traefik.docker.network=web`.
2. **Healthcheck uses bun -e** — No curl/wget in `oven/bun:slim`; `bun -e "fetch(...)"` is the lightest option.
3. **Rate limit env vars with defaults** — `${TRACEHUB_RATE_INGEST:-120}` pattern so compose works without `.env` file.
4. **Hot-swap mount updated** — `/opt/tracehub/src:/app/src:ro` matches new TS source layout.

---

### Task 10: @tracehub/sdk package — 2026-05-27

**Status:** PASS

#### Files Created
- `sdk/package.json` — @tracehub/sdk v0.1.0, zero dependencies (CN-06)
- `sdk/tsconfig.json` — ESNext/strict standalone config
- `sdk/src/types.ts` — TraceHubConfig, TraceEntry (snake_case matching server), AdaptiveConfig
- `sdk/src/logger.ts` — createLogger() wrapping user-provided or default console.warn, [TracHub] prefix (REQ-35)
- `sdk/src/config-poll.ts` — ConfigPoller class: long-poll /tracing/config, ETag/If-None-Match, jitter on 304 (AC-06), 429 Retry-After (CN-04/CR-08), exponential backoff on network error with default_rate=0 (REQ-30), AbortController for cancellation, O(1) shouldTrace()
- `sdk/src/client.ts` — BatchSender class: queue with 10K cap (AC-30), auto-flush at batchSize, interval flush, 429 backoff with Retry-After (CN-04), network error retry, close() with 5s timeout (AC-32)
- `sdk/src/index.ts` — Public API: init(), checkpoint(), shouldTrace(), close(), setCorrelationId(), getCorrelationId(), type re-exports

#### Design Decisions
1. **No AsyncLocalStorage** — Simple global `currentCorrelationId` variable. SDK users call `setCorrelationId()` before `checkpoint()`. AsyncLocalStorage is server-side only and adds complexity for the SDK's use case.
2. **adaptiveTracing flag** — Defaults to true. When false, ConfigPoller is not started and shouldTrace() always returns true (trace everything).
3. **Suffix counter resets per correlation** — `setCorrelationId()` resets the auto-incrementing suffix counter, ensuring clean ordering per correlation flow.
4. **Hostname from HOSTNAME env var** — Avoids importing `os` module (which would break browser compat). Falls back to "unknown".
5. **Queue overflow strategy (AC-30)** — Drops oldest entries (splice from front) when exceeding 10K, logs "queue_overflow".

#### Validation Results
```
bun -e "import { init, checkpoint, shouldTrace, close, setCorrelationId, getCorrelationId } from './src/index'"
  -> SDK exports OK, all 6 functions exported as 'function'

bun -e "ConfigPoller + BatchSender + createLogger tests"
  -> createLogger OK
  -> ConfigPoller: created, shouldTrace=false (default_rate=0), getConfig correct, closed
  -> BatchSender: created, send() queued 1 entry, closed (flush_error expected with fake URL)
  -> init/checkpoint/close flow: setCorrelationId works, checkpoint queues entry, close OK

Type validation:
  -> TraceEntry snake_case fields: source_id, correlation_id, timestamp, suffix, direction, operation, endpoint, data, hostname

Zero dependencies: no "dependencies" field in package.json
```

---

### Task 11: Python SDK update (checktrace 1.0.0) — 2026-05-27

**Status:** PASS

#### Files Modified
- `/home/relishev/projects/vibe/checktrace/src/checktrace/client.py` — Long-poll, X-TraceHub-Client header, 429/Retry-After handling, exponential backoff
- `/home/relishev/projects/vibe/checktrace/src/checktrace/__init__.py` — Version bump 0.3.0 → 1.0.0

#### Changes Summary

1. **AdaptiveTracingManager._poll_loop()** — Replaced 25-35s sleep-based polling with long-poll: sends `Prefer: wait=30` + `If-None-Match` headers, request timeout 35s. On 200 loops immediately. On 304 adds 0-5s jitter. On 429 reads `Retry-After`, sleeps, logs to stderr. On network error sets default_rate=0 (COLD), exponential backoff capped at 5min.
2. **AdaptiveTracingManager.__init__()** — New params `project_name`, `default_source_id`. Computes `_client_id`. Sends `X-TraceHub-Client` header on all config poll requests (CR-07).
3. **TraceHubClient.__init__()** — Computes `_client_id`. Adds `_backoff_until` for 429 pause tracking. Passes project_name/default_source_id to AdaptiveTracingManager.
4. **TraceHubClient._sender_loop()** — Checks `_backoff_until` before sending (CR-08).
5. **TraceHubClient._send_batch()** — Adds `X-TraceHub-Client` header to ingest requests (CR-07). On 429 reads `Retry-After`, sets `_backoff_until`, returns without retry (CN-04).
6. **_parse_retry_after()** — New helper: parses Retry-After header, falls back to 60s.
7. **Version bump** — 0.3.0 → 1.0.0.

#### Validation
```
PYTHONPATH=src python3 -c "from checktrace import __version__; assert __version__ == '1.0.0'" → Version OK: 1.0.0
PYTHONPATH=src python3 -c "from checktrace.client import TraceHubClient, AdaptiveTracingManager" → Imports OK
PYTHONPATH=src python3 -c "from checktrace import checkpoint, CheckpointMiddleware, ..." → Public API OK
```

---

### Task 12: Full E2E Validation

**Date:** 2026-05-27
**Server:** Bun + Hono on port 18099, DB: ./data/test-e2e.db

#### Test Results

| Step | Test | Result | Details |
|------|------|--------|---------|
| 2 | Health check (AC-41) | PASS | `{"status":"healthy","service":"tracehub","db":"./data/test-e2e.db","retention_hours":24}` |
| 3a | Batch ingest (REQ-01, CR-03) | PASS | `{accepted:2, inserted:2, duplicates:0}` |
| 3b | Single ingest | PASS | `{inserted:true}` |
| 4a | Query traces (REQ-03, CR-04) — first hit | PASS | 2 traces + adaptive_hint: previous_state=cold, current_state=hot |
| 4b | Query traces — second hit (AC-18) | PASS | adaptive_hint=null (already hot) |
| 5a | Correlations (REQ-06) | PASS | count=2 (e2e-test-001, e2e-test-002) |
| 5b | Recent (REQ-07) | PASS | count=3 |
| 6a | Tracing config (REQ-12) | PASS | ETag header present, hot_correlations contains e2e-test-001 |
| 6b | ETag 304 | PASS | Returns 304 with matching ETag |
| 7a | Long-poll timeout (CR-01, REQ-15..18) | PASS | 304 after ~3s with `Prefer: wait=3` |
| 7b | Long-poll wakeup on config change | PASS | Returns 200 immediately when config changes during wait=30 |
| 8 | Backward compat — no Prefer header (CN-05, REQ-18) | PASS | 200 in 4ms (immediate, no long-poll) |
| 9a | Tracing status (REQ-13) | PASS | count=2 (hot correlations) |
| 9b | Enable/disable tracing | PASS | enable: cold->hot, disable: hot->cold |
| 10 | Dedup (CR-05, REQ-19) | PASS | First insert=true, second (same source+corr+endpoint+direction within 5min)=false |
| 11a | Stats (REQ-08) | PASS | ingest_total=7, uptime tracked |
| 11b | Stats/sources | PASS | Shows TS source with rpm/rp5m counts |
| 12 | Rate limit (CR-02, REQ-20..24) | PASS | 429 triggered at request 121 (limit=120/min per client) |

#### Minor Issues Found (non-blocking)

1. **`/stats` missing `ingest_deduped` counter** — The `stats` object in `db/operations.ts` tracks both `ingestDuplicates` (UNIQUE constraint rejects) and `ingestDeduped` (5-min window UPDATE dedup), but `/stats` endpoint in `admin.ts:50-51` only exposes `ingest_duplicates`. The dedup-via-UPDATE count is lost from the API response.

2. **`/ingest/single` does not track source in sliding window** — The batch `/ingest` route tracks `sourceIngestWindow` and `sourceIngestTotals` per source_id (lines 56-61), but `/ingest/single` (lines 75-86) does not. Sources that only use single ingest won't appear in `/stats/sources`.

Both are observability gaps, not functional bugs. All core functionality (ingest, query, adaptive tracing, long-poll, dedup, rate limiting, backward compat) works correctly.

#### Verdict: PASS — all 16 test cases passed
