"""Slice 1 foundation: generic method columns + method_services + local instruments.
Harness: in-memory SQLite, same idiom as tests/test_manage_native_routes.py."""
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import models  # noqa: F401
from database import Base
from models import AnalysisService, HplcMethod, Instrument, method_services


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


def _svc(db, kw):
    s = AnalysisService(title=kw.title(), keyword=kw, origin="mk1", active=True,
                        variance_capable=False)
    db.add(s)
    db.flush()
    return s


def test_method_generic_columns_and_service_links(db_session):
    m = HplcMethod(name="Elemental Impurities by ICP-MS", code="AM-ELEM-001",
                   technique="ICP-MS", reference="USP <232>/<233>",
                   procedure_summary="Microwave digestion; ICP-MS quant.",
                   origin="mk1", active=True)
    db_session.add(m)
    lead = _svc(db_session, "LEAD-PPM")
    db_session.flush()
    db_session.execute(method_services.insert().values(
        method_id=m.id, analysis_service_id=lead.id, is_default=True))
    db_session.commit()

    row = db_session.execute(select(HplcMethod).where(HplcMethod.code == "AM-ELEM-001")).scalar_one()
    assert row.technique == "ICP-MS"
    assert row.origin == "mk1"
    assert row.supersedes_id is None
    link = db_session.execute(select(method_services)).one()
    assert link.is_default is True


def test_instrument_department_and_origin_columns(db_session):
    i = Instrument(name="Agilent 7900 ICP-MS", instrument_type="ICP-MS",
                   department_id=None, origin="mk1", active=True)
    db_session.add(i)
    db_session.commit()
    got = db_session.execute(select(Instrument)).scalar_one()
    assert got.origin == "mk1"
    assert got.senaite_id is None and got.senaite_uid is None


# ═══════════════════════════════════════════════════════════════════════════════
# Task 2 — route-level tests: generic fields on CRUD, R0 create shape
#
# route_client idiom copied from tests/test_native_manage_analyses.py /
# tests/test_department_routes.py (the plan's `tests/test_manage_native_routes.py`
# does not exist on this branch). Shaped as a `_client` generator helper so the
# `client` fixture can wire it to *this* file's `db_session` fixture, keeping
# client-issued requests and direct db_session queries on the same connection.
# ═══════════════════════════════════════════════════════════════════════════════


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


def test_create_method_generic_fields_and_r0(client, db_session):
    r = client.post("/hplc/methods", json={
        "name": "Residual Moisture by KF", "code": "AM-KF-001",
        "technique": "KF", "reference": "USP <921>",
        "procedure_summary": "Karl Fischer titration.",
        "senaite_id": "MET-SHOULD-BE-IGNORED",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["code"] == "AM-KF-001" and body["technique"] == "KF"
    assert body["origin"] == "mk1"
    assert body["senaite_id"] is None  # R0: field not accepted at create


def test_create_method_duplicate_code_400(client, db_session):
    client.post("/hplc/methods", json={"name": "M1", "code": "AM-X-1"})
    r = client.post("/hplc/methods", json={"name": "M2", "code": "AM-X-1"})
    assert r.status_code == 400
    assert "code" in r.json()["detail"].lower()


def test_update_method_generic_fields(client, db_session):
    mid = client.post("/hplc/methods", json={"name": "M3"}).json()["id"]
    r = client.put(f"/hplc/methods/{mid}", json={"technique": "PCR", "reference": "USP <71>"})
    assert r.status_code == 200
    assert r.json()["technique"] == "PCR"


def test_create_method_empty_string_code_normalizes_to_null(client, db_session):
    # R-P1-2: "" must not reach the DB partial unique index (WHERE code IS NOT
    # NULL) as a real value — a second "" would collide there and 500 instead
    # of hitting the app-level 400 dup-check.
    r1 = client.post("/hplc/methods", json={"name": "M-Empty-1", "code": ""})
    assert r1.status_code == 201, r1.text
    assert r1.json()["code"] is None

    r2 = client.post("/hplc/methods", json={"name": "M-Empty-2", "code": ""})
    assert r2.status_code == 201, r2.text  # no dup 400, no 500
    assert r2.json()["code"] is None


# ═══════════════════════════════════════════════════════════════════════════════
# Task 3 — method<->service links: GET/PUT services, defaults, default_method_id
# ═══════════════════════════════════════════════════════════════════════════════


def _mk_method(client, name, **kw):
    return client.post("/hplc/methods", json={"name": name, **kw}).json()["id"]


def test_put_services_links_and_defaults(client, db_session):
    lead = _svc(db_session, "LEAD-PPM"); ars = _svc(db_session, "ARSENIC-PPM")
    db_session.commit()
    mid = _mk_method(client, "ICP-MS", code="AM-ELEM-001", technique="ICP-MS")
    r = client.put(f"/hplc/methods/{mid}/services", json=[
        {"analysis_service_id": lead.id, "is_default": True},
        {"analysis_service_id": ars.id, "is_default": True},
    ])
    assert r.status_code == 200
    got = client.get(f"/hplc/methods/{mid}/services").json()
    assert {(s["analysis_service_id"], s["is_default"]) for s in got} == {(lead.id, True), (ars.id, True)}
    # MethodResponse.services (via GET /hplc/methods) carries the same links —
    # this is the field _method_to_response fills, exercising the column-dict
    # rewrite that avoids the HplcMethod.services ORM-relationship name collision.
    listed = next(m for m in client.get("/hplc/methods").json() if m["id"] == mid)
    assert {(s["analysis_service_id"], s["is_default"]) for s in listed["services"]} == {(lead.id, True), (ars.id, True)}


def test_second_default_for_service_400(client, db_session):
    lead = _svc(db_session, "LEAD-PPM"); db_session.commit()
    m1 = _mk_method(client, "ICP-MS A"); m2 = _mk_method(client, "ICP-MS B")
    client.put(f"/hplc/methods/{m1}/services", json=[{"analysis_service_id": lead.id, "is_default": True}])
    r = client.put(f"/hplc/methods/{m2}/services", json=[{"analysis_service_id": lead.id, "is_default": True}])
    assert r.status_code == 400
    assert "ICP-MS A" in r.json()["detail"]  # names the conflicting method
    # non-default link is fine
    r2 = client.put(f"/hplc/methods/{m2}/services", json=[{"analysis_service_id": lead.id, "is_default": False}])
    assert r2.status_code == 200


def test_default_method_id_fail_open(client, db_session):
    lead = _svc(db_session, "LEAD-PPM"); db_session.commit()
    mid = _mk_method(client, "ICP-MS C")
    client.put(f"/hplc/methods/{mid}/services", json=[{"analysis_service_id": lead.id, "is_default": True}])
    rows = client.get("/analysis-services").json()
    row = next(s for s in rows if s["id"] == lead.id)
    assert row["default_method_id"] == mid
    client.put(f"/hplc/methods/{mid}", json={"active": False})
    rows = client.get("/analysis-services").json()
    row = next(s for s in rows if s["id"] == lead.id)
    assert row["default_method_id"] is None  # fail-open (§4.2)


# ═══════════════════════════════════════════════════════════════════════════════
# Task 4 — DELETE referential guard: refuse deletion if analyses reference method
# ═══════════════════════════════════════════════════════════════════════════════


def test_delete_method_referenced_by_analysis_409(client, db_session):
    from models import LimsAnalysis, LimsSample
    mid = _mk_method(client, "ICP-MS D")
    svc = _svc(db_session, "CADMIUM-PPM")
    parent = LimsSample(sample_id="P-9001")
    db_session.add(parent); db_session.flush()
    db_session.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                                keyword="CADMIUM-PPM", title="Cadmium",
                                review_state="verified", provenance="canonical",
                                method_id=mid))
    db_session.commit()
    r = client.delete(f"/hplc/methods/{mid}")
    assert r.status_code == 409
    assert "deactivate" in r.json()["detail"].lower()
    assert db_session.get(HplcMethod, mid) is not None


# ═══════════════════════════════════════════════════════════════════════════════
# Task 5 — Instrument local CRUD: POST/PATCH, R0, department scope
# ═══════════════════════════════════════════════════════════════════════════════


def test_create_instrument_local(client, db_session):
    r = client.post("/instruments", json={"name": "Agilent 7900 ICP-MS",
                                          "instrument_type": "ICP-MS",
                                          "senaite_uid": "should-be-ignored"})
    assert r.status_code == 201
    b = r.json()
    assert b["origin"] == "mk1" and b["senaite_id"] is None and b["senaite_uid"] is None


def test_create_instrument_duplicate_name_400(client, db_session):
    client.post("/instruments", json={"name": "KF Titrator V20"})
    assert client.post("/instruments", json={"name": "KF Titrator V20"}).status_code == 400


def test_patch_instrument(client, db_session):
    iid = client.post("/instruments", json={"name": "KF Titrator V30"}).json()["id"]
    r = client.patch(f"/instruments/{iid}", json={"brand": "Mettler Toledo", "active": False})
    assert r.status_code == 200
    assert r.json()["brand"] == "Mettler Toledo" and r.json()["active"] is False


def test_patch_instrument_explicit_null_400(client, db_session):
    iid = client.post("/instruments", json={"name": "KF Titrator V40"}).json()["id"]
    # Explicit null on NOT-NULL name → 400 (R1)
    r = client.patch(f"/instruments/{iid}", json={"name": None})
    assert r.status_code == 400
    assert "name" in r.json()["detail"].lower()
    # Explicit null on NOT-NULL active → 400 (R1)
    r = client.patch(f"/instruments/{iid}", json={"active": None})
    assert r.status_code == 400
    assert "active" in r.json()["detail"].lower()


# ═══════════════════════════════════════════════════════════════════════════════
# Final-review fix wave — M-2/#6: DB-level proof that the one-default-per-service
# partial unique index (uq_method_service_default, models.py method_services
# Table) is actually enforced by SQLite, not just the app-level 400 in
# put_method_services. Same Index idiom (postgresql_where/sqlite_where) backs
# the HplcMethod.code uniqueness index added for M-2, so this also proves that
# style works under the in-memory SQLite harness.
# ═══════════════════════════════════════════════════════════════════════════════


def test_method_services_default_partial_index_enforced_in_sqlite(db_session):
    lead = _svc(db_session, "LEAD-PPM")
    m1 = HplcMethod(name="ICP-MS Default A", origin="mk1", active=True)
    m2 = HplcMethod(name="ICP-MS Default B", origin="mk1", active=True)
    db_session.add_all([m1, m2])
    db_session.flush()

    db_session.execute(method_services.insert().values(
        method_id=m1.id, analysis_service_id=lead.id, is_default=True))
    db_session.commit()

    with pytest.raises(IntegrityError):
        db_session.execute(method_services.insert().values(
            method_id=m2.id, analysis_service_id=lead.id, is_default=True))
        db_session.commit()
    db_session.rollback()

    # first row is untouched; no second default was ever persisted
    rows = db_session.execute(select(method_services)).all()
    assert len(rows) == 1
    assert rows[0].method_id == m1.id and rows[0].is_default is True
