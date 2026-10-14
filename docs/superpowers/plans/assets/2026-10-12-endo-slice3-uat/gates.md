# Endotoxin slice 3: gate results and launch rehearsal

Branch `feat/endo-slice3`. Base `feat/endo-worksheet-v2` @ 4efbd083. The gates ran on 2026-10-13.

## Gates

| Gate | Result | Record |
|---|---|---|
| Frontend typecheck, lint, ast-lint | PASS. Identical to base: tsc exits 0; 941 lint problems and 3 ast errors on both sides | `gates-frontend.md` |
| Frontend format | PASS. The only extra flagged files are the slice 3 plan and spec docs, the same `docs/superpowers` class base already flags (317 files); no `src/` file is flagged | `gates-frontend.md` |
| Frontend vitest | PASS. The branch has 9 failing tests, base has 13. The one extra is a 5 s timeout cascade in `analysis-profiles-coa-display.test.tsx`, an untouched file that runs at 4.1 to 5.0 s on both trees, so it is flaky | `gates-frontend.md` |
| Backend suites (stack container, scratch DB) | PASS. The branch and base fail the same 163 ids; the branch passes 4956 tests to base's 4840; every slice 3 file passes | `gates-backend.md` |
| Postgres-only tests | PASS. Index swap 3/3 and v2 migration 1/1. `test_hplc_native_schema` is 15/16; the one failure (its live INSERT omits `received_at`) also fails on base | `gates-backend.md` |

## Launch rehearsal (stack `endos3`, staged at da5bfc77)

This was a fresh stack from the 2026-09-11 golden, so v2 and slice 3 migrated together, as production will.

The golden has no native `ENDOTOXIN-USP85LAL` service. `seed_native_endo.py` builds a production-shaped one through the app's own API. It creates the EU/mL specs as on production, the "Endotoxin" method revision as the service's default, three cartridges and native vials on a 2 mL worksheet. It is re-runnable: a second run changes nothing.

1. **Boot.** PASS. The three `lims_analyses` columns are added, and the three unit-aware spec indexes replace the old names.
2. **Specs.** PASS. The Peptide 0 to 350 EU/vial row is accepted beside the EU/mL rows, and a duplicate in the same scope and unit gets 409.
3. **Promote.** PASS. The peptide and bac water rows are promoted to `parent_to_verify` with LOQ/LOD. The Invalid, inconclusive, SENAITE-born and parent-holds rows are refused with the exact reason texts, and the provenance audit rows are written.
4. **Repeat.** PASS. Every row is refused, with no new parent rows and no 500.
5. **Concurrency.** PASS. Two simultaneous requests for one row leave exactly one parent; the loser hit the unique index and was refused.
6. **Verify and COA.** PASS.
   - The peptide row shows "< LOQ" with LOQ 25 and is judged against 0 to 350 EU/vial.
   - The bac water row (0.005 cartridge, "<0.1") shows "< LOQ" with its own LOQ 0.1, not the spec's 0.2, and is judged against 0 to 0.25 EU/mL.
7. **Unchanged path.** PASS. An EU/mL result promoted the old way is judged against 0 to 5 EU/mL with the spec's LOQ 2.5.

The stack's `coa_generation` key was removed for steps 6 and 7, so it runs in `senaite` mode, which is production's effective mode (production has no key). The mk1-mode 502 is recorded in `gates-backend.md`. It comes from the existing legacy-rows preflight, not from slice 3.

## Still open before deploy

- **Read-only production queries.** These need the Handler's approval at the time; the drafts are in `gates-backend.md`.
  1. A.0 item 3's first query.
  2. A.0 item 3's second query. It is blocking.
  3. Services whose active specs span more than one unit. It is blocking: any service other than `ENDOTOXIN-USP85LAL` needs a ruling.
  4. Endotoxin vials by normalized sample type, including an empty one. The Peptide-scoped 350 EU/vial row matches only `Peptide` (and `Peptide Blend`). Any other or empty sample type is refused promote with "No active ... spec in EU/vial".
- **UAT with the Handler and Dennis (Step 6).**
  - Box 3 shows checkboxes only on eligible rows, with the reasons on hover.
  - The confirm dialog shows exactly what is sent.
  - Each row gets its own result.
  - The Promoted chip appears after a refresh.
  - Stock worksheets show nothing.
  - The sample page shows LOQ and LOD under the value, and the result's LOQ in the Spec column.
  - A regenerated COA preview prints "< LOQ".
  - Dark mode works.

## Slice 4

COA text macros: a profile's COA text may carry `{lod}`, and optional `[ ... ]` segments that disappear when there is no LOD. Branch `feat/endo-slice3` at `3d631b2e`. Base `99cd6e1e`, the commit before slice 4. It is code-identical to the brief's `aa39fc03`: `git diff aa39fc03 99cd6e1e` is one docs file. Run 2026-10-13.

### Gates

How they ran:
- On this machine, one process at a time, branch first, then base.
- Base ran in a temporary `git worktree add --detach` at `99cd6e1e`, removed afterwards with `git worktree remove`.
- The base tree's `node_modules` was a junction to the branch's. The package and config files are identical between the two commits.
- Before each `test_profile_coa_columns.py` run, `pg_stat_activity` on the host dev Postgres showed no other pytest session.
- Logs are in `C:/tmp/endo-s4-gates/`.

| Gate | Branch `3d631b2e` | Base `99cd6e1e` | Verdict |
|---|---|---|---|
| pytest `test_coa_text_macros.py`, `test_coa_text_macros_sections.py` | 37 passed | n/a (new files) | PASS |
| pytest `test_coa_result_loq.py`, `test_native_sections.py`, `test_coa_wire_document.py`, `test_coa_sections_endpoint.py` | 68 passed | 68 passed | PASS |
| pytest `test_profile_coa_columns.py` (host dev Postgres) | 15 passed | 10 passed | PASS (+5 new) |
| vitest `analysis-profiles-coa-display.test.tsx` | 6 passed | 5 passed | PASS (+1 new, the macro hint). No timeout; the slowest test took 3.1 s |
| `tsc --noEmit -p .` | exit 0, no output | exit 0, no output | PASS |
| eslint `AnalysisProfilesPage.tsx` | 6 errors | 6 errors | PASS, same set (see below) |
| prettier `--check` on the two touched files | page flagged, test clean | page flagged, test clean | PASS, same flagged set (see below) |

Notes on the frontend gates:
- **eslint.** Both sides have the same 6 errors:
  - 4 `no-non-null-assertion`, at lines 431, 432, 503 and 504;
  - 2 `react/no-unescaped-entities`, at 1392 and 1544 on the branch (1389 and 1541 on base). The 3-line hint moved them.
- **prettier.** The page file was already unformatted on base, with 656 lines of drift. The 3 hint lines follow the file's existing style and add 8 more.

### Stack check (`endos3`): PASS

**Restage at `3d631b2e6857d29ae69178927af76511f9241d51`.**
- **Method.** The documented `git archive HEAD | gzip | ssh ... tar -xz` flow, extracted in place over the mounted `~/worktrees/Accu-Mk1-endos3`, as in slice 3. Removing the bind-mounted directory would orphan `/app` (`gates-backend.md`, Section 1).
- **Same as a clean stage.** `git diff --name-status bf09757b HEAD` lists only added and modified files, none deleted.
- **`.staged-from-sha`** reads `3d631b2e...`.
- **Files.** In the container, the sha256 of `/app/coa/text_macros.py`, `/app/coa/native_sections.py` and `/app/main.py` matches `git show HEAD:`.
- **Reload.**
  - At 22:27:39Z, WatchFiles saw the change, and server process 17106 finished.
  - Process 19941 started, with startup complete at 22:27:41Z.
  - The only `migration_skipped` lines are the pre-existing `lims_analyses_review_state_check` constraint.
  - `/api/health` answered 200.

**How it ran.**
- All steps ran from one script, `s4check.py` in the controller scratchpad `endos3/`. It was copied to the container's `/tmp` and run with `docker exec -w /app -e PYTHONPATH=/app -e PYTHONDONTWRITEBYTECODE=1`.
- `stack_api.py` minted the token in the container for `stackdev@accumark.local`. The S2S token for `coa-sections` was read from the container env.
- The restore ran in a `finally` block.
- The full output is on the devbox, in `~/endos3-suites/s4-stack-check.txt`.

"The mockup text" below is the text the controller gave, abbreviated here as `Endotoxin testing performed ... (5 EU/kg x 70 kg, the whole vial as one dose). [LOD {lod}.]`.

| Step | Request | Status | Evidence | Result |
|---|---|---|---|---|
| 1. Restage | `git archive` in place, then the reload | health 200 | Above | PASS |
| 2. Record | `GET /analysis-profiles` | 200 | Profile 7 `endotoxin-usp85-lal`, archetype `limit_table`, `member_service_ids [234]`. `coa_method_text` is `null` | PASS |
| 3. Mockup text | `PATCH /analysis-profiles/7 {coa_method_text: <mockup>}` | 200 | Stored exactly as sent | PASS |
| 4a. `{lot}` | The same text with `[LOD {lot}.]` | 400 | `unknown COA text macro {lot}; supported: {lod}` (exact) | PASS |
| 4b. `{LOD}` | The same text with `[LOD {LOD}.]` | 400 | `unknown COA text macro {LOD}; supported: {lod}` (exact) | PASS |
| 4c. Nothing written | `GET /analysis-profiles` | 200 | Profile 7 still holds the step 3 text | PASS |
| 5. COA sections | `GET /samples/{id}/coa-sections` (S2S), for the three samples below | 200 each | See below | PASS |
| 6. Restore | `PATCH /analysis-profiles/7 {coa_method_text: null}`, then `GET` | 200, 200 | `coa_method_text` is `null` again. Each sample's sections equal the ones read before the first PATCH | PASS |

Step 5, the endotoxin section (`profile_key endotoxin-usp85-lal`) of each sample:

| Sample | `method_text` ends | Row: `result_display`, `specification.loq`, range |
|---|---|---|
| P-0144 (promoted peptide) | `... as one dose). LOD 0.05 EU/mL.` | `"< LOQ"`, 25.0, 0 to 350 EU/vial |
| BW-0010 (0.005 cartridge) | `... as one dose). LOD 0.005 EU/mL.` | `"< LOQ"`, 0.1, 0 to 0.25 EU/mL |
| P-0115 (EU/mL, promoted the old way, no LOD) | `... as one dose).` The segment is gone, with no trailing space | `"< LOQ"`, 2.5, 0 to 5 EU/mL |

- **The whole text was checked.** Each `method_text` was compared whole with `==`; only the end is shown above.
- **BW-0010 uses the same profile.** Service 234 is profile 7's only member.
- **The rows are unchanged.** They match the slice 3 record (`gates-backend.md`, Section 6, steps 6 and 7). Each is also identical, field for field, to the same row read before the first PATCH.
- **No text when the profile has none.** Before the PATCH and after the restore, every `method_text` was `null`.
- **Backend log, 22:28:24Z to 22:28:25Z.**
  - The PATCHes answered 200, 400 and 400, and the restore 200.
  - Every `coa-sections` call answered 200.
  - There were 0 tracebacks and 0 500s.

**State left on endos3.**
- Staged at `3d631b2e`.
- Profile 7's `coa_method_text` is `null`, as before.
- The COA mode is still senaite: `registry_read_source` has no `coa_generation` key.

**Hard rules kept.**
- Only endos3 was touched, and nothing was destroyed.
- No git ran in a container or in a devbox clone.
- No password was typed or printed.
- Nothing was written into `/app` except by the restage.
- No pytest ran on the stack.

## Slice 5

Method prep rules on the 2 mL worksheet. Branch `feat/endo-slice3` at `4c892267`. Base `c9ccd773`, the commit before slice 5. Run 2026-10-14, 23:02 to 23:28 UTC.

### Gates: PASS

How they ran:
- **Frontend.** On this machine, branch then base.
  - Base ran in a temporary `git worktree add --detach` at `c9ccd773`. Its `node_modules` was a junction to the branch's: `package.json` and `package-lock.json` are identical between the two commits.
  - The junction was removed first, then the tree with `git worktree remove --force`. No prune.
  - Findings were compared by `(file, rule, message)`, and vitest by failing test name.
  - Logs are in `C:/tmp/endo-s3-gates/s5-*.log`.
- **Backend.** In `accumark-endos3-accu-mk1-backend`, one pytest process at a time, branch then base.
  - Each tree ran from the container's `/tmp`.
  - Each run had a fresh scratch database built by that side's own `init_db()`, after a check that the engine named it. No suite touched `accumark_mk1`.
  - `pytest==9.1.1` and `pytest-timeout==2.4.0` were still installed from slice 3.
  - Logs are on the devbox, in `~/endos3-suites/s5/`.

| Gate | Branch `4c892267` | Base `c9ccd773` | Verdict |
|---|---|---|---|
| tsc (`npm run typecheck`) | exit 0 | exit 0 | PASS |
| eslint | 941 problems (839 errors, 102 warnings) | the same 941 | PASS. 0 new |
| ast-grep | 3 errors (`hooks-in-hooks-dir`: `hash-navigation.ts` 1, `read-source.ts` 2) | the same 3 | PASS. 0 new |
| prettier | 878 files flagged | 876 files flagged | PASS. See below |
| vitest, full suite | 7 failed, 2794 passed (355 files) | 15 failed, 2709 passed (352 files) | PASS. Every branch failure is in base's set; 0 extra |
| vitest, the named slice 5 files | `endo-prep-rules` 38, bench sheet 30, actions 10: 78 passed | n/a | PASS |
| pytest, full suite (`--continue-on-collection-errors`) | 159 failed, 5143 passed, 135 skipped, 4 errors (257 s) | 159 failed, 5030 passed, 135 skipped, 4 errors (254 s) | PASS. 163 failing ids on each side, identical; no collection errors |

Notes on the frontend gates:
- **Prettier is not a strict subset.** The branch flags 2 files base does not:
  - the slice 5 plan doc, a class base already flags (326 `docs/superpowers` files);
  - the new `backend/tests/fixtures/endo_prep_rule_cases.json`, also a class base already flags (3 backend fixture JSON files).

  No `src/` file is flagged.
- **Vitest.** The 7 branch failures are `App.test.tsx` (main window layout), `PackagingPanel`, `peptide-requests-list`, `worksheets-inbox-lanes`, `FlagsFlyout` (default tab) and two in `flag-stream-glue-invalidation`. All 7 fail on base too. Base's 8 further failures are in the flags suites, outside the slice 5 diff.

**Files run on their own.** Each file ran in its own process (`-rA`), on a fresh scratch database for each side.

| File | Branch | Base |
|---|---|---|
| `test_endo_prep_rules` | 29 passed | absent |
| `test_endo_prep_rules_api` (Task 2) | 30 passed | absent |
| `test_endo_prep_rule_rows` | 52 passed | absent |
| `test_spec_rules` | 42 passed | 40 passed |
| `test_worksheet_endo_prep` | 17 passed | 17 passed |
| `test_endo_worksheet_promote` | 62 passed | 62 passed |
| `test_endo_v2_worksheets` | 121 passed | 121 passed |
| `test_sla_schema` (host-DB) | 5 passed | 5 passed |
| `test_priority_migration` (host-DB) | 4 passed, 1 failed | 4 passed, 1 failed |
| `test_priority_embed` (host-DB) | 11 passed, 1 failed | 11 passed, 1 failed |
| `test_worksheet_department_schema` (host-DB) | 3 passed | 3 passed |
| `test_worksheets_inbox` (host-DB), default run | 23 skipped | 23 skipped |
| `test_worksheets_inbox`, `-m integration` | 4 passed, 19 errors | 4 passed, 19 errors, the same ids |

- **The two host-DB failures are the same ids on both sides,** and neither is slice 5:
  - `test_priority_migration::test_vial_keyed_sample_priorities_backfill_into_lims_sub_samples`
  - `test_priority_embed::test_sub_samples_list_rows_carry_priority_shape`
- **The default run of `test_worksheets_inbox` proves nothing.** The module is integration-marked, so every test skips.
- **Its `-m integration` run errors on both sides.** Its login fixture signs in as a user the scratch database does not hold. That log echoes the fixture's hard-coded test login, so only summary lines are quoted here.

**Postgres-only tests.**
- **Setup.** A scratch `accumark_mk1_migtest`, built by each side's `init_db()`. `MK1_TEST_POSTGRES_URL` was assembled inside the container and never printed. The database was dropped after each side.
- **Afterwards** `pg_database` lists only `accumark_integration`, `accumark_mk1`, `postgres`, `template0` and `template1`.

| Test | Branch | Base | Verdict |
|---|---|---|---|
| `test_hplc_native_schema`, in full | 15 passed, 1 failed | 15 passed, 1 failed | PASS. The failure is `test_slice1_boot_statements_execute_against_live_db` (its INSERT omits `received_at`), the known base failure |
| `test_endo_v2_migration_pg` | 1 passed | 1 passed | PASS |
| `test_spec_unit_indexes_pg` | 3 passed | 3 passed | PASS |

Part A wrote no slice 5 migration test (preflight F17).

### Stack check (`endos3`): PASS

**Restage at `4c89226719c5fae0e428331a2ff6a4d21f4492a1`.**
- **Method.** The documented `git archive HEAD | gzip | ssh ... tar -xz` flow, extracted in place over the mounted `~/worktrees/Accu-Mk1-endos3`, as for slice 4.
- **Same as a clean stage.** `git diff --diff-filter=D --name-only 3d631b2e HEAD` is empty.
- **`.staged-from-sha`** reads `4c892267...`.
- **Files.** In the container, the sha256 of `/app/endo_prep_rules.py`, `main.py`, `worksheets_endo.py`, `worksheets_endo_promote.py` and `database.py` matches `git show HEAD:`.
- **Reload.** uvicorn reloaded (process 55247) and `/health` answered 200.

**How it ran.**
- Every step went through the API, as `stackdev@accumark.local`, with a token minted in the container by `stack_api.py`.
- The scripts ran from the container's `/tmp`. They are kept in the controller scratchpad `s5t10/stack/` and on the devbox in `~/endos3-suites/s5/stack/`, with each output beside its script.
- The step 3 resolution, the coverage check and the summary render use the frontend's own functions. These were bundled from `src/lib`, run in headless Chromium, and fed the stack's own responses.

**Data built for the check.** The seed's API paths were used: each golden vial's role was set to `endo85`, and it got one native `ENDOTOXIN-USP85LAL` analysis.

| Worksheet | Title | Rows (item id, vial, weight) |
|---|---|---|
| 25 (L) | Endo s5 rule lifecycle (2 mL) | 80 P-0148-S01 10 mg BPC-157; 81 P-0149-S01 50 mg BPC-157; 82 P-0150-S01 5 mg AOD-9604; 83 P-0150-S02 20 mg AOD-9604; 84 P-0145-S01 10 mg, no catalog peptide; 85 P-0149-S02 10 mg BPC-157, switched to "no rule"; 86 P-0151-S02 10 mg BPC-157; 87 P-0155-S01 10 mg BPC-157 |
| 26 (A) | Endo s5 race A (2 mL) | 88 P-0149-S03, 89 P-0153-S06, and 92 P-0153-S05 (added after its print); 10 mg BPC-157 each |
| 27 (C) | Endo s5 race C (2 mL) | 90 P-0151-S01, 91 P-0153-S01; 10 mg BPC-157 each |

- **One SQL write, the seed's own.** `lims_samples.sample_type_title = 'Peptide'`, only where it was empty, on P-0148, P-0151, P-0153 and P-0155. Without it, a promote finds no EU/vial spec.
- **A side effect of the role change.** Moving P-0145-S01 out of the `hplc` role left P-0145 with no peptide anchor, so row 84 serves as a row with no catalog peptide.
- **Two vials could not be used.** P-0152-S01 and P-0152-S05 were refused with 409 `variance_locked`. P-0151-S02 and P-0153-S06 were used instead.

**Lifecycle.**

| Step | Request | Evidence | Result |
|---|---|---|---|
| 1. Boot | The restage reload | `endo_prep_rules` is present with its three FKs, and `worksheet_items` has `prep_rule` json, `prep_rules_off` boolean not null default false, `prep_note` text and `prep_history` json. The reload logged 2 `migration_skipped` lines, both the pre-existing `lims_analyses_review_state_check` constraint; none for the new table or columns | PASS |
| 2. Rules | `POST /endo-prep-rules` | Rule 1, BPC-157 `max_mg 30, total 300, trial`: 201, no warnings. Rule 2, BPC-157 any weight `total 400`: 201 with `overlaps rule 1 (up to 30 mg) for this peptide; where both match, the narrower band wins ...`. `total 15, step1_ratio 10`: 400 `total_dilution 1:15 is below 2 x the step 1 ratio 1:10, so step 2 cannot be made`, and not stored. Rules 3 (AOD-9604 up to 8 mg, 1:500, step 1 1:20, validated) and 4 (AOD-9604 any weight, the 0.01 cartridge) were added for the render | PASS |
| 3. Live | `GET /worksheets/25`, `GET /endo-prep-rules` | Row 80: `sample_peptide_id` 10, unlocked. The browser's `endoRowsFor` resolves row 80 to rule 1 (total 300), and the server's `match_rule` gives the same answer on the same data. Every other row resolves as expected (81 rule 2, 82 rule 3, 83 rule 4, 84 and 85 none) | PASS |
| 4. Print lock | `POST /worksheets/25/printed`, then `PATCH /endo-prep-rules/1 {total_dilution: 350}` | 200. Every row not switched to "no rule" has `locked_by "print"`: 80, 86 and 87 on rule 1 at 300, 81 on rule 2, 82 on rule 3, 83 on rule 4, 84 on the standard. Row 85 has no lock. After the edit, rows 80, 86 and 87 still show 300 | PASS |
| 5. Re-apply | `GET` then `POST .../prep-rules/reapply {item_ids: [80]}` | The preview lists 80, 86 and 87, each old 300, new 350. The POST returns `applied: true`. Row 80 is now `locked_by "reapply"` at 350; its `prep_history` has one entry (`reapply`, the print lock at 300); there is one `endo_prep_rule_reapplied` audit row, old 300, new 350 | PASS |
| 6. Override | Row 81: `PATCH` reading 0.1 with cartridge 1, then `PATCH prep_total_dilution 500` | The first reading wrote no history and no override audit (A.0 item 5). The override wrote one history entry (`override`, total 400, reading 0.1, the print lock) and one `endo_prep_override` audit row, `{prep_total_dilution: null}` to `{500}`. The lock is kept | PASS |
| 7. Promote | Row 80: reading 0.1 with cartridge 1, then `POST /worksheets/25/promote` with value 70, LOQ 35, LOD 0.05, the browser's numbers at the ruled total: 0.1 x 350 x 2 mL | `promoted: true`, parent analysis 3643, `parent_to_verify`. The `endo_worksheet_promoted` audit carries `total_dilution` 350, the locked line | PASS |
| 8. Rollback rehearsal | A.0 item 11's SQL on `accumark_mk1`, with `ROLLBACK` in place of `COMMIT` (`ON_ERROR_STOP`) | The read-only check lists 13 ruled rows. Inside the transaction the updates changed 11 totals, 1 cartridge (row 83: 2), 1 step 1 ratio (row 82: `[[null, 20], null, null]`) and 0 partial steps. All 13 rows read `materialised = t`. Row 81 keeps its typed 500. A fingerprint of every `worksheet_items` typed prep column (37 rows) is `04c0ee6a...` before and after the rollback | PASS |
| 9. Complete | `POST /worksheets/25/complete`, then `GET` and `POST .../prep-rules/reapply` with all 8 ids | 200. The preview is `{"candidates": []}`. The POST refuses all 8 with `the worksheet is completed` | PASS |
| 10. Clean up | `PATCH /endo-prep-rules/{1..4} {active: false}` | All 4 rules are inactive (0 of 4 active). Worksheets 25, 26 and 27 stay as rehearsal data | PASS |

**Concurrency checks on real Postgres.**

Each check sent two genuinely concurrent requests. Two OS processes each minted their own token and sent one request; the server gave each its own DB session.

To force overlap:
1. A third `psql` session took `SELECT ... FOR UPDATE` on the contended row and held it for 7 s.
2. Both requests were sent while it held the lock.
3. `pg_stat_activity` showed both backends waiting on a lock (`wait_event_type = Lock`), one behind the holder and one behind the other request.
4. The holder rolled back. It wrote nothing.

The backend log for the whole check has 0 tracebacks, 0 500s and 0 deadlocks. The only 4xx lines are the expected ones: the 400 floor refusal, the `variance_locked` 409, check c's 409, and the same 409 from the stall probe in Observation 1.

| Check | Row held | Requests, in send order | Outcome | Result |
|---|---|---|---|---|
| a. First reading against first print (worksheet 26, unpinned, unprinted) | `worksheets` 26 | `POST /printed`; `PATCH` item 88 first reading 0.1 + cartridge 1 | Both 200. Print committed first, so both rows are `locked_by "print"` on rule 1 at 300 and row 88 holds the reading. `printed_at` is set, and the method is pinned once: one `endo_method_pinned` audit row, `endo_method_id` 21 | PASS |
| b. Completion against Re-apply (worksheet 26) | `worksheets` 26 | `POST .../prep-rules/reapply [88]`; `POST /complete` | Both 200. Re-apply won: row 88 was applied at 350 (23:24:36.793). Completion then locked row 92, added after the print, `locked_by "complete"` (36.807), and completed the worksheet | PASS |
| c. Override PATCH against promote (row 90) | `lims_analyses` 3641 | `POST /promote` row 90 at its locked 300 (value 60, LOQ 30); `PATCH` item 90 `prep_total_dilution 500` | Promote won: `promoted: true` at the locked 300, although rule 1 reads 350 by then. The PATCH got 409 `the row is promoted; its prep is final`. Row 90 has no history entry and no `endo_prep_override` row, and its total is unchanged. No history was lost | PASS |
| d. Reader import against promote (row 91) | `lims_analyses` 3642 | `POST /promote` row 91; `POST /reader-import`, the same reading 0.1 and cartridge with a new `test_id` | Promote won, and the import answered 200 `applied: 0`. My runner cut the import's response before its `skipped` field; the row shows no reader record and no `endo_reader_imported` row. Re-run on row 87 (P-0155-S01, analysis 3637) with the runner fixed: promote won, and the import answered `applied: 0, skipped: [{item_id: 87, sample_id: P-0155-S01, reason: "the row is promoted; its prep is final"}]` | PASS |
| e. Two Re-apply POSTs on one row (row 89) | `worksheets` 26 | `POST .../prep-rules/reapply [89]`, twice | The first applied. The second got `nothing to re-apply: the row already matches today's rule`. Row 89 has one history entry and one `endo_prep_rule_reapplied` audit row | PASS |

**The summary-page render (Task 9).**
- **Inputs.** Worksheet 25 as read back after step 4's print, with its locks, through `buildEndoSheet2Doc` and `buildEndoBenchSheet2Html`, the functions the Print button calls. Also the stack's rules, cartridge catalog and lab calendar.
- **Measurement.** A Chromium PDF, plus each `.page`'s height in print media at 1026 x 733.
- **Due dates.** The `/sla/status` due dates, under the default tier, give one due date: every row joined that day. A second render forces six distinct due dates onto the same rows (the ceiling case). The page's own tier resolution was not reproduced.

| Render | Rules listed under "Method rules used" | Due dates | PDF pages | Summary page height | Result |
|---|---|---|---|---|---|
| Stack data | 4 (rules 1 to 4, with counts and notes) | 1 | 2 (1 table + 1 summary) | 680.3 px of 733 | PASS |
| Six due dates forced | 4 | 6 | 2 | 694.5 px of 733 | PASS |

The table page shows the ruled steps boxed, with `1:15 · rule (trial)` on step 2, `1:20 · rule` on step 1 of the AOD 5 mg row, and `0.01 R` on the AOD 20 mg row's cartridge.

**Rows the browser counts as endotoxin (`row_facts` coverage): PASS.**
- **Method.** After a print, the browser's `isEndoWorksheetItem` ran over the read-back worksheet. Its rows were diffed against the rows that carry a `prep_rule`.
- **Worksheets 25 and 26.** Every endotoxin row not switched to "no rule" is locked. Row 85 ("no rule") is not.
- **Worksheet 24 (the slice 3 rehearsal sheet), printed for this check.** All 9 rows count as endotoxin and all 9 are locked:
  - the promoted rows 71, 72 and 76;
  - bac water row 72, locked to the standard;
  - SENAITE-born `ENDO-LAL` row 79 (role `endo`).
- **No gaps.** No endotoxin row is unlocked, and no other row is locked.

**State left on endos3.**
- Staged at `4c892267`.
- Rules 1 to 4 are inactive.
- Worksheets 25 and 26 are completed and 27 is open. All three stay as rehearsal data.
- Worksheet 24 is printed once.
- Promotes made:
  - row 80: parent analysis 3643;
  - row 90: 3644;
  - row 91: 3645;
  - row 87: 3646.
- Profile 7's `coa_method_text` is still `null`. The COA mode is still senaite: `registry_read_source` has no `coa_generation` key.

**Hard rules kept.**
- Only endos3 was touched, and nothing was destroyed.
- No git ran in a container or in a devbox clone.
- No password was typed or printed.
- Nothing was written into `/app` except by the restage.
- One pytest process ran at a time, and only on scratch databases.
- No product code changed.

### Observations for the Handler

1. **An async route's lock wait stalls the whole backend.** The item PATCH and `complete` are `async def`, and slice 5 gave both a `FOR UPDATE` wait.
   - **Verified on this stack** (one uvicorn process): while the PATCH waited on a held worksheet row, a `GET /health` sent 1 s later was answered only when the lock was released, 3.7 s later.
   - **Effect on the checks.** The async request queues behind any lock wait, so checks a, b and c could only produce the sync-request-first order.
   - **Not checked:** production's worker count.
   - **How long it lasts.** The stall lasts as long as the competing transaction. That was not measured for promote, Re-apply or the reader import. Moving those two routes to `def` would remove the stall.
2. **Rows read before slice 5 take today's rules at their first print.** Worksheet 24's rows had readings entered before slice 5 and no lock. Its print locked row 71 (P-0144-S02, promoted at 1:250) and the SENAITE-born row 79 to rule 1's 1:300 (B5, as designed).
   - Production has no such rows, because v2 ships in the same release.
   - endov2 was not checked. Any 2 mL row there that has a reading from before slice 5 and no lock will take today's rule at its next print, including a row already promoted.
3. **An orphan worktree admin directory.** `Accu-Mk1/.git/worktrees/mk1-s5-base` was left behind after `git worktree remove` (Windows refused the delete: Permission denied), beside the existing `s5-draft-A` one. The working tree itself is gone, and no prune was run.

### UAT notes for Dennis

- Ruled steps are boxed on paper like any non-standard step (A.0 item 6, as he asked). The render above shows it.
- A ruled total prints as step 2's derived ratio, for example `1:15 · rule` for a 1:300 total, because the 2 mL sheet has no total column. Ask whether that label suits him.
- In Box 2, typing the ruled value on a row with a typed override returns the row to following the rule (spec D6).
- Print records first and prints from the server's locks, so a cancelled print still counts as printed.
