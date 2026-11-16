# HPLC Prep Worksheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tech opens an HPLC worksheet in Mk1, works a sheet that has the lab's own step
sections (stock preparation, blend components, intermediate dilution, dilution into the
autosampler vial), promotes a finished row, and the prep is on Sample Preps ready for Process
HPLC, with the results engine computing it from the real weighings. No second tool, no retyping.

**Architecture:** HPLC becomes the fifth bench kind of Worksheets 2.0, the way endotoxin and
PCR are. A row's typed inputs live in ONE new JSON column on `worksheet_items` (`hplc_prep`);
everything shown beside them is worked out, never stored. The working-out is one pure function,
`compute_row`, written once in Python (`backend/hplc_prep.py`) and mirrored in TypeScript
(`src/lib/hplc-prep.ts`), and both are held to the lab tool's own answers by a JSON fixture
GENERATED from that tool's `calc.js`. Promote turns one finished row into one `sample_preps`
row. Two small changes make the new prep reach the certificate correctly: `sample_preps` learns
the fields a two-step, liquid, bac or capsule prep carries, and the Process HPLC flyout passes
them to `POST /hplc/analyze`, which plan 1 already taught to compute them.

This plan is where plan 1's engine stops being inert. Before it, no screen could send a
two-step or non-powder prep; after it, the worksheet can.

**Tech Stack:** Python 3.11 / FastAPI / SQLAlchemy 2.x and psycopg2 (`backend/`), pytest;
React 19 / TypeScript / TanStack Query (`src/`), vitest; Node 24 for the fixture generator.

**Branch:** `feat/hplc-prep-worksheet`, created in worktree `C:/tmp/Accu-Mk1-hplc-ws` off
`feat/hplc-prep-rules` (plan 2) once plan 2 is complete.

**Spec:** `docs/superpowers/specs/2026-10-29-hplc-prep-worksheet-design.md`, sections S1, S4,
S5, S6 and S8, **as amended 2026-11-12** (A1 capsule per capsule, A3 the source is upstream).
Rider results (S7) and the inbox collapse of decision 17 are NOT in this plan; they are plan 3b.

**The source sheet, read-only:** `C:/tmp/tools-dennis-upstream/tools/hplc-peptide-quant/`.
`calc.js` is the arithmetic authority; `app.js` lines 224 to 333 are the column definitions
(labels, tooltips, decimal places) of the four step tables this plan ports. Never read
`C:/tmp/tools-dennis` (stale) and never test against `hplc-peptide-quant-data.json` (real lab
data).

## Global Constraints

- **Additive only.** A failing existing test defaults to "the test is stale", not "the code is
  wrong". The prep wizard, the Sample Preps page and every endo and PCR screen keep working
  exactly as they do. The wizard is NOT retired by this plan.
- **Plan 1's pin must not move.** `backend/tests/test_hplc_processor_golden.py` compares 221
  production cases; it passes before and after every task that touches
  `backend/calculations/hplc_processor.py` or `POST /hplc/analyze`. Never edit
  `backend/tests/fixtures/hplc_engine_golden.json`.
- **No new dilution arithmetic outside the two named files.** `backend/hplc_prep.py` and
  `src/lib/hplc-prep.ts` are the ports; nothing else subtracts weighings or divides volumes.
- **Inputs are stored, derived figures are not.** `worksheet_items.hplc_prep` holds what a tech
  typed. Concentrations, volumes to add, factors and warnings are computed wherever they are
  shown. The one storing moment is promote, which writes the `sample_preps` row.
- **Gate on the failure-set diff, never on zero failures.** Run the test files you touch.
- **Backend tests that need a database run in the devbox stack:**
  `bash C:/tmp/hplc-build/stack-pytest-ws.sh tests/<file>.py -q` (paths relative to `backend/`,
  ships the working tree, fresh scratch database per run). **One run at a time.** Pure tests can
  run locally: `cd C:/tmp/Accu-Mk1-hplc-ws/backend && python -m pytest tests/<file>.py -q -p no:cacheprovider`.
- **Frontend:** `npm` only. `npx vitest run <file>`; `npm run typecheck`; eslint and
  `prettier --check` clean **on the files you touched** (`npm run check:all` cannot pass on this
  repo and is not the gate).
- **A test under `src/` never imports a file under `backend/`.** Read shared fixtures at run
  time with `readFileSync`, as `src/lib/__tests__/endo-prep-rules.test.ts` does.
- **FastAPI `response_model` silently drops undeclared keys.** The three new routes return plain
  dicts with no `response_model`, as `GET /worksheets/{id}` does.
- **`_run_migrations` logs a failed statement instead of raising.** Every new column is added to
  `backend/scripts/check_hplc_columns.py` in the task that creates it.
- **LIMS-side tables use the `lims_` prefix.** This plan adds no table.
- **Commit with an explicit pathspec:** `git commit -m "..." -- <paths>`. Never `git add -A`.
  Check `git -c core.autocrlf=true diff --stat` first; a small edit that shows as a whole-file
  rewrite is a line-ending flip, fix it. New files are LF.
- **No em dashes** in any new text. **Commit messages end with**
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- **Labels are the source sheet's, verbatim**, minus everything it built for typing numbers into
  Mk1 by hand: no blue colour coding, no "to Mk1" tags, no Step 3b, no Step 3c, no "For
  Accu-Mk1" table (locked decision 4).
- **The floor warns and never blocks** (locked decision 8). No route refuses on it.

## The shapes every task shares

**`hplc_prep`, the stored inputs of one row.** Nested objects only, so a PATCH is a recursive
merge: a key sent replaces, a key sent as null is removed, a key not sent is untouched. Every
key is optional; a missing key means "not typed", and the standard applies.

```json
{
  "declared_mg": 10.0,
  "declared_volume_ml": 3.0,
  "capsules": 4,
  "diluent": "Water + 0.1% TFA",
  "diluent_ul": 3000,
  "two_step": true,
  "stock_vial_mg": 5012.31,
  "stock_vial_diluent_mg": 8003.6,
  "components": {"36": {"mg": 5.0, "vial": 2, "target": 175}},
  "vials": {"1": {"lead_id": 36, "target_ug_ml": 200, "target_volume_ul": 1500,
                  "vial_mg": 2500.1, "vial_diluent_mg": 3800.2, "vial_all_mg": 3996.4,
                  "int_target_ug_ml": 5000, "int_volume_ul": 1500,
                  "int_vial_mg": 2500.0, "int_vial_diluent_mg": 3950.0, "int_vial_all_mg": 3995.0}}
}
```

`components` is keyed by the component's peptide id, `vials` by the autosampler vial number
(1 is the sheet's vial A, 2 is B). `declared_mg` overrides the sample's declared weight and is
per capsule on a capsule row. `two_step` is true, false or absent (absent = by the rule).
A bac row's two stock weighings keep the sheet's own order: `stock_vial_diluent_mg` is the vial
full as received, weighed first, and `stock_vial_mg` is the same vial emptied and dried.

The row's **form** is the existing `worksheet_items.prep_form` column (`powder`, `liquid`,
`bac`, `capsule`; NULL = take it from the sample). The row's **instrument** is the existing
`worksheet_items.instrument_id`.

**Row facts, what the server knows about a row before anything is typed:**

```json
{
  "item_id": 311, "sample_id": "P-0120-S01", "parent_sample_id": "P-0120",
  "order_number": "WP-5541", "identity": "BPC-157",
  "peptide_id": 10, "peptide_name": "BPC-157", "is_blend": false,
  "components": [{"peptide_id": 10, "name": "BPC-157", "abbreviation": "BPC-157",
                  "declared_mg": 10.0, "vial": 1}],
  "components_source": "analytes",
  "declared_mg": 10.0,
  "sample_form": {"id": 1, "name": "Lyophilized Powder", "hplc_prep": "powder"},
  "sample_bac": false,
  "form": "powder",
  "rider_only": false,
  "instrument_id": 2, "instrument_name": "HPLC 1290a",
  "params": {"default_target_ug_ml": 200, "...": "the thirteen method constants"},
  "prep_form": null, "hplc_prep": {},
  "promoted": false, "prep": null,
  "problems": []
}
```

`form` is the effective form: the row's `prep_form`, else `bac` when the sample is
bacteriostatic water, else the sample form's `hplc_prep`, else null (a Pen, a Nasal Spray: no
HPLC prep maths, the sheet shows the row with no weighing boxes and it cannot be promoted).
`components` comes from the sample's own analytes (`lims_samples.analytes`, positional slots
with `peptide_id` and `declared_quantity`); a component's default `vial` comes from the catalog
blend's `blend_components.vial_number`.

**Corrected 2026-11-13 during the build.** Only natively registered samples carry `analytes`;
a sample born in the older LIMS has it NULL, and on the dev copy that was every sample. So the
resolution has two steps, and `components_source` says which one answered: `analytes` when the
sample's own slots name at least one peptide; else `analyses`, the peptide set of the sample's
live analyses (`coalesce(LimsAnalysis.peptide_id, AnalysisService.peptide_id)` over the parent
and its vials, the way `coa.spec_rules.sample_peptide_ids` reads it), where a blend's components
come in the catalog blend's display order with `declared_mg` null because the split is not on
file; else null, with `components` empty and a sentence in `problems`. A null `declared_mg` on
the row is normal for an older sample and is typed on the sheet; it is never a problem. `problems` lists what stops the row being planned, in
words ("this blend is not in the catalog", "no declared weight").

**`compute_row(facts, inputs, rules, params)`, the one working-out.** `facts` is the
`declared_mg`, `form`, `peptide_id` and `components` of the row facts; `inputs` is `hplc_prep`;
`rules` is the plan 2 snapshot list; `params` is the thirteen constants. It returns:

```json
{
  "form": "powder", "declared_total_mg": 10.0,
  "diluent": {"diluent": "Water", "rule_id": null, "typed": false},
  "stock": {"total_diluent_ml": 3.0, "problem": null},
  "capsule_diluent_ul": null,
  "floor_ug_ml": 60,
  "components": [{"peptide_id": 10, "declared_mg": 10.0, "vial": 1, "lead": true,
                  "target": {"value": 200, "source": "default", "rule_id": null, "typed": false},
                  "stock_conc_ug_ml": 3333.33, "planned_final_ug_ml": 200.0,
                  "actual_final_ug_ml": 199.4, "below_floor": false}],
  "vials": [{"vial": 1, "component_ids": [10],
             "lead": {"peptide_id": 10, "why": "heaviest"},
             "target": {"value": 200, "source": "default", "typed": false},
             "target_volume_ul": 1500,
             "stock_conc_ug_ml": 3333.33, "two_step": false, "neat": false,
             "intermediate": null,
             "stock_for_final": 3333.33,
             "plan": {"stock_vol_ul": 90.0, "diluent_vol_ul": 1410.0,
                      "stock_half_ul": 45.0, "diluent_half_ul": 705.0},
             "actual": {"actual_diluent_ul": 1304.0, "actual_stock_ul": 196.8,
                        "actual_total_ul": 1500.8, "actual_conc_ug_ml": 437.1,
                        "dilution_factor": 7.626, "problem": null},
             "dilution_factor_total": 7.626,
             "off": {"diluent": false, "stock": false}}],
  "warnings": [{"code": "below_floor", "vial": 1, "peptide_id": 70, "text": "..."}]
}
```

The numbers in that example show the shape only; they are not a worked case. The worked cases
are the fixture's.

`intermediate`, when the vial takes two steps, is
`{"target_ug_ml", "volume_ul", "target_defaulted", "plan": {...}, "actual": {...}, "weighed", "conc_for_final", "off": {...}}`
with `plan` and `actual` shaped like the vial's. Every number is unrounded; the page rounds for
display. A value that cannot be worked out is null, never 0. Warning codes: `declared`,
`stock_backwards`, `step3a_diluent`, `step3a_stock`, `step3_diluent`, `step3_stock`,
`volume_off`, `below_floor`, `capsule_over_neat`, `capsule_no_count`, `split_mismatch`.

The functions it ports, each named after its source in `calc.js` (upstream line numbers):
`stockPrep` (182), `declaredTotalMg` (247), `bacVolumeMl` (282), `dilutionPlan` (315),
`dilutionActual` (341), `volumeOff` (880), `needsTwoStep` (1020), `intermediateTarget` (1038),
`intermediateStep` (1064), the vial loop of `computeRun` (1832 to 1865) and its component loop
(1873 to 1888), `capsuleWarnings` (4048), `weighingWarnings` (2004). Targets, leads, the diluent
and the floor do NOT come from the source's name-matching tables: they come from plan 2's
`component_target`, `pick_lead`, `row_diluent` and `row_floor` over `rules`.

## Review Focus

1. **A capsule row with no count yet.** Nothing is planned and nothing is worked out; the row
   warns `capsule_no_count` and cannot be promoted. It does not divide by zero and does not
   treat the per-capsule weight as the total. Tasks 1, 3 and 6.
2. **A weighing lower than the one before it.** Flagged, never computed from, in every leg: the
   stock, the intermediate and the final vial. The volumes stay visible; no concentration, no
   factor. A bac row's stock weighings run the other way round on purpose and are NOT flagged.
   Tasks 3 and 4.
3. **A blend whose typed component weights do not add up to the declared weight.** The row
   warns `split_mismatch` (more than 0.005 mg apart) and still plans from what was typed.
   Tasks 3 and 4.
4. **Promote pressed twice, and a promote that half-commits.** One `sample_preps` row per
   worksheet item, found by `worksheet_item_id` before any insert. Task 6.
5. **A row edited after promote.** Every prep field answers 409 with "the row is promoted; its
   prep is final"; the instrument and the form are prep fields too. Task 5.
6. **A prep with no instrument.** Promote refuses it. The results engine can only check a curve
   against the run's instrument when the prep names one, and 117 production preps today do not.
   Task 6.

---

### Task 1: Capsule in the results engine

**Files:**
- Modify: `backend/calculations/hplc_processor.py`
- Modify: `backend/main.py` (`HPLCAnalyzeRequest`, `run_hplc_analysis`, `HPLCAnalysisResponse`)
- Modify: `backend/models.py` (`HPLCAnalysis.capsules_used`), `backend/database.py`
  (the ALTER; the `lims_sample_forms.hplc_prep` CHECK widened; the Capsule backfill)
- Modify: `backend/scripts/check_hplc_columns.py`
- Test: `backend/tests/test_hplc_capsule.py` (new), and run
  `tests/test_hplc_processor_golden.py`, `tests/test_hplc_processor_engine.py`,
  `tests/test_hplc_analyze_route.py`, `tests/test_sample_forms_schema.py`

**Read first:** `backend/calculations/hplc_processor.py` lines 96 to 230 and
`process_hplc_analysis`; in `backend/database.py` the `hplc_prep` block near line 2289.

**Interfaces:**
- Produces:
  - `PREP_FORMS = ("powder", "liquid", "bac", "capsule")`. A capsule's stock volume is worked out
    exactly as a powder's. A capsule is injected neat, and the engine needs nothing new for
    that: a dilution vial whose "+ diluent" weighing equals its empty weighing has added no
    diluent, which the engine already treats as a legal neat injection with a factor of 1.
  - `AnalysisInput.capsules_used: Optional[int] = None`.
  - `POST /hplc/analyze` accepts `capsules_used: Optional[int]`. For `prep_form == "capsule"` it
    is required and at least 1 (422 naming the field otherwise); for any other form it must be
    absent or null (422).
  - **The reported `quantity_mg` of a capsule analysis is per capsule:** the mass found in the
    stock divided by `capsules_used`. The division happens before the result is rounded and
    before the too-small-to-report check, so both apply to the per-capsule figure. The total
    stays in the calculation trace as `capsule_total_mg`, with `capsules_used` beside it.
  - `hplc_analyses.capsules_used INTEGER NULL`, returned by the route and declared on
    `HPLCAnalysisResponse`.
  - `lims_sample_forms.hplc_prep` CHECK becomes `IN ('powder','liquid','capsule')` (drop and
    re-add `ck_lims_sample_forms_hplc_prep` inside one guarded DO block that only acts when the
    existing definition lacks `capsule`), and the boot backfill sets `hplc_prep = 'capsule'` on
    the built-in form named `capsule` where it is NULL.

- [ ] **Step 1: Write the failing tests**

```python
def test_capsule_stock_volume_is_a_powders():
    w = WeightInputs(1000.0, 3006.0, 1000.0, 1000.0, 1200.0)
    assert stock_volume_ml("capsule", w, 997.1) == stock_volume_ml("powder", w, 997.1)

def test_capsule_quantity_is_per_capsule():
    # four 10 mg capsules in one stock, injected neat: the stock holds about 40 mg
    total = _quantity(form="powder", capsules=None)       # the helper builds one AnalysisInput
    per = _quantity(form="capsule", capsules=4)
    assert per["quantity_mg"] == pytest.approx(total["quantity_mg"] / 4, abs=1e-4)
    assert per["calculation_trace"]["quantity"]["capsule_total_mg"] == pytest.approx(total["quantity_mg"], abs=1e-4)
    assert per["calculation_trace"]["quantity"]["capsules_used"] == 4

def test_a_neat_vial_has_a_factor_of_one():
    w = WeightInputs(1000.0, 3006.0, 1000.0, 1000.0, 1200.0)   # "+ diluent" == empty: no diluent
    d = calculate_dilution_factor(w, 997.1, form="capsule")
    assert d["problem"] is None and d["dilution_factor_total"] == 1.0

def test_too_small_is_judged_on_the_per_capsule_figure(): ...
def test_route_requires_a_count_for_a_capsule(client): ...          # 422, names capsules_used
def test_route_refuses_a_count_on_a_powder(client): ...             # 422
def test_route_stores_and_returns_capsules_used(client): ...
def test_the_capsule_form_row_is_backfilled_and_the_check_allows_it(db): ...
def test_endo_forms_are_still_a_subset_of_prep_forms(): ...
```

- [ ] **Step 2: Run and see them fail.**
  `bash C:/tmp/hplc-build/stack-pytest-ws.sh tests/test_hplc_capsule.py -q` Expected: FAIL
  ("prep form must be one of powder, liquid, bac").

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the new file and the four named above.** Expected: the new file all PASS;
  the golden file still reports every case unchanged; the other three unchanged.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-ws commit -m "feat(hplc): the results engine takes a capsule and reports it per capsule" -- backend/calculations/hplc_processor.py backend/main.py backend/models.py backend/database.py backend/scripts/check_hplc_columns.py backend/tests/test_hplc_capsule.py
```

---

### Task 2: Sample Preps learns the new prep, and Process HPLC sends it

**Files:**
- Modify: `backend/mk1_db.py` (`ensure_sample_preps_table`, `create_sample_prep`,
  `update_sample_prep` and the row serialisation if it whitelists columns)
- Modify: `backend/scripts/check_hplc_columns.py`
- Create: `src/lib/hplc-analyze-fields.ts`
- Modify: `src/components/hplc/SamplePrepHplcFlyout.tsx` (the two `runHPLCAnalysis` call sites,
  about lines 1310 to 1370)
- Modify: `src/lib/api.ts` (the `SamplePrep` and vial-data types; the `runHPLCAnalysis` request type)
- Test: `backend/tests/test_sample_preps_hplc_columns.py`,
  `src/lib/__tests__/hplc-analyze-fields.test.ts`

**Interfaces:**
- Produces, on `sample_preps` (all nullable, added with `ADD COLUMN IF NOT EXISTS` beside the
  existing ALTERs): `prep_form VARCHAR(10)`, `declared_volume_ml DOUBLE PRECISION`,
  `capsules_used INTEGER`, `diluent VARCHAR(40)`, `int_vial_empty_mg`,
  `int_vial_with_diluent_mg`, `int_vial_final_mg` (all `DOUBLE PRECISION`),
  `worksheet_item_id INTEGER`, plus
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_sample_preps_worksheet_item ON sample_preps (worksheet_item_id) WHERE worksheet_item_id IS NOT NULL`.
  `create_sample_prep` and `update_sample_prep` accept the eight keys. A `vial_data` entry may
  carry the three `int_vial_*` keys as well.
- Produces: `mk1_db.list_sample_preps_for_worksheet_items(item_ids: list[int]) -> list[dict]`
  (one query, `[]` for an empty list), which is how Tasks 5 and 6 tell a promoted row.
- The tests call `mk1_db.ensure_sample_preps_table()` before they read the schema: the scratch
  database is a copy of a stack that booted an older image, so the new columns exist only after
  that call.
- Produces, in `src/lib/hplc-analyze-fields.ts`:

```ts
export interface PrepAnalyzeFields {
  weights: { stock_vial_empty: number | null; stock_vial_with_diluent: number | null;
             dil_vial_empty: number | null; dil_vial_with_diluent: number | null;
             dil_vial_with_diluent_and_sample: number | null;
             int_vial_empty?: number | null; int_vial_with_diluent?: number | null;
             int_vial_with_diluent_and_sample?: number | null }
  prep_form?: 'powder' | 'liquid' | 'bac' | 'capsule'
  declared_volume_ml?: number
  capsules_used?: number
}
/** What POST /hplc/analyze needs from a prep, for the row as a whole (vialNumber null) or for
 *  one entry of its vial_data. */
export function prepAnalyzeFields(prep: SamplePrep, vialNumber?: number | null): PrepAnalyzeFields
```

  **Corrected 2026-11-12 during the build.** An earlier draft of this task put the intermediate
  weighings in a top-level `intermediate` key. `HPLCAnalyzeRequest` has no such field: the route
  reads the three `int_vial_*` weighings from INSIDE `weights` (`HPLCWeightsInput`), and an
  unknown top-level key is dropped without an error, which would have computed a two-step prep
  as one step. They go inside `weights`.

  Rules: a **wizard-born prep (no `prep_form`) must produce exactly the request it produces
  today**: the five weights with the same `?? 0` fallbacks, no `int_vial_*` keys, and none of
  `prep_form`, `declared_volume_ml`, `capsules_used` (the server defaults the form to powder).
  For a prep that has a `prep_form`: `prep_form` is sent; a missing weight is `null`, not 0; the
  three `int_vial_*` keys are present inside `weights` only when at least one of them is stored;
  `declared_volume_ml` only for `liquid`; `capsules_used` only for `capsule`. A blend takes the
  weights, intermediate included, from the `vial_data` entry of that vial, and the form, the
  volume and the count from the row.
  The flyout calls it at both call sites and spreads the result into the request.

- [ ] **Step 1: Write the failing tests**

```ts
it('a wizard-born prep builds the request it builds today', ...)          // snapshot of the five weights, no extra keys
it('a worksheet-born two-step prep sends its intermediate', ...)
it('a liquid prep sends its declared volume and null stock weighings', ...)
it('a capsule prep sends its count', ...)
it('a blend reads the weighings of the vial it is asked for', ...)
it('a missing weight on a worksheet-born prep is null, never 0', ...)
```

```python
def test_the_eight_columns_and_the_unique_index_exist(mk1): ...
def test_create_and_update_round_trip_the_new_keys(mk1): ...
def test_two_preps_cannot_share_a_worksheet_item(mk1): ...                 # the second insert raises
def test_a_prep_with_no_worksheet_item_is_unconstrained(mk1): ...          # two NULLs are fine
```

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the two new files, `npm run typecheck`, eslint and prettier on the touched
  files, and any existing `SamplePrepHplcFlyout` tests (`npx vitest run src/components/hplc --reporter=dot -t "SamplePrepHplcFlyout"`). Expected: new tests PASS, existing unchanged.
- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-ws commit -m "feat(hplc): sample preps carry form, intermediate and capsule count, and Process HPLC sends them" -- backend/mk1_db.py backend/scripts/check_hplc_columns.py backend/tests/test_sample_preps_hplc_columns.py src/lib/hplc-analyze-fields.ts src/lib/__tests__/hplc-analyze-fields.test.ts src/components/hplc/SamplePrepHplcFlyout.tsx src/lib/api.ts
```

---

### Task 3: The fixture from the source sheet, and `compute_row` in Python

**Files:**
- Create: `backend/tests/fixtures/make_hplc_prep_cases.cjs` (the generator; a dev tool, run by
  hand, never at test time)
- Create: `backend/tests/fixtures/hplc_prep_cases.json` (its output, committed)
- Create: `backend/hplc_prep.py`
- Test: `backend/tests/test_hplc_prep.py` (pure, runs locally)

**Read first:** "The shapes every task shares" above; the source functions it lists; and
`backend/hplc_prep_rules.py` (plan 2) for the four rule functions `compute_row` calls.

**Interfaces:**
- Consumes: `hplc_prep_rules.match_rule`, `component_target`, `pick_lead`, `row_diluent`,
  `row_floor`; `catalog.method_run_params.HPLC_RUN_PARAM_DEFAULTS`;
  `calculations.hplc_processor.BENZYL_ALCOHOL_DENSITY` and `BAC_STOCK_UG_ML` are already inside
  `params`.
- Produces: `hplc_prep.compute_row(facts: dict, inputs: Optional[dict], rules: list[dict], params: dict) -> dict`,
  returning exactly the shape in "The shapes every task shares". Pure: no database, no imports
  from `main` or `models`.
- Produces: the fixture,
  `{"about": "...", "source_commit": "39a1afe8...", "params": {...}, "rules": [...], "peptides": {"10": "BPC-157", ...}, "cases": [{"name", "facts", "inputs", "expect"}]}`,
  where `expect` is the full `compute_row` result.

**The generator.** `node backend/tests/fixtures/make_hplc_prep_cases.cjs <path to calc.js>`
requires the source `calc.js`, builds each case's sample in the SOURCE's own input shape, runs
the source's `computeRun`, and writes each case with its inputs translated into Mk1's `facts`
and `inputs` and its outputs translated into the `expect` shape. The translation table is
written once in the generator and is the thing a reviewer checks:

| Mk1 | source sample field |
|---|---|
| `facts.declared_mg` or `inputs.declared_mg` | `declaredMg` |
| `facts.form` | `form` |
| `inputs.declared_volume_ml` | `declaredVolumeMl` |
| `inputs.capsules` | `capsules` |
| `inputs.diluent` / `inputs.diluent_ul` | `diluent` / `diluentUl` |
| `inputs.two_step` | `twoStep` |
| `inputs.stock_vial_mg` / `stock_vial_diluent_mg` | `vialMg` / `vialDiluentMg` |
| `inputs.components[id].mg` / `.vial` / `.target` | `componentMg[name]` / `componentVial[name]` (A, B) / `componentTarget[name]` |
| `inputs.vials[n].lead_id` | `leadPeptide` (vial 1) or `vialLead[letter]` |
| `inputs.vials[1].*` | the row's own `targetConcUgPerMl`, `targetVolumeUl`, `asVialMg`, `asVialDiluentMg`, `asVialAllMg`, `intTargetUgPerMl`, `intVolumeUl`, `intVialMg`, `intVialDiluentMg`, `intVialAllMg` |
| `inputs.vials[n>1].*` | the same fields under `extraVials[letter]` |
| a blend's identity | the component names joined with `" + "` |

The fixture's `rules` are the lab's own lines in plan 2's snapshot shape (NAD+ 150; GHK-Cu 125,
blend 350, TFA, lead priority 2; Ipamorelin 150, blend 175, lead priority 1), so the source's
built-in tables and Mk1's rules give the same targets and leads. The generator asserts that for
every case before writing: a case whose source target or lead differs from what the fixture's
`rules` would give is a generator bug and stops the run.

Cases, at least (names are the test ids):

| case | what it pins |
|---|---|
| powder, nothing weighed | plan only; every actual null |
| powder, fully weighed, one step | stock, plan, actual, factor |
| powder, typed target and volume | typed beats the rule |
| powder, a peptide with a rule target (NAD+) | 150 from the rule |
| powder, stock weighings backwards | `stock.problem` `diluent`, no stock, warning |
| powder, final vial "+ diluent" lighter than empty | `actual.problem` `diluent`, volumes kept, no conc |
| powder, last weighing not above "+ diluent" | `actual.problem` `stock` |
| powder, declared 500 mg, unweighed | two-step by the rule; intermediate target 5000 planned |
| powder, declared 500 mg, intermediate and final weighed | both factors and their product |
| powder, declared 750 mg, `two_step` false | the override wins, one step |
| powder, declared 100 mg, `two_step` true | the override wins, two steps |
| powder, pipetted volume 20 % off plan | `off` true and a `volume_off` warning |
| liquid, declared 3 mL | the declared volume is the stock; stock weighings ignored |
| liquid, no declared volume | nothing worked out |
| bac, weighed full then emptied | corrected volume, stock 9000, target 500, declared worked out |
| capsule, 4 x 10 mg, weighed, neat | total 40 mg, plan takes the stock neat, factor 1, `capsule_diluent_ul` |
| capsule, no count | `capsule_no_count`, nothing planned |
| capsule, stock above 350 | `capsule_over_neat` |
| blend of two, unsplit | lead by the rule; the declared total stands in |
| blend Tesamorelin + Ipamorelin, split | Ipamorelin leads at 175; Tesamorelin's planned final and floor check |
| blend with a component under 60 | `below_floor` true on the non-lead only; still plans |
| blend, one component moved to vial 2 | two vials, each with its own lead and dilution |
| blend, typed lead | `why` `chosen` |
| blend, typed component target | the lead's typed own target sets the vial's target |
| blend, weights that do not add up | `split_mismatch` |

- [ ] **Step 1: Write the generator and run it** against
  `C:/tmp/tools-dennis-upstream/tools/hplc-peptide-quant/calc.js`. Commit the JSON it writes.
- [ ] **Step 2: Write `test_hplc_prep.py`:** one parametrized test per fixture case comparing
  `compute_row(case.facts, case.inputs, fixture.rules, fixture.params)` with `case.expect`,
  numbers by `pytest.approx(rel=1e-9, abs=1e-9)`, everything else exactly. Plus one test that,
  for every case whose weighings are complete, plan 1's engine agrees with the port:

```python
def test_the_engine_agrees_with_the_port_on_every_weighed_case(case):
    row = compute_row(case["facts"], case["inputs"], RULES, PARAMS)
    for vial in row["vials"]:
        if vial["dilution_factor_total"] is None:
            continue
        d = calculate_dilution_factor(_weights(case, vial), PARAMS["diluent_density_mg_ml"],
                                      _intermediate(case, vial), form=row["form"],
                                      declared_volume_ml=case["inputs"].get("declared_volume_ml"))
        assert d["problem"] is None
        assert d["dilution_factor_total"] == pytest.approx(vial["dilution_factor_total"], abs=1e-6)
        assert d["stock_volume_ml"] == pytest.approx(row["stock"]["total_diluent_ml"], abs=1e-6)
```

  That test is what holds the number shown on the sheet to the number Process HPLC will
  compute from the promoted prep. `_weights` builds the engine's five weighings from the case's
  inputs the way promote will: a capsule vial with a blank "+ diluent" weighing takes its empty
  weighing there (neat), and a bac row's two stock weighings go to whichever of
  `stock_vial_empty` and `stock_vial_with_diluent` the engine's `stock_volume_ml` reads them as.
- [ ] **Step 3: Run and see it fail** (`hplc_prep` not found).
- [ ] **Step 4: Implement `backend/hplc_prep.py`.**
- [ ] **Step 5: Run** `python -m pytest tests/test_hplc_prep.py -q -p no:cacheprovider`.
  Expected: all PASS.
- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-ws commit -m "feat(hplc): compute_row, held to the source sheet by a generated fixture" -- backend/hplc_prep.py backend/tests/test_hplc_prep.py backend/tests/fixtures/make_hplc_prep_cases.cjs backend/tests/fixtures/hplc_prep_cases.json
```

---

### Task 4: `computeRow` in the browser

**Files:**
- Create: `src/lib/hplc-prep.ts`
- Test: `src/lib/__tests__/hplc-prep.test.ts`

**Interfaces:**
- Consumes: `backend/tests/fixtures/hplc_prep_cases.json` (Task 3), read at run time;
  `matchRule`, `componentTarget`, `pickLead`, `rowDiluent`, `rowFloor`, `HplcPrepRule` from
  `src/lib/hplc-prep-rules.ts` (plan 2).
- Produces: the types `HplcPrepInputs` (the `hplc_prep` shape), `HplcRowFacts`
  (`declared_mg`, `form`, `peptide_id`, `components`), `HplcRowComputed` (the result shape) and
  `HplcWarning`; `computeRow(facts, inputs, rules, params): HplcRowComputed`, the Python
  function's twin, same keys, same nulls; and `mergeHplcPrep(stored, patch): HplcPrepInputs`,
  the recursive merge the PATCH route applies (a null leaf removes the key, an object left empty
  is removed), so an optimistic update shows what the server will store.

- [ ] **Step 1: Write the failing test:** every fixture case through `computeRow`, numbers with
  `toBeCloseTo` at 9 places, everything else `toEqual`; and for `mergeHplcPrep`:

```ts
it('a sent key replaces, a null removes, an unsent key stays', ...)
it('an emptied vial or component entry is removed, and so is an emptied map', ...)
it('never mutates what it was given', ...)
```

- [ ] **Step 2: Run and see it fail.** `npx vitest run src/lib/__tests__/hplc-prep.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, typecheck, lint** on the two files.
- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-ws commit -m "feat(hplc): computeRow in the browser, on the same fixture" -- src/lib/hplc-prep.ts src/lib/__tests__/hplc-prep.test.ts
```

---

### Task 5: The row's storage, the sheet's read model and its two routes

**Files:**
- Modify: `backend/models.py` (`WorksheetItem.hplc_prep`), `backend/database.py` (the ALTER),
  `backend/scripts/check_hplc_columns.py`
- Create: `backend/worksheets_hplc.py`
- Modify: `backend/main.py` (two routes, placed after the worksheet item PATCH route)
- Test: `backend/tests/test_worksheets_hplc.py`

**Read first:** `backend/worksheets_endo.py` (`check_item_endo_fields`, `form_is_bac`,
`PREP_FINAL`), `backend/endo_prep_rules.py` `_row_inputs` (how a row's parent, peptide and
weight are found today), and in `backend/main.py` `_worksheet_item_parents`,
`_worksheet_item_parent_facts`, `_bench_kind_for_item` and `update_worksheet_item`.

**Interfaces:**
- Consumes: `hplc_prep.compute_row` (Task 3) is NOT called here; the read model serves facts and
  inputs and the browser computes. `catalog.method_run_params.hplc_run_params`.
- Produces: `worksheet_items.hplc_prep JSON NULL`.
- Produces, in `backend/worksheets_hplc.py`:

```python
HPLC_FORMS = ("powder", "liquid", "bac", "capsule")
PREP_FINAL = "the row is promoted; its prep is final"          # endo's wording, the same string

def validate_hplc_prep_patch(patch) -> dict
    # A merge patch in the hplc_prep shape. Raises ValueError naming the key for: an unknown key
    # at any level; a number that is not finite; a weight, volume or target below zero; a
    # `capsules` or `lead_id` that is not a whole number of at least 1; a `vial` outside 1 to 7;
    # a `components` or `vials` key that is not a positive whole number; `two_step` that is not
    # a boolean; `diluent` outside hplc_prep_rules.HPLC_DILUENTS. null is always allowed.
def merge_hplc_prep(stored: Optional[dict], patch: dict) -> Optional[dict]
    # recursive merge; a null leaf removes the key; an emptied object is removed; None when
    # nothing is left. Never mutates its arguments.
def sheet_rows(db, worksheet, items=None) -> list[dict]
    # the row facts of every HPLC-kind item, in the worksheet's item order (one row per item)
def apply_patch(db, worksheet, item, *, prep_form=..., hplc_prep=...) -> dict
    # validates, refuses, stores; returns the row's facts
```

- Produces the routes:
  - `GET /worksheets/{worksheet_id}/hplc` ->
    `{"worksheet_id", "status", "blend_cap": int, "rows": [row facts]}`. 404 for a missing or
    staging worksheet.
  - `PATCH /worksheets/{worksheet_id}/items/{item_id}/hplc`, body
    `{"prep_form"?: str | null, "hplc_prep"?: {merge patch}}` -> the row's facts after the
    change. 400 with the reason for a bad patch or a `prep_form` outside `HPLC_FORMS` (the
    message lists them); 404 for an item not on this worksheet or not an HPLC row; 409
    "Worksheet is completed"; 409 `PREP_FINAL` when the row is promoted and the patch would
    change anything.
  - The existing `PATCH /worksheets/{worksheet_id}/items/{item_id}` gains one guard: changing
    `instrument_id` or `instrument_uid` on a promoted HPLC row answers 409 `PREP_FINAL`.
- `blend_cap` reads the `settings` row `hplc_blend_component_cap` (default 4, clamped to 1 to 4;
  4 is the physical ceiling until the 4-slot program lands). No settings screen in this task.
- A row is **promoted** when a `sample_preps` row carries its `worksheet_item_id` (Task 2's
  column); `prep` is then `{"id", "sample_id", "status"}`.
- The row's catalog peptide: the sample's analytes with a `peptide_id`. One: that peptide. Two
  or more: the blend peptide whose `blend_components` are exactly that set, else `peptide_id`
  null and the problem "this blend is not in the catalog". None: `peptide_id` null and the
  problem "the sample has no catalog peptide".
- `rider_only` is true for an item whose vial role is `fentanyl`; such a row has no prep.
- `params` is `hplc_run_params(method.run_parameters)` for the method the existing code
  resolves from the row's peptide and instrument, and the defaults when none resolves.

- [ ] **Step 1: Write the failing tests**

```python
def test_merge_replaces_removes_and_keeps(): ...
def test_merge_drops_an_emptied_vial_and_an_emptied_map(): ...
def test_validate_names_the_bad_key(): ...            # parametrized over every refusal above
def test_sheet_rows_serve_a_solo_peptide_row(db, hplc_worksheet): ...
def test_a_blend_row_carries_its_components_with_their_default_vials(db, ...): ...
def test_a_blend_missing_from_the_catalog_says_so(db, ...): ...
def test_the_row_form_wins_then_bac_then_the_sample_form(db, ...): ...
def test_a_form_with_no_hplc_prep_serves_a_null_form(db, ...): ...           # a Pen
def test_patch_merges_and_returns_the_row(client, ...): ...
def test_patch_refuses_a_completed_worksheet(client, ...): ...               # 409
def test_patch_refuses_a_promoted_row(client, ...): ...                      # 409 PREP_FINAL
def test_a_patch_that_changes_nothing_on_a_promoted_row_is_fine(client, ...): ...
def test_the_item_route_refuses_an_instrument_change_on_a_promoted_row(client, ...): ...
def test_an_endo_row_is_not_an_hplc_row(client, ...): ...                    # 404
```

- [ ] **Step 2: Run and see them fail.**
  `bash C:/tmp/hplc-build/stack-pytest-ws.sh tests/test_worksheets_hplc.py -q`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file and `tests/test_endo_item_fields.py` (or whichever existing
  file covers `update_worksheet_item`; name it in your report). Expected: new all PASS, existing
  unchanged.
- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-ws commit -m "feat(hplc): worksheet rows store their prep inputs and serve the sheet's facts" -- backend/models.py backend/database.py backend/scripts/check_hplc_columns.py backend/worksheets_hplc.py backend/main.py backend/tests/test_worksheets_hplc.py
```

---

### Task 6: Promote, the row becomes a prep

**Files:**
- Create: `backend/worksheets_hplc_promote.py`
- Modify: `backend/main.py` (one route, after Task 5's)
- Test: `backend/tests/test_worksheets_hplc_promote.py`

**Read first:** `backend/main.py` about lines 17090 to 17270 (how the wizard builds a
`sample_preps` row, its `components_json` and its `vial_data`, and stamps the vial's analyses),
`backend/worksheets_endo_promote.py` for the refusal style, and `backend/mk1_db.py`
`create_sample_prep`.

**Interfaces:**
- Consumes: `worksheets_hplc.sheet_rows` (Task 5), `hplc_prep.compute_row` (Task 3),
  `hplc_prep_rules.load_rules` (plan 2), `mk1_db.create_sample_prep` with Task 2's keys.
- Produces: `POST /worksheets/{worksheet_id}/items/{item_id}/hplc/promote` ->
  `{"prep": {"id", "sample_id", "status"}, "already": bool, "row": row facts}`.
  200 with `already: true` when the row was promoted before (found by `worksheet_item_id`
  BEFORE anything is inserted). 409 with the reasons, all of them at once in
  `{"detail": {"message": "...", "reasons": [...]}}`, when the row cannot be promoted.
- Produces: `worksheets_hplc_promote.promote_reasons(row: dict, computed: dict, blend_cap: int) -> list[str]`
  (pure) and `promote_row(db, current_user, worksheet, item) -> dict`.

**What stops a promote**, each a sentence the tech can act on:
- the worksheet is completed; the row is rider only; the row's form is null ("this form has no
  HPLC prep in Mk1");
- no catalog peptide; a blend with more components than `blend_cap` ("this blend has 5
  components and the cap is 4; a partial blend is never filed");
- **no instrument** ("pick the instrument first: a curve is checked against the run's
  instrument, and a prep without one cannot be checked");
- no declared weight; a capsule with no count; a liquid with no declared volume;
- a weighing missing or flagged: the stock pair (powder, bac, capsule), each vial's three, and
  the intermediate three of every two-step vial. A capsule's "+ diluent" weighing may be blank;
- a blend with a component that has no weight.

**The floor never stops a promote.** A `below_floor` warning is carried into the prep's notes.

**What promote writes**, one `sample_preps` row per worksheet item:
- identity: `worksheet_item_id`; `lims_sub_sample_pk` (the vial); `senaite_sample_id` = the
  item's sample id; the catalog peptide's id, name and abbreviation; `instrument_id` and name;
  the user-tracking columns; `status` `awaiting_hplc`;
- the row: `prep_form`, `declared_weight_mg` (the declared TOTAL in the stock, so per capsule
  times the count for a capsule; the worked-out weight for bac), `declared_volume_ml`,
  `capsules_used`, `diluent`;
- vial 1 in the flat columns: `target_conc_ug_ml`, `target_total_vol_ul`,
  `stock_vial_empty_mg`, `stock_vial_loaded_mg`, `dil_vial_empty_mg`,
  `dil_vial_with_diluent_mg`, `dil_vial_final_mg`, the three `int_vial_*`, and the derived
  `stock_conc_ug_ml`, `required_stock_vol_ul`, `required_diluent_vol_ul`, `actual_conc_ug_ml`,
  `actual_diluent_vol_ul`, `actual_stock_vol_ul`, `actual_total_vol_ul` from `compute_row`;
- a capsule vial whose "+ diluent" weighing is blank is written with it equal to the empty
  weighing, which is what makes the engine read it as neat;
- for a blend: `is_blend`, `components_json` in the wizard's shape with each component's
  `vial_number` as THIS ROW assigned it, and `vial_data` with one entry per vial in the wizard's
  shape plus the three `int_vial_*` keys and `analyte_data`.

The stock weighings are written in the engine's order: read `stock_volume_ml` in
`backend/calculations/hplc_processor.py` to see which of a bac row's two weighings it expects
as `stock_vial_empty` and which as `stock_vial_with_diluent`, and write them that way. The test
below that sends a promoted bac prep through the engine is what proves it.

After the insert: stamp the vial's analyses with the instrument and method exactly as the
wizard does (reuse its helper; best effort, logged, never fatal), and set the row's
`prep_rule` to `{"event": "promote", "locked_at", "locked_by", "diluent", "floor_ug_ml", "vials": [{"vial", "lead", "target"}]}`
so the row keeps the rule it was promoted under. Failures surface as 500 with the reason; no
bare `except` that only prints.

- [ ] **Step 1: Write the failing tests**

```python
def test_reasons_is_empty_for_a_finished_powder_row(): ...
def test_reasons_lists_every_gap_at_once(): ...
def test_the_floor_is_never_a_reason(): ...
def test_no_instrument_is_a_reason(): ...
def test_a_blend_over_the_cap_is_a_reason_and_names_the_cap(): ...
def test_promote_writes_one_prep_with_the_typed_weighings(client, ...): ...
def test_promote_twice_returns_the_same_prep_and_inserts_nothing(client, ...): ...
def test_a_promote_that_finds_a_prep_from_a_half_commit_heals(client, ...): ...
def test_a_two_step_row_writes_its_intermediate_weighings(client, ...): ...
def test_a_blend_writes_components_json_and_one_vial_data_entry_per_vial(client, ...): ...
def test_a_component_moved_to_vial_2_is_vial_2_in_components_json(client, ...): ...
def test_a_capsule_prep_is_neat_and_carries_its_count(client, ...): ...
def test_after_promote_the_prep_fields_answer_409(client, ...): ...

@pytest.mark.parametrize("kind", ["powder", "two_step", "liquid", "bac", "capsule"])
def test_a_promoted_prep_goes_through_the_engine_and_matches_the_sheet(client, kind, ...):
    # promote the row, build the engine's inputs from the STORED sample_preps row the way
    # src/lib/hplc-analyze-fields.ts does, run calculate_dilution_factor, and compare its total
    # factor and stock volume with compute_row's for the same row (abs=1e-6)
```

- [ ] **Step 2: Run and see them fail.**
  `bash C:/tmp/hplc-build/stack-pytest-ws.sh tests/test_worksheets_hplc_promote.py -q`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file plus `tests/test_worksheets_hplc.py`. Expected: all PASS.
- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-ws commit -m "feat(hplc): promote a finished worksheet row to a sample prep" -- backend/worksheets_hplc_promote.py backend/main.py backend/tests/test_worksheets_hplc_promote.py
```

---

### Task 7: The HPLC worksheet page, with Step 2 and Step 3

**Files:**
- Modify: `src/lib/api.ts` (three functions: `getHplcSheet`, `patchHplcRow`, `promoteHplcRow`,
  and their types)
- Create: `src/services/hplc-worksheet.ts`
- Create: `src/components/hplc/WorksheetPage.tsx`
- Create: `src/components/hplc/prep/HplcWorksheetPage.tsx`
- Create: `src/components/hplc/prep/HplcPrepSheet.tsx`
- Create: `src/components/hplc/prep/HplcSheetCells.tsx`
- Create: `src/components/hplc/prep/hplc-sheet-columns.ts`
- Modify: `src/components/layout/MainWindowContent.tsx` (the `'worksheet'` sub-section renders
  `WorksheetPage`)
- Modify: `src/components/hplc/WorksheetDrawer.tsx` (an all-HPLC worksheet shows a short summary
  and an "Open worksheet" button that opens its page, the way an endo worksheet does)
- Test: `src/components/hplc/prep/__tests__/HplcPrepSheet.test.tsx`,
  `src/components/hplc/prep/__tests__/HplcWorksheetPage.test.tsx`,
  `src/components/hplc/__tests__/WorksheetPage.test.tsx`

**Read first:** `src/components/hplc/endo/EndoWorksheetPage.tsx` (the page shell: title,
analyst, Add samples, notes, completed state, how it is opened and keyed),
`src/components/hplc/EndoWorksheetTable.tsx` (how a cell commits on blur or Enter and PATCHes
one field, how a failed save is shown, how a completed worksheet goes read-only), and the
source's `app.js` lines 224 to 270 (`STEP1`, which is the sheet's Step 2) and 306 to 333
(`STEP2`, the sheet's Step 3).

**Interfaces:**
- Consumes: the three routes (Tasks 5 and 6); `computeRow`, `mergeHplcPrep` and the types
  (Task 4); `useHplcPrepRules` (plan 2).
- Produces: `WorksheetPage` (reads `worksheetPageId` from the UI store, loads the worksheet with
  the endo page's query key, renders `HplcWorksheetPage` for kind `hplc` and `EndoWorksheetPage`
  for everything else, so the endo page's own messages are untouched);
  `HPLC_SHEET_KEY = (id: number) => ['hplc-sheet', id] as const`, `useHplcSheet(id)`,
  `usePatchHplcRow(id)` (optimistic through `mergeHplcPrep`, rolled back on error with the
  server's reason shown) in the service; `HplcPrepSheet` taking
  `{ sheet, rules, readOnly, onPatch(itemId, patch), onPromote(itemId) }`.

**The page.** Under the endo page's header shell, the sheet is the source's step sections, in
its order and with its section titles and one-line descriptions:

1. a warnings panel listing every row's `warnings`, each prefixed with its sample id;
2. **Step 2, Peptide sample stock preparation**, one row per sample;
3. **Step 3, Peptide dilution into the autosampler vial**, one row per vial.

(Steps 2b and 3a are Task 8. The promote control is Task 9. Until Task 8 lands, a blend row
shows in Step 2 and Step 3 as its lead's row, and a two-step row shows a note in Step 3 that its
intermediate is not on the sheet yet.)

**Columns.** Labels, tooltips and decimal places are the source's, taken from the two `app.js`
arrays named above; the inputs map as below. Columns the source marks `mk1`, `paste`, `grip`,
`queue` or `remove` are not ported. A computed cell shows a dash when its value is null.

| Step 2 column | kind | reads or writes |
|---|---|---|
| Sample ID | text | `sample_id` |
| Sample Identity | text | `identity` |
| Declared Peptide Wt (mg) | input | `hplc_prep.declared_mg`, placeholder the sample's `declared_mg`; hint "per capsule" on a capsule row, "vial total" on a blend |
| Form | select | `prep_form`; first option "from the sample (<effective form>)" sends null |
| Declared Liquid Vol (mL) | input, shown only when a row is liquid | `declared_volume_ml` |
| Capsules used | input, shown only when a row is a capsule | `capsules` |
| Instrument | select | the existing item PATCH (`instrument_id`) |
| Diluent | select | `diluent`; first option "by rule (<resolved diluent>)" sends null |
| Wt Customer Sample vial and Septum (mg) | input | `stock_vial_mg` |
| Diluent to add (uL) | input | `diluent_ul`, placeholder `params.sample_diluent_ul`, or the capsule assumption |
| Wt Customer Sample vial and Septum + Diluent (mg) | input | `stock_vial_diluent_mg` |
| Total Diluent added (mL) | computed, 4 dp | `stock.total_diluent_ml` |
| Peptide Stock Conc (ug/mL) | computed, 2 dp | vial 1's `stock_conc_ug_ml` |
| 2-step dilution | select auto / yes / no | `two_step` |

When a row has no instrument and plan 2's `rowInstrument` names one for it, the Instrument
select offers "usually <name>" as its first choice; nothing is written until the tech picks.

A liquid row's two weighing boxes are disabled. A bac row's two weighing boxes carry the
source's hints ("(1) full, as received: weigh first" and "(2) emptied and dried: weigh after").
A row whose `form` is null shows its identity and the note "no HPLC prep for this form" across
the weighing columns.

| Step 3 column | kind | reads or writes (`vials[n]`) |
|---|---|---|
| Sample ID, Vial | text | `sample_id`, the vial letter when the row has more than one |
| Sample Identity | text | the vial's component names |
| Diluent | text, marked when not Water | `diluent.diluent` |
| Diluting from (ug/mL) | computed, 2 dp | `stock_for_final` |
| Target Conc (ug/mL) | input | `target_ug_ml`, placeholder the resolved target |
| Target Total Vol (uL) | input | `target_volume_ul`, placeholder `params.target_volume_ul` |
| Wt Autosampler vial and cap (mg) | input | `vial_mg` |
| Diluent Vol to Add (uL), total and half | computed, 2 dp | `plan.diluent_vol_ul`, `plan.diluent_half_ul` |
| Wt Autosampler vial and cap + Diluent (mg) | input | `vial_diluent_mg` |
| Stock Vol to Add (uL), total and half | computed, 2 dp | `plan.stock_vol_ul`, `plan.stock_half_ul` |
| Wt of Vial, cap, Diluent + Sample (mg) | input | `vial_all_mg` |
| Actual Diluent Volume added (uL) | computed, 2 dp, marked when `off.diluent` | `actual.actual_diluent_ul` |
| Actual Stock Vol added (uL) | computed, 2 dp, marked when `off.stock` | `actual.actual_stock_ul` |
| Actual Total Volume (uL) | computed, 2 dp | `actual.actual_total_ul` |
| Actual Conc (ug/mL) | computed, 2 dp | `actual.actual_conc_ug_ml` |
| Total Dilution Factor | computed, 4 dp | `dilution_factor_total` |

Every input is a number box that commits on blur or Enter, sends one merge patch for the one
key it owns, clears to null (never 0) when emptied, and is read-only when the worksheet is
completed or the row is promoted. Rows on the same instrument as the first row's are plain;
rows on another instrument are shaded, as the source shades its 1290B rows.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders Step 2 and Step 3 with the source labels', ...)
it('shows the worked-out stock concentration and plan from the typed weighings', ...)
it('typing a weighing sends a merge patch for that one key', ...)
it('clearing a box sends null, never 0', ...)
it('a liquid row has its weighing boxes off and its volume box on', ...)
it('the capsule and liquid columns appear only when a row needs them', ...)
it('a backwards weighing shows in the warnings panel with its sample id', ...)
it('a completed worksheet is read-only', ...)
it('a promoted row is read-only', ...)
it('a failed save rolls the cell back and shows the reason', ...)
it('WorksheetPage shows the HPLC page for an all-HPLC worksheet and the endo page otherwise', ...)
it('the drawer opens the HPLC worksheet page', ...)
```

- [ ] **Step 2: Run and see them fail.** `npx vitest run src/components/hplc/prep src/components/hplc/__tests__/WorksheetPage.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those plus `src/components/hplc/endo/__tests__` (unchanged), then
  typecheck, eslint and prettier on the touched files.
- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-ws commit -m "feat(hplc): the HPLC worksheet page with stock preparation and dilution" -- src/lib/api.ts src/services/hplc-worksheet.ts src/components/hplc/WorksheetPage.tsx src/components/hplc/prep src/components/hplc/__tests__/WorksheetPage.test.tsx src/components/layout/MainWindowContent.tsx src/components/hplc/WorksheetDrawer.tsx
```

---

### Task 8: Step 2b, blend components, and Step 3a, the intermediate dilution

**Files:**
- Modify: `src/components/hplc/prep/HplcPrepSheet.tsx`, `src/components/hplc/prep/hplc-sheet-columns.ts`
- Create: `src/components/hplc/prep/HplcBlendTable.tsx`,
  `src/components/hplc/prep/HplcIntermediateTable.tsx`
- Test: `src/components/hplc/prep/__tests__/HplcBlendTable.test.tsx`,
  `src/components/hplc/prep/__tests__/HplcIntermediateTable.test.tsx`

**Read first:** the source's `app.js` lines 273 to 304 (`STEP1B`, the sheet's Step 2b, and
`STEP2A`, its Step 3a) and the section descriptions in `index.html` lines 156 to 174.

**Interfaces:**
- Consumes: `HplcPrepSheet` and the cell primitives (Task 7), `computeRow`'s `components`,
  `vials[n].intermediate` and `floor_ug_ml` (Task 4).
- Produces: the two sections, placed where the source has them (Step 2b after Step 2, Step 3a
  between Step 2b and Step 3), each shown only when a row needs it, and Step 3 now showing one
  row per vial for a blend split across vials.

| Step 2b column | kind | reads or writes |
|---|---|---|
| Sample ID | text, once per sample | `sample_id` |
| Component | text | the component's name |
| Declared Wt (mg) | input | `components[id].mg`, placeholder the sample's own figure |
| Vial | select A to G | `components[id].vial` (A sends the catalog default back as null when it IS the default) |
| Lead | one radio per vial | `vials[n].lead_id`; the resolved lead is shown checked and greyed with its reason (by rule, preferred, heaviest, first) until one is chosen |
| Component Stock Conc (ug/mL) | computed, 2 dp | `components[].stock_conc_ug_ml` |
| Own Target (ug/mL) | input | `components[id].target`, placeholder the rule's |
| Planned Final Conc (ug/mL) | computed, 2 dp | `planned_final_ug_ml` |
| Actual Final Conc (ug/mL) | computed, 2 dp | `actual_final_ug_ml` |

A component whose `below_floor` is true has its Planned Final Conc marked and the tooltip
"under the <floor> ug/mL floor: it can go in its own vial, choose B". It is a warning only:
nothing is disabled. A blend row with a `problems` entry shows it in place of the component
lines. The split's own state shows under the sample id: "split not typed yet", "partly typed",
or "the weights add up to X, the vial says Y" for a mismatch.

| Step 3a column | kind | reads or writes (`vials[n]`) |
|---|---|---|
| Sample ID, Vial, Sample Identity, Diluent | text | as Step 3 |
| Intermediate Target (ug/mL) | input | `int_target_ug_ml`, placeholder `intermediate.target_ug_ml` |
| Intermediate Target Vol (uL) | input | `int_volume_ul`, placeholder `params.intermediate_volume_ul` |
| Wt Intermediate vial and cap (mg) | input | `int_vial_mg` |
| Diluent Vol to Add (uL), total and half | computed | `intermediate.plan` |
| Wt Intermediate vial and cap + Diluent (mg) | input | `int_vial_diluent_mg` |
| Stock Vol to Add (uL), total and half | computed | `intermediate.plan` |
| Wt Intermediate vial, cap, Diluent + Stock (mg) | input | `int_vial_all_mg` |
| Actual Diluent Volume added (uL), Actual Stock Vol added (uL) | computed, marked when off | `intermediate.actual` |
| Actual Intermediate Conc (ug/mL) | computed, 2 dp | `intermediate.actual.actual_conc_ug_ml` |

- [ ] **Step 1: Write the failing tests**

```tsx
it('Step 2b appears only when a row is a blend, Step 3a only when a vial takes two steps', ...)
it('moving a component to vial B gives Step 3 a second row for that sample', ...)
it('choosing a lead sends vials[n].lead_id and re-plans that vial', ...)
it('a component under the floor is marked and nothing is disabled', ...)
it('a split that does not add up says so under the sample id', ...)
it('the intermediate target shows 5000 as its placeholder until one is typed', ...)
it('typing the three intermediate weighings shows the actual intermediate concentration and re-plans Step 3 from it', ...)
```

- [ ] **Step 2: Run and see them fail.** `npx vitest run src/components/hplc/prep`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the folder, typecheck, eslint and prettier on the touched files.
- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-ws commit -m "feat(hplc): blend components and the intermediate dilution on the worksheet" -- src/components/hplc/prep
```

---

### Task 9: Promote on the page

**Files:**
- Modify: `src/components/hplc/prep/HplcPrepSheet.tsx`, `src/components/hplc/prep/HplcWorksheetPage.tsx`,
  `src/services/hplc-worksheet.ts`
- Create: `src/components/hplc/prep/HplcPromoteCell.tsx`
- Create: `src/lib/hplc-promote.ts`
- Test: `src/components/hplc/prep/__tests__/HplcPromoteCell.test.tsx`,
  `src/lib/__tests__/hplc-promote.test.ts`

**Interfaces:**
- Consumes: `promoteHplcRow` (Task 7's api function over Task 6's route), row facts, `computeRow`.
- Produces: `promoteReasons(row, computed, blendCap): string[]` in `src/lib/hplc-promote.ts`, the
  browser's copy of `worksheets_hplc_promote.promote_reasons`, same sentences, so the button can
  say why it is off before anyone presses it (the server stays the authority and its 409
  reasons are shown as returned); `usePromoteHplcRow(id)`; and a last column on the Step 2
  table, "Sample prep":
  - not ready: a disabled Promote button whose tooltip lists the reasons;
  - ready: Promote. Pressing it asks once, in the endo promote's words, because it is final:
    "Promote this row? Its prep becomes final and can only be corrected by a retest.";
  - promoted: the prep's number (for example SP-20261113-0004) as a link that opens Sample
    Preps, and a small "final" badge. The whole row is then read-only.
- The page header counts "N of M promoted".

- [ ] **Step 1: Write the failing tests**

```ts
it('lists every reason a row cannot be promoted, in the server wording', ...)   // table of cases mirroring Task 6's
it('the floor is never a reason', ...)
```
```tsx
it('a row that is not ready shows why on its disabled button', ...)
it('promoting asks once and then shows the prep number as a link', ...)
it('a 409 from the server shows its reasons and leaves the row editable', ...)
it('a promoted row shows its prep and has no button', ...)
```

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/components/hplc/prep src/lib/__tests__/hplc-promote.test.ts`,
  typecheck, eslint and prettier on the touched files.
- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-ws commit -m "feat(hplc): promote a row from the worksheet page" -- src/components/hplc/prep src/services/hplc-worksheet.ts src/lib/hplc-promote.ts src/lib/__tests__/hplc-promote.test.ts
```

---

## After the last task (controller, not an implementer)

- Full backend suite in the stack and full vitest, failure sets diffed against plan 2's head.
- Mount the branch on a devbox stack and work one row of each kind end to end in a browser:
  powder one step, powder two step, liquid, bac, capsule, a blend split across two vials. For
  each: promote, open Sample Preps, Process HPLC with generated peak files, and compare the
  reported quantity with the source sheet's answer for the same weighings.
- Release checklist additions: `backend/scripts/check_hplc_columns.py` now covers
  `hplc_analyses.capsules_used`, the widened `hplc_prep` CHECK, the eight `sample_preps`
  columns and their index, and `worksheet_items.hplc_prep`.
- Not in this plan, each ledgered: rider results and the one-item-per-sample inbox (plan 3b);
  a printed bench sheet and the Excel export; the rule lock's re-apply and history; a settings
  screen for the blend cap; retiring the prep wizard.
