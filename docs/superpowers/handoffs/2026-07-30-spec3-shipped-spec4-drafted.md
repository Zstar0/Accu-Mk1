# Handoff: Spec 3 SHIPPED (4 PRs) + Spec 4 drafted — catalog-driven bench next

*Created 2026-07-30 (session ran past midnight; some artifacts stamp 2026-07-31). Paste this into a fresh session to resume with full context.*

---

You're picking up the new-test-families program. **Spec 3 (Catalog Order Routing) is fully executed, rehearsed, final-reviewed "Ready to merge — Yes", pushed, and PR'd across four repos. Spec 4 ("Catalog-driven bench") is DRAFTED but not planned or executed.** Deployment of everything remains deferred to ONE combined window per standing Handler ruling. Your job is to drive whatever the user asks next — most likely spec-4 planning, PR review support, UAT follow-ups, or the deploy window itself.

## Working directories (verified fresh at handoff time)

| Repo / dir | Path | Branch | Head |
|---|---|---|---|
| Mk1 spec-3 worktree | `C:\tmp\Accu-Mk1-order-routing` | `feat/catalog-order-routing` | `ef1eddb` (clean) |
| IS spec-3 worktree | `C:\tmp\is-order-routing` | `feat/catalog-order-routing` | `5cabb6f` (clean; ignore `.planning/STATE.md` if it reappears) |
| COABuilder spec-3 worktree | `C:\tmp\coabuilder-order-routing` | `feat/catalog-order-routing` | `baeebeb` (`logs/coabuilder.log` dirty — NEVER commit it; `app_settings.json` present, has creds, NEVER commit) |
| WP spec-3 worktree | `C:\tmp\accumarklabs-order-routing` | `feat/catalog-order-routing` | `27033c3` (cut from prepaid-merge master `7f0982f`) |
| Mk1 main checkout (docs) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` | `docs/analysis-catalog-specs` | spec-4 doc + spec-3 plan are UNTRACKED here (not yet committed to the docs branch) |
| Spec-2 worktrees | `C:\tmp\Accu-Mk1-coa-sections` · `C:\tmp\coabuilder-coa-sections` · `C:\tmp\is-coa-sections` | `feat/native-coa-sections` | unchanged from prior handoff |

**Open PRs (all "merge when Handler reviews, deploy in ONE combined window"):** spec 3 — Mk1 [#90](https://github.com/Zstar0/Accu-Mk1/pull/90) (chain #87→#88→#89→#90, auto-retargets on merge) · IS [#20](https://github.com/ValenceAnalytical/accumark-integration-service/pull/20) (on #19) · coabuilder [#6](https://github.com/ValenceAnalytical/coabuilder/pull/6) (on #5) · accumarklabs [#20](https://github.com/Zstar0/accumarklabs/pull/20) (base master). Plus the pre-existing spec-1/2 PRs (#87/#88/#89, coab #5, IS #19).

## What's on the branches

**Layer 1 — spec-3 execution (SDD, 10 tasks + final fix wave, this session):** Mk1: catalog demand (`backend/sub_samples/catalog_demand.py`, MAX-per-role, legacy shadow-compare where legacy WINS divergent legacy buckets + `demand_divergence` ERROR), catalog seeding (`_catalog_members_for_role`, shared `_seed_rows_from_services` helper), `hm` role at every site (own "Heavy Metals" department + inbox lane; runtime variance guard `_VARIANCE_INELIGIBLE_ROLES={"hm"}` in `backend/sub_samples/service.py` ~:1598), hygiene riders (ordered_keys dedup, PUR_/QTY_ reserved prefixes, fulfillment validation + legacy-role/xtra reservation), profiles admin fulfillment fields + client-side role guard, native parent analyses card (`service.list_native_parent_analyses`, origin='mk1' + provenance='canonical' only), shape-driven box-label/capture counts. IS: `SampleServices` → `ConfigDict(extra="allow")` + field-wins `model_serializer`; `NATIVE_SERVICE_KEYS={"heavy_metals"}`/`KNOWN_SERVICE_KEYS` in `app/services/order_validator.py`; recorded 422 in the VALIDATOR (never parse-time); native-only orders pass with zero SENAITE profiles; peptide-identity lookup gated. COABuilder: `native_section_unit_divergence` warning (does NOT cover ENDO-LAL — legacy engine path; G-ENDO stays sole control). WP: `profile_key` column on wc_test_services; `serviceWireKey()` in BOTH JS paths; catalog-addon state machine fixed through 4 review rounds (overlay hydration two-pass, AccuShield exclusions via `getCatalogAddonKeys()`, the `globalAddons`-never-carries-catalog-truth invariant closed by snapshot-restore in `applySample1Defaults`).

**Layer 2 — proof:** stack `s3rehe` rehearsal, ALL 8 PROOFS PASS (749-line report). Notables: fresh-DB seed proof at RestartCount=0; **SENAITE ACCEPTS bare ARs** (native-only orders viable; empty ARs park at sample_due forever); wire keys byte-identical via the real `serviceWireKey` over live data; 422 recorded; hm vial demand/seed/lane/variance all green; COA `MXK6-LD7S` renders the Heavy Metals table. **G-KEYS deploy gate PASSED** (controller ran read-only prod enumeration: exactly 6 keys / 1,877 HPOS orders / legacy postmeta empty).

**Layer 3 — spec-4 draft (Handler design session, end of this session):** `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-07-31-catalog-driven-bench-design.md`. Handler RULINGS locked: **Analysis Profile is the one lab-facing concept** (groups frozen, retire by starvation; SLA moves group→profile); roles auto-mint 1:1 with profiles (role=key, profile=face); **ride lists** express conditional vial sharing (standalone rider MINTS ITS OWN role's vial — Handler-locked; shared-role-as-sharing-mechanism RETIRED because standalone would mis-seed via the hplc mirror path); **`vial_profile_assignments` custody edges** (immutable, host|rider, written with the plan) = ISO 17025 backbone; dynamic assignment page (department-row sections, profile-faced spots, rider chips); bench_stations + QR scan-in events. **BacWater CORRECTED: panel = Benzyl Alc + pH + Fill Volume (all Analytical); Endo is an add-on with its own vial — NO current product spans departments.** Hierarchy artifact (corrected): https://claude.ai/code/artifact/156b985d-211e-4833-8d17-c1aeeda6fafb

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| The SDD ledger is the authoritative record and was deliberately KEPT | 40+ deferred minors + parked rulings + deploy facts live there | `C:\tmp\Accu-Mk1-order-routing\.superpowers\sdd\2026-07-30-catalog-order-routing\progress.md`; task reports + rehearsal report in the same dir |
| Platform bug (NEW, unsigned): stack `mount` bind-mounts worktree mu-plugins OVER restore.sh's | WP→IS silently unwired ("Integration service not configured") on ANY stack mounting accumarklabs | Hand-fixed on s3rehe; re-fix after any re-mount; platform fix needed |
| The hm vial is INVISIBLE in BoxStep (boxing flow) | `BOXABLE_ROLES` in `backend/boxes/service.py` excludes hm — G-PUB blocker-class | Spec-4 Layer 5 absorbs it; do NOT hack it standalone |
| AssignStep panel hardcodes 3 buckets; hm vial renders NOWHERE on it | Xtra filter is `role === 'xtra' \|\| role == null` — hm matches no bucket | Spec-4 Layer 4 (dynamic assignment page) is the fix; assignment itself works server-side |
| The demand shadow-compare ZERO-CLAMPS new profiles on legacy roles | A paid add-on would silently un-provision | Enforcement rider shipped (400 on legacy roles for non-legacy keys, xtra reserved); rider retires WITH the compare |
| PRE-EXISTING LIVE BUG (not this branch): WP `?edit_order=` drops endotoxin on edit-and-resubmit | `sampleData.addons` is ALWAYS undefined (no payload ever carried it) → `{...globalAddons}` fallback always fires | Surface to Handler; fix as its own slice; repro on accumarklabs.local only |
| Theme `deploy.sh` has a PLAINTEXT SSH password committed (dead host, but in git history) | Credential hygiene | Rotate/remove independent of spec work |
| IS 129-line failure baseline includes a WEBHOOK_SECRET env-gap class | Zero-failure or naive-diff gating looks broken | Baselines + lint counts in the sdd dir (`is-baseline-*.txt`); diagnostic runs need `WEBHOOK_SECRET` set |
| Mk1 backend drops ALL logger.info (no basicConfig) BUT `demand_divergence` is ERROR and DOES emit | Log-based assertions mislead; the one drill signal works | Behavior/DB proofs first; `docker logs --since` parses naive timestamps as LOCAL time (false negatives — bit the rehearsal) |
| Each repo's venv lives in the MAIN checkout | Wrong interpreter = bogus results | Mk1 `...\Accu-Mk1\backend\.venv\Scripts\python.exe`; IS/coabuilder `...\<repo>\.venv\Scripts\python.exe`; run FROM the worktree |
| WP repo root = the WordPress INSTALL root; live DevKinsta tree is on `feat/prepaid-balance`; local `master` ref pinned by stale `C:\tmp\wpstar-coa-export` worktree | Wrong-tree edits / failed fetches | Work only in `C:\tmp\accumarklabs-order-routing`; leave the stale worktree alone |
| Spec-4 doc + spec-3 plan are UNTRACKED on the docs branch | A `git clean` in the main checkout would delete them | Commit them to `docs/analysis-catalog-specs` early next session |
| Teammate/agent idle notifications arrive without their final report | Looks like the agent finished silently | SendMessage asking them to send the report to "main" |

## Infrastructure state

- **Devbox `forrestparker@100.73.137.3`** — THREE stacks deliberately UP for Handler inspection:
  - **`s3rehe`** (spec-3 rehearsal): ports 5760-5779 — Mk1 BE :5770 / FE :5772 / IS :5765 / COABuilder :5768 / WP :5775 (SSH local-forward needed from laptop) / SENAITE :5778 / PG :5760. Login `forrest@valenceanalytical.com` / `s3rehe-uat`. Showcase COA `MXK6-LD7S`. Artifacts: `forrestparker@100.73.137.3:~/s3rehe-artifacts/` (REHEARSAL.md, PDFs, scripts). Compose override with `ACCUMK1_*`/`COA_BUILDER_URL` env vars — wiped if `mount` reruns, reapply + force-recreate.
  - **`s2e2e`** (spec-2 showcase, LANA-J3TU): ports 5720-5739. **`catui`** (spec-1 UAT): 5740-5759.
  - Destroy via `cd ~/accumark-stack && ./bin/accumark-stack destroy <name> --yes` + remove `~/worktrees/*-<name>` when the Handler is done.
- Laptop: no services started by this session.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Mk1 gate | `cd /c/tmp/Accu-Mk1-order-routing/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/ -q 2>&1 \| grep -E "^FAILED" \| sed 's/ - .*//' \| sort > /tmp/now.txt && diff /c/tmp/Accu-Mk1-order-routing/.superpowers/sdd/2026-07-30-catalog-order-routing/baseline-failures.txt /tmp/now.txt` (64 baseline; suite has one known flake `test_peptide_request_update_fields`) |
| Mk1 FE | `cd /c/tmp/Accu-Mk1-order-routing && npx tsc --noEmit` (NEVER `npm run check:all`) |
| IS gate | `cd /c/tmp/is-order-routing && <IS-main-venv-python> -m pytest -q` → diff vs `is-baseline-failures.txt` in the Mk1 sdd dir; `ruff check .` (2464) + `mypy app` (241/44 files) net-zero |
| COABuilder gate | `cd /c/tmp/coabuilder-order-routing && SENAITE_URL=http://x SENAITE_USERNAME=t SENAITE_PASSWORD=t <coab-main-venv-python> -m pytest -q --ignore=scripts/test_ui_mock.py` (5-failure baseline in sdd dir) |
| WP | no framework: `node --check` both JS files, `php -l` touched PHP; real gate = stack rehearsal |
| Stack health | `ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack validate s3rehe'` (21/21) |

## Outstanding items the user may want next

1. **Spec-4 planning** (Catalog-driven bench): spec at `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-07-31-catalog-driven-bench-design.md`. Mk1-only, builds on `feat/catalog-order-routing` or post-merge master. Recon→plan→SDD per program convention. It absorbs the spec-3 deferred FE shapes + BOXABLE_ROLES. Open gates G-RIDE/G-STATION + 2 open questions in the doc.
2. **Handler UAT on `s3rehe`** — a full punch list was delivered in-session (catalog admin validation 400s, native parent card, receive-desk counts, WP wizard legacy regression + overlay leak sequence, console-substitute HM order, IS 422/bare-AR checks, judgment calls: card sort order, "HM HM" glyph, bare-AR accumulation, MAX-per-role ratification).
3. **PR reviews/merges** (9 open across 4 repos; Mk1 chain #87→#90 merges in order; only safe deploy order IS → Mk1 → WP-entry-flip; seed `coa_archetype` LAST).
4. **Deploy-runbook additions** to the `accumark-deploy` skill: G-KEYS evidence citation, post-flip `GET /analysis-profiles` presence check, `demand_divergence` ×4-paths-no-dedup alerting decision, IS debug-log services shape change (variance bool→dict), row-clone profile_key trap, bare-AR accumulation, seed-catalog-LAST, ENDO-LAL unit fix (G-ENDO — the new COABuilder warning does NOT cover it).
5. **Fix the live `?edit_order=` endotoxin-loss bug** (own slice, WP).
6. **Platform fixes (unsigned):** mount-clobbers-mu-plugins (NEW); minio-init create-abort; ACCUMK1_*/COA_BUILDER_URL compose wiring; Mk1 logging basicConfig.
7. **Commit the untracked docs** (spec-4 doc, spec-3 plan, this handoff) to `docs/analysis-catalog-specs`.
8. **Stack teardown** of `catui`/`s2e2e`/`s3rehe` + devbox worktrees when inspection is done.

## User collaboration preferences

- Push + PR per spec; **NO deploy until the combined window** — sign-offs attach there. Additive only; failing tests default to "test is stale"; production-behavior changes need sign-off.
- Explicit-path staging always; full absolute paths in every reference; prose recommendations over MCQ; drive forward without check-ins; surface only genuine blockers/decisions.
- npm only (Mk1 FE); Zustand selector syntax; shadcn sectioned font-mono tooltips; worktrees at `C:\tmp\<name>`.
- The user thinks out loud and expects push-back grounded in code — this session they overturned two recorded "facts" (BacWater membership; sharing-by-shared-role) by argument, and both corrections made the design better. Concede when the code agrees with them; hold when it doesn't (the merge question died on their own pH example).
- SDD process discipline: fresh implementer per task, opus reviews for risky diffs, RED-first fix proofs, minors to the ledger never the loop, ONE final fix wave. It caught real bugs every single task — keep it.

## Recommended first action in the new session

Confirm ground truth, then ask which outstanding item to drive:

```
git -C /c/tmp/Accu-Mk1-order-routing log --oneline -1        # expect ef1eddb
git -C /c/tmp/is-order-routing log --oneline -1              # expect 5cabb6f
git -C /c/tmp/coabuilder-order-routing log --oneline -1      # expect baeebeb
git -C /c/tmp/accumarklabs-order-routing log --oneline -1    # expect 27033c3
tail -15 /c/tmp/Accu-Mk1-order-routing/.superpowers/sdd/2026-07-30-catalog-order-routing/progress.md
```

If the heads match and the ledger tail shows the PR list after "SPEC-3 SDD RUN COMPLETE", everything above is current. The ledger and `git log` are authoritative over this document.
