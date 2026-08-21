# Handoff: Native Manage Analyses — built, final-reviewed, live on arcitest, UAT round 2 in progress

*Created 2026-08-19. Paste this into a fresh session to resume with full context. Successor to `C:\tmp\wpstar-badge-native\wp-content\themes\wpstar\docs\superpowers\handoffs\2026-08-18-badge-native-sections-v160.md` (badge v1.6.0 slice — separate arc thread, still open).*

---

You're picking up the **native Manage Analyses + parent-row lifecycle** slice for Accu-Mk1: lab-side add/remove of native (origin='mk1') analysis profiles on a parent sample and its vials, plus an admin "Re-sync from order" heal. It went spec → plan → full subagent-driven build (9 tasks + 1 UAT fix, every task independently reviewed, 5 fix rounds total) → final whole-branch review (**ready to merge, 0 critical**) → live on arcitest where the PB-0156 acceptance passed end-to-end and the Handler's first UAT round surfaced one real bug (fixed as Task 13, redeployed, re-verified live). **Handler is mid-UAT round 2 on P-0157**; two Handler decisions are open (see Outstanding). Drive whatever the Handler asks; the SDD ledger is the complete decision record.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Slice worktree (THE work; KEEP until merge) | `C:\tmp\Accu-Mk1-manage-analyses` | `feat/native-manage-analyses` (based on `b30d9fc0` = PR #98 tip) | `8cda9e22`, clean tree, **UNPUSHED** (19 commits) |
| Local test composition | `C:\tmp\Accu-Mk1-arcitest` | `integration/catalog-arc-itest` | `109c2d3d` (slice merge `8de04572` + S3 seeder fix `2cc02860` + T13 merge), never push |
| Devbox arcitest Mk1 (LIVE UAT surface) | `forrestparker@100.73.137.3:~/worktrees/mk1-arcitest` | `arcitest/mk1-full` | `ad2f5c8a`; `package-lock.json` dirty ON PURPOSE, leave it |
| Mk1 docs branch (spec/plan master copies) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` (main checkout) | `docs/analysis-catalog-specs` | `0e6fb814`; pre-existing dirty files (AGENTS.md, CLAUDE.md, scripts/*) are NOT ours, leave them |
| Spec (as-built, incl. R2-drop + rider-dim rulings) | `C:\tmp\Accu-Mk1-manage-analyses\docs\superpowers\specs\2026-08-18-native-manage-analyses-design.md` | | |
| Plan (12 tasks) | `C:\tmp\Accu-Mk1-manage-analyses\docs\superpowers\plans\2026-08-18-native-manage-analyses.md` | | |
| SDD ledger — EVERY ruling/fix-round/gate with evidence | `C:\tmp\Accu-Mk1-manage-analyses\.superpowers\sdd\2026-08-18-native-manage-analyses\progress.md` (+ task-N-brief/report/review files, final-review.md) | | |
| Memory file (kept current) | `C:\Users\forre\.claude\projects\C--Users-forre-OneDrive-Documents-GitHub-Accumark-Workspace\memory\project_native_manage_analyses.md` | | |

## What's on the branch

**Layer 1 — backend core (T2–T6).** `backend/lims_analyses/manage_native.py` (new module) composes three unchanged primitives: `seed_parent_placeholders` (parent `provenance='ordered'` rows; now gains `reason`/`created_by_user_id` audit kwargs and skips dead rows on the exists pre-check so a soft-removed placeholder is re-addable), host custody edges (`VialProfileAssignment` written directly, insert-only — **`write_custody_edges` is never called**, it supersedes everything), and the seeder's `_seed_rows_from_services`. Functions: `native_profiles_for_parent` (picker: active all-mk1 profiles + on_sample + host_vials), `add_profile_to_parent` (placeholders + edge + vial seed; no host vial → placeholder-only), `remove_parent_native_analysis` (409 live-canonical → classify pristine/worked/blocked → 412 confirm → delete pristine via `delete_pristine_analysis` / reject worked / supersede orphan edges / soft-reject placeholder `R1`), `resync_parent_from_order` (admin; additive-only heal from the IS; 502 zero-writes on IS failure), `ensure_parent_placeholder` (single-service, used by vial adds), `placeholder_profile_keys` → **role-flip union hook** in `sub_samples/service.py::set_assignment_role` (placeholder keys merged into services_map; placeholder True beats WP False) so lab-added profiles seed when a matching-role vial appears. Two new transition sites in `service.py` (`record_placeholder_created`, `soft_reject_parent_placeholder`) — amendment-audit guard floor is now **13**.

**Layer 2 — routes + FE (T7, T9, T10).** Routes under `/api/lims-analyses/parent/{sample_id}/…`: GET `native-profiles`, POST `profiles` `{profile_id}`, DELETE `native-analyses/{id}?confirm=`, POST `resync-from-order` (**require_admin**). Error bodies `{"detail":{code,message}}`; 412 = `{"detail":{code:"confirm_required", impact}}`. Senaite-shape rows now carry `provenance`; Mk1 id rides `uid` = `"mk1:<id>"`. Explorer vial-add accepts `keyword` (mk1-only services reachable at last) and best-effort ensures the parent placeholder (catches `ProfileNotNativeError` + `IntegrityError`, logs, never fails the committed add). `GET /analysis-services?origin=mk1&active=true` feeds the native vial picker. FE: `src/components/senaite/NativeManageAnalysesBlock.tsx` in the Manage Analyses overlay (parent pages; shares the card's exact query key + staleTime), `src/lib/manage-analyses-picker.ts` (`pickerSourceFor` — native only on `mk1://` vial pages), `RemovalConfirmModal` reused. Activity flyout labels: `native_profile_added` / `native_analysis_removed` / `native_resync`.

**Layer 3 — UAT fix (T13, `8cda9e22`).** Handler's round-1 find: parent retest leaves the vial source `promoted` + promotion link to the now-**retracted** parent; rejecting the retest child orphaned it and remove 409'd. Fix: `_classify_vial_rows` blocks only on `verified`/`published` state OR a **LIVE** promotion link; dead-linked promoted rows = worked → confirm clears via `force_retract_analysis(reason="manage_analyses:remove")` (new default-preserving `reason` kwarg; retracts live parents, **deletes stale links**, rejects source). Verified live on P-0157, then the Handler's pre-retest state was restored (parent Lead placeholder **3715** ordered + S02 row **3719** unassigned — vial-level add, exactly their original action).

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **🔴 MERGE-TRAIN OBLIGATION: S3 widened `_seed_rows_from_services` with required kw-only `existing_service_ids`** | the slice's `_seed_members_on_vial` (written vs base) misses it → `TypeError` on every manage-native vial seed the moment this branch and S3 co-exist on master; the fix (build BOTH live sets) exists ONLY as composition commit `2cc02860` | the adaptation must ride whichever PR lands SECOND (this slice's PR if S3 lands first) — it's ~8 lines, copy from `C:\tmp\Accu-Mk1-arcitest\backend\lims_analyses\manage_native.py::_seed_members_on_vial` |
| **The `/api`-DOUBLE on arcitest** | port 5812 is the FE/Vite proxy which strips one `/api`; the router's own prefix is `/api/lims-analyses` | API drives use `http://localhost:5812/api/api/lims-analyses/...` (login at `/api/auth/login`); raw backend is port **5810** |
| **Devbox backend hot-reload can wedge in graceful shutdown** ("Waiting for connections to close" — SSE/proxy holds) | old worker keeps serving; new code never loads; curls hang | `docker restart accumark-arcitest-accu-mk1-backend`, ~12s, then `/health` via 5812 |
| **Full-suite runs poison the live dev Postgres and vice versa** | the killed overnight run left aged `peptide_requests` rows → 3 `test_clickup_task_retry` failures in the next full run (self-healed); a 10-hour zero-CPU hang at ~50% was a transient DB lock | gate on the failure-SET diff of `grep -E "^(FAILED\|ERROR) tests/"` ids ONLY (`baseline_ids.txt` = 68 ids in the SDD workspace); if the suite stalls >5 min at ~50% with ~0 CPU, kill and re-run |
| **`seed_vial_roles` doesn't seed role `kf`** in SQLite fixtures | role-flip tests using kf/moisture fail the role gate | tests use `hm`/`heavy_metals` for flips (T4 precedent) |
| **Rejecting a retest child leaves the original promoted+retested row verb-less** (pre-existing #95/#96 cascade behavior) | looks like a slice bug; it isn't — the un-promote program owns the real fix | Manage Analyses remove is now the escape hatch (T13); flagged to Handler |
| **arcitest UAT login** | stack env files carry no Mk1 UAT password | `e2e@accumark.local` / `E2e-Verify-9931` (admin; set in the 2026-06-13 session, survives in the golden) |
| **Windows worktree git index corrupts on power loss** | `fatal: index file corrupt` on every git op | `rm <gitdir>/index && git reset` — working tree is untouched; happened once this session, zero loss |
| **Subagent final messages drop occasionally** (idle notification, no report) | controller waits forever | every implementer/reviewer ALSO writes a report file; on silent idle read the file / `git log`, or SendMessage "resend" |
| An active profile with ZERO members seeds nothing (PB-0156's original cause) | silent gap | `add_profile_to_parent` now 422s `profile_has_no_members`; save-time guard still a ledgered follow-up |

## Infrastructure state

- **arcitest stack** (devbox `forrestparker@100.73.137.3`, block 5800–5819): validate was 21/21 post-merge; backend healthy via `http://localhost:5812/health` (FE proxy) after the T13 restart. Postgres container `accumark-arcitest-postgres`, DB `accumark_mk1`, `psql -U postgres`. Backend container `accumark-arcitest-accu-mk1-backend` runs `--reload` on the bind-mounted worktree — merges to `~/worktrees/mk1-arcitest` auto-reload (unless wedged; see gotchas). FE = Vite dev server, serves new modules without restart.
- **UAT state**: `P-0156` left with Residual Moisture ADDED (placeholder 3709 + S04 row + edge). `P-0157` healed and reset: live Lead placeholder **3715** (ordered) + S02 row **3719** (unassigned); history rows 3711/3712/3713/3714 rejected/retracted in Invalid tabs; **promotion link 580 deleted**.
- **Prod untouched. Nothing pushed anywhere.** Local: no `backend/.env` in the slice worktree (deliberate — an empty-token .env fakes +23 failures); npm deps installed.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Slice backend suites | `cd C:\tmp\Accu-Mk1-manage-analyses\backend && C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_manage_native.py tests/test_manage_native_routes.py tests/test_parent_placeholders.py tests/test_amendment_audit.py` (last: 85 passed incl. T13's 4) |
| Full-suite gate | same interpreter, `-m pytest -q -p no:cacheprovider -rf`, then diff `grep -E "^(FAILED\|ERROR) tests/"` ids vs `C:\tmp\Accu-Mk1-manage-analyses\.superpowers\sdd\2026-08-18-native-manage-analyses\baseline_ids.txt` (68 ids) |
| FE | `cd C:\tmp\Accu-Mk1-manage-analyses && npx vitest run src/test/native-manage-analyses-block.test.tsx src/test/manage-analyses-picker.test.ts && npm run check:all` (npm ONLY) |
| Stack | `ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack validate arcitest \| tail -1'` → 21/21 |
| Live API smoke | login `POST http://localhost:5812/api/auth/login` (e2e creds above) → `GET http://localhost:5812/api/api/lims-analyses/parent/P-0157/native-profiles` |

## Outstanding items the user may want next

1. **UAT round 2 verdict (P-0157)** — Handler re-runs: result on S02 Lead → promote → parent retest → reject child → Manage Analyses remove now gives 412-confirm → clean removal → re-add. Waiting on their report.
2. **OPEN DECISION: "reject AR on the parent" one-click extension** — Handler asked; I proposed relaxing remove's live-canonical 409 behind the modal's escalated ("Force retract & replace") confirm, using `force_retract_analysis` as-is; published stays refused. Offered as a Task-13-sized slice; **no answer yet**.
3. **OPEN DECISION: branch integration** — menu presented (merge local / push+PR stacked on #98 / keep as-is). House norm: merge train HELD, pushes Handler-directed. No answer yet.
4. Follow-ups ledgered in spec §9: IS `order-services-updated` → Mk1 re-signal; raw `POST /api/lims-analyses` creator guard; empty-members profile save-time guard; Re-sync stamps NULL `catalog_snapshot` once S4 + this slice are both merged; R2 + rider-dim tripwires (fire when the catalog first gains a peptide-linked or all-mk1-rider profile).
5. Deferred minors (final-review triaged, none block): remove-404 detail shape, picker `p.key` lowercase, `doRemove` NaN console.warn, perf items in `manage_native.py`.
6. Still open from prior arcs (untouched this session): badge v1.6.0 integration choice, release plan v2 checks, promo enforce flip, #100 S2×S4 fix.

## User collaboration preferences

- Full pipeline for features (brainstorm → spec → plan → SDD with per-task review + final review); rulings by exception with cost-if-wrong ledgered; reviewer prompts never pre-judge findings.
- Conversational clarification over MCQ walls; absolute paths everywhere; name the environment (arcitest ≠ s3rehe ≠ prod); npm only in Mk1 FE; never push/merge without the word; never `git checkout --`/stash on devbox worktrees; failing baseline tests = gate by failure-SET diff, never zero-failures.
- UAT style: Handler drives the UI personally and reports precise repro sequences (the P-0157 find was exact); when they report a bug, diagnose from the DB first, propose the fix, get the nod, then build.
- When healing UAT data, restore their EXACT prior state (vial-level add ≠ profile add — got corrected on this once).

## Recommended first action in the new session

Confirm the three checkouts still match this doc, then pick up whichever open decision the Handler answers first:

```bash
git -C C:/tmp/Accu-Mk1-manage-analyses log --oneline -1   # expect 8cda9e22, clean
git -C C:/tmp/Accu-Mk1-arcitest log --oneline -1          # expect 109c2d3d
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/mk1-arcitest log --oneline -1; curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://localhost:5812/health'   # expect ad2f5c8a, 200
```
