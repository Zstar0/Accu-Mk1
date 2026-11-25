# HPLC Prep Worksheet + Calibration Curve Worksheet: Design

Status: design, awaiting Handler approval. Recon 2026-10-29, all code references read from
`origin/master` at Mk1 1.55.0.

Source material: Dennis's `tools/hplc-peptide-quant` (private repo `tools-dennis`, 34 commits
2026-10-16 to 10-26). Companion recon notes: the entity map produced alongside this document.

The builder check's open questions were answered by Dennis on 2026-10-30 and are now locked
decisions 13 to 20 below. Nothing in this document is waiting on an answer.

**The shape of the slice changed with those answers.** It is no longer a bench-UI build.
Teaching `hplc_processor` the real prep (decision 13) and closing the manual curve pick
(decision 18) are both production-behaviour changes to the HPLC results engine, so this slice
carries a sign-off. Re-identification (decision 20) is new scope on top.

## 1. Problem

HPLC sample prep in Mk1 today is the **prep wizard**: a modal flow over `wizard_sessions`
that a tech opens per sample, works through, and which auto-syncs a `sample_preps` row at the
end. It is powder-only, has no form dimension, no intermediate dilution, no tray, no blend
component sheet, and no place for the rider services the order paid for. Dennis has spent a
month building the worksheet the bench actually wants, outside Mk1, against real lab data.

Meanwhile Mk1 already shipped **Worksheets 2.0** for four other benches (endo, pcr,
sterility, hm): a worksheet is created from the inbox by dragging samples in, assigned to a
tech, worked as a flat row-per-sample table, printed as a bench sheet, and promoted when
done. `src/lib/worksheet-kind.ts:8` already declares `hplc` as the fifth `BenchKind`.

So this is not a new system. It is the fifth bench kind, and it replaces the prep wizard as
the way an HPLC prep is created.

### Why now

- Dennis's sheet is in daily use and is the lab's real procedure. Every day it stays outside
  Mk1, the bench does its maths in one tool and its record-keeping in another, and the two
  disagree: `calc.js` and `backend/calculations/wizard.py` are two implementations of the
  same arithmetic with no device holding them to the same answers.
- Three of his sections exist only to work around Mk1's limits (Steps 3b, 3c and the "For
  Accu-Mk1" table are all "type this into Mk1 so its one-step formula gives back my two-step
  answer"). Those sections are pure friction and pure risk.
- Vacuum, pH and fentanyl are services the lab sells. Today their results have nowhere to be
  typed, so they live on Dennis's sheet and reach the certificate by hand.

### What success looks like

A tech takes an HPLC item from the inbox, works one sheet that looks like Dennis's, saves,
and the prep is on the Sample Preps page ready to process, with no retyping anywhere and no
second tool open.

## 2. Locked decisions (Handler, 2026-10-29)

1. **HPLC is bench kind five in Worksheets 2.0.** Not a new frontend onto `wizard_sessions`,
   not a parallel system.
2. **Name it the HPLC Prep Worksheet**, not the sample prep worksheet.
3. **Match Dennis's design as exactly as possible**, his step sections and his layout. Same
   rule that was applied to his endotoxin worksheet, where Mk1 took his column labels
   verbatim (see `src/components/hplc/EndoWorksheetTable.tsx`).
4. **Drop every accommodation Dennis built for testing outside Mk1.** Mk1 learns the real
   two-step dilution and the real bac-water volume, so Step 3b, Step 3c's paste columns, the
   "For Accu-Mk1" summary table and the blue colour coding are never ported.
5. **One worksheet per Mk1 worksheet from the inbox**, created by dragging samples in,
   assigned to a tech, with live adds while it is in progress.
6. **A prep lands on Sample Preps per row, as soon as that row is finished.** Not per
   worksheet, not on worksheet completion.
7. **Lab rules live on the peptide record, on their own page like the endo prep rules page.**
   Rules apply to solo peptides and to blends; a blend rule names the lead component. Plus a
   concentration floor that warns.
8. **The floor warns and lets the tech continue.** It does not block the row, does not
   auto-split to vial B, and does not need a sign-off. A breached row still finishes and
   still mints its prep.
9. **The tech can move a component to vial B on one sample**, overriding the blend's default
   split.
10. **Vacuum and pH are Accu-Mk1 services the lab currently sells, as ride-along (rider)
    analysis services.** Same for fentanyl.
11. **The Calibration Curve Worksheet is designed and built alongside this**, being a
    variation of the same sheet.
12. **The HPLC Batch Queue is another agent's build.** Reviewed here for ties only.

### Decisions 13 to 20 (Dennis, 2026-10-30, answering the builder check)

13. **Teach `hplc_processor` the real prep.** Decision 4 stands, the results-engine non-goal
    is dropped for this point, and the engine change goes through sign-off as part of this
    slice. **No synthesiser, no derived numbers in the weighing columns.**
14. **Match `calc.js` function for function:** `stockPrep` for the Step 2 stock,
    `intermediateStep` and `dilutionActual` for the two dilution steps, and
    `dilutionFactorTotal` (their product) in `computeRun`. Quantity is curve concentration
    times that total factor times stock volume. **A weighing lower than the one before it is
    flagged, never computed from.**
15. **Apply the net peptide weight factor** (decided 2026-10-08), as the worksheet does. The
    66 curves on file were entered by hand with the net weight, so they are already on that
    basis: tag them "net, entered by hand" and leave them alone. New curves store the inputs
    (assay, water, counterion, equivalents) and the factor computed from them.
16. **Missing inputs do not block the factor.** Use what is filled in and treat a blank as no
    correction for that part: no assay is 100%, no water is 0%, no counterion is free
    peptide. Warn that the correction is partial, store which parts were used, and still file
    the curve. **Keep a manual override:** the computed factor is the default, the curve's net
    weight or factor can be edited by hand, and the computed value, the applied value and a
    reason are all kept on the record. **One active curve per peptide and instrument.**
17. **Row per sample** (decision 3 holds). Riders are results attached to the sample's
    existing prep, never preps of their own. Fentanyl: ordered per sample, no prep, a strip
    dipped in the Step 2 stock at the end; one result and a note per sample on the purity prep
    row; keep the fentanyl role for demand and billing, but it must not create a prep row or a
    vial, and its inbox item resolves to the same prep row as the purity item. Vacuum: one
    reading per vial, before decapping, stored as a field on each vial inside the sample's row,
    with the gauge ID; required if ordered, and the worksheet warns when a vial was weighed
    without it.
18. **Fix the manual curve pick in the same sign-off.** A hand-chosen curve must be from the
    same instrument as the run. If it is not, stop with an error instead of using it.
19. **The blend component cap becomes a Mk1 setting**, changeable without a code or table
    change, because five-component blends can come in. It stays at four for now. The results
    record holds one analyte row per component and the setting is the only cap. Until the cap
    is raised, keep the refusal with the reason named: never file a partial blend.
20. **Re-identification:** the peptide on a sample can change after measurement without a new
    prep. The prep row and its weighings are untouched; the sample keeps its declared identity
    and gains a measured identity; processing re-selects the curve for the new peptide on the
    same instrument and recomputes. Log who, when and why. If no curve exists for the new
    peptide on that instrument, say so rather than silently reusing the old one. Blends: the
    same, per component.

## 3. Goals, non-goals, anti-goals

### Goals

- Dennis's sheet, as a bench kind in Mk1, with his sections and labels.
- One maths authority for HPLC prep, held to Dennis's answers by a shared fixture.
- Rider results (vacuum, pH, fentanyl) typed once, landing in `lims_analyses`.
- The Calibration Curve Worksheet filing a `calibration_curves` row that carries the net
  peptide weight derivation.
- The prep wizard's output shape preserved, because `sample_preps` is the downstream join key
  and `actual_conc_ug_ml` is the purity denominator.

### Non-goals

- The HPLC Batch Queue. Another agent builds it; this design only keeps the seams clean.
- Retiring the prep wizard. It stays until the worksheet path has run in production.
- Backfilling existing `wizard_sessions` into worksheets.
- OpenLab. The string does not appear anywhere in Mk1 and should stay that way on this slice.

An earlier draft listed "changing how HPLC results are processed once the vial is on the
instrument" here. **Decision 13 dropped it.** The results engine is in scope, under sign-off,
because the alternative was storing derived numbers in the weighing columns.

### Anti-goals (would make this a failure even if it worked)

- Another implementation of the dilution maths. There are already THREE (`calc.js`,
  `backend/calculations/wizard.py`, and `backend/calculations/hplc_processor.py`, which is the
  one that reaches the certificate; see the open question in S4). If this build adds
  `hplc-prep.ts` and `hplc_prep.py` with no fixture pinning them together, we have shipped
  the problem we set out to fix.
- Derived figures stored on rows. The endo worksheet's whole discipline is that items store
  only inputs, and only when the analyst overrode a default, so the drawer, the bench sheet
  and the CSV cannot disagree. HPLC stores more than endo does (see S6), and every additional
  stored value has to be justified as an input, never as a cached derivation.
- Rider results on `worksheet_items`. They would be orphaned from the certificate.
- Re-architecting Worksheets 2.0 to fit HPLC. Additive only.

## 4. Constraints

- **Additive only.** New features extend existing systems. A failing test defaults to "the
  test is stale". Production-behaviour changes need sign-off.
- **`peptide_analytes` has a hard 4-slot ceiling, and decision 19 only half fits it.** The
  decision is that the cap becomes a Mk1 setting changeable without a code or table change,
  staying at four for now. The setting is buildable and correct as the thing that refuses a
  blend, but it **cannot be raised above four** by itself. `backend/models.py:907` carries
  `CheckConstraint("slot >= 1 AND slot <= 4", name="ck_peptide_analyte_slot_range")` and a
  `UniqueConstraint("peptide_id", "slot")`, and the docstring states the reason: "the entire
  pipeline is 4-slot (slot maps, conformance, alias slots), widening requires a program, not a
  CHECK edit." So the setting can move freely from 1 to 4 and a five-component blend still
  needs that program. Build the setting as the single place the cap is read from, which is
  what makes the later program a change in one place instead of a sweep, and say plainly in
  the setting's own help text that 4 is the current physical ceiling.
- **`_run_migrations` swallows failed ALTERs.** Verify every new column exists after deploy.
- **FastAPI `response_model` silently drops undeclared keys.** Smoke the deployed route, not
  the local one.
- **LIMS-side tables use the `lims_` prefix.** Bare `samples` is taken by HPLC job samples.
- **`npm` only** for the frontend.
- **The dev golden cannot rehearse rider results today.** It has 6 `analysis_profiles` and no
  vacuum, pH or fentanyl profile; prod has 13. The golden refresh is a separate task with its
  own approved scope (section 8).

## 5. Dennis's sheet, section by section, and where each one lands

His rendered section order, from `index.html`:

| Dennis's section | Disposition |
|---|---|
| Step 1, order information | Mostly DELETED. Mk1 knows this already (S1) |
| Step 1b, vacuum testing, before the vial is opened | PORTED as a rider result section (S7) |
| Step 2, stock prep | PORTED, the core of the sheet (S4) |
| Step 2b, blend components, blend rows only | PORTED (S5) |
| Step 3a, intermediate dilution, heavy samples only | PORTED (S4) |
| Step 3, dilution | PORTED, one row per autosampler vial (S4) |
| Step 3b, the two steps as one, for Accu-Mk1 | **DELETED** |
| Step 3c, bacteriostatic water, for Accu-Mk1 | Paste columns DELETED, physics ported into Step 2 (S4) |
| Fentanyl testing | PORTED as a rider result section (S7) |
| pH testing | PORTED as a rider result section (S7) |
| For Accu-Mk1, every number to type in one place | **DELETED** |
| Lab rules, the peptide tables the sheet works from | BECOMES the HPLC Prep Rules page (S3) |
| Built-in values | BECOMES `hplc_methods.run_parameters` (S2) |

### Step 1 is deleted because Mk1 already knows it

Dennis types Sample Identity, Instrument, and three flags (Fentanyl / pH / Vacuum testing
required) from an intake CSV. In Mk1:

- identity, declared weight and form come from the parent sample;
- instrument is `worksheet_items.instrument_id`, already on the row;
- the three flags are the order. A sample needs vacuum because the customer bought the
  vacuum profile, which is a row in `lims_analyses`, not a tick a tech sets.

So Step 1 survives only as the worksheet header and the existing per-row instrument picker.
This is the single biggest "reach for what Mk1 already has" in the port.

### Dennis's own tooltips are the evidence for what to drop

`PASTE_TITLE`: "Type this into Accu-Mk1 as the autosampler-vial weighing. With the vial as 0,
Mk1's one-step formula (total / stock) gives back this vial's two-step Total Dilution
Factor." `BAC_PASTE`: "Type this into Accu-Mk1's stock preparation. With the vial as 0, Mk1's
(vial + diluent - vial) / density is this volume, and declared x 1000 / volume is 9000
ug/mL." Both sections exist only because Mk1 could not represent the real procedure. Once it
can, they are noise.

## 6. Design

### S1. The worksheet shell (backend + FE)

HPLC joins the existing worksheet machinery with no new tables for the shell itself.
`BenchKind` already includes `hplc`, `ROLE_KIND` already maps the `fentanyl` vial role to it,
and `benchKindForItem` falls back to analysis keywords (`/PURITY|IDENTITY|^ID_|^HPLC/i`).

- Creation, assignment, live adds, notes, print and the inbox are the shipped paths. No
  change beyond rendering the HPLC table for `kind === 'hplc'`.
- The table is one flat row per sample, Dennis's Step 2 columns, with the per-vial Step 3
  rows and the Step 2b component lines as expandable sub-rows under their sample. Same
  pattern as the endo table, which proved the row-per-sample layout at the bench.
- **The method is resolved by instrument.** `PATCH /worksheets/{id}/items/{item_id}` already
  re-resolves the method when `instrument_uid` changes. This fixes the open method-linkage
  bug by construction: the prep wizard stamps `peptide.methods[0]`, which puts retired, draft
  and wrong-instrument methods on HPLC runs. The worksheet path must never copy that.

### S2. Method constants: an `hplc` block in `run_parameters`

`hplc_methods.run_parameters` is already revision-locked, content-locked via
`METHOD_LOCKED_FIELDS`, and pinned at first print. `backend/catalog/method_run_params.py`
whitelists blocks and raises on an unknown one, so adding `hplc` is an additive edit to that
one file, with the same "a missing key means Dennis's value" rule endo uses.

    default_target_ug_ml      200
    intermediate_target_ug_ml 1500
    intermediate_volume_ul    1500
    two_step_threshold_mg     500
    bac_stock_ug_ml           9000
    bac_target_ug_ml          500
    capsule_neat_max_ug_ml    350
    diluent_density_mg_ml     997.1
    benzyl_alcohol_density    1034.72
    floor_ug_ml               60

The two-step threshold belongs here, not in the rules table: 500 mg or more applies to every
peptide, so it is a method constant. A per-peptide band table would need a band per peptide.

`benzyl_alcohol_density` is the one lab-wide constant with no natural home. Putting it on the
method is the builder's call to make if the method block is wrong for it; `settings`
(key/value text) is the fallback.

### S3. The HPLC Prep Rules page: copy the endo rules stack

Dennis: "These rules can be made into another page similar to the endo toxin prep rules."
That page exists and the whole stack is a straight copy.

| Endo, shipped | HPLC |
|---|---|
| `endo_prep_rules` table | `hplc_prep_rules` |
| `backend/endo_prep_rules.py` (`match_rule`, `row_rule`, `snapshot`) | `backend/hplc_prep_rules.py` |
| `src/lib/endo-prep-rules.ts`, the browser's mirror of the matcher | `src/lib/hplc-prep-rules.ts` |
| `src/services/endo-prep-rules.ts` | `src/services/hplc-prep-rules.ts` |
| `EndoPrepRulesPage.tsx` + `EndoPrepRuleBits.tsx` | the HPLC rules page |
| `GET/POST/PATCH /endo-prep-rules` + `POST /endo-prep-rules/reorder` | the same five routes |
| `backend/tests/fixtures/endo_prep_rule_cases.json` | `hplc_prep_rule_cases.json` |

That fixture is the device that answers the anti-goal: it pins the backend matcher and its
browser mirror to the same answers, and it is equally the answer to `calc.js` drifting from
`wizard.py`.

Semantics carried over unchanged: a weight band (`weight > min_mg and <= max_mg`, a null
bound meaning none); NULL means "use the method's standard"; `sort_order` plus the reorder
route makes it ordered, first match wins; `active=False` retires a line, never deleted;
`status` is `trial` or `validated` and is a label only; matching reads `snapshot()`, never
the live row; the matched line LOCKS onto the item with `locked_at` / `locked_by` and
replaced runs land in the row's history with a `why` of reapply / override / replaced.

New fields on the HPLC rule line:

- `target_conc_ug_ml`, NULL meaning the method's `default_target_ug_ml`.
- `lead_component_id` FK peptides, NULL meaning the usual lead else the heaviest. Only
  meaningful when `peptide_id` is a blend. Dennis: a rule on Tesa/Ipa names Ipamorelin as the
  lead so the solution is made to 175 ug/mL for the Ipa "regardless of the tesamorelin
  concentration".
- `floor_ug_ml`, NULL meaning the method's floor.

A blend is itself a row in `peptides` (`is_blend=True`), so `peptide_id` addresses solo
peptides and blends with no scope discriminator. **Builder's call, mine, not the Handler's:**
three rule scopes resolved in this order, which covers both of Dennis's tables
(`targetConcByPeptide` and `blendTargetConcByPeptide`) without a scope column:

1. a line whose `peptide_id` is the BLEND, which also names the lead;
2. a line whose `peptide_id` is a COMPONENT peptide, which is Dennis's
   `blendTargetConcByPeptide` written once and good for every blend containing it;
3. a line whose `peptide_id` is the peptide run SOLO;
4. otherwise the method's `default_target_ug_ml`.

Dennis's other Lab rules tables land as follows. `methodByPeptide` is `peptide_methods`
(exists). `blendShorthand` ("KLOW" = its four peptides) is `peptides.is_blend` plus
`blend_components` plus the alias tables (exists; KLOW is already a blend peptide with four
components). `counterions` has no home and is new, and belongs with the calibration
worksheet (S9), not the prep rules. `instrumentByPeptide` is a GAP: `instruments` exist and
`instrument_methods` says which instruments a method MAY run on, but Dennis's table is the
one it USUALLY runs on, a single default, which Mk1 has no concept of.

`diluentByPeptide` is UNVERIFIED and the builder must settle it before relying on it.
`hplc_methods.dissolution` already holds exactly this string shape ("100 Water w/ 0.1% TFA")
and `calibration_curves.diluent` holds it per curve, so the diluent may already be covered by
the peptide's active method. It is only covered if every peptide's active method's
dissolution matches Dennis's list; a method serving two peptides with different diluents
breaks it. The check, read only:

    SELECT p.abbreviation, m.name, m.dissolution
    FROM peptides p
    JOIN peptide_methods pm ON pm.peptide_id = p.id
    JOIN hplc_methods m ON m.id = pm.method_id
    WHERE m.status = 'active' AND p.active
    ORDER BY p.abbreviation;

Expect GHK-Cu and Eloralintide on TFA, the rest on water.

### S4. The prep sheet: Steps 2, 3a and 3, and the real physics

Row fields follow the `worksheet_items` house pattern exactly: one flat row with a nullable
override column per bench, NULL meaning "the standard". Endo has `prep_weight_mg`,
`prep_volume_ml`, `prep_dilution_factor`, `prep_target_mg_ml`, `prep_form`, `prep_water_ml`,
`prep_total_dilution`, `prep_steps`; PCR has `plate_no`, `well_pos`. HPLC columns are added
the same way.

**`prep_form` already exists** on `worksheet_items` as `String(10)` holding
`powder | liquid | bac` (`backend/models.py:1295`), gated by `ENDO_FORMS`
(`backend/worksheets_endo.py:28`) and validated in `check_item_endo_fields` at `:429`.
Dennis's fourth form is a new VALUE, not a new column, and not a second vocabulary.

Four forms, and what each one does:

- **powder** (Lyophilized Powder), the usual: weigh, dissolve, dilute.
- **liquid** (Reconstituted Solution): the customer's declared volume IS the stock; the
  weighing boxes switch off.
- **bac** (bacteriostatic water): NOT a dosage form. Dennis derives it from the Sample
  Identity (`/bac(teriostatic)?\.?\s*-?\s*water|benzyl\s*alcohol/i`), so it stays
  identity-derived, exactly as `form_is_bac` (`backend/worksheets_endo.py:409`) already does
  for endo over `worksheets_endo_promote._sample_is_bac` (`:216`). Two things Mk1 must learn:
  the two Step 2 weighings run BACKWARDS (the full vial as received first, then emptied and
  dried), and the volume is
  `(mass / 997.1) / (1 - 9/density_BA + 9/997.1)` for water with 0.9% benzyl alcohol
  (9 mg/mL). The stock is fixed at 9000 ug/mL whatever the volume, and the target is 500, not
  200.
- **capsule** (oral): the declared weight is per capsule times capsules used, so the row needs
  a capsules-used input. The stock is made to the row's target and injected neat;
  `capsule_neat_max_ug_ml` (350) warns above it. Otherwise it weighs and dilutes exactly like
  a powder.

#### How a sample's Form reaches the prep maths (corrected 2026-11-02)

**Prep branches on a new `lims_sample_forms.hplc_prep` column**, never on the form's name
(names are user-renamable over HTTP) and never on `route`.

**An earlier pass of this section said to branch on `lims_sample_forms.route`
(`injectable | nasal_inhaled | oral`). That is wrong and it is withdrawn.** Verified on
`origin/master`: Lyophilized Powder, Reconstituted Solution and Pen are all `injectable`
(the seed at `backend/database.py:2254-2259`), so `route` cannot tell a weighed powder from
a pipetted liquid, which is the only distinction the stock volume turns on.

Sample Forms shipped in Mk1 1.55.0 as the managed dosage-form entity: `lims_sample_forms`
(`backend/models.py:2087`) carries `name`, `route`, `is_default`, `active`, `sort_order` and
`icon`, rows are user-renamable and retirable in Settings, and `lims_samples.sample_form_id`
(`:1425`) points at one. Nothing on it names the physics. So the entity gains a nullable
`hplc_prep VARCHAR(10)`, CHECK `IN ('powder','liquid')`, filled for the six built-in names
by a boot UPDATE where it is NULL, exactly as `icon` was added (`backend/database.py:2262`).
NULL means "this form has no HPLC prep maths", which is the honest state for Pen, Nasal
Spray and Tablet.

The mapping is the designer's call, not something the lab should have to discover:

| Form (seeded) | route | `hplc_prep` |
|---|---|---|
| Lyophilized Powder (the default) | injectable | `powder` |
| Reconstituted Solution | injectable | `liquid` |
| Pen | injectable | NULL |
| Nasal Spray | nasal_inhaled | NULL |
| Capsule (inactive on prod) | oral | NULL until the capsule ruling |
| Tablet (inactive on prod) | oral | NULL |

**`bac` is deliberately not a value in that column.** It stays identity-derived through the
two functions the endo bench already shares, `_sample_is_bac` (a `BW-` sample id, or a
sample type or identity matching `_BAC_WORDS`) and `form_is_bac(prep_form, sample_bac)`,
which lets an explicit row form win and otherwise falls back to the sample. The Sample Forms
release ruled that bacteriostatic water never gets a form row at all, so there is none to
carry it.

A form whose `hplc_prep` is NULL has no prep maths, so the prep sheet offers no weighing
boxes for it and the engine is never handed its kind. Pen, Nasal Spray and Tablet are the
three that reach that state today.

The two-step dilution (Step 3a) is the feature Mk1 lacks. Rows at or above
`two_step_threshold_mg` get an intermediate vial made to `intermediate_target_ug_ml` in
`intermediate_volume_ul`, and Step 3 then dilutes from the intermediate's ACTUAL
concentration rather than the stock's.

#### The third implementation, and what decision 13 does about it

An earlier pass of this design claimed adding intermediate columns was contained, on the
grounds that `backend/calculations/wizard.py`'s five pure functions are only called from the
wizard's own routes (`backend/main.py:16035-16290`). **That claim is false and it is
withdrawn.** Verified on `origin/master`:

- `src/components/hplc/SamplePrepHplcFlyout.tsx:1255` (and `:1318` per vial from `vial_data`)
  feeds the prep's five flat weighings straight into `runHPLCAnalysis`.
- `backend/calculations/hplc_processor.py:54` `calculate_dilution_factor` **re-derives** the
  dilution factor from the dilution vial's three weighings, and
  `stock_volume_ml = stock_mass_mg / density` from the stock vial's two.
- `calculate_quantity` is then `undiluted_conc * stock_vol`, and
  `backend/lims_analyses/prep_bridge.py:120` writes that `quantity_mg` into `lims_analyses`.

So `calc.js` and `wizard.py` are not the two implementations of this arithmetic. There are
three, and the third is the one that reaches the certificate. With Dennis's accommodations
deleted and nothing else changed, Process HPLC reads the new preps wrong, per form:

| Form | What Process HPLC does with it |
|---|---|
| two-step | quantity low by the intermediate factor, roughly 7x on a 500 mg sample |
| bac | backwards weighings make the stock mass negative; the benzyl-alcohol volume formula never runs |
| liquid | no stock weighings exist, so `stock_vol` is 0 |
| capsule | unstated whether quantity is per capsule or total |

**Decision 13 resolves it: teach the engine.** `hplc_processor` and the flyout learn the
intermediate and the per-form stock volume, the results-engine non-goal is dropped for this
point, and the change goes through sign-off as part of this slice. The rejected alternative
was synthesizing one-step-equivalent weighings at promote, which is Dennis's Step 3b done
server side and would put a derived number in a column every downstream reader treats as a
balance reading.

**Decision 14 names the shape, function for function.** Dennis's `calc.js` is the authority,
and all four names are verified to exist in it. Line numbers in this section were re-derived
from `C:/tmp/tools-dennis/tools/hplc-peptide-quant/calc.js` on 2026-11-02; an earlier pass
cited them roughly 20 lines high throughout:

| `calc.js` | What it owns | Mk1 side |
|---|---|---|
| `stockPrep` (`calc.js:177`) | the Step 2 stock | the stock leg of `calculate_dilution_factor` |
| `intermediateStep` (`calc.js:1044`) | the Step 3a intermediate vial | NEW, no counterpart today |
| `dilutionActual` (`calc.js:321`) | the Step 3 final vial | the dilution leg of `calculate_dilution_factor` |
| `dilutionFactorTotal` (`calc.js:1832`) | the product of the two steps | replaces the single re-derived DF |

Quantity becomes **curve concentration times `dilutionFactorTotal` times stock volume**,
replacing `calculate_quantity`'s current `undiluted_conc * stock_vol`. For a one-step row the
total factor is the single factor, so one-step behaviour is unchanged by construction, which
is the regression test to write first.

`calc.js:367` holds `singleStepEquivalent`, the function that exists only to feed Mk1's
one-step formula, called once at `:1836`. **It is the thing decision 13 deletes**, and
`calc.js:3354` already
documents the replacement contract in a comment: `dilutionFactor: V.dilutionFactorTotal`,
"stock to final vial, both steps if two".

**A weighing lower than the one before it is flagged, never computed from** (decision 14).
That rule is what makes the bac-water form safe: its two Step 2 weighings legitimately run
backwards (full vial as received, then emptied and dried), so the engine must know which
sequence it is reading rather than subtracting blind and producing a negative mass.

### S5. Blends, vials, and the per-item split

This is the largest reuse find and it settles "one prep or several".

- `blend_components.vial_number` already says which components of a blend share an
  autosampler vial. That IS Dennis's Step 2b Vial A / B column, at the blend level.
- `sample_preps.vial_data` is a JSON list with one entry per vial, each carrying its own
  `component_ids`, `component_abbreviations`, `declared_weight_mg`, `target_conc_ug_ml`,
  `target_total_vol_ul`, the full weighing set and the computed actuals
  (`backend/main.py:16668-16706`).
- `WizardMeasurement.vial_number` keys balance readings per vial.

So **one worksheet item mints ONE `sample_preps` row**, and Dennis's "a row per vial in Step
3" becomes entries inside that row's `vial_data`.

The per-item split override (locked decision 9): one JSON column on `worksheet_items`, NULL
meaning the blend's default from `blend_components.vial_number`. `prep_steps` is the
precedent exactly, validated the way `validate_prep_steps` validates it: a fixed-length list
whose entries are null for standard. It is an INPUT, so it is stored and the maths reads it,
which is consistent with the never-stored rule because only derived figures are forbidden.
Promote reads it to decide how many `vial_data` entries to build.

Do not confuse an autosampler vial with a `LimsSubSample`: a customer sub-sample (-S0#) is a
different thing.

**Fragility not to copy:** the existing `vial_data` auto-sync is wrapped in a bare
`try/except` that only prints `[WARN] Auto-sync sample prep failed for session {id}`
(`backend/main.py:16632` and `16709`), so a failed sync is swallowed. The promote path must
surface its failures.

### S6. Promote: the row becomes a prep

Endo's promote is the shape to follow, including its finality rule, with one difference that
has to be stated plainly.

**HPLC cannot follow endo's "store nothing", but not for the reason an earlier pass gave.**
That pass said `actual_conc_ug_ml` is the denominator of reported purity
(`backend/calculations/wizard.py:218`). **Withdrawn:** that formula's only callers are inside
the wizard's own routes (`backend/main.py:16101`), and certificate purity is peak-area
percent from `calculate_purity_from_injections`. In `src/` the only non-wizard readers of
`actual_conc_ug_ml` are display (`SamplePreps.tsx:823`) and the standards correction ratio
(`SamplePrepHplcFlyout.tsx:1550-1563`).

The real downstream contract is **the weighings shape**, not the concentration.
`sample_preps` is the join key for everything downstream
(`HPLCAnalysis.sample_prep_id`), and Process HPLC re-derives the dilution factor and the
stock volume from those five columns itself. That is a stronger reason for promote to be the
storing moment, and it is also exactly why the open question above has to be answered before
promote's contract can be fixed: what promote must write depends on who is reading it.

Mechanics:

- **Per row, as soon as that row is finished** (locked decision 6), not on worksheet
  completion.
- **An explicit per-row Promote action, not an automatic trigger. My call, not the
  Handler's.** It follows endo's precedent, and the alternative is unsafe: promote makes the
  prep final with a 409, while both candidate automatic triggers are reversible controls.
  `prep_status` is a free dropdown of ready / in_progress / complete
  (`src/components/hplc/PrepStatusSelect.tsx:9-12`) and `made_at` is a toggleable tick. If
  promote fired on the last weighing typed, a transposed digit would be unfixable except by
  retest, and two reversible controls would silently become one-way.
- **`worksheet_item_id` on `sample_preps`** earns its place twice: the mint looks the row up
  by it before inserting, so a retry after a half-commit heals instead of double-minting, and
  it routes "Open in Wizard" back to the worksheet row.
- **Not two databases, two drivers.** `backend/mk1_db.py:30-35` and
  `backend/database.py:28-32` read the same `MK1_DB_*` variables and the same dbname
  (`accumark_mk1`). So promote is cross-CONNECTION, not cross-database: a separate psycopg2
  connection with its own commit. It is therefore not one transaction and must be per-row
  idempotent, which is what the lookup above provides. An atomic promote stays reachable
  later by running the insert on the SQLAlchemy session instead. The builder may take that
  option; it is not required.
- **After promote the prep is final.** Every prep field refuses a change with 409 and the
  endo precedent's wording ("the row is promoted; its prep is final",
  `backend/worksheets_endo.py:393`). A promoted row's weighings or split moved the vial the
  purity denominator was measured in, so it is corrected by retest, not by an edit. This also
  settles untick-after-mint: the ticks that do not enter a promoted row's result stay
  editable, the prep fields do not.

### S7. Rider results: the part that widens the sheet

Dennis's Step 1b (vacuum), Fentanyl testing and pH testing are not prep notes. They are
reportable results on services the customer bought, so **the HPLC Prep Worksheet is also a
result-entry surface.**

The rider mechanism, verified: `analysis_profiles` carries `key` (the order key WordPress
sends, immutable once an order references it), `is_addon`, `fulfillment_role` and
`fulfillment_dim` (defaulting to "role"). A rider is a profile whose `fulfillment_role` names
a HOST bench role, so its work rides that host's vial. `src/lib/worksheet-kind.ts:18` maps
the `fentanyl` role to the `hplc` bench and `backend/main.py:25021` maps it the same way for
the bench log; the inbox filters by `role_tags` so rider work stays reachable
(`WorksheetsInboxPage.tsx:648`).

- **Results go into `lims_analyses`, never onto `worksheet_items`**, or they are orphaned
  from the certificate. This is the same shape endo already has, where the worksheet writes
  results through reader-import; here they are typed by hand.
- **Vacuum is read BEFORE the vial is decapped**, so its section comes before Step 2 and the
  sheet must order it that way. Once the vial is open the reading is gone.
- **pH is read on the Step 2 stock, last of all, after every dilution is made**, one per
  sample.
- The existing `2026-08-20-rider-vial-visibility-design.md` slice already assigns riders to
  their host vial and shows that landing. It does not cover result entry, which is new here.
- The COA layer is ready for the vacuum shape: `backend/coa/native_sections.py:512` names
  "the vial vacuum test" as the example of a section that is report-only for every sample and
  uses its note to describe the method.
- `ConsumableType` + `method_consumables` is the home for vacuum gauges, fentanyl strips,
  autosampler vials and columns. Once a worksheet or item references a type, its kind and
  specs lock.

Two things the builder must verify before writing the entry path, both configuration rather
than design:

- **Each rider service's `origin` must be `mk1`.** Endo's promote refuses any service whose
  `origin != 'mk1'` (`backend/worksheets_endo_promote.py:272`), so a SENAITE-born rider
  service has no write path at all. `PRESSURE-VC` appears as an `mk1`-origin service in
  `backend/tests/test_native_sections.py:1129`, which is encouraging but is a fixture, not
  prod. Check prod.
- **Result type, unit and spec per rider**, from `AnalysisService.result_type` and
  `result_options` (`backend/models.py:207-210`). The mechanism exists; the values decide the
  entry control (numeric with a unit for pH and vacuum, a verdict for fentanyl) and its tests.

#### Row per sample, and what that costs (decision 17)

**One row per sample. Riders are results on that row's prep, never preps of their own.** So
the sheet keeps Dennis's layout and locked decision 3 holds.

That is the right answer for the bench and it is not free, because the data model does not
currently agree with it. Fentanyl is its own vial role with its own demand, and a rider
attaches to the first host role that has demand
(`backend/sub_samples/catalog_demand.py:157-166`; `backend/tests/test_ride_lists.py:140` shows
vacuum riding `[thplc, tfent]` and landing on the fentanyl vial when hplc is absent).
`ROLE_KIND` sends both `hplc` and `fentanyl` to the hplc bench. So one sample ordering purity
plus fentanyl plus vacuum arrives as TWO inbox items and two worksheet rows, and the
fentanyl result's `lims_analyses` row hangs off a vial that is not the one the prep was made
in.

So the work decision 17 creates is a **collapse**, in three places:

1. **Inbox.** One item per sample, with fentanyl and vacuum as badges on the HPLC item rather
   than items of their own, plus a filter for items that have riders. The badge carries its
   state: vacuum reads "not read" until a reading is entered, and it is the FIRST job on the
   sample because it comes before decapping; fentanyl reads "not done" until the strip result
   is in, and it is the LAST. The fentanyl tab is retired, or kept only as a saved filter of
   HPLC items carrying the fentanyl badge.
2. **Resolution.** The fentanyl inbox item must resolve to the same prep row as the purity
   item. Keep the `fentanyl` role for demand and billing, since that is what WordPress orders
   and bills against, but it must not create a prep row or an autosampler vial.
3. **Promote.** The badges travel with the sample's one prep row. Nothing mints a second
   `sample_preps` row for a rider.

Shapes for the two rider results, which differ and must not be unified:

- **Fentanyl: one result and a note per SAMPLE.** No prep of its own, a strip dipped in the
  Step 2 stock at the end. It lands on the purity prep row.
- **Vacuum: one reading per VIAL**, taken before that vial is decapped, stored as a field on
  each vial entry inside the sample's row (`vial_data` already being a per-vial list, S5),
  **with the gauge ID**. It is a required reading when ordered, and the worksheet warns when a
  vial was weighed without one. The gauge ID is a `ConsumableType` reference, which is why
  vacuum gauges belong in that table.

The warning is the interesting constraint: it means the sheet has to know, per vial, that a
weighing was entered while the vacuum field was still empty. Reading the vacuum after the
weighing is not merely late, it is physically impossible, so the warning is the only evidence
the lab gets that a reading was skipped rather than deferred.

### S8. The floor warning

Locked decision 8: warn, carry on. The floor is checked for every non-lead component against
the row's effective `floor_ug_ml`. Dennis's example: Tesamorelin dropping to 60 ug/mL while
Ipamorelin is held at 175 in a Tesa/Ipa blend.

The warning is **derived, never stored.** It falls out of the weighings plus the locked rule,
so it recomputes wherever the row is shown and the drawer, the bench sheet and the CSV cannot
disagree. A stored breach flag would be the first break in the never-stored rule and would go
stale the moment a weighing is corrected.

The precedent is not endo's own floor, and the difference is the whole point. Endo has two
kinds of check:

- **Blocking**, server side: `check_item_endo_fields` (`backend/worksheets_endo.py:411`)
  raises when a total dilution falls below step 1's ratio x 2, because that prep physically
  cannot be made.
- **Advisory**, browser side: the same docstring ends "Tube overflow is only a screen
  warning", and that warning lives as a derived field on the computed prep,
  `warning: 'over_cartridge' | 'no_diluent' | null` (`src/lib/endo-prep.ts:100`).

The HPLC concentration floor is the second kind: a `'below_floor'` member on the equivalent
union in the HPLC prep lib, and **no server-side refusal at all.** Promote validates
weighings and resolved slots; it must not refuse on the floor.

Dennis's sheet today does two other things with the floor, and neither is what we build: his
Step 2b says a sub-60 component "gets its own vial, choose B", and his bench-aid flowchart
(commit 61dffcf) sends it to the Lab Manager. Under decision 8 the vial B move is the tech's
manual choice (S5), and there is no sign-off.

### S9. The Calibration Curve Worksheet

Much closer to existing Mk1 than expected. `CalibrationCurve`
(`backend/models.py:950-1017`) ALREADY has: vendor, lot_number, batch_number, cap_color,
standard_weight_mg, stock_concentration_ug_ml, diluent, diluent_density, column_type,
wavelength_nm, flow_rate_ml_min, injection_volume_ul, operator, run_date, instrument_id,
source_sample_id, slope / intercept / r_squared, `standard_data`
{concentrations, areas, rts}, chromatogram_data, reference_rt, rt_tolerance, is_active,
peptide_analyte_id.

Dennis's sheet has four sections: **The standard** (Compound, Instrument, CAS number,
Standard Supplier, Weight from COA, Diluent density), **Net peptide weight**, **Serial
dilution** ("Stock is the top level"), and **Peak areas and the curve**. Actions: File curve,
Duplicate for another injection, Send to HPLC queue, Curves on file, Export to Excel.

What is MISSING from the model is all of Net peptide weight: CAS, counterion plus counterion
mass (g/mol per eq), equivalents n, free-peptide MW, the stated FW on the CoA, mass-spec m/z
plus ion, CoA assay %, Karl Fischer water %, and the counterion assumption in words. **His
sheet will not file a curve without that written sentence**, and that rule ports with it.

#### The net peptide weight is APPLIED (decisions 15 and 16)

Dennis applies it and so does Mk1, as decided 2026-10-08. `calc.js:1124` multiplies the
standard weighing by the factor before deriving the stock concentration, and the factor
itself is built at `:2745` as `assay * f_counterion * (1 - water)`.

The basis worry that made this a question is answered by the lab, not by code: **the 66 curves
on file were entered by hand with the net weight already applied**, so they sit on the same
basis as the new ones. They get tagged "net, entered by hand" and are otherwise left alone. No
back-correction, no migration of `standard_data`.

A new curve stores the inputs (assay, water, counterion, equivalents) AND the factor computed
from them. Storing the factor beside its inputs is not a cached derivation, it is the applied
value, and decision 16 is why it must be stored separately.

**Partial corrections file, they do not block.** Use what is filled in and treat each blank as
no correction for that part: no assay is 100%, no water is 0%, no counterion is free peptide.
Warn that the correction is partial, **store which parts were used**, and still file. So the
row records which components contributed, not only their product.

**A manual override is kept.** The computed factor is the default; the net weight or the factor
itself can be edited by hand; and the computed value, the applied value and a reason are all
kept on the record. That trio is the audit trail. Without the computed value beside the applied
one, nobody can later tell an override from a different set of inputs.

Dennis's counterion table (acetate 60.05, TFA 114.02, HCl 36.46, iodide 126.90, sodium 21.98)
is new to Mk1 and belongs here, not in the prep rules.

#### One active curve per peptide and instrument (decision 16), and the data fix it needs first

Not enforced today. `CalibrationCurve` has no `__table_args__` at all: no unique constraint,
and `instrument_id` is nullable. Checked against prod, read only:

- 66 curves, **63 active**, and **0 with a null `instrument_id`**, so that column needs no
  backfill.
- **One pair already violates the rule**: peptide 38 on instrument 2 holds two active curves.

So the invariant is one partial unique index plus one decision about which of that pair stays
active. Small, but it has to happen before the constraint or the migration fails on live data.
It is also what makes decision 18's error message meaningful: "the active curve for this
peptide on this instrument" is only well defined once it is unique.

Also missing: the per-level serial-dilution weighings (`standard_data` holds only the final
numbers, while each level is actually made from the one above), and "Duplicate for another
injection", which files as -Inj2 on the same instrument or as that instrument's own curve on
another.

**Trap, and this one has already cost us.** A cross-instrument curve defect put the wrong
quantity on four published COAs. Curve work here must not reintroduce picking a curve from
the wrong instrument, and the fix has to block manual picks too, not just the automatic path.

The hole is located and verified. In `POST /hplc/analyze` (`backend/main.py:6835`), the
fallback path filters the active curve by `instrument_id` when one is supplied, but when
`calibration_curve_id` is passed explicitly the query filters on `peptide_id` only and skips
the instrument check entirely.

**Decision 18 closes it, in this slice's sign-off.** A hand-chosen curve must be from the same
instrument as the run; if it is not, the request stops with an error rather than using it.
Note the shape: it is an error, not a fallback to the right curve. Picking a different curve
than the one the operator asked for would hide the mistake, and a run stopped with a reason is
recoverable while four published COAs were not.

### S10. HPLC Batch Queue: ties only, do not build

Known ties, for the agent building the queue:

- A filed curve's made levels (not the stock) go to the queue as their own batch, lowest
  level first, key `cal:<id>::L<index>::inj<n>`, named `<Compound>-Cal_<inst>_<date>`.
- Prepared sample vials flow from the prep worksheet into the waiting list.
- "OpenLab" appears nowhere in Mk1 and should stay that way on this slice.

### S11. Re-identification (decision 20): new scope, and it lands on a known fault

The requirement: the peptide on a sample can change after measurement **without a new prep**.
The common case is a declared TB4 that is actually the 17-23 fragment. The prep row and its
weighings are untouched, the sample keeps its declared identity and gains a **measured
identity**, processing re-selects the curve for the new peptide **on the same instrument** and
recomputes, and who, when and why are logged. If no curve exists for the new peptide on that
instrument, say so rather than silently reusing the old one. Blends: the same, per component.

This is the right feature and it is being built on top of a path with known open defects.
Verified on current `origin/master` and against prod, read only:

**The surface already exists.** `POST /explorer/samples/{id}/analytes/{slot}/replace` (Replace
Analyte) handles slots 1 to 4, single-peptide samples included, with a vial orchestrator
(`replace_analyte_slot`, `backend/lims_analyses/service.py:1777`) that deletes pristine rows,
rejects worked ones and reports or forces blocked ones. The re-identify control on the
worksheet must call this, and nothing else.

**Trap 1, and it is the one that matters most here.**
`classify_slot_replacement_impact` (`backend/lims_analyses/service.py:3348`) joins
`AnalysisService.peptide_id == old_peptide_id` (`:3373`), so **generic HPLC-PUR and PEPT-Total
rows are never touched by Replace.** Those are exactly the rows carrying purity and quantity.
Replace today swaps the identity service and deliberately leaves the numbers alone, which is
why the existing behaviour has been safe. Decision 20's recompute has to reach precisely the
rows Replace was written to avoid, so it is new code, not a flag on the old path.

**Trap 2.** Step 5 of Replace, the parent AR identity swap through the IS proxy
(`backend/main.py:13156`), is recorded in our own notes as **fail-open**: both the remove and
the add wrapped in warning-only handlers, so a failed swap silently leaves the AR with both
identity analyses or neither. Verify that at build time; if it is still fail-open, a recompute
hanging off it inherits the same silence.

**Trap 3, the one that can defeat the feature before it runs.** The label-only edit path still
sits in the UI next to Replace. Correcting the peptide through the sample-details basic-info
edit rewrites `ClientSampleID`, `ClientLot`, `Analyte{N}Peptide` and the quantities **without
swapping the identity analysis**, and once that edit has run **Replace can no longer repair
it**, because the dialog infers `oldPeptideId` from the very label the bad edit just
corrected. A re-identify control that is easier to reach than the field edit is part of this
slice's value; one that sits beside it without displacing it is not.

**Trap 4, in Dennis's own example.** Checked on prod: `ID_TB500BETA4` ("TB500 (Thymosin Beta
4)") resolves to peptide 63 and `ID_TB500-17-23` ("TB500 (17-23 Fragment)") to peptide 62, so
his TB4 to 17-23 swap resolves on both sides. But `ID_TB500` ("TB-500 - Identity (HPLC)") has
a **NULL `peptide_id`**, and **13 `ID_` services on prod are still unlinked** that way. A
sample registered against one of those has no peptide to swap FROM. Separately,
`PUR_THYMOSINBETA4` and `PUR_TB500BETA4` both point at peptide 63, so one peptide has two
purity services, which the curve re-selection has to tolerate.

**What "measured identity" means in the model.** `hplc_analyses.identity_conforms` and
`identity_rt_delta` already hold the measurement's VERDICT against the declared peptide. What
is new is the measured identity itself, which peptide it actually turned out to be, held
alongside the declared one rather than overwriting it. Mk1 already reports declared against
measured on the COA for quantity, so this extends an existing idea rather than introducing
one.

## 7. Error handling

- Promote failures surface. No bare `try/except` that prints (S5).
- A floor breach never raises (S8).
- A prep that physically cannot be made (a negative or zero volume, a target above the stock)
  raises server side, following `check_item_endo_fields`.
- A promoted row's prep fields return 409 with a reason, not 400 (S6).
- A rider result typed for a service the order does not carry is refused: the result needs a
  `lims_analyses` row to land on.
- `prep_form` outside the accepted set raises with the accepted list in the message, the way
  `ENDO_FORMS` already does.
- A blend with more components than the cap refuses promote with a reason naming the cap,
  rather than silently reporting the first few (decision 19). Never file a partial blend.
- A weighing lower than the one before it is flagged and never computed from (decision 14).
- A vial weighed while its vacuum field is empty warns, when vacuum was ordered (decision 17).
- A hand-picked curve from a different instrument than the run stops with an error
  (decision 18). Not a fallback to the right curve.
- A re-identification with no curve for the new peptide on that instrument says so, and does
  not reuse the old curve (decision 20).
- A partial net-weight correction warns and still files, recording which parts were applied
  (decision 16).

## 8. Dependencies outside this build

**The golden refresh** (approved scope, Handler 2026-10-29): a catalog pull from prod, not a
clone. Measured, a full prod clone would be roughly 15 to 22 GB as a tarball and about 40 GB
live per stack, against about 3 GB today, because prod SENAITE is 28 GB and prod Mk1 is
7582 MB of which `hplc_analyses` is 7363 MB (heap 12 MB, TOAST 7351 MB, dead tuples 0;
`raw_data` averages 752 kB per row). The catalog that actually blocks the rehearsal is under
1 MB. Scope: catalog tables replaced wholesale, all 66 `calibration_curves` with their
standard and chromatogram data (50 MB, and the Calibration Curve Worksheet has nothing to
rehearse against without real curves), plus a bounded sample set exercising each bench. No WP
tables, no customer or order tables, no SENAITE.

Order matters: upgrade the golden in place to current masters FIRST (prod rows carry columns
a 1.21.0 schema lacks), re-establish the two golden invariants, then diff `(id, name/key)`
golden against prod for peptides, services, profiles, methods and instruments, because the
golden's `lims_samples` point at catalog ids and a different mapping makes this a merge by
natural key rather than a replace.

Without that refresh, S7 cannot be rehearsed on a stack at all.

## 9. Testing

- **`hplc_prep_rule_cases.json`**, the shared fixture, pinning the backend matcher and the
  browser mirror to the same answers. Non-negotiable; it is the anti-goal's antidote.
- **Dennis's own expected output as a fixture.** His repo carries `expected_output`,
  `sample_input`, `calc.test.js` and `round-trip.js`. Port his cases, so "Mk1 agrees with
  Dennis" is a test, not an opinion. His `hplc-peptide-quant-data.json` is REAL lab data:
  never edit it, never test against it.
- Per form: powder, liquid, bac (both weighing orders), capsule (including the neat-injection
  warning above 350 ug/mL).
- Two-step: a row at the threshold, one above, one below.
- Blends: default split, per-item override to vial B, a floor breach that still promotes, and
  a 5-component blend hitting the `peptide_analytes` 4-slot ceiling.
- Promote: idempotence (double-promote mints one prep), half-commit retry, 409 after promote.
- Riders: vacuum before decap, pH last, fentanyl, each landing in `lims_analyses`.
- **The first test to write, because it is what the sign-off rests on: a one-step prep's
  reported quantity does not move.** With `dilutionFactorTotal` equal to the single factor on
  a one-step row, every existing prep must produce the quantity it produces today. Pin it
  against real `hplc_analyses` rows before touching `hplc_processor`.
- Two-step quantity against Dennis's expected output, and the backwards-weighing flag (a
  weighing lower than the one before it is flagged, never computed from).
- Net weight: full inputs, each input missing in turn (assay blank is 100%, water blank is 0%,
  counterion blank is free peptide), the partial warning, and a manual override keeping
  computed value, applied value and reason.
- A hand-picked curve from the wrong instrument errors. A second active curve for one peptide
  and instrument is refused.
- Re-identification: the prep row and weighings unchanged, the curve re-selected on the same
  instrument, quantity recomputed, the log written, and the no-curve case saying so. Then the
  same for one component of a blend.
- Rider badges: vacuum "not read" before any reading, the warning when a vial is weighed
  without one, fentanyl "not done" until the strip result, and a fentanyl-only inbox item
  resolving onto the purity prep row without minting a second prep.
- **Gate on the failure-set diff, never on zero failures.** Mk1 has a known test baseline.
- One suite at a time: backend pytest hits the host dev Postgres and concurrent runs deadlock
  (`MK1_DB_HOST=127.0.0.1` from the host, `host.docker.internal` is stale).
- The release gate is the frontend DOCKER build, not `tsc` alone.

## 10. Left to the builder

- Table and column names beyond those named here.
- Where `benzyl_alcohol_density` lives if the method block is wrong for it.
- The exact JSON shape of the vial-split override.
- Whether the worksheet path gets its own measurement trail or leans on `audit_logs`.
  `WizardMeasurement` (5 `step_key` values, already carrying `vial_number`) hangs off
  `wizard_sessions`, which this path does not use.
- Component ordering within a vial on the printed sheet.
- Settling `diluentByPeptide` with the query in S3 before relying on the method's dissolution.
- Whether `instrumentByPeptide` is worth a default-instrument concept now or is deferred.

## 11. Follow-ups ledgered (not this slice)

- Retiring the prep wizard once the worksheet path has run in production.
- Backfilling `wizard_sessions` into worksheets, if ever.
- **Raising the blend cap above four**, which decision 19 anticipates and which needs the
  4-slot program (CHECK, slot maps, conformance, alias slots), not a setting change. The
  setting built in this slice is the hook that program will use.
- The 13 unlinked `ID_` services on prod (`peptide_id` NULL, `ID_TB500` among them), which
  limit re-identification for samples registered against them (S11).
- Displacing the label-only peptide edit path, which can defeat re-identification if it stays
  reachable (S11, trap 3).
- `hplc_analyses.raw_data` retention: 7.4 GB of append-only instrument payloads on a
  db-s-1vcpu-2gb managed instance with no retention rule.
- The existing `vial_data` auto-sync's swallowed failures on the wizard path (S5).
- A default-instrument concept, if `instrumentByPeptide` turns out to be needed.
