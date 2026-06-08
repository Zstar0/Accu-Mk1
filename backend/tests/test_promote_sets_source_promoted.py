"""Task 3: promote moves source sub-sample to 'promoted'; retest from promoted.

Tests:
  1. test_promote_moves_source_to_promoted: after promote_to_parent, source
     row's review_state is 'promoted' (not still 'to_be_verified').
  2. test_verify_blocked_on_vial: apply_transition kind='verify' on a vial-tier
     row raises TierMismatchError (Task 1 removed vial verify).
"""
from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from lims_analyses.service import (
    apply_transition,
    create_analysis,
    get_analysis,
    promote_to_parent,
)
from lims_analyses.state_machine import TierMismatchError
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSubSample,
)


# ─── Fixtures (mirrored from test_vial_retest.py — no shared conftest) ────────


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def sub_sample(db):
    sub = db.execute(select(LimsSubSample)).scalars().first()
    if sub is None:
        pytest.skip("no lims_sub_samples row available — seed via Receive Wizard")
    return sub


@pytest.fixture(autouse=True)
def cleanup(db):
    """Wipe TEST-prefixed analyses (and cascading audit rows) after each test."""
    yield
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.reason.like("TEST:%")
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.title.like("TEST:%")
    ))
    db.commit()


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _create(db, sub, svc, **kw):
    return create_analysis(
        db,
        host_kind="sub_sample",
        host_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=kw.get("keyword", svc.keyword),
        title=kw.get("title", "TEST: " + (svc.title or svc.keyword)),
        result_value=kw.get("result_value"),
    )


def _walk_to_tbv(db, sub, svc, result="42.0"):
    """Create a fresh vial-tier row and walk it to to_be_verified."""
    row = _create(db, sub, svc)
    apply_transition(db, analysis_id=row.id, kind="assign", reason="TEST: assign")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value=result, reason="TEST: submit")
    return get_analysis(db, row.id)


# ─── Test 1: promote moves source to 'promoted' ───────────────────────────────


def test_promote_moves_source_to_promoted(db, sub_sample, analysis_service):
    """After promote_to_parent, the source vial row must be in 'promoted'."""
    src = _walk_to_tbv(db, sub_sample, analysis_service)
    assert src.review_state == "to_be_verified"

    parent_row, _promotions = promote_to_parent(
        db,
        keyword=analysis_service.keyword,
        result_value="42.0",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
        user_id=None,
        reason="TEST: promote to promoted",
        commit=True,
    )

    # Tag parent row for cleanup
    parent_row.title = "TEST: parent-" + (parent_row.title or "")
    db.commit()

    # Source must now be in 'promoted'
    db.refresh(src)
    assert src.review_state == "promoted", (
        f"Expected 'promoted' but got {src.review_state!r}"
    )

    # Parent-tier row is in 'verified'
    assert parent_row.review_state == "verified"


# ─── Test 2: verify blocked on vial tier ──────────────────────────────────────


def test_verify_blocked_on_vial(db, sub_sample, analysis_service):
    """apply_transition kind='verify' on a vial-tier row raises TierMismatchError.

    Task 1 removed 'verify' from the vial tier; only parent-tier rows can verify.
    """
    src = _walk_to_tbv(db, sub_sample, analysis_service)
    with pytest.raises(TierMismatchError):
        apply_transition(db, analysis_id=src.id, kind="verify",
                         reason="TEST: verify should be blocked on vial")
