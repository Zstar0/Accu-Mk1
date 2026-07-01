"""Departments admin API: update, counts, admin-gating. Runs against the live
catalog DB (SessionLocal) via TestClient; all rows created here use a ZZDEPT-
prefix and are deleted in teardown so nothing persists."""
import pytest
from fastapi.testclient import TestClient
import main
from database import SessionLocal
from models import Department, User, ServiceGroup, AnalysisService
from auth import get_password_hash, create_access_token


@pytest.fixture
def client():
    return TestClient(main.app)


def _token(role: str) -> str:
    db = SessionLocal()
    try:
        email = f"zzdept-{role}@test.local"
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(email=email, hashed_password=get_password_hash("x"), role=role, is_active=True)
            db.add(u); db.commit(); db.refresh(u)
        return create_access_token({"sub": str(u.id)})
    finally:
        db.close()


def _auth(role="admin"):
    return {"Authorization": f"Bearer {_token(role)}"}


@pytest.fixture
def dept():
    db = SessionLocal()
    d = Department(name="ZZDEPT-A", color="blue", sort_order=5)
    db.add(d); db.commit(); db.refresh(d)
    did = d.id
    db.close()
    yield did
    db = SessionLocal()
    row = db.get(Department, did)
    if row: db.delete(row); db.commit()
    db.close()


def test_response_carries_counts(client, dept):
    r = client.get("/departments", headers=_auth())
    assert r.status_code == 200
    row = next(d for d in r.json() if d["id"] == dept)
    assert row["group_count"] == 0 and row["service_count"] == 0


def test_put_updates_fields(client, dept):
    r = client.put(f"/departments/{dept}", json={"name": "ZZDEPT-A2", "color": "green", "sort_order": 9}, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "ZZDEPT-A2" and body["color"] == "green" and body["sort_order"] == 9
    assert body["group_count"] == 0 and body["service_count"] == 0


def test_put_rejects_duplicate_name(client, dept):
    db = SessionLocal(); other = Department(name="ZZDEPT-OTHER"); db.add(other); db.commit(); oid = other.id; db.close()
    try:
        r = client.put(f"/departments/{dept}", json={"name": "ZZDEPT-OTHER"}, headers=_auth())
        assert r.status_code == 400
    finally:
        db = SessionLocal()
        try:
            db.delete(db.get(Department, oid)); db.commit()
        finally:
            db.close()


def test_put_404_missing(client):
    assert client.put("/departments/99999999", json={"name": "X"}, headers=_auth()).status_code == 404


def test_put_requires_admin(client, dept):
    assert client.put(f"/departments/{dept}", json={"name": "Nope"}, headers=_auth("standard")).status_code == 403


def test_post_requires_admin(client):
    assert client.post("/departments", json={"name": "ZZDEPT-NEW"}, headers=_auth("standard")).status_code == 403


def test_put_rename_to_own_name_ok(client, dept):
    r = client.put(f"/departments/{dept}", json={"name": "ZZDEPT-A", "color": "red"}, headers=_auth())
    assert r.status_code == 200
    assert r.json()["color"] == "red"


def test_service_count_counts_ungrouped_service(client, dept):
    db = SessionLocal()
    svc = AnalysisService(keyword="ZZDEPT-UNGROUPED", title="zz", department_id=dept)  # no service_group_members row
    db.add(svc); db.commit(); sid = svc.id; db.close()
    try:
        r = client.get("/departments", headers=_auth())
        row = next(d for d in r.json() if d["id"] == dept)
        assert row["service_count"] == 1   # counted directly by department_id, not through any group
        assert row["group_count"] == 0
    finally:
        db = SessionLocal()
        try:
            db.delete(db.get(AnalysisService, sid)); db.commit()
        finally:
            db.close()


def test_delete_ok_no_dependents(client):
    db = SessionLocal(); d = Department(name="ZZDEPT-DEL"); db.add(d); db.commit(); did = d.id; db.close()
    r = client.delete(f"/departments/{did}", headers=_auth())
    assert r.status_code == 204
    db = SessionLocal(); assert db.get(Department, did) is None; db.close()


def test_delete_blocked_by_service(client, dept):
    db = SessionLocal()
    svc = AnalysisService(keyword="ZZDEPT-SVC", title="zz", department_id=dept)
    db.add(svc); db.commit(); sid = svc.id; db.close()
    try:
        r = client.delete(f"/departments/{dept}", headers=_auth())
        assert r.status_code == 409
        assert "service" in r.json()["detail"].lower()
    finally:
        db = SessionLocal(); db.delete(db.get(AnalysisService, sid)); db.commit(); db.close()


def test_delete_blocked_when_system(client):
    db = SessionLocal(); d = Department(name="ZZDEPT-SYS", is_system=True); db.add(d); db.commit(); did = d.id; db.close()
    try:
        assert client.delete(f"/departments/{did}", headers=_auth()).status_code == 409
    finally:
        db = SessionLocal(); db.delete(db.get(Department, did)); db.commit(); db.close()


def test_delete_requires_admin(client, dept):
    assert client.delete(f"/departments/{dept}", headers=_auth("standard")).status_code == 403


def test_delete_404_missing(client):
    assert client.delete("/departments/99999999", headers=_auth()).status_code == 404


def test_delete_blocked_by_group(client, dept):
    db = SessionLocal()
    g = ServiceGroup(name="ZZDEPT-GRP", department_id=dept)
    db.add(g); db.commit(); gid = g.id; db.close()
    try:
        r = client.delete(f"/departments/{dept}", headers=_auth())
        assert r.status_code == 409
        assert "group" in r.json()["detail"].lower()
    finally:
        db = SessionLocal(); db.delete(db.get(ServiceGroup, gid)); db.commit(); db.close()
