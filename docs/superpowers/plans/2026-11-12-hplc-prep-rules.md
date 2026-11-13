# HPLC Prep Rules and Method Constants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Mk1 the two things the HPLC Prep Worksheet reads its defaults from: an `hplc`
block of method constants on `hplc_methods.run_parameters`, and an HPLC Prep Rules page whose
lines set a peptide's target, blend target, lead, diluent, floor and usual instrument.

**Architecture:** This is plan 2 of 5 and it is a copy of a shipped stack. Endotoxin prep rules
(`endo_prep_rules` table, `backend/endo_prep_rules.py`, four routes, a browser mirror, a shared
fixture and a page) are the pattern; every task below names the endo file it copies. The one
piece that is not a copy is the matcher: endo answers "which line rules this row", HPLC also
answers "what is this component's target in a blend", "which component leads" and "which
diluent". Those are five small pure functions, written once in Python and mirrored line for
line in TypeScript, held to the same answers by one JSON fixture both test suites read.

Nothing in this plan changes what an existing screen does. No worksheet reads these rules until
plan 3; the rule locks, history and re-apply that endo carries on `worksheet_items` are plan 3's.

**Tech Stack:** Python 3.11 / FastAPI / SQLAlchemy 2.x (`backend/`), pytest; React 19 /
TypeScript / TanStack Query (`src/`), vitest.

**Branch:** `feat/hplc-prep-rules`, already created in worktree `C:/tmp/Accu-Mk1-hplc-engine`
off `feat/hplc-results-engine` with `origin/master` (`a75d27e7`) merged in.

**Spec:** `docs/superpowers/specs/2026-10-29-hplc-prep-worksheet-design.md`, sections S2 and S3,
**as amended 2026-11-12** (amendments A2, A4, A5 and A6 at the top of the spec change this
plan's values; read them first).

**Source of the values:** `C:/tmp/tools-dennis-upstream/tools/hplc-peptide-quant/calc.js`, the
`DEFAULTS` object at lines 25 to 138. Read-only. Never read `C:/tmp/tools-dennis` (a stale
checkout) and never test against `hplc-peptide-quant-data.json` (real lab data).

## Global Constraints

- **Additive only.** A failing existing test defaults to "the test is stale", not "the code is
  wrong". Do not change what an existing endo screen, route or matcher does.
- **Gate on the failure-set diff, never on zero failures.** Mk1 has a known failing baseline.
  Run the test files you touch; do not chase unrelated failures.
- **Backend tests that need a database run in the devbox stack**, because Docker is down on
  this machine: `bash C:/tmp/hplc-build/stack-pytest.sh tests/<file>.py -q` (paths relative to
  `backend/`; it ships the working tree, uncommitted edits included, and uses a fresh scratch
  database per run). **One run at a time.** A pure test with no database can also run locally:
  `cd C:/tmp/Accu-Mk1-hplc-engine/backend && python -m pytest tests/<file>.py -q -p no:cacheprovider`.
- **Frontend:** `npm` only. `npx vitest run <file>` for tests, `npm run typecheck` for types.
  `npm run check:all` cannot pass on this repo (pre-existing lint and prettier debt in hundreds
  of untouched files); the gate is typecheck clean plus eslint and prettier clean **on the files
  you touched** (`npx eslint <files>`, `npx prettier --check <files>`).
- **A test under `src/` never imports a file under `backend/`.** The frontend Docker image has no
  `backend/` directory and its `tsc` pass covers tests. Read the shared fixture at run time with
  `readFileSync`, exactly as `src/lib/__tests__/endo-prep-rules.test.ts` does.
- **FastAPI `response_model` silently drops undeclared keys.** Every key a route returns is
  declared on its Pydantic model.
- **Commit with an explicit pathspec:** `git commit -m "..." -- <paths>`. Never `git add -A`,
  never a bare `git commit`. Check `git -c core.autocrlf=true diff --stat` before committing: a
  20-line edit that shows as a whole-file rewrite means a line-ending flip, so fix it, do not
  commit it. Edit files in place with their existing line endings; new files are LF.
- **No em dashes** in any new text: code comments, UI copy, docs, commit messages.
- **Commit messages end with** `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- **Labels follow the source sheet.** Where the lab's own sheet already names a thing ("Target
  Conc (ug/mL)", "Diluent", "Lead"), the page uses that wording.

## Review Focus

Inputs the spec implies and a reasonable person would expect to work, each pinned by a test in
the task named:

1. **A blend line whose named lead is not in the vial** (the blend was edited, or the component
   moved to vial B). `pick_lead` falls through to the next rule, it does not return a peptide
   that is not there. Task 2.
2. **A method carrying both an `endotoxin` and an `hplc` block.** Both survive a save; a null key
   is dropped; an unknown key in either is refused by name. Task 1.
3. **A line turned back on after its instrument was retired.** Reactivation re-checks every
   field, as endo re-checks a retired cartridge. Task 3.
4. **A reorder sent with a stale id list** (another tab added a line). 400 naming the rule, no
   partial reorder. Task 3.
5. **A seed run on a database that lacks one of the peptides** ("NAD+" is not in every copy).
   The script reports the miss and carries on; a second run inserts nothing. Task 7.

---

### Task 1: The `hplc` block in method run parameters

**Files:**
- Modify: `backend/catalog/method_run_params.py`
- Test: `backend/tests/test_method_run_params_hplc.py` (new; pure, runs locally)

**Interfaces:**
- Consumes: `calculations.hplc_processor.DILUENT_DENSITY_MG_ML`, `BENZYL_ALCOHOL_DENSITY`,
  `BAC_STOCK_UG_ML` (the engine's constants; import them, do not retype them).
- Produces:
  - `HPLC_RUN_PARAM_DEFAULTS: dict[str, float]`, exactly these keys and values:

    | key | value |
    |---|---|
    | `default_target_ug_ml` | 200 |
    | `intermediate_target_ug_ml` | 5000 |
    | `intermediate_volume_ul` | 1500 |
    | `two_step_threshold_mg` | 500 |
    | `bac_stock_ug_ml` | `BAC_STOCK_UG_ML` (9000) |
    | `bac_target_ug_ml` | 500 |
    | `capsule_neat_max_ug_ml` | 350 |
    | `diluent_density_mg_ml` | `DILUENT_DENSITY_MG_ML` (997.1) |
    | `benzyl_alcohol_density_mg_ml` | `BENZYL_ALCOHOL_DENSITY` (1034.72) |
    | `floor_ug_ml` | 60 |
    | `target_volume_ul` | 1500 |
    | `sample_diluent_ul` | 3000 |
    | `volume_tolerance_pct` | 15 |

  - `hplc_run_params(run_params: Optional[dict]) -> dict`: a method's stored `run_parameters`
    (or None) with every missing or null `hplc` key at its default. The HPLC twin of
    `worksheets_endo.endo_run_params`.
  - `validate_run_parameters(value)` now accepts the blocks `endotoxin` and `hplc`, alone or
    together, and returns only the non-empty ones (None when nothing is left).

- [ ] **Step 1: Write the failing tests**

```python
def test_defaults_are_the_engines_own_constants():
    assert HPLC_RUN_PARAM_DEFAULTS["diluent_density_mg_ml"] == hplc_processor.DILUENT_DENSITY_MG_ML
    assert HPLC_RUN_PARAM_DEFAULTS["benzyl_alcohol_density_mg_ml"] == hplc_processor.BENZYL_ALCOHOL_DENSITY
    assert HPLC_RUN_PARAM_DEFAULTS["bac_stock_ug_ml"] == hplc_processor.BAC_STOCK_UG_ML

def test_intermediate_target_is_5000_not_the_volume():
    assert HPLC_RUN_PARAM_DEFAULTS["intermediate_target_ug_ml"] == 5000
    assert HPLC_RUN_PARAM_DEFAULTS["intermediate_volume_ul"] == 1500

def test_missing_and_null_keys_take_the_default():
    assert hplc_run_params(None) == HPLC_RUN_PARAM_DEFAULTS
    assert hplc_run_params({"hplc": {"floor_ug_ml": None}})["floor_ug_ml"] == 60
    assert hplc_run_params({"hplc": {"floor_ug_ml": 40}})["floor_ug_ml"] == 40

def test_both_blocks_survive_a_save():
    out = validate_run_parameters({"endotoxin": {"cv_limit_pct": 20}, "hplc": {"floor_ug_ml": 40}})
    assert out == {"endotoxin": {"cv_limit_pct": 20}, "hplc": {"floor_ug_ml": 40}}

def test_null_keys_and_empty_blocks_are_dropped():
    assert validate_run_parameters({"hplc": {"floor_ug_ml": None}}) is None
    assert validate_run_parameters({"endotoxin": {}, "hplc": {"floor_ug_ml": 40}}) == {"hplc": {"floor_ug_ml": 40}}

def test_unknown_keys_are_refused_by_name():
    with pytest.raises(ValueError, match="unknown hplc run parameter\\(s\\): nope"):
        validate_run_parameters({"hplc": {"nope": 1}})
    with pytest.raises(ValueError, match="unknown run_parameters block\\(s\\): pcr"):
        validate_run_parameters({"pcr": {}})

def test_values_must_be_positive_finite():
    for bad in (0, -1, float("inf"), float("nan"), "200", True):
        with pytest.raises(ValueError, match="hplc.default_target_ug_ml must be a positive number"):
            validate_run_parameters({"hplc": {"default_target_ug_ml": bad}})

def test_cross_field_rules_read_effective_values():
    # a floor at or above the target can never be met
    with pytest.raises(ValueError, match="hplc.floor_ug_ml must be below default_target_ug_ml"):
        validate_run_parameters({"hplc": {"floor_ug_ml": 200}})
    # an intermediate weaker than the final target cannot be diluted down to it
    with pytest.raises(ValueError, match="hplc.intermediate_target_ug_ml must be above default_target_ug_ml"):
        validate_run_parameters({"hplc": {"intermediate_target_ug_ml": 150}})
    with pytest.raises(ValueError, match="hplc.volume_tolerance_pct must be at most 100"):
        validate_run_parameters({"hplc": {"volume_tolerance_pct": 150}})

def test_endotoxin_alone_validates_exactly_as_before():
    assert validate_run_parameters({"endotoxin": {"cv_limit_pct": 20}}) == {"endotoxin": {"cv_limit_pct": 20}}
    assert validate_run_parameters({"endotoxin": None}) is None
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd C:/tmp/Accu-Mk1-hplc-engine/backend && python -m pytest tests/test_method_run_params_hplc.py -q -p no:cacheprovider`
Expected: FAIL on import (`HPLC_RUN_PARAM_DEFAULTS` not defined).

- [ ] **Step 3: Implement.** Split the per-block cleaning into one helper per block so the endo
  path keeps its exact messages; `validate_run_parameters` cleans each block present and
  assembles the result. Update the module docstring to show both blocks.

- [ ] **Step 4: Run the new file and the existing one**

Run: `python -m pytest tests/test_method_run_params_hplc.py tests/test_method_consumables_run_params.py -q -p no:cacheprovider`
(the second file needs a database: `bash C:/tmp/hplc-build/stack-pytest.sh tests/test_method_consumables_run_params.py -q`)
Expected: the new file all PASS; the existing file's result identical to before your change.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-engine commit -m "feat(hplc): method run parameters gain an hplc block" -- backend/catalog/method_run_params.py backend/tests/test_method_run_params_hplc.py
```

---

### Task 2: The rules table, the matcher and the shared fixture

**Files:**
- Modify: `backend/models.py` (add `HplcPrepRule` directly after `EndoPrepRule`)
- Modify: `backend/database.py` (a `CREATE TABLE IF NOT EXISTS hplc_prep_rules` statement in
  the same migration list as the endo one, about line 2854; follow that statement's style)
- Create: `backend/hplc_prep_rules.py`
- Create: `backend/tests/fixtures/hplc_prep_rule_cases.json`
- Test: `backend/tests/test_hplc_prep_rules.py` (new)
- Modify: `backend/scripts/check_hplc_columns.py` (add the table and its columns to the
  post-deploy check, and say so in its docstring)

**Read first:** `backend/endo_prep_rules.py` lines 1 to 200 (module docstring, `snapshot`,
`load_rules`, `_in_band`, `_width`, `match_rule`, `check_rule`) and
`backend/tests/fixtures/endo_prep_rule_cases.json`. `_in_band` and `_width` are copied
unchanged in meaning.

**Interfaces:**
- Consumes: `HPLC_RUN_PARAM_DEFAULTS` (Task 1) for the default target and floor in `check_rule`.
- Produces, table `hplc_prep_rules`:

  | column | type | null | meaning |
  |---|---|---|---|
  | `id` | serial PK | | |
  | `peptide_id` | FK `peptides.id`, no ON DELETE | no | a solo peptide, a component, or a blend |
  | `min_mg`, `max_mg` | double | yes | weight band, `weight > min and <= max`, null = open |
  | `target_conc_ug_ml` | double | yes | the target alone (for a blend line: the lead's target in this blend); null = method default |
  | `blend_target_conc_ug_ml` | double | yes | this peptide's target as a blend component; null = same as alone |
  | `lead_component_id` | FK `peptides.id` | yes | blend lines only: which component leads |
  | `lead_priority` | integer | yes | component lines only: lower leads first when no lead is named |
  | `floor_ug_ml` | double | yes | null = method floor |
  | `diluent` | varchar(40) | yes | null = Water |
  | `default_instrument_id` | FK `instruments.id` | yes | the instrument it usually runs on |
  | `status` | varchar(10) | no, default `trial` | `trial` or `validated`, a label only |
  | `note` | text | yes | |
  | `active` | boolean | no, default true | false retires a line; never deleted |
  | `sort_order` | integer | no, default 0 | |
  | `created_at`, `updated_at` | timestamp | | as endo |
  | `updated_by_id` | FK `users.id` ON DELETE SET NULL | yes | |

- Produces, in `backend/hplc_prep_rules.py`:

```python
HPLC_DILUENTS = ("Water", "Water + 0.1% TFA")
DEFAULT_DILUENT = "Water"

def snapshot(rule) -> dict
    # every column above except created_at, updated_at, updated_by_id
def load_rules(db, *, active_only: bool = True) -> list[dict]

def match_rule(rules: list[dict], *, peptide_id: Optional[int],
               weight_mg: Optional[float]) -> Optional[dict]
    # The active line for this peptide whose band holds the weight. Narrowest band wins, then
    # lowest sort_order, then lowest id. peptide_id None -> None. Returns the dict from `rules`.

def component_target(rules, *, peptide_id: Optional[int], weight_mg: Optional[float],
                     in_blend: bool, default: float) -> dict
    # {"value": float, "source": "blend_rule" | "rule" | "default", "rule_id": Optional[int]}
    # line = match_rule(peptide_id, weight_mg). in_blend and line.blend_target set -> blend_rule;
    # else line.target set -> rule; else default with rule_id None.

def pick_lead(rules, components: list[dict], *, row_rule: Optional[dict],
              chosen_id: Optional[int] = None) -> Optional[dict]
    # components: one autosampler vial's [{"peptide_id": int, "declared_mg": Optional[float]}],
    # in display order. Returns {"peptide_id": int, "why": ...} or None for an empty list.
    #   "chosen"    chosen_id, when it is in the vial
    #   "rule"      row_rule["lead_component_id"], when it is in the vial   (2+ components only)
    #   "preferred" the component whose own matched line has the lowest lead_priority; a tie
    #               goes to the one listed first                            (2+ components only)
    #   "heaviest"  the greatest declared_mg among those with a weight; a tie goes to the first
    #   "first"     no component has a weight

def row_diluent(rules, *, row_rule: Optional[dict], components: list[dict]) -> dict
    # {"diluent": str, "rule_id": Optional[int]}. row_rule's diluent if set; else the first
    # component, in order, whose own matched line names one; else DEFAULT_DILUENT, rule_id None.

def row_instrument(rules, *, row_rule: Optional[dict], components: list[dict]) -> Optional[int]
    # the same walk for default_instrument_id; None when no line names one

def row_floor(row_rule: Optional[dict], *, default: float) -> float

def check_rule(db, values: dict, sent, *, rule_id: Optional[int] = None) -> list[str]
    # raises ValueError (the routes answer 400); returns warnings for an active line
```

  A component's own line is matched on **the component's** `declared_mg`; the row's own line on
  the row's declared total. For a solo row `components` is the one peptide and `row_rule` is
  that peptide's line.

- `check_rule` refuses, with the reason in the message:
  - `peptide_id`, `status` or `active` sent as null; a non-finite number; an unknown peptide;
  - `target_conc_ug_ml`, `blend_target_conc_ug_ml` or `floor_ug_ml` not above zero;
  - `min_mg >= max_mg`;
  - `lead_priority` not a whole number of at least 1;
  - `diluent` outside `HPLC_DILUENTS` (the message lists them);
  - `default_instrument_id` that is not an active instrument;
  - `lead_component_id` on a line whose peptide is not a blend ("only a blend line names a
    lead"), or naming a peptide that is not one of that blend's components;
  - `blend_target_conc_ug_ml` or `lead_priority` on a line whose peptide IS a blend ("a blend is
    never a component of another blend");
  - an effective floor at or above the effective target (each falling back to
    `HPLC_RUN_PARAM_DEFAULTS`).

  Like endo, each check runs only when a field it reads was sent, so a line that an old value no
  longer fits can still be deactivated or re-noted. Warnings, active lines only: a band that
  overlaps another active line of the same peptide (endo's `OVERLAP_RULE` wording), and a
  `lead_priority` another active line already uses ("ties go to the component listed first").

- The fixture `backend/tests/fixtures/hplc_prep_rule_cases.json`:

```json
{"about": "...", "peptides": {"1": "Retatrutide", "...": "..."},
 "rule_sets": {"main": [ {snapshot}, ... ]},
 "cases": [{"name": "...", "fn": "match_rule | component_target | pick_lead | row_diluent | row_instrument | row_floor",
            "rules": "main", "query": { keyword arguments }, "expect": ...}]}
```

  For `pick_lead`, `row_diluent` and `row_instrument` the query carries
  `"row_rule_id": <id or null>` and the test resolves it to the snapshot in the rule set, so the
  fixture stays plain data. `expect` is the whole return value (`rule_id` for `match_rule`).

- [ ] **Step 1: Write the fixture.** Rule set `main` holds the lab's real lines and enough
  synthetic ones to pin the matcher. Real, from the source `DEFAULTS`: NAD+ target 150; GHK-Cu
  target 125, blend target 350, diluent `Water + 0.1% TFA`, lead priority 2; Ipamorelin target
  150, blend target 175, lead priority 1; Retatrutide `default_instrument_id` 3. Synthetic: two
  banded lines for one peptide (a closed band inside an open one), an inactive line, two lines
  tied on band width, and one blend line that names a lead and a diluent. Cases, at least:

  | fn | case | expect |
  |---|---|---|
  | match_rule | no peptide | null |
  | match_rule | band includes its top, excludes its bottom | hit, then null |
  | match_rule | closed band beats the open one | the closed line |
  | match_rule | inactive line never matches | null |
  | match_rule | tie on width goes to lowest sort_order, then id | named line |
  | match_rule | no weight sits only in a fully open line | the open line |
  | component_target | Ipamorelin alone | 150, `rule` |
  | component_target | Ipamorelin in a blend | 175, `blend_rule` |
  | component_target | GHK-Cu alone / in a blend | 125 / 350 |
  | component_target | NAD+ in a blend (no blend target) | 150, `rule` |
  | component_target | a peptide with no line | the default passed in, `default`, rule_id null |
  | pick_lead | chosen wins over everything | `chosen` |
  | pick_lead | chosen is not in the vial | falls through |
  | pick_lead | the blend line's lead wins over a preferred one | `rule` |
  | pick_lead | **the blend line's lead is not in the vial** | falls through to `preferred` |
  | pick_lead | Ipamorelin beats GHK-Cu when both are in | Ipamorelin, `preferred` |
  | pick_lead | GHK-Cu leads BPC-157 + GHK-Cu + TB500 | GHK-Cu, `preferred` |
  | pick_lead | no preferred component | the heaviest, `heaviest` |
  | pick_lead | no weights at all | the first, `first` |
  | pick_lead | one component | that component, `heaviest` (or `first` with no weight) |
  | pick_lead | empty vial | null |
  | row_diluent | GHK-Cu alone | TFA |
  | row_diluent | a blend holding GHK-Cu, no blend line | TFA, GHK-Cu's rule id |
  | row_diluent | **Eloralintide alone** | Water, rule_id null |
  | row_diluent | the blend line's own diluent wins | the blend line |
  | row_instrument | Retatrutide alone / in a blend | 3 / 3 |
  | row_instrument | a peptide with no line | null |
  | row_floor | no line / a line with floor 40 | the default / 40 |

  The Eloralintide case exists so that putting it back on TFA has to be a deliberate edit of a
  failing test (spec amendment A2).

- [ ] **Step 2: Write `test_hplc_prep_rules.py`.** One parametrized test runs every fixture case
  through the function named by its `fn`. Plus database tests for `check_rule` (one per refusal
  above, asserting the message; one per warning), a `snapshot` test (the key list matches the
  table), a `load_rules` ordering test, and a schema test (the table exists with every column
  above and the two FKs).

- [ ] **Step 3: Run and see it fail**

Run: `bash C:/tmp/hplc-build/stack-pytest.sh tests/test_hplc_prep_rules.py -q`
Expected: FAIL on import (`hplc_prep_rules` not found).

- [ ] **Step 4: Implement** the model, the `CREATE TABLE` statement, the module and the
  check-script lines.

- [ ] **Step 5: Run and see it pass**

Run: `bash C:/tmp/hplc-build/stack-pytest.sh tests/test_hplc_prep_rules.py tests/test_endo_prep_rules.py -q`
Expected: the new file all PASS; the endo file's result unchanged.

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-engine commit -m "feat(hplc): prep rules table, matcher and shared fixture" -- backend/models.py backend/database.py backend/hplc_prep_rules.py backend/tests/fixtures/hplc_prep_rule_cases.json backend/tests/test_hplc_prep_rules.py backend/scripts/check_hplc_columns.py
```

---

### Task 3: The four routes

**Files:**
- Modify: `backend/main.py` (a new block directly after the endo prep rule routes, about line
  4410, before `# --- Analysis Service Endpoints ---`)
- Test: `backend/tests/test_hplc_prep_rules_api.py` (new; copy the shape of
  `backend/tests/test_endo_prep_rules_api.py`)

**Read first:** `backend/main.py` from `class EndoPrepRuleIn` to the end of
`reorder_endo_prep_rules`. The HPLC block is the same code with the HPLC names.

**Interfaces:**
- Consumes: `hplc_prep_rules.snapshot`, `check_rule` and `HplcPrepRule` (Task 2).
- Produces:
  - `GET /hplc-prep-rules` -> `list[HplcPrepRuleOut]`, inactive lines included, in list order.
  - `POST /hplc-prep-rules` (body `HplcPrepRuleIn`) -> 201 `HplcPrepRuleSaveOut`.
  - `PATCH /hplc-prep-rules/{rule_id}` (body `HplcPrepRulePatch`) -> `HplcPrepRuleSaveOut`;
    sent = set, explicit null clears, omitted = untouched.
  - `POST /hplc-prep-rules/reorder` (body `{"ids": [...]}`) -> `list[HplcPrepRuleOut]`.
  - `HplcPrepRuleOut` = the snapshot keys plus `peptide_name: Optional[str]`,
    `peptide_is_blend: bool`, `lead_component_name: Optional[str]`,
    `default_instrument_name: Optional[str]`, `updated_at: Optional[datetime]`.
  - `HplcPrepRuleSaveOut` = `{"rule": HplcPrepRuleOut, "warnings": list[str]}`.
  - Audit rows: `operation` `hplc_prep_rule_created`, `hplc_prep_rule_updated`,
    `hplc_prep_rules_reordered`; `entity_type` `hplc_prep_rule`; `details` `{user_id, old, new}`.
  - Same permission as the endo routes: any signed-in user (`get_current_user`).

- [ ] **Step 1: Write the failing tests.** Mirror every test in `test_endo_prep_rules_api.py`
  that is not about a cartridge, renamed, and add:

```python
def test_out_declares_every_key_the_page_reads(client, seeded):
    row = client.get("/hplc-prep-rules").json()[0]
    assert set(row) == {"id", "peptide_id", "min_mg", "max_mg", "target_conc_ug_ml",
                        "blend_target_conc_ug_ml", "lead_component_id", "lead_priority",
                        "floor_ug_ml", "diluent", "default_instrument_id", "status", "note",
                        "sort_order", "active", "peptide_name", "peptide_is_blend",
                        "lead_component_name", "default_instrument_name", "updated_at"}

def test_reactivating_a_line_rechecks_a_retired_instrument(...):
    # create with an active instrument, deactivate the line, retire the instrument,
    # PATCH {"active": true} -> 400 naming the instrument

def test_reorder_with_a_stale_id_list_is_refused_whole(...):
    # ids missing one rule -> 400 "ids must list every rule exactly once"; sort_order unchanged

def test_a_save_that_changes_nothing_writes_no_audit_row(...)
def test_an_explicit_null_clears_a_value_back_to_the_standard(...)
```

- [ ] **Step 2: Run and see it fail**

Run: `bash C:/tmp/hplc-build/stack-pytest.sh tests/test_hplc_prep_rules_api.py -q`
Expected: FAIL (404 on `/hplc-prep-rules`).

- [ ] **Step 3: Implement** the Pydantic models, `_hplc_prep_rules_out` (one query, outer joins
  for the three names) and the four routes.

- [ ] **Step 4: Run and see it pass**

Run: `bash C:/tmp/hplc-build/stack-pytest.sh tests/test_hplc_prep_rules_api.py tests/test_endo_prep_rules_api.py -q`
Expected: the new file all PASS; the endo file's result unchanged.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-engine commit -m "feat(hplc): prep rules routes" -- backend/main.py backend/tests/test_hplc_prep_rules_api.py
```

---

### Task 4: The browser's mirror of the matcher and of the method constants

**Files:**
- Create: `src/lib/hplc-prep-rules.ts`
- Create: `src/lib/hplc-run-params.ts`
- Test: `src/lib/__tests__/hplc-prep-rules.test.ts`, `src/lib/__tests__/hplc-run-params.test.ts`

**Read first:** `src/lib/endo-prep-rules.ts` and `src/lib/__tests__/endo-prep-rules.test.ts`
(how it reads the shared fixture with `readFileSync`).

**Interfaces:**
- Consumes: `backend/tests/fixtures/hplc_prep_rule_cases.json` (Task 2), at run time only.
- Produces, in `hplc-prep-rules.ts`: `HplcPrepRule` (the route's `HplcPrepRuleOut` shape),
  `HplcPrepRuleStatus`, `HPLC_DILUENTS`, `DEFAULT_DILUENT`, and
  `matchRule`, `componentTarget`, `pickLead`, `rowDiluent`, `rowInstrument`, `rowFloor` with the
  Python functions' parameters (camelCased option names, snake_case rule and result keys, as the
  endo mirror does) and identical results; plus the page helpers `bandText`, `ruleText`,
  `ruleTag` on the endo pattern.
- Produces, in `hplc-run-params.ts`: `HplcRunParamsWire` (the stored snake_case block, every key
  optional and nullable), `HPLC_RUN_PARAM_DEFAULTS` (the same thirteen values as Task 1, same
  keys) and `hplcRunParamsFrom(runParameters: unknown): Record<keyof typeof HPLC_RUN_PARAM_DEFAULTS, number>`.

- [ ] **Step 1: Write the failing tests.** `hplc-prep-rules.test.ts` runs every fixture case
  through the function its `fn` names and expects the fixture's `expect`, with the same
  `row_rule_id` resolution as the Python test. `hplc-run-params.test.ts`:

```ts
it('carries the same thirteen defaults the backend does', () => {
  expect(HPLC_RUN_PARAM_DEFAULTS).toEqual({
    default_target_ug_ml: 200, intermediate_target_ug_ml: 5000, intermediate_volume_ul: 1500,
    two_step_threshold_mg: 500, bac_stock_ug_ml: 9000, bac_target_ug_ml: 500,
    capsule_neat_max_ug_ml: 350, diluent_density_mg_ml: 997.1,
    benzyl_alcohol_density_mg_ml: 1034.72, floor_ug_ml: 60, target_volume_ul: 1500,
    sample_diluent_ul: 3000, volume_tolerance_pct: 15,
  })
})
it('fills missing and null keys with the default', () => {
  expect(hplcRunParamsFrom(null)).toEqual(HPLC_RUN_PARAM_DEFAULTS)
  expect(hplcRunParamsFrom({ hplc: { floor_ug_ml: null } }).floor_ug_ml).toBe(60)
  expect(hplcRunParamsFrom({ hplc: { floor_ug_ml: 40 } }).floor_ug_ml).toBe(40)
  expect(hplcRunParamsFrom({ endotoxin: { cv_limit_pct: 20 } })).toEqual(HPLC_RUN_PARAM_DEFAULTS)
})
```

- [ ] **Step 2: Run and see it fail**

Run: `cd C:/tmp/Accu-Mk1-hplc-engine && npx vitest run src/lib/__tests__/hplc-prep-rules.test.ts src/lib/__tests__/hplc-run-params.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** both modules.

- [ ] **Step 4: Run, typecheck, lint**

Run: the vitest command above, then `npm run typecheck`, then
`npx eslint src/lib/hplc-prep-rules.ts src/lib/hplc-run-params.ts src/lib/__tests__/hplc-prep-rules.test.ts src/lib/__tests__/hplc-run-params.test.ts`
and `npx prettier --check` on the same four files.
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-engine commit -m "feat(hplc): browser mirror of the prep rule matcher and method constants" -- src/lib/hplc-prep-rules.ts src/lib/hplc-run-params.ts src/lib/__tests__/hplc-prep-rules.test.ts src/lib/__tests__/hplc-run-params.test.ts
```

---

### Task 5: The HPLC Prep Rules page

**Files:**
- Modify: `src/lib/api.ts` (four functions directly after the endo prep rule functions, about
  line 7010)
- Create: `src/services/hplc-prep-rules.ts`
- Create: `src/components/hplc/prep/HplcPrepRulesPage.tsx`
- Create: `src/components/hplc/prep/HplcPrepRuleBits.tsx`
- Modify: `src/store/ui-store.ts` (add the sub-section id `'hplc-prep-rules'` beside
  `'endo-prep-rules'`)
- Modify: `src/components/layout/AppSidebar.tsx` (an entry
  `{ id: 'hplc-prep-rules', label: 'HPLC prep rules' }` directly after the endo one)
- Modify: `src/components/layout/MainWindowContent.tsx` (render the page for that sub-section)
- Test: `src/components/hplc/prep/__tests__/HplcPrepRulesPage.test.tsx`,
  `src/components/hplc/prep/__tests__/HplcPrepRuleBits.test.tsx`

**Read first:** `src/components/hplc/endo/EndoPrepRulesPage.tsx`,
`src/components/hplc/endo/EndoPrepRuleBits.tsx`, their two test files, and
`src/services/endo-prep-rules.ts`. The page is the same page: same layout, same add, edit,
activate and reorder interactions, same warnings display, same query invalidation.

**Interfaces:**
- Consumes: the routes (Task 3); `HplcPrepRule`, `HPLC_DILUENTS`, `DEFAULT_DILUENT`, `bandText`,
  `ruleText`, `ruleTag` (Task 4); `HPLC_RUN_PARAM_DEFAULTS` (Task 4) for the placeholders.
- Produces: `getHplcPrepRules()`, `createHplcPrepRule(body)`, `updateHplcPrepRule(id, patch)`,
  `reorderHplcPrepRules(ids)` in `api.ts`; `HPLC_PREP_RULES_KEY = ['hplc-prep-rules'] as const`
  and `useHplcPrepRules()` in the service; `HplcPrepRulesPage` (named and default export).

**Columns, in this order, with these labels:** Peptide, Weight (mg), Target Conc (ug/mL),
Target in a blend (ug/mL), Lead, Diluent, Floor (ug/mL), Instrument, Status, Note. Rules for
the cells that differ by line kind:

- A line whose peptide is a blend (`peptide_is_blend`): "Target in a blend" is not editable and
  shows a dash; "Lead" is a picker of that blend's components (blank = "by the usual rule").
- A line whose peptide is not a blend: "Lead" is a small whole-number box labelled "leads
  blends, rank" (blank = never preferred).
- A blank Target shows the method default as its placeholder (200); a blank Floor shows 60; a
  blank Diluent shows Water. Blank always means "the standard", never zero.
- The page says once, above the table, in the lab's voice: a blend is made to its lead's
  target, a rule on the blend itself names the lead, and a component below the floor only
  warns.

- [ ] **Step 1: Write the failing tests.** Mirror the endo page and bits tests that are not
  about cartridges or the step 1 ratio, renamed, and add:

```ts
it('offers the blend components as the lead on a blend line and a rank box otherwise', ...)
it('shows the method default as the placeholder of a blank target, floor and diluent', ...)
it('sends an explicit null when a value is cleared, never 0', ...)
it('shows the warnings a save returns', ...)
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/components/hplc/prep`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** the api functions, the service, the two components and the three
  wiring edits.

- [ ] **Step 4: Run, typecheck, lint**

Run: `npx vitest run src/components/hplc/prep src/components/hplc/endo/__tests__/EndoPrepRulesPage.test.tsx`,
then `npm run typecheck`, then eslint and `prettier --check` on every file you created or edited.
Expected: the new tests PASS, the endo page test unchanged, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-engine commit -m "feat(hplc): the HPLC Prep Rules page" -- src/lib/api.ts src/services/hplc-prep-rules.ts src/components/hplc/prep src/store/ui-store.ts src/components/layout/AppSidebar.tsx src/components/layout/MainWindowContent.tsx
```

---

### Task 6: The HPLC constants on the method panel

**Files:**
- Modify: `src/components/hplc/MethodRunParamsSection.tsx`
- Modify: `src/components/hplc/MethodPanel.tsx` (render the section for a method that is not an
  endotoxin method, with `block="hplc"`)
- Modify: `src/lib/api.ts` (the method's `run_parameters` type gains the optional `hplc` block)
- Test: `src/components/hplc/__tests__/MethodRunParamsSection.test.tsx` (extend it if it exists,
  create it if it does not)

**Interfaces:**
- Consumes: `HplcRunParamsWire`, `HPLC_RUN_PARAM_DEFAULTS` (Task 4).
- Produces: `MethodRunParamsSection` takes `block?: 'endotoxin' | 'hplc'` (default
  `'endotoxin'`, so the existing call site and its behaviour are untouched). With `'hplc'` it
  lists the thirteen constants, each with its unit and the default as its placeholder, and saves
  `{ ...existing run_parameters, hplc: {...} }` so an endotoxin block already on the method is
  never dropped by an HPLC save, and the reverse.

  Labels and units: Default target (ug/mL), Intermediate target (ug/mL), Intermediate volume
  (uL), Two-step from (mg), Bac water stock (ug/mL), Bac water target (ug/mL), Capsule neat
  limit (ug/mL), Diluent density (mg/mL), Benzyl alcohol density (mg/mL), Blend floor (ug/mL),
  Target volume (uL), Diluent to add (uL), Volume tolerance (%).

  The draft-only rule is unchanged: the section sends nothing for a method that is not a draft.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists the thirteen HPLC constants with their defaults as placeholders', ...)
it('saving the hplc block keeps an endotoxin block already on the method', ...)
it('saving the endotoxin block keeps an hplc block already on the method', ...)
it('a cleared field is sent as null, so the default comes back', ...)
it('sends nothing for a method that is not a draft', ...)
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/components/hplc/__tests__/MethodRunParamsSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run, typecheck, lint** as in Task 5, on the files you touched.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-engine commit -m "feat(hplc): the method panel edits the HPLC constants" -- src/components/hplc/MethodRunParamsSection.tsx src/components/hplc/MethodPanel.tsx src/lib/api.ts src/components/hplc/__tests__/MethodRunParamsSection.test.tsx
```

---

### Task 7: A seed for the lab's own lines

**Files:**
- Create: `backend/scripts/seed_hplc_prep_rules.py`
- Test: `backend/tests/test_seed_hplc_prep_rules.py`

**Interfaces:**
- Consumes: `HplcPrepRule` (Task 2).
- Produces: `seed(db, *, apply: bool) -> dict` returning
  `{"inserted": [names], "skipped_existing": [names], "not_found": [names]}`, and a command line:
  dry run by default, `--apply` to write. Same stdin-friendly shape as
  `backend/scripts/check_hplc_columns.py` (no `__file__` when piped into the prod container).

  The lines, from the source `DEFAULTS` (`targetConcByPeptide`, `blendTargetConcByPeptide`,
  `preferredLeads`, `diluentByPeptide`, `instrumentByPeptide`):

  | peptide | target | blend target | lead priority | diluent | instrument |
  |---|---|---|---|---|---|
  | NAD+ | 150 | | | | |
  | GHK-Cu | 125 | 350 | 2 | Water + 0.1% TFA | |
  | Ipamorelin | 150 | 175 | 1 | | |
  | Retatrutide | | | | | the instrument named `HPLC 1290b` (case-insensitive) |

  Bacteriostatic water's 500 is a method constant (Task 1), not a line. GLOW and KLOW need no
  line: GHK-Cu's diluent decides for any blend holding it.

  A peptide is found by `abbreviation`, then `name`, case-insensitive and exact. A peptide that
  already has ANY line is skipped whole, so a second run inserts nothing and never fights a hand
  edit. Lines are `validated`, with a note naming the source table and date. A peptide or
  instrument that is not in the database is reported in `not_found` and the run carries on (for
  the Retatrutide line, a missing instrument inserts the line without one and says so).

- [ ] **Step 1: Write the failing tests**

```python
def test_dry_run_writes_nothing(db): ...
def test_apply_inserts_the_lines_with_the_source_values(db): ...
def test_a_second_apply_inserts_nothing(db): ...
def test_a_peptide_with_a_hand_made_line_is_left_alone(db): ...
def test_a_missing_peptide_is_reported_and_the_rest_still_seed(db): ...
```

- [ ] **Step 2: Run and see it fail**

Run: `bash C:/tmp/hplc-build/stack-pytest.sh tests/test_seed_hplc_prep_rules.py -q`
Expected: FAIL on import.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and see it pass.** Same command. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-hplc-engine commit -m "feat(hplc): seed script for the lab's own prep rule lines" -- backend/scripts/seed_hplc_prep_rules.py backend/tests/test_seed_hplc_prep_rules.py
```

---

## After the last task (controller, not an implementer)

- Full backend suite in the stack, failure set diffed against the same run at
  `c9f7bda8` (the branch point): `bash C:/tmp/hplc-build/stack-pytest.sh tests -q -rfE`.
- Full vitest run, failure set diffed against the same commit.
- The frontend Docker build cannot run on this machine tonight (Docker is down). It is a
  release-gate item for this branch and is listed in the hand-back, not skipped silently.
- Release checklist addition: after deploy, run `backend/scripts/check_hplc_columns.py` (now
  covering `hplc_prep_rules`), then `backend/scripts/seed_hplc_prep_rules.py --apply` once.
