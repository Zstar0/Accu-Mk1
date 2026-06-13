# Replace Analyte (wrong-variant correction) — Design

*Created 2026-06-12. Accu-Mk1 `subsample-features` branch.*

## Problem

Customers routinely submit the **wrong variant** of a peptide (e.g. they pick a
generic "TB500" when they mean "TB500 (Thymosin Beta 4)"). Correcting this today
is a multi-step manual chore with no atomicity and a built-in way to leave a
sample half-corrected:

1. Edit the analyte's `Analyte{N}Peptide` field on the parent (Analytes card).
2. Separately remove the wrong Identity service and add the right one in Manage
   Analyses.
3. The per-vial purity/quantity rows are **never** fixed by either of the above
   (see "the PUR/QTY trap" below), so vials keep the old variant's data silently.

This design adds a single **Replace analyte** action that does the whole
correction transactionally (best-effort across SENAITE + Mk1, with a clear
summary), plus upgrades the standalone service-remove to retract worked results
behind a confirmation modal instead of silently skipping them.

## Current architecture (verified, not assumed)

**The analyte→peptide link is positional.** The parent AR carries four SENAITE
fields `Analyte1Peptide`…`Analyte4Peptide`. The backend (`main.py:11309`) walks
them in order — slot number *is* the position — strips the method suffix,
fuzzy-matches to a `Peptide`, and emits `data.analytes = [{slot_number, raw_name,
matched_peptide_name, declared_quantity}]`.

**Purity & Quantity are generic, slot-keyed.** On the parent the services are
`ANALYTE-{1-4}-PUR` / `ANALYTE-{1-4}-QTY` (regex `^ANALYTE-([1-4])-(PUR|QTY)$`,
`seeder.py:57`). They have **no peptide of their own** — the only link to TB500 is
the "2" in `ANALYTE-2-PUR` indexing slot 2 = `Analyte2Peptide`. The FE's
`formatAnalysisTitle` (AnalysisTable.tsx:476) parses "Analyte 2" → slot 2 →
`analyteNameMap` → "TB500 (…)". Plus aggregate generics `PEPT-Total`, `BLEND-PUR`,
`HPLC-ID`.

**Identity is peptide-specific.** Each peptide has a cloned `ID_<X>` service
(`ID_BPC157`, `ID_TB500BETA4`; "{Name} - Identity (HPLC)" pattern).

**Vials translate generic → per-substance.** At mirror/seed time
`seed_analyses_for_vial` (seeder.py) reads the parent's `Analyte{N}Peptide` via
`fetch_parent_analyte_slots`, matches the slot title → `ID_<X>` → `peptide_id` →
translates `ANALYTE-{slot}-PUR/QTY` into the per-substance `PUR_<X>` / `QTY_<X>`
services on the vial. So on a vial the peptide link is baked into the service's
`peptide_id`.

**Existing parent→vial cascades** (all triggered by service add/remove/reject on
the parent AR via the Integration-Service proxy → SENAITE):

| Cascade | Location | Behavior |
|---|---|---|
| `cascade_parent_add_to_vials` | `service.py:1128`, wired `main.py:8276` | re-runs idempotent seeder per non-xtra vial |
| `cascade_parent_remove_from_vials` | `service.py:1059`, wired `main.py:8356` | hard-deletes **pristine** vial rows only |
| `cascade_parent_reject_to_vials` | `service.py:992`, wired `main.py:12947` (SENAITE reject transition) | retracts/clears vial rows incl. unpopulated worksheet rows, **audited**, restorable on re-add |

Reusable primitives: `delete_pristine_analysis` (pristine guard), `seed_analyses_for_vial`
(slot→per-substance translation), `_candidate_vial_keywords`, `resolve_parent_analyte_target`.

**COA Alias** is a *separate* concept: `SampleAnalyteAlias` table (`main.py:8649`
set / `8700` clear) — a denormalized COA display string per slot. It does **not**
touch the binding.

### The two gaps this design closes

1. **Cascades fire on services, not on the slot field.** Editing
   `Analyte{N}Peptide` (the actual source of truth, written via the `senaiteField`
   EditableField path, same as `ClientSampleID`) triggers no cascade and does not
   reconcile the Identity service.
2. **The PUR/QTY trap.** Because the parent purity/quantity keyword
   (`ANALYTE-2-PUR`) never changes on a peptide swap, **neither the add nor the
   remove cascade fires for them.** Every vial keeps `PUR_<oldVariant>` /
   `QTY_<oldVariant>` until that slot is explicitly re-mirrored. This is the silent
   wrong-data risk.

## Decisions (locked)

1. **Entry point / lead:** the swap is driven by the **slot** (`Analyte{N}Peptide`),
   anchored on the ANALYTES-card A-row. The Identity service follows the slot, not
   the reverse.
2. **New-peptide service availability — offer-only.** Replace only offers peptides
   that already have a complete `ID_/PUR_/QTY_` service set. If the correct variant
   isn't set up, show "set this peptide up in Analysis Services first" — no
   auto-clone.
3. **Destructive path — retract, never hard-delete.** When removal (standalone or
   inside Replace) would hit a worked row, retract it (cleared from the active view,
   full audit trail, restorable on re-add) via the existing reject/retract path.
4. **Removal tiers:**
   | Row state | Behavior |
   |---|---|
   | Pristine (no value, not on worksheet, not promoted) | removed silently (as today) |
   | Worked but **unverified** | **confirmation modal** → on confirm, **retract** with audit |
   | **Verified / on published COA** (review_state ∈ {verified, published} or promoted) | **blocked** — "invalidate/retest first", not removable here |
5. **Declared Qty on swap — keep.** The swapped slot keeps `Analyte{N}DeclaredQuantity`
   (customer's declared mass, identity-independent); editable on the card as before.
6. **No Manage-Analyses grouping UI.** The current flat list is fine once Replace
   exists; out of scope.

## Design

### Step 1 — Repoint the slot (the canonical write)

Overwrite, for the chosen slot N:

| Field | Source | Action |
|---|---|---|
| Peptide | `Analyte{N}Peptide` (SENAITE AR) | overwrite with new peptide's identity title — drives everything |
| COA Alias | `SampleAnalyteAlias` (slot N) | **reset** (clear → defaults to new peptide's real name) |
| Declared Qty | `Analyte{N}DeclaredQuantity` | **keep** |

### Step 2 — Reconcile the parent Identity service

Remove `ID_<old>`, add `ID_<new>` via the same Integration-Service proxy the
add/remove endpoints use. This automatically fires `cascade_parent_remove_from_vials`
(drops pristine vial `ID_<old>`) and `cascade_parent_add_to_vials` (seeds `ID_<new>`).
If the parent's `ID_<old>` is worked → goes through the retract path per the tiers.

### Step 3 — Re-mirror the slot's PUR/QTY on vials (the new piece)

For each non-xtra vial of the family:
- Candidate old rows = the vial's analyses whose `analysis_service.peptide_id ==
  old_peptide_id` (i.e. `PUR_<old>` / `QTY_<old>` / `ID_<old>`).
- Apply the removal tiers: pristine → delete; worked-unverified → retract (under
  the same confirm); verified/published → block (and report).
- Re-run `seed_analyses_for_vial` so the seeder re-translates slot N →
  `PUR_<new>` / `QTY_<new>` / `ID_<new>`.

### Step 4 — Parent PUR/QTY

No action — they re-resolve positionally once `Analyte{N}Peptide` changed.

### Step 5 — Summary & guardrails

Best-effort across SENAITE + Mk1 (the writes are not in one DB transaction — same
posture as the existing cascades, which never raise and return a summary). Return:
`{ slot, old_peptide, new_peptide, parent: {...}, vials: { updated: [...],
retracted: [...], blocked: [...] } }`. Surface as a toast / panel:
*"Slot 2 → TB500 (Thymosin Beta 4). 1 parent + N vials updated, M results retracted,
K blocked (verified — invalidate first)."*

### Standalone remove (Manage Analyses trash icon)

Same tiers and modal. Today's silent-skip becomes:
- Pristine → remove as today (no modal).
- Worked-unverified on parent or any sub → **confirmation modal** listing the
  impact ("This will retract N entered result(s) across the parent and M vials and
  keep a record. Continue?") → on confirm, retract.
- Verified/published → blocked with the invalidate/retest guidance.

Replace reuses this exact impact-detection + modal.

## Backend

**New preview/detect** (drives the modal before any write):
`GET /…/samples/{sample_id}/analytes/{slot}/replace-impact?new_peptide_id=` →
`{ eligible_new_peptides_ok: bool, old_peptide, rows: { pristine: [...],
worked_unverified: [...], blocked: [...] } }`. Also reused by the standalone
remove as `…/analyses/{keyword}/remove-impact`.

**New orchestrator endpoint:**
`POST /…/samples/{sample_id}/analytes/{slot}/replace`
body `{ new_peptide_id: int, confirm_retract: bool }`.
- 400 if new peptide lacks a complete service set (offer-only gate).
- 409 / structured block if verified/published rows exist.
- 412 if worked-unverified rows exist and `confirm_retract` is false (FE shows
  modal, re-submits with `true`).
- Orchestrates steps 1–5; returns the summary.

**New service function** `replace_analyte_slot(db, *, parent_sample_id, slot,
new_peptide_id, confirm_retract, user_id)` in `lims_analyses/service.py`,
composing the existing primitives. Add a `retract` variant of the slot re-mirror
that routes worked rows through the audited reject path rather than
`delete_pristine_analysis`.

**Standalone remove upgrade:** the remove endpoint (`main.py` ~8351) gains the
tiered behavior; add a `confirm_retract` flag and the retract branch.

## Frontend

- **Replace action** on each ANALYTES-card A-row (next to the pencil), in
  `SampleDetails.tsx`.
- **Peptide picker** populated from peptides with a complete service set
  (offer-only); disabled/explained otherwise.
- **Impact/confirmation modal** (shared component) showing what will be retracted /
  blocked, voice mirroring the Manage Analyses help text ("…and it keeps a record").
- **Wire-up:** call replace-impact → modal → POST replace → invalidate
  `sample-details` + vial overlay queries → toast summary.
- **Standalone remove** in Manage Analyses gains the same modal via remove-impact.
- Reuse `formatAnalysisTitle` / `analyteNameMap` for any name display.

## Error handling / atomicity

- Each cross-system write guarded individually; one vial failure never kills the
  rest (existing cascade pattern). The endpoint never 500s on a partial — it
  returns the summary with per-target status so the tech sees exactly what still
  needs manual attention.
- Verified/published rows are detected **before** any write and reported in the
  preview, so the tech sees blockers up front.
- `Analyte{N}Peptide` written form-encoded (py2 isDecimal unicode constraint —
  see existing accumark field-edit path).

## Testing

- `replace_analyte_slot`: pristine vials (delete + reseed → new per-substance
  rows), worked-unverified (retract under confirm), verified (blocked, untouched),
  offer-only gate (missing service set → 400), COA-alias reset, declared-qty kept.
- Slot→old-peptide candidate resolution (peptide_id match) incl. the aggregate
  generics left alone.
- Standalone remove tiers (pristine/worked/verified).
- FE: Replace action renders per A-row; modal copy; offer-only picker; summary
  toast. (Lean on the pure backend logic for the cascade correctness; keep FE
  tests light.)

## Out of scope

- Auto-cloning services for a brand-new peptide variant.
- Manage-Analyses grouping UI.
- Changing the COA/variance report rendering.
- Bulk multi-slot replace (one slot at a time).
