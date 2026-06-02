"""Tests for GET /reports/turnaround.

The route is guarded by get_current_user (JWT) and reads the integration DB via
get_integration_db(). Auth is bypassed with a dependency override; get_integration_db
is monkeypatched with a fake context manager returning pre-pivoted rows, so we
exercise ISO serialization, null preservation, and the is_test_order passthrough
without a database.
"""
from datetime import datetime, timezone
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

import main as main_module
from auth import get_current_user
from main import app


client = TestClient(app)

_ORIG_GET_INT_DB = main_module.get_integration_db


def _dt(*args):
    return datetime(*args, tzinfo=timezone.utc)


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def execute(self, *_a, **_k):
        pass

    def fetchall(self):
        return self._rows


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def cursor(self, *_a, **_k):
        return _FakeCursor(self._rows)


def _use(rows):
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="lab@x")
    main_module.get_integration_db = lambda: _FakeConn(rows)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    main_module.get_integration_db = _ORIG_GET_INT_DB


def test_requires_auth():
    resp = client.get("/reports/turnaround")
    assert resp.status_code == 401


def test_serializes_milestones_and_flags_test_orders():
    rows = [
        # sample_id, ordered, received, submitted, verified, published, is_test
        ("P-1", _dt(2026, 1, 1, 0, 0, 0), _dt(2026, 1, 1, 12, 0, 0), _dt(2026, 1, 3), None, None, True),
        ("P-2", None, _dt(2026, 2, 1), _dt(2026, 2, 2), _dt(2026, 2, 5), _dt(2026, 2, 6), False),
    ]
    _use(rows)
    try:
        resp = client.get("/reports/turnaround")
    finally:
        _clear()
    assert resp.status_code == 200, resp.text
    body = {r["sample_id"]: r for r in resp.json()}

    p1 = body["P-1"]
    assert p1["ordered_at"] == "2026-01-01T00:00:00Z"
    assert p1["received_at"] == "2026-01-01T12:00:00Z"
    assert p1["submitted_at"] == "2026-01-03T00:00:00Z"
    assert p1["verified_at"] is None
    assert p1["published_at"] is None
    assert p1["is_test_order"] is True

    p2 = body["P-2"]
    assert p2["ordered_at"] is None
    assert p2["published_at"] == "2026-02-06T00:00:00Z"
    assert p2["is_test_order"] is False
