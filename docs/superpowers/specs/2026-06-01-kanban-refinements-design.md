# Spec: Order Status / Kanban refinements

*2026-06-01. Three UI refinements on the Order Status page (`OrderStatusPage.tsx`), continuing the `feat/order-status-filters` branch.*

## What & why

1. **Hide "Pending" everywhere** — Pending reflects SENAITE's unassigned-analysis
   state, which Accu-Mk1 worksheets don't drive (SENAITE is being phased out), so it's
   misleading noise. Remove it from the Kanban columns and the stage-filter chips.
2. **Collapsible Kanban columns (flat view)** — let staff collapse/re-open individual
   columns to hide noise. State persists across refreshes.
3. **Fix Kanban card SLA squish** — the multi-group SLA lines get crammed next to the
   sample-state text; give them their own full-width row.

No backend/API/locale changes. Web-only.

## Decisions (resolved)

- **Hide Pending: everywhere** — Kanban column AND stage-filter chip. Also strip any
  stale `'pending'` from a loaded `activeStates` so no orphaned filter persists.
- **Collapse: persists in localStorage** (`OrderFilters.collapsedKanbanCols: string[]`).
- **Collapse scope: flat Kanban mode only** — grouped/swimlane mode has no per-column
  headers, so no toggle location. Out of scope here.
- Collapse toggle reuses the existing `toggleFilterKey` helper.

## Current state (verified)

- `KANBAN_COLUMNS` (`:80-90`) includes `{ key: 'pending', ... }` at index 2.
- `ANALYSIS_STATE_BUTTONS` (`:478-488`) includes the `pending` chip.
- `groupAnalysisStates` (`helpers.tsx:23-60`) computes `pending` (analysis-level count)
  — leave intact; just stop surfacing it.
- Flat-Kanban column header: `OrderStatusPage.tsx:391-398` (label + count Badge).
- Grid template: `:385` (flat) — `repeat(${visibleCols.length}, minmax(180px, 1fr))`.
- `KanbanSampleCard` Row 2: `:263-295` — `flex justify-between` with
  `#order · Sample: <state>` (left) and `SampleSlaIndicator` OR processing-time (right).
- `OrderFilters` interface + `loadOrderFilters` default: `:494-526`.

## Design

### Part 1 — Hide Pending

- Remove the `{ key: 'pending', ... }` line from `KANBAN_COLUMNS`.
- Remove the `{ key: 'pending', ... }` line from `ANALYSIS_STATE_BUTTONS`.
- In `loadOrderFilters`, after parsing persisted filters, strip `'pending'` from
  `activeStates` (`activeStates: parsed.activeStates.filter(s => s !== 'pending')`)
  so a previously-saved Pending filter can't persist with no chip to clear it.

### Part 2 — Collapsible Kanban columns

- Add `collapsedKanbanCols: string[]` to `OrderFilters` (default `[]`); persisted via the
  existing `saveOrderFilters`.
- Add a `toggleCollapsedCol(key)` handler in the component:
  `updateFilters({ collapsedKanbanCols: toggleFilterKey(orderFilters.collapsedKanbanCols, key) })`.
- Pass `collapsedCols` + `onToggleCollapse` into `KanbanView`.
- Flat-mode rendering:
  - Per-column grid track: collapsed → `minmax(40px, auto)`, expanded → `minmax(180px, 1fr)`,
    built by mapping `visibleCols`.
  - Column header gains a chevron button (`ChevronDown` when expanded, `ChevronRight`
    when collapsed) that calls `onToggleCollapse(col.key)`. When collapsed, the column
    renders only its header (chevron + count Badge; label hidden but set as `title`),
    and the card body is omitted.
- Grouped/swimlane mode: unchanged (no per-column headers).

### Part 3 — Card SLA on its own row

- In `KanbanSampleCard`, Row 2 keeps `#order · Sample: <state>` on the left and the
  processing-time fallback (published / no `date_received`) on the right.
- Move `SampleSlaIndicator` to a new full-width row BELOW Row 2, rendered only when
  `item.lookup?.date_received && item.lookup.review_state !== 'published'`:
  ```tsx
  {item.lookup?.date_received && item.lookup.review_state !== 'published' && (
    <div className="mt-0.5">
      <SampleSlaIndicator snapshots={sampleSlaStatusesMap?.get(item.sampleId)} />
    </div>
  )}
  ```
- Remove the SLA branch from Row 2's right side; Row 2's right side now only shows the
  processing-time span (for the non-SLA case). When SLA applies, Row 2 right is empty
  and the SLA row carries the indicator.

## Testing

- Collapse logic reuses `toggleFilterKey` (already unit-tested in `order-filters.test.ts`).
- The rest is constant-array edits + JSX re-layout with no OrderStatusPage test harness,
  so verification is `npm run typecheck` + scoped `npx eslint` + manual smoke on `:3101`
  (same approach approved for the prior task). No new test files.

## Files

- `src/components/OrderStatusPage.tsx` — only file. Reuses `toggleFilterKey` and the
  `ChevronDown`/`ChevronRight` lucide icons (confirm import; `lucide-react` is already used).

## Out of scope

- Column collapse in grouped/swimlane mode; reordering columns; saved column presets;
  changing what `Pending` means (covered separately if the page is ever rewired to
  Accu-Mk1 worksheet assignment).
