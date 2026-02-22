---
created: 2026-02-22
updated: 2026-02-22
revision: 1.3.0
based_on:
  - path: /mnt/d/Vibe_coding_projects/kiberos-platform/kiberos-commander/tracehub/PRPs/adaptive-tracing.md
    revision: 1.0.0
status: draft
---
# Plan: Adaptive Tracing — Smart Trace Recording with Cooldown

**Archon Project:** N/A

## Project Structure

### Current Layout
```
tracehub/
├── server.py          # 680 lines — ALL server logic in one file
├── client.py          # standalone client (not used by server)
├── __init__.py        # root package init (unused?)
├── src/tracehub/      # pip package: client.py + __init__.py
├── Dockerfile         # COPY tracehub/ ./tracehub/ (expects package dir)
├── docker-compose.yml # hot-swap mount: /opt/.../tracehub/tracehub:/app/tracehub:ro
├── pyproject.toml     # hatch build from src/tracehub/
└── requirements.txt
```

### Target Layout (after refactoring)
```
tracehub/
├── src/tracehub/          # all server + client code lives here
│   ├── __init__.py        # package init, get_app()
│   ├── app.py             # FastAPI app, lifespan, middleware (~60 lines)
│   ├── config.py          # env vars, constants (~30 lines)
│   ├── models.py          # Pydantic models (~30 lines)
│   ├── db.py              # SQLite: init, insert, query, cleanup (~120 lines)
│   ├── streaming.py       # SSE subscribers (~60 lines)
│   ├── endpoints.py       # /ingest, /traces, /recent, /correlations, /stats, /health (~200 lines)
│   ├── adaptive.py        # NEW: state machine, /tracing/* endpoints (~150 lines)
│   ├── client.py          # existing pip-distributed client (unchanged)
│   └── cli.py             # argparse entry point (~30 lines)
├── Dockerfile             # updated CMD
├── docker-compose.yml     # hot-swap mount updated
├── pyproject.toml         # unchanged (already builds from src/tracehub)
└── requirements.txt
```

**Key insight:** Dockerfile already `COPY tracehub/` and `CMD python -m tracehub.server`, and pyproject.toml already builds from `src/tracehub/`. After refactoring, Dockerfile needs minor path update but the overall build model stays the same.

## Context References

### Files to READ Before Implementing
| File | Lines | Why |
|------|-------|-----|
| `server.py` | full | Source of refactoring — understand all sections |
| `src/tracehub/__init__.py` | full | Existing package exports |
| `src/tracehub/client.py` | full | Existing pip client — DO NOT break |
| `Dockerfile` | 17,34 | COPY path + CMD |
| `docker-compose.yml` | 18 | Hot-swap volume mount path |
| `checktrace/config.py` | 27-106 | SDK CheckTraceConfig fields |
| `checktrace/client.py` | 94-268 | SDK TraceHubClient — gate insertion |

### Files to CREATE
| File | Description |
|------|-------------|
| `src/tracehub/app.py` | FastAPI app, lifespan, CORS middleware |
| `src/tracehub/config.py` | Server config from env vars |
| `src/tracehub/models.py` | Pydantic request/response models |
| `src/tracehub/db.py` | SQLite operations |
| `src/tracehub/streaming.py` | SSE subscriber management |
| `src/tracehub/endpoints.py` | All HTTP endpoints |
| `src/tracehub/adaptive.py` | Adaptive tracing state machine + endpoints |
| `src/tracehub/cli.py` | CLI entry point |

### Files to MODIFY
| File | Action | Description |
|------|--------|-------------|
| `src/tracehub/__init__.py` | UPDATE | Add server exports, bump version |
| `Dockerfile` | UPDATE | Fix COPY path: `COPY src/tracehub/ ./tracehub/` |
| `checktrace/config.py` | UPDATE | Add adaptive_tracing field |
| `checktrace/client.py` | UPDATE | Add AdaptiveTracingManager, should_trace() |
| `checktrace/__init__.py` | UPDATE | Export should_trace, bump version |
| `tracehub-ctl.sh` | UPDATE | Add tracing-* commands |

### Patterns to Follow
**Naming:** snake_case, underscore-prefixed globals (`_subscribers`, `_stats`)
**Errors:** HTTPException with status_code + detail
**State:** In-memory dicts with cleanup in background asyncio loop
**SDK threading:** Background daemon thread pattern
**Config:** pydantic BaseSettings with env vars
**Imports:** Relative within package (`from .config import ...`)

## Critical Requirements (For Execution)

```yaml
critical_requirements:
  must_have:
    - id: "CR-01"
      what: "GET /tracing/config — in-memory, <10ms"
      source: "REQ-01, US-01"
      why: "SDK polls this every 30s from N services, must be fast"
    - id: "CR-02"
      what: "Auto-HOT on GET /traces/{corr_id}"
      source: "REQ-02, US-02 AC-04"
      why: "Core value — debug triggers full recording"
    - id: "CR-03"
      what: "HOT→WARM→COLD state machine with timers"
      source: "REQ-03, US-01 AC-02"
      why: "Without this system doesn't auto-reduce load"
    - id: "CR-04"
      what: "SDK should_trace() gate — skip network when False"
      source: "REQ-07, REQ-08, US-04 AC-12"
      why: "Zero overhead in COLD = main win"
    - id: "CR-05"
      what: "SDK config polling with ETag + jitter 25-35s"
      source: "REQ-06, REQ-10"
      why: "Without jitter all services poll simultaneously on startup"
    - id: "CR-06"
      what: "Trace dedup (UPSERT on ingest)"
      source: "REQ-09"
      why: "Reduces MA 909K→estimated 180-450K traces/day"
    - id: "CR-07"
      what: "adaptive_hint in /traces/{corr_id} response when was COLD"
      source: "REQ-11, US-02 AC-14"
      why: "Developer must know data may be incomplete and when to retry"
  must_not:
    - id: "CN-01"
      what: "No DB query in /tracing/config"
      source: "REQ-01 NFR-Performance"
      why: "DB query = 50-200ms, budget is 10ms"
    - id: "CN-02"
      what: "Don't block main application thread from SDK"
      source: "US-04 AC-10"
      why: "SDK works transparently"
    - id: "CN-03"
      what: "Don't break old SDK versions"
      source: "US-04 AC-13"
      why: "Server must accept traces from any SDK version"
    - id: "CN-04"
      what: "Don't trace in COLD when TracHub unreachable"
      source: "US-04 AC-11"
      why: "Fail-safe = don't trace, not fail-open"
  decision_boundaries:
    - id: "DB-01"
      decision: "In-memory dict for state (loss on restart OK)"
      source: "Research"
      why: "Simplicity > persistence; COLD = safe restart default"
    - id: "DB-02"
      decision: "30s polling with jitter 25-35s, ETag"
      source: "Research"
      why: "Balance reactivity vs load for N clients"
    - id: "DB-03"
      decision: "HOT=5min, WARM=25min+10%, COLD=1%/0%"
      source: "Idea doc"
      why: "5min debug window sufficient, WARM = grace period"
    - id: "DB-04"
      decision: "Client-side gate, not server-side rejection"
      source: "Research"
      why: "Client gate = zero network overhead in COLD"
    - id: "DB-05"
      decision: "SQL UPSERT on (source_id, corr_id, endpoint, direction)"
      source: "Idea doc"
      why: "50-80% reduction of polling duplicates"
```

## Validation Decisions (from s3.5 review)

1. **COLD rate = 0%** (not 1%). Simpler, AC-01 guaranteed. If needed later, make configurable via env var.
2. **Auto-HOT scope:** ONLY on `GET /traces/{corr_id}` per PRD AC-04. Remove auto-HOT from `get_recent_traces()` and `stream_traces()` — those are browsing, not debugging.
3. **Dedup UPDATE columns:** Only `timestamp` and `created_at` updated on conflict. Data/payload stays from first insert.
4. **cooldown_tick interval:** 10s, defined as `ADAPTIVE_TICK_INTERVAL` constant.
5. **SDK polling thread:** Daemon thread (already pattern in TraceHubClient). `close()` stops it. Fork-safe: gunicorn post_fork re-initializes.
6. **Package structure:** Server modules stay in `src/tracehub/` (same as now). `pyproject.toml` already has `packages = ["src/tracehub"]` — server AND client ship together (this is intentional, TracHub is both server+client). checktrace SDK is a separate package entirely.
7. **Refactoring scope:** Full 8-module split as planned. Risk is acceptable — it's mechanical extraction with no logic changes.

## Step-by-Step Tasks

---

### Task 0: Refactor server.py into package modules
**Action:** REFACTOR — split `server.py` (680 lines) into `src/tracehub/` modules
**Source:** `server.py` (single file, 7 logical sections with `# ===` separators)

**Step 0a: Create `src/tracehub/config.py`** (server config)
Extract from `server.py:30-53`:
- `TRACEHUB_DB`, `TRACEHUB_PORT`, `TRACEHUB_RETENTION_HOURS`, `TRACEHUB_SECRET` env vars
- All in-memory state dicts: `_subscribers`, `_subscriber_timestamps`, `_stats`, `_recent_rate_window`, `_source_ingest_window`, `_source_ingest_totals`

**Step 0b: Create `src/tracehub/models.py`**
Extract from `server.py:91-116`:
- `TraceEntry`, `TraceIngestRequest`, `TraceQueryResponse` pydantic models
- `verify_secret()` auth dependency

**Step 0c: Create `src/tracehub/db.py`**
Extract from `server.py:122-261`:
- `init_db()`, `cleanup_old_traces()`, `insert_trace()`, `query_traces()`, `list_recent_correlations()`
- Import config vars from `.config`

**Step 0d: Create `src/tracehub/streaming.py`**
Extract from `server.py:267-321`:
- `subscribe()`, `unsubscribe()`, `notify_subscribers()`, `cleanup_stale_subscribers()`
- Import state dicts from `.config`

**Step 0e: Create `src/tracehub/endpoints.py`**
Extract from `server.py:380-644`:
- All `@app.` route handlers: `/ingest`, `/ingest/single`, `/recent`, `/traces/{corr_id}`, `/traces/{corr_id}/stream`, `/correlations`, `/stats`, `/stats/sources`, `/health`, `/cleanup`
- Use `APIRouter` instead of direct `@app.` decorators
- Import from `.db`, `.streaming`, `.config`, `.models`

**Step 0f: Create `src/tracehub/app.py`**
Extract from `server.py:327-373`:
- `lifespan()` async context manager with cleanup_loop
- FastAPI app creation, CORS middleware
- Include router from `.endpoints`

**Step 0g: Create `src/tracehub/cli.py`**
Extract from `server.py:651-679`:
- `main()` function with argparse + uvicorn.run
- Import `app` from `.app`

**Step 0h: Update `src/tracehub/__init__.py`**
- Keep existing client exports
- Add `get_app()` pointing to `.app`
- Add `__main__.py` or update `__init__` to support `python -m tracehub.server` → `python -m tracehub`

**Step 0i: Update Dockerfile**
- Change `COPY tracehub/ ./tracehub/` to `COPY src/tracehub/ ./tracehub/` (if needed)
- Verify `CMD ["python", "-m", "tracehub.server"]` still works (or update to `tracehub.cli`)

**Step 0j: Delete old `server.py` from root** (it's been split into modules)

**Validate:**
```bash
cd /mnt/d/Vibe_coding_projects/kiberos-platform/kiberos-commander/tracehub
python3 -c "from src.tracehub.app import app; print(app.title)"
python3 -c "from src.tracehub.cli import main; print('CLI OK')"
```

**Critical:** This is a pure refactoring — NO behavioral changes. All endpoints must work identically.

---

### Task 1: Add adaptive tracing state machine
**File:** `/mnt/d/Vibe_coding_projects/kiberos-platform/kiberos-commander/tracehub/src/tracehub/adaptive.py`
**Action:** CREATE
**Pattern:** `config.py` (state dicts), `endpoints.py` (APIRouter pattern)
**Changes:**
- Constants: `ADAPTIVE_HOT_TTL=300`, `ADAPTIVE_WARM_TTL=1500`, `ADAPTIVE_WARM_RATE=0.1`, `ADAPTIVE_COLD_RATE=0.0`, `ADAPTIVE_TICK_INTERVAL=10`
- State dict: `_adaptive_state: Dict[str, dict]` — `{corr_id: {state, expires_at, queried_at}}`
- ETag counter: `_config_etag: int` (increments on state change)
- `mark_hot(corr_id)` — set/extend HOT state, increment etag
- `get_state(corr_id) -> str` — return "hot"/"warm"/"cold" (cold if absent)
- `get_trace_rate(corr_id) -> float` — return rate based on state
- `cooldown_tick()` — called from cleanup_loop every 10s: HOT→WARM→COLD transitions
- `APIRouter` with `/tracing/*` endpoints (Task 2 details below)
**Validate:** `python3 -c "from src.tracehub.adaptive import router; print('OK')"`

### Task 2: Add /tracing/* endpoints
**File:** `src/tracehub/adaptive.py` (same file, router)
**Action:** Part of Task 1 CREATE
**Changes:**
- `GET /tracing/config` — return `{mode, default_rate, hot_correlations, warm_rate, etag}`. Support `If-None-Match` → 304. Pure in-memory (CN-01).
- `GET /tracing/status` — all HOT/WARM entries with remaining TTL
- `POST /tracing/enable/{corr_id}` — call `mark_hot()`, return state
- `POST /tracing/disable/{corr_id}` — remove from state, return OK
**Validate:** `curl http://localhost:8099/tracing/config`

### Task 3: Add auto-HOT trigger + adaptive_hint to query endpoints
**File:** `src/tracehub/endpoints.py`
**Action:** UPDATE
**Changes:**
- In `get_traces()`: check previous state via `adaptive.get_state(correlation_id)` BEFORE calling `mark_hot()`
- Call `adaptive.mark_hot(correlation_id)` (AC-04)
- If previous state was COLD (or absent): add `adaptive_hint` to response (CR-07, AC-14):
  ```json
  {
    "adaptive_hint": {
      "previous_state": "cold",
      "current_state": "hot",
      "message": "Tracing activated. Previous traces may be incomplete (COLD mode). Full recording started.",
      "retry_after_seconds": 45
    }
  }
  ```
  - `retry_after_seconds` = SDK poll interval (30s) + jitter margin (10s) + trace latency (5s) = 45s
  - If previous state was HOT/WARM: no hint (data already being recorded)
- Do NOT add auto-HOT to `get_recent_traces()` or `stream_traces()` — those are browsing, not debugging (per PRD scope)
- Import `from .adaptive import mark_hot, get_state`
**Validate:** Query cold corr_id → response contains `adaptive_hint`; query hot corr_id → no hint

### Task 4: Add trace deduplication to ingest
**File:** `src/tracehub/db.py`
**Action:** UPDATE
**Changes:**
- Add dedup index: `CREATE UNIQUE INDEX IF NOT EXISTS idx_dedup ON traces(source_id, correlation_id, endpoint, direction)`
- `insert_trace()`: `INSERT ... ON CONFLICT(source_id, correlation_id, endpoint, direction) DO UPDATE SET timestamp=excluded.timestamp, created_at=excluded.created_at` — only timestamp/created_at updated; data/payload stays from first insert
- Add `_stats["ingest_deduped"]` counter
- Note: existing UNIQUE(correlation_id, timestamp, suffix) stays for exact-duplicate protection
**Validate:** Send same trace twice → second UPDATEs

### Task 5: Wire adaptive into app lifecycle
**File:** `src/tracehub/app.py`
**Action:** UPDATE
**Changes:**
- Include `adaptive.router` in app
- Add `adaptive.cooldown_tick()` call in cleanup_loop (every 10s)
**Validate:** `/tracing/config` accessible after server start

---

### Task 6: Add adaptive_tracing config to checktrace SDK
**File:** `/mnt/d/LifeAiTools/Turov/checktrace/src/checktrace/config.py`
**Action:** UPDATE
**Changes:**
- Add field: `adaptive_tracing: bool = Field(default=False)` — opt-in (CN-03)
- Add `CHECKTRACE_ADAPTIVE` env var mapping in `from_env()`
**Validate:** `python3 -c "from checktrace.config import CheckTraceConfig; print(CheckTraceConfig(tracehub_url='http://x').adaptive_tracing)"`

### Task 7: Add AdaptiveTracingManager to checktrace SDK
**File:** `/mnt/d/LifeAiTools/Turov/checktrace/src/checktrace/client.py`
**Action:** UPDATE
**Pattern:** `TraceHubClient` background thread pattern (client.py:94-178)
**Changes:**
- `AdaptiveTracingManager` class:
  - `__init__(base_url, secret, timeout)` — starts daemon polling thread
  - `_poll_loop()` — poll `/tracing/config` every 25-35s (jitter), ETag, `If-None-Match`
  - `_hot_correlations: Dict[str, float]`, `_default_rate`, `_warm_rate`, `_last_etag`
  - `should_trace(corr_id) -> bool` — O(1) dict lookup; if not hot, `random.random() < default_rate`
  - `close()` — stop thread
- TracHub unreachable → `_default_rate = 0.0` (CN-04)
- 304 Not Modified → keep cache
**Validate:** Unit test should_trace hot=True, cold=mostly False

### Task 8: Integrate AdaptiveTracingManager into TraceHubClient
**File:** `/mnt/d/LifeAiTools/Turov/checktrace/src/checktrace/client.py`
**Action:** UPDATE
**Changes:**
- `TraceHubClient.__init__()`: if `config.adaptive_tracing` → create `AdaptiveTracingManager`
- `TraceHubClient.send()`: if adaptive → `should_trace(entry.correlation_id)` before queue (CR-04)
- `TraceHubClient.close()`: close adaptive manager
- `adaptive_tracing=False` → no manager, unchanged behavior (CN-03)
**Validate:** Adaptive+COLD → send() doesn't queue

### Task 9: Export should_trace, bump SDK version
**File:** `/mnt/d/LifeAiTools/Turov/checktrace/src/checktrace/__init__.py`
**Action:** UPDATE
**Changes:**
- Add `should_trace` module-level function (delegates to global client's adaptive manager)
- Add to `__all__`
- Bump `__version__` to `"0.3.0"`
**Validate:** `python3 -c "from checktrace import should_trace"`

### Task 10: Update checktrace CLI to display adaptive_hint
**File:** `/mnt/d/LifeAiTools/Turov/checktrace/src/checktrace/cli.py`
**Action:** UPDATE
**Pattern:** `cli.py:267-291` (get_traces command)
**Changes:**
- After fetching data in `get_traces()`, check for `adaptive_hint` in response
- If present: display colored warning before traces table:
  ```
  ⚠ Tracing was COLD for this correlation. Full recording activated.
    Check back in ~45s for complete trace data.
  ```
- Also display adaptive_hint in JSON format output
**Validate:** `checktrace get cold-corr-id` → shows hint; `checktrace get hot-corr-id` → no hint

### Task 11: Update tracehub-ctl CLI
**File:** `/home/relishev/scripts/tracehub-ctl.sh`
**Action:** UPDATE
**Changes:**
- `tracing-config`: `curl -s $URL/tracing/config | jq .`
- `tracing-status`: `curl -s $URL/tracing/status | jq .`
- `tracing-enable CORR_ID`: `curl -s -X POST $URL/tracing/enable/$1`
- `tracing-disable CORR_ID`: `curl -s -X POST $URL/tracing/disable/$1`
**Validate:** `tracehub-ctl tracing-status`

### Task 12: Deploy + E2E verification
**Changes:**
1. Rebuild TracHub: `docker compose up -d --build`
2. Verify all existing endpoints still work (regression check)
3. Test `/tracing/config`, `/tracing/status`
4. Auto-HOT: query `/traces/test-123` → check status
5. Manual: `POST /tracing/enable/manual-test` → check status
6. Dedup: send identical trace twice → verify UPDATE not INSERT
7. SDK: `CHECKTRACE_ADAPTIVE=1` → verify polling in logs
8. Fail-safe: stop TracHub → SDK falls to COLD
9. **AC-01 verification:** Record /stats before deploy (ingest_total baseline). Wait 1h, compare ingest rate. COLD=0% → expect near-zero new traces from non-HOT sources.
10. **AC-03 verification:** Check DB size via `tracehub-ctl db-size` after 24h. With dedup + COLD=0%, expect <100MB/day.

## Validation Commands

### After Task 0 (refactoring)
```bash
cd /mnt/d/Vibe_coding_projects/kiberos-platform/kiberos-commander/tracehub
python3 -c "import sys; sys.path.insert(0,'src'); from tracehub.app import app; print(f'{app.title} - {len(app.routes)} routes')"
```

### After Tasks 1-5 (server)
```bash
python3 -c "import sys; sys.path.insert(0,'src'); from tracehub.adaptive import router; print(f'{len(router.routes)} adaptive routes')"
```

### After Tasks 6-9 (SDK)
```bash
cd /mnt/d/LifeAiTools/Turov/checktrace && python3 -c "from checktrace import should_trace; print('OK')"
```

### Final E2E
```bash
curl -s http://tracehub.muid.io/tracing/config | jq .
curl -s http://tracehub.muid.io/traces/test-123 | jq .
curl -s http://tracehub.muid.io/tracing/status | jq .
```

## Dependency Graph

```
Task 0 (refactor) ──→ Task 1 (state machine) ──→ Task 2 (endpoints)
                  ──→ Task 3 (auto-HOT+hint) ──→ Task 5 (wire into app)
                  ──→ Task 4 (dedup) ──────────→ Task 5
                                                    ↓
Task 6 (SDK config) → Task 7 (manager) → Task 8 (integrate) → Task 9 (export)
                                                                    ↓
Task 10 (checktrace CLI hint) ──→ Task 12 (E2E)
Task 11 (tracehub-ctl) ─────────→ Task 12 (E2E)
```

## Next Step

Run: `/s3.5-validate-plan /mnt/d/Vibe_coding_projects/kiberos-platform/kiberos-commander/tracehub/PRPs/adaptive-tracing/02-plan.md`
