"""Task 1: Vial-tier retest — state machine + service tests.
Task 2: Promote supersession for retest sources.

Tests (≥5 per plan, Task 1):
  1. retest from to_be_verified creates linked row + flags old row
  2. retest from promoted works
  3. old row's review_state is unchanged after retest
  4. vial retract/reject behavior unchanged (regression)
  5. parent-tier retest raises TierMismatchError (regression)
  + extras: audit chain, initial state of new row, from-unassigned illegal

Tests (≥3 per plan, Task 2):
  T2-1. retest-source promote supersedes old parent row
  T2-2. non-retest second promote still raises IntegrityError
  T2-3. supersession respects commit=False (rollback leaves old parent active)
"""
from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from sqlalchemy.exc import IntegrityError

from database import SessionLocal
from lims_analyses.service import (
    BadRequestError,
    NotFoundError,
    apply_transition,
    create_analysis,
    get_analysis,
    promote_to_parent,
)
from lims_analyses.state_machine import (
    InvalidTransitionError,
    TierMismatchError,
)
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisPromotion,
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


def _walk_to_promoted(db, sub, svc, result="98.55"):
    """Create a fresh vial-tier row and put it in 'promoted' (post-promote).

    Sets review_state directly to 'promoted' without running the full promote
    machinery — isolates retest-from-promoted without requiring a parent sample.
    """
    row = _walk_to_tbv(db, sub, svc, result=result)
    row.review_state = "promoted"
    db.commit()
    db.refresh(row)
    return row


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


# ─── Test 2: retest from promoted works ──────────────────────────────────────


def test_retest_from_promoted_creates_linked_row(db, sub_sample, analysis_service):
    old = _walk_to_promoted(db, sub_sample, analysis_service)
    assert old.review_state == "promoted"

    new_row = apply_transition(db, analysis_id=old.id, kind="retest",
                               reason="TEST: retest promoted")

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


def test_retest_from_promoted_does_not_change_old_row_state(db, sub_sample, analysis_service):
    old = _walk_to_promoted(db, sub_sample, analysis_service)
    old_id = old.id

    new_row = apply_transition(db, analysis_id=old.id, kind="retest",
                               reason="TEST: check promoted state preserved")

    old_reloaded = get_analysis(db, old_id)
    assert old_reloaded.review_state == "promoted"  # unchanged

    # Tag new row for cleanup
    new_row.title = "TEST: retest-" + (new_row.title or "")
    db.commit()


# ─── Test 4: vial retract/reject behavior unchanged (regression) ─────────────


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


def test_vial_verify_raises_tier_mismatch(db, sub_sample, analysis_service):
    """Task 1 removed 'verify' from the vial tier — it must now raise
    TierMismatchError instead of succeeding."""
    row = _walk_to_tbv(db, sub_sample, analysis_service)
    with pytest.raises(TierMismatchError):
        apply_transition(db, analysis_id=row.id, kind="verify",
                         reason="TEST: verify blocked on vial")


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


# ─── Task 2: Promote supersession for retest sources ─────────────────────────


@pytest.fixture
def parent_sample(db):
    """Find an existing LimsSample with at least one sub-sample."""
    parent = db.execute(
        select(LimsSample)
        .join(LimsSubSample, LimsSubSample.parent_sample_pk == LimsSample.id)
    ).scalars().first()
    if parent is None:
        pytest.skip("no lims_samples with sub-samples available")
    return parent


def _find_free_sub_sample(db, parent, svc):
    """Find a sub-sample under parent that has no non-retest row for svc.keyword."""
    subs = db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
    ).scalars().all()
    for sub in subs:
        existing = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sub_sample_pk == sub.id,
                LimsAnalysis.keyword == svc.keyword,
                LimsAnalysis.retest_of_id.is_(None),
            )
        ).scalars().first()
        if existing is None:
            return sub
    return None


def _seed_parent_tier_row(db, parent_sample_pk, svc):
    """Insert a synthetic verified parent-tier row for (parent, keyword).

    Returns the row. Used to pre-populate the index slot before re-promoting.
    Marked TEST: for cleanup.
    """
    row = LimsAnalysis(
        lims_sample_pk=parent_sample_pk,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title="TEST: parent-tier " + (svc.title or svc.keyword),
        review_state="verified",
        result_value="98.55",
        retest_of_id=None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ─── T2-1: retest-source promote supersedes old parent row ───────────────────


def test_retest_source_promote_supersedes_old_parent_row(
    db, parent_sample, analysis_service
):
    """A retest-source promotion retracts the prior active parent-tier row in
    the same transaction and inserts the new one — no IntegrityError."""
    sub = _find_free_sub_sample(db, parent_sample, analysis_service)
    if sub is None:
        pytest.skip("no free sub-sample under parent for retest-source promote test")

    # Pre-populate an active parent-tier row for this (parent, keyword)
    old_parent = _seed_parent_tier_row(db, parent_sample.id, analysis_service)
    old_parent_id = old_parent.id
    assert old_parent.review_state == "verified"

    # Create a vial row, walk it to to_be_verified, then retest → new_row
    vial = _walk_to_tbv(db, sub, analysis_service)
    new_vial = apply_transition(db, analysis_id=vial.id, kind="retest",
                                reason="TEST: retest for supersession test")
    new_vial.title = "TEST: retest-" + (new_vial.title or "")
    db.commit()

    # Walk the new vial to to_be_verified so it can be promoted
    apply_transition(db, analysis_id=new_vial.id, kind="assign",
                     reason="TEST: assign retest vial")
    apply_transition(db, analysis_id=new_vial.id, kind="submit",
                     result_value="99.00", reason="TEST: submit retest vial")
    new_vial_tbv = get_analysis(db, new_vial.id)
    assert new_vial_tbv.review_state == "to_be_verified"
    assert new_vial_tbv.retest_of_id is not None  # IS a retest row

    # Promote the retest vial — must supersede old_parent, not 409
    new_parent, promotions = promote_to_parent(
        db,
        keyword=analysis_service.keyword,
        result_value="99.00",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[{"analysis_id": new_vial_tbv.id, "contribution_kind": "chosen"}],
        user_id=None,
        reason="TEST: retest supersession",
        commit=True,
    )

    # New parent row is verified
    assert new_parent.review_state == "verified"
    assert new_parent.id != old_parent_id
    new_parent.title = "TEST: parent-" + (new_parent.title or "")
    db.commit()

    # Old parent row is now retracted
    db.expire(old_parent)
    db.refresh(old_parent)
    assert old_parent.review_state == "retracted"

    # Audit row written on old parent with the supersession reason
    audit = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == old_parent_id,
            LimsAnalysisTransition.reason == "superseded by retest promotion",
        )
    ).scalars().first()
    assert audit is not None
    assert audit.to_state == "retracted"


# ─── T2-2: non-retest second promote still raises IntegrityError ─────────────


def test_non_retest_second_promote_raises_integrity_error(
    db, parent_sample, analysis_service
):
    """Re-promoting a non-retest source against an existing parent-tier row
    still hits the partial unique index → IntegrityError (no supersession)."""
    sub = _find_free_sub_sample(db, parent_sample, analysis_service)
    if sub is None:
        pytest.skip("no free sub-sample for double-promote test")

    # Find a second free sub-sample for the second promote attempt
    sub2 = None
    subs = db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent_sample.id)
    ).scalars().all()
    for candidate in subs:
        if candidate.id == sub.id:
            continue
        existing = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sub_sample_pk == candidate.id,
                LimsAnalysis.keyword == analysis_service.keyword,
                LimsAnalysis.retest_of_id.is_(None),
            )
        ).scalars().first()
        if existing is None:
            sub2 = candidate
            break
    if sub2 is None:
        pytest.skip("need 2 free sub-samples under parent for double-promote test")

    # First promote: vial from sub (non-retest source)
    vial1 = _walk_to_tbv(db, sub, analysis_service)
    parent_row, _ = promote_to_parent(
        db,
        keyword=analysis_service.keyword,
        result_value="98.55",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[{"analysis_id": vial1.id, "contribution_kind": "chosen"}],
        user_id=None,
        reason="TEST: first promote",
        commit=True,
    )
    parent_row.title = "TEST: parent-" + (parent_row.title or "")
    db.commit()

    # Second promote: vial from sub2 (also non-retest source) — must IntegrityError
    vial2 = _walk_to_tbv(db, sub2, analysis_service)
    with pytest.raises(IntegrityError):
        promote_to_parent(
            db,
            keyword=analysis_service.keyword,
            result_value="99.00",
            result_unit=None,
            method_id=None,
            instrument_id=None,
            sources=[{"analysis_id": vial2.id, "contribution_kind": "chosen"}],
            user_id=None,
            reason="TEST: second promote should 409",
            commit=True,
        )

    # Rollback the failed transaction so subsequent tests can still use the session
    db.rollback()


# ─── T2-3: supersession respects commit=False path ───────────────────────────


def test_retest_supersession_respects_commit_false(
    db, parent_sample, analysis_service
):
    """With commit=False, the supersession flush happens but the whole
    transaction is uncommitted. After rollback(), the old parent row is
    still active (not retracted)."""
    sub = _find_free_sub_sample(db, parent_sample, analysis_service)
    if sub is None:
        pytest.skip("no free sub-sample for commit=False supersession test")

    # Pre-populate an active parent-tier row
    old_parent = _seed_parent_tier_row(db, parent_sample.id, analysis_service)
    old_parent_id = old_parent.id

    # Create a retest vial and walk it to to_be_verified
    vial = _walk_to_tbv(db, sub, analysis_service)
    new_vial = apply_transition(db, analysis_id=vial.id, kind="retest",
                                reason="TEST: retest for commit=False test")
    new_vial.title = "TEST: retest-" + (new_vial.title or "")
    db.commit()

    apply_transition(db, analysis_id=new_vial.id, kind="assign",
                     reason="TEST: assign")
    apply_transition(db, analysis_id=new_vial.id, kind="submit",
                     result_value="99.00", reason="TEST: submit")
    new_vial_tbv = get_analysis(db, new_vial.id)
    assert new_vial_tbv.retest_of_id is not None

    # Promote with commit=False — supersession flush runs but nothing committed
    promote_to_parent(
        db,
        keyword=analysis_service.keyword,
        result_value="99.00",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[{"analysis_id": new_vial_tbv.id, "contribution_kind": "chosen"}],
        user_id=None,
        reason="TEST: commit=False supersession",
        commit=False,
    )

    # Rollback — everything in the transaction is discarded
    db.rollback()

    # Old parent row must still be active (not retracted)
    db.expire(old_parent)
    db.refresh(old_parent)
    assert old_parent.review_state == "verified", (
        f"Expected verified after rollback, got {old_parent.review_state!r}"
    )
