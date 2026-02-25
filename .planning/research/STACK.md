# Technology Stack — Inline Analysis Editing + Workflow Transitions

**Project:** Accu-Mk1
**Milestone:** Inline result editing, row selection, bulk workflow actions in SampleDetails
**Researched:** 2026-02-24
**Research mode:** Stack dimension — focused on what is NEW for this capability

---

## Verdict: No New Libraries Required

The existing stack already contains every primitive needed. This milestone is an
implementation task against existing dependencies, not a dependency acquisition task.

Adding libraries for problems already solved by `@tanstack/react-table` and
`@tanstack/react-query` would introduce duplication and conflict with the existing
`DataTable` component.

---

## Existing Stack Audit — What Each Library Provides

### @tanstack/react-table — v8.21.3 (already installed)

The existing `DataTable` component (`src/components/ui/data-table.tsx`) already uses
this library. The analyses table in `SampleDetails.tsx` is currently a raw `<table>`
element — it is NOT wired to TanStack Table. Migrating it opens all of v8's features
at zero extra dependency cost.

TanStack Table v8 ships these capabilities natively:

| Capability | API surface | Notes |
|---|---|---|
| Row selection state | `RowSelectionState` (Record&lt;string, boolean&gt;) | Built into core |
| Per-row selectability | `enableRowSelection: (row) => boolean` | Can restrict to `review_state === 'unassigned'` |
| Checkbox column | `getIsSelected()`, `getToggleSelectedHandler()` | Standard column def pattern |
| Select-all header | `table.getIsAllRowsSelected()`, `table.toggleAllRowsSelected()` | Header checkbox |
| Read selected set | `table.getSelectedRowModel().rows` | Used by bulk action toolbar |
| Inline cell editing | `meta.updateData(rowIndex, columnId, value)` | Official `tableMeta` pattern |

Source: TanStack Table v8 Row Selection guide and Editable Data example (official docs).

**Critical: `'use no memo'` requirement.** The existing `DataTable` already carries
this directive (line 42 of `data-table.tsx`) plus the
`// eslint-disable-next-line react-hooks/incompatible-library` comment on `useReactTable`.
Any new component calling `useReactTable` must reproduce this exact pattern.

This is a confirmed, ongoing incompatibility between TanStack Table v8 and the React
Compiler. The React Compiler recognises `@tanstack/react-table` as a known incompatible
library and skips memoisation of components using it, because `useReactTable` uses
interior mutability (returns a mutable object whose methods change without the
reference changing). The `'use no memo'` directive is the documented workaround.
Source: github.com/facebook/react/issues/33057, github.com/TanStack/table/issues/6137.

### @tanstack/react-query — v5.90.12 (already installed)

TanStack Query v5 `useMutation` handles optimistic updates for workflow transitions.

**Two patterns available in v5:**

**Pattern A — cache-based (for queries managed by TanStack Query):**
```
onMutate → cancelQueries → getQueryData → setQueryData (optimistic) → return snapshot
onError → setQueryData (rollback from snapshot)
onSettled → invalidateQueries
```

**Pattern B — UI-state-based (for data in useState, not a query cache):**
```
onMutate → snapshot local state → setLocalState (optimistic)
onError → setLocalState (rollback from snapshot)
onSettled → refetch manually if needed
```

`SampleDetails.tsx` currently uses `useState` + manual `fetch` calls, not TanStack
Query. **Pattern B is the correct match.** The existing `EditableField.tsx` already
implements this exact approach at lines 80-107 (snapshot `previousValue`, call
`onSaved?.(newValue)` optimistically, rollback via `onSaved?.(previousValue)` in
catch). For bulk mutations, `useMutation` wraps the same logic with a cleaner API.

Source: TanStack Query v5 Optimistic Updates guide (tanstack.com/query/v5/docs).

### shadcn/ui — existing components cover all UI needs

| UI need | Existing component | Already in project |
|---|---|---|
| Cell input while editing | `<Input>` | Yes — `src/components/ui/input.tsx` |
| Save/Cancel buttons | `<Button>` | Yes |
| Row selection checkbox | `<Checkbox>` | Yes — `src/components/ui/checkbox.tsx` |
| Floating/sticky toolbar | Tailwind `sticky bottom-*` | Yes — utility classes |
| Toast feedback on save | `sonner` v2.0.7 | Yes — `src/components/ui/sonner.tsx` |
| Status badge | `<Badge>` | Yes |

The shadcn bulk-actions table block (shadcn.io/blocks/tables-bulk-actions) is a
Pro (paid) component. It is not needed. The floating toolbar pattern it implements
is a conditionally-rendered `div` with `position: sticky` — approximately 15 lines
of Tailwind. Building it directly is faster than purchasing the block and integrating
it.

### FastAPI backend — SENAITE adapter already has result submission

The integration service already exposes:

| Endpoint | Purpose |
|---|---|
| `GET /senaite/{sample_id}/analyses` | Fetch analyses with UID, keyword, review_state |
| `POST /senaite/{sample_id}/results` | Submit results: sets Result field, then transitions to "submit" |

The SENAITE adapter's `submit_analysis_result` (senaite.py lines 901-996) already
implements the two-step SENAITE workflow: POST `{"Result": value}` then POST
`{"transition": "submit"}` against the same UID endpoint. This backend work is done.

---

## Architecture Decisions

### Decision 1: Migrate analyses table to TanStack Table — RECOMMENDED

The current analyses table in `SampleDetails.tsx` (lines 1231-1281) is a raw
`<table>` element. To add row selection checkboxes and per-cell edit state without
turning the render method into a mess of local index-keyed state, TanStack Table's
column definition model is the appropriate structure.

**Concretely:** Extract a new `AnalysesTable` component that calls `useReactTable`.
The component must open with `'use no memo'`. Pass `data`, `sampleId`, and
`onResultsChanged` as props. Keep `SampleDetails` as the data owner.

The existing `DataTable` component in `data-table.tsx` is the model for this —
look at how it configures `useReactTable` and wraps the shadcn `Table` components.
The new component will add `enableRowSelection` and `meta.updateData` on top of
that existing pattern.

Column definitions for the analyses table:

```
select     — Checkbox (only enabled when review_state === 'unassigned')
analysis   — Analysis title (read-only, formatted via analyteNameMap)
result     — Inline editable cell (Input in edit mode, value display otherwise)
unit       — Read-only
method     — Read-only
instrument — Read-only
analyst    — Read-only
status     — StatusBadge (read-only)
captured   — Formatted date (read-only)
```

### Decision 2: Keep SampleDetails on useState, not TanStack Query — RECOMMENDED for this milestone

Migrating `SampleDetails` to `useQuery` is a worthwhile future improvement but is
not required for this milestone. Migrating it now would be scope creep. The optimistic
pattern in Pattern B (UI-state-based) works correctly with `useState`.

### Decision 3: Row selection state in useState, not Zustand — REQUIRED by architecture rules

Row selection state is transient, component-scoped UI state. It does not persist
between sessions and is not shared across components. Per AGENTS.md's state management
onion: `useState` → Zustand → TanStack Query. Row selection belongs in `useState`
local to `AnalysesTable`.

Do NOT put `rowSelection` in `useUIStore`. The Zustand store is for global UI state
shared across multiple components.

### Decision 4: Floating bulk toolbar — pure Tailwind, no library

The toolbar renders only when `Object.keys(rowSelection).length > 0`. Sticky
positioning at the bottom of the analyses card is sufficient. The toolbar calls
`useMutation` to POST the selected analyses' results.

Reference pattern:
```tsx
// Inside AnalysesTable, after the <table>
{Object.keys(rowSelection).length > 0 && (
  <div className="sticky bottom-4 z-10 mt-4 flex items-center justify-between gap-3
                  px-4 py-2.5 rounded-lg border border-border bg-background shadow-lg">
    <span className="text-sm text-muted-foreground">
      {Object.keys(rowSelection).length} selected
    </span>
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        disabled={submitMutation.isPending}
        onClick={handleBulkSubmit}
      >
        Submit Results
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>
        Clear
      </Button>
    </div>
  </div>
)}
```

### Decision 5: Inline cell editing uses local draft state, not tableMeta.updateData

The tableMeta `updateData` pattern is designed for scenarios where the table itself
is the data owner. In this app, `SampleDetails` owns the data (via `useState`).

The correct pattern for cell-level inline editing matches what `EditableField.tsx`
already does:

1. Each editable cell maintains its own `editing: boolean` and `draft: string` in
   local `useState`
2. On save: call `POST /senaite/{sampleId}/results` via `useMutation`
3. Optimistic update: call `onResultSaved(rowIndex, newValue)` callback before await
4. On error: rollback via `onResultSaved(rowIndex, previousValue)` in `onError`
5. `SampleDetails` propagates the update into its `data` state to keep the
   table reactive

This is consistent with the existing `EditableField` / `EditableDataRow` pattern
already used throughout `SampleDetails.tsx`.

---

## Backend Gap: SenaiteAnalysis type lacks uid and keyword

**This is the primary blocker for result submission.**

The `SenaiteAnalysis` interface in `src/lib/api.ts` (line 2016) has `title`,
`result`, `unit`, `method`, `instrument`, `analyst`, `due_date`, `review_state`,
`sort_key`, `captured`, `retested` — but **no `uid` and no `keyword`**.

The submit endpoint (`POST /senaite/{sample_id}/results`) requires the analysis
`keyword` to route to the correct analysis UID on the backend.

**Fix options:**

1. **Enrich the existing `/wizard/senaite/lookup` response** to include `uid` and
   `keyword` in each analysis item. The backend's `get_analyses_for_sample` method
   already returns `AnalysisInfo` objects with both fields — they just need to be
   surfaced through the lookup route. This is the cleaner option: single fetch,
   no waterfall.

2. **Second fetch in `SampleDetails`** to `GET /senaite/{sampleId}/analyses` after
   the main lookup, merging results by title. More requests, more complexity.

Recommendation: Option 1. Update the Python `/wizard/senaite/lookup` handler and
the `SenaiteLookupResult` / `SenaiteAnalysis` TypeScript types together.

---

## What NOT to Add

| Library | Why NOT |
|---|---|
| `react-hook-form` | Per-cell inline editing uses `useState` draft values. This is the existing `EditableField` pattern. No form layer is needed. |
| `zod` | No schema validation layer needed for individual result values. The SENAITE backend validates on submission. |
| Any step-wizard library | Not applicable to this milestone. |
| `react-table-library` | Redundant — TanStack Table is installed and used. |
| Floating UI / Popper | Not needed. The bulk action bar is sticky-positioned, not anchored to a reference element. |
| `@dnd-kit/*` | No drag-and-drop in scope for this milestone. |
| shadcn bulk-actions Pro block | The pattern is ~15 lines of Tailwind; the block is paywalled. |

---

## Complete Dependency Changes

### Frontend — no new packages

No `npm install` needed.

### Backend — no new packages

No new pip packages needed. The `submit_analysis_result` endpoint is already
implemented. Backend work is limited to enriching the existing lookup route to
return `uid` and `keyword` per analysis.

### New TypeScript types needed (changes to existing files)

```typescript
// src/lib/api.ts — extend SenaiteAnalysis
export interface SenaiteAnalysis {
  uid: string | null          // ADD — needed for result submission routing
  keyword: string | null      // ADD — needed for submit endpoint
  title: string
  result: string | null
  unit: string | null
  method: string | null
  instrument: string | null
  analyst: string | null
  due_date: string | null
  review_state: string | null
  sort_key: number | null
  captured: string | null
  retested: boolean
}
```

---

## Confidence Assessment

| Area | Confidence | Basis |
|---|---|---|
| TanStack Table row selection API | HIGH | Official docs, confirmed against installed v8.21.3 |
| `'use no memo'` requirement | HIGH | GitHub issue confirmed, existing DataTable already handles it |
| TanStack Query v5 useMutation optimistic pattern | HIGH | Official docs, consistent with EditableField.tsx existing pattern |
| shadcn components sufficient for UI | HIGH | All components already in project, verified in source |
| Backend submit endpoint exists | HIGH | Verified directly in integration-service/app/adapters/senaite.py and desktop.py |
| uid/keyword missing from SenaiteAnalysis | HIGH | Verified by reading src/lib/api.ts line 2016 |
| No new npm packages needed | HIGH | Cross-checked TanStack Table v8 feature list against all requirements |

---

## Sources

- TanStack Table v8 Row Selection guide: [https://tanstack.com/table/v8/docs/guide/row-selection](https://tanstack.com/table/v8/docs/guide/row-selection)
- TanStack Table v8 Editable Data example: [https://tanstack.com/table/latest/docs/framework/react/examples/editable-data](https://tanstack.com/table/latest/docs/framework/react/examples/editable-data)
- TanStack Query v5 Optimistic Updates: [https://tanstack.com/query/v5/docs/framework/react/guides/optimistic-updates](https://tanstack.com/query/v5/docs/framework/react/guides/optimistic-updates)
- React Compiler / TanStack Table incompatibility: [https://github.com/facebook/react/issues/33057](https://github.com/facebook/react/issues/33057)
- TanStack Table incompatible-library issue: [https://github.com/TanStack/table/issues/6137](https://github.com/TanStack/table/issues/6137)
- shadcn bulk actions table block: [https://www.shadcn.io/blocks/tables-bulk-actions](https://www.shadcn.io/blocks/tables-bulk-actions)
- Existing DataTable `'use no memo'` pattern: `src/components/ui/data-table.tsx` line 42 (verified by reading file)
- Existing EditableField optimistic pattern: `src/components/dashboard/EditableField.tsx` lines 80-107 (verified by reading file)
- SENAITE submit_analysis_result two-step pattern: `integration-service/app/adapters/senaite.py` lines 901-996 (verified by reading file)
- SenaiteAnalysis type gap: `src/lib/api.ts` line 2016 (verified by reading file)
