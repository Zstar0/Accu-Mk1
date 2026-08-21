"""Transfer lineage readback — mirrors the retest-info endpoint.

Auth: the endpoint sits behind get_current_user, same as get_sample_retest_info
(source_order_id/source_user_id is cross-account ownership data). Tests
authenticate via the dependency-override convention used elsewhere in this
suite (see tests/test_workflow_catalog_api.py's `client` fixture and
test_requires_authentication) — not real JWTs, no such fixture exists in
conftest.py.

The override is applied per-test via a fixture, not once at module import:
dependency_overrides is a single global dict shared across every test file in
the run, and other files' fixtures clear/restore it between tests. A
module-level override set once at import time gets wiped out by whichever
other test file's teardown runs first — caught by running this file as part
of the full suite, not in isolation.
"""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import MagicMock

import main
from auth import get_current_user


@pytest.fixture
def client():
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[get_current_user] = (
        lambda: MagicMock(id=1, email="t@t"))
    tc = TestClient(main.app)
    yield tc
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(prev)


def test_non_transferred_sample_reports_false(client):
    resp = client.get("/samples/P-0301/transfer-info")
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_transfer"] is False
    assert body["source_sample_id"] is None
    assert body["transferred_as"] == []


def test_response_shape_is_stable(client):
    body = client.get("/samples/P-0301/transfer-info").json()
    for key in (
        "is_transfer",
        "source_sample_id",
        "source_order_id",
        "source_user_id",
        "transferred_as",
    ):
        assert key in body, f"missing key {key}"


def test_missing_migration_returns_degraded_shell(client, monkeypatch):
    """Environments where w1x2y3z4a5b6 isn't applied (deploy-order tolerance)
    get the designed all-empty shell — the ONLY failure allowed to degrade
    silently after the Task 9 narrowing."""
    import psycopg2.errors

    conn = MagicMock()
    cursor = MagicMock()
    cursor.execute.side_effect = psycopg2.errors.UndefinedColumn(
        'column os.is_transfer does not exist')
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=False)
    conn.cursor.return_value.__enter__ = MagicMock(return_value=cursor)
    conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
    monkeypatch.setattr(main, "get_integration_db", lambda: conn)

    resp = client.get("/samples/P-0301/transfer-info")
    assert resp.status_code == 200
    assert resp.json()["is_transfer"] is False


def test_connection_failure_is_503_not_a_false_negative(client, monkeypatch):
    """Task 9 carried-forward verification #5: once the migration is applied,
    the endpoint must stop swallowing connection/query failures — answering
    "not a transfer" when the truth is unknown is a lie about lineage."""
    import psycopg2

    def refuse():
        raise psycopg2.OperationalError("connection refused")
    monkeypatch.setattr(main, "get_integration_db", refuse)

    resp = client.get("/samples/BW-0014/transfer-info")
    assert resp.status_code == 503


def test_requires_authentication():
    """No auth at all (get_current_user not overridden) — the router-level
    get_current_user gate rejects with 401. Guards against a future refactor
    silently dropping the Depends(get_current_user) parameter — this endpoint
    returns cross-account ownership data (source_order_id/source_user_id) and
    must stay gated exactly like get_sample_retest_info."""
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides.clear()
    try:
        unauth_client = TestClient(main.app)
        resp = unauth_client.get("/samples/P-0301/transfer-info")
        assert resp.status_code == 401
    finally:
        main.app.dependency_overrides.clear()
        main.app.dependency_overrides.update(prev)
