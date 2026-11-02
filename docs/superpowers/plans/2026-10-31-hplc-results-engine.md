# HPLC Results Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `backend/calculations/hplc_processor.py` the real two-step prep and the
per-form stock volume, close the manual calibration-curve pick, and make one active curve
per peptide and instrument an enforced invariant, with no change to any quantity Mk1
reports today.

**Architecture:** The engine is five pure functions plus one orchestrator, with one route
(`POST /hplc/analyze`) and one storage model (`HPLCAnalysis`). Dennis's `calc.js` is the
arithmetic authority: his `stockPrep`, `intermediateStep`, `dilutionActual` and
`dilutionFactorTotal` map onto the engine function for function, and his quantity chain is
structurally identical to Mk1's today (determined concentration, times a dilution factor,
times a stock volume, divided by 1000). So this build is two substitutions plus one branch:
the single re-derived dilution factor becomes the product of the steps, and the stock volume
becomes per-form. On a one-step powder row the product equals the single factor and the
per-form volume equals today's, so output is unchanged by construction. A golden-master
fixture captured from prod proves it, and it is the first thing written.

Nothing in this plan produces a two-step or non-powder prep. The prep wizard cannot make
one. The engine therefore ships inert, which is what makes the sign-off defensible: the
only observable changes are the curve-pick error and the rows that already carry impossible
weighings.

**Tech Stack:** Python 3.11 / FastAPI / SQLAlchemy 2.x (`backend/`), pytest. No frontend
work in this plan.

**Branch:** the implementation branch comes off **`origin/master`**, not off the docs branch
this plan was written on:

```bash
git -C C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1 worktree add C:/tmp/Accu-Mk1-hplc-engine -b feat/hplc-results-engine origin/master
git -C C:/tmp/Accu-Mk1-hplc-engine checkout docs/analysis-catalog-specs -- docs/superpowers/specs/2026-10-29-hplc-prep-worksheet-design.md docs/superpowers/plans/2026-10-31-hplc-results-engine.md
git -C C:/tmp/Accu-Mk1-hplc-engine commit -m "docs: HPLC prep worksheet spec and results-engine plan" -- docs/superpowers/specs/2026-10-29-hplc-prep-worksheet-design.md docs/superpowers/plans/2026-10-31-hplc-results-engine.md
```

The checkout brings the spec and this plan onto the branch at their **latest** versions on
`docs/analysis-catalog-specs`. Do not cherry-pick `0755c740` or `e22830be`: those are the
first drafts, and both have since been amended.

Every Mk1 `file:line` below was re-derived from `origin/master` on 2026-11-02 (`befeb1c3`),
and the `calc.js` lines from `C:/tmp/tools-dennis` on the same day. An earlier pass of this
plan cited `backend/main.py` and `backend/database.py` lines read from the docs branch, which
is 1959 commits behind master (merge base 2026-08-13); those citations were wrong and are
replaced. `backend/calculations/hplc_processor.py` is byte-identical on both trees, so Tasks
1 to 5 read the right engine either way.

**Spec:** `docs/superpowers/specs/2026-10-29-hplc-prep-worksheet-design.md` (committed
`0755c740`, amended 2026-11-02 with the Sample Forms correction to S4). This plan
implements decisions 13, 14, 16's uniqueness invariant, and 18, plus the S4 engine section
and the S9 curve-pick section. Read the spec alongside this plan.

## Global Constraints

- **Additive only.** A failing existing test defaults to "the test is stale", not "the code
  is wrong". This plan contains a production-behaviour change to the HPLC results engine and
  carries the Handler's sign-off as part of the HPLC Prep Worksheet slice.
- **Gate on the failure-set diff, never on zero failures.** Mk1 has a known test baseline
  (`docs/` architecture note: `architecture_mk1_test_baseline_failures`). Record the failure
  set before the first change and compare, do not chase a green board.
- **One pytest suite at a time.** The backend suite hits the host dev Postgres and concurrent
  runs deadlock. From the host use `MK1_DB_HOST=127.0.0.1`; `host.docker.internal` is stale.
- **`_run_migrations` swallows failed ALTERs** (`backend/database.py:342`). Every new column
  and index in this plan gets an explicit post-deploy existence check, named in its task.
- **FastAPI `response_model` silently drops undeclared keys.** Every new response field must
  appear on `HPLCAnalysisResponse` and in `_analysis_to_response`, and must be smoked on the
  deployed route, not the local one.
- **Prod is read-only here, and only after lab hours.** The 2026-09-21 `pg_dump` dropped Mk1
  DB connections mid-shift. Never `SELECT hplc_analyses.raw_data` or `chromatogram_data`:
  that column is 7351 MB of TOAST on a `db-s-1vcpu-2gb` instance. Scalars plus
  `calculation_trace` only.
- **Secrets from the vault, never literals.** `PG_PASSWORD` via
  `. C:\Users\forre\.accumark\Use-AccumarkSecrets.ps1`. Nothing credential-shaped enters a
  file in this repo.
- **Dennis's repo stays at `C:/tmp/tools-dennis`.** It carries real lab data and Accu-Mk1
  sits in OneDrive. When porting his cases, take the numbers and scrub sample identities,
  client names and lot numbers. Never edit or test against
  `hplc-peptide-quant-data.json`.
- **Exact values, copied from the spec's S2 block**, as engine defaults in this plan (the
  `run_parameters` method block arrives in the worksheet plan):
  `intermediate_target_ug_ml 1500`, `intermediate_volume_ul 1500`,
  `two_step_threshold_mg 500`, `bac_stock_ug_ml 9000`, `diluent_density_mg_ml 997.1`,
  `benzyl_alcohol_density 1034.72`.
- **Task 5 MUST land before Task 6. This is not a preference.** Task 3 adds
  `dilution_factor_total` but Task 5 is what makes `calculate_quantity` read it, so between
  them a complete two-step row computes a quantity that is too LOW by the intermediate factor,
  roughly 6x. Task 6 is the task that first lets a caller supply an intermediate, so shipping
  Task 6 ahead of Task 5 would put a silently wrong quantity on a certificate. That is the
  exact failure mode that already put wrong quantities on four published COAs. The branch is
  safe in the interim only because no route can set an intermediate until Task 6.
- **No em dashes in any file this plan creates**, including comments and docstrings.
- New files written on this machine get `sed -i 's/\r$//'` before `git add`: both the Bash
  heredoc and the Write tool emit CRLF here. Commit with `git commit -- <paths>`.

## Review Focus

Five inputs the spec implies, that reach this engine today, and that no task above would
otherwise exercise. Each line's test is added to the task that owns the code.

1. **`calibration_curves.diluent_density` is NULL.** The column is nullable; the route passes
   `cal.diluent_density` straight into the engine, which divides by it. A NULL gives a
   `TypeError` and a 500 instead of a reason. Owned by Task 4.
2. **`calibration_curves.rt_tolerance` is NULL.** Same shape: `calculate_identity` evaluates
   `delta <= peptide.rt_tolerance` and raises. Owned by Task 6.
3. **The picked curve's own `instrument_id` is NULL while the run names an instrument.** Prod
   has none today, but the column is nullable and a new curve can be filed without one, so
   the new gate meets it eventually. Fail closed, with a reason saying the curve has no
   instrument. Owned by Task 7.
4. **A liquid-form row with no declared volume.** The stock volume is the declared volume, so
   a blank or zero gives a null quantity with nothing a tech can read. Owned by Task 4.
5. **A two-step row whose intermediate stock volume is zero.** The intermediate leg divides
   by it. Dennis's asymmetric thresholds cover it only if copied exactly (stock `<= 0` is a
   problem, diluent `< 0` is a problem, zero diluent is a legal neat injection). Owned by
   Task 3.

---

## Blocking questions (Handler, before the task that names them)

- **Task 9 is gated on a data fix the Handler is making:** peptide 38 on instrument 2 holds
  two active calibration curves on prod, and which one stays active is the lab's call. The
  implementer must not pick. Task 9 Step 1 is now that gate, run against prod, and it aborts
  that task rather than asking. **Task 9 is last and nothing depends on it**, so an abort
  there leaves Tasks 1 to 8 shippable: `_run_migrations` swallows a failed `CREATE UNIQUE INDEX`, so
  shipping ahead of the fix leaves prod with no constraint while every local test passes.
- **Capsule is deferred, and its prep kind has a home now.** The spec's S4 table records
  capsule quantity as unresolved ("unstated whether quantity is per capsule or total") and
  decisions 13 to 20 do not settle it. Decision 14's formula yields total mass, so a COA
  comparing that to a per-capsule declared weight reads roughly N times high. Capsule is
  excluded from Task 4, and the Capsule form row (seeded inactive on prod) keeps
  `hplc_prep` NULL until the ruling, at which point it is one UPDATE plus one widened CHECK,
  not a new design.

---

### Task 1: Pin today's engine with a golden master

Characterization test, not TDD: it must PASS against unchanged code. That is the sign-off's
whole foundation, so it is written and committed before anything is touched.

Do not replay prod's stored `quantity_mg` as the expected value. Those numbers came from
whatever engine and curve existed when the row was written, so some will not reproduce, and
the temptation would then be to loosen the tolerance. The capture script runs today's engine
on captured inputs and stores ITS output as `expected`; the stored prod value rides along as
an informational field only.

**Files:**
- Create: `backend/scripts/capture_hplc_golden.py`
- Create: `backend/tests/fixtures/hplc_engine_golden.json`
- Create: `backend/tests/test_hplc_processor_golden.py`

**Interfaces:**
- Consumes: `process_hplc_analysis(AnalysisInput) -> dict`, `AnalysisInput`, `WeightInputs`,
  `CalibrationParams`, `PeptideParams` from `backend/calculations/hplc_processor.py`,
  unchanged.
- Produces: the fixture's case shape, which every later task asserts against:
  `{"id": str, "weights": {5 float keys named as WeightInputs' fields},
  "areas": [float], "slope": float, "intercept": float, "diluent_density": float,
  "expected": {"quantity_mg", "dilution_factor", "stock_volume_ml", "purity_percent",
  "concentration_ug_ml"}, "prod_stored_quantity_mg": float|null}`, plus top-level
  `"captured_at"`, `"source"`, `"drifted"` (ids whose `prod_stored_quantity_mg` differs from
  `expected.quantity_mg`) and `"flagged"` (ids whose weighings go backwards, see Task 2).

- [ ] **Step 1: Write `backend/scripts/capture_hplc_golden.py`**

A standalone script (not a test, not imported by the app) that writes the fixture JSON to
stdout and its counts to stderr, so it can be piped into the prod container over stdin
(Step 2). It takes no arguments and no credentials: it uses
`from database import SessionLocal`, the container's own engine. `LIMIT` is a module constant
set to 200.

It executes ONE read-only query selecting only: `id`, `sample_id_label`, the five weighing
columns, `quantity_mg`, `calibration_curve_id`, and `calculation_trace`. **It must not name
`raw_data` or `chromatogram_data` in the select list**, and must not `select(HPLCAnalysis)`
whole, because the ORM would fetch both and that is 7351 MB of TOAST on a one-vCPU instance.
Rows are the `LIMIT` most recent with a non-null `calculation_trace`, plus every row whose
weighings go backwards by the Task 2 rules (so the expected-change set is complete rather
than sampled).

Per row it pulls `individual_areas`, `calibration_slope` and `calibration_intercept` from
`calculation_trace["quantity"]`, and `diluent_density` from the curve (falling back to
997.1 when NULL), builds a synthetic one-injection-per-area `injections` list
(`[{"peaks": [{"area": a, "area_percent": p, "retention_time": rt}], "main_peak_index": 0}]`
with the trace's own purity and RT values where present), calls today's
`process_hplc_analysis`, and writes the result as `expected`. Rows missing any of the four
inputs are skipped and counted in the output, not silently dropped.

- [ ] **Step 2: Run the capture against prod, read only, after lab hours**

Prod `accumark_mk1` is reachable ONLY from the droplet, through the backend container's own
SQLAlchemy engine. So the script imports `from database import SessionLocal` and is piped in
over stdin, the house idiom:

```bash
ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python' < backend/scripts/capture_hplc_golden.py > /tmp/hplc_engine_golden.json
```

It therefore takes no DB credentials of its own and reads none. Use the Tailscale IP, never
the bare `165.227.241.81` (firewalled since 2026-09-08). A `Permission denied` on the 100.x
address means a local VPN client is on, not a ban. In auto permission mode the classifier may
refuse this as a production read; ask the Handler to allow it rather than routing around it.

Expected: a fixture with 150 or more cases, a non-empty `source` string, and the skipped
count printed to stderr. Move the JSON to
`backend/tests/fixtures/hplc_engine_golden.json`, run `sed -i 's/\r$//'` on it, and record
the counts in the commit message.

- [ ] **Step 3: Write the pin test**

```python
GOLDEN = json.loads((FIXTURES / "hplc_engine_golden.json").read_text())

@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["id"])
def test_engine_reproduces_captured_output(case):
    result = process_hplc_analysis(_input_from(case))
    for key in ("quantity_mg", "dilution_factor", "stock_volume_ml",
                "purity_percent", "concentration_ug_ml"):
        assert result[key] == case["expected"][key]

def test_golden_fixture_is_not_empty():
    assert len(GOLDEN["cases"]) >= 150
```

`_input_from(case)` is a module-level helper building `AnalysisInput` from the case dict.
Assert exact equality; no `pytest.approx`, no tolerance.

- [ ] **Step 4: Run the pin against UNCHANGED engine code**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_processor_golden.py -v`
Expected: PASS, every case. A failure here means the capture is wrong, not the engine.

- [ ] **Step 5: Record the test baseline**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests -q 2>&1 | tail -30`
Save the failure set to the task's commit message. Every later task compares against it.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/capture_hplc_golden.py backend/tests/fixtures/hplc_engine_golden.json backend/tests/test_hplc_processor_golden.py
git commit -- backend/scripts/capture_hplc_golden.py backend/tests/fixtures/hplc_engine_golden.json backend/tests/test_hplc_processor_golden.py -m "test: pin the HPLC engine against captured prod inputs"
```

---

### Task 2: Flag weighings that run backwards, by role

Decision 14: a weighing lower than the one before it is flagged, never computed from. The
check is by ROLE, not by time order: `calc.js` has no sequence concept. Copy Dennis's
thresholds exactly, including the asymmetry, because zero added diluent is a legal neat
injection while zero added stock is not.

**Files:**
- Modify: `backend/calculations/hplc_processor.py` (`calculate_dilution_factor`, currently
  lines 54 to 93)
- Modify: `backend/tests/test_hplc_processor_golden.py` (add the flagged-row assertions)
- Test: `backend/tests/test_hplc_processor_engine.py` (create)

**Interfaces:**
- Consumes: Task 1's fixture shape.
- Produces: `calculate_dilution_factor` keeps its signature
  `(weights: WeightInputs, density: float) -> dict` and its existing keys, and gains
  `"problem": Optional[str]` with the values `"stock_diluent"`, `"diluent"`, `"stock"` or
  `None`. When `problem` is not None, `dilution_factor` and `stock_volume_ml` are `None`
  rather than a number. Later tasks read `problem` to short-circuit.
- **`stock_diluent` is computed inline and unconditionally in this task, and Task 4 relocates
  it.** There is one prep form at this point and it is the default, so unconditional is
  correct here. Task 4 introduces `form` and moves the stock-leg determination into
  `stock_volume_ml`, where a `liquid` form must NOT raise it (its stock vial is never weighed,
  so its stock leg is zero, and its volume is the declared one). Keep the stock-leg test in
  one place and do not spread the threshold across helpers, so that relocation stays a move
  rather than a rewrite. The two dilution-leg problems stay in `calculate_dilution_factor` for
  good: every form has a final dilution vial.

- [ ] **Step 1: Write the failing tests**

```python
def test_forward_weighings_have_no_problem():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1)
    assert d["problem"] is None

def test_stock_vial_lighter_than_empty_is_flagged():
    w = replace(FORWARD_WEIGHTS, stock_vial_with_diluent=FORWARD_WEIGHTS.stock_vial_empty - 5)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None

def test_negative_added_diluent_is_flagged():
    w = replace(FORWARD_WEIGHTS, dil_vial_with_diluent=FORWARD_WEIGHTS.dil_vial_empty - 1)
    assert calculate_dilution_factor(w, 997.1)["problem"] == "diluent"

def test_zero_added_diluent_is_legal():
    w = replace(FORWARD_WEIGHTS, dil_vial_with_diluent=FORWARD_WEIGHTS.dil_vial_empty)
    assert calculate_dilution_factor(w, 997.1)["problem"] is None

def test_zero_added_stock_is_flagged():
    w = replace(FORWARD_WEIGHTS, dil_vial_with_diluent_and_sample=FORWARD_WEIGHTS.dil_vial_with_diluent)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] == "stock"
    assert d["dilution_factor"] is None
```

`FORWARD_WEIGHTS` is a module-level `WeightInputs` taken from any case in Task 1's fixture.

- [ ] **Step 2: Run to verify they fail**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_processor_engine.py -v`
Expected: FAIL with `KeyError: 'problem'`.

- [ ] **Step 3: Add the role checks to `calculate_dilution_factor`**

Thresholds, from `calc.js:204` (`stockPrep`) and `calc.js:337` (`dilutionActual`): the
stock leg is a problem when `stock_vial_with_diluent - stock_vial_empty <= 0`; the dilution
leg is a problem when the added diluent mass is `< 0`, or the added stock mass is `<= 0`.
Keep every existing key and every existing rounding call; only `dilution_factor` and
`stock_volume_ml` become `None` under a problem.

- [ ] **Step 4: Run both suites**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_processor_engine.py backend/tests/test_hplc_processor_golden.py -v`
Expected: the new tests PASS. The golden cases listed in the fixture's `flagged` array now
FAIL, because today they produce a garbage number and the new code produces `None`. That is
the intended behaviour change.

- [ ] **Step 5: Move the flagged rows to an expected-change assertion**

In `test_hplc_processor_golden.py`, skip `flagged` ids in the main parametrize and add:

```python
@pytest.mark.parametrize("case_id", GOLDEN["flagged"])
def test_rows_with_impossible_weighings_now_refuse(case_id):
    case = _case(case_id)
    result = process_hplc_analysis(_input_from(case))
    assert result["quantity_mg"] is None
    assert case["expected"]["quantity_mg"] is not None   # it used to produce a number
```

Run both files again. Expected: PASS. The count of flagged ids goes in the commit message
and into the sign-off, because every one is a prod row whose reported quantity changes.

- [ ] **Step 6: Commit**

```bash
git add backend/calculations/hplc_processor.py backend/tests/test_hplc_processor_engine.py backend/tests/test_hplc_processor_golden.py
git commit -- backend/calculations/hplc_processor.py backend/tests/test_hplc_processor_engine.py backend/tests/test_hplc_processor_golden.py -m "feat: flag HPLC weighings that run backwards instead of computing from them"
```

---

### Task 3: The intermediate step and the total dilution factor

**Files:**
- Modify: `backend/calculations/hplc_processor.py`
- Test: `backend/tests/test_hplc_processor_engine.py`

**Interfaces:**
- Consumes: `calculate_dilution_factor`'s `problem` key (Task 2).
- Produces:
  - `@dataclass IntermediateWeights` with `int_vial_empty: Optional[float]`,
    `int_vial_with_diluent: Optional[float]`,
    `int_vial_with_diluent_and_sample: Optional[float]`. All three are `Optional` because a
    partly weighed intermediate is a real state the engine must refuse rather than crash on.
  - `calculate_intermediate(weights: IntermediateWeights, stock_conc_ug_ml: Optional[float], density: Optional[float]) -> dict`
    returning `{"diluent_vol_ul", "stock_vol_ul", "total_vol_ul", "actual_conc_ug_ml",
    "dilution_factor", "problem"}`, mirroring `dilutionActual` (`calc.js:321`) exactly,
    same asymmetric thresholds as Task 2.
  - `AnalysisInput` gains `intermediate: Optional[IntermediateWeights] = None`.
  - `calculate_dilution_factor`'s returned dict gains `"dilution_factor_total"` and
    `"intermediate"`. With no intermediate it equals `dilution_factor` and `None`; with one
    it is the product of the two legs (`calc.js:1832`).

Dennis's `concForFinal` falls back to the planned target when the intermediate is unweighed.
That is for bench display before the balance. **The engine does not do it:** a row declaring
an intermediate with incomplete weighings returns `dilution_factor_total: None` and a
`problem` of `"intermediate_unweighed"`.

- [ ] **Step 1: Write the failing tests**

```python
def test_no_intermediate_leaves_total_equal_to_the_single_factor():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1)
    assert d["dilution_factor_total"] == d["dilution_factor"]

def test_total_is_the_product_of_the_two_legs():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1, intermediate=INT_WEIGHTS)
    expected = round(d["intermediate"]["dilution_factor"] * d["dilution_factor"], 6)
    assert d["dilution_factor_total"] == expected

def test_intermediate_with_zero_added_stock_is_flagged():
    iw = replace(INT_WEIGHTS, int_vial_with_diluent_and_sample=INT_WEIGHTS.int_vial_with_diluent)
    i = calculate_intermediate(iw, 9000.0, 997.1)
    assert i["problem"] == "stock"
    assert i["dilution_factor"] is None

def test_declared_intermediate_with_missing_weighings_does_not_compute():
    iw = replace(INT_WEIGHTS, int_vial_with_diluent_and_sample=None)
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1, intermediate=iw)
    assert d["dilution_factor_total"] is None
    assert d["problem"] == "intermediate_unweighed"
```

- [ ] **Step 2: Run to verify they fail**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_processor_engine.py -v`
Expected: FAIL, `TypeError: calculate_dilution_factor() got an unexpected keyword argument 'intermediate'`.

- [ ] **Step 3: Implement `IntermediateWeights`, `calculate_intermediate`, and the `intermediate` keyword on `calculate_dilution_factor`**

Round `dilution_factor_total` to 6 places, matching the existing `dilution_factor` rounding.
`calculate_intermediate`'s own rounding mirrors `calculate_dilution_factor`'s, place for
place, so the two legs are commensurate.

- [ ] **Step 4: Run both suites**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_processor_engine.py backend/tests/test_hplc_processor_golden.py -v`
Expected: PASS, golden included and unchanged (every golden case is one-step, so
`dilution_factor_total == dilution_factor`).

- [ ] **Step 5: Commit**

```bash
git add backend/calculations/hplc_processor.py backend/tests/test_hplc_processor_engine.py
git commit -- backend/calculations/hplc_processor.py backend/tests/test_hplc_processor_engine.py -m "feat: HPLC intermediate dilution step and total dilution factor"
```

---

### Task 4: Per-form stock volume

**Files:**
- Modify: `backend/calculations/hplc_processor.py`
- Test: `backend/tests/test_hplc_processor_engine.py`

**Interfaces:**
- Produces:
  - Module constants `DILUENT_DENSITY_MG_ML = 997.1`, `BENZYL_ALCOHOL_DENSITY = 1034.72`,
    `BAC_STOCK_UG_ML = 9000.0`.
  - `bac_volume_ml(mass_mg: Optional[float], water_density: Optional[float] = DILUENT_DENSITY_MG_ML, ba_density: float = BENZYL_ALCOHOL_DENSITY, bac_stock_ug_ml: float = BAC_STOCK_UG_ML) -> Optional[float]`
  - `stock_volume_ml(form: str, weights: WeightInputs, density: Optional[float], *, declared_volume_ml: Optional[float] = None, ba_density: float = BENZYL_ALCOHOL_DENSITY, bac_stock_ug_ml: float = BAC_STOCK_UG_ML) -> tuple[Optional[float], Optional[str]]`
    returning `(volume_ml, problem)`.
  - **This function takes over Task 2's `stock_diluent` problem and scopes it by form.** Move
    the threshold here; do not leave a second copy in `calculate_dilution_factor`. `powder`
    and `bac` both weigh a stock vial, so both still raise `stock_diluent` when
    `stock_vial_with_diluent - stock_vial_empty <= 0`. **`liquid` must not raise it**: its
    stock vial is never weighed, so its stock leg is zero on every real row, and its volume is
    the declared one. This mirrors `calc.js:204`, where the stock-leg problem is guarded by
    `!preDissolved`. `calculate_dilution_factor` then combines its own two dilution-leg
    problems with whatever this function returns. Without the scoping, every liquid row is
    flagged and the declared volume is never read, which no unit test in this task would catch
    because they all pass forward weights.
  - **A stock-only problem must stop nulling the dilution factor** (Task 2's review, Minor 2).
    Task 2 carries one `problem` value and wraps both `dilution_factor` and `stock_volume_ml`
    in `None if problem else ...`, so a row whose dilution legs are fine loses a perfectly
    good factor. Two of the five flagged production rows are exactly that: a diluent leg of
    `0.0` and a sample leg of `1500.0`, giving a legitimate dilution factor of `1.0` for a
    neat injection, with only the stock leg unentered. Once the stock-leg test lives in
    `stock_volume_ml`, keep the two decisions separate: a stock problem nulls
    `stock_volume_ml` only, a dilution-leg problem nulls `dilution_factor` only, and
    `quantity_mg` is None whenever either is. `problem` keeps reporting the first code by the
    precedence Task 2 pinned. This narrows the sign-off again, so **the sign-off text is
    written from the end of this plan, never from Task 2's commits.**
  - **The separation is three-way, not two-way, and Task 3's tests pin the old behaviour**
    (found by Task 3's review). Task 3 added an intermediate leg, so there are three places a
    weighing can fail and each nulls only what it actually touches:

    | problem | nulled | kept |
    |---|---|---|
    | stock leg | `stock_volume_ml` | `dilution_factor`, and the total if the legs allow |
    | final dilution leg | `dilution_factor`, so also `dilution_factor_total` | `stock_volume_ml` |
    | intermediate leg | `dilution_factor_total` only | `dilution_factor`, `stock_volume_ml` |

    `quantity_mg` is None whenever `dilution_factor_total` or `stock_volume_ml` is None.
    `problem` keeps reporting the first code by Task 2's and Task 3's pinned precedence.

    An intermediate-only problem is the case the plan had never decided: the final vial's
    weighings are fine, so nulling its factor and stock volume throws away two good numbers.
    Task 3 pinned today's wider behaviour at
    `backend/tests/test_hplc_processor_engine.py:297` and `:314`. **Those two assertions are
    stale by design once this task lands**, which is the additive-only doctrine's "a failing
    test defaults to the test being stale" working as intended: update them deliberately and
    say so in the commit message, rather than meeting them as a surprise.
  - **Close the final vial's non-finite hole while you are here** (Task 3's review, Minor 1).
    Task 3 added a finiteness check to the intermediate leg only. The final vial's legs still
    accept NaN or infinity and produce a non-finite factor with `problem: None`, which then
    passes an `is not None` check into `calculate_quantity`. Dennis's `num()` rejects
    non-finite input, so this is a divergence from the authority rather than a design choice.
    Task 6 also rejects non-finite floats at the request boundary; both belong, because the
    engine is reachable from the worksheet path too.
  - `calculate_dilution_factor`'s `density` parameter widens from `float` to
    `Optional[float]`, which is what the `no_density` guard below requires. Task 2's and
    Task 3's narrower annotation is superseded here.
  - `PREP_FORMS = ("powder", "liquid", "bac")`, the same three values the endo bench
    already accepts as `ENDO_FORMS` (`backend/worksheets_endo.py:28`, verified). An
    unrecognised form raises `ValueError` naming the accepted list, the way
    `check_item_endo_fields` already does at `:429`. Do NOT import the tuple either
    direction: `worksheets_endo` imports `models` and the catalog, and the engine is the
    lower layer. The drift is pinned by a test instead (Step 1), asserting
    `set(ENDO_FORMS) <= set(PREP_FORMS)`, which is the invariant that matters and the one
    that survives capsule being added to the engine alone.
  - **`bac` is a prep kind, not a dosage form, and this plan does not derive it.** The
    caller states it. Mk1 already owns the derivation for endo, in
    `worksheets_endo_promote._sample_is_bac` (`:216`: a `BW-` sample id, or a sample type or
    identity matching `_BAC_WORDS`) and `worksheets_endo.form_is_bac` (`:409`: the row's own
    form wins, else the sample's rule). The worksheet plan reuses both. Nothing here
    re-implements that regex.
  - Capsule is deliberately absent, see the blocking questions.
  - `calculate_dilution_factor` gains `form: str = "powder"` and
    `declared_volume_ml: Optional[float] = None` keywords, and routes its `stock_volume_ml`
    through the new function. The default keeps today's behaviour exactly.

**Why a density test lives here and not in the golden master:** every one of the 66
calibration curves on prod carries `diluent_density` 997.1 (checked 2026-11-02), so the Task 1
fixture has no density variation to pin and cannot acquire any without fabricating cases. This
task's handwritten tests are the right place for synthetic variation, and
`test_stock_volume_tracks_the_density_it_is_given` is what catches a hardcoded constant.

The bac algorithm, which the signature does not determine (`calc.js:262`, benzyl alcohol at
0.9 percent):

```
c   = bac_stock_ug_ml / 1000          # mg/mL
vol = (mass_mg / water_density) / (1 - c / ba_density + c / water_density)
```

**Correction, 2026-11-02: the volume comes out SMALLER, not larger.** An earlier pass of this
plan asserted the opposite in the test above and called the correction "upward" here, and both
were wrong. The denominator is `1 - 9/1034.72 + 9/997.1 = 1.00032817`, which is greater than 1,
so dividing by it reduces the volume: 29913 mg gives 29.9902 mL against a naive 30.0000, and
9293.38 mg gives 9.3174 against 9.3204, both matching `calc.js` and its own comment. The
physical reason is that benzyl alcohol at 1034.72 mg/mL is denser than water at 997.1, so the
mixture is denser and a given mass takes up less room. The formula was always right; only the
assertion about it was inverted, which a green suite would have turned into the expected
behaviour.

The function returns `None` when `mass_mg <= 0` or either density is non-positive. The mass is the same
`stock_vial_with_diluent - stock_vial_empty` difference as powder, which is how the form's
legitimately reversed weighing order stays a configuration question rather than a sequence
one.

- [ ] **Step 1: Write the failing tests**

```python
def test_the_engine_understands_every_form_the_endo_bench_accepts():
    from worksheets_endo import ENDO_FORMS
    assert set(ENDO_FORMS) <= set(PREP_FORMS)

def test_powder_stock_volume_is_todays_formula():
    vol, problem = stock_volume_ml("powder", FORWARD_WEIGHTS, 997.1)
    assert problem is None
    assert vol == (FORWARD_WEIGHTS.stock_vial_with_diluent - FORWARD_WEIGHTS.stock_vial_empty) / 997.1

def test_stock_volume_tracks_the_density_it_is_given():
    # The golden master cannot cover this: all 66 prod curves are 997.1, so an
    # engine that hardcoded that constant would pass the test above and the pin.
    mass = FORWARD_WEIGHTS.stock_vial_with_diluent - FORWARD_WEIGHTS.stock_vial_empty
    assert stock_volume_ml("powder", FORWARD_WEIGHTS, 500.0)[0] == mass / 500.0
    assert (stock_volume_ml("powder", FORWARD_WEIGHTS, 500.0)[0]
            != stock_volume_ml("powder", FORWARD_WEIGHTS, 997.1)[0])

def test_liquid_stock_volume_is_the_declared_volume():
    vol, problem = stock_volume_ml("liquid", FORWARD_WEIGHTS, 997.1, declared_volume_ml=3.0)
    assert (vol, problem) == (3.0, None)

def test_liquid_without_a_declared_volume_says_why():
    assert stock_volume_ml("liquid", FORWARD_WEIGHTS, 997.1)[1] == "no_declared_volume"
    assert stock_volume_ml("liquid", FORWARD_WEIGHTS, 997.1, declared_volume_ml=0)[1] == "no_declared_volume"

def test_bac_volume_is_density_corrected_for_benzyl_alcohol():
    # Benzyl alcohol (1034.72) is DENSER than the water (997.1), so the mixture is
    # denser and a given mass occupies slightly LESS volume. 29913 mg: 29.9902 mL
    # against a naive 30.0000. Values from calc.js:262, which agrees to the digit.
    assert bac_volume_ml(29_913.0) == pytest.approx(30.0, abs=0.05)
    assert bac_volume_ml(29_913.0) < 29_913.0 / 997.1

def test_bac_rejects_a_non_positive_mass():
    assert bac_volume_ml(0) is None

def test_an_unknown_form_names_the_accepted_list():
    with pytest.raises(ValueError, match="powder"):
        stock_volume_ml("capsule", FORWARD_WEIGHTS, 997.1)

def test_a_null_diluent_density_says_why_instead_of_raising():
    assert stock_volume_ml("powder", FORWARD_WEIGHTS, None)[1] == "no_density"

def test_an_unweighed_stock_vial_is_flagged_for_powder_but_not_for_liquid():
    # A liquid row never weighs its stock vial, so its stock leg is zero on
    # every real row. Powder keeps Task 2's behaviour.
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=0.0, stock_vial_with_diluent=0.0)
    assert stock_volume_ml("powder", w, 997.1)[1] == "stock_diluent"
    assert stock_volume_ml("bac", w, 997.1)[1] == "stock_diluent"
    assert stock_volume_ml("liquid", w, 997.1, declared_volume_ml=3.0) == (3.0, None)

def test_a_stock_only_problem_keeps_a_computable_dilution_factor():
    # The two prod rows behind Task 2's review Minor 2: dilution legs fine, stock
    # leg unentered. The factor is a real 1.0 and only the stock volume is unknown.
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=0.0, stock_vial_with_diluent=0.0,
                dil_vial_with_diluent=FORWARD_WEIGHTS.dil_vial_empty)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] == "stock_diluent"
    assert d["stock_volume_ml"] is None
    assert d["dilution_factor"] is not None

def test_a_dilution_leg_problem_keeps_a_computable_stock_volume():
    w = replace(FORWARD_WEIGHTS, dil_vial_with_diluent=FORWARD_WEIGHTS.dil_vial_empty - 1)
    d = calculate_dilution_factor(w, 997.1)
    assert d["problem"] == "diluent"
    assert d["dilution_factor"] is None
    assert d["stock_volume_ml"] is not None

def test_calculate_dilution_factor_reaches_the_declared_volume_for_a_liquid_row():
    # The integration path: the whole point of scoping stock_diluent by form.
    w = replace(FORWARD_WEIGHTS, stock_vial_empty=0.0, stock_vial_with_diluent=0.0)
    d = calculate_dilution_factor(w, 997.1, form="liquid", declared_volume_ml=3.0)
    assert d["problem"] is None
    assert d["stock_volume_ml"] == 3.0
    assert d["dilution_factor"] is not None
```

- [ ] **Step 2: Run to verify they fail**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_processor_engine.py -v`
Expected: FAIL with `ImportError` on `stock_volume_ml`.

- [ ] **Step 3: Implement the constants, `bac_volume_ml`, `stock_volume_ml`, and the two new keywords**

The `no_density` guard is Review Focus 1: `calculate_dilution_factor` must also stop dividing
by a `None` density in its two dilution legs, returning the `no_density` problem rather than
raising, because the route passes `cal.diluent_density` straight through and the column is
nullable.

- [ ] **Step 4: Run both suites**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_processor_engine.py backend/tests/test_hplc_processor_golden.py -v`
Expected: PASS, golden unchanged (every golden case is `form="powder"` with a real density).

- [ ] **Step 5: Commit**

```bash
git add backend/calculations/hplc_processor.py backend/tests/test_hplc_processor_engine.py
git commit -- backend/calculations/hplc_processor.py backend/tests/test_hplc_processor_engine.py -m "feat: per-form HPLC stock volume (powder, liquid, bacteriostatic water)"
```

---

### Task 5: Quantity reads the total factor, with the rounding order preserved

**Files:**
- Modify: `backend/calculations/hplc_processor.py` (`calculate_quantity` 134 to 188,
  `process_hplc_analysis` 252 to 289)
- Test: `backend/tests/test_hplc_processor_engine.py`

**Interfaces:**
- Produces: `calculate_quantity(injections, calibration, dilution)` keeps its signature and
  every returned key, and reads `dilution["dilution_factor_total"]` where it reads
  `dilution["dilution_factor"]` today. Its returned `"dilution_factor"` key carries the
  TOTAL, which is the value `calc.js:3354` sends to Mk1 ("stock to final vial, both steps if
  two"). It gains `"dilution_factor_steps": {"intermediate": float|None, "final": float}`.
  When `dilution["problem"]` is set it returns `quantity_mg: None` and `error: <problem>`
  **while keeping the quantity section's inputs and its concentration**:
  `individual_areas`, `avg_main_peak_area`, `calibration_slope`,
  `calibration_intercept` and `concentration_ug_ml` all stay. Only the values that
  genuinely cannot be computed without a dilution factor or a stock volume are
  omitted (`undiluted_concentration_ug_ml`, `mass_ug`, and the `dilution_factor`
  and `stock_volume_ml` echoes). Task 2 already shipped this shape; do not
  reintroduce the collapse.
  `process_hplc_analysis`'s returned `"dilution_factor"` is likewise the total.
  **Block the quantity on `dilution_factor_total` and `stock_volume_ml`, never on
  `dilution_factor`** (Task 3's review). After Task 4 an intermediate-only problem leaves a
  perfectly good final-step `dilution_factor` in place while the total is None, so a guard
  written against the final factor would compute a quantity from one step of a two-step prep:
  the same roughly 6x understatement that the Task 5 before Task 6 constraint exists to
  prevent.

  **Why the collapse is wrong, since an earlier pass of this plan asked for it.** A
  two-key `{"quantity_mg": None, "error": ...}` quantity section is self-defeating
  three ways. `backend/scripts/capture_hplc_golden.py`'s `build_case` rebuilds engine
  inputs by reading `individual_areas`, `calibration_slope` and
  `calibration_intercept` out of `trace["quantity"]`, so a future golden recapture
  would skip every flagged row as `no_individual_areas` and the fixture would lose
  exactly the cases that prove this slice's behaviour change. `isQuantityTrace`
  (`src/components/hplc/CalculationVisuals.tsx:79`) requires `calibration_slope` and
  `avg_main_peak_area`, so the whole quantity panel would vanish with no explanation
  instead of showing the measured concentration beside the reason the mass could not
  be determined. And the concentration does not depend on the weighings at all: it is
  `(avg_area - intercept) / slope`, and `calc.js`'s `sampleResult` keeps
  `determinedConc` while nulling only `determinedStock`.

**The rounding order is load-bearing and must not be tidied.** Today's chain multiplies a
`dilution_factor` already rounded to 6 places by a `stock_volume_ml` already rounded to 6
places. Multiplying unrounded values instead moves some quantities in the fourth decimal and
breaks the pin. Round each factor to 6 places first, then multiply.

- [ ] **Step 1: Write the failing tests**

```python
def test_quantity_uses_the_total_factor_on_a_two_step_row():
    d = calculate_dilution_factor(FORWARD_WEIGHTS, 997.1, intermediate=INT_WEIGHTS)
    q = calculate_quantity(INJECTIONS, CAL, d)
    assert q["dilution_factor"] == d["dilution_factor_total"]
    assert q["dilution_factor_steps"]["intermediate"] == d["intermediate"]["dilution_factor"]

def test_two_step_quantity_is_the_one_step_quantity_times_the_intermediate_factor():
    one = calculate_quantity(INJECTIONS, CAL, calculate_dilution_factor(FORWARD_WEIGHTS, 997.1))
    two = calculate_quantity(INJECTIONS, CAL, calculate_dilution_factor(FORWARD_WEIGHTS, 997.1, intermediate=INT_WEIGHTS))
    factor = calculate_intermediate(INT_WEIGHTS, 9000.0, 997.1)["dilution_factor"]
    assert two["quantity_mg"] == pytest.approx(one["quantity_mg"] * factor, rel=1e-6)

def test_a_flagged_dilution_refuses_to_report_a_quantity():
    w = replace(FORWARD_WEIGHTS, dil_vial_with_diluent_and_sample=FORWARD_WEIGHTS.dil_vial_with_diluent)
    q = calculate_quantity(INJECTIONS, CAL, calculate_dilution_factor(w, 997.1))
    assert q["quantity_mg"] is None
    assert q["error"] == "stock"
```

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL with `KeyError: 'dilution_factor_steps'`.

- [ ] **Step 3: Rewire `calculate_quantity` and `process_hplc_analysis` onto the total**

- [ ] **Step 4: Run the whole engine and pin suite**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_processor_engine.py backend/tests/test_hplc_processor_golden.py -v`
Expected: PASS. **This is the step the sign-off rests on:** every golden case is one-step, so
its total factor equals its single factor and its quantity is bit-identical to what prod
reports today. A single golden failure here stops the task.

- [ ] **Step 5: Port Dennis's two-step expectation as an independent check**

From `C:/tmp/tools-dennis/tools/hplc-peptide-quant/expected_output` and `sample_input`, take
one two-step case's numbers into `backend/tests/fixtures/hplc_dennis_cases.json`, scrubbing
sample identities, client names and lot numbers (numbers only). Assert the engine's
`dilution_factor_total` and quantity match his, so "Mk1 agrees with Dennis" is a test rather
than an opinion.

- [ ] **Step 6: Run the full backend suite and diff the failure set**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests -q 2>&1 | tail -30`
Expected: the failure set recorded in Task 1 Step 5, with nothing added.

- [ ] **Step 7: Commit**

```bash
git add backend/calculations/hplc_processor.py backend/tests/test_hplc_processor_engine.py backend/tests/fixtures/hplc_dennis_cases.json
git commit -- backend/calculations/hplc_processor.py backend/tests/test_hplc_processor_engine.py backend/tests/fixtures/hplc_dennis_cases.json -m "feat: HPLC quantity from the total dilution factor"
```

---

### Task 6: The route and the stored record carry the form and the intermediate

**Files:**
- Modify: `backend/main.py` (`HPLCWeightsInput` 6756, `HPLCAnalyzeRequest` 6765,
  `HPLCAnalysisResponse` 6786, `_analysis_to_response` 6817, the `/hplc/analyze` route 6850
  onward, `WeightInputs(` built at 6939, `process_hplc_analysis` called at 6957)
- Modify: `backend/models.py` (`HPLCAnalysis` 1018)
- Modify: `backend/database.py` (`_run_migrations` 342)
- Test: `backend/tests/test_hplc_analyze_route.py` (create)

**Interfaces:**
- Consumes: Tasks 3 to 5's engine surface.
- Produces:
  - `HPLCWeightsInput` gains three optional floats: `int_vial_empty`,
    `int_vial_with_diluent`, `int_vial_with_diluent_and_sample`. All default `None`.
  - `HPLCAnalyzeRequest` gains `prep_form: str = "powder"` and
    `declared_volume_ml: Optional[float] = None`. **Every addition is optional**, so the two
    existing callers (`SamplePrepHplcFlyout.tsx:1327` and `:1355`, `NewAnalysis.tsx:531`)
    keep working untouched. No frontend change in this plan.
  - **The route does NOT resolve the form from the sample, and that is deliberate.**
    `HPLCAnalyzeRequest` carries `sample_prep_id`, and a prep could be walked to its sample
    and so to `lims_samples.sample_form_id`. Two reasons not to, here: `sample_preps` lives
    in a separate database reached by raw psycopg2 (`backend/mk1_db.py`; the id is a plain
    INTEGER with no FK, `backend/models.py:1056`) and the only link back is the
    `senaite_sample_id` text label, so the hop belongs with the producer; and resolving it
    would stop this plan shipping inert. A Reconstituted Solution sample run through the
    flyout today computes as a powder, and silently changing that is a production-behaviour
    change wider than the sign-off this slice carries. Task 8 puts the prep kind on the form
    entity; the worksheet plan is the first reader.
  - `HPLCAnalysis` gains `prep_form VARCHAR(10)`, `declared_volume_ml DOUBLE PRECISION`,
    `int_vial_empty`, `int_vial_with_diluent`, `int_vial_with_diluent_and_sample`
    (all `DOUBLE PRECISION`, all nullable).
  - `hplc_analyses.dilution_factor` stores the TOTAL factor. Re-verified on
    `origin/master` 2026-11-02: every reader of the stored column is display only
    (`AnalysisResults.tsx:78` `toFixed(2)`, `CalculationVisuals.tsx:290` and `:431`,
    `SamplePrepHplcFlyout.tsx:511` and `:549` debug lines, `api.ts:3588` the type;
    `Step4Results.tsx:141` and `Step5Summary.tsx:283` read the wizard's own calcs, not this
    column), and no backend module outside `main.py` reads it at all. The per-step factors
    live in `calculation_trace.quantity.dilution_factor_steps`.
  - `HPLCAnalysisResponse` and `_analysis_to_response` declare `prep_form` and
    `dilution_factor_steps`. Anything not declared on the model is dropped silently.
  - **A blank weighing must arrive as `None`, never `0`** (Task 3's review, Minor 3). The
    engine treats only `None` as unweighed, so a blank sent as `0.0` is reported as
    `intermediate_stock` or `intermediate_diluent` rather than `intermediate_unweighed`, and
    an unentered **tare** of `0.0` computes with no problem at all. That mirrors Dennis, so it
    is the caller's obligation rather than an engine bug, and this request model is that
    caller.
  - **Reject non-finite floats at the request boundary** (Task 3's review, Minor 1). NaN and
    infinity are not valid JSON, but Python's `json` module accepts both, so a raw API client
    can send either and reach the engine. Validate every weighing field, the five existing
    ones included. This is the trust boundary; the engine's own finiteness checks are defence
    in depth behind it, not a substitute. **Bound the magnitude too**: Task 3's re-review found
    that two finite weighings near 1e308 overflow their difference to infinity, giving a
    `dilution_factor_total` of `inf` that still passes an `is not None` check (`calc.js`
    overflows identically, so this is not a divergence). A balance reading is in milligrams, so
    a generous sanity ceiling costs nothing and closes the overflow class entirely. This is a
    typo guard, not a calibration limit, so keep it well clear of any real reading.
  - **Five new problem codes get UI copy here** (found by Tasks 3 and 4).
    `WEIGHING_PROBLEM_TEXT` in `src/components/hplc/CalculationVisuals.tsx:117` maps only
    `stock_diluent`, `diluent` and `stock`; an unmapped code prints raw. Task 3 added
    `intermediate_unweighed`, `intermediate_diluent` and `intermediate_stock`, and Task 4 added
    `no_density` and `no_declared_volume`. This is the first task where a caller can set an
    intermediate or a prep form, so it is the first task where a tech could see any of them
    raw. Add a sentence for each of the five, in the same voice as the existing three, and
    extend that file's `it.each` problem-code test to cover them. Until this lands no route can
    produce those codes, which is why Tasks 3 and 4 correctly left the copy alone.

- [ ] **Step 1: Write the failing tests**

```python
def test_request_defaults_to_powder_with_no_intermediate():
    r = HPLCAnalyzeRequest(sample_id_label="X", peptide_id=1,
                           weights=HPLCWeightsInput(**FIVE_WEIGHTS), injections=[])
    assert r.prep_form == "powder"
    assert r.weights.int_vial_empty is None

def test_response_model_declares_every_new_field():
    declared = set(HPLCAnalysisResponse.model_fields)
    assert {"prep_form", "dilution_factor_steps"} <= declared

def test_an_unknown_prep_form_is_refused_with_the_accepted_list():
    with pytest.raises(ValueError, match="powder"):
        HPLCAnalyzeRequest(sample_id_label="X", peptide_id=1, prep_form="tablet",
                           weights=HPLCWeightsInput(**FIVE_WEIGHTS), injections=[])

def test_a_null_rt_tolerance_gives_a_reason_not_a_crash():
    result = calculate_identity(INJECTIONS, PeptideParams(reference_rt=10.0, rt_tolerance=None,
                                                          diluent_density=997.1))
    assert result["conforms"] is None
    assert "tolerance" in result["error"]
```

The last test is Review Focus 2 and belongs to `calculate_identity` in
`backend/calculations/hplc_processor.py`: `rt_tolerance` is a nullable column passed straight
through, so the comparison must guard it the way `reference_rt` already is.

- [ ] **Step 2: Run to verify they fail**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_analyze_route.py -v`
Expected: FAIL on the unknown `prep_form` field.

- [ ] **Step 3: Add the schema fields, the model columns, the migration, and the route wiring**

`prep_form` validates against the engine's `PREP_FORMS` (Task 4, the same three values as
`ENDO_FORMS`) with a Pydantic field validator raising a message that names the accepted
list. The route passes `request.prep_form`,
`request.declared_volume_ml` and the intermediate trio (as `IntermediateWeights`, or `None`
when any of the three is missing) into `calculate_dilution_factor`, and persists the five new
columns on the `HPLCAnalysis` row alongside the existing five weighings.

Migration statements go in `_run_migrations`' list in the established
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` form.

- [ ] **Step 4: Run the route and engine suites**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_analyze_route.py backend/tests/test_hplc_processor_engine.py backend/tests/test_hplc_processor_golden.py -v`
Expected: PASS.

- [ ] **Step 5: Verify the columns exist after deploy, and smoke the DEPLOYED route**

`_run_migrations` swallows failed ALTERs, so the columns must be checked, not assumed. Write
a four-line script that selects `column_name` from `information_schema.columns` for
`table_name='hplc_analyses'` and the five new names, and pipe it in the same way as Task 1:

```bash
ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python' < C:/tmp/check_hplc_columns.py
```

Expected: all five names. Then GET one existing analysis through the deployed route and
confirm `prep_form` and `dilution_factor_steps` are present in the JSON, because
`response_model` drops undeclared keys and a local pass proves nothing about that.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/models.py backend/database.py backend/calculations/hplc_processor.py backend/tests/test_hplc_analyze_route.py
git commit -- backend/main.py backend/models.py backend/database.py backend/calculations/hplc_processor.py backend/tests/test_hplc_analyze_route.py -m "feat: /hplc/analyze carries prep form and intermediate weighings"
```

---

### Task 7: A hand-picked curve must be from the run's instrument

Decision 18. `backend/main.py:6868` to `:6873` (re-verified on `origin/master`): when
`calibration_curve_id` is supplied the query filters `CalibrationCurve.id` and
`CalibrationCurve.peptide_id` only, so the instrument check in the `else` branch (`:6884`) is
skipped entirely. That is the hole that put the wrong quantity on four published COAs.

**Decided, not a question for the implementer:** the gate fires only when the request names
an instrument. `NewAnalysis.tsx:531-533` sends `sample_id_label`, `peptide_id` and
`calibration_curve_id` and no `instrument_id` at all, because the ad-hoc screen has no run
instrument to compare against; failing closed there would break that screen on the first
deploy. The flyout does send one, but as `prep.instrument_id ?? undefined` (`:1335`, `:1363`),
so it too can arrive absent. The residual hole is ledgered as a follow-up,
not closed here. The builder verifies before relying on it that an ad-hoc row carries no
`sample_prep_id` and so cannot reach `lims_analyses` through
`backend/lims_analyses/prep_bridge.py`.

**It is an error, not a fallback.** Silently substituting the correct curve would hide the
operator's mistake; a stopped run is recoverable, four published COAs were not.

**Files:**
- Modify: `backend/main.py:6868-6873`
- Test: `backend/tests/test_hplc_analyze_route.py`

**Interfaces:**
- Produces: `POST /hplc/analyze` raises `HTTPException(400, ...)` when
  `request.calibration_curve_id` is set, `request.instrument_id` is set, and the curve's
  `instrument_id` differs from it or is NULL. The message names the curve id, the curve's
  instrument (or "no instrument") and the run's instrument.

- [ ] **Step 1: Write the failing tests**

```python
def test_a_hand_picked_curve_from_another_instrument_is_refused(client, curve_on_instrument_2):
    r = client.post("/hplc/analyze", json={**BASE_PAYLOAD,
                    "calibration_curve_id": curve_on_instrument_2.id, "instrument_id": 1})
    assert r.status_code == 400
    assert "instrument" in r.json()["detail"].lower()

def test_a_hand_picked_curve_on_the_run_instrument_is_accepted(client, curve_on_instrument_2):
    r = client.post("/hplc/analyze", json={**BASE_PAYLOAD,
                    "calibration_curve_id": curve_on_instrument_2.id, "instrument_id": 2})
    assert r.status_code == 201

def test_a_hand_picked_curve_with_no_instrument_is_refused_when_the_run_has_one(client, curve_without_instrument):
    r = client.post("/hplc/analyze", json={**BASE_PAYLOAD,
                    "calibration_curve_id": curve_without_instrument.id, "instrument_id": 1})
    assert r.status_code == 400

def test_a_hand_picked_curve_is_still_accepted_when_the_request_names_no_instrument(client, curve_on_instrument_2):
    r = client.post("/hplc/analyze", json={**BASE_PAYLOAD,
                    "calibration_curve_id": curve_on_instrument_2.id})
    assert r.status_code == 201
```

The third test is Review Focus 3; the fourth is what keeps `NewAnalysis.tsx` working.

- [ ] **Step 2: Run to verify they fail**

Expected: the first and third FAIL with 201.

- [ ] **Step 3: Add the instrument check to the explicit-curve branch**

- [ ] **Step 4: Run the route suite**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_hplc_analyze_route.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_hplc_analyze_route.py
git commit -- backend/main.py backend/tests/test_hplc_analyze_route.py -m "fix: a hand-picked calibration curve must be from the run's instrument"
```

---

### Task 8: The Sample Form entity says which prep maths applies

Spec S4 as corrected 2026-11-02. Sample Forms is the managed dosage-form entity that shipped
in Mk1 1.55.0: `lims_sample_forms` (`backend/models.py:2087`) holds six seeded rows
(`backend/database.py:2252-2260`), user-renamable and retirable in Settings, and
`lims_samples.sample_form_id` (`:1425`) points at one. It carries `name`, `route`,
`is_default`, `active`, `sort_order` and `icon`, and nothing that says how a sample in that
form is prepped. `route` cannot supply it: Lyophilized Powder, Reconstituted Solution and Pen
are all `injectable`.

**Nothing in this plan reads the new column.** Task 6 keeps taking the kind from the request,
so the engine still ships inert. The column lands here because this is the plan that already
owns `models.py`, `_run_migrations` and a post-deploy column check, and because a prep
vocabulary defined twice at two different times is exactly how the engine and the bench drift
apart. The worksheet plan is the first reader.

**Files:**
- Modify: `backend/models.py` (`LimsSampleForm` 2087, which already has `__table_args__`)
- Modify: `backend/database.py` (the `lims_sample_forms` statement list, 2230 to 2275)
- Test: `backend/tests/test_sample_forms_schema.py` (exists; use its `_captured()` idiom,
  which runs the real `_run_migrations()` against a fake connection because SQLite never
  executes the raw migration SQL)

**Interfaces:**
- Produces: `LimsSampleForm.hplc_prep: Mapped[Optional[str]]`, `String(10)`, nullable. NULL
  means "this form has no HPLC prep maths". The accepted values are `powder` and `liquid`
  only. `bac` is absent because it is identity-derived
  (`worksheets_endo_promote._sample_is_bac`) and the Sample Forms release ruled that
  bacteriostatic water never gets a form row; `capsule` is absent until the capsule ruling.

- [ ] **Step 1: Write the failing tests**

The file already has `db_session`, `_captured()` and `_index_of(sqls, needle)`, and
`test_migrations_add_icon_before_the_seed_and_fill_only_null_icons` (`:104`) is the shape to
copy:

```python
def test_hplc_prep_check_rejects_a_value_outside_the_pair(db_session):
    db_session.add(LimsSampleForm(name="Gel", route="oral", hplc_prep="bac"))
    with pytest.raises(IntegrityError):
        db_session.flush()

def test_hplc_prep_may_be_null(db_session):
    db_session.add(LimsSampleForm(name="Gel", route="oral", hplc_prep=None))
    db_session.flush()   # no raise

def test_migrations_add_hplc_prep_then_its_check_then_fill_only_null_values():
    sqls = _captured()
    i_create = _index_of(sqls, "CREATE TABLE IF NOT EXISTS lims_sample_forms")
    i_col = _index_of(sqls, "ALTER TABLE lims_sample_forms ADD COLUMN IF NOT EXISTS hplc_prep")
    i_check = _index_of(sqls, "ck_lims_sample_forms_hplc_prep")
    i_fill = _index_of(sqls, "UPDATE lims_sample_forms SET hplc_prep")
    assert i_create < i_col < i_check < i_fill
    assert "WHERE hplc_prep IS NULL" in sqls[i_fill]
    assert "'lyophilized powder'" in sqls[i_fill].lower()
    assert "'reconstituted solution'" in sqls[i_fill].lower()

def test_the_backfill_leaves_the_other_four_built_in_forms_alone():
    sqls = _captured()
    fill = _index_of(sqls, "UPDATE lims_sample_forms SET hplc_prep")
    for name in ("'pen'", "'nasal spray'", "'capsule'", "'tablet'"):
        assert name not in sqls[fill].lower()   # the quoted literal, not a bare word
```

- [ ] **Step 2: Run to verify they fail**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_sample_forms_schema.py -v`
Expected: FAIL, `hplc_prep` is not a field on the model.

- [ ] **Step 3: Add the column, the CHECK, and the backfill**

The model gains the column and `__table_args__` gains the constraint. The table exists on
prod already, so a `CheckConstraint` in `__table_args__` alone never reaches it: the
migration adds the CHECK with the union-preserve `DO $$ BEGIN` idiom this file already uses
for `ck_lims_sub_sample_events_one_host`, after the `ADD COLUMN IF NOT EXISTS`.

The backfill copies the `icon` precedent (`backend/database.py:2262`) line for line, a
`CASE lower(btrim(name))` UPDATE guarded by `WHERE hplc_prep IS NULL`, so a value set in the
database by hand is never overwritten on a later boot:

| `lower(btrim(name))` | `hplc_prep` |
|---|---|
| `lyophilized powder` | `powder` |
| `reconstituted solution` | `liquid` |
| `pen`, `nasal spray`, `capsule`, `tablet` | left NULL |

Only the two names appear in the `CASE`; the other four are simply not listed, which leaves
them NULL without a statement that has to be undone when capsule is ruled.

- [ ] **Step 4: Run the forms suite and the spec suites it shares a resolver with**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_sample_forms.py backend/tests/test_sample_forms_schema.py -v`
Expected: PASS, with nothing added to the Task 1 Step 5 failure set.

- [ ] **Step 5: Verify the column, the CHECK and the backfill on prod after deploy**

Three facts, one script, piped the same way as Task 1: `hplc_prep` is in
`information_schema.columns` for `lims_sample_forms`; `ck_lims_sample_forms_hplc_prep` is in
`pg_constraints` for that table; and `SELECT name, route, hplc_prep FROM lims_sample_forms
ORDER BY sort_order` returns `powder` for Lyophilized Powder, `liquid` for Reconstituted
Solution and NULL for the other four.

```bash
ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python' < C:/tmp/check_form_prep.py
```

Prod rows may have been renamed in Settings since the 1.55.0 seed. If a built-in name no
longer matches, its `hplc_prep` is NULL and the fix is one UPDATE by id, not a code change.
Report which rows came back NULL rather than guessing at a rename.

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_sample_forms_schema.py
git commit -- backend/models.py backend/database.py backend/tests/test_sample_forms_schema.py -m "feat: sample forms carry the HPLC prep kind"
```

---

### Task 9: One active calibration curve per peptide and instrument

**Blocked on the Handler's answer:** peptide 38 on instrument 2 holds two active curves on
prod (66 curves, 63 active, 0 with a null instrument, exactly one violating pair). Which
stays active is the lab's call. Do not pick one. Without the data fix the index creation
fails, and `_run_migrations` swallows the failure, so prod would silently have no constraint
while every test passes locally.

**Files:**
- Modify: `backend/models.py` (`CalibrationCurve` 950, which has no `__table_args__` today;
  `instrument_id` is nullable, so the index's partial predicate must tolerate NULL)
- Modify: `backend/database.py` (`_run_migrations`)
- Modify: every writer that sets `CalibrationCurve.is_active` (enumerate with the grep in
  Step 2; known surfaces are the star/activate route, curve creation, and the SharePoint
  import)
- Test: `backend/tests/test_calibration_curve_uniqueness.py` (create)

**Interfaces:**
- Produces: a partial unique index `uq_active_curve_per_peptide_instrument` on
  `calibration_curves (peptide_id, instrument_id) WHERE is_active`, declared on the model's
  `__table_args__` as an `Index(..., postgresql_where=...)` and created in `_run_migrations`
  with `CREATE UNIQUE INDEX IF NOT EXISTS`. Every `is_active` writer deactivates the sibling
  curve for the same `(peptide_id, instrument_id)` in the same transaction, so activating a
  second curve is a swap rather than an `IntegrityError` 500.

- [ ] **Step 1: Gate on prod having no violating pair, and abort if it does**

The Handler owns the data fix (peptide 38 on instrument 2). This step verifies it landed; it
does not perform it and does not choose a curve. Write a script that groups
`calibration_curves` by `(peptide_id, instrument_id)` where `is_active`, having
`count(*) > 1`, and pipe it in the same way as Task 1:

```bash
ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python' < C:/tmp/check_curve_duplicates.py
```

Expected: zero rows. **Any row means stop and report the task as blocked**, naming the pairs
and their curve ids. Do not continue: `_run_migrations` swallows a failed
`CREATE UNIQUE INDEX`, so shipping now would leave prod with no constraint while every local
test passes. Record the query output in the commit message either way.

- [ ] **Step 2: Enumerate every `is_active` writer**

Run: `grep -rn "is_active" backend/ --include=*.py | grep -i "calibration\|curve"`
List each call site in the task's commit message. A writer missed here becomes a 500 the
first time a tech stars a second curve.

- [ ] **Step 3: Write the failing tests**

```python
def test_a_second_active_curve_for_the_same_peptide_and_instrument_is_refused(db, curve):
    with pytest.raises(IntegrityError):
        db.add(CalibrationCurve(peptide_id=curve.peptide_id, instrument_id=curve.instrument_id,
                                is_active=True, slope=1.0, intercept=0.0, r_squared=1.0))
        db.flush()

def test_two_active_curves_on_different_instruments_are_allowed(db, curve):
    db.add(CalibrationCurve(peptide_id=curve.peptide_id, instrument_id=curve.instrument_id + 1,
                            is_active=True, slope=1.0, intercept=0.0, r_squared=1.0))
    db.flush()   # no raise

def test_activating_a_curve_deactivates_its_sibling(db, curve, sibling):
    activate_curve(db, sibling.id)
    db.refresh(curve)
    assert curve.is_active is False
    assert sibling.is_active is True
```

- [ ] **Step 4: Run to verify they fail**

Expected: the first FAILs (no constraint), the third FAILs on the missing swap.

- [ ] **Step 5: Add `__table_args__`, the migration statement, and the swap to every writer**

- [ ] **Step 6: Run the new suite and the full backend suite**

Run: `MK1_DB_HOST=127.0.0.1 pytest backend/tests/test_calibration_curve_uniqueness.py -v`
then `MK1_DB_HOST=127.0.0.1 pytest backend/tests -q 2>&1 | tail -30`
Expected: the new tests PASS; the failure set matches Task 1 Step 5 with nothing added.

- [ ] **Step 7: Verify the index exists on prod after deploy**

Same idiom: a script selecting `indexname` from `pg_indexes` where
`tablename='calibration_curves'`, piped into the container.

```bash
ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python' < C:/tmp/check_curve_index.py
```

Expected: `uq_active_curve_per_peptide_instrument` in the list. Its absence means the
migration was swallowed and the invariant does not exist in production.

- [ ] **Step 8: Commit**

```bash
git add backend/models.py backend/database.py backend/main.py backend/tests/test_calibration_curve_uniqueness.py
git commit -- backend/models.py backend/database.py backend/main.py backend/tests/test_calibration_curve_uniqueness.py -m "feat: enforce one active calibration curve per peptide and instrument"
```

---

## Deliberately not in this plan, from the spec's own lists

- **"A prep that physically cannot be made raises server side, following
  `check_item_endo_fields`"** (spec section 7). That is the PREP path's refusal, on the
  worksheet's save and promote routes. This plan is the ANALYSIS path, where the same
  condition is a `problem` string on the engine's result, because an analysis of an already
  made vial has nothing left to refuse. Both exist; they are different surfaces, and the
  raise belongs to the worksheet plan.
- The floor warning, the rules page, `run_parameters`, the worksheet shell, promote, rider
  results, re-identification, and everything in S9 except the uniqueness invariant. Those
  are the later plans in the roadmap.

## Follow-ups this plan creates

- **The ad-hoc analysis screen cannot be instrument-gated.** `NewAnalysis.tsx:531-533`
  sends no `instrument_id`, so a hand-picked curve from the wrong instrument is still
  accepted there. Either send the instrument from that screen or derive it from
  `sample_prep_id` on the route.
- **A sample whose form has no HPLC prep maths still computes as a powder.** Task 8 records
  `hplc_prep` NULL for Pen, Nasal Spray and Tablet, but nothing in this plan reads it, so a
  Pen sample reaching `POST /hplc/analyze` is still processed with the powder stock-volume
  formula, exactly as today. The worksheet plan is the first reader and owns the refusal.
- **`lims_sample_forms.hplc_prep` has no Settings UI** after Task 8. The six built-in rows
  are filled by the boot UPDATE; a form the lab adds itself lands NULL and a new form that
  needs HPLC prep maths needs one SQL UPDATE until the picker ships with the worksheet plan.
- **Capsule quantity, per capsule or total**, which blocks the capsule form (see the blocking
  questions).
- **The flagged prod rows from Task 2**, whose reported quantity changes from a number to
  none. Each needs a lab decision: correct the weighings and reprocess, or retest.
- The `hplc_analyses.raw_data` retention question (7.4 GB of append-only payloads, no
  retention rule, `db-s-1vcpu-2gb`), which this plan reads around rather than addresses.
