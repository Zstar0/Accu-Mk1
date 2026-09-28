import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from datetime import datetime
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
    seams.register_entity("sub_sample", label=lambda d, e: f"Vial {e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)  # includes a global "task" type (Slice 2)
    try:
        yield s
    finally:
        s.close()


def _user(id=1, role="admin"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def test_next_run_after_literals():
    from flags.recurring import next_run_after
    mon = datetime(2026, 7, 13)  # a Monday (weekday()==0)
    assert next_run_after("daily", datetime(2026, 7, 9, 8)) == datetime(2026, 7, 10)
    # weekly:0 (Mon) from a Monday -> the NEXT Monday (strictly after)
    assert next_run_after("weekly:0", mon) == datetime(2026, 7, 20)
    assert next_run_after("monthly:15", datetime(2026, 7, 9)) == datetime(2026, 7, 15)
    assert next_run_after("monthly:5", datetime(2026, 7, 9)) == datetime(2026, 8, 5)


def test_create_flag_event_details_merges(db):
    from flags import service
    from flags.models import FlagEvent
    f = service.create_flag(db, user=_user(), entity_type="sub_sample", entity_id="1",
                            type="blocker", title="t",
                            event_details={"automated": True, "recurring_id": 9})
    raised = [e for e in db.query(FlagEvent).filter_by(flag_id=f.id)
              if e.event_type == "raised"][0]
    assert raised.details["automated"] is True and raised.details["recurring_id"] == 9
    assert raised.details["type"] == "blocker"     # existing key preserved


def test_run_due_mints_and_advances(db):
    from flags import recurring
    from flags.models import FlagRecurring, FlagFlag
    r = recurring.create_recurring(db, user=_user(1), title="Calibrate", body="do it",
                                   type="task", cadence="daily",
                                   assignee_id=2, watchers=[3])
    r.next_run_at = datetime(2026, 7, 9, 0, 0)     # force due
    db.commit()
    minted = recurring.run_due(db, now=datetime(2026, 7, 9, 8, 0))
    assert minted == 1
    flag = db.query(FlagFlag).filter_by(title="Calibrate").one()
    assert flag.assignee_id == 2
    row = db.get(FlagRecurring, r.id)
    assert row.last_minted_flag_id == flag.id
    assert row.next_run_at == datetime(2026, 7, 10)  # advanced


def test_run_due_skips_when_previous_open(db):
    from flags import recurring
    from flags.models import FlagRecurring
    r = recurring.create_recurring(db, user=_user(1), title="Weekly", type="task",
                                   cadence="daily", skip_if_open=True)
    r.next_run_at = datetime(2026, 7, 9)
    db.commit()
    assert recurring.run_due(db, now=datetime(2026, 7, 9, 8)) == 1
    # previous mint is still open -> the next due tick skips (but still advances)
    db.get(FlagRecurring, r.id).next_run_at = datetime(2026, 7, 10)
    db.commit()
    assert recurring.run_due(db, now=datetime(2026, 7, 10, 8)) == 0
    assert db.get(FlagRecurring, r.id).next_run_at == datetime(2026, 7, 11)


# --- isolation + real creator (slice 2 final review I0) ----------------------
from tests.test_flags_visibility_enforcement import (  # noqa: E402,F401
    ADMIN, MEMBER, OUTSIDER, w)


def test_run_due_isolates_a_failing_template_and_mints_as_the_creator(w, caplog):
    import logging
    from datetime import timedelta
    from flags import recurring
    from flags.models import FlagFlag
    now = datetime.utcnow()
    due = now - timedelta(days=1)
    mk = lambda **kw: recurring.create_recurring(
        w.s, user=ADMIN, type="task", cadence="daily", next_run_at=due, **kw)
    bad = mk(title="bad: hidden assignee", entity_type="board_node",
             entity_id=str(w.sec.id), assignee_id=OUTSIDER.id)
    board = mk(title="admin on secret frame", entity_type="board_node",
               entity_id=str(w.sec.id), watchers=[OUTSIDER.id])
    general = mk(title="general recurring")
    with caplog.at_level(logging.WARNING, logger="flags.recurring"):
        assert recurring.run_due(w.s, now=now) == 2
    titles = {f.title for f in w.s.query(FlagFlag).all()}
    assert "general recurring" in titles and "admin on secret frame" in titles
    assert "bad: hidden assignee" not in titles
    for r in (bad, board, general):
        w.s.refresh(r)
        assert r.next_run_at > now, "every template advances, the failing one too"
    assert bad.last_minted_flag_id is None
    msgs = [rec.getMessage() for rec in caplog.records]
    assert any(m.startswith("flag_recurring_mint_failed") and f"recurring_id={bad.id}" in m
               for m in msgs)
    assert any(m.startswith("flag_recurring_watcher_failed") and f"user_id={OUTSIDER.id}" in m
               for m in msgs)


# --- deactivated creator does not keep admin authority (Task 8 item 1, fix round 1 item 2) --
def test_run_due_deactivated_creator_does_not_mint_with_admin_authority(w):
    """A deactivated admin's template falls back to the synthetic (plain standard)
    actor, which the restricted board refuses, so the mint is isolated exactly
    like any other bad template, not minted as admin.

    Deactivation does NOT delete the creator's own group membership rows, so the
    creator is also made a member of the restricted board's group here: the
    fallback actor must itself carry is_active=False (fix round 1), or it would
    still resolve that stale membership by id and mint anyway. A general (fully
    unanchored) template from the same deactivated creator still mints: "create"
    is an open action that only requires a non-None user (flags/permissions.py),
    unaffected by this fix."""
    from datetime import timedelta
    from flags import recurring
    from flags.models import FlagFlag
    from groups.models import UserGroupMember
    from models import User
    now = datetime.utcnow()
    w.s.add(UserGroupMember(group_id=w.g.id, user_id=ADMIN.id))
    w.s.commit()
    restricted = recurring.create_recurring(
        w.s, user=ADMIN, title="admin template, deactivated", type="task",
        cadence="daily", next_run_at=now - timedelta(days=1),
        entity_type="board_node", entity_id=str(w.sec.id))
    general = recurring.create_recurring(
        w.s, user=ADMIN, title="general recurring, deactivated creator",
        type="task", cadence="daily", next_run_at=now - timedelta(days=1))
    w.s.get(User, ADMIN.id).is_active = False
    w.s.commit()
    assert recurring.run_due(w.s, now=now) == 1
    titles = {f.title for f in w.s.query(FlagFlag).all()}
    assert "admin template, deactivated" not in titles
    assert "general recurring, deactivated creator" in titles
    w.s.refresh(restricted)
    assert restricted.last_minted_flag_id is None
    assert restricted.next_run_at > now
    w.s.refresh(general)
    assert general.last_minted_flag_id is not None
