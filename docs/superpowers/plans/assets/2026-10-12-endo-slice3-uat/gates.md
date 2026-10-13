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
