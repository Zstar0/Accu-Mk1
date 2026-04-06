---
phase: 15-foundation
plan: 01
subsystem: api
tags: [fastapi, sqlalchemy, typescript, service-groups, senaite, m2m]

requires: []
provides:
  - ServiceGroup SQLAlchemy model with M2M relationship to AnalysisService via service_group_members table
  - Full CRUD endpoints for /service-groups (GET, POST, PUT, DELETE)
  - GET /service-groups/{id}/members returning current member IDs as list[int]
  - PUT /service-groups/{id}/members for full membership replacement
  - GET /senaite/analysts proxying SENAITE LabContact
  - POST /senaite/analyses/{uid}/analyst for analyst assignment
  - TypeScript ServiceGroup, ServiceGroupCreate/Update, SenaiteAnalyst types in api.ts
  - TypeScript API functions: getServiceGroups, createServiceGroup, updateServiceGroup, deleteServiceGroup, getServiceGroupMembers, setServiceGroupMembers, getSenaiteAnalysts, setAnalysisAnalyst
affects: [15-foundation, 16-bulk-assignment, 17-inbox, 18-worksheets]

tech-stack:
  added: []
  patterns:
    - ServiceGroup M2M via service_group_members association table (mirrors peptide_methods pattern)
    - SENAITE proxy endpoints using httpx.AsyncClient with _get_senaite_auth(current_user)
    - ServiceGroupResponse manually constructed (not from_attributes) to include computed member_count field
    - GET members endpoint queries association table directly for list[int] output

key-files:
  created: []
  modified:
    - backend/models.py
    - backend/main.py
    - src/lib/api.ts

key-decisions:
  - "Used secondary='service_group_members' string reference in ServiceGroup.analysis_services relationship to avoid forward-reference issues with Table defined after class"
  - "ServiceGroupResponse built manually rather than from_attributes due to computed member_count field not on model"
  - "SENAITE analyst endpoints raise HTTPException on error (not return AnalysisResultResponse) to match 503/504/502 semantics for service unavailability"

patterns-established:
  - "Service group CRUD: same select/add/commit/refresh pattern as HplcMethod CRUD"
  - "Membership GET: query association table directly, return list[int]"
  - "Membership PUT: load group with joinedload, query services by IDs, assign group.analysis_services = list(services)"

requirements-completed:
  - SGRP-01
  - SGRP-02
  - SGRP-04
  - ANLY-01
  - ANLY-02
  - ANLY-03

duration: 18min
completed: 2026-03-31
---

# Phase 15 Plan 01: Foundation Summary

**ServiceGroup model + M2M table, 8 backend endpoints (CRUD, membership, SENAITE analyst proxy), and 8 TypeScript API functions covering all service group and analyst operations**

## Performance

- **Duration:** 18 min
- **Started:** 2026-03-31T21:15:00Z
- **Completed:** 2026-03-31T21:33:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- ServiceGroup SQLAlchemy model with color, sort_order, description and M2M relationship to AnalysisService via service_group_members association table
- 8 FastAPI endpoints: GET/POST/PUT/DELETE /service-groups, GET/PUT /service-groups/{id}/members, GET /senaite/analysts, POST /senaite/analyses/{uid}/analyst
- TypeScript types (ServiceGroup, ServiceGroupCreate, ServiceGroupUpdate, SenaiteAnalyst) and 8 matching API functions in src/lib/api.ts

## Task Commits

1. **Task 1: Add ServiceGroup model and service_group_members M2M table** - `bf57062` (feat)
2. **Task 2: Add service group CRUD, membership, and SENAITE analyst endpoints + TypeScript API client** - `cf9f96b` (feat)

## Files Created/Modified

- `backend/models.py` - Added ServiceGroup class and service_group_members association Table
- `backend/main.py` - Added ServiceGroupCreate/Update/Response/MembersRequest/AnalystAssignRequest schemas; 8 new endpoints
- `src/lib/api.ts` - Added ServiceGroup/SenaiteAnalyst TypeScript interfaces and 8 API functions

## Decisions Made

- Used `secondary="service_group_members"` string reference in the relationship to avoid the Table being defined after the class body - at runtime the string is resolved after all models are loaded.
- ServiceGroupResponse is constructed manually (not via `from_attributes = True`) because `member_count` is a computed field that does not exist on the model itself.
- SENAITE analyst endpoints raise `HTTPException` (503/504/502/500) rather than returning a typed error response, consistent with the plan's requirement to treat SENAITE unavailability as a hard error.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

The local test environment was missing `python-jose[cryptography]` and `python-multipart` packages, causing `import main` to fail during verification. Both packages were installed (they are already declared in requirements.txt/Dockerfile for the actual running service). Not a code issue.

## User Setup Required

None - no external service configuration required. SENAITE endpoints require `SENAITE_URL` environment variable to be set at runtime, which is pre-existing configuration.

## Next Phase Readiness

- ServiceGroup data layer is complete. Plan 03 (admin UI) can now build the membership checkbox editor using `getServiceGroupMembers` for pre-population and `setServiceGroupMembers` for saving.
- SENAITE analyst endpoints are ready for Phase 16 bulk assignment flows.
- No blockers.

---
*Phase: 15-foundation*
*Completed: 2026-03-31*
