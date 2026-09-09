## Summary

Accu-Mk1 takes ownership of sample-tier status behind a switch, tees every status verb to SENAITE with read-back and retry, surfaces stranded samples as flags instead of sweeping them, and adds a native **Cancel sample** action that works from any state.

Spec: `docs/superpowers/specs/2026-09-09-sample-status-authority-flip-design.md` · Plan: `docs/superpowers/plans/2026-09-09-sample-status-authority-flip.md` (18 tasks, subagent-driven; every ruling is in the plan workspace ledger and summarised below).

### Added
- **Sample-status authority switch** (`Settings → Data Source → Sample status authority`): under `Accu-Mk1` the workflow engine writes the sample's status from the catalog and SENAITE follows; the SENAITE-sourced mirrors (registry heal, IS event stream, sub-sample parent refresh) stop writing it. Default stays `SENAITE`, so this deploys dark.
- **SENAITE tee with read-back and retry**: verify / publish / cancel are teed to SENAITE, proven by re-reading the AR (SENAITE answers 200 to refused transitions), and refusals are queued in `lims_senaite_tee_retries` for the `senaite_tee_retry` job (5 min; backoff 5 → 720 min; gives up after 8 attempts). A refused publish issues `verify` first (the PB-0462 "stuck To Verify" class). A cancel SENAITE refuses (it allows cancel only before any analysis is assigned) is recorded as `senaite_only`, never retried. The shadow summary reports `senaite_lagging`.
- **Stranded-sample detector** (`workflow_stranded_check`, 15 min, read-only): one `Workflow Stranded` flag per sample whose verified lines are ahead of its status, whose publish ledger has no matching status, whose native and mirror disagree under Mk1 authority, or whose SENAITE tee gave up; resolved when the condition clears. Cascade refusals are recorded with their first unmet requirement. No scheduled converge, by ruling.
- **Cancel sample** from any state: `POST /api/samples/{id}/cancel` (dry-run preview, reason, confirm; 409 already cancelled / no edge, 412 preview-or-requirements, refusals persisted) plus the sample page's "Cancel sample…" action with a typed confirm. Pending analysis rows are cancelled (new analysis-tier `cancel` verb and `cancelled` state) and released from their worksheets; finished rows stay as history; a published COA stays live and the dialog says so. In senaite mode the dialog states the badge limit (spec §11.4).
- **Catalog is the source of truth for status vocabulary**: the status writers accept any active catalog state, badges take their label from the catalog with the hardcoded map as fallback, and a seeded partial-publish pathway keeps the add-on-pending badge meaningful. Cancel edges are seeded from every sample state (insert-if-missing at boot; the Settings → Workflow pane owns them afterwards).

### Schema / jobs
- New table `lims_senaite_tee_retries` (+ 2 partial indexes); new flag type `workflow_stranded`; CHECK pairs widened for `transition_kind` (+`cancel`) and `review_state` (+`cancelled`). All idempotent boot migrations.
- New scheduler jobs `senaite_tee_retry` (5 min) and `workflow_stranded_check` (15 min).

## Rollout (spec §11)
1. **Deploy dark**: switch absent → `senaite`. The engine keeps writing only `native_status`; the tee retry job and the detector run in both modes (the retry fixes the silent-200 class regardless of authority; the detector starts flagging immediately).
2. **Work the flags**: root-cause the 11 `no_edge:publish` residuals and whatever the detector raises in its first days; fix each at the source (rule, seed, data correction), then a named manual converge. Flip when the detector has been clean for 48 h except the documented SENAITE-only classes and `GET /api/workflow/shadow/summary` agrees.
3. **Flip** `sample_status` to `mk1` in the admin UI; watch the summary for 48 h.
4. Cancel ships in this deploy and works in both modes; in senaite mode a post-verification cancel moves `native_status` and cancels the rows but the badge follows SENAITE until the flip (the dialog says so).
5. Later slice: IS notification on cancel; reinstate; retiring the SENAITE-sourced writers once SENAITE is disconnected.

## Test gates
- Backend (solo runs, branch venv): pristine `origin/master` a4f78fb4 = 99 failed / 3181 passed / 4 errors (known non-zero baseline); branch after merging master = 103 failed / 3250 passed / 4 errors. Net-new after rulings: **0 real** — 2 × `test_httpx_shared_ssl` (the `.venv`-BOM environmental class, fails only in worktrees carrying a `.venv`), and 2 publish-edge tests that pinned exactly two publish edges, updated for the seeded partial-publish edge (spec §3.3).
- Frontend: `tsc --noEmit` clean; full vitest 1741 passed, 6 failed under CPU contention → 2 pass in isolation, the other 4 fail identically on pristine `origin/master` (pre-existing). Net-new: **0**.
- New tests: 9 backend files (authority, status write, gated writers, cascade refusals, tee, tee retry job, publish route authority, stranded, cancel state machine) + cancel cascade, cancel seeds, cancel route; 4 frontend files (authority toggle, workflow-states store, cancel dialog).

## Rulings worth knowing (full list in the ledger)
- SENAITE cancel model corrected at final review; publish route now runs the native publish + retry enqueue on every SENAITE outcome (user responses unchanged).
- No allowlist for `dispatch` / `invalidate` (never used); cancel allowed from every state with a typed confirm.
- No scheduled converge: strandings are flagged, not swept; manual converge only.
- Refused cancels commit their refusal record and any first-touch arming (spec §6).
- `kept_rows` in the cancel preview excludes `cancelled` rows (dead rows are not history).
- Catalog seed is insert-if-missing keyed on (scope, from-state, verb); the pane owns edges afterwards.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
