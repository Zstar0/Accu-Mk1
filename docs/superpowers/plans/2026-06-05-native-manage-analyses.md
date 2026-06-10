# Native-Aware Manage Analyses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Manage Analyses" add/remove works on native (`mk1://`) vials by branching to Mk1 in the existing explorer-proxy endpoints; FE untouched.

**Architecture:** Native-detection + branch at the top of the two proxy endpoints in `backend/main.py`; create via existing `lims_analyses.service.create_analysis`; pristine-row hard-delete (+ audit rows) in a new small service function; everything else falls through to the IS proxy unchanged.

**Tech Stack:** FastAPI/SQLAlchemy; tests in backend container `accumark-subvial-accu-mk1-backend`.

**Spec:** `docs/superpowers/specs/2026-06-05-native-manage-analyses-design.md` · **Branch:** `subvial/continue` (worktree `C:/tmp/Accu-Mk1-subvial`)

**Operational notes:** locate by symbol name; bind-mounted container (do NOT restart); `-e MSYS_NO_PATHCONV=1` on docker exec; per-task commits, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`; only your task's files; leave dirty docs alone. Tests: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -v"`.

---

## Task 1: Service-layer add/remove for native vials

**Files:** `backend/lims_analyses/service.py`, new test `backend/tests/test_native_manage_analyses.py`.

TDD. Two functions:

1. `add_analysis_to_native_vial(db, *, sub_sample_pk: int, senaite_service_uid: str | None, keyword: str | None, user_id) -> LimsAnalysis`
   - Resolve the `AnalysisService`: by `senaite_uid == senaite_service_uid` when given, else by `keyword`. NotFoundError when unresolvable.
   - 409-style `BadRequestError` if an active (non-retracted/rejected, `retest_of_id IS NULL`) row with that keyword already exists on the vial.
   - Delegate to the existing `create_analysis(host_kind="sub_sample", host_pk=sub_sample_pk, analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title, result_unit=svc.unit (check field name), created_by_user_id=user_id)`.
2. `delete_pristine_analysis(db, *, sub_sample_pk: int, keyword: str, user_id) -> None`
   - Find the vial's active row by keyword (NotFoundError if none).
   - Guard: `review_state == "unassigned"` AND `result_value IS NULL` AND not retested AND no promotion link — else `BadRequestError("analysis has activity — retract it instead")`.
   - Hard-delete the row's `LimsAnalysisTransition` rows then the row; commit.

Tests (≥6): add resolves by senaite_uid; add by keyword fallback; duplicate add raises; delete pristine removes row+audit; delete with result raises; delete with non-unassigned state raises. Use existing `db_session` fixture + real models (AnalysisService has `senaite_uid` — confirm the column name by reading the model; adapt if different).

Run new file + `tests/test_lims_analyses_service.py`. Commit `feat(lims-analyses): native vial add/remove service functions`.

## Task 2: Native branch in the explorer proxy endpoints

**Files:** `backend/main.py` (the two endpoints near `POST /explorer/samples/{sample_id}/analyses` — search for that path), append tests to `backend/tests/test_native_manage_analyses.py`.

1. At the top of BOTH endpoints: look up `LimsSubSample` by `sample_id` where `external_lims_uid LIKE 'mk1://%'`. If found → native branch; else existing IS-proxy code untouched.
2. Native add: parse the same request body the FE sends today (READ the existing proxy + `addAnalysisToSample` in `src/lib/api.ts` to learn the exact payload field for the service uid). Call `add_analysis_to_native_vial`. Return a response shape compatible with what the FE expects from the proxy success path (read the FE handler — likely just checks ok/json message; match minimally).
3. Native remove: call `delete_pristine_analysis(sub.id, keyword)`. Map NotFoundError→404, BadRequestError→409.
4. Tests (≥4, TestClient with snapshot/restore overrides pattern from `tests/test_analysis_service_result_type.py`): native add 200 + row exists; native add duplicate 409; native remove pristine 200 + row gone; native remove with result 409; PLUS one non-native fallthrough test (sample_id with no native sub-sample row → monkeypatch the IS proxy helper/httpx call to assert the legacy path is reached, not the native one).

Run the file + `tests/test_sub_samples_routes.py` (regression). Commit `feat(explorer): native-aware Manage Analyses add/remove`.

---

## Self-Review

Spec coverage: native detection/branch → T2; add resolution + duplicate guard → T1; pristine-delete semantics → T1; non-native fallthrough untouched → T2 test. No FE task (same endpoints; verified via the payload-compat step in T2). No placeholders — discovery steps are anchored (read the proxy + api.ts payload; read the AnalysisService column names).

Final gate (controller): full backend baseline (13 known failures), live E2E: add HPLC-PUR to a native endo vial on P-0144 via the API, remove it, re-add — then user repeats via the UI button.
