# Handoff: Vial attachments + prep cutover — photos, chromatograms, COA gate, prep HPLC to vials

*Created 2026-06-11. Paste this into a fresh session to resume with full context.*

---

You're picking up the Mk1 sub-vial arc on `subvial/continue`. Today's slice (12 commits, all UAT'd live by the Handler except the COA gate) made vials first-class for attachments and HPLC processing: vial photos with primary selection, vial-attached chromatograms, parent-side pickers for both, COA generation gated on those attachments, the Sample Prep flow cut over to vials-only, and a samples-page search regression fixed. Your job is to drive whatever the user asks next.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Accu-Mk1 (subvial worktree) | `C:/tmp/Accu-Mk1-subvial` | `subvial/continue` | `7db745d` fix(samples): sub-sample ID search finds Mk1-native vials |
| Accu-Mk1 (main checkout — do NOT work here for this arc) | `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1` | `master` | `3aca048` (v0.38.0) |
| accumark-stack | `.../Accumark-Workspace/accumark-stack` | `master` | `75328b9` feat(mount): AZURE_*/SHAREPOINT_* pass-through |

Working tree is clean except `M package-lock.json` (pre-existing, not ours — leave it) and untracked handoffs/`backend/tests/test_coa_gate.py` (pre-existing leftover with a syntax error at line 45 — fix or delete someday, it's not in the repo).

## What's on the branch (this session's 12 commits, bottom-up)

**Layer 1 — vial attachments (`ee5877f`, `909a697`, `37d5940`):**
- New `lims_sub_sample_attachments` table (created by `create_all`; bytes reuse the Mk1 photo store). Vial pages' Attachments section shows the check-in photo (Replace/Remove, armed-confirm buttons), extra sample images (add/delete, images only), all with activity-log events. Fixed a latent bug: `update_sub_sample` pushed replacement photos to SENAITE with `mk1://` keys.
- **Make-primary**: primary image == `photo_external_uid`; promoting an extra image swaps it into the photo slot and demotes the old photo to a regular attachment. Legacy SENAITE photos → 409 `photo_not_mk1` everywhere (remove/primary).
- **Select Vial Image** (parent pages): picker grid of vials' primary photos → snapshots bytes to the parent AR as a SENAITE "Sample Image" attachment via the existing wizard upload route. Header thumb updates instantly via `seedSubSamplePhoto`.

**Layer 2 — Sample Prep cutover to vials (`ed4dcf9`, `317284c`, `c3f637d`):**
- Step1 lookup is vial-only: parent IDs show a vial picker instead of creating parent preps; manual tab untouched.
- `VialResultsView` replaces `SenaiteResultsView` for vial-scoped preps: results write to the vial's `lims_analyses` (same `AnalysisTable` as the vial page), Auto-fill re-runs the idempotent bridge via `POST /hplc/sample-preps/{id}/bridge` (`prep_bridge.rebridge_prep`). Banner names the target vial. Parent/legacy preps keep the SENAITE view.
- **HPLC folder override**: FolderSearch icon per Sample Preps row → SharePoint browser → `GET /sample-preps/hplc-folder-match` pins any folder's PeakData/chrom CSVs to a prep (session-only; Process button tints amber).

**Layer 3 — chromatograms + COA gate + fixes (`c293aeb`, `374d801`, `fa27d67`, `e4030f0`, `7db745d`, `7ee35ff`):**
- Chromatogram = `chromatogram_data` on the prep's `hplc_analyses` row — auto-attached to the vial by linkage (`sample_preps.lims_sub_sample_pk` → `hplc_analyses.sample_prep_id`), NO separate storage. `GET /api/sub-samples/{id}/chromatograms` (vial-or-parent dispatch) ships the ~800-pt series; rendered with the in-app recharts chart (`VialChromatogramChart`), NOT the branded PNG. **Select Vial Chromatogram** (parent pages) uploads the CSV to the parent AR via the existing `chromatogram-to-senaite` route. The prep view's auto-upload-to-parent was REMOVED — parent attachment is always the explicit picker now.
- **COA attachments gate** (`fa27d67`, NOT yet UAT'd): `generate-coa` 422s (`missing_attachments`) unless the parent AR has an `image/*` attachment + (for non-micro samples) an HPLC Graph/.csv. Fail-OPEN on SENAITE read errors. Message renders via the existing FE error path.
- **Samples-page search fix** (`7db745d`, live-verified): ID search synthesizes a row from `lims_sub_samples` when SENAITE getId misses (native vials have no AR).
- Findings doc `7ee35ff`: ACE-031 orphan cleanup on P-0144-S01, mirror-prune gap = LOW/cosmetic (bridge guard + COA resolver both safe), TB500 variant swap via Manage Analyses verified end-to-end.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| Worktree has no Python venv; `node_modules` was empty until `npm ci` this session | Tests/lint fail mysteriously otherwise | Backend: run pytest from `backend/` with `C:/Users/.../Accu-Mk1/backend/.venv/Scripts/python.exe`. FE: node_modules now installed in worktree |
| Pre-existing failures are NOT regressions (stash-verified) | You'll waste time "fixing" them | 5 failed + 3 errors in `test_container_mode`/`test_sub_samples_routes`; tsc error `WorksheetsInboxPage.tsx:434`; eslint baseline 26 problems in SampleDetails+api.ts. Baseline-diff (stash → check → pop) before blaming new work |
| `docker restart` does NOT reload compose env | Env changes silently missing | Recreate: `docker compose -p accumark-subvial --env-file C:/Users/forre/.accumark-stack/stacks/subvial/.env -f docker-compose.yml -f C:/Users/forre/.accumark-stack/stacks/subvial/docker-compose.override.yml up -d accu-mk1-backend` (from accumark-stack dir) |
| Vite HMR unreliable on the worktree bind mount | Live tests look broken when only the bundle is stale | Hard-refresh (Ctrl+Shift+R) before judging any FE change in the browser |
| Peptides curve-import dialog swallows SharePoint errors as "This folder is empty" (`PeptideConfig.tsx:673`) | Misdiagnosis as local/empty | Use the prep folder-override picker (surfaces errors) to diagnose SharePoint health |
| `_subSamplePhotoCache` / seed semantics | invalidate-then-bump after photo replace/remove; after Select Vial Image, seed is set — do NOT invalidate after seeding or you reintroduce the SENAITE read-after-write race | Follow the existing onAttached/refreshVialPhoto patterns in SampleDetails |
| TestClient + conftest sqlite session = cross-thread error | Route tests touching real DB via dependency_overrides crash | Mock the service layer in route tests (project pattern), test logic at service level with `db_session` |
| `test_coa_gate.py` (untracked) has a syntax error | Breaks `pytest tests/` whole-dir collection | Scope pytest to specific files, or fix/delete the file |

## Infrastructure state

All `accumark-subvial-*` containers healthy. Ports: FE **5532**, Mk1 API **5530**, SENAITE **5538** (login `forrest@valenceanalytical.com` / `Valence2025!`), WP 5535, IS 5525, coabuilder 5528, Postgres 5520, Redis 5521, MailHog UI 5522. Stack login for Mk1: `forrest@valenceanalytical.com` / `test123`.

- Backend bind-mounts `C:/tmp/Accu-Mk1-subvial/backend` → `/app` with `--reload`; FE runs vite from the worktree.
- **SharePoint/Graph now works on this stack** (this session): `AZURE_*`/`SHAREPOINT_*` copied from the host `accu-mk1-backend` container into `C:/Users/forre/.accumark-stack/stacks/subvial/.env` (backup `.env.bak-azure`), referenced in the stack's `docker-compose.override.yml`, AND the mount generator (`accumark-stack/bin/accumark-stack`, commit `75328b9`) passes them through so remounts keep it. Verified live: 740 folders in LIMS root.
- Browser overrides for the stack FE (tab-scoped sessionStorage): `accu_mk1_api_url_override=http://localhost:5530`, `accu_mk1_wp_url_override=http://localhost:5535`.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command (from `C:/tmp/Accu-Mk1-subvial`) |
|---|---|
| Backend new-feature suites | `cd backend && <main-checkout-venv-python> -m pytest tests/test_sub_sample_attachments.py tests/test_prep_bridge.py -q` (was 46 passed) |
| FE typecheck | `npm run typecheck` (only pre-existing WorksheetsInboxPage error expected) |
| FE lint baseline | `npx eslint src/components/senaite/SampleDetails.tsx src/lib/api.ts` (baseline 26 problems) |
| FE related tests | `npx vitest run src/test/native-sub-sample.test.ts src/test/vials-quicklook.test.tsx` (was 25 passed) |
| Native vial search live | login → `GET :5530/senaite/samples?search=BW-0014-S03` returns synthesized row |

## Outstanding items the user may want next

1. **UAT the COA attachments gate** (`fa27d67`) — the only unverified piece: fresh sample without attachments → Generate COA → expect 422 listing both items; attach via the two pickers → generate passes. Micro-only sample should skip the chromatogram requirement.
2. **PR #9 / push** — 12+ commits on `subvial/continue` are local-only. When the arc stabilizes, update/push the PR.
3. **Deferred backlog (unchanged)**: parent shadow/SENAITE phase-out, physical sample-type model, admin un-promote, COA M/I source question; plus mirror-prune gap (documented LOW in `docs/superpowers/handoffs/2026-06-11-vial-analyte-sync-findings.md` — fix only if it recurs through a cascade-bypassing path).
4. **Surface SharePoint errors in the Peptides curve-import dialog** (stop swallowing as "empty folder") — Handler saw this confusion firsthand.
5. **Banner precision nit**: prep-bridge banner counts ALL filled rows, not just bridge-written ones — offered to scope to fresh writes, Handler hasn't asked.
6. **Fix/delete untracked `backend/tests/test_coa_gate.py`** (syntax error at line 45).

## User collaboration preferences

- Compact design proposal → "go ahead" → build; ask only genuinely user-owned decisions (AskUserQuestion with recommendations works well).
- Additive-only: don't re-architect; failing tests default to "stale test" — prove with a stash baseline before claiming regression.
- Commit per feature on `subvial/continue` with detailed bodies; specs in `docs/superpowers/specs/` (master spec for this arc: `2026-06-11-subsample-attachments-design.md`, prep cutover addendum in `2026-06-08-sample-prep-sub-sample-support-design.md`).
- npm only; restart (or recreate, for env changes) the backend container after backend edits; Handler UATs in the browser personally — give exact URLs/steps and remind about hard-refresh.
- Reuse existing machinery over new storage (chromatogram = linkage; Select pickers = existing SENAITE upload routes).

## Recommended first action in the new session

Confirm state, then UAT the one unverified feature: `git -C C:/tmp/Accu-Mk1-subvial log --oneline -5`, check `docker ps | grep subvial`, then walk the Handler through the COA gate test (item 1 above) on a fresh sample without attachments.
