---
created: 2026-02-22
updated: 2026-02-22
revision: 1.0.0
based_on: []
status: draft
---
# Idea: Adaptive Tracing — Smart Trace Recording with Cooldown

**Type:** new_feature

## Description
TracHub currently records ALL traces at 100% rate regardless of whether anyone is observing them. This causes massive DB bloat (2.3GB/day) and CPU overhead. MA source alone generates 909K traces/day, V3 adds 265K — 99.3% of total traffic.

Adaptive Tracing introduces a HOT/WARM/COLD model where trace recording rate dynamically adjusts based on developer interest. When a developer queries a correlation_id, it becomes HOT (100% recording). Without queries, traces cool down through WARM (sampled) to COLD (minimal/off). The checktrace SDK clients check TracHub for their enabled status and gate trace emission locally.

## User Value
As a developer debugging distributed systems, I want traces to be fully recorded only when I'm actively investigating, so that the server isn't overwhelmed with unused trace data while still capturing everything I need when debugging.

## Research Summary

### Best Practices
- **OpenTelemetry tail-based sampling:** Decision to record made after trace completes, based on attributes. Similar concept but we decide based on "is anyone watching?"
- **Adaptive sampling (Jaeger):** Adjusts sample rate per-service based on throughput. Our approach is per-correlation instead.
- **Feature flags for tracing:** LaunchDarkly-style config polling. Our /tracing/config endpoint is similar.

### Recommended Approach
Three-tier system: TracHub server manages hot/warm/cold state per correlation_id. checktrace SDK polls /tracing/config every 30s (with ETag + jitter) and caches in-memory. SDK gates trace emission with should_trace() check before any network call.

### Architecture Components

**TracHub Server (gate controller):**
- `GET /tracing/config` — returns mode + hot correlation list + sample rates
- Auto-HOT: querying /traces/{corr_id} or /recent marks correlations as hot (5 min TTL)
- `POST /tracing/enable/{corr_id}` — manual enable
- `POST /tracing/disable/{corr_id}` — manual disable
- Cooldown: HOT (5min) → WARM (25min, 10% sample) → COLD (1% or 0%)

**checktrace SDK (client-side gate):**
- In-memory config cache (NOT file — avoids race conditions)
- Poll /tracing/config every 30s with ETag, jitter 25-35s
- `should_trace(corr_id) -> bool` — fast local check
- Fallback: if TracHub unreachable → COLD mode (don't trace)
- Zero-overhead when COLD: no network calls for traces

**Deduplication (TracHub ingest):**
- Same (source_id, corr_id, endpoint, direction) with only timestamp changed → UPDATE instead of INSERT
- Reduces polling-generated trace volume by 50-80%

### Three Recording Levels

| State | Trigger | Sample Rate | Duration |
|-------|---------|-------------|----------|
| HOT | Developer queries corr_id | 100% | 5 min after last query |
| WARM | After HOT expires | 10% | 25 min |
| COLD | Default / no interest | 1% or 0% | Until queried |

### Libraries/Tools
- ETag/If-None-Match: standard HTTP caching for config polling
- asyncio.Event or threading.Event: for SDK config update notification
- No new dependencies needed in SDK or server

### Known Gotchas
- All services polling /tracing/config simultaneously on startup → jitter required
- Config endpoint must be <10ms response (in-memory, no DB)
- SDK must not block main application thread
- Race between "trace emitted" and "config changed to cold" — acceptable, eventual consistency
- Need to handle SDK versions that don't support adaptive tracing (backwards compat)

## Existing Codebase
**TracHub server:** `/mnt/d/Vibe_coding_projects/kiberos-platform/kiberos-commander/tracehub/server.py` — already has /stats, /stats/sources, rate limiting
**checktrace SDK:** `/mnt/d/LifeAiTools/Turov/checktrace/src/checktrace/` — client.py, config.py, logger.py, decorators.py
**SDK config:** `CheckTraceConfig()` + `init_tracing(cfg)` pattern already exists
**Current SDK behavior:** Always emits if CHECKPOINT_TRACING=1 env var set, no conditional logic

## Initial Scope Estimate
**Complexity:** high
**Affected areas:** TracHub server (new endpoints + auto-hot logic), checktrace SDK (config polling + should_trace gate), all services using checktrace (no code change needed — SDK handles internally)

## Top Spammers (data from this session)
| Source | Traces/day | Correlations | Issue |
|--------|-----------|-------------|-------|
| MA (Manager API) | 909,118 | 454,724 | Traces every poll operation |
| V3 (MessageBridge) | 265,880 | 430 | 618 traces per correlation |
| Others | 4,527 | combined | Normal volume |

## Next Step
Run: `/s1.5-creative /mnt/d/Vibe_coding_projects/kiberos-platform/kiberos-commander/tracehub/PRPs/adaptive-tracing/01-idea.md`
