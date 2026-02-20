---
phase: 01-wizard-db
plan: 01
subsystem: database
tags: [sqlalchemy, fastapi, pydantic, sqlite, jwt, wizard, measurements]

# Dependency graph
requires: []
provides:
  - WizardSession SQLAlchemy 2.0 model (wizard_sessions table)
  - WizardMeasurement SQLAlchemy 2.0 model (wizard_measurements table)
  - 6 JWT-authenticated REST endpoints for wizard session lifecycle
  - Pydantic schemas for all wizard request/response shapes
  - _build_session_response() helper with staged calculation integration (try/except)
affects:
  - 01-02 (calculations/wizard.py must implement calc_stock_prep, calc_required_volumes, calc_actual_dilution, calc_results)
  - 02-scale-bridge (Phase 2 adds source='scale' measurements via same endpoints)
  - 03-frontend-wizard (React wizard UI consumes these endpoints)
  - 04-senaite (SENAITE integration populates sample_id_label and declared_weight_mg)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Staged calculation pattern (try/except per stage so partial sessions return partial calcs)
    - Re-weigh audit trail (insert new + set old is_current=False, never delete)
    - Auto-resolve active calibration curve on session create

key-files:
  created: []
  modified:
    - backend/models.py
    - backend/main.py

key-decisions:
  - "Auto-resolve active calibration curve on POST /wizard/sessions — return 400 if none active for that peptide"
  - "_build_session_response() imports calculations.wizard functions with try/except so endpoints work before Plan 01-02 is complete"
  - "VALID_STEP_KEYS enforced at endpoint level — reject unknown step_key with 422"
  - "declared_weight_mg stored on WizardSession (not as WizardMeasurement) because it is a manually entered value, not a balance reading"
  - "msal installed as deviation fix (was missing from venv but needed by main.py sharepoint import)"

patterns-established:
  - "Re-weigh pattern: POST measurements sets old is_current=False then inserts new record — audit trail preserved"
  - "Staged calc pattern: each calculation stage in try/except, returning partial results for partial sessions"
  - "Float conversion boundary: Decimal arithmetic in calculations/, converted to float() at response boundary in _build_session_response()"

# Metrics
duration: 3min
completed: 2026-02-20
---

# Phase 1 Plan 1: WizardSession DB Models and REST Endpoints Summary

**WizardSession + WizardMeasurement SQLAlchemy models, wizard_sessions/wizard_measurements tables auto-created via init_db(), and 6 JWT-authenticated REST endpoints for the full wizard session lifecycle**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-20T02:40:31Z
- **Completed:** 2026-02-20T02:43:29Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

- WizardSession model with all required fields (peptide_id, calibration_curve_id, status, sample_id_label, declared_weight_mg, target params, peak_area, timestamps, relationships)
- WizardMeasurement model with step_key, weight_mg, source, is_current, recorded_at and session relationship
- Both wizard tables created automatically by existing init_db() via Base.metadata.create_all()
- 6 REST endpoints covering full wizard lifecycle: create, list, get, update, record measurement, complete
- _build_session_response() with staged calculation integration (plans 01-02 functions called with try/except for partial session tolerance)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add WizardSession and WizardMeasurement models** - `49e7d0a` (feat)
2. **Task 2: Verify wizard tables created by init_db** - `457a2c5` (feat)
3. **Task 3: Add wizard session REST endpoints** - `d8f96ff` (feat)
4. **Bug fix: calc_results argument order** - `b1d441c` (fix)

**Plan metadata:** `(pending)` (docs: complete plan)

## Files Created/Modified

- `backend/models.py` - Added WizardSession and WizardMeasurement classes at end of file using mapped_column style
- `backend/main.py` - Added WizardSession/WizardMeasurement to import, appended all Pydantic schemas, _build_session_response helper, and 6 endpoint functions

## Decisions Made

- Auto-resolve active calibration curve on session create: query CalibrationCurve where is_active=True and peptide_id matches, order by created_at desc, return 400 if none found
- _build_session_response() uses try/except per calculation stage so endpoints respond correctly even before calculations/wizard.py exists (Plan 01-02 runs in parallel)
- VALID_STEP_KEYS set enforced at endpoint boundary — returns 422 for unrecognized step keys
- declared_weight_mg stored on WizardSession (not as WizardMeasurement) since it is a manually typed value, not a balance reading

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed missing msal package**

- **Found during:** Task 3 (verifying main.py imports)
- **Issue:** main.py imports sharepoint.py which imports msal — package was missing from .venv causing ModuleNotFoundError
- **Fix:** Ran `pip install msal` to install the missing dependency
- **Files modified:** None (venv package install only)
- **Verification:** `python -c "import main; print('OK')"` passed after install
- **Committed in:** Not committed (environment fix only)

---

**2. [Rule 1 - Bug] Fixed calc_results argument order mismatch**

- **Found during:** Post-task review (cross-checking with Plan 01-02 calc_results signature)
- **Issue:** _build_session_response called calc_results(peak_area, slope, intercept, ...) but function signature is (slope, intercept, peak_area, actual_conc, actual_total, actual_stock) — also missing 6th arg actual_stock_vol_ul
- **Fix:** Reordered arguments to match actual signature; captured actual_stock_d from Stage 3 result; added actual_stock_d as 6th arg; updated Stage 4 guard to require actual_stock_d
- **Files modified:** backend/main.py
- **Verification:** main.py imports cleanly; argument order matches calculations/wizard.py calc_results signature
- **Committed in:** b1d441c (fix commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** msal was a pre-existing venv gap; calc_results arg order was a correctness bug that would silently produce wrong results at runtime. Both fixes necessary.

## Issues Encountered

- msal missing from backend venv caused main.py import to fail during verification — installed via pip, unblocked immediately
- calc_results arg order in _build_session_response was wrong — detected via cross-check with Plan 01-02's function signature, fixed immediately

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 01-02 (calculations/wizard.py) can now be executed: _build_session_response() already calls calc_stock_prep, calc_required_volumes, calc_actual_dilution, calc_results with try/except — endpoints will immediately begin returning calculations once wizard.py exists
- Phase 2 (Scale Bridge) can add 'scale' source measurements via the existing POST /wizard/sessions/{id}/measurements endpoint — no endpoint changes needed
- Phase 3 (Frontend Wizard) has full API surface available: all 6 endpoints are live and authenticated

---
*Phase: 01-wizard-db*
*Completed: 2026-02-20*

## Self-Check: PASSED
