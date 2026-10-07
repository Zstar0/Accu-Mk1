"""Tests for GET /reports/checkin-times.

Check-ins come from lims_samples.date_received (one record per received sample,
the same population as /reports/throughput). worksheet_items only lends the
priority, from the sample's vials. Runs against an in-memory SQLite session.
"""
from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main as main_module
from auth import get_current_user
from database import Base, get_db
from main import app
from models import LimsSample, Worksheet, WorksheetItem

client = TestClient(app)


@pytest.fixture
def db(monkeypatch):
    # The route runs in the TestClient's worker thread: share one connection.
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="lab@x")
    app.dependency_overrides[get_db] = lambda: s
    monkeypatch.setattr(main_module, "_test_order_senaite_ids", lambda: {"P-9"})
    try:
        yield s
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_db, None)
        s.close()


def _sample(db, sid, received, peptide=None, uid=None):
    db.add(LimsSample(sample_id=sid, date_received=received, peptide_name=peptide,
                      external_lims_uid=uid, status="received"))
    db.flush()


def _vial(db, vial_id, priority):
    ws = Worksheet(title="WS")
    db.add(ws)
    db.flush()
    db.add(WorksheetItem(worksheet_id=ws.id, sample_uid=f"wu-{vial_id}", sample_id=vial_id,
                         date_received=datetime(2026, 9, 1), priority=priority))
    db.flush()


def test_requires_auth():
    assert TestClient(app).get("/reports/checkin-times").status_code == 401


def test_one_record_per_received_sample_even_without_a_worksheet(db):
    _sample(db, "P-1", datetime(2026, 9, 2, 16, 0), "BPC-157", uid="u1")
    _sample(db, "P-2", datetime(2026, 9, 3, 17, 0), "TB-500")   # never on a worksheet
    _sample(db, "P-9", datetime(2026, 9, 4, 18, 0))             # test order
    _sample(db, "P-3", None)                                     # not received
    _vial(db, "P-1-S01", "normal")
    _vial(db, "P-1-S02", "expedited")
    body = client.get("/reports/checkin-times").json()
    assert [r["sample_id"] for r in body] == ["P-9", "P-2", "P-1"]   # newest first
    p1 = next(r for r in body if r["sample_id"] == "P-1")
    assert p1 == {"sample_id": "P-1", "sample_uid": "u1", "date_received": "2026-09-02T16:00:00Z",
                  "product_label": "BPC-157", "priority": "expedited", "is_test_order": False}
    p2 = next(r for r in body if r["sample_id"] == "P-2")
    assert p2["priority"] == "normal" and p2["sample_uid"].startswith("mk1:")
    assert next(r for r in body if r["sample_id"] == "P-9")["is_test_order"] is True


def test_from_to_are_inclusive_day_bounds(db):
    _sample(db, "P-1", datetime(2026, 8, 31, 23, 0))
    _sample(db, "P-2", datetime(2026, 9, 1, 0, 0))
    _sample(db, "P-3", datetime(2026, 9, 30, 23, 59))
    _sample(db, "P-4", datetime(2026, 10, 1, 0, 0))
    body = client.get("/reports/checkin-times?from=2026-09-01&to=2026-09-30").json()
    assert sorted(r["sample_id"] for r in body) == ["P-2", "P-3"]
