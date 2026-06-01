# Order Explorer + Order Dashboard SLA — close the order-surface coverage gap

*Spec, 2026-06-01. Follows the SLA tier model, order-list SLA column (D2), per-group multi-tier follow-on, analysis-services SLA column, and the worksheet/inbox SLA indicator.*

## Summary

Two order-listing surfaces still show the pre-SLA hardcoded elapsed-time coloring that the SLA feature was built to replace: **OrderExplorer** (the all-orders table, "Processing Time" column colored green/yellow by WP status) and **OrderDashboard** (the "Outstanding Orders" work queue, orange "Age" column). Both render the same `ExplorerOrder` rows that OrderStatusPage and CustomerStatusPage already show with proper red/amber/green SLA — but they render their own tables instead of `OrderRow`, so they slipped past the SLA wiring.

This work wires both surfaces to the existing `useOrderSlaStatuses` + `OrderSlaCell` path, replacing the hardcoded elapsed-time columns with the standard SLA indicator. The per-sample SENAITE-lookup-map chain — currently duplicated inline in OrderStatusPage and CustomerStatusPage — is extracted into a shared `useSenaiteLookupMap(orders)` hook, and those two existing pages are retrofitted onto it (pure DRY, no behavior change).

## Goals

1. Show the standard SLA indicator (red/amber/green + hover breakdown) on OrderExplorer and OrderDashboard, replacing their hardcoded elapsed-time columns.
2. Extract the duplicated SENAITE-lookup-map boilerplate into one tested hook.
3. Retrofit OrderStatusPage + CustomerStatusPage onto the extracted hook, deleting their inline copies.
4. Reuse the shared `['senaite','lookup',id]` query cache so warm lookups are not re-fetched across surfaces.

## Non-goals

- No backend or schema change. `useOrderSlaStatuses` and `/sla/status` already exist.
- No change to `OrderSlaCell`, `useOrderSlaStatuses`, or the SLA resolution logic.
- No new i18n keys — these surfaces use hardcoded English headers (project convention for internal screens).
- Not enhancing `OrderSlaCell` to show a frozen "took Xh" on completed orders (deferred — see Completed-orders tradeoff).

## Decisions captured during brainstorming

| Decision | Value |
|---|---|
| Fetch strategy | Both surfaces fetch per-sample SENAITE lookups (shared 15-min cache; Explorer paginated, Dashboard capped at 25) |
| Column treatment | Replace the existing elapsed-time column with the SLA indicator on both |
| Architecture | Extract `useSenaiteLookupMap(orders)`; both new surfaces + retrofit the two existing pages onto it (Approach A + retrofit) |
| Completed-orders duration | Accept the loss of the raw "took Nd" number on completed Explorer rows — Created/Completed columns bracket the span; SLA met/missed is the decision-relevant signal |

## Architecture

The duplicated chain has two halves with a seam OrderStatusPage depends on:

```
orders
  │
  ▼
useSenaiteLookupMap(orders)            ← NEW extracted hook
  │  sampleIds (unique, skip failed/empty)
  │  useQueries(enqueueSenaiteLookup)  (serialized, staleTime 15min, shared cache key)
  │  build Map<senaiteId, {data?, isLoading, isError}>
  ▼
{ sampleLookupMap, sampleIds, isLoading, isError }
  │
  ├── (OrderStatusPage only) filteredOrders predicate reads sampleLookupMap ──┐
  │                                                                            │
  ▼                                                                            ▼
useOrderSlaStatuses(<orders-or-filteredOrders>, sampleLookupMap)   (EXISTING, unchanged)
  ▼
verdictByOrderId → <OrderSlaCell verdict={...} isLoading isError />
```

Two units, split at the natural seam (map ←→ verdict), because OrderStatusPage builds the map from the full `orders` set, filters orders *using* the map, then computes verdicts on the filtered subset. A single monolithic `useOrderSlaForList` could not expose that mid-pipeline map (also read by OrderStatusPage's `attentionCount`). `useOrderSlaStatuses` is unchanged and continues to take the map as input.

## Components & files

### New files

| File | Responsibility |
|---|---|
| `src/services/senaite-lookup-map.ts` | `useSenaiteLookupMap(orders)` hook: sampleIds collection + serialized `useQueries` + map build. Returns `{ sampleLookupMap, sampleIds, isLoading, isError }`. |
| `src/test/senaite-lookup-map.test.tsx` | Hook tests. |

### Changed — new SLA consumers

| File | Change |
|---|---|
| `src/components/OrderExplorer.tsx` | Call `useSenaiteLookupMap(filteredOrders)` + `useOrderSlaStatuses(filteredOrders, sampleLookupMap)`; replace the `processing_time` `ColumnDef` cell body with `<OrderSlaCell verdict={verdictByOrderId.get(row.original.order_id)} isLoading={slaIsLoading} isError={slaIsError} />`; rename header `"Processing Time"` → `"SLA"`. Remove now-unused `formatProcessingTime` import if no other consumer. |
| `src/components/dashboard/OrderDashboard.tsx` | Call the two hooks over the displayed `[...outstandingOrders, ...failedOrders].slice(0, 25)` set (hoist that slice to a memo so the hook and the render share one reference); replace the orange "Age" `<TableCell>` with `<OrderSlaCell>`; rename `<TableHead>` `"Age"` → `"SLA"`. Remove now-dead `formatRelativeDate` helper (only the Age cell used it — verify and delete). |

### Changed — retrofit (pure DRY, no behavior change)

| File | Change |
|---|---|
| `src/components/OrderStatusPage.tsx` | Delete inline `sampleIds` memo, `sampleQueries` `useQueries`, and `sampleLookupMap` memo (~40 lines). Replace with `const { sampleLookupMap } = useSenaiteLookupMap(orders)`. Keep `filteredOrders` (reads `sampleLookupMap`), `useOrderSlaStatuses(filteredOrders, sampleLookupMap)`, and `attentionCount` exactly as-is. Drop now-unused `useQueries` + `enqueueSenaiteLookup` imports (and `SenaiteLookupResult` only if no longer referenced). |
| `src/components/CustomerStatusPage.tsx` | Same deletion + `const { sampleLookupMap } = useSenaiteLookupMap(orders)`. Keep existing `useOrderSlaStatuses(orders, sampleLookupMap)` and downstream usages. Drop now-unused imports. |

### Hook contract — `useSenaiteLookupMap`

```ts
import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { type ExplorerOrder, type SenaiteLookupResult } from '@/lib/api'
import { enqueueSenaiteLookup } from '@/components/explorer/senaite-queue'

export interface SenaiteLookupEntry {
  data?: SenaiteLookupResult
  isLoading: boolean
  isError: boolean
}

export interface SenaiteLookupMapResult {
  /** senaiteId → lookup query state. Keyed by senaite_id (human sample id). */
  sampleLookupMap: Map<string, SenaiteLookupEntry>
  /** Unique senaite_ids collected from the orders (skip failed/empty). */
  sampleIds: string[]
  /** True while any underlying per-sample lookup is still loading. */
  isLoading: boolean
  /** True if any underlying per-sample lookup errored. */
  isError: boolean
}

export function useSenaiteLookupMap(orders: ExplorerOrder[]): SenaiteLookupMapResult
```

**Behavior (verbatim from the current inline chains — they are byte-identical across OrderStatusPage and CustomerStatusPage):**
1. `sampleIds`: iterate `orders`; for each `order.sample_results` entry, push `entry.senaite_id` when it is truthy AND `entry.status !== 'failed'` AND not already collected (dedupe). Memoized on `orders`.
2. `sampleQueries = useQueries(...)` — one query per id: `queryKey: ['senaite','lookup', id]`, `queryFn: () => enqueueSenaiteLookup(id)`, `staleTime: 15 * 60_000`, `retry: 1`.
3. `sampleLookupMap`: memoized; for each `(id, idx)` set `{ data: q.data, isLoading: q.isLoading ?? true, isError: q.isError ?? false }`.
4. `isLoading = sampleQueries.some(q => q.isLoading)`; `isError = sampleQueries.some(q => q.isError)` (new aggregate fields — the inline versions didn't expose these, but they're needed so the new surfaces can pass `isLoading`/`isError` into `OrderSlaCell`).

### Cell wiring

Both new surfaces render the existing `OrderSlaCell`:
```tsx
<OrderSlaCell
  verdict={verdictByOrderId.get(order.order_id)}
  isLoading={slaIsLoading}
  isError={slaIsError}
/>
```
`verdict` may be `undefined` (order has no resolvable SLA) — `OrderSlaCell` already handles that as the `awaiting` state (renders `—`). The component supplies the hover `SlaBreakdownTooltip` for active/met states automatically.

- **OrderExplorer:** the cell goes in the `processing_time` column's `cell: ({ row }) => ...`. The two hooks run in the `OrderExplorer` component body (top level, unconditional); `verdictByOrderId`/`slaIsLoading`/`slaIsError` are closed over by the column def. Note: `ordersColumns` must be built where those values are in scope (it already is — it's defined in the component body), and should be wrapped in `useMemo` keyed on the SLA values if it isn't already, so the column defs pick up verdict changes. Read the current `ordersColumns` definition: if it's a plain `const` rebuilt each render, leave it (it already re-closes over fresh values each render); if memoized, add the SLA values to deps.
- **OrderDashboard:** the cell replaces the `<TableCell className="...text-orange-400...">` Age cell inside the existing `.map`. `verdictByOrderId.get(o.order_id)` per row.

## Completed-orders tradeoff (explicit)

OrderExplorer's "Processing Time" column showed total elapsed time for completed orders (e.g. "18d 4h"), colored green when complete. `OrderSlaCell` renders an all-published order as the `met` state (✓, muted) with an "all samples published" tooltip — it does **not** show a duration. Replacing the column therefore drops the raw completed-duration number from Explorer rows.

**Decision: accept it.** The "Created" and "Completed" columns already sit adjacent and bracket the historical span for completed orders, and the SLA met/missed signal is more decision-relevant on a live work surface. Enhancing `OrderSlaCell` to render a frozen "took Xh" on the met state is a larger change to a component shared by three live pages and is deferred to a possible follow-on.

## Edge cases

| Edge | Behavior |
|---|---|
| Order with no `sample_results` | `verdictByOrderId.get()` → undefined → `OrderSlaCell` `awaiting` (`—`). Matches OrderStatusPage. |
| Cold visit, lookups fetching | `slaIsLoading` true → loading dot until per-sample lookups resolve; `keepPreviousData` in `useOrderSlaStatuses` smooths refetches. |
| Dashboard 25-cap | Hook fires lookups only for the ≤25 displayed orders. Bounded. |
| Explorer pagination | Hook keyed on current page's `filteredOrders`; page change → new (mostly warm) lookup set. |
| All-published order | `met` ✓ (completed-duration tradeoff above). |
| Shared cache | `['senaite','lookup',id]` identical across all 4 surfaces → warm reuse, no double-fetch. |
| Retrofit seam (OrderStatusPage) | Map built from full `orders` (superset of `filteredOrders`); filtered lookups always present. `attentionCount` continues to read the same map. No behavior change. |

## Test plan (TDD)

### `senaite-lookup-map.test.tsx` (~5 tests)
1. Empty orders → empty `sampleLookupMap`, empty `sampleIds`, `isLoading === false`.
2. Collects unique senaite_ids across orders; **skips** entries with `status === 'failed'` and null/empty `senaite_id`.
3. Dedupes the same senaite_id appearing in multiple orders.
4. `sampleLookupMap` carries `{ data, isLoading, isError }` per id from the matching query.
5. `isLoading` aggregates true while any query loads; `isError` true if any errors.

(Mock `enqueueSenaiteLookup` + use a `QueryClient` wrapper, mirroring `sample-sla.test.tsx` / `order-sla.test.tsx` patterns.)

### Retrofit regression guard
- Run existing `src/test/order-row.test.tsx` and `src/test/customer-status-page.test.tsx` after the OrderStatusPage/CustomerStatusPage retrofit — they must stay green (proves the extraction is behavior-preserving).

### New-surface coverage
- OrderExplorer and OrderDashboard have **no existing test suites**. No new render suites are added in this work — the SLA path is already unit-tested via `order-sla.test.tsx` (hook) and `order-sla-cell.test.tsx` (cell); these are thin integration sites. Coverage is the shared hook test + manual smoke.

### Manual smoke (post-implementation, on `:3101`)
- **OrderExplorer:** all-orders table shows an "SLA" column (was "Processing Time") with red/amber/green per in-flight order; completed orders show `met ✓`; hover → breakdown tooltip.
- **OrderDashboard:** "Outstanding Orders" queue shows an "SLA" column (was orange "Age").
- **OrderStatusPage + CustomerStatusPage:** SLA column unchanged from before (retrofit is invisible); no double-fetch (cache shared); analysis-state filter + attention count still work.
- Confirm no console errors and lookups don't burst beyond the displayed page/cap.

## Reused as-is

- `src/services/order-sla.ts` — `useOrderSlaStatuses`, `OrderSlaVerdict`.
- `src/components/explorer/OrderSlaCell.tsx`.
- `src/components/explorer/senaite-queue.ts` — `enqueueSenaiteLookup`.
- `src/lib/api.ts` — `ExplorerOrder`, `SenaiteLookupResult`.

## Files quick-index

- New: `src/services/senaite-lookup-map.ts`, `src/test/senaite-lookup-map.test.tsx`
- Changed (feature): `src/components/OrderExplorer.tsx`, `src/components/dashboard/OrderDashboard.tsx`
- Changed (retrofit): `src/components/OrderStatusPage.tsx`, `src/components/CustomerStatusPage.tsx`
