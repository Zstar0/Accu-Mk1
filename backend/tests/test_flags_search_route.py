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
    yield tc
    app.dependency_overrides.pop(get_db, None) if prev_db is None else app.dependency_overrides.__setitem__(get_db, prev_db)
    app.dependency_overrides.pop(get_current_user, None) if prev_user is None else app.dependency_overrides.__setitem__(get_current_user, prev_user)
    shared.close()


def _raise(client, *, title, entity_id, comment=None):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": entity_id,
                                         "type": "blocker", "title": title})
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    if comment is not None:
        c = client.post(f"/api/flags/{fid}/comments", json={"body": comment})
        assert c.status_code == 201, c.text
    return fid


def test_search_matches_comment_body(client):
    fid = _raise(client, title="Pump seal", entity_id="1",
                 comment="the cloudy precipitate settled overnight")
    hits = client.get("/api/flags/search?q=precipitate").json()
    assert [h["flag_id"] for h in hits] == [fid]
    assert "comment" in hits[0]["matched_in"]
    assert "precipitate" in hits[0]["snippet"].lower()


def test_search_matches_title(client):
    fid = _raise(client, title="Centrifuge imbalance", entity_id="2")
    hits = client.get("/api/flags/search?q=centrifuge").json()
    hit = next(h for h in hits if h["flag_id"] == fid)
    assert hit["matched_in"] == ["title"] and hit["snippet"] == ""


def test_search_short_query_returns_empty(client):
    _raise(client, title="ph drift", entity_id="3", comment="ph is drifting")
    assert client.get("/api/flags/search?q=ph").json() == []


def test_search_route_wins_over_flag_id_param(client):
    # /search must resolve to the search handler, NOT GET /{flag_id} with
    # flag_id="search" (which would 422). A no-match query returns [] with 200.
    r = client.get("/api/flags/search?q=zzzznomatch")
    assert r.status_code == 200 and r.json() == []


def test_search_requires_auth(client):
    from auth import get_current_user
    from main import app
    app.dependency_overrides.pop(get_current_user, None)
    try:
        r = client.get("/api/flags/search?q=anything")
        assert r.status_code in (401, 403)
    finally:
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
            id=42, role="standard", email="t@x.t")
