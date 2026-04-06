---
phase: 15-foundation
plan: 02
subsystem: ui
tags: [react, typescript, zustand, navigation, sidebar]

# Dependency graph
requires: []
provides:
  - WorksheetSubSection type exported from ui-store.ts
  - HPLCAnalysisSubSection extended with inbox, worksheets, worksheet-detail
  - LIMSSubSection extended with service-groups
  - ActiveSubSection union includes WorksheetSubSection
  - Service Groups nav item under LIMS (admin-only)
  - Inbox and Worksheets nav items under HPLC Automation
  - ServiceGroupsPage placeholder component
  - WorksheetsInboxPage placeholder component
  - WorksheetsListPage placeholder component
  - MainWindowContent render cases for all three new sub-sections
affects: [15-03, phase-16, phase-17, phase-18]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Placeholder page pattern: export default function XPage() with flex-1 p-6 layout"
    - "adminOnly flag on sidebar SubItem to gate nav items by role"

key-files:
  created:
    - src/components/hplc/ServiceGroupsPage.tsx
    - src/components/hplc/WorksheetsInboxPage.tsx
    - src/components/hplc/WorksheetsListPage.tsx
  modified:
    - src/store/ui-store.ts
    - src/components/layout/AppSidebar.tsx
    - src/components/layout/MainWindowContent.tsx

key-decisions:
  - "WorksheetSubSection standalone type added to ui-store.ts for downstream consumers (Phase 16+) who want to narrow to worksheet-specific sub-sections without pulling in all HPLCAnalysisSubSection values"
  - "worksheet-detail not wired in MainWindowContent — Phase 17 will handle detail page routing when the component exists"

patterns-established:
  - "Placeholder page pattern: minimal default export component with flex-1 p-6 container, h1 heading, muted-foreground description"

requirements-completed: [NAVG-01, NAVG-02]

# Metrics
duration: 10min
completed: 2026-03-31
---

# Phase 15 Plan 02: Navigation Skeleton Summary

**Navigation skeleton for Worksheets feature: WorksheetSubSection types, 3 new sidebar items (Inbox, Worksheets, Service Groups), and placeholder page components wired into MainWindowContent**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-03-31T21:15:00Z
- **Completed:** 2026-03-31T21:25:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Extended ui-store.ts with WorksheetSubSection type and updated LIMSSubSection and HPLCAnalysisSubSection unions
- Added Inbox and Worksheets nav items to HPLC Automation section; Service Groups (admin-only) to LIMS section
- Created three placeholder pages (ServiceGroupsPage, WorksheetsInboxPage, WorksheetsListPage) wired into MainWindowContent
- TypeScript compilation passes with no errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend type definitions for worksheet and service-groups nav** - `45134b3` (feat)
2. **Task 2: Add sidebar nav items, render cases, and placeholder pages** - `46d36a0` (feat)

**Plan metadata:** (docs commit — see final commit hash below)

## Files Created/Modified

- `src/store/ui-store.ts` - Added WorksheetSubSection type, extended HPLCAnalysisSubSection and LIMSSubSection, updated ActiveSubSection union
- `src/components/layout/AppSidebar.tsx` - Added service-groups (adminOnly) to LIMS subItems, inbox and worksheets to HPLC Automation subItems
- `src/components/layout/MainWindowContent.tsx` - Added imports and render cases for ServiceGroupsPage, WorksheetsInboxPage, WorksheetsListPage
- `src/components/hplc/ServiceGroupsPage.tsx` - Placeholder for Plan 03 implementation
- `src/components/hplc/WorksheetsInboxPage.tsx` - Placeholder for Phase 16 implementation
- `src/components/hplc/WorksheetsListPage.tsx` - Placeholder for Phase 18 implementation

## Decisions Made

- WorksheetSubSection exported as standalone type even though its values overlap with HPLCAnalysisSubSection — provides a narrower type for Phase 16+ consumers
- worksheet-detail not wired in MainWindowContent yet — routing deferred to Phase 17 when the detail component exists

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

ESLint run via `npm run check:all` picked up files from the parallel agent worktree (`.claude/worktrees/agent-a60ba337/`) causing lint failures unrelated to this plan's changes. TypeScript compilation (`tsc --noEmit`) passed cleanly. The worktree lint issue is a pre-existing environment artifact from parallel execution, out of scope per deviation rules.

## Known Stubs

- `src/components/hplc/ServiceGroupsPage.tsx` - Intentional placeholder; Plan 03 will implement service groups management UI
- `src/components/hplc/WorksheetsInboxPage.tsx` - Intentional placeholder; Phase 16 will implement received samples inbox
- `src/components/hplc/WorksheetsListPage.tsx` - Intentional placeholder; Phase 18 will implement worksheets list

These stubs do not prevent this plan's goal (navigation routing skeleton) from being achieved. Each is documented with the phase that will replace it.

## Next Phase Readiness

- Navigation skeleton is complete — clicking Inbox, Worksheets, or Service Groups in the sidebar routes to the correct placeholder page
- Hash navigation (#hplc-analysis/inbox, #hplc-analysis/worksheets, #lims/service-groups) works via existing parseNavHash logic
- Plan 03 can implement ServiceGroupsPage using the service-groups sub-section routing already in place
- Phases 16 and 18 can replace placeholder components without touching sidebar or MainWindowContent

---
*Phase: 15-foundation*
*Completed: 2026-03-31*
