# Retest-Aware Promote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vial-tier Retest works (linked retest row + RETESTED flag); promoting a retest row supersedes the prior parent value atomically; SENAITE write-back targets the right line after a parent-side retest; Verify stays hidden on promoted vial rows.

**Architecture:** Additive edges in `lims_analyses/state_machine.py` + a retest branch in `service.apply_transition`; a supersession step inside `promote_to_parent`'s transaction; a smarter match preference in `senaite_writeback.find_parent_analysis_line`; two-line rule changes in AnalysisTable's exported gating helpers.

**Tech Stack:** FastAPI/SQLAlchemy backend (container `accumark-subvial-accu-mk1-backend`), React/TS/vitest FE (container `accumark-subvial-accu-mk1-frontend`).

**Spec:** `docs/superpowers/specs/2026-06-05-retest-aware-promote-design.md` · **Branch:** `subvial/continue` (worktree `C:/tmp/Accu-Mk1-subvial`)

**Operational notes (all tasks):** locate edits by symbol name; containers bind-mount the worktree (do NOT restart); always `-e MSYS_NO_PATHCONV=1` on docker exec with container paths; per-task commits, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`; commit only your task's files; leave dirty `docs/superpowers/` files alone. Backend tests: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -v"`. FE tests/typecheck: vitest + `tsc --noEmit` in the FE container (expect ONLY the 2 pre-existing typecheck errors: `WorksheetsInboxPage.tsx(356,38)`, `SampleDetails.tsx ... subSamples ... never read`).

---

## Task 1: Vial-tier retest (state machine + service)

**Files:** `backend/lims_analyses/state_machine.py`, `backend/lims_analyses/service.py`, new test `backend/tests/test_vial_retest.py`.

Requirements (TDD — write the failing tests first):
1. `kind="retest"` becomes legal on VIAL tier from `to_be_verified` and from `verified` (read `_ALLOWED` / `_TIER_ALLOWED_KINDS` and follow their exact structure; parent-tier retest behavior must remain unchanged — check what it allows today and don't alter it).
2. Retest is NOT a simple state move: in `apply_transition`, a `retest` on a vial row must (in one transaction, mirroring how the function writes audit transitions today):
   - leave the old row's `review_state` unchanged; set `old.retested = True`
   - create a new `LimsAnalysis`: same `lims_sub_sample_pk`/`analysis_service_id`/`keyword`/`title`/`result_unit`, `result_value=None`, `retest_of_id=old.id`, initial `review_state` matching whatever state freshly-created vial analyses start in (find `create_analysis` in the service and reuse its initial state)
   - write an audit transition row on the old analysis (reason mentions the new row id) following the existing audit pattern
   - return the NEW row (so the API response is the retest row)
3. Tests (≥5): retest from `to_be_verified` creates linked row + flags old; retest from `verified` works; old row state unchanged; vial retract/reject/verify behavior unchanged (regression); parent-tier retest behavior unchanged (regression — assert whatever it does today, discover first).
4. Run new file + `tests/test_lims_analyses_service.py` + `tests/test_lims_analyses_routes.py` (no regressions). Commit `feat(lims-analyses): vial-tier retest creates linked retest row`.

## Task 2: Promote supersession for retest sources

**Files:** `backend/lims_analyses/service.py` (`promote_to_parent`), append tests to `backend/tests/test_vial_retest.py`.

Requirements:
1. In `promote_to_parent`, after source validation and BEFORE inserting the parent row: if every source row has `retest_of_id IS NOT NULL` (it's a retest promotion) — find the active parent-tier row for `(parent_sample_pk, keyword)` (`retest_of_id IS NULL AND review_state NOT IN ('retracted','rejected')`); if found, set it to `retracted` + write an audit transition (reason `"superseded by retest promotion"`) inside the same transaction. Non-retest sources: behavior unchanged (the unique index still 409s).
2. Tests (≥3, driving `promote_to_parent` directly with `commit=True`): retest-source promote supersedes (old parent row `retracted`, new row `verified`, audit written); non-retest second promote still raises IntegrityError; supersession respects the `commit=False` path (nothing persisted before route commit — promote with commit=False, rollback, assert old parent row still active).
3. Run the file + `tests/test_promote_writeback_route.py`. Commit `feat(lims-analyses): retest promotion supersedes prior parent row`.

## Task 3: Write-back targets active non-verified lines

**Files:** `backend/lims_analyses/senaite_writeback.py` (`find_parent_analysis_line`), tests in `backend/tests/test_senaite_writeback.py` (append/convert).

Requirements:
1. Among keyword matches: first preference = lines NOT in `('retracted','rejected','verified')`; if none, and verified line(s) exist → `SenaiteWritebackError` ("already verified in SENAITE — retest or retract there first"), NO update calls; all-retracted/rejected error unchanged.
2. `writeback_promotion`'s own already-verified guard stays (defense in depth) but is now only reachable in races.
3. Tests: [verified, unassigned] pair → returns the unassigned uid regardless of order (test both orders); only-verified → error + no `_update`/`_transition` calls; existing tests adjusted as needed (keep ≥ current coverage, file currently has 9 tests).
4. Run the file + `tests/test_promote_writeback_route.py`. Commit `fix(lims-analyses): write-back prefers active non-verified SENAITE lines`.

## Task 4: FE gating — verify hidden on promoted rows + destructive note

**Files:** `src/components/senaite/AnalysisTable.tsx`, tests appended to `src/test/bulk-promote-overlay.test.tsx`.

Requirements:
1. New exported helper or extend existing: a row "has been promoted" = `promoted_to_parent_id != null`. `visibleRowTransitions` suppresses `verify` when the row is promotable OR promoted. `deriveBulkActions` excludes `verify` when ANY selected row is promotable OR promoted (showPromote rule unchanged).
2. The bulk destructive confirm dialog (search `Bulk destructive transition confirmation`): when the selection includes promoted rows, append a line to the description: `"N selected analyses were promoted to the parent — the parent keeps its promoted value."` (derive N from selectedAnalyses with promoted_to_parent_id != null; plain conditional text, no new component).
3. Tests (≥4): promoted row hides verify in `visibleRowTransitions` but keeps retract; bulk with promoted row excludes verify; promoted+SENAITE mix excludes verify, no promote; pure-SENAITE selection still offers verify (regression). Existing 22 tests in the file must stay green (counts may shift if any asserted old verify behavior on promoted rows — convert, don't delete).
4. Typecheck + run `src/test/bulk-promote-overlay.test.tsx` + `src/test/analysis-mk1-indicator.test.tsx`. Commit `fix(analysis-table): suppress verify on promoted vial rows + destructive note`.

---

## Self-Review

Spec coverage: vial retest → T1; supersession → T2; targeting → T3; guardrails → T4 (bulk Retest needs no change — T1 makes the existing wiring valid). No placeholders — discovery steps are anchored ("find create_analysis initial state", "read _ALLOWED structure"). Type consistency: `retest_of_id`, `retested`, `promoted_to_parent_id` names match the existing model/response fields used across tasks.

Final gate (controller): full backend baseline (flag-off, expect the 13 known failures), FE suite + typecheck, live E2E on P-0144 (vial Retest ENDO → enter value → promote → old Mk1 parent row retracted, SENAITE line at to_be_verified).
