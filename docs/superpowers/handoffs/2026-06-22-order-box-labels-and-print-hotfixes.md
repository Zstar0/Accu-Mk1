# Handoff: Order Box Labels + check-in/print hotfixes

*Created 2026-06-22. Paste this into a fresh session to resume with full context.*

---

You're picking up after a session of **shipped check-in/print hotfixes** plus a **planned-but-not-built** feature (Order Box Labels). Status: hotfixes are **live in prod**; the Order Box Labels feature is **spec'd + planned, zero code written**. Your most likely next job is to **execute the order-box-labels plan**, or take whatever the user asks next.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Accu-Mk1 (wave1 worktree) | `C:/tmp/accu-mk1-wave1` | `subsample-features` | `b8a6bcb` (order-box-labels plan; 2 doc commits ahead of origin/master) |
| accumarklabs theme (DevKinsta) | `\\wsl.localhost\…\DevKinsta\public\accumarklabs` | **`vialcoa/feat-per-vial-coa`** (⚠ another agent switched it here; `db2e978`) | my theme work (2.27.2 `8d7e27f`) is already merged to master |

`gh` authed as **Zstar0**. Repos: `Zstar0/Accu-Mk1`, `Zstar0/accumarklabs`.

## Prod deploy state (ground truth this session)

- **Accu-Mk1: 1.0.2** — deployed early today (full), then two **frontend-only** hotpatches held the version at 1.0.2 (bumping FE-only would mismatch backend `/api/health` and trip auto-rollback).
- **accumarklabs theme: 2.27.2** — deployed via `deploy.py` (Kinsta), merged to master (PR #9).
- IS 1.0.2, COA 2.27.0 (untouched this session).
- Full current-state memory: `project_prod_deploy_state` (refreshed this session).

## What's on the branch

**Layer 1 — shipped & deployed hotfixes (Accu-Mk1, all on master + subsample-features):**
- `215e907` **fix(intake)** — "Choose file" upload button now ALWAYS shows on the vial check-in photo step (was only when camera unavailable). FE-only deploy.
- `c830b87` **fix(labels)** — vial label corrected from 105.7×8.5mm to the real **2"×¼" (50.8×6.35mm)** media (the oversized `@page` was the QR-truncation cause) + 2-row layout (sample ID + role top-right, vial/order + date below), smaller fonts, QR 5.5mm with quiet zone.
- `a13d14c` **fix(labels)** — added `padding-right: 4mm` so right-aligned role/date clear the printer's unprintable right margin (first print clipped "HPLC"→"HPL"). All three merged to master via **PR #12**.

**Layer 2 — Order Box Labels feature (SPEC + PLAN only, NO code):**
- `6085d09` spec → `docs/superpowers/specs/2026-06-22-order-box-labels-design.md`
- `b8a6bcb` plan → `docs/superpowers/plans/2026-06-22-order-box-labels.md`
- These two doc commits are the **+2 ahead of origin/master** (docs only; code lives in the plan, unbuilt).
- **The feature:** a "Print Order #" button on the Print Labels tab prints one **box label per department** (HPLC/ENDO/PCR) for the color-coded department bins. Each label: order # (WP-####, large), department + **expected vial count**, order date. **No QR** (deferred). Count = ordered/expected vials summed across the WHOLE order (ster=2/sample); needs a new Mk1 endpoint (`GET /orders/{order_number}/box-label-summary`) that reads the integration DB `order_submissions` row and runs each sample through `derive_base_demand`. 3 tasks; ships as **1.0.3** (backend+frontend, real release — not the FE-only trick).

**Earlier today (context, already merged/deployed):** Mk1 1.0.2 batch (inbox native-vial fix, variance-set defaults, native-create default) + theme 2.27.2 (variance-report tightness gauge + sparkline hover). See `project_prod_deploy_state` memory.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **Frontend-only deploy must NOT bump version** | deploy.sh health-checks backend `/api/health`; a FE-only bump makes it report the old version → expected-mismatch → **auto-rollback**. | FE-only hotfix: keep version, `deploy.sh --frontend --skip-release`. The git commit is the record. (Order-box-labels touches backend → it DOES bump to 1.0.3 + full deploy.) |
| **Label media is 2"×¼" (50.8×6.35mm), NOT 105.7×8.5mm** | Wrong `@page` size made the browser render a 2×-wide page → CAB driver clipped/rescaled → truncated QR. | `PrintStep.css` is now correct. CAB driver must also be set to 2"×0.25" + **100% / "Actual size"** (not Fit-to-page). |
| **Print isolation = exactly one `.print-area`** | `@media print` hides everything except `.print-area`. The order-box-labels plan adds a SECOND print set — two `.print-area`s would print both. | Plan Task 2 Step 3 uses a `printMode` flag so only one container carries `.print-area` at print time. |
| **deploy.sh has CRLF / worktree** | Mk1 is a git worktree; running deploy.sh from PowerShell→WSL fails the git-tag step. | `sed -i 's/\r$//' scripts/deploy.sh` first; run from **Git Bash**; `--skip-release` (worktree). `scripts/deploy.sh` shows as modified (LF strip) — leave it, don't commit. |
| **order_submissions order-number column unconfirmed** | The new endpoint must find the order row by WP number; exact column (`order_id` vs `payload->>'order_number'`) not verified. | Plan Task 1 **Step 1 is a discovery query** — run it first, feed the column into the query. |
| **SSH `mux_client_request_session` noise** | Every deploy/ssh prints `Connection reset by peer` / `mm_send_fd` lines. | Cosmetic SSH multiplexing noise — ignore. Trust the health-check line. |
| **deploy.py "health got 0"** (theme) | Looks like prod down. | Deploy-client false negative — verify with `curl` independently. |
| **WP deploy.py git-add landmine** | deploy.py `git add -A` would sweep the untracked `accumark-hardening.php` mu-plugin. | Move mu-plugin aside before `deploy.py`, restore after (only relevant if deploying the theme). |
| **Mk1 ~19 baseline test failures** | Full suite has known failures (flaky-pollution + stale-tests). | Gate via normalized baseline diff — see `architecture_mk1_test_baseline_failures` memory. |
| **GitNexus "index stale" advisory** | Fires on Bash calls. | Noise — ignore. |
| **Theme worktree branch changed** | Another agent put the theme on `vialcoa/feat-per-vial-coa` (`db2e978`). | Not your work; my 2.27.2 is on master. Don't assume the theme tree is where you left it. |

## Infrastructure state

- **Local Mk1 wave1 stack** (runs the tests + typecheck): `accu-mk1-backend` (Up), `accu-mk1-frontend` (Up). Tests: `docker exec accu-mk1-backend python -m pytest …`. FE typecheck: `docker exec accu-mk1-frontend npx tsc --noEmit -p tsconfig.json`. No file-watch across the bind mount — restart containers after git ops if behavior looks stale.
- **DevKinsta** `devkinsta_fpm` (PHP 7.4, serves accumarklabs.local; theme at `/www/kinsta/public/accumarklabs/wp-content/themes/wpstar`) — used for the theme PHP harness last session; not needed for Mk1 work.
- **Prod droplet** `165.227.241.81`: Mk1 web (`accu-mk1-backend`/`-frontend`), deploy via `bash scripts/deploy.sh` from Git Bash. Prod env in `/root/accu-mk1/backend/.env` (never overwrite). Rollback: `previous_version` saved per deploy.
- **Prod Kinsta** theme: `deploy.py` (tar), never DB-sync.

## Verification commands (re-run, don't trust stale numbers)

| What | Command |
|---|---|
| Mk1 prod version | `curl -s https://accumk1.valenceanalytical.com/api/health` (expect 1.0.2 until 1.0.3 ships) |
| Branch vs master | `cd /c/tmp/accu-mk1-wave1 && git fetch origin -q && git rev-list --count origin/master..origin/subsample-features` (expect 2 = the doc commits) |
| order_submissions column discovery | Plan Task 1 Step 1 (run before coding the endpoint) |
| Mk1 backend tests | `docker exec accu-mk1-backend python -m pytest tests/ -q` (~19 baseline failures — see memory) |
| FE typecheck | `docker exec accu-mk1-frontend npx tsc --noEmit -p tsconfig.json` |

## Outstanding items the user may want next

1. **Execute the order-box-labels plan** — `docs/superpowers/plans/2026-06-22-order-box-labels.md`. 3 tasks (endpoint → button/labels → 1.0.3 release+deploy). Subagent-driven recommended. Start with Task 1 Step 1 discovery query.
2. **Deferred from this feature:** the QR code on the box label + the customer-detail `orderID` query param (pre-fill Order# search). Explicitly deferred; user may revisit.
3. **Fine-tune the vial label** if a future print shows clipping — every dimension in `PrintStep.css` is a one-number tweak (`50.8mm`/`6.35mm`/`5.5mm`/`6pt`/`padding-right: 4mm`).
4. **Post-1.0.2 items** (from `project_prod_deploy_state`): 2 manual prod peptide links, regenerate P-1010 COA, alias-model brainstorm for the 15 unlinked identity services.

## User collaboration preferences

- **Decisive, drive-forward, prefers prose** (dislikes the AskUserQuestion tool). Wants a recommendation on real forks.
- **Ships hotfixes fast and tests in prod** — explicitly OK deploying additive/reversible FE changes and verifying live (rolls back if needed). Production deploys are authorized when the user asks for the hotfix.
- **Wants work committed + pushed so other agents pull it** — push to `subsample-features`; **merge to master** to sync (other agents branch from master too).
- **Additive only**; failing tests default to "stale" (verify via baseline diff). Atomic commits with the `Co-Authored-By: Claude Opus 4.8` trailer.
- Physical-print iteration is expensive — confirm label layout/scope before printing.

## Recommended first action in the new session

Confirm state, then start the plan:
```
cd /c/tmp/accu-mk1-wave1 && git log --oneline -3 && git fetch origin -q && git rev-list --count origin/master..origin/subsample-features
```
Then run **Task 1 Step 1** of `docs/superpowers/plans/2026-06-22-order-box-labels.md` (the `order_submissions` column discovery query) before writing the endpoint. Execute the plan subagent-driven.
