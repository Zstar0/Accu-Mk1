# Handoff: Spec 4 shipped (Mk1 PR #91) — s3rehe running it live for UAT

*Created 2026-07-31. Paste this into a fresh session to resume with full context.*

---

You're picking up the new-test-families program. **Spec 4 ("Catalog-driven bench") is fully executed through a 13-task SDD run, final-reviewed "Ready to merge — With fixes", fix-waved clean, pushed, and PR'd: Mk1 [#91](https://github.com/Zstar0/Accu-Mk1/pull/91)** (base `feat/catalog-order-routing`, extends the chain #87→#88→#89→#90→#91, auto-retargets on merge). **The `s3rehe` devbox stack now runs the spec-4 Mk1 branch live with seeded demo data — the Handler is mid-UAT on it.** Deploy remains deferred to the ONE combined window per standing ruling. Your job is to drive whatever the user asks next — most likely UAT follow-ups/fixes on the stack, PR review support, the Handler rulings listed below, or the next program phase.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Mk1 spec-4 worktree | `C:\tmp\Accu-Mk1-bench` | `feat/catalog-driven-bench` | `489dc1b` (clean, synced w/ origin) |
| Mk1 main checkout (docs) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` | `docs/analysis-catalog-specs` | `4262a00` (synced; `AGENTS.md`/`CLAUDE.md` mods are pre-existing local) |
| Devbox s3rehe Mk1 | `forrestparker@100.73.137.3:~/worktrees/Accu-Mk1-s3rehe` | `feat/catalog-driven-bench` | `489dc1b` (`package-lock.json` dirty — devbox npm artifact, ignore) |
| Spec-3 worktrees (untouched) | `C:\tmp\Accu-Mk1-order-routing` · `C:\tmp\is-order-routing` · `C:\tmp\coabuilder-order-routing` · `C:\tmp\accumarklabs-order-routing` | `feat/catalog-order-routing` | ef1eddb / 5cabb6f / baeebeb / 27033c3 per prior handoff |

**Open PRs:** spec 4 — Mk1 [#91](https://github.com/Zstar0/Accu-Mk1/pull/91). Plus the pre-existing chain: Mk1 #87/#88/#89/#90, IS #20 (+#19), coabuilder #6 (+#5), accumarklabs #20. Merge order: chain order; only safe deploy order IS → Mk1 → WP-entry-flip; seed-catalog-LAST.

## What's on the branch (31 commits, `ef1eddb..489dc1b`)

**Layer 1 — the five spec moves (SDD Tasks 1-12):** `vial_roles` table seeded parity-exact with the deleted constants (hplc/endo/ster/xtra boxable, hm NOT, xtra NULL-department, all five `is_system+frozen`); profile auto-mint (POST/PATCH mint unknown role codes AFTER the spec-3 guards — structurally cannot create legacy/xtra); `profile_ride_hosts` + demand v2 (deterministic anchors→riders in `backend/sub_samples/catalog_demand.py::resolve_catalog_fulfillment`; legacy buckets provably unmovable; endo/ster barred from ride lists); `vial_profile_assignments` custody edges (append-only, supersede-on-every-flip, written + flushed inside `set_assignment_role`'s single transaction; seeding reads the EDGES via `_catalog_members_for_role(sub_sample=...)`); dynamic AssignStep (sections from `vial_plan.sections`; `Bucket`/`SubDropZone`/`VarianceDropZone` kept verbatim; hm-invisibility class closed — any unknown-role vial lands visibly in Xtra); ALL role-constant sites converted fail-closed (incl. inbox lanes via `catalog.roles.inbox_lanes` — legacy keys 'hplc'/'microbiology'/'hm' stable, new depts slugified+uniquified); profile `sla_tier_id` (beats group tier, loses to priority — `sla_days` NEVER EXISTED, plan deviation 1); bench_stations + QR scan-in (soft custody, ships EMPTY, phone page `public/m/bench.html` hardcodes `/api/api`).

**Layer 2 — proof:** acceptance suite `backend/tests/test_catalog_bench_acceptance.py` proves manager-authors-lab-follows VIA API ONLY through public `compute_vial_plan`; found ZERO production defects. Final opus whole-branch review re-ran all three gates itself: pytest failure-set diff EMPTY (64/64 baseline), tsc clean, vitest strict subset of the 7-name flake baseline; verified zero-clamp/parity/registry invariants BY TRACING. Final wave (`1b2237d`+`403f9e3`): ten async→def handler conversions, seed dept self-heal, per-token scan cap 200, custody-CASCADE docstring truth-fix, misc. Re-reviewed clean.

**Layer 3 — UAT-live polish:** `489dc1b` — assignment sections grid wraps on narrow viewports (`repeat(auto-fit, minmax(240px,1fr))`, old 1.2fr/0.8fr weights deliberately dropped, style-contract test). Handler-requested during live UAT, already deployed to s3rehe.

**Demo data seeded on s3rehe (via API, like a manager would):** department id=4 "Storage" (Handler-created, non-system) → service `STOR-CHK` id=233 → profile `zz_storage_check` id=7 (auto-minted role `stor` in Storage) → IS order `3269` payload sample-1 services gained `"zz_storage_check": true` → sample **P-0141** now plans `{hplc:1, endo:1, ster:2, hm:1, stor:1}` with a Storage section. **P-0141's variance lock was CLEARED** (spec-3 rehearsal artifact, deliberately, so drags/auto-assign work).

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| SDD ledger is the authoritative record, deliberately KEPT | Every deferred minor, controller ruling, UAT delta, G-gate addition lives there | `C:\tmp\Accu-Mk1-bench\.superpowers\sdd\2026-07-30-catalog-driven-bench\progress.md` (+ task reports, final-wave-report.md same dir) |
| s3rehe is now MIXED-VINTAGE by design | Mk1 = spec-4 `489dc1b`; IS/COABuilder/WP/SENAITE = spec-3 vintage. Correct (no wire coupling) but COA/WP flows exercise spec-3 code | Don't "fix" it; if a WP/COA change is needed, those worktrees are `~/worktrees/*-s3rehe` on the devbox |
| Mk1 suppresses ALL `logger.info` (no basicConfig) | Seed/mint log lines never appear in `docker logs` — looks like the seed didn't run | Verify via DB (`psql -U postgres -d accumark_mk1` in `accumark-s3rehe-postgres`) or API, never logs |
| Benign boot noise on s3rehe | `migration_skipped` for `lims_analyses_review_state_check` (memory-recorded benign) and `uq_lims_analyses_parent_service_root` UniqueViolation (pre-existing rehearsal data) fire every boot | Ignore both; neither is spec-4 schema |
| Live-DB tests bypass `init_db()` | A fresh dev DB on this branch fails ~4 tests with `relation "vial_profile_assignments" does not exist` | One backend restart (or direct `_run_migrations()`) before judging the suite |
| A new department alone shows NOTHING on the assignment page | Sections come from the PLAN: need profile (role in that dept) + an order carrying its key | Full chain: dept → profile (auto-mint) → add key to IS `order_submissions.payload` sample slot → open that sample's Assign tab |
| New profiles have NO WP card (G-PUB not done) | You cannot order a new family through the WP wizard | Seed orders by editing IS `order_submissions.payload` directly (established mechanism) |
| FE baseline has a ~7-name flaky set; backend baseline is 64 failures | Zero-failure gating reads as broken | Diff failing NAMES vs `fe-baseline-failures.txt` / `baseline-failures.txt` in the sdd dir; rerun deltas alone; known backend flake `test_peptide_request_update_fields` |
| `assignment_role` is VARCHAR(8) | `vial_roles.code` inherits the ceiling; regex `^[a-z][a-z0-9_]{0,7}$` at every edge | Never widen the column |
| The `/api/api` static-page trap | nginx strips one `/api`, routers declare their own | `public/m/bench.js:1` and `capture.js:1` hardcode `const API = '/api/api'` — any new static phone page must too |
| Token scan-count filter e2e-tested on SQLite only | Postgres JSONB comparator path hand-verified, not test-covered | Aware-only; revisit if scan-cap bugs surface on Postgres |

## Infrastructure state

- **Devbox `forrestparker@100.73.137.3`** — THREE stacks UP: **`s3rehe`** (now the spec-4 UAT stack): Mk1 BE :5770 / FE :5772 / IS :5765 / COABuilder :5768 / WP :5775 / SENAITE :5778 / PG :5760 (user `postgres`, DBs `accumark_mk1` + `accumark_integration`). Login `forrest@valenceanalytical.com` / `s3rehe-uat`. UAT anchor: `http://100.73.137.3:5772/#senaite/sample-details?id=P-0141` → manage sub samples → Assignment tab. Validate: `ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack validate s3rehe'` (21/21). Restart Mk1 after git ops: `docker restart accumark-s3rehe-accu-mk1-backend accumark-s3rehe-accu-mk1-frontend` (bind mounts, no file-watch). **`s2e2e`** (spec-2 showcase) + **`catui`** (spec-1 UAT) still up, untouched.
- Laptop: no services started by this session.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Mk1 backend gate | `cd /c/tmp/Accu-Mk1-bench/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/ -q 2>&1 \| grep -E "^FAILED" \| sed 's/ - .*//' \| sort > /tmp/now.txt && diff /c/tmp/Accu-Mk1-bench/.superpowers/sdd/2026-07-30-catalog-driven-bench/baseline-failures.txt /tmp/now.txt` (empty = green) |
| Mk1 FE | `cd /c/tmp/Accu-Mk1-bench && npx tsc --noEmit` (NEVER `npm run check:all`); `npm run test:run` names vs `fe-baseline-failures.txt` |
| Stack health | `ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack validate s3rehe'` |
| Spec-4 live spot-check | `docker exec accumark-s3rehe-postgres psql -U postgres -d accumark_mk1 -c "select code, boxable, is_system from vial_roles order by sort_order;"` (6 rows incl. `stor`) |

## Outstanding items the user may want next

1. **Handler UAT on s3rehe** (in progress): the P-0141 walkthrough (Storage section, add-vial → auto-assign to `stor`, drag/reseed, custody in the activity feed), Vial Roles admin page, Analysis Profiles ride-hosts editor + SLA select, dynamic inbox lanes (HM chip), reassign dropdown, box-label fallbacks, BoxStep dark-launch (flip hm `boxable` and watch the column appear).
2. **Handler rulings pending (on PR #91 body + ledger):** (a) vial-delete custody CASCADE — accept-as-intended vs 409 guard (reviews lean accept; docstring already truthful); (b) 6 UAT display deltas (Analytical header, Endotoxin sub-label, single-role-micro sub-header drop, dept—label redundancies, PrintStep lexicographic print order, dept-prefixed reassign labels; + equal-width wrapped columns from `489dc1b`); (c) hm `boxable` flip after boxing rehearsal.
3. **G-RIDE / G-STATION** before those features go live: ride-list contents for vacuum/fent; station inventory + two final-review additions — long/indefinite station-token TTL (2h kills printed placards) and the scan-endpoint existence-oracle posture (cap 200 shipped).
4. **PR reviews/merges** (10 open across 4 repos; #91 merges after #90).
5. **Fix-later seams in the ledger:** `vials_required=0` anchor-vs-rider asymmetry (attach to G-RIDE/G-V); thread one `RoleFulfillment` through `compute_vial_plan` (3-4x re-resolve); bench-stations FE admin page; `sla-subjects.ts` (worksheet SLA surface) doesn't read profile tiers.
6. **Deploy-runbook additions** for the combined window: spec-4 has no new wire coupling but adds first-boot order (backfill_departments before vial_roles seed — self-heals now), the `RestartCount=0` seed-proof discipline, and the fresh-DB `_run_migrations()` note.
7. **Stack teardown** of `catui`/`s2e2e` (+ eventually `s3rehe`) + devbox worktrees when inspection is done.

## User collaboration preferences

- Push + PR per spec; **NO deploy until the ONE combined window** — sign-offs attach there. Additive only; failing tests default to "test is stale"; production-behavior changes need sign-off (that's why vial-delete-CASCADE is a ruling, not a fix).
- Drive forward without check-ins; surface only genuine blockers/decisions; prose recommendations over MCQ; full absolute paths everywhere.
- npm only (Mk1 FE); worktrees at `C:\tmp\<name>`; rich sectioned font-mono tooltips are the FE default.
- SDD discipline (kept the whole run): fresh implementer per task, opus reviews on risky diffs, RED-first fixes, minors to the ledger never the loop, ONE final wave. It caught real bugs in 8 of 13 tasks.
- The Handler tests hands-on and reports UI friction conversationally (the wrap fix came from live UAT) — fix small UI feedback immediately on the branch, push, and update the stack in the same breath.

## Recommended first action in the new session

Confirm ground truth, then ask what to drive:

```
git -C /c/tmp/Accu-Mk1-bench log --oneline -1                 # expect 489dc1b
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-s3rehe log --oneline -1'   # expect 489dc1b
tail -20 /c/tmp/Accu-Mk1-bench/.superpowers/sdd/2026-07-30-catalog-driven-bench/progress.md
```

If both heads read `489dc1b` and the ledger tail shows the PR-FEEDBACK + RUN-COMPLETE lines, everything above is current. The ledger and `git log` are authoritative over this document.
