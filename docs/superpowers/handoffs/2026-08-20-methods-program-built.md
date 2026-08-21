# Handoff: Methods/Instruments Program — built (3 slices), live on arcitest, Handler UAT open

*Created 2026-08-20. Paste this into a fresh session to resume with full context. Sibling arc thread: `C:\tmp\Accu-Mk1-manage-analyses\docs\superpowers\handoffs\2026-08-19-native-manage-analyses.md` (manage-analyses slice — still open, Handler UAT round 2 on P-0157).*

---

You're picking up the **methods/instruments program** for Accu-Mk1: generic analytical methods for every test family (not just HPLC), method↔service catalog links with per-service defaults, locally-registered instruments, bench stamping of method+instrument onto analysis rows, and an ISO-17025-shaped controlled-document lifecycle (draft→active→retired revisions, immutable issued content, S3 attachments, audited CRUD). It went spec (3 docs) → plan (3 docs, 26 tasks) → full subagent-driven build (~10 review-driven fix rounds, 3 opus whole-branch reviews) → merged into the arcitest composition and verified live. **Handler UAT is open**; the push/PR decision is not yet made. Drive whatever the Handler asks; the three SDD ledgers are the complete decision record.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Methods worktree (THE program; KEEP until merge) | `C:\tmp\Accu-Mk1-methods` | `feat/methods-controlled-docs` (top of the 3-branch stack) | `87e971c0`, clean tree except deliberate `?? .baseline_ids.txt`, **UNPUSHED to origin** |
| — stack below it | same worktree's repo | `feat/methods-bench-stamping` @ `5f9509f7` → `feat/methods-foundation` @ `3926903f` → cut from `b0ba8573` (#106 head) | all UNPUSHED |
| Local merge composition (never push to origin) | `C:\tmp\Accu-Mk1-arcimerge` | `arcitest/methods-merge` | `0c6fa5b0` — pushed to the DEVBOX clone only |
| Devbox arcitest (LIVE UAT surface) | `forrestparker@100.73.137.3:~/worktrees/mk1-arcitest` | `arcitest/mk1-full` | `0c6fa5b0`; `package-lock.json` dirty ON PURPOSE, leave it |
| Specs + plans (master copies) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` (main checkout) | `docs/analysis-catalog-specs` @ `91c85d93` | specs `2026-08-19-methods-{foundation,bench-stamping,controlled-documents}-design.md`, plans same-named under `plans/`; working copies also at `C:\tmp\2026-08-19-methods-*.md` |
| SDD ledgers (EVERY ruling/fix-round, RETAINED deliberately) | `C:\tmp\Accu-Mk1-methods\.superpowers\sdd\2026-08-19-methods-{foundation,bench-stamping,controlled-documents}\progress.md` (+ task briefs/reports/review diffs) | | |
| Memory file (kept current) | `C:\Users\forre\.claude\projects\C--Users-forre-OneDrive-Documents-GitHub-Accumark-Workspace\memory\project_methods_instruments_program.md` | | |

## What's on the branches

**Layer 1 — foundation (`feat/methods-foundation`, 16 commits to `3926903f`).** `hplc_methods` generalized in place (R1): `code/technique/department_id/reference/procedure_summary/supersedes_id/origin`, date-gated `technique='HPLC'` backfill, partial-unique `code`. New `method_services` m2m with `is_default` + DB-enforced one-default-per-service (partial unique, mirrored models.py+DDL). Method CRUD drops `senaite_id` (R0), gains the generic fields; `GET/PUT /hplc/methods/{id}/services` (replace-set, 400 names default conflicts, working IntegrityError→409 backstop — the first fix attempt was INERT because Core `db.execute(insert())` emits immediately, final review caught it); `AnalysisServiceResponse.default_method_id` (LIST route only, fail-open: NULL unless the default's method is active). `DELETE /hplc/methods` 409s once any `lims_analyses` row references it. Instruments: local `POST/PATCH` (R0: no senaite fields ever), `department_id`+`origin`; sync stamps `origin='senaite'` now; Sync button demoted to "Sync from SENAITE (legacy)". FE: MethodsPage/MethodPanel with Covered Services editor; InstrumentsPage add/edit.

**Layer 2 — bench stamping (`feat/methods-bench-stamping`, 12 commits to `5f9509f7`).** `worksheet_items.instrument_id` FK (local-instrument leg; `instrument_uid` = frozen SENAITE leg, R0). `stamp_method_instrument` no-commit core + `STAMPABLE_STATES=(unassigned,assigned,to_be_verified)` guard + `StateLockedError`→409 `{code:"state_locked"}` (prep_bridge's early-state stamping unaffected — it pre-filters `unassigned`). Submit-time stamping rides `apply_transition`'s PRE-EXISTING 2026-08-10 fold-in (R-P2-1 — the plan's approach would have double-written transitions); non-submit kinds carrying the fields 400. Bulk verb `POST /worksheets/{id}/apply-method-instrument`: coverage-scoped (only `method_services`-covered analyses), state-pre-filtered, one transaction, response reports `skipped_state`/`skipped_uncovered`. Worksheet payload: `stamped_method_name`/`stamped_instrument_name` (distinct→name, >1→"mixed", dead rows excluded per R-P2-2). FE: drawer apply bar (remount-keyed reset on worksheet switch), stamped display precedence, native items' instrument select id-keyed, `SetMethodInstrumentDialog` per-row override (serviceId via serialized `analysis_service_id`, R-P2-3).

**Layer 3 — controlled documents (`feat/methods-controlled-docs`, 16 commits to `87e971c0`).** `status/revision/activated_at/retired_at` in lockstep with `active`; index migrations (name constraint → `(name,revision)`; code → `(code,revision)` + one-active-per-code). Creates mint DRAFTS; PUT rejects `active` (400) and 409s locked-field edits once issued/referenced (locked: name/code/technique/reference/procedure_summary + 4 HPLC params; editable: notes/department/instruments). Verbs: `new-revision` (clones content+service links `is_default=False`+instrument links, never senaite_id), `activate` (defaults AND — per Handler ruling R-P3-6 @ `87e971c0` — **peptide links transfer from the superseded source**; retires ANY same-code active per R-P3-2), `retire`. `method_attachments` (S3 via photo_storage; upload any status, delete draft-only, download = authed blob fetch per R-P3-4, empty upload 400s). CRUD audit via `catalog/change_log` (create/log_create, edits/apply_and_log, instruments too). FE: lifecycle verbs behind confirms, locked-field DetailRows, revision **family** history (R-P3-5 — chain-walk dropped parallel siblings), attachments block, `coa_method_text` "Suggest from methods" on the profile editor, prep-wizard method picker filtered to active (final-review F1).

**Layer 4 — arcitest composition merge (2026-08-20).** Merged locally in `C:\tmp\Accu-Mk1-arcimerge` (9 conflicts, all unions), pushed to the devbox clone (`devbox` remote = `forrestparker@100.73.137.3:/home/forrestparker/accumark-repos/Accu-Mk1`), ff-merged onto `arcitest/mk1-full` (now `0c6fa5b0`, which also permanently commits the previously hand-copied help-guide files as `19e71cbf`). Backend restarted; **all migrations verified applied** (6 columns, 3 indexes, name constraint gone, `method_services`/`method_attachments`/`catalog_change_log`/`worksheet_items.instrument_id` present); live smoke: 18 methods with correct backfills.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| 🔴 **The composition's S4 `catalog_change_log` is a SUPERSET of slice 3's port** | slice 3 cherry-picked S4's `f430a966` as `381a6bef` (ruling R-P3-1) because the audit infra existed only on the unmerged S4 branch; at arcitest-merge time the composition's evolved version won (extra route-audit tests). When the real PRs land, whichever of S4/this-stack lands second sees duplicate-but-identical hunks; `database.py` may conflict trivially (adjacent appends) | **The PR body for `feat/methods-controlled-docs` MUST state the shared content**; resolve any conflict by taking the S4 side for the 4 ported files |
| **`.baseline_ids.txt` keeps getting swept into commits** | untracked 68-id pytest baseline at `C:\tmp\Accu-Mk1-methods\.baseline_ids.txt`; it was accidentally committed and re-untracked THREE times this build | it must stay untracked; check `git status` before any commit/tar; deploys tar gitignored/untracked files — clean first |
| **`C:\tmp` node_modules get EXTERNALLY EMPTIED** (recurred this session) | `C:\tmp\Accu-Mk1-manage-analyses\node_modules` went to 0 entries mid-merge; junctions pointing at it broke silently ("npm install typescript" errors from npx) | populated stores: `C:\tmp\Accu-Mk1-amendment-audit\node_modules` (482), main checkout (484). Re-point junctions: `cmd /c "mklink /J node_modules C:\tmp\Accu-Mk1-amendment-audit\node_modules"` |
| **Composition baseline failure ≠ merge damage** | `tests/test_catalog_change_log.py::test_create_service_group_writes_create_log_row` fails on arcitest: an S-slice 410'd service-group creation ("service groups are legacy"), S4's test expects 201 — verified failing at the PRE-merge commit `19e71cbf` | pre-existing; don't chase; the composition owns it (S4's own PR will reconcile) |
| **Backend restart REQUIRED after merging into arcitest** | slice-3 migrations include `DROP CONSTRAINT hplc_methods_name_key` etc.; hot-reload doesn't run `_run_migrations()` — without restart every lifecycle verb 500s on missing `status` | `ssh forrestparker@100.73.137.3 'docker restart accumark-arcitest-accu-mk1-backend'` (~15s), then `/health` via 5812. Same applies to ANY future env this deploys to (prod runbook) |
| **The `/api`-DOUBLE on arcitest** | port 5812 = FE/Vite proxy stripping one `/api`; lims-analyses router has its own `/api` prefix, methods routes don't | lims-analyses: `http://localhost:5812/api/api/lims-analyses/...`; methods: `http://localhost:5812/api/hplc/methods`; login `POST /api/auth/login` (e2e@accumark.local / E2e-Verify-9931) |
| **Creates mint DRAFTS now** | any script/test that POSTs a method then expects it usable (default resolution, bulk apply) fails until `POST /hplc/methods/{id}/activate` | activate after create; pickers only ever show active |
| **Parallel sibling drafts: links/defaults land on whichever activates FIRST** | activating sibling B after A finds the shared predecessor drained; B ends active with no defaults/peptide links (A retired holding them) — mirrors accepted defaults semantics, ledgered informational | revise serially (normal workflow); if it ever bites, re-link manually via MethodPanel |
| **`revision` is invisible on certificates by design** | COA `_method_label` prints method NAME; revisions share names — UAT must not expect rev 1 vs rev 2 COAs to differ | open Handler ruling: print `code Rev N` (COABuilder wire touch, own slice) |
| **Devbox pushes are composition-only** | `devbox` git remote now exists on the main checkout; `arcitest/*` branches live ONLY on the devbox clone | NEVER push `arcitest/*` or the merge branch to origin; origin pushes remain Handler-gated |

## Infrastructure state

- **arcitest stack** (devbox `forrestparker@100.73.137.3`, ports 5800–5819): FE/proxy `:5812` (health 200 verified at handoff time), raw backend `:5810`. Backend container `accumark-arcitest-accu-mk1-backend` runs `--reload` on the bind-mounted `~/worktrees/mk1-arcitest` — FE changes hot-serve; backend model/migration changes need the docker restart. Postgres `accumark-arcitest-postgres`, DB `accumark_mk1`, `psql -U postgres`.
- **Nothing pushed to origin/GitHub.** The three `feat/methods-*` branches exist locally (+ the merge branch on the devbox clone only). Prod untouched.
- Local FE tooling: worktrees `C:\tmp\Accu-Mk1-methods` and `C:\tmp\Accu-Mk1-arcimerge` have `node_modules` junctions → `C:\tmp\Accu-Mk1-amendment-audit\node_modules` (arcimerge) and → `C:\tmp\Accu-Mk1-manage-analyses\node_modules` (methods — 🔴 that target is currently EMPTY, re-point before running FE tools there).
- No `backend/.env` in either worktree (deliberate — an empty-token .env fakes +23 failures).

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Program backend suites | `cd C:\tmp\Accu-Mk1-methods\backend && C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_methods_catalog.py tests/test_methods_stamping.py tests/test_methods_lifecycle.py` (last: 15+19+31 green incl. R-P3-6's 3) |
| Full-suite gate | same interpreter, `-m pytest -q -p no:cacheprovider -rf`, diff `grep -E "^(FAILED\|ERROR) tests/" \| sort` against `C:\tmp\Accu-Mk1-methods\.baseline_ids.txt` (68 ids) — empty diff required |
| FE (methods worktree — fix the junction first) | `npx vitest run src/test/methods-catalog-fields.test.tsx src/test/instruments-page-local.test.tsx src/test/method-lifecycle-ui.test.tsx src/test/coa-method-text-suggest.test.tsx src/test/worksheet-apply-method.test.tsx src/test/set-method-instrument-dialog.test.tsx src/lib/__tests__/method-attachment-download.test.ts && npx tsc --noEmit` |
| Merged composition (arcimerge worktree) | backend battery above + `tests/test_catalog_change_log.py tests/test_native_manage_analyses.py` (last: 136 passed + 1 PRE-EXISTING fail); FE battery + help-guide + native-manage suites (last: 41/41) |
| Live stack | `ssh forrestparker@100.73.137.3 'curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://localhost:5812/health'` → 200; methods smoke: login then `GET http://localhost:5812/api/hplc/methods` |

## Outstanding items the user may want next

1. **Handler UAT on arcitest** — suggested drive: LIMS → Methods (create draft w/ code+technique → Covered Services + default → link instrument → attach SOP → Activate); LIMS → Instruments (Add Instrument, local); Worksheets → hm#1 drawer apply bar (stamp covered analyses, see skip reporting + stamped columns); wrench per-row override on `mk1:` rows; New Revision → Activate flip (defaults + peptide links move); profile editor "Suggest from methods".
2. **Push + PRs decision** — three stacked PRs (foundation → stamping → controlled-docs), base `feat/coa-display-fields` (#106) like PR #108. PR body for controlled-docs MUST carry the R-P3-1 shared-content note (S4).
3. **Open Handler ruling: print `code Rev N` on certificates** (spec §7 of the controlled-docs design; touches COABuilder wire; own small slice).
4. **Slice-2 follow-up riders** (assessed no-interaction, deliberately NOT folded into slice 3): `.where(LimsAnalysis.retested.is_(False))` on the stamped-name reader (main.py ~19495); "Stamped 0" idempotent re-apply toast copy (WorksheetDrawer); `item.instrument_id` name resolution on completed rows (WorksheetDrawerItems ~333).
5. **Parked findings** (full context in the slice-3 ledger): F3 name-keyed `max_rev` 500 via draft-rename (repro in ledger); `delete_method` unaudited + S3-orphan on cascade (ISO follow-up); EditableSelectCell offers unfiltered catalog vs the dialog's scoped options (pre-existing divergence).
6. **Later programs ledgered**: instrument calibration/maintenance event log; per-matrix method defaults; approval/e-signature workflow (slice 4 if ISO demands).
7. Still open from sibling threads: manage-analyses Handler UAT round 2 (P-0157) + its integration choice; moisture COA arming on P-0157 (profile 7 `coa_archetype`); PR #108 help-guide UAT.

## User collaboration preferences

- Full pipeline for features (brainstorm → spec → plan → SDD with per-task review + final whole-branch review); rulings by exception, every one ledgered with cost-if-wrong; reviewer prompts never pre-judge findings.
- Conversational clarification over MCQ; absolute paths everywhere; NAME the environment (arcitest ≠ s3rehe ≠ prod); npm only in Mk1 FE; **never push to origin / merge without the word** (devbox-clone pushes for compositions are established practice); gate by failure-SET diff, never zero-failures.
- R0 program-wide: zero new SENAITE coupling — any new code touching a SENAITE surface is a spec violation.
- Handler drives UAT personally in the UI; when they report a bug, diagnose from the DB first, propose, get the nod, then build.

## Recommended first action in the new session

Confirm the three anchors still match this doc, then take whatever the Handler reports from UAT:

```bash
git -C C:/tmp/Accu-Mk1-methods log --oneline -1        # expect 87e971c0
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/mk1-arcitest log --oneline -1; curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://localhost:5812/health'   # expect 65cf1848, 200
git -C "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1" log --oneline -1  # expect 91c85d93 on docs/analysis-catalog-specs
```

---

## ADDENDUM 2026-08-20 (later session): master sync — anchors moved

All four arcitest worktrees were brought current with their `origin/master`s ahead of deployment:

- **Mk1: `arcitest/mk1-full` is now `65cf1848`** (= `0c6fa5b0` + `origin/master` `eb498674`, the v1.7.5
  variance-series fix PR #107). Clean merge (the program never touched `backend/coa/variance_series.py`);
  same flow as Layer 4: merged in `C:\tmp\Accu-Mk1-arcimerge` on `arcitest/methods-merge` (also now
  `65cf1848`), battery 153 passed + only the documented pre-existing change_log fail, pushed to the
  devbox clone, ff-only on the worktree, backend restarted, health 200, 18-method smoke green.
- **WP: `arcitest/wp-s9` is now `092ed819`** (merged master 2.42.1, PR #45). Conflicts were version
  metadata only — CHANGELOG unioned, `style.css` kept the composition's `Version: 2.44.0`. The badge
  v1.6.0 hand-copies are intact and still uncommitted (PR #45's files don't intersect them).
- **IS (`arcitest/is-full`) and coabuilder (`arcitest/coab-full`) already contained master** — untouched.

Everything else in this doc is unchanged and current.

**Later that day — UAT round-1 slices:** `feat/methods-controlled-docs` tip is now `506fe5cd`
(`a68bf107` = services picker on the create form + MethodsGuide + panel empty-state hint +
ResizeObserver test stub; `506fe5cd` = AnalysisServicesGuide + SENAITE sync buttons removed from
the services/instruments pages, stale sync copy repointed — backend sync routes untouched per R0).
Arcitest composition + `arcitest/mk1-full` are at `37955381`. Anchor expectations: methods worktree
`506fe5cd`, arcitest `37955381`. 🔶 Open Handler ruling: Preferences → Data Pipeline still has the
SENAITE sync buttons + peptide seeder (last remaining sync UI surface).
