---
created: 2026-05-27
updated: 2026-05-27
revision: 1.0.0
based_on:
  - path: /home/relishev/projects/vibe/tracehub/PRPs/adaptive-tracing/01-idea.md
    revision: 1.0.0
status: draft
---
# Idea: TracHub TS Refactor — Hono + Drizzle + Multi-Language SDK Architecture

**Type:** refactor

## Description
Полный рефакторинг TracHub с Python/FastAPI на TypeScript-стек (Hono + Drizzle + Bun SQLite). Ключевое архитектурное изменение — разделение на три слоя по модели OpenTelemetry Collector:

1. **Language-specific emitters** (тонкие SDK) — минимальные библиотеки для TS/JS, Python, и потенциально других языков. Единственная задача: сформировать trace entry и положить в локальную очередь. Не делают HTTP-вызовов напрямую.
2. **Local collector** (единый на машину) — Bun-процесс, который собирает traces от всех локальных emitters (через unix socket или localhost HTTP), батчит, дедуплицирует, и отправляет на сервер через long-polling / controlled push. Именно collector контролирует нагрузку на сервер.
3. **TracHub server** (центральный) — Hono + Drizzle + bun:sqlite. Принимает батчи от collectors, хранит, отдаёт через SSE/REST. Адаптивный трейсинг (HOT/WARM/COLD) сохраняется.

Альтернативный лёгкий вариант: если поверхность emitter API мала (5-6 функций), можно обойтись без local collector — каждый language SDK сам батчит и отправляет. Но collector даёт единую точку контроля backpressure и единый протокол к серверу.

## User Value
As a developer running polyglot services (TS/Python/etc.) on the same machine, I want a unified tracing system where any language can emit traces with minimal SDK overhead, traces are consolidated locally before reaching the server, and the server isn't overwhelmed — so I get full distributed tracing without per-language complexity or server-side load problems.

As a maintainer of TracHub, I want the server on our standard TS stack (Hono/Drizzle/Bun) so it's consistent with the rest of our tooling, easier to extend, and benefits from Bun's native SQLite performance (~5x faster bulk inserts vs better-sqlite3).

## Research Summary

### Best Practices
- **OTel Collector Pattern:** Отделять emission от delivery. Приложение эмитирует, локальный collector батчит и доставляет. Приложение не знает о backend'е (протокол, формат, retry — всё в collector). Это канонический подход OpenTelemetry и главная причина его успеха в polyglot-средах.
- **Thin SDK / Fat Collector:** SDK должен быть максимально тонким — формирование trace entry + запись в очередь. Никакой retry-логики, backpressure, polling в SDK. Чем тоньше SDK, тем проще портировать на новый язык.
- **SSE для server→client push:** Hono имеет встроенный `streamSSE` helper. SSE предпочтительнее long-polling для server-push (проще, нативная поддержка в браузерах/curl, работает через reverse proxy). Long-polling оправдан для collector→server direction (collector тянет конфиг с сервера).
- **WAL mode для SQLite:** Обязателен для concurrent read/write. Bun SQLite + WAL даёт ~28ms на 10K insert vs ~142ms better-sqlite3.
- **Batch + Transaction:** Вставлять traces внутри одной транзакции — критично для throughput. Одиночные INSERT в SQLite ~60x медленнее, чем batch в транзакции.
- **Heartbeat/Keep-alive:** При SSE обязательны heartbeat-пинги каждые 15-30s — иначе nginx/Traefik/Cloudflare закрывают idle connection.
- **Jitter на polling:** Все collectors стартуют одновременно → thundering herd. Jitter 25-35s вместо ровных 30s (уже реализовано в текущем Python SDK).

### Architecture: Two Viable Models

**Model A: Emitter → Local Collector → Server (Full OTel-inspired)**
```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  TS Service  │  │  Python Svc  │  │  Go Service  │
│  ts-emitter  │  │  py-emitter  │  │  go-emitter  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ (localhost:9098) │                 │
       └────────┬─────────┘─────────────────┘
                ▼
       ┌────────────────┐
       │ Local Collector │  (Bun process, 1 per machine)
       │ - batch + dedup │
       │ - backpressure  │
       │ - config poll   │
       └────────┬───────┘
                │  (HTTPS, long-poll config, batch POST traces)
                ▼
       ┌────────────────┐
       │  TracHub Server │  (Hono + Drizzle + bun:sqlite)
       │  tracehub.muid.io
       └────────────────┘
```
- **Pro:** Единая точка backpressure, emitter'ы максимально тонкие (0 сетевой логики), collector контролирует нагрузку.
- **Con:** Дополнительный процесс на каждой машине. Нужно управлять его lifecycle (systemd/docker).

**Model B: Smart SDK → Server (No Collector)**
```
┌──────────────┐  ┌──────────────┐
│  TS Service  │  │  Python Svc  │
│  ts-sdk      │  │  py-sdk      │
│  (batch+send)│  │  (batch+send)│
└──────┬───────┘  └──────┬───────┘
       │                 │
       │  (HTTPS, batch POST, config poll with ETag)
       └────────┬────────┘
                ▼
       ┌────────────────┐
       │  TracHub Server │
       └────────────────┘
```
- **Pro:** Нет отдельного процесса. Проще deploy. Текущая архитектура (checktrace SDK) уже так работает.
- **Con:** Каждый language SDK дублирует batch/retry/backpressure/config-polling логику. Больше поверхность для каждого нового языка.

**Рекомендация: Model B (Smart SDK) с опциональным collector.**
Причины:
1. Текущая поверхность emitter API очень мала: `init()`, `checkpoint_entry()`, `checkpoint_exit()`, `should_trace()`, `close()` — 5 функций.
2. Batch + retry + config-poll — это ~150 строк на любом языке. Не настолько сложно, чтобы оправдывать отдельный процесс.
3. Collector можно добавить позже как opt-in для высоконагруженных сценариев (>10 сервисов на одной машине).
4. Backpressure на стороне SDK: если сервер возвращает 429 или 503 → exponential backoff + drop oldest traces. Простой протокол.

### Recommended Approach
Переписать TracHub server на Hono + Drizzle + bun:sqlite (WAL mode). Сохранить все существующие endpoints и adaptive tracing логику. Создать TypeScript SDK (`@tracehub/sdk`) как primary — с batch sender, config polling (ETag + jitter), should_trace() gate, backpressure (429→backoff). Python SDK переписать как thin wrapper с тем же протоколом. Протокол клиент→сервер остаётся HTTP JSON (POST /ingest, GET /tracing/config) — простой, debuggable, работает через любой proxy.

**Long-polling для config:** Вместо периодического poll каждые 30s, использовать HTTP long-poll: клиент отправляет GET /tracing/config с `If-None-Match: "{etag}"` и `Prefer: wait=30`. Сервер держит connection до изменения конфига или timeout (30s). Результат: мгновенная реакция на HOT-активацию вместо задержки до 30s, при этом меньше запросов к серверу (один long-poll вместо ~1 req/30s). Fallback на обычный poll если long-poll не поддерживается.

### Tech Stack Decisions

| Component | Current (Python) | Target (TS) | Why |
|-----------|-------------------|-------------|-----|
| Runtime | Python 3.12 | Bun | Native SQLite driver (5x faster inserts), single binary, TS-first |
| Web framework | FastAPI | Hono | Lightweight (~14kb), built-in SSE `streamSSE`, Web Standards API |
| ORM / DB | aiosqlite (async) | Drizzle + bun:sqlite (sync) | Type-safe SQL, zero overhead thin layer, sync = correct for embedded SQLite |
| Schema migrations | manual SQL | drizzle-kit | Auto-generate migrations from schema.ts |
| Validation | Pydantic v2 | Zod (+ hono/zod-validator) | Standard TS validation, integrates with Hono middleware |
| TS SDK | — (checktrace Python) | `@tracehub/sdk` | Primary SDK, batch sender + adaptive config poll |
| Python SDK | checktrace 0.3.0 | checktrace 1.0.0 (thin rewrite) | Same protocol, thin — delegate batch/retry to shared logic or reimplement simply |
| Containerization | Docker (python:3.12-slim) | Docker (oven/bun:slim) | Smaller image, faster startup |
| Reverse proxy | Traefik (unchanged) | Traefik (unchanged) | Already configured for tracehub.muid.io |

**Решение по sync vs async для SQLite:** Bun SQLite — синхронный драйвер. Для embedded SQLite это правильно: async обёртка (как aiosqlite) добавляет event-loop hop без реальной пользы, т.к. SQLite — in-process файловый I/O, а не TCP. Drizzle поддерживает оба API поверх bun:sqlite.

### Libraries/Tools

**Server:**
- `hono` — web framework, SSE via `hono/streaming`, Zod validation via `@hono/zod-validator`
- `drizzle-orm` + `drizzle-kit` — ORM + migration tooling
- `bun:sqlite` (built-in) — native SQLite driver, WAL mode, sync API
- `zod` — schema validation для request/response models

**TS SDK (`@tracehub/sdk`):**
- `undici` или native `fetch` — HTTP client (Bun/Node compatible)
- Никаких внешних deps кроме fetch — SDK должен быть zero-dependency для максимальной совместимости

**Python SDK (checktrace 1.0.0):**
- `httpx` — уже используется, оставляем
- `pydantic` — для конфига, оставляем
- Логика batch/retry/config-poll переписывается с учётом long-poll

**Tooling:**
- `biome` — lint + format (замена eslint+prettier, один инструмент)
- `drizzle-kit` — `generate` / `migrate` для schema changes

### Known Gotchas

1. **bun:sqlite sync блокирует event loop.** Для единичных INSERT (~0.01ms) не проблема. Для batch 1000+ rows — оборачивать в `Bun.sleep(0)` между chunk'ами или использовать worker thread. В текущей нагрузке (MA 909K traces/day ≈ 10 req/s average) — не блокирует.

2. **Drizzle + bun:sqlite — sync API.** Drizzle предоставляет и sync, и async API для bun:sqlite. Hono handlers async — нужно быть внимательным: `db.select()` возвращает результат синхронно, не нужен await. Это нормально, но может путать.

3. **Long-poll держит connections.** Если 50 collectors делают long-poll одновременно — 50 held connections. Hono/Bun справляется (тысячи concurrent connections), но нужно:
   - Server-side timeout (30s max hold) чтобы не leak'ать connections
   - `stream.onAbort()` cleanup при disconnect клиента
   - Limit max concurrent long-poll connections (e.g., 200)

4. **SSE через Traefik.** Traefik по умолчанию буферизирует response. Нужен `Content-Type: text/event-stream` + `X-Accel-Buffering: no` header. Уже работает в текущем Python-сервере, но проверить при миграции.

5. **Migration path.** Нельзя сломать текущий Python checktrace SDK 0.3.0 который уже deployed. Новый TS-сервер должен принимать тот же POST /ingest формат. Переход: deploy TS-сервер → verify старые SDK-клиенты работают → затем обновлять SDK.

6. **SQLite schema migration.** Текущая DB создаётся через raw SQL в `init_db()`. Drizzle-kit генерирует миграции из schema.ts. Нужна одноразовая миграция: экспорт текущей schema → создание baseline migration в Drizzle.

7. **ETag числовой counter reset.** Текущий adaptive.py использует `_config_etag: int` — in-memory counter, сбрасывается при рестарте. Это ОК (клиент получит полный ответ вместо 304), но в TS-версии стоит использовать тот же подход — не усложнять.

8. **Python SDK long-poll.** Python `httpx` поддерживает long-poll нативно (просто `timeout=35s` на GET). Но daemon thread в checktrace блокируется на long-poll — ОК, он и так блокируется на `time.sleep(30)`. Фактически long-poll заменяет sleep.

### Reference Links
- [Hono SSE Streaming Helper](https://hono.dev/docs/helpers/streaming) — built-in `streamSSE` API
- [SSE Is the Right Answer More Often Than You Think — Hono + TS](https://dev.to/sendotltd/sse-is-the-right-answer-more-often-than-you-think-a-hono-typescript-reference-service-3p74)
- [Drizzle ORM + Bun SQLite](https://orm.drizzle.team/docs/get-started/bun-sqlite-new) — official setup guide
- [Bun SQLite docs](https://bun.com/docs/runtime/sqlite) — native driver, WAL mode, bulk insert benchmarks
- [WAL Mode & Performance Tuning (better-sqlite3)](https://deepwiki.com/WiseLibs/better-sqlite3/3.4-wal-mode-and-performance-tuning) — applies to SQLite generally
- [OpenTelemetry Collector Architecture](https://opentelemetry.io/docs/collector/architecture/) — API/SDK/Collector separation pattern
- [OpenTelemetry Components](https://opentelemetry.io/docs/concepts/components/) — thin SDK vs fat collector design
- [Bun + Hono + Drizzle ORM + SQLite reference project](https://github.com/jthinking/hono-app)
- [better-sse — spec-compliant SSE for Hono/Express/Fastify](https://github.com/MatthewWid/better-sse)
- [Long Polling guide](https://mvolkmann.github.io/blog/long-polling/?v=1.1.1)

## Existing Codebase

### TracHub Server (Python → будет заменён)
**Path:** `/home/relishev/projects/vibe/tracehub/src/tracehub/`
- `app.py` — FastAPI app, lifespan, cleanup loop (~80 lines)
- `config.py` — env vars, in-memory state dicts (~43 lines)
- `models.py` — Pydantic models, auth dependency (~83 lines)
- `db.py` — SQLite init/insert/query/cleanup + dedup (~187 lines)
- `streaming.py` — SSE subscriber management (~75 lines)
- `endpoints.py` — all HTTP routes (~315 lines)
- `adaptive.py` — HOT/WARM/COLD state machine + /tracing/* endpoints (~189 lines)
- `client.py` — SDK: batch sender + query client (~386 lines)
- `cli.py` — argparse + uvicorn entry point (~44 lines)

**Total server code:** ~1,400 lines Python (включая client.py который станет отдельным пакетом)

### CheckTrace SDK (Python — будет обновлён)
**Path:** `/home/relishev/projects/vibe/checktrace/src/checktrace/`
- `config.py` — CheckTraceConfig (Pydantic BaseSettings)
- `context.py` — ContextVar-based correlation ID
- `logger.py` — CheckpointLogger с entry/exit markers
- `decorators.py` — `@checkpoint` decorator (sync/async)
- `middleware.py` — FastAPI/Starlette middleware (auto correlation ID)
- `client.py` — TraceHubClient (batch sender), AdaptiveTracingManager, should_trace()
- `session_detect.py` — session ID detection
- `subscriptions.py` — subscription registry

### Что сохраняется 1:1
- **API contract:** POST /ingest, GET /traces/{corr_id}, GET /tracing/config — тот же JSON формат
- **Adaptive tracing:** HOT/WARM/COLD state machine, auto-HOT on query, ETag/304
- **Deduplication:** UPSERT по (source_id, correlation_id, endpoint, direction)
- **Auth:** X-TraceHub-Secret header
- **Docker + Traefik:** tracehub.muid.io:8099, hot-swap mount

### Что меняется
- **Runtime:** Python → Bun
- **Framework:** FastAPI → Hono
- **DB driver:** aiosqlite (async) → bun:sqlite (sync, WAL)
- **ORM:** raw SQL → Drizzle (type-safe schema + migrations)
- **Config polling:** periodic GET → long-poll (Prefer: wait=30)
- **SDK architecture:** monolithic checktrace → `@tracehub/sdk` (TS) + thin checktrace 1.0.0 (Python)

## Initial Scope Estimate
**Complexity:** high
**Affected areas:**

| Area | Scope | Effort |
|------|-------|--------|
| TracHub server (Hono + Drizzle) | Full rewrite ~1,000 lines TS | High — new stack, same logic |
| Drizzle schema + migrations | New schema.ts + baseline migration | Medium |
| TS SDK (`@tracehub/sdk`) | New package ~400 lines | Medium — batch, config poll, should_trace |
| Python SDK (checktrace 1.0.0) | Update client.py ~200 lines (long-poll, protocol alignment) | Low-Medium |
| Dockerfile + docker-compose | Update to oven/bun:slim | Low |
| Long-poll on /tracing/config | New server-side hold + SDK support | Medium — both server and all SDKs |
| E2E validation | Deploy, verify old+new SDK, regression | Medium |

**Estimated total:** ~1,800 lines new TS + ~200 lines Python updates

### Migration Strategy (zero-downtime)
1. Build TS server → verify all existing endpoints respond identically (same JSON contract)
2. Deploy TS server on same port (8099) behind Traefik → old Python checktrace 0.3.0 SDKs MUST work unchanged
3. Release `@tracehub/sdk` (TS) + checktrace 1.0.0 (Python) with long-poll support
4. Gradually migrate services to new SDKs
5. Remove old Python server code after all services migrated

## Next Step
Run: `/lat-dev-kit:s1.5-creative /home/relishev/projects/vibe/tracehub/PRPs/ts-refactor/01-idea.md`
