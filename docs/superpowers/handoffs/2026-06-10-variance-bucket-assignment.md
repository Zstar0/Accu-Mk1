# Handoff: Variance-Bucket Assignment — indicators shipped+verified; explicit-assignment re-architecture spec+plan ready to execute

*Created 2026-06-10. Paste this into a fresh session to resume with full context.*

---

You're picking up the Mk1 sub-vial variance arc on `subvial/continue`. This session **shipped + live-verified** two variance-indicator features, then **pivoted to a re-architecture**: variance becomes an *explicit per-vial assignment* (`assignment_kind: core|variance`) set at check-in, replacing the implicit demand-math model. The spec and a 6-task implementation plan are written and committed but **NOT executed** — that's the main outstanding work. Nothing pushed (82 ahead of origin; push only when asked). Your job: drive whatever the user asks next, most likely executing that plan.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Mk1 worktree (this session) | `C:/tmp/Accu-Mk1-subvial` | `subvial/continue` | `2c19e66` (82 ahead of origin; unpushed) |
| Integration-service | `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service` | — | untouched this session |

Dirty/untracked: only pre-existing noise (`package-lock.json` M; older handoff/plan/spec `.md`s untracked). All session work is committed.

## What's on the branch (this session, oldest → newest)

**Layer 1 — variance-gated indicator (`db938d6` spec … `0f613a9`):** membership "Variance" chip on variance-series analysis rows (`isVarianceMember`/`showVarianceChip`/`VarianceChip`, suppressed on promoted/variance_verified), `Variance ×N` pill on the AssignStep HPLC bucket, and a bulk **"Verify (Variance) selected"** toolbar action (`deriveBulkActions.showVarianceVerify`). Two follow-up fixes (toast past-tense `c2fcdfb`, in-progress label `0f613a9`). All two-stage reviewed, all approved.

**Layer 2 — sub-sample name treatment (`8d0478a` spec … `f3e6faa`):** backend per-parent `variance:{hplc,endo,ster}` map on the aggregates endpoint (`75d8704`, reads `variance_override`); analysis-table first-column vial refs get sky text + `Layers` icon when variance (`b653b6a`+`9935f10`); SenaiteDashboard parent-row flag + sub-name treatment via `parentHasVariance`/`subIsVarianceMember` (`f513862`+`f3e6faa`).

**Layer 3 — live-debugging fix (`829ce36`):** Surface A (analysis-table vial coloring) **passed all unit tests but rendered nowhere** — entitlement was gated to vial pages while the vial-list overlay only renders on parent pages (mutually exclusive), and it keyed every vial to the table `primaryRole` (wrong for endo/ster on a mixed parent). Fixed by fetching the parent's own entitlement (`vialListVarianceEntitlement`) and carrying each vial's own `assignment_role` through `VialMatch`. **Live-verified in the browser** on PB-0076 (S06 lit, S05/S01/S02 plain). Screenshot sent to user.

**Layer 4 — the pivot (spec `6d13174`, plan `2c19e66`) — NOT EXECUTED:** the user diagnosed the root cause of the whole "Ready to Promote on a variance row" confusion: the system can't tell a variance replicate from a canonical candidate because variance is *implicit*. Decision: re-architect to **explicit per-vial assignment** — a new nullable `assignment_kind` enum (`core|variance`) on `lims_sub_samples`, set at check-in via drag buckets (HPLC / HPLC Variance, Endo / Endo Variance, Sterility / Sterility Variance). Workflow path = f(kind): core→promote, variance→`variance_verify` (no parent-lock). Sign-off gate moves from commercial entitlement to assignment; **entitlement becomes a display-only "paid product" marker** on the Assignment page. Parent stays canonical. Indicators re-key off `kind` (which *retires* the `829ce36` `vialListVarianceEntitlement` plumbing). Spec: `docs/superpowers/specs/2026-06-10-variance-bucket-assignment-design.md`; plan: `docs/superpowers/plans/2026-06-10-variance-bucket-assignment.md`.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **Vite serves a STALE transform of large files** | After editing `SampleDetails.tsx` (a big file), the dev server kept serving the old transformed module — even after `touch` (host + in-container) AND a normal browser reload. `vial-assignment.ts`/`AnalysisTable.tsx` (smaller) updated fine. Cost ~30 min this session. | `docker restart accumark-subvial-accu-mk1-frontend` to clear Vite's in-memory module graph, THEN load the page with a cache-bust (`?cb=1`) so the browser re-imports fresh ES modules. Verify the served module via `curl -s http://localhost:5532/src/<path>` (note esbuild renames vars, e.g. `v`→`v_0`). |
| **"Passed tests but didn't render"** | Surface A unit tests were green while the feature was dark in the running app (entitlement-gating mismatch). The user caught it, not the reviews — they verify predicate logic in isolation, not end-to-end rendering. | For any UI feature, **drive the real browser and inspect the rendered DOM / React fiber** before claiming done. The fiber-walk (`el.__reactFiber$...`, walk `.return`, read `memoizedProps`) was the decisive diagnostic. |
| **Stack browser needs overrides + full reload + correct token key** | The FE login API points at the wrong host without overrides; hash-nav doesn't apply them. | Set `localStorage`+`sessionStorage` `accu_mk1_api_url_override='http://localhost:5530'` and `accu_mk1_wp_url_override='http://localhost:5535'`, then **full reload** (the login screen should read "API: http://localhost:5530"). Auth token lives at `localStorage.accu_mk1_auth_token`. Login `forrest@valenceanalytical.com` / `test123`. SENAITE samples list = nav **Analysis → Samples** (`#senaite/samples`); it paginates (PB-0076 not on page 1). |
| **`parentSampleId===null` on parent pages; entitlement was vial-page-only** | The exact mutually-exclusive gating that made Surface A render nowhere. `SampleDetails` passes `varianceEntitlement` only when `parentSampleId !== null`, but the vial-list overlay renders only when `=== null`. | The new plan retires this entirely (kind-based). Until then, the `829ce36` `vialListVarianceEntitlement` workaround is what makes it work. |
| **`analysisRole()` returns null for HPLC rows w/o `peptide_name`** | PB-0076's parent rows all have `peptide_name: null`; `analysisRole` only yields `'hplc'` via `peptide_name`, so row-based classification failed. | Use the **vial's own `assignment_role`** (carried on `VialMatch`), not row classification. The new plan keys off `assignment_kind` directly. |
| **The new plan SUPERSEDES `829ce36`** | Task 6 removes `vialListVarianceEntitlement`; indicators flip to `assignment_kind`-driven. | Don't bother gate-reviewing `829ce36` — it gets replaced. |
| **Backend tests hit the LIVE `accumark_mk1` DB** | Easy to pollute; `apply_transition`/`compute_vial_plan` commit internally. | ZZTEST-* fixtures + explicit teardown; after runs assert `SELECT count(*) ... LIKE 'ZZTEST%'` = 0. `LimsSubSample` requires `external_lims_uid`. |
| **`compute_vial_plan` PERSISTS auto-assign role changes** | Calling it on a real sample mutates dev data. | Tests use ZZTEST parents with no sub-samples. **Never point it at PB-0076.** |
| **Pre-existing test failures are NOT regressions** | FE: `App.test.tsx`, `peptide-requests-list.test.tsx`. Backend: `test_list_sub_samples_with_children` (MagicMock→Pydantic-V2 coercion, unrelated), `test_sub_samples_service.py` ×5 (`create_sub_sample_*`). | Verified pre-existing via stash-baseline. Don't chase; baseline anything new against the prior commit. |

## Infrastructure state

All 10 `accumark-subvial-*` containers up. **9 healthy; `accumark-subvial-accu-mk1-frontend` shows "Up ~1 hour" (no healthcheck label)** — it was restarted this session to clear the Vite stale-transform; it's serving fine. Mk1 FE :5532 (HMR, bind `C:/tmp/Accu-Mk1-subvial`→/app), Mk1 API :5530 (`--reload`, bind backend/→/app, **migrations run at startup** — restart the backend after a `database.py` ALTER if the column doesn't appear), Postgres :5520 (`accumark_mk1`). Login `forrest@valenceanalytical.com` / `test123`. **PB-0076** has `variance_override = {"hplcpurity_identity": 2}` (S05 promoted/canonical, S06 the un-promoted HPLC replicate, S01 endo, S02 ster, S03/04/05 xtra). Backend exits if it loses the Postgres startup race → `docker restart accumark-subvial-accu-mk1-backend`.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Branch state | `git -C C:/tmp/Accu-Mk1-subvial log --oneline -5` (expect `2c19e66` HEAD, 82 ahead) |
| Backend variance suites | `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_aggregate.py tests/test_variance_verify.py tests/test_variance_demand.py -q"` |
| FE variance suites | `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx src/test/assign-step.test.tsx src/test/dashboard-variance.test.tsx src/test/bulk-promote-overlay.test.tsx"` |
| Full FE | `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run"` → only the 2 documented pre-existing failures |
| Typecheck | `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"` → only `WorksheetsInboxPage.tsx(434,38)` pre-existing |
| ZZTEST residue | `docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -t -c "SELECT count(*) FROM lims_samples WHERE sample_id LIKE 'ZZTEST%'"` → 0 |

## Outstanding items the user may want next

1. **Execute the variance-bucket-assignment plan** (`docs/superpowers/plans/2026-06-10-variance-bucket-assignment.md`) — the main event. 6 tasks (assignment_kind column+migration → set_assignment_role+lock guard → sign-off gate moves to assignment → vial-plan carries/fills kind → AssignStep variance drop zones+paid marker → lifecycle+indicator re-key). The user had NOT yet chosen execution mode or said "go" — confirm before starting. Likely subagent-driven with two-stage reviews (their established flow). Two soft spots flagged in the plan: Task 4 (`auto_assign`/`compute_vial_plan` internals — implementer reads+matches) and the Task 6 caller-sweep (`deriveBulkActions`).
2. **Optionally review the plan first** — it's a meaty re-architecture; the user may want to read it before execution.
3. **The vial-based "parent-as-grouping-master" north star** — the user's deeper vision: stop treating the parent as a vial-with-results; make it a pure grouping/COA container and every physical vial a sub-sample. Explicitly deferred this session as a separate arc *after* variance buckets. The variance-bucket work is a deliberate stepping stone toward it.
4. **Older deferred backlog** (unchanged): parent shadow/SENAITE phase-out, admin un-promote, COA variance-statistics section, auto-cleanup rules when re-assigning vials with artifacts.
5. **Push `subvial/continue`** — only when asked (82 ahead).

## User collaboration preferences

- **Full superpowers flow**: brainstorm → spec → plan → subagent-driven execution with per-task **two-stage reviews** (spec compliance, then code quality). Reviewers + the final holistic review caught real issues again this session. Keep the gate. Per-task commits, footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **LIVE verification is non-negotiable for UI** — the user caught a "passed-tests-but-dark" bug this session. Drive the browser and inspect rendered output before declaring a UI feature done. Report verification scope honestly.
- **Complex design = conversation, not a question grid.** The user rejected an `AskUserQuestion` grid mid-design and asked to talk it through; they think out loud and refine across turns. Use batched AskUserQuestion *with a recommendation* for crisp forks, but don't force a grid on open-ended architecture.
- **Normally additive-only / "don't re-architect"** — but they *explicitly chose* to re-architect the variance model this session. Honor the additive default unless they say otherwise; name it when something breaks the rule.
- Don't push until asked. Destructive dev-DB writes / SENAITE mutations hit the auto-mode classifier — the user authorizes freely on this isolated stack.

## Recommended first action in the new session

`git -C C:/tmp/Accu-Mk1-subvial log --oneline -5` to confirm `2c19e66` HEAD (82 ahead), then **ask the user whether to execute the variance-bucket-assignment plan and in which mode (subagent-driven recommended), or review the plan first.** Do not start executing without their go — they paused right at the execution-choice prompt.
