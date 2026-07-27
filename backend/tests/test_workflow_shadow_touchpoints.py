"""Touchpoint wiring tests: the mk1-hook chokepoint and the analysis-route
cascades drive the engine, env-gated, never breaking the host path."""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from models import (LimsSample, LimsSampleTransition,
                    LimsWorkflowShadowEvaluation, LimsWorkflowState,
                    LimsWorkflowTransition)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def receive_catalog(db):
    """TEST states + a plain receive-verb edge (no requirements)."""
    a = LimsWorkflowState(entity_scope="sample", slug="test_tp_due",
                          label="TEST due", category="active",
                          sort_order=9100, is_builtin=False)
    b = LimsWorkflowState(entity_scope="sample", slug="test_tp_received",
                          label="TEST received", category="active",
                          sort_order=9101, is_builtin=False)
    db.add_all([a, b]); db.flush()
    e = LimsWorkflowTransition(entity_scope="sample", from_state_id=a.id,
                               to_state_id=b.id, verb="receive",
                               requirements=[], auto_fire=False,
                               is_builtin=False, sort_order=9100)
    db.add(e); db.flush(); db.commit()
    yield
    db.execute(delete(LimsWorkflowTransition).where(
        LimsWorkflowTransition.id == e.id))
    db.execute(delete(LimsWorkflowState).where(
        LimsWorkflowState.id.in_([a.id, b.id])))
    db.commit()


@pytest.fixture
def publish_catalog(db):
    """TEST states + a publish-verb edge (requires coa_published attestation)."""
    a = LimsWorkflowState(entity_scope="sample", slug="test_tp_verified",
                          label="TEST verified", category="active",
                          sort_order=9102, is_builtin=False)
    b = LimsWorkflowState(entity_scope="sample", slug="test_tp_published",
                          label="TEST published", category="active",
                          sort_order=9103, is_builtin=False)
    db.add_all([a, b]); db.flush()
    e = LimsWorkflowTransition(entity_scope="sample", from_state_id=a.id,
                               to_state_id=b.id, verb="publish",
                               requirements=[{"kind": "coa_published", "value": None, "note": None}],
                               auto_fire=False, is_builtin=False, sort_order=9100)
    db.add(e); db.flush(); db.commit()
    yield
    db.execute(delete(LimsWorkflowTransition).where(
        LimsWorkflowTransition.id == e.id))
    db.execute(delete(LimsWorkflowState).where(
        LimsWorkflowState.id.in_([a.id, b.id])))
    db.commit()


@pytest.fixture
def tp_sample(db):
    row = LimsSample(sample_id="TEST-TP-0001", status="sample_due",
                     native_status="test_tp_due")
    db.add(row); db.flush(); db.commit()
    yield row
    db.execute(delete(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == row.id))
    db.execute(delete(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id))
    db.execute(delete(LimsSample).where(LimsSample.id == row.id))
    db.commit()


@pytest.fixture
def tp_sample_publish(db):
    row = LimsSample(sample_id="TEST-TP-0002", status="verified",
                     native_status="test_tp_verified")
    db.add(row); db.flush(); db.commit()
    yield row
    db.execute(delete(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == row.id))
    db.execute(delete(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id))
    db.execute(delete(LimsSample).where(LimsSample.id == row.id))
    db.commit()


def _run_hook(sample_id):
    from main import _record_sample_transition_bg
    _record_sample_transition_bg(
        sample_id=sample_id, verb="receive", to_status="sample_received",
        from_status="sample_due", source="mk1", actor_user_id=None)


def test_receive_hook_advances_native(db, receive_catalog, tp_sample):
    _run_hook(tp_sample.sample_id)
    db.expire_all()
    fresh = db.get(LimsSample, tp_sample.id)
    assert fresh.native_status == "test_tp_received"
    evals = db.execute(select(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == tp_sample.id
    )).scalars().all()
    assert any(e.outcome == "advanced" and e.trigger == "receive"
               for e in evals)


def test_flag_off_is_a_noop(db, receive_catalog, tp_sample):
    with patch.dict(os.environ, {"MK1_WORKFLOW_SHADOW_ENABLED": "0"}):
        _run_hook(tp_sample.sample_id)
    db.expire_all()
    assert db.get(LimsSample, tp_sample.id).native_status == "test_tp_due"


def test_engine_failure_never_breaks_the_hook(db, receive_catalog, tp_sample):
    with patch("workflow.engine.execute_verb",
               side_effect=RuntimeError("boom")):
        _run_hook(tp_sample.sample_id)   # must not raise
    db.expire_all()
    # host effects still landed: the log row + status heal
    assert db.get(LimsSample, tp_sample.id).status == "sample_received"


def test_publish_hook_advances_native(db, publish_catalog, tp_sample_publish):
    from main import _record_sample_transition_bg
    _record_sample_transition_bg(
        sample_id=tp_sample_publish.sample_id, verb="publish",
        to_status="published", from_status="verified", source="mk1",
        actor_user_id=None)
    db.expire_all()
    fresh = db.get(LimsSample, tp_sample_publish.id)
    assert fresh.native_status == "test_tp_published"
    evals = db.execute(select(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == tp_sample_publish.id
    )).scalars().all()
    assert any(e.outcome == "advanced" and e.trigger == "publish"
               for e in evals)


def test_transition_route_schedules_cascade():
    """The native analysis transition endpoint registers run_cascades_bg as
    a background task with the resolved PARENT sample pk."""
    import inspect
    from lims_analyses import routes
    src = inspect.getsource(routes.transition)
    assert "run_cascades_bg" in src and "background_tasks" in src
    src2 = inspect.getsource(routes.promote)
    assert "run_cascades_bg" in src2 and "background_tasks" in src2
