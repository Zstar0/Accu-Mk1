"""Tests for Task 4/5: threadpool wrapper + hooks A1 (set_analysis_result) and
A2/A3 (transition_analysis).

Hooks the parent-analysis SENAITE->Mk1 shadow mirror into
POST /wizard/senaite/analyses/{uid}/result. The endpoint is `async def`,
takes NO `db` dependency, and calls SENAITE via httpx inside its own
`async with httpx.AsyncClient(...)`. The hook fires AFTER
`resp.raise_for_status()` using only the response's `items[0]` + `req.result`,
via `await run_in_threadpool(_mirror_parent_analysis_bg, ...)` — the wrapper
opens its own SessionLocal(), commits, and swallows every exception so a
mirror failure can never fail or delay-fail the user's edit.

Task 5 wires the SAME wrapper into POST
/wizard/senaite/analyses/{uid}/transition (`transition_analysis`). That
endpoint DOES take a `db: Session = Depends(get_db)` (used by the existing
retest/reject vial cascades) — the mirror hook does NOT use that session; it
opens its own via `_mirror_parent_analysis_bg`, same as A1. The hook fires
only after the DATA-04 silent-rejection check (`actual_state ==
expected_state`) passes, so a silently-rejected transition never mirrors.

House pattern: TestClient(main.app) with get_current_user overridden (see
test_box_label_summaries_batch.py) + httpx.AsyncClient mocked via
patch("httpx.AsyncClient") + __aenter__/__aexit__ (see
test_native_manage_analyses.py). DB-side assertions use a live SessionLocal()
exactly like test_parent_mirror_helper.py (TEST-prefixed LimsSample + a real
seeded AnalysisService keyword + FK-safe cleanup).
"""
from __future__ import annotations

import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import main
from auth import get_current_user
from database import SessionLocal
from lims_analyses.parent_mirror import SHADOW_STATE
from models import (
    AnalysisService, HplcMethod, Instrument, LimsAnalysis,
    LimsAnalysisTransition, LimsSample,
)

TEST_SAMPLE_ID = "TEST-PM4-PARENT"
# A7-add needs a dedicated AnalysisService (not a shared seeded row we'd have
# to mutate) so the endpoint can resolve service_uid -> keyword; see Task 8.
TEST_ADD_SERVICE_KEYWORD = "TEST-PM8-ADDKW"


def _client() -> TestClient:
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides[get_current_user] = (
        lambda: {"email": "a@x", "role": "standard"})
    return TestClient(main.app)


def _client_as_user(user_id: int = 42) -> TestClient:
    """Task 8 endpoints (add/remove/replace) read `_current_user.id` — the
    plain-dict override used by `_client()` for A1/A2/A4 has no `.id` and
    would AttributeError before those handlers ever reach the mirror hook."""
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides[get_current_user] = (
        lambda: MagicMock(id=user_id, email="a@x", role="standard"))
    return TestClient(main.app)


def _mock_is_proxy(*, post_json=None, delete_json=None, get_json=None):
    """Patch httpx.AsyncClient for the non-native IS-proxy branches of
    add/remove/replace (see test_native_manage_analyses.py's _is_proxy_mock).
    Caller must .stop() the returned patcher."""
    mock_instance = AsyncMock()
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json = MagicMock(return_value={})
    if post_json is not None:
        post_resp = MagicMock()
        post_resp.raise_for_status = MagicMock()
        post_resp.json = MagicMock(return_value=post_json)
        mock_instance.post = AsyncMock(return_value=post_resp)
    if delete_json is not None:
        delete_resp = MagicMock()
        delete_resp.raise_for_status = MagicMock()
        delete_resp.json = MagicMock(return_value=delete_json)
        mock_instance.delete = AsyncMock(return_value=delete_resp)
    if get_json is not None:
        get_resp = MagicMock()
        get_resp.raise_for_status = MagicMock()
        get_resp.json = MagicMock(return_value=get_json)
        mock_instance.get = AsyncMock(return_value=get_resp)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    """Pick any seeded analysis_service with a non-null keyword."""
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def seed_parent_and_service(db, analysis_service):
    """A fresh TEST-prefixed parent LimsSample + an existing seeded service."""
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="received")
    db.add(parent)
    db.commit()
    db.refresh(parent)
    return parent, analysis_service


@pytest.fixture
def seed_method_instrument(db):
    """An existing seeded HplcMethod (senaite_id set) + Instrument
    (senaite_uid set) — prefer real seeded rows over TEST-prefixed ones per
    the house convention, since the dev DB reliably carries both."""
    method = db.execute(
        select(HplcMethod).where(HplcMethod.senaite_id.isnot(None))
    ).scalars().first()
    instrument = db.execute(
        select(Instrument).where(Instrument.senaite_uid.isnot(None))
    ).scalars().first()
    if method is None or instrument is None:
        pytest.skip("no seeded HplcMethod/Instrument with a senaite id/uid available")
    return method, instrument


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.rollback()
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id.in_(
            select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sample_pk.in_(
                    select(LimsSample.id).where(LimsSample.sample_id == TEST_SAMPLE_ID)
                )
            )
        )
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id == TEST_SAMPLE_ID)
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id == TEST_SAMPLE_ID))
    # Task 8: the dedicated A7-add AnalysisService (LimsAnalysis rows that
    # reference it are already gone via the delete above).
    db.execute(delete(AnalysisService).where(
        AnalysisService.keyword == TEST_ADD_SERVICE_KEYWORD
    ))
    db.commit()


@pytest.fixture
def seed_add_service(db):
    """A fresh TEST-prefixed AnalysisService with a real senaite_uid — used
    only by the A7-add test. The IS proxy response for add carries no
    keyword, so the endpoint must resolve service_uid -> keyword via this
    table; a real seeded service row is never mutated for this (would
    corrupt shared seed data), hence a dedicated throwaway row."""
    svc = AnalysisService(
        title="TEST PM8 Add Service",
        keyword=TEST_ADD_SERVICE_KEYWORD,
        senaite_uid="TEST-PM8-ADD-UID",
    )
    db.add(svc)
    db.commit()
    db.refresh(svc)
    return svc


@pytest.fixture
def replace_analyte_peptides(db):
    """Two distinct seeded peptides, each with a full ID_/PUR_/QTY_ service
    set (replace_analyte's offer-only gate) — the NEW peptide's Identity
    service also needs a senaite_uid to drive the IS-proxy add in step 5.
    Picked from real seed data; nothing is created or mutated."""
    from lims_analyses.service import peptide_has_full_service_set

    pids = db.execute(
        select(AnalysisService.peptide_id)
        .where(AnalysisService.peptide_id.is_not(None)).distinct()
    ).scalars().all()
    full = [pid for pid in pids if peptide_has_full_service_set(db, peptide_id=pid)]

    def _id_svc(pid):
        return db.execute(
            select(AnalysisService).where(
                AnalysisService.peptide_id == pid,
                AnalysisService.keyword.like("ID%"),
            )
        ).scalars().first()

    for new_pid in full:
        new_id_svc = _id_svc(new_pid)
        if not (new_id_svc and new_id_svc.senaite_uid):
            continue
        for old_pid in full:
            if old_pid == new_pid:
                continue
            if _id_svc(old_pid) is not None:
                return old_pid, new_pid
    pytest.skip(
        "need >=2 seeded peptides with a full ID_/PUR_/QTY_ service set "
        "(new peptide's Identity service also needing a senaite_uid)"
    )


def _mock_senaite_update(*, review_state, keyword, get_request_id):
    """Patch httpx.AsyncClient so set_analysis_result's POST to SENAITE's
    /update/{uid} returns items[0] echoing review_state/Keyword/getRequestID.
    Caller must .stop() the returned patcher."""
    mock_instance = AsyncMock()
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json = MagicMock(return_value={
        "items": [{
            "review_state": review_state,
            "Keyword": keyword,
            "getRequestID": get_request_id,
        }]
    })
    mock_instance.post = AsyncMock(return_value=mock_resp)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p


def test_set_result_writes_shadow_row(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword=svc.keyword,
        get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-123/result", json={"result": "42%"}
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()
    assert row.result_value == "42%"
    assert row.mirror_review_state == "to_be_verified"


def test_mirror_failure_never_fails_the_response(caplog):
    """The never-fails contract: mirror_parent_analysis raising must not
    change the endpoint's success response, and must log a warning."""
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword="ANY-KW",
        get_request_id="P-DOESNT-MATTER",
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             patch("lims_analyses.parent_mirror.mirror_parent_analysis",
                   side_effect=RuntimeError("boom")), \
             caplog.at_level(logging.WARNING):
            r = _client().post(
                "/wizard/senaite/analyses/UID-999/result", json={"result": "1"}
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["message"] == "Result updated"
    assert any("registry.analysis_mirror_failed" in rec.message for rec in caplog.records)


def test_missing_request_id_skips_mirror_silently(db):
    """No getRequestID/RequestID in the SENAITE response item -> the hook is
    a no-op (per brief: skip silently, no extra SENAITE fetch). Response is
    unaffected either way."""
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword="ANY-KW", get_request_id=None,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-777/result", json={"result": "1"}
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    assert r.json()["success"] is True


# ═══════════════════════════════════════════════════════════════════════════
# Task 5: hook A2/A3 — transition_analysis (state mirror + retest)
# ═══════════════════════════════════════════════════════════════════════════


def test_transition_verify_mirrors_state(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    proxy = _mock_senaite_update(
        review_state="verified", keyword=svc.keyword, get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-1/transition", json={"transition": "verify"}
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    assert r.json()["success"] is True

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()
    assert row.mirror_review_state == "verified"


def test_transition_retest_mirrors_new_row(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    # EXPECTED_POST_STATES["retest"] == "verified" too — SENAITE keeps the OLD
    # line at 'verified' and spawns a new analysis object under the hood.
    proxy = _mock_senaite_update(
        review_state="verified", keyword=svc.keyword, get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            client = _client()
            r1 = client.post(
                "/wizard/senaite/analyses/UID-1/transition", json={"transition": "verify"}
            )
            r2 = client.post(
                "/wizard/senaite/analyses/UID-1/transition", json={"transition": "retest"}
            )
    finally:
        proxy.stop()

    assert r1.status_code == 200 and r1.json()["success"] is True
    assert r2.status_code == 200 and r2.json()["success"] is True

    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).all()
    assert len(rows) == 2
    assert any(row.retested for row in rows)
    live = [row for row in rows if not row.retested]
    assert len(live) == 1
    # FIX 2: the new live retest row is born unassigned, NOT stamped with
    # `actual_state` ("verified") — that state describes the OLD line
    # SENAITE echoed back, not the freshly-spawned retest analysis.
    assert live[0].mirror_review_state == "unassigned"
    assert live[0].retest_of_id is not None
    superseded = [row for row in rows if row.retested]
    assert superseded[0].mirror_review_state == "verified"  # old row untouched


def test_transition_silent_rejection_no_mirror(db, seed_parent_and_service):
    """SENAITE returns a review_state that doesn't match EXPECTED_POST_STATES
    for the requested transition (silent rejection, DATA-04) -> success=False
    AND the mirror hook must not run at all (no shadow row written)."""
    parent, svc = seed_parent_and_service
    proxy = _mock_senaite_update(
        review_state="unassigned", keyword=svc.keyword, get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-1/transition", json={"transition": "verify"}
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    body = r.json()
    assert body["success"] is False

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one_or_none()
    assert row is None


# ═══════════════════════════════════════════════════════════════════════════
# Task 6: hook A4 — set_analysis_method_instrument (SENAITE-uid resolution)
# ═══════════════════════════════════════════════════════════════════════════


def test_method_instrument_mirrors_resolved_ids(db, seed_parent_and_service,
                                                 seed_method_instrument):
    """A method_uid/instrument_uid that resolve to a real Mk1 HplcMethod /
    Instrument land as method_id/instrument_id on the shadow row.

    NOTE: HplcMethod has no senaite_uid column — resolve_method_id matches
    on senaite_id instead (see parent_mirror.py docstring). The seeded
    method's senaite_id doubles as the "uid" sent to the endpoint here for
    exactly that reason.
    """
    parent, svc = seed_parent_and_service
    method, instrument = seed_method_instrument
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword=svc.keyword,
        get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-1/method-instrument",
                json={
                    "method_uid": method.senaite_id,
                    "instrument_uid": instrument.senaite_uid,
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    assert r.json()["success"] is True

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()
    assert row.method_id == method.id
    assert row.instrument_id == instrument.id


def test_method_instrument_unresolvable_uids_writes_row_with_none(
        db, seed_parent_and_service):
    """Unknown method_uid/instrument_uid (no matching Mk1 row) must not kill
    the mirror — the shadow row is still written/updated, with method_id and
    instrument_id left None."""
    parent, svc = seed_parent_and_service
    proxy = _mock_senaite_update(
        review_state="to_be_verified", keyword=svc.keyword,
        get_request_id=parent.sample_id,
    )
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client().post(
                "/wizard/senaite/analyses/UID-1/method-instrument",
                json={
                    "method_uid": "TEST-NO-SUCH-METHOD-UID",
                    "instrument_uid": "TEST-NO-SUCH-INSTRUMENT-UID",
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    assert r.json()["success"] is True

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()
    assert row.method_id is None
    assert row.instrument_id is None


# ═══════════════════════════════════════════════════════════════════════════
# Task 8: A7 remove — remove_sample_analysis (non-native IS-proxy branch)
# ═══════════════════════════════════════════════════════════════════════════


def test_remove_marks_shadow_row_rejected(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    from lims_analyses.parent_mirror import mirror_parent_analysis
    mirror_parent_analysis(
        db, sample_id=parent.sample_id, keyword=svc.keyword,
        mirror_review_state="to_be_verified", result_value="1",
    )
    db.commit()

    proxy = _mock_is_proxy(delete_json={"success": True, "message": "proxied"})
    try:
        r = _client_as_user().delete(
            f"/explorer/samples/{parent.sample_id}/analyses/{svc.keyword}"
        )
    finally:
        proxy.stop()

    assert r.status_code == 200
    assert r.json()["success"] is True

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).one()
    # The shadow row is stamped, never deleted (audit trail) — its sentinel
    # review_state is untouched; only mirror_review_state records SENAITE truth.
    assert row.review_state == SHADOW_STATE
    assert row.mirror_review_state == "rejected"


# ═══════════════════════════════════════════════════════════════════════════
# Task 8: A7 add — add_sample_analysis (non-native IS-proxy branch)
# ═══════════════════════════════════════════════════════════════════════════


def test_add_creates_shadow_row_unassigned(db, seed_parent_and_service, seed_add_service):
    parent, _svc = seed_parent_and_service

    proxy = _mock_is_proxy(post_json={"success": True, "message": "proxied"})
    try:
        r = _client_as_user().post(
            f"/explorer/samples/{parent.sample_id}/analyses",
            json={"service_uid": seed_add_service.senaite_uid},
        )
    finally:
        proxy.stop()

    assert r.status_code == 200

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow",
        analysis_service_id=seed_add_service.id,
    ).one()
    assert row.keyword == seed_add_service.keyword
    assert row.mirror_review_state == "unassigned"
    # No result yet — the shadow row mirrors the line's existence, not a result.
    assert row.result_value is None


def test_add_unresolvable_service_uid_skips_mirror_silently(db, seed_parent_and_service):
    """service_uid with no matching AnalysisService.senaite_uid -> the mirror
    is a documented no-op. Response is unaffected."""
    parent, _svc = seed_parent_and_service

    proxy = _mock_is_proxy(post_json={"success": True, "message": "proxied"})
    try:
        r = _client_as_user().post(
            f"/explorer/samples/{parent.sample_id}/analyses",
            json={"service_uid": "TEST-NO-SUCH-SERVICE-UID"},
        )
    finally:
        proxy.stop()

    assert r.status_code == 200
    assert r.json()["success"] is True

    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).all()
    assert rows == []


# ═══════════════════════════════════════════════════════════════════════════
# Task 8: A5 replace-analyte — replace_analyte (identity swap)
# ═══════════════════════════════════════════════════════════════════════════


def test_replace_analyte_mirrors_old_rejected_new_unassigned(
        db, seed_parent_and_service, replace_analyte_peptides):
    parent, _svc = seed_parent_and_service
    old_pid, new_pid = replace_analyte_peptides

    old_id_kw = db.execute(
        select(AnalysisService.keyword).where(
            AnalysisService.peptide_id == old_pid,
            AnalysisService.keyword.like("ID%"),
        )
    ).scalars().first()
    new_id_svc = db.execute(
        select(AnalysisService).where(
            AnalysisService.peptide_id == new_pid,
            AnalysisService.keyword.like("ID%"),
        )
    ).scalars().first()

    proxy = _mock_is_proxy(post_json={"success": True}, delete_json={"success": True})
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             patch.object(
                 main, "update_senaite_sample_fields",
                 AsyncMock(return_value=MagicMock(success=True)),
             ), \
             patch("sub_samples.senaite.fetch_parent_metadata",
                   side_effect=RuntimeError("no live SENAITE in tests")):
            r = _client_as_user().post(
                f"/explorer/samples/{parent.sample_id}/analytes/1/replace",
                json={
                    "new_peptide_id": new_pid,
                    "old_peptide_id": old_pid,
                    "senaite_uid": "TEST-PM8-REPLACE-AR-UID",
                },
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True

    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).all()
    by_kw = {row.keyword: row for row in rows}
    assert by_kw[old_id_kw].mirror_review_state == "rejected"
    assert by_kw[new_id_svc.keyword].mirror_review_state == "unassigned"


# ═══════════════════════════════════════════════════════════════════════════
# Task 8: A6 publish — publish_sample_coa (call-site presence; see
# test_parent_mirror_helper.py for the mark_parent_shadows_published
# behavior-level coverage — full-flow httpx stubbing of publish-coa's three
# external calls (IS publish, SENAITE VerificationCode write, SENAITE
# publish transition) was disproportionately brittle for this slice, per the
# controller's pre-authorized fallback).
# ═══════════════════════════════════════════════════════════════════════════


def _drive_publish_coa(sample_id: str, *, transition_state: str,
                       reread_state: str | None = None):
    """Drive the real publish-coa endpoint through its external calls, all
    served by ONE generic httpx.AsyncClient mock — publish-coa's own logic
    short-circuits the VerificationCode POST when the IS response carries no
    `verification_code`, so a single {"success": True, "items": [...]} body
    satisfies both the IS publish-coa gate and the SENAITE transition
    response. `transition_state` is the review_state the transition POST
    echoes; `reread_state`, when set, is what the verify re-read GET returns
    (the search GET body carries it too — harmless, the search only reads
    `uid`). `_mark_shadows_published_bg` is stubbed to a recording list.
    Returns (response, calls). Kept deliberately minimal per the
    controller's pre-authorized fallback for A6 (full multi-branch httpx
    routing would be disproportionate here)."""
    mock_instance = AsyncMock()
    get_item = {"uid": "AR-UID-PUBLISH-1"}
    if reread_state is not None:
        get_item["review_state"] = reread_state
    get_resp = MagicMock()
    get_resp.raise_for_status = MagicMock()
    get_resp.status_code = 200
    get_resp.json = MagicMock(return_value={"items": [get_item]})
    mock_instance.get = AsyncMock(return_value=get_resp)

    post_resp = MagicMock()
    post_resp.raise_for_status = MagicMock()
    post_resp.json = MagicMock(return_value={
        "success": True, "message": "ok",
        "items": [{"review_state": transition_state}],
    })
    mock_instance.post = AsyncMock(return_value=post_resp)

    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)

    calls = []
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             patch.object(
                 main, "_mark_shadows_published_bg",
                 lambda sample_id: calls.append(sample_id),
             ):
            r = _client_as_user().post(
                f"/wizard/senaite/samples/{sample_id}/publish-coa"
            )
    finally:
        p.stop()
    return r, calls


def test_publish_wires_mark_shadows_published_on_success(db, seed_parent_and_service):
    """AR actually reached 'published' -> `_mark_shadows_published_bg` (not
    the DB effect — that's helper-level, see test_parent_mirror_helper.py)
    fires exactly once with the resolved sample_id, after the reconciliation
    block passes."""
    parent, _svc = seed_parent_and_service
    r, calls = _drive_publish_coa(parent.sample_id, transition_state="published")

    assert r.status_code == 200, r.text
    assert r.json()["success"] is True
    assert calls == [parent.sample_id]


def test_publish_no_mirror_when_prepublish_state(db, seed_parent_and_service):
    """Transition echoes a non-accepted state and the verify re-read resolves
    to a PRE-PUBLISH state (ready_for_initial_review): the endpoint succeeds
    with a warning (the COA is live in our system) but the SENAITE analyses
    are NOT published — the shadow mirror must not stamp 'published'."""
    parent, _svc = seed_parent_and_service
    r, calls = _drive_publish_coa(
        parent.sample_id,
        transition_state="ready_for_initial_review",
        reread_state="ready_for_initial_review",
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert body["warning"]  # the pre-publish warning path was taken
    assert calls == []


def test_publish_no_mirror_when_partial_publish_deferred(db, seed_parent_and_service):
    """Transition echoes an ACCEPTED-but-not-published state
    (to_be_verified — the lab partial-publish / addon flow): the endpoint
    succeeds cleanly, but SENAITE deferred the workflow publish, so the
    analyses are not published there and the mirror must not fire. When
    publish lands later, per-line A2/A3 hooks and/or the next publish call
    record it."""
    parent, _svc = seed_parent_and_service
    r, calls = _drive_publish_coa(
        parent.sample_id, transition_state="to_be_verified",
    )

    assert r.status_code == 200, r.text
    assert r.json()["success"] is True
    assert calls == []
