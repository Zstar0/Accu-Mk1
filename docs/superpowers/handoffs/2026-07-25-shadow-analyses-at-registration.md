# Shadow-at-registration — closing the fresh-sample analyses gap

*Created 2026-07-25. Branch `feat/shadow-analyses-at-registration`, worktree `C:\tmp\Accu-Mk1-shadow-reg`, off `origin/master` @ `969b09f` (v1.6.0). NOT deployed, NOT merged — awaiting Handler sign-off.*

## The gap this closes

The parent-analysis mirror hooks are **event-driven** (result / transition / replace / remove / publish). A sample that has only been REGISTERED has fired none of them, so it has **zero** shadow rows and `build_native_details` returns an EMPTY analyses list in mk1 mode. Flipping the read source with this gap open would hide pending tests from the bench.

Same root gap also hid the "rejected line" diffs on published samples (parity class #10) — **empirically confirmed one gap, not two**: `fetch_parent_analyses('PB-0274')` shows all 11 lines (incl. the 4 `rejected` ANALYTE-3/4 ones) carry `created = 2026-07-20T23:00:57` = the AR's own creation timestamp. Those lines existed at registration and were rejected later, so registration-time shadowing captures them and the later reject event updates the same row.

## What the live registration path actually is (re-verified 2026-07-25)

Memory said the dual-write signal was "DORMANT until IS `ACCUMK1_*` env; #46 NOT deployed". **That was stale.** Verified in prod:

- Prod IS container HAS `/app/app/adapters/accumk1.py` → `POST /s2s/lims-samples`.
- Prod IS env HAS `ACCUMK1_BASE_URL` + `ACCUMK1_INTERNAL_SERVICE_TOKEN`.
- Mk1 prod has **306 rows with a minted `native_id`** — only `upsert_sample_from_signal` mints those. Newest (`P-1567`) minted ~2h before this was written.

Live chain: `IS order_processor` → creates SENAITE AR → `accumk1.notify_sample_created(meta=registry_meta)` → `POST /s2s/lims-samples` → `upsert_sample_from_signal`. This is a **true creation-time hook**, unlike `ensure_sample_row`, whose own docstring says it is "a FIRST-TOUCH path, not a creation-time hook — it can fire years after a family physically existed."

## Why a SENAITE call (and why the signal payload isn't enough)

`ar_data.to_senaite_payload()` carries `Analyses` (explicit service UIDs) and `Profiles` — but **profiles expand server-side in SENAITE**, so signal-only shadowing would capture add-ons/identity services and MISS profile-expanded lines (HPLC-PUR, PEPT-Total). A partial analysis list that looks authoritative is worse than none.

The AR detail is not a source either: `complete=true` returns `Analyses` as **bare refs** (`api_url`/`uid`/`url` only — verified on PB-0274), so resolving them would be 11 extra calls per sample.

So the hook makes **ONE** `fetch_parent_analyses(sample_id)` catalog query — the identical single call the backfill already makes per parent. `feedback_senaite_bulk_scan_hazard` is about unthrottled *sweeps* (hundreds of `complete=yes` at once); this is one call on a human-paced event at ~20-30 new samples/day. Note it does roughly double SENAITE calls during multi-sample order processing (one extra per sample, paced by AR creation).

## What was built (all additive)

| File | Change |
|---|---|
| `backend/lims_analyses/parent_mirror.py` | **NEW** `sync_parent_shadows_from_items(db, *, sample_id, items) -> {created, updated, skipped}`. PURE DB — takes already-fetched catalog items (same split as `select_current_lines`, which it reuses), so the module stays free of HTTP imports and tests need no network. Idempotent by construction: every write goes through `mirror_parent_analysis`'s get-or-create/update against the live (`retested=False`) row, so a rider sweep / retry / the first real result event UPDATES the same row instead of adding a second. `is_retest=False` always (current state, not history). An unmapped keyword or unregistered parent counts `skipped` and never aborts the batch. |
| `backend/main.py` | **NEW** `_shadow_analyses_at_registration_bg(sample_id)` — own short-lived `SessionLocal`, lazy imports inside the try, never raises, logs `registry.registration_shadow_sync`. Exact hardening shape of `_mark_shadows_published_bg`. |
| `backend/main.py` | `s2s_upsert_lims_sample` takes `BackgroundTasks` and schedules the sync **after the response** — IS never waits on the SENAITE round trip, and the request `db` is never held across it. Gated to SENAITE-attached rows only. |
| `backend/tests/test_shadow_analyses_at_registration.py` | **NEW**, 8 tests. |

`BackgroundTasks` is new to this codebase (no prior use in `main.py`) — chosen because the S2S route is a **sync `def`**, so the async siblings' `run_in_threadpool` doesn't apply. It's first-party FastAPI, no new dependency. Converting the route to `async def` was rejected: with a sync DB call inside, that is exactly the `architecture_mk1_async_def_loop_blocking` anti-pattern.

## Bug caught in review of my own guard

First version gated on `if row.external_lims_uid:`. Wrong predicate:
- The IS adapter documents `senaite_uid` as **optional** ("Mk1 fills uid via its reconcile later").
- `fetch_parent_analyses` keys on the **sample_id**, not the uid.

So a legitimately SENAITE-attached sample whose create result didn't expose a uid would have been **silently skipped**. Prod impact today: **none** (0 of 306 signal-created rows have a NULL uid), but the predicate was wrong. Correct gate is "not SENAITE-free" (`external_lims_system != "mk1"` — SENAITE-free rows are the `sample_id is None` branch that explicitly stamps `"mk1"`). Covered by a dedicated regression test.

## TDD record

Every test was watched failing first:
- 5 unit tests → `ImportError: cannot import name 'sync_parent_shadows_from_items'` (feature missing, fixtures ran → DB live).
- Endpoint test → `assert [] == ['KF']` (sample created, zero shadow rows) — the exact gap.
- The SENAITE-failure guard passed vacuously before the hook existed, so it was **mutation-checked**: adding `raise` to the except block made it fail (`RuntimeError: SENAITE down`), proving it can catch the bug. Mutation reverted.
- No-uid test → written RED against the wrong guard.

## Gate

Baseline rule: normalized FAILED-name-set diff vs **master run in the same venv** (the v1.4.0 60-name baseline is stale; current is 63).

- Branch: **63 failed / 1748 passed / 42 skipped**.
- Master @ `969b09f` (main checkout): 65 failed / 1739 passed / 42 skipped.
- Name-set diff: **zero branch-only failures.** The branch set is a strict SUBSET of master's; the only delta is 2 failures present ONLY on master.

**Those 2 are an environment artifact, not code** — `test_httpx_shared_ssl.py::test_all_httpx_clients_share_ssl_context` and `::test_files_using_shared_context_import_it` fail with `SyntaxError: invalid non-printable character U+FEFF`. That test `ast.parse`s backend source files **without excluding `.venv`**, and the venv lives *inside the main checkout* (`backend/.venv/Lib/site-packages/msal/{exceptions,mex,token_cache}.py` carry BOMs). The clean worktree has no venv, so it never scans them. Pre-existing test-hygiene issue, unrelated to this branch — worth a follow-up (`.venv` exclusion in that test's file walk), NOT a regression.

**Final post-guard-fix run: 66 failed / 1746 passed / 42 skipped.** The 3 above the 63 baseline are all `tests/test_clickup_task_retry.py` (`test_retry_picks_up_and_creates`, `test_retry_marks_terminally_failed_after_24h`, `test_retry_does_not_pick_up_recent_rows`) — the known intermittent time-window flake class already recorded in `architecture_mk1_test_baseline_failures`. **Verified flaky, not a regression:** all 3 pass standalone on the branch AND on master (3 passed / 3 passed). Nothing in this change touches ClickUp.

Net: **zero real branch-only failures.**

Run artifacts: `/c/tmp/branch_out.txt`, `/c/tmp/master_out.txt`, `/c/tmp/{branch,master}_names.txt`, `/c/tmp/branch_out2.txt`, `/c/tmp/branch_names2.txt`.

Follow-up worth filing (pre-existing, not mine): `test_httpx_shared_ssl.py` should exclude `.venv` from its file walk — it only passes in a worktree because worktrees have no venv.

## Uncovered path (deliberate, disclosed)

`ensure_sample_row` is a SECOND creation path and is **not** hooked. IS treats the creation signal as best-effort and swallows failures ("the lazy first-touch + reconcile fallback catches missed samples"), so a sample whose signal errored gets its row from `ensure_sample_row` and receives NO shadow sync from either path until the backfill or the nightly rider runs. That is the intended safety net, but it makes this "prevented on the normal path", not "prevented universally". Hooking `ensure_sample_row`'s create branch would close it — deliberately left out to keep this change minimal and additive.

**Premise verified end-to-end against prod (2026-07-25):** `fetch_parent_analyses` returns EXACTLY the keyword set the parity report flagged as `analyses_senaite_only`, for both P-1544 (`ENDO-LAL, HPLC-PUR, ID_RETATRUTIDE, PEPT-Total, STER-PCR`) and P-1543 (`HPLC-PUR, ID_TIRZEPATIDE, PEPT-Total`) — including the profile-expanded lines. Exact match, no source gap.

## What is NOT done (needs Handler sign-off)

1. **Deploy.** Nothing shipped.
2. **Heal the backlog.** The existing `scripts/backfill_parent_analysis_shadows.py` already does this — idempotent, throttled, checkpointed. It was last run before these samples existed (PB-0274 was created 2026-07-20 and still lacks its rejected lines), so a re-run heals every sample created since. **No new code needed** for the backlog; off-hours + serial per backfill doctrine.
3. **The nightly rider** (`MK1_PARENT_MIRROR_RECONCILE_ENABLED`) is still OFF per the prior Handler call. It reuses the same backfill core and would be the ongoing safety net.
4. **Re-parity** after deploy + backfill, then the per-cohort flip decision.

## Relation to the rest of the parity triage

This closes the fresh-cohort blocker and parity class #10. Still open from `2026-07-25-parity-diff-class-triage.md`: the #5 publish-state fix (separate, has the terminality/guard consequences), the #1/#4/#6 harness rules, the #2/#3 backfills, and the #7/#8/#9 unit errors.

**Bonus root-cause for #2/#3 (not fixed here):** `to_senaite_payload()` is the AR-**creation** payload — it has `SampleType` (uid) but no `getSampleTypeTitle` (a read-only getter/index) and no `DateReceived` (not received yet at creation). SENAITE *does* hold both (verified on PB-0274: `getSampleTypeTitle='Peptide Blend'`, `DateReceived='2026-07-21T21:25:54+00:00'`). So it is one root cause — a thin signal payload — not two, and the fix is either IS enrichment or a Mk1 refresh.
