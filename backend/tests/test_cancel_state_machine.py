import pytest

from lims_analyses.state_machine import (InvalidTransitionError, STATES, TIER_PARENT,
                                         TIER_VIAL, TRANSITION_KINDS, next_state, tier_allows)


@pytest.mark.parametrize("frm", ["unassigned", "assigned", "to_be_verified"])
def test_vial_pending_rows_cancel(frm):
    assert next_state(frm, "cancel", TIER_VIAL) == "cancelled"


def test_parent_to_verify_cancels():
    assert next_state("parent_to_verify", "cancel", TIER_PARENT) == "cancelled"


@pytest.mark.parametrize("frm", ["verified", "promoted", "variance_verified", "published"])
def test_finished_rows_never_cancel(frm):
    with pytest.raises(InvalidTransitionError):
        next_state(frm, "cancel", None)


def test_vocabulary():
    assert "cancel" in TRANSITION_KINDS and "cancelled" in STATES
    assert tier_allows(TIER_VIAL, "cancel") and tier_allows(TIER_PARENT, "cancel")


def test_apply_transition_cancel_audits(db_session):
    from lims_analyses.service import apply_transition
    from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample, LimsSubSample
    from sqlalchemy import select
    p = LimsSample(sample_id="P-CSM-1", status="sample_received")
    db_session.add(p)
    db_session.flush()
    v = LimsSubSample(sample_id="P-CSM-1-S01", parent_sample_pk=p.id, vial_sequence=1,
                      external_lims_uid="mk1://vial/csm-1")   # NOT NULL + unique
    db_session.add(v)
    svc = AnalysisService(keyword="K-CSM", title="t")
    db_session.add(svc)
    db_session.flush()
    a = LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=svc.id, keyword="K-CSM",
                     title="t", review_state="assigned", provenance="canonical", retested=False)
    db_session.add(a)
    db_session.flush()
    apply_transition(db_session, analysis_id=a.id, kind="cancel", reason="customer request",
                     user_id=None, commit=False)
    assert a.review_state == "cancelled"
    t = db_session.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == a.id)).scalar_one()
    assert (t.transition_kind, t.to_state, t.reason) == ("cancel", "cancelled", "customer request")
