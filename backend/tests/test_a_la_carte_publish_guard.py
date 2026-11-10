"""Publish guard for a la carte COAs. Plan 4 Task 4: Publish refuses a flagged
(page1 "none") draft whose badge is IN REVIEW, because one ordered test has no
results yet. Every other draft publishes exactly as before, and a failed read
fails open."""
import asyncio
import json
import sqlite3
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import integration_db
import main

SID = "P-9602"


def _badge(**kw):
    base = {"generation_number": 3, "verification_code": "ALCT-9602"}
    base.update(kw)
    return base


def _patch_badge(monkeypatch, value=None, exc=None):
    def fake(sample_id):
        assert sample_id == SID
        if exc is not None:
            raise exc
        return value
    monkeypatch.setattr(integration_db, "fetch_publish_draft_badge", fake)


def test_refuses_in_review_flagged_draft(monkeypatch):
    _patch_badge(monkeypatch, _badge(page1="none", overall_status="IN REVIEW"))
    with pytest.raises(HTTPException) as ei:
        main._refuse_in_review_a_la_carte(SID)
    assert ei.value.status_code == 409
    assert "IN REVIEW" in ei.value.detail
    assert ei.value.detail == (
        "This a la carte COA (Gen #3, ALCT-9602) is IN REVIEW: a test has no "
        "results yet. Finish it, regenerate, then publish.")


@pytest.mark.parametrize("status", ["PASSED", "FAILED", "MEASURED"])
def test_allows_flagged_draft(monkeypatch, status):
    _patch_badge(monkeypatch, _badge(page1="none", overall_status=status))
    assert main._refuse_in_review_a_la_carte(SID) is None


def test_unflagged_in_review_draft_unchanged(monkeypatch):
    _patch_badge(monkeypatch, _badge(page1=None, overall_status="IN REVIEW"))
    assert main._refuse_in_review_a_la_carte(SID) is None


def test_no_draft_passes(monkeypatch):
    _patch_badge(monkeypatch, None)
    assert main._refuse_in_review_a_la_carte(SID) is None


def test_fails_open_on_read_error(monkeypatch):
    _patch_badge(monkeypatch, exc=RuntimeError("IS down"))
    assert main._refuse_in_review_a_la_carte(SID) is None


def test_publish_route_refuses_before_any_is_call(db_session, monkeypatch):
    import scheduled_publish
    monkeypatch.setattr(integration_db, "fetch_stale_draft_primary", lambda sid: None)
    monkeypatch.setattr(scheduled_publish, "has_pending", lambda db, sid: False)
    _patch_badge(monkeypatch, _badge(page1="none", overall_status="IN REVIEW"))

    def no_client(*a, **kw):
        raise AssertionError("httpx.AsyncClient constructed before the guard")
    monkeypatch.setattr(main.httpx, "AsyncClient", no_client)

    with pytest.raises(HTTPException) as ei:
        asyncio.run(main.publish_sample_coa(
            sample_id=SID, current_user=SimpleNamespace(id=1), db=db_session))
    assert ei.value.status_code == 409
    assert "IN REVIEW" in ei.value.detail


# The function's real SQL, run against sqlite (the _db() idiom from
# tests/test_api_reports_sync_grain.py). The query is plain ANSI.

class _SqliteCursor:
    def __init__(self, conn):
        self._cur = conn.cursor()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._cur.close()

    def execute(self, sql, params):
        self._cur.execute(sql.replace("%s", "?"), params)

    def fetchone(self):
        row = self._cur.fetchone()
        if row is None:
            return None
        return {d[0]: v for d, v in zip(self._cur.description, row)}


class _SqliteConn:
    def __init__(self, conn):
        self._conn = conn

    def cursor(self, cursor_factory=None):
        return _SqliteCursor(self._conn)


def _db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE coa_generations ("
        " id TEXT, sample_id TEXT, generation_number INTEGER,"
        " verification_code TEXT, status TEXT, coa_data TEXT,"
        " created_at TEXT, parent_generation_id TEXT)"
    )

    def gen(code, n, created, status="draft", parent=None, sample=SID, coa_data=None):
        conn.execute(
            "INSERT INTO coa_generations (id, sample_id, generation_number,"
            " verification_code, status, coa_data, created_at, parent_generation_id)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (code, sample, n, code, status, json.dumps(coa_data or {}), created, parent),
        )
    return conn, gen


def _patch_conn(monkeypatch, conn):
    @contextmanager
    def fake():
        yield _SqliteConn(conn)
    monkeypatch.setattr(integration_db, "get_integration_db", fake)


def test_fetch_publish_draft_badge_picks_newest_top_level_draft(monkeypatch):
    conn, gen = _db()
    gen("OLD", 1, "2026-11-01", coa_data={"page1": "none", "overall_status": "PASSED"})
    gen("NEW", 2, "2026-11-05",
        coa_data={"page1": "none", "overall_status": "IN REVIEW"})
    gen("CHILD", 1, "2026-11-08", parent="NEW",
        coa_data={"overall_status": "PASSED"})
    gen("PUB", 3, "2026-11-09", status="published",
        coa_data={"overall_status": "PASSED"})
    gen("OTHER", 9, "2026-11-09", sample="P-0001",
        coa_data={"overall_status": "FAILED"})
    _patch_conn(monkeypatch, conn)

    assert integration_db.fetch_publish_draft_badge(SID) == {
        "generation_number": 2, "verification_code": "NEW",
        "page1": "none", "overall_status": "IN REVIEW",
    }


def test_fetch_publish_draft_badge_none_without_draft(monkeypatch):
    conn, gen = _db()
    gen("PUB", 1, "2026-11-09", status="published")
    _patch_conn(monkeypatch, conn)
    assert integration_db.fetch_publish_draft_badge(SID) is None


def test_fetch_publish_draft_badge_unflagged_has_no_page1(monkeypatch):
    conn, gen = _db()
    gen("D", 1, "2026-11-09", coa_data={"overall_status": "IN REVIEW"})
    _patch_conn(monkeypatch, conn)
    badge = integration_db.fetch_publish_draft_badge(SID)
    assert badge["page1"] is None
    assert badge["overall_status"] == "IN REVIEW"
