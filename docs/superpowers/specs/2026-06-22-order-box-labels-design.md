# Order Box Labels — design

*2026-06-22. Accu-Mk1 Receive Wizard → Print Labels tab.*

## Problem / context

At check-in the lab prints vial labels, then sorts vials into **color-coded
department boxes** (green=HPLC, orange=Endo, purple=Sterility/PCR). They want a
**"Print Order #"** button that prints a label for each department's box, so a
box reads "this is order WP-3910's HPLC vials, expect N."

The button lives in one sample's wizard, but the count must be **order-level**:
how many vials the *whole order* will place in each department's box.

## Decisions (confirmed)

- **One label per department with a non-zero count** (HPLC / ENDO / PCR).
- **Count = expected VIALS per department, summed across the whole order**,
  based on **what was ordered** (not what's checked in so far). Sterility = 2
  vials per sample per lab protocol; HPLC/Endo = 1 each.
- **No QR for now** (deferred; the customer-detail `orderID` param is also out
  of scope).
- Label fields: **WP-#### (large/dominant)**, **department + vial count**,
  **order date**.

## Architecture

All in Accu-Mk1 — no integration-service change. Mk1 already reads the
integration DB's `order_submissions` directly (the worksheet inbox does this via
`get_integration_db()`), and already derives per-sample vial demand
(`sub_samples.service.derive_base_demand`).

### Backend — new endpoint

`GET /orders/{order_number}/box-label-summary` →
```json
{ "order_number": "WP-3910", "order_date": "2026-06-15", "counts": { "hplc": 4, "endo": 1, "ster": 2 } }
```

Logic:
1. Locate the order's `order_submissions` row by order number (mirror the
   explorer's `search_order_number` lookup; confirm the exact column at
   plan time — `order_id` vs a number field in `payload`).
2. Collect the order's samples from `sample_results` (dict → each entry's
   `senaite_id`), the same extraction the inbox uses.
3. For each sample `senaite_id`, `fetch_sample_services(senaite_id)` →
   `derive_base_demand(services)` → accumulate `{hplc, endo, ster}`.
4. `order_date` = `order_submissions.created_at` (date portion).
5. Soft-fail: order not found → 404; a sample whose services 404 → skip it
   (it contributes 0), so a partially-mapped order still returns a usable total.

`derive_base_demand` already returns `{hplc:0/1, endo:0/1, ster:0/2}`, so summing
across samples yields total expected vials per department. Counts of 0 are
omitted from the printed labels (no empty-box label).

> N IS calls per order (N = sample count, typically 1–few) — acceptable. If the
> `order_submissions.payload` proves to already carry the per-sample service
> flags, derive locally to avoid the round-trips (plan-time optimization).

### Frontend — Print Labels tab

- New **"Print Order #"** button beside the existing "Print N labels" button.
- On click: call `getOrderBoxLabelSummary(orderNumber)` (new `lib/api.ts`
  wrapper), build one box-label model per department with count > 0, render them
  into a **separate** print container, then `window.print()`.
- **Print isolation:** the existing vial-label print hides everything except
  `.print-area`. The order labels need their own scope so "Print Order #" prints
  *only* box labels and "Print N labels" prints *only* vial labels. Approach: a
  small state flag (e.g. `printMode: 'vials' | 'order'`) that controls which
  container carries the `.print-area` class at print time; reset after print.
- **Box-label layout** (same 2"×¼" / 50.8mm × 6.35mm media + `@page`, no QR):
  - **WP-3910** — large, dominant (fills most of the ¼" height).
  - Second line: **department + vial count** (e.g. "STERILITY · 2 vials") and
    **order date**, right-aligned, smaller — reusing the same right-padding fix
    so it clears the printer's right margin.
  - One `<div class="order-label">` per department; new CSS rules in
    `PrintStep.css` (screen preview + `@media print`).

## Deploy

Touches the **Mk1 backend** → a real release: **version bump 1.0.2 → 1.0.3**
(`package.json` + `src-tauri/tauri.conf.json` + `CHANGELOG.md`), backend +
frontend deployed together (`deploy.sh --skip-release`), health check confirms
1.0.3. Not the frontend-only-hold-at-1.0.2 path used for the prior label hotfixes.

## Testing

- **Backend:** pytest for the summary computation — given a stubbed
  `order_submissions` row + stubbed `fetch_sample_services`, assert the per-
  department sums (incl. ster=2, 0-count omission, sample-services-404 skip).
  Run in-container (`docker exec accu-mk1-backend python -m pytest`).
- **Frontend:** typecheck; the print isolation + layout verified by render
  (screen preview) and a physical test print, like the prior label work.

## Out of scope

- QR code on the box label (deferred).
- customer-detail `orderID` query param + page pre-fill (deferred with the QR).
- Counting received/assigned vials (we count *ordered* expected demand).
- Orders spanning behavior beyond the single `order_submissions` row.
