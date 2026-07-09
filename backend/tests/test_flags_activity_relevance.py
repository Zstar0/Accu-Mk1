import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


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
