# Bottleneck (Phase Turnaround) Report — Design

**Date:** 2026-06-02
**Status:** Approved
**Author:** Brainstorming session

## Problem

The lab can see *that* samples take time but not *where* the time goes. They need
a **systemic** view: over a date range, which workflow phase consistently consumes
the most time, so process/staffing can be targeted. Answers "verification is our
chokepoint," not "these samples are stuck right now."

## Decisions locked during brainstorming

1. **Systemic/analytical**, not live-operational. Aggregate time-in-phase across
   many samples.
2. **SENAITE milestone phases (v1):** Ordered → Received → Submitted → Verified →
   Published (4 phases). Deep lab micro-steps (worksheet/prep/analysis) deferred
   to v2.
3. **Headline:** ranked horizontal bars, slowest first, median per phase with a
   lighter **p90** tail.
4. **Fold `partial_*` into milestones:** `partial_submit`→Submitted,
   `partial_verify`→Verified.
5. **Calendar (wall-clock) time** for v1. Business-hours-only is a future option.

## Data source (verified)

Both source tables live in the **integration DB** (`accumark_integration`), so v1
needs **no cross-DB join**.

- **`sample_status_events`** — per-sample SENAITE transitions. Columns used:
  `sample_id`, `transition`, `new_status`, `event_timestamp` (Unix **seconds**,
  verified; present on ~84% of rows), `created_at` (fallback), `order_submission_id`
  (links 237/244 rows to the order).
  - Milestone transitions: `receive` → Received; `submit`/`partial_submit` →
    Submitted; `verify`/`partial_verify` → Verified; `publish` → Published.
- **`order_submissions`** — `id`, `created_at` (order placed = Ordered milestone),
  `payload` (`billing.email` for test-order detection), `sample_results`.

Local dev data: 244 events, 96 samples, 57 with ≥2 transitions, range 2026‑01‑26 →
2026‑05‑12. Prod has the same schema with more volume.

## Architecture & data flow

```
sample_status_events ⋈ order_submissions      backend                       frontend
  (integration DB, by order_submission_id)  GET /reports/turnaround   ──▶  getTurnaround()
                                             SQL pivot → per-sample          TanStack Query
                                             milestone timestamps             │
                                             + is_test_order                  ▼
                                             (NO aggregation server-side)  TurnaroundReport.tsx
                                                                           (aggregate + ranked bars)
```

Client-side aggregation mirrors the Check-In report: the period selector and
"Hide test orders" toggle recompute instantly without a refetch, and the backend
stays a thin extraction layer.

### Backend — `GET /reports/turnaround`

- Auth `Depends(get_current_user)`. Reads the integration DB via
  `get_integration_db()` (no ORM session needed).
- **One SQL query** pivots `sample_status_events` to first-occurrence milestone
  timestamps per sample and left-joins the order:

```sql
WITH m AS (
  SELECT
    sample_id,
    MAX(order_submission_id) AS order_id,
    MIN(COALESCE(to_timestamp(event_timestamp), created_at))
        FILTER (WHERE transition = 'receive')                         AS received_at,
    MIN(COALESCE(to_timestamp(event_timestamp), created_at))
        FILTER (WHERE transition IN ('submit','partial_submit'))      AS submitted_at,
    MIN(COALESCE(to_timestamp(event_timestamp), created_at))
        FILTER (WHERE transition IN ('verify','partial_verify'))      AS verified_at,
    MIN(COALESCE(to_timestamp(event_timestamp), created_at))
        FILTER (WHERE transition = 'publish')                         AS published_at
  FROM sample_status_events
  GROUP BY sample_id
)
SELECT m.sample_id, os.created_at AS ordered_at,
       m.received_at, m.submitted_at, m.verified_at, m.published_at,
       (LOWER(os.payload->'billing'->>'email') IN
          ('forrestp@outlook.com','forrest@valenceanalytical.com')) AS is_test_order
FROM m LEFT JOIN order_submissions os ON os.id = m.order_id;
```

- `MIN(...)` gives **first-occurrence** (rollbacks/reinstates ignored).
- Returns `list[TurnaroundSample]`; all timestamps serialized as ISO‑8601 UTC
  (`…Z`), nulls preserved.

```python
class TurnaroundSample(BaseModel):
    sample_id: str
    ordered_at: Optional[str] = None
    received_at: Optional[str] = None
    submitted_at: Optional[str] = None
    verified_at: Optional[str] = None
    published_at: Optional[str] = None
    is_test_order: bool = False
```

### Frontend — `turnaround-utils.ts` (pure, unit-tested)

- `PHASES`: ordered list of `{key, label, from, to}` over the milestone fields.
- `phaseDurationMs(sample, phase)`: both boundaries present → `to - from`;
  returns null if a boundary is missing or duration ≤ 0 (anomaly).
- `aggregate(samples)`: per phase collect non-null durations → `{median, p90, n}`
  via a linear-interpolation `percentile()`; also total turnaround
  (`published_at - ordered_at`) median, slowest phase, anomaly count, cohort size.
- `percentile(sorted, q)`, `humanizeDuration(ms)` ("4.2d" / "18h" / "45m"),
  `filterByPeriod(samples, period)` (by **received_at**).

### Frontend — `TurnaroundReport.tsx`

- **Header:** title "Bottlenecks" + subtitle "Median time per phase" + period
  selector (1M/3M/6M/1Y/ALL by received date) + "Hide test orders" toggle
  (reuses `is_test_order`).
- **Summary cards:** total median turnaround · slowest phase (named) · cohort size.
- **Ranked bars** (CSS/flex, not recharts): one row per phase sorted slowest-first;
  solid bar = median, lighter tail = p90; phase **n** labelled per row; bars with
  n < 3 dimmed.
- **Table:** phase · median · p90 · n · % of total.
- **Footnote:** "calendar time; partial_submit/partial_verify counted as
  submit/verify; N anomalies excluded."

### Wiring

- `ui-store.ts`: `ReportsSubSection` += `'bottlenecks'`.
- `AppSidebar.tsx`: add `{ id: 'bottlenecks', label: 'Bottlenecks' }` after
  Check-In Times in the reports sub-items.
- `MainWindowContent.tsx`: `case 'reports'` → `if (activeSubSection ===
  'bottlenecks') return <TurnaroundReport />`.

## Error / empty handling

- Loading spinner; red inline error; "No completed phases in this range" empty
  state (existing patterns).
- Integration DB unreachable → endpoint returns 503 (consistent with other
  `/reports/*` endpoints).

## Testing

- **Frontend:** `turnaround-utils.test.ts` — `percentile` (median/p90),
  `phaseDurationMs` (missing boundary → null, negative → null), `aggregate`
  (per-phase n differs, slowest phase, total turnaround), `humanizeDuration`,
  `filterByPeriod`.
- **Backend:** `test_api_reports_turnaround.py` — mocked integration-DB cursor
  returns pivoted rows; asserts auth (401), ISO serialization with `Z`, null
  preservation, and `is_test_order` passthrough.

## Out of scope (YAGNI / v2)

- Deep lab micro-steps (worksheet/prep/analysis) drill-down.
- Business-hours-only durations.
- Product/analyte and per-analyst breakdowns.
- "Currently stuck" live operational view.
