"""Summary buckets + registry-inspect shadow block."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

import main
from auth import get_current_user, require_admin
from database import SessionLocal
from models import (LimsSample, LimsWorkflowShadowEvaluation,
                    LimsWorkflowState, LimsWorkflowTransition)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def cohort(db):
    rows = []
    def mk(sid, status, native, evals=()):
        r = LimsSample(sample_id=sid, status=status, native_status=native)
        db.add(r); db.flush()
        for outcome, verb in evals:
            db.add(LimsWorkflowShadowEvaluation(
                lims_sample_pk=r.id, trigger="publish", verb=verb,
                from_status=native, to_status=native, outcome=outcome,
                requirements_met=(outcome == "advanced"), outcomes=[]))
        db.flush()
        rows.append(r)
        return r
    mk("TEST-SUM-A", "verified", "verified")                       # agree
    mk("TEST-SUM-B", "published", "verified",
       evals=[("requirements_unmet", "publish")])                  # mk1_refused
    mk("TEST-SUM-C", "published", "verified",
       evals=[("no_edge", "publish")])                             # stuck_behind
    mk("TEST-SUM-D", "cancelled", "sample_received",
       evals=[("seeded", None)])                                   # no_native_pathway
    db.commit()
    yield rows
    for r in rows:
        db.execute(delete(LimsWorkflowShadowEvaluation).where(
            LimsWorkflowShadowEvaluation.lims_sample_pk == r.id))
        db.execute(delete(LimsSample).where(LimsSample.id == r.id))
    db.commit()


def test_summary_buckets(db, cohort):
    from workflow.routes import _shadow_summary_payload
    p = _shadow_summary_payload(db, since=None)
    by_id = {d["sample_id"]: d["bucket"] for d in p["divergent"]}
    assert by_id["TEST-SUM-B"] == "mk1_refused"
    assert by_id["TEST-SUM-C"] == "stuck_behind"
    assert by_id["TEST-SUM-D"] == "no_native_pathway"
    assert "TEST-SUM-A" not in by_id
    assert p["buckets"]["agree"] >= 1


# ── controller amendment: live-probe reclassification ──────────────────
#
# evaluate_cascades (Task 3) records NO refusal row for an auto_fire edge
# that simply never fired — cascade probing is speculative. A divergent
# sample whose auto-edge requirements are merely unmet therefore has no
# "requirements_unmet"/"no_edge" trajectory row to explain it, and would
# masquerade as a true no_native_pathway gap without the live probe.

@pytest.fixture
def sum_e_catalog(db):
    """Private TEST catalog: test_sum_e_a --test_sum_submit(auto_fire,
    needs all analyses verified)--> test_sum_e_b. No lines are ever added,
    so the edge is permanently unmet but never actually attempted."""
    states = {}
    for slug in ("test_sum_e_a", "test_sum_e_b"):
        s = LimsWorkflowState(entity_scope="sample", slug=slug,
                              label=f"TEST {slug}", category="active",
                              sort_order=9200, is_builtin=False)
        db.add(s)
        db.flush()
        states[slug] = s
    edge = LimsWorkflowTransition(
        entity_scope="sample", from_state_id=states["test_sum_e_a"].id,
        to_state_id=states["test_sum_e_b"].id, verb="test_sum_submit",
        requirements=[{"kind": "all_analyses_in_state", "value": "verified",
                       "note": None}],
        auto_fire=True, is_builtin=False, sort_order=9200)
    db.add(edge)
    db.flush()
    db.commit()
    yield states
    db.execute(delete(LimsWorkflowTransition).where(
        LimsWorkflowTransition.id == edge.id))
    db.execute(delete(LimsWorkflowState).where(
        LimsWorkflowState.slug.in_(["test_sum_e_a", "test_sum_e_b"])))
    db.commit()


@pytest.fixture
def sample_e(db, sum_e_catalog):
    """published/native test_sum_e_a, NO analyses (empty live-line set →
    fail-closed unmet per _eval_one), only a 'seeded' eval row — never a
    refusal attempt."""
    r = LimsSample(sample_id="TEST-SUM-E", status="published",
                   native_status="test_sum_e_a")
    db.add(r)
    db.flush()
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=r.id, trigger="seed", verb=None,
        from_status=None, to_status="test_sum_e_a",
        outcome="seeded", requirements_met=None, outcomes=[]))
    db.commit()
    yield r
    db.execute(delete(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == r.id))
    db.execute(delete(LimsSample).where(LimsSample.id == r.id))
    db.commit()


def test_summary_live_probe_reclassifies_unfired_auto_edge(db, sample_e):
    from workflow.routes import _shadow_summary_payload
    p = _shadow_summary_payload(db, since=None)
    by_id = {d["sample_id"]: d for d in p["divergent"]}
    assert by_id["TEST-SUM-E"]["bucket"] == "mk1_refused"
    assert by_id["TEST-SUM-E"]["latest_outcome"] == "live_probe_unmet"


# ── fix round 1: since-window bucket semantics are window-relative ──────
#
# A `since` cutoff that excludes a sample's real historical refusal doesn't
# make the refusal disappear from the payload's honesty — it makes the WHY
# get RE-DERIVED from current state, which can silently land a different
# (or no) reason than what actually blocked the sample. This pins that
# documented behavior rather than leaving it as an undocumented surprise.

@pytest.fixture
def window_state(db):
    """Private TEST state with ZERO outgoing transitions (no auto_fire
    edges at all) — isolated from the real catalog so the live probe has no
    candidate to find regardless of catalog changes elsewhere."""
    s = LimsWorkflowState(entity_scope="sample", slug="test_sum_f_window",
                          label="TEST window", category="active",
                          sort_order=9300, is_builtin=False)
    db.add(s)
    db.flush()
    db.commit()
    yield s
    db.execute(delete(LimsWorkflowState).where(LimsWorkflowState.id == s.id))
    db.commit()


@pytest.fixture
def sample_f(db, window_state):
    """The sample's ONLY shadow row is a real historical refusal
    (requirements_unmet), explicitly timestamped in the past. native_status
    has no outgoing edges, so a live probe run against it finds nothing."""
    r = LimsSample(sample_id="TEST-SUM-F", status="published",
                   native_status="test_sum_f_window")
    db.add(r)
    db.flush()
    db.add(LimsWorkflowShadowEvaluation(
        lims_sample_pk=r.id, trigger="publish", verb="publish",
        from_status="test_sum_f_window", to_status="test_sum_f_window",
        outcome="requirements_unmet", requirements_met=False, outcomes=[],
        evaluated_at=datetime(2026, 1, 1)))
    db.commit()
    yield r
    db.execute(delete(LimsWorkflowShadowEvaluation).where(
        LimsWorkflowShadowEvaluation.lims_sample_pk == r.id))
    db.execute(delete(LimsSample).where(LimsSample.id == r.id))
    db.commit()


def test_summary_since_window_is_relative_not_immutable_history(db, sample_f):
    from workflow.routes import _shadow_summary_payload
    # since=None sees the real historical refusal.
    full = _shadow_summary_payload(db, since=None)
    by_full = {d["sample_id"]: d for d in full["divergent"]}
    assert by_full["TEST-SUM-F"]["bucket"] == "mk1_refused"
    assert by_full["TEST-SUM-F"]["latest_outcome"] == "requirements_unmet"

    # since after the refusal excludes it; no auto edge exists to live-probe
    # from test_sum_f_window, so the bucket silently reclassifies —
    # pinning the documented window-relative semantics, not a bug.
    windowed = _shadow_summary_payload(db, since=datetime(2026, 6, 1))
    by_windowed = {d["sample_id"]: d for d in windowed["divergent"]}
    assert by_windowed["TEST-SUM-F"]["bucket"] == "no_native_pathway"


# ── route wiring: admin gate + since validation ─────────────────────────

@pytest.fixture
def client():
    prev = dict(main.app.dependency_overrides)
    admin = lambda: SimpleNamespace(id=1, role="admin", email="admin@test")
    main.app.dependency_overrides[get_current_user] = admin
    main.app.dependency_overrides[require_admin] = admin
    tc = TestClient(main.app)
    yield tc
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(prev)


@pytest.fixture
def client_non_admin():
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[get_current_user] = (
        lambda: SimpleNamespace(id=42, role="standard", email="t@test"))
    tc = TestClient(main.app)
    yield tc
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(prev)


def test_summary_requires_admin(client_non_admin):
    r = client_non_admin.get("/api/workflow/shadow/summary")
    assert r.status_code == 403


def test_summary_invalid_since_422(client):
    r = client.get("/api/workflow/shadow/summary",
                   params={"since": "not-a-date"})
    assert r.status_code == 422


def test_summary_endpoint_shape(client, cohort):
    r = client.get("/api/workflow/shadow/summary")
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("total_seeded", "buckets", "divergent"):
        assert key in body
    for key in ("agree", "mk1_refused", "no_native_pathway", "stuck_behind"):
        assert key in body["buckets"]


# ── registry-inspect side-by-side block (Task 8) ────────────────────────

def test_build_shadow_block(db, cohort):
    from main import _build_shadow_block
    refused = next(r for r in cohort if r.sample_id == "TEST-SUM-B")
    block = _build_shadow_block(db, refused)
    assert block["native_status"] == "verified"
    assert block["current_status"] == "published"
    assert block["in_sync"] is False
    assert block["latest"]["outcome"] == "requirements_unmet"

    agree = next(r for r in cohort if r.sample_id == "TEST-SUM-A")
    assert _build_shadow_block(db, agree)["in_sync"] is True


# Fix round 1: "shadow" must be a sibling of "transitions" on EVERY return
# path out of _build_registry_debug_response, not just the happy path —
# same independent-failure posture the "transitions" key already proves via
# test_registry_debug_transitions.py's test_transitions_none_when_row_missing
# / test_transitions_populated_on_senaite_meta_missing_path.

def test_shadow_key_present_when_row_missing(db):
    from main import _build_registry_debug_response
    out = _build_registry_debug_response(db, "TEST-SUM-NOPE")
    assert out["load"]["exists"] is False
    assert "shadow" in out
    assert out["shadow"] is None


def test_shadow_key_populated_on_senaite_meta_missing_path(db, cohort):
    """The `meta is None` early-return (senaite fetch_parent_metadata raised)
    must still carry a populated shadow block — same independent-failure
    posture the transitions section already proves for this path."""
    from main import _build_registry_debug_response
    agree = next(r for r in cohort if r.sample_id == "TEST-SUM-A")
    with patch.object(main.senaite, "fetch_parent_metadata", side_effect=RuntimeError("no AR")):
        out = _build_registry_debug_response(db, agree.sample_id)
    assert out["senaite_error"] is not None
    assert "shadow" in out
    assert isinstance(out["shadow"], dict)
    assert out["shadow"]["error"] is None
    assert out["shadow"]["in_sync"] is True
