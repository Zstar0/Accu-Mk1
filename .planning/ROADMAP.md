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

### Phase 11: Backfill Existing Curves

**Goal:** Lab staff can retroactively enrich existing calibration curves by linking a Sample ID (which triggers chromatogram fetch from SharePoint) and editing manufacturer/notes metadata.

**Depends on:** Phase 10

**Requirements:** BKFL-01, BKFL-02, BKFL-03

**Success Criteria** (what must be TRUE when this phase completes):
1. User can open an existing calibration curve's edit form, set or change the source Sample ID, and save — the curve record updates with the linked sample prep ID
2. When a source Sample ID is saved, the system locates the corresponding DAD1A chromatogram in SharePoint and populates chromatogram_data on the curve automatically
3. User can edit manufacturer and notes fields on any existing calibration curve and see the changes persist

**Plans:** TBD

Plans:
- [ ] 11-01: Curve edit form (Sample ID link, manufacturer, notes) + SharePoint chromatogram auto-fetch on save

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
- [ ] 12-01: Load curve chromatogram_data in HPLC flyout + dual-trace rendering with synchronized axis

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 06. Data Foundation + Inline Editing | v0.12.0 | 4/4 | Complete | 2026-02-25 |
| 07. Per-Row Workflow Transitions | v0.12.0 | 2/2 | Complete | 2026-02-25 |
| 08. Bulk Selection & Floating Toolbar | v0.12.0 | 2/2 | Complete | 2026-02-25 |
| 09. Data Model + Standard Prep Flag | v0.26.0 | 2/2 | Complete | 2026-03-16 |
| 10. Auto-Create Curve from Standard | v0.26.0 | 0/3 | Not started | - |
| 11. Backfill Existing Curves | v0.26.0 | 0/1 | Not started | - |
| 12. Chromatogram Overlay | v0.26.0 | 0/1 | Not started | - |
