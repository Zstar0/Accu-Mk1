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
