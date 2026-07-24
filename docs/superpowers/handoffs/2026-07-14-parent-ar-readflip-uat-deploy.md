# Handoff: Parent-AR Read-Flip — branch complete; UAT → PR → deploy next

*Created 2026-07-14. Paste this into a fresh session to resume with full context.*

---

You're picking up the SENAITE phase-out program's section-2 read-flip at the release gate. The program branch is **COMPLETE, reviewed, and pushed** — all four layers built via subagent-driven development with per-task + per-layer + whole-branch reviews (four real defects caught and fixed by that pipeline). Current master (v1.5.2) is already merged in. Your job: drive registry-stack UAT with the parity harness, then PR → deploy (ordered backfills!) → Handler's page-by-page flip.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Program worktree (laptop) | `C:\tmp\Accu-Mk1-parent-readflip` | `feat/parent-ar-read-flip` (pushed, in sync) | `64e8ae0` |
| Main checkout — NOT a deploy source | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` | `master` (own drift) | — |
| origin/master (= prod lineage) | GitHub `Zstar0/Accu-Mk1` | `master` | `97409ff` (v1.5.2) |
| Registry stack worktree (devbox) | `forrestparker@100.73.137.3:~/worktrees/Accu-Mk1-registry` | still `uat/registry-combined` (STALE — previous program) | needs fetch + checkout of this branch for UAT |

Prod as of last sighting: **Mk1 1.5.2** (a parallel session shipped 1.5.0-1.5.2 while this branch was built — see `C:\Users\forre\.claude\projects\C--Users-forre-OneDrive-Documents-GitHub-Accumark-Workspace\memory\MEMORY.md` deploy-state line; re-verify before deploying).

## What's on the branch (~30 commits, spec + 4 layer plans + code)

**Spec (amended as-built 5×):** `C:\tmp\Accu-Mk1-parent-readflip\docs\superpowers\specs\2026-07-14-parent-ar-read-flip-design.md`. Layer plans in `C:\tmp\Accu-Mk1-parent-readflip\docs\superpowers\plans\2026-07-14-parent-ar-read-flip-layer{1,2,3,4}-*.md`.

- **L1 — M/I ownership** (`1bd8bfa`,`b10c61d`): `lims_analyses.method_id/instrument_id` Mk1-owned everywhere; mirror + shadow-backfill blinded (resolvers deleted, A4 pass-through removed). Zero FE change (`mk1:<id>` routing pre-existed). SENAITE-retest blanks current-row M/I BY DESIGN.
- **L2 — remarks native** (`44b1237`..`f077b63`): `lims_sample_remarks` table; receive-flow writes native (SENAITE write deleted); **generic-endpoint intercept** (`update_senaite_sample_fields` pops `Remarks` — the FE add-remark forms were a third write path caught at final review); `_native_sample_remarks` serves BOTH read modes; backfill `C:\tmp\Accu-Mk1-parent-readflip\backend\scripts\backfill_lims_sample_remarks.py`.
- **L3 — attachments native record** (`81e2a5f`..`d158c8b`): `lims_parent_attachments` (kind CHECK incl. `chromatogram`, `attachment_type` col, partial-unique uid); THREE capture sites (Select-Vial-Image, receive step-1, **chromatogram push** — another review-caught write path) via shared `_capture_parent_attachment_bg`; frozen S3 snapshots (retakes never mutate); sweep `C:\tmp\Accu-Mk1-parent-readflip\backend\scripts\backfill_lims_parent_attachments.py` (uid adoption, dup-check-first after a review-caught IntegrityError, `detail_fetch_errors` exit gating).
- **L4 — builder + flip wiring** (`5774cbd`..`3f656e2`): `C:\tmp\Accu-Mk1-parent-readflip\backend\sub_samples\registry_details.py` `build_native_details` (zero SENAITE HTTP, test-enforced); lookup-shape models moved to `C:\tmp\Accu-Mk1-parent-readflip\backend\sub_samples\lookup_models.py`; parent-tier senaite-shape listing tier-guarded via `state_machine.tier_of` (variance parent-as-vial rows excluded); DB-typed attachment download route; endpoint mk1 branch → builder via `run_in_threadpool`; `sample_details` page key (pre-existed from v1.1.x — only consumer resolution was new: 4 pages + `senaite-lookup-map`, NOT SenaiteDashboard); nightly reconcile rider (`MK1_PARENT_MIRROR_RECONCILE_ENABLED`, code default **false**, 08:00 UTC); parity harness `C:\tmp\Accu-Mk1-parent-readflip\backend\scripts\parity_sample_details.py` (12 known-expected classes; `--strict` exits 1 on real diffs OR fetch errors = the flip gate).
- **Master merge** (`4dd9bba`): v1.5.2 era (lot cards, 1.5.1 status heal, square crop) merged CLEAN — the 1.5.1 heal is a builder *prerequisite* (keeps `lims_samples.status` in SENAITE vocabulary), square-crop/lot-cards verified non-interacting. Final one-liners `3adad70`; section-5 checklist note `64e8ae0`.

Execution ledger with the FULL carry table + per-task review outcomes: `C:\tmp\Accu-Mk1-parent-readflip\.superpowers\sdd\progress.md`. Per-task reports: `C:\tmp\Accu-Mk1-parent-readflip\.superpowers\sdd\task-*.md`.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| Backfills have a REQUIRED order at deploy | `fetch_attachment_meta`'s URL shape was **never live-verified** against real SENAITE; remarks history is invisible in BOTH read modes until its backfill runs | Smoke FIRST: `python -m scripts.backfill_lims_parent_attachments --dry-run --limit 5` in the prod backend container (verify URL + filename equality + RenderInReport type) → remarks dry→real→re-run → attachments dry→real→re-run. Off-hours, throttled (SENAITE bulk-scan incident class) |
| Remarks write-flip is deliberately irreversible | SENAITE `Remarks` goes stale the moment this deploys; nothing reads it anymore | Documented spec §11; the backfill re-run closes the deploy-window gap |
| Reconcile rider code-default is OFF | Stacks want it on (env); prod is a Handler call at deploy | If enabled: avoid backend recreate during 08:00-08:59 UTC (second throttled sweep, harmless but load); one checkpoint file/day in container `/tmp` |
| Parity `--strict` exits 1 on fetch errors too | A partial run must not read as a green light — deliberate widening | HTTP mode needs `MK1_PARITY_TOKEN` env (bearer); `--in-process` mode needs SENAITE env (stack/UAT) |
| Gate = failure-SET diff, not counts | 60-name v1.4.0 baseline at `C:\Users\forre\Downloads\Obsidian\TerraVex\TerraVex\Sessions\handoffs\gate-backend-failures-v140-master.txt`; two `test_clickup_task_retry` names flake intermittently | Diff names; standalone-rerun clickup flakes before attributing |
| Dev DB is shared with parallel sessions | Prod moved 1.4.0→1.5.2 via a parallel session while this branch was built; MEMORY.md got cross-written twice | Re-verify prod version + master head before deploy; re-read MEMORY.md fresh |
| `review_state` parity diff during worksheet-assigned windows | 1.5.1's heal whitelist deliberately ignores raw IS vocab (`analyzing`) | That's the heal working, not builder drift — known-expected during UAT eyeball |
| Chromatogram snapshots key as `.bin` in S3 | `_extension_for` doesn't know `.csv`; the DB row's `content_type='text/csv'` is correct | Serving MUST stay DB-row-typed (it does — binding constraint, test-locked); never derive from key extension |
| `uid`-keyed capture vs `sample_id`-keyed remarks | A `lims_samples` row with NULL/drifted `external_lims_uid` silently no-ops attachment capture (logged) while remarks still write | Sweep adoption heals the record later; UID-mismatch guard STILL unsigned (now flagged 4×) |
| Container `readflip-test` bind-mounts THIS worktree | Backend tests run in it against the live dev DB | Recreate if gone: `docker run -d --name readflip-test -e MK1_DB_HOST=host.docker.internal -v "C:\tmp\Accu-Mk1-parent-readflip\backend:/app" ghcr.io/zstar0/accu-mk1-backend:1.4.0 sleep infinity` then `pip install -q pytest` inside |
| Commit trailers | Session-specific | Copy verbatim from `git log -1 --format=%B 64e8ae0` — never retype |

## Infrastructure state

- **Laptop:** `readflip-test` container Up (bind-mounted to the worktree, live dev DB via `host.docker.internal`). Worktree clean, in sync with origin.
- **Devbox registry stack** (`forrestparker@100.73.137.3`, ports 5640-5659, MinIO :5659): last known healthy but its Mk1 worktree (`~/worktrees/Accu-Mk1-registry`) is parked on the PREVIOUS program's `uat/registry-combined`. For UAT: `ssh forrestparker@100.73.137.3 'cd ~/worktrees/Accu-Mk1-registry && git fetch origin && git checkout feat/parent-ar-read-flip && git pull'` then `docker restart accumark-registry-accu-mk1-backend` (backend changes need restart; uvicorn --reload wedges on open SSE — restart, don't wait). Re-add compose-override blocks (SENAITE webhook + `ACCUMK1_*`) after any `accumark-stack mount`.
- **New env vars this branch:** `MK1_PARENT_MIRROR_RECONCILE_ENABLED` (rider; default false), `MK1_PARITY_TOKEN` (parity HTTP mode only). No JWT/IS/COA changes; migrations self-apply on boot (two new `lims_` tables + `attachment_type` ALTER + kind-CHECK DROP/ADD pair).

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Full-suite gate | `docker exec readflip-test sh -c "cd /app && python -m pytest tests/ -q --tb=no"` → diff FAILED names vs the 60-name baseline file above |
| L4 sweep (79 expected) | `docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_list_parent_analyses_senaite_shape.py tests/test_registry_details_builder.py tests/test_registry_details_flip.py tests/test_parent_mirror_reconcile_rider.py tests/test_parity_sample_details.py tests/test_registry_read_endpoint.py tests/test_native_remarks_read.py -q"` |
| L2+L3 sweeps | remarks: `tests/test_lims_sample_remarks_schema.py tests/test_receive_remarks_native.py tests/test_native_remarks_read.py tests/test_backfill_lims_sample_remarks.py tests/test_update_fields_remarks_intercept.py`; attachments: `tests/test_lims_parent_attachments_schema.py tests/test_parent_attachment_capture.py tests/test_backfill_lims_parent_attachments.py` |
| FE | `npx tsc --noEmit` + `npx vitest run src/lib/__tests__/lookup-source.test.ts src/lib/__tests__/upload-attachment-fields.test.ts src/components/preferences` (in the worktree; `npm ci` first if node_modules stale) |
| Parity (UAT) | `python -m scripts.parity_sample_details --in-process --limit 20 --out /tmp/parity.json` inside the stack backend container |

## Outstanding items the user may want next

1. **Registry-stack UAT + parity run** — mount the branch on the devbox stack (commands above), Handler drives the UI (sample details in both modes, add remark, Select-Vial-Image, chromatogram push), agent runs the parity harness and triages the report. Parity classes to expect: `published_coa_senaite_era`, `profiles_empty_native`, `attachment_mk1att_uids`, `mi_blank_after_retest`, etc. — REAL diffs are the news.
2. **PR** — Handler-gated. The whole-branch review produced a PR-body skeleton (features + ordered deploy steps + follow-ups) — it's in the session transcript AND reproducible from `C:\tmp\Accu-Mk1-parent-readflip\.superpowers\sdd\progress.md`'s carry table.
3. **Deploy** via the `accumark-deploy` skill (Mk1 only, both images) + the ORDERED backfills (gotchas table). Version: prod is on 1.5.x — presumably 1.6.0 (feature batch), Handler's call.
4. **Post-deploy Handler calls:** rider env on/off; parity run against prod; page-by-page `sample_details` flip via Preferences.
5. **Then:** the shadow-engine slice (spec `C:\tmp\Accu-Mk1-parent-readflip\docs\superpowers\specs\2026-07-13-workflow-shadow-engine-design.md`, §6 decisions already recommended: on/dormant/pre-fill/sweep-default-off — Handler leaned yes but never formally locked them); UID-mismatch guard sign-off (bitten 4×); the v1.4.0-era leftovers (inbox read-source flip, desktop draft releases v1.2.1→v1.5.2, six pending).
6. **Carry-list batch ticket** (post-flip): SENAITE_URL guard reorder in `update_senaite_sample_fields` (remark entry must survive SENAITE disconnect), A4 M/I proxy retirement, legacy `upload_photo` posture, minors — full table in the ledger.

## User collaboration preferences

- Additive-only; prod changes + PRs + flips Handler-gated; deploys from clean detached worktrees via the `accumark-deploy` skill; explicit `git add <files>`; conversational prose over MCQ; absolute paths everywhere; blunt trade-offs.
- Subagent-driven development for build work (implementer + task reviewer + whole-layer reviewer; fix rounds until clean; ledger in `.superpowers/sdd/progress.md`). Trailers copied from prior commits via git, never retyped inline (two near-miss typos this session).
- UAT style: Handler drives the real UI; agent probes backend + fixes hot; destructive/SENAITE-mutating steps staged as scripts for the Handler to run via `!`.
- Handler decisions this session: read-flip before shadow engine; close gap-fields on the way (M/I + remarks full native authority, attachments dual-write); S3 snapshot copies at capture (option 1); section-5 checklist = byte-migration + latest-wins rule.

## Recommended first action in the new session

Run `git -C C:\tmp\Accu-Mk1-parent-readflip log --oneline -3` + `git -C C:\tmp\Accu-Mk1-parent-readflip status -sb` and re-read the MEMORY.md deploy-state line (parallel sessions move prod), then ask the Handler: UAT on the registry stack first, or straight to PR?
