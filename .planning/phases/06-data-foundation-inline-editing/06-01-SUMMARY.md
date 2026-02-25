---
phase: 06-data-foundation-inline-editing
plan: 01
subsystem: api
tags: [pydantic, typescript, senaite, data-model]

# Dependency graph
requires: []
provides:
  - "SenaiteAnalysis model with uid and keyword fields (backend + frontend)"
  - "Analysis UID available for addressing individual analyses in subsequent plans"
affects: [06-02, 06-03, 06-04]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - backend/main.py
    - src/lib/api.ts

key-decisions:
  - "uid and keyword placed before title field as primary identifiers"
  - "Both fields nullable (Optional/null) for backward compatibility with older cached responses"
  - "uid fallback: an_item.get('uid') or an_item.get('UID') covers both SENAITE API casing conventions"
  - "keyword fallback: an_item.get('Keyword') or an_item.get('getKeyword') covers accessor pattern"

patterns-established: []

# Metrics
duration: 1min
completed: 2026-02-25
---

# Phase 06 Plan 01: Analysis UID/Keyword Data Model Summary

**Added uid and keyword identifier fields to SenaiteAnalysis in both backend Pydantic model and frontend TypeScript interface, mapped from SENAITE API response**

## Performance

- **Duration:** 1 min
- **Started:** 2026-02-25T05:46:42Z
- **Completed:** 2026-02-25T05:47:51Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- SenaiteAnalysis Pydantic model now includes uid (Optional[str]) and keyword (Optional[str]) fields
- Lookup endpoint maps uid and keyword from SENAITE API response items with fallback casing
- SenaiteAnalysis TypeScript interface includes matching uid (string | null) and keyword (string | null) fields
- TypeScript typecheck passes with zero errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Add uid and keyword to backend SenaiteAnalysis model and mapping** - `a428874` (feat)
2. **Task 2: Add uid and keyword to frontend SenaiteAnalysis interface** - `0acb9f3` (feat)

## Files Created/Modified
- `backend/main.py` - Added uid and keyword fields to SenaiteAnalysis Pydantic model; mapped them in lookup endpoint constructor call
- `src/lib/api.ts` - Added uid and keyword fields to SenaiteAnalysis TypeScript interface

## Decisions Made
- Placed uid and keyword before the title field in both backend and frontend models, since they serve as primary identifiers
- Used nullable types (Optional/null) for backward compatibility -- older cached responses or edge cases may not have these fields
- Used dual fallback for uid mapping (uid/UID) and keyword mapping (Keyword/getKeyword) to handle SENAITE API casing variations

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Backend Python verification via direct import (`from main import SenaiteAnalysis`) failed due to missing `jose` dependency in local environment. Verified model structure using standalone Pydantic test instead. This is a local dev environment issue, not a code issue.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Analysis uid and keyword fields are now available for all subsequent plans in Phase 06
- Plan 06-02 (backend transition endpoints) can use uid to address individual analyses
- Plan 06-03 (AnalysisTable extraction) will have uid available for row identity
- Plan 06-04 (inline editing) will use uid for result submission

## Self-Check: PASSED

---
*Phase: 06-data-foundation-inline-editing*
*Completed: 2026-02-25*
