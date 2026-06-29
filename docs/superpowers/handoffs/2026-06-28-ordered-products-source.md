# Handoff: ordered-products-source — order-sourced Products + sticky-header chips & completion checks

*Created 2026-06-28. Paste this into a fresh session to resume with full context.*

---

You're picking up the **ordered-products-source** feature for Accu-Mk1 (+ a 1-line integration-service change). The core feature is shipped to two open PRs; the latest work (sticky-header product chips + green completion checks) is committed, and there is **one uncommitted UI tweak** awaiting the user's visual OK on the live 3101 stack. Your job is to drive whatever the user asks next.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Accu-Mk1 (feature worktree) | `C:/tmp/worktrees/ordered-products-source/Accu-Mk1` | `hotfix/ordered-products-source` | `054ab09` (+1 uncommitted: `SampleDetails.tsx`) |
| integration-service (feature worktree) | `C:/tmp/worktrees/ordered-products-source/integration-service` | `hotfix/ordered-products-source` | `411873d` (clean) |
| Mk1 main checkout (LEAVE ALONE) | `.../Accumark-Workspace/Accu-Mk1` | `master` (stale, 104 behind origin) | — |

**PRs:** Mk1 → `Zstar0/Accu-Mk1` **#20**; IS → `ValenceAnalytical/accumark-integration-service` **#11** (#20 depends on #11). Both branches pushed; `054ab09` and the uncommitted tweak are **not yet on the PR**.

## What's on the branch

**Layer 1 — core feature (shipped to PRs #20/#11, built via subagent-driven TDD).** Source the sample parent page's PRODUCTS section from customer ORDER data via Integration Service instead of SENAITE profiles + current vial assignment. A single backend `PRODUCT_REGISTRY` drives chips + a purchased-vs-assigned amber alert (the incident: variance bought but no vial assigned). New Mk1 endpoint `GET /api/sub-samples/{id}/ordered-products` (live-read from IS, no SENAITE fallback; 404=no order, 502=IS down). IS got a `package` field on `/orders/sample-services`. Also: activity endpoint now fans out over the family's vials with a bucket-aware `role_assigned` label, and the flyout shows vial id + ambers a move out of variance.

**Layer 2 — this session's new work (commit `054ab09`, FE-only, no backend).** Copied the product chips into the sticky header and added a green check to each chip when its lab work is done: Endotoxin/Sterility = group analysis (`ENDO-LAL`/`STER-PCR`) promoted; HPLC = **every** hplc-family parent analysis promoted (strict — user chose this); Variance = the variance set is `locked`. Hovering the check lists the contributing vial(s). All derived from data the page already loads (`promotionsByKeyword` + `varianceSetOverlay`). New files: `src/lib/product-completion.ts` (pure, 8 tests), `src/components/senaite/ProductChip.tsx`. `OrderedProducts` now exports `useOrderedProducts` (shared query) and renders via `ProductChip`.

**Layer 3 — in-flight tweak (UNCOMMITTED in `SampleDetails.tsx`, typecheck-clean).** First placement put the chips in the top header row, which crowded the vial photo into wrapping. Moved them to their **own right-aligned line directly above the action bar** (`HPLC Results / Activity / …` row). Awaiting the user's confirmation on 3101 before committing.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **3101 is the `accu-mk1-wave1` stack, REPOINTED to this branch** | Its compose mounts were edited to bind-mount the feature worktrees (FE `src`, `backend`, IS `/app`). It normally runs the user's `subsample-features` (Mk1) + `vialcoa` (IS) worktrees. | Revert when done: restore the 3 backups + recreate (command in Infra section). Backups: `C:/tmp/accu-mk1-wave1/docker-compose.yml.bak-20260628`, `…/docker-compose.override.yml.bak-20260628`, `C:/tmp/is-vialcoa-override.yml.bak-20260628`. |
| **Mk1 backend container has NO `--reload`** | FE edits hot-reload (vite HMR), but backend code changes do NOT appear until the container is recreated. IS also has no `--reload`. | After a backend/IS edit: `cd C:/tmp/accu-mk1-wave1 && docker compose up -d` (Mk1) / the IS recreate command below. |
| **Do NOT run a formatter on `SampleDetails.tsx`** | It has pre-existing prettier debt; a prior attempt reformatted 2000+ lines and had to be reverted. | Hand-format only your new lines. Validate with `npm run typecheck` + `npm run lint` (lint failures on that file are pre-existing). |
| **`npm run test` is watch-mode vitest (hangs)** | Will block a non-interactive shell forever. | Use `npm run test:run -- <file>` (one-shot). |
| **Plan/spec line numbers are STALE vs the worktree** | Worktree is off `origin/master`, ~104 commits ahead of local `master` the plan was written against. | Locate code by content, not line number. |
| **Backend/IS tests need the MAIN-checkout venv** | The worktree has no `.venv`; shell `python` is the hermes-agent venv (no deps). | Use `…/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest …` (and the IS one) — see Verification. |
| **Variance "done" = `locked`** | `lock_variance_set` (service.py:1644-1680) already requires ≥2 in-set vials AND all in-set variance-bucket analyses promoted/variance_verified — so `locked` alone is sufficient for the green check. | Don't re-derive count/verified separately. |
| **Backend startup ran additive `create_all`/ALTERs on the wave1 DB** | This branch is off origin/master (ahead of subsample-features); a few columns may have been added to the wave1 dev DB. | Additive/harmless to subsample-features; nothing to undo. |

## Infrastructure state

- **3101 stack** (compose project `accu-mk1-wave1`, working dir `C:/tmp/accu-mk1-wave1`): `accu-mk1-frontend` (3101→5173, vite dev, mounts feature `src`), `accu-mk1-backend` (8012, mounts feature `backend`, no reload). Up ~9h.
- **IS** (compose project `integration-service`): `integration-service` (8000, mounts `C:/tmp/worktrees/ordered-products-source/integration-service:/app`). Up ~9h, healthy.
- Other stacks present but untouched: `accumark-host-*` (55xx) and `accumark-subvial-*` (552x/553x).
- **Revert 3101 to the user's normal env:**
  ```bash
  cp "C:/tmp/accu-mk1-wave1/docker-compose.yml.bak-20260628" "C:/tmp/accu-mk1-wave1/docker-compose.yml"
  cp "C:/tmp/accu-mk1-wave1/docker-compose.override.yml.bak-20260628" "C:/tmp/accu-mk1-wave1/docker-compose.override.yml"
  cp "C:/tmp/is-vialcoa-override.yml.bak-20260628" "C:/tmp/is-vialcoa-override.yml"
  cd "C:/tmp/accu-mk1-wave1" && docker compose up -d
  cd "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service" && docker compose -p integration-service -f docker-compose.yml -f C:/tmp/is-vialcoa-override.yml up -d
  ```

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command (from the Mk1 feature worktree unless noted) |
|---|---|
| FE typecheck | `cd C:/tmp/worktrees/ordered-products-source/Accu-Mk1 && npm run typecheck` |
| FE feature tests | `npm run test:run -- src/test/product-completion.test.ts src/test/ordered-products.test.tsx src/test/sample-activity-log.test.tsx` |
| Mk1 backend tests | `cd <wt>/Accu-Mk1/backend && "…/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_product_registry.py tests/test_ordered_products_endpoint.py tests/test_activity_family_fanout.py tests/test_subsample_activity.py -v` |
| IS test | `cd <wt>/integration-service && "…/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit/test_desktop_sample_services.py -v` |

Last known green this session: FE 15/15 (+typecheck clean), backend 25, IS 2.

## Outstanding items the user may want next

1. **Confirm the moved chip-row placement** on 3101 (`BW-0015`) — chips on their own line above the action bar, photo no longer crowded. If good → commit the uncommitted `SampleDetails.tsx` (`feat(mk1-fe): move header product chips above the action bar`), then ask whether to push to PR #20.
2. **Add a `ProductChip` render test** (presentational; the completion logic has 8 tests but the check/tooltip render is untested).
3. **Revert the 3101 repoint** when the user is done testing (command above).
4. **PRs #20 / #11**: review + merge. Deploy ordering: IS (#11) before/with Mk1 (#20) — use the `accumark-deploy` skill. Manual QA: open a real Core/AccuShield order and confirm the package chip renders (automated tests cover the registry mapping, not the live IS payload).
5. Optional: save a memory on the PRODUCTS-source migration once merged.

## User collaboration preferences

- **npm only** (never pnpm) for Mk1 frontend.
- Brainstorm → present design → get approval **before** building; the user liked the full subagent-driven TDD rigor for the big feature, but inline TDD is fine for small FE changes.
- **No unsolicited commits/pushes** — confirm first. Additive-only; don't re-architect.
- Fast iteration: test live on 3101 as we go.
- Don't reformat files with pre-existing prettier debt.

## Recommended first action in the new session

Reload **http://localhost:3101** → open `BW-0015`, confirm the product-chip row sits on its own line above the action bar (photo not crowded, checks showing). If the user approves, commit the uncommitted `SampleDetails.tsx` and ask whether to push to PR #20.
