import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Mutable fake-entity state the tests flip to simulate a transition.
_STATE = {}


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams._REGISTRY.clear()
    seams.register_entity("widget",
                          label=lambda d, e: f"Widget {e}",
                          deep_link=lambda e: f"/w/{e}",
                          can_flag=lambda u, e: True,
                          state=lambda d, e: _STATE.get(e))
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    _STATE.clear()
    try:
        yield s
    finally:
        s.close()
        seams._REGISTRY.clear()


def _user(i):
    return SimpleNamespace(id=i, role="standard", email=f"u{i}@x.t")


def test_poll_fires_comment_when_state_matches(db):
    from flags import service, watches
    f = service.create_flag(db, user=_user(1), entity_type="widget", entity_id="W1",
                            type="blocker", title="t")
    watches.arm_watch(db, user=_user(1), entity_type="widget", entity_id="W1",
                      condition={"field": "state", "equals": "received"},
                      action={"kind": "comment", "flag_id": f.id, "body": "W1 received"},
                      watch_flag_id=f.id)
    assert watches.run_watch_poll(db) == 0            # not received yet
    _STATE["W1"] = "received"
    assert watches.run_watch_poll(db) == 1            # fires
    assert watches.run_watch_poll(db) == 0            # one-shot: no re-fire
    detail = service.get_flag(db, f.id)
    assert any(c.body == "W1 received" for c in detail.comments)
    fired = [e for e in detail.events if e.event_type == "watch_fired"][-1]
    assert fired.details["automated"] is True
    commented = [e for e in detail.events if e.event_type == "commented"][-1]
    assert commented.details["automated"] is True     # §10 marker on the action too


def test_poll_fires_create_flag_and_links_minted_flag(db):
    from flags import watches
    from flags.models import FlagEntityWatch
    w = watches.arm_watch(db, user=_user(3), entity_type="widget", entity_id="W2",
                          condition={"field": "state", "equals": "done"},
                          action={"kind": "create_flag", "type": "blocker",
                                  "title": "W2 is done", "assignee_id": 3})
    _STATE["W2"] = "done"
    assert watches.run_watch_poll(db) == 1
    row = db.get(FlagEntityWatch, w.id)
    assert row.status == "fired" and row.fired_at is not None
    assert row.watch_flag_id is not None              # linked to the minted flag


def test_one_poison_watch_does_not_stall_the_rest(db):
    from flags import service, watches
    # A comment watch whose target flag will be deleted → fire raises, is isolated.
    f = service.create_flag(db, user=_user(1), entity_type="widget", entity_id="W3",
                            type="blocker", title="t")
    watches.arm_watch(db, user=_user(1), entity_type="widget", entity_id="W3",
                      condition={"field": "state", "equals": "x"},
                      action={"kind": "comment", "flag_id": f.id, "body": "hi"},
                      watch_flag_id=f.id)
    good = watches.arm_watch(db, user=_user(1), entity_type="widget", entity_id="W4",
                             condition={"field": "state", "equals": "x"},
                             action={"kind": "create_flag", "type": "blocker", "title": "ok"})
    db.delete(f); db.commit()                          # poison the first watch
    _STATE["W3"] = "x"; _STATE["W4"] = "x"
    assert watches.run_watch_poll(db) == 1             # W4 still fires
    from flags.models import FlagEntityWatch
    assert db.get(FlagEntityWatch, good.id).status == "fired"
