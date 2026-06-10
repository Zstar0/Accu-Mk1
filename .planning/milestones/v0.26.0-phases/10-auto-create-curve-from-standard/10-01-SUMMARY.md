# Phase 10 Plan 01: Backend Endpoint + Frontend API Summary

**One-liner:** POST endpoint for auto-creating CalibrationCurve from standard HPLC data with mk1_db validation and full provenance fields

## Metadata

- **Phase:** 10-auto-create-curve-from-standard
- **Plan:** 01
- **Duration:** ~4 min
- **Completed:** 2026-03-17

## Task Commits

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Backend endpoint POST /peptides/{id}/calibrations/from-standard | b194136 | backend/main.py |
| 2 | Frontend API function createCalibrationFromStandard | caf3487 | src/lib/api.ts |

## What Was Built

### Backend (Task 1)
- `StandardCalibrationInput` Pydantic model with sample_prep_id, concentrations, areas, rts, chromatogram_data, source_sharepoint_folder, vendor, notes, instrument
- `POST /peptides/{peptide_id}/calibrations/from-standard` endpoint that:
  - Validates peptide exists (404)
  - Validates sample_prep_id exists in mk1_db PostgreSQL and is_standard=True (400)
  - Computes linear regression via `calculate_calibration_curve()`
  - Deactivates existing active curves for the peptide
  - Creates CalibrationCurve with full provenance: source_sample_id, chromatogram_data, source_sharepoint_folder, vendor, instrument, notes
  - Returns via `_cal_to_response()` for SharePoint URL resolution

### Frontend (Task 2)
- `StandardCalibrationInput` TypeScript interface matching backend model
- `createCalibrationFromStandard()` async function following existing `createCalibration` pattern

## Decisions Made

- Used inline `from mk1_db import` pattern consistent with all other sample_prep endpoints
- Query sample_preps by `sample_id` string (not integer id) since the HPLC flyout works with prep identifiers like "P-0136"
- Used `_cal_to_response()` wrapper (existing `create_calibration` returns raw curve - this is more correct since it resolves SharePoint URLs)

## Deviations from Plan

None - plan executed exactly as written.

## Key Files

- `backend/main.py` - StandardCalibrationInput model (~line 1607), create_calibration_from_standard endpoint (~line 2435)
- `src/lib/api.ts` - StandardCalibrationInput interface (~line 2021), createCalibrationFromStandard function (~line 2033)

## Self-Check: PASSED
