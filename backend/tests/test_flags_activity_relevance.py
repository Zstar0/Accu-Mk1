import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"V{e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    # Real users so mention validation has something to match.
    from models import User
    for uid, em in [(1, "a@x.t"), (2, "b@x.t"), (5, "e@x.t")]:
        s.add(User(id=uid, email=em, hashed_password="x", is_active=True))
    s.commit()
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def _raise(db, actor, assignee=None):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type="sub_sample",
                               entity_id="1", type="blocker", title="t",
                               assignee_id=assignee)


def test_relevance_actor_and_raised(db):
    from flags import service
    _raise(db, actor=1, assignee=2)  # creator=1, assignee=2
    rows, _ = service.list_activity(db, user_id=1, limit=25)
    rel = service.compute_relevance(db, rows, user_id=1)
    raised = next(e for e in rows if e.event_type == "raised")
    assert "actor" in rel[raised.id] and "raised" in rel[raised.id]
    assert "assigned" not in rel[raised.id]  # user 1 is creator, not assignee


def test_relevance_assigned_and_watching(db):
    from flags import service
    _raise(db, actor=1, assignee=2)
    rows, _ = service.list_activity(db, user_id=2, limit=25)
    rel = service.compute_relevance(db, rows, user_id=2)
    raised = next(e for e in rows if e.event_type == "raised")
    assert "assigned" in rel[raised.id]
    assert "watching" in rel[raised.id]  # assignee is auto-added as a participant
    assert "actor" not in rel[raised.id]


def test_relevance_mentioned(db):
    from flags import service
    f = _raise(db, actor=1)
    service.add_comment(db, user=_user(1), flag_id=f.id, body="hey @e",
                        mention_ids=[5])
    rows, _ = service.list_activity(db, user_id=5, limit=25)
    rel = service.compute_relevance(db, rows, user_id=5)
    commented = next(e for e in rows if e.event_type == "commented")
    assert "mentioned" in rel[commented.id]


def test_comment_event_carries_mentions(db):
    # Regression guard: add_comment already writes details.mentions (service.py).
    from flags import service
    f = _raise(db, actor=1)
    service.add_comment(db, user=_user(1), flag_id=f.id, body="hi @e",
                        mention_ids=[5])
    ev = [e for e in service.get_flag(db, f.id).events
          if e.event_type == "commented"][-1]
    assert (ev.details or {}).get("mentions") == [5]


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


def test_activity_endpoint_serializes_relevance(client):
    # Requesting user (42) raises the flag → the raised event carries actor+raised.
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                        "type": "blocker", "title": "rel"})
    assert r.status_code == 201, r.text
    body = client.get("/api/flags/activity?limit=10").json()
    raised = next(i for i in body["items"] if i["event_type"] == "raised")
    assert "relevance" in raised
    assert "actor" in raised["relevance"] and "raised" in raised["relevance"]
