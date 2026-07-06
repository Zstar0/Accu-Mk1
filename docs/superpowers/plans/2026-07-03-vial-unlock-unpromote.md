# Vial Unlock (un-promote / un-verify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One "Unlock" affordance that returns locked vial results (`promoted` / `variance_verified`) to `to_be_verified` and pulls the promoted value out of the parent, so the existing retest → re-promote machinery handles corrections.

**Architecture:** Backend adds (1) an `unverify` transition kind (variance rows, rides the existing `/transitions` endpoint) and (2) a `POST /api/lims-analyses/unpromote` endpoint + service function that retracts the parent-tier row and reverts every source vial in the promotion group. SENAITE guard fail-closed before any mutation. Frontend adds an Unlock menu item + reason dialog to `AnalysisTable`.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + vitest (frontend). Spec: `docs/superpowers/specs/2026-07-03-vial-unlock-unpromote-design.md`.

## Global Constraints

- Additive only — no schema change, no migration; `LimsAnalysisPromotion` links are never deleted by unlock.
- Reason is **required** (non-empty after strip) for both unlock actions → 400 otherwise.
- Any authenticated staff may unlock (no role gate); attribution via audit rows.
- Backend pytest runs in a container (laptop python lacks deps):
  `MSYS_NO_PATHCONV=1 docker run --rm -v "C:/tmp/flag-ui/backend:/app" -w /app ghcr.io/zstar0/accu-mk1-backend:1.0.19 sh -c "pip install -q pytest 2>&1 | tail -1; python -m pytest <paths> -q"`
- Frontend: `npx vitest run <file>`; `npx tsc --noEmit`. npm only.
- Do NOT run `prettier --write` on pre-existing files (CRLF working copies mass-reformat); prettier-write only files you created.
- Work on branch `feat/vial-unlock-unpromote` in `C:/tmp/flag-ui`.

---

### Task 1: State machine — `unverify` kind

**Files:**
- Modify: `backend/lims_analyses/state_machine.py` (TRANSITION_KINDS ~line 84, `_ALLOWED` ~line 114, `_TIER_ALLOWED_KINDS` ~line 132)
- Modify: `backend/lims_analyses/schemas.py` (`TransitionKind` Literal, ~line 42)
- Test: `backend/tests/test_lims_analyses_state_machine.py`

**Interfaces:**
- Produces: `next_state("variance_verified", "unverify", tier="vial") == "to_be_verified"`; `"unverify"` member of `TRANSITION_KINDS` and of the vial tier set; `TransitionKind` Literal accepts `"unverify"`.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_lims_analyses_state_machine.py`, matching its existing import style):

```python
def test_unverify_reverts_variance_verified_to_tbv():
    assert next_state("variance_verified", "unverify", tier="vial") == "to_be_verified"


def test_unverify_rejected_from_other_states():
    for state in ("to_be_verified", "verified", "promoted", "unassigned"):
        with pytest.raises(InvalidTransitionError):
            next_state(state, "unverify", tier="vial")


def test_unverify_rejected_on_parent_tier():
    with pytest.raises(TierMismatchError):
        next_state("variance_verified", "unverify", tier="parent")
```

(If the file imports these names differently, follow its existing imports — `next_state`, `InvalidTransitionError`, `TierMismatchError` all live in `lims_analyses.state_machine`.)

- [ ] **Step 2: Run to verify they fail**

Run: container pytest `tests/test_lims_analyses_state_machine.py -q`
Expected: FAIL — `UnknownKindError` (or similar) because `"unverify"` is not in `TRANSITION_KINDS`.

- [ ] **Step 3: Implement**

In `state_machine.py`:

```python
TRANSITION_KINDS: FrozenSet[str] = frozenset({
    "assign", "submit", "verify", "retract", "reject",
    "retest", "publish", "reset", "auto", "variance_verify", "unverify",
})
```

In `_ALLOWED`, next to the `("promoted", "reject")` entry:

```python
    # Unlock: a signed-off variance replicate returns to to_be_verified so the
    # normal retest/re-verify tools apply (vial unlock spec 2026-07-03).
    ("variance_verified", "unverify"): "to_be_verified",
```

In `_TIER_ALLOWED_KINDS[TIER_VIAL]` add `"unverify"`:

```python
    TIER_VIAL: frozenset({
        "assign", "submit", "retract", "reject", "reset", "retest", "auto",
        "variance_verify", "unverify",
    }),
```

In `schemas.py`, extend the Literal:

```python
TransitionKind = Literal[
    "assign", "submit", "verify", "retract", "reject",
    "retest", "publish", "reset", "auto", "variance_verify", "unverify",
]
```

- [ ] **Step 4: Run tests — expect PASS** (same command; also run the whole file to catch regressions).

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/state_machine.py backend/lims_analyses/schemas.py backend/tests/test_lims_analyses_state_machine.py
git commit -m "feat(lims): unverify transition kind (variance_verified -> to_be_verified)"
```

---

### Task 2: `apply_transition` semantic guard — unverify requires reason

**Files:**
- Modify: `backend/lims_analyses/service.py` (`apply_transition`, semantic guards block ~line 326)
- Test: `backend/tests/test_lims_analyses_service.py`

**Interfaces:**
- Consumes: Task 1's `unverify` kind.
- Produces: `apply_transition(db, analysis_id=..., kind="unverify", reason="...", user_id=...)` reverts a vial-tier `variance_verified` row to `to_be_verified` and writes an audit row; blank/missing reason raises `BadRequestError`.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_lims_analyses_service.py`, using that file's existing db fixture/seed helpers — it already seeds vial-tier rows; put the row in `variance_verified` by setting `review_state` directly on the seeded row and committing):

```python
def test_unverify_requires_reason(db_with_vial_analysis):
    db, analysis = db_with_vial_analysis          # adapt to the file's fixture name/shape
    analysis.review_state = "variance_verified"
    db.commit()
    with pytest.raises(service.BadRequestError):
        service.apply_transition(db, analysis_id=analysis.id, kind="unverify",
                                 reason="   ", user_id=1)


def test_unverify_reverts_and_audits(db_with_vial_analysis):
    db, analysis = db_with_vial_analysis
    analysis.review_state = "variance_verified"
    db.commit()
    row = service.apply_transition(db, analysis_id=analysis.id, kind="unverify",
                                   reason="tech verified the wrong replicate", user_id=1)
    assert row.review_state == "to_be_verified"
    audits = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == analysis.id,
            LimsAnalysisTransition.transition_kind == "unverify",
        )
    ).scalars().all()
    assert len(audits) == 1
    assert "wrong replicate" in (audits[0].reason or "")
```

(Prefer reusing a seeded vial-analysis fixture already in `test_lims_analyses_service.py`. If none fits cleanly, use this standalone fixture instead — same pattern as Task 3's:)

```python
@pytest.fixture
def db_with_vial_analysis():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    svc = AnalysisService(title="Purity (HPLC)", keyword="PURITY-HPLC")
    db.add(svc); db.flush()
    parent = LimsSample(sample_id="P-0001", external_lims_uid="uid-P-0001")
    db.add(parent); db.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-0001-S01",
                        external_lims_uid="uid-s1", vial_sequence=1)
    db.add(sub); db.flush()
    a = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                     keyword="PURITY-HPLC", title="Purity (HPLC)",
                     review_state="to_be_verified", result_value="98.5")
    db.add(a); db.commit(); db.refresh(a)
    try:
        yield db, a
    finally:
        db.close()
```

- [ ] **Step 2: Run to verify failure** — expected: reason guard missing, so the blank-reason test FAILS (transition succeeds).

- [ ] **Step 3: Implement** — in `apply_transition`'s semantic-guards block (after the `variance_verify` guard):

```python
    elif kind == "unverify":
        # Unlock is a traceable amendment (ISO 17025 7.5.2) — the audit row
        # must say why, so a blank reason is rejected.
        if not (reason or "").strip():
            raise BadRequestError("unverify requires a non-empty reason")
```

- [ ] **Step 4: Run tests — expect PASS** (run the whole `test_lims_analyses_service.py` file).

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/service.py backend/tests/test_lims_analyses_service.py
git commit -m "feat(lims): unverify transition requires an audit reason"
```

---

### Task 3: `service.unpromote_parent_analysis`

**Files:**
- Modify: `backend/lims_analyses/service.py` (new function, place directly after `force_retract_analysis` ~line 1504)
- Test: Create `backend/tests/test_lims_analyses_unpromote.py`

**Interfaces:**
- Consumes: existing `get_analysis`, `LimsAnalysisPromotion`, `LimsAnalysisTransition`, `BadRequestError`, `InvalidTransitionError`, `NotFoundError`.
- Produces: `unpromote_parent_analysis(db, *, parent_analysis_id: int, reason: str, user_id: Optional[int]) -> tuple[LimsAnalysis, list[int]]` — returns the retracted parent row and the reverted source ids. Task 4's route calls exactly this.

- [ ] **Step 1: Write the failing tests** — new file `backend/tests/test_lims_analyses_unpromote.py`:

```python
"""Unlock (un-promote): parent-tier retract + group source revert.

Spec: docs/superpowers/specs/2026-07-03-vial-unlock-unpromote-design.md
"""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses import service
from models import (
    AnalysisService, LimsAnalysis, LimsAnalysisPromotion,
    LimsAnalysisTransition, LimsSample, LimsSubSample,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _seed_promoted_group(db, n_sources=2):
    """Parent sample + n vials, each with a to_be_verified analysis, promoted
    through the REAL promote_to_parent so state/links match production."""
    svc = AnalysisService(title="Purity (HPLC)", keyword="PURITY-HPLC")
    db.add(svc); db.flush()
    parent = LimsSample(sample_id="P-0001", external_lims_uid="uid-P-0001")
    db.add(parent); db.flush()
    sources = []
    for i in range(1, n_sources + 1):
        sub = LimsSubSample(parent_sample_pk=parent.id, sample_id=f"P-0001-S{i:02d}",
                            external_lims_uid=f"uid-s{i}", vial_sequence=i)
        db.add(sub); db.flush()
        a = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                         keyword="PURITY-HPLC", title="Purity (HPLC)",
                         review_state="to_be_verified", result_value=f"98.{i}")
        db.add(a); db.flush()
        sources.append(a)
    kind = "aggregated_in" if n_sources > 1 else "chosen"
    parent_row, _ = service.promote_to_parent(
        db, keyword="PURITY-HPLC", result_value="98.5", result_unit="%",
        sources=[{"analysis_id": a.id, "contribution_kind": kind} for a in sources],
        user_id=1, reason="test promote",
    )
    return parent, parent_row, sources


def test_unpromote_reverts_group_and_retracts_parent(db):
    parent, parent_row, sources = _seed_promoted_group(db, n_sources=2)
    got_parent, reverted = service.unpromote_parent_analysis(
        db, parent_analysis_id=parent_row.id, reason="purity/quantity swap", user_id=7)
    assert got_parent.review_state == "retracted"
    assert sorted(reverted) == sorted(a.id for a in sources)
    for a in sources:
        db.refresh(a)
        assert a.review_state == "to_be_verified"
    # Links preserved (audit history), parent audit row written with the reason
    links = db.execute(select(LimsAnalysisPromotion).where(
        LimsAnalysisPromotion.parent_analysis_id == parent_row.id)).scalars().all()
    assert len(links) == 2
    parent_audit = db.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == parent_row.id,
        LimsAnalysisTransition.transition_kind == "unpromote")).scalars().all()
    assert len(parent_audit) == 1 and "purity/quantity swap" in parent_audit[0].reason


def test_unpromote_blank_reason_rejected(db):
    _, parent_row, _ = _seed_promoted_group(db, 1)
    with pytest.raises(service.BadRequestError):
        service.unpromote_parent_analysis(db, parent_analysis_id=parent_row.id,
                                          reason="  ", user_id=1)


def test_unpromote_published_parent_blocked(db):
    _, parent_row, _ = _seed_promoted_group(db, 1)
    parent_row.review_state = "published"
    db.commit()
    with pytest.raises(service.InvalidTransitionError):
        service.unpromote_parent_analysis(db, parent_analysis_id=parent_row.id,
                                          reason="x", user_id=1)


def test_unpromote_rejects_vial_tier_target(db):
    _, _, sources = _seed_promoted_group(db, 1)
    with pytest.raises(service.BadRequestError):
        service.unpromote_parent_analysis(db, parent_analysis_id=sources[0].id,
                                          reason="x", user_id=1)


def test_unpromote_then_repromote_round_trip(db):
    _, parent_row, sources = _seed_promoted_group(db, 1)
    service.unpromote_parent_analysis(db, parent_analysis_id=parent_row.id,
                                      reason="redo", user_id=1)
    # Source is back in to_be_verified and the unique parent slot is vacated —
    # a fresh promote succeeds.
    new_parent, _ = service.promote_to_parent(
        db, keyword="PURITY-HPLC", result_value="97.9", result_unit="%",
        sources=[{"analysis_id": sources[0].id, "contribution_kind": "chosen"}],
        user_id=1, reason="re-promote after unlock",
    )
    assert new_parent.review_state == "verified"
    assert new_parent.id != parent_row.id
```

- [ ] **Step 2: Run to verify failure** — expected: `AttributeError: module ... has no attribute 'unpromote_parent_analysis'`.

- [ ] **Step 3: Implement** — add to `service.py` after `force_retract_analysis`:

```python
def unpromote_parent_analysis(
    db: Session, *, parent_analysis_id: int, reason: str,
    user_id: Optional[int],
) -> Tuple[LimsAnalysis, List[int]]:
    """Unlock a promotion: retract the parent-tier canonical row and revert
    EVERY source vial in its promotion group to to_be_verified, so the normal
    retest / re-verify / re-promote tools apply (vial unlock spec 2026-07-03).

    Non-destructive counterpart to force_retract_analysis: promotion links are
    KEPT (consumers already ignore links whose parent row is retracted), and
    sources come back workable instead of rejected. The SENAITE-side guard
    (parent AR line not verified/published) lives in the route — this function
    only owns Mk1 state.

    Returns (parent_row, reverted_source_ids).
    """
    from models import LimsAnalysisPromotion

    if not (reason or "").strip():
        raise BadRequestError("unpromote requires a non-empty reason")

    parent_row = get_analysis(db, parent_analysis_id)
    if parent_row.lims_sub_sample_pk is not None or parent_row.lims_sample_pk is None:
        raise BadRequestError(
            f"analysis {parent_analysis_id} is not a parent-tier row; "
            f"unpromote targets the promoted parent value"
        )
    if parent_row.review_state != "verified":
        raise InvalidTransitionError(
            parent_row.review_state, "unpromote",
            message=(
                "parent result is published (cited by a COA) — invalidate via "
                "the SENAITE/republish flow first"
                if parent_row.review_state == "published"
                else f"unpromote requires a 'verified' parent row, "
                     f"got {parent_row.review_state!r}"
            ),
        )

    links = list(db.execute(
        select(LimsAnalysisPromotion).where(
            LimsAnalysisPromotion.parent_analysis_id == parent_row.id
        )
    ).scalars().all())
    if not links:
        raise BadRequestError(
            f"parent analysis {parent_row.id} has no promotion links; "
            f"nothing to unpromote"
        )

    source_rows = [get_analysis(db, link.source_analysis_id) for link in links]
    not_promoted = [r.id for r in source_rows if r.review_state != "promoted"]
    if not_promoted:
        raise InvalidTransitionError(
            "mixed", "unpromote",
            message=(
                f"source analyses {not_promoted} are not in 'promoted' — the "
                f"promotion group cannot be unlocked partially"
            ),
        )

    now = datetime.utcnow()
    parent_row.review_state = "retracted"
    parent_row.updated_at = now
    db.add(LimsAnalysisTransition(
        analysis_id=parent_row.id, from_state="verified", to_state="retracted",
        transition_kind="unpromote", user_id=user_id,
        reason=f"un-promoted: {reason.strip()}",
    ))

    reverted: List[int] = []
    for src in source_rows:
        src.review_state = "to_be_verified"
        src.updated_at = now
        db.add(LimsAnalysisTransition(
            analysis_id=src.id, from_state="promoted", to_state="to_be_verified",
            transition_kind="unpromote", user_id=user_id,
            reason=f"un-promoted from parent #{parent_row.id}: {reason.strip()}",
        ))
        reverted.append(src.id)

    db.commit()
    db.refresh(parent_row)
    return parent_row, reverted
```

(`Tuple` — check the file's `typing` import at the top; it already imports `Dict, List, Optional, Tuple` variants. Add whichever is missing.)

- [ ] **Step 4: Run tests — expect all 6 PASS.** Also run `tests/test_promote_sets_source_promoted.py tests/test_lims_analyses_service.py -q` for regressions.

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/service.py backend/tests/test_lims_analyses_unpromote.py
git commit -m "feat(lims): unpromote_parent_analysis — group revert + parent retract"
```

---

### Task 4: Route `POST /api/lims-analyses/unpromote` + schemas + SENAITE guard

**Files:**
- Modify: `backend/lims_analyses/schemas.py` (new request/response models, near `PromoteRequest` ~line 98)
- Modify: `backend/lims_analyses/routes.py` (new endpoint after `promote` ~line 379)
- Test: append to `backend/tests/test_lims_analyses_unpromote.py` (route section with its own TestClient fixture — copy the `route_client` fixture pattern from `backend/tests/test_promote_writeback_route.py` lines 46–86 verbatim)

**Interfaces:**
- Consumes: Task 3's `unpromote_parent_analysis`; `senaite_writeback.find_parent_analysis_line(parent_sample_id, keyword) -> {"uid", "review_state"}` (raises `SenaiteWritebackError`).
- Produces: `POST /api/lims-analyses/unpromote` body `{"parent_analysis_id": int, "reason": str}` → 200 `{"parent": AnalysisResponse, "reverted_source_ids": [int]}`; 404 unknown id; 409 SENAITE verified/lookup-failure/state conflicts; 400 blank reason. Task 5's FE calls this.

- [ ] **Step 1: Write the failing route tests** (append; patch target is `lims_analyses.routes.senaite_writeback.find_parent_analysis_line`):

```python
# ─── Route-level tests ────────────────────────────────────────────────────────
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from auth import get_current_user
from database import get_db
from main import app


@pytest.fixture
def route_client():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    def _override_get_db():
        yield shared

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="qa@x.t")
    tc = TestClient(app)
    tc._test_session = shared
    yield tc
    if prev_db is None: app.dependency_overrides.pop(get_db, None)
    else: app.dependency_overrides[get_db] = prev_db
    if prev_user is None: app.dependency_overrides.pop(get_current_user, None)
    else: app.dependency_overrides[get_current_user] = prev_user
    shared.close()


def _line(state):
    return {"uid": "senaite-uid-1", "review_state": state}


def test_unpromote_route_happy_path(route_client):
    db = route_client._test_session
    _, parent_row, sources = _seed_promoted_group(db, 1)
    with patch("lims_analyses.routes.senaite_writeback.find_parent_analysis_line",
               return_value=_line("to_be_verified")):
        resp = route_client.post("/api/lims-analyses/unpromote",
                                 json={"parent_analysis_id": parent_row.id,
                                       "reason": "swap fix"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["parent"]["review_state"] == "retracted"
    assert body["reverted_source_ids"] == [sources[0].id]


def test_unpromote_route_senaite_verified_blocks(route_client):
    db = route_client._test_session
    _, parent_row, sources = _seed_promoted_group(db, 1)
    with patch("lims_analyses.routes.senaite_writeback.find_parent_analysis_line",
               return_value=_line("verified")):
        resp = route_client.post("/api/lims-analyses/unpromote",
                                 json={"parent_analysis_id": parent_row.id,
                                       "reason": "swap fix"})
    assert resp.status_code == 409
    assert "SENAITE" in resp.json()["detail"]
    db.refresh(parent_row)
    assert parent_row.review_state == "verified"      # nothing mutated


def test_unpromote_route_senaite_lookup_failure_fail_closed(route_client):
    db = route_client._test_session
    _, parent_row, _ = _seed_promoted_group(db, 1)
    from lims_analyses.senaite_writeback import SenaiteWritebackError
    with patch("lims_analyses.routes.senaite_writeback.find_parent_analysis_line",
               side_effect=SenaiteWritebackError("boom")):
        resp = route_client.post("/api/lims-analyses/unpromote",
                                 json={"parent_analysis_id": parent_row.id,
                                       "reason": "swap fix"})
    assert resp.status_code == 409
    db.refresh(parent_row)
    assert parent_row.review_state == "verified"


def test_unpromote_route_unknown_id_404(route_client):
    resp = route_client.post("/api/lims-analyses/unpromote",
                             json={"parent_analysis_id": 999999, "reason": "x"})
    assert resp.status_code == 404


def test_unpromote_route_blank_reason_400(route_client):
    db = route_client._test_session
    _, parent_row, _ = _seed_promoted_group(db, 1)
    with patch("lims_analyses.routes.senaite_writeback.find_parent_analysis_line",
               return_value=_line("to_be_verified")):
        resp = route_client.post("/api/lims-analyses/unpromote",
                                 json={"parent_analysis_id": parent_row.id,
                                       "reason": "   "})
    assert resp.status_code == 400
```

- [ ] **Step 2: Run to verify failure** — expected: 404 on every POST (route doesn't exist yet — FastAPI returns 404 for unknown path, which collides with the unknown-id test; the happy-path assertion failing on status 404 vs 200 is the signal).

- [ ] **Step 3: Implement.** In `schemas.py` after `PromoteRequest`:

```python
class UnpromoteRequest(BaseModel):
    """Unlock a promotion: retract the parent-tier row and revert every source
    vial in its group to to_be_verified (vial unlock spec 2026-07-03)."""
    parent_analysis_id: int
    reason: str


class UnpromoteResponse(BaseModel):
    parent: "AnalysisResponse"
    reverted_source_ids: List[int]
```

(Place `UnpromoteResponse` after `AnalysisResponse` is defined, or keep the forward-ref string as shown. Add both names to the routes import at `routes.py` top where `PromoteRequest, PromoteResponse` are imported.)

In `routes.py` after the `promote` endpoint:

```python
@router.post("/unpromote", response_model=UnpromoteResponse)
def unpromote(
    req: UnpromoteRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Unlock a promotion. SENAITE guard runs BEFORE any Mk1 mutation and is
    fail-closed: if the parent AR line is verified/published — or its state
    cannot be confirmed — the unlock is refused (retract in SENAITE first)."""
    from models import LimsSample

    try:
        parent_row = service.get_analysis(db, req.parent_analysis_id)
    except service.NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    parent_sample = (
        db.get(LimsSample, parent_row.lims_sample_pk)
        if parent_row.lims_sample_pk is not None else None
    )
    parent_sample_id = parent_sample.sample_id if parent_sample else None

    if parent_sample_id:
        try:
            line = senaite_writeback.find_parent_analysis_line(
                parent_sample_id, parent_row.keyword)
        except SenaiteWritebackError as e:
            raise HTTPException(
                status_code=409,
                detail=f"SENAITE state could not be confirmed — unlock "
                       f"blocked (fail-closed): {e}",
            )
        if line["review_state"] in ("verified", "published"):
            raise HTTPException(
                status_code=409,
                detail=f"parent analysis line {parent_row.keyword!r} on "
                       f"{parent_sample_id} is {line['review_state']} in "
                       f"SENAITE — retract it in SENAITE first, then unlock",
            )

    try:
        parent, reverted = service.unpromote_parent_analysis(
            db,
            parent_analysis_id=req.parent_analysis_id,
            reason=req.reason,
            user_id=getattr(current_user, "id", None),
        )
    except Exception as e:
        raise _handle_service_error(e)

    return UnpromoteResponse(
        parent=AnalysisResponse.model_validate(parent),
        reverted_source_ids=reverted,
    )
```

- [ ] **Step 4: Run tests — expect all route tests PASS.** Then run the whole lims battery:
`tests/test_lims_analyses_state_machine.py tests/test_lims_analyses_service.py tests/test_lims_analyses_unpromote.py tests/test_lims_analyses_routes.py tests/test_promote_writeback_route.py tests/test_promote_sets_source_promoted.py -q`

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/schemas.py backend/lims_analyses/routes.py backend/tests/test_lims_analyses_unpromote.py
git commit -m "feat(lims): POST /api/lims-analyses/unpromote with fail-closed SENAITE guard"
```

---

### Task 5: Frontend API functions

**Files:**
- Modify: `src/lib/api.ts` (place next to `transitionAnalysis`, ~line 3944)

**Interfaces:**
- Consumes: Task 4's endpoint; existing `API_BASE_URL()` + `getBearerHeaders()` helpers in the same file.
- Produces: `unpromoteAnalysis(parentAnalysisId: number, reason: string): Promise<void>` and `unverifyVarianceAnalysis(uid: string, reason: string): Promise<void>` — Task 6's dialog calls these. Both throw `Error(detail)` on non-OK.

- [ ] **Step 1: Implement** (no standalone test — Task 6's dialog test mocks and asserts these; type safety via tsc):

```typescript
/** Unlock a promotion: retracts the parent-tier value and reverts every
 *  source vial in the group to to_be_verified. 409s carry the SENAITE
 *  retract-first guidance in `detail`. */
export async function unpromoteAnalysis(
  parentAnalysisId: number,
  reason: string
): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/api/lims-analyses/unpromote`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ parent_analysis_id: parentAnalysisId, reason }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    const detail = err?.detail
    throw new Error(
      typeof detail === 'string'
        ? detail
        : (detail?.message ?? `Unlock failed: ${response.status}`)
    )
  }
}

/** Unlock a variance replicate: variance_verified → to_be_verified with a
 *  required audit reason. mk1: UIDs only. */
export async function unverifyVarianceAnalysis(
  uid: string,
  reason: string
): Promise<void> {
  const limsId = parseInt(uid.slice('mk1:'.length), 10)
  const response = await fetch(
    `${API_BASE_URL()}/api/lims-analyses/${limsId}/transitions`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ kind: 'unverify', reason }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    const detail = err?.detail
    throw new Error(
      typeof detail === 'string'
        ? detail
        : (detail?.message ?? `Unlock failed: ${response.status}`)
    )
  }
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit`, expect clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(lims): unlock API functions (unpromote + unverify)"
```

---

### Task 6: UnlockDialog + AnalysisTable wiring

**Files:**
- Create: `src/components/senaite/UnlockDialog.tsx`
- Modify: `src/components/senaite/AnalysisTable.tsx` (gate helper near `visibleRowTransitions` ~line 280; menu item + dialog in the row actions block ~line 1444; state var next to `promoteOpen`)
- Test: Create `src/test/unlock-analysis.test.tsx`

**Interfaces:**
- Consumes: Task 5's `unpromoteAnalysis` / `unverifyVarianceAnalysis`; row fields `uid` (`mk1:<id>`), `review_state`, `promoted_to_parent_id`, `title` on `SenaiteAnalysis` (all exist in `src/lib/api.ts`).
- Produces: exported `canUnlock(a: SenaiteAnalysis): boolean` (for tests); `<UnlockDialog analysis={...} open onOpenChange onUnlocked />`.

- [ ] **Step 1: Write the failing tests** — `src/test/unlock-analysis.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import type { SenaiteAnalysis } from '@/lib/api'

const unpromoteAnalysis = vi.fn()
const unverifyVarianceAnalysis = vi.fn()
vi.mock('@/lib/api', async () => {
  const actual = (await vi.importActual('@/lib/api')) as Record<string, unknown>
  return {
    ...actual,
    unpromoteAnalysis: (...a: unknown[]) => unpromoteAnalysis(...a),
    unverifyVarianceAnalysis: (...a: unknown[]) => unverifyVarianceAnalysis(...a),
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const base = {
  title: 'Purity (HPLC)', keyword: 'PURITY-HPLC', result: '98.5',
} as unknown as SenaiteAnalysis

describe('canUnlock', () => {
  it('allows a promoted mk1 row that knows its parent', async () => {
    const { canUnlock } = await import('@/components/senaite/AnalysisTable')
    expect(canUnlock({ ...base, uid: 'mk1:5', review_state: 'promoted',
                       promoted_to_parent_id: 9 } as SenaiteAnalysis)).toBe(true)
  })
  it('allows a variance_verified mk1 row', async () => {
    const { canUnlock } = await import('@/components/senaite/AnalysisTable')
    expect(canUnlock({ ...base, uid: 'mk1:5', review_state: 'variance_verified',
                       promoted_to_parent_id: null } as SenaiteAnalysis)).toBe(true)
  })
  it('rejects senaite-uid rows, other states, and promoted rows without a parent id', async () => {
    const { canUnlock } = await import('@/components/senaite/AnalysisTable')
    expect(canUnlock({ ...base, uid: 'abc123', review_state: 'promoted',
                       promoted_to_parent_id: 9 } as SenaiteAnalysis)).toBe(false)
    expect(canUnlock({ ...base, uid: 'mk1:5', review_state: 'to_be_verified',
                       promoted_to_parent_id: null } as SenaiteAnalysis)).toBe(false)
    expect(canUnlock({ ...base, uid: 'mk1:5', review_state: 'promoted',
                       promoted_to_parent_id: null } as SenaiteAnalysis)).toBe(false)
  })
})

describe('UnlockDialog', () => {
  beforeEach(() => {
    unpromoteAnalysis.mockReset().mockResolvedValue(undefined)
    unverifyVarianceAnalysis.mockReset().mockResolvedValue(undefined)
  })

  it('disables confirm until a reason is typed, then unpromotes with it', async () => {
    const { UnlockDialog } = await import('@/components/senaite/UnlockDialog')
    const onUnlocked = vi.fn()
    render(
      <UnlockDialog
        analysis={{ ...base, uid: 'mk1:5', review_state: 'promoted',
                    promoted_to_parent_id: 9 } as SenaiteAnalysis}
        open
        onOpenChange={() => {}}
        onUnlocked={onUnlocked}
      />
    )
    const confirm = screen.getByRole('button', { name: /unlock/i })
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/reason/i), 'entry swap')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    await waitFor(() => expect(unpromoteAnalysis).toHaveBeenCalledWith(9, 'entry swap'))
    expect(unverifyVarianceAnalysis).not.toHaveBeenCalled()
    expect(onUnlocked).toHaveBeenCalled()
  })

  it('routes variance_verified rows to unverify', async () => {
    const { UnlockDialog } = await import('@/components/senaite/UnlockDialog')
    render(
      <UnlockDialog
        analysis={{ ...base, uid: 'mk1:5', review_state: 'variance_verified',
                    promoted_to_parent_id: null } as SenaiteAnalysis}
        open
        onOpenChange={() => {}}
        onUnlocked={() => {}}
      />
    )
    await userEvent.type(screen.getByLabelText(/reason/i), 'wrong replicate')
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }))
    await waitFor(() =>
      expect(unverifyVarianceAnalysis).toHaveBeenCalledWith('mk1:5', 'wrong replicate'))
    expect(unpromoteAnalysis).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/test/unlock-analysis.test.tsx`; expected: module has no export `canUnlock` / `UnlockDialog` not found.

- [ ] **Step 3: Implement `UnlockDialog.tsx`:**

```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  unpromoteAnalysis, unverifyVarianceAnalysis, type SenaiteAnalysis,
} from '@/lib/api'

/**
 * Unlock a signed-off vial result (vial unlock spec 2026-07-03).
 *
 * promoted rows          → POST /unpromote (retracts the parent value and
 *                          reverts EVERY vial in the promotion group)
 * variance_verified rows → kind=unverify transition (single row)
 *
 * The reason is required — it lands on the audit trail (ISO 17025 7.5.2).
 */
export function UnlockDialog({
  analysis,
  open,
  onOpenChange,
  onUnlocked,
}: {
  analysis: SenaiteAnalysis
  open: boolean
  onOpenChange: (open: boolean) => void
  onUnlocked: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const isPromoted = analysis.review_state === 'promoted'

  const confirm = async () => {
    if (!reason.trim() || !analysis.uid) return
    setBusy(true)
    try {
      if (isPromoted) {
        if (analysis.promoted_to_parent_id == null) return
        await unpromoteAnalysis(analysis.promoted_to_parent_id, reason.trim())
      } else {
        await unverifyVarianceAnalysis(analysis.uid, reason.trim())
      }
      toast.success('Result unlocked — back to To Be Verified')
      onOpenChange(false)
      setReason('')
      onUnlocked()
    } catch (err) {
      toast.error('Unlock failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlock {analysis.title}</DialogTitle>
          <DialogDescription>
            {isPromoted
              ? 'Retracts the promoted parent value and returns every vial in this promotion group to To Be Verified. Retest / re-verify / re-promote as needed afterwards.'
              : 'Returns this variance replicate to To Be Verified so it can be corrected and re-verified.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="unlock-reason">Reason (required)</Label>
          <Input
            id="unlock-reason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. data-entry swap — purity entered as quantity"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || !reason.trim()}>
            Unlock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Wire `AnalysisTable.tsx`.** Near `visibleRowTransitions` (~line 280) add + export the gate:

```tsx
/** Unlock is offered on live mk1 rows whose result is signed off: a promoted
 *  row that knows its parent-tier id (needed for /unpromote), or a
 *  variance_verified replicate (vial unlock spec 2026-07-03). */
export function canUnlock(a: SenaiteAnalysis): boolean {
  if (!a.uid?.startsWith('mk1:')) return false
  if (a.review_state === 'promoted') return a.promoted_to_parent_id != null
  return a.review_state === 'variance_verified'
}
```

In the row component (next to `const [promoteOpen, setPromoteOpen] = useState(false)`):

```tsx
const [unlockOpen, setUnlockOpen] = useState(false)
```

In the dropdown trigger condition (~line 1429) add `|| canUnlock(analysis)` to the visibility check:

```tsx
{analysis.uid && (allowedTransitions.length > 0 || canPromote || canVarVerify || canUnlock(analysis)) && (
```

In `DropdownMenuContent`, after the `canVarVerify` item:

```tsx
{canUnlock(analysis) && (
  <DropdownMenuItem onClick={() => setUnlockOpen(true)}>
    Unlock…
  </DropdownMenuItem>
)}
```

After the `PromoteDialog` block (same pattern — always render, gated by open):

```tsx
{canUnlock(analysis) && (
  <UnlockDialog
    analysis={analysis}
    open={unlockOpen}
    onOpenChange={setUnlockOpen}
    onUnlocked={() => onTransitionComplete?.()}
  />
)}
```

Add the import at the top: `import { UnlockDialog } from '@/components/senaite/UnlockDialog'`.
(The row component receives `onTransitionComplete` via props/closure — mirror however `PromoteDialog`'s `onPromoted={onTransitionComplete}` reaches it at ~line 1992.)

- [ ] **Step 5: Run tests — expect PASS:** `npx vitest run src/test/unlock-analysis.test.tsx`, then the neighbors: `npx vitest run src/test/bulk-promote-overlay.test.tsx src/test/variance-verify-gating.test.tsx`. Then `npx tsc --noEmit` and `npx eslint src/components/senaite/UnlockDialog.tsx src/test/unlock-analysis.test.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/components/senaite/UnlockDialog.tsx src/components/senaite/AnalysisTable.tsx src/test/unlock-analysis.test.tsx
git commit -m "feat(lims): Unlock action on promoted/variance-verified vial rows"
```

---

### Task 7: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Backend battery** (container): `tests/test_lims_analyses_state_machine.py tests/test_lims_analyses_service.py tests/test_lims_analyses_unpromote.py tests/test_lims_analyses_routes.py tests/test_promote_writeback_route.py tests/test_promote_sets_source_promoted.py tests/test_httpx_shared_ssl.py -q` — expect 0 failures.
- [ ] **Step 2: Frontend:** `npx vitest run` (full) — compare failures against the known baseline (should be 0 new); `npx tsc --noEmit` clean.
- [ ] **Step 3:** `git push -u origin feat/vial-unlock-unpromote` and stop — PR + version bump + deploy are a separate, sign-off-gated step.
