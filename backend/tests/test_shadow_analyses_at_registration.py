"""Shadow-at-registration: a parent AR's analysis lines must appear as native
shadow rows as soon as the sample is REGISTERED, not only once a result or
transition event fires.

Why this exists: the parent-analysis mirror hooks are event-driven
(result/transition/replace/remove/publish). A freshly-registered sample has had
none of those, so `build_native_details` returns ZERO analyses for it — in mk1
read mode the bench would see an empty analysis list and pending tests would
vanish. Same root gap also hides lines that were registered-then-rejected
without ever carrying a result.

Seam: `sync_parent_shadows_from_items` is PURE DB (no HTTP) — it takes the
already-fetched SENAITE catalog items, exactly like `select_current_lines`
does, so these tests never touch the network. The SENAITE fetch itself lives
in the caller (the registration hook), matching where every other SENAITE call
already lives.
"""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from lims_analyses.parent_mirror import SHADOW_STATE
from models import (
    AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample,
    LimsWorkflowShadowEvaluation,
)

TEST_SAMPLE_IDS = ["TEST-SAR-PARENT", "TEST-SAR-UNREG", "TEST-SAR-REG"]


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def two_analysis_services(db):
    """Two seeded services with DISTINCT keywords. Distinctness matters: the
    keyword column carries no unique constraint (a sync re-run has cloned
    keywords in prod before), and a shared keyword would collapse the two
    lines this test asserts on into one."""
    svcs = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
        .order_by(AnalysisService.id)
    ).scalars().all()
    seen: dict[str, AnalysisService] = {}
    for s in svcs:
        seen.setdefault(s.keyword, s)
        if len(seen) == 2:
            break
    if len(seen) < 2:
        pytest.skip("need >=2 seeded analysis_services rows with distinct keywords")
    return list(seen.values())


@pytest.fixture
def parent(db):
    row = LimsSample(
        sample_id="TEST-SAR-PARENT",
        external_lims_uid="uid-test-sar-1",
        external_lims_system="senaite",
    )
    db.add(row)
    db.flush()
    return row


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.rollback()
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id.in_(
            select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sample_pk.in_(
                    select(LimsSample.id).where(LimsSample.sample_id.in_(TEST_SAMPLE_IDS))
                )
            )
        )
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id.in_(TEST_SAMPLE_IDS))
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id.in_(TEST_SAMPLE_IDS)))
    db.commit()


def _item(uid, keyword, **kw):
    """A SENAITE Analysis-catalog item, same shape fetch_parent_analyses
    yields (mirrors test_backfill_parent_analysis_shadows._item)."""
    base = {"uid": uid, "keyword": keyword, "result": None, "unit": None,
            "review_state": None, "retest_of_uid": None, "instrument_uid": None,
            "created": None}
    base.update(kw)
    return base


def _shadow_rows(db, parent_pk):
    return db.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent_pk)
    ).scalars().all()


def test_registration_sync_creates_a_shadow_row_per_line(db, parent, two_analysis_services):
    """The core gap: a just-registered sample's SENAITE lines become shadow
    rows immediately, with no result and no transition event ever having
    fired."""
    from lims_analyses.parent_mirror import sync_parent_shadows_from_items

    svc_a, svc_b = two_analysis_services
    items = [
        _item("A", svc_a.keyword, review_state="registered", unit="%"),
        _item("B", svc_b.keyword, review_state="unassigned"),
    ]

    stats = sync_parent_shadows_from_items(db, sample_id="TEST-SAR-PARENT", items=items)
    db.flush()

    rows = _shadow_rows(db, parent.id)
    assert {r.keyword for r in rows} == {svc_a.keyword, svc_b.keyword}
    assert all(r.provenance == "shadow" for r in rows)
    assert all(r.review_state == SHADOW_STATE for r in rows)
    assert {r.mirror_review_state for r in rows} == {"registered", "unassigned"}
    assert stats["created"] == 2
    assert stats["updated"] == 0


def test_registration_sync_is_idempotent_and_never_duplicates(db, parent, two_analysis_services):
    """Re-running (rider sweep, retry, a later real event) must UPDATE the
    live shadow row, never add a second one — the row this writes has to be
    the same row `mirror_parent_analysis` finds later, or a missing-analyses
    diff becomes a doubled-analyses diff."""
    from lims_analyses.parent_mirror import sync_parent_shadows_from_items

    svc_a, _ = two_analysis_services
    items = [_item("A", svc_a.keyword, review_state="registered")]

    sync_parent_shadows_from_items(db, sample_id="TEST-SAR-PARENT", items=items)
    db.flush()
    second = sync_parent_shadows_from_items(
        db, sample_id="TEST-SAR-PARENT",
        items=[_item("A", svc_a.keyword, review_state="unassigned")],
    )
    db.flush()

    rows = [r for r in _shadow_rows(db, parent.id) if r.keyword == svc_a.keyword]
    assert len(rows) == 1, "second sync must not create a duplicate line"
    assert rows[0].mirror_review_state == "unassigned", "state must advance in place"
    assert second["created"] == 0
    assert second["updated"] == 1


def test_registration_sync_drops_retest_superseded_lines(db, parent, two_analysis_services):
    """Registration sync records CURRENT state: a superseded line must not
    become its own shadow row (same selection rule as the backfill)."""
    from lims_analyses.parent_mirror import sync_parent_shadows_from_items

    svc_a, _ = two_analysis_services
    items = [
        _item("A", svc_a.keyword, result="1"),
        _item("B", svc_a.keyword, result="2", retest_of_uid="A"),
    ]

    sync_parent_shadows_from_items(db, sample_id="TEST-SAR-PARENT", items=items)
    db.flush()

    rows = [r for r in _shadow_rows(db, parent.id) if r.keyword == svc_a.keyword]
    assert len(rows) == 1
    assert rows[0].result_value == "2"


def test_registration_sync_no_ops_for_an_unregistered_parent(db, two_analysis_services):
    """No registry row yet -> no rows written, no raise. The hook is
    best-effort and must stay silent rather than half-write."""
    from lims_analyses.parent_mirror import sync_parent_shadows_from_items

    svc_a, _ = two_analysis_services
    stats = sync_parent_shadows_from_items(
        db, sample_id="TEST-SAR-UNREG", items=[_item("A", svc_a.keyword)],
    )
    db.flush()

    assert stats["created"] == 0
    assert stats["skipped"] == 1


def test_registration_sync_skips_unknown_keywords_without_failing_the_batch(
    db, parent, two_analysis_services
):
    """An unmapped SENAITE keyword must not abort the whole sync — the known
    line still lands."""
    from lims_analyses.parent_mirror import sync_parent_shadows_from_items

    svc_a, _ = two_analysis_services
    items = [
        _item("A", "TEST-SAR-NO-SUCH-KEYWORD"),
        _item("B", svc_a.keyword, review_state="registered"),
    ]

    stats = sync_parent_shadows_from_items(db, sample_id="TEST-SAR-PARENT", items=items)
    db.flush()

    rows = _shadow_rows(db, parent.id)
    assert {r.keyword for r in rows} == {svc_a.keyword}
    assert stats["created"] == 1
    assert stats["skipped"] == 1


# ═══════════════════════════════════════════════════════════════════════════
# The registration hook itself — IS's creation signal must leave the sample
# already shadowed, with no result/transition event ever firing.
# ═══════════════════════════════════════════════════════════════════════════


def test_s2s_registration_signal_shadows_the_ar_analyses(db, two_analysis_services):
    """End-to-end through the real S2S route IS calls: after the creation
    signal, the sample's SENAITE analysis lines exist as native shadow rows.

    Asserts on real committed rows, not on the mock — the only thing patched
    is the SENAITE HTTP boundary."""
    from fastapi.testclient import TestClient
    from main import app

    svc_a, _ = two_analysis_services
    items = [_item("A", svc_a.keyword, review_state="registered", unit="%")]

    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-secret"}), \
            patch("sub_samples.senaite.fetch_parent_analyses", return_value=items):
        client = TestClient(app)
        resp = client.post(
            "/s2s/lims-samples",
            json={
                "sample_id": "TEST-SAR-REG",
                "senaite_uid": "uid-test-sar-reg",
                "meta": {"uid": "uid-test-sar-reg", "review_state": "sample_due"},
            },
            headers={"X-Service-Token": "test-secret"},
        )

    assert resp.status_code == 200, resp.text

    # Fresh session: the hook commits on its OWN session, so read it back
    # independently of this test's session snapshot.
    fresh = SessionLocal()
    try:
        parent = fresh.execute(
            select(LimsSample).where(LimsSample.sample_id == "TEST-SAR-REG")
        ).scalar_one()
        rows = fresh.execute(
            select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id)
        ).scalars().all()
        assert [r.keyword for r in rows] == [svc_a.keyword]
        assert rows[0].provenance == "shadow"
        assert rows[0].review_state == SHADOW_STATE
        assert rows[0].mirror_review_state == "registered"
    finally:
        fresh.close()


def test_s2s_registration_shadows_even_when_the_signal_carries_no_uid(
    db, two_analysis_services
):
    """A SENAITE-ATTACHED signal whose create result didn't expose a uid must
    still sync. The IS adapter documents `senaite_uid` as optional ("Mk1 fills
    uid via its reconcile later"), and the shadow fetch keys on the SAMPLE ID,
    not the uid — so gating the hook on external_lims_uid would silently skip
    these. SENAITE-free rows (no sample_id -> external_lims_system 'mk1') are
    the only ones with genuinely nothing to mirror."""
    from fastapi.testclient import TestClient
    from main import app

    svc_a, _ = two_analysis_services
    items = [_item("A", svc_a.keyword, review_state="registered")]

    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-secret"}), \
            patch("sub_samples.senaite.fetch_parent_analyses", return_value=items):
        client = TestClient(app)
        resp = client.post(
            "/s2s/lims-samples",
            json={
                "sample_id": "TEST-SAR-REG",
                "senaite_uid": None,                       # create result exposed none
                "meta": {"review_state": "sample_due"},    # and no "uid" key either
            },
            headers={"X-Service-Token": "test-secret"},
        )

    assert resp.status_code == 200, resp.text
    fresh = SessionLocal()
    try:
        parent = fresh.execute(
            select(LimsSample).where(LimsSample.sample_id == "TEST-SAR-REG")
        ).scalar_one()
        assert parent.external_lims_uid is None, "precondition: row has no uid"
        rows = fresh.execute(
            select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id)
        ).scalars().all()
        assert [r.keyword for r in rows] == [svc_a.keyword]
    finally:
        fresh.close()


# ═══════════════════════════════════════════════════════════════════════════
# Side-by-side engine: registration must also ARM native_status (P-0140
# coverage-decay finding, 2026-07-27). A sample minted after the catalog
# seed run gets native_status=NULL forever otherwise — the engine skips
# NULL by design, so burn-in coverage silently decays for every sample
# created post-go-live. This is a SEPARATE bg task from the shadow-sync one
# above (see test below for the "survives a SENAITE failure" proof), so it
# runs to completion independent of the SENAITE fetch outcome.
# ═══════════════════════════════════════════════════════════════════════════


def test_s2s_registration_signal_arms_native_status(db, two_analysis_services):
    """First-touch arming: the registration signal arms native_status on a
    newly-minted row to its current status, with a 'seeded'/'registration'
    trajectory row. Asserts on real committed rows via a fresh session —
    the arming bg task commits on its own session, same as its shadow-sync
    sibling."""
    from fastapi.testclient import TestClient
    from main import app

    svc_a, _ = two_analysis_services
    items = [_item("A", svc_a.keyword, review_state="registered", unit="%")]

    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-secret"}), \
            patch("sub_samples.senaite.fetch_parent_analyses", return_value=items):
        client = TestClient(app)
        resp = client.post(
            "/s2s/lims-samples",
            json={
                "sample_id": "TEST-SAR-REG",
                "senaite_uid": "uid-test-sar-reg",
                "meta": {"uid": "uid-test-sar-reg", "review_state": "sample_due"},
            },
            headers={"X-Service-Token": "test-secret"},
        )

    assert resp.status_code == 200, resp.text

    fresh = SessionLocal()
    try:
        parent = fresh.execute(
            select(LimsSample).where(LimsSample.sample_id == "TEST-SAR-REG")
        ).scalar_one()
        assert parent.native_status is not None
        assert parent.native_status == parent.status
        evals = fresh.execute(
            select(LimsWorkflowShadowEvaluation).where(
                LimsWorkflowShadowEvaluation.lims_sample_pk == parent.id)
        ).scalars().all()
        assert any(e.outcome == "seeded" and e.trigger == "registration"
                   for e in evals)
    finally:
        fresh.close()


def test_s2s_registration_arm_survives_a_senaite_failure(db, two_analysis_services):
    """Arming must not be coupled to the SENAITE analyses shadow-sync
    outcome — a SENAITE outage there must not leave the sample unarmed."""
    from fastapi.testclient import TestClient
    from main import app

    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-secret"}), \
            patch("sub_samples.senaite.fetch_parent_analyses",
                  side_effect=RuntimeError("SENAITE down")):
        client = TestClient(app)
        resp = client.post(
            "/s2s/lims-samples",
            json={
                "sample_id": "TEST-SAR-REG",
                "senaite_uid": "uid-test-sar-reg",
                "meta": {"uid": "uid-test-sar-reg", "review_state": "sample_due"},
            },
            headers={"X-Service-Token": "test-secret"},
        )

    assert resp.status_code == 200, resp.text
    fresh = SessionLocal()
    try:
        parent = fresh.execute(
            select(LimsSample).where(LimsSample.sample_id == "TEST-SAR-REG")
        ).scalar_one()
        assert parent.native_status == parent.status
    finally:
        fresh.close()


def test_s2s_registration_signal_survives_a_senaite_failure(db, two_analysis_services):
    """A SENAITE outage must never fail the registration signal — the row is
    still created, the shadow sync is simply skipped. IS treats this call as
    best-effort, but a 500 here would still log an order-processing error."""
    from fastapi.testclient import TestClient
    from main import app

    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-secret"}), \
            patch("sub_samples.senaite.fetch_parent_analyses",
                  side_effect=RuntimeError("SENAITE down")):
        client = TestClient(app)
        resp = client.post(
            "/s2s/lims-samples",
            json={
                "sample_id": "TEST-SAR-REG",
                "senaite_uid": "uid-test-sar-reg",
                "meta": {"uid": "uid-test-sar-reg", "review_state": "sample_due"},
            },
            headers={"X-Service-Token": "test-secret"},
        )

    assert resp.status_code == 200, resp.text
    fresh = SessionLocal()
    try:
        parent = fresh.execute(
            select(LimsSample).where(LimsSample.sample_id == "TEST-SAR-REG")
        ).scalar_one_or_none()
        assert parent is not None, "registration must survive a SENAITE failure"
    finally:
        fresh.close()
