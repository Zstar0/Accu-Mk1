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
    seams.register_entity("sub_sample",
                           label=lambda d, e: f"Vial {e}",
                           deep_link=lambda e: f"/v/{e}",
                           can_flag=lambda u, e: True)
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


def test_create_flag_writes_event_and_emits(db):
    from flags import service, seams
    from flags.models import FlagEvent
    f = service.create_flag(db, user=_user(7), entity_type="sub_sample", entity_id="123",
                            type="blocker", title="Crashed out", first_comment="cloudy")
    assert f.id and f.status == "open" and f.kind == "issue" and f.created_by == 7
    evs = db.query(FlagEvent).filter_by(flag_id=f.id).all()
    assert any(e.event_type == "raised" for e in evs)
    assert seams.EVENT_SINK.events[0]["event_type"] == "raised"
    assert len(f.comments) == 1 and f.comments[0].body == "cloudy"


def test_create_flag_unknown_entity_type_rejected(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=_user(), entity_type="nope", entity_id="1",
                            type="blocker", title="x")


def test_create_flag_invalid_type_rejected(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=_user(), entity_type="sub_sample", entity_id="1",
                            type="not_a_type", title="x")


def test_list_tabs_and_summary(db):
    from flags import service
    u = _user(7)
    a = service.create_flag(db, user=u, entity_type="sub_sample", entity_id="1",
                            type="blocker", title="A", assignee_id=7)
    service.create_flag(db, user=u, entity_type="sub_sample", entity_id="2",
                        type="ready_for_verification", title="B")
    assigned = service.list_flags(db, user_id=7, tab="assigned")
    assert [f.id for f in assigned] == [a.id]
    all_open = service.list_flags(db, user_id=7, tab="all_open")
    assert len(all_open) == 2
    s = service.summary(db, user_id=7)
    assert s["assigned_to_me"] == 1
    # by_type is scoped to flags assigned to me: the unassigned
    # ready_for_verification flag (B) is excluded.
    assert s["by_type"] == {"blocker": 1}


def test_summary_by_type_scoped_to_assignee(db):
    from flags import service
    u7, u8 = _user(7), _user(8)
    service.create_flag(db, user=u7, entity_type="sub_sample", entity_id="1",
                        type="blocker", title="mine", assignee_id=7)
    service.create_flag(db, user=u7, entity_type="sub_sample", entity_id="2",
                        type="question", title="mine too", assignee_id=7)
    # Someone else's open flag — must NOT count toward my badge.
    service.create_flag(db, user=u8, entity_type="sub_sample", entity_id="3",
                        type="blocker", title="theirs", assignee_id=8)
    # An unassigned open flag — also excluded.
    service.create_flag(db, user=u7, entity_type="sub_sample", entity_id="4",
                        type="critical", title="nobody's")
    s = service.summary(db, user_id=7)
    assert s["assigned_to_me"] == 2
    assert s["by_type"] == {"blocker": 1, "question": 1}
    # by_type totals reconcile with assigned_to_me.
    assert sum(s["by_type"].values()) == s["assigned_to_me"]
