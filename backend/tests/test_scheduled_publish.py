"""Scheduled COA publish: time math, SLA clamp, rows, and the scheduler job.

The job is driven through `Scheduler.tick(now=...)` with an injected fake
`publish` (the seam main.py fills with publish_sample_coa). Nothing sleeps.
"""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import asyncio
import random
from datetime import date, datetime, time, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import scheduled_publish as sp
from models import (
    BusinessHoursConfig, LabHoliday, LimsAnalysis, LimsSample, LimsScheduledPublish,
    LimsSubSampleEvent, Priority, ServiceGroup, SlaPriorityTier, SlaTier, User, FlagType,
    service_group_members,
)
from sla_engine import BusinessSchedule, compute_business_minutes

LA = ZoneInfo("America/Los_Angeles")
SCHEDULE = BusinessSchedule(open_time=time(9, 0), close_time=time(17, 0),
                            timezone="America/Los_Angeles", working_days=frozenset({0, 1, 2, 3, 4}))
NO_HOLIDAY = lambda d: False  # noqa: E731


def la(y, m, d, hh, mm=0):
    """Lab wall time -> naive UTC (what the DB stores)."""
    return datetime(y, m, d, hh, mm, tzinfo=LA).astimezone(timezone.utc).replace(tzinfo=None)


def to_la(naive_utc):
    return naive_utc.replace(tzinfo=timezone.utc).astimezone(LA)


# ── fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def session_factory():
    from database import Base
    import flags.models  # noqa: F401
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    from flags.types_service import seed_builtins
    seed_builtins(db)
    db.add(User(id=1, email="admin@x", hashed_password="x", role="admin", is_active=True))
    db.add(User(id=2, email="tech@x", hashed_password="x", role="standard", is_active=True))
    db.add(BusinessHoursConfig(id=1, open_time=time(9, 0), close_time=time(17, 0),
                               timezone="America/Los_Angeles", working_days=[0, 1, 2, 3, 4]))
    db.add(SlaTier(id=1, name="Standard", target_minutes=1440, business_hours_only=True, is_default=True))
    db.add(Priority(key="default", name="Normal", rank=0, is_default=True))
    db.add(Priority(key="expedited", name="Expedited", rank=10))
    db.commit()
    db.close()
    return factory


def add_sample(db, sample_id="P-1", received=la(2026, 9, 17, 14, 0), **kw):
    s = LimsSample(sample_id=sample_id, status="verified", date_received=received, **kw)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def add_row(db, sample_id="P-1", scheduled_at=la(2026, 9, 19, 10, 0), status="pending",
            created_at=la(2026, 9, 17, 15, 0), by=2):
    r = LimsScheduledPublish(sample_id=sample_id, scheduled_at=scheduled_at, pdf_date="09/19/2026",
                             status=status, created_by_user_id=by, created_at=created_at)
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


def publish_stub(outcomes):
    """A fake publish_sample_coa: pops the next outcome per call. An outcome
    is a result object, an exception to raise, or a callable(db, sample_id)."""
    calls = []

    async def publish(*, sample_id, current_user, db):
        calls.append((sample_id, getattr(current_user, "id", None)))
        out = outcomes.pop(0)
        if callable(out) and not isinstance(out, BaseException):
            return out(db, sample_id)
        if isinstance(out, BaseException):
            raise out
        return out
    publish.calls = calls
    return publish


def ok(warning=None):
    return SimpleNamespace(success=True, message="COA published", verification_code="AB12-CD34", warning=warning)


def tick(factory, publish, now):
    """One scheduler tick with the job registered the way main.py does it."""
    from flags.scheduler import Scheduler
    s = Scheduler(factory)

    async def job(now):
        await sp.run_due(factory, publish, now=now)
    s.register("scheduled_publish", interval=timedelta(minutes=1), fn=job, jitter=0.0)
    return asyncio.run(s.tick(now=now))


def rows(factory, sample_id="P-1"):
    db = factory()
    try:
        return db.execute(select(LimsScheduledPublish).where(LimsScheduledPublish.sample_id == sample_id)
                          .order_by(LimsScheduledPublish.id)).scalars().all()
    finally:
        db.close()


def open_flags(factory, sample_id="P-1"):
    from flags.models import FlagFlag
    db = factory()
    try:
        return db.execute(select(FlagFlag).where(FlagFlag.entity_id == sample_id, FlagFlag.status == "open")
                          ).scalars().all()
    finally:
        db.close()


# ── time math ───────────────────────────────────────────────────────────────

def test_pdf_date_is_lab_local():
    assert sp.pdf_date(datetime(2026, 9, 20, 5, 30), "America/Los_Angeles") == "09/19/2026"
    assert sp.pdf_date(datetime(2026, 9, 20, 12, 30), "America/Los_Angeles") == "09/20/2026"


def test_quiet_window_edges_in_lab_time():
    assert sp.in_quiet_window(la(2026, 9, 17, 22, 0), "America/Los_Angeles")
    assert sp.in_quiet_window(la(2026, 9, 18, 4, 59), "America/Los_Angeles")
    assert not sp.in_quiet_window(la(2026, 9, 18, 5, 0), "America/Los_Angeles")
    assert not sp.in_quiet_window(la(2026, 9, 17, 21, 59), "America/Los_Angeles")


def test_to_naive_utc_rejects_naive():
    with pytest.raises(ValueError):
        sp.to_naive_utc(datetime(2026, 9, 19, 10, 0))
    assert sp.to_naive_utc(datetime(2026, 9, 19, 10, 0, tzinfo=LA)) == la(2026, 9, 19, 10, 0)


def test_add_open_day_hours_skips_the_weekend():
    # Thu 14:00 + 60h: 10h Thu, 24h Fri, Sat/Sun skipped, 24h Mon, 2h Tue.
    out = sp.add_open_day_hours(la(2026, 9, 17, 14, 0), 60, SCHEDULE, NO_HOLIDAY)
    assert to_la(out) == datetime(2026, 9, 22, 2, 0, tzinfo=LA)
    # A holiday is skipped whole too.
    out = sp.add_open_day_hours(la(2026, 9, 17, 14, 0), 60, SCHEDULE, lambda d: d == date(2026, 9, 21))
    assert to_la(out) == datetime(2026, 9, 23, 2, 0, tzinfo=LA)


@pytest.mark.parametrize("start,minutes", [
    (la(2026, 9, 14, 16, 0), 1440),   # Mon 16:00 -> Thu 16:00
    (la(2026, 9, 17, 14, 0), 1440),   # Thu across the weekend
    (la(2026, 9, 19, 11, 0), 480),    # Saturday start -> Mon 17:00
    (la(2026, 9, 14, 7, 0), 30),      # before open -> 09:30
    (la(2026, 9, 14, 16, 30), 0),     # zero -> the same instant
])
def test_add_business_minutes_round_trips_through_the_engine(start, minutes):
    end = sp.add_business_minutes(start, minutes, SCHEDULE, NO_HOLIDAY)
    assert compute_business_minutes(start, end, SCHEDULE, NO_HOLIDAY) == pytest.approx(minutes)
    assert to_la(sp.add_business_minutes(la(2026, 9, 14, 16, 0), 1440, SCHEDULE, NO_HOLIDAY)) \
        == datetime(2026, 9, 17, 16, 0, tzinfo=LA)


def test_push_out_of_quiet_lands_next_open_morning():
    rng = random.Random(1)
    # Friday 23:00 -> Monday 05:00..08:00 (Sat/Sun closed)
    out = to_la(sp.push_out_of_quiet(la(2026, 9, 18, 23, 0), SCHEDULE, NO_HOLIDAY, rng))
    assert out.date() == date(2026, 9, 21) and time(5, 0) <= out.time() < time(8, 0)
    # Tuesday 02:00 -> the same Tuesday morning
    out = to_la(sp.push_out_of_quiet(la(2026, 9, 22, 2, 0), SCHEDULE, NO_HOLIDAY, rng))
    assert out.date() == date(2026, 9, 22) and time(5, 0) <= out.time() < time(8, 0)
    # Not in the window: untouched.
    assert sp.push_out_of_quiet(la(2026, 9, 22, 10, 0), SCHEDULE, NO_HOLIDAY, rng) == la(2026, 9, 22, 10, 0)


# ── suggestion + SLA ────────────────────────────────────────────────────────

def test_suggest_lands_50_to_70_open_day_hours_out(session_factory):
    db = session_factory()
    s = add_sample(db, received=la(2026, 9, 17, 14, 0))  # Thursday
    lo, hi = datetime(2026, 9, 21, 16, 0, tzinfo=LA), datetime(2026, 9, 22, 12, 0, tzinfo=LA)
    for seed in range(40):
        at, deadline, clamped, _tier = sp.suggest(db, s, now=la(2026, 9, 17, 15, 0), rng=random.Random(seed))
        local = to_la(at)
        assert lo <= local <= hi, local
        assert local.weekday() < 5
        assert not sp.in_quiet_window(at, "America/Los_Angeles")
        assert not clamped
    assert to_la(deadline) == datetime(2026, 9, 22, 14, 0, tzinfo=LA)  # 24 bh after Thu 14:00
    db.close()


def test_suggest_skips_a_lab_holiday(session_factory):
    db = session_factory()
    db.add(LabHoliday(holiday_date=date(2026, 9, 21), name="Test day", source="custom"))
    db.commit()
    s = add_sample(db, received=la(2026, 9, 17, 14, 0))
    at, deadline, _, _tier = sp.suggest(db, s, now=la(2026, 9, 17, 15, 0), rng=random.Random(3))
    assert to_la(at).date() >= date(2026, 9, 22)
    assert to_la(deadline) == datetime(2026, 9, 23, 14, 0, tzinfo=LA)
    db.close()


def test_suggest_is_never_past_the_sla(session_factory):
    """Handler 09-17: a suggestion past the SLA means the math is wrong."""
    db = session_factory()
    rng = random.Random(42)
    for i in range(200):
        received = la(2026, 9, 1, 0, 0) + timedelta(minutes=rng.randint(0, 60 * 24 * 21))
        s = add_sample(db, sample_id=f"P-{i}", received=received)
        at, deadline, _, _tier = sp.suggest(db, s, now=received, rng=random.Random(i))
        assert compute_business_minutes(received, at, SCHEDULE, NO_HOLIDAY) <= 1440, (received, at)
        assert at <= deadline
        assert not sp.in_quiet_window(at, "America/Los_Angeles")
    db.close()


def test_expedited_priority_tier_scales_the_suggestion_into_its_own_window(session_factory):
    db = session_factory()
    db.add(SlaTier(id=2, name="Rush", target_minutes=480, business_hours_only=True))
    db.add(SlaPriorityTier(priority="expedited", sla_tier_id=2, service_group_id=None))
    db.commit()
    from priority.service import invalidate_priority_cache
    invalidate_priority_cache()
    s = add_sample(db, received=la(2026, 9, 14, 10, 0), priority_key="expedited")  # Mon 10:00
    for seed in range(20):
        at, deadline, _, tier = sp.suggest(db, s, now=la(2026, 9, 14, 10, 30), rng=random.Random(seed))
        assert tier.name == "Rush"
        assert to_la(deadline) == datetime(2026, 9, 15, 10, 0, tzinfo=LA)      # 8 bh later
        # 50/72 .. 70/72 of a 24 h window, never past deadline minus the margin.
        assert la(2026, 9, 15, 2, 0) <= at <= deadline - sp.SLA_MARGIN, to_la(at)
    # A normal sample keeps the default tier.
    n = add_sample(db, sample_id="P-2", received=la(2026, 9, 14, 10, 0))
    _, d2, _, t2 = sp.suggest(db, n, now=la(2026, 9, 14, 10, 30), rng=random.Random(0))
    assert t2.name == "Standard" and to_la(d2) == datetime(2026, 9, 17, 10, 0, tzinfo=LA)
    invalidate_priority_cache()
    db.close()


def test_early_morning_receipt_is_clamped_inside_the_sla(session_factory):
    """Received 07:00: 24 bh ends Wed 17:00, while +70 clock hours is Thu
    05:00. The clamp is what keeps the suggestion inside the SLA."""
    db = session_factory()
    s = add_sample(db, received=la(2026, 9, 14, 7, 0))                          # Monday 07:00
    top = SimpleNamespace(uniform=lambda a, b: b)                               # always the 70 h end
    at, deadline, clamped, _ = sp.suggest(db, s, now=la(2026, 9, 14, 8, 0), rng=top)
    assert to_la(deadline) == datetime(2026, 9, 16, 17, 0, tzinfo=LA)
    assert clamped and to_la(at) == datetime(2026, 9, 16, 16, 0, tzinfo=LA)
    db.close()


def test_suggest_floors_at_now_when_already_late(session_factory):
    db = session_factory()
    s = add_sample(db, received=la(2026, 9, 1, 10, 0))
    now = la(2026, 9, 17, 10, 0)
    at, _, clamped, _tier = sp.suggest(db, s, now=now, rng=random.Random(0))
    assert clamped and at == now + timedelta(hours=1)
    db.close()


# ── rows ────────────────────────────────────────────────────────────────────

def test_process_override_only_while_pending(session_factory):
    db = session_factory()
    assert sp.process_override(db, "P-1") == {}
    add_row(db)
    assert sp.process_override(db, "P-1") == {"published_date_override": "09/19/2026"}
    sp.cancel_active(db, "P-1", 2, reason="test")
    assert sp.process_override(db, "P-1") == {}
    assert [r.status for r in rows(session_factory)] == ["cancelled"]
    db.close()


def test_one_pending_row_per_sample(session_factory):
    db = session_factory()
    add_row(db)
    with pytest.raises(IntegrityError):
        add_row(db)
    db.rollback()
    # create_pending replaces instead of colliding; a firing row blocks it.
    r = sp.create_pending(db, "P-1", la(2026, 9, 20, 10, 0), "09/20/2026", 2)
    assert r.status == "pending" and [x.status for x in rows(session_factory)] == ["cancelled", "pending"]
    r.status = "firing"
    db.commit()
    with pytest.raises(sp.PublishInProgress):
        sp.create_pending(db, "P-1", la(2026, 9, 21, 10, 0), "09/21/2026", 2)
    db.close()


# ── the job ─────────────────────────────────────────────────────────────────

def test_not_due_rows_are_left_alone(session_factory):
    db = session_factory(); add_sample(db); add_row(db, scheduled_at=la(2026, 9, 19, 10, 0)); db.close()
    publish = publish_stub([ok()])
    tick(session_factory, publish, la(2026, 9, 19, 9, 0))
    assert publish.calls == [] and rows(session_factory)[0].status == "pending"


def test_due_row_publishes_once_as_the_scheduling_user(session_factory):
    db = session_factory(); add_sample(db); add_row(db, by=2); db.close()
    publish = publish_stub([ok(warning="SENAITE still ready_for_initial_review")])
    assert tick(session_factory, publish, la(2026, 9, 19, 10, 1)) == ["scheduled_publish"]
    r = rows(session_factory)[0]
    assert r.status == "published" and r.fired_at == la(2026, 9, 19, 10, 1)
    assert r.last_error == "SENAITE still ready_for_initial_review"
    assert publish.calls == [("P-1", 2)]
    tick(session_factory, publish, la(2026, 9, 19, 10, 3))
    assert publish.calls == [("P-1", 2)]          # never fires twice
    assert open_flags(session_factory) == []


def test_publish_failure_marks_failed_and_flags_once(session_factory):
    db = session_factory(); add_sample(db); add_row(db); db.close()
    publish = publish_stub([SimpleNamespace(success=False, message="No draft COA found for sample P-1")])
    tick(session_factory, publish, la(2026, 9, 19, 10, 1))
    r = rows(session_factory)[0]
    assert r.status == "failed" and "No draft COA" in r.last_error
    flags = open_flags(session_factory)
    assert len(flags) == 1 and flags[0].type == sp.FLAG_TYPE and flags[0].assignee_id == 2
    # A second failed row on the same sample dedupes on the open flag.
    db = session_factory(); add_row(db, scheduled_at=la(2026, 9, 19, 10, 5)); db.close()
    tick(session_factory, publish_stub([HTTPException(503, "Integration Service unavailable")]),
         la(2026, 9, 19, 10, 6))
    assert [x.status for x in rows(session_factory)] == ["failed", "failed"]
    assert "Integration Service unavailable" in rows(session_factory)[1].last_error
    assert len(open_flags(session_factory)) == 1


def test_senaite_silent_reject_502_still_counts_as_published(session_factory):
    db = session_factory(); s = add_sample(db); pk = s.id
    add_row(db, created_at=la(2026, 9, 10, 15, 0))   # before the machine clock either way
    db.close()

    def publish_then_502(db, sample_id):
        db.add(LimsSubSampleEvent(lims_sample_pk=pk, event="coa_published", details={}, user_id=2))
        db.commit()
        raise HTTPException(502, "COA published in system but SENAITE silently rejected the 'publish' transition")
    tick(session_factory, publish_stub([publish_then_502]), la(2026, 9, 19, 10, 1))
    r = rows(session_factory)[0]
    assert r.status == "published" and "silently rejected" in r.last_error
    assert open_flags(session_factory) == []


def test_on_hold_blocks_the_fire(session_factory):
    from flags.models import FlagFlag
    db = session_factory(); add_sample(db); add_row(db)
    db.add(FlagType(slug="new_type_7", label="On Hold", color="#64748b", kind="issue",
                    is_blocking=False, sort_order=20, entity_types=[], is_builtin=False))
    db.add(FlagFlag(entity_type="sample", entity_id="P-1", kind="issue", type="new_type_7",
                    status="open", title="customer paying", created_by=1))
    db.commit(); db.close()
    publish = publish_stub([ok()])
    tick(session_factory, publish, la(2026, 9, 19, 10, 1))
    assert publish.calls == []
    r = rows(session_factory)[0]
    assert r.status == "failed" and r.last_error == "sample is On Hold"
    assert len([f for f in open_flags(session_factory) if f.type == sp.FLAG_TYPE]) == 1


def test_already_published_since_scheduling_cancels(session_factory):
    db = session_factory(); s = add_sample(db); add_row(db, created_at=la(2026, 9, 17, 15, 0))
    db.add(LimsSubSampleEvent(lims_sample_pk=s.id, event="coa_published", details={}, user_id=2,
                              created_at=la(2026, 9, 18, 9, 0)))
    db.commit(); db.close()
    publish = publish_stub([ok()])
    tick(session_factory, publish, la(2026, 9, 19, 10, 1))
    assert publish.calls == []
    assert rows(session_factory)[0].status == "cancelled"


def test_stale_firing_row_is_failed_on_the_next_tick(session_factory):
    db = session_factory(); add_sample(db); add_row(db, status="firing"); db.close()
    publish = publish_stub([])
    tick(session_factory, publish, la(2026, 9, 19, 10, 1))
    r = rows(session_factory)[0]
    assert r.status == "failed" and "restart" in r.last_error and publish.calls == []
    assert len(open_flags(session_factory)) == 1


def test_quiet_window_defers_due_rows(session_factory):
    db = session_factory(); add_sample(db); add_row(db, scheduled_at=la(2026, 9, 18, 22, 30)); db.close()
    publish = publish_stub([ok()])
    tick(session_factory, publish, la(2026, 9, 18, 23, 0))     # 23:00 lab: quiet
    tick(session_factory, publish, la(2026, 9, 19, 4, 59))
    assert publish.calls == [] and rows(session_factory)[0].status == "pending"
    tick(session_factory, publish, la(2026, 9, 19, 5, 0))
    assert publish.calls == [("P-1", 2)] and rows(session_factory)[0].status == "published"


def test_max_per_tick(session_factory):
    db = session_factory()
    for i in range(7):
        add_sample(db, sample_id=f"P-{i}")
        add_row(db, sample_id=f"P-{i}", scheduled_at=la(2026, 9, 19, 10, 0) + timedelta(minutes=i))
    db.close()
    publish = publish_stub([ok()] * 7)
    tick(session_factory, publish, la(2026, 9, 19, 11, 0))
    assert [c[0] for c in publish.calls] == ["P-0", "P-1", "P-2", "P-3", "P-4"]
    tick(session_factory, publish, la(2026, 9, 19, 11, 1))
    assert len(publish.calls) == 7


def test_cancel_active_keeps_history_and_reports_statuses(session_factory):
    db = session_factory(); add_sample(db)
    add_row(db, status="failed", scheduled_at=la(2026, 9, 18, 10, 0))
    add_row(db)
    assert sorted(sp.cancel_active(db, "P-1", 1, reason="published manually")) == ["failed", "pending"]
    assert [r.status for r in rows(session_factory)] == ["cancelled", "cancelled"]
    assert sp.active_for(db, "P-1") is None
    assert sp.cancel_active(db, "P-1", 1, reason="again") == []
    db.close()


def test_active_by_sample_serializes_with_z_timestamps(session_factory):
    db = session_factory(); add_sample(db); add_row(db); db.close()
    db = session_factory()
    out = sp.active_by_sample(db)
    assert out["P-1"]["status"] == "pending"
    assert out["P-1"]["scheduled_at"] == "2026-09-19T17:00:00Z"
    assert out["P-1"]["pdf_date"] == "09/19/2026"
    db.close()


# ── tiers beyond the 3-day default (USP 71 = 14 working days) ───────────────

def _usp71(db):
    """The prod shape once USP71 is attached: a 6720-minute tier on a group
    holding the USP 71 service (id 91). HPLC services (id 10) stay ungrouped,
    exactly like prod's Core HPLC group with zero members."""
    db.add(SlaTier(id=3, name="USP71", target_minutes=6720, business_hours_only=True))
    db.add(ServiceGroup(id=5, name="Sterility USP71", sla_tier_id=3))
    db.flush()
    db.execute(service_group_members.insert().values(service_group_id=5, analysis_service_id=91))
    db.commit()


def _line(db, sample, service_id, keyword):
    db.add(LimsAnalysis(lims_sample_pk=sample.id, analysis_service_id=service_id,
                        keyword=keyword, title=keyword))
    db.commit()


def test_usp71_only_sample_gets_the_14_day_window(session_factory):
    db = session_factory()
    _usp71(db)
    s = add_sample(db, received=la(2026, 9, 14, 10, 0))          # Monday
    _line(db, s, 91, "STERILITY-USP71")
    for seed in range(25):
        at, deadline, clamped, tier = sp.suggest(db, s, now=la(2026, 9, 14, 11, 0), rng=random.Random(seed))
        assert tier.name == "USP71"
        assert to_la(deadline) == datetime(2026, 10, 2, 10, 0, tzinfo=LA)   # 14 working days
        local = to_la(at)
        # 50/72 .. 70/72 of 336 open-day hours = 9.7 .. 13.6 working days out.
        assert datetime(2026, 9, 25, 10, 0, tzinfo=LA) <= local <= datetime(2026, 10, 2, 9, 0, tzinfo=LA), local
        assert at <= deadline and not sp.in_quiet_window(at, "America/Los_Angeles")
    db.close()


def test_mixed_sample_owes_the_fast_tier_first_and_the_slow_tier_after_a_publish(session_factory):
    db = session_factory()
    _usp71(db)
    s = add_sample(db, received=la(2026, 9, 14, 10, 0))
    _line(db, s, 10, "HPLC-PUR")            # ungrouped -> default tier is in play
    _line(db, s, 91, "STERILITY-USP71")
    assert sp.resolve_tier(db, s).name == "Standard"
    assert to_la(sp.sla_deadline(db, s)) == datetime(2026, 9, 17, 10, 0, tzinfo=LA)
    # The partial COA goes out; what remains is the USP 71 result.
    db.add(LimsSubSampleEvent(lims_sample_pk=s.id, event="coa_published", details={}, user_id=2))
    db.commit()
    assert sp.resolve_tier(db, s).name == "USP71"
    assert to_la(sp.sla_deadline(db, s)) == datetime(2026, 10, 2, 10, 0, tzinfo=LA)
    # No lines at all: the default tier.
    bare = add_sample(db, sample_id="P-9", received=la(2026, 9, 14, 10, 0))
    assert sp.resolve_tier(db, bare).name == "Standard"
    db.close()


def test_sla_window_hours(session_factory):
    db = session_factory()
    std = db.get(SlaTier, 1)
    assert sp.sla_window_hours(std, SCHEDULE) == 72.0                       # 1440 bh-min at 8 h/day
    assert sp.sla_window_hours(SlaTier(target_minutes=6720, business_hours_only=True), SCHEDULE) == 336.0
    assert sp.sla_window_hours(SlaTier(target_minutes=4320, business_hours_only=False), SCHEDULE) == 72.0
    assert sp.sla_window_hours(None, SCHEDULE) == 72.0
    db.close()


# ── the list page ───────────────────────────────────────────────────────────

def test_list_rows_orders_live_first_and_joins_sample_and_user(session_factory):
    db = session_factory()
    u = db.get(User, 2); u.first_name, u.last_name = "Dana", "Tech"
    add_sample(db, sample_id="P-1", client_title="Acme", client_order_number="7001")
    add_sample(db, sample_id="P-2")
    add_sample(db, sample_id="P-3")
    add_row(db, sample_id="P-1", scheduled_at=la(2026, 9, 21, 10, 0))                 # pending, later
    add_row(db, sample_id="P-2", scheduled_at=la(2026, 9, 19, 10, 0))                 # pending, sooner
    add_row(db, sample_id="P-3", status="failed")
    add_row(db, sample_id="P-3", status="published", scheduled_at=la(2026, 9, 10, 10, 0))
    add_row(db, sample_id="GONE-1", status="firing", by=None)                          # no registry row
    live = sp.list_rows(db)
    assert [(r["sample_id"], r["status"]) for r in live] == [
        ("GONE-1", "firing"), ("P-2", "pending"), ("P-1", "pending"), ("P-3", "failed")]
    p1 = next(r for r in live if r["sample_id"] == "P-1")
    assert (p1["client"], p1["order"], p1["created_by"]) == ("Acme", "7001", "Dana Tech")
    assert p1["received_at"].endswith("Z") and p1["scheduled_at"] == "2026-09-21T17:00:00Z"
    gone = live[0]
    assert gone["client"] is None and gone["created_by"] is None
    full = sp.list_rows(db, include_history=True)
    assert [r["status"] for r in full] == ["firing", "pending", "pending", "failed", "published"]
    db.close()
