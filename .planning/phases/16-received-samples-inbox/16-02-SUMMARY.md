---
phase: 16-received-samples-inbox
plan: 02
subsystem: ui
tags: [react, tanstack-query, typescript, tailwind, inbox, worksheets]

# Dependency graph
requires:
  - phase: 15-foundation
    provides: API_BASE_URL, getBearerHeaders, service-group-colors, ServiceGroup types
provides:
  - InboxPriority, InboxSampleItem, InboxResponse TypeScript types in api.ts
  - 5 inbox API functions: getInboxSamples, updateInboxPriority, getWorksheetUsers, bulkUpdateInbox, createWorksheet
  - useInboxSamples hook with 30s polling
  - usePriorityMutation with optimistic update + rollback
  - useBulkUpdateMutation, useCreateWorksheetMutation
  - PriorityBadge component (3 levels, expedited pulses)
  - AgingTimer component (4-tier SLA colors, 60s refresh, red pulses at >=24h)
affects:
  - 16-03 (inbox table consumes all exports from this plan)
  - 16-04 (worksheet creation dialog uses useCreateWorksheetMutation)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - TanStack Query hook with refetchInterval for live polling (30s)
    - Optimistic mutation with rollback using cancelQueries/setQueryData/getQueryData
    - staleTime: 0 override for live queue (bypasses global 5min stale config)
    - Error property augmentation for typed error subclasses (staleUids)

key-files:
  created:
    - src/hooks/use-inbox-samples.ts
    - src/components/hplc/PriorityBadge.tsx
    - src/components/hplc/AgingTimer.tsx
  modified:
    - src/lib/api.ts

key-decisions:
  - "API functions use project-standard API_BASE_URL()/getBearerHeaders() pattern, not credentials:include (plan template was wrong)"
  - "409 stale guard in createWorksheet augments Error with staleUids property for typed handling in mutation"
  - "AgingTimer uses useState(Date.now()) + setInterval(60_000) with cleanup for live 1-minute updates"

patterns-established:
  - "Live queue pattern: useQuery with refetchInterval: 30_000 + staleTime: 0 bypasses global caching"
  - "Optimistic mutation rollback: cancelQueries -> snapshot -> setQueryData -> onError restore"
  - "Typed error augmentation: Object.assign(new Error(...), { customProp }) for 409 stale detection"

requirements-completed: [INBX-03, INBX-05, INBX-06, INBX-09]

# Metrics
duration: 12min
completed: 2026-04-01
---

# Phase 16 Plan 02: Inbox Types, API Functions, and Shared Components Summary

**Inbox TypeScript types, 5 API functions, TanStack Query hook with 30s polling + optimistic mutations, PriorityBadge (3 levels), and AgingTimer (4-tier SLA) — building blocks for Plan 03 inbox table**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-04-01T03:36:48Z
- **Completed:** 2026-04-01T03:48:00Z
- **Tasks:** 2 of 2
- **Files modified:** 4

## Accomplishments

- Added all inbox TypeScript types to api.ts matching backend InboxResponse schema exactly, plus 5 API functions with proper JWT bearer auth
- Created useInboxSamples with 30s polling, usePriorityMutation with optimistic update/rollback, useBulkUpdateMutation, and useCreateWorksheetMutation with 409 stale guard handling
- PriorityBadge renders 3 distinct color levels (zinc/amber/red) with expedited pulsing; AgingTimer shows live age with 4-tier SLA colors updating every 60s

## Task Commits

1. **Task 1: Add inbox TypeScript types and API functions to api.ts** - `7245f8a` (feat)
2. **Task 2: Create TanStack Query hook, PriorityBadge, and AgingTimer** - `6865480` (feat)

## Files Created/Modified

- `src/lib/api.ts` - Added InboxPriority, InboxAnalysisItem, InboxServiceGroupSection, InboxSampleItem, InboxResponse, WorksheetUser, WorksheetCreateResponse types + 5 API functions
- `src/hooks/use-inbox-samples.ts` - TanStack Query hook with 30s polling and 4 mutation hooks
- `src/components/hplc/PriorityBadge.tsx` - Reusable 3-level priority badge, expedited pulses
- `src/components/hplc/AgingTimer.tsx` - Live SLA aging timer with 4 color thresholds

## Decisions Made

- API functions adapted from plan template to use `API_BASE_URL()` + `getBearerHeaders()` (project standard), not `credentials: 'include'` (plan template assumed a different auth pattern)
- 409 conflict from createWorksheet augments the Error object with `staleUids` property for typed error handling in the mutation's onError callback
- AgingTimer green threshold is <12h, yellow 12-20h, orange 20-24h, red >=24h (with animate-pulse) per RESEARCH.md D-12/D-13

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected API fetch pattern**
- **Found during:** Task 1 (reading existing api.ts)
- **Issue:** Plan template used `credentials: 'include'` and a plain `apiUrl` variable. This project uses JWT Bearer tokens via `getBearerHeaders()` and `API_BASE_URL()` throughout api.ts
- **Fix:** Replaced all fetch calls to use `getBearerHeaders()` and `API_BASE_URL()` per existing project pattern
- **Files modified:** src/lib/api.ts
- **Verification:** TypeScript compiles clean; matches every other function in the file
- **Committed in:** 7245f8a (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — wrong fetch pattern from plan template)
**Impact on plan:** Necessary for API calls to work with JWT auth. No scope creep.

## Issues Encountered

None - both tasks executed cleanly after correcting the fetch pattern.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All building blocks ready for Plan 03 (inbox table component)
- Plan 03 can import: `useInboxSamples`, `usePriorityMutation`, `PriorityBadge`, `AgingTimer`, `InboxSampleItem`
- Existing `getInstruments()` confirmed present at line 1934 of api.ts for INBX-05 instrument dropdown in Plan 03

---
*Phase: 16-received-samples-inbox*
*Completed: 2026-04-01*
