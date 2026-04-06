# Roadmap: Accu-Mk1

## Milestones

- ✅ **v0.12.0 — Analysis Results & Workflow Actions** — Phases 6–8 (shipped 2026-02-25)
- ✅ **v0.26.0 — Standard Sample Preps & Calibration Curve Chromatograms** — Phases 9–14 (shipped)
- ✅ **v0.28.0 — Worksheet Feature** — Phases 15–18 (shipped 2026-04-06)
- 🚧 **v0.30.0 — Multi-Instrument Architecture** — Phases 19–23 (in progress)

---

<details>
<summary>✅ v0.12.0 — Analysis Results & Workflow Actions — SHIPPED 2026-02-25</summary>

- [x] **Phase 06: Data Foundation + Inline Editing** — uid/keyword model, backend endpoints, AnalysisTable extraction, and click-to-edit result cells
- [x] **Phase 07: Per-Row Workflow Transitions** — state-aware action menus for all four transitions with sample-level refresh after each action
- [x] **Phase 08: Bulk Selection & Floating Toolbar** — checkbox selection, floating batch action toolbar, and sequential bulk processing

</details>

<details>
<summary>✅ v0.26.0 — Standard Sample Preps & Calibration Curve Chromatograms — SHIPPED</summary>

- [x] **Phase 09: Data Model + Standard Prep Flag** — schema additions for CalibrationCurve, standard toggle + metadata in wizard, standard badge + filter in list
- [x] **Phase 10: Auto-Create Curve from Standard** — HPLC completion on a standard triggers automatic calibration curve creation with full provenance
- [x] **Phase 10.5: HPLC Results Persistence** — full provenance enrichment of hplc_analyses rows, chromatogram storage, DB reload
- [x] **Phase 11: Backfill Existing Curves** — edit existing curves to link Sample ID, fetch chromatogram from SharePoint, edit manufacturer/notes
- [x] **Phase 12: Chromatogram Overlay** — render standard reference trace alongside sample trace in HPLC flyout
- [x] **Phase 13: Same-Method Identity Check** — detect standard injection files, extract RTs, use as identity reference
- [x] **Phase 13.5: HPLC Audit Trail & Debug Persistence** — persist full debug log, source file checksums, visible warnings
- [x] **Phase 14: RT Check Chromatogram Comparison** — side-by-side chromatogram comparison in HPLC flyout for identity verification

</details>

<details>
<summary>✅ v0.28.0 — Worksheet Feature — SHIPPED 2026-04-06</summary>

- [x] **Phase 15: Foundation** — Service groups data model + admin UI, analyst assignment to SENAITE, and navigation wiring (completed 2026-04-01)
- [x] **Phase 16: Received Samples Inbox** — Full inbox queue with priority, aging timers, inline assignment, bulk actions, and worksheet creation (completed 2026-04-01)
- [x] **Phase 17: Worksheet Detail** — Worksheet header, items table, add/remove/reassign items, and completion (completed 2026-04-01)
- [x] **Phase 18: Worksheets List** — All-worksheets view with KPI stats row, filters, and drill-through navigation (completed 2026-04-01)

</details>

---

### 🚧 v0.30.0 — Multi-Instrument Architecture (In Progress)

**Milestone Goal:** Generalize the HPLC-only automation pipeline into an instrument-agnostic framework, prove it with endotoxin (LAL) numeric results and sterility pass/fail, and design the schema for future analytics.

## Phases

- [ ] **Phase 19: Foundation** — Alembic migration framework, main.py router extraction, HPLC regression tests
- [ ] **Phase 20: Schema Generalization** — Generalized Method model, InstrumentResult table, analytics indexes, Alembic migration
- [ ] **Phase 21: Plugin Framework** — Instrument plugin protocol, registry, HPLC refactored as first registered plugin
- [ ] **Phase 22: Endotoxin (LAL)** — Manual entry, standard curve + EU/mL back-calculation, PPC gate, validity dashboard, SENAITE push
- [ ] **Phase 23: Sterility** — Test initiation, 14-day observation workflow, pass/fail verdict, investigational hold, SENAITE push

## Phase Details

### Phase 19: Foundation
**Goal**: The codebase has a safe, versioned migration framework; main.py is decomposed into domain routers; and HPLC calculations are verified by regression tests before any schema changes begin.
**Depends on**: Phase 18 (v0.28.0 complete)
**Requirements**: FNDN-01, FNDN-02, FNDN-03, FNDN-04
**Success Criteria** (what must be TRUE):
  1. Running `alembic upgrade head` applies all existing schema steps cleanly against a fresh database with no errors swallowed
  2. A migration failure (e.g., bad SQL) raises a visible exception and halts startup — the silent bare-except is gone
  3. main.py contains only app setup and router includes; all endpoint logic lives in domain-specific router files (worksheets, hplc, instruments, admin, etc.)
  4. A regression test suite runs end-to-end against fixture CSV data and asserts correct purity %, quantity, and identity results — all pass before any refactoring begins
**Plans**: TBD

### Phase 20: Schema Generalization
**Goal**: The database has a generalized Method model replacing HplcMethod and an InstrumentResult table with typed result columns and analytics indexes, all applied via a clean Alembic migration, with existing HPLC method data migrated and HPLCAnalysis linked forward.
**Depends on**: Phase 19
**Requirements**: SCHM-01, SCHM-02, SCHM-03, SCHM-04, SCHM-05, SCHM-06
**Success Criteria** (what must be TRUE):
  1. The methods table exists with an instrument_type discriminator column and a JSON config column; existing HplcMethod data is readable via the new model
  2. New junction tables (instrument_methods_v2, peptide_methods_v2) are populated with migrated HPLC method associations
  3. The instrument_results table has typed columns result_numeric (float), result_pass (bool), result_unit (text), result_data (JSON), and all provenance FKs: analysis_service_id, instrument_id, method_id, peptide_id, sample_prep_id
  4. HPLCAnalysis has a nullable instrument_result_id FK column; existing rows have NULL (no backfill required)
  5. Analytics indexes on (instrument_type, peptide_id, created_at) and (analysis_service_id, created_at) exist and are queryable
**Plans**: TBD

### Phase 21: Plugin Framework
**Goal**: A typed plugin registry exists keyed by instrument_type; HPLC is registered in it via a shim that wraps existing processor files without modifying them; and all Phase 19 regression tests still pass through the new code path.
**Depends on**: Phase 20
**Requirements**: PLUG-01, PLUG-02, PLUG-03, PLUG-04
**Success Criteria** (what must be TRUE):
  1. The backend/instruments/ package exists with a Protocol defining parse(), calculate(), and can_parse() methods; any plugin can be looked up from the registry by instrument_type string
  2. HplcPlugin is registered in INSTRUMENT_REGISTRY under "hplc"; it delegates to the existing hplc_processor.py and peakdata_csv_parser.py with zero modifications to those files
  3. A new HPLC ingest writes an InstrumentResult row first, then an HPLCAnalysis row with instrument_result_id set
  4. All Phase 19 HPLC regression tests pass through the new plugin path — purity %, quantity, and identity results are numerically identical
**Plans**: TBD

### Phase 22: Endotoxin (LAL)
**Goal**: Users can create LAL test runs with manual onset time entry, the system calculates EU/mL via log-log regression, enforces r >= 0.980 and PPC 50–200% hard gates, shows a validity dashboard per run, stores full provenance in InstrumentResult, and pushes EU/mL to SENAITE.
**Depends on**: Phase 21
**Requirements**: ENDO-01, ENDO-02, ENDO-03, ENDO-04, ENDO-05, ENDO-06, ENDO-07, ENDO-08
**Success Criteria** (what must be TRUE):
  1. User can create a LAL test run record specifying sample IDs, method type (kinetic chromogenic/turbidimetric/gel-clot), dilution factor, and reagent lot; the record persists and is retrievable
  2. User can enter standard curve concentration/onset-time pairs; the system stores slope, intercept, and r-value; a run with r < 0.980 cannot be approved — the approval button is disabled with a visible reason
  3. User can enter sample onset times; the system back-calculates EU/mL from the run's stored curve without any browser-side math
  4. A PPC spike recovery outside 50–200% blocks run approval with a visible gate indicator; a PPC within range shows green
  5. The LAL run validity dashboard shows r-value, PPC recovery %, and a green/red overall validity indicator in one view
  6. Approved LAL results appear in the analyses results table and can be pushed to SENAITE as EU/mL numeric values to the correct analysis service
**Plans**: TBD
**UI hint**: yes

### Phase 23: Sterility
**Goal**: Users can initiate sterility test records, record daily observations over a 14-day incubation period, record a pass/fail verdict (with the 14-day gate enforced server-side), place failed tests in investigational hold, view a days-elapsed indicator, and push results to SENAITE.
**Depends on**: Phase 21
**Requirements**: STER-01, STER-02, STER-03, STER-04, STER-05, STER-06, STER-07, STER-08
**Success Criteria** (what must be TRUE):
  1. User can create a sterility test record with sample IDs, method (membrane filtration/direct inoculation), media lots, and incubation start date; the record persists and appears in a sterility tests list
  2. User can record a daily observation entry per vessel (date, observer, growth yes/no, notes); observations accumulate and are visible in the test detail view
  3. Attempting to record a Pass verdict before 14 days have elapsed since initiation returns a server-side error — the gate is enforced regardless of UI state
  4. User can record a Fail verdict with vessel ID, day of detection, and growth description; the test is marked failed with that detail stored
  5. User can place a failed test in investigational hold status; the test shows "Investigational Hold" and cannot be re-verdicted until hold is lifted
  6. Each in-progress sterility test shows a days-elapsed / 14-day indicator so operators can see incubation progress at a glance
  7. Approved sterility results appear in the analyses results table and can be pushed to SENAITE as Pass/Fail text to the correct analysis service
**Plans**: TBD
**UI hint**: yes

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 06. Data Foundation + Inline Editing | v0.12.0 | 4/4 | Complete | 2026-02-25 |
| 07. Per-Row Workflow Transitions | v0.12.0 | 2/2 | Complete | 2026-02-25 |
| 08. Bulk Selection & Floating Toolbar | v0.12.0 | 2/2 | Complete | 2026-02-25 |
| 09. Data Model + Standard Prep Flag | v0.26.0 | 2/2 | Complete | 2026-03-16 |
| 10. Auto-Create Curve from Standard | v0.26.0 | 3/3 | Complete | — |
| 10.5 HPLC Results Persistence | v0.26.0 | 2/2 | Complete | 2026-03-18 |
| 11. Backfill Existing Curves | v0.26.0 | 2/2 | Complete | 2026-03-18 |
| 12. Chromatogram Overlay | v0.26.0 | 2/2 | Complete | 2026-03-18 |
| 13. Same-Method Identity Check | v0.26.0 | 3/3 | Complete | 2026-03-19 |
| 13.5 HPLC Audit Trail & Debug | v0.26.0 | 3/3 | Complete | 2026-03-19 |
| 14. RT Check Chromatogram Comparison | v0.26.0 | 0/? | Complete | — |
| 15. Foundation | v0.28.0 | 4/4 | Complete | 2026-04-01 |
| 16. Received Samples Inbox | v0.28.0 | 4/4 | Complete | 2026-04-01 |
| 17. Worksheet Detail | v0.28.0 | 3/3 | Complete | 2026-04-01 |
| 18. Worksheets List | v0.28.0 | 1/1 | Complete | 2026-04-01 |
| 19. Foundation | v0.30.0 | 0/? | Not started | - |
| 20. Schema Generalization | v0.30.0 | 0/? | Not started | - |
| 21. Plugin Framework | v0.30.0 | 0/? | Not started | - |
| 22. Endotoxin (LAL) | v0.30.0 | 0/? | Not started | - |
| 23. Sterility | v0.30.0 | 0/? | Not started | - |
