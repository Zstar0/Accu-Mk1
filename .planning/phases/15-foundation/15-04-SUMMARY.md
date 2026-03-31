---
phase: 15-foundation
plan: "04"
subsystem: api
tags: [senaite, analyst, diagnostic, httpx, fastapi]

# Dependency graph
requires:
  - phase: 15-foundation-01
    provides: SENAITE analyst endpoints (get_senaite_analysts, set_analysis_analyst, _get_senaite_auth pattern)
provides:
  - Diagnostic endpoint POST /senaite/analyses/{uid}/analyst-test
  - AnalystTestRequest schema (username + uid fields)
  - Live-testable format verification for SENAITE Analyst field (username vs UID)
affects: [16-bulk-analyst-assignment, phase-16, analyst-assignment]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Diagnostic test-and-restore pattern: read original → test format A → test format B → restore → return structured report"

key-files:
  created: []
  modified:
    - backend/main.py

key-decisions:
  - "SENAITE Analyst field format (username vs UID) requires live verification — endpoint created, human verification pending"
  - "Restore original Analyst value after testing (best-effort, non-fatal if restore fails)"
  - "recommendation logic: exact match to sent value takes precedence over non-null stored value"

patterns-established:
  - "Diagnostic endpoints: test both possible formats, read back stored value, restore, return structured recommendation"

requirements-completed:
  - ANLY-03

# Metrics
duration: 5min
completed: 2026-03-31
---

# Phase 15 Plan 04: Analyst Format Verification Summary

**POST /senaite/analyses/{uid}/analyst-test diagnostic endpoint that tests username vs UID Analyst field format against live SENAITE and returns a structured recommendation — human verification pending**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-31T21:20:00Z
- **Completed:** 2026-03-31T21:22:17Z (Task 1 only; Task 2 is a human checkpoint)
- **Tasks:** 1/2 (Task 2 is checkpoint:human-verify)
- **Files modified:** 1

## Accomplishments

- Added `AnalystTestRequest(BaseModel)` schema with `username` and `uid` fields
- Added `POST /senaite/analyses/{uid}/analyst-test` endpoint in backend/main.py
- Endpoint reads current Analyst value, tests username format, tests UID format, restores original, returns `{original_value, username_test, uid_test, recommendation}`
- Recommendation logic: exact string match takes precedence; falls back to non-null detection; returns `"use_username"`, `"use_uid"`, or `"unclear"`
- Human verification against live SENAITE is pending (Task 2 checkpoint)

## Task Commits

1. **Task 1: Add analyst format test endpoint** - `919017a` (feat)

**Plan metadata:** pending (after checkpoint resolution)

## Files Created/Modified

- `backend/main.py` — Added `AnalystTestRequest` schema at line 1467; added `test_analyst_format` endpoint at end of file (line 10400+)

## Decisions Made

- The restore step is best-effort (non-fatal) — diagnostic result is already captured before restore, so a restore failure doesn't invalidate the test.
- `username_exact` (stored value matches sent value exactly) takes precedence over `username_accepted` (any non-null stored value) in the recommendation logic. This avoids false positives when SENAITE transforms the value.

## Deviations from Plan

None — plan executed exactly as written for Task 1.

## Issues Encountered

None.

## Verification Status

**PENDING** — Task 2 requires a human to call the endpoint against a live SENAITE instance and report whether `username_test.accepted` or `uid_test.accepted` is true. Until this is done, the verified format is unknown.

If verified format differs from current `set_analysis_analyst` implementation (which sends `req.analyst_value` as-is without transformation), the endpoint will need updating before Phase 16.

Expected outcomes:
- `"recommendation": "use_username"` → current implementation is likely correct
- `"recommendation": "use_uid"` → `set_analysis_analyst` must be updated to accept a username and resolve it to a UID before sending
- `"recommendation": "unclear"` → manual inspection of `stored` values required

## User Setup Required

None — no external service configuration required beyond the existing `SENAITE_URL` env var.

## Next Phase Readiness

- Diagnostic endpoint is deployed and callable once backend server is started
- Human verification (Task 2) must complete before Phase 16 bulk analyst assignment is built on top of this
- If SENAITE unavailable: defer to Phase 16 start per plan instructions

---
*Phase: 15-foundation*
*Completed: 2026-03-31 (Task 1); Task 2 pending human checkpoint*
