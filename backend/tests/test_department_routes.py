"""Route-level tests for GET/POST/PATCH/DELETE /departments.

Covers the four routes added in Task 8: list ordering, create (incl.
duplicate-name guard), patch, and delete's three guards (404, is_system 400,
in-use 409 — via a service AND via a group pointing at the department).

Fixture mirrors test_analysis_service_routes.py.
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
        Department(name="Zeta", sort_order=1),
        Department(name="Analytical", sort_order=0),
        Department(name="Beta", sort_order=1),
    ])
    db.commit()

    resp = route_client.get("/departments")
    assert resp.status_code == 200
    names = [d["name"] for d in resp.json()]
    # sort_order=0 first, then sort_order=1 group alphabetically (Beta, Zeta)
    assert names == ["Analytical", "Beta", "Zeta"]


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
