"""Vial Roles admin API (spec 4, Task 2): the catalog-driven bench.

CRUD over the vial_roles table. code stays the DB join key on vials
(lims_sub_samples.assignment_role / lims_samples.assignment_role, VARCHAR(8));
this catalog is its editable face (label, department, bench flags).

xtra is the only role allowed a NULL department (the reserved unassigned
bucket) — POST/PATCH both refuse a NULL department for any other code.
frozen rows (a vial already references the code) refuse a code change but
stay otherwise editable. is_system rows can't be deleted at all; any other
row referenced by an AnalysisProfile.fulfillment_role, a vial's
assignment_role, or a LimsBox.role refuses with 409 naming what references it.

Fixture idiom copied from test_native_promote.py's `client`/`db_session`
(StaticPool in-memory SQLite + get_db/get_current_user dependency overrides,
snapshot/restore on teardown) — isolates each test's rows from the shared
suite DB and lets `db_session` seed rows the POST schema doesn't expose
(is_system, frozen) directly via the ORM.
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
from models import VialRole, AnalysisProfile, LimsBox, LimsSample, LimsSubSample


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


def test_post_creates_role_with_department(client, db_session):
    dep = client.post("/departments", json={"name": "Tox Dept"}).json()
    r = client.post("/vial-roles", json={"code": "tox", "label": "Toxicology", "department_id": dep["id"]})
    assert r.status_code == 201
    assert r.json()["code"] == "tox" and r.json()["boxable"] is False


def test_post_rejects_bad_code_format(client):
    assert client.post("/vial-roles", json={"code": "Bad-Code", "label": "x"}).status_code == 400
    assert client.post("/vial-roles", json={"code": "toolongcode", "label": "x"}).status_code == 400


def test_post_rejects_null_department_for_non_xtra(client):
    r = client.post("/vial-roles", json={"code": "orphan", "label": "No Dept"})
    assert r.status_code == 400  # deviation 2: only xtra may be department-less


def test_post_rejects_duplicate_code(client, db_session):
    dep = client.post("/departments", json={"name": "Dup Dept"}).json()
    first = client.post("/vial-roles", json={
        "code": "dupe", "label": "First", "department_id": dep["id"],
    })
    assert first.status_code == 201
    second = client.post("/vial-roles", json={
        "code": "dupe", "label": "Second", "department_id": dep["id"],
    })
    assert second.status_code == 400


def test_patch_rejects_null_department_for_non_xtra(client, db_session):
    # deviation 2 on the PATCH side: an explicit {"department_id": null} must
    # 400 for any role but xtra, same as POST — a silently-orphaned role
    # would fall out of real_bucket_codes() without anyone noticing.
    dep = client.post("/departments", json={"name": "Null Dept"}).json()
    role = client.post("/vial-roles", json={
        "code": "nullck", "label": "Null Check", "department_id": dep["id"],
    }).json()
    r = client.patch(f"/vial-roles/{role['id']}", json={"department_id": None})
    assert r.status_code == 400


def test_delete_refuses_system_and_referenced_roles(client, db_session):
    # is_system → 400; role referenced by a profile fulfillment_role or any
    # lims_sub_samples.assignment_role → 409 (department DELETE guard pattern, main.py:15594-15612)
    dep = client.post("/departments", json={"name": "Guard Dept"}).json()

    sys_role = VialRole(code="sysd", label="System Role", department_id=dep["id"], is_system=True)
    profile_ref_role = VialRole(code="pref", label="Profile Ref", department_id=dep["id"])
    vial_ref_role = VialRole(code="vref", label="Vial Ref", department_id=dep["id"])
    free_role = VialRole(code="free", label="Free Role", department_id=dep["id"])
    db_session.add_all([sys_role, profile_ref_role, vial_ref_role, free_role])
    db_session.flush()
    sys_id, profile_ref_id, vial_ref_id, free_id = (
        sys_role.id, profile_ref_role.id, vial_ref_role.id, free_role.id
    )

    db_session.add(AnalysisProfile(
        key="guard_profile", name="Guard Profile", is_addon=False, fulfillment_role="pref",
    ))
    parent = LimsSample(sample_id="P-9001")
    db_session.add(parent)
    db_session.flush()
    db_session.add(LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="uid-9001-s01",
        sample_id="P-9001-S01", vial_sequence=1, assignment_role="vref",
    ))
    db_session.commit()

    assert client.delete(f"/vial-roles/{sys_id}").status_code == 400

    profile_resp = client.delete(f"/vial-roles/{profile_ref_id}")
    assert profile_resp.status_code == 409
    assert "profile" in profile_resp.json()["detail"].lower()

    vial_resp = client.delete(f"/vial-roles/{vial_ref_id}")
    assert vial_resp.status_code == 409
    assert "vial" in vial_resp.json()["detail"].lower()

    assert client.delete(f"/vial-roles/{free_id}").status_code == 204


def test_delete_refuses_role_referenced_only_by_a_box_until_cleared(client, db_session):
    # Fourth reference clause: a LimsBox keyed to the role (box.role == code)
    # 409s the same as a profile/vial reference, naming the box; once the
    # box no longer references it, the delete succeeds.
    dep = client.post("/departments", json={"name": "Box Dept"}).json()
    box_role = VialRole(code="boxr", label="Box Ref", department_id=dep["id"])
    db_session.add(box_role)
    db_session.flush()
    box_role_id = box_role.id

    box = LimsBox(order_key="WP-90001", box_number=1, role="boxr")
    db_session.add(box)
    db_session.commit()

    resp = client.delete(f"/vial-roles/{box_role_id}")
    assert resp.status_code == 409
    assert "box" in resp.json()["detail"].lower()

    db_session.delete(box)
    db_session.commit()

    assert client.delete(f"/vial-roles/{box_role_id}").status_code == 204


def test_delete_refuses_role_referenced_only_by_a_parent_sample_until_cleared(client, db_session):
    # The LimsSample.assignment_role branch of the vial-reference OR-check
    # only runs when the LimsSubSample query comes back empty — prove it
    # actually 409s on its own (a parent sample with no sub-sample child),
    # not just that it's reachable dead code behind the sub-sample branch.
    dep = client.post("/departments", json={"name": "Parent Dept"}).json()
    parent_role = VialRole(code="parr", label="Parent Ref", department_id=dep["id"])
    db_session.add(parent_role)
    db_session.flush()
    parent_role_id = parent_role.id

    parent = LimsSample(sample_id="P-9002", assignment_role="parr")
    db_session.add(parent)
    db_session.commit()

    resp = client.delete(f"/vial-roles/{parent_role_id}")
    assert resp.status_code == 409
    assert "vial" in resp.json()["detail"].lower()

    db_session.delete(parent)
    db_session.commit()

    assert client.delete(f"/vial-roles/{parent_role_id}").status_code == 204


def test_patch_updates_flags_but_never_code_on_frozen(client, db_session):
    # frozen row: label/boxable/variance_eligible/sort_order editable, code immutable → 400 on code change
    dep = client.post("/departments", json={"name": "Patch Dept"}).json()
    frozen_role = VialRole(code="frzn", label="Frozen Role", department_id=dep["id"], frozen=True)
    db_session.add(frozen_role)
    db_session.commit()
    role_id = frozen_role.id

    ok = client.patch(f"/vial-roles/{role_id}", json={
        "label": "Frozen Role Renamed", "boxable": True,
        "variance_eligible": True, "sort_order": 5,
    })
    assert ok.status_code == 200
    body = ok.json()
    assert body["label"] == "Frozen Role Renamed"
    assert body["boxable"] is True
    assert body["variance_eligible"] is True
    assert body["sort_order"] == 5

    blocked = client.patch(f"/vial-roles/{role_id}", json={"code": "newcd"})
    assert blocked.status_code == 400
