"""Endo worksheet v2 schema (spec 2026-10-10 section 3). In-memory SQLite +
dependency overrides, the test_worksheet_endo_prep.py idiom. The Postgres
migration itself is covered by test_endo_v2_migration_pg.py."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import ConsumableType, HplcMethod, Instrument, Worksheet, method_consumables


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


def _cols(db, table):
    return {c["name"] for c in inspect(db.get_bind()).get_columns(table)}


def test_new_tables_and_columns_exist(db):
    assert {"id", "kind", "name", "manufacturer", "part_number", "instrument_id", "specs",
            "active", "origin", "created_at", "updated_at"} <= _cols(db, "consumable_types")
    assert _cols(db, "method_consumables") == {"method_id", "consumable_type_id", "kind", "is_default"}
    assert "run_parameters" in _cols(db, "hplc_methods")
    assert "serial_number" in _cols(db, "instruments")
    assert {"endo_prep", "cartridge_type_id", "endo_method_id"} <= _cols(db, "worksheets")
    assert {"prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps", "cartridge_type_id",
            "result_reading", "result_reader", "result_entered_at",
            "result_entered_by_user_id"} <= _cols(db, "worksheet_items")


def test_new_worksheet_defaults_to_2ml(db):
    ws = Worksheet(title="Endo 10/10/2026", status="open")
    db.add(ws)
    db.commit()
    db.refresh(ws)
    assert ws.endo_prep == "2ml"


def test_new_consumable_type_defaults(db):
    t = ConsumableType(kind="endo_cartridge", name="Endosafe 0.05")
    db.add(t)
    db.commit()
    db.refresh(t)
    assert (t.specs, t.active, t.origin) == ({}, True, "mk1")


def test_duplicate_instrument_serial_rejected_by_index(db):
    db.add_all([Instrument(name="MCS A", serial_number="SN-1"), Instrument(name="MCS B", serial_number=None),
                Instrument(name="MCS C", serial_number=None)])
    db.commit()  # two NULL serials are fine
    db.add(Instrument(name="MCS D", serial_number="SN-1"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_part_number_unique_per_manufacturer_by_index(db):
    db.add_all([
        ConsumableType(kind="endo_cartridge", name="A", manufacturer="CR", part_number="PTS2005"),
        ConsumableType(kind="endo_cartridge", name="B", manufacturer="Other", part_number="PTS2005"),
        ConsumableType(kind="endo_cartridge", name="C", part_number="X1"),
    ])
    db.commit()
    db.add(ConsumableType(kind="endo_cartridge", name="D", manufacturer=None, part_number="X1"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_one_default_per_method_per_kind_by_index(db):
    m = HplcMethod(name="Endotoxin", status="draft", active=False)
    a = ConsumableType(kind="endo_cartridge", name="A")
    b = ConsumableType(kind="endo_cartridge", name="B")
    db.add_all([m, a, b])
    db.flush()
    db.execute(method_consumables.insert().values(
        method_id=m.id, consumable_type_id=a.id, kind="endo_cartridge", is_default=True))
    with pytest.raises(IntegrityError):
        db.execute(method_consumables.insert().values(
            method_id=m.id, consumable_type_id=b.id, kind="endo_cartridge", is_default=True))
    db.rollback()


def test_delete_method_pinned_by_a_worksheet_is_refused(client, db):
    m = HplcMethod(name="Endotoxin", status="active", active=True)
    db.add(m)
    db.flush()
    db.add(Worksheet(title="Endo 10/10/2026", status="open", endo_method_id=m.id))
    db.commit()
    r = client.delete(f"/hplc/methods/{m.id}")
    assert r.status_code == 409, r.text
    assert "pinned" in r.json()["detail"]
    assert db.get(HplcMethod, m.id) is not None
