"""Schema + seed tests for the workflow state system (slice 3, Task 1)."""
from sqlalchemy import inspect, text
import pytest
from database import SessionLocal, engine
from models import (LimsWorkflowState, LimsWorkflowTransition,
                    LimsSampleTransition, LimsWorkflowSyncState)
from workflow.seeds import seed_workflow_catalog


@pytest.fixture()
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


def test_tables_exist():
    names = inspect(engine).get_table_names()
    for t in ("lims_workflow_states", "lims_workflow_transitions",
              "lims_sample_transitions", "lims_workflow_sync_state"):
        assert t in names


def test_transition_kind_check_accepts_observed(db):
    row = db.execute(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname='lims_analysis_transitions_transition_kind_check'"
    )).scalar()
    assert "observed" in (row or "")


def test_sample_transitions_source_check(db):
    row = db.execute(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname='lims_sample_transitions_source_check'")).scalar()
    for s in ("mk1", "senaite", "reconcile", "is_seed"):
        assert s in row


def test_seed_idempotent(db):
    first = seed_workflow_catalog(db)
    db.commit()
    again = seed_workflow_catalog(db)
    db.commit()
    assert again == {"states_created": 0, "transitions_created": 0}
    # spot-check content
    slugs = {s.slug for s in db.query(LimsWorkflowState)
             .filter(LimsWorkflowState.entity_scope == "sample")}
    assert {"sample_due", "sample_received", "published", "cancelled",
            "waiting_for_addon_results"} <= slugs
    sentinel = (db.query(LimsWorkflowState)
                .filter_by(entity_scope="analysis", slug="senaite_mirror").one())
    assert sentinel.is_active is False and sentinel.category == "exception"


def test_seed_requirements_shape(db):
    seed_workflow_catalog(db)
    db.commit()
    verify = (db.query(LimsWorkflowTransition)
              .join(LimsWorkflowState, LimsWorkflowTransition.to_state_id == LimsWorkflowState.id)
              .filter(LimsWorkflowTransition.entity_scope == "sample",
                      LimsWorkflowTransition.verb == "verify").one())
    assert verify.requirements == [
        {"kind": "all_analyses_in_state", "value": "verified", "note": None}]


def test_publish_edges_gate_on_verified_or_published():
    """Burn-in finding 2026-08-23 (mk1_refused bucket): the A6 publish hook
    flips shadow-mirrored analyses to 'published' before the sample-publish
    evaluation runs, so a strict 'verified' list refused real publishes.
    Both SEEDED publish edges must accept verified-or-published.

    Asserted on the SEED LIST (the fresh-DB half of the fresh-vs-existing
    split) — the shared dev DB carries pre-widen rows the seed never
    updates; the existing-DB half is the guarded boot UPDATE, exercised
    with effect-assertions in test_workflow_engine.py::
    test_sbs_boot_statements_execute_against_live_db."""
    from workflow.seeds import SEED_TRANSITIONS
    publish_edges = [t for t in SEED_TRANSITIONS
                     if t[0] == "sample" and t[3] == "publish"]
    assert len(publish_edges) == 2
    assert {t[1] for t in publish_edges} == {
        "verified", "waiting_for_addon_results"}
    for _scope, _frm, to, _verb, _auto, reqs, _desc in publish_edges:
        assert to == "published"
        gate = next(r for r in reqs if r["kind"] == "all_analyses_in_state")
        assert gate["value"] == "verified,published"
        assert any(r["kind"] == "coa_published" for r in reqs)


def test_waiting_for_addon_results_has_a_publish_edge(db):
    """Burn-in finding 2026-08-23 (stuck_behind bucket): the state was seeded
    with NO out-edges, stranding native_status on every real publish from
    it. Publishing once add-on results complete is a legal lab flow."""
    seed_workflow_catalog(db)
    db.commit()
    waiting = (db.query(LimsWorkflowState)
               .filter_by(entity_scope="sample",
                          slug="waiting_for_addon_results").one())
    published = (db.query(LimsWorkflowState)
                 .filter_by(entity_scope="sample", slug="published").one())
    edge = (db.query(LimsWorkflowTransition)
            .filter_by(entity_scope="sample", from_state_id=waiting.id,
                       verb="publish").one())
    assert edge.to_state_id == published.id
    assert edge.is_builtin
