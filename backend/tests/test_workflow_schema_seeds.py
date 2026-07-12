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
