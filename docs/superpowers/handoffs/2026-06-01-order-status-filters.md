# Handoff: Order Status filters & Kanban refinements — feature complete, awaiting push/PR

*Created 2026-06-01. Paste this into a fresh session to resume with full context.*

---

You're picking up the **Order Status page filter/Kanban work** on branch `feat/order-status-filters`. **Status: all four features implemented, reviewed, and verified locally; the branch is NOT pushed. The next step is the user's push + PR decision (their standing rule: they verify live on `:3101` first, no push/PR without explicit go).** Earlier in the same session, a separate feature (SLA tooltip "Received" field) shipped all the way to prod as v0.36.0 — that's done; see context below. Your job: drive whatever the user asks next (most likely push + one PR for the filter stack), with full context of what was built and the gotchas.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| **Accu-Mk1 (worktree — ALL work here)** | `C:\tmp\accu-mk1-wave1` | `feat/order-status-filters` | `73a700f` |
| Accu-Mk1 (OneDrive checkout — DO NOT EDIT, on master) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` | `master` | `2460d27` (v0.36.0, deployed) |
| integration-service (sibling, referenced not edited) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\integration-service` | — | — |

`master` is at `2460d27` (= the squash-merged, deployed v0.36.0). `feat/order-status-filters` branched off it and is **12 commits ahead, unpushed** (remote branch does not exist yet). The worktree at `C:\tmp\accu-mk1-wave1` is what Docker bind-mounts and what `:3101`/`:8012` serve.

## What's on the branch

Two distinct feature efforts happened this session. **Only the second is on `feat/order-status-filters`.**

**Earlier (already shipped — context only): SLA breakdown tooltip "Received" field.** Added the sample's received date/time as the first field of the shared `SlaBreakdownTooltip` (all 5 surfaces). That was on the PRIOR branch `feat/order-status-processing-time` → **PR #5, squash-merged to master, DEPLOYED to prod as v0.36.0** (`scripts/deploy.sh`; health `{"status":"ok","version":"0.36.0"}`; SLA schema verified on prod DB, default tier seeded at 48h). The `accumark-deploy` skill + `docs/developer/deployment.md` cover the deploy mechanics. Nothing left to do here.

**This branch — Order Status filters & Kanban refinements (12 commits, `ed7d2cb`..`73a700f`):**

- **Layer 1 — Filter helpers + multi-select stage filters + SLA at-risk toggle.** New pure helpers `toggleFilterKey` / `isOrderAtRisk` in `src/components/explorer/order-filters.ts` (TDD-tested in `src/test/order-filters.test.ts`). `toggleState` switched from single- to multi-select (the OR-matching + multi-active rendering already existed). New persisted `OrderFilters.slaAtRisk` toggle ("⚠ SLA at-risk", right of "All Orders") that narrows to amber+red orders via a `displayedOrders` memo; all render consumers repointed to `displayedOrders`. Empty-state copy clarified when the SLA filter narrows to zero.
- **Layer 2 — Kanban refinements (`e9992d8`, `3e5025a`).** Hid "Pending" everywhere (removed from `KANBAN_COLUMNS` + `ANALYSIS_STATE_BUTTONS`; `loadOrderFilters` strips stale `'pending'` from persisted `activeStates`; dead `pending` map entries removed). Collapsible flat-Kanban columns: new persisted `collapsedKanbanCols: string[]`, chevron toggle per column header (reuses `toggleFilterKey`), collapsed columns shrink to a thin bar + hide cards. Moved `SampleSlaIndicator` to its own full-width card row (was squished in Row 2).
- **Layer 3 — Client-side analyte filter (`73a700f`).** New persisted `analyteFilter` text input in the filter row; matches the card's displayed analysis names (`formatAnalysisTitle`) case-insensitively, in the `filteredOrders` memo so it composes (AND) with stage/SLA/text filters across table + Kanban. **Client-side by deliberate choice** (matches loaded SENAITE analysis names) — NOT the server-side `sample_identity` parity the Customer Detail page uses.

Specs in `docs/superpowers/specs/2026-06-01-*`; plan in `docs/superpowers/plans/2026-06-01-order-status-filter-enhancements.md`. Each layer had spec-compliance + code-quality review (all approved).

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **Uncommitted, UNRELATED work in the worktree** | `git status` shows `M backend/main.py, src/lib/api.ts, src/store/ui-store.ts, src/components/layout/{AppSidebar,MainWindowContent}.tsx` + untracked `src/components/reports/{CheckInTimesReport.tsx,checkin-utils.ts,checkin-utils.test.ts}` and `backend/tests/test_api_reports_checkin_times.py`. This is an in-progress **"Check-In Times Report"** feature — **NOT part of `feat/order-status-filters`** and not built this session. | Do NOT `git add -A`. When committing/pushing the filter branch, stage ONLY the filter files. Ask the user what to do with the Check-In Times Report work (separate branch? someone else's WIP?). Don't sweep it into the filters PR. |
| **Branch is local-only (not pushed)** | `git ls-remote origin feat/order-status-filters` is empty. No PR exists. | First push needs `git push -u origin feat/order-status-filters` — only after the user's explicit go. |
| **`.planning/STATE.md` always shows ` M`** | GSD artifact; pollutes commits. | Never stage it. Stage files explicitly; verify each commit with `git show --stat HEAD`. |
| **`noUnusedLocals` is ON** | Importing a symbol before it's consumed fails `tsc` (bit us mid-session). | Import only what the current edit uses; add to the import when a later edit consumes it. |
| **Squash-merge is the team convention** | PR #4 and PR #5 both landed on master as a single squashed commit. | When the filter PR merges, squash. Intermediate per-commit history doesn't reach master. |
| **`OrderStatusPage.tsx:80` lint baseline** | `npx eslint` reports `consistent-type-definitions` on the `KanbanCol` type — pre-existing, NOT yours. | Ignore that one line. Use scoped `npx eslint <files>` from the worktree, never `npm run lint` (surfaces baseline noise). |
| **Pre-existing test failures (not regressions)** | Frontend: 2 (`App.test.tsx`, `peptide-requests-list.test.tsx`). Backend: 6 (clickup-webhook, completion-side-effects ×4, peptide-e2e) — all verified failing at master baseline `2460d27`/`159fb1f`. | Don't chase them as new breakage. Documented; optional separate cleanup. |
| **Order Status "Pending"/"Assigned" reads SENAITE, not Accu-Mk1 worksheets** | Analysis `review_state` comes from the SENAITE lookup; Accu-Mk1 worksheet assignment is local (`worksheet_items`) and does NOT flip SENAITE state. This is WHY Pending was hidden. | If asked to make stage filters reflect Accu-Mk1 assignment, that's a real (unscoped) change — flag it. |
| **3rd unlabeled SLA row = ungrouped analyses** | A blank SLA line on a card means some analyses aren't mapped to any service group (fall to NO_GROUP_KEY + default tier). Working as designed, not a bug. | Fix is config (map services to a group) or an optional code tweak to label/hide it. |
| **No OrderStatusPage test harness** | The integration is verified by typecheck + scoped eslint + manual smoke, not component tests (user approved this). Only the pure helpers have unit tests. | Don't try to build a full component test unless asked; follow the established verify approach. |
| **Tests run INSIDE the frontend container** | `npm`/`npx` on the host is for typecheck/eslint; vitest runs in Docker. | `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run <files>'`. |

## Infrastructure state

Dev stack — all bind-mount `C:\tmp\accu-mk1-wave1`:

| Service | Container | Ports | Notes |
|---|---|---|---|
| Mk1 frontend (Vite) | `accu-mk1-frontend` | 3101 → 5173 (also 3100 → 80) | **Test on `:3101`.** Up ~30 min (restarted after the analyte filter). |
| Mk1 backend (FastAPI) | `accu-mk1-backend` | 8012 | Up ~30 min. No backend changes on the filter branch. |
| Postgres | `accumark_postgres` | 5432 | Up 4 days (healthy). |

- Frontend HMR auto-reloads on `src/` edits. New files/locale changes sometimes need `docker restart accu-mk1-frontend` (Vite ready ~450ms) — done after each layer this session.
- Backend needs restart only after `main.py`/`models.py`/`database.py` edits — not relevant on this branch.
- Prod web app: `https://accumk1.valenceanalytical.com` (droplet `165.227.241.81`), currently running v0.36.0. Deploy via `scripts/deploy.sh` (see `accumark-deploy` skill) — prod-host access requires explicit user authorization (the auto-mode classifier blocks unprompted prod SSH).

## Verification commands (re-run, don't trust stale numbers)

| Check | Run command |
|---|---|
| Helper unit tests | `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-filters.test.ts'` (expect 6 pass) |
| SLA regression suite | `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-sla.test.tsx src/test/order-row.test.tsx'` |
| Typecheck | `cd /c/tmp/accu-mk1-wave1 && npm run typecheck` (expect clean) |
| Scoped lint | `cd /c/tmp/accu-mk1-wave1 && npx eslint src/components/OrderStatusPage.tsx src/components/explorer/order-filters.ts` (only the `:80` KanbanCol baseline) |
| Branch state | `git -C /c/tmp/accu-mk1-wave1 log --oneline origin/master..HEAD` (12 commits, top `73a700f`) |
| Confirm not pushed | `git -C /c/tmp/accu-mk1-wave1 ls-remote origin feat/order-status-filters` (empty = not pushed) |

## Outstanding items the user may want next

1. **Push `feat/order-status-filters` + open ONE PR** for the whole stack (multi-select filters, SLA at-risk toggle, Kanban refinements, analyte filter). This is the most likely next ask — but ONLY after the user confirms live testing on `:3101`. Stage only the filter files; exclude the Check-In Times Report WIP. Squash-merge to match convention.
2. **Decide what to do with the uncommitted Check-In Times Report work** (the unrelated `reports/*` + layout + api/ui-store + backend changes). Probably belongs on its own branch. Ask before touching.
3. **Version bump for the next deploy** — `package.json`/`tauri.conf.json` are at `0.36.0` (the deployed version). The filter stack would ship as `0.37.0`; bump + CHANGELOG before deploying (not required just to open the PR).
4. **(Optional) Label or hide the ungrouped SLA row** — the blank SLA line for analyses not mapped to a service group. Either map the stray services (config) or a small code tweak (label "Ungrouped" / hide when grouped rows exist). Offered, user said "not a bug" for now.
5. **(Optional) Server-side analyte parity** — match the WP-ordered `sample_identity` like Customer Detail (needs `search_analyte` forwarding on the general `/explorer/orders` endpoint + getExplorerOrders + debounced query). User chose client-side "for now".
6. **(Optional) Clean up the 2 frontend + 6 backend pre-existing stale tests.**

## User collaboration preferences

- **Brainstorm → spec → plan → subagent-driven execution.** Every feature this session followed it. Specs to `docs/superpowers/specs/`, plans to `docs/superpowers/plans/`. Two-stage review (spec-compliance then code-quality) per task.
- **"Proceed and implement, only come back if stuck"** — when the user says this, drive autonomously through implementation + verification without per-step check-ins; surface only genuine blockers.
- **Don't push branches / open PRs without explicit go** — the user verifies live behavior on `:3101` first. They frequently say "push to local docker so I can test" = restart the frontend container, not a git push.
- **One commit per task, exact messages, no amend** (exception: fixing a self-introduced error in the immediately-prior UNPUSHED commit is fine). `.planning/STATE.md` never committed. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **TDD** for logic (pure helpers); for thin UI glue with no harness, typecheck + scoped eslint + manual smoke is the accepted verification (explicitly approved).
- **npm not pnpm. `T[]` not `Array<T>`. Zustand selector syntax, no destructuring. React Compiler auto-memoizes** (but explicit `useMemo` matching existing file patterns is fine).
- **Web deploy is what matters; no active desktop users** (skip desktop release; leave any Tauri draft unpublished).
- **i18n: identical English across en/fr/ar; translation deferred.**

## Recommended first action in the new session

Confirm branch + worktree state and surface the two pending decisions — do NOT push yet:

```bash
git -C /c/tmp/accu-mk1-wave1 status --short
git -C /c/tmp/accu-mk1-wave1 log --oneline origin/master..HEAD | head
```

Then tell the user: "`feat/order-status-filters` is complete and local (12 commits, top `73a700f`) — multi-select filters, SLA at-risk toggle, Kanban refinements, analyte filter, all verified. Two things to decide: (1) ready to push + open the PR? and (2) there's uncommitted **Check-In Times Report** work in the worktree that isn't part of this branch — how do you want to handle it?"
