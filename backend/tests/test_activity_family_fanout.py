from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from database import Base, get_db
from auth import get_current_user
from models import LimsSample, LimsSubSample, LimsSubSampleEvent


@pytest.fixture
def seeded_client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestingSession = sessionmaker(bind=engine)
    s = TestingSession()
    parent = LimsSample(sample_id="P-7000", status="received")
    s.add(parent); s.flush()
    v1 = LimsSubSample(sample_id="P-7000-S01", external_lims_uid="SENAITE-7000-S01",
                       parent_sample_pk=parent.id, vial_sequence=1,
                       assignment_role="hplc", assignment_kind="variance")
    s.add(v1); s.flush()
    s.add(LimsSubSampleEvent(
        sub_sample_pk=v1.id, event="role_assigned",
        details={"from": "hplc", "to": "xtra", "kind_from": "variance", "kind_to": None},
        created_at=datetime(2026, 8, 1, 12, 0, 0),
    ))
    # Task 7: a parent-hosted event, seeded strictly NEWER than the vial
    # event above so the fan-out ordering assertion is unambiguous.
    s.add(LimsSubSampleEvent(
        lims_sample_pk=parent.id, event="parent_analysis_verified",
        details={"keyword": "PURITY-HPLC", "analysis_id": 999, "service_origin": "mk1"},
        created_at=datetime(2026, 8, 1, 13, 0, 0),
    ))
    s.commit(); s.close()

    def _override_get_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: type("U", (), {"id": 1, "email": "t@t"})()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)


def test_parent_activity_includes_family_vial_events(seeded_client):
    r = seeded_client.get("/samples/P-7000/activity")
    assert r.status_code == 200
    role_events = [e for e in r.json()["events"] if e["event"] == "role_assigned"]
    assert role_events, "parent flyout must surface vial assignment events"
    e = role_events[0]
    assert e["details"]["vial"] == "P-7000-S01"
    assert "Variance" in e["label"] and "Extra" in e["label"]


def test_parent_activity_fans_out_parent_hosted_events_newest_first(seeded_client):
    """Task 7: a parent-hosted event (lims_sample_pk) must appear in the
    family activity feed alongside vial-hosted ones (sub_sample_pk), merged
    into the same reverse-chronological order — not a separate or omitted
    stream."""
    r = seeded_client.get("/samples/P-7000/activity")
    assert r.status_code == 200
    events = r.json()["events"]

    ordered_names = [
        e["event"] for e in events
        if e["event"] in ("role_assigned", "parent_analysis_verified")
    ]
    assert ordered_names == ["parent_analysis_verified", "role_assigned"], (
        "the parent-hosted event was seeded newer and must sort ahead of "
        "the vial-hosted one"
    )

    parent_event = next(e for e in events if e["event"] == "parent_analysis_verified")
    assert parent_event["details"]["keyword"] == "PURITY-HPLC"
    assert parent_event["details"]["analysis_id"] == 999
    assert parent_event["details"]["service_origin"] == "mk1"
    assert "vial" not in parent_event["details"]
