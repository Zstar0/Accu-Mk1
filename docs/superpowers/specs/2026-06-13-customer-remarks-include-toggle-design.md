# Customer Remarks — "Include with Publish?" toggle + delivery timestamp

*2026-06-13. Adds explicit opt-in control over whether Customer Remarks are
delivered with a published COA, plus a Mk1-side "Delivered on" timestamp.
Builds on the shipped Customer Remarks feature
(`docs/superpowers/specs/2026-06-12-customer-remarks-design.md`).*

## Problem

Today Customer Remarks are **always** delivered with a published COA whenever the
field is non-empty — Mk1's generate-COA attaches `lab_remarks` to the COABuilder
`/process` body unconditionally. The lab wants:

1. An explicit **"Include with Publish?"** checkbox in the Customer Remarks
   section, so a remark can be authored/saved without forcing delivery.
2. A **"Delivered on &lt;publish date &amp; time&gt;"** timestamp shown in the
   Customer Remarks section once a remark has actually gone out with a COA.

## Decisions (Handler-approved)

1. **Default checked.** The checkbox defaults to **included** (`TRUE`), preserving
   today's "always sent when non-empty" behavior. No regression for in-flight
   samples. The tech unchecks to suppress.
2. **Checkbox always wins — even non-conforming.** Unchecking suppresses remarks
   on **any** COA, including non-conforming ones. This deliberately weakens the
   existing mandatory-remarks-on-non-conforming rule, and requires a COABuilder
   gate change (below) so the non-conforming 422 gate is skipped when delivery
   is intentionally suppressed.
3. **"Delivered on" is Mk1-only, stamped at generation.** Mk1 records
   `customer_remarks_delivered_at = utcnow()` when a COA is **successfully
   generated with remarks included**. That is the delivery moment Mk1 can
   observe (the remark is baked into the generated COA snapshot at this point;
   the customer email fires later via the IS publish webhook, outside Mk1). The
   UI labels it "Delivered on". No COABuilder/IS/WP plumbing for the timestamp.

## Architecture / data flow

```
Mk1 lims_samples
  ├─ customer_remarks            TEXT   (existing)
  ├─ customer_remarks_include    BOOL   DEFAULT TRUE   (NEW)
  └─ customer_remarks_delivered_at TIMESTAMP NULL      (NEW)

generate-coa (parents only):
  include = parent.customer_remarks_include
  body["include_lab_remarks"] = bool(include)          (always sent)
  if include and customer_remarks.strip():
      body["lab_remarks"] = customer_remarks.strip()
  POST /process/{id}
    └─ COABuilder gate:
         include_remarks = body.include_lab_remarks (default True if absent)
         if include_remarks and coa_requires_lab_remarks(results) and not lab_remarks → 422
         else embed lab_remarks (only when non-empty)
  on success (verification_code present) AND remarks were included:
      parent.customer_remarks_delivered_at = utcnow(); commit
```

Suppression (`include_lab_remarks: false`) means COABuilder embeds no
`lab_remarks` in `coa_data`. IS passes through whatever is in `coa_data`; WP
shows the email section / order-page button only when `lab_remarks` is
non-empty. So **no IS or WP change is needed** — both already guard on presence.

## Changes

### Mk1 (`subsample-features`)

- **Schema** (`backend/database.py`, next to the existing
  `ADD COLUMN IF NOT EXISTS customer_remarks` ALTER): two idempotent ALTERs —
  `customer_remarks_include BOOLEAN NOT NULL DEFAULT TRUE` and
  `customer_remarks_delivered_at TIMESTAMP` (nullable).
- **Model** (`backend/models.py`, `LimsSample`): `customer_remarks_include:
  Mapped[bool]` (`default=True, server_default=text('true')`),
  `customer_remarks_delivered_at: Mapped[Optional[datetime]]`.
- **Schema (Pydantic)** (`backend/sub_samples/schemas.py`):
  - `ParentSampleSummary`: add `customer_remarks_include: bool = True` and
    `customer_remarks_delivered_at: Optional[datetime] = None`.
  - `CustomerRemarksUpdate`: add `include: bool = True`.
- **Service** (`backend/sub_samples/service.py`, `set_customer_remarks`): accept
  `include: bool = True`; set `parent.customer_remarks_include = include`; add
  `include` to the audit `details`. Return value includes `customer_remarks_include`.
  Does **not** touch `customer_remarks_delivered_at` (that is generation-driven).
- **Routes** (`backend/sub_samples/routes.py`): pass `body.include` through in
  `update_customer_remarks`; populate the two new `ParentSampleSummary` fields in
  both builders (the `ensure`/POST path and `list_sub_samples`).
- **generate-coa** (`backend/main.py`, the parents-only block ~9159–9172 and the
  post-success block ~9253+):
  - Read `customer_remarks_include` off `_parent_row`. Always set
    `alias_body["include_lab_remarks"] = bool(include)`. Attach
    `alias_body["lab_remarks"]` only when `include` is true **and** the text is
    non-empty. Track a local `_remarks_included = bool(include and text)`.
  - In the success path (guarded on `verification_code`), when
    `_remarks_included`, set `_parent_row.customer_remarks_delivered_at =
    datetime.utcnow()` and commit. Best-effort, wrapped so a failure here never
    fails the (already-succeeded) generation.

### COABuilder (`feat/coa-identity-na-variance`, `scripts/server.py`)

- `ProcessSampleRequest.include_lab_remarks: Optional[bool] = None`.
- Gate change (line ~593–598):
  ```python
  include_remarks = body.include_lab_remarks if (body and body.include_lab_remarks is not None) else True
  if include_remarks and coa_requires_lab_remarks(data.results) and not lab_remarks:
      raise HTTPException(422, ...)
  ```
  Absent field ⇒ `True` ⇒ existing behavior (back-compat for any other caller).
  `False` ⇒ gate skipped; `lab_remarks` is empty anyway so nothing is embedded.
- Version bump + CHANGELOG entry.

### Mk1 FE (`src/components/senaite/SampleDetails.tsx`, `CustomerRemarksCard`)

- New props: `initialInclude: bool`, `deliveredAt: string | null`.
- Add an "Include with Publish?" checkbox (existing Checkbox/label primitives in
  the file) bound to an `include` state seeded from `initialInclude`.
- `dirty = text !== initial || include !== initialInclude`. `handleSave` sends
  `{ remarks, include }` via `updateCustomerRemarks` (extend its signature).
- When `deliveredAt` is set, render a muted line under the textarea:
  **"Delivered on &lt;formatted date &amp; time&gt;"** using the date/time
  formatter already used elsewhere in this file.
- Call site (~4350): pass `initialInclude={subData?.parent?.customer_remarks_include ?? true}`
  and `deliveredAt={subData?.parent?.customer_remarks_delivered_at ?? null}`.
- `src/lib/api.ts`: `updateCustomerRemarks(sampleId, remarks, include)` — add the
  `include` arg to the PUT body.

## Out of scope

- Delivering the "Delivered on" timestamp to the customer (email / order page).
  It is a lab-facing record only.
- A true publish-webhook timestamp (would require an IS → Mk1 callback). Mk1
  stamps at generation, which is the snapshot point.
- Re-architecting the existing remarks delivery rail (IS/WP untouched).

## Testing

- **Mk1 service/route** (sqlite): `set_customer_remarks(..., include=False)`
  persists the flag + audit detail; `ParentSampleSummary` carries both new fields.
- **Mk1 generate-coa body** (mirror the existing `lab_remarks`/`variance_replicates`
  body-assembly tests): unchecked ⇒ body has `include_lab_remarks:false` and **no**
  `lab_remarks`; checked + text ⇒ both present. `delivered_at` set after a
  simulated successful generation with remarks included; **not** set when
  suppressed.
- **COABuilder** (`tests/test_lab_remarks_gate.py` companion): non-conforming +
  `include_lab_remarks=False` + empty remarks ⇒ no 422 (passes); field absent ⇒
  still gates (back-compat); `include_lab_remarks=True` + empty ⇒ gates.
- **FE** (`src/test`): checkbox toggles dirty; Save posts `{remarks, include}`;
  "Delivered on" renders only when `deliveredAt` present.

## Risks / notes

- **Weakened compliance gate.** A non-conforming COA can now ship with no
  customer remarks (Handler-approved). The audit log still records the
  `customer_remarks_updated` event with the `include` flag, so suppression is
  traceable.
- **"Delivered" label vs. true publish.** The timestamp marks COA *generation*
  (snapshot), not the customer email. Accurate enough for the lab-facing record;
  noted here so a future true-publish callback can refine it.
- Two-repo change (Mk1 + COABuilder). COABuilder must deploy with/before Mk1 so a
  suppressed-non-conforming generation doesn't 422 against an old gate. For local
  UAT both run from their respective checkouts.
- `customer_remarks_include` is `NOT NULL DEFAULT TRUE`; existing rows backfill to
  `TRUE` ⇒ unchanged behavior.
