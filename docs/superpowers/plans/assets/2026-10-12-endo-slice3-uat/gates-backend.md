# Endo slice 3, Task 9 Steps 2-5: backend gates and launch rehearsal (endos3)

Operator record, 2026-10-13. Brief: `.superpowers/sdd/2026-10-12-endo-slice3/task-9-ops.md`, as amended by the Task 9 rulings in `preflight-rulings.md`.

**Status: all gates and rehearsal steps 1-7 PASS, at `da5bfc77`.**

Two passes:
- **First pass, at `1b5317ed`.** Stopped at Step 4: the new test `test_spec_unit_indexes_pg.py` failed on an over-literal assertion (Section 5).
- **Second pass, at `da5bfc77`.** The controller committed the one-line test fix and ruled on COA mode (Section 6). The stack was restaged, Step 4's file re-ran green, and rehearsal steps 2-7 ran in order.

## 1. Stack facts

| Item | Value |
|---|---|
| Stack | `endos3`, block 8, ports 5660-5679, created from `golden-20260911-233650`. `validate`: 21/21 PASS. |
| Mk1 | http://100.73.137.3:5672 (frontend, `/api` proxied; `/api/health` 200). Backend 5670. |
| Staged | `da5bfc77af2516f3b8575eedf03cf4845077bc30`, in `~/worktrees/Accu-Mk1-endos3/.staged-from-sha`. |
| Base for diffs | `feat/endo-worksheet-v2` @ 4efbd083, shipped with `git archive 4efbd083 backend`. |
| Container tooling | `pytest==9.1.1` and `pytest-timeout==2.4.0` pip-installed into `accumark-endos3-accu-mk1-backend`. A recreate loses them. |
| Where the suites ran | Both trees were unpacked under the container's `/tmp` (`/tmp/s3-branch/backend`, `/tmp/s3-base/backend`) and run with `PYTHONDONTWRITEBYTECODE=1`. Nothing was written to `/app` except by staging. |
| Logs and scripts | Logs: devbox `~/endos3-suites/` (`rehearsal-step2.txt` ... `rehearsal-step7.txt`). Scripts: `stack_api.py`, `rehearse.py` and the runners, in the controller scratchpad `endos3/`. |
| COA mode left on the stack | **senaite** (the `coa_generation` key removed; Section 6). |

**How the stack was staged:**
- **First stage (`1b5317ed`).** The documented flow: `git archive HEAD | ssh ... tar -xz` into a fresh `~/worktrees/Accu-Mk1-endos3`, then `mount endos3 --mk1`.
- **Restage (`da5bfc77`).** The same `git archive | tar -xz`, extracted in place over the mounted directory, with `.staged-from-sha` updated. The documented `rm -rf` of a directory that is bind-mounted into the running container would have left `/app` pointing at the deleted directory.
  - The one file changed is `backend/tests/test_spec_unit_indexes_pg.py`, and no file was deleted between the shas, so the in-place tree is the same as a clean stage.
  - Its sha256 matches `git show HEAD:` on the devbox and inside the container.
  - uvicorn reloaded; health 200.

**Hard rules kept:**
- Only endos3 was touched. endov2, host and production were not.
- Nothing was destroyed.
- No git ran in a container or in a devbox clone.
- No password was typed or printed:
  - API calls used tokens minted inside the container for `stackdev@accumark.local`, and for `admin@accumark.local` as the reviewer;
  - the S2S token for `coa-sections` was read from the container env;
  - a password grep over each pg-test output found 0 matches.
- One pytest process ran at a time.
- No suite ran against `accumark_mk1`. Its only uses were one read-only `pg_dump`, restored into the scratch database (Section 4b), and the rehearsal API calls.

## 2. Boot (Task Step 2 / rehearsal step 1): PASS

The first boot of the branch after the mount (the whole boot log is 50 lines) shows no `migration_skipped` for the three `lims_analyses` columns or for `_SPEC_UNIT_INDEX_SWAP`.

The skips it does show are all outside this diff:
- tables that do not exist in the golden: `document_comments`, `documents`, `customer_ai_reviews`;
- the `lims_analyses_review_state_check` constraint, which a golden row violates. That statement is not in `git diff 4efbd083 HEAD -- backend/database.py`.

The reload at `da5bfc77` (a second boot) logged only the review_state constraint skip.

Schema after the first boot:

```
lims_analyses: lod double precision | lod_unit text | loq double precision
analysis_service_specs indexes: analysis_service_specs_pkey,
  uq_analysis_service_specs_matrix_unit   ... lower(btrim((COALESCE(unit, ''::character varying))::text))) WHERE (active AND (matrix IS NOT NULL))
  uq_analysis_service_specs_peptide_unit  ... WHERE (active AND (peptide_id IS NOT NULL))
  uq_analysis_service_specs_wildcard_unit ... WHERE (active AND (matrix IS NULL) AND (peptide_id IS NULL))
```

The old names (`uq_analysis_service_specs_matrix`, `_peptide`, `_wildcard`) are absent after this boot. That the swap drops them, and that a second boot changes nothing, is proven by `test_spec_unit_indexes_pg.py` (Step 4).

## 3. Seed (`seed_native_endo.py`, next to this file)

The golden holds only SENAITE-born `ENDO-LAL` (service 77). The seed builds the production shape through the app's API.

It is re-runnable. A second run printed only "service exists", "method exists" and the summary, and changed nothing.

**Preflight (added after the rehearsal, for the UAT stack).** Before any write, the seed checks two things:
- **Every chosen vial is free.** None may be on another open worksheet in the Microbiology scope, because `create-from-drop` and `add-group` 409 on their open-worksheet guard.
- **No chosen vial holds another live endotoxin analysis.**

If either check fails, the seed stops and writes nothing.

It also picks the SENAITE-born row at run time:
- the one already on the seed's worksheet;
- else the first free golden vial whose only live endotoxin analysis is SENAITE-born ENDO-LAL, preferring P-0155-S02.

Why: on endov2 the v2 UAT worksheet (`uat_worksheet.sql`) holds the golden's endo vials, P-0155-S02 among them. A hard-coded P-0155-S02 would have 409'd mid-seed, after the catalog writes.

Checks on endos3:
- A third run (`seed-run3.txt`) printed "preflight OK; SENAITE-born row: P-0155-S02", then only "service exists" and "method exists", and `seed OK`.
- A read-only check of the hold query flags P-0152-S03 (on "6/1 Ster", scope 2/2) and clears P-0155-S02 and BW-0010-S01.

### Catalog

| What | Id | How |
|---|---|---|
| Service `ENDOTOXIN-USP85LAL` "Endotoxin USP85 LAL" (origin mk1, EU/mL, numeric, Microbiology) | 234 | `POST /analysis-services` |
| Profile `endotoxin-usp85-lal`: limit_table, member 234, role endo85 (minted by the profile) | 7 | `POST /analysis-profiles`, `PUT .../members`, then `PATCH coa_archetype` |
| Spec, catch-all 0-5 EU/mL, LOQ 2.5 | 6 | `POST /analysis-services/234/specs` |
| Spec, Bacteriostatic Water 0-0.25 EU/mL, LOQ 0.2 | 7 | same |
| Spec, BPC-157 (peptide 10) 0-40 EU/mL, LOQ 2.5 | 8 | same |
| Spec, GHK-Cu (peptide 26) 0-64 EU/mL, LOQ 3.75 | 9 | same |
| Cartridges 0.05 / 0.01 / 0.005 EU/mL | 1 / 2 / 3 | `POST /consumables` |
| Reader, serial STACK-READER-0001 | 4 | `POST /instruments` |
| Method "Endotoxin" rev 1: active, default for 234 only (as production's method 26), cartridges 0.05 (default), 0.01 and 0.005 | 21 | `POST /hplc/methods`, `PUT services`, `PUT consumables`, `activate` |

The seed leaves out the Peptide 0-350 EU/vial row, because rehearsal step 2 adds it through the spec editor (here, spec 10). **For the UAT stack, run the seed with `--with-eu-vial`.** Without that row, every peptide promote is refused "No active ... spec in EU/vial ...".

### The one SQL write (stands, per the controller's ruling)

The seed sets `lims_samples.sample_type_title` to `Peptide` or `Bacteriostatic Water`, on the 9 parents it uses, and only where the column is empty.

Why this one write is SQL:
- The golden has the column empty on all 39 parents (`sample_type` holds only SENAITE UIDs).
- Its only writer is `_populate_basic_info`, fed from SENAITE.
- The stack's SENAITE has none of these ARs ("SENAITE has no AR with id=P-0146" from `/debug/sample-registry`).

Without it, promote and the COA both call `normalize_matrix(None)`:
- every peptide row is refused "No active ... spec in EU/vial for any sample type";
- the bac water row resolves to the 0-5 catch-all.

### Vials

Each vial was set to role endo85 through `PATCH /api/sub-samples/{id}/assignment`. No analysis was seeded by that flip. Each then got one native analysis through `POST /api/lims-analyses`.

| Vial | Analysis | Role in the rehearsal | Row (worksheet 24) |
|---|---|---|---|
| P-0144-S02 (was xtra; parent anchored to BPC-157, which has a per-peptide EU/mL row) | 3614 | eligible peptide, "<" | item 71: 10 mg, 0.05 cartridge, reader import T-S3-A "<0.05", valid |
| BW-0010-S01 (was endo) | 3615 | eligible bac water; LOQ 0.1, not the spec's 0.2 | item 72: 0.005 cartridge, typed "<0.1" |
| P-0146-S01 | 3616 | Invalid | item 73: 10 mg, reader import T-S3-INV "<0.05", recovery 40 %, valid=False |
| P-0114-S01 | 3617 | inconclusive | item 74: 100 mg, total 1:5000, steps [[20, 50], null, null], typed "<0.05" |
| P-0115-S02 | 3618 | parent already holds a result | item 75: 10 mg, typed "<0.05" |
| P-0120-S01 | 3619 | concurrency row | item 76: typed "0.08" (40 EU/vial) |
| P-0121-S01, P-0123-S01 | 3620, 3621 | spares | items 77, 78: typed "0.1" and "0.06" |
| P-0155-S02 (golden, SENAITE-born ENDO-LAL 3607) | n/a | SENAITE-born | item 79: typed "<0.05" |

Notes on the rows:
- **Inconclusive.** The weight does not move the LOQ. `loqVial` is lambda x N x water, independent of mg. So the row is inconclusive through N = 5000: 0.05 x 5000 x 2 = 500 EU/vial, above 350. The brief's "heavy weight" is kept (100 mg), but the total is what makes the row inconclusive.
- **Parent holds a result.** The seed promoted sibling P-0115-S01 the old way: submit "1.2", then `POST /api/lims-analyses/promote` with EU/mL, no limits and the sample page's reason. That made parent row 3623. It is also rehearsal step 7's sample.
- **Method pinning.** Worksheet 24 ("Endo s3 rehearsal (2 mL)", `endo_prep` 2ml) was built with `create-from-drop` and `add-group`. The first typed reading pinned method 21 while only native rows were on it. The SENAITE-born row was added after that. A worksheet that mixes both services resolves no method, because service 77 has no default method here, as in production.

Each sample's matrix and peptide anchor, from `sample_peptide_id`:

| Sample | Matrix | Anchor |
|---|---|---|
| P-0144 | Peptide | 10 (BPC-157) |
| BW-0010 | Bacteriostatic Water | None |
| P-0120 | Peptide | None |
| P-0115 | Peptide | None |

## 4. Backend suites (Task Step 3)

### 4a. Full suite, failure-set diff: PASS

Each side ran with its own `init_db()` on a fresh `accumark_mk1_pytest`. The command was `python -m pytest -q -p no:cacheprovider --timeout=120 -rfE --continue-on-collection-errors`. The runner checked before each side that the engine named the scratch database: `engine database = accumark_mk1_pytest`.

These full runs were at `1b5317ed`. `da5bfc77` changes only `test_spec_unit_indexes_pg.py`, which skips without `MK1_TEST_POSTGRES_URL` and is covered in Step 4.

| Side | Result |
|---|---|
| branch | 159 failed, 4956 passed, 135 skipped, 4 errors (255 s) |
| base | 159 failed, 4840 passed, 132 skipped, 4 errors (241 s) |

- **Failing ids:** 163 on each side, and the two sets are identical. The branch has no new failure; 0 ids are base-only.
- **Collection errors:** none on either side.
- **Extra skips:** the branch has 3 more. They match `test_spec_unit_indexes_pg.py`'s 3 tests.

### 4b. The six named suites, and every slice 3 file, on their own

**Why per file, on a copy.** On an empty `init_db` schema the six named suites mostly skip ("no lims_sub_samples row available - seed via Receive Wizard"). In one process, module-level `app.dependency_overrides` leak between files, which turns some route tests into 401s. So each file ran in its own pytest process (`-rA`) on `accumark_mk1_pytest`, restored from a `pg_dump` of the stack's database. That copy includes the seed. It was dropped afterwards.

| File | Branch | Base |
|---|---|---|
| test_lims_analyses_routes | 21 passed, 1 failed | 21 passed, 1 failed |
| test_vial_retest | 13 passed | 13 passed |
| test_lims_analyses_service | 36 passed, 4 failed, 1 error | 36 passed, 4 failed, 1 error |
| test_promote_sets_source_promoted | 1 passed | 1 passed |
| test_variance_kind_gate | 4 passed | 4 passed |
| test_families_routes | 3 passed, 2 failed | 3 passed, 2 failed |
| test_coa_result_loq (new) | 10 passed | - |
| test_endo_worksheet_promote (new) | 48 passed | - |
| test_promote_flow (new) | 12 passed | - |
| test_result_limits (new) | 11 passed | - |
| test_spec_unit_aware (new) | 32 passed | - |
| test_blend_aggregates (modified) | 14 passed | 13 passed |
| test_native_parent_analyses_endpoint (modified) | 9 passed | 9 passed |
| test_service_spec_routes (modified) | 34 passed | 32 passed |

The failing ids are identical on both sides. All are pre-existing and none sits on slice 3 code:
- `test_lims_analyses_routes::test_transition_happy_path_to_verified`
- `test_lims_analyses_service::test_unassigned_to_verified_full_path`
- `test_lims_analyses_service::test_retract_from_verified_clears_verified_at`
- `test_lims_analyses_service::test_publish_on_vial_tier_row_raises_tier_mismatch` (TierMismatchError: vials never verify)
- `test_lims_analyses_service::test_list_variance_verifications_groups_by_vial` (failed, and an error)
- `test_families_routes::test_get_family_state_to_be_verified_when_vial_submitted`
- `test_families_routes::test_get_family_state_verified_when_only_analyte_promoted`

The `ERROR ... endo_worksheet_promote_failed` line in `test_endo_worksheet_promote`'s output is a captured log from its deliberate unexpected-error test. All 48 of its tests passed.

## 5. Postgres-only tests (Task Step 4): PASS at `da5bfc77`

Setup:
- Scratch database `accumark_mk1_migtest`, built by the branch's `init_db()`.
- Env: `MK1_DB_NAME` set to it, so the live-DB tests' `SessionLocal` points there and never at `accumark_mk1`.
- `MK1_TEST_POSTGRES_URL` assembled inside the container from its own env, never printed.
- Dropped after every run. `pg_database` now lists only `accumark_integration accumark_mk1 postgres template0 template1`.

| Test | Result |
|---|---|
| test_endo_v2_migration_pg (1) | PASS |
| test_spec_unit_indexes_pg (3) | **FAIL at `1b5317ed` (1 of 3); 3 passed at `da5bfc77`**, on a fresh `accumark_mk1_migtest` |
| test_hplc_native_schema (15 of 16, including live-DB `..._is_idempotent_and_preserves_oid`) | PASS |
| test_hplc_native_schema::test_slice1_boot_statements_execute_against_live_db | FAIL, identical at base (pre-existing; recorded, no action per ruling) |

### The first-pass failure

At `1b5317ed`, `test_spec_unit_indexes_pg.py:110` asserted the literal `"WHERE active"`. Postgres stores the predicate as `WHERE (active AND ...)`, the same stored form the stack's `pg_indexes` shows in Section 2.

- **Diagnostic.** A `/tmp` copy with only that literal changed passed 3/3.
- **Fix.** The controller committed it as `da5bfc77` (the one literal, nothing else).
- **Re-run at `da5bfc77`:**
  - `test_the_swap_replaces_the_old_indexes_and_a_second_boot_changes_nothing`: PASSED
  - `test_an_older_image_boot_is_undone_by_the_next_boot`: PASSED
  - `test_one_active_row_per_scope_and_unit`: PASSED

### The pre-existing failure

`test_slice1_boot_statements_execute_against_live_db` fails the same way on base (4efbd083, its own `init_db`, same scratch setup): `NotNullViolation: null value in column "received_at" of relation "lims_sub_samples"`. Its raw `INSERT INTO lims_sub_samples` omits a NOT NULL column. Not slice 3.

## 6. Launch rehearsal (Task Step 5): PASS

All steps went through the API (`rehearse.py` in the container's `/tmp`). Full requests and responses are in `~/endos3-suites/rehearsal-step*.txt`.

Over the rehearsal window the backend log shows:
- 0 `endo_worksheet_promote_failed`, 0 `endo_worksheet_promote_audit_failed`, 0 tracebacks, 0 HTTP 500s;
- one 502, the deliberate mk1-mode check in step 6.

| Step | Result | Evidence |
|---|---|---|
| 1. Boot | PASS | Section 2. |
| 2. Specs | PASS | See below. |
| 3. Promote (6 rows) | PASS | See below. |
| 4. Repeat | PASS | See below. |
| 5. Concurrency | PASS | See below. |
| 6. Verify and COA | PASS | See below. |
| 7. Unchanged path | PASS | See below. |

### Step 2: specs

`POST /analysis-services/234/specs` with `{matrix "Peptide", range 0-350, unit "EU/vial"}` and no LOQ answered **201**: spec 10, `loq: null`.

The active rows afterwards: 6 (catch-all EU/mL), 7 (BW), 8 (BPC-157), 9 (GHK-Cu) and 10. One row was added and none displaced.

A second active row in the same scope, `{matrix "Peptide", 0-300, unit " eu/VIAL "}`, answered **409**: "an active spec already exists for this tier ... deactivate it first" (the stored text has an em dash; paraphrased here).

### Step 3: promote

`POST /worksheets/24/promote` with items 71, 72, 73, 74, 79 and 75 in that order; each payload as `promoteCheck` builds it. **200.**

| Row | Sent | Answer |
|---|---|---|
| 71 P-0144-S02 | 25 EU/vial, loq 25, lod 0.05 | promoted, parent **3624** `parent_to_verify` |
| 72 BW-0010-S01 | 0.1 EU/mL, loq 0.1, lod 0.005 | promoted, parent **3625** `parent_to_verify` |
| 73 P-0146-S01 | 25 EU/vial | "Invalid: spike recovery 40 % outside 50-200 %" |
| 74 P-0114-S01 | 500 EU/vial, loq 500 | "inconclusive: LOQ 500 EU/vial is above the 350 limit" |
| 79 P-0155-S02 | 25 EU/vial | "manual entry: SENAITE-born endotoxin" |
| 75 P-0115-S02 | 25 EU/vial | "the parent already holds a result; retest the vial to replace it" |

Each refusal text is the module's constant, byte for byte, or the module's own f-string with these numbers.

The parent rows:
- **3624:** `result_value "25"`, `EU/vial`, `loq 25.0`, `lod 0.05`, `lod_unit EU/mL`, canonical, method 21.
- **3625:** `"0.1"`, `EU/mL`, `loq 0.1`, `lod 0.005`, `EU/mL`.

The vial rows are `promoted` and carry the same limits.

The transitions:
- the vial's submit: "promoted from worksheet WS-24 row P-0144-S02";
- the parent's auto: "promoted from sources [3614]; promoted from worksheet WS-24 row P-0144-S02".

BW-0010-S01's rows read the same way.

Two `endo_worksheet_promoted` audit rows, on entity 3624 and 3625. Both carry every provenance key: user_id, worksheet_id, item_id, sample_id, reading, reader_test_id, cartridge_type_id, cartridge_sensitivity, total_dilution, water_ml, value, unit, loq, lod and lod_unit.

| Key | 3624 | 3625 |
|---|---|---|
| reader_test_id | "T-S3-A" | "typed, no reader record" |
| total_dilution | 250 | 20 |
| water_ml | 2 | null |

Counts went from 1 to 3 parent rows (+2), and from 0 to 2 audit rows (+2).

### Step 4: repeat

The same request again answered **200**:
- 71 and 72: "already promoted";
- 73, 74, 79 and 75: their own step 3 reasons, unchanged.

Counts did not change (3 parent rows, 2 audit rows).

### Step 5: concurrency

Two processes released by a barrier, each with its own minted token and connection, both posting item 76 (P-0120-S01, 40 EU/vial, loq 25, lod 0.05).

| Process | Start | End | Answer |
|---|---|---|---|
| B | +0.000 s | +0.017 s | 200, promoted, parent **3626** |
| A | +0.000 s | +0.016 s | 200, refused "the parent already holds a result; retest the vial to replace it" |

- **A real race.** The two requests overlapped, and both passed the checks. The Postgres log at 19:49:03.097 shows `duplicate key value violates unique constraint "uq_lims_analyses_parent_service_root"`: the loser hit the unique index, `run_promote` raised `parent_row_already_exists`, and the row was answered with the parent-holds reason.
- **Outcome.** One live parent row (3626: 40 EU/vial, loq 25), one new audit row (2 to 3), no 500.

### Step 6: verify and COA

Verify, as reviewer `admin@accumark.local` (`POST /api/lims-analyses/{id}/transitions {kind: verify}`, the sample page's call): 3624, 3625 and 3626 each answered 200, `verified`.

**The mk1-mode 502, as the controller asked.** The stack started with `registry_read_source = {"sample_details":"mk1","samples_list":"mk1","worksheets_inbox":"mk1","coa_generation":"mk1","sample_status":"mk1"}`. `GET /samples/P-0144/coa-sections` answered **502**:

```
legacy rows: no legacy-family analyses found for P-0144 [em dash] refusing to assemble an empty results table (mirror gap?)
```

This is the existing mk1-mode legacy-rows preflight in `coa/legacy_rows.py`, not slice 3 code. It answered the same for P-0115, BW-0010 and P-0144 before the seed.

**The switch to production's mode.** `PUT /settings/registry_read_source` (the app's settings API) with the `coa_generation` key removed answered 200. The value is now `{"sample_details":"mk1","samples_list":"mk1","worksheets_inbox":"mk1","sample_status":"mk1"}`. `coa_generation_source()` falls back to `senaite`, which matches production (no `coa_generation` key there, per the controller). **endos3 is left in this mode.**

`GET /samples/{id}/coa-sections` (S2S), the endotoxin row:

| Sample | Result | Unit | `result_display` | `specification` | `conforms` |
|---|---|---|---|---|---|
| P-0144 | "25" | EU/vial | "< LOQ" | range 0-350 EU/vial, **loq 25.0** (the result's own; the spec row has none) | true |
| BW-0010 | "0.1" | EU/mL | "< LOQ" | range **0-0.25 EU/mL**, **loq 0.1** (the result's own, not the spec's 0.2) | true |
| P-0120 | "40" | EU/vial | null (a number above its LOQ) | range 0-350 EU/vial, loq 25.0 | true |

P-0144's anchor is BPC-157, whose per-peptide row (spec 8) is EU/mL. Its EU/vial result fell through to the Peptide EU/vial row, as `resolve_spec` intends.

### Step 7: the unchanged EU/mL path

P-0115's parent row 3623 came from the seed's old-way promote (sample page `/promote`): `"1.2" EU/mL`, `loq/lod/lod_unit null`, method null. Verified as the reviewer: 200, `verified`.

In senaite mode, `GET /samples/P-0115/coa-sections` gives the endotoxin row:

| Field | Value |
|---|---|
| result | "1.2" EU/mL |
| specification | range **0-5 EU/mL**, **loq 2.5** (the spec's) |
| conforms | true |
| result_display | "< LOQ" (1.2 is under the spec LOQ, the existing censoring rule) |

## 7. Pending: production queries before deploy (Handler approval each time)

Each needs the Handler's explicit approval at the time. Run it `SET TRANSACTION READ ONLY`, over Tailscale `root@100.120.92.93` only.

Queries 2 and 3 are blocking (preflight rulings, Task 9).

```sql
-- 1. Active specs whose unit differs from the service's catalog unit (A.0 item 3).
SELECT s.id, a.keyword, s.matrix, s.peptide_id, s.unit, a.unit
FROM analysis_service_specs s JOIN analysis_services a ON a.id = s.analysis_service_id
WHERE s.active AND lower(btrim(coalesce(s.unit, ''))) <> lower(btrim(coalesce(a.unit, '')));

-- 2. BLOCKING: certifiable mk1 parent results in a unit that is neither empty nor the
--    catalog unit. Any row with no spec in its own unit stops that COA after deploy.
SELECT a.keyword, la.result_unit, count(*)
FROM lims_analyses la JOIN analysis_services a ON a.id = la.analysis_service_id
WHERE la.lims_sub_sample_pk IS NULL AND la.provenance = 'canonical'
  AND la.review_state IN ('verified', 'published') AND a.origin = 'mk1'
  AND lower(btrim(coalesce(la.result_unit, ''))) NOT IN ('', lower(btrim(coalesce(a.unit, ''))))
GROUP BY 1, 2;

-- 3. BLOCKING (draft, from the Task 3 review ruling): services whose ACTIVE specs span more
--    than one normalized unit (empty/NULL counts as its own unit). Any service other than
--    281 (ENDOTOXIN-USP85LAL) stops the deploy until the Handler rules.
SELECT a.id, a.keyword, array_agg(DISTINCT lower(btrim(coalesce(s.unit, '')))) AS units
FROM analysis_service_specs s JOIN analysis_services a ON a.id = s.analysis_service_id
WHERE s.active
GROUP BY a.id, a.keyword
HAVING count(DISTINCT lower(btrim(coalesce(s.unit, '')))) > 1;
```

## 8. Concerns

1. **A pre-existing live-DB test failure.** `test_slice1_boot_statements_execute_against_live_db` is red at base too (its raw INSERT omits `received_at`). Not slice 3; recorded, no action.
2. **endos3 is left in senaite COA mode** (the `coa_generation` key removed), to match production. Any later mk1-mode COA check on this stack must put the key back first.
3. **Two seed shapes differ from production on purpose:**
   - the one `sample_type_title` SQL write (ruled to stand);
   - P-0144-S02 was an xtra vial before its flip to endo85.
4. **Applying the seed to endov2.**
   - **One branch has not run.** The "new revision of an existing active Endotoxin method" path is for endov2, where the v2 method is linked to ENDO-LAL and locked. It did not run on endos3, so check its output there.
   - **Use `--with-eu-vial`** for UAT.
   - **The preflight may stop it.** It refuses, writing nothing, if testers have since put any chosen native vial on an open worksheet. BW-0010-S01 is the likeliest: it was on the v2 worksheet before `uat_reader.py` removed it. If that happens, swap the named vial in `VIALS`/`FILLS` for a free one.
5. **Restaged in place.** The restage extracted over the mounted directory rather than `rm -rf` + re-mount, because removing a bind-mounted directory under a running container orphans `/app`. The tree is the same as a clean stage (Section 1).
