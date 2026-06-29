# Check-in → Boxing → Worksheet SOP — Design

**Date:** 2026-06-25
**Status:** Approved (design locked, pre-plan)
**Area:** Accu-Mk1 — `ReceiveWizard` (check-in), Worksheets Inbox, Worksheet detail, SOP guides
**Author:** Handler + ZeroSignal

---

## 1. Problem & context

We are formalizing the end-to-end operational flow from **package check-in** through **getting work onto worksheets**, and aligning the software to match it. Most of the pieces exist; this spec captures the SOP and the targeted, **additive** tweaks needed so the app mirrors how the lab actually works.

The physical SOP:

1. **Check-in (front desk — Steven).** Receives one package at a time — usually one order, sometimes several orders from the *same customer*. Checks the package in, photographs each vial, applies vial labels.
2. **Boxing.** Three **color-coded bins** by test type: **HPLC**, **Endotoxin**, **Sterility**. Assigned vials go into the matching bin. Each box gets a printed **box label** (the order number). A large order (20–30 vials) overflows one bin → the order's boxes are numbered `WP-{order}-1`, `-2`, `-3`, … Boxes are set aside.
3. **Lab planning (lab manager — Dennis).** A daily worksheet is created per person. Dennis works the **inbox** and assigns samples to worksheets. Today the inbox groups *parent → sub-samples (vials)*; we add a third tier — **order** — above it, so he can grab a whole order in one gesture.
4. **Lab execution (tech).** Tech opens their worksheet and needs to know **which boxes to physically go grab** — e.g. "the five HPLC boxes with order X." A boxes-to-grab list on the worksheet provides this, scoped to the tech's bench.

Finally, the two on-screen SOP links (check-in overlay + inbox page) get updated to match these concepts.

### What already exists (we extend, not rebuild)
- **`ReceiveWizard`** (`src/components/intake/ReceiveWizard/ReceiveWizard.tsx`) — 4 phases: `capture` (vial photos + remarks) → `assign` (drag vials into HPLC / Micro / Xtra buckets, persists `assignment_role`) → `print` (per-vial strip labels via `window.print()`, **already carry the order number `WP-XXXX`**) → `details`.
- **Inbox** (`src/components/hplc/WorksheetsInboxPage.tsx` + `src/lib/inbox-families.ts`) — groups vials into parent-sample families. `client_order_number` and `assignment_role` are **already present on every `InboxVialItem`** (`src/lib/api.ts`), sourced from the SENAITE parent in `backend/main.py:_build_native_vial_inbox_items`.
- **Worksheets** (`worksheets` / `worksheet_items` in `backend/models.py`; `WorksheetDrawer.tsx`) — assignable to an analyst. No order/box columns yet.
- **Role badges** — `src/lib/inbox-filters.ts:itemRoleBadges` resolves HPLC / ENDO / STER from service group + analysis keyword.
- **SOP guides** — `docs/guides/front-desk-sample-check-in.md` (+ built `public/guides/*.html`) linked in `WizardHeader.tsx`; `docs/guides/lab-tech-worksheets-variance.md` linked in `WorksheetsInboxPage.tsx` (~L385).

### What is net-new
- An **order-first check-in entry point**: a *By order / By sample* toggle on the Receive Samples page. "By order" groups the due-samples list into orders and runs an **order-scoped receive session** that walks every sample (and its vials) in the order, instead of opening the wizard one sample at a time. "By sample" preserves today's flat list as the fallback.
- A **box** concept: a physical bin grouping, scoped to one test-type/role and to an **order** (may span several of the order's samples), holding specific vials, with a printed label `WP-{order}-{n}`.
- An **order tier** in the inbox grouping + order-level drag.
- A **boxes-to-grab** panel on the worksheet view.

---

## 2. Goals / non-goals

**Goals**
- Let the check-in clerk work **package/order-first**: select an order and check in all its samples and vials in one session, rather than sample-by-sample.
- Let the check-in clerk create boxes, fill them by drag-and-drop, and print a box label per box — with overflow handled by adding more boxes.
- Let the lab manager assign a whole order's bench-work to a worksheet in one gesture.
- Let the tech see exactly which physical boxes to retrieve for their worksheet.
- Keep the two on-screen SOP guides accurate.
- Stay **audit-aware** for ISO/IEC 17025 alignment (see §7).

**Non-goals (explicitly deferred)**
- QR-on-box size signaling and a scan-gun batch flow (scan box + each vial → auto-print). v1 is drag-and-drop; the data model leaves a seam.
- Environmental/storage-condition monitoring (17025 7.4.4).
- Multi-order-into-one-parent merging (each order remains its own parent sample / AR).
- Any change to COA, variance, or result-entry behavior.

---

1. **Order-first entry via a toggle.** Add a *By order / By sample* toggle to the Receive Samples page. "By order" (default) is the new package-first flow; "By sample" is today's flat list, kept intact as a fallback (and for order-less/legacy samples). Chosen over a separate tab (less duplication) and over a full replace (more additive).
2. **Box numbering:** running suffix **per order** — `WP-{order}-1, -2, -3 …`, incrementing across *all* of the order's samples and bins. **Bin color tells the test type**; the app records each box's role behind the scenes.
3. **Boxes are keyed to the order, not a single sample.** An order may contain multiple samples; a color box holds that order's vials of one test type and **may span several samples** of the order. `lims_boxes` is keyed by `client_order_number` (fallback: parent `sample_id` when no order number exists).
4. **Box capacity:** none configured. Overflow is handled by the clerk adding a box — it does not matter which specific vial lands in which box.
5. **Box composition:** **persisted, drag-and-drop.** The clerk adds a box, drags vials into it, prints its label. Membership is recorded (cheap; underpins the boxes-to-grab list and the future QR/scan flow).
6. **Boxing/assignment is per-bench.** An order's HPLC vials go to the HPLC tech; its Endo/Ster vials go to the Micro tech. Order-drag and the boxes-to-grab list are bench-scoped.
7. **Identity rides on the vial, not the box** — each vial keeps its unique label (`P-XXXX-SNN` + QR), so "any vial in any box" is traceability-safe.
8. **Reuse existing label sizes/formats.** Box labels go through the label print setup already configured in the system; no new media size is introduced.
9. Honor workspace non-negotiables: additive only, `lims_` table prefix, npm-only frontend, no prod-behavior change without sign-off.

---

## 4. The SOP (target procedure)

**A. Front-desk check-in (Steven)**
1. On the Receive Samples page (**By order** mode), pick the order/package to receive. (A package may carry several same-customer orders → each is its own order group; do them in turn.)
2. The order-scoped receive session opens and walks each sample in the order. For each sample:
   - **Capture:** photograph each vial, add remarks if anything is off (records condition on receipt).
   - **Assign:** drag each vial to its test-type bin: HPLC / Endotoxin / Sterility (Xtra = surplus/hold).
   - **Print vial labels** (unchanged): one strip label per vial.
3. **Box (order-level):** for each bin with vials, **+ add box** (gets the order's next `WP-{order}-{n}`), drag that bin's vials — from any of the order's samples — into the box, **print the box label** (existing label format), place the physical box in the matching color bin. Overflow → add another box. Set boxes aside.

**B. Lab planning (Dennis)**
6. Create the day's worksheet per person (assign an analyst).
7. In the inbox, expand by **Order**, grab an order (or a family, or a vial) and drop it on the target worksheet. Drop assigns *that bench's* portion.

**C. Lab execution (tech)**
8. Open assigned worksheet → open **Boxes to grab** → physically retrieve the listed boxes (bench-color, enumerated per order). Confirm none are left behind.
9. Proceed to prep/analysis as today.

---

## 5. Design — by phase

### Phase 1 — Order-first check-in + boxing

#### 1a. Order-first entry (toggle on `ReceiveSample.tsx`)
- Add a **By order / By sample** toggle to Step 1 of `ReceiveSample.tsx`. The due-samples list (SENAITE `sample_due`, already carrying `client_order_number`) is the single data source for both modes — no new fetch.
- **By sample** (today's behavior): flat sortable list; row click opens the per-sample `ReceiveWizard`. Unchanged fallback; also the path for order-less/legacy samples.
- **By order** (default): group the same list client-side by `client_order_number` (reuse the family-grouping idiom from `inbox-families.ts`) into order cards — `WP-20066 · RTD Bio · 3 samples · 28 vials · {state mix}`. Selecting an order opens the **order-scoped receive session**.

#### 1b. Order-scoped receive session
- A thin wrapper around the existing `ReceiveWizard` that iterates the order's samples with a **sample stepper / progress rail** ("Sample 2 of 3"). Per sample it runs the existing wizard phases (`capture` → `assign` → `print` vial labels); advancing moves to the next sample. The wizard internals are reused, not rebuilt.
- Boxing is **not** a per-sample step (a per-sample wizard is scoped to one `parent` and can't see the order's other vials). After the per-sample loop, the session opens a single **order-level boxing stage** (1c).

#### 1c. Order-level boxing stage (after all samples captured/assigned/labeled)
- One view for the whole order: the order's vials grouped into bin lanes (HPLC / Endo / Ster) from **all** its samples. Xtra excluded (surplus not boxed; clerk may optionally box later — see edge cases). This matches the physical reality: label every vial first, then decide how many boxes each color bin needed.
- **+ Add box** → allocates the order's next `box_number` and a card labeled `{order_label}-{n}`, tagged with the lane's role/color.
- Clerk **drags vials** (from any of the order's samples) from the lane's "unboxed" tray into a box card. A vial belongs to at most one box; only vials whose `assignment_role` matches the lane may drop in. (Since which vial lands in which box doesn't matter operationally, a "fill" affordance may auto-distribute — implementation detail.)
- Each box card has **Print label** / **Reprint** (stamps `printed_at`/`printed_by`).

**Box label content** — rendered with the **existing label format/size** (reuse `LabelTemplate`/`PrintStep` conventions; no new media size). `{order_label}` is the order number **rendered exactly as the vial label renders it** (verbatim `client_order_number`, e.g. `WP-20066`) — the box code just appends `-{n}`; never prepend a second `WP-`:
```
WP-20066-3                         [ STERILITY ]   ← bin color
RTD Biosciences
4 vials · Order WP-20066
[QR: WP-20066-3]                                    ← optional, seeds scan v2
```
Vial count is informational (snapshot at print). QR encodes `label_code` for the future scan flow.

**Print mechanism.** Reuse the existing `window.print()` + off-screen print-area pattern (`PrintStep` / `usePrintLabel`).

**Data model (additive).**
- New table **`lims_boxes`** — keyed to the **order**, not a single sample:
  - `id` PK
  - `order_key` VARCHAR — `client_order_number` when present, else the parent `sample_id` (order-less fallback). Indexed.
  - `box_number` INT — running suffix `n` (monotonic per `order_key`; never reused)
  - `role` VARCHAR(8) — `hplc` | `endo` | `ster`
  - `created_by_user_id` FK → `users.id`, `created_at` DATETIME
  - `printed_at` DATETIME NULL, `printed_by_user_id` FK NULL
  - UNIQUE `(order_key, box_number)`
  - `label_code` is **derived** at read time as `{order_label}-{box_number}`, where `{order_label}` is the verbatim `client_order_number` (already `WP-…` style — do not add a prefix) or the `sample_id` for the order-less fallback. Not stored, to avoid drift, and guaranteed to match the vial label's order rendering.
- New column **`lims_sub_samples.box_id`** FK → `lims_boxes.id` NULL (a vial's box membership; NULL = unboxed). A box may hold vials from multiple parents that share the `order_key`.

**Endpoints (additive).**
- `GET /receive/orders/{order_key}` → the order's samples + vials + existing boxes (drives the order-scoped session).
- `POST /receive/orders/{order_key}/boxes` `{ role }` → creates the order's next box, returns it.
- `POST /receive/boxes/{box_id}/assign` `{ sub_sample_ids: [...] }` → sets `box_id` on those vials (validates role match + same `order_key`; records change).
- `POST /receive/boxes/{box_id}/print` → stamps `printed_at`/`printed_by`, returns render payload.

**Incremental receive.** Re-opening a checked-in order to add a vial supports adding it to an existing box or a new one and reprinting; `box_number` keeps climbing per order.

### Phase 2 — Inbox order tier + order drag

- Extend grouping to **Order → family (parent) → vials** in `src/lib/inbox-families.ts` (new `groupByOrderThenFamily`, null order → "No order" bucket) and render an order-level collapsible header in `WorksheetsInboxPage.tsx` / a small `InboxOrderGroup` component.
- **Order-level drag:** dragging the order header carries all of the order's *currently-filtered-bench* vials; drop = client-side loop over the existing per-vial add endpoints (collision guards intact, same pattern as today's family drag).
- No backend data change for this phase — `client_order_number` is already on items, and bench scoping already exists via the inbox filter.

### Phase 3 — Worksheet "Boxes to grab" panel

- Collapsible **Boxes to grab** panel on the worksheet view (`WorksheetDrawer` / `WorksheetDrawerItems`). Button-triggered if vertical space is tight.
- **Derivation (precise, membership-based):** for each item (vial) on the worksheet, resolve its vial's `box_id` → `lims_boxes` row; collect distinct boxes; group by order; show `label_code`, role/color, and how many of *this worksheet's* vials it holds. List only boxes whose role matches the worksheet's bench.
  - Vials with no `box_id` → surface a "**N vials not yet boxed**" note so the tech/clerk follows up.
  - A box partially on this worksheet still lists (grab the whole physical box).
- **Endpoint:** `GET /worksheets/{id}/boxes` → `[{ order_number, label_code, role, vials_on_worksheet, vials_in_box }]`, scoped to the worksheet's bench.
- **Self-contained stamping:** at add-to-worksheet time, also stamp `client_order_number` (+ resolved `role`) onto the `worksheet_item` so order/role display needs no live SENAITE/IS call.
  - New columns: `worksheet_items.order_number` VARCHAR NULL, `worksheet_items.role` VARCHAR(8) NULL. Populated in `POST /worksheets/.../add-group` + `create-from-drop` from the `InboxVialItem`.

### Phase 4 — SOP guide updates (controlled documents)

- Update `docs/guides/front-desk-sample-check-in.md` → add the **order-first (By order) flow** (select an order, walk all its samples/vials) and the **Boxing** step (add box, drag vials, print box label, overflow `WP-{order}-{n}`, place in matching color bin).
- Update `docs/guides/lab-tech-worksheets-variance.md` → add the **Order tier + order-drag** and the **Boxes to grab** panel.
- Rebuild the linked `public/guides/*.html`.
- **Document control (8.3):** each guide gets a visible **revision/version + date + approver** stamp; the change is identified in the doc. Do not edit silently.

---

## 6. Data model summary (all additive)

| Change | Table | Notes |
|---|---|---|
| New table | `lims_boxes` | keyed by `order_key` (order #, fallback sample id); `box_number`, `role`, created/printed attribution; UNIQUE `(order_key, box_number)` |
| New column | `lims_sub_samples.box_id` | nullable FK → `lims_boxes` (box may span parents sharing the order) |
| New column | `worksheet_items.order_number` | nullable; stamped at add-time |
| New column | `worksheet_items.role` | nullable `hplc`/`endo`/`ster`; stamped at add-time |

No `lims_orders` table is introduced — order is an existing string (`client_order_number`) used as the box grouping key, keeping the change additive.

Mk1 uses `create_all` + hand-rolled idempotent `ALTER TABLE` migrations (per workspace memory); follow that pattern, no destructive changes.

---

## 7. ISO/IEC 17025:2017 alignment

Accumark is **aligning to pursue** accreditation (not yet accredited) — bake awareness in now, no gold-plating.

- **7.4.2 Unambiguous identification.** The order→parent→vial→box→worksheet chain *is* the required identification system; it explicitly accommodates subdivision (parent→vials), grouping (boxing), and transfer (worksheet assignment). Identity rides on the vial label, so flexible boxing is safe.
- **7.4.3 Condition on receipt.** Preserved via existing capture photos + per-vial remarks.
- **7.5.1 Attributable records.** Box creation, vial→box assignment, and label prints record **who + when** (`created_by/at`, `printed_by/at`). Worksheet assignment already records analyst + timestamps.
- **7.5.2 / 8.4 Traceable amendments.** Moving a vial between boxes or reprinting a label must not silently erase prior state — record the change (minimum: `updated_at` + the action; full move-history is a candidate v2). Box numbers are never reused.
- **8.3 Document control.** Both SOP guides carry version + approver stamps (Phase 4).
- **7.11.2 LIMS change validation.** These features need verification evidence (the box→worksheet chain works end-to-end) before prod, consistent with the existing additive-only + production-sign-off non-negotiables.
- **7.4.4 Storage conditions.** **Out of scope** for this spec (flagged, not addressed) — color bins route by test type but do not monitor environmental conditions.

---

## 8. Deferred / future (seam only)

- **QR-on-box:** box label QR (`label_code`) is included so a scan gun can later identify a box.
- **Scan-to-batch:** scan box + each vial → system builds box membership and auto-prints. The `lims_boxes` + `box_id` model is the substrate; no v1 implementation.
- **Box size signaling** via QR-encoded bin size — only meaningful once capacity matters; not now.

---

## 9. Edge cases

- **Xtra vials:** not part of test work → not required to be boxed; optional box allowed but excluded from boxes-to-grab.
- **Vial rejected after boxing:** vial leaves the box (membership cleared or kept with rejected state); box stays valid; printed count may be stale (informational only).
- **Unboxed vials at worksheet time:** surfaced as a "not yet boxed" note, not a hard error.
- **Order spans benches:** HPLC boxes and Micro boxes for the same order both exist; each tech sees only their color.
- **Multiple same-customer orders in one package:** each is its own order group → its own box-number sequence (`WP-20066-…`, `WP-20071-…`); the clerk receives them in turn from the By-order list.
- **Order with multiple samples:** boxes span the order's samples — one HPLC box can hold HPLC vials from several samples of the same order.
- **No order number (pre-order/legacy sample):** use **By sample** mode; boxing still works with `order_key = sample_id`, label shows `{sample_id}-{n}` instead of `WP-…`.
- **Integration Service down:** inbox/worksheet order display unaffected (order number sourced from SENAITE parent / stamped on worksheet item, not a live IS call).

---

## 10. Testing (additive, no regressions)

- **Backend:** `lims_boxes` CRUD + role-match validation; `box_id` assignment; idempotent migration; `GET /worksheets/{id}/boxes` derivation (membership-based, bench-scoped); add-to-worksheet stamps order_number/role.
- **Frontend:** By-order/By-sample toggle + order grouping on the receive list; order-scoped session sample stepper; box step drag-and-drop + label render; inbox order grouping + order drag (extend `inbox-families.test.ts`); boxes-to-grab panel render incl. "not yet boxed" note.
- **Baseline:** run `npm run check:all`; diff against the known ~19-failure baseline (per workspace memory) — net-new failures only.
- **Live:** verify on the subvial stack (multi-vial parents across HPLC + Micro benches), as with prior subvial work.

---

## 11. Files likely touched (for the plan phase)

**Phase 1:** `ReceiveSample.tsx` (By-order/By-sample toggle + order grouping), new order-grouping helper + `OrderReceiveSession` wrapper (sample stepper), `ReceiveWizard.tsx` (+ `box` step), new `BoxStep.tsx` + `BoxLabelTemplate.tsx` (reuse existing label format), `src/lib/vial-label.ts` (box `label_code` helper), `src/lib/api.ts` (order + box endpoints); `backend/main.py` (order/box routes + `lims_boxes`), `backend/models.py` (`LimsBox`, `LimsSubSample.box_id`), `backend/database.py` (migration).
**Phase 2:** `src/lib/inbox-families.ts`, `WorksheetsInboxPage.tsx`, new `InboxOrderGroup.tsx`.
**Phase 3:** `WorksheetDrawer.tsx` / `WorksheetDrawerItems.tsx`, new boxes-to-grab component, `src/lib/api.ts`; `backend/main.py` (`GET /worksheets/{id}/boxes`, stamp add endpoints), `backend/models.py` (`worksheet_items.order_number`, `.role`), `backend/database.py`.
**Phase 4:** `docs/guides/front-desk-sample-check-in.md`, `docs/guides/lab-tech-worksheets-variance.md`, rebuilt `public/guides/*.html`, `WizardHeader.tsx` / `WorksheetsInboxPage.tsx` link copy if needed.

---

## 12. Open questions (none blocking)

- Whether to log full vial→box move history now (7.5.2) or defer to v2 (recommend: minimal `updated_at` now, history later).
- **Receive-list pagination:** the due list is fetched `getSenaiteSamples('sample_due', 50, 0)`. Client-side order grouping can split one order across the 50-row boundary. Mitigate by raising the limit or grouping server-side if real order volumes approach 50; confirm typical volumes at plan time.
