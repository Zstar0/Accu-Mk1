"""Tests for GET /reports/checkin-times.

The route is guarded by get_current_user (JWT) and reads worksheet_items via the
ORM get_db session. Auth is bypassed with a dependency override; the DB session is
replaced with a fake whose execute().scalars().all() returns crafted WorksheetItem
rows, so we exercise the dedup / product-label / ordering logic without a database.
"""
import json
from datetime import datetime
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

import main as main_module
from auth import get_current_user
from database import get_db
from main import app
from models import WorksheetItem


client = TestClient(app)

# Capture the real integration-DB-backed helper so we can restore it after each
# test. We patch it in _use() so tests never touch the integration DB.
_ORIG_TEST_IDS = main_module._test_order_senaite_ids


class _FakeScalars:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return _FakeScalars(self._rows)


class _FakeSession:
    def __init__(self, rows):
        self._rows = rows

    def execute(self, *_a, **_k):
        return _FakeResult(self._rows)


def _item(sample_uid, sample_id, dt, *, priority="normal", peptides=None):
    it = WorksheetItem()
    it.sample_uid = sample_uid
    it.sample_id = sample_id
    it.date_received = dt
    it.priority = priority
    it.analyses_json = (
        json.dumps([{"peptide_name": p} for p in peptides]) if peptides else None
    )
    return it


def _use(rows, test_ids=frozenset()):
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="lab@x")

    def _fake_db():
        yield _FakeSession(rows)

    app.dependency_overrides[get_db] = _fake_db
    # Avoid touching the integration DB; control which sample IDs are "test orders".
    main_module._test_order_senaite_ids = lambda: set(test_ids)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_db, None)
    main_module._test_order_senaite_ids = _ORIG_TEST_IDS


def test_requires_auth():
    resp = client.get("/reports/checkin-times")
    assert resp.status_code == 401


def test_returns_one_record_per_sample_with_merged_labels():
    """A sample with two analyses (two worksheet rows) collapses to one record."""
    rows = [
        _item("uid-1", "S-1", datetime(2026, 2, 11, 10, 30), peptides=["Semaglutide"]),
        _item("uid-1", "S-1", datetime(2026, 2, 11, 10, 30), peptides=["Tirzepatide"]),
        _item("uid-2", "S-2", datetime(2026, 2, 12, 14, 5), peptides=["BPC-157"]),
    ]
    _use(rows)
    try:
        resp = client.get("/reports/checkin-times")
    finally:
        _clear()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 2  # deduped by sample_uid
    by_uid = {r["sample_uid"]: r for r in body}
    assert set(by_uid["uid-1"]["product_label"].split(", ")) == {"Semaglutide", "Tirzepatide"}
    assert by_uid["uid-2"]["product_label"] == "BPC-157"
    # ISO UTC with trailing Z
    assert by_uid["uid-1"]["date_received"].endswith("Z")


def test_keeps_earliest_receive_time_per_sample():
    rows = [
        _item("uid-1", "S-1", datetime(2026, 2, 11, 16, 0)),
        _item("uid-1", "S-1", datetime(2026, 2, 11, 9, 15)),  # earlier
    ]
    _use(rows)
    try:
        resp = client.get("/reports/checkin-times")
    finally:
        _clear()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    assert body[0]["date_received"].startswith("2026-02-11T09:15:00")


def test_orders_by_date_received_desc():
    rows = [
        _item("uid-1", "S-1", datetime(2026, 2, 11, 10, 0)),
        _item("uid-2", "S-2", datetime(2026, 3, 1, 10, 0)),
        _item("uid-3", "S-3", datetime(2026, 1, 5, 10, 0)),
    ]
    _use(rows)
    try:
        resp = client.get("/reports/checkin-times")
    finally:
        _clear()
    body = resp.json()
    dates = [r["date_received"] for r in body]
    assert dates == sorted(dates, reverse=True)


def test_accepts_from_and_to_params():
    rows = [_item("uid-1", "S-1", datetime(2026, 2, 11, 10, 0), peptides=None)]
    _use(rows)
    try:
        resp = client.get("/reports/checkin-times", params={"from": "2026-01-01", "to": "2026-12-31"})
    finally:
        _clear()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body[0]["product_label"] is None


def test_flags_test_orders_by_sample_id():
    """is_test_order is set for samples whose senaite_id is in the test-order set."""
    rows = [
        _item("uid-1", "S-1", datetime(2026, 2, 11, 10, 0)),  # test
        _item("uid-2", "S-2", datetime(2026, 2, 12, 10, 0)),  # real
    ]
    _use(rows, test_ids={"S-1"})
    try:
        resp = client.get("/reports/checkin-times")
    finally:
        _clear()
    assert resp.status_code == 200, resp.text
    flags = {r["sample_id"]: r["is_test_order"] for r in resp.json()}
    assert flags == {"S-1": True, "S-2": False}
