"""The routes that take worksheet row locks (endo slice 5 final review C1).
They run in FastAPI's threadpool, so a lock wait never blocks the event
loop, and they roll back before an error leaves them, so no FOR UPDATE lock
outlives a refused request while the session waits to be closed.
In-memory SQLite + dependency overrides, with test_endo_v2_worksheets.py's
helpers. SQLite ignores FOR UPDATE, so these pin the shape, not the waits."""
from inspect import iscoroutinefunction, unwrap
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main
from auth import get_current_user
from database import Base, get_db
from main import app
from models import Worksheet
from tests.test_endo_v2_worksheets import _count_sql, _row_world


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="qa@accumark.test")
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.mark.parametrize("method, path", [
    ("PATCH", "/worksheets/{worksheet_id}/items/{item_id}"),
    ("POST", "/worksheets/{worksheet_id}/complete"),
    ("PUT", "/worksheets/{worksheet_id}"),
    ("DELETE", "/worksheets/{worksheet_id}"),
    ("POST", "/worksheets/{worksheet_id}/reader-import"),
    ("POST", "/worksheets/{worksheet_id}/prep-rules/reapply"),
    # Not lock takers themselves, but their writes wait on the locks above (final re-review Q1).
    ("DELETE", "/worksheets/{worksheet_id}/items/{item_id}"),
    ("POST", "/worksheets/{worksheet_id}/items/{item_id}/reassign"),
    ("POST", "/worksheets/{worksheet_id}/apply-method-instrument"),
    ("PUT", "/worksheets/{worksheet_id}/reorder"),
])
def test_the_lock_taking_routes_run_in_the_threadpool(method, path):
    [route] = [r for r in app.routes
               if getattr(r, "path", None) == path and method in getattr(r, "methods", ())]
    # Both: a sync wrapper over an async route would still hand FastAPI a coroutine.
    assert not iscoroutinefunction(route.endpoint)
    assert not iscoroutinefunction(unwrap(route.endpoint))


@pytest.mark.parametrize("status, method, path, body, code", [
    # A refused bench save: after the worksheet, analysis and item locks.
    ("open", "PATCH", "/worksheets/{ws}/items/{item}", {"prep_form": "nope"}, 400),
    ("completed", "POST", "/worksheets/{ws}/complete", None, 400),
    ("completed", "PUT", "/worksheets/{ws}", {"endo_prep": "2ml"}, 409),
    ("completed", "POST", "/worksheets/{ws}/reader-import",
     {"file_name": "EndoScanV-Export.csv", "tests": []}, 409),
    ("staging", "POST", "/worksheets/{ws}/prep-rules/reapply", {"item_ids": []}, 404),
])
def test_a_refusal_after_a_lock_leaves_no_transaction_open(client, db, status, method, path,
                                                          body, code):
    ws, item, _, _ = _row_world(db)
    ws.status = status
    url = path.format(ws=ws.id, item=item.id)
    db.commit()
    assert not db.in_transaction()
    r = client.request(method, url, json=body)
    assert r.status_code == code, r.text
    # Rolled back inside the route, so no row lock waits for the session's close.
    assert not db.in_transaction()


def test_delete_takes_the_worksheet_lock_before_anything_else(client, db, monkeypatch):
    """Final review L110: the worksheet row first, as every writer of its
    analyses or items takes it (main._worksheet_for_update)."""
    ws, _, _, _ = _row_world(db)
    ws_id = ws.id
    db.commit()
    real, before = main._worksheet_for_update, []
    with _count_sql(db) as seen:
        monkeypatch.setattr(main, "_worksheet_for_update",
                            lambda session, wid: before.append(len(seen)) or real(session, wid))
        assert client.delete(f"/worksheets/{ws_id}").status_code == 200
    assert before == [0]
    assert db.get(Worksheet, ws_id) is None
