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


def test_arm_list_cancel_via_api(client):
    # seed a watchable sample through the shared session
    from models import LimsSample
    client.db.add(LimsSample(sample_id="PB-0102", status="new")); client.db.commit()
    f = client.post("/api/flags", json={"entity_type": "sample", "entity_id": "PB-0102",
                                        "type": "blocker", "title": "t"}).json()
    r = client.post("/api/flags/watches", json={
        "entity_type": "sample", "entity_id": "PB-0102",
        "condition": {"field": "state", "equals": "received"},
        "action": {"kind": "comment", "flag_id": f["id"], "body": "arrived"},
        "watch_flag_id": f["id"]})
    assert r.status_code == 201, r.text
    wid = r.json()["id"]
    assert r.json()["status"] == "armed"
    lst = client.get(f"/api/flags/watches?flag_id={f['id']}").json()
    assert [w["id"] for w in lst] == [wid]
    assert client.delete(f"/api/flags/watches/{wid}").status_code == 204
    assert client.get(f"/api/flags/watches?flag_id={f['id']}").json() == []


def test_arm_on_unwatchable_type_400(client):
    r = client.post("/api/flags/watches", json={
        "entity_type": "sub_sample", "entity_id": "9",
        "condition": {"field": "state", "equals": "received"},
        "action": {"kind": "create_flag", "type": "blocker", "title": "x"}})
    assert r.status_code == 400, r.text
