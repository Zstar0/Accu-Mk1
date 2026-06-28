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
    s.add(LimsSubSampleEvent(sub_sample_pk=v1.id, event="role_assigned",
          details={"from": "hplc", "to": "xtra", "kind_from": "variance", "kind_to": None}))
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
