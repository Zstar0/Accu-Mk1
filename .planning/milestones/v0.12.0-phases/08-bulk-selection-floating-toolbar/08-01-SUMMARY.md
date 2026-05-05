---
phase: 08
plan: 01
subsystem: bulk-selection
tags: [checkbox, hooks, bulk-operations, state-management]

dependency-graph:
  requires:
    - "07-01: use-analysis-transition.ts hook pattern"
    - "07-01: transitionAnalysis from src/lib/api.ts"
  provides:
    - "Indeterminate-aware Checkbox component"
    - "useBulkAnalysisTransition hook with full selection + sequential processing API"
  affects:
    - "08-02: AnalysisTable bulk selection UI wires these building blocks"

tech-stack:
  added: []
  patterns:
    - "Sequential for...await loop for bulk operations (never Promise.all)"
    - "Indeterminate checkbox via Radix data-state attribute + Tailwind data variants"
    - "useCallback wrapping for all state-mutating functions"
    - "Single onTransitionComplete call after bulk loop (not per-item)"

key-files:
  created:
    - src/hooks/use-bulk-analysis-transition.ts
  modified:
    - src/components/ui/checkbox.tsx

decisions:
  - "Icons on Indicator element use data-[state=indeterminate] to reference Indicator's own data-state"
  - "Root className gets indeterminate filled styling matching checked state (bg-primary, text-primary-foreground, border-primary)"
  - "TRANSITION_PAST_TENSE map defined locally in hook (not imported from component)"
  - "clearSelection called inside executeBulk after onTransitionComplete — hook cleans itself up"

metrics:
  duration: "< 5 min"
  completed: "2026-02-25"
---

# Phase 08 Plan 01: Checkbox Indeterminate & Bulk Hook Summary

**One-liner:** Indeterminate Checkbox visual (MinusIcon + filled styling) and sequential `useBulkAnalysisTransition` hook with Set-based selection state and progress-tracked for...await bulk processing.

## What Was Built

### Task 1: Checkbox Indeterminate Visual

Updated `src/components/ui/checkbox.tsx`:

- Added `MinusIcon` import from `lucide-react` alongside `CheckIcon`
- `CheckIcon` now has `data-[state=indeterminate]:hidden` — hidden when indeterminate
- `MinusIcon` has `hidden data-[state=indeterminate]:block` — only visible when indeterminate
- Root className gains `data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground data-[state=indeterminate]:border-primary` so indeterminate gets the same filled visual as checked

The `CheckboxPrimitive.Indicator` carries the `data-state` attribute from Radix, so the Tailwind data variants on the child icons correctly reference the nearest ancestor's state.

### Task 2: useBulkAnalysisTransition Hook

Created `src/hooks/use-bulk-analysis-transition.ts`:

**State exposed:**
- `selectedUids: Set<string>` — selection set
- `isBulkProcessing: boolean` — processing gate
- `bulkProgress: BulkProgress | null` — `{ current, total, transition }` for progress bar

**Actions exposed:**
- `toggleSelection(uid)` — adds/removes uid from Set (new Set copy)
- `selectAll(uids[])` — replaces selectedUids with new Set(uids)
- `clearSelection()` — resets to empty Set
- `executeBulk(uids[], transition)` — sequential for loop, calls `onTransitionComplete` once after loop, clears selection, shows summary toast

**Toast logic:**
- All succeeded: `toast.success("N analyses submitted")`
- Partial failure: `toast.warning("N succeeded, M failed", { description: "M transition(s) could not be completed" })`

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add indeterminate visual to Checkbox | bf62554 | src/components/ui/checkbox.tsx |
| 2 | Create useBulkAnalysisTransition hook | 33986db | src/hooks/use-bulk-analysis-transition.ts |

## Verification Results

- `npx tsc --noEmit` — passed clean (no errors)
- `checkbox.tsx` imports both `CheckIcon` and `MinusIcon` — confirmed
- `use-bulk-analysis-transition.ts` imports `transitionAnalysis` from `@/lib/api` — confirmed
- Hook uses `for` loop (not `Promise.all`) — confirmed
- `onTransitionComplete` called exactly once after loop, not inside — confirmed
- Pre-existing lint errors in other files exist (unrelated to this plan)

## Deviations from Plan

None - plan executed exactly as written.

## Next Phase Readiness

Plan 08-02 can now wire `useBulkAnalysisTransition` into `AnalysisTable.tsx`:
- Import the hook and `Checkbox` component
- Add checkbox column with header select-all / row toggle
- Add floating toolbar that calls `executeBulk`

## Self-Check: PASSED
