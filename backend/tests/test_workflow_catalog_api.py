"""API tests for the workflow catalog CRUD + graph (slice 3, Task 2).

House pattern: TestClient(main.app) with `require_admin` dependency-overridden
(see test_registry_debug_endpoint.py / test_parent_mirror_hooks.py). The
non-admin test overrides `get_current_user` with a standard-role user and
leaves the REAL `require_admin` in place, proving the 403 gate.

Live dev DB, TEST-prefixed rows (`test_wf_` slugs, `TEST-WF-` sample_ids),
FK-safe cleanup (transitions before states). Seeded builtin rows are never
deleted; the deactivate test flips is_active on one builtin and cleanup
restores it.
"""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import main
from auth import get_current_user, require_admin
from database import SessionLocal
from models import (AnalysisService, LimsAnalysis, LimsSample,
                    LimsWorkflowState, LimsWorkflowTransition)
from workflow.seeds import seed_workflow_catalog

SLUG_PREFIX = "test_wf_"
SAMPLE_PREFIX = "TEST-WF-"


# ── fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="module", autouse=True)
def _ensure_seeds():
    """Idempotent — guarantees the builtin catalog exists in this DB."""
    s = SessionLocal()
    try:
        seed_workflow_catalog(s)
        s.commit()
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _cleanup():
    """FK-safe TEST-row cleanup: transitions before states, then samples
    (lims_analyses ride the DB-level ON DELETE CASCADE). Also restores the
    builtin the deactivate test flips."""
    yield
    s = SessionLocal()
    try:
        state_ids = [i for (i,) in s.query(LimsWorkflowState.id)
                     .filter(LimsWorkflowState.slug.like(f"{SLUG_PREFIX}%"))]
        if state_ids:
            (s.query(LimsWorkflowTransition)
             .filter((LimsWorkflowTransition.from_state_id.in_(state_ids)) |
                     (LimsWorkflowTransition.to_state_id.in_(state_ids)))
             .delete(synchronize_session=False))
        (s.query(LimsWorkflowTransition)
         .filter(LimsWorkflowTransition.verb.like(f"{SLUG_PREFIX}%"))
         .delete(synchronize_session=False))
        (s.query(LimsWorkflowState)
         .filter(LimsWorkflowState.slug.like(f"{SLUG_PREFIX}%"))
         .delete(synchronize_session=False))
        (s.query(LimsSample)
         .filter(LimsSample.sample_id.like(f"{SAMPLE_PREFIX}%"))
         .delete(synchronize_session=False))
        (s.query(LimsWorkflowState)
         .filter_by(entity_scope="sample", slug="dispatched", is_builtin=True)
         .update({"is_active": True}))
        s.commit()
    finally:
        s.close()


@pytest.fixture
def client():
    """Overrides BOTH gates: the router-level get_current_user (any
    authenticated user, gates GET /graph) and require_admin (gates every
    mutation). An admin satisfies both."""
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
    """Only get_current_user is overridden (with a standard-role user) — the
    REAL require_admin gate runs on top of it (require_admin itself depends
    on get_current_user, so it sees the overridden standard user and 403s).
    This proves: GET /graph succeeds (get_current_user gate only), mutations
    403 (require_admin gate)."""
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[get_current_user] = (
        lambda: SimpleNamespace(id=42, role="standard", email="t@test"))
    tc = TestClient(main.app)
    yield tc
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(prev)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


# ── helpers ──────────────────────────────────────────────────────────────

def _mk_state(client, slug, scope="sample", **kw):
    body = {"entity_scope": scope, "slug": slug, "label": kw.pop("label", slug)}
    body.update(kw)
    r = client.post("/api/workflow/states", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _mk_transition(client, from_id, to_id, verb, **kw):
    body = {"from_state_id": from_id, "to_state_id": to_id, "verb": verb}
    body.update(kw)
    return client.post("/api/workflow/transitions", json=body)


def _builtin(db, scope, slug):
    return (db.query(LimsWorkflowState)
            .filter_by(entity_scope=scope, slug=slug, is_builtin=True).one())


# ── graph payload ────────────────────────────────────────────────────────

def test_graph_payload_shape(client, db):
    r = client.get("/api/workflow/graph", params={"scope": "sample"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "sample"
    slugs = {s["slug"] for s in body["states"]}
    assert {"sample_due", "sample_received", "published"} <= slugs
    for st in body["states"]:
        for key in ("id", "slug", "label", "description", "category", "color",
                    "sort_order", "is_builtin", "is_active", "usage_count"):
            assert key in st, f"state missing {key}"
        assert isinstance(st["usage_count"], int)
    assert body["transitions"], "seeded sample transitions expected"
    for tr in body["transitions"]:
        for key in ("id", "from_state_id", "to_state_id", "verb", "label",
                    "description", "requirements", "is_builtin", "is_active"):
            assert key in tr, f"transition missing {key}"


def test_graph_invalid_scope_422(client):
    r = client.get("/api/workflow/graph", params={"scope": "frobnicate"})
    assert r.status_code == 422


def test_graph_usage_count_counts_live_sample_rows(client, db):
    _mk_state(client, "test_wf_counted")
    db.add(LimsSample(sample_id=f"{SAMPLE_PREFIX}COUNTED-1",
                      status="test_wf_counted"))
    db.commit()
    body = client.get("/api/workflow/graph", params={"scope": "sample"}).json()
    counted = next(s for s in body["states"] if s["slug"] == "test_wf_counted")
    assert counted["usage_count"] == 1


def test_analysis_usage_counts_canonical_plus_shadow(client, db):
    """Analysis-scope rule: canonical rows by review_state PLUS shadow rows
    by mirror_review_state, summed per slug."""
    svc = db.query(AnalysisService).first()
    if svc is None:
        pytest.skip("no AnalysisService seed in this DB")

    def _verified_count():
        body = client.get("/api/workflow/graph",
                          params={"scope": "analysis"}).json()
        return next(s for s in body["states"]
                    if s["slug"] == "verified")["usage_count"]

    before = _verified_count()
    sample = LimsSample(sample_id=f"{SAMPLE_PREFIX}USAGE-1")
    db.add(sample)
    db.flush()
    db.add(LimsAnalysis(lims_sample_pk=sample.id, analysis_service_id=svc.id,
                        keyword="test_wf_kw", title="TEST canonical",
                        provenance="canonical", review_state="verified"))
    db.add(LimsAnalysis(lims_sample_pk=sample.id, analysis_service_id=svc.id,
                        keyword="test_wf_kw", title="TEST shadow",
                        provenance="shadow", review_state="senaite_mirror",
                        mirror_review_state="verified"))
    db.commit()
    assert _verified_count() == before + 2


# ── create ───────────────────────────────────────────────────────────────

def test_create_state_and_transition(client):
    st_a = _mk_state(client, "test_wf_alpha", label="Alpha")
    st_b = _mk_state(client, "test_wf_beta", label="Beta")
    assert st_a["slug"] == "test_wf_alpha"
    assert st_a["label"] == "Alpha"
    assert st_a["is_builtin"] is False

    r = _mk_transition(client, st_a["id"], st_b["id"], "test_wf_go")
    assert r.status_code == 200, r.text
    tr = r.json()
    assert tr["verb"] == "test_wf_go"
    assert tr["from_state_id"] == st_a["id"]
    assert tr["to_state_id"] == st_b["id"]
    assert tr["requirements"] == []
    assert tr["is_builtin"] is False


def test_duplicate_state_slug_409(client):
    _mk_state(client, "test_wf_dup")
    r = client.post("/api/workflow/states", json={
        "entity_scope": "sample", "slug": "test_wf_dup", "label": "again"})
    assert r.status_code == 409


def test_duplicate_transition_edge_409(client):
    a = _mk_state(client, "test_wf_edge_a")
    b = _mk_state(client, "test_wf_edge_b")
    assert _mk_transition(client, a["id"], b["id"], "test_wf_hop").status_code == 200
    r = _mk_transition(client, a["id"], b["id"], "test_wf_hop")
    assert r.status_code == 409


def test_cross_scope_edge_rejected(client):
    smp = _mk_state(client, "test_wf_scope_s", scope="sample")
    ana = _mk_state(client, "test_wf_scope_a", scope="analysis")
    r = _mk_transition(client, smp["id"], ana["id"], "test_wf_cross")
    assert r.status_code == 422
    assert "scope" in r.json()["detail"].lower()


def test_transition_missing_state_422(client):
    a = _mk_state(client, "test_wf_lonely")
    r = _mk_transition(client, a["id"], 999999999, "test_wf_nowhere")
    assert r.status_code == 422


# ── requirements validation ──────────────────────────────────────────────

def test_unknown_requirement_kind_rejected(client):
    a = _mk_state(client, "test_wf_req_a")
    b = _mk_state(client, "test_wf_req_b")
    r = _mk_transition(client, a["id"], b["id"], "test_wf_req",
                       requirements=[{"kind": "frobnicate", "value": "x"}])
    assert r.status_code == 422
    assert "frobnicate" in r.json()["detail"]


def test_requirement_missing_value_rejected(client):
    a = _mk_state(client, "test_wf_val_a")
    b = _mk_state(client, "test_wf_val_b")
    r = _mk_transition(client, a["id"], b["id"], "test_wf_val",
                       requirements=[{"kind": "field_present"}])
    assert r.status_code == 422


def test_requirements_cleaned_roundtrip(client):
    a = _mk_state(client, "test_wf_clean_a")
    b = _mk_state(client, "test_wf_clean_b")
    r = _mk_transition(
        client, a["id"], b["id"], "test_wf_clean",
        requirements=[
            {"kind": "manual", "note": "operator checks paperwork",
             "extra_junk": "dropped"},
            {"kind": "all_analyses_in_state", "value": "verified"},
        ])
    assert r.status_code == 200, r.text
    assert r.json()["requirements"] == [
        {"kind": "manual", "value": None, "note": "operator checks paperwork"},
        {"kind": "all_analyses_in_state", "value": "verified", "note": None},
    ]


# ── delete guardrails ────────────────────────────────────────────────────

def test_delete_builtin_409(client, db):
    builtin = _builtin(db, "sample", "cancelled")
    r = client.delete(f"/api/workflow/states/{builtin.id}")
    assert r.status_code == 409
    assert "deactivate" in r.json()["detail"].lower()


def test_delete_state_with_usage_409(client, db):
    st = _mk_state(client, "test_wf_used_state")
    db.add(LimsSample(sample_id=f"{SAMPLE_PREFIX}USED-1",
                      status="test_wf_used_state"))
    db.commit()
    r = client.delete(f"/api/workflow/states/{st['id']}")
    assert r.status_code == 409
    assert "deactivate" in r.json()["detail"].lower()


def test_delete_state_with_transition_ref_409(client):
    a = _mk_state(client, "test_wf_ref_a")
    b = _mk_state(client, "test_wf_ref_b")
    tr = _mk_transition(client, a["id"], b["id"], "test_wf_ref").json()
    r = client.delete(f"/api/workflow/states/{a['id']}")
    assert r.status_code == 409
    assert "deactivate" in r.json()["detail"].lower()
    # unblock: delete the edge, then the state deletes cleanly
    assert client.delete(f"/api/workflow/transitions/{tr['id']}").status_code == 204
    assert client.delete(f"/api/workflow/states/{a['id']}").status_code == 204


def test_delete_unused_custom_state_ok(client, db):
    st = _mk_state(client, "test_wf_disposable")
    r = client.delete(f"/api/workflow/states/{st['id']}")
    assert r.status_code == 204
    assert (db.query(LimsWorkflowState)
            .filter_by(entity_scope="sample", slug="test_wf_disposable")
            .one_or_none()) is None


def test_delete_builtin_transition_409(client, db):
    builtin = (db.query(LimsWorkflowTransition)
               .filter_by(entity_scope="sample", verb="receive",
                          is_builtin=True).first())
    assert builtin is not None, "seeded receive transition expected"
    r = client.delete(f"/api/workflow/transitions/{builtin.id}")
    assert r.status_code == 409
    assert "deactivate" in r.json()["detail"].lower()


def test_delete_missing_404(client):
    assert client.delete("/api/workflow/states/999999999").status_code == 404
    assert client.delete("/api/workflow/transitions/999999999").status_code == 404


# ── patch ────────────────────────────────────────────────────────────────

def test_deactivate_instead(client, db):
    builtin = _builtin(db, "sample", "dispatched")
    r = client.patch(f"/api/workflow/states/{builtin.id}",
                     json={"is_active": False})
    assert r.status_code == 200, r.text
    assert r.json()["is_active"] is False
    # restore (cleanup also restores as a belt-and-braces)
    r = client.patch(f"/api/workflow/states/{builtin.id}",
                     json={"is_active": True})
    assert r.status_code == 200 and r.json()["is_active"] is True


def test_patch_slug_and_scope_immutable(client):
    st = _mk_state(client, "test_wf_immutable")
    r = client.patch(f"/api/workflow/states/{st['id']}",
                     json={"slug": "evil_rename", "entity_scope": "analysis",
                           "label": "Renamed Label"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["slug"] == "test_wf_immutable"
    assert body["label"] == "Renamed Label"


def test_patch_transition_cross_scope_rejected(client, db):
    a = _mk_state(client, "test_wf_pt_a")
    b = _mk_state(client, "test_wf_pt_b")
    ana = _mk_state(client, "test_wf_pt_ana", scope="analysis")
    tr = _mk_transition(client, a["id"], b["id"], "test_wf_pt").json()
    r = client.patch(f"/api/workflow/transitions/{tr['id']}",
                     json={"to_state_id": ana["id"]})
    assert r.status_code == 422


def test_patch_transition_requirements_validated(client):
    a = _mk_state(client, "test_wf_pr_a")
    b = _mk_state(client, "test_wf_pr_b")
    tr = _mk_transition(client, a["id"], b["id"], "test_wf_pr").json()
    r = client.patch(f"/api/workflow/transitions/{tr['id']}",
                     json={"requirements": [{"kind": "bogus"}]})
    assert r.status_code == 422
    r = client.patch(
        f"/api/workflow/transitions/{tr['id']}",
        json={"requirements": [{"kind": "role_at_least", "value": "admin"}]})
    assert r.status_code == 200, r.text
    assert r.json()["requirements"] == [
        {"kind": "role_at_least", "value": "admin", "note": None}]


def test_patch_null_for_non_nullable_422(client):
    st = _mk_state(client, "test_wf_nullpatch")
    r = client.patch(f"/api/workflow/states/{st['id']}", json={"label": None})
    assert r.status_code == 422
    a = _mk_state(client, "test_wf_np_a")
    b = _mk_state(client, "test_wf_np_b")
    tr = _mk_transition(client, a["id"], b["id"], "test_wf_np").json()
    r = client.patch(f"/api/workflow/transitions/{tr['id']}",
                     json={"verb": None})
    assert r.status_code == 422


def test_patch_missing_404(client):
    assert client.patch("/api/workflow/states/999999999",
                        json={"label": "x"}).status_code == 404
    assert client.patch("/api/workflow/transitions/999999999",
                        json={"label": "x"}).status_code == 404


# ── auth gate ────────────────────────────────────────────────────────────

def test_graph_readable_by_non_admin(client_non_admin):
    """GET /graph is the designed read-only view for every authenticated
    user (nav item is visible to all) — it exposes only catalog + usage
    counts, no secrets, so it sits behind get_current_user, not
    require_admin."""
    r = client_non_admin.get("/api/workflow/graph", params={"scope": "sample"})
    assert r.status_code == 200, r.text
    assert r.json()["scope"] == "sample"


def test_requires_admin(client_non_admin):
    c = client_non_admin
    assert c.post("/api/workflow/states", json={
        "entity_scope": "sample", "slug": "test_wf_nope", "label": "n"}).status_code == 403
    assert c.patch("/api/workflow/states/1", json={"label": "n"}).status_code == 403
    assert c.delete("/api/workflow/states/1").status_code == 403
    assert c.post("/api/workflow/transitions", json={
        "from_state_id": 1, "to_state_id": 2, "verb": "test_wf_nope"}).status_code == 403
    assert c.patch("/api/workflow/transitions/1", json={"label": "n"}).status_code == 403
    assert c.delete("/api/workflow/transitions/1").status_code == 403


def test_requires_authentication():
    """No auth at all (neither require_admin nor get_current_user
    overridden) — the router-level get_current_user gate rejects with 401,
    including on the read-only graph route."""
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides.clear()
    try:
        c = TestClient(main.app)
        r = c.get("/api/workflow/graph", params={"scope": "sample"})
        assert r.status_code == 401
    finally:
        main.app.dependency_overrides.clear()
        main.app.dependency_overrides.update(prev)
