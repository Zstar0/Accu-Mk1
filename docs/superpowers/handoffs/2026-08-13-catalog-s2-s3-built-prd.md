# Handoff: Catalog Foundation — S2+S3 built and PR'd (#103/#104), arc deploy plan published

*Created 2026-08-13. Paste this into a fresh session to resume with full context.*

---

You're picking up the Catalog Foundation Hardening program after its closing build session: S2
(worksheets/inbox off service groups) and S3 (native identity convergence, the centerpiece) were
built end-to-end through the subagent pipeline (plan → fresh implementer per task → task review →
fix loops → full-suite failure-set gate → final whole-branch review on the strongest model → one
fix wave → scoped re-review), pushed, and opened as PRs #103/#104. The arc-wide merge/deploy plan
is committed AND pushed on the docs branch. 8 of 9 slices are now built; S9 remains (needs Handler
sign-off on the `derive_base_demand` retirement). Your job is to drive whatever the user asks
next: likely merge coordination, the S3 pre-deploy gate runs, UAT support, or S9.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| S2 worktree | `C:\tmp\Accu-Mk1-s2-worksheets` | `feat/s2-worksheets-off-groups` | `405fffd8` (19 commits, **PR #103**) |
| S3 worktree | `C:\tmp\Accu-Mk1-s3-identity` | `feat/s3-identity-convergence` | `db844425` (21 commits, **PR #104**) |
| Mk1 main checkout (docs) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` | `docs/analysis-catalog-specs` | `b81954b4` (specs + deploy plan, **pushed**) |
| S1/S4/S6/S8 worktrees | `C:\tmp\Accu-Mk1-{s1-roles,s4-catalog-log,s6-hygiene,s8-adoption-guard}` | per 2026-08-13 AM handoff | PRs #99-#102 |
| Amendment-audit (base) | `C:\tmp\Accu-Mk1-amendment-audit` | `feat/analysis-amendment-audit` | `b30d9fc0` (PR #98) |

All six slice branches are siblings off `b30d9fc0`; PR base `feat/analysis-amendment-audit`.
Merge order: **#97 → #98 first**, then #99-#104 in any order (GitHub auto-retargets).

Key artifacts:
- **Arc deploy plan (merge order, conflict playbook, gates, backfills, UAT, rollback):**
  `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-08-13-catalog-foundation-deploy-plan.md` (committed `b81954b4`, pushed)
- S2/S3 sub-specs + S9 inventory: same specs dir, same commit.
- Slice plans (untracked in each worktree): `C:\tmp\Accu-Mk1-s2-worksheets\docs\superpowers\plans\2026-08-13-s2-worksheets-off-groups.md` and `C:\tmp\Accu-Mk1-s3-identity\docs\superpowers\plans\2026-08-13-s3-identity-convergence.md`
- SDD ledgers (every ruling, deferred minor, adjudication, UAT note — the richest record):
  `C:\tmp\Accu-Mk1-s2-worksheets\.superpowers\sdd\2026-08-13-s2-worksheets-off-groups\progress.md` and
  `C:\tmp\Accu-Mk1-s3-identity\.superpowers\sdd\2026-08-13-s3-identity-convergence\progress.md`
- Session scratchpad (baseline-failed-set.txt + recovered dossiers): `C:/Users/forre/AppData/Local/Temp/claude/C--Users-forre-OneDrive-Documents-GitHub-Accumark-Workspace/5469cda1-d3cd-413c-9736-0d8229e79f9e/scratchpad/` (session-scoped — may not survive; the committed specs + ledgers carry the load-bearing content)

## What's on the branches

**Layer 1 — S2 (#103), departments own routing.** `worksheet_items.department_id` + group-bridge
backfill; stamping resolves department-first with a vial-role fallback (P-0146-S04 class closed);
`_item_scope_filter`/`_first_item_in_scope` replace the five `gid_filter` copies (ordered
`.first()` + ambiguity warning); department on the add/staging wire (precedence, disagreement 400,
unknown-gid 400 stale-client hardening); **merge-all staging** (a department is one lane);
path-param item routes deleted; inbox shim deleted — lanes, claims, staging map, and the NATIVE
EMITTER all speak department identity (the emitter port was a mid-task premise correction: dev's
group/dept id coincidence masked a real cross-write); four-state `department_name` chain ending in
fail-visible `"Legacy"`; COA gate transition union with the **Handler-RULED HM exemption**
(`test_heavy_metals_exempt_ruling_2026_08_12` carries the do-not-revert docstring); FE wave (all
inbox-derived senders flip to `department_id`, dept-shaped storage keys with legacy read-fallback,
frozen ServiceGroupsPage with membership editing intact).

**Layer 2 — S3 (#104), service-id identity.** `backend/scripts/s3_identity_precheck.py` = the
complete two-part deploy gate (canary-first violations, exit 0/2/3, diagnostics ALWAYS run,
cross-origin keyword-collision diagnostic folded in by the final fix wave); the two service-id
root indexes byte-faithful to their keyword twins + post-boot `verify_identity_indexes` ERROR +
placeholder-coexistence pin (protects WP-3280/P-0145); shared `_find_active_parent_row` three-leg
resolver (explicit id → exact stored keyword → mk1-scoped catalog rescue on miss;
`allow_native_rescue=False` at the SENAITE webhook — implementer-caught hazard, cross-origin
collisions are NOT index-prevented); seeder union skip (id OR keyword — RULED, pinned by a
discriminating test); additive `analysis_service_id` params on add/delete with the service-id
duplicate guard; pin-staleness OR-form monotone freshness; `analysis_service_id` on the
senaite-shape wire + FE tier-0 join (ladder: 0 id · 1 keyword · 2 identity bridge · 3 analyte
bridge) + ast-grep rule; keyword-identity AST guard (5 SHRINKING with real retirement conditions ·
22 PERMANENT with reasons · per-file floors · disjointness).

**Layer 3 — closure.** Both final whole-branch reviews (fable) returned "With fixes"; one fix wave
each (`405fffd8`, `db844425`), scoped re-reviews clean. Docs branch pushed. PR bodies carry the
deploy gates and merge-interplay notes.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **S3's index CREATE fails SILENTLY** (`migration_skipped` noise class) | Violating rows → index absent → every converged reader trusts an unenforced invariant | `python scripts/s3_identity_precheck.py --env-label {s3rehe\|prod}` on BOTH envs BEFORE deploy, environment named; exit 3 → human dedupe first; exit 2 → migration-mechanism investigation FIRST. Local dev proves nothing (0 mk1 services in its catalog). |
| **S2's rollback unit is FE+BE together** | Inbox wire re-means `group_id` to department identity; FE-only rollback or stale desktop client sends dept ids as `service_group_id` (masked on dev where id spaces coincide) | Deploy FE+BE as one unit; backend now 400s unknown gids (fail-visible). Plan the desktop-client skew window. |
| **S2-merge and S1-merge each touch S3's guard** | The guard asserts SHRINKING entries still match; S2 rewrites `list_worksheets`' block; S1 supersedes `select_services_for_role`'s in-code pin | On S2 merge: DELETE the `main.py::list_worksheets` SHRINKING entry in `C:\tmp\Accu-Mk1-s3-identity\backend\tests\test_identity_convergence_guard.py` (never weaken the assertion). On S1 merge: reclassify `seeder.py::select_services_for_role`. |
| **S1+S4 merge interplay** (from AM session, still live) | Both append to the migrations tail; S4's `VIAL_ROLE_LOG_FIELDS` lacks S1's display-face columns | Keep both migration blocks any order; whichever merges second extends `VIAL_ROLE_LOG_FIELDS` (flagged in #100's body). Same tail-append class recurs for S2+S3. |
| **Shared dev Postgres residue fakes regressions** | Both full-suite gates saw exactly ONE new failure: `TestVialPlanSections::test_sections_locked_...` failing on a stale `ZZTEST-SEC-LOCKED` row (created 2026-08-12 by an interrupted run); `-k retest` also hits `TEST-UNPROMOTE`/`TEST-PM7-PARENT` residue from 2026-08-09 | Gate = failure-SET diff vs `baseline-failed-set.txt` (67F/14E at `b30d9fc0`) + isolated re-run; attribute residue by querying row `created_at`, don't fix blind. |
| **FE lint/format/ast are RED at baseline in BOTH fresh worktrees** (511 eslint problems, prettier failing pristine files, 3 hooks-in-hooks-dir) | Absolute-green FE gates are impossible; naive gating would block everything | Gate FE by failure-set/changed-line diff only. typecheck IS absolutely clean. Recorded eslint 9.39.2 / prettier 3.7.4 — likely fresh-install version drift; not investigated further. |
| **The 3 drop-in-txn precheck tests take ACCESS EXCLUSIVE on `lims_analyses`** | Brief cross-worktree blocking/flake window during test runs | Plain DROP inside the rolled-back txn + `SET LOCAL lock_timeout='5s'` is by design; isolate on flake. |
| **`ast-grep-ignore` directives must carry the BARE rule id** | Trailing prose after the id silently breaks suppression AND the error still fires | Reason on the line above; directive line = id only (documented in the rule's note). |
| **Reviewer/implementer first send often fails silently** | ~8 agents this session went idle without their report arriving | Nudge with "a PARTIAL report labeled as such beats silence" — every one delivered on the nudge. |
| **Bash cwd drifts between worktrees in this session pattern** | Two ledger appends and one task-brief landed against the wrong repo before being caught | Always `cd` explicitly (or `git -C`) per command; never rely on prior call's cwd. |

## Infrastructure state

- **Nothing new was deployed anywhere.** Prod: IS 1.0.18 · COA 2.30.2 · Mk1 1.7.4 · theme 2.37.6
  (per memory; COA bumped by a parallel session 2026-08-13). The catalog layer is still
  s3rehe-only, NOT in prod — prod's FIRST boot of this arc runs all catalog migrations/seeds
  (heavy; review that boot's logs once, per the deploy plan §4).
- **Stack `s3rehe`** (devbox `forrestparker@100.73.137.3`): untouched this session; SENAITE
  counter collisions P-0147…P-0155 still unburned (they're S8's quarantine UAT scenario).
- **Local dev Postgres** (`localhost:5432/accumark_mk1`): schema-ahead as documented, now
  additionally carrying S2's `worksheet_items.department_id` and S3's two indexes; plus the stale
  ZZTEST/TEST-* fixture residue rows noted in gotchas.
- **Backend venv** (all worktrees): `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe`
- **node_modules installed** in both S2 and S3 worktrees (plus S1 from the AM session).
- Main checkout has unrelated dirty files (`AGENTS.md`, `CLAUDE.md`, `scripts/check_statuses.sh`,
  `scripts/deploy.sh` modified; many old handoffs untracked) — left alone deliberately; the two
  2026-08-06 placeholder-program specs are deliberately NOT in the docs commit.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| PR state | `gh pr list --repo Zstar0/Accu-Mk1 --limit 10` |
| Branch heads | `git -C C:\tmp\Accu-Mk1-s2-worksheets log --oneline -3` · same for `C:\tmp\Accu-Mk1-s3-identity` |
| S2 backend slice tests | `cd C:\tmp\Accu-Mk1-s2-worksheets\backend && <venv python> -m pytest tests/test_worksheet_item_scope.py tests/test_worksheet_analyst_stamp.py tests/test_coa_gate_departments.py tests/test_service_groups_freeze.py -q` |
| S3 backend slice tests | `cd C:\tmp\Accu-Mk1-s3-identity\backend && <venv python> -m pytest tests/test_identity_precheck.py tests/test_identity_indexes.py tests/test_identity_convergence.py tests/test_identity_convergence_guard.py -q` |
| S3 deploy gate (local smoke only) | `cd C:\tmp\Accu-Mk1-s3-identity\backend && <venv python> scripts/s3_identity_precheck.py --env-label local-dev` |
| Full-suite gate (either worktree, NEVER two at once) | `<venv python> -m pytest tests/ -q` → diff sorted FAILED set vs the 67-failure baseline (re-derive from `b30d9fc0` if the scratchpad copy is gone) |
| FE gates (either worktree) | `npm run typecheck` (must be clean) · `npm run test:run` (diff vs 5-file/6-test flaky baseline) · `npm run ast:lint` (S3 rule must pass; 3 hooks-in-hooks-dir findings are pre-existing) |

## Outstanding items the user may want next

1. **Merge coordination** — order #97 → #98 → #99-#104; per-merge conflict playbook is §2 of the
   deploy plan (S1+S4 tail conflict + `VIAL_ROLE_LOG_FIELDS`; S2→S3 guard entry deletion; S1→S3
   guard reclassification).
2. **Run the S3 pre-deploy gate on s3rehe and prod** and report results with environments named —
   required before ANY deploy of this arc. Prod mechanism: `docker exec -w /app -i accu-mk1-backend python < script`.
3. **S9** — inventory is committed; centerpiece (`derive_base_demand` legacy-wins retirement)
   still needs Handler sign-off as a production demand change; must build on the branch carrying
   the sterility 2→1 fix (lives only in the s3rehe stack worktree).
4. **UAT after merge/deploy** (deploy plan §6): S1 vial sub-line + usp71 badge; S8 quarantine
   (burn the SENAITE counter first); S4 change-log + reprovision; S2 lanes/drag-drop/prep-flag
   fallback + HM COA exemption; S3 drifted-retest + catalog-rename no-longer-orphans.
5. **Handler backlog items surfaced this session** (in the S3 ledger): `delete_pristine_analysis`
   keyword-path retirement is UNOWNED; COA pin storage constraints (ruled out of S3);
   `retest_of_id` term in the seeder skip (production behavior change if added); deferred-minor
   backlogs triaged in both final reviews ride in the ledgers.
6. **Standing items untouched:** S5 (waits on IS registry PRs #94/#27), S7 (waits on S2 merge),
   secrets rotation 🔴, spec-4 UAT deltas, placeholder-branch veto window.

## User collaboration preferences

- **Rulings by exception**: plan-text details are the controller's to rule (ledger them, surface
  in the final report); genuine forks and production behavior changes go to the Handler. This
  session's controller rulings (B+C retest design, union skip, merge-all staging, emitter port,
  unknown-gid 400) all followed that doctrine; the Handler's pre-baked rulings (HM exemption,
  additive params, deferred retirement) were implemented and test-pinned, never re-litigated.
- **Verify, don't assume; name the environment.** Two premise corrections came from implementers
  verifying spec claims against code (retest readers are keyword-only on the wire; the native
  inbox emitter was NOT exempt) — reward the BLOCKED-with-evidence pattern, never punish it.
- **Additive only; failing test = stale test by default; never push without asking** (this
  session's pushes/PRs and the docs commit+push were each explicitly directed).
- npm only in Mk1 FE; absolute paths always; `lims_` prefix; conversational clarification over MCQ.

## Recommended first action in the new session

Confirm state, then ask what to drive:

```bash
gh pr list --repo Zstar0/Accu-Mk1 --limit 10
git -C /c/tmp/Accu-Mk1-s2-worksheets log --oneline -2
git -C /c/tmp/Accu-Mk1-s3-identity log --oneline -2
```

If the user says "merge them": follow the deploy plan
(`C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-08-13-catalog-foundation-deploy-plan.md`)
§1-§2 exactly — #97 first, and remember the S3-guard edits at S2/S1 merges. If "run the gate":
item 2 above, both environments, named.
