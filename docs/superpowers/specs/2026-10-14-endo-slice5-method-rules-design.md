# Endotoxin slice 5: method prep rules on the 2 mL worksheet

Status: the design was approved in conversation by the Handler on 2026-10-13 and 2026-10-14. This document is the written spec, for review.
Builds on: v2 (2 mL worksheet), slice 3 (promote and its I-3 value check) and slice 4, all on `feat/endo-slice3`.
Source model: Dennis's endotoxin tool (`tools-dennis`, `tools/endotoxin-log`, `calc.js` `pickRule` / `ruleOf` / `ruleValues`). The full map is in `.superpowers/slice5-method-rules-map.md`.

## 1. Goal

Dennis tunes the 2 mL prep per product. For example: "Retatrutide over 30 mg needs 1:300; 1:250 gave low PPC". For the next month or two the lab will change these rules several times a week, while failures run a little higher. Mk1 gets an editable list of prep rules that sets a row's default total dilution, step 1 ratio and cartridge for a catalog peptide and a weight band.

A rule locks onto the row once the row is printed, gets a result, or its worksheet completes. The lab can deliberately move locked rows to newer rules with "Re-apply", keeping the old run in the row's history. Dennis can override any rule per row for a special preparation.

Once the rules settle, they can move onto the controlled Endotoxin method revision ("option 1"). That move is a later slice; section 11 says how.

## 2. Decisions (Handler, 2026-10-13/14)

| # | Decision |
|---|---|
| D1 | Rules live in an editable table, not on the method revision, because they change several times a week for now. |
| D2 | A rule matches a **catalog peptide entity**. There are no typed product names. A blend (no single peptide) never matches. |
| D3 | Re-apply previews each row, with old against new values, and changes only the rows the analyst confirms. Promoted rows and completed worksheets are never changed. A row moved by Re-apply keeps its previous run in its history, so a failed run stays on record. |
| D4 | Trial and validated are a label only, as in Dennis's tool. Promote and the COA behave the same either way. |
| D5 | A row locks its rule at the first print, its first result, or worksheet completion, whichever comes first. The lock at print is new compared with Dennis's tool, where a printed row kept following rule edits that the bench never saw. |
| D6 | Per-row overrides: Dennis can type any of the three values (typed beats rule), or switch the row to "no rule" for a special preparation. Re-apply never touches an override. The reason note is optional, and every override is audited. |

## 3. The rule

A new table, `endo_prep_rules`:

| Column | Type | Meaning |
|---|---|---|
| `id` | int PK | |
| `peptide_id` | int FK to the catalog peptide table, not null | the match key (D2) |
| `min_mg` | float, null | band: weight **>** `min_mg`; null means no lower bound |
| `max_mg` | float, null | band: weight **<=** `max_mg`; null means no upper bound |
| `total_dilution` | float, null | the total 1:N; null means the standard (`run_parameters.endotoxin.std_total_dilution`) |
| `step1_ratio` | float, null | step 1 Tris ratio 1:N; null means the standard (`STEP1_RATIO`, 10) |
| `cartridge_type_id` | int FK `consumable_types`, null | null means the row's usual cartridge chain |
| `status` | text, `trial` or `validated`, default `trial` | label only (D4) |
| `note` | text, null | why the rule exists |
| `active` | bool, default true | inactive rules never match; there is no delete |
| `sort_order` | int | breaks ties (section 4) and sets the list order |
| `created_at`, `updated_at`, `updated_by_id` | | |

A line with every value null is allowed. It documents that the standard is confirmed for that band, and it still locks as "rule (standard confirmed)".

**Save checks (400 on failure):**
- `total_dilution > 0` when set.
- `step1_ratio >= 1` when set.
- When the effective total and the effective ratio are both known, total >= 2 x ratio. This is the step 1 floor that `check_item_endo_fields` enforces. Dennis's tool does not check it, and a rule that breaks it gives a prep that cannot be made.
- `min_mg < max_mg` when both are set.
- The cartridge, when set, is an active consumable of the endotoxin cartridge kind.

**Warnings returned with the save (not refusals):**
- an overlapping band for the same peptide;
- a cartridge that the active Endotoxin method revision does not allow.

**Edits.** Create, update, reorder and (de)activate are audited with old and new values. The editing permission is the one that edits the Endotoxin method and the consumables catalog today; the plan names the exact dependency.

## 4. Matching

`match_rule(rules, peptide_id, weight_mg, form, is_bac, endo_prep)` returns the matching active rule or none. One Python function on the server and one TypeScript mirror in the browser implement it, and a shared fixture table pins them to give identical answers. The fixtures are Dennis's own test lines a to f, plus Mk1 cases.

**Never ruled:**
- stock worksheets (`endo_prep != '2ml'`);
- bac water (the v2 rule);
- a sample with no single catalog peptide (a blend, or none);
- a row switched to "no rule".

**Peptide.** `rule.peptide_id == the parent sample's catalog peptide` (`sample_peptide_id`). The worksheet item serializer serves it, from one batched query per worksheet and never one per row.

**Weight.** The row's weight as Box 2 already reads it: `prep_weight_mg`, else `declared_weight_mg`. This is the same input Dennis's band reads (his `f` column).
- It matches when `weight > min_mg` (or `min_mg` is null) and `weight <= max_mg` (or `max_mg` is null).
- A row with no weight matches only a line with both bounds null.

**Form.** Powder and liquid are both ruled (as in Dennis's tool). Bac water is excluded above.

**Several lines match.** The narrowest band wins, where width = (`max_mg` or infinity) - (`min_mg` or 0). A tie goes to the lowest `sort_order`. Dennis's open-band quirk is kept: any closed band beats an open one, and between open bands the higher line wins.

## 5. Effective values on a row

For each of the three fields the order is **typed > rule > standard**, field by field.
- **Typed:** the row's existing `prep_total_dilution`, `prep_steps[0][1]` and `cartridge_type_id`.
- **Rule:** the locked snapshot when the row is locked, else the live match.
- **Standard:** the method's `std_total_dilution`, `STEP1_RATIO`, and the usual cartridge chain (bac 0.01, then the run cartridge, then the method default).
- **A row switched to "no rule"** uses typed, then standard.

**Every place that computes or checks a row uses these effective values:**
- the browser's prep maths (`totalOf`, `stepsOf`, `resolveRow`, `prep2Check`);
- the Box 2 grouping;
- the bench sheet;
- the server's step 1 floor check (`check_item_endo_fields`);
- the server's promote value check (slice 3 I-3, `_plan`).

Promote requires a result, and a result locks the row, so the server's promote check always reads the locked snapshot and never live rules. A rule edit can therefore never make a promote disagree with what was prepped.

## 6. Locking (D5)

**New columns on `worksheet_items`:**
- `prep_rule` (JSON, null), the lock snapshot: `{"rule": <full copy of the matched line, or null for "standard">, "locked_at": iso, "locked_by": "print"|"result"|"complete"|"reapply"|"switch", "user_id": int}`. A deep copy, as in Dennis's `rl`, so later edits to the line never reach a locked row.
- `prep_rules_off` (bool, not null, default false), the "no rule" switch.
- `prep_note` (text, null), the optional special-prep reason. It prints with the row.
- `prep_history` (JSON list, null), append-only past runs (section 7).

**Lock events.** Each one locks every row on the worksheet that is not locked yet, using the live match at that moment. A row with no match locks to `"rule": null` (the standard).
- **print:** `POST /worksheets/{id}/printed`, every print, so rows added after the first print lock at the next one;
- **result:** saving a reading (typed) or applying a reader import, for that row;
- **complete:** `POST /worksheets/{id}/complete`.

A row switched to "no rule" is not locked; it needs no lock. Switching a row back to rules on a worksheet that has already been printed locks it at once to the current match (`locked_by: "switch"`), so it never follows live edits the bench did not see.

**Release.** Clearing a row's reading releases its lock only when `locked_by == "result"`. A lock taken at print, completion or Re-apply survives a cleared reading, because the bench prepped from that paper.

**Completed worksheets.** Every row locks at completion, and nothing on a completed worksheet changes afterwards, rules or Re-apply alike.

## 7. Re-apply (D3) and history

**Preview.** `GET /worksheets/{id}/prep-rules/reapply` lists every row that meets all of these:
- the row is locked;
- the worksheet is open (not completed);
- the row's endotoxin analysis is not promoted;
- the row is not switched to "no rule";
- the row's snapshot differs from today's match: a different line, different values, or rule against none.

Each candidate carries its old snapshot and the new match. The browser computes and shows old against new for the effective total, ratio and cartridge, the LOQ, EU per vial and the verdict, using the same maths it already runs. A row with a reading shows instead of EU per vial and the verdict that its reading moves to the history and the sample is re-run, never a result worked out again for the old reading, and it starts unticked; a row without one starts ticked (Handler ruling 2026-10-14, final review I2).

**Apply.** `POST /worksheets/{id}/prep-rules/reapply {item_ids: [...]}`. For each confirmed row the server re-checks the preview's conditions; a row that no longer qualifies is refused per row with a reason. For a row that qualifies, it then:
1. appends a history entry;
2. replaces `prep_rule` with the current match (`locked_by: "reapply"`);
3. writes an audit row `endo_prep_rule_reapplied` with the old and new snapshots.

Typed values stay as they are. Re-apply moves the reading to the row's history and clears it, and the re-run's reading is entered the usual way (Handler ruling 2026-10-14, final review I2):
- the history entry keeps the reading in full and is marked `reading_moved`, and the audit row keeps the old reading and reader record;
- every reading field on the row is cleared (`result_reading`, `result_reader`, `result_entered_at`, `result_entered_by_user_id`), while the new lock, the cartridge and the Ran tick stay;
- the reader import never restores a moved reading: a test whose id a moved entry holds is skipped and listed in `skipped` ("this run's reading was moved to history by Re-apply; enter the re-run"), replace ticked or not;
- a row with no reading moves as before.

**History entry** (in `prep_history`):
- `at`, `by`, `why` (`reapply`, or `override` per section 8);
- the old snapshot;
- the effective total, ratio and cartridge before the change;
- `result_reading`;
- the reader test id;
- `result_entered_at`;
- for a reading Re-apply moved, also `result_reader`, `result_entered_by_user_id` and `reading_moved: true`.

It holds stored facts only. The row's history view recomputes EU per vial and the verdict from them with the pinned method, so a failed run stays on record (D3).

## 8. Overrides (D6)

- **Typing a value** on any of the three fields beats the rule on that field. The other fields keep following the rule. A typed value is allowed until the row is promoted, after print and after a result too.
- **A promoted row is final.** Every endo field the item PATCH takes refuses a change with 409 ("the row is promoted; its prep is final"), the form, the water and the reading included, because each one moves the EU/vial or LOQ already on the parent. A promoted row is corrected by retest. The weight, the stock bench fields and the bench ticks stay editable, because none of them enters a promoted row's EU/vial or LOQ (Handler ruling 2026-10-14, final review I3).
- **The "no rule" switch** (`prep_rules_off`) makes the row ignore rules entirely. Re-apply never lists it.
- **When a row already has a result**, changing a typed value or the switch appends a history entry (`why: "override"`) before the change, so the replaced run is kept.
- **Every override** is audited: who, when, old and new.
- **The reason note** (`prep_note`) is optional and prints with the row as "special prep: <note>".

## 9. Screens

- **Rules page.** Opened from a "Prep rules" button on the endotoxin worksheet page and from the worksheets nav. It is an editable table:
  - columns: peptide (catalog search picker), above mg, up to mg, total, step 1 ratio, cartridge (endotoxin cartridges from the consumables catalog), status, note, active;
  - move-up and move-down for order;
  - save errors and warnings inline;
  - a footer line "N rules, M on trial".
- **Box 2.**
  - A ruled row shows a "rule" tag, amber "rule (trial)" while the rule is on trial, and "locked" once locked. Hover shows the line, its status, its note and the lock event.
  - A "no rule" row shows "special prep", with its note on hover.
  - A row with history shows "History (n)", which opens the past runs with their recomputed values.
  - The row editor gains the "no rule" switch and the note field.
  - Box 2's actions gain "Re-apply rules (n)" when the preview has candidates, which opens the preview dialog with per-row checkboxes.
- **Bench sheet (2 mL).**
  - A ruled step prints "1:300 · rule", or "1:300 · rule (trial)".
  - A ruled cartridge prints with a superscript R.
  - A special-prep row prints "special prep" and its note.
  - The summary page lists "Method rules used in this run": each line, its status, the rows it covered, how many are locked, and its note.
- **Every new colour** has a `dark:` variant.

## 10. Testing

**Matching parity.**
- The shared fixtures, run in both pytest and vitest, give identical results for every case: Dennis's lines a to f; narrowest band; ties; open bands; no weight; a blend; bac water; a stock worksheet; "no rule"; an inactive line.

**Effective values.**
- Typed beats rule beats standard, per field.
- The step 1 floor check and the promote I-3 check accept a ruled row and refuse a tampered one.

**Locking.**
- Each event locks the unlocked rows: print (including a reprint after rows are added), first result, reader import, completion.
- A cleared reading releases only a result lock.
- A rule edit after a lock leaves the row unchanged.

**Re-apply.**
- The preview lists only qualifying rows.
- Apply refuses promoted rows, completed worksheets, "no rule" rows and rows that changed since the preview.
- Apply writes history and audit.
- Typed values survive.
- A read row's reading moves to its history and is cleared, a re-import of that run is skipped, and the dialog starts the row unticked.

**Overrides.** A typed change and a switch on a row with a result append history and an audit row.

**Rules API.** Every save check, the warnings, the audit, and reorder.

**Screens.** The Box 2 tags, the preview dialog, the history view, the "no rule" switch and the bench-sheet marks.

## 11. Migration, rollout, rollback and the later move

- **Migration.** One new table and four nullable or defaulted columns on `worksheet_items`, all additive and idempotent in `_run_migrations`. They go above the `retest_of_sample_id` statement, which a test pins as last.
- **Rollout.** These ship in the same Mk1 release as v2 and slices 3 and 4. They start with an empty rules table, so behaviour is the standard until the lab adds lines.
- **Rollback.**
  - The previous image ignores rules and snapshots, so a locked ruled row would recompute at the standard dilution, which is wrong for a prep that followed a rule.
  - Before rolling back, therefore, write each locked rule's values into that row's typed columns (`prep_total_dilution`, `prep_steps[0][1]`, `cartridge_type_id`) wherever the typed value is empty. The old image then computes the same numbers.
  - The plan gives the read-only check and the update statement. That materialising step comes before slice 4's and slice 3's rollback steps.
- **The later move to option 1** (rules on the method revision, once settled):
  - Copy the active lines into the Endotoxin method revision as a new revision.
  - Switch matching to read the pinned revision's lines.
  - Keep the row snapshots unchanged; they already hold full copies.
  - This is a separate slice and is not built here.

## 12. Out of scope

- Backfilling Dennis's existing 2 mL runs from his tool.
- Rules on stock worksheets.
- Rules for blends (a blend never matches; its row shows no rule tag).
- Rules that change the water, the form, the step sample volumes or the 350 EU per vial limit (Dennis's rules never do).
- The move to the method revision (section 11).
