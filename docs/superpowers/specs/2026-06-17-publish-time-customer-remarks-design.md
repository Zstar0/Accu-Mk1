# Publish-time Customer Remarks — Design

*2026-06-17. Target: 1.0.1 (post Accumark 1.0 Platform Release). Cross-service:
Accu-Mk1 + Integration Service + Accu-Mk1 frontend.*

## Problem

Customer Remarks (with the "Include with Publish?" toggle) are currently captured
into the COA at **Generate** time: the generate path (`main.py` ~9150) sends
`lab_remarks` + `include_lab_remarks` to COABuilder `/process`, and the publish
notification later re-sends whatever that generation stored.

But the lab's real workflow is **generate → review the generated COA → write the
remark → publish**. The remark doesn't exist at generate time, so it never reaches
the published COA. Observed on **BW-0015** (2026-06-17): COA generated 15:18:43,
remark set 15:21:13 (include=true, 302 chars), published 15:21:21 → the WP
notification carried **no `lab_remarks`**, the email had no remark, and
`customer_remarks_delivered_at` stayed NULL. The remark publishing alone can't pick
it up because Publish re-sends the stale generation.

Key facts that shape the fix:
- `lab_remarks` is **not rendered on the PDF or digital COA** — it's purely
  customer comms (the COA email + the order-page "Lab Remarks" button). So there is
  **no PDF/email consistency constraint**; delivery can move to publish freely.
- The COABuilder non-conforming "needs an explanation" gate keys on
  `include_lab_remarks` at generate time. **Out of scope here** — left as-is.

## Decision

Capture and deliver the customer remark at **Publish** time, from the current
Accu-Mk1 value, not from the generation.

## Scope

In:
- COA email (`WC_Email_COA_Published` / `_Reissued`) — already renders `lab_remarks`.
- Order-page **Lab Remarks button** (WP, reads `_accumark_coas[sid].lab_remarks`).
- Stamp + display the delivery timestamp.

Out (explicitly, for now):
- PDF / digital-COA rendering of the remark.
- Variance report or any other surface.
- Moving the COABuilder non-conforming gate to publish (separate decision).

## Design

### Accu-Mk1 — `POST /wizard/senaite/samples/{sample_id}/publish-coa` (`main.py:9328`)
- Inject a `db` session; read the parent `LimsSample.customer_remarks` +
  `customer_remarks_include` (same logic as the generate path 9175-9180).
- Send `lab_remarks` (when include && non-empty) + `include_lab_remarks` in the
  **body** of the POST to IS `publish-coa` (today it sends no body).
- After a successful publish, **stamp `customer_remarks_delivered_at = utcnow()`**
  (move this off the generate path at 9277-9279). Re-publish overwrites it with the
  latest delivery time. Include-off / empty remark → do not stamp.

### Accu-Mk1 — generate path (`main.py` ~9150)
- Stop driving *delivery* from generate: remove the `delivered_at` stamp. Keep
  sending `include_lab_remarks` to COABuilder only if the gate still needs it
  (gate behavior unchanged). The generation's stored `lab_remarks` is no longer the
  source of truth for the email — publish overrides it.

### Integration Service — `POST /explorer/samples/{sample_id}/publish-coa`
- Accept optional `lab_remarks` + `include_lab_remarks` in the request body.
- Set `lab_remarks` on the WP COA-notify payload it emits (override the generation's
  stored value). When include is false/empty, emit empty `lab_remarks`.
- Bump IS to 1.0.1.

### Accu-Mk1 frontend — `SampleDetails.tsx`
- Near the Customer Remarks block, when `customer_remarks_delivered_at` is set, show
  e.g. **"Delivered to Customer 9/1/23 12:32 PM"** using the page's existing
  timestamp format + timezone. When unset (never published / include off), show
  nothing (or a muted "Not yet delivered").

## Edge cases
- Include OFF or empty remark at publish → no `lab_remarks` delivered, no stamp,
  FE shows no delivered line.
- Re-publish (COA Reissued) → updates `lab_remarks` to current value + refreshes
  `customer_remarks_delivered_at`.
- Editing the remark after a delivery, before the next publish → the *next* publish
  delivers the new text and re-stamps. (The displayed timestamp reflects last
  delivery, so an edited-but-unpublished remark still shows the prior delivery time —
  acceptable; optionally flag "edited since last delivery" later.)

## Versions
Accu-Mk1 → 1.0.1, Integration Service → 1.0.1. WordPress: no change (renders already).

## Test (BW-0015)
1. Set a Customer Remark + Include on BW-0015; Publish.
2. Assert `lims_samples.customer_remarks_delivered_at` is stamped.
3. Assert the WP COA-notify payload carries `lab_remarks` (WP debug.log) and the
   "Reissued" email in MailHog (:15400) renders the remark.
4. Assert `SampleDetails` shows "Delivered to Customer <ts>".
5. Regression: a publish with include OFF delivers no remark and stamps nothing.
