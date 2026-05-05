---
phase: 06-data-foundation-inline-editing
plan: 03
subsystem: ui
tags: [react, component-extraction, refactor, analysis-table]

# Dependency graph
requires:
  - phase: 06-01
    provides: SenaiteAnalysis type with uid/keyword fields
provides:
  - Standalone AnalysisTable component with filter tabs, progress bar, and table
  - Exported StatusBadge, STATUS_COLORS, STATUS_LABELS for reuse
affects: [06-04, 07-workflow-actions, 08-bulk-operations]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Component extraction: move analysis rendering to dedicated file, pass data via props"
    - "Shared exports: StatusBadge exported from AnalysisTable for reuse in parent"

key-files:
  created:
    - src/components/senaite/AnalysisTable.tsx
  modified:
    - src/components/senaite/SampleDetails.tsx

key-decisions:
  - "StatusBadge and status constants exported from AnalysisTable.tsx rather than a separate shared file"
  - "verifiedCount/pendingCount kept in SampleDetails for header counters, computed independently from AnalysisTable"
  - "formatDate duplicated in AnalysisTable rather than extracted to shared util (tiny helper, used in both files)"

patterns-established:
  - "Analysis table rendering isolated in AnalysisTable.tsx with props-based data flow"
  - "Filter state (analysisFilter) managed internally by AnalysisTable — UI-only state stays in the component"

# Metrics
duration: 4min
completed: 2026-02-24
---

# Phase 06 Plan 03: Extract AnalysisTable Component Summary

**Standalone AnalysisTable component extracted from SampleDetails with filter tabs, progress bar, and analysis row rendering -- SampleDetails reduced from 1349 to 1055 lines**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-25T05:51:35Z
- **Completed:** 2026-02-25T05:55:54Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Extracted AnalysisTable.tsx (339 lines) as standalone component with internal filter state
- Reduced SampleDetails.tsx by 294 lines (1349 -> 1055), well below the 1100-1150 target
- Moved all analysis rendering: AnalysisRow, TabButton, StatusBadge, formatAnalysisTitle, status constants
- StatusBadge exported for reuse by SampleDetails sample-level badge at line 589
- TypeScript compiles cleanly, no new lint errors introduced

## Task Commits

Each task was committed atomically:

1. **Task 1: Create AnalysisTable.tsx with extracted analysis rendering** - `f29e189` (refactor)

## Files Created/Modified
- `src/components/senaite/AnalysisTable.tsx` - Standalone analysis table with filter tabs, progress bar, AnalysisRow, StatusBadge, TabButton, formatAnalysisTitle
- `src/components/senaite/SampleDetails.tsx` - Reduced by removing inline analysis rendering, now imports AnalysisTable and StatusBadge

## Decisions Made
- StatusBadge and status constants (STATUS_COLORS, STATUS_LABELS) exported from AnalysisTable.tsx rather than creating a separate shared file -- keeps the extraction minimal and avoids unnecessary file proliferation
- verifiedCount and pendingCount kept as local computations in SampleDetails for the header counter display, independently computed from AnalysisTable's internal state
- formatDate helper duplicated in AnalysisTable since it's a tiny 6-line utility used in both files; extracting to shared utils would be over-engineering at this point

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserved verifiedCount/pendingCount for header counters**
- **Found during:** Task 1 (TypeScript compilation)
- **Issue:** SampleDetails uses verifiedCount and pendingCount in the header summary counters (lines 610, 619), not just in the analyses table section. Removing the computations broke compilation.
- **Fix:** Kept verifiedCount and pendingCount as local computations in SampleDetails alongside the analyses const. These are independently computed from AnalysisTable's internal filter state.
- **Files modified:** src/components/senaite/SampleDetails.tsx
- **Verification:** npm run typecheck passes
- **Committed in:** f29e189 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minor adjustment to keep header counters working. No scope creep.

## Issues Encountered
- react-refresh/only-export-components warnings appear for STATUS_COLORS and STATUS_LABELS exports in AnalysisTable.tsx. These are HMR warnings (not errors) and are expected when a component file also exports constants. No impact on functionality.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- AnalysisTable.tsx is ready for Plan 04 to add inline editing state management
- Component is props-driven, making it straightforward to add editing callbacks
- StatusBadge export pattern established for shared component reuse

---
## Self-Check: PASSED

*Phase: 06-data-foundation-inline-editing*
*Completed: 2026-02-24*
