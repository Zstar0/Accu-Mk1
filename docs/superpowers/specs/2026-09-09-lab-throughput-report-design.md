# Lab Throughput report — design

**Date:** 2026-09-09 (design first proposed 2026-08-18; recovered and approved 2026-09-09)
**Status:** approved by Handler ("go, build it as a PR")
**Placement:** Reports → **Lab Throughput** (`#reports/throughput`)

## Why

The lab-throughput picture (tests per day by type, samples per day, COA output, HPLC bench
load, backlog, attach rate) currently exists only as an offline HTML report produced by the
`lab-throughput-report` skill from a prod SQL extract. The Handler wants it inside Accu-Mk1 so
anyone with a login can open it without an operator regenerating a file.

This is additive: a new `/reports/*` route and a new Reports sub-section, copying the idiom of
Check-In Times and Bottlenecks (commit `c7ec644d`, v0.37.0). Nothing existing changes.

## Definitions (identical to the offline report — do not re-derive)

| Term | Definition |
|---|---|
| **Test** | one analysis *family* ordered on a sample: **HPLC panel** (identity + purity + quantity, blends, `PUR_`/`QTY_`, counted once per sample), **Sterility** (`STER-PCR`), **Endotoxin** (`ENDO-LAL`), **Bac Water panel** (`Benzyl_Alcohol_Assay` + `PH-DETERM` + `FILL-NET-CONTENT`, counted once per sample — Handler ruling 2026-08-18). Anything else → **Other**, counted per keyword. Source `lims_analyses` de-duplicated on (sample, keyword) across `shadow` + `canonical` provenance, which is what makes pre-June months countable. |
| **Day** | `lims_samples.date_received` (naive UTC) converted to the lab timezone from `business_hours_config.timezone` (America/Los_Angeles in prod). |
| **Business day** | weekday in `business_hours_config.working_days` and not in `lab_holidays`. |
| **Primary COA** | Integration Service `coa_generations` with `parent_generation_id IS NULL` and `published_at IS NOT NULL`, counted on its publish day; re-issues included. |
| **Samples completed** | a sample's *first* primary publication (the clean counterpart to intake). |
| **Additional COA** | `coa_generations` with a `parent_generation_id` (branded ACOAs). |
| **Backlog** | received, not cancelled, no primary COA yet — daily end-of-day series plus a "now" snapshot by age bucket and status. |
| **HPLC vials run** | distinct `hplc_analyses.sample_id_label` per lab day, split by `instruments.name`; processing runs = every row. |
| **Vials received** | `lims_sub_samples` per parent sample (native check-in, June 2026+ only). |

Known data limits (the page states them): January 2026 is a migration artifact → series
starts 2026-02-01; `lims_sub_samples` from June 2026; `hplc_analyses` from March 2026;
today is partial; open samples older than 30 days are largely stale/abandoned work.

## Backend

`GET /reports/throughput?from=YYYY-MM-DD&to=YYYY-MM-DD&include_test_orders=false`

- Registered in `backend/main.py` next to the other `/reports/*` routes, same auth dependency
  as its siblings (any logged-in user).
- Logic lives in a new **pure** module `backend/throughput.py` (no FastAPI, no session
  import — like `sla_engine.py`) so it is unit-testable with plain dicts:
  - `classify_keyword(keyword, category) -> 'hplc'|'ster'|'endo'|'bacw'|'other'`
  - `lab_day(ts, tz) -> date`
  - `build_days(...)`, `backlog_now(...)` — take already-fetched row lists, return the response.
- The route fetches rows (Mk1 ORM session: `lims_samples`, `lims_analyses`, `lims_sub_samples`,
  `hplc_analyses` + `instruments`, `analysis_services`, `business_hours_config`,
  `lab_holidays`; IS DB via `get_integration_db()`: `coa_generations`) and hands them to the
  pure module.
- **Deliberate deviation** from the house "return raw rows, aggregate client-side" idiom:
  days are bucketed **server-side in the lab timezone** using the server's calendar (the SLA
  engine already owns it), because shipping ~30k analysis rows to dedupe in the browser is
  wasteful. Weekly / monthly / day-of-week / KPI rollups stay client-side in a pure
  `throughput-utils.ts`.
- Test orders (billing e-mail in `TEST_EMAILS`, via the existing `_test_order_senaite_ids()`)
  are **excluded by default**; `include_test_orders=true` includes them. The offline report
  did not exclude them, so in-app numbers may differ by a handful.
- IS DB failure → **503** like the other IS-backed reports. No server cache for v1
  (TanStack `staleTime` like siblings).

Response shape:

```
{
  "start": "2026-02-01", "end": "2026-09-09", "today": "2026-09-09",
  "tz": "America/Los_Angeles", "generated_at": "...",
  "instruments": ["1290a", "1290b"],
  "holidays": ["2026-07-03", ...],
  "days": [ { "d": "2026-02-01", "dow": 6, "biz": false, "hol": false,
              "samples": 0, "cancelled": 0, "hplc": 0, "ster": 0, "endo": 0, "bacw": 0, "other": 0,
              "tests": 0, "vials": 0, "retest": 0, "clients": 0,
              "coa": 0, "acoa": 0, "fp": 0,
              "bench_rows": 0, "bench_vials": 0, "bench_inst": {"1290a": 0},
              "backlog": 12 }, ... ],
  "backlog_now": { "total": 254, "status": {"sample_received": 120, ...},
                   "age": {"0-2d": 40, "3-7d": 30, "8-14d": 20, "15-30d": 30, ">30d": 134} },
  "notes": { "jan_excluded": true, "vials_from": "2026-06", "bench_from": "2026-03" }
}
```

## Frontend

- `src/components/reports/ThroughputReport.tsx` + `src/components/reports/throughput-utils.ts`
  (+ `throughput-utils.test.ts`), recharts (already a dependency).
- Wired like its siblings: `'throughput'` added to `ReportsSubSection` in the ui-store,
  a case in `MainWindowContent`, an entry in `AppSidebar` after Check-In Times,
  `getThroughput()` in `api.ts`.
- v1 sections (parity with the offline report minus the client/peptide mix):
  1. **StatCard row** — last 30 vs prior 30 calendar days, per business day: tests, samples
     (+ vials received), COAs published (+ samples completed), HPLC vials run, add-on attach
     rate (neutral delta), open backlog (stale split).
  2. **Daily stacked bars by type** (HPLC · Sterility · Endotoxin · Bac Water · Other when
     present) with 30/60/90/180/All presets, weekend shading, holiday ticks, hover tooltip.
  3. **Weekly stacked bars** (ISO weeks) with totals.
  4. **Intake vs samples-completed** weekly lines (current partial week omitted) and
     **backlog** line + age/status now.
  5. **Month-by-month table** with per-business-day rates; n/a cells before the vial/bench
     data start.
  6. **HPLC bench vials/day by instrument** (follows the range selector).
  7. **Day-of-week profile** and **add-on attach rate by month**.
  8. Definitions & data notes.
- Colours: the CVD-validated palette from the artifact — HPLC teal `#0F8AA3`, sterility
  `#eb6834`, endotoxin `#7b5ea7`, Bac Water `#c98500`, dark-mode variants `#1FA3BE` /
  `#d95926` / `#9085e9` / `#c98500`; instrument split = ordinal teal ramp.
- English strings like the sibling reports (they do not use i18n — flagged, not fixed here).

Deferred (cheap follow-ups, not in v1): top clients / peptides mix; CSV export.

## Tests & gates

- `backend/tests/test_throughput.py` — classification, (sample, keyword) de-dupe, lab-day
  bucketing across the UTC→LA boundary, backlog recurrence, business-day flags, age buckets.
- `backend/tests/test_api_reports_throughput.py` — 401 without auth, fake DB sessions like
  the sibling tests, 503 when the IS DB raises.
- `src/components/reports/throughput-utils.test.ts` — ISO week keys, month/week rollups,
  KPI windows, range slicing.
- `npm run check:all` and backend pytest judged against the **baseline failure-set diff**
  (repo-wide lint/format are not clean on master; never run repo-wide prettier).

## Delivery

Worktree off `origin/master` → branch `feat/reports-throughput` → PR with this spec,
CHANGELOG entry and version bump in lockstep (as `c7ec644d`). **PR only — no merge, no
deploy**; those are separate sign-offs.
