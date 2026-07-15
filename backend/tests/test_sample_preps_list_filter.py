"""Server-side status filtering for GET /sample-preps.

Root cause (2026-07-14): the Sample Preps page fetched the newest-100 preps
and hid completed statuses CLIENT-side, so active preps older than the
newest-100 window silently vanished from the list (38 hidden in prod at
diagnosis: 23 awaiting_hplc + 15 on_hold). Search bypassed the window via
ILIKE, which is why searched items were findable but absent from the list.

Tests:
  1. mk1_db.list_sample_preps(exclude_statuses=[...]) adds a NOT-ANY status
     condition with the list as a bind param.
  2. Without exclude_statuses the SQL is unchanged (no status condition).
  3. GET /sample-preps?exclude_statuses=a,b,c parses the comma list and
     forwards it to mk1_db.list_sample_preps.
  4. GET /sample-preps without the param forwards exclude_statuses=None
     (existing callers unaffected).
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import mk1_db
from auth import get_current_user
from main import app


# ─── mk1_db SQL-builder tests ─────────────────────────────────────────────────


class _FakeCursor:
    def __init__(self, log):
        self._log = log

    def execute(self, query, params=None):
        self._log.append((query, params))

    def fetchall(self):
        return []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeConn:
    def __init__(self, log):
        self._log = log

    def cursor(self, cursor_factory=None):
        return _FakeCursor(self._log)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.fixture
def sql_log(monkeypatch):
    log: list[tuple[str, list]] = []
    monkeypatch.setattr(mk1_db, "get_mk1_db", lambda: _FakeConn(log))
    return log


def test_exclude_statuses_adds_not_any_condition(sql_log):
    excluded = ["hplc_complete", "completed", "curve_created"]
    mk1_db.list_sample_preps(exclude_statuses=excluded)
    assert len(sql_log) == 1
    query, params = sql_log[0]
    assert "NOT (status = ANY(%s))" in query
    assert excluded in params


def test_no_exclude_statuses_leaves_sql_unchanged(sql_log):
    mk1_db.list_sample_preps()
    query, params = sql_log[0]
    assert "status" not in query.lower().replace("order by", "")
    # params are just limit + offset
    assert params == [100, 0]


# ─── Endpoint param-forwarding tests ──────────────────────────────────────────


@pytest.fixture
def client():
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_current_user] = lambda: MagicMock()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


def test_endpoint_forwards_exclude_statuses(client):
    with patch("mk1_db.ensure_sample_preps_table"), patch(
        "mk1_db.list_sample_preps", return_value=[]
    ) as listed:
        resp = client.get(
            "/sample-preps?exclude_statuses=hplc_complete,completed,curve_created&limit=500"
        )
    assert resp.status_code == 200
    listed.assert_called_once_with(
        search=None,
        is_standard=None,
        limit=500,
        offset=0,
        exclude_statuses=["hplc_complete", "completed", "curve_created"],
    )


def test_endpoint_default_has_no_exclusions(client):
    with patch("mk1_db.ensure_sample_preps_table"), patch(
        "mk1_db.list_sample_preps", return_value=[]
    ) as listed:
        resp = client.get("/sample-preps")
    assert resp.status_code == 200
    listed.assert_called_once_with(
        search=None, is_standard=None, limit=100, offset=0, exclude_statuses=None
    )
