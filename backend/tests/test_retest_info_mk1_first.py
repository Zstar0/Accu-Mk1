"""GET /samples/{id}/retest-info answers from Mk1's own lineage columns first;
the Integration DB still contributes legacy entries Mk1 does not know (M5)."""
from datetime import datetime
from unittest.mock import MagicMock, patch

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


def _fake_is(fetchone=None, fetchall=()):
    cur = MagicMock()
    cur.fetchone.return_value = fetchone
    cur.fetchall.return_value = list(fetchall)
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    is_db = MagicMock()
    is_db.return_value.__enter__.return_value = conn
    return is_db


def test_mk1_lineage_wins_and_merges_legacy_is_entries(client, db_session):
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
    legacy = [
        {"new_sample_id": "P-3017", "order_id": "7920", "created_at": None},   # Mk1 already lists it
        {"new_sample_id": "P-2900", "order_id": "7001", "created_at": datetime(2026, 8, 1, 12, 0)},
    ]
    with patch("main.get_integration_db", _fake_is(fetchall=legacy)) as is_db:
        r = client.get("/samples/P-3017/retest-info")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["is_retest"] is True and body["source_sample_id"] == "P-2799"
        assert body["source"] == "mk1" and body["this_order_id"] == 7920
        assert body["retest_created_at"] == "2026-09-24T15:00:00Z"

        r = client.get("/samples/P-2799/retest-info")
        body = r.json()
        assert body["is_retest"] is False and body["source"] == "mk1"
        fwd, old = body["retested_as"]
        assert fwd["sample_id"] == "P-3017" and fwd["status"] == "sample_received"
        assert fwd["retest"] == ["hplcpurity_identity"] and fwd["carry"] == ["heavy_metals"]
        assert old == {"sample_id": "P-2900", "order_id": 7001, "created_at": "2026-08-01T12:00:00"}
    assert is_db.call_count == 2


def test_mk1_forward_only_takes_is_retest_lineage_from_the_is(client, db_session):
    db_session.add_all([
        LimsSample(sample_id="P-2500", external_lims_system="senaite", status="published"),
        LimsSample(sample_id="P-3100", external_lims_system="mk1", status="sample_due",
                   retest_of_sample_id="P-2500"),
    ])
    db_session.commit()
    is_row = {"order_id": "6000", "created_at": None, "retest_of_order_id": 5000,
              "source_sample_id": "P-2400"}
    with patch("main.get_integration_db", _fake_is(fetchone=is_row)):
        body = client.get("/samples/P-2500/retest-info").json()
    assert body["source"] == "mk1"
    assert body["is_retest"] is True and body["source_sample_id"] == "P-2400"
    assert body["source_order_id"] == 5000 and body["this_order_id"] == 6000
    assert [e["sample_id"] for e in body["retested_as"]] == ["P-3100"]


def test_is_failure_keeps_the_mk1_answer(client, db_session):
    db_session.add(LimsSample(sample_id="P-3200", external_lims_system="mk1",
                              retest_of_sample_id="P-3199"))
    db_session.commit()
    with patch("main.get_integration_db", side_effect=RuntimeError("IS down")):
        body = client.get("/samples/P-3200/retest-info").json()
    assert body["source"] == "mk1" and body["source_sample_id"] == "P-3199"


def test_no_mk1_lineage_falls_back_to_the_integration_db(client, db_session):
    db_session.add(LimsSample(sample_id="P-1000", external_lims_system="senaite", status="published"))
    db_session.commit()
    with patch("main.get_integration_db", side_effect=RuntimeError("no IS in tests")) as is_db:
        r = client.get("/samples/P-1000/retest-info")
    assert r.status_code == 200
    assert r.json()["source"] == "integration_db" and r.json()["is_retest"] is False
    is_db.assert_called_once()
