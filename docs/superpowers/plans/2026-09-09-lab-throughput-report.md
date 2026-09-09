# Lab Throughput Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Reports → Lab Throughput page to Accu-Mk1 that shows tests per day by type, samples/COAs per business day, HPLC bench load, backlog and add-on attach rate from live Mk1 + Integration Service data.

**Architecture:** A pure engine (`backend/throughput.py`) turns already-fetched rows into a per-day series bucketed in the lab timezone; one new `GET /reports/throughput` route in `main.py` loads the rows (Mk1 ORM + IS `coa_generations`) and delegates to the engine. The frontend adds a `ThroughputReport` component beside Check-In Times, with all weekly/monthly/KPI rollups in a pure `throughput-utils.ts`.

**Tech Stack:** FastAPI + SQLAlchemy 2 (backend, pytest on a host venv), React 19 + TanStack Query + recharts 3 (frontend, vitest).

**Spec:** `docs/superpowers/specs/2026-09-09-lab-throughput-report-design.md`

## Global Constraints

- Additive only: no existing report, route, store field or sidebar entry changes behaviour.
- npm only for the frontend; `npm run check:all` gates are judged against the baseline failure-set diff (repo-wide lint/format are not clean on master; never run repo-wide prettier).
- No version bump in the PR: release commits (`chore: release vX.Y.Z`) carry the bump and fold the CHANGELOG entry; this PR adds the entry under `## Unreleased`.
- Route is a plain `def` (threadpool), not `async def`, because it does synchronous DB work.
- IS DB failure → `HTTPException(503, f"Reports database error: {e}")`, same string as the siblings.
- English strings, like the sibling reports (they do not use i18n; flagged in the PR, not fixed).
- Series never starts before `2026-02-01` (`SERIES_START`, January is a migration artifact).

---

### Task 1: Pure engine — `backend/throughput.py` ✅ (done, commit 9798d77f)

**Files:** Create `backend/throughput.py`, Test `backend/tests/test_throughput.py`.

**Produces:** `SampleIn`, `AnalysisIn`, `CoaIn`, `BenchIn`, `LabCalendar`, `SERIES_START`, `classify_keyword(keyword, category) -> str`, `lab_day(ts, tz) -> date | None`, `build_throughput(*, samples, analyses, vial_counts, coas, bench, instruments, service_categories, calendar, start, today, excluded_sample_ids=frozenset()) -> dict`.

- [x] Failing tests for classification, de-dupe, lab-day bucketing, window/calendar flags, exclusion, COA output, backlog series/snapshot, vials, bench, envelope.
- [x] Implementation; `pytest backend/tests/test_throughput.py` → 35 passed.

### Task 2: Pure frontend rollups — `src/components/reports/throughput-utils.ts` ✅ (done)

**Files:** Create `src/components/reports/throughput-utils.ts`, Test `src/components/reports/throughput-utils.test.ts`.

**Produces:** `ThroughputDay`, `ThroughputReport`, `RangeKey`, `isoWeekKey`, `sliceRange`, `businessDays`, `sumKey`, `perBusinessDay`, `pct`, `pctChange`, `kpiWindows`, `aggregateMonths`, `aggregateWeeks`, `flowWeeks`, `dowProfile`, `staleSplit`, `shortDay`, `longDay`.

- [x] Failing vitest for ISO weeks, range slicing, business-day rates, KPI windows, month/week rollups, flow weeks, DOW profile, stale split.
- [x] Implementation; `npx vitest run src/components/reports/throughput-utils.test.ts` → 22 passed.

### Task 3: API route — `GET /reports/throughput`

**Files:** Modify `backend/main.py` (after `reports_turnaround`, before `class ReportsSyncStatus`), Test `backend/tests/test_api_reports_throughput.py`.

**Interfaces:**
- Consumes: Task 1 engine.
- Produces: `_load_throughput_inputs(db) -> dict` (samples, analyses, vial_counts, bench, instruments, service_categories, calendar), `_fetch_throughput_coas() -> list[CoaIn]`, Pydantic `ThroughputDayOut`, `ThroughputBacklogNowOut`, `ThroughputReportOut`, route `reports_throughput(from_date, to_date, include_test_orders, db, _current_user)`.

- [ ] **Step 1: failing API test** — 401 without auth; 200 envelope with patched loaders; `include_test_orders=false` passes `_test_order_senaite_ids()` as `excluded_sample_ids`; `from`/`to` slice the day series without breaking the backlog value; 503 when `_fetch_throughput_coas` raises.
- [ ] **Step 2:** run → fails (route missing, 404).
- [ ] **Step 3:** implement the loaders + route; response models inline above the route like `CheckInRecord`.
- [ ] **Step 4:** run → passes; `pytest backend/tests/test_throughput.py backend/tests/test_api_reports_throughput.py`.
- [ ] **Step 5:** commit `feat(reports): GET /reports/throughput`.

### Task 4: API client + wiring

**Files:** Modify `src/lib/api.ts` (after `getTurnaround`), `src/store/ui-store.ts` (`ReportsSubSection`), `src/components/layout/MainWindowContent.tsx` (reports case), `src/components/layout/AppSidebar.tsx` (reports subItems).

- [ ] `getThroughput(includeTestOrders: boolean): Promise<ThroughputReport>` with `?include_test_orders=true` only when set; error `Throughput failed: <status>`.
- [ ] `'throughput'` member in `ReportsSubSection`; `if (activeSubSection === 'throughput') return <ThroughputReport />`; `{ id: 'throughput', label: 'Lab Throughput' }` after Check-In Times.
- [ ] `npm run typecheck`; commit `feat(reports): wire Lab Throughput into Reports`.

### Task 5: `ThroughputReport.tsx`

**Files:** Create `src/components/reports/ThroughputReport.tsx`, Test `src/components/reports/ThroughputReport.test.tsx` (render with mocked `getThroughput`).

- [ ] Failing render test: header, six stat cards, section headings, "Hide test orders" toggles the query key.
- [ ] Component: `useQuery({ queryKey: ['reports', 'throughput', includeTestOrders], staleTime: 60_000 })`, range presets 30/60/90/180/All, StatCard row, daily/weekly stacked `BarChart`s, intake-vs-completed + backlog `LineChart`s, monthly table, bench by instrument, DOW profile, attach-rate lines, definitions list.
- [ ] `npx vitest run src/components/reports`; commit `feat(reports): Lab Throughput page`.

### Task 6: Gates, CHANGELOG, PR

- [ ] `npm run typecheck && npm run lint && npm run ast:lint && npm run format:check` on changed files vs baseline; `npx vitest run` failure-set diff vs `.vitest-baseline.txt`; backend `pytest tests` failure-set diff vs `.pytest-baseline-failset.txt`.
- [ ] `CHANGELOG.md` `## Unreleased` → `### Added` entry.
- [ ] `gitnexus_detect_changes` before the final commit; push `feat/reports-throughput`; open PR (no merge, no deploy).
