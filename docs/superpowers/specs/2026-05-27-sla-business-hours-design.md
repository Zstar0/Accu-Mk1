# Sub-project B — Business-hours SLA engine + calendar

- **Date:** 2026-05-27
- **Branch:** `feat/order-status-processing-time`
- **Depends on:** the tier model (`2026-05-27-sla-tiers-model-and-settings-design.md`). B makes the per-tier `business_hours_only` flag actually do something.
- **Scope:** B = (1) a global business-hours schedule + a holiday/closure calendar, (2) a business-hours-aware elapsed engine, (3) a batch status endpoint D2 will call, (4) a "Business Hours" settings pane. **Out of scope:** D2 itself (the SLA column/colors/refetch cadence — its own spec); any TS mirror of the business-hours math (deliberately none — see "Why server-side").

## Goal

Make `business_hours_only` tiers measure elapsed time in **business minutes** (only Mon–Fri 09:00–17:00 Pacific, excluding holidays), so a 112h business-hours target = 14 working days. Non-business tiers keep the raw wall-clock behavior from A.

## Decisions (locked)

- **Schedule:** one **global** lab schedule (not per-tier; the per-tier `business_hours_only` flag selects whether a tier *uses* it). Seeded: **09:00–17:00, Mon–Fri, `America/Los_Angeles`**. "9–5 PST" = 9–5 on the Pacific wall clock, **DST-aware** (PST winter / PDT summer). A working day is **8 continuous hours** (no lunch carve-out).
- **Holidays:** all closures are **stored, editable rows** in `lab_holidays` (`source` = `federal` | `custom`). Federal rows are **seeded** by computing them per year (helper below) for a rolling window (current year + next 2). The lab adds custom closures (e.g. day-after-Thanksgiving). `is_holiday(d) = d ∈ lab_holidays`. **Disabling a federal holiday the lab works (e.g. Juneteenth) = delete its row** — every row, federal or custom, is removable. A **"generate federal holidays for year N"** action seeds missing future years (idempotent; skips any date already present, so it won't resurrect a row you deleted in a year you've already generated). Seeding multiple years up front mitigates the coverage edge.
- **D2 consumption:** **server-side batch endpoint** (`POST /sla/status`). Tier *resolution* stays client-side (data's already cached); only the business-minutes computation goes to the server, batched one call per page.

## Why server-side (and no TS mirror)

Business-minutes math needs the schedule + holiday set + DST-correct local-time arithmetic. Re-deriving that in browser JS (no date lib in this project) is a bug surface, especially at DST boundaries. Python's stdlib `zoneinfo` handles DST correctly. Performance is fine because it's **one batched call per page** (not per row): the client resolves each row's tier locally, then sends the resolved `(received_at, target_minutes, business_hours_only)` list in a single request. The `resolveSlaTier` TS resolver from A stays; **no** TS port of business-hours math exists.

## Data model

**`business_hours_config`** — singleton (enforced: a single row, id = 1):

| Column | Type | Seed |
|--------|------|------|
| `id` | int PK | 1 |
| `open_time` | TIME | `09:00` |
| `close_time` | TIME | `17:00` |
| `timezone` | String(64) | `America/Los_Angeles` |
| `working_days` | JSON (list of Python weekday ints, Mon=0…Sun=6) | `[0,1,2,3,4]` |
| `created_at`, `updated_at` | timestamps | |

**`lab_holidays`** — all closure dates (federal seeded + custom added), every row editable/removable:

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `holiday_date` | DATE, **unique** | the closure date |
| `name` | String(100) | e.g. "Independence Day (observed)", "Day after Thanksgiving" |
| `source` | String(10) | `federal` (seeded) \| `custom` (user-added). Display tag only — both are removable; deleting a `federal` row = the lab works that day. |
| `created_at` | timestamp | |

Migration in `database.py:_run_migrations` (idempotent, no Alembic): `CREATE TABLE IF NOT EXISTS` both; seed the single config row guarded by `WHERE NOT EXISTS (SELECT 1 FROM business_hours_config)`. **Seed federal holiday rows** for the rolling window (current year + next 2) using `us_federal_holidays(year)`; each insert guarded by `WHERE NOT EXISTS (SELECT 1 FROM lab_holidays WHERE holiday_date = :d)` so re-runs and user deletions are respected (a deleted date is not re-seeded on the next boot — the guard sees nothing to compare, so use a per-date `ON CONFLICT (holiday_date) DO NOTHING` insert instead, which is the idempotent-and-non-resurrecting form). Custom rows start empty. ORM models `BusinessHoursConfig`, `LabHoliday` in `models.py`.

> Migration nuance to pin in the plan: first-boot seeds federal rows; on later boots `ON CONFLICT DO NOTHING` means deleted federal dates stay deleted (won't resurrect). New future years are added only via the explicit "generate federal holidays for year N" endpoint, not on every boot.

## Federal holiday helper

`us_federal_holidays(year: int) -> set[date]` in a small pure module (`backend/holidays_us.py`), **no external dependency**:

- Fixed: New Year's (Jan 1), Juneteenth (Jun 19), Independence Day (Jul 4), Veterans Day (Nov 11), Christmas (Dec 25).
- Floating-Monday: MLK (3rd Mon Jan), Presidents' (3rd Mon Feb), Memorial (last Mon May), Labor (1st Mon Sep), Columbus/Indigenous Peoples' (2nd Mon Oct), Thanksgiving (4th **Thu** Nov).
- **Observed shift** (fixed-date holidays only): if the date is a Saturday → observed Friday; if Sunday → observed Monday. The set returned contains the **observed** dates.

Unit-tested against known years (e.g. 2026: Jul 4 is a Saturday → observed Fri Jul 3; Christmas Dec 25 is a Friday → no shift).

## Engine (`backend/sla_engine.py` — pure, DB-free, unit-tested)

**`compute_business_minutes(received_at, now, schedule, is_holiday) -> float`** — day-by-day overlap (NOT minute-by-minute):

```python
def compute_business_minutes(received_at, now, schedule, is_holiday):
    if received_at is None or now <= received_at:
        return 0.0
    tz = ZoneInfo(schedule.timezone)
    total = 0.0
    # iterate calendar dates in the schedule's tz from received_at..now
    for d in dates_in_local_range(received_at, now, tz):
        if d.weekday() not in schedule.working_days or is_holiday(d):
            continue
        open_dt  = datetime.combine(d, schedule.open_time, tz)
        close_dt = datetime.combine(d, schedule.close_time, tz)
        lo = max(received_at, open_dt)
        hi = min(now, close_dt)
        if hi > lo:
            total += (hi - lo).total_seconds() / 60.0
    return total
```

This makes the **clock-start rule fall out automatically**: a sample received at 18:00 Friday contributes 0 until 09:00 the next working day (the `max(received_at, open_dt)` clamp + weekend/holiday skips). All datetimes are tz-aware in the configured timezone; **DST needs no special handling** — for a 09:00–17:00 window neither the spring-forward gap (02:00) nor the fall-back duplicate (01:00) touches the window, and `zoneinfo` localizes `combine` correctly either way. `received_at`/`now` are stored/produced as naive UTC per the codebase convention; the engine treats them as UTC and compares against tz-aware window bounds (convert consistently — implementer: make both sides tz-aware UTC before comparing, or localize once; the plan pins the exact conversion).

**Status assembly — shared formula (no divergence between raw and business paths):**

```python
def sla_status_dict(target_minutes, elapsed_minutes):
    return {
        "target_minutes": target_minutes,
        "elapsed_minutes": elapsed_minutes,
        "remaining_minutes": target_minutes - elapsed_minutes,
        "breached": elapsed_minutes > target_minutes,   # strict > (matches A's raw boundary)
    }
```

`compute_sla_status` (A's raw function) is refactored to compute `elapsed = (now - received_at) minutes` then return `sla_status_dict(...)`; the business path computes `elapsed = compute_business_minutes(...)` then calls the **same** `sla_status_dict`. `received_at is None` → status `None` in both paths (unchanged from A).

**Misconfiguration is defined, not undefined:** close ≤ open, empty `working_days`, or holidays covering every working day → `compute_business_minutes` returns `0.0` indefinitely (nothing is ever inside a window). No exception; never crashes a render. State asserted by a test.

## API

- `GET /business-hours-config` → the singleton config.
- `PUT /business-hours-config` → update open/close/timezone/working_days. Validates: `timezone` is a real IANA zone (`ZoneInfo(tz)` must not raise → 422), `close_time > open_time` (422), `working_days` ⊆ 0..6.
- `GET /lab-holidays?year=<int>` → all stored rows for that year `[{id, holiday_date, name, source}]` (federal + custom, ordered by date). Defaults `year` to current.
- `POST /lab-holidays` → add a custom closure `{holiday_date, name}` (`source='custom'`; 409 on duplicate date).
- `DELETE /lab-holidays/{holiday_date}` → remove any closure, federal or custom (404 if absent). Deleting a federal row = the lab works that day.
- `POST /lab-holidays/generate-federal?year=<int>` → insert any missing federal rows for that year (`ON CONFLICT (holiday_date) DO NOTHING` — won't resurrect deleted dates); returns count added. Extends coverage beyond the seeded window.
- `POST /sla/status` — the batch render endpoint:

```
Request:  { "items": [ { "key": "<opaque client id>", "received_at": "<ISO|null>",
                         "target_minutes": <int>, "business_hours_only": <bool> } , ... ] }
Response: { "items": [ { "key": "<echoed>",
                         "status": { target_minutes, elapsed_minutes, remaining_minutes, breached } | null } ] }
```

- `key` is **opaque** and echoed back (client correlates by key, not array order — e.g. D2 sends the sample uid).
- `status` is `null` iff `received_at` is null.
- `now` = **server time**; the response is a **snapshot** (D2 refetches on load/poll — not live-ticking).
- The handler loads the config + the full `lab_holidays` date set **once** (not per item) into a Python `set[date]`, builds `is_holiday = lambda d: d in that_set`, then maps over items. O(items) with O(1) DB reads.
- Auth: `get_current_user`, read-only, no admin gate (render endpoint).

## UI — "Business Hours" Preferences pane

New `'businessHours'` pane in `PreferencesDialog` (TanStack Query + a `@/services/business-hours.ts`, mirroring `services/sla.ts`). Two `SettingsSection`s:
1. **Schedule** — open/close time inputs, working-day checkboxes (Mon–Sun), timezone (text/select). Admin-editable; non-admins read-only (same gate as the SLA pane).
2. **Holidays** — for the selected year, every closure row is listed (federal tagged "U.S. federal", custom tagged "Custom") **each with a remove button** — removing a federal row is how the lab opts out of a holiday it works. Add a custom closure (date + name). A year selector + a **"Generate federal holidays for {year}"** button (calls `generate-federal`) to extend coverage into a new year.

All strings via `useTranslation` (`preferences.businessHours.*` keys in `locales/*.json`).

## Out of scope / later

- D2 (the order-list SLA column + colors) — consumes `POST /sla/status`; its own spec.
- A TS mirror of business-hours math — intentionally none.
- Sub-day granularity beyond minutes; multiple schedules; per-service overrides.

## Resolved (review decisions)

1. **Holiday storage = stored editable rows** for both federal (seeded) and custom — chosen over computed-on-the-fly. Federal seeding uses `us_federal_holidays(year)` for the rolling window; `ON CONFLICT DO NOTHING` keeps it idempotent and non-resurrecting.
2. **Federal opt-out = delete the row.** The lab works some federal holidays; since every row (federal included) is removable, "disable Juneteenth" is just deleting that date's row. No separate opt-out mechanism needed.
