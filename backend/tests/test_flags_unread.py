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
    from models import User
    for uid in (1, 2, 9):
        s.add(User(id=uid, email=f"u{uid}@x.t", hashed_password="x", is_active=True))
    s.commit()
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def _flag(db, actor, assignee=None):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type="sub_sample",
                               entity_id="1", type="blocker", title="t",
                               assignee_id=assignee)


def test_relevant_flag_unread_until_read(db):
    from flags import service
    f = _flag(db, actor=1)                     # created by me(1) → relevant
    assert f.id in {x.id for x in service.list_unread(db, user_id=1)}
    service.mark_read(db, user_id=1, flag_id=f.id)
    assert f.id not in {x.id for x in service.list_unread(db, user_id=1)}


def test_new_activity_after_read_reopens_unread(db):
    from flags import service
    f = _flag(db, actor=1)
    service.mark_read(db, user_id=1, flag_id=f.id)
    service.add_comment(db, user=_user(9), flag_id=f.id, body="ping")  # bumps updated_at
    assert f.id in {x.id for x in service.list_unread(db, user_id=1)}


def test_irrelevant_flag_never_unread(db):
    from flags import service
    other = _flag(db, actor=9)                  # not mine, not assigned, not watching
    assert other.id not in {x.id for x in service.list_unread(db, user_id=1)}


def test_mark_read_is_idempotent(db):
    from flags import service
    from flags.models import FlagRead
    f = _flag(db, actor=1)
    service.mark_read(db, user_id=1, flag_id=f.id)
    service.mark_read(db, user_id=1, flag_id=f.id)
    rows = db.execute(select(FlagRead).where(FlagRead.user_id == 1,
                                             FlagRead.flag_id == f.id)).scalars().all()
    assert len(rows) == 1
