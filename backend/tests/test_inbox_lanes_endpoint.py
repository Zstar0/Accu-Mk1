"""GET /worksheets/inbox/lanes (spec 4, Task 10): catalog-driven worksheet-inbox
filter chips — one entry per department that owns >=1 vial role, via
catalog.roles.inbox_lanes(db). A thin HTTP wrapper; the lower-level
uniquify/collision/is_system-rename-guard behavior of inbox_lanes itself is
already covered by test_role_site_conversions.py — this file only proves the
route serializes it correctly and stays stable for the three legacy lanes.

NOTE: the task brief's literal 'GET /worksheet-inbox/lanes' is prose shorthand
— this repo's real convention (matching the sibling /worksheets/inbox/priority
and /worksheets/inbox/bulk routes already on this router) is
/worksheets/inbox/lanes. Implemented at that path; ledgered as a deviation
from the brief's exact string in the task report.

Fixture idiom copied from test_api_vial_roles.py's client/db_session
(StaticPool in-memory SQLite + get_db/get_current_user overrides) so this test
can seed the catalog and hit the real route end to end, including a live
POST /departments + POST /vial-roles round trip.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test"
    )
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


def _seed_catalog(db):
    from catalog.departments import backfill_departments
    from catalog.vial_roles_seed import seed_vial_roles
    backfill_departments(db)
    seed_vial_roles(db)


def test_legacy_lanes_are_stable_and_ordered(client, db_session):
    _seed_catalog(db_session)
    resp = client.get("/worksheets/inbox/lanes")
    assert resp.status_code == 200
    body = resp.json()
    # sort_order then key: hplc(0) < microbiology(min(endo=1,ster=2)=1) < hm(3)
    assert [lane["key"] for lane in body] == ["hplc", "microbiology", "hm"]
    lanes = {lane["key"]: lane for lane in body}
    assert lanes["hplc"]["label"] == "Analytical"
    assert lanes["hplc"]["role_codes"] == ["hplc"]
    assert lanes["hplc"]["sort_order"] == 0
    assert lanes["microbiology"]["label"] == "Microbiology"
    assert set(lanes["microbiology"]["role_codes"]) == {"endo", "ster"}
    assert lanes["hm"]["label"] == "Heavy Metals"
    assert lanes["hm"]["role_codes"] == ["hm"]


def test_new_department_and_role_appear_as_a_lane_legacy_keys_stable(client, db_session):
    _seed_catalog(db_session)
    dept = client.post("/departments", json={"name": "Tox Dept"}).json()
    created = client.post(
        "/vial-roles",
        json={"code": "tox", "label": "Toxicology", "department_id": dept["id"], "sort_order": 20},
    )
    assert created.status_code == 201

    resp = client.get("/worksheets/inbox/lanes")
    assert resp.status_code == 200
    lanes = {lane["key"]: lane for lane in resp.json()}

    # slugified from "Tox Dept" — new lane shows up, uses the department name
    # as its label (department_name, not the role's own label).
    assert "tox_dept" in lanes
    assert lanes["tox_dept"]["label"] == "Tox Dept"
    assert lanes["tox_dept"]["role_codes"] == ["tox"]
    assert lanes["tox_dept"]["sort_order"] == 20

    # legacy lanes untouched by the new department/role.
    assert lanes["hplc"]["role_codes"] == ["hplc"]
    assert set(lanes["microbiology"]["role_codes"]) == {"endo", "ster"}
    assert lanes["hm"]["role_codes"] == ["hm"]
