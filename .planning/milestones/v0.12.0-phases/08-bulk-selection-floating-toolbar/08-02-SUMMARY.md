---
phase: 08-bulk-selection-floating-toolbar
plan: 02
subsystem: ui
tags: [react, checkbox, bulk-selection, toolbar, alert-dialog, workflow-transitions]

# Dependency graph
requires:
  - phase: 08-01
    provides: useBulkAnalysisTransition hook and Checkbox indeterminate visual
  - phase: 07-analysis-transitions
    provides: useAnalysisTransition hook with pendingUids Set for per-row transitions
provides:
  - Checkbox column in AnalysisTable (header with indeterminate + per-row cells)
  - Floating BulkActionToolbar between progress bar and table
  - State-aware batch action buttons (intersection of ALLOWED_TRANSITIONS)
  - Progress counter during bulk processing ("Submitting 2/5...")
  - AlertDialog confirmation for destructive bulk transitions (retract, reject)
  - Toolbar disabled when per-row transitions are in-flight
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "bulkAvailableActions = intersection of ALLOWED_TRANSITIONS for all selected analyses"
    - "toolbarDisabled = transition.pendingUids.size > 0 — per-row in-flight blocks bulk toolbar"
    - "headerChecked indeterminate derived from filteredAnalyses (not all analyses)"
    - "Separate AlertDialog for bulk destructive vs per-row destructive confirmations"

key-files:
  created: []
  modified:
    - src/components/senaite/AnalysisTable.tsx

key-decisions:
  - "Header checkbox operates on filteredAnalyses only (select-all respects active filter tab)"
  - "bulkAvailableActions uses every() intersection — mixed states (e.g. unassigned + verified) show no actions"
  - "BulkActionToolbar placed between progress bar and table div (not inside overflow-x-auto)"
  - "Bulk AlertDialog placed outside the table/overflow wrapper inside Card for valid DOM nesting"
  - "colSpan updated from 9 to 10 to account for new checkbox column"

patterns-established:
  - "Toolbar disabled guard: transition.pendingUids.size > 0 prevents bulk while per-row in-flight"
  - "Progress label: TRANSITION_LABELS[transition]ing current/total (e.g. 'Submitting 2/5...')"

# Metrics
duration: 3min
completed: 2026-02-25
---

# Phase 8 Plan 02: Checkbox Selection & Bulk Action Toolbar Summary

**AnalysisTable wired with checkbox column, floating BulkActionToolbar, state-aware batch buttons, progress counter, and destructive confirmation dialogs completing all four BULK requirements**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-25T14:58:42Z
- **Completed:** 2026-02-25T15:01:45Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Checkbox column added to AnalysisTable with header select-all (filtered rows only) and per-row cells, both supporting indeterminate state
- Floating BulkActionToolbar renders between progress bar and table when any rows selected, showing count and state-aware batch action buttons
- Batch buttons only visible for transitions valid for ALL selected analyses (intersection logic with ALLOWED_TRANSITIONS)
- Progress counter ("Submitting 2/5...") replaces buttons during bulk processing
- AlertDialog confirmation gates destructive bulk transitions (retract, reject), separate from existing per-row AlertDialog
- Toolbar disabled when any per-row transition is in-flight (pendingUids.size > 0)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add checkbox column and hook integration to AnalysisTable** - `f2950f2` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/components/senaite/AnalysisTable.tsx` - Checkbox column, BulkActionToolbar, bulk AlertDialog, colSpan 10

## Decisions Made

- Header checkbox operates on `filteredAnalyses` only — select-all respects the active filter tab (All/Verified/Pending)
- `bulkAvailableActions` uses `every()` intersection: if any selected analysis lacks a transition, it is hidden from toolbar
- BulkActionToolbar placed between progress bar and `overflow-x-auto` div so it doesn't scroll with the table
- Bulk destructive AlertDialog placed outside the table inside Card (after the per-row AlertDialog) for valid DOM nesting
- `colSpan` updated from 9 to 10 for empty-state row

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. Pre-existing ESLint warnings in AnalysisTable.tsx (`react-refresh/only-export-components` for `STATUS_COLORS` and `STATUS_LABELS`) were present before this plan and are not introduced by these changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 08 is now complete. Both plans delivered:
- 08-01: Checkbox indeterminate visual + `useBulkAnalysisTransition` hook
- 08-02: Full UI integration in AnalysisTable

All four BULK requirements satisfied (BULK-01 through BULK-04). No blockers.

---
*Phase: 08-bulk-selection-floating-toolbar*
*Completed: 2026-02-25*

## Self-Check: PASSED
