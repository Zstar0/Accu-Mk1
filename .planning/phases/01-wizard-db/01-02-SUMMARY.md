---
phase: 01-wizard-db
plan: 02
subsystem: testing
tags: [python, decimal, pytest, calculations, wizard, tdd, purity, hplc]

# Dependency graph
requires:
  - phase: none
    provides: standalone pure functions, no dependency on plan 01-01 models
provides:
  - Four pure Decimal calculation functions covering all wizard stages
  - Pytest test suite with 23 tests verified against lab Excel reference values
  - TDD baseline: RED commit then GREEN commit pattern
affects: [02-scale-bridge, 03-wizard-ui, 04-hplc-import, 05-senaite]

# Tech tracking
tech-stack:
  added: [pytest (installed in .venv)]
  patterns: [Pure function Decimal arithmetic, TDD RED-GREEN cycle, lab-verified test values]

key-files:
  created:
    - backend/calculations/wizard.py
    - backend/tests/test_wizard_calculations.py
    - backend/tests/__init__.py
  modified: []

key-decisions:
  - "calc_results signature is (calibration_slope, calibration_intercept, peak_area, actual_conc_ug_ml, actual_total_vol_ul, actual_stock_vol_ul) — slope first, then intercept, then peak_area"
  - "actual_stock_vol_ul passed explicitly to calc_results to compute dilution_factor — not recomputed from diluent/total difference"
  - "28-digit Decimal precision via getcontext().prec = 28 set at module import — shared across all functions"
  - "Tests use round(float(value), N) for tolerance comparisons rather than exact Decimal equality where trailing precision differs"
  - "main.py NOT modified in this plan — integration fix deferred to orchestrator after both 01-01 and 01-02 complete"

patterns-established:
  - "Decimal module boundary: all wizard.py inputs and outputs are Decimal; callers use Decimal(str(float_val)) on input and float(decimal_val) on output"
  - "Pure function pattern: no imports from models.py, database.py, auth.py, or main.py inside wizard.py"
  - "Lab-verified fixture constants: DECLARED_WEIGHT_MG, STOCK_VIAL_EMPTY, STOCK_VIAL_LOADED, DILUENT_DENSITY as module-level Decimal constants in test file"
  - "TDD test class naming: TestCalcStockPrep, TestCalcRequiredVolumes, TestCalcActualDilution, TestCalcResults"

# Metrics
duration: 2min
completed: 2026-02-20
---

# Phase 1 Plan 02: Wizard Calculation Engine Summary

**Four pure Decimal functions (calc_stock_prep, calc_required_volumes, calc_actual_dilution, calc_results) with 23 pytest tests verified against lab Excel reference values (stock_conc=16595.82 ug/mL, required_stock=72.31 uL)**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-20T02:41:03Z
- **Completed:** 2026-02-20T02:43:17Z
- **Tasks:** 2 (RED + GREEN)
- **Files modified:** 3 created, 0 modified

## Accomplishments

- TDD RED phase: 23 tests written, confirmed ImportError on missing module
- TDD GREEN phase: wizard.py implemented with correct Decimal arithmetic, all 23 tests pass
- Lab-verified formula accuracy: stock_conc rounds to exactly 16595.82 ug/mL, required_stock_vol rounds to exactly 72.31 uL
- All returned values confirmed Decimal instances — no float leakage through module boundary

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — Write failing tests** - `7e6dc0b` (test)
2. **Task 2: GREEN — Implement wizard.py** - `b6cb072` (feat)

_Note: TDD plan — two commits per cycle (test -> feat)_

## Files Created/Modified

- `backend/calculations/wizard.py` - Four pure Decimal calculation functions for all wizard stages
- `backend/tests/test_wizard_calculations.py` - 23 pytest tests verified against lab Excel values
- `backend/tests/__init__.py` - Package init for test discovery

## Decisions Made

- `calc_results` signature is `(calibration_slope, calibration_intercept, peak_area, actual_conc_ug_ml, actual_total_vol_ul, actual_stock_vol_ul)` — slope first, matching test call order
- `actual_stock_vol_ul` passed explicitly as parameter to `calc_results` to compute `dilution_factor = total / stock`, not derived from `total - diluent` (which would lose precision)
- `main.py` integration fix (call order in `_build_session_response`) deferred to orchestrator — this plan focuses only on pure calculation functions and their tests
- pytest installed to backend/.venv (was not present); added silently as deviation Rule 3 (blocking) since tests couldn't run otherwise

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed pytest into backend/.venv**

- **Found during:** Task 1 (RED phase test run)
- **Issue:** `python -m pytest` failed with "No module named pytest" — pytest was not installed in the venv
- **Fix:** Ran `pip install pytest -q` inside activated .venv
- **Files modified:** backend/.venv (venv packages only, not tracked in git)
- **Verification:** `python -m pytest tests/test_wizard_calculations.py -v` ran and showed expected ImportError (RED confirmed)
- **Committed in:** Not committed (venv not tracked); install is implicit from requirements if pytest is added later

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to confirm RED state. No scope creep.

## Issues Encountered

None — plan executed cleanly after pytest installation. Both RED state (ImportError) and GREEN state (23/23 pass) confirmed as expected.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `backend/calculations/wizard.py` is ready for import by `main.py` once Plan 01-01's `_build_session_response` is updated to use correct `calc_results` argument order
- Orchestrator should fix `_build_session_response` in `main.py` to call: `calc_results(cal.slope, cal.intercept, session.peak_area, actual_conc_d, actual_total_d, actual_stock_d)`
- Phase 2 (Scale Bridge) can safely import from `calculations.wizard` — no circular dependencies, no DB/FastAPI imports inside wizard.py

---
*Phase: 01-wizard-db*
*Completed: 2026-02-20*

## Self-Check: PASSED
