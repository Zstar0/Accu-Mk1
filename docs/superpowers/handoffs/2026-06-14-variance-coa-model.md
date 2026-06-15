# Handoff: Variance COA Certification Model — parked pending lab decision

*Created 2026-06-14. Paste this into a fresh session to resume with full context.*

---

You're picking up a session that (1) **shipped** several P-0149 variance conformance fixes and (2) then hit a **fundamental design question that is now PARKED awaiting a lab decision**: how should we certify "variance" samples (multiple vials from the same lot) on a COA? Code is at a clean stop. The headline caution: **hold COABuilder `2.21.0` out of prod** until the variance-COA model is decided — its overall-status change is global and may be revised by the lab's answer.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| **Accu-Mk1** (FE+BE checkout) | `C:/tmp/accu-mk1-wave1` | `subsample-features` | `a64f9a1` (pushed; tree has 2 untracked brief files) |
| **COABuilder** | `C:/tmp/coabuilder-variance` | `feat/coa-identity-na-variance` | `d36da74` = **v2.21.0** (pushed; `logs/` dirty, ignore) |
| accumarklabs (WP) | DevKinsta / Kinsta | `subsample-features` | untouched this session |
| integration-service | `…/Accumark-Workspace/integration-service` | — | untouched this session |

Both feature branches are committed + pushed. The only uncommitted items are the two lab-brief files (see Outstanding #5).

## What's on the branch

**Layer 1 — Customer Remarks "Include with Publish?" (SHIPPED + deployed earlier this session):**
- Mk1 `4ea0d0a`→`2d77ad2`: `lims_samples.customer_remarks_include` (BOOL, default TRUE) + `customer_remarks_delivered_at`; generate-COA gates `lab_remarks` on the flag, always sends `include_lab_remarks`, stamps `delivered_at`; FE checkbox + "Delivered on" line.
- COABuilder `aa501d0` = **2.19.0**: `/process` honors `include_lab_remarks` (skips the non-conforming gate on intentional suppression). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-13-customer-remarks-include-toggle*`.

**Layer 2 — P-0149 variance conformance bug chain (SHIPPED):**
- Mk1 `57f2797`: `build_variance_replicates` must select the **current** vial row (`retested.is_(False)`), not `retest_of_id IS NULL` (which returned the superseded original). Fixed the COA showing identity "Conforms 3/3" when S03 was retested to "Does Not Conform".
- Mk1 `a64f9a1`: same-class fix in two more vial-row consumers — `_fetch_mk1_results_for_host` (feeds `get_variance_set` / in-app Variance Summary) and `families._gather_analytes` (feeds `_derive_state`). Audit of all `retest_of_id IS NULL` vial-row reads is **complete** (2 fixed, rest correct). Tests: `test_retest_current_row.py`.
- COABuilder `aad4816` = **2.20.0**: PDF `results_table` PURITY row now rolls up the variance series (only identity-passing figures count; identity-failed vials → N/A, excluded). Was primary-only → showed CONFORMS with a below-spec replicate.
- COABuilder `d36da74` = **2.21.0**: `overall_status`/`overall_pass` now FAILS when **any** reported IDENTITY or PURITY row is non-conforming (was gated only by parent/blend identity). P-0149 now → FAILED.

**Layer 3 — the PARKED design question (no code; this is the resume point):**
Shipping 2.21.0 surfaced a **digital-COA contradiction**: the AccuVerify verify page badge now reads "DOES NOT CONFORM" (from `overall_status`) while the Core Panel shows only the single **parent** figure — Purity 99.99% CONFORMS, Identity BPC-157 CONFORMS. The verify/digital view was built to show one representative result; the variance series only ever went onto the PDF. So the headline and the visible rows contradict each other.

User clarified the domain: **variance vials = different vials the customer sent from the same LOT** → this is a **uniformity / multi-unit** assessment (not same-material precision). User is **leaning toward**: the COA reports an **aggregate (mean)** result + one verdict per test, and we **also** publish the per-vial **Variance Report**. **User is asking the lab to decide** the exact rules first. A decision brief was produced (4 decisions, P-0149 worked example, suggested conservative default) as `docs/2026-06-14-variance-coa-lab-decision-brief.md` (+ `.html`) and a Slack Canvas: https://valence-analytical.slack.com/docs/T0A9LFNLYKY/F0BA37KUN4F

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **HOLD COABuilder 2.21.0 from prod** | The overall-status change is **global**, not P-0149-only: any COA with a below-spec purity or non-conforming identity now reads FAILED where it may previously have read PASSED. The lab's aggregation decision (mean vs worst-case) may revise this logic entirely. | Do NOT merge/deploy the coabuilder branch to prod until the variance-COA model is decided. Local `:5000` is fine for UAT. |
| **Digital-COA contradiction is still LIVE (by design, pending decision)** | Verify-page badge = `overall_status` (FAILED); Core Panel rows = `coa_data.results` (single parent figure, CONFORMS). Self-contradictory to a customer. | This is the core thing the lab decision resolves — the Core Panel must show the model's reportable result so badge + rows agree. Don't "fix" piecemeal before the model is set. |
| **`coa_data` is frozen at generation time** | Old generations keep their old verdict; only a **fresh regen** picks up the deployed COABuilder version. P-0149 gens #1 (published) / #2,#3 (draft) hold the pre-2.21.0 PASSED snapshot. | To see current behavior, regenerate. Latest gen's `coa_data` lives in `accumark_integration.coa_generations`. |
| **COABuilder deploy = rebuild baked image, not bind mount** | wave1 backend calls `COA_BUILDER_URL=http://host.docker.internal:5000` → container `coabuilder_service` (a **baked** `coabuilder-coabuilder` image). Editing `/c/tmp/coabuilder-variance` does NOT update `:5000` without a rebuild. (`:5528` = `accumark-subvial-coabuilder` bind-mounts the branch but wave1 doesn't hit it.) | Rebuild + recreate (see Infrastructure). See memory `architecture_coabuilder_container_topology`. |
| **COABuilder tests: host python only** | `docker exec accumark-subvial-coabuilder ... pytest` fails ("No module named pytest"). | Run `cd /c/tmp/coabuilder-variance && python -m pytest tests/`. |
| **Two pre-existing COABuilder collection/test failures (NOT regressions)** | `python -m pytest` (no path) hits `scripts/test_json_load.py` which `sys.exit(1)`s at import (INTERNALERROR). `tests/test_generic_page2_layout.py::...test_ph_not_duplicated_on_page2` fails with `ModuleNotFoundError` in the host env (verified identical with my changes stashed). | Run `pytest tests/` and `--deselect` the page2 test. Expect **44 passed, 1 deselected**. |
| **Retest current-row idiom** | Reading a **vial** row's current value → `retested.is_(False)`. `retest_of_id IS NULL` = the superseded original once retested. Parent-tier rows keep `retest_of_id IS NULL`. | See memory `architecture_retest_current_row_idiom`. |
| **Variance purity/identity rule** | Identity-failed vial → N/A for Qty + Purity, **excluded** from the purity verdict, still represented on the PDF. Purity conforms ⇔ every identity-passing figure clears spec. | See memory `domain_variance_identity_gated_conformance`. |
| Mk1 backend no `--reload`; Vite serves stale across the bind mount | Edits don't take effect live. | `docker restart accu-mk1-backend && sleep 6`; `docker restart accu-mk1-frontend` after FE edits. |

## Infrastructure state

- **`coabuilder_service`** — `:5000` (what wave1 hits), running **2.21.0** (rebuilt this session). Redeploy:
  `cd /c/tmp/coabuilder-variance && docker build -t coabuilder-coabuilder:latest .` then
  `docker compose -f "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/docker-compose.yml" -p coabuilder up -d --no-build --force-recreate coabuilder`. Verify `curl -s http://localhost:5000/version`. (Do NOT rebuild from the OneDrive `coabuilder` dir — it's stale at 2.14.8.)
- **`accu-mk1-backend`** — `:8012`, binds `C:/tmp/accu-mk1-wave1/backend`, **no --reload** → restart after BE edits.
- **`accu-mk1-frontend`** — `:3101` (Vite), binds wave1 `src`; restart after FE edits.
- **`accumark_postgres`** — DBs: `accumark_mk1` (Mk1) and `accumark_integration` (IS; `coa_generations.coa_data` JSONB holds `results`, `variance_report`, `overall_status`).
- `integration-service` `:8000` · `senaite` `:8080`. Redundant `accumark-subvial-*` / `accumark-host-*` stacks still running — ignore.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Branch/version | `git -C /c/tmp/accu-mk1-wave1 log --oneline -3` (expect `a64f9a1`) · `curl -s http://localhost:5000/version` (expect `2.21.0`) |
| Mk1 variance + retest + remarks | `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_variance_series.py tests/test_retest_current_row.py tests/test_customer_remarks.py -q"` |
| COABuilder | `cd /c/tmp/coabuilder-variance && python -m pytest tests/ -q --deselect "tests/test_generic_page2_layout.py::TestRenderedPdfHasNoPhLeak::test_ph_not_duplicated_on_page2"` (expect 44 passed, 1 deselected) |
| Latest P-0149 generation verdict | `docker exec accumark_postgres psql -U postgres -d accumark_integration -tA -c "SELECT generation_number, verification_code, coa_data->>'overall_status' FROM coa_generations WHERE sample_id='P-0149' ORDER BY created_at DESC LIMIT 3"` |

## Outstanding items the user may want next

1. **THE decision (blocking everything below).** Lab answers the 4 questions in the brief / canvas: (1) purity/quantity mean-only vs mean+individual-check, (2) identity "N of M confirmed" + how a miss affects the lot + whether to exclude failed-identity vials from the mean, (3) what the COA displays, (4) quantity reporting. Once decided → **brainstorm → spec → implement** the chosen variance-COA model.
2. **Reconcile the digital COA** as part of #1: the verify-page Core Panel must render the model's reportable result so the badge and the rows agree (no more FAILED-badge-over-CONFORMS-rows). Likely also: build/finish the separate **Variance Report** surface.
3. **Revisit COABuilder 2.21.0** `overall_status` logic against the lab's aggregation rule — if they pick mean-aggregation, the worst-case "any below-spec vial → FAILED" likely changes to a mean-based verdict.
4. **Deploy** once the model ships: hold the coabuilder branch from prod until #1; then use the `accumark-deploy` skill. Carries forward JWT_SECRET consistency + the WP Variance data setup from older handoffs.
5. **Commit the two brief files** (`docs/2026-06-14-variance-coa-lab-decision-brief.md` + `.html`) if wanted — currently untracked.
6. **Optional:** post the Slack canvas into a specific channel (not done — only the canvas was created).

## User collaboration preferences

- One finding at a time; **evidence before fixes**; systematic debugging (root cause first, instrument boundaries).
- **TDD where it reduces risk** (pure helpers, conformance logic); a failing test defaults to "test is stale," not "code is wrong" (e.g. `test_status_is_parent_driven` was updated this session).
- **Additive-only**, follow existing patterns; **confirm before prod / irreversible / live-SENAITE** writes. PB-/P- #### are test samples, OK to mutate once authorized.
- Per-logical-unit commits with detailed bodies; `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; **push after committing** for backup.
- Engages decisively on design questions, but **defers compliance/domain semantics to the lab** — don't force a decision; arm them with options and worked examples. No vibes-based conformance.
- Never run GitNexus `--embeddings` (external egress); the stale-index advisory on every Bash is benign.

## Recommended first action in the new session

Confirm state, then ask about the decision:
`git -C /c/tmp/accu-mk1-wave1 log --oneline -3` (expect `a64f9a1`) and `curl -s http://localhost:5000/version` (expect `2.21.0`). Then ask the user **whether the lab has decided the variance-COA model** (the 4 questions in `docs/2026-06-14-variance-coa-lab-decision-brief.md`). If yes → invoke brainstorming to design the chosen model (COA aggregate + Variance Report + digital reconciliation). If not → stand by or pick up an unrelated thread; do not implement variance-COA changes until the model is set.
