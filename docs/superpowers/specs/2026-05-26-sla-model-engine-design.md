# A — SLA model & engine (backend)

- **Date:** 2026-05-26
- **Branch:** `feat/order-status-processing-time`
- **Sub-project:** A of the SLA / processing-time feature (D1 ✅ done; **A = foundation**; then C settings UI, B calendar, D2 SLA column).
- **Status:** design. **Implementation crosses into new DB tables + migration → STOP for user approval before writing schema.**

## Goal

Replace the hardcoded 24h/48h goal with a **data-driven SLA model**: an SLA target (duration) defined per **(analysis service × priority)**, with a system default. Provide a resolution engine and a read/CRUD API so the settings UI (C) can manage targets and the SLA column (D2) can look them up.

## Decisions (the three open questions, resolved)

1. **Clock start = sample `date_received`.** The lab's SLA clock starts when the lab *receives* the sample — you can't be "late" before you have it. Matches D1's "Outstanding". An order/sample not yet received has **no active SLA** (shown as "Awaiting sample", as in D1). `created_at` ("since order") stays a separate, SLA-free signal.
2. **Granularity = per (sample × analysis service × priority); order-level = worst-breach rollup.** Each sample's analyses resolve their own SLA from the sample's analysis service + the sample's priority. The order-level indicator (D2) uses the *most-breached* sample, mirroring the existing `getOrderWorstState` pattern.
3. **Storage = AccuMk1 `accumark_mk1` Postgres, new SQLAlchemy model in `backend/models.py`** (alongside `AnalysisService`). Analysis services already live there; the SLA UI (C) is in AccuMk1 settings. Not the integration-service.

## Grounding (verified facts)

- `AnalysisService` — `backend/models.py:143` (`analysis_services`).
- Priority source — `SamplePriority` (`backend/models.py:571`, per-sample override, `priority` ∈ `normal|high|expedited`, default `normal`) and `WorksheetItem.priority` (`:622`). Upstream WP→IS priority wiring is **not built**; out of scope here.
- `date_received` — per-sample, from the SENAITE lookup (`SenaiteLookupResult.date_received`), already used by D1's `getOrderReceivedAt`.
- AccuMk1 DB persistence: SQLAlchemy ORM via `database.py` (`Base`), raw psycopg2 via `mk1_db.py`. SLA uses the **ORM** path (FK to `analysis_services`).

## Data model

New ORM model `SlaTarget` → table `sla_targets` (`accumark_mk1`):

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `analysis_service_id` | FK→`analysis_services.id`, **nullable** | NULL = applies to any service (used by the default row) |
| `priority` | `String(20)`, **nullable** | `normal\|high\|expedited`; NULL = any priority |
| `target_minutes` | int, not null | the SLA goal duration |
| `business_hours_only` | bool, default `false` | stored now; **honored in B** (no calendar math in A) |
| `is_default` | bool, default `false` | the catch-all when nothing else matches |
| timestamps | | `created_at`, `updated_at` |

Constraints: unique `(analysis_service_id, priority)`; exactly one row with `is_default = true` (app-enforced).

## Resolution engine (backend)

`resolve_sla_target(analysis_service_id, priority) -> SlaTarget` with fallback chain:
1. exact `(service, priority)` → 2. `(service, priority=NULL)` → 3. `(service=NULL, priority)` → 4. the `is_default` row.

`compute_sla_status(received_at, target, now) -> { target_minutes, elapsed_minutes, remaining_minutes, breached }` — **raw wall-clock elapsed in A**; business-hours-aware variant is **B**'s job (same signature, calendar-adjusted).

## Seed (backward compatibility)

On schema creation, insert the default row: `analysis_service_id=NULL, priority=NULL, target_minutes=1440 (24h), is_default=true` — encodes today's hardcoded goal so nothing regresses. (The old 48h "hard breach" becomes a D2 color-band concern, not a stored target.)

## API surface (tauri commands + FastAPI)

- `list_sla_targets()` → all rows (for C's management table + D2 lookup).
- `resolve_sla_target(service_id, priority)` → effective target (engine).
- CRUD: `create/update/delete_sla_target` — consumed by C's settings UI. (A ships the backend + bindings; C is the frontend.)

## Out of scope (later)

- Business-hours / holiday-aware elapsed → **B**.
- Settings management UI → **C** (consumes A's API).
- The color-coded SLA column in the lists → **D2**.
- WP→IS priority wiring (priority is read from existing `SamplePriority`/`WorksheetItem`).

## Implementation notes / open for execution

- **Confirm schema-creation mechanism before writing the migration:** does `database.py` use `Base.metadata.create_all` (dev) or Alembic? (mk1_db.py uses idempotent `CREATE TABLE IF NOT EXISTS`.) This determines how `sla_targets` is created + how the seed runs. **This is the migration step — pause for approval.**
- Tests: engine fallback chain (all 4 levels), seed idempotency, `compute_sla_status` raw elapsed + breach boundary.

## ⚠️ Pause point

Per the autonomy contract, **A's first implementation step creates a new DB table + migration on `accumark_mk1`**. I will stop and get explicit approval (and confirm the create/migrate mechanism) before writing any schema or running any migration.
