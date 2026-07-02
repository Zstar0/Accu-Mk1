import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401  (register FlagType on Base)
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"V{e}",
                           deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    try:
        yield s
    finally:
        s.close()


def _user(id=1, role="standard"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def _flag(db, assignee_id=None):
    from flags import service
    return service.create_flag(db, user=_user(1), entity_type="sub_sample", entity_id="1",
                               type="blocker", title="t", assignee_id=assignee_id)


def test_add_comment(db):
    from flags import service
    f = _flag(db)
    c = service.add_comment(db, user=_user(2), flag_id=f.id, body="hi")
    assert c.id and c.audience == "internal" and c.author_id == 2


def test_assign_and_watchers(db):
    from flags import service
    from flags.models import FlagParticipant
    f = _flag(db)
    service.assign(db, user=_user(1), flag_id=f.id, assignee_id=9)
    assert db.get(type(f), f.id).assignee_id == 9
    service.add_watcher(db, user=_user(1), flag_id=f.id, user_id=3)
    assert db.query(FlagParticipant).filter_by(flag_id=f.id, user_id=3).count() == 1
    service.remove_watcher(db, user=_user(1), flag_id=f.id, user_id=3)
    assert db.query(FlagParticipant).filter_by(flag_id=f.id, user_id=3).count() == 0


def test_status_lifecycle_and_perms(db):
    from flags import service
    from flags.errors import ConflictError, PermissionDeniedError
    f = _flag(db, assignee_id=2)               # raiser=1, assignee=2
    service.change_status(db, user=_user(2), flag_id=f.id, to_status="in_progress")
    got = service.change_status(db, user=_user(2), flag_id=f.id, to_status="resolved")
    assert got.status == "resolved" and got.resolved_at is not None and got.resolved_by == 2
    # a non-assignee non-admin non-raiser cannot move status
    with pytest.raises(PermissionDeniedError):
        service.change_status(db, user=_user(99), flag_id=f.id, to_status="closed")
    # illegal transition (resolved -> nonexistent already covered by catalog; test a bad jump)
    f2 = _flag(db)
    with pytest.raises(ConflictError):
        service.change_status(db, user=_user(1), flag_id=f2.id, to_status="bogus")
