# Promote SENAITE Write-Back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promotions write the result into the parent's SENAITE AR line (fail-closed, SENAITE-first), the parent page shows "promoted from" badges, and promotion events appear in the parent's activity log.

**Architecture:** New sync write-back helper module (`lims_analyses/senaite_writeback.py`, service-account auth, mirrors `sub_samples/senaite.py`); the promote route runs the Mk1 transaction uncommitted, performs the write-back, then commits (rollback + 502 on failure). A promotions read endpoint + `PromotedFromBadge` give parent-page provenance; `get_sample_activity` gains promotion events.

**Tech Stack:** FastAPI + SQLAlchemy + requests (backend, container `accumark-subvial-accu-mk1-backend`); React + TS + vitest (frontend, container `accumark-subvial-accu-mk1-frontend`).

**Spec:** `docs/superpowers/specs/2026-06-05-promote-senaite-writeback-design.md`
**Branch:** `subvial/continue` (worktree `C:/tmp/Accu-Mk1-subvial`)

---

## File Structure

- Create `backend/lims_analyses/senaite_writeback.py` — find line / write result+remark / transitions / orchestrator.
- Modify `backend/lims_analyses/service.py` — `promote_to_parent(..., commit: bool = True)`.
- Modify `backend/lims_analyses/routes.py` — write-back between service call and commit; 502 path. New `GET /promotions` endpoint + schemas.
- Modify `backend/lims_analyses/schemas.py` — promotion list response schemas.
- Modify `backend/main.py` — `get_sample_activity` promotions block.
- Modify `src/lib/api.ts` — `listParentPromotions` client + types.
- Create `src/components/senaite/PromotedFromBadge.tsx`.
- Modify `src/components/senaite/SampleDetails.tsx` + `src/components/senaite/AnalysisTable.tsx` — fetch + prop + render.
- Tests: `backend/tests/test_senaite_writeback.py`, `backend/tests/test_promote_writeback_route.py`, append to existing promote/activity test files where natural, `src/test/promoted-from-badge.test.tsx`.

**Test commands:**
- Backend: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -v"`
- FE: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run <path>"`
- FE typecheck: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"` → only 2 pre-existing errors (`WorksheetsInboxPage.tsx(356,38)`, `SampleDetails.tsx ... subSamples ... never read`).

**Operational notes (all tasks):** locate edits by symbol name (line numbers are hints); containers bind-mount the worktree (do NOT restart); always `-e MSYS_NO_PATHCONV=1` on docker exec with container paths; commit only listed files; per-task commits with trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 1: `senaite_writeback.py` helper (TDD, mocked HTTP)

**Files:** Create `backend/lims_analyses/senaite_writeback.py`; create `backend/tests/test_senaite_writeback.py`.

Mirror `backend/sub_samples/senaite.py` conventions: module-level `SENAITE_BASE_URL`, `SENAITE_USER`, `SENAITE_PASSWORD` env reads; sync `requests` with `_get`/`_post_json` thin wrappers (auth tuple, timeout=30).

Public surface:

```python
class SenaiteWritebackError(RuntimeError):
    """Write-back failed; promote must abort (fail-closed)."""

EXPECTED_POST_STATES = {"submit": "to_be_verified", "verify": "verified"}

def find_parent_analysis_line(parent_sample_id: str, keyword: str) -> dict:
    """GET {SENAITE_BASE_URL}/@@API/senaite/v1/Analysis?getRequestID={parent_sample_id}
    → first item with item["Keyword"] == keyword (items list under "items").
    Returns {"uid": ..., "review_state": ...}. Raises SenaiteWritebackError if
    no matching line or HTTP error."""

def _update(uid: str, payload: dict) -> dict:
    """POST {SENAITE_BASE_URL}/@@API/senaite/v1/update/{uid} → first item dict.
    Raises SenaiteWritebackError on HTTP error or empty items."""

def _transition(uid: str, action: str) -> str:
    """_update(uid, {"transition": action}); compare returned review_state to
    EXPECTED_POST_STATES[action]; mismatch → SenaiteWritebackError (silent
    rejection). Returns the new state."""

def writeback_promotion(parent_sample_id: str, keyword: str,
                        result_value: str, remark: str) -> str:
    """Orchestrator. find line → state machine:
    - state == "verified" → SenaiteWritebackError("already verified in SENAITE — retract there first")
    - _update(uid, {"Result": result_value, "Remarks": remark})
    - if state != "to_be_verified": _transition(uid, "submit")
    - _transition(uid, "verify")
    Returns the SENAITE analysis uid."""
```

Tests (monkeypatch the module's `requests.get`/`requests.post` or the `_get`/`_post_json` wrappers — match how other backend tests mock HTTP; check `tests/` for an existing pattern first):
1. `find_parent_analysis_line` returns uid+state for matching keyword among multiple items.
2. raises when keyword absent.
3. `writeback_promotion` happy path from `unassigned`: result update, submit, verify called in order (record calls).
4. skips submit when line already `to_be_verified`.
5. raises on already-`verified` line without any update call.
6. `_transition` raises on silent rejection (returned state ≠ expected).

Steps: write failing tests → run (`tests/test_senaite_writeback.py`) → implement → all pass → commit `feat(lims-analyses): SENAITE write-back helper for promotions`.

---

## Task 2: Route integration — fail-closed promote

**Files:** Modify `backend/lims_analyses/service.py` (`promote_to_parent`), `backend/lims_analyses/routes.py` (`promote`); create `backend/tests/test_promote_writeback_route.py`.

1. **Service:** read the tail of `promote_to_parent` — if it calls `db.commit()`, add `commit: bool = True` keyword param and gate that call (`if commit: db.commit()` — keep any `db.flush()` so generated IDs exist). If it doesn't commit (relies on route/session teardown), no service change is needed — note that in the report.
2. **Route `promote`:** after `service.promote_to_parent(..., commit=False)` succeeds, derive:
   - parent sample_id label: `db.get(LimsSample, parent_row.lims_sample_pk).sample_id`
   - source vial labels: promotion_rows → source analyses → `LimsSubSample.sample_id` (joined query)
   - user email: `getattr(current_user, "email", None) or "unknown"`
   - remark: `f"Promoted from {', '.join(vial_ids)} (Accu-Mk1) by {email} on {date.today().isoformat()}"`
   Then:
   ```python
   try:
       senaite_writeback.writeback_promotion(parent_sample_id, req.keyword,
                                             req.result_value, remark)
   except SenaiteWritebackError as e:
       db.rollback()
       raise HTTPException(502, f"SENAITE write-back failed — promote aborted: {e}")
   db.commit()
   ```
   Import the module as `from lims_analyses import senaite_writeback` (module-level import so tests can monkeypatch `routes.senaite_writeback.writeback_promotion`).
3. **Config guard:** if SENAITE is unconfigured (`SENAITE_BASE_URL` falsy / env absent) the helper will error — that IS the fail-closed behavior; do not add a bypass.

Tests (TestClient fixture — copy the snapshot/restore `route_client` pattern from `tests/test_analysis_service_result_type.py`, which correctly restores prior `dependency_overrides`; build a parent LimsSample + LimsSubSample + to_be_verified LimsAnalysis fixture):
1. Promote with `writeback_promotion` monkeypatched to succeed → 201; parent row exists; write-back called with parent sample_id, keyword, result, remark containing the vial id and user email.
2. Promote with write-back raising `SenaiteWritebackError` → 502; NO parent-tier row persisted (query: zero `lims_analyses` rows with `lims_sample_pk` set for that parent+keyword); source vial still `to_be_verified`.
3. Existing promote validation errors still work (e.g. wrong-state source → 400-family, write-back NOT called).

Run the new file + the existing promote tests (find them: `grep -l promote backend/tests`), expect all green. Commit `feat(lims-analyses): fail-closed SENAITE write-back on promote`.

---

## Task 3: Promotions read endpoint + parent activity events

**Files:** Modify `backend/lims_analyses/schemas.py`, `backend/lims_analyses/routes.py`, `backend/lims_analyses/service.py`, `backend/main.py` (`get_sample_activity`); append tests to `backend/tests/test_promote_writeback_route.py` (or a new `test_parent_promotions_read.py`).

1. **Schemas:**
   ```python
   class PromotionSourceInfo(BaseModel):
       sample_id: Optional[str] = None     # vial label, e.g. P-0143-S01
       contribution_kind: str

   class ParentPromotionInfo(BaseModel):
       keyword: str
       parent_analysis_id: int
       result_value: Optional[str] = None
       promoted_at: datetime
       promoted_by_email: Optional[str] = None
       sources: List[PromotionSourceInfo]
   ```
2. **Service:** `list_promotions_for_parent(db, parent_sample_id: str) -> list[ParentPromotionInfo]` — LimsSample by sample_id → parent-tier `lims_analyses` rows (`lims_sample_pk == parent.id`) → `LimsAnalysisPromotion` rows by `parent_analysis_id` → source analyses → `LimsSubSample.sample_id`; user email via `User` on `promoted_by_user_id`. Empty list when sample unknown (not 404 — parent pages for non-family samples call this too).
3. **Route:** `GET /api/lims-analyses/promotions?parent_sample_id=...` (auth like siblings) → `list[ParentPromotionInfo]`.
4. **Activity:** in `get_sample_activity` (main.py — locate by function name), after the existing Mk1 blocks add a promotions block using the same service function (import inside the function like other lazy imports there): for each promotion emit
   ```python
   events.append({
       "timestamp": p.promoted_at.isoformat(),
       "event": "analysis_promoted",
       "label": f"{p.keyword} promoted from {', '.join(s.sample_id or '?' for s in p.sources)}",
       "details": {"keyword": p.keyword, "result_value": p.result_value,
                    "by": p.promoted_by_email,
                    "sources": [s.model_dump() for s in p.sources]},
       "source": "lims_analysis_promotions",
   })
   ```
   Match the surrounding events' shape exactly (read a couple of existing blocks first).

Tests: seed parent + vial + promote via the service (commit=True, write-back not involved — call `service.promote_to_parent` directly); assert (a) GET promotions returns keyword/sources/email; (b) unknown sample → `[]`; (c) `get_sample_activity` response includes an `analysis_promoted` event for the parent sample_id (hit the activity route via the TestClient fixture). Commit `feat(lims-analyses): parent promotions endpoint + activity events`.

---

## Task 4: FE — PromotedFromBadge + parent page wiring

**Files:** Create `src/components/senaite/PromotedFromBadge.tsx`; modify `src/lib/api.ts`, `src/components/senaite/SampleDetails.tsx`, `src/components/senaite/AnalysisTable.tsx`; create `src/test/promoted-from-badge.test.tsx`.

1. **api.ts** (near `listLimsAnalysesForSubSample`, matching its conventions):
   ```typescript
   export interface ParentPromotionInfo {
     keyword: string
     parent_analysis_id: number
     result_value?: string | null
     promoted_at: string
     promoted_by_email?: string | null
     sources: { sample_id?: string | null; contribution_kind: string }[]
   }
   export async function listParentPromotions(parentSampleId: string): Promise<ParentPromotionInfo[]>
   // GET /api/lims-analyses/promotions?parent_sample_id=...
   ```
2. **PromotedFromBadge.tsx** (Mk1NativeBadge pattern — see `AnalysisTable.tsx` export):
   ```tsx
   export function PromotedFromBadge({ promotion }: { promotion: ParentPromotionInfo | undefined }) // null-safe: renders null when undefined
   ```
   Renders a muted inline chip: lucide `ArrowUpFromLine` size 11 + text `from {sources joined}`, `title` tooltip `Promoted {date} by {email}`. Test ids/aria: `aria-label="Promoted from sub-sample"`.
3. **AnalysisTable:** new optional prop `promotionsByKeyword?: Map<string, ParentPromotionInfo>`; thread to rows; in the title cell (next to `Mk1NativeBadge`) render `<PromotedFromBadge promotion={analysis.keyword ? promotionsByKeyword?.get(analysis.keyword) : undefined} />`. No behavior change when prop absent.
4. **SampleDetails:** on PARENT pages only (no `parentSampleId`), a `useEffect` on `sampleId` fetches `listParentPromotions(sampleId)` (catch → empty), builds the Map, passes to the parent `<AnalysisTable>`. Refetch after `onTransitionComplete` is NOT required (promotions only change via promote; acceptable staleness) — keep it simple.
5. **Tests** (`src/test/promoted-from-badge.test.tsx`): renders source labels + tooltip; renders null for undefined promotion. 2-4 tests, RTL.

Run badge tests + full bulk-promote/indicator files + typecheck. Commit `feat(sample-details): promoted-from provenance badge on parent analyses`.

---

## Self-Review

1. **Spec coverage:** write-back helper (T1) ✓; fail-closed route ordering + 502 + rollback (T2) ✓; remark format with vials/user/date (T2) ✓; promotions endpoint + badge (T3+T4) ✓; parent activity events (T3) ✓; no backfill / no method-instrument write-back — absent by design ✓.
2. **Placeholder scan:** none; helper signatures and route snippets are concrete; "match surrounding events' shape" is an anchored read-first instruction.
3. **Type consistency:** `SenaiteWritebackError`, `writeback_promotion`, `ParentPromotionInfo`, `PromotionSourceInfo`, `listParentPromotions`, `PromotedFromBadge`, `promotionsByKeyword` consistent across tasks.
