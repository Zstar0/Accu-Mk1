---
phase: 02-data-pipeline
plan: 05
subsystem: calculations
tags: [python, purity, calibration, formula, linear-equation]

# Dependency graph
requires:
  - phase: 02-04
    provides: Calculation engine, formula registry, accumulation formula
provides:
  - PurityFormula class for purity percentage calculation
  - Linear equation calibration (purity = (area - intercept) / slope)
  - Calibration settings defaults seeded on startup
affects: [03-review-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Linear calibration equation for purity calculation

key-files:
  created: []
  modified:
    - backend/calculations/formulas.py
    - backend/calculations/engine.py
    - backend/main.py

key-decisions:
  - "Purity formula uses linear equation: (area - intercept) / slope"
  - "Calibration settings seeded with placeholder defaults (1.0, 0.0)"
  - "Warnings for out-of-range purity values (< 0 or > 100%)"

patterns-established:
  - "Calibration-based purity calculation pattern"

# Metrics
duration: ~3 min
completed: 2026-01-16
---

# Phase 2 Plan 5: Purity Calculation Summary

**Linear equation purity formula with calibration slope/intercept settings for serial dilution method**

## Performance

- **Duration:** ~3 min
- **Completed:** 2026-01-16
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- PurityFormula class implementing linear calibration equation
- Validates calibration_slope is non-zero and calibration_intercept exists
- Calculates from total_area directly or sums peak_area from rows
- Warns if calculated purity falls outside 0-100% range
- Registered in FORMULA_REGISTRY as "purity" type
- Runs automatically in calculate_all when calibration settings exist
- Default calibration settings seeded on startup (placeholder values)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add PurityFormula class** - `599f211` (feat)
2. **Task 2: Register PurityFormula in engine** - `b6cc21a` (feat)
3. **Task 3: Add calibration settings defaults** - Included in parallel plan execution

## Files Modified

- `backend/calculations/formulas.py` - Added PurityFormula class with validate() and execute() methods
- `backend/calculations/engine.py` - Imported PurityFormula, added to registry, added to calculate_all
- `backend/main.py` - Added calibration_slope and calibration_intercept to DEFAULT_SETTINGS

## Decisions Made

- **Linear equation:** Uses standard calibration curve formula: purity_% = (area - intercept) / slope
- **Placeholder defaults:** Slope=1.0 and intercept=0.0 as safe placeholders (user must configure real values)
- **Range warnings:** Values outside 0-100% generate warnings but calculation still returns result
- **Flexible input:** Accepts total_area directly or calculates from rows for pipeline flexibility

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Task 3 (calibration settings) was committed as part of parallel plan execution. The changes were made correctly but committed in a different plan's commit sequence.

## User Setup Required

- User must configure actual calibration_slope and calibration_intercept values via settings UI
- Default placeholders (1.0, 0.0) will produce incorrect purity calculations

## Next Phase Readiness

- Purity calculation ready for use in batch review UI
- calculateSample() will include purity result when calibration settings are configured
- Settings UI should expose calibration_slope and calibration_intercept fields

---
*Phase: 02-data-pipeline*
*Completed: 2026-01-16*
