"""Route-level tests for GET/POST /analysis-services/{id}/specs and
PATCH /analysis-service-specs/{spec_id} (spec-ownership slice 2, Task 3).

Fixture mirrors test_analysis_service_routes.py's route_client: a single
shared in-memory SQLite session backs both the app (via get_db override)
and the test's own assertions, so audit rows written by a route call are
immediately visible to the test without a second connection.
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
from models import AnalysisService, AnalysisServiceSpec, AuditLog, Peptide


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
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
def svc(db_session):
    service = AnalysisService(title="HM-XX", keyword="HM-XX", origin="mk1")
    db_session.add(service)
    db_session.commit()
    return service


@pytest.fixture
def peptide(db_session):
    p = Peptide(name="BPC-157", abbreviation="BPC157")
    db_session.add(p)
    db_session.commit()
    return p


def test_create_and_list_wildcard_spec(client, svc):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "max_value": "0.5", "unit": "µg/g"})
    assert r.status_code == 201
    body = client.get(f"/analysis-services/{svc.id}/specs").json()
    assert [s["max_value"] for s in body] == ["0.5"]


def test_create_rejects_both_tiers(client, svc, peptide):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "max_value": "1",
                          "matrix": "Peptide", "peptide_id": peptide.id})
    assert r.status_code == 422


def test_create_conflict_on_second_active_wildcard(client, svc):
    p = {"rule_kind": "range", "max_value": "1"}
    assert client.post(f"/analysis-services/{svc.id}/specs", json=p).status_code == 201
    assert client.post(f"/analysis-services/{svc.id}/specs", json=p).status_code == 409
    # The 409's rollback must leave the shared session usable for the rest of
    # the request cycle (and beyond) — exactly one row survives, not zero.
    body = client.get(f"/analysis-services/{svc.id}/specs").json()
    assert len(body) == 1


def test_patch_reactivate_conflicts_with_freed_wildcard_slot(client, svc):
    """Deactivating a row frees its wildcard slot; a second wildcard row can
    then claim it. Reactivating the first row must collide with that second
    row via the same partial unique index PATCH never otherwise triggers —
    this is the only route path that can flip active False -> True."""
    p = {"rule_kind": "range", "max_value": "1"}
    first_id = client.post(f"/analysis-services/{svc.id}/specs", json=p).json()["id"]
    client.patch(f"/analysis-service-specs/{first_id}", json={"active": False})
    second_id = client.post(f"/analysis-services/{svc.id}/specs", json=p).json()["id"]

    r = client.patch(f"/analysis-service-specs/{first_id}", json={"active": True})
    assert r.status_code == 409

    # Rollback must leave the session usable and the surviving row untouched.
    body = client.get(f"/analysis-services/{svc.id}/specs").json()
    assert [s["id"] for s in body] == [second_id]


def test_patch_null_rule_kind_rejected(client, svc):
    """Explicit JSON null for a NOT-NULL control field must 422 with a
    diagnosis naming the field — not fall through to _validate_spec_shape's
    equals arm and die at db.flush() as a misleading 409."""
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    r = client.patch(f"/analysis-service-specs/{sid}", json={"rule_kind": None})
    assert r.status_code == 422
    assert "rule_kind" in r.json()["detail"]


def test_patch_null_active_rejected(client, svc):
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    r = client.patch(f"/analysis-service-specs/{sid}", json={"active": None})
    assert r.status_code == 422
    assert "active" in r.json()["detail"]


def test_create_rejects_malformed_min_value(client, svc):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "min_value": "abc"})
    assert r.status_code == 422
    assert "min_value" in r.json()["detail"]


def test_create_rejects_non_finite_min_value(client, svc):
    """decimal.Decimal("nan") parses fine (no InvalidOperation) but a NaN
    bound makes every comparison against it False -- a NaN max_value would
    silently PASS every certificate. Bounds must fail closed like results
    do."""
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "min_value": "nan"})
    assert r.status_code == 422
    assert "min_value" in r.json()["detail"]


def test_patch_rejects_non_finite_max_value(client, svc):
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    r = client.patch(f"/analysis-service-specs/{sid}", json={"max_value": "inf"})
    assert r.status_code == 422
    assert "max_value" in r.json()["detail"]


def test_patch_rejects_malformed_max_value(client, svc):
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    r = client.patch(f"/analysis-service-specs/{sid}", json={"max_value": "n/a"})
    assert r.status_code == 422
    assert "max_value" in r.json()["detail"]


def test_patch_partial_failure_leaves_no_trace(client, svc):
    """A 422 must apply nothing. min_value parses fine; max_value doesn't —
    if conversion and mutation were interleaved, min_value would land on
    the session before the abort. Verify through a GET on the same shared
    session that BOTH fields are exactly as they were pre-PATCH."""
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    r = client.patch(f"/analysis-service-specs/{sid}",
                      json={"min_value": "1", "max_value": "n/a"})
    assert r.status_code == 422

    body = client.get(f"/analysis-services/{svc.id}/specs").json()
    assert body[0]["id"] == sid
    assert body[0]["min_value"] is None
    assert body[0]["max_value"] == "1"


def test_create_rejects_unknown_matrix(client, svc):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "max_value": "1", "matrix": "Plasma"})
    assert r.status_code == 422


def test_patch_deactivates_and_audits(client, db_session, svc):
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    r = client.patch(f"/analysis-service-specs/{sid}", json={"active": False})
    assert r.status_code == 200 and r.json()["active"] is False
    audits = db_session.execute(select(AuditLog).where(
        AuditLog.operation == "analysis_service_spec_changed"
    ).order_by(AuditLog.id)).scalars().all()
    assert audits[-1].details["before"]["active"] is True
    assert audits[-1].details["after"]["active"] is False
    assert audits[-1].details["actor_user_id"] is not None


def test_rule_shape_422(client, svc):
    r = client.post(f"/analysis-services/{svc.id}/specs", json={"rule_kind": "range"})
    assert r.status_code == 422


def test_create_unknown_service_404(client):
    r = client.post("/analysis-services/999999/specs",
                    json={"rule_kind": "range", "max_value": "1"})
    assert r.status_code == 404


def test_list_unknown_service_404(client):
    r = client.get("/analysis-services/999999/specs")
    assert r.status_code == 404


def test_patch_unknown_spec_404(client):
    r = client.patch("/analysis-service-specs/999999", json={"active": False})
    assert r.status_code == 404


def test_create_peptide_tier_spec_returns_peptide_code(client, svc, peptide):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "max_value": "1",
                          "peptide_id": peptide.id})
    assert r.status_code == 201
    body = r.json()
    assert body["peptide_id"] == peptide.id
    assert body["peptide_code"] == "BPC157"


def test_create_rejects_unknown_peptide(client, svc):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "max_value": "1", "peptide_id": 999999})
    assert r.status_code == 422


def test_list_orders_peptide_then_matrix_then_wildcard(client, svc, peptide):
    """Response ordering is part of the contract Task 5's editor consumes:
    the most-specific tier (peptide-bound) first, then named-matrix, then
    the wildcard fallback last."""
    wildcard_id = client.post(f"/analysis-services/{svc.id}/specs",
                              json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    matrix_id = client.post(f"/analysis-services/{svc.id}/specs",
                            json={"rule_kind": "range", "max_value": "2",
                                  "matrix": "Peptide"}).json()["id"]
    peptide_row_id = client.post(f"/analysis-services/{svc.id}/specs",
                                 json={"rule_kind": "range", "max_value": "3",
                                       "peptide_id": peptide.id}).json()["id"]
    body = client.get(f"/analysis-services/{svc.id}/specs").json()
    assert [s["id"] for s in body] == [peptide_row_id, matrix_id, wildcard_id]


def test_list_excludes_inactive_rows(client, svc):
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    client.patch(f"/analysis-service-specs/{sid}", json={"active": False})
    body = client.get(f"/analysis-services/{svc.id}/specs").json()
    assert body == []


def test_patch_equals_rule_kind_change(client, svc):
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    r = client.patch(f"/analysis-service-specs/{sid}",
                      json={"rule_kind": "equals", "equals_value": "Not Detected",
                            "min_value": None, "max_value": None})
    assert r.status_code == 200
    body = r.json()
    assert body["rule_kind"] == "equals"
    assert body["equals_value"] == "Not Detected"
    assert body["min_value"] is None and body["max_value"] is None


def test_create_spec_with_loq(client, svc):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "max_value": "100",
                          "unit": "µg/g", "loq": "0.5"})
    assert r.status_code == 201 and r.json()["loq"] == "0.5"


def test_patch_spec_loq_and_clear(client, svc):
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    r = client.patch(f"/analysis-service-specs/{sid}", json={"loq": "0.25"})
    assert r.status_code == 200 and r.json()["loq"] == "0.25"
    r = client.patch(f"/analysis-service-specs/{sid}", json={"loq": None})
    assert r.status_code == 200 and r.json()["loq"] is None


def test_loq_rejects_negative_and_nonfinite(client, svc):
    for bad in ("-1", "nan", "abc"):
        r = client.post(f"/analysis-services/{svc.id}/specs",
                        json={"rule_kind": "range", "max_value": "100", "loq": bad})
        assert r.status_code == 422, bad


def test_loq_in_audit_snapshot(client, db_session, svc):
    client.post(f"/analysis-services/{svc.id}/specs",
                json={"rule_kind": "range", "max_value": "100", "loq": "0.5"})
    log = db_session.execute(select(AuditLog).where(
        AuditLog.operation == "analysis_service_spec_changed")).scalars().all()[-1]
    assert log.details["after"]["loq"] == "0.5"
