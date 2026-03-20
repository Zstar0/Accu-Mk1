# Roadmap

## Completed Milestones

- **v0.11.0 — New Analysis Wizard** SHIPPED 2026-02-20 — 5 phases, 9 plans, guided sample prep wizard with Mettler Toledo scale integration and SENAITE sample lookup. [Archive -->](milestones/v0.11.0-new-analysis-wizard.md)

<details>
<summary>v0.12.0 — Analysis Results & Workflow Actions — SHIPPED 2026-02-25</summary>

- [x] **Phase 06: Data Foundation + Inline Editing** — uid/keyword model, backend endpoints, AnalysisTable extraction, and click-to-edit result cells
- [x] **Phase 07: Per-Row Workflow Transitions** — state-aware action menus for all four transitions with sample-level refresh after each action
- [x] **Phase 08: Bulk Selection & Floating Toolbar** — checkbox selection, floating batch action toolbar, and sequential bulk processing

</details>

## Current Milestone

### v0.26.0 — Standard Sample Preps & Calibration Curve Chromatograms

**Milestone Goal:** Let lab staff prepare standards through the same wizard as production samples, auto-generate calibration curves from standard HPLC results, backfill existing curves with chromatogram data, and visually overlay standard vs sample chromatograms during HPLC processing.

- [x] **Phase 09: Data Model + Standard Prep Flag** — schema additions for CalibrationCurve, standard toggle + metadata in wizard, standard badge + filter in list
- [ ] **Phase 10: Auto-Create Curve from Standard** — HPLC completion on a standard triggers automatic calibration curve creation with full provenance
- [ ] **Phase 11: Backfill Existing Curves** — edit existing curves to link Sample ID, fetch chromatogram from SharePoint, edit manufacturer/notes
- [ ] **Phase 12: Chromatogram Overlay** — render standard reference trace alongside sample trace in HPLC flyout

---

## Phase Details

### Phase 09: Data Model + Standard Prep Flag

**Goal:** Lab staff can prepare a standard sample through the wizard with manufacturer and notes metadata, see it badged in the list, and the CalibrationCurve model has all fields needed for downstream automation.

**Depends on:** Phase 08 (v0.12.0 milestone complete)

**Requirements:** STDP-01, STDP-02, STDP-03, STDP-04, STDP-05, CURV-01, CURV-02, CURV-03, CURV-04, CURV-05

**Success Criteria** (what must be TRUE when this phase completes):
1. User can toggle "Standard" in wizard Step 1; toggling reveals manufacturer and notes fields that persist through all wizard steps and are saved on the sample prep record
2. Sample Preps list shows a visible "Standard" badge on standard preps; user can filter the list to show only standards or only production preps
3. CalibrationCurve table in the database includes source_sample_id, chromatogram_data, source_sharepoint_folder, manufacturer, and notes columns (verified via DB inspection or API schema)
4. Standard preps flow through stock prep, dilution, and measurement wizard steps identically to production preps — no steps skipped or altered

**Plans:** 2 plans

Plans:
- [x] 09-01-PLAN.md — Schema migrations (CalibrationCurve + WizardSession + sample_preps) and API/type updates
- [x] 09-02-PLAN.md — Standard toggle in wizard Step 1, list badge, and filter dropdown

---

### Phase 10: Auto-Create Curve from Standard

**Goal:** When HPLC processing completes on a standard sample prep, the system automatically creates a calibration curve with calculated values, chromatogram data, and full provenance linkage — no manual curve entry needed.

**Depends on:** Phase 09

**Requirements:** AUTO-01, AUTO-02, AUTO-03, AUTO-04, AUTO-05, AUTO-06

**Success Criteria** (what must be TRUE when this phase completes):
1. After running Process HPLC on a standard prep, a new CalibrationCurve row exists for the matching peptide without the user creating it manually
2. The auto-created curve contains slope, intercept, r_squared, and reference_rt values derived from the standard's HPLC analysis
3. The auto-created curve contains chromatogram_data (times + signals from DAD1A CSV) and links back to the source sample prep ID and SharePoint folder
4. Manufacturer and notes from the standard prep metadata are carried onto the new curve record

**Plans:** 3 plans

Plans:
- [ ] 10-01-PLAN.md — Backend endpoint POST /peptides/{id}/calibrations/from-standard with full provenance
- [ ] 10-02-PLAN.md — Wizard standard mode: configurable concentration levels, multi-dilution step builder
- [ ] 10-03-PLAN.md — HPLC flyout standard detection, curve preview, and confirm-to-create flow

---

### Phase 10.5: HPLC Results Persistence (INSERTED)

**Goal:** Enrich the existing `hplc_analyses` table with full provenance and context so every Process HPLC run produces a complete, reloadable record — including calibration curve used, sample prep link, chromatogram traces, instrument, source files, and blend run grouping.

**Depends on:** Phase 10

**Requirements:** HRES-01, HRES-02, HRES-03, HRES-04, HRES-05, HRES-06, HRES-07

**Success Criteria** (what must be TRUE when this phase completes):
1. Each `hplc_analyses` row stores the `calibration_curve_id`, `sample_prep_id`, `instrument_id`, and `source_sharepoint_folder` used for that analysis run
2. Chromatogram trace data (times + signals from parsed .ch files) is stored per analysis so the chart can be re-rendered without re-scanning SharePoint
3. Blend runs produce a `run_group_id` that links all per-analyte analysis rows from the same Process HPLC session, enabling grouped retrieval
4. Reopening Process HPLC for a sample prep that has saved results loads them from the DB instantly (no SharePoint re-scan), with an option to re-run
5. The full calculation trace, peak detection data, and injection-level details are persisted so results can be audited and compared across runs
6. Saved results are retrievable via API by sample_prep_id, enabling downstream comparison tooling (e.g., our results vs lab results)
7. Sample prep status transitions from `awaiting_hplc` to `hplc_complete` when results are saved, and the results are visible from the sample preps list

**Plans:** 2 plans

Plans:
- [x] 10.5-01-PLAN.md — Backend: schema migration, model enrichment, endpoint augmentation, new GET by sample_prep_id
- [x] 10.5-02-PLAN.md — Frontend: API types, flyout provenance passing, run_group_id, DB reload, status auto-update

---

### Phase 11: Backfill Existing Curves

**Goal:** Lab staff can retroactively enrich existing calibration curves by linking a Sample ID (which triggers chromatogram fetch from SharePoint) and editing manufacturer/notes metadata.

**Depends on:** Phase 10

**Requirements:** BKFL-01, BKFL-02, BKFL-03

**Success Criteria** (what must be TRUE when this phase completes):
1. User can open an existing calibration curve's edit form, set or change the source Sample ID, and save — the curve record updates with the linked sample prep ID
2. When a source Sample ID is saved, the system locates the corresponding DAD1A chromatogram in SharePoint and populates chromatogram_data on the curve automatically
3. User can edit manufacturer and notes fields on any existing calibration curve and see the changes persist

**Plans:** 2 plans

Plans:
- [x] 11-01-PLAN.md — Backend: extend PATCH schema + chromatogram auto-fetch on source_sample_id change
- [x] 11-02-PLAN.md — Frontend: Source Sample ID + Vendor fields in CalibrationRow edit/view

---

### Phase 12: Chromatogram Overlay

**Goal:** During HPLC processing, the flyout displays the active calibration curve's standard chromatogram as a reference trace underneath the sample's chromatogram, enabling direct visual comparison on a shared time axis.

**Depends on:** Phase 11

**Requirements:** CHRO-01, CHRO-02, CHRO-03, CHRO-04

**Success Criteria** (what must be TRUE when this phase completes):
1. When opening the HPLC flyout for a sample that has an active calibration curve with chromatogram_data, two traces appear on the chart instead of one
2. The standard trace renders in a distinct style (dashed or lighter) clearly distinguishable from the sample trace (solid)
3. Both traces share the same time axis — zooming or panning affects both traces together, and peaks at the same retention time visually align

**Plans:** TBD

Plans:
- [x] 12-01-PLAN.md — ChromatogramChart: per-trace styling (dashed/opacity) + extractStandardTrace helper
- [x] 12-02-PLAN.md — Flyout: prepend standard trace to displayChromTraces + visual checkpoint

---

### Phase 13: Same-Method Identity Check from Standard Injections

**Goal:** Detect standard injection files (`_std_` in filename) in the .rslt folder, extract their main peak RTs, and use those as the identity reference instead of the calibration curve's reference_rt (which may be from a different method). This gives accurate same-method RT comparison for blends.

**Depends on:** Phase 12

**Requirements:** METH-01, METH-02, METH-03, METH-04

**Success Criteria** (what must be TRUE when this phase completes):
1. The HPLC file parser detects `_std_` peak data files in the .rslt folder and parses them as standard reference injections
2. For each analyte, the identity check uses the standard injection's main peak RT (same method) when available, falling back to calibration curve reference_rt when no standard injection exists
3. Identity results for blends show correct CONFORMS/DOES NOT CONFORM based on same-method RT comparison (e.g., BPC-157 delta 0.019 min → Conforms, not 6.6 min → Does Not Conform)
4. The standard injection RT and source are displayed in the Identity section so the tech can see which reference was used

**Plans:** TBD

Plans:
- [x] 13-01-PLAN.md — Parse _std_ files, extract standard injection RTs, expose in API
- [x] 13-02-PLAN.md — Identity calculation uses std RT when available, alias matching, source tracking
- [x] 13-03-PLAN.md — Frontend types, flyout wiring, identity card reference source display

---

### Phase 13.5: HPLC Audit Trail & Debug Persistence (INSERTED)

**Goal:** Persist the full debug log and source file contents for every HPLC analysis run so results are reproducible, auditable, and debuggable without re-scanning SharePoint. Surface warnings visibly in the debug panel for silent fallbacks and missing data.

**Depends on:** Phase 13

**Requirements:** AUDT-01, AUDT-02, AUDT-03

**Success Criteria** (what must be TRUE when this phase completes):
1. Each hplc_analyses row stores the full debug log (array of level/msg objects) in a `debug_log` JSON field, renderable on DB reload
2. The `raw_data` JSON field includes the raw CSV content and SHA256 checksums for all source files used (peak data, standard injections, chromatograms)
3. The debug panel shows visible warnings for: missing standard injections (fallback to cal curve), missing chromatogram traces, label matching failures, missing vial weight data, and SharePoint errors

**Plans:** TBD

Plans:
- [x] 13.5-01-PLAN.md — Backend: debug_log column + source_files in raw_data
- [x] 13.5-02-PLAN.md — Frontend: warning lines in debug panel for all silent fallbacks
- [x] 13.5-03-PLAN.md — Frontend: SHA256 util, file retention, pass-through, DB reload rendering

---

### Phase 14: RT Check Chromatogram Comparison

**Goal:** Provide a side-by-side chromatogram comparison view in the HPLC flyout for identity verification — showing the standard's chromatogram next to the sample's chromatogram with peak annotations, matching how the lab techs currently compare RT Check PDFs.

**Depends on:** Phase 13

**Requirements:** RTCK-01, RTCK-02, RTCK-03

**Success Criteria** (what must be TRUE when this phase completes):
1. The identity section in the HPLC flyout shows a side-by-side chromatogram comparison: standard trace (with peak RT annotation) next to sample trace (with peak RT annotation)
2. Standard injection DAD1A chromatograms (`_std_*.dx_DAD1A.CSV`) are loaded and displayed alongside sample chromatograms
3. The comparison view shows the RT delta between the standard and sample main peaks, enabling the tech to visually confirm identity

**Plans:** TBD

Plans:
- [ ] TBD (run /gsd:plan-phase 14 to break down)

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 06. Data Foundation + Inline Editing | v0.12.0 | 4/4 | Complete | 2026-02-25 |
| 07. Per-Row Workflow Transitions | v0.12.0 | 2/2 | Complete | 2026-02-25 |
| 08. Bulk Selection & Floating Toolbar | v0.12.0 | 2/2 | Complete | 2026-02-25 |
| 09. Data Model + Standard Prep Flag | v0.26.0 | 2/2 | Complete | 2026-03-16 |
| 10. Auto-Create Curve from Standard | v0.26.0 | 0/3 | Not started | - |
| 10.5 HPLC Results Persistence | v0.26.0 | 2/2 | Complete | 2026-03-18 |
| 11. Backfill Existing Curves | v0.26.0 | 2/2 | Complete | 2026-03-18 |
| 12. Chromatogram Overlay | v0.26.0 | 2/2 | Complete | 2026-03-18 |
| 13. Same-Method Identity Check | v0.26.0 | 3/3 | Complete | 2026-03-19 |
| 13.5 HPLC Audit Trail & Debug | v0.26.0 | 3/3 | Complete | 2026-03-19 |
| 14. RT Check Chromatogram Comparison | v0.26.0 | 0/? | Not started | - |
