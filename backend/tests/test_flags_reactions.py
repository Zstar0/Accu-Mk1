import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from urllib.parse import quote
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
    shared = sessionmaker(bind=engine)()
    types_service.seed_builtins(shared)

    def _db():
        yield shared
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    yield tc
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    shared.close()


def _flag_with_comment(client):
    fid = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                          "type": "blocker", "title": "t"}).json()["id"]
    cid = client.post(f"/api/flags/{fid}/comments", json={"body": "hi"}).json()["id"]
    return fid, cid


def test_add_is_idempotent_and_aggregates(client):
    _fid, cid = _flag_with_comment(client)
    e = quote("👍")
    r1 = client.put(f"/api/flags/comments/{cid}/reactions/{e}")
    r2 = client.put(f"/api/flags/comments/{cid}/reactions/{e}")   # idempotent
    assert r1.status_code == 200 and r2.status_code == 200
    agg = {a["emoji"]: a for a in r2.json()}
    assert agg["👍"]["count"] == 1 and agg["👍"]["user_ids"] == [42]


def test_curated_set_round_trips_every_emoji(client):
    from flags.service import CURATED_EMOJI
    fid, cid = _flag_with_comment(client)
    for emo in CURATED_EMOJI:
        r = client.put(f"/api/flags/comments/{cid}/reactions/{quote(emo)}")
        assert r.status_code == 200, (emo, r.text)
    detail = client.get(f"/api/flags/{fid}").json()
    got = {a["emoji"] for a in detail["comments"][0]["reactions"]}
    assert got == set(CURATED_EMOJI)


def test_non_curated_emoji_rejected(client):
    _fid, cid = _flag_with_comment(client)
    assert client.put(f"/api/flags/comments/{cid}/reactions/{quote('🦄')}").status_code == 400


def test_delete_removes_only_own(client):
    _fid, cid = _flag_with_comment(client)
    e = quote("✅")
    client.put(f"/api/flags/comments/{cid}/reactions/{e}")
    d = client.delete(f"/api/flags/comments/{cid}/reactions/{e}")
    assert d.status_code == 200 and d.json() == []


def test_reaction_emits_comment_reaction_without_audit_or_updated_at(client):
    from flags import seams
    fid, cid = _flag_with_comment(client)
    before = client.get(f"/api/flags/{fid}").json()["updated_at"]
    seams.EVENT_SINK.events.clear()
    client.put(f"/api/flags/comments/{cid}/reactions/{quote('🎉')}")
    kinds = [e["event_type"] for e in seams.EVENT_SINK.events]
    assert kinds == ["comment_reaction"]              # nothing else on the sink
    after = client.get(f"/api/flags/{fid}").json()
    assert after["updated_at"] == before              # not bumped
    assert not any(ev["event_type"].startswith("comment_reaction")
                   for ev in after["events"])         # no flag_events row
