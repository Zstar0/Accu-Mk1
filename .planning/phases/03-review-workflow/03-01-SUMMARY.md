---
phase: 03-review-workflow
plan: 01
subsystem: api
tags: [fastapi, sample-lifecycle, approval-workflow, audit-log]

# Dependency graph
requires:
  - phase: 02-data-pipeline
    provides: Sample model, import endpoints, calculation engine
provides:
  - Sample status lifecycle (pending -> calculated -> approved/rejected)
  - PUT /samples/{id}/approve endpoint
  - PUT /samples/{id}/reject endpoint with reason
  - TypeScript approveSample() and rejectSample() API functions
  - rejection_reason field on Sample model
affects: [03-02, 03-03, 03-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Status lifecycle pattern: pending -> calculated -> approved/rejected"
    - "Rejection reason stored with status change"
    - "Audit log on status transitions"

key-files:
  created: []
  modified:
    - backend/models.py
    - backend/main.py
    - src/lib/api.ts

key-decisions:
  - "Approving clears rejection_reason (allows re-approval after rejection)"
  - "Both approve/reject create audit log entries with old/new status"

patterns-established:
  - "Sample status transitions: audit logged with old_status/new_status details"

# Metrics
duration: 4min
completed: 2026-01-16
---

# Phase 3 Plan 1: Sample Review Backend Summary

**Sample approval/rejection API with status lifecycle (pending->calculated->approved/rejected) and TypeScript client functions**

## Performance

- **Duration:** 4 min
- **Started:** 2026-01-16T16:15:00Z
- **Completed:** 2026-01-16T16:19:00Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Sample model extended with rejection_reason field for storing rejection rationale
- PUT /samples/{id}/approve endpoint sets status='approved' and clears rejection_reason
- PUT /samples/{id}/reject endpoint accepts reason, sets status='rejected', stores reason
- Both endpoints create audit log entries tracking status transitions
- TypeScript API client functions approveSample() and rejectSample() added
- Sample interface updated with rejection_reason and typed status values

## Task Commits

Each task was committed atomically:

1. **Task 1: Add rejection_reason to Sample model** - `dffadc4` (feat)
2. **Task 2: Create approve/reject API endpoints** - `f49569c` (feat)
3. **Task 3: Add TypeScript API client functions** - `1516b01` (feat)

## Files Created/Modified
- `backend/models.py` - Added rejection_reason field to Sample model
- `backend/main.py` - Added approve/reject endpoints, RejectRequest schema, updated SampleResponse
- `src/lib/api.ts` - Added approveSample(), rejectSample() functions, updated Sample interface

## Decisions Made
- Approving a sample clears rejection_reason (allows workflow: reject -> fix issue -> re-approve)
- Both approve/reject create audit log entries with old_status, new_status, and reason (for reject)
- Sample.status typed as union with fallback string for extensibility

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Approve/reject API ready for UI integration in 03-02
- TypeScript functions ready for React Query hooks
- Audit trail captures all status changes for compliance

---
*Phase: 03-review-workflow*
*Plan: 01*
*Completed: 2026-01-16*
