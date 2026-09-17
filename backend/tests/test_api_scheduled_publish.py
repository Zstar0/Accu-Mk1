"""Routes for the scheduled COA publish + the Ready to Publish parking.

The regenerate step (`generate_sample_coa`) is patched: these tests cover the
route edges (validation, row lifecycle, undo on failure), not COA Builder.
"""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from datetime import datetime, time, timedelta, timezone
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main as main_module
import scheduled_publish as sp
from auth import get_current_user
from database import get_db
from main import app, SampleCOAActionResponse
from models import BusinessHoursConfig, LimsSample, LimsScheduledPublish, SlaTier, User
from ready_to_publish import FlagTypeIn, SampleIn, TierIn
from sla_engine import BusinessSchedule

client = TestClient(app)
LA = ZoneInfo("America/Los_Angeles")
PATH = "/wizard/senaite/samples/P-1/scheduled-publish"


def la(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=LA).astimezone(timezone.utc).replace(tzinfo=None)


@pytest.fixture
def factory():
    from database import Base
    import flags.models  # noqa: F401
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    f = sessionmaker(bind=engine)
    db = f()
    from flags.types_service import seed_builtins
    seed_builtins(db)
    db.add(User(id=1, email="admin@x", hashed_password="x", role="admin", is_active=True))
    db.add(BusinessHoursConfig(id=1, open_time=time(9, 0), close_time=time(17, 0),
                               timezone="America/Los_Angeles", working_days=[0, 1, 2, 3, 4]))
    db.add(SlaTier(id=1, name="Standard", target_minutes=1440, business_hours_only=True, is_default=True))
    db.add(LimsSample(sample_id="P-1", status="verified", date_received=datetime.utcnow() - timedelta(hours=6)))
    db.commit()
    db.close()
    return f


@pytest.fixture
def api(factory, monkeypatch):
    """Wire the app to the SQLite factory + a fake user; return a recorder
    for the patched generate step."""
    def _db():
        db = factory()
        try:
            yield db
        finally:
            db.close()
    monkeypatch.setitem(app.dependency_overrides, get_current_user, lambda: MagicMock(id=1, role="admin"))
    monkeypatch.setitem(app.dependency_overrides, get_db, _db)
    rec = {"calls": [], "overrides": [], "result": SampleCOAActionResponse(
        success=True, message="COA generated", verification_code="AB12-CD34")}

    async def fake_generate(sample_id, db, current_user):
        rec["calls"].append(sample_id)
        rec["overrides"].append(sp.process_override(db, sample_id))
        if isinstance(rec["result"], BaseException):
            raise rec["result"]
        return rec["result"]
    monkeypatch.setattr(main_module, "generate_sample_coa", fake_generate)
    import ready_to_publish_cache
    ready_to_publish_cache.invalidate()
    return rec


def rows(factory):
    db = factory()
    try:
        return db.execute(select(LimsScheduledPublish).order_by(LimsScheduledPublish.id)).scalars().all()
    finally:
        db.close()


def future(hours=48):
    """An ISO-Z time `hours` out, nudged out of the quiet window."""
    at = datetime.now(timezone.utc) + timedelta(hours=hours)
    while sp.in_quiet_window(at.replace(tzinfo=None), "America/Los_Angeles"):
        at += timedelta(hours=1)
    return at.isoformat().replace("+00:00", "Z")


def test_requires_auth(monkeypatch):
    # Another module can leave a get_current_user override behind in the full
    # run (the known auth-leakage class); assert against a clean override map.
    monkeypatch.delitem(app.dependency_overrides, get_current_user, raising=False)
    assert client.get(PATH).status_code == 401


def test_get_state_without_a_schedule(api):
    r = client.get(PATH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["schedule"] is None
    assert body["lab_timezone"] == "America/Los_Angeles"
    assert body["suggested_at"].endswith("Z") and body["sla_deadline"].endswith("Z")
    # Random inside its window and clamped for early-morning receipts, so only
    # the invariant is asserted: never past the deadline.
    assert isinstance(body["suggestion_clamped"], bool)
    assert body["suggested_at"] <= body["sla_deadline"]
    assert client.get("/wizard/senaite/samples/P-404/scheduled-publish").status_code == 404


@pytest.mark.parametrize("payload,code,needle", [
    ({"scheduled_at": "2030-01-01T10:00:00"}, 422, "timezone"),
    ({"scheduled_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}, 422, "at least"),
    ({"scheduled_at": datetime(2030, 1, 7, 23, 30, tzinfo=LA).isoformat()}, 422, "No publishing between"),
])
def test_post_validation(api, payload, code, needle):
    r = client.post(PATH, json=payload)
    assert r.status_code == code, r.text
    assert needle in r.text
    assert api["calls"] == []


def test_post_rejects_sub_samples(api):
    r = client.post("/wizard/senaite/samples/P-1-S01/scheduled-publish", json={"scheduled_at": future()})
    assert r.status_code == 403


def test_schedule_regenerates_with_the_scheduled_date(api, factory):
    at = future()
    r = client.post(PATH, json={"scheduled_at": at})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True and body["verification_code"] == "AB12-CD34"
    assert body["schedule"]["status"] == "pending"
    expected_pdf = sp.pdf_date(sp.to_naive_utc(datetime.fromisoformat(at.replace("Z", "+00:00"))),
                               "America/Los_Angeles")
    assert body["schedule"]["pdf_date"] == expected_pdf
    # The row existed BEFORE generate ran, so the draft got the override.
    assert api["overrides"] == [{"published_date_override": expected_pdf}]
    assert [x.status for x in rows(factory)] == ["pending"]
    # Rescheduling replaces the pending row.
    r = client.post(PATH, json={"scheduled_at": future(72)})
    assert r.status_code == 200 and [x.status for x in rows(factory)] == ["cancelled", "pending"]
    state = client.get(PATH).json()
    assert state["schedule"]["id"] == rows(factory)[1].id


def test_schedule_undoes_the_row_when_generate_fails(api, factory):
    api["result"] = SampleCOAActionResponse(success=False, message="COA aborted")
    r = client.post(PATH, json={"scheduled_at": future()})
    assert r.status_code == 200 and r.json()["success"] is False
    assert [x.status for x in rows(factory)] == ["cancelled"]
    api["result"] = HTTPException(422, {"message": "preflight blocked", "unresolved": []})
    r = client.post(PATH, json={"scheduled_at": future()})
    assert r.status_code == 422 and "preflight blocked" in r.text
    assert [x.status for x in rows(factory)] == ["cancelled", "cancelled"]
    assert client.get(PATH).json()["schedule"] is None


def test_schedule_409_while_firing(api, factory):
    db = factory()
    db.add(LimsScheduledPublish(sample_id="P-1", scheduled_at=datetime.utcnow(), pdf_date="01/01/2030",
                                status="firing", created_by_user_id=1))
    db.commit(); db.close()
    assert client.post(PATH, json={"scheduled_at": future()}).status_code == 409
    assert client.delete(PATH).status_code == 409
    assert api["calls"] == []


def test_cancel_pending_regenerates_with_todays_date(api, factory):
    client.post(PATH, json={"scheduled_at": future()})
    api["overrides"].clear()
    r = client.delete(PATH)
    assert r.status_code == 200, r.text
    assert r.json()["success"] is True and "today" in r.json()["message"]
    assert api["overrides"] == [{}]                     # row cancelled before generate ran
    assert [x.status for x in rows(factory)] == ["cancelled"]
    assert client.delete(PATH).status_code == 404


def test_dismiss_failed_does_not_regenerate(api, factory):
    db = factory()
    db.add(LimsScheduledPublish(sample_id="P-1", scheduled_at=datetime.utcnow(), pdf_date="01/01/2030",
                                status="failed", last_error="boom", created_by_user_id=1))
    db.commit(); db.close()
    assert client.get(PATH).json()["schedule"]["status"] == "failed"
    r = client.delete(PATH)
    assert r.status_code == 200 and "ismissed" in r.json()["message"]
    assert api["calls"] == []
    assert [x.status for x in rows(factory)] == ["cancelled"]


def test_manual_publish_hook_cancels_the_schedule(api, factory):
    client.post(PATH, json={"scheduled_at": future()})
    db = factory()
    main_module._after_publish_native(db, sample_id="P-1", pre_publish_status="verified",
                                      actor_user_id=1, senaite_actual_state="published",
                                      verification_code="AB12-CD34")
    db.close()
    assert [x.status for x in rows(factory)] == ["cancelled"]
    assert rows(factory)[0].last_error == "published manually"


# ── Ready to Publish parking ────────────────────────────────────────────────

SCHEDULE = BusinessSchedule(open_time=time(9, 0), close_time=time(17, 0), timezone="America/Los_Angeles",
                            working_days=frozenset({0, 1, 2, 3, 4}))


def _sample(pk, sid):
    return SampleIn(pk=pk, sample_id=sid, status="verified", order="7001", client="Acme",
                    email="lab@acme.test", date_received=datetime(2026, 9, 8, 16, 0), lot="L1",
                    analytes=("BPC-157",))


def _sched(sid, status):
    return {"id": 1, "sample_id": sid, "scheduled_at": "2026-09-19T17:00:00Z", "pdf_date": "09/19/2026",
            "status": status, "created_by_user_id": 1, "created_at": "2026-09-17T22:00:00Z",
            "fired_at": None, "last_error": None}


def test_ready_to_publish_parks_scheduled_rows(monkeypatch):
    inputs = {
        "samples": [_sample(1, "P-1"), _sample(2, "P-2"), _sample(3, "P-3")],
        "line_states_by_pk": {1: {"HPLC-PUR": "verified"}, 2: {"HPLC-PUR": "verified"}, 3: {"HPLC-PUR": "verified"}},
        "flags": [], "flag_types": [FlagTypeIn(slug="new_type_3", label="Ready for Publish", color="#088000")],
        "priorities": {}, "services_of": {},
        "tiers": [TierIn(id=1, name="Standard", target_minutes=1440, is_default=True)],
        "groups": [], "schedule": SCHEDULE, "holidays": frozenset(),
        "scheduled": {"P-2": _sched("P-2", "pending"), "P-3": _sched("P-3", "failed")},
    }

    def _fake_db():
        yield MagicMock()
    monkeypatch.setitem(app.dependency_overrides, get_current_user, lambda: MagicMock(id=1))
    monkeypatch.setitem(app.dependency_overrides, get_db, _fake_db)
    monkeypatch.setattr(main_module, "_load_ready_to_publish_inputs", lambda db: inputs)
    monkeypatch.setattr(main_module, "_test_order_senaite_ids", lambda: set())
    import ready_to_publish_cache
    ready_to_publish_cache.invalidate()
    body = client.get("/reports/ready-to-publish").json()
    by = {r["sample_id"]: r for r in body["rows"]}
    assert by["P-1"]["scheduled"] is None
    assert by["P-2"]["scheduled"]["status"] == "pending" and by["P-2"]["scheduled"]["pdf_date"] == "09/19/2026"
    assert by["P-3"]["scheduled"]["status"] == "failed"
    # pending parked; failed stays live and counted.
    assert body["totals"]["rows"] == 2 and body["totals"]["scheduled"] == 1 and body["totals"]["held"] == 0
    assert client.get("/reports/ready-to-publish/summary").json()["totals"]["scheduled"] == 1
