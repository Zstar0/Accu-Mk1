import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"Vial {e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    # Real users so mention validation has something to match.
    from models import User
    for uid, em in [(1, "a@x.t"), (2, "b@x.t"), (3, "c@x.t")]:
        s.add(User(id=uid, email=em, hashed_password="x", is_active=True))
    s.commit()
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def _flag(db, actor=1):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type="sub_sample",
                               entity_id="1", type="blocker", title="t")


def test_mention_stores_ids_adds_watcher_and_tags_event(db):
    from flags import service, seams
    from flags.models import FlagParticipant
    f = _flag(db, actor=1)
    sink = seams.EVENT_SINK
    before = len(sink.events)
    c = service.add_comment(db, user=_user(1), flag_id=f.id, body="hey @b", mention_ids=[2])
    assert c.mentions == [2]
    # user 2 is now a watcher participant
    parts = db.execute(select(FlagParticipant.user_id).where(
        FlagParticipant.flag_id == f.id)).scalars().all()
    assert 2 in parts
    # the commented event carries details.mentions
    ev = [e for e in sink.events[before:] if e["event_type"] == "commented"][-1]
    assert ev["details"]["mentions"] == [2]


def test_mention_drops_unknown_ids_and_dedups(db):
    from flags import service
    f = _flag(db, actor=1)
    c = service.add_comment(db, user=_user(1), flag_id=f.id, body="x",
                            mention_ids=[2, 2, 999])
    assert c.mentions == [2]           # 999 unknown dropped, 2 deduped
