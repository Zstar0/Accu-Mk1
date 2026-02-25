---
phase: "07"
plan: "01"
subsystem: "analysis-workflow"
tags: ["senaite", "transitions", "dropdown-menu", "alert-dialog", "toast", "per-row-state"]

dependency-graph:
  requires:
    - "06-04 — AnalysisTable extracted as standalone component with useAnalysisEditing hook"
    - "06-01/02/03 — SenaiteAnalysis model with uid/keyword fields"
  provides:
    - "transitionAnalysis API function (POST /wizard/senaite/analyses/{uid}/transition)"
    - "useAnalysisTransition hook with per-row loading state and confirmation dialog control"
    - "AnalysisTable Actions column with context-sensitive DropdownMenu"
    - "AlertDialog for destructive transition confirmation (retract, reject)"
  affects:
    - "07-02 — wires onTransitionComplete from SampleDetails to trigger sample refresh"
    - "07-03 — bulk transitions reuse the same ALLOWED_TRANSITIONS constants"

tech-stack:
  added:
    - "None (all UI libraries already present)"
  patterns:
    - "useAnalysisTransition mirrors useAnalysisEditing structural pattern"
    - "pendingUids as Set<string> for independent per-row loading state"
    - "pendingConfirm object drives controlled AlertDialog (not imperative open/close)"
    - "DESTRUCTIVE_TRANSITIONS Set gates confirm vs immediate execute"
    - "AlertDialog placed outside table element (Radix Portal renders to document.body)"
    - "void operator on async onClick handlers to satisfy no-floating-promises lint"

key-files:
  created:
    - "src/hooks/use-analysis-transition.ts"
  modified:
    - "src/lib/api.ts"
    - "src/components/senaite/AnalysisTable.tsx"

decisions:
  - decision: "AlertDialog placed inside overflow-x-auto div but outside table element"
    rationale: "Radix AlertDialogContent renders via Portal to document.body regardless of JSX position; just needs to not be inside a table element to avoid DOM nesting errors"
  - decision: "pendingUids uses Set<string> not a single boolean"
    rationale: "Each analysis row locks independently — concurrent transitions on different rows are supported"
  - decision: "TRANSITION_LABELS defined locally in both hook and AnalysisTable.tsx"
    rationale: "Hook must not import from a component file (architectural direction); duplication is minimal and preferable to cross-layer dependency"
  - decision: "onTransitionComplete not wired in Plan 01"
    rationale: "Plan 02 adds sample-level refresh; transitions work and show toasts without refresh in this intermediate state"

metrics:
  duration: "~4 min"
  completed: "2026-02-25"
  tasks-completed: 2
  tasks-total: 2
---

# Phase 07 Plan 01: Per-Row Transition API, Hook, and Actions Column Summary

**One-liner:** Per-row workflow transitions via state-aware DropdownMenu, immediate-or-confirm execution, and Set-based per-row loading spinners.

## What Was Built

Task 1 added `transitionAnalysis()` to `src/lib/api.ts` (mirrors `setAnalysisResult` pattern; calls `POST /wizard/senaite/analyses/{uid}/transition`) and created `src/hooks/use-analysis-transition.ts` with:
- `pendingUids: Set<string>` for per-row in-flight tracking
- `pendingConfirm: { uid, transition, analysisTitle } | null` for controlled AlertDialog
- `executeTransition` / `requestConfirm` / `cancelConfirm` / `confirmAndExecute` operations
- Sonner toast feedback on success and failure (including SENAITE silent rejections where `response.success === false`)

Task 2 updated `src/components/senaite/AnalysisTable.tsx`:
- Added `ALLOWED_TRANSITIONS`, `TRANSITION_LABELS`, `DESTRUCTIVE_TRANSITIONS` constants
- Added 9th Actions column header (sr-only text) and updated colSpan to 9
- `AnalysisRow` receives `transition: UseAnalysisTransitionReturn` prop and renders a DropdownMenu with only valid transitions for the row's `review_state`
- Spinner replaces MoreHorizontal icon when `pendingUids.has(uid)`
- Destructive transitions (retract, reject) call `requestConfirm`; non-destructive call `executeTransition` directly
- AlertDialog added outside `</table>` element, controlled by `pendingConfirm !== null`
- `AnalysisTableProps` extended with optional `onTransitionComplete` callback

## Task Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | be535d6 | feat(07-01): add transitionAnalysis API function and useAnalysisTransition hook |
| 2 | 2cdde02 | feat(07-01): add Actions column with DropdownMenu and AlertDialog to AnalysisTable |

## Verification Results

- `npx tsc --noEmit`: PASS (zero type errors)
- `npm run build`: PASS (production build succeeds; chunk size warning is pre-existing)
- `ALLOWED_TRANSITIONS['unassigned']` = `['submit']`: PASS
- `ALLOWED_TRANSITIONS['to_be_verified']` = `['verify', 'retract', 'reject']`: PASS
- `ALLOWED_TRANSITIONS['verified']` = `['retract']`: PASS
- AlertDialog positioned after `</table>` closing tag: PASS
- `transitionAnalysis` exported from api.ts at correct endpoint: PASS
- `pendingUids` typed as `Set<string>` in hook: PASS

## Deviations from Plan

None — plan executed exactly as written.

## Next Phase Readiness

Plan 02 (`07-02`) can proceed immediately. It needs to:
1. Pass `onTransitionComplete` from `SampleDetails.tsx` to `AnalysisTable` to trigger sample data refresh after transitions
2. This wires REFR-01/REFR-02 requirements

The transition hook and UI are fully functional. Transitions execute and show toasts; the table data does not auto-refresh until Plan 02 wires the callback.

## Self-Check: PASSED
