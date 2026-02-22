---
created: 2026-02-22
updated: 2026-02-22
revision: 1.1.0
based_on:
  - path: /mnt/d/Vibe_coding_projects/kiberos-platform/kiberos-commander/tracehub/PRPs/adaptive-tracing/01-idea.md
    revision: 1.0.0
status: draft
---
# PRP: Adaptive Tracing — Smart Trace Recording with Cooldown

**Complexity:** high | **Archon:** N/A

## Overview

TracHub записывает ВСЕ traces при 100% rate, что генерирует 2.3GB/день и создаёт CPU overhead. 99.3% трафика — от двух источников (MA: 909K, V3: 265K traces/день), большинство никогда не просматривается. Adaptive Tracing вводит HOT/WARM/COLD модель: traces записываются на 100% только когда разработчик активно дебажит (HOT), остальное время — sampling или off. checktrace SDK клиенты polling'ят TracHub за конфигом и gate'ят трейсы локально.

## User Stories

### US-01: Автоматическое снижение нагрузки
As a platform operator, I want tracing to automatically reduce recording when nobody is debugging, so that server resources are not wasted on unobserved traces.

**Acceptance Criteria:**
- [ ] AC-01: В COLD режиме (по умолчанию) trace volume снижается на 90%+ vs текущее состояние
- [ ] AC-02: Переход HOT→WARM→COLD происходит автоматически по таймерам без ручного вмешательства
- [ ] AC-03: Нагрузка TracHub DB не превышает 500MB/день при нормальной эксплуатации (без HOT)

### US-02: Полный захват при отладке
As a developer debugging a distributed issue, I want to get 100% trace recording for my correlation_id when I query it, so that I don't miss any trace data during investigation.

**Acceptance Criteria:**
- [ ] AC-04: Запрос GET /traces/{corr_id} или /recent с фильтром автоматически включает HOT для этого corr_id
- [ ] AC-05: В HOT режиме 100% traces для данного corr_id записываются в течение 5 минут после последнего запроса
- [ ] AC-06: Повторный запрос продлевает HOT таймер ещё на 5 минут
- [ ] AC-14: Если corr_id был в COLD при запросе, response содержит `adaptive_hint` с previous_state="cold", сообщение что трейсинг активирован, и `retry_after_seconds` с рекомендацией когда повторить запрос

### US-03: Ручное управление трейсингом
As a developer, I want to manually enable/disable tracing for a specific correlation_id, so that I can pre-enable tracing before triggering an operation.

**Acceptance Criteria:**
- [ ] AC-07: POST /tracing/enable/{corr_id} переводит corr_id в HOT
- [ ] AC-08: POST /tracing/disable/{corr_id} переводит corr_id в COLD немедленно
- [ ] AC-09: Статус текущих HOT/WARM корреляций доступен через GET /tracing/status

### US-04: SDK прозрачная интеграция
As a service developer using checktrace SDK, I want adaptive tracing to work without code changes in my service, so that I don't need to modify every instrumented service.

**Acceptance Criteria:**
- [ ] AC-10: Существующий код с `checkpoint()` работает без изменений — SDK решает сам emit или нет
- [ ] AC-11: Если TracHub недоступен, SDK переходит в COLD mode (fail-safe — не трейсить)
- [ ] AC-12: SDK не создаёт заметного overhead в COLD mode (нет network calls для трейсов)
- [ ] AC-13: Обратная совместимость: старые SDK версии без adaptive трейсинга продолжают работать (сервер принимает все traces)

## Requirements

### Functional

1. **[REQ-01]** TracHub SHALL expose `GET /tracing/config` endpoint returning current mode, hot correlation list, and sample rates — response <10ms (in-memory state)
2. **[REQ-02]** TracHub SHALL automatically mark correlation_id as HOT when it is queried via `/traces/{corr_id}` or filtered in `/recent`
3. **[REQ-03]** TracHub SHALL implement cooldown state machine: HOT (5 min TTL) → WARM (25 min, 10% sample) → COLD (1% or 0%)
4. **[REQ-04]** TracHub SHALL expose `POST /tracing/enable/{corr_id}` and `POST /tracing/disable/{corr_id}` for manual control
5. **[REQ-05]** TracHub SHALL expose `GET /tracing/status` returning all active HOT/WARM correlations with remaining TTL
6. **[REQ-06]** checktrace SDK SHALL poll `/tracing/config` every 30s with ETag caching and jitter (25-35s)
7. **[REQ-07]** checktrace SDK SHALL implement `should_trace(corr_id) -> bool` as local in-memory check
8. **[REQ-08]** checktrace SDK SHALL gate all trace emission through `should_trace()` — if False, skip network call entirely
9. **[REQ-09]** TracHub SHALL deduplicate polling traces: same (source_id, corr_id, endpoint, direction) → UPDATE timestamp instead of INSERT
10. **[REQ-10]** `/tracing/config` endpoint SHALL support `If-None-Match` / `ETag` headers for bandwidth efficiency
11. **[REQ-11]** `GET /traces/{corr_id}` SHALL return `adaptive_hint` object when correlation was in COLD state at query time, containing: `previous_state`, `current_state`, `message`, and `retry_after_seconds` (estimated time for new traces to arrive based on SDK poll interval + trace latency)

### Non-Functional

- **Performance:** `/tracing/config` response <10ms; SDK `should_trace()` <1μs (dict lookup); no DB queries in config endpoint
- **Reliability:** SDK fails to COLD if TracHub unreachable; no trace loss for HOT correlations during SDK config poll gap
- **Backwards Compatibility:** Old SDK versions (without adaptive) continue working; server accepts traces regardless of source SDK version
- **Concurrency:** Config polling from N services simultaneously must not overload TracHub (jitter + ETag)

## Scope

**In:**
- [x] GET /tracing/config endpoint (TracHub)
- [x] Auto-HOT on query (TracHub)
- [x] HOT→WARM→COLD state machine (TracHub)
- [x] Manual enable/disable endpoints (TracHub)
- [x] GET /tracing/status endpoint (TracHub)
- [x] SDK config polling with ETag + jitter (checktrace)
- [x] SDK should_trace() gate (checktrace)
- [x] Trace deduplication on ingest (TracHub)
- [x] tracehub-ctl CLI update for new endpoints

**Out:**
- [ ] Per-source-id tracing rules (future — suppress MA polling traces specifically)
- [ ] Web UI for tracing management (future)
- [ ] Historical analytics on trace volume reduction (can use /stats)
- [ ] Distributed config (single TracHub instance is sufficient)

## Technical Notes

- **Approach:** In-memory state dict на TracHub, asyncio background task для cooldown transitions. SDK polling через aiohttp/httpx с ETag. Dedup через SQL UPSERT (ON CONFLICT UPDATE).
- **Dependencies:** Нет новых зависимостей. TracHub: FastAPI + SQLite (уже есть). checktrace SDK: httpx (уже есть).
- **State storage:** In-memory dict `{corr_id: {state, expires_at, queried_at}}` — потеря при restart допустима (всё переходит в COLD, восстановится при следующем запросе).
- **Config response format:**
  ```json
  {
    "mode": "adaptive",
    "default_rate": 0.01,
    "hot_correlations": {"corr-abc": {"rate": 1.0, "ttl": 287}},
    "warm_rate": 0.1
  }
  ```

## Critical Requirements (Extracted for Execution)

### Must Have
- [ ] **[CR-01]** GET /tracing/config endpoint, in-memory, <10ms response
      ← REQ-01: "SDK polls this every 30s from N services, must be fast"
- [ ] **[CR-02]** Auto-HOT при запросе /traces/{corr_id}
      ← REQ-02, US-02 AC-04: "Core value — debug triggers full recording"
- [ ] **[CR-03]** HOT→WARM→COLD state machine с таймерами
      ← REQ-03, US-01 AC-02: "Без этого система не снижает нагрузку автоматически"
- [ ] **[CR-04]** SDK should_trace() gate — skip network call if False
      ← REQ-07, REQ-08, US-04 AC-12: "Zero overhead в COLD = основной выигрыш"
- [ ] **[CR-05]** SDK config polling с ETag + jitter 25-35s
      ← REQ-06, REQ-10: "Без jitter все сервисы poll'ят одновременно при startup"
- [ ] **[CR-06]** Trace deduplication (UPSERT)
      ← REQ-09: "Reduces MA 909K→estimated 180-450K traces/day"
- [ ] **[CR-07]** COLD→HOT hint в response /traces/{corr_id}
      ← REQ-11, US-02 AC-14: "Разработчик должен знать что данные неполные и когда повторить"
      ← REQ-09: "Reduces MA 909K→estimated 180-450K traces/day"

### Must NOT
- [ ] **[CN-01]** НЕ делать DB query в /tracing/config
      ← REQ-01 NFR-Performance: "DB query = 50-200ms, budget 10ms"
- [ ] **[CN-02]** НЕ блокировать main thread приложения из SDK
      ← US-04 AC-10: "SDK работает прозрачно, не влияет на сервис"
- [ ] **[CN-03]** НЕ ломать старые SDK версии
      ← US-04 AC-13: "Сервер должен принимать traces от любых SDK версий"
- [ ] **[CN-04]** НЕ трейсить в COLD при недоступности TracHub
      ← US-04 AC-11: "Fail-safe = не трейсить, не fail-open"

### Decision Boundaries (Already Decided)
- **[DB-01] State storage:** In-memory dict (потеря при restart OK)
      ← Research: "Простота > persistence; COLD = safe default при restart"
- **[DB-02] Polling interval:** 30s с jitter 25-35s, ETag
      ← Research: "Баланс реактивности vs нагрузки на N клиентов"
- **[DB-03] Cooldown timers:** HOT=5min, WARM=25min+10%, COLD=1%/0%
      ← Idea doc analysis: "5min debug window достаточно, WARM = grace period"
- **[DB-04] SDK gate:** Conditional before network call, not server-side rejection
      ← Research: "Client-side gate = zero network overhead в COLD"
- **[DB-05] Dedup strategy:** SQL UPSERT on (source_id, corr_id, endpoint, direction)
      ← Idea doc: "50-80% reduction of polling-generated duplicates"

## Success Metrics
- [ ] Все AC проходят
- [ ] COLD mode trace volume <10% от текущего (с 1.17M/day до <120K)
- [ ] /tracing/config <10ms p99
- [ ] Нет regression в существующем tracing для HOT correlations
- [ ] SDK backwards compatible — старые версии без изменений
