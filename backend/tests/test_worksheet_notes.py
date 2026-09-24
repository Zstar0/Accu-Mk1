"""Worksheet notes: an append-only log, each note stamped by the server with
its author and time (Handler, 2026-09-23). The old free-text `worksheets.notes`
field is left as it is. In-memory SQLite + dependency overrides, no live stack.
"""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import User, Worksheet


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    db.add_all([
        User(id=1, email="guian@example.com", hashed_password="x", first_name="Guian", last_name="Hernandez"),
        User(id=2, email="cass@example.com", hashed_password="x"),
    ])
    db.commit()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _ws(db, status="open", notes=None):
    ws = Worksheet(title="PCR 09/23/2026", status=status, notes=notes)
    db.add(ws)
    db.commit()
    return ws


def _as_user(user_id):
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=user_id)


def test_a_note_is_stamped_with_its_author_and_time(client, db):
    ws = _ws(db)
    r = client.post(f"/worksheets/{ws.id}/notes", json={"body": "  Lot 42A master mix  "})
    assert r.status_code == 201, r.text
    note = r.json()
    assert note["body"] == "Lot 42A master mix"
    assert note["user_id"] == 1
    assert note["author"] == "Guian Hernandez"
    assert note["created_at"].endswith("Z")


def test_notes_come_back_in_order_with_the_worksheet(client, db):
    ws = _ws(db, notes='{"text": "typed before notes were logged"}')
    client.post(f"/worksheets/{ws.id}/notes", json={"body": "first"})
    _as_user(2)
    client.post(f"/worksheets/{ws.id}/notes", json={"body": "second"})
    body = client.get(f"/worksheets/{ws.id}").json()
    assert [(n["body"], n["author"]) for n in body["note_log"]] == [
        ("first", "Guian Hernandez"), ("second", "cass@example.com")]
    # The old free-text field is untouched.
    assert body["notes"] == '{"text": "typed before notes were logged"}'
    # The list endpoint carries the log too, and a worksheet with none has [].
    other = _ws(db)
    by_id = {w["id"]: w for w in client.get("/worksheets").json()}
    assert len(by_id[ws.id]["note_log"]) == 2
    assert by_id[other.id]["note_log"] == []


def test_empty_long_and_misplaced_notes_are_refused(client, db):
    ws = _ws(db)
    assert client.post(f"/worksheets/{ws.id}/notes", json={"body": "   "}).status_code == 400
    assert client.post(f"/worksheets/{ws.id}/notes", json={"body": "x" * 2001}).status_code == 400
    assert client.post("/worksheets/99999/notes", json={"body": "hi"}).status_code == 404
    done = _ws(db, status="completed")
    assert client.post(f"/worksheets/{done.id}/notes", json={"body": "hi"}).status_code == 409
    assert client.get(f"/worksheets/{ws.id}").json()["note_log"] == []
