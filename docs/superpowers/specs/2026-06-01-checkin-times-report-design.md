# Check-In Times Report — Design

**Date:** 2026-06-01
**Status:** Approved (Approach A)
**Author:** Brainstorming session

## Problem

The Reports area shows COA/product outcomes but nothing about *when samples are
checked in*. The lab wants to see check-in volume over time and the time-of-day
distribution of check-ins (a "9-to-5" view), plus a raw list — all filterable by
date range — to understand intake patterns.

## Data source (verified)

Check-in time lives in **`worksheet_items.date_received`** (accumark_mk1 DB).

- It is the **SENAITE sample-received timestamp**, copied locally when a sample is
  added to an AccuMark worksheet (the SENAITE-replacement intake path).
- Verified empirically: populated rows carry **real time-of-day** (non-midnight),
  stored UTC/naive. Confirmed via local probe (`date_received::time <> '00:00:00'`
  for all populated rows).
- Accessed through the ORM `get_db` Session — **not** `get_integration_db()`.
  (`published_coa_results` lives in the integration DB and is date-only — unusable
  for time-of-day.)

### Decisions locked during brainstorming

1. **Source field:** `date_received` (true SENAITE check-in time). Rows where it is
   null are excluded.
2. **Timezone:** raw UTC is returned; **all time-of-day bucketing happens
   client-side in the browser's local zone**, matching the app-wide
   `toLocaleString('en-US', …)` convention. No hardcoded lab timezone.
3. **Coverage:** only samples that reached an AccuMark worksheet. This is the
   intake path going forward; there is no deep historical backlog. Acceptable —
   coverage grows over time.
4. **De-duplication:** `worksheet_items` has one row per (sample, analysis), so a
   sample with N analyses yields N rows sharing the same `date_received`. The
   endpoint **dedupes by `sample_uid`** (one check-in event per sample) so counts
   reflect samples, not analyses.

## Architecture & data flow

```
worksheet_items (accumark_mk1)          backend                          frontend
  date_received TIMESTAMP  ──get_db──▶  GET /reports/checkin-times   ──▶  api.ts getCheckInTimes()
  sample_id, sample_uid                 Depends(get_current_user)         │  TanStack Query
  analyses_json (product)               Depends(get_db)                   ▼
  priority                              dedupe by sample_uid           CheckInTimesReport.tsx
                                        filter date_received NOT NULL   (recharts + table)
                                        optional ?from=&to=
                                        returns list[CheckInRecord]
```

### Backend — `GET /reports/checkin-times`

- Auth `Depends(get_current_user)`, DB `Depends(get_db)` (ORM Session).
- Optional query params `from`, `to` (ISO date strings) filtering on
  `date_received`.
- Query `worksheet_items` where `date_received IS NOT NULL`, dedupe by
  `sample_uid` (keep earliest `date_received`), build a `product_label` from
  `analyses_json` peptide names (deduped, comma-joined; null if none).
- Response: `list[CheckInRecord]`, ordered by `date_received` desc.

```python
class CheckInRecord(BaseModel):
    sample_id: str
    sample_uid: str
    date_received: str          # ISO 8601 UTC, "…Z"
    product_label: Optional[str] = None
    priority: str
```

No server-side aggregation: averages and per-hour/per-day buckets are timezone-
dependent and therefore computed client-side.

### Frontend — `api.ts`

```ts
export interface CheckInRecord {
  sample_id: string
  sample_uid: string
  date_received: string
  product_label: string | null
  priority: string
}
export async function getCheckInTimes(from?: string, to?: string): Promise<CheckInRecord[]>
```
Follows the `getReportsDashboard` pattern (`API_BASE_URL()`, `getBearerHeaders()`).

### Frontend — `CheckInTimesReport.tsx` (new, `src/components/reports/`)

Single filterable page, mirroring `ReportsDashboard` / `PurityTrendView` styling:

1. **Header** — title "Check-In Times" + a date-range period selector
   (`1M / 3M / 6M / 1Y / ALL`, reusing the `PurityTrendView` period pattern).
2. **Summary row** — stat cards (reuse the dashboard's card style): total
   check-ins, average time of day, busiest hour, busiest weekday.
3. **Chart panel with a view toggle** (icon buttons like the dashboard):
   - **By day** — bar chart, one bar per calendar day, count of check-ins.
   - **By hour** — bar chart over the 24h day with **off-hours (before 9, after
     17) dimmed**; a reference line at the average time. This is the "9-to-5"
     view.
   Built with recharts `BarChart` + `ResponsiveContainer`, dark-theme colors
   matching `PurityTrendView` (`#9ca3af` ticks, `#374151` grid).
4. **Raw list** — table of every check-in (date, time, sample, product,
   priority) with search + sort, reusing the dashboard `PeptideTable` patterns.

All four read from the single fetched payload; bucketing via `useMemo` in
browser-local time.

### Wiring

- `ui-store.ts`: extend `ReportsSubSection` → `'dashboard' | 'sync-debug' | 'checkin-times'`.
- `AppSidebar.tsx`: add `{ id: 'checkin-times', label: 'Check-In Times' }` to the
  `reports` sub-items.
- `MainWindowContent.tsx`: in `case 'reports'`, add
  `if (activeSubSection === 'checkin-times') return <CheckInTimesReport />`.

## Error / empty handling

- Loading: spinner (existing pattern).
- Error: red inline "Failed to load check-in data" (existing pattern).
- Empty: "No check-ins in this range" message (existing pattern).
- Null `date_received`: excluded server-side.

## Testing

- **Backend:** a test for `/reports/checkin-times` — auth required, dedupes by
  `sample_uid`, excludes null `date_received`, honors `from`/`to`. Follows the
  existing backend test pattern.
- **Frontend:** a component/unit test for the bucketing helpers (per-day,
  per-hour, average time) given a fixed set of records, asserting browser-local
  bucketing and off-hours classification.

## Out of scope (YAGNI)

- Server-side aggregation / caching.
- Backfilling historical check-ins from SENAITE.
- Configurable working-hours window (hardcode 9–17; revisit if asked).
- Cross-filtering by product/analyst (the list's search covers the immediate need).
