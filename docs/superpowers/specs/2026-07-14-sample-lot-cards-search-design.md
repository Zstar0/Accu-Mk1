# Sample Lot on Cards + Lot Search — Design

**Date:** 2026-07-14
**Status:** Approved (Handler, 2026-07-14)
**Repos:** Accu-Mk1 (frontend + backend proxy), integration-service
**Branches:** `Accu-Mk1@feat/sample-lot-cards-search` (off v1.4.0), `integration-service@feat/search-lot-axis` (off 1.0.8)

## Goal

Surface each sample's customer lot code on the sample cards of the Order Status
page and the Customers page (detail view), and add a lot search box to both
pages.

## Data sources

Two representations of the same value exist:

- `order.payload.samples[i].lot_code` — the customer-entered lot from the WP
  order submission (IS `app/models/order.py` `Sample.lot_code`). Present on the
  `ExplorerOrder` payload the frontend already holds; positional alignment with
  `sample_results` keys ("1" → `samples[0]`), same convention as the Phase 31
  analyte extraction in `OrderRow`.
- `lookup.client_lot` — the SENAITE AR's `ClientLot` field, returned by the
  per-sample SENAITE lookup (`SenaiteLookupResult.client_lot`). Set from
  `lot_code` at AR creation but editable lab-side afterwards, so it is the
  authoritative value once loaded.

**Display rule:** `lookup.client_lot ?? payloadLot` — instant from payload,
upgrades to the SENAITE value when the lookup lands. No lot → render nothing
(no empty gap), matching the analyte row convention.

## 1. Lot on the cards

### SampleCard (`src/components/explorer/SampleCard.tsx`)

- New optional prop `lot?: string` (payload-sourced, like the existing
  `analyte` prop).
- Renders a muted `Lot: {value}` line directly under the analyte row:
  - Loading branch: payload `lot` (lookup not yet available).
  - Error branch: payload `lot`.
  - Normal branch: `lookup.client_lot ?? lot`.
- `data-testid={`sample-card-lot-${sampleId}`}` for tests; `title` attr carries
  the full value (truncate like the analyte row).

### OrderRow (`src/components/explorer/OrderRow.tsx`)

- Widen the localized payload type assertion to
  `{ samples?: { sample_identity?: string; lot_code?: string }[] }`.
- Extract `lot` per sample entry alongside `analyte` (trimmed, empty → undefined).
- Pass `lot` to `SampleCard`.
- The inline "Failed to create in SENAITE" card also shows the lot line
  (consistency with its analyte line).

### KanbanSampleCard (`src/components/OrderStatusPage.tsx`)

- `KanbanSampleItem` gains `lot?: string` populated at item-build time in
  `KanbanView` from the order payload (same positional extraction; the order is
  in scope where items are built).
- Card shows `Lot: {lookup.client_lot ?? item.lot}` as a compact muted line
  (only when a value exists), consistent with the card's existing metadata rows.

## 2. Order Status page — lot search box (client-side)

`src/components/OrderStatusPage.tsx`:

- `OrderFilters` gains `lotFilter: string`; `loadOrderFilters()` defaults it to
  `''` and back-compats persisted state with `lotFilter: parsed.lotFilter ?? ''`
  (same treatment `analyteFilter` received).
- New `Input placeholder="Lot"` in the Row-3 text-filter strip; the Clear
  button's presence condition and reset include `lotFilter`.
- Filter logic lives in the `filteredOrders` useMemo (alongside the analyte
  filter, since it consults `sampleLookupMap`): an order matches when ANY
  sample satisfies **either**:
  - payload `samples[idx].lot_code` contains the query (case-insensitive
    substring) — instant, works for all orders; **or**
  - the sample's loaded `lookup.client_lot` contains the query — refines as
    SENAITE lookups arrive (covers lab-side edits).

## 3. Customers page (detail view) — lot search axis (server-side)

Follows the existing three-axis pattern end to end. AND-combined with the
other axes.

### integration-service (`app/api/desktop.py`)

- New query param `search_lot: str | None = Query(None, max_length=256)` on
  `GET /explorer/orders` (+ `search_lot_len` in the request log line).
- Condition mirrors `search_analyte` exactly (T-30-01 two-layer escaping):
  1. `regex_safe = re.escape(search_lot)`
  2. jsonpath assembled in Python with `_jsonpath_string_escape`, bound as a
     TEXT param and cast server-side:
     `$[*].lot_code ? (@ like_regex "<escaped>" flag "i")` bound under a
     distinct name (`lot_path`) against `payload->'samples' @? CAST(:lot_path AS jsonpath)`.
- Index: the existing `idx_order_submissions_samples_gin` GIN
  (`(payload->'samples') jsonb_path_ops`, migration s7m8n9o0p1q2) covers the
  `@?` probe — **no new migration**.

### Accu-Mk1 backend proxy (`backend/main.py` `get_explorer_orders`)

- New `search_lot: Optional[str] = None` param; forwarded to the IS verbatim
  only when not None (absent-vs-empty semantics preserved, like the other
  three axes).

### Accu-Mk1 frontend

- `src/store/ui-store.ts`: `customerOrderSearch` gains a `lot: ''` slot;
  `setCustomerOrderSearchField`'s field union gains `'lot'`; the reset action
  and `navigateToCustomers` clear it (both go through the same reset object —
  every initializer/reset site must include the new slot).
- `src/lib/api.ts` `getExplorerOrdersByCustomer`: `search` object gains
  `lot?: string`; forwarded as `search_lot` behind the same 2-char client gate.
- `src/components/CustomerStatusPage.tsx` `CustomerOrdersTab`: fourth labeled
  input **Lot** (id `customer-orders-search-lot`, placeholder e.g. `LOT-001`)
  with its own local state + 300ms debounce effect (same bail-when-equal
  contract); included in `searchActive`, the active-filter echo
  (`Lot: "..."`), and `handleClearAll`.
- `CustomerDetailView` orders queryKey gains the lot slot **before**
  `'open_first'`; `envName` stays the LAST element (documented invariant —
  update the index comment accordingly).

## Rollout

- Old IS silently ignores unknown `search_lot` (FastAPI drops unknown query
  params) → the axis no-ops rather than errors if Mk1 ships first. Still:
  **deploy IS before or with Mk1**.
- No DB migration. No JWT_SECRET involvement. Additive only — no existing
  behavior changes.

## Testing

- **IS** (`tests/integration/test_explorer_orders_search.py` pattern): lot
  match returns the order; non-match excludes; case-insensitive; substring
  (mid-value) match; AND-combine with another axis; regex metacharacters in
  the query are treated literally.
- **Mk1 frontend** (existing files):
  - `src/test/sample-card.test.tsx`: lot line renders from payload prop on
    loading branch; normal branch prefers `client_lot`; absent lot renders no
    line.
  - `src/test/order-row.test.tsx`: `lot_code` extracted positionally and passed
    through.
  - `src/test/customer-status-page.test.tsx`: fourth input dispatches the
    `lot` slot after debounce; clear wipes it; echo includes it.
  - OrderStatusPage lot filter: payload match filters orders; lookup
    `client_lot` match filters orders (test file colocated with existing
    OrderStatusPage coverage).
- Full-suite gates per repo baselines (known-failure sets excluded per
  `architecture_mk1_test_baseline_failures`).

## Out of scope

- Lot on the standalone OrderExplorer / sample detail pages (SENAITE sample
  detail already shows ClientLot).
- Any WP-side changes (lot capture already exists in the order wizard).
- Server-side lot search on the Order Status page (its filters are
  deliberately client-side over the fetched window).
