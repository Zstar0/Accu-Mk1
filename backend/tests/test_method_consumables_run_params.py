"""Method consumables and run parameters (endo worksheet v2, spec 2026-10-10
sections 3.3, 3.4 and 10). In-memory SQLite + dependency overrides, the
test_worksheet_endo_prep.py idiom."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from catalog.method_run_params import ENDO_RUN_PARAM_DEFAULTS, validate_run_parameters
from database import Base, get_db
from models import CatalogChangeLog, ConsumableType


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


def _cart(db, name, lam, active=True):
    t = ConsumableType(kind="endo_cartridge", name=name, specs={"sensitivity_eu_ml": lam}, active=active)
    db.add(t)
    db.commit()
    return t.id


def _draft(client, name="Endotoxin"):
    r = client.post("/hplc/methods", json={"name": name, "technique": "LAL"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _put(client, mid, links):
    return client.put(f"/hplc/methods/{mid}/consumables", json=links)


# --- method consumables ------------------------------------------------------


def test_draft_method_takes_a_replace_set_with_one_default(client, db):
    c05, c01, c005 = _cart(db, "Endosafe 0.05", 0.05), _cart(db, "Endosafe 0.01", 0.01), _cart(db, "Endosafe 0.005", 0.005)
    mid = _draft(client)
    assert client.get(f"/hplc/methods/{mid}/consumables").json() == []
    r = _put(client, mid, [{"consumable_type_id": c05, "is_default": True}, {"consumable_type_id": c01}])
    assert r.status_code == 200, r.text
    assert r.json() == [
        {"consumable_type_id": c01, "kind": "endo_cartridge", "name": "Endosafe 0.01",
         "specs": {"sensitivity_eu_ml": 0.01}, "active": True, "is_default": False},
        {"consumable_type_id": c05, "kind": "endo_cartridge", "name": "Endosafe 0.05",
         "specs": {"sensitivity_eu_ml": 0.05}, "active": True, "is_default": True},
    ]
    # Replace-set: the second PUT is the whole list.
    r = _put(client, mid, [{"consumable_type_id": c005, "is_default": True}])
    assert [(x["consumable_type_id"], x["is_default"]) for x in r.json()] == [(c005, True)]
    assert client.get(f"/hplc/methods/{mid}/consumables").json() == r.json()


def test_put_is_logged_including_a_change_of_default_alone(client, db):
    c05, c01 = _cart(db, "Endosafe 0.05", 0.05), _cart(db, "Endosafe 0.01", 0.01)
    mid = _draft(client)
    _put(client, mid, [{"consumable_type_id": c05, "is_default": True}, {"consumable_type_id": c01}])
    _put(client, mid, [{"consumable_type_id": c05}, {"consumable_type_id": c01, "is_default": True}])
    changes = [log.details["changed"] for log in db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "method", CatalogChangeLog.entity_pk == mid,
        CatalogChangeLog.action == "update").order_by(CatalogChangeLog.id)).scalars()]
    assert changes == [
        {"consumables": {"before": [], "after": sorted([c05, c01])}},
        {"consumable_defaults": {"before": [], "after": [c05]}},
        {"consumable_defaults": {"before": [c05], "after": [c01]}},
    ]


@pytest.mark.parametrize("verb", ["activate", "retire"])
def test_non_draft_method_consumables_are_409(client, db, verb):
    c05 = _cart(db, "Endosafe 0.05", 0.05)
    mid = _draft(client)
    _put(client, mid, [{"consumable_type_id": c05, "is_default": True}])
    client.post(f"/hplc/methods/{mid}/activate")
    if verb == "retire":
        client.post(f"/hplc/methods/{mid}/retire")
    r = _put(client, mid, [])
    assert r.status_code == 409
    assert "new revision" in r.json()["detail"]
    assert len(client.get(f"/hplc/methods/{mid}/consumables").json()) == 1


def test_put_rejects_bad_links_with_400(client, db):
    c05, c01 = _cart(db, "Endosafe 0.05", 0.05), _cart(db, "Endosafe 0.01", 0.01)
    old = _cart(db, "Old 0.25", 0.25, active=False)
    mid = _draft(client)
    for links in (
        [{"consumable_type_id": c05, "is_default": True}, {"consumable_type_id": c01, "is_default": True}],
        [{"consumable_type_id": 999}],
        [{"consumable_type_id": old}],
        [{"consumable_type_id": c05}, {"consumable_type_id": c05}],
    ):
        assert _put(client, mid, links).status_code == 400, links
    assert client.get(f"/hplc/methods/{mid}/consumables").json() == []
    assert client.get("/hplc/methods/999/consumables").status_code == 404
    assert _put(client, 999, []).status_code == 404


def test_new_revision_copies_consumables_with_default_and_run_parameters(client, db):
    c05, c01 = _cart(db, "Endosafe 0.05", 0.05), _cart(db, "Endosafe 0.01", 0.01)
    mid = _draft(client)
    _put(client, mid, [{"consumable_type_id": c05, "is_default": True}, {"consumable_type_id": c01}])
    client.put(f"/hplc/methods/{mid}", json={"run_parameters": {"endotoxin": {"cv_limit_pct": 20}}})
    client.post(f"/hplc/methods/{mid}/activate")
    r = client.post(f"/hplc/methods/{mid}/new-revision")
    assert r.status_code == 201, r.text
    rev2 = r.json()
    assert rev2["run_parameters"] == {"endotoxin": {"cv_limit_pct": 20}}
    links = client.get(f"/hplc/methods/{rev2['id']}/consumables").json()
    assert [(x["consumable_type_id"], x["is_default"]) for x in links] == [(c01, False), (c05, True)]
    # The source revision keeps its own links.
    assert len(client.get(f"/hplc/methods/{mid}/consumables").json()) == 2


# --- run parameters --------------------------------------------------------


@pytest.mark.parametrize("value", [
    [], "x", {"hplc": {}}, {"endotoxin": []}, {"endotoxin": {"water": 2}},
    {"endotoxin": {"std_total_dilution": 0}}, {"endotoxin": {"recon_water_ml": -2}},
    {"endotoxin": {"cv_limit_pct": True}}, {"endotoxin": {"cv_limit_pct": "25"}},
    {"endotoxin": {"cv_limit_pct": float("inf")}},
    {"endotoxin": {"spike_recovery_min_pct": 200, "spike_recovery_max_pct": 200}},
    {"endotoxin": {"spike_recovery_min_pct": 250}},   # above the default max of 200
    {"endotoxin": {"spike_recovery_max_pct": 40}},    # below the default min of 50
    {"endotoxin": {"std_total_dilution": 19}},
])
def test_validate_run_parameters_rejects(value):
    with pytest.raises(ValueError):
        validate_run_parameters(value)


def test_validate_run_parameters_accepts_and_normalizes():
    assert validate_run_parameters(None) is None
    assert validate_run_parameters({}) is None
    assert validate_run_parameters({"endotoxin": {}}) is None
    assert validate_run_parameters({"endotoxin": {"cv_limit_pct": None}}) is None
    assert validate_run_parameters({"endotoxin": {"std_total_dilution": 20, "recon_water_ml": None}}) == {
        "endotoxin": {"std_total_dilution": 20}}
    full = {"endotoxin": dict(ENDO_RUN_PARAM_DEFAULTS)}
    assert validate_run_parameters(full) == full


def test_put_method_sets_validates_and_clears_run_parameters(client, db):
    mid = _draft(client)
    r = client.put(f"/hplc/methods/{mid}", json={"run_parameters": {"endotoxin": {"std_total_dilution": 500}}})
    assert r.status_code == 200, r.text
    assert r.json()["run_parameters"] == {"endotoxin": {"std_total_dilution": 500}}
    listed = next(m for m in client.get("/hplc/methods").json() if m["id"] == mid)
    assert listed["run_parameters"] == {"endotoxin": {"std_total_dilution": 500}}
    r = client.put(f"/hplc/methods/{mid}", json={"run_parameters": {"endotoxin": {"std_total_dilution": 10}}})
    assert r.status_code == 400
    assert "std_total_dilution" in r.json()["detail"]
    r = client.put(f"/hplc/methods/{mid}", json={"run_parameters": None})
    assert r.status_code == 200 and r.json()["run_parameters"] is None
    logs = db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "method", CatalogChangeLog.entity_pk == mid,
        CatalogChangeLog.action == "update")).scalars().all()
    assert [log.details["changed"]["run_parameters"]["after"] for log in logs] == [
        {"endotoxin": {"std_total_dilution": 500}}, None]


def test_run_parameters_lock_once_issued(client, db):
    mid = _draft(client)
    client.post(f"/hplc/methods/{mid}/activate")
    r = client.put(f"/hplc/methods/{mid}", json={"run_parameters": {"endotoxin": {"cv_limit_pct": 20}}})
    assert r.status_code == 409
    assert "run_parameters" in r.json()["detail"]
