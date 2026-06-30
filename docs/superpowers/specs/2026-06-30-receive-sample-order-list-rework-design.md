# Receive Sample — Order-List Rework · Design

*Created 2026-06-30. Branch: `feat/order-first-checkin-boxing`. Status: approved, ready for implementation plan.*

## Context

The Receive Sample page (`src/components/intake/ReceiveSample.tsx`, route `#senaite/receive-sample`)
gained an order-first flow earlier in this feature (By order / By sample toggle, `OrderReceiveSession`,
boxing). Three follow-ups remain:

1. The legacy left **step sidebar** (Steps *Samples* / *Sample Details*) is dead — every real flow now
   runs through the wizard modal (By sample) or `OrderReceiveSession` (By order).
2. The **By-Order list items** are bare (`order # · client · N samples`). They should mirror the Order
   Status page's table-mode item and surface Created, Total Expected Vials, a linked customer email, and SLA.
3. Techs need a **Process button** (instead of click-anywhere), a way to **combine orders** when a customer
   packs several orders into one package, and a faster **boxing** flow (capacity-driven auto-assign).

This rework is **additive** to the order-first feature: no production behavior of the existing single-order
receive/boxing path changes; combined sessions are a superset (a single-order session is the length-1 case).
The only backend change is one new additive endpoint (`DELETE /api/boxes/{id}`, empty-box-only).

---

## Scope

- **Part A** — Remove the legacy step sidebar + the dead Step-2 flow.
- **Part B** — By-Order items mirror the Order Status page (table mode), via a SENAITE-due ↔ `ExplorerOrder` join.
- **Part C** — Process button, multi-order combine (per-order-sectioned rail + boxing), and a **capacity-driven
  boxing stage** (right vial panel, per-box capacity + Auto-assign, auto-create boxes, remove empty box).

Likely implemented in phases (the implementation plan will split): A+B (page cleanup + order-list), then C
(process/combine), then the boxing rework.

---

## Part A — Remove the legacy left sidebar

The sidebar is the `INTAKE_STEPS` nav. **Step 2 (Sample Details)** is the old lookup → photo → check-in
flow, reachable **only** through the sidebar. Removing the sidebar makes it dead code.

**Decision: remove the sidebar AND the Step-2 flow AND the Back/Next footer.** The page becomes a single
full-width "Samples" view: heading + `Show Test Samples` checkbox + `By order / By sample` toggle + the list.

Removed from `ReceiveSample.tsx`:

- `INTAKE_STEPS`, `IntakeStep`, `currentStep`, `completedSteps`, the step `<nav>` sidebar, the footer
  Back/Next/"Check In Another" bar.
- The entire Step-2 JSX block (lookup card, COA details, `PhotoCapture`, "Check-In Sample to SENAITE").
- Associated state + handlers now orphaned: `selectedSample`, `lookup*`, `receive*`, `remarks`,
  `capturedPhotoUrl`, `pendingLookupId`, `handleNext`/`handleBack`/`handleLookup`/`handleReceiveSample`/
  `handleCheckInAnother`, and the `popstate` back-button shim.
- Imports that become unused (`PhotoCapture`, Step-2-only icons, etc.).

Retained: the due-samples load (`getSenaiteStatus` + `getSenaiteSamples('sample_due')`), the test-contact
filter, the By-sample table + its row-click → `ReceiveWizard` modal, and the `OrderReceiveSession` mount.

> The one subtractive piece in the rework. It is genuinely dead once the sidebar is gone.

---

## Part B — By-Order items mirror Order Status (table mode)

### Data backbone — the SENAITE ↔ ExplorerOrder join

Today the By-Order list is built purely by grouping SENAITE due-samples on `client_order_number`
(`groupSamplesByOrder` in `src/lib/inbox-orders.ts`). That yields no email / customer / created / SLA.

**Add a join:** fetch `ExplorerOrder[]` via `getExplorerOrders()` (`GET /explorer/orders`), index by
`order_number`, and enrich each order group with its matched `ExplorerOrder`. Define an
`EnrichedOrderGroup` extending `OrderGroup` with `order: ExplorerOrder | null` (null for the "No order"
group and for due-orders with no Explorer record).

Per-order derived data:

| Field | Source | Notes |
|---|---|---|
| **Created** | `ExplorerOrder.created_at` via `formatDate` | Labeled **"Created"** — mirrors the Order Status page exactly. (No ship date exists in the data; this is the agreed substitute.) |
| **Customer email** | `getOrderEmail(order)` (`payload.billing.email`) | From `src/components/explorer/helpers.tsx`. |
| **Email link** | `#accumark-tools/customer-detail?id={customer_id}` when `customer_id` is set; else fall back to `#accumark-tools/customers`; if no email, plain "—". | Deep-link key is the **numeric** `customer_id`. |
| **Total Expected Vials** | `getOrderBoxLabelSummary(orderNumber)` → sum `counts.hplc + counts.endo + counts.ster` | One request per order, lazy/cached per-row (like the existing `VialCount`). No backend change. |
| **SLA** | `useOrderSlaStatuses` over the due samples (batch, page-level) → `<OrderSlaCell verdict=… />` + `<SlaBreakdownTooltip>` on hover | Same hook + components the Order Status page uses (`src/services/order-sla.ts`, `src/components/explorer/`). |
| **Progress / sample count** | order group's `samples.length` (+ `samples_delivered`/`samples_expected` from the order if useful) | |

The **"No order"** group (samples lacking `client_order_number`) has `order: null` → email/SLA/vials render
"—"; it stays processable (boxes fall back to the sample id, as today).

### Item layout

A real `<Table>` mirroring Order Status, **two rows per order**, with a left border tinted by worst sample
state (mirroring `OrderRow`):

```
+--+----------------------------------------------------------------------------------+
|[]| WP-1042   acme-labs · orders@acme.com^   Created Jun 24   (*)SLA 4h   [ Process ] |  row 1
|  | 3 samples · 14 expected vials · BPC-157, TB-500, GHK-Cu                           |  row 2 (muted)
+--+----------------------------------------------------------------------------------+
```

- **Row 1:** checkbox · Order # (mono) · client name + linked email · Created · SLA badge (hover →
  breakdown) · **Process** button.
- **Row 2** (spanning, muted): sample count · expected vials · sample-type / analyte chips — the
  at-a-glance "what's in this order," mirroring the Order Status "Sample Details" cell.

A new `OrderListRow` component owns one order's two rows (keeps `ReceiveSample.tsx` from ballooning).

---

## Part C — Process button + multi-order combine + capacity-driven boxing

### Selection + Process semantics

- Row-click **no longer** opens the session. Each row has a **checkbox** (left) and a **Process** button (right).
- Selection state: a `Set<string>` of checked order keys held in `ReceiveSample`.
- When ≥1 order is checked, a sticky **selection bar** appears above the table:
  `N orders selected · [ Process together ] · [ Clear ]`.
- **Process button behavior:**
  - Row's Process with 0–1 orders checked → opens **just that order**.
  - Row's Process while it is among ≥2 checked (or the bar's "Process together") → opens a **combined
    session** over all checked orders.
- Combining is **ephemeral** — UI-only session grouping. Nothing persisted, no merged-order entity; each
  sample keeps its own order linkage and `client_order_number`.

### `OrderReceiveSession` refactor (additive)

Prop changes from `order: OrderGroup` → `orders: OrderGroup[]`. **Length 1 reproduces today's behavior
exactly.**

- **Header:** single → "Receive WP-####"; combined → "Receive N orders".
- **Left rail:** samples grouped under per-order separators; the stepper walks the flattened union of
  samples (order 1's samples, then order 2's, …). Single-order rail is unchanged (separator may be omitted
  or shown minimally).

```
Samples
- WP-1042 ------------
  [v] P-1101  Lot A123  BPC-157
      P-1102  Lot A124  TB-500
- WP-1043 ------------
      P-1108  Lot B001  GHK-Cu
[box] Boxing
```

- **Boxing stage:** one `BoxStep` **section per order**, each with that order's `orderKey` + `sampleIds`.
  Boxes remain per-order, labeled `{order}-{n}`. Sections stack for combined sessions.

### Boxing stage — right vial panel + capacity-driven auto-assign

`BoxStep` becomes a two-pane layout: per-role box columns on the **left**, that order's **Unboxed vials**
panel on the **right** (badged by role, drag source for manual overrides). The panel empties as vials are
boxed. (Per-`BoxStep` panel — single-order = one clean "boxes left, vials right"; combined = stacked
self-contained sections. No global cross-order panel.)

```
 Box section: WP-1042
 +------------------------------------------+   +-------------------+
 | HPLC          Endotoxin      Sterility   |   | Unboxed (WP-1042) |
 | [Box 1042-1]  [Box 1042-2]   (none)      |   | HPLC: P-1101 P-..  |
 |  Cap[25][Auto-assign][x]                 |   | Ster: P-1108       |
 +------------------------------------------+   +-------------------+
```

**Per-box card** gains a **Capacity** input, an **Auto-assign** button, and (when empty) a **remove** control:

- **Capacity** — numeric input, **defaults to the role's remaining-unboxed count** so the common "one box
  holds them all" case is a single click; the tech lowers it when the physical box is smaller.
- **Auto-assign** — assigns up to `capacity − current vial_count` of that box's role's unboxed vials, via the
  existing `assignVialsToBox`.

**Auto-create flow (idempotent):**

- On entering the stage: one empty box per **active role** (role with ≥1 assigned, non-`xtra` vial).
- After an Auto-assign that leaves that role with unboxed vials remaining: the **next empty box** for that
  role is auto-created. Invariant: exactly one trailing empty box per role while unboxed vials remain.
- The tech can **remove** an empty box (e.g. an auto-created box they don't want).

`createBox` mints a new running-numbered box, so both auto-create points are gated on the loaded box list
(no empty box of that role exists + unboxed vials of that role exist) and guarded against the in-flight
window with a `useRef` keyed by `` `${orderKey}:${role}` `` so refetch/HMR never double-creates.

**Capacity is frontend-only (ephemeral)** in this rework — local per-box state that drives the Auto-assign
batch size; nothing persisted (no schema change). The label still shows `vial_count`. (Persisted capacity is
Future Work.)

**Removing a box** uses a new additive backend endpoint **`DELETE /api/boxes/{id}`**, guarded to **empty
boxes only** (a box with assigned vials cannot be deleted — unassign first). The only backend change in the
rework.

Manual **drag-drop** (right panel → a role-matching box) stays as an override; capacity is **not** enforced
on manual drags — only the Auto-assign button respects it.

---

## Components / files

All edits via devbox workers on the worktree (`~/worktrees/Accu-Mk1-boxing`).

| File | Change |
|---|---|
| `src/components/intake/ReceiveSample.tsx` | Remove sidebar/Step-2/footer; full-width Samples view; By-Order `<Table>` of `OrderListRow`; checkbox selection + Process + selection bar; ExplorerOrder join + page-level SLA hook; multi-order `OrderReceiveSession` invocation. |
| `src/lib/inbox-orders.ts` | Add `EnrichedOrderGroup` + a join that maps `ExplorerOrder[]` by `order_number` onto the grouped due-samples; null-order fallback. |
| `src/components/intake/OrderReceiveSession.tsx` | `orders: OrderGroup[]`; rail with per-order separators over the flattened sample list; boxing stage = per-order `BoxStep` sections; header single vs N-orders. |
| `src/components/intake/ReceiveWizard/BoxStep.tsx` | Two-pane layout + right unboxed-vial panel; per-box Capacity input + Auto-assign; idempotent auto-create (first box + trailing box on remainder); remove-empty-box control; manual drag retained. |
| **New:** `OrderListRow` (+ a small `OrderExpectedVials` cell) | The two-row order item; per-row lazy expected-vials. |
| **Backend (additive):** the boxes route + service | New `DELETE /api/boxes/{id}` (empty-box-only guard); reuses existing `lims_boxes`. |
| Reused | `OrderSlaCell`, `SlaBreakdownTooltip`, `useOrderSlaStatuses`, `getOrderEmail`, customer deep-link via the hash-navigation store; `assignVialsToBox`, `createBox`, `listOrderBoxes`. |

---

## Testing

Additive; existing tests stay green.

- `inbox-orders`: join matches by `order_number`; unmatched/`No order` → `order: null`; expected-vials sum.
- Combined session: sample flattening order; rail separator grouping; per-order boxing sections each carry
  the right `orderKey`/`sampleIds`.
- `OrderListRow`: renders linked email when `customer_id` present, plain text when null/absent; Created via
  `formatDate`; SLA cell receives the verdict.
- Selection: Process on an unchecked row opens single; Process while ≥2 checked opens combined; selection
  bar appears/clears.
- `BoxStep` auto-create: one box per active role on load; trailing box appears after Auto-assign leaves a
  remainder; **no duplicate** on refetch/re-render; no box for a role with no assigned vials.
- `BoxStep` Auto-assign: fills up to `capacity − current count`; capacity defaults to remaining-unboxed
  count; manual drag still assigns and is not capacity-bound.
- Remove box: empty box deletable; a box with vials is **not** deletable (guard).

---

## ISO 17025 alignment

Intake is handling/receipt of test items (7.4). The combine feature must not blur **sample identity or
traceability** (7.4.2): each sample retains its own order linkage and `client_order_number`; boxes stay
per-order (`{order}-{n}`); the combine is a display-only session grouping with no merged identity.
Created/received timestamps are shown as-stored (no synthesized "ship" date — "Created" is the order's real
`created_at`). Auto-created boxes carry the same order-scoped, traceable label codes as manually created
ones; capacity is an operational aid and does not alter a box's identity or its printed label.

---

## Decisions (confirmed)

- "Date Shipped" → **Created** (`ExplorerOrder.created_at`), mirroring the Order Status page.
- Email → **deep-link to the specific customer** (`customer-detail?id={customer_id}`), fall back to the
  customers list when `customer_id` is null.
- Remove the legacy sidebar **and** the dead Step-2 flow.
- Combined-session boxing → **per-order sections**, boxes stay `{order}-{n}`.
- Boxing assignment → per-box **Capacity** (numeric, defaults to remaining-unboxed) + **Auto-assign**;
  auto-create first box, then a **trailing box on remainder**; **removable** empty boxes; manual drag kept.
- Capacity is **frontend-only** in this rework; `DELETE /api/boxes/{id}` (empty-only) is the single backend add.
- Unboxed-vial panel is **per-`BoxStep`** (per order section), not global.

## Future work (designed-for, not built)

- **Settings → "Received Samples"** section to configure the box sizes the lab stocks; the Capacity field
  then becomes a **dropdown** sourced from that config.
- Optionally a **persisted `capacity` column** on `lims_boxes` (for printed capacity / a "full" indicator).

## Out of scope (YAGNI)

- Persisted "merged order" entity (combine is ephemeral).
- Shared boxes across combined orders (rejected in favor of per-order sections).
- A global cross-order vial panel (per-section panel chosen).
- A real ship-date field (would need backend; not pursued).
