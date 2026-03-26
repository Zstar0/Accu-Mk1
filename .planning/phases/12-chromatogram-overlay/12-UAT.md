---
status: testing
phase: v0.26.0-milestone
source: 10.5-01-SUMMARY.md, 10.5-02-SUMMARY.md, 11-01-SUMMARY.md, 11-02-SUMMARY.md, 12-01-SUMMARY.md, 12-02-SUMMARY.md
started: 2026-03-18T22:00:00Z
updated: 2026-03-18T22:00:00Z
---

## Current Test

number: 1
name: Calibration curve edit — Source Sample ID and Vendor fields
expected: |
  Open a peptide's details, expand a calibration curve, click Edit.
  You should see Source Sample ID and Vendor text inputs in a 2-column row between Instrument/Analyte and Notes.
  Enter a Source Sample ID (e.g., P-0309) and Vendor (e.g., Cayman), click Save.
  After save, view mode should show the Vendor below the stats grid.
awaiting: user response

## Tests

### 1. Calibration curve edit — Source Sample ID and Vendor fields
expected: Open a calibration curve edit form. Source Sample ID and Vendor fields visible. Save persists both values. View mode shows Vendor.
result: [pending]

### 2. Chromatogram auto-fetch on Source Sample ID save
expected: After saving a Source Sample ID on a curve, the backend auto-fetches DAD1A chromatogram files from SharePoint (LIMS CSV folder). Expand the curve — a "Standard Chromatogram" section should appear with concentration tabs (1, 10, 100, 250, 500, 1000 µg/mL) and an "All" overlay option.
result: [pending]

### 3. Standard chromatogram concentration tabs
expected: In the Standard Chromatogram viewer on a curve, clicking individual concentration tabs shows that single trace. Clicking "All" overlays all concentration traces on one chart. The reference RT vertical line is visible.
result: [pending]

### 4. Process HPLC — chromatogram overlay (standard behind sample)
expected: Open Process HPLC for a sample prep whose active calibration curve has chromatogram_data (e.g., a Humanin sample). The chromatogram chart shows TWO traces: a dashed, semi-transparent standard reference trace (labeled like "Std 1000 µg/mL") and the solid sample trace on top. Peaks at the same retention time should visually align.
result: [pending]

### 5. Process HPLC — no chromatogram data graceful fallback
expected: Open Process HPLC for a sample prep whose active calibration curve does NOT have chromatogram_data. Only the sample trace renders — no errors, no empty dashed line.
result: [pending]

### 6. HPLC results persistence — provenance fields saved
expected: After running Process HPLC on a sample, check that the hplc_analyses DB row has: calibration_curve_id, sample_prep_id, run_group_id, and chromatogram_data populated (not null). The run_group_id should be a UUID string.
result: [pending]

### 7. HPLC results reload from DB
expected: After running Process HPLC on a sample and closing the flyout, reopen Process HPLC for the same sample. It should load saved results from the DB instantly (no SharePoint scan), showing a "Previous results loaded" banner with a Re-run button.
result: [pending]

### 8. Sample prep status — hplc_complete
expected: After successfully running Process HPLC, the sample prep's status automatically updates to "hplc_complete" (teal badge) in the Sample Preps list. The status dropdown includes the hplc_complete option.
result: [pending]

### 9. Blend HPLC — per-analyte chromatogram overlay updates on tab switch
expected: Open Process HPLC for a BLEND sample prep (e.g., PB-0065). Switch between analyte tabs. If each component's calibration curve has chromatogram_data, the dashed standard reference trace should change when switching tabs (different standard for each component).
result: [pending]

## Summary

total: 9
passed: 0
issues: 0
pending: 9
skipped: 0

## Gaps

[none yet]
