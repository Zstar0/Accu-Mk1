"""HTTP-level tests for the lims_analyses router."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import auth
from database import SessionLocal
from main import app
from models import (
    AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSubSample,
)


class _FakeUser:
    """Minimal stand-in for the authed user; only id is read.
    id=None avoids a created_by_user_id FK target requirement."""
    id = None


# Module-level override, same convention as test_api_business_hours.py.
app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
client = TestClient(app)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def sub_sample(db):
    sub = db.execute(select(LimsSubSample)).scalars().first()
    if sub is None:
        pytest.skip("no lims_sub_samples row available")
    return sub


@pytest.fixture
def analysis_service(db):
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.reason.like("HTTP-TEST:%")
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.title.like("HTTP-TEST:%")
    ))
    db.commit()


def _create_payload(sub, svc):
    return {
        "host_kind": "sub_sample",
        "host_pk": sub.id,
        "analysis_service_id": svc.id,
        "keyword": svc.keyword,
        "title": "HTTP-TEST: " + (svc.title or svc.keyword),
    }


# ── POST /api/lims-analyses ─────────────────────────────────────────────────


def test_create_returns_201_unassigned(sub_sample, analysis_service):
    resp = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["review_state"] == "unassigned"
    assert body["lims_sub_sample_pk"] == sub_sample.id


# ── transition endpoint ────────────────────────────────────────────────────


def test_transition_happy_path_to_verified(sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]

    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "assign", "reason": "HTTP-TEST: assign"})
    assert r.status_code == 200
    assert r.json()["review_state"] == "assigned"

    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "submit", "result_value": "98.55",
                          "reason": "HTTP-TEST: submit"})
    assert r.status_code == 200
    assert r.json()["review_state"] == "to_be_verified"

    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "verify", "reason": "HTTP-TEST: verify"})
    assert r.status_code == 200
    assert r.json()["review_state"] == "verified"


def test_publish_on_vial_tier_returns_409_tier_mismatch(sub_sample, analysis_service):
    """Trying to publish a vial-tier row from unassigned hits the tier guard
    first → 409 with code='tier_mismatch'."""
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "publish", "reason": "HTTP-TEST: too early"})
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "tier_mismatch"
    assert detail["tier"] == "vial"
    assert detail["kind"] == "publish"


def test_submit_without_result_returns_400(sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    client.post(f"/api/lims-analyses/{aid}/transitions",
                json={"kind": "assign", "reason": "HTTP-TEST: assign"})
    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "submit", "reason": "HTTP-TEST: no result"})
    assert r.status_code == 400


def test_not_found_returns_404():
    r = client.get("/api/lims-analyses/99999999")
    assert r.status_code == 404


# ── reportable PATCH ────────────────────────────────────────────────────────


def test_patch_reportable_writes_audit(sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    r = client.patch(f"/api/lims-analyses/{aid}/reportable",
                     json={"reportable": False, "reason": "HTTP-TEST: not reportable"})
    assert r.status_code == 200
    assert r.json()["reportable"] is False

    r = client.get(f"/api/lims-analyses/{aid}")
    assert r.status_code == 200
    audit = r.json()["transitions"]
    # Initial auto + the reportable flip
    assert any(
        t["transition_kind"] == "auto" and "reportable=False" in (t.get("reason") or "")
        for t in audit
    )


# ── GET list for host ────────────────────────────────────────────────────────


def test_list_for_host_returns_created_row(sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    r = client.get(
        "/api/lims-analyses",
        params={"host_kind": "sub_sample", "host_pk": sub_sample.id},
    )
    assert r.status_code == 200
    ids = {row["id"] for row in r.json()}
    assert created["id"] in ids


# ── Phase 3 senaite_shape flavor ────────────────────────────────────────────


def test_list_for_host_default_flavor_returns_phase1_shape(sub_sample, analysis_service):
    create_resp = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service))
    assert create_resp.status_code == 201
    r = client.get(f"/api/lims-analyses?host_kind=sub_sample&host_pk={sub_sample.id}")
    assert r.status_code == 200
    rows = r.json()
    assert rows
    # Default shape has `id` (Phase 1)
    assert "id" in rows[0]
    assert "uid" not in rows[0]  # not the senaite_shape


def test_list_for_host_senaite_shape_returns_phase3_shape(sub_sample, analysis_service):
    create_resp = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service))
    assert create_resp.status_code == 201
    r = client.get(f"/api/lims-analyses?host_kind=sub_sample&host_pk={sub_sample.id}&as=senaite_shape")
    assert r.status_code == 200
    rows = r.json()
    assert rows
    # FE shape has `uid` with mk1: prefix
    assert rows[0]["uid"].startswith("mk1:")
    assert "method_options" in rows[0]
    assert "instrument_options" in rows[0]
    assert "review_state" in rows[0]


# ── Phase 3.6: method-instrument PATCH ──────────────────────────────────────


def test_patch_method_instrument_happy_path(sub_sample, analysis_service):
    from models import HplcMethod, Instrument
    db = SessionLocal()
    method = db.execute(select(HplcMethod)).scalars().first()
    instrument = db.execute(select(Instrument)).scalars().first()
    db.close()
    if method is None or instrument is None:
        pytest.skip("no hplc_methods / instruments in this env")
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    r = client.patch(
        f"/api/lims-analyses/{aid}/method-instrument",
        json={"method_id": method.id, "instrument_id": instrument.id},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["method_id"] == method.id
    assert body["instrument_id"] == instrument.id


def test_patch_method_instrument_404_on_missing_analysis():
    r = client.patch(
        "/api/lims-analyses/99999999/method-instrument",
        json={"method_id": None, "instrument_id": None},
    )
    assert r.status_code == 404
