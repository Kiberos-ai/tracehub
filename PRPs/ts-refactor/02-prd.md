---
created: 2026-05-27
updated: 2026-05-27
revision: 1.1.0
based_on:
  - path: /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/01-idea.md
    revision: 1.0.0
  - path: /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/01.5-creative.md
    revision: 1.0.0
  - path: /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/02.5-architect-review.md
    revision: 1.0.0
status: approved
---
# PRP: TracHub TS Refactor — Hono + Drizzle + Long-Poll + Abuse Protection

**Complexity:** high | **Archon:** N/A

## Overview
Полный рефакторинг TracHub сервера с Python/FastAPI на TypeScript (Bun + Hono + Drizzle + bun:sqlite). Замена periodic polling на long-poll (`Prefer: wait=N`) для config endpoint. Добавление three-tier abuse protection (rate limit → warning ban → hard ban). Создание TypeScript SDK (`@tracehub/sdk`) как primary, обновление Python SDK (checktrace 1.0.0). Все существующие API endpoints и adaptive tracing (HOT/WARM/COLD) сохраняются 1:1. Backward compatible с checktrace 0.3.0.

## User Stories

### US-01: Config Long-Poll (Primary)
As a **SDK client** polling for tracing config, I want the server to hold my request until config actually changes, so that there's zero traffic when nothing changes and I get instant notification when it does.

**Acceptance Criteria:**
- [ ] **AC-01** SDK sends `GET /tracing/config` with `If-None-Match: "{etag}"` and `Prefer: wait=30`
- [ ] **AC-02** Server holds connection up to `wait` seconds (cap 60s) when etag matches current
- [ ] **AC-03** Server returns `200` with new config immediately when config changes during hold
- [ ] **AC-04** Server returns `304 Not Modified` when hold timeout expires without changes
- [ ] **AC-05** SDK without `Prefer` header receives immediate 200/304 response (backward compat)
- [ ] **AC-06** SDK reconnects with random 0-5s jitter after disconnect/timeout (thundering herd protection)
- [ ] **AC-07** Traffic reduced by 90%+ compared to periodic 30s polling under stable config

### US-02: Abuse Protection
As a **server operator**, I want runaway or abusive clients to be automatically detected and temporarily banned, so that a single misbehaving SDK cannot overwhelm the server.

**Acceptance Criteria:**
- [ ] **AC-08** Rate limits per `X-TraceHub-Client` header (or IP fallback): `/ingest` 120 req/min, `/tracing/config` 10 req/min, `/traces/*` 60 req/min
- [ ] **AC-09** Exceeding rate limit → `429 Too Many Requests` + `Retry-After` header
- [ ] **AC-10** 10+ rate-limit violations in 2 min → warning ban (60s), all requests → 429 with `{"error": "temporary_ban", "ban_seconds": 60, ...}`
- [ ] **AC-11** 3+ warning bans in 1 hour → hard ban (300s)
- [ ] **AC-12** Ban response includes: `error`, `message`, `ban_seconds`, `retry_after`, `client_id`, `violations`, `hint`
- [ ] **AC-13** Normal SDK clients NEVER see 429 under standard operation (rate limits have 10x headroom)
- [ ] **AC-14** Per-IP coarse limit: 1000 req/min total (safety net for NAT)

### US-03: TS Server (Hono + Drizzle)
As a **maintainer**, I want the TracHub server on our standard TS stack (Bun + Hono + Drizzle), so it's consistent with our tooling and benefits from Bun's native SQLite performance.

**Acceptance Criteria:**
- [ ] **AC-15** All existing endpoints work identically (same JSON request/response contract)
- [ ] **AC-16** POST /ingest, GET /traces/{corr_id}, GET /tracing/config, GET /health — same behavior
- [ ] **AC-17** Adaptive tracing (HOT/WARM/COLD state machine) preserved 1:1
- [ ] **AC-18** Auto-HOT on GET /traces/{corr_id}, adaptive_hint when previous state was COLD
- [ ] **AC-19** Trace deduplication on ingest: UPSERT by (source_id, correlation_id, endpoint, direction) within 5min window
- [ ] **AC-20** SSE streaming on /traces/{corr_id}/stream with heartbeat pings
- [ ] **AC-21** X-TraceHub-Secret auth on ingest endpoints (same as current)
- [ ] **AC-22** SQLite WAL mode enabled, bun:sqlite sync driver via Drizzle
- [ ] **AC-23** Drizzle schema matches existing SQLite table structure (traces table + indexes)

### US-04: TypeScript SDK
As a **TS/JS developer**, I want a `@tracehub/sdk` package to emit traces from my application, with long-poll config, adaptive tracing gate, and proper backpressure handling.

**Acceptance Criteria:**
- [ ] **AC-24** `init(config)` → initialize SDK with tracehub_url, secret, client_id, source_id
- [ ] **AC-25** `checkpoint(direction, operation, endpoint, data?)` → queue trace entry
- [ ] **AC-26** Background batch sender: flush every 1s or when batch_size (10) reached
- [ ] **AC-27** `shouldTrace(correlationId)` → O(1) check against cached config
- [ ] **AC-28** Long-poll config with `Prefer: wait=30` + `If-None-Match` + jitter on reconnect
- [ ] **AC-29** `X-TraceHub-Client` header sent on every request
- [ ] **AC-30** On 429 → honour `Retry-After`, buffer traces (up to 10K), exponential backoff
- [ ] **AC-31** On TracHub unreachable → COLD mode (don't trace), retry with backoff
- [ ] **AC-32** `close()` → flush pending (timeout 5s, drop if exceeded), stop background tasks. MUST NOT block indefinitely
- [ ] **AC-33** Zero external dependencies (uses native `fetch`)

### US-05: Python SDK Update
As a **Python developer** using checktrace, I want the SDK updated to use long-poll and send `X-TraceHub-Client` header, so I benefit from reduced traffic and abuse protection.

**Acceptance Criteria:**
- [ ] **AC-34** Config poll switches to long-poll: `Prefer: wait=30` + `If-None-Match`
- [ ] **AC-35** `X-TraceHub-Client` header sent on every request
- [ ] **AC-36** On 429 → honour `Retry-After`, buffer traces, exponential backoff
- [ ] **AC-37** All existing checktrace API preserved (backward compat): `@checkpoint`, `CheckpointMiddleware`, `checkpoint_entry/exit`

### US-06: Zero-Downtime Migration
As a **DevOps engineer**, I want to switch from Python to TS server with zero downtime and no client breakage.

**Acceptance Criteria:**
- [ ] **AC-38** TS server deployed on same port (8099) behind Traefik at tracehub.muid.io
- [ ] **AC-39** Existing checktrace 0.3.0 SDK works unchanged against TS server
- [ ] **AC-40** Docker image uses oven/bun:slim, hot-swap mount preserved
- [ ] **AC-41** Healthcheck endpoint /health returns compatible response

## Requirements
### Functional

**Server Core:**
1. **REQ-01** Server SHALL accept `POST /ingest` with batch of trace entries (same JSON schema as current Python server)
2. **REQ-02** Server SHALL accept `POST /ingest/single` with single trace entry
3. **REQ-03** Server SHALL return traces for `GET /traces/{correlation_id}` ordered by timestamp ASC
4. **REQ-04** Server SHALL auto-activate HOT tracing on `GET /traces/{correlation_id}` and include `adaptive_hint` when previous state was COLD
5. **REQ-05** Server SHALL stream traces via SSE on `GET /traces/{correlation_id}/stream` with 15s heartbeat pings
6. **REQ-06** Server SHALL list recent correlations on `GET /correlations`
7. **REQ-07** Server SHALL return recent traces on `GET /recent` with rate limiting (30 req/min)
8. **REQ-08** Server SHALL return stats on `GET /stats` and `GET /stats/sources`
9. **REQ-09** Server SHALL return health on `GET /health`
10. **REQ-10** Server SHALL validate `X-TraceHub-Secret` on ingest endpoints when `TRACEHUB_SECRET` env is set
11. **REQ-34** Server SHALL read DB path from `TRACEHUB_DB` env var (default: `./data/tracehub.db`). Default MUST NOT be `/tmp/` or any volatile filesystem. Docker volume mount for data directory required.
      ← Architect review A1: "CONFIG-001 — `/tmp/tracehub.db` is volatile, data lost on reboot"

**Adaptive Tracing:**
11. **REQ-11** Server SHALL maintain HOT/WARM/COLD state machine: HOT (5min TTL, 100%) → WARM (25min TTL, 10%) → COLD (0%)
12. **REQ-12** Server SHALL expose `GET /tracing/config` returning mode, default_rate, warm_rate, hot_correlations, etag
13. **REQ-13** Server SHALL expose `GET /tracing/status`, `POST /tracing/enable/{corr_id}`, `POST /tracing/disable/{corr_id}`
14. **REQ-14** Server SHALL run cooldown_tick every 10s transitioning expired states

**Long-Poll:**
15. **REQ-15** Server SHALL support long-poll on `GET /tracing/config`: when client sends `Prefer: wait=N` and `If-None-Match` matching current etag, server holds connection up to N seconds (cap 60s)
16. **REQ-16** Server SHALL release held connection immediately when config changes (etag increments)
17. **REQ-17** Server SHALL return `304 Not Modified` when hold timeout expires without config change
18. **REQ-18** Server SHALL return immediate 200/304 when client omits `Prefer` header (backward compat)
19. **REQ-37** Server SHALL cap concurrent long-poll connections at `MAX_LONGPOLL_CONNECTIONS` (env, default 200). Connections beyond cap SHALL receive immediate 200 with current config (graceful degradation to periodic poll)
      ← Architect review A4: "Without cap, server restart + thundering herd = unbounded connection accumulation"

**Deduplication:**
19. **REQ-19** Server SHALL deduplicate traces on ingest: UPDATE existing row if same (source_id, correlation_id, endpoint, direction) within 5min window

**Abuse Protection:**
20. **REQ-20** Server SHALL rate-limit per `X-TraceHub-Client` header (fallback: IP): `/ingest` 120 req/min, `/tracing/config` 10 req/min, `/traces/*` 60 req/min. Thresholds SHALL be env-configurable (`TRACEHUB_RATE_INGEST`, `TRACEHUB_RATE_CONFIG`, `TRACEHUB_RATE_QUERY`) with stated values as defaults
21. **REQ-21** Server SHALL escalate to warning ban (60s) after 10+ rate-limit violations in 2min
22. **REQ-22** Server SHALL escalate to hard ban (300s) after 3+ warning bans in 1 hour
23. **REQ-23** Server SHALL return 429 with structured JSON body including error, message, ban_seconds, retry_after, client_id, violations, hint
24. **REQ-24** Server SHALL enforce per-IP coarse limit of 1000 req/min

**TS SDK:**
25. **REQ-25** SDK SHALL provide `init(config)`, `checkpoint(dir, op, endpoint, data?)`, `shouldTrace(corrId)`, `close()`
26. **REQ-26** SDK SHALL batch traces and flush every 1s or at batch_size (default 10)
27. **REQ-27** SDK SHALL long-poll `/tracing/config` with `Prefer: wait=30` + `If-None-Match` + reconnect jitter 0-5s
28. **REQ-28** SDK SHALL send `X-TraceHub-Client: {hostname}:{project}:{source_id}` on every request
29. **REQ-29** SDK SHALL on 429: honour Retry-After, buffer up to 10K traces, exponential backoff (cap 5min)
30. **REQ-30** SDK SHALL on unreachable: switch to COLD (don't trace), retry with backoff
31. **REQ-35** SDK SHALL log operational events to stderr (not throw): rate-limit received, ban received, connection lost, reconnect attempt, backoff timer. Format: `[TracHub] {event}: {details}`
      ← Architect review A2: "Without SDK logging, operators cannot diagnose why traces are not arriving"
32. **REQ-36** SDK SHALL accept optional `logger` callback in `init(config)` for custom log routing (default: `console.warn`)

**Python SDK Update:**
31. **REQ-31** checktrace SHALL switch config polling to long-poll with `Prefer: wait=30`
32. **REQ-32** checktrace SHALL send `X-TraceHub-Client` header on every request
33. **REQ-33** checktrace SHALL honour 429 Retry-After with buffering and backoff

### Non-Functional

- **NFR-01 Performance:** `GET /tracing/config` response (non-long-poll) SHALL be <10ms (in-memory, no DB)
- **NFR-02 Performance:** Batch ingest of 100 traces SHALL complete in <50ms (bun:sqlite WAL + transaction)
- **NFR-03 Performance:** Server SHALL handle 200+ concurrent long-poll connections without degradation
- **NFR-04 Reliability:** Server restart SHALL not corrupt SQLite DB (WAL mode + graceful shutdown)
- **NFR-05 Reliability:** SDK SHALL not crash user application on TracHub server failure — fail silently to COLD
- **NFR-06 Compatibility:** TS server SHALL accept requests from checktrace 0.3.0 SDK without any client changes
- **NFR-07 Observability:** Server SHALL log ban events to stderr: `[TracHub] Client {client_id} banned (tier {N}) for {seconds}s`
- **NFR-08 Resource:** Docker image SHALL be <100MB (oven/bun:slim base)
- **NFR-09 Resource:** Server memory usage SHALL stay <128MB under normal operation (50 SDK clients)
- **NFR-10 SDK Size:** `@tracehub/sdk` SHALL have zero external dependencies (native fetch only)
- **NFR-11 Startup Logging:** Server SHALL log configuration summary on startup to stderr: bind address, port, DB path, WAL mode, retention hours, secret configured (yes/no), max long-poll connections
      ← Architect review A5

## Scope

**In Scope:**
- [x] TracHub server rewrite: Bun + Hono + Drizzle + bun:sqlite (WAL)
- [x] All existing endpoints preserved 1:1 (same JSON contract)
- [x] Adaptive tracing HOT/WARM/COLD state machine
- [x] Long-poll on GET /tracing/config (Prefer: wait + If-None-Match)
- [x] Three-tier abuse protection (rate limit → warning ban → hard ban)
- [x] TS SDK (`@tracehub/sdk`) — batch sender, long-poll config, shouldTrace, backpressure
- [x] Python SDK update (checktrace 1.0.0) — long-poll, X-TraceHub-Client, 429 handling
- [x] Dockerfile update (oven/bun:slim)
- [x] docker-compose.yml update (hot-swap mount for TS)
- [x] Drizzle schema + baseline migration matching existing SQLite structure

**Out of Scope:**
- [ ] Local collector (Model A) — deferred, add later if >10 services per machine
- [ ] SSE config channel (Approach B from creative) — long-poll chosen instead
- [ ] Webhook config notify (Approach C) — rejected
- [ ] Go/Rust/other language SDKs — TS + Python only for now
- [ ] UI dashboard — no frontend
- [ ] Persistent ban storage (Redis/DB) — in-memory sufficient, resets on restart
- [ ] OTLP protocol support — custom JSON protocol retained
- [ ] Grafana integration — existing /stats endpoints suffice

## Technical Notes

**Approach:** Model B (Smart SDK → Server, no local collector) with long-poll for config delivery and three-tier abuse protection. Selected in creative exploration — simplest architecture that meets all requirements.

**Stack:**
- Runtime: Bun (native SQLite, TS-first)
- Framework: Hono (SSE via `streamSSE`, Zod validation via `@hono/zod-validator`)
- ORM: Drizzle + bun:sqlite (sync API — correct for embedded SQLite)
- Validation: Zod
- Lint/Format: Biome

**Dependencies (server):** `hono`, `drizzle-orm`, `zod`, `@hono/zod-validator`
**Dependencies (TS SDK):** none (native `fetch`)
**Dependencies (Python SDK update):** `httpx`, `pydantic` (unchanged)

**Long-poll implementation:**
- Server maintains `Set<{resolve, etag}>` of waiting clients
- On config change (mark_hot / cooldown_tick) → resolve all waiters
- `Promise.race([configChanged, Bun.sleep(waitSeconds * 1000)])` → 304 on timeout
- Parse `Prefer: wait=N` from request header, cap at 60s

**Abuse protection implementation:**
- In-memory `Map<client_id, ClientState>` with sliding window timestamps
- Hono middleware on all routes: check ban → check rate → proceed
- Cleanup loop every 60s: remove entries inactive >10min

**Migration path:**
1. Build TS server → run locally, verify all endpoints match Python server responses
2. Deploy TS server on port 8099 → Traefik routes to it → existing checktrace 0.3.0 works unchanged
3. Publish `@tracehub/sdk` + checktrace 1.0.0
4. Migrate services to new SDKs gradually

## Critical Requirements (Extracted for Execution)
### Must Have
- [ ] **CR-01** GET /tracing/config long-poll: hold connection when `Prefer: wait=N` + etag matches, release on change or timeout
      ← REQ-15..18, US-01: "Core traffic reduction mechanism — without it, periodic polling wastes 90%+ traffic"
- [ ] **CR-02** Three-tier abuse protection: rate limit → warning ban (60s) → hard ban (300s) per X-TraceHub-Client
      ← REQ-20..24, US-02: "Without auto-ban, a single runaway SDK can DOS the server"
- [ ] **CR-03** All existing API endpoints return identical JSON responses as Python server
      ← REQ-01..10, US-03 AC-15..16: "Breaking API contract = breaking all deployed checktrace 0.3.0 SDKs"
- [ ] **CR-04** Adaptive tracing state machine (HOT/WARM/COLD) with same timers and rates
      ← REQ-11..14, US-03 AC-17..18: "Core feature — config changes must propagate to SDKs"
- [ ] **CR-05** Trace deduplication on ingest: UPDATE if same (source_id, corr_id, endpoint, direction) within 5min
      ← REQ-19, US-03 AC-19: "Without dedup, MA source generates 909K traces/day (DB bloat)"
- [ ] **CR-06** TS SDK shouldTrace() gate — skip network when false, O(1) lookup
      ← REQ-25..27, US-04 AC-27: "Zero overhead in COLD mode = main performance win"
- [ ] **CR-07** SDK sends X-TraceHub-Client header on every request
      ← REQ-28, REQ-32, US-02 AC-08: "Server needs client_id for fine-grained rate limiting and ban tracking"
- [ ] **CR-08** SDK honours 429 Retry-After: stop requests, buffer traces, exponential backoff
      ← REQ-29, REQ-33, US-04 AC-30: "SDK that ignores 429 IS the runaway client"
- [ ] **CR-09** SQLite WAL mode enabled at server start
      ← NFR-02, US-03 AC-22: "Without WAL, concurrent read/write causes SQLITE_BUSY errors"
- [ ] **CR-10** DB path from `TRACEHUB_DB` env var, default `./data/tracehub.db` (NOT `/tmp/`)
      ← REQ-34, Architect review A1: "Volatile path = data loss on reboot"
- [ ] **CR-11** Long-poll connection cap at `MAX_LONGPOLL_CONNECTIONS` (env, default 200), graceful degradation
      ← REQ-37, Architect review A4: "Unbounded connections on thundering herd after restart"
- [ ] **CR-12** SDK logs operational events to stderr (rate-limit, ban, reconnect) — never throws to user code
      ← REQ-35, Architect review A2: "Without SDK logging, operators cannot diagnose missing traces"

### Must NOT
- [ ] **CN-01** No DB queries in GET /tracing/config — pure in-memory
      ← NFR-01, REQ-12: "DB query = 50-200ms, budget is <10ms. Long-poll waiters multiplied by DB latency = unacceptable"
- [ ] **CN-02** SDK must NOT block main application thread
      ← NFR-05, US-04 AC-31: "SDK runs in user's app — blocking = breaking their business logic"
- [ ] **CN-03** SDK must NOT crash or throw on TracHub failure — fail silently to COLD
      ← NFR-05, US-04 AC-31: "TracHub is observability, not business-critical. Crash = unacceptable side effect"
- [ ] **CN-04** SDK must NOT retry immediately after 429 — must honour Retry-After
      ← REQ-29, US-02: "Immediate retry IS the runaway behavior we're protecting against"
- [ ] **CN-05** Server must NOT break checktrace 0.3.0 SDK requests (no Prefer header, no X-TraceHub-Client)
      ← NFR-06, US-06 AC-39: "Deployed SDKs cannot be updated atomically — backward compat is mandatory"
- [ ] **CN-06** No external runtime dependencies for TS SDK — native fetch only
      ← NFR-10, US-04 AC-33: "External deps = version conflicts in user's project, bundle bloat"

### Decision Boundaries (Already Decided)
- **DB-01 Runtime:** Bun (not Node.js)
      ← Research: "Native bun:sqlite is 5x faster bulk inserts than better-sqlite3. Single binary, TS-first."
- **DB-02 Framework:** Hono (not Express/Fastify)
      ← Research: "~14kb, built-in streamSSE, Web Standards API, Zod validator middleware"
- **DB-03 ORM:** Drizzle + bun:sqlite sync API (not Prisma, not raw SQL)
      ← Research: "Type-safe thin SQL layer, zero overhead, correct for embedded SQLite (async wrappers add overhead for in-process DB)"
- **DB-04 Config delivery:** Long-poll with Prefer: wait (not SSE, not webhook)
      ← Creative §Recommendation: "95%+ traffic reduction, backward compat, trivial multi-language port (just HTTP GET with timeout)"
- **DB-05 Abuse protection:** In-memory three-tier (not Redis, not WAF)
      ← Creative §Abuse Protection: "Sufficient for 5-50 clients. Resets on restart = acceptable (clean slate). No external dependency."
- **DB-06 SDK architecture:** Model B — Smart SDK direct to server (no local collector)
      ← Idea §Architecture: "API surface small (5 functions), ~150 lines batch/retry per language. Collector adds operational overhead for marginal benefit at our scale."
- **DB-07 Client identification:** X-TraceHub-Client header format `{hostname}:{project}:{source_id}`
      ← Creative §Client Identification: "IP alone breaks behind NAT. Header gives fine-grained per-service tracking."
- **DB-08 Adaptive state timers:** HOT=300s, WARM=1500s/10%, COLD=0% (unchanged from Python)
      ← Existing codebase adaptive.py: "Proven values, no reason to change during refactor"
- **DB-09 Ban durations:** Warning=60s, Hard=300s. Env-configurable (`TRACEHUB_BAN_WARNING`, `TRACEHUB_BAN_HARD`) with stated values as defaults
      ← Creative §Three-Tier Response: "60s enough for SDK author to notice logs; 300s for repeat offenders" + Architect review B-CONFIG-3

## Success Metrics
- [ ] All 41 acceptance criteria pass
- [ ] No regression: checktrace 0.3.0 SDK works against TS server unchanged
- [ ] Config traffic reduced 90%+ (measured: requests to /tracing/config per hour, before vs after)
- [ ] Runaway client auto-banned within 10s of exceeding rate limit
- [ ] Normal SDK clients see 0 rate-limit 429s under standard operation
- [ ] Server starts in <2s, healthcheck passes within 5s
- [ ] Docker image <100MB

---
**Next:** `/s3-plan /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/02-prd.md`
