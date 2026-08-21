"""Route-level tests for GET/POST/PATCH/DELETE /departments.

Covers the four routes added in Task 8: list ordering, create (incl.
duplicate-name guard), patch, and delete's three guards (404, is_system 400,
in-use 409 — via a service AND via a group pointing at the department).

Fixture mirrors test_analysis_service_routes.py.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import AnalysisService, Department, ServiceGroup


@pytest.fixture
def route_client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared_session = Session()

    def _override_get_db():
        yield shared_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    tc = TestClient(app)
    tc._test_session = shared_session
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user
    shared_session.close()


def test_list_departments_ordered_by_sort_order_then_name(route_client):
    db = route_client._test_session
    db.add_all([
        # sort_order deliberately fights the alphabet: an order_by(name)-only
        # query would put Analytical first and Zeta last, the opposite of
        # what sort_order demands. Only a genuine ORDER BY sort_order, name
        # passes.
        Department(name="Analytical", sort_order=5),
        Department(name="Zeta", sort_order=0),
        Department(name="Beta", sort_order=0),
    ])
    db.commit()

    resp = route_client.get("/departments")
    assert resp.status_code == 200
    names = [d["name"] for d in resp.json()]
    # sort_order=0 group first, alphabetical within it (Beta, Zeta); then
    # sort_order=5 (Analytical) last.
    assert names == ["Beta", "Zeta", "Analytical"]


def test_create_department_201(route_client):
    resp = route_client.post(
        "/departments", json={"name": "Microbiology", "sort_order": 2, "color": "emerald"}
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Microbiology"
    assert body["sort_order"] == 2
    assert body["color"] == "emerald"
    assert body["is_system"] is False

    db = route_client._test_session
    assert db.get(Department, body["id"]) is not None


def test_create_department_duplicate_name_rejected(route_client):
    db = route_client._test_session
    db.add(Department(name="Analytical"))
    db.commit()

    resp = route_client.post("/departments", json={"name": "Analytical"})
    assert resp.status_code == 400


def test_patch_department_fields(route_client):
    db = route_client._test_session
    dept = Department(name="Analytical", sort_order=0, color="blue")
    db.add(dept)
    db.commit()

    resp = route_client.patch(
        f"/departments/{dept.id}",
        json={"name": "Analytical Chemistry", "sort_order": 5, "color": "rose"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Analytical Chemistry"
    assert body["sort_order"] == 5
    assert body["color"] == "rose"


def test_patch_department_not_found(route_client):
    resp = route_client.patch("/departments/999999", json={"name": "Nope"})
    assert resp.status_code == 404


def test_patch_department_rename_to_existing_name_rejected(route_client):
    """Department.name is unique=True — without an explicit guard this hits
    an unhandled IntegrityError at commit (opaque 500) instead of the same
    clean 400 create_department already gives for the identical user error."""
    db = route_client._test_session
    db.add_all([
        Department(name="Analytical"),
        Department(name="Microbiology"),
    ])
    db.commit()
    dept_b = db.execute(select(Department).where(Department.name == "Microbiology")).scalar_one()

    resp = route_client.patch(f"/departments/{dept_b.id}", json={"name": "Analytical"})
    assert resp.status_code == 400

    db.refresh(dept_b)
    assert dept_b.name == "Microbiology"


def test_patch_department_rename_to_own_current_name_succeeds(route_client):
    """The duplicate-name guard must exclude the row's own id — resubmitting
    the current name (e.g. a full-object-save that only changed sort_order)
    must not be mistaken for a collision with itself."""
    db = route_client._test_session
    dept = Department(name="Analytical", sort_order=0)
    db.add(dept)
    db.commit()

    resp = route_client.patch(
        f"/departments/{dept.id}", json={"name": "Analytical", "sort_order": 9}
    )
    assert resp.status_code == 200
    assert resp.json()["sort_order"] == 9


def test_patch_system_department_name_rejected(route_client):
    """is_system rows are load-bearing for the worksheet-inbox legacy lane
    keys (catalog.roles._LEGACY_LANE_KEYS) — a name change 400s (fix round,
    spec 4 Task 7)."""
    db = route_client._test_session
    dept = Department(name="Analytical", is_system=True)
    db.add(dept)
    db.commit()

    resp = route_client.patch(f"/departments/{dept.id}", json={"name": "Analytical Chemistry"})
    assert resp.status_code == 400
    assert "system department names" in resp.json()["detail"]
    db.refresh(dept)
    assert dept.name == "Analytical"


def test_patch_system_department_color_allowed(route_client):
    """is_system only locks `name` — color/sort_order stay editable."""
    db = route_client._test_session
    dept = Department(name="Analytical", is_system=True, color="blue")
    db.add(dept)
    db.commit()

    resp = route_client.patch(f"/departments/{dept.id}", json={"color": "rose", "sort_order": 3})
    assert resp.status_code == 200
    body = resp.json()
    assert body["color"] == "rose"
    assert body["sort_order"] == 3


def test_delete_department_204(route_client):
    db = route_client._test_session
    dept = Department(name="Unused")
    db.add(dept)
    db.commit()
    dept_id = dept.id

    resp = route_client.delete(f"/departments/{dept_id}")
    assert resp.status_code == 204
    assert db.get(Department, dept_id) is None


def test_delete_department_not_found(route_client):
    resp = route_client.delete("/departments/999999")
    assert resp.status_code == 404


def test_delete_system_department_rejected(route_client):
    db = route_client._test_session
    dept = Department(name="Core", is_system=True)
    db.add(dept)
    db.commit()

    resp = route_client.delete(f"/departments/{dept.id}")
    assert resp.status_code == 400
    assert db.get(Department, dept.id) is not None


def test_delete_department_in_use_by_service_rejected(route_client):
    db = route_client._test_session
    dept = Department(name="Analytical")
    db.add(dept)
    db.commit()
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1", department_id=dept.id)
    db.add(svc)
    db.commit()

    resp = route_client.delete(f"/departments/{dept.id}")
    assert resp.status_code == 409
    assert db.get(Department, dept.id) is not None


def test_delete_department_in_use_by_group_rejected(route_client):
    db = route_client._test_session
    dept = Department(name="Microbiology")
    db.add(dept)
    db.commit()
    group = ServiceGroup(name="Micro Panel", department_id=dept.id)
    db.add(group)
    db.commit()

    resp = route_client.delete(f"/departments/{dept.id}")
    assert resp.status_code == 409
    assert db.get(Department, dept.id) is not None
