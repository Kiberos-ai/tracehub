---
created: 2026-05-27
updated: 2026-05-27
revision: 1.0.0
based_on:
  - path: /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/02-prd.md
    revision: 1.1.0
status: draft
---
# Plan: TracHub TS Refactor — Hono + Drizzle + Long-Poll + Abuse Protection

**Archon Project:** N/A

## Project Structure

### Current Layout (Python — will be replaced)
```
tracehub/
├── src/tracehub/           # Python server + client SDK (1,440 lines total)
│   ├── app.py              # FastAPI app, lifespan (80 lines)
│   ├── config.py           # Env vars, in-memory state (42 lines)
│   ├── models.py           # Pydantic models, auth (82 lines)
│   ├── db.py               # SQLite operations (186 lines)
│   ├── streaming.py        # SSE subscribers (74 lines)
│   ├── endpoints.py        # All HTTP routes (314 lines)
│   ├── adaptive.py         # HOT/WARM/COLD state machine (188 lines)
│   ├── client.py           # SDK batch sender + query client (385 lines)
│   ├── cli.py              # Entry point (44 lines)
│   ├── __init__.py         # Package exports (43 lines)
│   └── __main__.py         # python -m tracehub (2 lines)
├── Dockerfile              # python:3.12-slim
├── docker-compose.yml      # Traefik labels, hot-swap mount
├── pyproject.toml           # hatchling build
└── requirements.txt
```

### Target Layout (TypeScript)
```
tracehub/
├── src/
│   ├── index.ts            # Entry point: Bun.serve + startup log (NFR-11)
│   ├── app.ts              # Hono app factory, route mounting, CORS
│   ├── db/
│   │   ├── schema.ts       # Drizzle table definitions (traces table + indexes)
│   │   ├── client.ts       # DB connection, WAL mode, prepared statements
│   │   └── operations.ts   # insert, query, dedup, cleanup functions
│   ├── routes/
│   │   ├── ingest.ts       # POST /ingest, POST /ingest/single
│   │   ├── query.ts        # GET /traces/:corrId, GET /recent, GET /correlations
│   │   ├── tracing.ts      # GET /tracing/config (long-poll), /status, /enable, /disable
│   │   ├── admin.ts        # GET /stats, /stats/sources, DELETE /cleanup
│   │   └── health.ts       # GET /health
│   ├── middleware/
│   │   ├── auth.ts         # X-TraceHub-Secret verification
│   │   ├── rate-limit.ts   # Three-tier abuse protection (rate limit → ban)
│   │   └── client-id.ts    # Extract X-TraceHub-Client, fallback to IP
│   ├── services/
│   │   ├── adaptive.ts     # HOT/WARM/COLD state machine, mark_hot, cooldown_tick
│   │   ├── streaming.ts    # SSE subscriber management
│   │   └── long-poll.ts    # Waiter set, resolve on config change, timeout
│   ├── lib/
│   │   ├── config.ts       # Env vars with defaults (all TRACEHUB_* vars)
│   │   └── types.ts        # Zod schemas + inferred TS types (TraceEntry, etc.)
│   └── __tests__/          # Bun test files (optional, validation via curl)
├── drizzle/                # Generated migrations
├── drizzle.config.ts       # Drizzle-kit config
├── sdk/                    # @tracehub/sdk (separate package)
│   ├── src/
│   │   ├── index.ts        # Public API: init, checkpoint, shouldTrace, close
│   │   ├── client.ts       # Batch sender, 429 handling, backpressure
│   │   ├── config-poll.ts  # Long-poll with Prefer: wait, ETag, jitter
│   │   ├── types.ts        # TraceEntry, Config types
│   │   └── logger.ts       # Internal logging (REQ-35, REQ-36)
│   ├── package.json
│   └── tsconfig.json
├── Dockerfile              # oven/bun:slim
├── docker-compose.yml      # Updated mount paths
├── package.json
├── tsconfig.json
└── biome.json              # Lint + format config
```

## Context References

### Files to READ Before Implementing

| File | Lines | Why |
|------|-------|-----|
| `src/tracehub/config.py` | full (42) | All env vars + in-memory state dicts — must replicate in `lib/config.ts` |
| `src/tracehub/models.py` | full (82) | Pydantic models → Zod schemas. `verify_secret` auth → `middleware/auth.ts` |
| `src/tracehub/db.py` | full (186) | SQLite schema (CREATE TABLE), indexes, insert_trace dedup, query logic |
| `src/tracehub/adaptive.py` | full (188) | State machine: mark_hot, get_state, cooldown_tick, /tracing/* endpoints |
| `src/tracehub/endpoints.py` | full (314) | All route handlers — must match JSON responses 1:1 |
| `src/tracehub/streaming.py` | full (74) | SSE subscriber pattern → port to TS Set/Map |
| `src/tracehub/app.py` | full (80) | Lifespan, cleanup loop timing, router mounting |
| `src/tracehub/client.py` | full (385) | SDK pattern: batch sender, TraceEntry dataclass, query client |
| `Dockerfile` | full (34) | Current Docker setup — rewrite for oven/bun:slim |
| `docker-compose.yml` | full (40) | Traefik labels, volume mounts, env vars, healthcheck |

### Patterns to Follow

**Naming:** camelCase for TS (variables, functions), PascalCase for types/interfaces, SCREAMING_SNAKE for constants/env
**Routes:** Hono `app.route("/path", router)` — separate file per route group
**Middleware:** `createMiddleware()` from `hono/factory` for type safety
**Validation:** Zod schemas in `lib/types.ts`, used via `@hono/zod-validator` in routes
**DB:** Drizzle `db.select()`, `db.insert()`, `db.update()` — sync API (bun:sqlite)
**Config:** All values from `process.env` with defaults in `lib/config.ts`, typed
**Errors:** `throw new HTTPException(status, { message })` — Hono catches and formats
**SSE:** `streamSSE(c, async (stream) => { ... })` from `hono/streaming`
**State:** In-memory `Map<>` / `Set<>` for adaptive state, rate limits, subscribers

## Critical Requirements (For Execution)

```yaml
critical_requirements:
  must_have:
    - id: "CR-01"
      what: "GET /tracing/config long-poll: hold when Prefer: wait=N + etag matches, release on change or timeout"
      source: "REQ-15..18, US-01"
      why: "Core traffic reduction — without it periodic polling wastes 90%+ traffic"
    - id: "CR-02"
      what: "Three-tier abuse protection: rate limit → warning ban (60s) → hard ban (300s) per X-TraceHub-Client"
      source: "REQ-20..24, US-02"
      why: "Without auto-ban, single runaway SDK can DOS the server"
    - id: "CR-03"
      what: "All existing API endpoints return identical JSON responses as Python server"
      source: "REQ-01..10, US-03 AC-15..16"
      why: "Breaking API = breaking all deployed checktrace 0.3.0 SDKs"
    - id: "CR-04"
      what: "Adaptive tracing state machine HOT/WARM/COLD with same timers and rates"
      source: "REQ-11..14, US-03 AC-17..18"
      why: "Core feature — config changes must propagate to SDKs"
    - id: "CR-05"
      what: "Trace dedup on ingest: UPDATE if same (source_id, corr_id, endpoint, direction) within 5min"
      source: "REQ-19, US-03 AC-19"
      why: "Without dedup, MA source generates 909K traces/day"
    - id: "CR-06"
      what: "TS SDK shouldTrace() gate — skip network when false, O(1) lookup"
      source: "REQ-25..27, US-04 AC-27"
      why: "Zero overhead in COLD = main performance win"
    - id: "CR-07"
      what: "SDK sends X-TraceHub-Client header on every request"
      source: "REQ-28, REQ-32, US-02 AC-08"
      why: "Server needs client_id for fine-grained rate limiting"
    - id: "CR-08"
      what: "SDK honours 429 Retry-After: stop requests, buffer traces, exponential backoff"
      source: "REQ-29, REQ-33, US-04 AC-30"
      why: "SDK that ignores 429 IS the runaway client"
    - id: "CR-09"
      what: "SQLite WAL mode enabled at server start"
      source: "NFR-02, US-03 AC-22"
      why: "Without WAL, concurrent read/write = SQLITE_BUSY"
    - id: "CR-10"
      what: "DB path from TRACEHUB_DB env, default ./data/tracehub.db (NOT /tmp/)"
      source: "REQ-34, Architect A1"
      why: "Volatile path = data loss on reboot"
    - id: "CR-11"
      what: "Long-poll connection cap MAX_LONGPOLL_CONNECTIONS (env, default 200)"
      source: "REQ-37, Architect A4"
      why: "Unbounded connections on thundering herd"
    - id: "CR-12"
      what: "SDK logs operational events to stderr, never throws to user code"
      source: "REQ-35, Architect A2"
      why: "Without SDK logging, operators cannot diagnose missing traces"
  must_not:
    - id: "CN-01"
      what: "No DB queries in GET /tracing/config — pure in-memory"
      source: "NFR-01, REQ-12"
      why: "DB = 50-200ms, budget <10ms"
    - id: "CN-02"
      what: "SDK must NOT block main application thread"
      source: "NFR-05, US-04 AC-31"
      why: "SDK in user's app — blocking breaks their logic"
    - id: "CN-03"
      what: "SDK must NOT crash or throw on TracHub failure — fail silently to COLD"
      source: "NFR-05, US-04 AC-31"
      why: "TracHub is observability, not business-critical"
    - id: "CN-04"
      what: "SDK must NOT retry immediately after 429 — must honour Retry-After"
      source: "REQ-29, US-02"
      why: "Immediate retry IS runaway behavior"
    - id: "CN-05"
      what: "Server must NOT break checktrace 0.3.0 SDK requests (no Prefer, no X-TraceHub-Client)"
      source: "NFR-06, US-06 AC-39"
      why: "Deployed SDKs cannot be updated atomically"
    - id: "CN-06"
      what: "No external runtime deps for TS SDK — native fetch only"
      source: "NFR-10, US-04 AC-33"
      why: "External deps = version conflicts in user's project"
  decision_boundaries:
    - id: "DB-01"
      decision: "Bun runtime (not Node.js)"
      source: "Research"
      why: "Native bun:sqlite 5x faster inserts, single binary, TS-first"
    - id: "DB-02"
      decision: "Hono framework (not Express/Fastify)"
      source: "Research"
      why: "~14kb, built-in streamSSE, Web Standards API"
    - id: "DB-03"
      decision: "Drizzle + bun:sqlite sync API (not Prisma, not raw SQL)"
      source: "Research"
      why: "Type-safe thin SQL layer, zero overhead for embedded SQLite"
    - id: "DB-04"
      decision: "Long-poll with Prefer: wait (not SSE, not webhook)"
      source: "Creative §Recommendation"
      why: "95%+ traffic reduction, backward compat, trivial multi-language port"
    - id: "DB-05"
      decision: "In-memory three-tier abuse protection (not Redis, not WAF)"
      source: "Creative §Abuse Protection"
      why: "Sufficient for 5-50 clients, resets on restart = OK"
    - id: "DB-06"
      decision: "Model B Smart SDK direct to server (no local collector)"
      source: "Idea §Architecture"
      why: "API surface small (5 functions), collector adds ops overhead at our scale"
    - id: "DB-07"
      decision: "X-TraceHub-Client header: {hostname}:{project}:{source_id}"
      source: "Creative §Client Identification"
      why: "IP alone breaks behind NAT"
    - id: "DB-08"
      decision: "Adaptive timers: HOT=300s, WARM=1500s/10%, COLD=0%"
      source: "Existing adaptive.py"
      why: "Proven values, no reason to change"
    - id: "DB-09"
      decision: "Ban durations: warning=60s, hard=300s (env-configurable)"
      source: "Creative §Three-Tier + Architect B-CONFIG-3"
      why: "60s for SDK author to notice; 300s for repeat offenders"
```

## Step-by-Step Tasks

### Task 0: Initialize Bun + Hono + Drizzle project
**Action:** CREATE project scaffold
**Changes:**
- `bun init` in project root (or manually create `package.json` + `tsconfig.json`)
- `bun add hono @hono/zod-validator zod drizzle-orm`
- `bun add -d drizzle-kit @biomejs/biome @types/bun`
- Create `biome.json` with default config
- Create `drizzle.config.ts` pointing to `src/db/schema.ts` and `./data/tracehub.db`
- Create `src/lib/config.ts` — all env vars with typed defaults:
  - `TRACEHUB_DB` (default: `./data/tracehub.db`) ← CR-10
  - `TRACEHUB_PORT` (default: 8099)
  - `TRACEHUB_SECRET` (default: "")
  - `TRACEHUB_RETENTION_HOURS` (default: 24)
  - `ADAPTIVE_HOT_TTL` (300), `ADAPTIVE_WARM_TTL` (1500), `ADAPTIVE_WARM_RATE` (0.1), `ADAPTIVE_COLD_RATE` (0.0), `ADAPTIVE_TICK_INTERVAL` (10) ← DB-08
  - `MAX_LONGPOLL_CONNECTIONS` (default: 200) ← CR-11
  - `TRACEHUB_RATE_INGEST` (120), `TRACEHUB_RATE_CONFIG` (10), `TRACEHUB_RATE_QUERY` (60)
  - `TRACEHUB_BAN_WARNING` (60), `TRACEHUB_BAN_HARD` (300) ← DB-09
- Create `mkdir -p data` with `.gitkeep`
**Validate:** `bun run src/lib/config.ts` (no errors) + `bunx drizzle-kit --version`

---

### Task 1: Drizzle schema + DB layer
**File:** `src/db/schema.ts`, `src/db/client.ts`, `src/db/operations.ts`
**Action:** CREATE
**Pattern:** Match existing Python `db.py` table structure exactly ← AC-23
**Changes:**

`src/db/schema.ts`:
- `traces` table: id (integer PK autoincrement), source_id (text), correlation_id (text), timestamp (real), suffix (text), direction (text), operation (text), endpoint (text), data (text, nullable), hostname (text, nullable), raw_line (text, nullable), created_at (real, default sql`strftime('%s','now')`)
- UNIQUE constraint: (correlation_id, timestamp, suffix) — exact match
- Indexes: idx_correlation_id, idx_timestamp, idx_source_id, idx_dedup (source_id, correlation_id, endpoint, direction)

`src/db/client.ts`:
- Open bun:sqlite Database with path from config
- `PRAGMA journal_mode = WAL` ← CR-09
- `PRAGMA busy_timeout = 5000`
- Export `db = drizzle(sqlite)` instance

`src/db/operations.ts`:
- `initDb()` — `CREATE TABLE IF NOT EXISTS` for v1 (handles both fresh DB and existing Python-created DB). Drizzle migrations for future schema changes only.
- `insertTrace(entry)` — dedup logic: UPDATE if same (source_id, corr_id, endpoint, direction) within 5min, else INSERT OR IGNORE ← CR-05
- `queryTraces(corrId, sourceId?, sinceTs?)` — SELECT ordered by timestamp ASC
- `listRecentCorrelations(limit)` — GROUP BY with counts, sources
- `cleanupOldTraces()` — DELETE WHERE created_at < cutoff
- `getDbSizeMb()` — file size check
- Track `_stats` object (ingest_total, ingest_duplicates, ingest_deduped)

**Validate:** `bun run -e "import { db } from './src/db/client'; console.log('DB OK')"` + check WAL mode

---

### Task 2: Zod models + auth middleware
**File:** `src/lib/types.ts`, `src/middleware/auth.ts`, `src/middleware/client-id.ts`
**Action:** CREATE
**Pattern:** Match Python `models.py` field names exactly ← CR-03

`src/lib/types.ts`:
- `TraceEntrySchema` (Zod): source_id (string), correlation_id (string), timestamp (number), suffix (string), direction (string), operation (string), endpoint (string), data (object, optional), hostname (string, default "unknown"), raw_line (string, optional)
- `TraceIngestRequestSchema`: { traces: TraceEntrySchema[] }
- `TraceQueryResponseSchema`: { correlation_id, traces, count, complete }
- Export inferred types: `type TraceEntry = z.infer<typeof TraceEntrySchema>`

`src/middleware/auth.ts`:
- `createMiddleware()` — check `X-TraceHub-Secret` header against `config.TRACEHUB_SECRET`
- If secret configured and header missing/wrong → `throw new HTTPException(401/403)` ← REQ-10
- If no secret configured → pass through

`src/middleware/client-id.ts`:
- Extract `X-TraceHub-Client` from header, fallback to `c.req.header("x-forwarded-for") || IP`
- Set `c.set("clientId", value)` for downstream rate-limit middleware
- Legacy SDK without header → IP-based identification ← CN-05

**Validate:** `bun run src/lib/types.ts` (types parse) + `bun test` (if unit tests added)

### Task 3: Core endpoints (ingest, query, health, stats)
**Files:** `src/routes/ingest.ts`, `src/routes/query.ts`, `src/routes/admin.ts`, `src/routes/health.ts`
**Action:** CREATE
**Pattern:** Match Python `endpoints.py` response JSON exactly ← CR-03

`src/routes/ingest.ts`:
- `POST /ingest` — validate with `TraceIngestRequestSchema`, loop traces, call `insertTrace()`, notify SSE subscribers. Return `{accepted, inserted, duplicates}`. Auth middleware applied ← REQ-01
- `POST /ingest/single` — validate single TraceEntry, insert, notify. Return `{inserted}` ← REQ-02
- Track per-source rates in `_source_ingest_window` / `_source_ingest_totals` Maps

`src/routes/query.ts`:
- `GET /traces/:correlationId` — call `queryTraces()`, compute `complete` (entries == exits), return `TraceQueryResponse`. Auto-HOT + adaptive_hint added in Task 4 ← REQ-03
- `GET /recent` — direct SQL query with limit/since_id/source filters, in-route rate limit (30 req/min via dedicated sliding window, separate from middleware rate-limit groups), exclude corr_id "-" ← REQ-07
- `GET /correlations` — call `listRecentCorrelations(limit)` ← REQ-06

`src/routes/admin.ts`:
- `GET /stats` — uptime, subscriber count, ingest totals, DB size, RSS memory, top sources ← REQ-08
- `GET /stats/sources` — per-source RPM/RP5M sorted by RPM desc ← REQ-08
- `DELETE /cleanup` — call `cleanupOldTraces()`, return `{deleted}` ← REQ-09 (health)

`src/routes/health.ts`:
- `GET /health` — return `{status: "healthy", service: "tracehub", db, retention_hours}` ← REQ-09, AC-41

**Validate:** `bun run src/index.ts & curl localhost:8099/health` → `{"status":"healthy",...}`

---

### Task 4: Adaptive tracing state machine + /tracing/* endpoints
**File:** `src/services/adaptive.ts`, `src/routes/tracing.ts`
**Action:** CREATE
**Pattern:** Match Python `adaptive.py` logic 1:1 ← CR-04

`src/services/adaptive.ts`:
- Constants from config: `ADAPTIVE_HOT_TTL`, `ADAPTIVE_WARM_TTL`, `ADAPTIVE_WARM_RATE`, `ADAPTIVE_COLD_RATE`, `ADAPTIVE_TICK_INTERVAL` ← DB-08
- State: `_adaptiveState: Map<string, {state, expiresAt, queriedAt}>`
- `_configEtag: number` (starts 0, increments on change)
- `markHot(corrId): string` — set/extend HOT, increment etag, return previous state
- `getState(corrId): "hot"|"warm"|"cold"` — lookup or "cold" if absent
- `getTraceRate(corrId): number` — 1.0/WARM_RATE/COLD_RATE based on state
- `cooldownTick()` — iterate Map, HOT→WARM (expired), WARM→delete (expired), increment etag if changed ← REQ-14
- `getConfigEtag(): number` — return current etag
- `getConfigPayload()` — return `{mode, default_rate, warm_rate, hot_correlations, etag}` ← REQ-12, CN-01

`src/routes/tracing.ts`:
- `GET /tracing/config` — immediate response (long-poll logic added in Task 5) ← REQ-12
- `GET /tracing/status` — return all HOT/WARM entries with remaining TTL ← REQ-13
- `POST /tracing/enable/:corrId` — call `markHot()`, return state ← REQ-13
- `POST /tracing/disable/:corrId` — remove from state, return state ← REQ-13

**Wire auto-HOT into query.ts:**
- In `GET /traces/:correlationId`: call `getState()` BEFORE `markHot()`, if previous was "cold" → add `adaptive_hint` to response ← CR-04, AC-18

**Validate:** `curl localhost:8099/tracing/config` → `{mode:"adaptive",...}`

---

### Task 5: Long-poll on /tracing/config
**File:** `src/services/long-poll.ts`, update `src/routes/tracing.ts`
**Action:** CREATE + UPDATE
**Source:** REQ-15..18, REQ-37, CR-01, CR-11

`src/services/long-poll.ts`:
- `_waiters: Set<{resolve: () => void, etag: string}>` — pending long-poll connections
- `_currentWaiterCount: number` — track for cap
- `addWaiter(etag): Promise<"changed"|"timeout">` — if `_currentWaiterCount >= MAX_LONGPOLL_CONNECTIONS` → return "changed" immediately (graceful degradation) ← CR-11
- Otherwise: create Promise, add to Set, `Promise.race([configChanged, Bun.sleep(waitMs)])` → remove from Set on resolve
- `notifyWaiters()` — resolve all waiters → they return "changed". Called from `markHot()` and `cooldownTick()` when etag changes
- `getWaiterCount(): number` — for /stats

**Update `src/routes/tracing.ts` GET /tracing/config:**
- Parse `Prefer` header: extract `wait=N`, cap at 60s
- Parse `If-None-Match` header, strip quotes
- If no `Prefer` header → immediate response (backward compat) ← CN-05, REQ-18
- If etag matches current → `addWaiter(etag)` → await → if "changed" return 200 with new config, if "timeout" return 304 ← REQ-15..17
- If etag doesn't match → immediate 200 with current config
- Set `ETag` header on response

**Wire notifyWaiters into adaptive.ts:**
- Import and call `notifyWaiters()` at end of `markHot()` and `cooldownTick()` (when etag changed)

**Validate:** `curl -H 'If-None-Match: "0"' -H 'Prefer: wait=5' localhost:8099/tracing/config` → hangs 5s → 304

### Task 6: SSE streaming
**File:** `src/services/streaming.ts`, update `src/routes/query.ts`
**Action:** CREATE + UPDATE
**Pattern:** Match Python `streaming.py` ← REQ-05, AC-20

`src/services/streaming.ts`:
- `_subscribers: Map<string, Set<ReadableStreamController>>` — corr_id → subscriber set
- `_subscriberTimestamps: Map<string, number>` — corr_id → last activity
- `subscribe(corrId): ReadableStreamController` — add to Set, update timestamp
- `unsubscribe(corrId, controller)` — remove from Set, cleanup empty entries
- `notifySubscribers(trace: TraceEntry)` — write SSE `data:` to all subscribers for that corr_id. Remove dead controllers
- `cleanupStaleSubscribers()` — remove entries older than 5min

**Update `src/routes/query.ts` GET /traces/:correlationId/stream:**
- Use Hono `streamSSE(c, async (stream) => { ... })`
- Send existing traces first (query DB)
- Subscribe to new traces
- Heartbeat: `stream.write(": ping\n\n")` every 15s ← AC-20
- Timeout configurable (query param, default 60s)
- `stream.onAbort()` → unsubscribe (cleanup)
- Final event: `data: {"type": "timeout"}`

**Wire notifySubscribers into ingest.ts:**
- After successful `insertTrace()` → call `notifySubscribers(trace)` for real-time streaming

**Validate:** `curl -N localhost:8099/traces/test-123/stream` → receives heartbeat pings

---

### Task 7: Abuse protection middleware (three-tier)
**File:** `src/middleware/rate-limit.ts`
**Action:** CREATE
**Source:** REQ-20..24, CR-02, DB-05, DB-09

**Data structure:**
```ts
Map<clientId, {
  windows: Map<endpointGroup, number[]>,  // timestamps
  violations: number,                      // count in current 2min window
  banUntil: number | null,                 // Unix ms
  banTier: 0 | 1 | 2,                     // ok, warning, hard
  warningBanCount: number,                 // in last hour
  lastWarningBanAt: number,
}>
```

**Endpoint groups:** `"ingest"` (POST /ingest*), `"config"` (GET /tracing/config), `"query"` (GET /traces/*, /recent, /correlations)

**Logic (createMiddleware):**
1. Extract `clientId` from `c.get("clientId")` (set by client-id middleware)
2. Check ban: if `banUntil > now` → return 429 with structured JSON body ← AC-12
3. Check per-IP coarse limit (1000 req/min) ← REQ-24
4. Determine endpoint group from path
5. Check sliding window rate for this clientId + group
6. If over limit → 429 + `Retry-After: 5` + increment violations ← AC-09
7. If violations >= 10 in 2min → warning ban (TRACEHUB_BAN_WARNING seconds) ← AC-10
8. If warningBanCount >= 3 in 1 hour → hard ban (TRACEHUB_BAN_HARD seconds) ← AC-11
9. Log ban events to stderr: `[TracHub] Client {clientId} banned (tier {N}) for {seconds}s` ← NFR-07
10. Pass through if OK

**429 response body:**
```json
{
  "error": "temporary_ban" | "rate_limit_exceeded",
  "message": "Client temporarily banned: ...",
  "ban_seconds": 60,
  "retry_after": 60,
  "client_id": "...",
  "violations": 15,
  "hint": "If using @tracehub/sdk, ensure batch_size >= 10"
}
```

**Cleanup function** (called from lifecycle loop every 60s):
- Remove entries with no activity in last 10min
- Reset hourly violation counters

**Validate:** Script: send 150 rapid requests → verify 429 after 120th → verify ban after sustained abuse

---

### Task 8: App assembly + lifecycle
**File:** `src/app.ts`, `src/index.ts`
**Action:** CREATE
**Pattern:** Match Python `app.py` lifecycle ← REQ-14

`src/app.ts`:
- Create Hono app
- Add CORS middleware (allow all — same as current)
- Mount middleware in order: client-id → rate-limit → routes
- Mount auth middleware only on ingest routes
- Mount route groups: `app.route("/", health)`, `app.route("/", ingest)`, `app.route("/", query)`, `app.route("/", tracing)`, `app.route("/", admin)`
- Export `app`

`src/index.ts`:
- Import app, config, db
- Initialize DB (create table, WAL mode)
- Startup log: port, DB path, WAL mode, retention, secret (yes/no), max long-poll ← NFR-11
- Start cleanup loop (setInterval):
  - Every `ADAPTIVE_TICK_INTERVAL` (10s): `cooldownTick()` ← REQ-14
  - Every ~60s (6 ticks): `cleanupStaleSubscribers()`, rate window cleanup, source window cleanup
  - Every ~1h (360 ticks): `cleanupOldTraces()` — log if deleted > 0
  - Every 60s: rate-limit map cleanup
- `Bun.serve({ fetch: app.fetch, port: config.TRACEHUB_PORT })`
- Graceful shutdown: `process.on("SIGTERM/SIGINT")` → cancel intervals

**Validate:** `bun run src/index.ts` → startup log printed → `/health` returns OK → cleanup loop runs

### Task 9: Dockerfile + docker-compose
**Files:** `Dockerfile`, `docker-compose.yml`
**Action:** UPDATE (rewrite)
**Source:** AC-38..41, CR-10

`Dockerfile`:
```dockerfile
FROM oven/bun:slim
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY drizzle.config.ts ./
RUN mkdir -p /data
ENV TRACEHUB_PORT=8099
ENV TRACEHUB_DB=/data/tracehub.db
ENV TRACEHUB_RETENTION_HOURS=72
ENV TRACEHUB_SECRET=""
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:8099/health').then(r=>{if(!r.ok)process.exit(1)})" || exit 1
CMD ["bun", "run", "src/index.ts"]
```

`docker-compose.yml`:
- Same Traefik labels (tracehub.muid.io, websecure, letsencrypt) ← AC-38
- Volume: `tracehub_data:/data`
- Hot-swap mount: `/opt/tracehub/src:/app/src:ro` ← AC-40
- Same env vars + `MAX_LONGPOLL_CONNECTIONS`, rate limit vars
- Network: `web` (external)

**Validate:** `docker compose build` → image < 100MB ← NFR-08

---

### Task 10: TS SDK (`@tracehub/sdk`)
**Files:** `sdk/` directory
**Action:** CREATE new package
**Source:** US-04, REQ-25..30, REQ-35..36, CR-06..08, CR-12, CN-02..04, CN-06

`sdk/package.json`:
- name: `@tracehub/sdk`, version: `0.1.0`
- main: `src/index.ts`, types: `src/index.ts`
- Zero dependencies ← CN-06

`sdk/src/types.ts`:
- `TraceHubConfig`: { url, secret?, clientId?, projectName?, sourceId?, batchSize?, flushInterval?, logger? }
- `TraceEntry`: { source_id, correlation_id, timestamp, suffix, direction, operation, endpoint, data?, hostname? }
- `AdaptiveConfig`: { mode, default_rate, warm_rate, hot_correlations, etag }

`sdk/src/logger.ts`:
- Default logger: `console.warn`
- `createLogger(userLogger?)` — returns `(event, details) => { ... }` ← REQ-35, REQ-36
- Events: `rate_limited`, `banned`, `connection_lost`, `reconnecting`, `backoff`

`sdk/src/config-poll.ts`:
- `ConfigPoller` class:
  - Long-poll loop: `fetch(url/tracing/config, { headers: {"If-None-Match": etag, "Prefer": "wait=30", "X-TraceHub-Client": clientId} })` ← CR-01
  - On 200 → update cached config, restart loop
  - On 304 → restart loop (jitter 0-5s) ← AC-06
  - On 429 → read Retry-After, pause loop ← CR-08
  - On network error → COLD mode (default_rate=0), retry with backoff ← REQ-30
  - `shouldTrace(corrId): boolean` — O(1) check: hot_correlations has corrId → true, else `Math.random() < default_rate` ← CR-06
  - `close()` → abort current fetch, stop loop

`sdk/src/client.ts`:
- `BatchSender` class:
  - Queue: `TraceEntry[]` (max 10K buffer) ← AC-30
  - Timer: flush every `flushInterval` (default 1s) or at `batchSize` (default 10) ← REQ-26
  - `send(entry)` — if `configPoller.shouldTrace(entry.correlation_id)` → push to queue, else skip ← CR-06
  - `_flush()` — POST /ingest with batch, X-TraceHub-Secret + X-TraceHub-Client headers ← CR-07
  - On 429 → pause, honour Retry-After, exponential backoff (cap 5min) ← CR-08, CN-04
  - On network error → buffer, retry with backoff
  - `close()` → flush with 5s timeout, abort if exceeded ← AC-32

`sdk/src/index.ts`:
- `init(config: TraceHubConfig)` → create ConfigPoller + BatchSender ← AC-24
- `checkpoint(direction, operation, endpoint, data?)` → create TraceEntry, call sender.send() ← AC-25
- `shouldTrace(corrId)` → delegate to ConfigPoller ← AC-27
- `close()` → flush + stop poller ← AC-32
- `setCorrelationId(id)` / `getCorrelationId()` — AsyncLocalStorage or global var

**Validate:** `cd sdk && bun run src/index.ts` (no errors) + unit test: shouldTrace returns false in COLD

---

### Task 11: Python SDK update (checktrace 1.0.0)
**Files:** `/home/relishev/projects/vibe/checktrace/src/checktrace/client.py`
**Action:** UPDATE
**Source:** US-05, REQ-31..33, AC-34..37

**Changes to `AdaptiveTracingManager._poll_loop()`:**
- Replace `time.sleep(jitter)` with long-poll: `httpx.get(url, headers={"If-None-Match": etag, "Prefer": "wait=30"}, timeout=35)` ← REQ-31, AC-34
- On 304 → continue loop (add jitter 0-5s)
- On 429 → read `Retry-After`, sleep that duration, log warning ← REQ-33, AC-36
- On network error → default_rate=0 (COLD), backoff sleep

**Changes to `TraceHubClient._send_batch()`:**
- Add `X-TraceHub-Client` header: `{socket.gethostname()}:{config.project_name}:{config.default_source_id}` ← REQ-32, AC-35
- On 429 → read `Retry-After`, pause sender for that duration, log `[TracHub] Rate limited, retrying in {N}s`

**Changes to `AdaptiveTracingManager.__init__()`:**
- Also add `X-TraceHub-Client` header to config poll requests

**Preserve all existing API:** `@checkpoint`, `CheckpointMiddleware`, `checkpoint_entry/exit`, `init_tracing()` ← AC-37

**Bump version:** `__version__ = "1.0.0"` in `__init__.py`

**Validate:** `cd checktrace && python3 -c "from checktrace import __version__; print(__version__)"` → `1.0.0`

---

### Task 12: E2E validation + backward compat test
**Action:** VERIFY
**Source:** US-06, AC-38..41, CR-03, CN-05

**Step 1: Start TS server locally**
```bash
cd tracehub && bun run src/index.ts
```
Verify startup log ← NFR-11

**Step 2: Verify all existing endpoints (backward compat)**
```bash
# Health
curl -s localhost:8099/health | jq .
# Ingest (same JSON as Python)
curl -s -X POST localhost:8099/ingest -H 'Content-Type: application/json' \
  -d '{"traces":[{"source_id":"TS","correlation_id":"test-e2e","timestamp":1234567890,"suffix":"abc","direction":"->","operation":"TEST","endpoint":"/test"}]}'
# Query
curl -s localhost:8099/traces/test-e2e | jq .
# Correlations
curl -s localhost:8099/correlations | jq .
# Stats
curl -s localhost:8099/stats | jq .
# Tracing config
curl -s localhost:8099/tracing/config | jq .
```

**Step 3: Verify long-poll**
```bash
# Should hang ~5s then return 304
curl -v -H 'If-None-Match: "0"' -H 'Prefer: wait=5' localhost:8099/tracing/config
# In parallel: enable hot → should release immediately
curl -X POST localhost:8099/tracing/enable/test-lp
```

**Step 4: Verify adaptive_hint**
```bash
curl -s localhost:8099/traces/cold-corr-id | jq '.adaptive_hint'
# Should contain {previous_state: "cold", current_state: "hot", message: ..., retry_after_seconds: 45}
```

**Step 5: Verify abuse protection**
```bash
# Rapid fire 130 requests → should get 429 after ~120
for i in $(seq 1 130); do curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8099/ingest -H 'Content-Type: application/json' -H 'X-TraceHub-Client: test:abuse:XX' -d '{"traces":[]}'; done | sort | uniq -c
```

**Step 6: Verify old SDK compat (no Prefer, no X-TraceHub-Client)**
```bash
# Simulates checktrace 0.3.0 — no special headers
curl -s localhost:8099/tracing/config  # immediate response, not long-poll
curl -s -X POST localhost:8099/ingest -H 'X-TraceHub-Secret: ...' -H 'Content-Type: application/json' \
  -d '{"traces":[{"source_id":"MA","correlation_id":"legacy-test","timestamp":1234,"suffix":"xyz","direction":"->","operation":"REST","endpoint":"/api"}]}'
```

**Step 7: Docker build + deploy**
```bash
docker compose build
docker compose up -d
curl -s https://tracehub.muid.io/health | jq .
```

**Validate:** All steps pass, image < 100MB ← NFR-08

## Validation Commands

### After Each Task
```bash
bun run --bun src/index.ts &    # start server
sleep 1
curl -sf localhost:8099/health   # health check
kill %1                          # stop server
```

### Type Check
```bash
bun x tsc --noEmit
```

### Lint + Format
```bash
bun x biome check src/ sdk/
```

### Final E2E (Task 12)
```bash
bun run src/index.ts &
sleep 1
# All curl commands from Task 12
kill %1
```

### Docker Build Size
```bash
docker compose build
docker images tracehub --format '{{.Size}}'  # must be < 100MB
```

## Dependency Graph

```
Task 0 (project init) ──────────────────────────────────────────────┐
    │                                                                │
    ▼                                                                │
Task 1 (schema + DB) ──→ Task 3 (core endpoints) ──→ Task 6 (SSE)  │
    │                         │                          │           │
    ▼                         ▼                          │           │
Task 2 (models + auth) ──→ Task 4 (adaptive) ──→ Task 5 (long-poll) │
                              │                          │           │
                              ▼                          ▼           │
                         Task 7 (abuse protection) ──────────────────┤
                              │                                      │
                              ▼                                      │
                         Task 8 (app assembly) ──→ Task 9 (Docker)   │
                                                       │             │
                                                       ▼             │
                                                  Task 12 (E2E) <────┤
                                                       ▲             │
Task 10 (TS SDK) ──────────────────────────────────────┘             │
Task 11 (Python SDK update) ───────────────────────────┘             │
```

**Parallelizable groups:**
- Tasks 1 + 2 can start in parallel (both depend only on Task 0)
- Tasks 3 + 4 can start in parallel (both depend on 1 + 2)
- Tasks 10 + 11 can be done in parallel with server tasks (independent packages)
- Task 12 requires all other tasks complete

**Critical path:** 0 → 1 → 3 → 4 → 5 → 8 → 9 → 12

## Next Step
Run: `/lat-dev-kit:s3.5-validate-plan /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/03-plan.md`
