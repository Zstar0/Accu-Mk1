import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import models  # noqa: F401  (register FlagType on Base)
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_mk1_entities()

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    types_service.seed_builtins(shared)

    def _db():
        yield shared
    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    tc.db = shared  # tests seed LIMS rows through the shared session
    yield tc
    app.dependency_overrides.pop(get_db, None) if prev_db is None else app.dependency_overrides.__setitem__(get_db, prev_db)
    app.dependency_overrides.pop(get_current_user, None) if prev_user is None else app.dependency_overrides.__setitem__(get_current_user, prev_user)
    shared.close()


def test_raise_list_get_comment_status(client):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "123",
                                         "type": "blocker", "title": "Crashed out",
                                         "first_comment": "cloudy", "assignee_id": 42})
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    assert r.json()["kind"] == "issue" and r.json()["status"] == "open"

    assert client.get("/api/flags?tab=all_open").json()[0]["id"] == fid
    detail = client.get(f"/api/flags/{fid}").json()
    assert detail["comments"][0]["body"] == "cloudy"
    assert any(e["event_type"] == "raised" for e in detail["events"])

    c = client.post(f"/api/flags/{fid}/comments", json={"body": "re-prep scheduled"})
    assert c.status_code == 201

    s = client.post(f"/api/flags/{fid}/status", json={"to_status": "in_progress"})
    assert s.status_code == 200 and s.json()["status"] == "in_progress"

    summ = client.get("/api/flags/summary").json()
    assert summ["by_type"]["blocker"] == 1


def test_unknown_entity_type_400(client):
    r = client.post("/api/flags", json={"entity_type": "nope", "entity_id": "1",
                                         "type": "blocker", "title": "x"})
    assert r.status_code == 400, r.text


def test_get_missing_404(client):
    assert client.get("/api/flags/99999").status_code == 404


def _seed_sample_with_vials(client):
    """Parent P-0071 + two vials; v1 has two analyses. Returns (sample, v1, v2)."""
    from models import LimsSample, LimsSubSample, LimsAnalysis
    db = client.db
    sample = LimsSample(sample_id="P-0071")
    db.add(sample)
    db.flush()
    v1 = LimsSubSample(parent_sample_pk=sample.id, external_lims_uid="mk1://v1",
                       sample_id="P-0071-S01", vial_sequence=1)
    v2 = LimsSubSample(parent_sample_pk=sample.id, external_lims_uid="mk1://v2",
                       sample_id="P-0071-S02", vial_sequence=2)
    db.add_all([v1, v2])
    db.flush()
    for title, kw in [("PEPT-Total", "pept_total"), ("HPLC-PUR", "hplc_pur")]:
        db.add(LimsAnalysis(lims_sub_sample_pk=v1.id, analysis_service_id=1,
                            keyword=kw, title=title))
    db.commit()
    return sample, v1, v2


def test_list_carries_resolved_entity_context(client):
    _sample, v1, _v2 = _seed_sample_with_vials(client)
    r = client.post("/api/flags", json={"entity_type": "sub_sample",
                                         "entity_id": str(v1.id),
                                         "type": "blocker", "title": "Crashed out"})
    assert r.status_code == 201, r.text
    # The create response itself is decorated.
    ent = r.json()["entity"]
    assert ent["sample_id"] == "P-0071"
    assert ent["deep_link"]["kind"] == "sample" and ent["deep_link"]["id"] == "P-0071"
    assert ent["analyses"] and "PEPT-Total" in ent["analyses"]

    row = client.get("/api/flags?tab=all_open").json()[0]
    assert row["entity"]["label"] == "P-0071-S01"
    assert row["entity"]["sample_id"] == "P-0071"
    assert row["entity"]["deep_link"]["kind"] == "sample"
    assert row["entity"]["analyses"]


def test_include_descendants_rolls_up_vial_flags(client):
    sample, v1, _v2 = _seed_sample_with_vials(client)
    # Flag lives on the VIAL, not the sample.
    client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": str(v1.id),
                                     "type": "blocker", "title": "vial issue"})

    # Self-only sample query sees nothing (no flag on the sample itself).
    self_only = client.get(
        f"/api/flags?tab=all_open&entity_type=sample&entity_id={sample.id}").json()
    assert self_only == []

    # With include_descendants the sample aggregates its vials' flags.
    rolled = client.get(
        f"/api/flags?tab=all_open&entity_type=sample&entity_id={sample.id}"
        "&include_descendants=true").json()
    assert [f["title"] for f in rolled] == ["vial issue"]


# --- flag types (Plan 5) -------------------------------------------------
def _as_admin(client):
    """Flip the get_current_user override to an admin for this client."""
    from main import app
    from auth import get_current_user
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=1, role="admin", email="admin@x.t")


def _as_standard(client):
    from main import app
    from auth import get_current_user
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=42, role="standard", email="t@x.t")


def test_list_types_lists_builtins(client):
    rows = client.get("/api/flags/types").json()
    slugs = [r["slug"] for r in rows]
    assert slugs == ["blocker", "critical", "question",
                     "waiting_on_customer", "ready_for_verification",
                     "task", "feature_request"]
    assert all(r["is_builtin"] for r in rows)


def test_entity_types_endpoint(client):
    types = client.get("/api/flags/entity-types").json()
    assert set(types) >= {"sample", "sub_sample", "worksheet"}


def test_type_mutations_require_admin(client):
    # Standard user (fixture default) is forbidden from all mutations.
    assert client.post("/api/flags/types", json={
        "label": "X", "color": "#000000", "kind": "issue"}).status_code == 403
    assert client.put("/api/flags/types/1", json={"label": "Y"}).status_code == 403
    assert client.delete("/api/flags/types/1").status_code == 403


def test_admin_can_create_update_delete_type(client):
    _as_admin(client)
    try:
        created = client.post("/api/flags/types", json={
            "label": "Vial Only", "color": "#abcdef", "kind": "issue",
            "entity_types": ["sub_sample"]})
        assert created.status_code == 201, created.text
        tid = created.json()["id"]
        assert created.json()["slug"] == "vial_only"

        upd = client.put(f"/api/flags/types/{tid}", json={"label": "Vial Only!"})
        assert upd.status_code == 200 and upd.json()["label"] == "Vial Only!"

        assert client.delete(f"/api/flags/types/{tid}").status_code == 204
    finally:
        _as_standard(client)


def test_delete_builtin_returns_409(client):
    _as_admin(client)
    try:
        blocker = next(r for r in client.get("/api/flags/types").json()
                       if r["slug"] == "blocker")
        assert client.delete(f"/api/flags/types/{blocker['id']}").status_code == 409
    finally:
        _as_standard(client)


def test_delete_in_use_type_returns_409(client):
    _as_admin(client)
    try:
        created = client.post("/api/flags/types", json={
            "label": "In Use", "color": "#abcabc", "kind": "issue"})
        tid, slug = created.json()["id"], created.json()["slug"]
        _as_standard(client)
        r = client.post("/api/flags", json={"entity_type": "sub_sample",
                        "entity_id": "9", "type": slug, "title": "uses it"})
        assert r.status_code == 201, r.text
        _as_admin(client)
        assert client.delete(f"/api/flags/types/{tid}").status_code == 409
    finally:
        _as_standard(client)


def test_create_flag_with_type_not_allowed_for_entity_400(client):
    _as_admin(client)
    try:
        created = client.post("/api/flags/types", json={
            "label": "Vial Only", "color": "#abcdef", "kind": "issue",
            "entity_types": ["sub_sample"]})
        slug = created.json()["slug"]
    finally:
        _as_standard(client)
    # Allowed on a vial…
    ok = client.post("/api/flags", json={"entity_type": "sub_sample",
                     "entity_id": "1", "type": slug, "title": "ok"})
    assert ok.status_code == 201, ok.text
    # …but not on a worksheet (out of scope).
    bad = client.post("/api/flags", json={"entity_type": "worksheet",
                      "entity_id": "1", "type": slug, "title": "nope"})
    assert bad.status_code == 400, bad.text
