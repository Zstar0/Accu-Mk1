"""Consumables catalog API (endo worksheet v2, spec 2026-10-10 sections 3.1,
3.2, 9 and 10). In-memory SQLite + dependency overrides, the
test_worksheet_endo_prep.py idiom."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from catalog.consumables import ConsumableSpecError, validate_specs
from database import Base, get_db
from models import CatalogChangeLog, Instrument, Worksheet, WorksheetItem

CART = {"kind": "endo_cartridge", "name": "Endosafe 0.05", "manufacturer": "Charles River",
        "part_number": "PTS2005", "specs": {"sensitivity_eu_ml": 0.05}}


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


def _create(client, **over):
    r = client.post("/consumables", json={**CART, **over})
    assert r.status_code == 201, r.text
    return r.json()


def _use_on_worksheet(db, type_id):
    ws = Worksheet(title="Endo 10/10/2026", status="open", cartridge_type_id=type_id)
    db.add(ws)
    db.commit()
    return ws


def _use_on_item(db, type_id):
    ws = Worksheet(title="Endo 10/11/2026", status="open")
    db.add(ws)
    db.flush()
    db.add(WorksheetItem(worksheet_id=ws.id, sample_uid="mk1://v1", sample_id="P-1-S02",
                         cartridge_type_id=type_id))
    db.commit()


def _logs(db, type_id):
    return db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "consumable_type",
        CatalogChangeLog.entity_pk == type_id).order_by(CatalogChangeLog.id)).scalars().all()


# --- registry ---------------------------------------------------------------


def test_kinds_endpoint_serves_the_registry(client):
    r = client.get("/consumables/kinds")
    assert r.status_code == 200
    assert r.json() == [{
        "key": "endo_cartridge", "label": "Endotoxin cartridge",
        "specs": [{"key": "sensitivity_eu_ml", "label": "Sensitivity", "unit": "EU/mL",
                   "type": "positive_float", "required": True}],
    }]


@pytest.mark.parametrize("specs", [
    {}, {"sensitivity_eu_ml": None}, {"sensitivity_eu_ml": 0}, {"sensitivity_eu_ml": -0.05},
    {"sensitivity_eu_ml": True}, {"sensitivity_eu_ml": "0.05"}, {"sensitivity_eu_ml": float("nan")},
    {"sensitivity_eu_ml": float("inf")}, {"sensitivity_eu_ml": 0.05, "lot": 7}, [0.05],
    {"sensitivity_eu_ml": 10**400},   # an int too big for a float: math.isfinite raises OverflowError
])
def test_validate_specs_rejects(specs):
    with pytest.raises(ConsumableSpecError):
        validate_specs("endo_cartridge", specs)


def test_validate_specs_rejects_unknown_kind_and_returns_floats():
    with pytest.raises(ConsumableSpecError, match="unknown kind"):
        validate_specs("pipette_tip", {})
    assert validate_specs("endo_cartridge", {"sensitivity_eu_ml": 1}) == {"sensitivity_eu_ml": 1.0}


# --- create -----------------------------------------------------------------


def test_create_returns_the_row_and_logs_it(client, db):
    inst = Instrument(name="Nexgen-MCS")
    db.add(inst)
    db.commit()
    body = _create(client, instrument_id=inst.id)
    assert {k: body[k] for k in ("kind", "name", "manufacturer", "part_number", "instrument_id",
                                 "specs", "active", "origin", "in_use")} == {
        "kind": "endo_cartridge", "name": "Endosafe 0.05", "manufacturer": "Charles River",
        "part_number": "PTS2005", "instrument_id": inst.id, "specs": {"sensitivity_eu_ml": 0.05},
        "active": True, "origin": "mk1", "in_use": False}
    [log] = _logs(db, body["id"])
    assert log.action == "create"
    assert log.details["changed"]["specs"]["after"] == {"sensitivity_eu_ml": 0.05}


@pytest.mark.parametrize("over", [
    {"kind": "pipette_tip"},
    {"specs": {}},
    {"specs": {"sensitivity_eu_ml": 0}},
    {"specs": {"sensitivity_eu_ml": 0.05, "lot": "A1"}},
    {"name": "   "},
    {"instrument_id": 999},
])
def test_create_rejects_bad_input_with_400(client, over):
    r = client.post("/consumables", json={**CART, **over})
    assert r.status_code == 400, r.text


def test_create_huge_int_spec_is_400_not_500(client):
    r = client.post("/consumables", json={**CART, "specs": {"sensitivity_eu_ml": 10**400}})
    assert r.status_code == 400, r.text
    assert "sensitivity_eu_ml" in r.json()["detail"]


def test_create_duplicate_kind_and_name_is_409(client):
    _create(client)
    r = client.post("/consumables", json={**CART, "part_number": "OTHER"})
    assert r.status_code == 409
    assert "already exists" in r.json()["detail"]


def test_part_number_unique_per_manufacturer(client):
    _create(client)
    r = client.post("/consumables", json={**CART, "name": "Copy"})
    assert r.status_code == 409
    assert "PTS2005" in r.json()["detail"]
    # Same part number, another manufacturer: fine.
    _create(client, name="Other make", manufacturer="Lonza")
    # No manufacturer counts as '' (the index's coalesce), so two blanks collide.
    _create(client, name="No make 1", manufacturer=None, part_number="X1")
    r = client.post("/consumables", json={**CART, "name": "No make 2", "manufacturer": "", "part_number": "X1"})
    assert r.status_code == 409


def test_blank_part_numbers_never_collide(client):
    _create(client, part_number="")
    body = _create(client, name="Endosafe 0.01", part_number="  ", specs={"sensitivity_eu_ml": 0.01})
    assert body["part_number"] is None


# --- edit, lock on use, retire ---------------------------------------------


def test_patch_unused_type_edits_specs_and_logs(client, db):
    t = _create(client)
    r = client.patch(f"/consumables/{t['id']}", json={"specs": {"sensitivity_eu_ml": 0.005}})
    assert r.status_code == 200, r.text
    assert r.json()["specs"] == {"sensitivity_eu_ml": 0.005}
    upd = _logs(db, t["id"])[-1]
    assert upd.action == "update"
    assert upd.details["changed"]["specs"] == {"before": {"sensitivity_eu_ml": 0.05},
                                               "after": {"sensitivity_eu_ml": 0.005}}


@pytest.mark.parametrize("use", [_use_on_worksheet, _use_on_item])
def test_used_type_locks_specs_and_kind(client, db, use):
    t = _create(client)
    use(db, t["id"])
    r = client.patch(f"/consumables/{t['id']}", json={"specs": {"sensitivity_eu_ml": 0.01}})
    assert r.status_code == 409
    assert "specs" in r.json()["detail"]
    db.expire_all()
    assert client.get("/consumables").json()[0]["specs"] == {"sensitivity_eu_ml": 0.05}


def test_used_type_names_both_locked_fields(client, db, monkeypatch):
    # A second kind, so a kind change can pass validation and reach the lock.
    from catalog import consumables
    monkeypatch.setitem(consumables.CONSUMABLE_KINDS, "endo_cartridge_b",
                        consumables.CONSUMABLE_KINDS["endo_cartridge"])
    t = _create(client)
    _use_on_worksheet(db, t["id"])
    r = client.patch(f"/consumables/{t['id']}", json={"kind": "endo_cartridge_b",
                                                      "specs": {"sensitivity_eu_ml": 0.01}})
    assert r.status_code == 409
    assert "kind, specs" in r.json()["detail"]


def test_used_type_accepts_unchanged_specs_and_other_fields(client, db):
    t = _create(client)
    _use_on_worksheet(db, t["id"])
    r = client.patch(f"/consumables/{t['id']}", json={
        "kind": "endo_cartridge", "specs": {"sensitivity_eu_ml": 0.05},
        "name": "Endosafe 0.05 (PTS)", "manufacturer": "CR", "part_number": "PTS2005-B"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["name"], body["part_number"], body["in_use"]) == ("Endosafe 0.05 (PTS)", "PTS2005-B", True)


def test_retire_and_rf4_retired_type_in_use_still_listed_with_specs(client, db):
    t = _create(client)
    _use_on_item(db, t["id"])
    r = client.patch(f"/consumables/{t['id']}", json={"active": False})
    assert r.status_code == 200, r.text
    assert r.json()["active"] is False
    retired = client.get("/consumables", params={"active": "false"}).json()
    assert [(row["id"], row["specs"], row["in_use"]) for row in retired] == [
        (t["id"], {"sensitivity_eu_ml": 0.05}, True)]
    assert client.get("/consumables", params={"active": "true"}).json() == []
    assert [row["id"] for row in client.get("/consumables").json()] == [t["id"]]
    assert _logs(db, t["id"])[-1].details["changed"]["active"] == {"before": True, "after": False}


def test_list_filters_by_kind(client):
    _create(client)
    assert len(client.get("/consumables", params={"kind": "endo_cartridge"}).json()) == 1
    assert client.get("/consumables", params={"kind": "pipette_tip"}).json() == []


def test_patch_rejects_nulls_bad_specs_duplicates_and_missing(client):
    a = _create(client)
    b = _create(client, name="Endosafe 0.01", part_number="PTS2001", specs={"sensitivity_eu_ml": 0.01})
    for body in ({"name": None}, {"name": " "}, {"kind": None}, {"specs": None}, {"active": None},
                 {"specs": {"sensitivity_eu_ml": -1}}, {"kind": "pipette_tip"}, {"instrument_id": 999}):
        assert client.patch(f"/consumables/{a['id']}", json=body).status_code == 400, body
    assert client.patch(f"/consumables/{a['id']}", json={"name": b["name"]}).status_code == 409
    assert client.patch(f"/consumables/{a['id']}", json={"part_number": "PTS2001"}).status_code == 409
    assert client.patch("/consumables/999", json={"name": "x"}).status_code == 404


def test_there_is_no_delete(client):
    t = _create(client)
    assert client.delete(f"/consumables/{t['id']}").status_code == 405


# --- lock through a method (final review fix wave) ----------------------------


def _use_on_method(client, type_id, status):
    """Link the type to a method left in `status`. The link goes in while the
    method is a draft: method consumables change only on drafts."""
    mid = client.post("/hplc/methods", json={"name": f"Endotoxin {status}",
                                             "technique": "LAL"}).json()["id"]
    r = client.put(f"/hplc/methods/{mid}/consumables",
                   json=[{"consumable_type_id": type_id, "is_default": True}])
    assert r.status_code == 200, r.text
    if status != "draft":
        assert client.post(f"/hplc/methods/{mid}/activate").status_code == 200
    if status == "retired":
        assert client.post(f"/hplc/methods/{mid}/retire").status_code == 200


@pytest.mark.parametrize("status", ["active", "retired"])
def test_a_type_behind_an_issued_method_locks_specs(client, db, status):
    # A cartridge behind an active or retired revision keeps the numbers that
    # revision was issued with: retire it and add a new one instead.
    t = _create(client)
    _use_on_method(client, t["id"], status)
    r = client.patch(f"/consumables/{t['id']}", json={"specs": {"sensitivity_eu_ml": 0.01}})
    assert r.status_code == 409
    assert "specs" in r.json()["detail"]
    assert [(row["id"], row["in_use"]) for row in client.get("/consumables").json()] == [
        (t["id"], True)]


def test_a_type_linked_only_to_a_draft_method_is_not_in_use(client, db):
    t = _create(client)
    _use_on_method(client, t["id"], "draft")
    assert [(row["id"], row["in_use"]) for row in client.get("/consumables").json()] == [
        (t["id"], False)]
    r = client.patch(f"/consumables/{t['id']}", json={"specs": {"sensitivity_eu_ml": 0.01}})
    assert r.status_code == 200, r.text
    assert r.json()["in_use"] is False
