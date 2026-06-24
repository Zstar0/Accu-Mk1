# Handoff: Variance Hardening — BW variance feature + Codex-finding fixes

*Created 2026-06-17. Paste this into a fresh session to resume with full context.*

---

You're picking up the **variance-capable Analysis Services** feature (peptide + Bacteriostatic Water variance on the COA) plus an in-flight **hardening pass** addressing two Codex adversarial-review findings. The core feature is **built, working end-to-end, and unmerged**; the hardening pass is **half done** (Finding 1 closed; Finding 2 = 3 tasks remaining). Your job is to finish the remaining hardening tasks (H3→H4→H5), then drive whatever the user asks next. Nothing here is a blocker — the feature functions; these are integrity/parity guards on an unmerged feature.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Accu-Mk1 (wave1 worktree) | `C:/tmp/accu-mk1-wave1` | `subsample-features` | `5c7bf48` (H1 lock-gate) |
| COABuilder (feature worktree) | `C:/tmp/coabuilder-varcap` | `feat/variance-capable-services` | `efadf8d` (H2 guard) |
| integration-service | `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service` | `subsample-features` | `5ed7fb1` (BW-variance validator fix) |
| accumarklabs (DevKinsta WP) | `\\wsl.localhost\docker-desktop-data\data\docker\volumes\DevKinsta\public\accumarklabs` | `subsample-features` | `fa3a492` (compact BW label) |

**Nothing merged to master** — the merge is the user's explicit deploy gate. COABuilder feature branch is `feat/variance-capable-services` (a worktree at `C:/tmp/coabuilder-varcap`, off master `b66635c`), NOT the `coabuilder-master` worktree.

## What's on the branch (layered)

**Layer 1 — Variance-capable feature (DONE, committed across 4 repos).** Generalized variance testing from the hardcoded peptide-HPLC bucket model to a per-`AnalysisService.variance_capable` flag, enabling BW variance (pH, Benzyl Alcohol, Fill Volume). Accu-Mk1: `variance_capable` column + run-once BW backfill, admin toggle, `build_variance_analyte_series` (keyword-keyed), `variance_analytes` sent on the direct Mk1→COABuilder `/process` call, BW-aware `derive_variance_demand` (hplc bucket reads `hplcpurity_identity` OR `bac_water_panel`). COABuilder `feat/variance-capable-services` @ **2.27.0**: shared `variance_stats.py`, `GenericAssayEngine` renders BW variance with an **all-replicates-in-range** verdict (Handler decision; diverges from peptide mean-based by design; pH 4.5–7.0 + Benzyl Alcohol 0.81–0.99 get verdicts, Fill Volume has no baked spec → informational). WP: variance vial selector for BW in the order wizard + compact "Variance (N additional vials)" line label. IS: removed the order-intake guard that 422'd BW + variance.

**Layer 2 — Live-test fixes (DONE).** Order #3257 (BW-0016) 422'd at the IS — removed the BW-variance rejection in `order_validator.py` (`5ed7fb1`). Then the Receive screen showed "1 vial" instead of 4 — root cause was the Mk1 backend running **stale pre-T10 code** (no `--reload`, not restarted after the entitlement commit); `docker restart accu-mk1-backend` fixed it. Verified the live plan: `demand {hplc:1}` + `variance {hplc:3}` = 4 vials.

**Layer 3 — Hardening pass (IN PROGRESS; user approved "harden both paths now" + "gate generate on lock").** Two Codex adversarial-review findings — both **pre-existing properties of the lab-approved peptide variance system**, surfaced via the BW diff, NOT regressions:
- **Finding 1 — DONE.** H1 (`5c7bf48`, Mk1): COA generation blocked if variance purchased + set not locked (`422 variance_not_locked`); pure helper `variance_lock_required` in `sub_samples/service.py` + 4 tests; applies to peptide + BW. H2 (`efadf8d`, COABuilder): `_apply_variance` withholds the verdict (→ IN REVIEW, `conforms=None`) when a value is unparseable or the parent figure is missing — never falsely CONFORMS on incomplete data; tests rewritten + added.
- **Finding 2 — TODO (3 tasks, "Approach X").** `/process-additional` re-fetches SENAITE bare, so re-branded/additional COAs lose variance (could show PASSED while primary FAILED). Approach X chosen over Y (Y = reuse primary `coa_data`; rejected — stored `coa_data` is lossy for the PDF series + needs a CoAData reconstructor). See "Outstanding" for the H3/H4/H5 specs.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| Mk1 backend has **no `--reload`** | Code edits on the bind-mounted worktree do NOT go live until restart — this caused the "1 vial" false bug after a committed entitlement change | `docker restart accu-mk1-backend` after ANY backend code change; same for `integration-service` and `coabuilder_service` |
| Git Bash mangles absolute container/UNC paths | `docker exec ... /www/...` became `C:/Program Files/Git/www/...`; psql/grep paths broke | `export MSYS_NO_PATHCONV=1` before docker exec / UNC path commands |
| `order_submissions.order_id` is **varchar** | `WHERE order_id = 3257` → "operator does not exist: character varying = integer" | Quote it: `WHERE order_id = '3257'` |
| `curl` is NOT in the slim `accu-mk1-backend` image | Can't curl the IS from inside the backend | Use `python` (it's present) — e.g. `docker exec accu-mk1-backend python -c "import sub_samples.service as s; ..."` |
| `fetch_sample_services()` returns a **wrapper** | Returns `{services:{...}, analytical_test, wp_order_number}` — `derive_*` need the INNER `services` dict | `derive_variance_demand((resp or {}).get("services") or {})` |
| WP payload keys ≠ Mk1 keys | WP order log shows `bacwaterpanel` (frontend-normalized) but the IS persists Mk1-normalized `bac_water_panel`; the variance map key is `bac_water_panel` either way | Mk1's inner services use `bac_water_panel`/`hplcpurity_identity`; the IS `SampleServices` Pydantic aliases handle the mapping |
| COABuilder pre-existing test failure | `tests/test_generic_page2_layout.py` fails with `ModuleNotFoundError: reportlab` — NOT a regression | Ignore that one; full suite otherwise green (79 passed, 1 failed) |
| GitNexus stale-index hook + `npx gitnexus` | Fires on most Bash calls in the IS repo; `npx gitnexus analyze` is **blocked by the sandbox** (and subagents tried it) | Treat the hook as advisory; do NOT run npx/gitnexus. IS `CLAUDE.md` mandates `gitnexus_impact` before edits — use the MCP `mcp__gitnexus__impact` tool (works on the existing index) |
| COABuilder UAT image is baked | `coabuilder_service` :5000 runs the BAKED image, NOT the `coabuilder-varcap` checkout — branch edits aren't live on the wave1 stack without intervention | See memory `architecture_coabuilder_container_topology` to get branch COABuilder live for E2E |

## Infrastructure state (wave1 stack — what the user tests against)

- `accu-mk1-backend` :8012 (no --reload; bind-mounts `C:/tmp/accu-mk1-wave1` → `/app`) — **restarted this session, running current code**.
- `accu-mk1-frontend` :3101 (Vite, no HMR across bind mount; `docker restart accu-mk1-frontend` after FE edits).
- `integration-service` :8000 (bind-mounts the workspace IS worktree → `/app`, no --reload) — **restarted this session**. This is the IS that DevKinsta WP AND wave1 Mk1 both call. IS→Mk1 uses `ACCUMK1_BASE_URL` + `X-Service-Token` (S2S).
- `coabuilder_service` :5000 (BAKED image — not the feature branch; see gotcha).
- `accumark_postgres` :5432 — DBs `accumark_mk1`, `accumark_integration`.
- DevKinsta WP `accumarklabs.local` (`devkinsta_fpm` PHP 8.2, `devkinsta_nginx`); mail UI `devkinsta_mailhog` **:15400**. Theme JS auto-cache-busts via `filemtime` enqueue. Theme lives in 2 places — deploy edits to DevKinsta AND the `:5535` subvial stack if testing there.
- Separate stacks (do not confuse): `accumark-subvial-*` (:55xx), `accumark-host-*` (:55xx).

## Verification commands (re-run, don't trust stale numbers)

| What | Command |
|---|---|
| Mk1 lock-gate (H1) | `docker exec accu-mk1-backend python -m pytest tests/test_variance_lock_gate.py -v` |
| Mk1 variance series/demand | `docker exec accu-mk1-backend python -m pytest tests/test_variance_analyte_series.py tests/test_variance_demand.py -q` |
| COABuilder variance (H2 + feature) | `cd /c/tmp/coabuilder-varcap && python -m pytest tests/test_generic_engine_variance.py tests/test_variance_report.py -q` (ignore pre-existing reportlab failure) |
| IS BW-variance validator | `cd .../integration-service && ./.venv/Scripts/python.exe -m pytest tests/unit/test_order.py -k "bw or bac" -q` |
| Live BW plan sanity | `docker exec accu-mk1-backend python -c "from database import SessionLocal; import sub_samples.service as s; db=SessionLocal(); print(s.compute_vial_plan(db,'BW-0016').get('variance')); db.close()"` (expect `{'hplc':3,...}`) |

## Outstanding items the user may want next

1. **Finish Finding 2 (Approach X) — H3 → H4 → H5.** Detailed in memory `project_variance_capable_services`. Execute in order (cross-repo chain; don't leave half-wired):
   - **H3 (Mk1):** new S2S endpoint (X-Service-Token auth, like `/peptide-requests`) returning `{variance_replicates, variance_analytes}` for a `sample_id` — looks up the parent `LimsSample`, calls `build_variance_replicates` + `build_variance_analyte_series`. Find Mk1's existing S2S verifier (the one guarding `/peptide-requests`) and reuse it.
   - **H4 (COABuilder):** `ProcessAdditionalRequest` (`scripts/server.py:876`) += `variance_replicates`, `variance_analytes` (Optional); `/process-additional` (~line 922) passes them to `fetch_sample_data` — mirror `/process` (lines 555-593).
   - **H5 (IS):** `AccuMk1Adapter.get_variance_payload(sample_id)` (GET the H3 endpoint, S2S, 404→None); `_trigger_additional_coa_if_published` (`app/api/webhook.py:640-720`) fetches it and adds the two fields to the `/process-additional` body (line ~693). Fail-soft. Run `mcp__gitnexus__impact` on the trigger fn before editing (IS `CLAUDE.md` rule).
2. **T12 — version bumps + full E2E.** Mk1 → 1.0.2 (package.json/tauri.conf.json/Cargo.toml+lock; backend `APP_VERSION` reads package.json); theme → 2.27.0; changelogs. Then E2E on the wave1 stack (needs branch COABuilder made live — baked-image gotcha): flag pH/BA/FillVol, set HPLC variance override on a BW sample, assign + seed variance vials, sign off, **lock** the variance set, generate + publish, confirm the COA stat line + verdict + WP verify page.
3. **Merge** all four feature branches to master (user's explicit go), then the 1.0 deploy (use the `accumark-deploy` skill; IS must be redeployed too — it's now in the change set).
4. **Codex review re-run** (optional): after H3-H5, re-run `/codex:adversarial-review` to confirm both findings are addressed.

## User collaboration preferences

- **Decisive, drive-forward.** Says "proceed"/"continue" — wants momentum, not repeated confirmation. But genuine design/workflow forks (e.g. lock-before-generate, scope of hardening) ARE the user's call — surface them with a recommendation.
- **Additive-only; don't re-architect** shipped/just-shipped systems. Both Codex findings were correctly treated as parity-with-peptide + separate hardening, not a reactive rewrite.
- **Merging to master is the deploy gate** — commit on feature branches freely; get explicit go before merging.
- **Verify against domain truth**, don't over-assert from code inference (e.g. BW all-in-range vs peptide mean was a lab/Handler decision, not inferred).
- **Subagent-driven execution** worked well: implement → spec review → code review per task, with fixes looped back to the same implementer. Use cheap models (sonnet) for mechanical tasks; reserve heavier review for keystone/shipped-path changes. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- This session **chose "harden both paths now"** + **"gate generate on lock = yes"** — H1-H5 follow from that. Approach X (not Y) for Finding 2.

## Recommended first action in the new session

Confirm state, then start **H3**. Run:
`git -C C:/tmp/accu-mk1-wave1 log --oneline -3 && git -C C:/tmp/coabuilder-varcap log --oneline -3 && git -C .../integration-service log --oneline -3`
to confirm the heads above, then dispatch the H3 implementer (Mk1 S2S variance-payload endpoint) per the spec in item 1 and memory `project_variance_capable_services`. Execute H3→H4→H5 as a single chain so Finding 2 is never left half-wired across repos.
