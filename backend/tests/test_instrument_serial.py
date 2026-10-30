"""Instrument serial numbers (endo worksheet v2, spec 2026-10-10 sections 3.5
and 10): the reader import stamps the instrument by serial. In-memory SQLite +
dependency overrides, the test_worksheet_endo_prep.py idiom."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import CatalogChangeLog


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
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_create_and_list_carry_the_serial(client):
    r = client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": " NX-1234 "})
    assert r.status_code == 201, r.text
    assert r.json()["serial_number"] == "NX-1234"
    assert [i["serial_number"] for i in client.get("/instruments").json()] == ["NX-1234"]
    # Blank means none, so blanks never collide.
    assert client.post("/instruments", json={"name": "A", "serial_number": ""}).json()["serial_number"] is None
    assert client.post("/instruments", json={"name": "B", "serial_number": "  "}).json()["serial_number"] is None


def test_duplicate_serial_is_409_on_create_and_patch(client):
    client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": "NX-1234"})
    r = client.post("/instruments", json={"name": "Nexgen-MCS 2", "serial_number": "NX-1234"})
    assert r.status_code == 409
    assert "Nexgen-MCS" in r.json()["detail"]
    other = client.post("/instruments", json={"name": "Nexgen-MCS 2"}).json()
    r = client.patch(f"/instruments/{other['id']}", json={"serial_number": "NX-1234"})
    assert r.status_code == 409


def test_patch_sets_keeps_and_clears_the_serial(client):
    inst = client.post("/instruments", json={"name": "Nexgen-MCS"}).json()
    r = client.patch(f"/instruments/{inst['id']}", json={"serial_number": "NX-1234"})
    assert r.status_code == 200 and r.json()["serial_number"] == "NX-1234"
    # Re-sending its own serial is not a duplicate.
    r = client.patch(f"/instruments/{inst['id']}", json={"serial_number": "NX-1234", "brand": "Charles River"})
    assert r.status_code == 200, r.text
    r = client.patch(f"/instruments/{inst['id']}", json={"serial_number": None})
    assert r.status_code == 200 and r.json()["serial_number"] is None


def test_serial_changes_are_in_the_catalog_change_log(client, db):
    iid = client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": "NX-1"}).json()["id"]
    client.patch(f"/instruments/{iid}", json={"serial_number": "NX-2"})
    logs = db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "instrument", CatalogChangeLog.entity_pk == iid)
        .order_by(CatalogChangeLog.id)).scalars().all()
    assert logs[0].action == "create"
    assert logs[0].details["changed"]["serial_number"] == {"before": None, "after": "NX-1"}
    assert logs[1].details["changed"]["serial_number"] == {"before": "NX-1", "after": "NX-2"}


def test_overlong_serial_is_refused_before_the_database(client):
    # The column is VARCHAR(100): SQLite would store 101 characters, Postgres
    # would raise a 500. The schema refuses it with a 422 on both routes.
    r = client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": "X" * 101})
    assert r.status_code == 422, r.text
    inst = client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": "X" * 100}).json()
    assert inst["serial_number"] == "X" * 100
    r = client.patch(f"/instruments/{inst['id']}", json={"serial_number": "Y" * 101})
    assert r.status_code == 422, r.text
    assert client.get("/instruments").json()[0]["serial_number"] == "X" * 100


def test_nul_in_serial_is_refused_before_the_database(client):
    # Postgres rejects NUL in text, which would be a 500 on the duplicate lookup.
    r = client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": "NX-\u00001"})
    assert r.status_code == 422, r.text
    inst = client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": "NX-1"}).json()
    r = client.patch(f"/instruments/{inst['id']}", json={"serial_number": "NX-\u00002"})
    assert r.status_code == 422, r.text
    assert client.get("/instruments").json()[0]["serial_number"] == "NX-1"
