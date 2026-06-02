# Spec: Order Status client-side analyte filter

*2026-06-01. Adds an analyte search box to the Order Status page, client-side. Continues `feat/order-status-filters`.*

## What & why

Staff want to filter the Order Status list by analyte (e.g. "BPC-157"), like the
analyte search on the Customer Detail page. The Customer Detail version is
server-side (integration-service regex on `payload.samples[*].sample_identity`),
but that field isn't in the Order Status page's `ExplorerOrder` data, and this
page filters client-side. Per decision, do a **client-side** version that matches
the analysis names already shown on the cards. No backend/API/locale changes.

## Decision (resolved)

- **Client-side**, matching the card's displayed analysis names
  (`formatAnalysisTitle(analysis.title, …)`), case-insensitive substring.
  Consistent with the page's existing client-side orderId/email/sampleId filters.

## Current state (verified)

- Existing client-side text filters (`orderIdFilter`, `emailFilter`, `sampleIdFilter`)
  live in the `orders` useMemo and filter on order data only (no SENAITE lookup).
- `filteredOrders` useMemo has `sampleLookupMap` and applies the analysis-state filter.
- `orderSla`, `displayedOrders`, `atRiskCount` are all derived from `filteredOrders`,
  and both table and Kanban render `displayedOrders` — so a filter added in
  `filteredOrders` flows everywhere automatically.
- Card analysis names come from `formatAnalysisTitle(a.title, buildAnalyteNameMap(lookup))`
  (`OrderStatusPage.tsx` ~138-165) — both helpers are local to this file.
- Row 3 holds the text-filter `<Input>`s + a "Clear" link gated on the three filters.
- `OrderFilters` interface + `loadOrderFilters` (default + persisted-normalize path).

## Design

1. **State:** add `analyteFilter: string` to the `OrderFilters` interface; default `''`
   in `loadOrderFilters`'s default object. (Persisted-path uses `...parsed`, so old
   data without the key yields `undefined`; guard at read sites with `?? ''` is not
   needed because the input is controlled — set `analyteFilter: parsed.analyteFilter ?? ''`
   in the normalize block for safety, matching the `collapsedKanbanCols` guard.)

2. **Input:** add an `<Input placeholder="Analyte" ... />` in Row 3 after the Sample ID
   input, wired `value={orderFilters.analyteFilter}`
   `onChange={e => updateFilters({ analyteFilter: e.target.value })}`. Add
   `orderFilters.analyteFilter` to the Row-3 "Clear" condition and to the clear action's
   reset object.

3. **Filter logic** (in the `filteredOrders` useMemo, after the stage-filter block,
   before the kanban sort): when `analyteFilter.trim()` is set, keep orders where some
   sample's loaded lookup has an analysis whose formatted title matches the query
   (case-insensitive substring):
   ```ts
   const analyteQ = orderFilters.analyteFilter.trim().toLowerCase()
   if (analyteQ) {
     result = result.filter(o => {
       if (!o.sample_results) return false
       return Object.values(o.sample_results).some(v => {
         if (!v.senaite_id) return false
         const lookup = sampleLookupMap.get(v.senaite_id)?.data
         if (!lookup) return false
         const nameMap = buildAnalyteNameMap(lookup)
         return lookup.analyses.some(a =>
           formatAnalysisTitle(a.title, nameMap).toLowerCase().includes(analyteQ)
         )
       })
     })
   }
   ```
   `filteredOrders` already depends on `orderFilters` and `sampleLookupMap`, so deps are covered.

## Behavior notes

- Applies in both table and Kanban (both render `displayedOrders` ⊆ `filteredOrders`)
  and composes (AND) with the SLA at-risk toggle, stage filters, and text filters.
- Orders whose sample lookups haven't streamed in yet won't match until loaded; results
  refine as SENAITE lookups arrive (consistent with the page's lazy loading).

## Testing

The match reuses the local `formatAnalysisTitle`/`buildAnalyteNameMap` helpers and there
is no OrderStatusPage test harness, so verification is `npm run typecheck` + scoped
`npx eslint` + manual smoke on `:3101` (same approach approved for the prior tasks).

## Files

- `src/components/OrderStatusPage.tsx` only.

## Out of scope

- Server-side parity (matching the WP-ordered `sample_identity`); debounce (the other
  text filters here aren't debounced — keep consistent); analyte search in other views.
