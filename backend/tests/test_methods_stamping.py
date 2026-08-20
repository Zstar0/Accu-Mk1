"""Slice 2 (bench stamping) — Task 1: worksheet_items.instrument_id local FK leg.
Harness copied verbatim from tests/test_methods_catalog.py (in-memory SQLite +
TestClient, same idiom as tests/test_manage_native_routes.py)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import models  # noqa: F401
from database import Base


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _client(db_session, admin=True):
    from unittest.mock import MagicMock

    from fastapi.testclient import TestClient

    from auth import get_current_user
    from database import get_db
    from main import app

    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, role="admin" if admin else "standard", email="admin@test")

    tc = TestClient(app)
    yield tc

    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user


@pytest.fixture
def client(db_session):
    yield from _client(db_session, admin=True)


def test_worksheet_item_instrument_id_roundtrip(client, db_session):
    from models import Instrument, Worksheet, WorksheetItem
    inst = Instrument(name="Agilent 7900 ICP-MS", origin="mk1", active=True)
    ws = Worksheet(title="hm#1", status="open")
    db_session.add_all([inst, ws]); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-1", sample_id="PB-1-S01")
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"instrument_id": inst.id})
    assert r.status_code == 200
    listed = client.get("/worksheets").json()
    item = listed[0]["items"][0]
    assert item["instrument_id"] == inst.id


def test_worksheet_item_instrument_id_rejects_unknown_instrument(client, db_session):
    from models import Worksheet, WorksheetItem
    ws = Worksheet(title="hm#2", status="open")
    db_session.add(ws); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-2", sample_id="PB-2-S01")
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"instrument_id": 999999})
    assert r.status_code == 400


def test_worksheet_item_instrument_id_clear_to_null(client, db_session):
    from models import Instrument, Worksheet, WorksheetItem
    inst = Instrument(name="Waters Alliance HPLC", origin="mk1", active=True)
    ws = Worksheet(title="hm#3", status="open")
    db_session.add_all([inst, ws]); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-3", sample_id="PB-3-S01",
                       instrument_id=inst.id)
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"instrument_id": None})
    assert r.status_code == 200
    listed = client.get("/worksheets").json()
    item = listed[0]["items"][0]
    assert item["instrument_id"] is None


def test_worksheet_item_instrument_id_omitted_is_noop(client, db_session):
    from models import Instrument, Worksheet, WorksheetItem
    inst = Instrument(name="Waters Alliance HPLC", origin="mk1", active=True)
    ws = Worksheet(title="hm#3b", status="open")
    db_session.add_all([inst, ws]); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-3b", sample_id="PB-3B-S01",
                       instrument_id=inst.id)
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"prep_status": "in_progress"})
    assert r.status_code == 200
    listed = client.get("/worksheets").json()
    item = listed[0]["items"][0]
    assert item["instrument_id"] == inst.id


def test_worksheet_item_instrument_uid_leg_untouched(client, db_session):
    """R0: instrument_uid (SENAITE leg) and instrument_id (local FK leg) are
    independent — setting one must not disturb the other."""
    from models import Instrument, Worksheet, WorksheetItem
    inst = Instrument(name="Agilent 7900 ICP-MS", origin="mk1", active=True)
    ws = Worksheet(title="hm#4", status="open")
    db_session.add_all([inst, ws]); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-4", sample_id="PB-4-S01",
                       instrument_uid="senaite-uid-abc")
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"instrument_id": inst.id})
    assert r.status_code == 200
    listed = client.get("/worksheets").json()
    item = listed[0]["items"][0]
    assert item["instrument_id"] == inst.id
    assert item["instrument_uid"] == "senaite-uid-abc"
