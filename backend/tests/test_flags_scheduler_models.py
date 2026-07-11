import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from datetime import date, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_scheduler_run_row(db):
    from flags.models import FlagSchedulerRun
    db.add(FlagSchedulerRun(name="digest", last_run_at=datetime(2026, 7, 9, 8),
                            last_status="ok"))
    db.commit()
    assert db.get(FlagSchedulerRun, "digest").last_status == "ok"


def test_recurring_row_defaults(db):
    from flags.models import FlagRecurring
    r = FlagRecurring(title="Calibrate HPLC", type="task", cadence="weekly:0",
                      next_run_at=datetime(2026, 7, 13), created_by=1)
    db.add(r)
    db.commit()
    assert r.id and r.active is True and r.skip_if_open is True
    assert r.body is None and r.entity_type is None and r.last_minted_flag_id is None


def test_slack_prefs_digest_columns(db):
    from models import SlackDmPrefs
    p = SlackDmPrefs(user_id=1)
    db.add(p)
    db.commit()
    assert p.digest_enabled is False and p.digest_hour == 8
    assert p.last_digest_date is None
    p.last_digest_date = date(2026, 7, 9)
    db.commit()
    assert db.query(SlackDmPrefs).one().last_digest_date == date(2026, 7, 9)
