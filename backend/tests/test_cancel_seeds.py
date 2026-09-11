from sqlalchemy import select

from models import LimsWorkflowState, LimsWorkflowTransition


def _edges(db, verb):
    S = LimsWorkflowState
    rows = db.execute(
        select(LimsWorkflowTransition).where(LimsWorkflowTransition.entity_scope == "sample",
                                             LimsWorkflowTransition.verb == verb)
    ).scalars().all()
    by_id = {s.id: s.slug for s in db.execute(select(S).where(S.entity_scope == "sample")).scalars()}
    return {(by_id[t.from_state_id], by_id[t.to_state_id]): t for t in rows}


def test_cancel_edges_from_every_state(db_session):
    from workflow.seeds import SEED_STATES, seed_workflow_catalog
    seed_workflow_catalog(db_session)
    edges = _edges(db_session, "cancel")
    expected = {slug for (scope, slug, *_r) in SEED_STATES if scope == "sample"} - {"cancelled"}
    assert {frm for (frm, to) in edges} == expected
    assert all(to == "cancelled" and not t.auto_fire and t.requirements == [] for (frm, to), t in edges.items())


def test_partial_publish_pathway(db_session):
    from workflow.seeds import seed_workflow_catalog
    seed_workflow_catalog(db_session)
    pub = _edges(db_session, "publish")
    assert ("sample_received", "waiting_for_addon_results") in pub
    t = pub[("sample_received", "waiting_for_addon_results")]
    assert not t.auto_fire
    assert t.requirements == [{"kind": "coa_published", "value": None,
                               "note": "attested by the publish touchpoint"}]
    # the two pre-existing publish edges are untouched
    assert ("verified", "published") in pub and ("waiting_for_addon_results", "published") in pub
    sub = _edges(db_session, "submit")
    assert ("waiting_for_addon_results", "to_be_verified") in sub
    assert sub[("waiting_for_addon_results", "to_be_verified")].requirements == \
        sub[("sample_received", "to_be_verified")].requirements


def test_seed_is_idempotent(db_session):
    from workflow.seeds import seed_workflow_catalog
    seed_workflow_catalog(db_session)
    n1 = len(_edges(db_session, "cancel"))
    seed_workflow_catalog(db_session)
    assert len(_edges(db_session, "cancel")) == n1
