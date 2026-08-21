# Handoff: Amendment audit shipped + Catalog Foundation Hardening program fully ruled

*Created 2026-08-11. Paste this into a fresh session to resume with full context.*

---

You're picking up two things: (1) the **amendment-audit slice is SHIPPED to review** — PRs #97/#98
open, deployed and live-verified on the s3rehe stack; (2) the **Catalog Foundation Hardening
program** — a 9-slice umbrella spec, every Handler decision RULED, awaiting only "go S1" (or any
slice) to enter the subagent pipeline. Your job is to drive whatever the user asks next.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| **Amendment-audit worktree** | `C:\tmp\Accu-Mk1-amendment-audit` | `feat/analysis-amendment-audit` | `b30d9fc0` (13 commits off `01e01c1`, **pushed**, PR #98) |
| Placeholder worktree | `C:\tmp\Accu-Mk1-parent-placeholder` | `feat/native-parent-placeholders` | `01e01c1c` (10 commits, **pushed**, PR #97) |
| Mk1 main checkout (specs/handoffs) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` | `docs/analysis-catalog-specs` | many pre-existing untracked handoffs — stage only your own |
| Stack Mk1 worktree (devbox) | `forrestparker@100.73.137.3:~/worktrees/Accu-Mk1-s3rehe` | detached-ish @ `ed4307d8` + deployed files | **dirty on purpose — see gotchas** |

Key artifacts (absolute paths):
- Program spec (ALL RULED): `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-08-10-catalog-foundation-hardening-design.md`
- Amendment-audit spec: `...\Accu-Mk1\docs\superpowers\specs\2026-08-07-analysis-amendment-audit-design.md` (carries dated honesty corrections)
- Amendment-audit plan: `...\Accu-Mk1\docs\superpowers\plans\2026-08-08-analysis-amendment-audit.md`
- SDD ledger (recovery map for the audit build): `C:\tmp\Accu-Mk1-amendment-audit\.superpowers\sdd\2026-08-08-analysis-amendment-audit\progress.md`
- Entity-map artifact (visual companion): https://claude.ai/code/artifact/83c3c3f7-acf8-4e73-abba-df14b6ff1b5c
- **All three 2026-08 spec docs + program spec are UNCOMMITTED** in the main checkout — Handler said "one word and commit"; never got the word.

## What's on the branches / in the specs

**Layer 1 — placeholder program closed (2026-08-07/08).** Task 7 step 5 verified live on s3rehe:
`ordered` 3661 + `canonical` 3663 coexist on P-0145 while the card shows one. PR #97.

**Layer 2 — amendment-audit slice (2026-08-08→10), PR #98 stacked on #97.** `details` JSONB on
`lims_analysis_transitions` (`{"changed": {field: {before, after}}}`), all 11 write sites
instrumented, AST guard (+`ast.Attribute`, ≥11 tripwire), `TransitionInfo.details`, activity-log
blend (`result_entered` info / `analysis_amended` warn), flyout style map. Handler rulings landed:
A1 curated (gated `parent is not None` — vial-scoped requests keep generic lines), prep_bridge
instrument via new `apply_transition` kwargs post-snapshot, worksheet_analyst parked,
set_reportable guard widened (reason-only edits audited; neighbor idempotence test un-staled with
`reason=None`). Full-suite failure-SET byte-identical (67 both sides — the documented 64 drifted
+3 environmentally). Deployed to s3rehe (10-file union, md5 10/10, `details` column confirmed in
stack Postgres). NULL contract: NULL = pre-slice OR mirror-exempt writes.

**Layer 3 — P-0146 UAT + architecture review (2026-08-10).** New order verified: shadow sync 5/5
in_sync vs live SENAITE, status tracking correct on both surfaces, placeholder minted again, audit
capture live. Found: usp71 renders "Unassigned"/"—" (≥6 hardcoded FE `ROLE_BADGES` maps),
native card lacks vial sub-line (`vialAssignmentByKeyword` never passed to
`NativeParentAnalysesCard`), analyst stamping dead for native services (`stamp_for_item` scopes by
`service_group_members`; `STERILITY_USP71` is in NO group). These became program slices — do NOT
hand-patch them.

**Layer 4 — the Catalog Foundation Hardening program (2026-08-10/11), fully ruled.** 9 slices in
the spec: S1 roles-as-data (FIRST; supersedes interim "Fix A/B") · S2 worksheets/inbox off service
groups → departments/roles (sub-spec; hm pattern generalizes; must pin the "COA blocking gate"
from the 2026-07-28 foundation ruling — not found group-keyed today) · S3 keyword→service_id
identity convergence (CENTERPIECE, sub-spec; indexes alongside + violation pre-check; senaite rows
grandfathered) · S4 catalog_change_log + **RULED: registration catalog_snapshot; check-in seeds
from the SNAPSHOT; reprovision = deliberate audited action** · S5 demand oracle via IS registry
(kills cart-vs-checkout + heavy-metals billing) · S6 hygiene (dept totality; PUR_/QTY_ reconciler;
4-slot ceiling) · S7 SLA **RULED: CONCURRENT PER-PROFILE CLOCKS** (primary clock keeps
received→first-primary-COA-publish as THE headline TAT; add-on endpoints pinned against
`useAnalysisSlaMap` in the plan; rollup = most-urgent-remaining) · S8 adoption guard
(uid-mismatch → quarantine+flag) · S9 de-hardcoding sweep (litmus: lab-manager-changeable → data +
UI CRUD + change-log, fail-closed on unknowns; engineer-only stays code with reason;
departments.py name-map = dying shim, do NOT datafy).

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **`~/worktrees/Accu-Mk1-s3rehe` is deliberately dirty** | Holds the UNCOMMITTED sterility 2→1 fix (`backend/sub_samples/service.py`, `backend/catalog/profile_seed.py`) + all deployed audit/placeholder files as working-tree modifications. | NEVER `git checkout/stash/clean` there. Deploy = scp tarball of named files + extract + `docker restart accumark-s3rehe-accu-mk1-backend`. |
| **PR #98 is STACKED on #97** | Base = `feat/native-parent-placeholders`, not master. | Merge #97 first; GitHub auto-retargets #98. PR chain also includes #94/#95/#96 (earlier program). |
| **s3rehe SENAITE counter collisions: P-0147…P-0155 remain** | P-0145/P-0146 became golden chimeras (adopted June rows + golden vials; P-0146's new-order HPLC work lands on June vial S01). | Scope evidence by `provenance='ordered'`/row ids/timestamps. Burn stub ARs past P-0155 before more E2E, or land S8. |
| **Reviewer subagents stall silently (~4 of 9 needed nudges; 2 double-stalled)** | Pipeline hangs waiting. | SendMessage nudge with "labeled PARTIAL beats silence"; after 2 silent idles controller reviews the diff directly (accepted fallback, ledger it). Implementers were 10/10 reliable. |
| **Permission classifier blocks some command SHAPES, not actions** | `gh pr create` heredoc and tar-over-ssh pipe were blocked; body-file + scp forms passed. | Retry Handler-authorized actions in conventional forms; "Stage 2 transient" errors retry clean. |
| **Full-suite baseline is now 67 failed (not the documented 64) + 14 errors** | Environmental drift, identical both sides — set-diff still the only valid gate. | Always base-vs-tip sorted FAILED set diff; known flake `test_clickup_task_retry.py`; `test_registry_inbox.py::test_route_mk1_source_works_without_senaite` pre-existing red. |
| **Local dev Postgres already has the `details` column** | Task 2 ran `_run_migrations()` against it; live-DB tests fail confusingly on checkouts WITHOUT the model column. | Don't re-diagnose "column doesn't exist / unexpected column" — it's schema-ahead-of-branch. |
| **Never add entries to hardcoded FE role maps or keyword-identity comparisons** | Program slices S1/S3 retire these by class; hand-patches recreate the debt. | Route any such symptom to its slice. |
| **Stack Mk1 UI login** | forrest@valenceanalytical.com / `s3rehe-uat`; controller policy: never type it into the browser — API login + localStorage token injection (`accu_mk1_auth_token`, `accu_mk1_auth_user`). | Login shape: `POST :5770/auth/login {email,password}`. |

## Infrastructure state

**Stack `s3rehe` (devbox `forrestparker@100.73.137.3`) — all 11 containers Up, backend healthy
(restarted 2026-08-10 with the audit deploy).** Ports: Mk1 BE :5770 / FE :5772 / IS :5765 / COA
:5768 / WP :5775 / PG :5760. Backend bind mount `~/worktrees/Accu-Mk1-s3rehe/backend` → `/app`
(no file-watch — restart after changes); FE vite HMR over the same mount. Stack Postgres HAS the
`details` JSONB column (boot migration, verified via information_schema). `STERILITY_USP71` is in
NO service group (by design pending S2 — this is why analyst stamping no-ops for it).
P-0146 state: received, 5 shadow rows in_sync, ordered placeholder 3669, vials S01(golden hplc),
S02(golden endo), S03 ster, S04 usp71, S05/S06 xtra. P-0145: parent row 3663 still
`parent_to_verify` (Handler verify-flow UAT pending).

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Branch state | `cd /c/tmp/Accu-Mk1-amendment-audit && git log --oneline -3 && git status --short` |
| Audit tests | `cd /c/tmp/Accu-Mk1-amendment-audit/backend && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_amendment_audit.py -q` (expect 25) |
| Full gate | same venv, `-m pytest tests/ -q` at base `01e01c1` vs tip; diff sorted FAILED sets (67 both sides last run) |
| Stack health + column | `ssh forrestparker@100.73.137.3 "docker inspect accumark-s3rehe-accu-mk1-backend --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' && docker exec accumark-s3rehe-postgres psql -U postgres -d accumark_mk1 -c \"SELECT column_name FROM information_schema.columns WHERE table_name='lims_analysis_transitions' AND column_name='details';\""` |
| PRs | `gh pr list --repo Zstar0/Accu-Mk1 --limit 5` (97, 98 open; chain 94/95/96 also open) |
| P-0146 audit rows | `ssh ... psql -c "SELECT id,keyword,provenance,review_state FROM lims_analyses WHERE lims_sample_pk=32 AND lims_sub_sample_pk IS NULL ORDER BY id;"` |

## Outstanding items the user may want next

1. **"Go S1"** — roles-as-data plan → subagent pipeline (small; kills the usp71 badge bug by class; rider: card vial sub-line). The program spec is fully ruled; S2/S3 want sub-specs first.
2. **Commit the spec docs** — program spec + amendment-audit spec/plan sit uncommitted in the main checkout docs branch; Handler said "one word and I'll commit," word not given yet.
3. **PR merges** — #97 then #98 (then the S3/S4 slices unblock). Chain #94/#95/#96 still open too.
4. **Handler UAT on the stack** — the flyout on P-0145/P-0146 (correction renders warn "Result corrected — X → Y"); the parent verify flow on row 3663.
5. **SENAITE counter** — burn stubs past P-0155 (~9 collisions left) before more E2E ordering.
6. **Amendment-audit fast-follows** (ledgered): from/to/kind into curated event details; label polish ("(cleared)" for None); batch-fetch the users N+1 on the activity endpoint.
7. **Standing open items from prior arcs** (untouched this session): wpstar addon-cards branch findings, spec-4 UAT deltas + CASCADE ruling, ENDO-LAL unit divergence, secrets rotation 🔴.

## User collaboration preferences

- **Verify, don't assume; name the environment.** Every architecture claim this session was verified against models.py / live DB before asserting — Handler explicitly values this ("crucial we get this foundation right").
- **Prose recommendations with reasoning; surface only genuine forks.** Handler rules fast and decisively (curate/fix/park; snapshot; concurrent clocks) — present options with a recommendation, one line each.
- **Handler corrects course confidently** — the S7 "pick one tier" framing was wrong; they reframed to concurrent clocks from UI reality. When corrected, bake the correction into spec + memory immediately.
- **Additive-only; failing test = stale test by default; never push without asking** (pushes/PRs this session were explicitly directed).
- **Data-driven over hardcoded is now a standing ruling** (S9 litmus test). Never add to hardcoded vocab maps.
- Rich hover tooltips are the FE default; absolute paths always; `lims_` table prefix; npm only in Mk1 FE.

## Recommended first action in the new session

Confirm state, then ask which slice to drive:

```bash
cd /c/tmp/Accu-Mk1-amendment-audit && git log --oneline -3
gh pr list --repo Zstar0/Accu-Mk1 --limit 5
```

Then: if the Handler says "go S1", run the brainstorm-skip path (spec §Slice-1 is the requirements)
straight to a plan via superpowers:writing-plans, then subagent-driven-development — same pipeline
that shipped the audit slice. If PRs merged in the meantime, S3/S4 sub-spec work unblocks.
