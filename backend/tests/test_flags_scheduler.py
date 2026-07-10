import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import asyncio
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def session_factory():
    from database import Base
    import flags.models  # noqa: F401
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def test_due_first_time_then_respects_interval(session_factory):
    from flags.scheduler import Scheduler
    from flags.models import FlagSchedulerRun
    calls = []
    s = Scheduler(session_factory)
    s.register("job", interval=timedelta(hours=1),
               fn=lambda now: calls.append(now), jitter=0.0)
    t0 = datetime(2026, 7, 9, 8, 0, 0)
    assert asyncio.run(s.tick(now=t0)) == ["job"]         # never run -> due
    assert asyncio.run(s.tick(now=t0 + timedelta(minutes=30))) == []  # < interval
    assert asyncio.run(s.tick(now=t0 + timedelta(hours=1, minutes=1))) == ["job"]
    assert len(calls) == 2
    db = session_factory()
    assert db.get(FlagSchedulerRun, "job").last_status == "ok"
    db.close()


def test_failing_job_records_error_and_does_not_kill_tick(session_factory):
    from flags.scheduler import Scheduler
    from flags.models import FlagSchedulerRun
    ran = []
    s = Scheduler(session_factory)
    s.register("boom", interval=timedelta(hours=1),
               fn=lambda now: (_ for _ in ()).throw(RuntimeError("nope")), jitter=0.0)
    s.register("ok", interval=timedelta(hours=1),
               fn=lambda now: ran.append(now), jitter=0.0)
    fired = asyncio.run(s.tick(now=datetime(2026, 7, 9, 8)))
    assert set(fired) == {"boom", "ok"} and ran           # ok still ran
    db = session_factory()
    assert db.get(FlagSchedulerRun, "boom").last_status.startswith("error:")
    assert db.get(FlagSchedulerRun, "ok").last_status == "ok"
    db.close()


def test_async_job_is_awaited(session_factory):
    from flags.scheduler import Scheduler
    seen = []
    async def job(now):
        seen.append(now)
    s = Scheduler(session_factory)
    s.register("aj", interval=timedelta(hours=1), fn=job, jitter=0.0)
    asyncio.run(s.tick(now=datetime(2026, 7, 9, 8)))
    assert len(seen) == 1


def test_duplicate_registration_rejected(session_factory):
    from flags.scheduler import Scheduler
    s = Scheduler(session_factory)
    s.register("x", interval=timedelta(hours=1), fn=lambda now: None)
    with pytest.raises(ValueError):
        s.register("x", interval=timedelta(hours=1), fn=lambda now: None)
