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
    import flags.models  # noqa: F401
    from flags import seams
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_mk1_entities()

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()

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
                                         "first_comment": "cloudy"})
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
