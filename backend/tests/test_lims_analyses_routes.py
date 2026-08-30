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
    LimsSubSampleEvent,
)


class _FakeUser:
    """Minimal stand-in for the authed user; only id is read.
    id=None avoids a created_by_user_id FK target requirement."""
    id = None
    email = "test@accumark.test"


# Module-level override, same convention as test_api_business_hours.py.
app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
client = TestClient(app)


@pytest.fixture(autouse=True)
def _stub_senaite_writeback(monkeypatch):
    """Stub out SENAITE write-back so promote tests don't require a live SENAITE.

    This is an autouse function-scoped fixture so every test in this module
    gets a clean stub without touching call sites individually.  Tests that
    want to test the write-back failure path live in test_promote_writeback_route.py.
    """
    import lims_analyses.routes as _routes

    monkeypatch.setattr(_routes.senaite_writeback, "writeback_promotion",
                        lambda *args, **kwargs: "stub-senaite-uid")
    # Parent-tier verify tee (seam fix 2026-08-20): apply_transition now tees
    # SENAITE-origin parent sign-offs to SENAITE. Same stub rationale as
    # promote above; the tee's own coverage lives in
    # test_parent_verify_tee.py / test_senaite_writeback.py.
    monkeypatch.setattr(_routes.senaite_writeback, "writeback_parent_verify",
                        lambda *args, **kwargs: "verified")


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
    # Task 7: parent_analysis_verified events are hosted on lims_sample_pk
    # (the LimsSample), not the LimsAnalysis row itself, so the FK cascade
    # below doesn't reach them — delete by embedded analysis_id BEFORE the
    # LimsAnalysis rows they reference disappear.
    db.execute(text(
        "DELETE FROM lims_sub_sample_events "
        "WHERE event = 'parent_analysis_verified' "
        "AND (details->>'analysis_id')::int IN ("
        "  SELECT id FROM lims_analyses WHERE title LIKE 'HTTP-TEST:%'"
        ")"
    ))
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


def _find_clean_sub_avoiding_variance(db, svc, *, parent_pk=None):
    """Like _find_clean_sub_for_route, but also skips vials already assigned
    to a variance bucket — promote_to_parent 400s on those, which is an
    unrelated blocker for a tier-mismatch pin test."""
    exclude: list[int] = []
    for _ in range(50):
        candidate = _find_clean_sub_for_route(
            db, svc, exclude_ids=tuple(exclude), parent_pk=parent_pk,
        )
        if candidate is None:
            return None
        if candidate.assignment_kind != "variance":
            return candidate
        exclude.append(candidate.id)
    return None


def test_retest_on_parent_tier_returns_409_tier_mismatch(analysis_service):
    """Pins WHY the dedicated parent-retest route exists: the generic
    transitions endpoint tier-blocks retest on a verified parent row.

    Uses _find_clean_sub_avoiding_variance (not the shared `sub_sample`
    fixture) so promotion can't be blocked by an unrelated variance-bucket
    assignment on whatever row happens to sort first in the shared dev DB —
    mirrors test_promote_endpoint_happy_path_single_vial's fixture idiom.

    Re-asserts the module's auth override locally (save/restore) instead of
    trusting the module-level `app.dependency_overrides` write at the top of
    this file: several other test modules (e.g. test_parent_mirror_hooks.py,
    test_registry_debug_endpoint.py) call `app.dependency_overrides.clear()`
    unconditionally in teardown, which wipes this module's override without
    restoring it — confirmed as the cause of the pre-existing baseline
    401s/KeyErrors across most of this file in a full-suite run. This test
    doesn't depend on that shared, order-fragile state to pass.
    """
    prev_user = app.dependency_overrides.get(auth.get_current_user)
    app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
    try:
        db = SessionLocal()
        clean_sub = _find_clean_sub_avoiding_variance(db, analysis_service)
        db.close()
        if clean_sub is None:
            pytest.skip("no non-variance sub-sample free of keyword for parent-tier pin test")

        created = client.post("/api/lims-analyses", json=_create_payload(clean_sub, analysis_service)).json()
        aid = created["id"]
        _walk_to_to_be_verified(aid)

        promote_resp = client.post("/api/lims-analyses/promote", json={
            "keyword": analysis_service.keyword,
            "result_value": "98.55",
            "sources": [{"analysis_id": aid, "contribution_kind": "chosen"}],
            "reason": "HTTP-TEST: promote",
        })
        assert promote_resp.status_code == 201, promote_resp.text
        parent_row_id = promote_resp.json()["parent"]["id"]
        _rename_parent_for_cleanup(parent_row_id)

        r = client.post(f"/api/lims-analyses/{parent_row_id}/transitions",
                        json={"kind": "retest", "reason": "HTTP-TEST: retest parent"})
        assert r.status_code == 409
        detail = r.json()["detail"]
        assert detail["code"] == "tier_mismatch"
    finally:
        if prev_user is None:
            app.dependency_overrides.pop(auth.get_current_user, None)
        else:
            app.dependency_overrides[auth.get_current_user] = prev_user


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
    assert body["parent"]["review_state"] == "parent_to_verify"
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


# ── Task 3: promotion mints parent_to_verify; verify via generic endpoint ──


@pytest.fixture
def _stable_auth():
    """Re-assert this module's auth override for the test's duration.

    Same rationale as test_retest_on_parent_tier_returns_409_tier_mismatch
    above: several other test modules call app.dependency_overrides.clear()
    unconditionally in their teardown, which wipes this module's
    module-level override without restoring it when tests share a
    full-suite pytest session — confirmed cause of the pre-existing 401s
    across this file outside per-file isolation. Tests below that promote
    +verify multi-step flows depend on this instead of the module-level
    write surviving until they run.
    """
    prev_user = app.dependency_overrides.get(auth.get_current_user)
    app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
    yield
    if prev_user is None:
        app.dependency_overrides.pop(auth.get_current_user, None)
    else:
        app.dependency_overrides[auth.get_current_user] = prev_user


def test_promote_mints_parent_to_verify(_stable_auth, analysis_service):
    """Promotion is submission, not sign-off (spec 2026-08-04)."""
    db = SessionLocal()
    clean_sub = _find_clean_sub_for_route(db, analysis_service)
    db.close()
    if clean_sub is None:
        pytest.skip("no sub-sample free of keyword for parent_to_verify mint test")

    created = client.post("/api/lims-analyses", json=_create_payload(clean_sub, analysis_service)).json()
    aid = created["id"]
    _walk_to_to_be_verified(aid)
    r = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "98.55",
            "sources": [{"analysis_id": aid, "contribution_kind": "chosen"}],
            "reason": "HTTP-TEST: promote mints parent_to_verify",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["parent"]["review_state"] == "parent_to_verify"
    assert body["parent"]["verified_at"] is None
    parent_id = body["parent"]["id"]
    _rename_parent_for_cleanup(parent_id)

    db = SessionLocal()
    transition = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == parent_id,
            LimsAnalysisTransition.from_state.is_(None),
        )
    ).scalars().first()
    db.close()
    assert transition is not None
    assert transition.to_state == "parent_to_verify"


def test_parent_verify_via_generic_endpoint(_stable_auth, analysis_service):
    db = SessionLocal()
    clean_sub = _find_clean_sub_for_route(db, analysis_service)
    db.close()
    if clean_sub is None:
        pytest.skip("no sub-sample free of keyword for verify-endpoint test")

    created = client.post("/api/lims-analyses", json=_create_payload(clean_sub, analysis_service)).json()
    aid = created["id"]
    _walk_to_to_be_verified(aid)
    promote_resp = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "98.55",
            "sources": [{"analysis_id": aid, "contribution_kind": "chosen"}],
            "reason": "HTTP-TEST: promote for verify",
        },
    )
    assert promote_resp.status_code == 201, promote_resp.text
    parent_id = promote_resp.json()["parent"]["id"]
    _rename_parent_for_cleanup(parent_id)

    r = client.post(f"/api/lims-analyses/{parent_id}/transitions",
                    json={"kind": "verify", "reason": "HTTP-TEST: verify parent"})
    assert r.status_code == 200, r.text
    assert r.json()["review_state"] == "verified"

    db = SessionLocal()
    parent_row = db.get(LimsAnalysis, parent_id)
    verified_at = parent_row.verified_at
    transition = db.execute(
        select(LimsAnalysisTransition)
        .where(LimsAnalysisTransition.analysis_id == parent_id)
        .order_by(LimsAnalysisTransition.occurred_at.desc())
    ).scalars().first()
    # Filtered on the embedded analysis_id, not just lims_sample_pk: this is
    # a shared, persistent real DB — other tests (this file and others) can
    # promote+verify other keywords under the SAME parent sample, leaving
    # their own parent_analysis_verified rows on the same lims_sample_pk.
    event = db.execute(
        select(LimsSubSampleEvent).where(
            LimsSubSampleEvent.event == "parent_analysis_verified",
            LimsSubSampleEvent.lims_sample_pk == parent_row.lims_sample_pk,
            text("(details->>'analysis_id')::int = :pid"),
        ).params(pid=parent_id)
    ).scalars().first()
    db.close()
    assert verified_at is not None
    assert transition.to_state == "verified"
    assert transition.transition_kind == "verify"
    assert transition.from_state == "parent_to_verify"
    assert transition.user_id == _FakeUser.id  # the module's auth stub (None)

    # Task 7: activity event, hosted on the parent (not any vial), written
    # in the same commit as the verify transition above. service_origin is
    # asserted against the fixture's OWN service row rather than a hardcoded
    # literal — the live catalog happens to carry no mk1-origin service
    # today, but pinning "senaite" here would silently rot if that changes.
    # Both origin values are covered directly (with a fixed, known service)
    # in test_source_retest_route.py's
    # test_verify_writes_parent_analysis_verified_event_{mk1,senaite_origin}.
    assert event is not None
    assert event.sub_sample_pk is None
    assert event.details == {
        "keyword": analysis_service.keyword,
        "analysis_id": parent_id,
        "service_origin": analysis_service.origin,
    }


def test_verify_on_vial_row_still_409(_stable_auth, sub_sample, analysis_service):
    """Pin: verify stays illegal at the vial tier."""
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "verify", "reason": "HTTP-TEST: verify too early"})
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "tier_mismatch"


def test_repromote_supersedes_parent_to_verify(_stable_auth, analysis_service):
    """Retest + re-promote over an awaiting parent retires it (retracted),
    new row takes the slot."""
    db = SessionLocal()
    clean_sub = _find_clean_sub_for_route(db, analysis_service)
    db.close()
    if clean_sub is None:
        pytest.skip("no sub-sample free of keyword for repromote-supersedes test")

    created = client.post("/api/lims-analyses", json=_create_payload(clean_sub, analysis_service)).json()
    aid = created["id"]
    _walk_to_to_be_verified(aid)
    promote_resp = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "98.55",
            "sources": [{"analysis_id": aid, "contribution_kind": "chosen"}],
            "reason": "HTTP-TEST: initial promote for supersession",
        },
    )
    assert promote_resp.status_code == 201, promote_resp.text
    old_parent_id = promote_resp.json()["parent"]["id"]
    assert promote_resp.json()["parent"]["review_state"] == "parent_to_verify"
    _rename_parent_for_cleanup(old_parent_id)

    retest_resp = client.post(f"/api/lims-analyses/{aid}/transitions",
                              json={"kind": "retest", "reason": "HTTP-TEST: retest for repromote"})
    assert retest_resp.status_code == 200, retest_resp.text
    new_vial_id = retest_resp.json()["id"]
    _walk_to_to_be_verified(new_vial_id, result="99.00")

    repromote_resp = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "99.00",
            "sources": [{"analysis_id": new_vial_id, "contribution_kind": "chosen"}],
            "reason": "HTTP-TEST: repromote supersedes parent_to_verify",
        },
    )
    assert repromote_resp.status_code == 201, repromote_resp.text
    new_parent = repromote_resp.json()["parent"]
    assert new_parent["review_state"] == "parent_to_verify"
    assert new_parent["id"] != old_parent_id
    _rename_parent_for_cleanup(new_parent["id"])

    db = SessionLocal()
    old_parent_row = db.get(LimsAnalysis, old_parent_id)
    db.close()
    assert old_parent_row.review_state == "retracted"


def test_repromote_over_published_supersedes_published_parent(_stable_auth, analysis_service):
    """Handler ruling 2026-08-28: a retest re-promote SUPERSEDES a published
    parent — the published row is retracted ('superseded by retest promotion')
    inside the same transaction and the new row mints parent_to_verify.
    Replaces the former COA-snapshot 409 deferral."""
    db = SessionLocal()
    clean_sub = _find_clean_sub_for_route(db, analysis_service)
    db.close()
    if clean_sub is None:
        pytest.skip("no sub-sample free of keyword for published-collision test")

    created = client.post("/api/lims-analyses", json=_create_payload(clean_sub, analysis_service)).json()
    aid = created["id"]
    _walk_to_to_be_verified(aid)
    promote_resp = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "98.55",
            "sources": [{"analysis_id": aid, "contribution_kind": "chosen"}],
            "reason": "HTTP-TEST: initial promote for published-collision",
        },
    )
    assert promote_resp.status_code == 201, promote_resp.text
    parent_id = promote_resp.json()["parent"]["id"]
    _rename_parent_for_cleanup(parent_id)

    verify_resp = client.post(f"/api/lims-analyses/{parent_id}/transitions",
                              json={"kind": "verify", "reason": "HTTP-TEST: verify before publish"})
    assert verify_resp.status_code == 200, verify_resp.text
    publish_resp = client.post(f"/api/lims-analyses/{parent_id}/transitions",
                               json={"kind": "publish", "reason": "HTTP-TEST: publish for collision test"})
    assert publish_resp.status_code == 200, publish_resp.text

    retest_resp = client.post(f"/api/lims-analyses/{aid}/transitions",
                              json={"kind": "retest", "reason": "HTTP-TEST: retest over published parent"})
    assert retest_resp.status_code == 200, retest_resp.text
    new_vial_id = retest_resp.json()["id"]
    _walk_to_to_be_verified(new_vial_id, result="99.00")

    r = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "99.00",
            "sources": [{"analysis_id": new_vial_id, "contribution_kind": "chosen"}],
            "reason": "HTTP-TEST: repromote over published parent",
        },
    )
    assert r.status_code == 201, r.text
    new_parent = r.json()["parent"]
    _rename_parent_for_cleanup(new_parent["id"])
    assert new_parent["review_state"] == "parent_to_verify"

    db = SessionLocal()
    try:
        old = db.get(LimsAnalysis, parent_id)
        assert old.review_state == "retracted"
        supersede_tr = db.execute(
            select(LimsAnalysisTransition).where(
                LimsAnalysisTransition.analysis_id == parent_id,
                LimsAnalysisTransition.to_state == "retracted",
            )
        ).scalars().all()
        assert any(
            "superseded by retest promotion" in (t.reason or "") for t in supersede_tr
        ), [t.reason for t in supersede_tr]
    finally:
        db.close()


# ── Phase 4b: senaite_shape promoted_to_parent_id ───────────────────────────


def test_senaite_shape_response_includes_promoted_to_parent_id_field(sub_sample, analysis_service):
    """The new field appears in the JSON response even when null. The FE
    treats this as the discriminator for rendering the Promoted badge."""
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    r = client.get(f"/api/lims-analyses?host_kind=sub_sample&host_pk={sub_sample.id}&as=senaite_shape")
    assert r.status_code == 200
    rows = r.json()
    assert rows
    assert all("promoted_to_parent_id" in row for row in rows)
    new_row = next(row for row in rows if row["uid"] == f"mk1:{created['id']}")
    assert new_row["promoted_to_parent_id"] is None
