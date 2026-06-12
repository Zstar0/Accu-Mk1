# Customer Remarks (Lab Remarks) — Design

*2026-06-12. Customer-facing lab remarks for published COAs, delivered via the
existing COA-publish pipeline. Also establishes the pathway the future
"Variance Report" order-page button will reuse.*

## Problem

Lab techs need a way to write a short customer-facing paragraph (one or two) that
is delivered with a published COA — context, caveats, interpretation. Today the
parent sample has only the SENAITE-backed "Remarks" field, which is internal.
Remarks are optional in general but **mandatory when the COA is non-conforming**
(the customer must get insight into why).

Delivery surfaces: the COA-published email and a "Lab Remarks" button on the
customer's order page (`/portal/order/`), next to the per-sample COA row
(Download / Get QR). A future "Variance Report" button will sit on the same row
and must be able to reuse this pathway.

## Decisions (Handler-approved)

1. **Rename, don't repurpose.** The existing parent-sample "Remarks" section
   becomes **Internal Remarks** — behavior unchanged (SENAITE `Remarks` field).
   A new **Customer Remarks** section is added below it, Mk1-native.
2. **Snapshot at generation.** The remark travels with the COA generation:
   Mk1 → COABuilder `/process` body → `coa_data` → IS generation record → WP
   notify payload → order meta. Editing remarks later requires re-generating /
   re-publishing the COA to refresh the customer copy — re-publish IS the
   refresh mechanism. No new cross-service read paths.
3. **Hard gate, every generation.** A non-conforming COA (any identity or purity
   row non-conforming) with empty `lab_remarks` → 422, on initial generation AND
   re-publish. Since the field persists on the sample, re-publishes only block if
   the lab actively cleared the text.
4. **Gate lives in COABuilder.** Conformance is computed by the
   `ConformanceEngine` (98% spec, identity matching, N/A logic) — Mk1 doesn't
   know it. COABuilder checks the engine output and 422s before PDF generation;
   Mk1 relays the message to the tech via the existing error path.
5. **Surfaces:** email + order-page button. NOT rendered on the PDF or the
   public verify page (possible follow-ups).

## Architecture / data flow

```
Mk1 lims_samples.customer_remarks
  └─ generate-coa → POST /process body { lab_remarks }          (parents only)
       └─ COABuilder: gate (non-conforming + empty → 422)
            └─ CoAData.lab_remarks → _build_coa_data_json → coa_data["lab_remarks"]
                 └─ IS generation record (coa_data JSONB)
                      └─ publish: COANotificationPayload.lab_remarks
                           └─ WP /coa/notify → _accumark_coas[sample_id]["lab_remarks"]
                                ├─ coa_published email: "Remarks from the Lab" section
                                └─ order page COA row: "Lab Remarks" button → modal
```

The future Variance Report button follows the same rail: another `coa_data` key →
payload field → `_accumark_coas` key → row button. Documented here; not built.

## Changes

### Mk1 (`subvial/continue`)

- **Schema:** `lims_samples.customer_remarks` TEXT NULL — idempotent hand-rolled
  ALTER (the Mk1 migration convention) + model field.
- **API:** extend the existing parent-sample update path (sub_samples routes
  service layer) with a `PUT /api/samples/{sample_id}/customer-remarks`
  (or equivalent additive route in the sub_samples module) that sets the field
  and emits an activity event (`customer_remarks_updated`, old/new length —
  not full text — in details).
- **UI (`SampleDetails.tsx`):** "Remarks" section header → **Internal Remarks**
  (SENAITE-backed, unchanged). New **Customer Remarks** card below: textarea +
  Save, helper text "Delivered to the customer with the published COA. Required
  when the COA is non-conforming." Shows current value from the parent fetch.
- **generate-coa:** for parent samples, load `customer_remarks`; if non-empty,
  add `lab_remarks` to the existing `/process` body (`alias_body`). Always sent
  when present — COABuilder decides whether it was required.

### COABuilder (`feat/coa-identity-na-variance`)

- `ProcessSampleRequest.lab_remarks: Optional[str]`.
- **Gate** in `process_sample` after `fetch_sample_data` (engine has run):
  non-conforming = any results-table row with `test_type` IDENTITY or PURITY and
  `conforms is False` (the digital view for variance rows — parent figure).
  If non-conforming and no `lab_remarks` (None/blank) → HTTP 422
  `detail="Non-conforming COA requires customer remarks. Add Customer Remarks on
  the sample page and regenerate."`. Mk1 surfaces this message via its existing
  COABuilder-error relay.
- `CoAData.lab_remarks: str = ""`; threaded `server → fetch_sample_data → CoAData`
  (not through the engine — remarks don't affect results).
- `_build_coa_data_json`: add top-level `coa_data["lab_remarks"]` when non-empty.
- Version bump (2.17.0) + CHANGELOG.

### Integration Service

- `COANotificationPayload.lab_remarks: str | None = None`, included in
  `to_dict()` when set.
- Both publish call sites (webhook primary path, desktop publish path) read
  `generation.coa_data.get("lab_remarks")` onto the payload. Additional-COA
  child publishes inherit the parent generation's remarks (same sample) — read
  from the child's own coa_data, which COABuilder copies (children are generated
  from the same CoAData; verify at plan time, else fall back to parent
  generation's coa_data).

### WordPress (wpstar theme)

- `COAEndpoint::handle_primary_coa_notification`: persist
  `lab_remarks` into the `_accumark_coas[sample_id]` entry (sanitized,
  `sanitize_textarea_field`).
- **Email** (`class-wc-email-coa-published.php` + both templates): pass remarks
  through `trigger()` → template arg; render a "Remarks from the Lab" section
  (styled like existing info blocks) only when non-empty. Plain template gets a
  text section.
- **Order page** (`portal-view-order.php` COA rows, primary rows only): a
  "Lab Remarks" button when the entry has non-empty `lab_remarks`; opens a modal
  (existing portal modal pattern) titled "Remarks from the Lab — {sample}" with
  the text. Additional-COA rows never show the button.

## Out of scope

- Rendering remarks on the PDF COA or the public verify page.
- The Variance Report button itself (pathway documented above).
- Back-filling remarks onto already-published COAs (regenerate to deliver).
- Sub-sample COA generation path (parent-level feature).

## Testing

- Mk1 (sqlite): route/service test — set/update customer_remarks + activity
  event; generate-coa body includes `lab_remarks` when set (test at the
  body-assembly level mirroring variance_replicates tests).
- COABuilder (standalone): gate tests — non-conforming + no remarks → 422
  semantics (the gate helper returns "blocked"); non-conforming + remarks →
  passes; conforming + no remarks → passes; `coa_data["lab_remarks"]` present
  when set, absent otherwise. Factor the gate check into a pure helper
  (`_requires_lab_remarks(results_table) -> bool`) so it's testable without the
  HTTP layer.
- IS: payload serialization test (`lab_remarks` in `to_dict`), publish path sets
  it from coa_data (existing test patterns in the IS repo).
- WP: manual verification (no theme test harness) — meta stored, email preview
  (`email-preview-page.php` supports coa-published), order-page button + modal.

## Risks / notes

- The remarks gate fires inside COABuilder, so Mk1's structured-422 UX (used by
  the attachments gate) doesn't apply — the tech sees the relayed message via
  the generic COA-failure toast. Acceptable; revisit if the lab wants the
  styled error.
- `_accumark_coas` is an array meta — adding a key is additive and safe for
  existing entries (PHP `??` guards on read).
- Email/order page must HTML-escape the remarks (plain text only, `nl2br` for
  paragraphs).
