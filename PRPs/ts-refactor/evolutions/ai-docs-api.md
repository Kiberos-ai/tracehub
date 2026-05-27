---
created: 2026-05-27
updated: 2026-05-27
revision: 1.0.0
based_on:
  - path: /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/02-prd.md
    revision: 1.1.0
status: draft
type: system-evolution
---
# System Evolution: AI-Friendly Documentation API for TracHub

**Severity:** medium
**Type:** system-evolution (feature gap, not bug)

## Executive Summary

TracHub не имеет machine-readable документации. AI-агенты (Claude Code, Cursor, Copilot) при интеграции TracHub в проект вынуждены полагаться на skill-файл в плагине lat-dev-kit, который: (a) доступен только пользователям плагина, (b) может быть устаревшим, (c) не содержит актуальных эндпоинтов и SDK API. Решение — сервер сам раздаёт `llms.txt` / `llms-full.txt` по стандарту [llmstxt.org](https://llmstxt.org/), плюс endpoint `/docs/integration.md` с полным гайдом. Любой агент может `curl tracehub.muid.io/llms.txt` и получить всё необходимое для интеграции.

## Gap Analysis (Root Cause Chain)

```
Symptom: AI agents don't know how to integrate TracHub into projects
    ↓
Why 1: No documentation accessible via HTTP from TracHub server itself
    ↓
Why 2: Docs live only in plugin skill files (lat-dev-kit), not in the service
    ↓
Why 3: TracHub was built as infrastructure, not as a developer-facing API product
    ↓
Why 4: No standard for serving AI-readable docs existed when TracHub was created
    ↓
ROOT: TracHub needs to follow llms.txt standard — self-serve its own integration docs
```

**Industry standard (2025-2026):** [llms.txt](https://llmstxt.org/) — 849+ sites adopted (Stripe, Cloudflare, Vercel). AI coding assistants (Cursor, Claude Code) actively check `/llms.txt` when encountering new APIs. Format: markdown at root, `text/plain` content type. Two files:
- `llms.txt` — compact index with links (table of contents)
- `llms-full.txt` — complete self-contained documentation (no external fetches needed)

## Evolution Tasks

### Phase 1: Serve llms.txt + llms-full.txt from TracHub server

**Files:** `src/routes/docs.ts`, `src/docs/llms.txt`, `src/docs/llms-full.txt`

**`GET /llms.txt`** — compact index (Content-Type: text/plain):
```markdown
# TracHub
> Centralized checkpoint trace collection and query service for distributed systems.

TracHub collects checkpoint traces from distributed services, provides real-time SSE streaming, adaptive sampling (HOT/WARM/COLD), and long-poll config delivery. Deploy once, trace from any language (TS/Python SDK).

## Getting Started
- [Quick Integration Guide](https://tracehub.muid.io/docs/integration.md): Step-by-step setup for TS and Python
- [API Reference](https://tracehub.muid.io/docs/api.md): All endpoints with request/response examples

## SDKs
- [TypeScript SDK](https://tracehub.muid.io/docs/sdk-ts.md): @tracehub/sdk — zero-dep, batch sender, long-poll config
- [Python SDK](https://tracehub.muid.io/docs/sdk-python.md): checktrace — decorator, middleware, manual checkpoints

## Concepts
- [Adaptive Tracing](https://tracehub.muid.io/docs/adaptive.md): HOT/WARM/COLD model — traces only when debugging
- [Abuse Protection](https://tracehub.muid.io/docs/rate-limiting.md): Three-tier rate limiting and auto-ban
- [Long-Poll Config](https://tracehub.muid.io/docs/long-poll.md): Zero-traffic config delivery via Prefer: wait

## Optional
- [Source IDs](https://tracehub.muid.io/docs/source-ids.md): Two-letter codes for service identification
- [Trace Format](https://tracehub.muid.io/docs/trace-format.md): JSON trace entry schema
```

**`GET /llms-full.txt`** — complete self-contained doc (~2-3K tokens). Includes:
- Full API reference (all endpoints with curl examples)
- TS SDK: `init()`, `checkpoint()`, `shouldTrace()`, `close()` with code samples
- Python SDK: `@checkpoint`, `CheckpointMiddleware`, `checkpoint_entry/exit`
- Environment variables table
- Trace entry JSON schema
- Adaptive tracing explanation (HOT/WARM/COLD)
- Common patterns: "Add tracing to FastAPI app", "Add tracing to Hono app", "Debug a request chain"

**`GET /docs/:page.md`** — individual doc pages (text/plain), each self-contained markdown.

**Implementation:** Static strings embedded in code (not file reads — zero I/O, instant response). Updated when API changes. Route in `src/routes/docs.ts`, mounted in app.ts.

### Phase 2: Generate docs content from actual codebase

Create doc markdown strings covering:

**`integration.md`** — Quick start:
1. Install SDK (`bun add @tracehub/sdk` / `pip install checktrace`)
2. Set env vars (`TRACEHUB_URL`, `TRACEHUB_SECRET`)
3. Initialize (`init({url, secret, sourceId})`)
4. Add checkpoints (decorator or manual)
5. Query traces (`curl tracehub.muid.io/traces/{corrId}`)

**`api.md`** — Every endpoint with curl example:
- POST /ingest — batch traces
- POST /ingest/single — single trace
- GET /traces/:corrId — query + adaptive_hint
- GET /traces/:corrId/stream — SSE
- GET /tracing/config — long-poll with Prefer: wait
- POST /tracing/enable/:corrId, POST /tracing/disable/:corrId
- GET /correlations, GET /recent, GET /stats, GET /health

**`sdk-ts.md`** — Full TS SDK API reference with examples
**`sdk-python.md`** — Full Python SDK API (checktrace) with examples
**`adaptive.md`** — HOT/WARM/COLD explained, when traces are recorded, retry_after_seconds
**`rate-limiting.md`** — Three tiers, what 429 response looks like, how SDK should handle it
**`long-poll.md`** — Prefer: wait protocol, ETag, jitter, backward compat
**`trace-format.md`** — TraceEntry JSON schema with all fields
**`source-ids.md`** — MA, WS, WK, VM, MB, JW, SP + how to pick your own

### Phase 3: Update tracehub-integration skill

Update `/home/relishev/.claude/plugins/marketplaces/lifeaitools/skills/tracehub-integration/SKILL.md`:
- Add instruction: "BEFORE integrating, fetch `https://tracehub.muid.io/llms-full.txt` for latest docs"
- Add TS SDK examples alongside Python
- Reference the live API docs endpoint instead of hardcoded examples
- This way the skill stays thin (pointer) and the server is the SSOT for docs

## Validation Criteria

- [ ] `curl -sf https://tracehub.muid.io/llms.txt` returns valid llms.txt markdown (text/plain)
- [ ] `curl -sf https://tracehub.muid.io/llms-full.txt` returns complete self-contained docs (text/plain)
- [ ] `curl -sf https://tracehub.muid.io/docs/integration.md` returns integration guide
- [ ] `curl -sf https://tracehub.muid.io/docs/api.md` returns API reference with curl examples
- [ ] All doc URLs in llms.txt are resolvable (no 404s)
- [ ] llms-full.txt fits within 4K tokens (agent-friendly size)
- [ ] An AI agent given only `llms-full.txt` can correctly set up TracHub SDK in a new project

## Next Step
Execute: implement Phase 1 + Phase 2 directly (simple feature — static content, no complex logic)
