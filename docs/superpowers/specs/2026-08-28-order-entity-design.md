# Order Entity + Order Flags (Phase 1)

**Date:** 2026-08-28 · **Status:** Approved design (Forrest, 2026-08-28), pre-plan
**Repos touched:** Accu-Mk1 (this repo, anchor) · integration-service · wpstar
**Program context:** Foundation for "bring more WP order info into Accu-Mk1."
Phase 2 (separate plan) adds live `order.updated` sync and the ~29k WP order
notes. Builds ON TOP of logistics-capture (Accu-Mk1 PR #150 / wpstar PR #61)
— execution branches from master AFTER #150 lands.

## Goal

Give Accu-Mk1 a first-class, durable **order** entity so that:

1. The lab can **raise flags on orders and on their samples** from the Receive
   page (full flags machinery: comments, watchers, blocking types, audit).
2. Mk1 holds the **customer's billing address** ("where they're likely
   shipping from" — Forrest) and shipping address per order, without a live
   round-trip to the integration service.
3. Every `lims_samples` row knows its **WooCommerce line-item ids**, closing
   the commerce↔lab join (one sample ↔ many line items: product + service
   add-ons, joined by the `_sample_number` item meta WP already writes).

## Non-goals (explicitly out of Phase 1)

- **No tracking/vendor fields on `lims_orders`** — logistics-capture owns
  those, per-sample on `lims_samples`, by approved design. This spec adds no
  logistics data anywhere.
- No live `order.updated` webhook sync (status/refund currency) — Phase 2.
- No WP order-notes ingest — Phase 2 (they are queryable: 29,397 rows in
  `wp_comments` where `comment_type='order_note'`).
- No portal/order-page UI changes in WP — Slice B of the portal program owns
  that page.
- No SENAITE writes.
- No new flag TYPES — the admin-managed `flag_types` catalog already covers
  scoping types to the new entity via `entity_types`.

## Ruled semantics (decisions already made)

- **Samples ARE the order items.** No `lims_order_items` table. The flaggable
  item entity is the already-registered `sample`; the new parent entity is
  `order`. (Forrest, 2026-08-28.)
- **One sample ↔ many WC line items.** Verified in prod: every WC line item
  carries `_sample_number` item meta (order 6344 → items 13049/50/51 →
  samples 1/2/3); service add-ons (endotoxin, sterility) are separate line
  items sharing the sample number. Hence `wc_line_item_ids` is a JSON array.
- **Join by order number string, no FK.** `lims_samples.client_order_number`
  ("WP-6344") ↔ `lims_orders.order_number`. Matches the registry pattern and
  the flags module's no-FK anchoring philosophy.
- **Flag entity id for an order = its `order_number`** (e.g. `WP-6344`) —
  human-legible, stable, and the same key the rest of the registry uses.
- **Sync model: upsert-at-acceptance + idempotent backfill.** The IS pushes
  an order upsert to Mk1 right after order processing persists
  `sample_results` (same S2S `X-Service-Token` channel as logistics'
  shipping update). Push failure is **non-fatal** (logged; order processing
  never rolls back for it) because the backfill script re-converges at any
  time — it iterates every `order_submissions` row and re-upserts.
- **Billing address is already captured** in every historical
  `order_submissions.payload` (`billing` block: company, name, email, phone,
  address_1, city, state, postcode, country) — the backfill populates all
  history for free. `address_2` and the WC shipping block are new payload
  fields; they exist only for orders submitted after the wpstar leg deploys.

## Data model

### Mk1 `lims_orders` (new)

| column | type | notes |
|---|---|---|
| id | SERIAL PK | |
| wp_order_id | INTEGER NOT NULL UNIQUE | upsert key |
| order_number | VARCHAR(40) NOT NULL, indexed | "WP-6344" form, join key to `lims_samples.client_order_number` |
| status | VARCHAR(40) NULL | WP status slug at last upsert (goes live in Phase 2) |
| customer_user_id | INTEGER NULL | WP user id |
| customer_name | VARCHAR(200) NULL | |
| customer_email | VARCHAR(254) NULL | |
| billing | JSONB NULL | payload `billing` block verbatim (post-sanitization) |
| shipping | JSONB NULL | payload `shipping` block; NULL for pre-Phase-1 orders |
| wp_created_at | TIMESTAMPTZ NULL | order created in WP |
| wp_paid_at | TIMESTAMPTZ NULL | |
| created_at / updated_at | TIMESTAMPTZ NOT NULL | row lifecycle |

### Mk1 `lims_samples` (extended)

- `wc_line_item_ids JSONB NULL` — array of WC line-item ids (ints).

### Wire formats

**WP → IS payload additions** (`build_order_payload`):
- `samples[n].line_item_ids: [int]` — WC item ids whose `_sample_number` meta
  equals that sample's `number`.
- `billing.address_2: string`
- `shipping: {company_name, first_name, last_name, address_1, address_2,
  city, state, postcode, country} | null` (null when WC has no shipping
  address).

**IS → Mk1 S2S upsert** `POST /s2s/orders/upsert` (header `X-Service-Token`):

```json
{"orders": [{
  "wp_order_id": 6344,
  "order_number": "WP-6344",
  "status": "order-submitted",
  "customer": {"user_id": 3181, "name": "Jane Doe", "email": "j@x.com"},
  "billing": { ...payload billing block... },
  "shipping": { ...payload shipping block or null... },
  "wp_created_at": "2026-08-19T23:02:46Z",
  "wp_paid_at": "2026-08-20T00:10:22Z",
  "samples": [{"senaite_sample_id": "P-2289", "line_item_ids": [13049]}]
}]}
```

Bulk (`orders` list) so the backfill can batch. Upsert by `wp_order_id`;
`samples[]` stamps `wc_line_item_ids` onto `lims_samples` by `sample_id`
(missing registry rows are skipped, not errors — registry sync may lag).
Response: `{"upserted": n, "samples_stamped": m, "samples_missing": k}`.

**Mk1 read** `GET /registry/orders?numbers=WP-6344,WP-6350` (bearer-authed
like `/registry/samples`): returns the `lims_orders` rows for the requested
numbers (missing numbers simply absent). Consumed by the Receive page to show
the ship-from line without an IS round-trip.

## Flags integration

`register_entity("order", ...)` in `backend/flags/seams.py` wiring:
- **label**: the order_number itself ("WP-6344"), suffixed with customer name
  when the row resolves ("WP-6344 · Jane Doe").
- **deep_link**: the Receive page hash (`#senaite/receive-sample`) — Slice B
  may later point this at a dedicated order page.
- **can_flag**: any authenticated user (same as `sample`).
- **context**: `{label, customer_name, customer_email, sample_ids}` from
  `lims_orders` + `lims_samples` by order_number.
- **descendants**: the order's `lims_samples` rows as `("sample", sample_id)`
  pairs — sample flags roll up under the order exactly like vials under a
  sample.

`flag_item_kinds` gains an `order` row (label "Order") so ad-hoc kind
management and the flags UI treat it as a first-class kind.

## UI (Receive page only, this phase)

- **Order rows**: a flag icon (reusing `RaiseFlagButton`, `entityType="order"`,
  `entityId={orderKey}`, `candidates={group.samples}` — the component's
  existing order-scope "Which sample?" behavior stays available) next to
  Process.
- **Expanded sample rows** (the detail sub-table shipped in v1.11.10): a
  per-sample `RaiseFlagButton` (`entityType="sample"`, `entityId={s.id}`).
- **Ship-from line**: in the expanded detail, one muted line above the
  sub-table: `Ships from: {billing.city}, {billing.state} {billing.country}`
  via the batched `GET /registry/orders` join (one request per page view for
  the visible groups, mirroring the expected-vials batch pattern — never
  per-row).

## Failure / consistency model

- Upsert-at-acceptance failing leaves NO gap that the next backfill run
  can't close; the backfill is idempotent (pure upsert) and safe to re-run
  whole.
- `samples_missing` in the upsert response is informational: the registry
  row may not exist yet at first push; the backfill run after registry sync
  re-stamps.
- The Receive page renders fully when `GET /registry/orders` returns nothing
  (ship-from line simply absent) — the order entity is an enrichment, never
  a gate.

## Deploy order

Mk1 → IS → wpstar (payload fields last; IS ignores unknown payload keys
until then, Mk1 endpoint exists before IS calls it). Then run the IS
backfill once: historical `lims_orders` appear, `wc_line_item_ids` stays
NULL for history (line-item ids enter payloads only going forward — WP could
backfill them later from `_sample_number` meta if ever needed, out of scope).
