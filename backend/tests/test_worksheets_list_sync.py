"""GET /worksheets must be a SYNC endpoint (threadpool), never `async def`.

Regression guard for the 2026-07-07 event-loop-blocking finding: the handler
body is ~2.5s of pure synchronous DB work with zero awaits, and the sample
details page fires it twice per load. As `async def` it ran ON uvicorn's
single event loop and froze every other request behind it — a 32ms flag GET
measured 5.3s while two /worksheets calls were in flight (prod probe). The
browser's HTTP/1.1 6-connection cap masked this until HTTP/2 was enabled at
the edge. As plain `def`, FastAPI runs it in the threadpool and concurrent
requests are unaffected.

Pure unit tests: in-memory SQLite + dependency overrides, no live stack.
"""
import asyncio
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main
from main import app
from auth import get_current_user
from database import Base, get_db
from models import Worksheet


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_list_worksheets_is_not_a_coroutine_function():
    """The load-bearing assertion: `async def` here freezes the event loop
    for the handler's full multi-second runtime. Keep it `def` unless the
    body becomes genuinely async end-to-end."""
    assert not asyncio.iscoroutinefunction(main.list_worksheets)


def test_list_worksheets_still_serves(client, db):
    """Sync conversion smoke: route resolves deps, excludes staging, filters."""
    db.add(Worksheet(title="WS Open", status="open"))
    db.add(Worksheet(title="WS Staging", status="staging"))
    db.add(Worksheet(title="WS Done", status="completed"))
    db.commit()

    r = client.get("/worksheets")
    assert r.status_code == 200
    titles = {ws["title"] for ws in r.json()}
    assert titles == {"WS Open", "WS Done"}  # staging excluded

    r = client.get("/worksheets?status=open")
    assert r.status_code == 200
    assert [ws["title"] for ws in r.json()] == ["WS Open"]
