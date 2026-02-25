# Phase 08: Bulk Selection & Floating Toolbar - Research

**Researched:** 2026-02-25
**Domain:** React checkbox selection state, floating action bar UI, sequential async batch processing
**Confidence:** HIGH — all findings verified against live codebase, existing patterns, and Radix UI type signatures

## Summary

Phase 08 adds bulk analysis selection (checkbox column + indeterminate header checkbox) to the AnalysisTable, a floating toolbar that appears when rows are selected, state-aware batch action buttons, and a sequential processing loop with progress counter and summary toast. All UI primitives needed are already installed. The existing `useAnalysisTransition` hook's `executeTransition` function is directly reusable for bulk processing — no new backend endpoints are needed.

The architecture is a pure extension of Phase 07's patterns: a new `useBulkAnalysisTransition` hook owns selected UIDs and bulk processing state, the AnalysisTable gains a checkbox column, and a `BulkActionToolbar` component renders conditionally below the filter tabs. State-aware batch buttons use the existing `ALLOWED_TRANSITIONS` constant to determine which transitions are valid for the entire selection. The BatchReview.tsx component in this codebase provides a validated `for...await` loop pattern for sequential processing.

The `Checkbox` component (`@/components/ui/checkbox.tsx`) wraps `@radix-ui/react-checkbox@1.3.3` which natively supports `checked="indeterminate"` via its `CheckedState = boolean | 'indeterminate'` type. The existing `Checkbox` component component passes all props through to the Radix root, but only shows `CheckIcon` in its Indicator — the indeterminate visual (a dash/minus icon) must be added to the Checkbox component or handled inline with a custom header cell.

**Primary recommendation:** Add `selectedUids: Set<string>` state to AnalysisTable (or a `useBulkAnalysisTransition` hook); render a `BulkActionToolbar` component between the filter tabs row and the table; reuse `executeTransition` from the existing hook for each analysis in a `for...await` loop; call `onTransitionComplete` once after the loop completes.

## Standard Stack

### Core (all already installed, zero new dependencies)

| Component | Location | Purpose | Note |
|-----------|----------|---------|------|
| `Checkbox` | `@/components/ui/checkbox.tsx` | Row selection + header indeterminate | Wraps `@radix-ui/react-checkbox@1.3.3` |
| `Minus` (icon) | `lucide-react` | Indeterminate header checkbox visual | Already available, just not imported |
| `Button` | `@/components/ui/button.tsx` | Bulk action buttons in toolbar | Used throughout app |
| `toast` (sonner) | `sonner@2.0.7` | Summary toast with description | Pattern established in prior phases |
| `Spinner` | `@/components/ui/spinner.tsx` | Processing state indicator in toolbar | Used in AnalysisRow, EditableResultCell |

### API Functions (existing, no changes needed)

| Function | Location | Purpose |
|----------|----------|---------|
| `transitionAnalysis(uid, transition)` | `src/lib/api.ts` | Single analysis transition — loop calls this |

The backend endpoint at `POST /wizard/senaite/analyses/{uid}/transition` is fully functional. No new API surface needed for bulk operations — sequential single-item calls is the required pattern.

### No New Dependencies

```bash
# Nothing to install — all packages already present
```

## Architecture Patterns

### Recommended Component/Hook Structure

```
src/
├── hooks/
│   ├── use-analysis-editing.ts       (Phase 06 — unchanged)
│   ├── use-analysis-transition.ts    (Phase 07 — unchanged)
│   └── use-bulk-analysis-transition.ts  (NEW — Phase 08)
├── components/senaite/
│   ├── AnalysisTable.tsx             (MODIFIED — checkbox column, BulkActionToolbar, selectedUids)
│   └── SampleDetails.tsx             (unchanged — already passes onTransitionComplete)
└── lib/
    └── api.ts                        (unchanged — transitionAnalysis already exists)
```

### Pattern 1: useBulkAnalysisTransition Hook

Owns selection state and bulk processing state. Separate from `useAnalysisTransition` (which owns per-row pending state) to avoid coupling.

```typescript
// Source: derived from use-analysis-transition.ts pattern (verified codebase)
interface BulkProcessOutcome {
  succeeded: string[]  // UIDs that succeeded
  failed: string[]     // UIDs that failed
}

interface UseBulkAnalysisTransitionReturn {
  selectedUids: Set<string>
  isBulkProcessing: boolean
  bulkProgress: { current: number; total: number } | null
  toggleSelection: (uid: string) => void
  selectAll: (uids: string[]) => void
  clearSelection: () => void
  executeBulk: (uids: string[], transition: string) => Promise<void>
}
```

Key design decisions:
- `selectedUids: Set<string>` — same pattern as `pendingUids` in `useAnalysisTransition`
- `bulkProgress: { current, total } | null` — null when not processing, populated during run
- `executeBulk` calls `transitionAnalysis` in a `for...await` loop, tracking per-item outcomes
- After loop: calls `onTransitionComplete` once (not per-item), then emits summary toast
- `isBulkProcessing` gates toolbar buttons during active run

### Pattern 2: Sequential for...await Loop with Progress Counter

The existing `BatchReview.tsx` validates this pattern (lines 155-161):

```typescript
// Source: BatchReview.tsx lines 155-161 (verified codebase) + STATE.md decision
// "Bulk operations must be sequential for...await (never Promise.all)"
const executeBulk = async (uids: string[], transition: string) => {
  setIsBulkProcessing(true)
  setBulkProgress({ current: 0, total: uids.length })

  const succeeded: string[] = []
  const failed: string[] = []

  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i]!
    setBulkProgress({ current: i + 1, total: uids.length })
    try {
      const response = await transitionAnalysis(
        uid,
        transition as 'submit' | 'verify' | 'retract' | 'reject'
      )
      if (response.success) {
        succeeded.push(uid)
      } else {
        failed.push(uid)
      }
    } catch {
      failed.push(uid)
    }
  }

  // Single refresh after all items (not per-item — avoids N refreshes)
  onTransitionComplete?.()
  clearSelection()
  setIsBulkProcessing(false)
  setBulkProgress(null)

  // Summary toast
  if (failed.length === 0) {
    toast.success(`${succeeded.length} submitted`)
  } else {
    toast.warning(`${succeeded.length} succeeded, ${failed.length} failed`)
  }
}
```

**Critical:** `for...await` not `Promise.all`. This is a locked decision in STATE.md to avoid SENAITE workflow race conditions.

### Pattern 3: Checkbox Column with Indeterminate Header

Radix UI `@radix-ui/react-checkbox@1.3.3` supports `checked="indeterminate"` natively. The `CheckedState = boolean | 'indeterminate'` type is verified in the type definitions.

```typescript
// Source: @radix-ui/react-checkbox type definitions (verified)
// Header checkbox — three states
const allSelected = filteredAnalyses.every(a => a.uid && selectedUids.has(a.uid))
const someSelected = filteredAnalyses.some(a => a.uid && selectedUids.has(a.uid))
const headerChecked: boolean | 'indeterminate' =
  allSelected ? true : someSelected ? 'indeterminate' : false

// Header cell
<th className="py-2 px-3 w-10">
  <Checkbox
    checked={headerChecked}
    onCheckedChange={(checked) => {
      if (checked === true) {
        selectAll(filteredAnalyses.map(a => a.uid).filter(Boolean) as string[])
      } else {
        clearSelection()
      }
    }}
    aria-label="Select all analyses"
  />
</th>

// Per-row cell (first column)
<td className="py-2.5 px-3">
  {analysis.uid && (
    <Checkbox
      checked={selectedUids.has(analysis.uid)}
      onCheckedChange={() => { if (analysis.uid) toggleSelection(analysis.uid) }}
      aria-label={`Select ${analysis.title}`}
    />
  )}
</td>
```

**Note:** The existing `Checkbox` component's `Indicator` only renders `CheckIcon`. For indeterminate visual, the `Indicator` already renders when state is `indeterminate` (Radix behavior) — but it shows a checkmark. Two approaches:
1. Add a `Minus` icon branch inside the shared `Checkbox` component's Indicator
2. Use a custom inline checkbox for the header only

Approach 1 is preferred (edit `checkbox.tsx` to show `Minus` icon when `data-state=indeterminate`).

### Pattern 4: State-Aware Bulk Action Buttons

Derive available actions from the intersection of allowed transitions for ALL selected analyses:

```typescript
// Source: ALLOWED_TRANSITIONS constant from AnalysisTable.tsx (verified)
// Reuse the same constant
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  unassigned: ['submit'],
  to_be_verified: ['verify', 'retract', 'reject'],
  verified: ['retract'],
}

// Compute intersection of valid transitions for all selected rows
const selectedAnalyses = analyses.filter(a => a.uid && selectedUids.has(a.uid))
const bulkActions = selectedAnalyses.length > 0
  ? Object.keys(ALLOWED_TRANSITIONS).reduce<string[]>((acc, _) => {
      // For each possible transition, check ALL selected analyses support it
      const allTransitions = new Set(['submit', 'verify', 'retract', 'reject'])
      return [...allTransitions].filter(t =>
        selectedAnalyses.every(a =>
          a.review_state && (ALLOWED_TRANSITIONS[a.review_state] ?? []).includes(t)
        )
      )
    }, [])
  : []
```

Simpler implementation:

```typescript
// Cleaner version
const allTransitionsForSelected = selectedAnalyses.map(a =>
  new Set(a.review_state ? (ALLOWED_TRANSITIONS[a.review_state] ?? []) : [])
)
const bulkActions = ['submit', 'verify', 'retract', 'reject'].filter(t =>
  allTransitionsForSelected.length > 0 &&
  allTransitionsForSelected.every(set => set.has(t))
)
```

### Pattern 5: BulkActionToolbar Component (Conditional Render)

The toolbar appears when `selectedUids.size > 0`. It lives between the filter tabs and the table within the `AnalysisTable` Card.

```typescript
// Source: project pattern — inline conditional render
{selectedUids.size > 0 && (
  <BulkActionToolbar
    selectedCount={selectedUids.size}
    bulkActions={bulkActions}
    isBulkProcessing={isBulkProcessing}
    bulkProgress={bulkProgress}
    onAction={(transition) => void executeBulk([...selectedUids], transition)}
    onClear={clearSelection}
  />
)}
```

Toolbar layout:
- Left: "N selected" count badge + "Clear" button
- Center/Right: Batch action buttons (only valid actions for all selected rows)
- During processing: progress text "Submitting 2/5..." replaces buttons

The toolbar uses existing `Button` components and Tailwind. No custom positioning needed — it renders inline above the `<div className="overflow-x-auto rounded-lg border border-border">` wrapper. This avoids `fixed` positioning complexity (which would require z-index management and portal considerations).

### Anti-Patterns to Avoid

- **Promise.all for bulk transitions:** Locked decision in STATE.md — SENAITE has workflow race conditions. Always `for...await`.
- **Per-item toast during bulk:** Creates toast storm. Only one summary toast after all items complete.
- **Per-item `onTransitionComplete` call:** Triggers N refreshes. Call once after the loop.
- **selectedUids in SampleDetails:** Keep bulk selection state in AnalysisTable (or its hook). It's table-local UI state, not parent-level.
- **Absolute/fixed toolbar position:** Inline render above the table is simpler and avoids z-index conflicts with the ScrollArea in SampleDetails.
- **colSpan hard-coded as 9:** The table currently has 9 columns. Adding the checkbox column makes it 10. Update any colSpan references (empty state row uses `colSpan={9}`).
- **Destructive bulk transitions without confirmation:** retract/reject in bulk should still gate through an AlertDialog. The toolbar should use the same `DESTRUCTIVE_TRANSITIONS` set.
- **selectAll across all analyses (not filtered):** Header checkbox should only select/deselect rows currently visible (filteredAnalyses), not all analyses.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Indeterminate checkbox state | Custom CSS dash element | `@radix-ui/react-checkbox` `checked="indeterminate"` | Native support, accessibility, keyboard |
| Progress counter display | Custom progress bar component | Simple inline text "Submitting N/M..." | Sufficient for requirements; toast handles final state |
| Batch action derivation | Complex state machine | Set intersection on ALLOWED_TRANSITIONS | The constant already exists, simple array filter |
| Selection management | Library (react-table selection) | `useState<Set<string>>` | AnalysisTable already custom, no TanStack Table |

**Key insight:** All complexity is already solved by existing patterns. This phase is a UI composition task, not a new problem.

## Common Pitfalls

### Pitfall 1: colSpan Mismatch After Adding Checkbox Column

**What goes wrong:** The empty-state row `<td colSpan={9}>` becomes incorrect when checkbox column is added, causing misaligned empty state display.
**Why it happens:** The table's column count increases from 9 to 10 with the new checkbox column.
**How to avoid:** Search for `colSpan={9}` in AnalysisTable.tsx and update to `colSpan={10}`.
**Warning signs:** Empty state row looks misaligned or narrower than the table.

### Pitfall 2: Stale Selection After Filter Change

**What goes wrong:** User selects 3 rows in "Pending" filter, switches to "All" filter — selected rows are still highlighted but may now include rows that were hidden. OR: user filters to "Verified", selects rows, switches to "Pending" — selection count in toolbar mismatches visible rows.
**Why it happens:** `selectedUids` persists across filter changes.
**How to avoid:** `clearSelection()` on filter change, OR accept that selection persists across filters (simpler, acceptable UX). Document the choice. The simpler approach (selection persists) matches how most data tables work.

### Pitfall 3: Bulk Processing While Per-Row Transition Pending

**What goes wrong:** A per-row transition is in-flight (row shows Spinner) while user triggers bulk operation on the same UID — two concurrent transitions for one analysis.
**Why it happens:** `pendingUids` (per-row hook) and `selectedUids` (bulk hook) are independent sets.
**How to avoid:** In `executeBulk`, skip UIDs that are in `pendingUids` from the per-row hook. OR: disable bulk toolbar when `pendingUids.size > 0`. The disable approach is simpler.

### Pitfall 4: Summary Toast Before Refresh Completes

**What goes wrong:** Summary toast says "3 submitted" but sample status badge still shows old state — user sees inconsistent UI.
**Why it happens:** `onTransitionComplete` (which calls `refreshSample`) is async but `executeBulk` doesn't await it.
**How to avoid:** Either `await onTransitionComplete?.()` if it returns a Promise, OR accept the race (refresh is fast, toast lingers). Check if `refreshSample` returns a Promise in SampleDetails — it currently does not (returns void from `.then()` chain). Toast appears immediately, refresh follows naturally.

### Pitfall 5: indeterminate Visual Not Showing

**What goes wrong:** Header checkbox shows checkmark for both "all selected" and "some selected" states — indeterminate is not visually distinct.
**Why it happens:** The existing `Checkbox` component's `Indicator` only contains `CheckIcon`. Radix Indicator renders for both `checked` AND `indeterminate` but shows the same icon.
**How to avoid:** Update `checkbox.tsx` to conditionally render `Minus` icon when `data-state` is `indeterminate`. Use `useCheckboxContext` or a ref to detect state, OR use Tailwind `data-[state=indeterminate]:hidden` / `data-[state=checked]:hidden` on each icon.

```typescript
// Pattern to update checkbox.tsx Indicator section:
<CheckboxPrimitive.Indicator
  data-slot="checkbox-indicator"
  className="flex items-center justify-center text-current transition-none"
>
  <Minus className="size-3 hidden data-[state=indeterminate]:block" />
  <CheckIcon className="size-3.5 hidden data-[state=checked]:block" />
</CheckboxPrimitive.Indicator>
```

Note: The `data-state` attribute is on the `CheckboxPrimitive.Root`, not on `Indicator`. The `Indicator` itself renders only when state is checked or indeterminate. Use CSS sibling selector trick OR check the Radix docs — the `Indicator` has `data-state` prop too.

Actually verified approach: Radix `CheckboxIndicator` does propagate `data-state` to the rendered span. Use `data-[state=indeterminate]` and `data-[state=checked]` Tailwind variants on the icons.

### Pitfall 6: Header Checkbox Selects Invisible Analyses

**What goes wrong:** "Select All" header checkbox selects analyses hidden by the current filter tab.
**Why it happens:** `selectAll` receives `analyses` (all) instead of `filteredAnalyses` (visible).
**How to avoid:** Always pass `filteredAnalyses.map(...)` to `selectAll`, not `analyses.map(...)`.

## Code Examples

### Sequential Bulk Processing Loop

```typescript
// Source: BatchReview.tsx lines 155-161 (verified codebase) + STATE.md
// for...await — NEVER Promise.all (SENAITE race condition risk)
const executeBulk = useCallback(async (uids: string[], transition: string) => {
  setIsBulkProcessing(true)
  let processed = 0
  const succeeded: string[] = []
  const failed: string[] = []

  for (const uid of uids) {
    processed++
    setBulkProgress({ current: processed, total: uids.length })
    try {
      const response = await transitionAnalysis(
        uid,
        transition as 'submit' | 'verify' | 'retract' | 'reject'
      )
      if (response.success) {
        succeeded.push(uid)
      } else {
        failed.push(uid)
      }
    } catch {
      failed.push(uid)
    }
  }

  onTransitionComplete?.()
  clearSelection()
  setIsBulkProcessing(false)
  setBulkProgress(null)

  const total = uids.length
  if (failed.length === 0) {
    toast.success(`${succeeded.length} of ${total} succeeded`)
  } else {
    toast.warning(`${succeeded.length} succeeded, ${failed.length} failed`, {
      description: `${failed.length} transition(s) failed`
    })
  }
}, [onTransitionComplete, clearSelection])
```

### Indeterminate Header Checkbox State Derivation

```typescript
// Source: derived from Radix UI CheckedState type (verified type definitions)
// Must use filteredAnalyses (not all analyses) for header state
const selectableUids = filteredAnalyses
  .map(a => a.uid)
  .filter((uid): uid is string => !!uid)

const allSelected = selectableUids.length > 0 &&
  selectableUids.every(uid => selectedUids.has(uid))
const someSelected = selectableUids.some(uid => selectedUids.has(uid))

const headerCheckedState: boolean | 'indeterminate' =
  allSelected ? true : someSelected ? 'indeterminate' : false
```

### Bulk Action Intersection Derivation

```typescript
// Source: ALLOWED_TRANSITIONS from AnalysisTable.tsx (verified codebase)
// Reuse existing constant — compute intersection for toolbar buttons
const selectedAnalyses = analyses.filter(
  a => a.uid && selectedUids.has(a.uid)
)

const bulkAvailableActions = (['submit', 'verify', 'retract', 'reject'] as const).filter(t =>
  selectedAnalyses.length > 0 &&
  selectedAnalyses.every(a =>
    a.review_state !== null &&
    a.review_state !== undefined &&
    (ALLOWED_TRANSITIONS[a.review_state] ?? []).includes(t)
  )
)
```

### Toolbar Progress Text

```typescript
// Source: requirements — "Submitting 2/5..."
// Render during processing instead of action buttons
{isBulkProcessing && bulkProgress ? (
  <span className="text-sm text-muted-foreground">
    {TRANSITION_LABELS[activeTransition] ?? activeTransition}ing{' '}
    {bulkProgress.current}/{bulkProgress.total}...
  </span>
) : (
  bulkAvailableActions.map(t => (
    <Button key={t} size="sm" variant={...} onClick={() => handleBulkAction(t)}>
      {TRANSITION_LABELS[t]} selected
    </Button>
  ))
)}
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Individual row clicks only | Checkbox bulk selection | "Submit all" morning workflow = 1 click instead of N |
| N individual toasts for N transitions | Single summary toast post-bulk | Cleaner UX, no toast storm |
| Per-item refresh | Single refresh after loop completes | N fewer re-renders, single spinner flash avoided |

## Open Questions

1. **Destructive bulk actions (retract/reject)**
   - What we know: DESTRUCTIVE_TRANSITIONS (retract, reject) use AlertDialog for per-row, per the STATE.md decision
   - What's unclear: Should bulk retract/reject show an AlertDialog listing all affected analyses before executing?
   - Recommendation: Show a single AlertDialog confirmation before bulk destructive operations. The tentative plan says "Submit selected" is the primary use case — but the toolbar will show retract/reject buttons too when applicable. A single "Confirm retract N analyses?" dialog is the safe default.

2. **Selection persistence during in-flight per-row transitions**
   - What we know: `pendingUids` (per-row) and `selectedUids` (bulk) are independent sets
   - What's unclear: Should selected UIDs that have an active per-row transition be excluded from bulk?
   - Recommendation: Disable the bulk toolbar entirely when `pendingUids.size > 0` (simplest, no partial-exclusion logic)

3. **Post-bulk selected state**
   - What we know: `clearSelection()` is called after bulk completes
   - What's unclear: If 1 of 5 analyses failed, should failed UIDs remain selected?
   - Recommendation: Clear all selections after bulk regardless of outcome. Summary toast communicates the result. Keeping failed selections adds complexity without clear UX value.

## Sources

### Primary (HIGH confidence)

- Live codebase: `src/components/senaite/AnalysisTable.tsx` — current table structure (9 columns, colSpan=9, ALLOWED_TRANSITIONS, filter state)
- Live codebase: `src/hooks/use-analysis-transition.ts` — pendingUids Set pattern, executeTransition, onTransitionComplete callback
- Live codebase: `src/hooks/use-analysis-editing.ts` — hook return type pattern, useCallback structure
- Live codebase: `src/components/BatchReview.tsx` lines 155-161 — `for...await` batch loop pattern
- Live codebase: `src/components/ui/checkbox.tsx` — Radix wrapper, Indicator contains only CheckIcon
- `@radix-ui/react-checkbox@1.3.3` type definitions — `CheckedState = boolean | 'indeterminate'`, `forceMount` on Indicator
- `.planning/STATE.md` — locked decisions: sequential for...await, pendingUids as Set<string>, refreshSample pattern
- `package.json` — `sonner@2.0.7`, `lucide-react@0.561.0`, `@radix-ui/react-checkbox@1.3.3`, all confirmed present

### Secondary (MEDIUM confidence)

- Radix UI Checkbox documentation pattern for indeterminate visual — behavior verified via type signatures

### Tertiary (LOW confidence)

- None — all critical claims verified against live codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified in package.json and source code
- Architecture: HIGH — patterns derived from existing Phase 07 hooks and BatchReview.tsx
- Pitfalls: HIGH — derived from direct code inspection (colSpan count, Indicator icon, filter scope)
- Open questions: MEDIUM — design choices not yet decided, noted with recommendations

**Research date:** 2026-02-25
**Valid until:** 2026-03-25 (stable domain, UI-only change, no external dependencies changing)
