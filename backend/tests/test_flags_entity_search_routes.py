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
    import models  # noqa: F401
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
    tc.db = shared
    yield tc
    app.dependency_overrides.pop(get_db, None) if prev_db is None else app.dependency_overrides.__setitem__(get_db, prev_db)
    app.dependency_overrides.pop(get_current_user, None) if prev_user is None else app.dependency_overrides.__setitem__(get_current_user, prev_user)
    shared.close()


def test_entity_search_returns_hits(client):
    from models import LimsSample
    client.db.add(LimsSample(sample_id="PB-0102", status="new"))
    client.db.add(LimsSample(sample_id="PB-0199", status="new"))
    client.db.commit()
    r = client.get("/api/flags/entity-search", params={"entity_type": "sample", "q": "PB-01"})
    assert r.status_code == 200, r.text
    assert [h["entity_id"] for h in r.json()] == ["PB-0102", "PB-0199"]
    assert r.json()[0]["label"] == "PB-0102"


def test_entity_search_short_query_returns_empty(client):
    from models import LimsSample
    client.db.add(LimsSample(sample_id="PB-0102", status="new")); client.db.commit()
    r = client.get("/api/flags/entity-search", params={"entity_type": "sample", "q": "P"})
    assert r.status_code == 200
    assert r.json() == []


def test_entity_search_unregistered_type_empty(client):
    r = client.get("/api/flags/entity-search", params={"entity_type": "nope", "q": "abc"})
    assert r.status_code == 200
    assert r.json() == []


def test_entity_search_literal_route_not_shadowed_by_flag_id(client):
    # /entity-search must win over /{flag_id}; a shadowed route would try to
    # parse "entity-search" as an int id → 422, not a clean 200 [].
    r = client.get("/api/flags/entity-search", params={"entity_type": "worksheet", "q": "zz"})
    assert r.status_code == 200
    assert r.json() == []
