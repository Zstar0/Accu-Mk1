# Endotoxin slice 3: Promote to Parent from the worksheet, per-result LOQ and LOD, unit-aware specs

Status: design approved in conversation with the Handler, 2026-10-12. Written for the Handler's review before
an implementation plan. Builds on `feat/endo-worksheet-v2` (slices 1 and 2) and lands after it merges.

## 1. What this is

Analysts finish an endotoxin run on the 2 mL worksheet (v2) and today retype each result into the vial's
analysis row by hand. This slice adds **Promote to Parent** to the worksheet's Results box: tick rows, press
one button, and Mk1 fills each vial's endotoxin result and promotes it to the parent sample, where a reviewer
verifies it on the sample page as today. Each result also carries its own **LOQ** and **LOD**, so a below-LOQ
result such as "<25 EU/vial" is stored as the number 25 with LOQ 25, and the COA prints it as "< LOQ" with 25
in its LOQ column. Peptide endotoxin specs move to **350 EU per vial** without disturbing bac water (EU/mL) or
any result already in EU/mL, because the spec a result is judged against is now chosen by its unit.

## 2. Decisions (Handler, 2026-10-09 to 2026-10-12)

| # | Decision |
|---|---|
| D1 | Promote to Parent from the Results box with per-row checkboxes: fill the vial result, then promote vial to parent; the parent result waits for a reviewer on the sample page (R7, 10-09). |
| D2 | Native results only (`ENDOTOXIN-USP85LAL`). SENAITE-born `ENDO-LAL` rows keep manual entry and get no Promote (10-12). |
| D3 | LOQ and LOD are fields on the result row, not new services (R11, 10-09). "<25" is stored as 25 with LOQ 25; the COA's existing rule (value at or below LOQ prints "< LOQ") gives the "<". |
| D4 | Peptide endotoxin specs move to 350 EU per vial (R6). Bac water stays EU/mL (0 to 0.25). |
| D5 | Spec choice is unit-aware: EU/mL and EU/vial rows stay active side by side; a result is judged against the row in its own unit. No EU/mL row is deactivated (Dennis: deactivation could break bac water). |
| D6 | The browser sends the values the analyst sees; the server checks eligibility and records where each value came from (option B). Same trust as typing the value into the analysis row today. |
| D7 | Typed readings (no reader export) may be promoted, marked "typed, no reader record" for the reviewer. |
| D8 | Invalid and inconclusive rows, and a "<" reading whose number is not the cartridge's sensitivity, cannot be promoted. |

## 3. Production facts this design rests on (read-only queries, 2026-10-12)

- `ENDOTOXIN-USP85LAL` (service 281) is Mk1-native, unit EU/mL, numeric. In the 120 days to 10-12: 417 vial
  results promoted to 409 published parent results in EU/mL; vial rows carry no unit (it is stamped at
  promote). `ENDO-LAL` (service 77) is SENAITE-born, unit EU/mg, 834 verified parent results.
- Active spec rows on 281: catch-all (no sample type, no peptide) range 0 to 5 EU/mL, LOQ 2.5; Bacteriostatic
  Water 0 to 0.25 EU/mL, LOQ 0.2; per-peptide rows for peptides 40 and 35 (LOQ 2.5) and 64 (LOQ 3.75); about
  twenty inactive historical rows.
- Of the 459 samples with a native endotoxin result, all 38 bac water samples resolve to the bac water row;
  Peptide (293) and Peptide Blend (89) samples resolve to the catch-all; 39 to per-peptide rows.
- Method 26 "Endotoxin" rev 1 (active) is linked to 281 **without** `is_default`, so no worksheet resolves a
  method today (a v2 launch step fixes this; section 9).

## 4. Storage: LOQ and LOD on results

Three nullable columns on `lims_analyses`, on vial and parent rows alike, added by idempotent
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `database._run_migrations`:

| Column | Type | Meaning |
|---|---|---|
| `loq` | double precision | the result's limit of quantitation, in the result's own unit (`result_unit`) |
| `lod` | double precision | the result's limit of detection |
| `lod_unit` | text | LOD's unit (EU/mL: the cartridge's sensitivity), which differs from the result's |

- Plain floats, not `NUMERIC`, so the amendment audit (`TRACKED_FIELDS`, `lims_analyses/service.py`) can record
  them: `loq`, `lod` and `lod_unit` join `TRACKED_FIELDS` and the "result entered" grouping (`only_result`).
- **Copied:** promote copies them from the source row to the parent; retest carry copies them with the value.
- **Cleared:** reset clears them; both un-promote paths (a source retest un-promoting the parent) clear them on
  the parent; a new retest row starts without them.
- A below-LOQ result is stored as the number equal to its LOQ: `result_value = "25"`, `loq = 25`. The "<" is
  implied by value at or below LOQ. The verdict always runs on the number, so nothing new has to parse "<".

## 5. Promote from the worksheet

### 5.1 Screen (Box 3, `EndoResultsBox.tsx`)

- A checkbox on every eligible row and a **Promote to Parent (n)** button in the box's actions. A row that is not
  eligible shows a disabled checkbox with the reason on hover (section 5.2). A row whose vial result is already
  promoted shows a "Promoted" chip instead.
- The button opens a confirm dialog listing each ticked sample with the value, unit, LOQ, LOD and verdict that
  will be sent. Confirm sends one request; the dialog then reports row by row: promoted (with the parent result's
  state) or not promoted and why. Promoted rows refresh to the "Promoted" chip.
- Stock worksheets show no checkboxes and no button. SENAITE-born `ENDO-LAL` rows show no checkbox (the reason
  on hover: "manual entry: SENAITE-born"). Already-promoted rows show the "Promoted" chip on open and completed
  worksheets alike.

### 5.2 Eligibility (shown in the UI, re-checked on the server)

A row is eligible when all of these hold:

1. Its vial carries exactly one live endotoxin analysis (not `retested`, not `rejected`/`retracted`) and that
   analysis is `ENDOTOXIN-USP85LAL`, Mk1-native.
2. That analysis is `unassigned`, `assigned` or `to_be_verified` (not `promoted`, not parent-tier).
3. The worksheet row has a reading (typed or imported) and its verdict is Pass or Fail.
4. Not Invalid: a stored reader record that fails the server's `reader_validity` refuses the row.
5. Not inconclusive: a "<" result whose LOQ is above the limit (350 EU/vial for peptides, 0.25 EU/mL for bac
   water) cannot show a pass and needs a rerun on a more sensitive cartridge.
6. A "<" reading's number equals the row's cartridge sensitivity (its LOD). Otherwise the stored value and LOQ
   would not line up and the COA would lose the "<".
7. Unit: EU/vial for peptides, EU/mL for bac water.

### 5.3 Request and server behaviour

`POST /worksheets/{worksheet_id}/promote` (logged-in users; refused on staging worksheets; allowed on open and
completed worksheets):

```json
{ "rows": [ { "item_id": 123, "value": 25, "unit": "EU/vial", "loq": 25, "lod": 0.05, "lod_unit": "EU/mL" } ] }
```

At most one entry per item and no more entries than the worksheet has items (else 400). Each row is handled on
its own, so one refusal never blocks the others. For each row the server:

1. **Re-checks** every rule in section 5.2 from stored data: the item's reading (`parse_reading`), its reader
   record (`reader_validity` with the worksheet's method parameters), the vial's live endotoxin analysis, the
   row's cartridge sensitivity (the row's own cartridge, else the run's, else the method default), and the unit
   against the sample's form (bac water rule as in v2). It also checks the sent numbers: `value >= 0`, `loq > 0`,
   `lod > 0`, `lod_unit == "EU/mL"`, and `lod` equals the cartridge sensitivity. For a "<" reading, `value` also
   equals `loq` (relative tolerance 1e-9). An exact reading has no further rule: if its value happens to sit at
   or below its LOQ, the COA's existing censoring prints "< LOQ". Inconclusive is checked against the limit of
   the spec the result would be judged by (section 6).
2. **Fills the vial result** through one internal service call (not the HTTP submit route, which takes no unit):
   `result_value`, `result_unit`, `loq`, `lod`, `lod_unit`, `method_id` = the worksheet's pinned endotoxin method
   (pinning happens as in v2 when the first reading or print resolves a method), and the instrument already
   stamped on the analysis by the reader import (left unchanged when present). The row moves to
   `to_be_verified` (or stays there, overwritten in place, the existing self-edge).
3. **Promotes** it with `contribution_kind = chosen`, through the promote logic moved out of the route into one
   shared function (`lims_analyses` service layer) that both the sample page's route and this endpoint call:
   target resolution, retest supersession, commit-first, the post-commit cascade, and the SENAITE gate (skipped
   for this Mk1-native service). The parent result lands `parent_to_verify` with the same values and fields.
4. **Records the source**: the transition rows' `reason` names the worksheet and row ("promoted from worksheet
   WS-24 row 3"), and one `audit_logs` row (`operation = 'endo_worksheet_promoted'`, entity the parent analysis)
   carries `{worksheet_id, item_id, sample_id, reading, reader_test_id or "typed, no reader record",
   cartridge_type_id, cartridge_sensitivity, total_dilution, water_ml, value, unit, loq, lod, lod_unit}`.

Response: `{"results": [{"item_id", "promoted": true, "parent_analysis_id", "state"} | {"item_id", "promoted":
false, "reason"}]}`. Reasons are short sentences the dialog shows as they are, one per rule:

| Rule | Reason |
|---|---|
| not native | "manual entry: SENAITE-born endotoxin" |
| no single live endotoxin analysis | "the vial has no endotoxin analysis" / "the vial has more than one endotoxin analysis" |
| already promoted | "already promoted" |
| parent already holds a result | "the parent already holds a result; retest the vial to replace it" |
| no reading | "no reading" |
| Invalid | "Invalid: " + the reader record's reasons (for example "spike CV 30 % over 25 %") |
| inconclusive | "inconclusive: LOQ 500 EU/vial is above the 350 limit" |
| mismatched "<" | "the reading <0.1 is not this cartridge's sensitivity (0.05)" |
| wrong unit | "peptides promote in EU/vial" / "bac water promotes in EU/mL" |
| bad numbers | "the value, LOQ or LOD does not match the worksheet row" |

## 6. Unit-aware specs

- **Uniqueness.** The three partial unique indexes on `analysis_service_specs` (peptide, sample type and
  catch-all scopes, each `WHERE active`) gain the unit: `lower(btrim(coalesce(unit, '')))`. They are replaced in
  one transaction by indexes with new names (`..._unit`); the old names are dropped. One active row per scope per
  unit.
- **Lookup.** `coa.spec_rules.resolve_spec(db, service_id, matrix, peptide_id=None, unit=None)`. With a unit, each
  scope (peptide, then sample type, then catch-all) is filtered to rows whose unit matches (trimmed,
  case-insensitive) and the first scope with a match wins. So a new EU/vial result for a peptide that only has an
  EU/mL per-peptide row falls through to the Peptide EU/vial row. Without a unit the lookup behaves as today, and
  a scope holding two active rows raises (loud, as `scalar_one_or_none` does now) rather than guessing.
- **Every caller passes the unit:** the COA build (`native_sections.py`, the row's `result_unit` or the service
  unit), the older HPLC rows in `legacy_rows.py`, the table's spec display (`display_spec_fields`), and the
  service page's "How results are judged" panel (which lists every active row with its unit).
- **No spec in the result's unit**: the COA stops with a clear reason ("No active Endotoxin USP85 LAL spec in
  EU/vial for Peptide") instead of judging against another unit.
- **The new row**, added by the lab in the spec editor at launch: service 281, sample type **Peptide** (blends
  fold into Peptide), range 0 to 350, unit **EU/vial**, LOQ empty (each result carries its own). It is never the
  catch-all, so a bac water result can never be judged against it. Every EU/mL row stays active: the catch-all
  (older EU/mL results and any sample type that matches nothing), bac water's 0 to 0.25, and the per-peptide
  rows.

## 7. COA and sample page

- **The result's LOQ wins.** In `native_sections.py`, the effective LOQ is the row's `loq` when set, else the
  spec row's. `_result_display` prints "< LOQ" when the value is at or below it (range rules, as today), and the
  row's wire `specification.loq` carries that effective LOQ, which is where coabuilder's LOQ column and the
  digital COA's `loq` already read from. So coabuilder, WordPress and the Integration Service need no change; the
  LOQ column reads "LOQ (EU/vial)" when the section's rows share the unit. LOD stays off the COA (slice 4).
- **Verdict unchanged:** the number against the spec chosen by unit.
- **Sample page (reviewers).** The analysis payloads (`AnalysisResponse`, `SenaiteShapeAnalysisResponse`,
  `NativeParentAnalysisRow`) carry `loq`, `lod` and `lod_unit`; the analysis table shows "LOQ 25 · LOD 0.05 EU/mL"
  in small text under the value when present, and the Spec column shows the result's LOQ in place of the spec's.
  The stored number is shown as stored.

## 8. Error handling

- Promote: per-row refusals with reasons (section 5.3), never a partial write within a row: the fill and the
  promote of one row commit together or not at all. A request-level 400 for malformed bodies (duplicate items,
  too many rows, wrong types) writes nothing.
- Spec editor: a second active row in the same scope and unit is refused with the existing duplicate message.
- COA: no spec in the result's unit stops generation with the reason in section 6.

## 9. Rollout and rollback

- **Order:** after v2 merges (it needs the 2 mL worksheet and its stored readings). Mk1-only deploy; coabuilder,
  WordPress and the Integration Service are unchanged.
- **Migration:** three nullable columns; the spec index swap in one transaction. Both idempotent.
- **Launch steps** (after hours, `accumark-deploy` skill):
  1. confirm the v2 launch fix is in: method 26 "Endotoxin" is the default method for `ENDOTOXIN-USP85LAL`;
  2. add the Peptide 0 to 350 EU/vial spec row in the spec editor;
  3. promote one test sample end to end on the stack first (worksheet, review, COA preview showing "< LOQ" and
     LOQ 25).
- **Rollback** (corrected 2026-10-13 by final review I-2; the earlier text was unsafe). The previous image's
  `resolve_spec` ignores units and has no per-result LOQ, so neither spec state is safe on its own once EU/vial
  results exist:
  - *EU/vial row deactivated:* the old image judges a regenerated EU/vial result against the EU/mL rows (a
    per-peptide row, else the 0 to 5 catch-all). "25 EU/vial", a clean "< LOQ" result, prints as 25 against 0 to 5
    and FAILs. That is a false FAIL on every slice 3 result, not just a lost LOQ.
  - *EU/vial row left active:* a regenerated EU/mL peptide result with no per-peptide row resolves to the Peptide
    0 to 350 row, so an EU/mL value between 5 and 350 falsely passes.
  - The earlier claim that the previous code "cannot choose between two units in one scope" was wrong for a
    Peptide-scoped EU/vial row. No Peptide EU/mL row shares its scope, so the old code does not stop; it silently
    picks the EU/vial row.

  With the row deactivated, EU/mL results are judged as they were before slice 3, so only the EU/vial samples need
  holding. A rollback is:
  1. Deactivate the EU/vial spec row(s) in the spec editor.
  2. Hold COA generation and regeneration for every sample whose endotoxin parent result is in EU/vial, until
     roll-forward. The samples (read-only; parent rows in any state, so the list errs toward holding too many):
     ```sql
     SELECT DISTINCT s.sample_id
     FROM lims_analyses a
     JOIN analysis_services svc ON svc.id = a.analysis_service_id
     JOIN lims_samples s ON s.id = a.lims_sample_pk
     WHERE svc.keyword = 'ENDOTOXIN-USP85LAL'
       AND a.lims_sub_sample_pk IS NULL
       AND lower(btrim(a.result_unit)) = 'eu/vial'
     ORDER BY s.sample_id;
     ```
  3. Redeploy the previous image.

  The new columns are ignored by old code, and results promoted in the meantime keep their values. Roll-forward:
  redeploy the slice 3 image, reactivate the EU/vial row(s), then release the hold.

## 10. Testing

Backend:
- Migration: columns added once; index swap idempotent; a second boot changes nothing.
- Unit-aware lookup across the three scopes, with and without a unit, case and spacing in units, and the loud
  failure when a unit-less lookup meets two rows.
- Dennis's concern pinned: a bac water EU/mL result resolves to 0 to 0.25 and never to 5 or 350; a peptide EU/vial
  result resolves to 350; a peptide EU/mL result from the older prep still resolves to 5; a sample type matching
  nothing gets the catch-all only in its own unit; a blend resolves as Peptide.
- Promote: each eligibility refusal (ENDO-LAL, not native, two live endotoxin rows, already promoted, parent
  already holds a result, no reading, Invalid record, inconclusive, mismatched "<", wrong unit, bad numbers);
  typed-reading audit marking; partial success across rows; the audit row and transition reasons; retest
  supersession through the shared function; the sample page's promote route behaves exactly as before.
- LOQ and LOD: copied on promote and retest carry, cleared on reset, un-promote and a new retest row; recorded
  by the amendment audit.
- COA: the result's LOQ wins over the spec's; "< LOQ" with 25 in the LOQ column; no spec in the unit stops the
  COA; heavy metals unchanged (spec LOQ only).

Frontend:
- Box 3 checkboxes appear only on eligible rows, with the reason on hover otherwise; the confirm dialog lists
  exactly what is sent; the per-row results render; promoted rows show the chip after refresh.
- The analysis table shows LOQ and LOD under the value and the result's LOQ in the Spec column.

## 11. Out of scope

- LOD on the COA (slice 4, through coabuilder and WordPress).
- Method rules per product, their lock and "Re-apply rules" (slice 5).
- SENAITE-born `ENDO-LAL` results (D2) and coabuilder's built-in endotoxin judging for them.
- Recomputing the endotoxin maths on the server (D6; revisit with agent worksheet tools).
- Deactivating or migrating existing EU/mL spec rows or results.
