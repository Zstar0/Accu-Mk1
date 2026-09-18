"""Business-hours deadline: the inverse of compute_business_minutes.

The endotoxin bench (spec 2026-09-18-endo-worksheet-design, Handler ruling
2026-09-18) takes its due date from the SLA engine rather than a constant, so
/sla/status now returns `due_at`: the instant the business clock reaches the
sample's target. In-memory SQLite for the route test, no live stack.
"""
from datetime import datetime, time, timedelta, timezone as _tz, date
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from main import app
from models import BusinessHoursConfig, LabHoliday
from sla_engine import BusinessSchedule, compute_business_deadline

_PT = ZoneInfo("America/Los_Angeles")
_SCHED = BusinessSchedule(
    open_time=time(9, 0), close_time=time(17, 0),
    timezone="America/Los_Angeles", working_days=frozenset({0, 1, 2, 3, 4}),
)
_NO_HOLIDAY = lambda d: False  # noqa: E731


def _utc(y, mo, d, h, mi=0):
    """A Pacific wall-clock instant as NAIVE UTC (codebase convention)."""
    return datetime(y, mo, d, h, mi, tzinfo=_PT).astimezone(_tz.utc).replace(tzinfo=None)


def test_1440_minutes_from_friday_morning_lands_wednesday_morning():
    # Fri 07-10 10:00 -> 420 that day, Mon 480 (900), Tue 480 (1380), Wed 09:00 + 60
    assert compute_business_deadline(_utc(2026, 7, 10, 10), 1440, _SCHED, _NO_HOLIDAY) == _utc(2026, 7, 15, 10)


def test_received_after_close_starts_the_clock_at_next_open():
    # Fri 18:00 -> Mon 480, Tue 960, Wed 1440 at close
    assert compute_business_deadline(_utc(2026, 7, 10, 18), 1440, _SCHED, _NO_HOLIDAY) == _utc(2026, 7, 15, 17)


def test_lab_holiday_pushes_the_deadline():
    # Fri 09-04 10:00 with Labor Day (Mon 09-07) closed -> Tue, Wed, Thu 10:00
    is_holiday = lambda d: d == date(2026, 9, 7)  # noqa: E731
    assert compute_business_deadline(_utc(2026, 9, 4, 10), 1440, _SCHED, is_holiday) == _utc(2026, 9, 10, 10)


def test_misconfigured_schedule_returns_none_never_raises():
    empty = BusinessSchedule(open_time=time(9, 0), close_time=time(17, 0),
                             timezone="America/Los_Angeles", working_days=frozenset())
    assert compute_business_deadline(_utc(2026, 7, 10, 10), 1440, empty, _NO_HOLIDAY) is None
    assert compute_business_deadline(None, 1440, _SCHED, _NO_HOLIDAY) is None


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add(BusinessHoursConfig(id=1, open_time=time(9, 0), close_time=time(17, 0),
                              timezone="America/Los_Angeles", working_days=[0, 1, 2, 3, 4]))
    s.add(LabHoliday(holiday_date=date(2026, 9, 7), name="Labor Day", source="federal"))
    s.commit()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_sla_status_reports_due_at(client):
    received = _utc(2026, 9, 4, 10)
    r = client.post("/sla/status", json={"items": [
        {"key": "bh", "received_at": received.isoformat(), "target_minutes": 1440, "business_hours_only": True},
        {"key": "wall", "received_at": received.isoformat(), "target_minutes": 1440, "business_hours_only": False},
        {"key": "none", "received_at": None, "target_minutes": 1440, "business_hours_only": True},
    ]})
    assert r.status_code == 200, r.text
    by_key = {i["key"]: i["status"] for i in r.json()["items"]}
    assert by_key["bh"]["due_at"] == _utc(2026, 9, 10, 10).isoformat()
    assert by_key["wall"]["due_at"] == (received + timedelta(minutes=1440)).isoformat()
    assert by_key["none"] is None
    # The existing keys are untouched.
    assert set(by_key["bh"]) >= {"target_minutes", "elapsed_minutes", "remaining_minutes", "breached"}
