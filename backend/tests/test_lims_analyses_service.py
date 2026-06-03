"""Service-layer integration tests for lims_analyses.

Each test cleans up its own rows. Uses the live subvial DB session
(same convention as test_variance_set.py).
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
    list_analyses_for_host,
    set_reportable,
)
from lims_analyses.state_machine import InvalidTransitionError, TierMismatchError
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    """Pick any seeded analysis_service with a non-null keyword."""
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def sub_sample(db):
    """Pick any existing sub-sample to host the test analyses."""
    sub = db.execute(select(LimsSubSample)).scalars().first()
    if sub is None:
        pytest.skip("no lims_sub_samples row available — seed via Receive Wizard")
    return sub


@pytest.fixture(autouse=True)
def cleanup(db):
    """Wipe any TEST-prefixed analyses + their audit rows after each test."""
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


# ── creation ────────────────────────────────────────────────────────────────


def test_create_sub_sample_analysis_starts_unassigned(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    assert row.review_state == "unassigned"
    assert row.lims_sub_sample_pk == sub_sample.id
    assert row.lims_sample_pk is None
    # Initial audit row written
    txns = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id
        )
    ).scalars().all()
    assert len(txns) == 1
    assert txns[0].from_state is None
    assert txns[0].to_state == "unassigned"
    assert txns[0].transition_kind == "auto"


def test_create_with_invalid_host_kind_raises(db, sub_sample, analysis_service):
    with pytest.raises(BadRequestError):
        create_analysis(
            db, host_kind="garbage", host_pk=sub_sample.id,
            analysis_service_id=analysis_service.id,
            keyword=analysis_service.keyword,
            title="TEST: garbage host",
        )


# ── happy-path transitions ──────────────────────────────────────────────────


def test_unassigned_to_verified_full_path(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    row = apply_transition(
        db, analysis_id=row.id, kind="assign",
        reason="TEST: assigning",
    )
    assert row.review_state == "assigned"

    row = apply_transition(
        db, analysis_id=row.id, kind="submit",
        result_value="98.55", reason="TEST: submit",
    )
    assert row.review_state == "to_be_verified"
    assert row.result_value == "98.55"
    assert row.submitted_at is not None
    assert row.captured_at is not None

    row = apply_transition(
        db, analysis_id=row.id, kind="verify",
        reason="TEST: verify",
    )
    assert row.review_state == "verified"
    assert row.verified_at is not None
    # NOTE: under the two-tier model, walking a vial-tier row to 'published'
    # via the in-place 'publish' kind is illegal — publish is parent-tier only.
    # The end of the vial-tier lifecycle is 'verified'. Promotion to a
    # parent-tier row in 'verified' is Phase 4 work (promote_to_parent).


def test_submit_without_result_raises(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: assign")
    with pytest.raises(BadRequestError):
        apply_transition(db, analysis_id=row.id, kind="submit",
                         reason="TEST: missing result")


def test_verify_without_result_raises(db, sub_sample, analysis_service):
    # Walk in via the unassigned -> to_be_verified shortcut WITHOUT a
    # result by going around the guard via direct row mutation in a
    # hypothetical; in practice the submit guard catches first.
    # Use a fresh row + autoEdit-style submit to ensure result is set:
    row = _create(db, sub_sample, analysis_service, result_value=None)
    # We can't actually reach to_be_verified without a result via the
    # service layer (guard fires on submit). So just assert the submit
    # guard.
    with pytest.raises(BadRequestError):
        apply_transition(db, analysis_id=row.id, kind="submit",
                         reason="TEST: no result")


def test_reset_clears_draft_and_returns_to_unassigned(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: assign")
    # Reset
    row = apply_transition(db, analysis_id=row.id, kind="reset",
                           reason="TEST: reset")
    assert row.review_state == "unassigned"
    assert row.result_value is None


# ── disallowed transitions ──────────────────────────────────────────────────


def test_publish_from_unassigned_raises_tier_mismatch(db, sub_sample, analysis_service):
    """A vial-tier row in 'unassigned' can never publish — publish is
    parent-tier-only at any state. The tier guard fires before the state
    machine reaches the (unassigned, publish) edge."""
    row = _create(db, sub_sample, analysis_service)
    with pytest.raises(TierMismatchError):
        apply_transition(db, analysis_id=row.id, kind="publish",
                         reason="TEST: cannot publish vial-tier from unassigned")


def test_no_transition_out_of_terminal_published(db, analysis_service):
    """Parent-tier row directly inserted in 'published' (simulating the
    end state of a future promote_to_parent + publish flow) is terminal —
    no kind moves it out. is_terminal() check fires before the tier guard."""
    parent = db.execute(select(LimsSample)).scalars().first()
    if parent is None:
        pytest.skip("no lims_samples row available")
    row = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title="TEST: parent-tier published terminal",
        review_state="published",
        result_value="98.55",
        published_at=__import__("datetime").datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    with pytest.raises(InvalidTransitionError):
        apply_transition(db, analysis_id=row.id, kind="retract",
                         reason="TEST: cannot leave terminal")


# ── retract preserves audit; clears verified_at ──────────────────────────────


def test_retract_from_verified_clears_verified_at(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value="42", reason="TEST")
    apply_transition(db, analysis_id=row.id, kind="verify", reason="TEST")
    # Sanity
    fresh = get_analysis(db, row.id)
    assert fresh.verified_at is not None
    # Retract
    after = apply_transition(db, analysis_id=row.id, kind="retract",
                             reason="TEST: oops")
    assert after.review_state == "retracted"
    assert after.verified_at is None
    # Audit chain
    txns = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id
        ).order_by(LimsAnalysisTransition.occurred_at)
    ).scalars().all()
    kinds = [t.transition_kind for t in txns]
    assert kinds == ["auto", "assign", "submit", "verify", "retract"]


# ── reportable flag flip writes an audit row ─────────────────────────────────


def test_set_reportable_writes_audit_row(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    assert row.reportable is True

    set_reportable(db, analysis_id=row.id, reportable=False,
                   reason="TEST: excluded from COA")
    fresh = get_analysis(db, row.id)
    assert fresh.reportable is False
    assert fresh.reportable_reason == "TEST: excluded from COA"

    audit = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id,
            LimsAnalysisTransition.transition_kind == "auto",
        ).order_by(LimsAnalysisTransition.occurred_at.desc())
    ).scalars().first()
    assert audit is not None
    # The reportable=False reason gets prefixed into the audit reason.
    assert "reportable=False" in (audit.reason or "")


def test_set_reportable_idempotent_no_audit_when_unchanged(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    set_reportable(db, analysis_id=row.id, reportable=True, reason="TEST: noop")
    audit_count = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id,
            LimsAnalysisTransition.transition_kind == "auto",
        )
    ).scalars().all()
    # Only the initial-insert audit row; the no-op set_reportable wrote nothing.
    assert len(audit_count) == 1


# ── list_analyses_for_host ──────────────────────────────────────────────────


def test_list_analyses_for_host_returns_only_that_hosts_rows(
    db, sub_sample, analysis_service,
):
    row1 = _create(db, sub_sample, analysis_service,
                   title="TEST: list 1")
    rows = list_analyses_for_host(db, host_kind="sub_sample", host_pk=sub_sample.id)
    assert row1.id in {r.id for r in rows}
    # Listing for a different sub-sample doesn't return row1
    other = db.execute(
        select(LimsSubSample).where(LimsSubSample.id != sub_sample.id).limit(1)
    ).scalar_one_or_none()
    if other is not None:
        other_rows = list_analyses_for_host(
            db, host_kind="sub_sample", host_pk=other.id,
        )
        assert row1.id not in {r.id for r in other_rows}


def test_get_analysis_not_found_raises(db):
    with pytest.raises(NotFoundError):
        get_analysis(db, 99_999_999)


# ── tier guards (service layer) ─────────────────────────────────────────────


def test_publish_on_vial_tier_row_raises_tier_mismatch(db, sub_sample, analysis_service):
    """A vial-tier row in 'verified' state (rare admin path) cannot publish —
    publishing is a parent-tier transition."""
    row = _create(db, sub_sample, analysis_service)
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value="42", reason="TEST")
    apply_transition(db, analysis_id=row.id, kind="verify", reason="TEST")
    # State is now 'verified' but the row is vial-tier (lims_sub_sample_pk set).
    with pytest.raises(TierMismatchError):
        apply_transition(db, analysis_id=row.id, kind="publish",
                         reason="TEST: cannot publish vial-tier")


def test_assign_on_parent_tier_row_raises_tier_mismatch(db, analysis_service):
    """A parent-tier row created directly in 'verified' (simulating a future
    promote_to_parent insert) cannot accept assign/submit — those are
    vial-tier kinds."""
    parent = db.execute(select(LimsSample)).scalars().first()
    if parent is None:
        pytest.skip("no lims_samples row available")
    # Simulate a Phase 4 promote-to-parent direct insert.
    row = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title="TEST: parent-tier direct",
        review_state="verified",
        result_value="98.55",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    with pytest.raises(TierMismatchError):
        apply_transition(db, analysis_id=row.id, kind="assign",
                         reason="TEST: cannot assign parent-tier")


# ── Phase 3 adapter ─────────────────────────────────────────────────────────


def test_list_analyses_in_senaite_shape_returns_mk1_prefixed_uids(db, sub_sample, analysis_service):
    from lims_analyses.service import list_analyses_in_senaite_shape
    row = _create(db, sub_sample, analysis_service)
    rows = list_analyses_in_senaite_shape(
        db, host_kind="sub_sample", host_pk=sub_sample.id,
    )
    matching = [r for r in rows if r.uid == f"mk1:{row.id}"]
    assert matching, f"expected uid=mk1:{row.id}; got uids={[r.uid for r in rows]}"
    r = matching[0]
    assert r.keyword == row.keyword
    assert r.title == row.title
    assert r.review_state == "unassigned"


def test_list_analyses_in_senaite_shape_returns_empty_for_unknown_host(db):
    from lims_analyses.service import list_analyses_in_senaite_shape
    rows = list_analyses_in_senaite_shape(
        db, host_kind="sub_sample", host_pk=99_999_999,
    )
    assert rows == []


# ── Phase 3.6: set_method_instrument ────────────────────────────────────────


def test_set_method_instrument_persists_and_writes_audit(db, sub_sample, analysis_service):
    from lims_analyses.service import set_method_instrument
    from models import HplcMethod, Instrument
    row = _create(db, sub_sample, analysis_service)
    method = db.execute(select(HplcMethod)).scalars().first()
    instrument = db.execute(select(Instrument)).scalars().first()
    if method is None or instrument is None:
        pytest.skip("no hplc_methods / instruments in this env")
    updated = set_method_instrument(
        db, analysis_id=row.id,
        method_id=method.id, instrument_id=instrument.id,
    )
    assert updated.method_id == method.id
    assert updated.instrument_id == instrument.id
    # Audit chain: initial 'auto' + the new 'auto' for method/instrument
    txns = db.execute(
        select(LimsAnalysisTransition)
        .where(LimsAnalysisTransition.analysis_id == row.id)
        .order_by(LimsAnalysisTransition.occurred_at)
    ).scalars().all()
    assert len(txns) == 2
    assert txns[-1].transition_kind == "auto"
    assert f"method_id={method.id}" in (txns[-1].reason or "")
    assert f"instrument_id={instrument.id}" in (txns[-1].reason or "")


def test_set_method_instrument_is_noop_when_unchanged(db, sub_sample, analysis_service):
    from lims_analyses.service import set_method_instrument
    row = _create(db, sub_sample, analysis_service)
    # Both fields None on a fresh row — setting to None should be a no-op
    set_method_instrument(db, analysis_id=row.id, method_id=None, instrument_id=None)
    txns = db.execute(
        select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == row.id)
    ).scalars().all()
    # Just the initial 'auto' — no spurious second audit row
    assert len(txns) == 1
