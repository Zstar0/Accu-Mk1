# Task: HPLC Audit Trail & Debug Persistence

## Overview

Capture the full processing context for every HPLC analysis run so results are reproducible and debuggable without re-scanning SharePoint.

## Scope

### 1. Persist debug log to DB

- Add `debug_log` JSON field to `hplc_analyses` (array of `{level, msg}` objects)
- After `runAllAnalyses` completes, serialize `buildDebugLines()` output and store on each analysis row
- On DB reload, render the debug panel from saved data instead of showing empty
- Includes: label matching results, standard injection detection, vial weight routing, chromatogram trace filtering, identity reference source selection, any warnings/errors

### 2. Archive source files in `raw_data`

Expand the existing `raw_data` JSON field from `{"injections": [...]}` to include:

```json
{
  "injections": [...],
  "files": {
    "PB-0065_Inj_1_BPC157_PeakData.csv": "<raw csv content>",
    "PB-0065_Inj_1_std_BPC157_PeakData.csv": "<raw csv content>",
    "PB-0065_Inj_1_BPC_TB17-23.dx_DAD1A.CSV": "<raw csv content>"
  },
  "file_manifest": [
    {"name": "...", "size": 1234, "sha256": "abc123..."}
  ]
}
```

- Peak data CSVs (~2-5KB each) — already downloaded during processing
- Standard injection CSVs (~2-5KB each) — already downloaded during parsing
- Chromatogram DAD1A CSVs (~500KB each, or store downsampled) — already downloaded
- File manifest with names, sizes, SHA256 checksums for audit proof

### 3. Surface warnings in debug panel

The debug panel should show warnings for:
- Missing standard injection for an analyte (fallback to calibration curve)
- Missing chromatogram trace for an analyte
- Label-to-component matching failures
- Vial weight data missing (using top-level weights as fallback)
- SharePoint download failures
- Any silent fallbacks that currently happen without notification

## Technical Notes

- `raw_data` is already a JSON column on `hplc_analyses` — no migration needed, just expand the content
- `debug_log` needs a new JSON column (migration in `database.py`)
- The flyout already downloads all files during `loadPeakData` — pass the raw content through to the analyze request
- File sizes: 3 analytes × (peak CSV + std CSV + chrom CSV) ≈ 1.5MB total per run — acceptable for JSONB
- Consider storing chromatograms downsampled (5K points instead of 30K) to reduce size

## Priority

Medium — not blocking testing, but needed for production audit compliance and debugging filed issues.
