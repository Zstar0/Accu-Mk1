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
    seams._REGISTRY.clear()
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def test_watch_row_roundtrips(db):
    from flags.models import FlagEntityWatch
    w = FlagEntityWatch(entity_type="sample", entity_id="PB-1",
                        condition={"field": "state", "equals": "received"},
                        action={"kind": "comment", "flag_id": 1, "body": "hi"},
                        created_by=42, status="armed")
    db.add(w); db.commit(); db.refresh(w)
    assert w.id and w.status == "armed" and w.fired_at is None
    assert w.condition["equals"] == "received"


def test_create_flag_merges_event_details(db):
    # create_flag already carries event_details (Slice 5); the poller reuses it
    # to stamp the automated marker on the raised event (spec §10).
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="sample",
                            entity_id="PB-1", type="blocker", title="t",
                            event_details={"automated": True, "watch_id": 7})
    raised = [e for e in f.events if e.event_type == "raised"][-1]
    assert raised.details["automated"] is True and raised.details["watch_id"] == 7
    assert raised.details["type"] == "blocker"          # original key preserved


def test_add_comment_merges_event_details(db):
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="sample",
                            entity_id="PB-1", type="blocker", title="t")
    service.add_comment(db, user=_user(1), flag_id=f.id, body="done",
                        event_details={"automated": True})
    ev = [e for e in service.get_flag(db, f.id).events
          if e.event_type == "commented"][-1]
    assert ev.details["automated"] is True and ev.details["body_excerpt"] == "done"


def test_arm_cancel_list_lifecycle(db):
    from flags import service, watches
    f = service.create_flag(db, user=_user(1), entity_type="sample",
                            entity_id="PB-1", type="blocker", title="t")
    w = watches.arm_watch(db, user=_user(1), entity_type="sample",
                          entity_id="PB-1",
                          condition={"field": "state", "equals": "received"},
                          action={"kind": "comment", "flag_id": f.id, "body": "here"},
                          watch_flag_id=f.id)
    assert w.status == "armed"
    assert [x.id for x in watches.list_watches(db, flag_id=f.id)] == [w.id]
    # watch_armed rode the associated flag
    assert "watch_armed" in [e.event_type for e in service.get_flag(db, f.id).events]
    watches.cancel_watch(db, user=_user(1), watch_id=w.id)
    assert db.get(type(w), w.id).status == "cancelled"
    assert watches.list_watches(db, flag_id=f.id) == []          # armed-only
    assert "watch_cancelled" in [e.event_type for e in service.get_flag(db, f.id).events]


def test_arm_rejects_unwatchable_entity(db):
    from flags import watches
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        watches.arm_watch(db, user=_user(1), entity_type="sub_sample",
                          entity_id="9",
                          condition={"field": "state", "equals": "received"},
                          action={"kind": "create_flag", "type": "blocker", "title": "x"})


def test_cancel_requires_creator_or_admin(db):
    from flags import watches
    from flags.errors import PermissionDeniedError
    w = watches.arm_watch(db, user=_user(1), entity_type="sample", entity_id="PB-2",
                          condition={"field": "state", "equals": "received"},
                          action={"kind": "create_flag", "type": "blocker", "title": "x"})
    with pytest.raises(PermissionDeniedError):
        watches.cancel_watch(db, user=_user(2), watch_id=w.id)         # not creator
    watches.cancel_watch(db, user=SimpleNamespace(id=99, role="admin"), watch_id=w.id)
