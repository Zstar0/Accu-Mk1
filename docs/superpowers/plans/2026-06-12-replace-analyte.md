# Replace Analyte — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tech correct a wrong peptide-variant on a parent sample in one slot-anchored "Replace" action that repoints the analyte, reconciles the Identity service, re-mirrors the vials, and clears worked results via an audited retract behind a confirmation modal.

**Architecture:** Two shippable subsystems. **Phase 1 (foundation):** upgrade the standalone Manage-Analyses service remove so worked rows route to the existing audited `reject` transition (not silent-skip), gated by a confirmation modal driven by a new removal-impact endpoint; verified/published rows are blocked. **Phase 2:** a slot-anchored Replace orchestrator that repoints `Analyte{N}Peptide`, reconciles `ID_<old>`→`ID_<new>`, and re-mirrors each vial's per-substance PUR/QTY/ID — reusing Phase 1's retract path and the existing parent→vial cascades and seeder.

**Tech Stack:** FastAPI + SQLAlchemy (backend `C:/tmp/accu-mk1-wave1/backend`), React + TanStack Query + dnd-kit (frontend `src/`), pytest (in-memory sqlite) + vitest. Parent AR services proxy to the Integration Service → SENAITE; vial rows are Mk1 `lims_analyses`.

**Key reuse points (verified):**
- `lims_analyses/service.py`: `apply_transition(db, *, analysis_id, kind, result_value=None, reason=None, user_id=None)` (kinds incl. `reject`: unassigned/assigned/to_be_verified→rejected); `delete_pristine_analysis(db, *, sub_sample_pk, keyword, user_id)` (raises `BadRequestError` on activity); `cascade_parent_reject_to_vials(db, *, parent_sample_id, keyword, user_id)`; `cascade_parent_remove_from_vials(...)`; `cascade_parent_add_to_vials(db, *, parent_sample_id, user_id)`; `_candidate_vial_keywords(db, *, parent_sample_id, keyword)`; `list_analyses_for_host(db, *, host_kind, host_pk, include_retests)`.
- `lims_analyses/seeder.py`: `seed_analyses_for_vial(db, *, sub_sample, role, wp_services, parent_sample_id, ...)` (translates `ANALYTE-{slot}` → `PUR_<X>/QTY_<X>/ID_<X>`).
- `main.py`: remove endpoint `DELETE /explorer/samples/{sample_id}/analyses/{keyword}` (~8295); add endpoint `POST /explorer/samples/{sample_id}/analyses` (~8200) with `cascade_parent_add_to_vials`; `transition_analysis` (~12821) wires the parent reject cascade; analyte parse from `Analyte{N}Peptide` (~11309); `set_sample_analyte_alias`/`clear_sample_analyte_alias` (~8649/8700).
- Models: `AnalysisService(title, keyword, peptide_id)`, `LimsAnalysis(keyword, review_state, result_value, retested, promoted_to_parent_id, lims_sub_sample_pk, retest_of_id)`, `LimsSubSample(parent_sample_pk, sample_id, vial_sequence, assignment_role, external_lims_uid)`, `LimsSample(sample_id, external_lims_uid)`.
- Terminology: the user's "retract" = clear-with-audit = state-machine **`reject`** (review_state→`rejected`, restorable on re-add). State-machine `retract` (verified→retracted) is admin-only and out of scope (verified rows are blocked).

**Row tiers (used everywhere a removal can occur):**
| Tier | Predicate | Action |
|---|---|---|
| pristine | `review_state=='unassigned'` AND `result_value IS NULL` AND `not retested` AND no promotion link | delete (`delete_pristine_analysis`) |
| worked_unverified | active (not retracted/rejected), has activity, `review_state NOT IN {verified, published}`, `promoted_to_parent_id IS NULL` | reject (`apply_transition kind='reject'`) — confirm-gated |
| blocked | `review_state IN {verified, published}` OR `promoted_to_parent_id IS NOT NULL` | none — report "invalidate/retest first" |

---

## PHASE 1 — Tiered retract-on-remove (foundation)

### Task 1: `classify_removal_impact` service function

**Files:**
- Modify: `backend/lims_analyses/service.py` (add function near `cascade_parent_remove_from_vials`, ~line 1056)
- Test: `backend/tests/test_removal_impact.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_removal_impact.py
from __future__ import annotations
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import apply_transition, create_analysis, classify_removal_impact
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample


@pytest.fixture
def db_mem():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def seed(db_mem):
    svc = AnalysisService(title="BPC-157 - Identity (HPLC)", keyword="ID_BPC157")
    db_mem.add(svc); db_mem.flush()
    parent = LimsSample(sample_id="P-IMP-001", external_lims_uid="uid-imp-001")
    db_mem.add(parent); db_mem.flush()
    sub1 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="uid-imp-001-S01",
                         sample_id="P-IMP-001-S01", vial_sequence=1)
    sub2 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="uid-imp-001-S02",
                         sample_id="P-IMP-001-S02", vial_sequence=2)
    db_mem.add_all([sub1, sub2]); db_mem.commit()
    return db_mem, parent, sub1, sub2, svc


def _row(db, sub, svc):
    return create_analysis(db, host_kind="sub_sample", host_pk=sub.id,
                           analysis_service_id=svc.id, keyword=svc.keyword,
                           title=svc.title, result_value=None)


def _no_slot(monkeypatch):
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots",
                        lambda pid: (_ for _ in ()).throw(AssertionError("no slot fetch")))


def test_classifies_pristine_worked_and_blocked(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot(monkeypatch)
    pristine = _row(db, sub1, svc)                      # unassigned, no result -> pristine
    worked = _row(db, sub2, svc)
    apply_transition(db, analysis_id=worked.id, kind="assign")
    apply_transition(db, analysis_id=worked.id, kind="submit", result_value="99.1")  # to_be_verified -> worked_unverified

    impact = classify_removal_impact(db, parent_sample_id=parent.sample_id, keyword=svc.keyword)

    assert [r["sample_id"] for r in impact["pristine"]] == ["P-IMP-001-S01"]
    assert [r["sample_id"] for r in impact["worked_unverified"]] == ["P-IMP-001-S02"]
    assert impact["blocked"] == []


def test_verified_row_is_blocked(seed, monkeypatch):
    db, parent, sub1, sub2, svc = seed
    _no_slot(monkeypatch)
    r = _row(db, sub1, svc)
    apply_transition(db, analysis_id=r.id, kind="assign")
    apply_transition(db, analysis_id=r.id, kind="submit", result_value="99.1")
    apply_transition(db, analysis_id=r.id, kind="verify")   # verified -> blocked

    impact = classify_removal_impact(db, parent_sample_id=parent.sample_id, keyword=svc.keyword)
    assert [r["sample_id"] for r in impact["blocked"]] == ["P-IMP-001-S01"]
    assert impact["pristine"] == [] and impact["worked_unverified"] == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_removal_impact.py -q"`
Expected: FAIL — `ImportError: cannot import name 'classify_removal_impact'`

- [ ] **Step 3: Implement `classify_removal_impact`**

Add to `backend/lims_analyses/service.py` (after `cascade_parent_remove_from_vials`). Reuses `_candidate_vial_keywords` for the analyte-bridge keyword set and the tier predicates from the plan header.

```python
def classify_removal_impact(
    db: Session, *, parent_sample_id: str, keyword: str,
) -> Dict[str, List[dict]]:
    """Classify the vial-tier rows a parent-service removal would touch into
    pristine / worked_unverified / blocked. Drives the confirmation modal and
    the delete-vs-reject decision. Pure read; never mutates."""
    from models import LimsSample, LimsSubSample, LimsAnalysisPromotion

    out = {"pristine": [], "worked_unverified": [], "blocked": []}
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return out

    candidate_kws = _candidate_vial_keywords(
        db, parent_sample_id=parent_sample_id, keyword=keyword
    )
    rows = db.execute(
        select(LimsAnalysis, LimsSubSample.sample_id)
        .join(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsAnalysis.keyword.in_(candidate_kws),
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.review_state.notin_(["retracted", "rejected"]),
        )
    ).all()

    for row, vial_sample_id in rows:
        entry = {"analysis_id": row.id, "sample_id": vial_sample_id,
                 "keyword": row.keyword, "review_state": row.review_state}
        promoted = row.promoted_to_parent_id is not None or db.execute(
            select(LimsAnalysisPromotion.id).where(
                LimsAnalysisPromotion.source_analysis_id == row.id)
        ).scalar_one_or_none() is not None
        if row.review_state in ("verified", "published") or promoted:
            out["blocked"].append(entry)
        elif row.review_state == "unassigned" and row.result_value is None and not row.retested:
            out["pristine"].append(entry)
        else:
            out["worked_unverified"].append(entry)
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_removal_impact.py -q"`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/service.py backend/tests/test_removal_impact.py
git commit -m "feat(lims): classify_removal_impact — tier vial rows for retract-on-remove"
```

---

### Task 2: `reject_vials_for_parent_keyword` (retract worked vial rows)

**Files:**
- Modify: `backend/lims_analyses/service.py`
- Test: `backend/tests/test_removal_impact.py` (extend)

- [ ] **Step 1: Write the failing test**

```python
def test_reject_worked_vials_clears_with_audit(seed, monkeypatch):
    from lims_analyses.service import reject_vials_for_parent_keyword
    db, parent, sub1, sub2, svc = seed
    _no_slot(monkeypatch)
    worked = _row(db, sub2, svc)
    apply_transition(db, analysis_id=worked.id, kind="assign")
    apply_transition(db, analysis_id=worked.id, kind="submit", result_value="99.1")

    rejected = reject_vials_for_parent_keyword(
        db, parent_sample_id=parent.sample_id, keyword=svc.keyword, user_id=None,
    )
    assert worked.id in rejected
    db.refresh(worked)
    assert worked.review_state == "rejected"
```

- [ ] **Step 2: Run to verify it fails**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_removal_impact.py::test_reject_worked_vials_clears_with_audit -q"`
Expected: FAIL — ImportError.

- [ ] **Step 3: Implement** (reuses `classify_removal_impact` + `apply_transition`)

```python
def reject_vials_for_parent_keyword(
    db: Session, *, parent_sample_id: str, keyword: str, user_id: Optional[int],
) -> List[int]:
    """Reject (audited clear) the worked_unverified vial rows of a parent
    service. Verified/published/promoted rows are left untouched (blocked).
    Returns the rejected analysis ids. Never raises on a single bad row."""
    impact = classify_removal_impact(db, parent_sample_id=parent_sample_id, keyword=keyword)
    out: List[int] = []
    for entry in impact["worked_unverified"]:
        try:
            apply_transition(db, analysis_id=entry["analysis_id"], kind="reject",
                             reason="rejected via Manage Analyses remove (worked result)",
                             user_id=user_id)
            out.append(entry["analysis_id"])
        except Exception:
            db.rollback()
            continue
    return out
```

- [ ] **Step 4: Run to verify it passes**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_removal_impact.py -q"`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/service.py backend/tests/test_removal_impact.py
git commit -m "feat(lims): reject_vials_for_parent_keyword — audited retract of worked vial rows"
```

---

### Task 3: removal-impact endpoint

**Files:**
- Modify: `backend/main.py` (near the remove endpoint ~8295)
- Test: manual curl (endpoint is a thin wrapper over the tested function)

- [ ] **Step 1: Add the endpoint**

```python
@app.get("/explorer/samples/{sample_id}/analyses/{keyword}/removal-impact")
async def get_removal_impact(
    sample_id: str,
    keyword: str,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Classify the vial rows a removal of {keyword} from parent {sample_id}
    would touch (pristine / worked_unverified / blocked). Drives the FE modal."""
    from lims_analyses.service import classify_removal_impact
    return classify_removal_impact(db, parent_sample_id=sample_id, keyword=keyword)
```

- [ ] **Step 2: Restart backend, verify route registered**

Run: `docker restart accu-mk1-backend >/dev/null && sleep 3 && curl -fsS "http://localhost:8012/openapi.json" | grep -c "removal-impact"`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add backend/main.py
git commit -m "feat(api): GET removal-impact endpoint for Manage Analyses remove modal"
```

---

### Task 4: upgrade remove endpoint — confirm_retract + reject path

**Files:**
- Modify: `backend/main.py` remove endpoint (~8295-8375)
- Test: `backend/tests/test_native_manage_analyses.py` (extend with a TestClient call, mirror existing tests in that file)

- [ ] **Step 1: Write the failing test** (mirror the existing TestClient setup already in `test_native_manage_analyses.py`)

```python
def test_remove_blocks_when_verified_rows_exist(client, seed_parent_with_verified_vial):
    # seed_parent_with_verified_vial: parent + vial with a VERIFIED ID_ row
    resp = client.delete("/explorer/samples/P-IMP-001/analyses/ID_BPC157")
    assert resp.status_code == 409
    assert "verified" in resp.json()["detail"].lower()


def test_remove_requires_confirm_for_worked_rows(client, seed_parent_with_worked_vial):
    resp = client.delete("/explorer/samples/P-IMP-001/analyses/ID_BPC157")
    assert resp.status_code == 412   # confirmation required
    body = resp.json()
    assert body["detail"]["worked_unverified"]


def test_remove_with_confirm_rejects_worked_rows(client, seed_parent_with_worked_vial):
    resp = client.delete("/explorer/samples/P-IMP-001/analyses/ID_BPC157?confirm_retract=true")
    assert resp.status_code == 200
    # worked vial row now rejected
```

- [ ] **Step 2: Run to verify it fails**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_native_manage_analyses.py -q -k remove_"`
Expected: FAIL (endpoint ignores confirm_retract / doesn't 409/412).

- [ ] **Step 3: Implement** — add `confirm_retract: bool = False` query param; before the existing delete/proxy logic, classify impact and branch:

```python
# at top of the remove endpoint, after resolving sample_id/keyword:
from lims_analyses.service import (
    classify_removal_impact, reject_vials_for_parent_keyword,
)
_impact = classify_removal_impact(db, parent_sample_id=sample_id, keyword=keyword)
if _impact["blocked"]:
    raise HTTPException(status_code=409, detail=(
        "Verified/published results exist on "
        f"{len(_impact['blocked'])} vial(s) — invalidate or retest those first."
    ))
if _impact["worked_unverified"] and not confirm_retract:
    raise HTTPException(status_code=412, detail=_impact)  # FE shows modal, resubmits
if _impact["worked_unverified"] and confirm_retract:
    reject_vials_for_parent_keyword(
        db, parent_sample_id=sample_id, keyword=keyword, user_id=_current_user.id)
# … then the EXISTING native-delete / IS-proxy + cascade_parent_remove logic runs
#    (pristine vial rows handled by the remove cascade as today).
```

- [ ] **Step 4: Run to verify it passes**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_native_manage_analyses.py -q"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_native_manage_analyses.py
git commit -m "feat(api): remove endpoint blocks verified, retracts worked rows on confirm"
```

---

### Task 5: FE — removal-impact API client + confirmation modal

**Files:**
- Modify: `src/lib/api.ts` (add `getRemovalImpact`, extend `removeAnalysisFromSample` with `confirmRetract`)
- Create: `src/components/senaite/RemovalConfirmModal.tsx`
- Modify: `src/components/senaite/SampleDetails.tsx` (`handleRemoveAnalysis` flow)
- Test: `src/test/removal-confirm-modal.test.tsx` (create)

- [ ] **Step 1: API client**

```typescript
// src/lib/api.ts
export interface RemovalImpact {
  pristine: { analysis_id: number; sample_id: string; keyword: string; review_state: string }[]
  worked_unverified: RemovalImpact['pristine']
  blocked: RemovalImpact['pristine']
}
export async function getRemovalImpact(sampleId: string, keyword: string): Promise<RemovalImpact> {
  return apiFetch(`/explorer/samples/${encodeURIComponent(sampleId)}/analyses/${encodeURIComponent(keyword)}/removal-impact`)
}
// extend removeAnalysisFromSample(sampleId, keyword, opts?: { confirmRetract?: boolean })
// → append `?confirm_retract=true` when set.
```

- [ ] **Step 2: Modal component** — `RemovalConfirmModal.tsx`: props `{ impact, serviceTitle, onConfirm, onCancel, open }`. Renders blocked (red, "invalidate first", confirm disabled), worked_unverified count ("This will retract N entered result(s) across M vials and keep a record."), voice mirroring the Manage Analyses help text. Reuse the existing Dialog primitive used elsewhere in `senaite/`.

- [ ] **Step 3: Wire `handleRemoveAnalysis`** — on trash click: `getRemovalImpact`; if only pristine → remove directly (as today); if blocked → open modal in blocked state; if worked_unverified → open modal → on confirm call `removeAnalysisFromSample(id, kw, { confirmRetract: true })`. Refresh sample on success.

- [ ] **Step 4: Test** — render modal with a worked_unverified impact, assert copy + confirm fires `onConfirm`; render with blocked impact, assert confirm is disabled and the invalidate message shows.

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/removal-confirm-modal.test.tsx -q"`
Expected: PASS

- [ ] **Step 5: tsc + commit**

```bash
MSYS_NO_PATHCONV=1 docker exec accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"
git add src/lib/api.ts src/components/senaite/RemovalConfirmModal.tsx src/components/senaite/SampleDetails.tsx src/test/removal-confirm-modal.test.tsx
git commit -m "feat(sample-details): retract-confirm modal for Manage Analyses remove"
```

- [ ] **Step 6: Browser-verify** — restart frontend; on PB-0075 Manage Analyses, remove a service with a worked vial → modal appears → confirm → row rejected; remove a pristine service → no modal.

---

## PHASE 2 — Replace analyte orchestrator + UI

### Task 6: `peptide_has_full_service_set` (offer-only gate)

**Files:**
- Modify: `backend/lims_analyses/service.py`
- Test: `backend/tests/test_replace_analyte.py` (create)

- [ ] **Step 1: Failing test** — seed peptide P with `ID_P`, `PUR_P`, `QTY_P` (peptide_id=P.id) → returns True; seed peptide Q with only `ID_Q` → False.

- [ ] **Step 2: Run → fail (ImportError).**

- [ ] **Step 3: Implement**

```python
def peptide_has_full_service_set(db: Session, *, peptide_id: int) -> bool:
    """True iff the peptide has an ID_, a PUR_, and a QTY_ AnalysisService."""
    from models import AnalysisService
    kws = db.execute(
        select(AnalysisService.keyword).where(AnalysisService.peptide_id == peptide_id)
    ).scalars().all()
    prefixes = {k.split("_", 1)[0] for k in kws if k and "_" in k}
    return {"ID", "PUR", "QTY"}.issubset(prefixes)
```

- [ ] **Step 4: Run → pass. Step 5: commit** `feat(lims): peptide_has_full_service_set offer-only gate`.

---

### Task 7: `replace_analyte_slot` orchestrator (vial re-mirror core)

**Files:**
- Modify: `backend/lims_analyses/service.py`
- Test: `backend/tests/test_replace_analyte.py`

- [ ] **Step 1: Failing test** — parent with slot 2 = old peptide; two vials each carrying `PUR_<old>`/`QTY_<old>`/`ID_<old>` (one pristine, one worked). Call `replace_analyte_slot(... new_peptide_id=NEW, confirm_retract=True ...)`. Assert: pristine vial's old rows deleted; worked vial's old rows rejected; both vials gain `PUR_<new>`/`QTY_<new>`/`ID_<new>` after reseed; returns summary dict.

```python
def test_replace_swaps_vial_per_substance_rows(seed_blend_with_two_vials, monkeypatch):
    from lims_analyses.service import replace_analyte_slot
    db, parent, subs, old_pep, new_pep = seed_blend_with_two_vials
    # stub seeder + slot fetch as the existing seeder tests do
    summary = replace_analyte_slot(
        db, parent_sample_id=parent.sample_id, slot=2,
        new_peptide_id=new_pep.id, confirm_retract=True, user_id=None,
    )
    assert summary["old_peptide_id"] == old_pep.id
    assert summary["new_peptide_id"] == new_pep.id
    # old rows gone/rejected, new rows seeded — assert per the seeder stub
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — orchestrate (Mk1-side only; the SENAITE field write + identity reconcile happen in the endpoint, Task 8):
  1. Resolve old peptide for slot from `fetch_parent_analyte_slots` (title → `ID_<X>` → peptide_id).
  2. Guard: `peptide_has_full_service_set(new_peptide_id)` else `raise BadRequestError`.
  3. Candidate old vial rows = vial analyses where `analysis_service.peptide_id == old_peptide_id`.
  4. Classify per tiers; if blocked and not allowed → return them in summary `blocked`; pristine → `delete_pristine_analysis`; worked_unverified → `apply_transition kind='reject'` (only if `confirm_retract`).
  5. Re-run `seed_analyses_for_vial` per non-xtra vial (seeds new peptide's per-substance rows once the slot title is updated — the endpoint updates the SENAITE field first).
  6. Return `{slot, old_peptide_id, new_peptide_id, vials: {updated, retracted, deleted, blocked}}`.

- [ ] **Step 4: Run → pass. Step 5: commit** `feat(lims): replace_analyte_slot vial re-mirror orchestrator`.

---

### Task 8: Replace endpoint (field write + identity reconcile + orchestrator)

**Files:**
- Modify: `backend/main.py`
- Test: extend `test_replace_analyte.py` with a TestClient call (stub the IS proxy + SENAITE field write as existing tests do)

- [ ] **Step 1: Failing test** — POST `/explorer/samples/{id}/analytes/2/replace` `{new_peptide_id, confirm_retract}` → 400 when new peptide lacks services; 412 when worked rows and not confirmed; 200 + summary on success; asserts `Analyte2Peptide` write + `ID_<old>`→`ID_<new>` reconcile were invoked (mocks).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement endpoint**

```python
@app.post("/explorer/samples/{sample_id}/analytes/{slot}/replace")
async def replace_analyte(
    sample_id: str, slot: int, body: ReplaceAnalyteBody,
    db: Session = Depends(get_db), _current_user=Depends(get_current_user),
):
    # 1. offer-only gate
    if not peptide_has_full_service_set(db, peptide_id=body.new_peptide_id):
        raise HTTPException(400, "Selected peptide has no full ID_/PUR_/QTY_ service set — set it up in Analysis Services first.")
    new_pep = db.get(Peptide, body.new_peptide_id)
    # 2. write Analyte{slot}Peptide on the SENAITE AR (form-encoded accumark field path)
    await _write_senaite_field(sample_id, f"Analyte{slot}Peptide", new_pep.identity_title)
    # 3. reset COA alias for the slot
    _clear_alias(db, sample_id, slot)
    # 4. reconcile parent Identity service: reject/remove ID_<old>, add ID_<new>
    #    (reuse the remove-with-confirm path + add endpoint logic)
    # 5. orchestrate vial re-mirror
    summary = replace_analyte_slot(db, parent_sample_id=sample_id, slot=slot,
                                   new_peptide_id=body.new_peptide_id,
                                   confirm_retract=body.confirm_retract,
                                   user_id=_current_user.id)
    return summary
```

(412 surfaced from `replace_analyte_slot` when worked rows exist and `confirm_retract` is false — mirror Task 4's branch.)

- [ ] **Step 4: Run → pass. Step 5: commit** `feat(api): POST replace-analyte orchestrator endpoint`.

---

### Task 9: FE — Replace action, peptide picker, confirm, wire-up

**Files:**
- Modify: `src/lib/api.ts` (`getReplaceableSlotImpact`, `replaceAnalyte`, `getPeptidesWithServiceSet`)
- Create: `src/components/senaite/ReplaceAnalyteDialog.tsx`
- Modify: `src/components/senaite/SampleDetails.tsx` (ANALYTES card A-row Replace button)
- Test: `src/test/replace-analyte-dialog.test.tsx`

- [ ] **Step 1:** API client — `replaceAnalyte(sampleId, slot, { newPeptideId, confirmRetract })`; reuse `getRemovalImpact` shape for the preview.
- [ ] **Step 2:** `ReplaceAnalyteDialog` — peptide combobox (offer-only; disabled rows for peptides without a full service set, with "set up in Analysis Services" hint), impact preview (reuses the Phase-1 modal's retract/blocked rendering), confirm.
- [ ] **Step 3:** Add a "Replace" button on each ANALYTES-card A-row in `SampleDetails.tsx` next to the pencil; opens the dialog for that slot. On success: invalidate `sample-details` + `VIAL_OVERLAY_QUERY_KEY`; toast the summary.
- [ ] **Step 4:** Test — dialog renders offer-only picker; selecting a peptide with worked vials shows the retract warning; confirm calls `replaceAnalyte` with `confirmRetract: true`.

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/replace-analyte-dialog.test.tsx -q && npx tsc --noEmit"`
Expected: PASS + tsc clean.

- [ ] **Step 5: commit** `feat(sample-details): Replace analyte action + dialog`.

- [ ] **Step 6: Browser-verify on PB-0075** — Replace slot 2 (TB500) with another fully-set-up peptide: ANALYTES card Peptide updates, COA alias resets, parent PUR/QTY re-resolve, vials re-mirror to the new per-substance services, summary toast shows updated/retracted/blocked counts.

---

## Self-review notes

- **Spec coverage:** step-1 repoint (Task 8 field write + alias reset + declared-qty kept), step-2 identity reconcile (Task 8), step-3 slot re-mirror (Task 7), step-4 parent auto (no task — positional), step-5 summary/guards (Tasks 7/8), standalone remove tiers + modal (Tasks 1-5), offer-only gate (Task 6), retract-not-delete (Tasks 2/7), verified blocked (Tasks 1/4/7). All covered.
- **Terminology:** "retract" everywhere = state-machine `reject` (audited, restorable); verified rows blocked, never auto-`retract`d.
- **Open verification during execution:** the exact SENAITE field-write helper (`_write_senaite_field`) and the parent identity reconcile reuse the existing accumark field-edit + add/remove proxy paths — confirm their precise call signatures when implementing Task 8 (the EditableField `senaiteField` write target).
