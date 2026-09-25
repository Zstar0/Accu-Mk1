"""GET /samples/{id}/retest-info answers from Mk1's own lineage columns first;
the Integration DB is only consulted when Mk1 has no lineage at all."""
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import auth
from database import Base, get_db
from main import app
from models import LimsSample


class _FakeUser:
    id = 1
    email = "test@accumark.test"


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


@pytest.fixture
def client(db_session):
    app.dependency_overrides[get_db] = lambda: (yield db_session)
    app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(auth.get_current_user, None)


def test_mk1_lineage_wins_and_skips_the_integration_db(client, db_session):
    db_session.add_all([
        LimsSample(sample_id="P-2799", external_lims_system="mk1", status="published"),
        LimsSample(sample_id="P-3017", external_lims_system="mk1", status="sample_received",
                   is_retest=True, retest_of_sample_id="P-2799", client_order_number="WP-7920",
                   catalog_snapshot={"profiles": [], "retest": {
                       "retest": ["hplcpurity_identity"], "carry": ["heavy_metals"],
                       "add": {"profiles": [], "variance_points": 0, "additional_vials": 0},
                       "requested_at": "2026-09-24T15:00:00Z"}}),
    ])
    db_session.commit()
    with patch("main.get_integration_db") as is_db:
        r = client.get("/samples/P-3017/retest-info")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["is_retest"] is True and body["source_sample_id"] == "P-2799"
        assert body["source"] == "mk1" and body["this_order_id"] == 7920
        assert body["retest_created_at"] == "2026-09-24T15:00:00Z"

        r = client.get("/samples/P-2799/retest-info")
        body = r.json()
        assert body["is_retest"] is False and body["source"] == "mk1"
        [fwd] = body["retested_as"]
        assert fwd["sample_id"] == "P-3017" and fwd["status"] == "sample_received"
        assert fwd["retest"] == ["hplcpurity_identity"] and fwd["carry"] == ["heavy_metals"]
    is_db.assert_not_called()


def test_no_mk1_lineage_falls_back_to_the_integration_db(client, db_session):
    db_session.add(LimsSample(sample_id="P-1000", external_lims_system="senaite", status="published"))
    db_session.commit()
    with patch("main.get_integration_db", side_effect=RuntimeError("no IS in tests")) as is_db:
        r = client.get("/samples/P-1000/retest-info")
    assert r.status_code == 200
    assert r.json()["source"] == "integration_db" and r.json()["is_retest"] is False
    is_db.assert_called_once()
