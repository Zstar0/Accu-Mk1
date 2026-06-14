# Handoff: Replace Analyte — wrong-variant correction + Manage-Analyses hardening

*Created 2026-06-13. Paste this into a fresh session to resume with full context.*

---

You're picking up after a long UAT-driven session on the `subsample-features` integration branch. The headline feature — **Replace analyte** (wrong-variant correction) — is **shipped and live-verified** on PB-0075 and PB-0076, plus a Manage-Analyses hide-toggle that closes the manual-swap trap. Several earlier per-finding fixes also shipped. Your job is to drive whatever the user asks next; the work is at a clean stop.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| **Accu-Mk1** (active FE+BE checkout) | `C:/tmp/accu-mk1-wave1` | `subsample-features` | `fea5c02` (pushed, clean tree) |
| accumarklabs (DevKinsta WP = local WP) | `//wsl.localhost/docker-desktop-data/data/docker/volumes/DevKinsta/public/accumarklabs` | `subsample-features` | `fab29cd` (pushed) — **but variance files reverted in working tree, see gotchas** |
| integration-service | `…/Accumark-Workspace/integration-service` | `subsample-features` | untouched this session |
| coabuilder | `C:/tmp/coabuilder-variance` | `feat/coa-identity-na-variance` | untouched this session |

Origin `subsample-features` (Accu-Mk1) = `fea5c02`. All Accu-Mk1 work is committed + pushed; tree clean.

## What's on the branch

**Layer 1 — earlier per-finding UAT fixes (shipped before the main feature):**
- `0726e97` — Worksheets Inbox: **Endotoxin/Sterility sub-bench chips** nested under the Microbiology chip (reuses the existing `microCategory` client filter).
- `ea06b1f` — Manage Analyses **"Current analyses" now shows resolved analyte names** (reuses `formatAnalysisTitle` + `analyteNameMap`) instead of "Analyte 1/2".
- (accumarklabs) `fab29cd` — Variance Report **Design A spread-table swap + spacing**. **This was reverted in the WP working tree back to Design B (C-then-B)** — see gotchas; the commit is still on the branch but the live files are Design B.

**Layer 2 — Replace analyte feature (the main work; spec `d4b29ff`, plan `6d4eb48`):**
- *Phase 1 — tiered retract-on-remove (foundation):* `d70cb23` `classify_removal_impact`, `822c9f1` `reject_vials_for_parent_keyword`, `3c7b4be` removal-impact endpoint + tiered guard on the DELETE remove endpoint (verified→409, worked→412+confirm, pristine→delete), `adce047` FE `RemovalConfirmModal`.
- *Phase 2 — Replace orchestrator + UI:* `c8215b0` `peptide_has_full_service_set` (offer-only gate), `22f9b24` `replace_analyte_slot` (vial re-mirror), `923a687` `classify_slot_replacement_impact`, `5e25dcf` `POST /explorer/samples/{id}/analytes/{slot}/replace` endpoint, `b5ae850` FE Replace button on the ANALYTES card A-rows + `ReplaceAnalyteDialog` (offer-only picker, 412→confirm).

**Layer 3 — force strong-confirm + Manage-Analyses hardening (polish, this session's tail):**
- `4a6d4c1` — **force strong-confirm**: makes verified/promoted results retractable. Adds `promoted→reject` state transition + `force_retract_analysis` (un-promotes: retracts the parent canonical row, drops the promotion link, rejects the source). Published rows still hard-block (invalidate in SENAITE). Endpoint uses a single `force` flag; FE escalates the confirm modal (`forceable` mode → "Force retract & replace").
- `105d8c7` — fix: replace endpoint referenced `logging` before a local import (500'd before any write; now fixed).
- `fea5c02` — **"Hide HPLC identity/purity/quantity" toggle** in Manage Analyses (default on, localStorage-persisted). Hides the HPLC analyte family from BOTH lists so identity/purity/quantity are only changed via Replace. Tested pure helper `src/lib/hplc-analyte-services.ts` (`isHplcAnalyteService`, 20 cases).

**Live-verified end-to-end (real SENAITE + Mk1):**
- PB-0075 slot 2: `force` Replace TB500→Ipamorelin — canonical row 55 verified→retracted, promotion link 13 dropped, source 46 promoted→rejected, both vials re-mirrored to Ipamorelin. (Left orphan `*_TB500-17-23` pep-62 rows — see gotchas.)
- PB-0076: user's own Replace fully converged all 4 vials to TB500 (Thymosin Beta 4); the HPLC-hide toggle verified hiding all HPLC analyte keywords by default and revealing all 88 when unchecked.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **Variance Design A reverted in WP working tree** | accumarklabs has uncommitted reverts of `variance-report-content.php` / `variance-charts.php` / `css/variance-report.css` back to **Design B (C-then-B)**, while commit `fab29cd` on the branch is Design A. The live page is Design B. | Don't blindly commit the WP working tree or re-clobber. Confirm with user which variance design they want before touching those files. Several other WP files (portal.css, sample-submission.*, thankyou.php) are also dirty and predate this session. |
| **62/63 split-slot data inconsistency** | PB-0075 slot 2 had identity=peptide 63 (TB500 Beta-4) but purity/quantity=peptide 62 (TB500-17-23). Replace keys on ONE `old_peptide_id` (the FE sends the identity's), so it only cleared pep-63 rows, leaving orphan `PUR/QTY_TB500-17-23` (pep 62) active on the vials. | Normal (consistent) slots have one peptide → no orphans. Only matters for already-inconsistent data. If hardening is wanted, the endpoint must resolve+clear both the identity peptide AND the slot's actual pur/qty peptide. |
| **promoted/verified need `force`; published hard-blocks** | Replace 409s on published (terminal — needs SENAITE invalidate); 412s on worked/verified/promoted and re-posts with `force:true` after the escalated confirm. | Expected behavior. To test the success path on a worked sample, use `force`. |
| **Vite serves stale transforms across the Windows bind mount** | After editing `C:/tmp/accu-mk1-wave1/src/**`, Vite serves OLD cached transforms. | `docker restart accu-mk1-frontend` after FE edits, then `curl http://localhost:3101/src/<file>` to confirm the new code is served. |
| **Backend has no --reload** | `accu-mk1-backend` won't pick up `backend/**` edits live. | `docker restart accu-mk1-backend && sleep 4`, check `docker logs … | tail` for "Application startup complete". |
| **Playwright-MCP chrome profile locks repeatedly** | Profile `mcp-chrome-d1e6b3e` throws "Browser is already in use" / "Target page closed" intermittently. | Kill its chrome procs + `Remove-Item …/mcp-chrome-d1e6b3e/Singleton*` (PowerShell), then re-navigate. Recurs every few calls. |
| **e2e test-admin password** | Set to `E2e-Verify-9931` on `e2e@accumark.local` this session for API/UI verification (left `forrest@valenceanalytical.com` untouched). | Reuse it for `POST /auth/login` to drive the real endpoints from Bash. |
| **GitNexus stale-index advisory on every Bash** | Fires "run npx gitnexus analyze --embeddings" constantly. | Ignore — `--embeddings` is forbidden (external egress). |
| **LF→CRLF git warnings** | Every WSL-path commit warns. | Benign; ignore. |

## Infrastructure state

- `accu-mk1-frontend` — **3101 (Vite dev — use this)** / 3100 static; image `accu-mk1-wave1-frontend:latest`; binds wave1 `src` + `package.json`; **restart after FE edits**.
- `accu-mk1-backend` — 8012, binds `C:/tmp/accu-mk1-wave1/backend`, **no --reload → restart after BE edits**. API base `http://localhost:8012` / `http://127.0.0.1:8012`.
- `integration-service` 8000 (healthy) · `coabuilder_service` 5000 · `accumark_postgres` 5432 (db `accumark_mk1`, user `postgres`) · `senaite` 8080.
- WP = DevKinsta `accumarklabs.local` (wp root in `devkinsta_fpm` = `/www/kinsta/public/accumarklabs`); WC-touching wp-cli needs `php8.2 /usr/local/bin/wp … --allow-root`.
- Redundant `accumark-subvial-*` / `accumark-host-*` stacks still running — teardown candidates, ignore.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Branch/origin | `git -C /c/tmp/accu-mk1-wave1 log --oneline -3` (expect `fea5c02` top) |
| Backend — full Replace/remove suite | `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_replace_analyte.py tests/test_removal_impact.py tests/test_native_manage_analyses.py tests/test_lims_analyses_state_machine.py"` (was 70 passed) |
| FE typecheck | `MSYS_NO_PATHCONV=1 docker exec accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"` |
| FE — new component/helper tests | `MSYS_NO_PATHCONV=1 docker exec accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/hplc-analyte-services.test.ts src/test/replace-analyte-dialog.test.tsx src/test/removal-confirm-modal.test.tsx"` (NO `-q` flag — vitest rejects it) |
| Login for API drive | `curl -s -X POST http://localhost:8012/auth/login -H 'Content-Type: application/json' -d '{"email":"e2e@accumark.local","password":"E2e-Verify-9931"}'` |
| PB-0076 vial state | `docker exec accumark_postgres psql -U postgres -d accumark_mk1 -tA -c "SELECT ss.sample_id, la.keyword, la.review_state FROM lims_analyses la JOIN lims_sub_samples ss ON ss.id=la.lims_sub_sample_pk WHERE ss.parent_sample_pk=(SELECT id FROM lims_samples WHERE sample_id='PB-0076') AND la.review_state NOT IN ('retracted','rejected') ORDER BY ss.sample_id, la.keyword"` |

## Outstanding items the user may want next

1. **Clean PB-0075's orphan `*_TB500-17-23` (pep 62) rows** — leftover from its split-slot Replace test; quick DB cleanup on a test sample.
2. **Decide variance report Design A vs B** — Design A is committed (`fab29cd`) but the WP working tree was reverted to Design B. The user needs to choose; the dirty WP files are unresolved.
3. **Harden Replace for split slots (62/63)** — only if inconsistent slots turn out common; resolve+clear both identity and pur/qty peptides. Also worth investigating how PB-0075 slot 2 got split in the first place.
4. **Full backend + FE suite run** before any merge (the per-feature suites are green; haven't run the whole repo this session).
5. **Merge `subsample-features` → master + prod deploy** (use `accumark-deploy` skill). Carries forward from prior handoffs: prod needs the Variance WP data setup + the lockfile fix; verify `JWT_SECRET` consistency.
6. **MailHog routing / user 1545 password** — untouched, carried from older handoffs.

## User collaboration preferences

- **One finding at a time, evidence before fixes** — they browser-test and feed findings individually; root-cause with DB/code/served-asset checks before changing anything.
- **Additive-only, follow existing patterns**; **TDD where it reduces risk** (pure helpers, cascade logic), skip performative tests; reuse existing helpers over reinventing.
- **Per-logical-unit commits with detailed bodies**, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; **push to origin after committing** for backup.
- **Confirm before irreversible/live SENAITE writes** — but PB-#### are test samples and OK to mutate once the user authorizes ("this is just test samples").
- **Never run GitNexus `--embeddings`** (external egress).
- Brainstorm → spec → plan → execute for substantial features; the user engages with design questions and picks options decisively.

## Recommended first action in the new session

Confirm state, then ask — the feature is at a clean stop:
`git -C /c/tmp/accu-mk1-wave1 log --oneline -3` (expect `fea5c02`) and `docker ps --format '{{.Names}}\t{{.Status}}' | grep accu-mk1`. Then ask the user whether they want to continue UAT findings, clean up PB-0075's orphan rows, or resolve the variance Design A/B decision.
