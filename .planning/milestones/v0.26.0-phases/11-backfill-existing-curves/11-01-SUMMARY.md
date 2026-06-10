---
phase: 11-backfill-existing-curves
plan: 01
subsystem: api
tags: [fastapi, pydantic, sharepoint, hplc, calibration, typescript]

# Dependency graph
requires:
  - phase: 10.5-hplc-results-persistence
    provides: CalibrationCurve model with source_sample_id, vendor, chromatogram_data, source_sharepoint_folder columns
  - phase: 10-calibration-curves
    provides: update_calibration PATCH endpoint and CalibrationCurveUpdateInput interface
provides:
  - PATCH /peptides/{id}/calibrations/{cal_id} accepts source_sample_id, vendor, notes for backfill
  - Auto-fetches DAD1A chromatogram from SharePoint when source_sample_id is set/changed
  - Stores chromatogram_data and source_sharepoint_folder on the curve
  - CalibrationCurveUpdateInput TypeScript interface includes source_sample_id and vendor
affects:
  - 11-backfill-existing-curves (plan 02+, CalibrationPanel edit form uses this interface)
  - Any frontend that edits calibration curves via PATCH

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Best-effort async side-effect: try/except around SharePoint fetch inside PATCH; log warning on failure, never block the primary update"
    - "Source-change guard: only fetch chromatogram when new_sample_id != target.source_sample_id to avoid re-fetching unchanged data"
    - "Local sharepoint import inside endpoint function body (consistent with other endpoints in main.py)"

key-files:
  created: []
  modified:
    - backend/main.py
    - src/lib/api.ts

key-decisions:
  - "Chromatogram auto-fetch is best-effort — SharePoint failures log a warning and do not fail the PATCH"
  - "Only fetch when source_sample_id actually changes (skip no-op updates)"
  - "Local import sharepoint as sp inside function body — consistent with existing patterns in main.py"
  - "CSV parsing inline: same time,absorbance format as frontend parseChromatogramCsv, skip header-less lines gracefully"

patterns-established:
  - "Best-effort async side-effect pattern for SharePoint calls within PATCH endpoints"

# Metrics
duration: 2min
completed: 2026-03-18
---

# Phase 11 Plan 01: Backfill Existing Curves Summary

**PATCH calibration endpoint extended to accept source_sample_id/vendor and auto-fetch DAD1A chromatogram from SharePoint when sample ID is set or changed**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-18T23:01:05Z
- **Completed:** 2026-03-18T23:03:13Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

- Extended `CalibrationCurveUpdate` Pydantic schema with `source_sample_id: Optional[str]` and `vendor: Optional[str]` for partial PATCH semantics
- Added auto-fetch logic in `update_calibration`: when `source_sample_id` is set/changed, calls `sp.get_sample_files()` to locate DAD1A CSVs, downloads the first one, parses `time,absorbance` lines, and stores `chromatogram_data` + `source_sharepoint_folder`
- Extended `CalibrationCurveUpdateInput` TypeScript interface with matching `source_sample_id?: string | null` and `vendor?: string | null` fields

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend CalibrationCurveUpdate Pydantic schema** - `a33c83c` (feat)
2. **Task 2: Add chromatogram auto-fetch to PATCH endpoint** - `ac1bfd5` (feat)
3. **Task 3: Extend CalibrationCurveUpdateInput TypeScript interface** - `584b9b1` (feat)

## Files Created/Modified

- `backend/main.py` - CalibrationCurveUpdate schema extended; update_calibration endpoint has best-effort SharePoint auto-fetch block
- `src/lib/api.ts` - CalibrationCurveUpdateInput interface extended with source_sample_id and vendor

## Decisions Made

- Chromatogram fetch is best-effort: `try/except` wraps the entire SharePoint block; on any exception, a warning is logged and the PATCH succeeds with only the non-chromatogram fields updated
- Only fetch when `source_sample_id` is actually changing (`new_sample_id != target.source_sample_id`) — avoids redundant SharePoint calls on repeated PATCHes
- Used local `import sharepoint as sp` inside the endpoint function body to be consistent with the pattern used in other endpoints throughout main.py
- CSV parsed inline using the same `time,absorbance` format as frontend `parseChromatogramCsv`; non-parseable lines are silently skipped

## Deviations from Plan

None - plan executed exactly as written. `sp.get_sample_files()` exists in sharepoint.py exactly as the plan referenced it.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- PATCH endpoint is ready to receive `source_sample_id` from the CalibrationPanel edit form
- Frontend `updateCalibration()` function in api.ts accepts `source_sample_id` and `vendor` — CalibrationPanel can now pass these fields
- SharePoint chromatogram backfill is fully wired; plan 02 can build the edit UI on this foundation

---
*Phase: 11-backfill-existing-curves*
*Completed: 2026-03-18*

## Self-Check: PASSED
