# D1 — Order-status time columns: "Since Order" + "Outstanding"

- **Date:** 2026-05-26
- **Branch:** `feat/order-status-processing-time`
- **Sub-project:** D1 of the SLA / processing-time feature (decomposition: A model · B calendar · C settings UI · **D1 time columns** · D2 SLA column). Zero-dependency slice — ships first.

## Goal

Surface two timestamp-derived durations in the order-status lists, **independent of any SLA rules** (those arrive in D2/A):

- **Since Order** — elapsed since the order was placed (`order.created_at`).
- **Outstanding** — elapsed since the lab *received* the sample(s) (`date_received`). **Uncolored** (color/threshold logic is D2).

**Primary use case (user's words):** "see status on orders where we didn't receive the sample for a long time so we know to investigate or contact the customer." Showing *Since Order* next to *Outstanding* makes that gap visible: a large Since-Order with no Outstanding ⇒ ordered long ago, sample never arrived.

## Current state (facts)

- Table columns (`OrderStatusPage.tsx:1107-1112`): Order ID · Email · Progress · Created · **Processing Time** · Sample Details.
- "Processing Time" cell (`OrderRow.tsx:208-217`) = `formatProcessingTime(created_at, completed_at)` → created→completed (or →now); green when complete, yellow in progress.
- Kanban sort toggle (`OrderStatusPage.tsx:909-911`) offers `processing_time` **mislabeled "Outstanding"** — it actually sorts by the created-based value.
- `date_received` is **per-sample** (`SenaiteLookupResult.date_received`), reachable via `sampleLookupMap`; not surfaced at order level today.
- Existing helpers (`helpers.tsx`): `formatProcessingTime(created, completed)`, `formatTimeSince(dateStr)`.

## Design

### Helper (new, `helpers.tsx`)
```ts
// Earliest date_received across an order's samples = when the lab first
// received anything for this order. null if no sample is received yet.
export function getOrderReceivedAt(
  order: ExplorerOrder,
  sampleLookupMap: Map<string, { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }>,
): string | null
```
Iterates `order.sample_results`, reads each `lookup.data.date_received`, returns the earliest ISO string (or null).

### OrderRow time cell (replaces the single "Processing Time" `<td>`)
A compact stacked cell, two labeled lines:
- **Order** `formatProcessingTime(created_at, completed_at)` — keep existing semantics + green(done)/yellow(in-progress) treatment.
- **Lab** `formatTimeSince(getOrderReceivedAt(...))` — **muted/uncolored**. When not received → `Awaiting sample` (muted).

Header: rename the column **"Processing Time" → "Timing"** (cell now carries two sub-values).

### Sort-label fix
Kanban sort label `processing_time` **"Outstanding" → "Since order"** (it sorts created-based). A true received-based sort is deferred.

### Files
- `src/components/explorer/helpers.tsx` — add `getOrderReceivedAt`.
- `src/components/explorer/OrderRow.tsx` — replace Processing-Time `<td>` with stacked Order/Lab cell.
- `src/components/OrderStatusPage.tsx` — header label + sort label.
- Check `CustomerStatusPage.tsx`: OrderRow is shared (used via detail panels), so changes propagate; if it renders its own table header it needs the same label tweak.

### Tests (vitest)
- `explorer-helpers.test.ts` — `getOrderReceivedAt`: earliest of multiple samples; null when none received; skips samples lacking a lookup.
- `order-row.test.tsx` — renders both Order and Lab durations; shows "Awaiting sample" when no `date_received`; Lab value carries no color class.

### Verification
- `npm run check:all` + `vitest` green.
- Playwright on `:3101` (table view): both durations render; an order with an unreceived sample shows "Awaiting sample".

## Explicitly out of scope (later sub-projects)
- SLA thresholds + color-coding → **D2**.
- Business-hours / holiday-aware elapsed → **B**.
- SLA data model + per-(service × priority) resolution → **A**; SLA management UI → **C**.

## Default decisions made under autonomy (adjustable via the pushed branch)
1. Order-level "received" = **earliest** sample `date_received` (when processing started), not latest/all-received.
2. Surface both times in **one stacked cell** rather than two new columns, matching the user's "the processing-time field should be able to show…" framing and leaving column room for the D2 SLA value.
3. "Timing" chosen as the column header; trivially renamed if undesired.
