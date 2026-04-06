# Requirements: Accu-Mk1 v0.30.0

**Defined:** 2026-04-06
**Core Value:** Streamlined lab workflow: import instrument data, review batch, calculate results, push to SENAITE. One operator, one workstation, any instrument type, no friction.

## v0.30.0 Requirements

Requirements for multi-instrument architecture milestone. Each maps to roadmap phases.

### Foundation & Infrastructure

- [ ] **FNDN-01**: Alembic migration framework initialized with existing schema as baseline
- [ ] **FNDN-02**: Migration runner bare `except:pass` replaced with proper error handling and logging
- [ ] **FNDN-03**: main.py endpoints extracted into domain-specific routers (worksheets, HPLC, instruments, admin, etc.)
- [ ] **FNDN-04**: HPLC regression tests verify existing calculation pipeline produces correct purity, quantity, and identity results before any refactoring

### Generalized Schema

- [ ] **SCHM-01**: Generalized Method model replaces HPLC-specific HplcMethod, with instrument_type discriminator and config JSON for type-specific parameters
- [ ] **SCHM-02**: New junction tables (instrument_methods_v2, peptide_methods_v2) reference the generalized Method model; existing HPLC method data migrated
- [ ] **SCHM-03**: InstrumentResult model stores results for any instrument type with typed columns: result_numeric (float), result_unit (string), result_pass (bool), result_data (JSON for full detail)
- [ ] **SCHM-04**: InstrumentResult links to analysis_service_id, instrument_id, method_id, peptide_id, and sample_prep_id for full provenance
- [ ] **SCHM-05**: Existing HPLCAnalysis records linked to InstrumentResult via nullable FK (no data migration of existing records required)
- [ ] **SCHM-06**: Analytics-ready indexes on InstrumentResult: (instrument_type, peptide_id, created_at), (analysis_service_id, created_at) for cross-sample trending queries

### Plugin Framework

- [ ] **PLUG-01**: Instrument plugin protocol defines standard interface: parse(file) -> ParseResult, calculate(inputs) -> ResultData, can_parse(file) -> bool
- [ ] **PLUG-02**: Plugin registry keyed by instrument_type with parser, calculator, and result-shape metadata per entry
- [ ] **PLUG-03**: HPLC automation refactored as HplcPlugin wrapping existing hplc_processor.py and peakdata_csv_parser.py without modifying their internals
- [ ] **PLUG-04**: Existing HPLC automation continues to produce identical results after plugin refactor (verified by FNDN-04 regression tests)

### Endotoxin (LAL) Testing

- [ ] **ENDO-01**: User can create a LAL test run record with sample ID(s), method (kinetic chromogenic/turbidimetric/gel-clot), dilution factor, and reagent lot
- [ ] **ENDO-02**: User can enter standard curve data (concentrations and onset times) for a LAL run; system calculates log-log regression and stores slope, intercept, r-value
- [ ] **ENDO-03**: System enforces r ≥ 0.980 hard gate on standard curve — run cannot be approved if curve is invalid
- [ ] **ENDO-04**: User can enter sample onset times (manual entry); system back-calculates EU/mL from the run's standard curve
- [ ] **ENDO-05**: System calculates PPC spike recovery and enforces 50-200% hard gate — run is flagged invalid if outside range
- [ ] **ENDO-06**: LAL run validity dashboard shows standard curve r-value, PPC recovery %, and green/red validity indicator at a glance
- [ ] **ENDO-07**: LAL results stored in InstrumentResult with full provenance (curve parameters, well data, dilution factor, calculation trace)
- [ ] **ENDO-08**: LAL results auto-fill into the analyses results table using the same pattern as HPLC, enabling SENAITE push

### Sterility Testing

- [ ] **STER-01**: User can initiate a sterility test record with sample ID(s), method (membrane filtration/direct inoculation), media lots, incubation start date
- [ ] **STER-02**: User can record daily observations per vessel: date, observer, growth yes/no, notes (sub-table or observation array)
- [ ] **STER-03**: System enforces 14-day completion gate — test cannot be marked Pass until ≥14 days have elapsed since initiation
- [ ] **STER-04**: User can record final verdict (Pass/Fail) with growth detail on fail (which vessel, which day, growth description)
- [ ] **STER-05**: Failed sterility tests can be placed in investigational hold status before final disposition
- [ ] **STER-06**: In-progress sterility tests display an age indicator showing days elapsed / 14 days
- [ ] **STER-07**: Sterility results stored in InstrumentResult with full provenance (observation history, vessel details, verdict rationale)
- [ ] **STER-08**: Sterility results auto-fill into the analyses results table using the same pattern as HPLC, enabling SENAITE push

## Future Requirements

### LAL File Parser

- **LALP-01**: System can parse EndoScan-V CSV export files to extract onset times, concentrations, and well mappings
- **LALP-02**: System can parse MARS/Softmax Pro exports as alternative plate reader formats
- **LALP-03**: Parser uses can_parse() self-identification to auto-detect file format

### Analytics & Reporting

- **ANLR-01**: User can view cross-sample trending for any result type (purity, EU/mL, etc.) per peptide/blend
- **ANLR-02**: User can view average results and trend charts across all samples of a given type
- **ANLR-03**: Dashboard shows QC indicators and out-of-trend alerts

### Additional Instrument Types

- **INST-01**: LCMS automation (mass spec result ingest and processing)
- **INST-02**: GCMS automation
- **INST-03**: Heavy metals testing (ICP-MS/ICP-OES)

## Out of Scope

| Feature | Reason |
|---------|--------|
| LAL file parser (EndoScan-V/MARS CSV) | Deferred to v0.31.0 — need actual export files from lab to implement correctly |
| Analytics/reporting UI | Deferred to next milestone — schema designed for it, UI built later |
| Instrument-specific UI pages per type | Anti-pattern — use shared InstrumentResultDetail component with type-based sections |
| Frontend scientific calculations | Backend owns all calculations — no regression in JS/TS |
| LAL approval override for invalid runs | PPC and r-value gates are pharmacopeial requirements (USP <85>), not soft warnings |
| Sterility observation reminders/notifications | No notification infrastructure — operators check the app daily |
| Raw plate reader kinetic data storage | Megabytes per plate, no query value — store derived onset times only |
| Automatic LAL file discovery (folder watch) | LAL plate reader requires manual export — use file upload/browse UI instead |
| LCMS, GCMS, heavy metals automation | Deferred to future milestones — architecture will support them |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FNDN-01 | Phase 19 | Pending |
| FNDN-02 | Phase 19 | Pending |
| FNDN-03 | Phase 19 | Pending |
| FNDN-04 | Phase 19 | Pending |
| SCHM-01 | Phase 20 | Pending |
| SCHM-02 | Phase 20 | Pending |
| SCHM-03 | Phase 20 | Pending |
| SCHM-04 | Phase 20 | Pending |
| SCHM-05 | Phase 20 | Pending |
| SCHM-06 | Phase 20 | Pending |
| PLUG-01 | Phase 21 | Pending |
| PLUG-02 | Phase 21 | Pending |
| PLUG-03 | Phase 21 | Pending |
| PLUG-04 | Phase 21 | Pending |
| ENDO-01 | Phase 22 | Pending |
| ENDO-02 | Phase 22 | Pending |
| ENDO-03 | Phase 22 | Pending |
| ENDO-04 | Phase 22 | Pending |
| ENDO-05 | Phase 22 | Pending |
| ENDO-06 | Phase 22 | Pending |
| ENDO-07 | Phase 22 | Pending |
| ENDO-08 | Phase 22 | Pending |
| STER-01 | Phase 23 | Pending |
| STER-02 | Phase 23 | Pending |
| STER-03 | Phase 23 | Pending |
| STER-04 | Phase 23 | Pending |
| STER-05 | Phase 23 | Pending |
| STER-06 | Phase 23 | Pending |
| STER-07 | Phase 23 | Pending |
| STER-08 | Phase 23 | Pending |

**Coverage:**
- v0.30.0 requirements: 30 total
- Mapped to phases: 30
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-06*
*Last updated: 2026-04-06 after initial definition*
