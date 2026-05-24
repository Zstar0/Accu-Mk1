---
title: Customer Detail Tabs + Customer Orders Search
status: design
date: 2026-05-18
authors: forrestp (via Claude Opus 4.7 brainstorming)
target_milestone: v0.34.0 (proposed)
target_phase: 30 (proposed)
supersedes: none
depends_on: v0.33.0 (Phase 25-29) — wc_customers, order_submissions.customer_id, /explorer/orders?customer_id=
---

# Customer Detail Tabs + Customer Orders Search

## Problem

The Phase 29 customer detail page (`CustomerStatusPage.tsx` → `CustomerDetailView`) shows a single flat orders table sorted open-first. It works for "what's outstanding for this customer", but doesn't support sophisticated investigation: *"which of this customer's orders had sample P-0067?"*, *"how many BPC-157 orders has this customer placed?"*, *"jump me to the WP admin page for order #3066"*.

The longer-term vision is a multi-tab customer detail page where:

1. The **Customer Orders** tab supports search by Order #, Sample ID, or Analyte (within the current customer's orders).
2. A **Dashboard** tab eventually surfaces analytics (revenue over time, orders/day, avg turnaround).
3. Both tabs offer deep-link affordances out to the relevant context (AccuMark sample detail or WP order admin).

This spec covers v1: the tabs structure + the Customer Orders search. Dashboard content is deferred to a follow-up.

## Goals

- Customer detail page restructured as a tabbed view (Customer Orders + Dashboard).
- Within-customer order search across 3 fields with SENAITE-search-pattern parity (explicit field selector, Postgres-owned index).
- Auto-expand + highlight matching sample on search-result rendering.
- Universal deep-link affordances (sample → AccuMark sample detail; order → WP order admin in new tab).
- Zero new sync layer. Postgres GIN indexes + endpoint extension only.

## Non-Goals (deferred to later milestones)

- **Dashboard tab content** — v1 ships a placeholder shell; v2 adds revenue chart, orders/day, avg turnaround.
- **Top-level customers-page global search** — cross-customer search by sample/analyte that lands you on the matching customer. Separate milestone.
- **Sample-state filtering** — searching by SENAITE state ("received" / "to-verify" / "published") would require mirroring SENAITE state into IS. Out of scope for v1.
- **URL-synced tab state** — tab state is Zustand-only for v1. Adding URL sync later as v1.1 polish if shareable links become a need.
- **Per-session "remember last-used tab"** — sticking with always-default-to-Customer-Orders for v1.

## Architecture

### Backend (Integration Service)

#### Endpoint extension

`GET /explorer/orders` (Phase 28-05) gains three optional query params:

```
GET /explorer/orders
  ?customer_id=<int>
  &search_order_number=<string>    (each search_* param independently optional)
  &search_sample_id=<string>
  &search_analyte=<string>
  &sort=<open_first|date_desc|date_asc>
  &limit=<int>&offset=<int>
```

When multiple `search_*` params are set, conditions are AND-combined — a result must match ALL active filters. Response shape unchanged — `List[ExplorerOrder]`. Within-customer search enforced by the existing `customer_id` filter; this route cannot search globally.

**Note on revision history:** The original spec used a single `search_field`/`search_value` pair (mutually exclusive). Revised 2026-05-18 post-Task-7 to three independent params for AND-combined filtering.

#### Search SQL (parameterized, GIN-indexed)

| Field | SQL approach |
|---|---|
| `order_number` | `WHERE order_number ILIKE :pattern` (`:pattern = "%{value}%"`) — substring match |
| `sample_id` | `WHERE sample_results @@ '$.* ? (@.senaite_id == $val)'::jsonpath` (with `$val` bound) — exact match against per-position `senaite_id` values |
| `analyte` | `WHERE payload->'samples' @@ '$[*].sample_identity like_regex $pat flag "i"'::jsonpath` — case-insensitive substring against sample identities |

All `search_value`s bound via SQLAlchemy `bindparam`. Zero string concatenation into SQL. Mirrors Phase 25's URLSearchParams discipline at the SQL layer.

#### Sort

Server-side, three options:

- `open_first` (default, matches current Phase 29 behavior): `ORDER BY (completed_at IS NULL) DESC, created_at DESC`
- `date_desc`: `ORDER BY created_at DESC`
- `date_asc`: `ORDER BY created_at ASC`

#### Migration

One Alembic migration adds two GIN indexes:

```sql
CREATE INDEX CONCURRENTLY idx_order_submissions_sample_results_gin
  ON order_submissions USING GIN (sample_results jsonb_path_ops);

CREATE INDEX CONCURRENTLY idx_order_submissions_samples_gin
  ON order_submissions USING GIN ((payload->'samples') jsonb_path_ops);
```

`CONCURRENTLY` — non-blocking against the live table. `jsonb_path_ops` chosen over default `jsonb_ops` (smaller, faster for containment/path queries; sufficient for our query shape).

> **Discovery (2026-05-19, user smoke):** Analyte data lives in `payload->'samples'[*].sample_identity`, not `payload->'line_items'[*].name` as initially planned. Verified against IS dev DB: 0/138 orders have `payload.line_items`, 136/138 have `payload.samples`. The first version of this migration created `idx_order_submissions_line_items_gin` against the WC REST shape — but the IS webhook persists a different payload shape. Replacement migration `s7m8n9o0p1q2` drops the old index and creates `idx_order_submissions_samples_gin` against the correct path. Both SQL (table above) and migration (this section) updated to reflect the real path. T-30-02 below also updated.

### Frontend (Accu-Mk1)

#### File structure

Changes confined to `src/components/CustomerStatusPage.tsx` and `src/components/explorer/OrderRow.tsx`. No new top-level files in v1.

```
CustomerStatusPage.tsx (~860 → ~1100 lines)
├─ CustomerStatusPage (router export, unchanged)
├─ CustomerListView (unchanged)
├─ CustomerRow (unchanged)
├─ CustomerDetailView (body restructured to wrap content in Tabs)
├─ CustomerOrdersTab (new — formerly the orders card body)
└─ CustomerDashboardPlaceholder (new — placeholder card with "Coming in v2")
```

If the file exceeds ~1200 lines after this work, extract `CustomerOrdersTab` to `src/components/explorer/customer-orders/CustomerOrdersTab.tsx` as a follow-up. Same-file keeps the v1 navigation tight.

#### CustomerDetailView body structure

```
<persistent header card — display_name, email, company, aggregate stats — unchanged>

<Tabs value={customerDetailTab} onValueChange={setCustomerDetailTab}>
  <TabsList>
    <TabsTrigger value="orders">Customer Orders</TabsTrigger>
    <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
  </TabsList>
  <TabsContent value="orders">
    <CustomerOrdersTab />
  </TabsContent>
  <TabsContent value="dashboard">
    <CustomerDashboardPlaceholder />
  </TabsContent>
</Tabs>
```

Default value: `'orders'` (Question 5 resolved A).

#### Zustand store additions (`src/store/ui-store.ts`)

State fields (with defaults):

```typescript
customerDetailTab: 'orders' | 'dashboard'     // default 'orders'
customerOrderSearch: {                         // default all empty
  order_number: string
  sample_id: string
  analyte: string
}
```

Actions:

```typescript
setCustomerDetailTab(tab)
setCustomerOrderSearchField(field, value)      // write one slot at a time
setCustomerOrderSearchReset()                  // clear all three slots (used by Clear-search button + navigateToCustomers)
```

The per-field setter replaces the original `setCustomerOrderSearch({field, value})` atomic dual-write. With three independent slots there's no longer a race to atomically resolve — each input has its own debounced setter targeting its own slot.

`navigateToCustomers()` (Phase 29) extended to also reset both new fields on back-nav. This prevents tab/search state from one customer leaking into the next customer click.

#### OrderRow component changes (`src/components/explorer/OrderRow.tsx`)

Two new optional props, both default `undefined`. Existing OrderStatusPage call sites unchanged.

```typescript
interface OrderRowProps {
  // ... existing props
  defaultExpanded?: boolean
  highlightSampleId?: string
}
```

- `defaultExpanded={true}` → row renders pre-expanded; user does NOT need to click to see samples.
- `highlightSampleId={'P-0067'}` → SampleCard with matching `sampleId` gets a visual ring (Tailwind `ring-2 ring-primary`).

CustomerOrdersTab passes these conditionally based on search state.

#### API client change (`src/lib/api.ts`)

Extend the existing `getExplorerOrdersByCustomer`:

```typescript
export async function getExplorerOrdersByCustomer(
  customerId: number,
  search?: { field: string; value: string },
  sort?: string,
  limit = 50,
  offset = 0
): Promise<ExplorerOrder[]>
```

New params optional; existing call sites compile unchanged.

## Data Flow

### Search request lifecycle

1. User selects a field in the dropdown (e.g., "Sample ID"). `setCustomerOrderSearch({ field: 'sample_id', value: '' })` writes both fields atomically.
2. User types `P-0067`. 300ms debounce (existing pattern from Phase 29's `setSearchAndResetPage`). Atomic write of `{ field: 'sample_id', value: 'P-0067' }`.
3. **Minimum-character gate**: search fires only when `value.length >= 2`. Below that, the query key carries `null` for both fields → unfiltered list. Rationale: combined with the exact-match SQL for `sample_id`, single-char queries (`P`) would otherwise produce "no results" flicker on every keystroke. Two-char minimum balances responsiveness against false-empty flashes.
4. TanStack query key transitions to `['explorer','orders','by-customer', customerId, search.field, search.value, sort, envName]`. New fetch fires; previous unfiltered cache entry stays valid.
5. Empty `search.value` (or below the 2-char threshold) → query key carries `null` for both → backend returns unfiltered list (current Phase 29 behavior, no regression).

### TanStack query key shape

```typescript
[
  'explorer',
  'orders',
  'by-customer',
  customerDetailTargetId,           // existing
  customerOrderSearch.field,        // new (null when no search)
  customerOrderSearch.value,        // new ('' when no search)
  sort,                             // new (defaults to 'open_first')
  envName,                          // existing (for T-29-05-new env scoping)
]
```

Index 7 (envName) preserves the cross-env leak mitigation from Phase 29 SECURITY.

### Render behavior matrix

| Result count | Search active? | OrderRow rendering |
|---|---|---|
| 0 | No | Phase 29 empty state: "No orders for this customer" |
| 0 | Yes | New empty state: "No orders match {field_label}: '{value}'" + Clear-search button |
| 1+ | No | Phase 29 default: collapsed rows, open-first sort |
| 1+ | Yes | Each row `defaultExpanded={true}`; if `search.field === 'sample_id'`, `highlightSampleId={value}` |

### Deep-link affordances (universal — both tabs, search and non-search rows)

| Click target | Behavior |
|---|---|
| Sample badge inside a SampleCard | Existing AccuMark sample detail navigation (no new wiring) |
| Order # text in OrderRow header | Opens `{wordpressHost}/wp-admin/post.php?post={orderId}&action=edit` in a new tab via `<a target="_blank" rel="noopener">` |
| Small external-link icon adjacent to Order # | Same as Order # click — explicit affordance for users who don't realize the text is clickable |

`wordpressHost` already arrives as an OrderRow prop sourced from `getWordpressUrl()` (api-profiles.ts).

## Error Handling and Edge Cases

| Scenario | Behavior |
|---|---|
| IS disconnected (status query returns `connected: false`) | Search controls disabled; existing Phase 29 disconnected banner shown |
| Search returns no results | Empty card with field/value echoed + Clear-search button |
| Search returns 50+ results (hit limit) | Pagination row renders (existing Phase 29 pagination behavior); Prev/Next gated correctly |
| Backend 500 (bad jsonpath, etc.) | Existing Alert + Retry button; PROD-vs-dev copy gate preserved (inherited T-29-02 mitigation) |
| Customer has zero orders, no search | Phase 29 empty state ("No orders for this customer") |
| User switches to Dashboard tab mid-flight | TanStack abort signal cancels in-flight request; switching back resumes from cache |
| Back-nav to customer list while search active | `navigateToCustomers()` resets both new Zustand fields; next customer click starts clean |

## Threat Model (additions over Phase 29's register)

| Threat ID | Category | Component | Disposition | Mitigation |
|---|---|---|---|---|
| T-30-01 | Tampering / Injection | SQL via `search_value` in `/explorer/orders` | mitigate | SQLAlchemy `bindparam` for all three search queries; zero string concatenation into SQL; jsonpath args also bound via `bindparam` (not f-string interpolation) |
| T-30-02 | DoS | Expensive jsonpath `like_regex` on analyte | mitigate | GIN index on `payload->'samples'` with `jsonb_path_ops` (per 2026-05-19 fix; originally planned against `payload->'line_items'` but the real payload shape is `samples`); query-plan check in Phase 30 W0 probes confirms index use against representative DB. Length limit (256 chars) enforced on `search_value` to prevent pathological inputs |
| T-30-03 | Information Disclosure | Tab/search state leak across customers | mitigate | `navigateToCustomers` clears both `customerDetailTab` and `customerOrderSearch`. Test asserts the reset |

Inherited from Phase 29 (no change required): T-29-01, T-29-01-pre, T-29-02, T-29-02-pre, T-29-04, T-29-05-new.

## Testing Strategy

| Layer | Coverage |
|---|---|
| **Unit (vitest) — `customer-status-page.test.tsx`** | Tab rendering; tab switching dispatches `setCustomerDetailTab`; default tab is 'orders'; field selector dropdown; debounced search; OrderRow receives `defaultExpanded` + `highlightSampleId` on search-active state; empty-state copy per field; Clear-search button resets state |
| **Unit (vitest) — `ui-store.test.ts`** | `setCustomerDetailTab` writes; `setCustomerOrderSearch` is atomic; `navigateToCustomers` clears both new fields |
| **Integration (IS pytest) — `test_explorer_orders_search.py` (new)** | One test per field (order_number, sample_id, analyte); sort variants; empty-results case; bindparam injection attempts (single-quote, semicolon, jsonpath escape attempts); pagination interplay |
| **Migration (IS pytest) — `test_migration_add_jsonb_indexes.py` (new)** | Migration applies cleanly; both indexes exist post-upgrade; downgrade removes them; CONCURRENTLY didn't lock the table during apply |
| **E2E (Playwright) — extend `e2e/customers.spec.ts`** | Drill into a customer; switch tab to Dashboard and back; search by sample ID; verify OrderRow auto-expanded with highlighted sample card; search by analyte (no highlight); search by order #; Clear-search resets |

## Open Questions / Risks

- **Sample-ID highlighting under regex match.** If the user types a partial sample ID like `P-006`, the jsonpath `@.senaite_id == $val` exact-match won't return anything. v1 keeps sample-ID search as exact-match (matches SENAITE samples-page behavior at `backend/main.py:10838`). Substring search on sample IDs becomes a v1.1 follow-up if requested.
- **Analyte name shape.** IS-shaped `sample_identity` values look like `"BPC-157 5mg"` or comma-delimited multi-analyte strings like `"KPV, GHK-Cu, BPC-157, TB-500"` — searching `BPC-157` matches via substring regex in both shapes. Searching `BPC` matches `BPC-157` and any other peptide starting with `BPC`. This is the intended behavior; can be tightened to word-boundary regex if false positives become a problem. (Original plan assumed WC `line_items[*].name` shape — corrected 2026-05-19 to the real `samples[*].sample_identity` path.)
- **What happens when an order has 4 samples and search matched only one?** With auto-expand on, all 4 samples render; only the matched one gets the ring. User can visually identify the match. Acceptable per Question 4 resolution.

## Verification (post-implementation)

The phase is complete when:

1. Visiting any customer's detail page shows Tabs with Customer Orders default and Dashboard placeholder
2. The order search dropdown contains exactly 3 options (Order # / Sample ID / Analyte)
3. Typing `P-####` (sample ID search) with a known-good sample returns the right order, auto-expanded, with the matching SampleCard ringed
4. Typing a real analyte name (`BPC-157`) with the analyte selector returns all orders containing that line item
5. The "Coming soon" Dashboard placeholder card renders on tab switch and doesn't error
6. The two new GIN indexes exist in IS Postgres (`\d order_submissions` shows them)
7. Bind-param injection attempts in pytest (single quote, semicolon, jsonpath escape) return safe results, no error stack traces leaked
8. `/gsd-secure-phase` (or whatever security gate this milestone uses) reports `threats_open: 0`
9. Playwright E2E suite green
10. Manual smoke OR automated-coverage rationale documented per the v0.33.0 close-out precedent

---
*Spec authored 2026-05-18. Locked decisions reflect 5 rounds of clarifying questions + Approach 1 selection.*
