# Requirements: Accu-Mk1 v0.26.0

**Defined:** 2026-03-16
**Core Value:** Streamlined morning workflow: import CSV, review batch, calculate purity, push to SENAITE. One operator, one workstation, no friction.

## v0.26.0 Requirements

Requirements for Standard Sample Preps & Calibration Curve Chromatograms milestone.

### Standard Sample Prep

- [ ] **STDP-01**: User can mark a sample prep as "Standard" during New Analysis wizard Step 1
- [ ] **STDP-02**: When marked as Standard, user can enter manufacturer name (e.g., "Cayman", "NxGen")
- [ ] **STDP-03**: When marked as Standard, user can enter free-text notes for the standard
- [ ] **STDP-04**: Standard preps flow through the same wizard steps as production preps (stock prep, dilution, measurements)
- [ ] **STDP-05**: Sample Preps list shows a "Standard" badge on standard preps and supports filtering by standard vs production

### Calibration Curve Schema

- [ ] **CURV-01**: CalibrationCurve model includes source_sample_id field (links to the standard SamplePrep that built it)
- [ ] **CURV-02**: CalibrationCurve model includes chromatogram_data field (JSON: times[] + signals[] from DAD1A CSV)
- [ ] **CURV-03**: CalibrationCurve model includes source_sharepoint_folder field (path to .rslt data)
- [ ] **CURV-04**: CalibrationCurve model includes manufacturer field (vendor who supplied the standard)
- [ ] **CURV-05**: CalibrationCurve model includes notes field (free-text per curve)

### Auto-Create Curve from Standard

- [ ] **AUTO-01**: When Process HPLC completes on a standard sample prep, system auto-creates a new CalibrationCurve for the matching peptide
- [ ] **AUTO-02**: Auto-created curve is populated with slope, intercept, r_squared from the standard's analysis results
- [ ] **AUTO-03**: Auto-created curve stores reference_rt from the standard's main peak retention time
- [ ] **AUTO-04**: Auto-created curve stores chromatogram_data from the DAD1A CSV trace
- [ ] **AUTO-05**: Auto-created curve links source_sample_id and source_sharepoint_folder from the standard prep
- [ ] **AUTO-06**: Auto-created curve carries manufacturer and notes from the standard sample prep metadata

### HPLC Results Persistence

- [ ] **HRES-01**: hplc_analyses stores calibration_curve_id (FK) identifying which curve was used for the analysis
- [ ] **HRES-02**: hplc_analyses stores sample_prep_id linking back to the sample_preps record in accumark_mk1
- [ ] **HRES-03**: hplc_analyses stores instrument_id (FK) and source_sharepoint_folder for full provenance
- [ ] **HRES-04**: hplc_analyses stores chromatogram trace data (times[] + signals[] JSON) so charts render without re-scanning SharePoint
- [ ] **HRES-05**: Blend runs use a run_group_id to link all per-analyte analysis rows from a single Process HPLC session
- [ ] **HRES-06**: Reopening Process HPLC for a sample prep with saved results loads them from DB (no SharePoint re-scan), with option to re-run
- [ ] **HRES-07**: Sample prep status updates to hplc_complete when results are persisted, and results are accessible from the sample preps list

### Backfill Existing Curves

- [ ] **BKFL-01**: User can edit an existing calibration curve to add/change source_sample_id (Sample ID link)
- [ ] **BKFL-02**: When a source_sample_id is set and saved, system locates the corresponding chromatogram data in SharePoint and stores it
- [ ] **BKFL-03**: User can edit manufacturer and notes on existing calibration curves

### Chromatogram Overlay

- [ ] **CHRO-01**: During Process HPLC, the flyout loads the active calibration curve's chromatogram_data (if available)
- [ ] **CHRO-02**: Standard chromatogram trace rendered as a background/reference trace (lighter/dashed style)
- [ ] **CHRO-03**: Sample chromatogram trace rendered as the primary trace (solid style) overlaid on the standard
- [ ] **CHRO-04**: Both traces share a synchronized time axis for direct visual comparison

### Same-Method Identity Check

- [ ] **METH-01**: HPLC file parser detects `_std_` peak data files in .rslt folders and parses them as standard reference injections
- [ ] **METH-02**: Each standard injection's main peak RT is extracted and matched to the corresponding analyte
- [ ] **METH-03**: Identity check uses standard injection RT (same method) when available, falls back to calibration curve reference_rt when not
- [ ] **METH-04**: Identity section displays which reference source was used (standard injection vs calibration curve) and the source sample ID

### HPLC Audit Trail & Debug Persistence

- [ ] **AUDT-01**: hplc_analyses stores debug_log (JSON array of {level, msg}) capturing the full processing context — renderable on DB reload
- [ ] **AUDT-02**: hplc_analyses raw_data includes source file contents (peak data CSVs, standard injection CSVs, chromatogram CSVs) and SHA256 checksums for audit proof
- [ ] **AUDT-03**: Debug panel shows visible warnings for missing standard injections, missing chromatograms, label matching failures, missing vial data, and SharePoint errors

### RT Check Chromatogram Comparison

- [ ] **RTCK-01**: Identity section shows side-by-side chromatogram comparison — standard trace with peak RT annotation next to sample trace with peak RT annotation
- [ ] **RTCK-02**: Standard injection DAD1A chromatograms (`_std_*.dx_DAD1A.CSV`) are loaded and displayed alongside sample chromatograms
- [ ] **RTCK-03**: Comparison view shows RT delta between standard and sample main peaks for tech confirmation

## Future Requirements

Deferred to later milestones.

### Identity Enhancements

- **IDEN-01**: Relative Retention Time (RRT) calculation for method-independent identity checks
- **IDEN-02**: Method-locked calibration curve matching (enforce same HPLC method between standard and sample)
- **IDEN-03**: UV spectral matching from DAD data for compound confirmation

## Out of Scope

| Feature | Reason |
|---------|--------|
| Blend-specific calibration standards | Standards are single-peptide only; blends use per-component curves |
| RRT calculation | Future enhancement; manual visual comparison sufficient for now |
| Method field on calibration curves | Useful but not blocking; defer to identity enhancements milestone |
| Auto-publish curves | Newly created curves should require manual activation |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| STDP-01 | Phase 09 | Complete |
| STDP-02 | Phase 09 | Complete |
| STDP-03 | Phase 09 | Complete |
| STDP-04 | Phase 09 | Complete |
| STDP-05 | Phase 09 | Complete |
| CURV-01 | Phase 09 | Complete |
| CURV-02 | Phase 09 | Complete |
| CURV-03 | Phase 09 | Complete |
| CURV-04 | Phase 09 | Complete |
| CURV-05 | Phase 09 | Complete |
| AUTO-01 | Phase 10 | Pending |
| AUTO-02 | Phase 10 | Pending |
| AUTO-03 | Phase 10 | Pending |
| AUTO-04 | Phase 10 | Pending |
| AUTO-05 | Phase 10 | Pending |
| AUTO-06 | Phase 10 | Pending |
| HRES-01 | Phase 10.5 | Complete |
| HRES-02 | Phase 10.5 | Complete |
| HRES-03 | Phase 10.5 | Complete |
| HRES-04 | Phase 10.5 | Complete |
| HRES-05 | Phase 10.5 | Complete |
| HRES-06 | Phase 10.5 | Complete |
| HRES-07 | Phase 10.5 | Complete |
| BKFL-01 | Phase 11 | Complete |
| BKFL-02 | Phase 11 | Complete |
| BKFL-03 | Phase 11 | Complete |
| CHRO-01 | Phase 12 | Complete |
| CHRO-02 | Phase 12 | Complete |
| CHRO-03 | Phase 12 | Complete |
| CHRO-04 | Phase 12 | Complete |
| METH-01 | Phase 13 | Complete |
| METH-02 | Phase 13 | Complete |
| METH-03 | Phase 13 | Complete |
| METH-04 | Phase 13 | Complete |
| AUDT-01 | Phase 13.5 | Complete |
| AUDT-02 | Phase 13.5 | Complete |
| AUDT-03 | Phase 13.5 | Complete |
| RTCK-01 | Phase 14 | Pending |
| RTCK-02 | Phase 14 | Pending |
| RTCK-03 | Phase 14 | Pending |

**Coverage:**
- v0.26.0 requirements: 37 total
- Mapped to phases: 37
- Unmapped: 0

---
*Requirements defined: 2026-03-16*
*Last updated: 2026-03-16 after roadmap creation*
