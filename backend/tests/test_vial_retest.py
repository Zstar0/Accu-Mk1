"""Task 1: Vial-tier retest — state machine + service tests.

Tests (≥5 per plan):
  1. retest from to_be_verified creates linked row + flags old row
  2. retest from verified works
  3. old row's review_state is unchanged after retest
  4. vial retract/reject/verify behavior unchanged (regression)
  5. parent-tier retest raises TierMismatchError (regression)
  + extras: audit chain, initial state of new row, from-unassigned illegal
"""
from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from lims_analyses.service import (
    BadRequestError,
    NotFoundError,
    apply_transition,
    create_analysis,
    get_analysis,
)
from lims_analyses.state_machine import (
    InvalidTransitionError,
    TierMismatchError,
)
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


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


def _walk_to_tbv(db, sub, svc, result="98.55"):
    """Create a fresh vial-tier row and walk it to to_be_verified."""
    row = _create(db, sub, svc)
    apply_transition(db, analysis_id=row.id, kind="assign", reason="TEST: assign")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value=result, reason="TEST: submit")
    return get_analysis(db, row.id)


def _walk_to_verified(db, sub, svc, result="98.55"):
    """Create a fresh vial-tier row and walk it to verified."""
    row = _walk_to_tbv(db, sub, svc, result=result)
    apply_transition(db, analysis_id=row.id, kind="verify", reason="TEST: verify")
    return get_analysis(db, row.id)


# ─── Test 1: retest from to_be_verified creates linked row + flags old ────────


def test_retest_from_to_be_verified_creates_linked_row(db, sub_sample, analysis_service):
    old = _walk_to_tbv(db, sub_sample, analysis_service)
    assert old.review_state == "to_be_verified"

    new_row = apply_transition(db, analysis_id=old.id, kind="retest",
                               reason="TEST: retest tbv")

    # Returns the NEW row, not the old row
    assert new_row.id != old.id

    # New row is linked back to old
    assert new_row.retest_of_id == old.id

    # New row starts in 'unassigned' with no result
    assert new_row.review_state == "unassigned"
    assert new_row.result_value is None

    # New row inherits service metadata from old
    assert new_row.keyword == old.keyword
    assert new_row.analysis_service_id == old.analysis_service_id
    assert new_row.lims_sub_sample_pk == old.lims_sub_sample_pk

    # Old row's retested flag is set
    db.refresh(old)
    assert old.retested is True

    # Old row has a 'retest' audit transition
    audit = db.execute(
        select(LimsAnalysisTransition)
        .where(
            LimsAnalysisTransition.analysis_id == old.id,
            LimsAnalysisTransition.transition_kind == "retest",
        )
    ).scalars().first()
    assert audit is not None
    assert audit.from_state == "to_be_verified"
    assert audit.to_state == "to_be_verified"
    assert str(new_row.id) in (audit.reason or "")

    # New row has its own initial audit transition
    new_audit = db.execute(
        select(LimsAnalysisTransition)
        .where(LimsAnalysisTransition.analysis_id == new_row.id)
    ).scalars().first()
    assert new_audit is not None
    assert new_audit.from_state is None
    assert new_audit.to_state == "unassigned"
    assert new_audit.transition_kind == "auto"

    # Tag new row for cleanup
    new_row.title = "TEST: retest-" + (new_row.title or "")
    db.commit()


# ─── Test 2: retest from verified works ─────────────────────────────────────


def test_retest_from_verified_creates_linked_row(db, sub_sample, analysis_service):
    old = _walk_to_verified(db, sub_sample, analysis_service)
    assert old.review_state == "verified"

    new_row = apply_transition(db, analysis_id=old.id, kind="retest",
                               reason="TEST: retest verified")

    assert new_row.id != old.id
    assert new_row.retest_of_id == old.id
    assert new_row.review_state == "unassigned"
    assert new_row.result_value is None

    db.refresh(old)
    assert old.retested is True

    # Tag new row for cleanup
    new_row.title = "TEST: retest-" + (new_row.title or "")
    db.commit()


# ─── Test 3: old row's review_state is unchanged after retest ────────────────


def test_retest_does_not_change_old_row_state(db, sub_sample, analysis_service):
    old_tbv = _walk_to_tbv(db, sub_sample, analysis_service)
    old_tbv_id = old_tbv.id
    old_state = old_tbv.review_state

    new_row = apply_transition(db, analysis_id=old_tbv.id, kind="retest",
                               reason="TEST: check old state")

    # Re-load old row fresh from DB
    old_reloaded = get_analysis(db, old_tbv_id)
    assert old_reloaded.review_state == old_state  # unchanged: still to_be_verified

    # Tag new row for cleanup
    new_row.title = "TEST: retest-" + (new_row.title or "")
    db.commit()


def test_retest_from_verified_does_not_change_old_row_state(db, sub_sample, analysis_service):
    old = _walk_to_verified(db, sub_sample, analysis_service)
    old_id = old.id

    new_row = apply_transition(db, analysis_id=old.id, kind="retest",
                               reason="TEST: check verified state preserved")

    old_reloaded = get_analysis(db, old_id)
    assert old_reloaded.review_state == "verified"  # unchanged

    # Tag new row for cleanup
    new_row.title = "TEST: retest-" + (new_row.title or "")
    db.commit()


# ─── Test 4: vial retract/reject/verify behavior unchanged (regression) ──────


def test_vial_retract_from_to_be_verified_still_works(db, sub_sample, analysis_service):
    """Regression: retract from to_be_verified works as before."""
    row = _walk_to_tbv(db, sub_sample, analysis_service)
    result = apply_transition(db, analysis_id=row.id, kind="retract",
                              reason="TEST: retract regression")
    assert result.review_state == "retracted"
    assert result.retested is False  # retract ≠ retest


def test_vial_reject_from_unassigned_still_works(db, sub_sample, analysis_service):
    """Regression: reject from unassigned works as before."""
    row = _create(db, sub_sample, analysis_service)
    result = apply_transition(db, analysis_id=row.id, kind="reject",
                              reason="TEST: reject regression")
    assert result.review_state == "rejected"


def test_vial_verify_from_to_be_verified_still_works(db, sub_sample, analysis_service):
    """Regression: verify from to_be_verified works as before."""
    row = _walk_to_tbv(db, sub_sample, analysis_service)
    result = apply_transition(db, analysis_id=row.id, kind="verify",
                              reason="TEST: verify regression")
    assert result.review_state == "verified"
    # verify on a normal row does NOT set retested
    assert result.retested is False


# ─── Test 5: parent-tier retest raises TierMismatchError (regression) ────────


def test_retest_on_parent_tier_raises_tier_mismatch(db, analysis_service):
    """A parent-tier row (lims_sample_pk set, review_state=verified) must
    raise TierMismatchError(.tier=='parent', .kind=='retest') — byte-identical
    to what the tier guard does for any other illegal parent-tier kind."""
    parent = db.execute(select(LimsSample)).scalars().first()
    if parent is None:
        pytest.skip("no lims_samples row available")

    row = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title="TEST: parent-tier retest guard",
        review_state="verified",
        result_value="98.55",
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    with pytest.raises(TierMismatchError) as exc_info:
        apply_transition(db, analysis_id=row.id, kind="retest",
                         reason="TEST: should not retest parent-tier")

    err = exc_info.value
    assert err.tier == "parent"
    assert err.kind == "retest"


# ─── Bonus: retest from illegal vial states raises InvalidTransitionError ─────


def test_retest_from_unassigned_raises_invalid_transition(db, sub_sample, analysis_service):
    """Vial-tier retest is only legal from to_be_verified or verified, not
    unassigned — raises InvalidTransitionError."""
    row = _create(db, sub_sample, analysis_service)
    assert row.review_state == "unassigned"

    with pytest.raises(InvalidTransitionError) as exc_info:
        apply_transition(db, analysis_id=row.id, kind="retest",
                         reason="TEST: illegal retest from unassigned")

    err = exc_info.value
    assert err.from_state == "unassigned"
    assert err.kind == "retest"


def test_retest_from_assigned_raises_invalid_transition(db, sub_sample, analysis_service):
    """Vial-tier retest from assigned is also illegal."""
    row = _create(db, sub_sample, analysis_service)
    apply_transition(db, analysis_id=row.id, kind="assign", reason="TEST: assign")
    row = get_analysis(db, row.id)
    assert row.review_state == "assigned"

    with pytest.raises(InvalidTransitionError):
        apply_transition(db, analysis_id=row.id, kind="retest",
                         reason="TEST: illegal retest from assigned")
