# Endotoxin worksheet (Worksheets 2.0, endo first): design

## Data the worksheet records for reporting (added 2026-09-18)

The bench is paper-first: print, work the run, key it in afterwards. So tick times are
ENTRY times, good to the day, not to the minute. The honest run-level clock is
`printed_at` (left for the bench) to `completed_at`.

| Question | Source | State |
|---|---|---|
| Rows prepped / run per tech per day | `worksheet_items.made_by_user_id`, `ran_by_user_id` (+ `_at`) | new, server-stamped |
| Results entered per tech | `lims_analyses.analyst_user_id`; `lims_analysis_transitions` (`submit`, user, `occurred_at`) | existing; analyst coverage rises as worksheets are used |
| Runs per instrument, retest rate per instrument | `lims_analyses.instrument_id`, `retested` | was 0 of 1,288 endo analyses on prod (30 days to 2026-09-18); now stamped by the MCS tick |
| Runs per method | `lims_analyses.method_id` | NOT stamped by the tick, on purpose: the COA's native section prints it (`coa/native_sections.py`) and promote copies it to the parent row. Ruling 2026-09-19: methods go on COAs later, once the method system settles, and then for every sample |
| Queue wait | `date_received` to `worksheet_items.added_at` | existing |
| Staging time | `worksheets.created_at` to `printed_at` | new |
| Bench time per run | `printed_at` to `completed_at` | new |
| Review lag | `lims_analyses.submitted_at` to `verified_at` | existing |
| On time vs SLA | `/sla/status` `due_at` | existing; computed live, so a tier change rewrites history |
| Declared-data quality | `prep_weight_mg` / `prep_volume_ml` overrides | existing on this branch |

Not captured anywhere yet: reagent / cartridge lot numbers, and instrument capacity
(needed to turn runs into utilisation). PCR and HPLC worksheets should reuse the same
columns: `made_*`, `ran_*`, `printed_*` are bench-generic on purpose.

Written 2026-09-18 from Dennis's `tools-dennis/tools/endotoxin-log` (in daily use since
2026-09-01) and a read-only probe of prod Mk1 the same night. The Handler's framing: what
Dennis built is Worksheets 2.0 for Accu-Mk1, starting with endotoxin; PCR and HPLC follow,
split by instrument and method. This spec covers the endo slice only.

## 1. Why now

Mk1 worksheets are how analyst attribution reaches results: adding a vial to a worksheet
stamps `lims_analyses.analyst_user_id` on its live rows and moves them to `assigned`
(`backend/lims_analyses/worksheet_analyst.py`). Since the endo bench moved to Dennis's log,
that stopped happening for endotoxin:

| week of | Microbiology worksheet items | native endo rows | of which no analyst |
|---|---|---|---|
| 2026-08-24 | 93 | 94 | 12 |
| 2026-08-31 | 167 | 116 | 34 |
| 2026-09-07 | 207 | 101 | 32 |
| 2026-09-14 | 71 | 95 | 29 |

Dennis's log holds the missing attribution: 23 runs, 252 rows, analyst on 15 runs (Guian
10, Leanne 5). Every one of its 250 distinct sample ids resolves to an Mk1 vial (57 exact
vial ids, 193 bare parent ids with exactly one endo-role vial). 117 of those vials are also
on Mk1 worksheets from before the switch (the lab's old convention: one worksheet per order,
titled `<order> E`).

Two more findings that shape the port:

- Where a log row carries its own received date, it equals Mk1's `date_received` in lab
  time 57 of 57 times. Where it inherits the run date (159 rows), it is 1 to 5 days late.
  Mk1's received date is the truth; the inherit rule was a data-entry shortcut.
- The log's declared weight equals Mk1's `declared_total_quantity` 157 of 160 times. The
  three differences are the analyst prepping a different weight than the order declared
  (P-2458 is the sample-prep forensics case). The bench needs a per-item weight override.

## 2. What Mk1 gets

An endotoxin worksheet is an ordinary Mk1 worksheet whose items are endo vials
(`assignment_role` `endo` or `endo85`, or an item whose analyses carry an ENDO keyword).
Nothing new is created; the existing Microbiology inbox lane, worksheet creation, analyst
assignment, priority, SLA column, completion and result attribution all apply unchanged.

Added on top:

1. **Three prep overrides on `worksheet_items`** (nullable floats): `prep_weight_mg`,
   `prep_volume_ml`, `prep_dilution_factor`. NULL means "use the computed value".
2. **Parent facts on every worksheet item** in the worksheet API: `declared_weight_mg`,
   `sample_type`, `client_order_number`, `sample_identity`.
3. **The prep calculation in the frontend** (`src/lib/endo-prep.ts`), a direct port of
   `calc.js` with its test vectors. Derived figures are never stored.
4. **Dennis's run table inside the worksheet flyout.** A worksheet whose items are all
   endo work renders his table (bench order; received, due, priority, order, sample id,
   identity, weight and volume as editable overrides, sample µL, LAL µL, vial conc or the
   dilution chip, SLA, status, actions; tinted rows for cartridge warnings; run totals in
   the footer). A mixed Microbiology worksheet keeps the generic list with a compact endo
   line under each endo item. Bench kinds (`src/lib/worksheet-kind.ts`: endo, pcr,
   sterility, hm, hplc) are what the PCR and HPLC tables hang off next; the flyout will
   likely grow tabs per kind.
5. **Bench sheet print and CSV export** on any worksheet holding endo items: landscape,
   exactly 10 samples per page, priority pill, summary sheet last. Ported from Dennis's
   `buildPrintDoc`, which the analysts iterated to legibility at the bench.
6. **A backfill script** that creates the missing Mk1 worksheets from the log's data file,
   stamps analysts through the normal path, and records the prep overrides.

Not ported (and why): the paste/CSV intake (the inbox is the intake; the `-Sxx` ids in the
log are Mk1 vial ids), the holiday calendar (`lab_holidays` + `business_hours_config`
already exist and also cover custom closures), the Made / Ran-on-MCS / Inputted / Flag ticks
(8% used; completion comes from `lims_analyses.review_state`), the run-level due date, the
budget-ledger CSV (feeds another of Dennis's artifacts, ruling pending), the Artifact print
subsystem internals.

## 3. Rules (must match `calc.js` exactly; analysts trust the printed figures)

```
weight (mg)          = prep_weight_mg ?? declared_weight_mg
volume to add (mL)   = prep_volume_ml ?? MIN(10, 1 + FLOOR(weight / 50))
vial conc (mg/mL)    = weight / volume
sample needed (µL)   = 1 / vial conc × 1000            (target is always 1 mg/mL)
LAL needed (µL)      = 1000 − sample needed
```

Bacteriostatic water (sample type "Bacteriostatic Water", or sample id starting `BW-`)
is a dilution, not a weight prep: `factor = prep_dilution_factor ?? 20`,
`sample = 1000 / factor`, `LAL = 1000 − sample`; volume and vial conc are not applicable.

Flags: sample needed > 1000 µL (will not fit the cartridge), LAL ≤ 0 (no diluent).

Due date = the SLA engine's deadline (Handler ruling 2026-09-18): `/sla/status` now
returns `due_at`, the instant the business clock reaches the sample's resolved target
(`compute_business_deadline`, the inverse of `compute_business_minutes`, walking
`business_hours_config` working days and skipping every `lab_holidays` row). For the
Microbiology tier (1440 business minutes at 8 h/day) that is received + 3 business days,
exactly Dennis's rule, and priority tiers or calendar changes now flow through on their own.
The bench shows the lab date of `due_at` and names any holiday stepped over.

Bench order = due date ascending, then priority expedited → high → default, then the
worksheet's own `sort_order`. Applied identically to the drawer line, the sheet and the CSV.

Display: microlitres to 1 decimal with trailing `.0` dropped; concentrations and mL to 3.

## 4. Data and API

`worksheet_items` + `prep_weight_mg FLOAT`, `prep_volume_ml FLOAT`, `prep_dilution_factor FLOAT`
(boot ALTER in `database.py`, model in `models.py`). Additive; nothing existing changes.

`PATCH /worksheets/{id}/items/{item_id}` accepts the three fields; explicit `null` clears
(same `model_fields_set` convention as `instrument_id`); values must be > 0.

`GET /worksheets` and `GET /worksheets/{id}` item dicts gain `prep_weight_mg`,
`prep_volume_ml`, `prep_dilution_factor`, `declared_weight_mg` (parsed from the parent's
`declared_total_quantity`), `sample_type` (`sample_type_title` or `sample_type`),
`client_order_number`, `sample_identity` (parent `analytes` names joined with ", ", else
`peptide_name`). Resolved through the vial's parent; parent-sample items (legacy
`<order> E` worksheets hold `P-XXXX`) resolve by their own sample id. These handlers declare
no `response_model`, so the keys pass through.

## 5. Backfill (`backend/scripts/backfill_endo_worksheets.py`)

Input: the log's `endotoxin-data.json` (`{ savedAt, store: { "runs/<id>": run } }`).
Dry-run by default, `--apply` writes, one commit at the end.

Per run: resolve every row to a vial (exact `lims_sub_samples.sample_id`, else the parent's
single `endo`/`endo85` vial; report and skip anything else). A vial already on any
non-staging worksheet keeps it (the lab's own record wins) and only has empty prep
overrides filled. The rest go on one new worksheet per run: title from the run
(`Endo 09/11/2026 #3` or the run's label), analyst by first name, department Microbiology,
`created_at` = run date, status `completed` when every live endo row on its vials is past
submission, else `open`. Items carry Mk1's effective priority, the parent's received date,
the vial's endo analyses, and the prep overrides (weight only where the log's number
differs from the declared quantity, volume where the log has an explicit value, dilution
where a bac-water note names a factor other than 20). Every new item goes through
`stamp_for_item`, so attribution, `assign` transitions and the vial event happen exactly as
they do from the drawer.

Idempotent: placed vials are never placed again; a re-run creates nothing.

## 6. Assumptions to confirm with the Handler

1. ~~Extend the existing worksheet rather than a new entity~~ RULED 2026-09-18: yes, as
   long as PCR and the rest slot in the same way (bench kinds, one table per kind).
2. ~~Backfill creates historical worksheets~~ RULED 2026-09-18: yes.
3. ~~Due date is a constant 3 business days~~ RULED 2026-09-18: the SLA engine owns it (done).
4. ~~The budget-ledger CSV stays in Dennis's tool~~ RULED 2026-09-18: yes; the budget is a
   separate tool/system later.
5. ~~Dennis's tool is retired for new runs once this deploys~~ RULED 2026-09-18: he keeps
   using it until this is working and deployed to prod, then switches and the backfill runs
   from a fresh export.

## 7. Tests

Backend: PATCH sets and clears the overrides and rejects ≤ 0; GET returns the parent facts
for a vial item and for a parent-sample item; backfill dry-run writes nothing, apply creates
the worksheet, items, overrides and analyst stamps, and a second apply is a no-op.

Frontend: the `calc.js` vectors (10 mg → 100/900, 120 mg → 25/975, 600 mg → 10 mL, 449 vs
450 mg cap, 1 mg → no diluent, bac water 20× → 50/950, 40× note → 25/975, override wins),
due dates (Fri → Wed, Memorial Day skip with the holiday reported, custom closure skip),
bench order (due then priority then insertion), bench sheet pagination (10 per page, summary
last, 21 rows → 3 sheets + summary) and escaping.
