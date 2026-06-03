"""HTTP-level tests for the lims_analyses router."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text

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


# ── Phase 4a: POST /promote ─────────────────────────────────────────────────


def _find_clean_sub_for_route(db, svc, *, exclude_ids=(), parent_pk=None):
    """Pick a sub-sample with no non-retest row for svc.keyword."""
    stmt = (
        select(LimsSubSample)
        .where(LimsSubSample.id.notin_(exclude_ids) if exclude_ids else True)
        .where(~select(LimsAnalysis.id).where(
            LimsAnalysis.lims_sub_sample_pk == LimsSubSample.id,
            LimsAnalysis.keyword == svc.keyword,
            LimsAnalysis.retest_of_id.is_(None),
        ).exists())
    )
    if parent_pk is not None:
        stmt = stmt.where(LimsSubSample.parent_sample_pk == parent_pk)
    return db.execute(stmt).scalars().first()


def _find_parent_with_n_clean_subs_route(db, svc, n):
    """Find parent_pk with at least n sub-samples free of svc.keyword."""
    from sqlalchemy import func
    stmt = (
        select(LimsSubSample.parent_sample_pk)
        .where(~select(LimsAnalysis.id).where(
            LimsAnalysis.lims_sub_sample_pk == LimsSubSample.id,
            LimsAnalysis.keyword == svc.keyword,
            LimsAnalysis.retest_of_id.is_(None),
        ).exists())
        .group_by(LimsSubSample.parent_sample_pk)
        .having(func.count(LimsSubSample.id) >= n)
        .limit(1)
    )
    return db.execute(stmt).scalar_one_or_none()


def _walk_to_to_be_verified(aid: int, result: str = "98.55"):
    """Helper: assign + submit a freshly-created analysis via HTTP."""
    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "assign", "reason": "HTTP-TEST: assign"})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "submit", "result_value": result,
                          "reason": "HTTP-TEST: submit"})
    assert r.status_code == 200, r.text


def _rename_parent_for_cleanup(parent_id: int):
    """Re-title the parent-tier row so the HTTP-TEST:% autouse cleanup catches it."""
    db = SessionLocal()
    db.execute(text("UPDATE lims_analyses SET title = 'HTTP-TEST: ' || title WHERE id = :id"),
               {"id": parent_id})
    db.commit()
    db.close()


def test_promote_endpoint_happy_path_single_vial(analysis_service):
    db = SessionLocal()
    clean_sub = _find_clean_sub_for_route(db, analysis_service)
    db.close()
    if clean_sub is None:
        pytest.skip("no sub-sample free of keyword for promote happy-path test")
    created = client.post("/api/lims-analyses", json=_create_payload(clean_sub, analysis_service)).json()
    aid = created["id"]
    _walk_to_to_be_verified(aid)
    r = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "98.55",
            "sources": [{"analysis_id": aid, "contribution_kind": "chosen"}],
            "reason": "HTTP-TEST: promote single",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["parent"]["review_state"] == "verified"
    assert body["parent"]["lims_sub_sample_pk"] is None
    assert len(body["promotions"]) == 1
    _rename_parent_for_cleanup(body["parent"]["id"])


def test_promote_endpoint_empty_sources_returns_422():
    """Pydantic validates min_length=1 on sources — 422 before service runs."""
    r = client.post(
        "/api/lims-analyses/promote",
        json={"keyword": "X", "result_value": "1", "sources": []},
    )
    assert r.status_code == 422, r.text


def test_promote_endpoint_missing_source_returns_404(analysis_service):
    r = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "1",
            "sources": [{"analysis_id": 99_999_999, "contribution_kind": "chosen"}],
        },
    )
    assert r.status_code == 404, r.text


def test_promote_endpoint_409_on_existing_parent_row(analysis_service):
    """Re-promoting against an existing parent-tier row hits the partial
    unique index and surfaces as 409 with code=parent_row_already_exists."""
    db = SessionLocal()
    parent_pk = _find_parent_with_n_clean_subs_route(db, analysis_service, 2)
    if parent_pk is None:
        db.close()
        pytest.skip("need a parent with 2+ free sub-samples for 409 test")
    clean_a = _find_clean_sub_for_route(db, analysis_service, parent_pk=parent_pk)
    clean_b = _find_clean_sub_for_route(
        db, analysis_service, exclude_ids=(clean_a.id,), parent_pk=parent_pk,
    )
    db.close()

    created = client.post("/api/lims-analyses", json=_create_payload(clean_a, analysis_service)).json()
    _walk_to_to_be_verified(created["id"])
    r1 = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "98.55",
            "sources": [{"analysis_id": created["id"], "contribution_kind": "chosen"}],
        },
    )
    assert r1.status_code == 201, r1.text
    parent_id = r1.json()["parent"]["id"]
    _rename_parent_for_cleanup(parent_id)

    created2 = client.post("/api/lims-analyses", json=_create_payload(clean_b, analysis_service)).json()
    _walk_to_to_be_verified(created2["id"])
    r2 = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "99.0",
            "sources": [{"analysis_id": created2["id"], "contribution_kind": "chosen"}],
        },
    )
    assert r2.status_code == 409, r2.text
    assert r2.json()["detail"]["code"] == "parent_row_already_exists"
