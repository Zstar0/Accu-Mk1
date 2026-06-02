# Spec: Order Status page filter enhancements

*2026-06-01. Two filter behaviors on the Order Status page (`OrderStatusPage.tsx`).*

## What & why

Lab staff triaging the Order Status page need two filtering improvements:

1. **Multi-select stage filters** — today clicking a stage chip (Received, Pending,
   Assigned, …) replaces the selection; you can only view one stage at a time.
   Staff want to toggle several stages on at once and see orders matching **any**
   of them.
2. **"SLA at-risk" toggle** — a single top-row toggle that filters the list to
   orders that are **approaching or past** their SLA target (amber + red), so staff
   can immediately see what needs attention.

No backend or API changes. Web-only surface.

## Decisions (resolved)

- **At-risk = amber + red** (approaching target OR overdue). Green / met / awaiting /
  loading / error are excluded when the toggle is on.
- **Combination:** the SLA toggle **ANDs** with stage filters and text filters (it's
  a further narrowing). Multiple selected **stages OR together** (existing behavior).
- **Placement:** the SLA toggle sits in Row 1 of the filter bar, **immediately to the
  right of the "All Orders" button** (`OrderStatusPage.tsx:805-815`).
- **Persistence:** `slaAtRisk` persists in the existing `order-status-filters`
  localStorage blob, like the other filters. `activeStates` already persists.
- **Loading SLA:** orders whose SLA verdict is still loading/awaiting are **excluded**
  while the toggle is on (only known-at-risk shown). Acceptable — they reappear once
  resolved or when the toggle is off.

## Current state (verified)

- `toggleState(key)` (`OrderStatusPage.tsx:551`) currently does
  `activeStates: activeStates[0] === key ? [] : [key]` — single-select.
- Stage button rendering already uses `active = activeStates.includes(btn.key)`
  (`:954`) and `sampleMatchesAnalysisFilter` already ORs across the array via
  `.some()` (`helpers.tsx:192`). **Multi-select is purely a `toggleState` change.**
- The existing **"Active"** stage button (clears `activeStates`) serves as
  "clear all stages."
- `orderSla.verdictByOrderId` (`:650`) exposes per-order verdict `color`
  (`red | amber | green | met | awaiting | loading | error`).
- `filteredOrders` is consumed in 4 render spots: count (`:1028`), empty-state
  (`:1048`), table map (`:1069`), kanban (`:1088`).

## Design

### 1. Multi-select stage filters

- New pure helper `toggleFilterKey(keys: string[], key: string): string[]` —
  returns `keys` with `key` removed if present, else appended. Unit-tested.
- `toggleState` calls it: `updateFilters({ activeStates: toggleFilterKey(orderFilters.activeStates, key) })`.
- No rendering or filter-logic change (both already handle multi).

### 2. SLA at-risk toggle

- Add `slaAtRisk: boolean` to the `OrderFilters` interface + `loadOrderFilters`
  default (`false`).
- New pure helper `isOrderAtRisk(verdict: OrderSlaVerdict | undefined): boolean` →
  `verdict?.color === 'red' || verdict?.color === 'amber'`. Unit-tested.
- New `displayedOrders` memo, derived from `filteredOrders` + `orderSla`:
  - when `orderFilters.slaAtRisk` is true → `filteredOrders.filter(o => isOrderAtRisk(orderSla.verdictByOrderId.get(o.order_id)))`
  - else → `filteredOrders`
  - depends on `[filteredOrders, orderFilters.slaAtRisk, orderSla.verdictByOrderId]`.
  - `orderSla` continues to be computed from `filteredOrders` (superset), so verdicts
    for the narrowed set are always present.
- Repoint the 4 render consumers from `filteredOrders` → `displayedOrders`
  (count, empty-state, table map, kanban).
- **UI:** a toggle button in Row 1 immediately after "All Orders". Warning-styled to
  read as a different axis from the stage chips (amber/red accent when active, ⚠
  icon), label "SLA at-risk", with a count badge = number of at-risk orders in the
  current `filteredOrders` (`filteredOrders.filter(isOrderAtRisk).length`). Toggling
  flips `slaAtRisk` via `updateFilters`.

## Testing (TDD)

- Pure helpers in a new module `src/components/explorer/order-filters.ts` so they're
  unit-testable without rendering:
  - `toggleFilterKey`: add when absent, remove when present, independent of order.
  - `isOrderAtRisk`: true for red/amber; false for green/met/awaiting/loading/error/undefined.
- Component test (follow `customer-status-page.test.tsx` pattern): selecting two stage
  chips shows orders matching either; enabling the SLA toggle narrows to amber+red and
  ANDs with an active stage filter.

## Files

- `OrderStatusPage.tsx` — `OrderFilters.slaAtRisk`, default, `toggleState` rewrite,
  `displayedOrders` memo, repoint 4 consumers, the new toggle button.
- New module `src/components/explorer/order-filters.ts` (`toggleFilterKey`,
  `isOrderAtRisk`) + `src/test/order-filters.test.ts`.
- No new locale strings: the "SLA at-risk" button label is literal English, matching
  the existing filter-bar buttons ("Open Orders", "All Orders", "Active").

## Out of scope

- Sorting by SLA, per-stage SLA breakdown, saved filter presets, kanban-column SLA
  filtering beyond the shared `displayedOrders` narrowing.
