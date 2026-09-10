# Sample Priority — design

Date: 2026-09-09
Status: draft for Handler review
Scope: Accu-Mk1 (backend + frontend). Integration Service and WordPress touch
only the already-existing order-payload priority field.

## 1. Problem and goal

The lab needs a priority marker that (a) can be managed as data, (b) maps
each priority to an SLA turnaround tier, (c) can be set at customer, order,
sample and vial level with the most specific setting winning, and (d) is
visible as a compact indicator everywhere a sample is listed.

Most of the machinery already exists and is inert:

| Exists today | Where | Gap |
|---|---|---|
| Per-sample priority `normal`/`high`/`expedited` keyed by SENAITE uid | `sample_priorities`, inbox endpoints `PUT /worksheets/inbox/{uid}/priority`, bulk, `POST /sample-priorities/lookup` | hardcoded list; SENAITE key; only the inbox can set it |
| Copy on worksheet items | `worksheet_items.priority` | snapshot copy, drifts |
| Priority → SLA tier, global or per service group | `sla_priority_tiers`, `PUT/GET/DELETE /sla-priority-tiers` | keyed by literal; UI shows two hardcoded rows |
| SLA engine precedence priority > profile > group > default | `backend/sla_engine.py`, TS mirror | takes a literal from `PRIORITIES` |
| Order payload priority from WordPress | inbox seeding at `main.py` ~19897 and ~20247 | copied into samples once, only when still `normal` |
| Badge | `src/components/hplc/PriorityBadge.tsx` | full pill, three hardcoded styles |

The 2026-08-03 SLA performance report found the priority map empty and
both tiers at the same target: "nothing can be expedited". This feature is
what makes that machinery real.

Out of scope: security/roles for who may set priority (Handler: anyone for
now, revisit later); SENAITE's own AR priority (ignored, Mk1 native only);
the WordPress "Rush" product (later; it will simply set the order-level
value through the existing payload field); the SLA report's default-tier
drift (seed 48h vs prod 24h) and the empty Core HPLC service group.

## 2. Decisions (Handler rulings, 2026-09-09)

1. Resolution is **most specific explicit value wins**: vial > sample >
   order > customer > Default. A lower level may lower the priority. Every
   level stores `NULL` for "inherit".
2. Priorities carry a numeric **rank**; Default is rank 0; priorities below
   Default are allowed (negative rank).
3. Customer-level lives in an **Mk1-owned table keyed by WordPress customer
   user id** (option A). WordPress marks the customer today and the order
   payload carries the priority into the order level. Seeding the Mk1
   customer table from WordPress via the Integration Service is a later
   addition (option C), designed for but not built.
4. Priorities are soft-deactivated, never deleted; the seeded three keep
   their meaning.
5. Indicator is a **colored glyph**, chosen per priority at creation from a
   fixed icon set; Default renders nothing.
6. Anyone can set any level for now.
7. **Audit** every change; sample and vial changes, and order/customer
   changes that alter a sample's effective value, appear in the existing
   sample activity log.
8. The **Priorities pane owns the list and the SLA tier mapping** (option
   A). The SLA pane keeps tiers and per-service-group exceptions.
9. Check-in: the receive wizard's sample panel gets the effective value
   with override; the vial tab gets the vial-level override; the wizard
   header gets the glyph. No new step. (The wizard → cart → order flow the
   Handler described is the WordPress ordering side; Mk1's receive wizard
   runs after the order exists.)
10. Approach **A, resolve at read**, with audit rows as the timeline and
    **snapshots at the SLA clock events** (receive, in-flight change,
    completion) so reports grade against what was promised at the time.

## 3. Data model

### 3.1 `priorities`

| column | type | notes |
|---|---|---|
| id | int PK | |
| key | varchar(40) unique, immutable | slug, referenced by every other table |
| name | varchar(100) | display |
| rank | int | higher is more urgent; Default = 0; negatives allowed |
| icon | varchar(30) | enum: `chevrons-up`, `chevron-up`, `minus`, `chevron-down`, `chevrons-down` |
| color | varchar(20) | enum of theme palette names: `red`, `amber`, `emerald`, `sky`, `violet`, `zinc` |
| is_default | bool | exactly one `true`; partial unique index `uq_priorities_single_default` (same pattern as `uq_sla_tier_single_default`) |
| is_active | bool | soft deactivate; inactive keys resolve as inherit and log a warning |
| created_at / updated_at | timestamp | |

Seed (migration): `default` ("Default", rank 0, `minus`, `zinc`, is_default),
`high` ("High", rank 10, `chevron-up`, `amber`), `expedited` ("Expedited",
rank 20, `chevrons-up`, `red`). The old `normal` literal maps to `default`.

### 3.2 `sla_priority_tiers`

Keep the table and both partial unique indexes. `priority` becomes an FK to
`priorities.key`. The Default key has no row (sparsity contract in
`sla_engine.resolve_sla_tier` unchanged: an unmapped key falls through to
profile → group → default tier).

### 3.3 Explicit values, all nullable = inherit

| level | home | key column |
|---|---|---|
| customer | new `customer_priorities` (wp_customer_user_id int PK, priority_key FK, note text, updated_at, updated_by) | priority_key |
| order | `lims_orders.priority_key` FK | plus `priority_source` varchar(20): `ui` / `order-payload` |
| sample | `lims_samples.priority_key` FK | |
| vial | `lims_sub_samples.priority_key` FK | |

`sample_priorities` is backfilled into `lims_samples.priority_key` where the
SENAITE uid resolves to a native row (`lims_samples.external_lims_uid`), then
dropped in the release after nothing reads it. `worksheet_items.priority`
stops being written and is dropped in the same follow-up.

### 3.4 `priority_audit`

| column | notes |
|---|---|
| id, at, user_id | |
| level | `customer` / `order` / `sample` / `vial` |
| entity_id | text (wp customer id, lims_orders.id, lims_samples.id, lims_sub_samples.id) |
| old_key, new_key | nullable |
| source | `ui` / `order-payload` / `migration` / `bulk` |
| note | optional |

### 3.5 SLA snapshots

On `lims_samples` and `lims_sub_samples`: `sla_priority_key`,
`sla_priority_source` (`vial`/`sample`/`order`/`customer`/`default`),
`sla_target_minutes`, `sla_snapshot_at`. Written by one helper
`priority.snapshot.refresh(db, sample_ids)` at: receive (the existing
receive touchpoint), any assign that changes the effective value of an
in-flight sample, and completion (the existing publish/complete
touchpoint). Reports read the snapshot; live views read the resolver.

## 4. Resolution

`backend/priority/resolver.py`:

- `resolve(explicit: {vial, sample, order, customer}, priorities) -> Effective`
  is pure and DB-free: first non-null active key in vial, sample, order,
  customer order; else the default. Returns `{key, rank, source_level,
  source_id}`.
- `load_effective(db, sample_ids=(), vial_ids=()) -> dict[id, Effective]`
  batches: one query per level (sub_samples, samples, orders joined on
  `client_order_number`, customer_priorities joined on
  `lims_orders.customer_user_id`) plus the priorities table (cached
  per-process 60 s like the throughput row cache).
- `src/lib/priority-resolver.ts` mirrors the pure rule; a shared fixture
  file `backend/tests/fixtures/priority_cases.json` is consumed by both
  test suites so the two cannot drift (same pattern as the SLA engine
  mirror).

Consumers: `POST /sla/status` passes `effective.key` into
`resolve_sla_tier`; the Slack notifier's planner does the same; the inbox's
copy-from-order code paths are deleted.

## 5. API

| route | behaviour |
|---|---|
| `GET /priorities` | active and inactive, sorted by rank desc |
| `POST /priorities` | create; validates icon/color enums; key derived from name, immutable |
| `PATCH /priorities/{key}` | name, rank, icon, color, is_active, sla_tier_id (writes the global `sla_priority_tiers` row, or deletes it when null) |
| `DELETE /priorities/{key}` | deactivates; 409 on the default |
| `PUT /priorities/default/{key}` | move the default marker |
| `PUT /priorities/assign` | `{level, id, priority_key\|null, note?}`; writes the level column, one audit row, activity-log lines for affected samples, snapshot refresh for in-flight samples |
| `PUT /priorities/assign/bulk` | list of the above; replaces both inbox priority endpoints |
| `POST /priorities/resolve` | `{sample_ids?, vial_ids?}` → effective map |
| `GET /customer-priorities` | rows joined with last-seen customer name/email from `lims_orders` |
| `GET /customers/seen?q=` | distinct customers from `lims_orders` for the picker |

Inline embedding: every endpoint that returns sample or vial rows (samples
list, registry list, order status, vial status board, worksheets inbox,
worksheets list, active boxes, sample details, sub-sample list) adds
`priority: {key, rank, source_level}` to each row using `load_effective`
once per response. Order endpoints add `priority_key` (explicit) and
`effective_priority` (customer-inherited). No list needs a second request.

Order ingest (`/s2s` order upsert): map the payload's priority to
`lims_orders.priority_key` on create only, `priority_source =
'order-payload'`, audit row with source `order-payload`. Unknown keys are
logged and ignored. A later "Rush" product changes nothing here.

The two `sla-priority-tiers` routes validate `priority` against the table.

## 6. Settings UI

`src/components/preferences/panes/PrioritiesPane.tsx`, registered in
`panes.tsx` next to SLA.

- Table sorted by rank: glyph preview, name (inline edit), rank up/down,
  icon picker (the five icons), color picker (the six theme colors), SLA
  tier select (existing tiers, "Follow profile/group" = no row), active
  switch, "Default" radio. Add row at the bottom. Deactivating a priority
  in use shows the count of explicit assignments and proceeds.
- Section "Customer priorities": search over `GET /customers/seen`, set or
  clear a customer's priority, table of current rows with name, email,
  priority, note, updated by/at.
- Gating: none for now; the pane reads the same `isAdmin` flag the SLA pane
  does but does not disable controls. One place to flip later.
- `SlaPane.tsx`: remove the two hardcoded `OVERRIDABLE` rows; the
  per-service-group exception editor lists every active non-default
  priority from `GET /priorities`.

## 7. Surfaces

- `src/components/common/PriorityGlyph.tsx` replaces `PriorityBadge.tsx`.
  Props `{priority: {key, rank, source_level, ...} | null, size: 'row' |
  'card' | 'header', showLabel?}`. Renders nothing for the default key;
  otherwise the icon in the priority color with a tooltip "Expedited via
  customer (Acme Labs)". Icons are lucide (`ChevronsUp`, `ChevronUp`,
  `Minus`, `ChevronDown`, `ChevronsDown`).
- Placement: samples list rows and cards, order list rows and order status
  page, vial status board cards, worksheets inbox family header and vial
  cards, worksheet drawer items, active boxes, receive wizard header.
  Inbox and worksheet family ordering use `rank`.
- Set controls (`PrioritySelect`): sample details basic info, sub-sample
  page, receive wizard sample panel (sample level) and vial tab (vial
  level), order status page (order level). Options: "Inherit (Default via
  customer)" plus active priorities; writes through `/priorities/assign`.
- Activity log lines: "Priority: High → Expedited (Jane)"; derived lines
  for order/customer changes: "Priority now Expedited via order 3291".

## 8. Migration

Single migration in `database._run_migrations`, idempotent:

1. create `priorities`, seed three rows; create `customer_priorities`,
   `priority_audit`; add the four `priority_key` columns, the order
   `priority_source`, and the snapshot columns.
2. backfill `lims_samples.priority_key` from `sample_priorities` (uid →
   native row); write one audit row per backfilled sample, source
   `migration`; `normal` → NULL (inherit), others → same key.
3. add the FK on `sla_priority_tiers.priority` after asserting every
   existing value is a seeded key.
4. follow-up release: drop `sample_priorities` and
   `worksheet_items.priority`.

Code removals: `sla_engine.PRIORITIES`, `InboxPriority` type, the
inbox copy-from-order blocks, `PriorityBadge.tsx`.

## 9. Testing

Backend (pytest): resolver precedence matrix from the shared fixture
(explicit at each level, lowering, inactive key, negative rank, missing
customer); `assign` writes column + audit + activity log + snapshot;
bulk assign; order ingest maps and ignores unknown keys; migration on a
seeded DB preserves meaning; `/sla/status` uses the effective key.

Frontend (vitest): TS resolver against the same fixture; `PriorityGlyph`
renders nothing for default and the right icon/color/tooltip otherwise;
Priorities pane CRUD and default move; `PrioritySelect` inherit option
text; receive wizard field; one samples-list render proving the inline
shape draws glyphs with no extra request.

## 10. Rollout

Ships behind nothing: with the seeded rows and no SLA mapping, behaviour is
identical to today (every sample resolves to Default, no glyphs). The lab
turns it on by mapping priorities to tiers and setting customers.
