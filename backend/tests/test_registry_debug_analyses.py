"""Tests for Task 10: registry-inspect debug panel's analyses sync column
(2026-07-07-sample-registry-debug-panel-design.md, Handler amendment).

Covers `main._build_analysis_debug_rows` (the DB+SENAITE-touching builder)
and `lims_analyses.parent_mirror.build_analysis_sync_rows` (the pure
per-keyword comparison it delegates to). Split per house convention (see
test_registry_debug.py / test_registry_debug_endpoint.py): the status matrix
(in_sync/drift/no_shadow/shadow_only + summary counts) is proven on the PURE
function with no DB and no mocks; the live-DB half (SessionLocal(), a
TEST-prefixed LimsSample + a real seeded AnalysisService — house pattern per
test_parent_mirror_helper.py) proves only what the pure function can't: the
live-shadow / current-canonical row SELECTION from `lims_analyses`,
non-mutation (no new lims_analyses rows written), and the analyses-specific
SENAITE-error degradation. The SENAITE fetch seam is monkeypatched via
`main.senaite.fetch_parent_analyses` — the same idiom test_registry_debug_endpoint.py
already uses for `main.senaite.fetch_parent_metadata` / `fetch_secondaries`.

NOTE: Viewing triggers the passive observer (Task 7) which UPDATEs/audits
existing shadows asynchronously; the non-mutation guarantee holds only for
lims_analyses row COUNT (never INSERTs new rows; observer only UPDATEs +
inserts audit transition rows).
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy import delete, func, select

import main
from database import SessionLocal
from lims_analyses.parent_mirror import build_analysis_sync_rows
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample

TEST_SAMPLE_ID = "TEST-RD10-PARENT"


def _senaite_item(uid, keyword, **kw):
    base = {"uid": uid, "keyword": keyword, "result": None, "unit": None,
            "review_state": None, "retest_of_uid": None, "instrument_uid": None,
            "created": None}
    base.update(kw)
    return base


# ═══════════════════════════════════════════════════════════════════════════
# Pure: build_analysis_sync_rows status matrix — no DB, no mocks (mirrors how
# diff_registry_vs_senaite is unit-tested in test_registry_debug.py)
# ═══════════════════════════════════════════════════════════════════════════


def test_in_sync_when_state_and_result_match():
    out = build_analysis_sync_rows(
        {"KW1": {"review_state": "verified", "result": "99.2", "title": "T"}},
        {"KW1": {"mirror_review_state": "verified", "result": "99.2", "title": "T"}},
        {},
    )
    assert out["rows"] == [{
        "keyword": "KW1", "title": "T",
        "senaite": {"review_state": "verified", "result": "99.2"},
        "shadow": {"mirror_review_state": "verified", "result": "99.2"},
        "canonical": None, "status": "in_sync",
    }]
    assert out["summary"] == {"senaite": 1, "shadow": 1, "in_sync": 1, "drift": 0, "missing": 0}


def test_result_comparison_trims_whitespace_not_drift():
    """Trailing/leading whitespace differences must never read as drift."""
    out = build_analysis_sync_rows(
        {"KW1": {"review_state": "verified", "result": " 99.2 ", "title": "T"}},
        {"KW1": {"mirror_review_state": "verified", "result": "99.2", "title": "T"}},
        {},
    )
    assert out["rows"][0]["status"] == "in_sync"


def test_drift_on_state_mismatch():
    out = build_analysis_sync_rows(
        {"KW1": {"review_state": "verified", "result": "99.2", "title": "T"}},
        {"KW1": {"mirror_review_state": "to_be_verified", "result": "99.2", "title": "T"}},
        {},
    )
    assert out["rows"][0]["status"] == "drift"
    assert out["summary"]["drift"] == 1
    assert out["summary"]["in_sync"] == 0


def test_drift_on_result_mismatch():
    out = build_analysis_sync_rows(
        {"KW1": {"review_state": "verified", "result": "99.2", "title": "T"}},
        {"KW1": {"mirror_review_state": "verified", "result": "88.0", "title": "T"}},
        {},
    )
    assert out["rows"][0]["status"] == "drift"


def test_no_shadow_when_senaite_line_has_no_shadow_yet():
    """Expected pre-backfill: a current SENAITE line with no shadow row."""
    out = build_analysis_sync_rows(
        {"KW1": {"review_state": "verified", "result": "99.2", "title": "T"}}, {}, {},
    )
    assert out["rows"][0]["status"] == "no_shadow"
    assert out["rows"][0]["shadow"] is None
    assert out["summary"] == {"senaite": 1, "shadow": 0, "in_sync": 0, "drift": 0, "missing": 1}


def test_shadow_only_when_no_current_senaite_line():
    out = build_analysis_sync_rows(
        {}, {"KW1": {"mirror_review_state": "verified", "result": "1", "title": "T"}}, {},
    )
    assert out["rows"][0]["status"] == "shadow_only"
    assert out["rows"][0]["senaite"] is None
    # shadow_only has no dedicated summary slot (implicit: shadow - in_sync - drift).
    assert out["summary"] == {"senaite": 0, "shadow": 1, "in_sync": 0, "drift": 0, "missing": 0}


def test_canonical_marker_present_and_does_not_affect_status():
    out = build_analysis_sync_rows(
        {"KW1": {"review_state": "verified", "result": "99.2", "title": "T"}},
        {"KW1": {"mirror_review_state": "verified", "result": "99.2", "title": "T"}},
        {"KW1": {"review_state": "verified", "result": "99.2", "title": "T"}},
    )
    assert out["rows"][0]["canonical"] == {"review_state": "verified", "result": "99.2"}
    assert out["rows"][0]["status"] == "in_sync"


def test_title_prefers_shadow_over_senaite_only_title():
    out = build_analysis_sync_rows(
        {"KW1": {"review_state": "verified", "result": "1", "title": "SENAITE-ONLY"}},
        {"KW1": {"mirror_review_state": "verified", "result": "1", "title": "SHADOW-TITLE"}},
        {},
    )
    assert out["rows"][0]["title"] == "SHADOW-TITLE"


def test_canonical_only_keyword_does_not_crash_and_is_not_misclassified():
    """Regression: a keyword present ONLY in canonical_map (no current
    SENAITE line, no live shadow row) must not raise — union membership
    comes from all three maps, but the status matrix only has 4 values."""
    out = build_analysis_sync_rows(
        {}, {}, {"KW1": {"review_state": "verified", "result": "99.2", "title": "T"}},
    )
    assert out["rows"][0]["status"] == "shadow_only"
    assert out["rows"][0]["senaite"] is None
    assert out["rows"][0]["shadow"] is None
    assert out["rows"][0]["canonical"] == {"review_state": "verified", "result": "99.2"}
    # Neither the senaite nor the shadow summary counter claims this row.
    assert out["summary"]["senaite"] == 0 and out["summary"]["shadow"] == 0


def test_summary_across_mixed_statuses():
    out = build_analysis_sync_rows(
        senaite_map={
            "KW1": {"review_state": "verified", "result": "1", "title": "T1"},
            "KW2": {"review_state": "to_be_verified", "result": "2", "title": "T2"},
        },
        shadow_map={
            "KW1": {"mirror_review_state": "verified", "result": "1", "title": "T1"},
        },
        canonical_map={},
    )
    by_kw = {r["keyword"]: r["status"] for r in out["rows"]}
    assert by_kw == {"KW1": "in_sync", "KW2": "no_shadow"}
    assert out["summary"] == {"senaite": 2, "shadow": 1, "in_sync": 1, "drift": 0, "missing": 1}


# ═══════════════════════════════════════════════════════════════════════════
# DB-level: main._build_analysis_debug_rows — house live-DB pattern per
# test_parent_mirror_helper.py (real SessionLocal(), TEST-prefixed
# LimsSample + a seeded AnalysisService)
# ═══════════════════════════════════════════════════════════════════════════


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def two_analysis_services(db):
    svcs = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().all()[:2]
    if len(svcs) < 2:
        pytest.skip("need >=2 seeded analysis_services rows with a keyword")
    return svcs


@pytest.fixture
def seed_parent(db):
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="received",
                        external_lims_uid="SENAITE-UID-RD10")
    db.add(parent)
    db.commit()
    db.refresh(parent)
    return parent


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
    db.commit()


def test_shadow_side_filtered_to_live_row_only(db, seed_parent, two_analysis_services):
    """A retested (superseded) shadow row must be ignored — only the live
    (retested=False) row represents the shadow side."""
    svc_a, _ = two_analysis_services
    old = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title, review_state="senaite_mirror",
        provenance="shadow", mirror_review_state="verified", result_value="OLD",
        retested=True,
    )
    live = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title, review_state="senaite_mirror",
        provenance="shadow", mirror_review_state="verified", result_value="NEW",
        retested=False,
    )
    db.add_all([old, live])
    db.commit()

    with patch.object(main.senaite, "fetch_parent_analyses", return_value=[
        _senaite_item("U1", svc_a.keyword, result="NEW", review_state="verified"),
    ]):
        out = main._build_analysis_debug_rows(db, seed_parent, TEST_SAMPLE_ID)

    row = next(r for r in out["rows"] if r["keyword"] == svc_a.keyword)
    assert row["shadow"] == {"mirror_review_state": "verified", "result": "NEW"}
    assert row["status"] == "in_sync"


def test_canonical_selection_prefers_live_over_retracted(db, seed_parent, two_analysis_services):
    """Same invariant as the DB's own `uq_lims_analyses_parent_service_root`
    partial unique index: a canonical row with review_state='retracted' (the
    retest-unpromote cascade) coexists alongside the live re-verified one —
    selection must prefer the live (non-retracted) row."""
    svc_a, _ = two_analysis_services
    old_canonical = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title, review_state="retracted",
        provenance="canonical", result_value="OLD",
    )
    live_canonical = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title, review_state="verified",
        provenance="canonical", result_value="NEW",
    )
    db.add_all([old_canonical, live_canonical])
    db.commit()

    with patch.object(main.senaite, "fetch_parent_analyses", return_value=[]):
        out = main._build_analysis_debug_rows(db, seed_parent, TEST_SAMPLE_ID)

    row = next(r for r in out["rows"] if r["keyword"] == svc_a.keyword)
    assert row["canonical"] == {"review_state": "verified", "result": "NEW"}


def test_no_shadow_status_when_only_senaite_line_exists(db, seed_parent, two_analysis_services):
    svc_a, _ = two_analysis_services
    with patch.object(main.senaite, "fetch_parent_analyses", return_value=[
        _senaite_item("U1", svc_a.keyword, result="99.2", review_state="to_be_verified"),
    ]):
        out = main._build_analysis_debug_rows(db, seed_parent, TEST_SAMPLE_ID)
    row = next(r for r in out["rows"] if r["keyword"] == svc_a.keyword)
    assert row["status"] == "no_shadow"
    assert row["shadow"] is None


def test_shadow_only_status_when_no_current_senaite_line(db, seed_parent, two_analysis_services):
    svc_a, _ = two_analysis_services
    live = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title, review_state="senaite_mirror",
        provenance="shadow", mirror_review_state="rejected", result_value="X",
        retested=False,
    )
    db.add(live)
    db.commit()

    with patch.object(main.senaite, "fetch_parent_analyses", return_value=[]):
        out = main._build_analysis_debug_rows(db, seed_parent, TEST_SAMPLE_ID)

    row = next(r for r in out["rows"] if r["keyword"] == svc_a.keyword)
    assert row["status"] == "shadow_only"


def test_summary_counts_across_mixed_statuses_via_builder(db, seed_parent, two_analysis_services):
    svc_a, svc_b = two_analysis_services
    shadow_a = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title, review_state="senaite_mirror",
        provenance="shadow", mirror_review_state="verified", result_value="1",
        retested=False,
    )
    db.add(shadow_a)
    db.commit()

    with patch.object(main.senaite, "fetch_parent_analyses", return_value=[
        _senaite_item("U1", svc_a.keyword, result="1", review_state="verified"),
        _senaite_item("U2", svc_b.keyword, result="2", review_state="to_be_verified"),
    ]):
        out = main._build_analysis_debug_rows(db, seed_parent, TEST_SAMPLE_ID)

    assert out["summary"] == {"senaite": 2, "shadow": 1, "in_sync": 1, "drift": 0, "missing": 1}
    assert out["error"] is None


def test_non_mutation_no_rows_written(db, seed_parent, two_analysis_services):
    """A registry-debug read must never INSERT new lims_analyses rows.
    (Passive observer may UPDATE existing shadows or INSERT transition
    audit rows; lims_analyses row count remains unchanged.)"""
    svc_a, _ = two_analysis_services
    before = db.execute(
        select(func.count()).select_from(LimsAnalysis)
        .where(LimsAnalysis.lims_sample_pk == seed_parent.id)
    ).scalar_one()

    with patch.object(main.senaite, "fetch_parent_analyses", return_value=[
        _senaite_item("U1", svc_a.keyword, result="1", review_state="verified"),
    ]):
        main._build_analysis_debug_rows(db, seed_parent, TEST_SAMPLE_ID)

    after = db.execute(
        select(func.count()).select_from(LimsAnalysis)
        .where(LimsAnalysis.lims_sample_pk == seed_parent.id)
    ).scalar_one()
    assert before == 0 and after == 0


def test_senaite_error_degrades_to_empty_rows_not_misleading_shadow_only(
        db, seed_parent, two_analysis_services):
    """A live shadow row exists, but the SENAITE analyses fetch itself fails
    — must NOT render that row as shadow_only (we don't actually know whether
    a current SENAITE line exists); degrade to empty rows + an error string,
    same posture as the basic-info `meta is None` path."""
    svc_a, _ = two_analysis_services
    live = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title, review_state="senaite_mirror",
        provenance="shadow", mirror_review_state="verified", result_value="1",
        retested=False,
    )
    db.add(live)
    db.commit()

    with patch.object(main.senaite, "fetch_parent_analyses",
                       side_effect=RuntimeError("senaite down")):
        out = main._build_analysis_debug_rows(db, seed_parent, TEST_SAMPLE_ID)

    assert out["error"] == "senaite down"
    assert out["rows"] == []
    assert out["summary"] is None


# ═══════════════════════════════════════════════════════════════════════════
# Wiring: _build_registry_debug_response carries "analyses" in every return
# path, and a basic-info senaite_error does not blank it (independent
# failure modes)
# ═══════════════════════════════════════════════════════════════════════════


def test_analyses_key_present_when_registry_row_missing(db):
    out = main._build_registry_debug_response(db, "TEST-RD10-NOPE")
    assert out["load"]["exists"] is False
    assert out["analyses"] is None


def test_basic_info_senaite_error_does_not_blank_analyses_section(
        db, seed_parent, two_analysis_services):
    svc_a, _ = two_analysis_services
    live = LimsAnalysis(
        lims_sample_pk=seed_parent.id, analysis_service_id=svc_a.id,
        keyword=svc_a.keyword, title=svc_a.title, review_state="senaite_mirror",
        provenance="shadow", mirror_review_state="verified", result_value="1",
        retested=False,
    )
    db.add(live)
    db.commit()

    with patch.object(main.senaite, "fetch_parent_metadata",
                       side_effect=RuntimeError("basic-info down")), \
         patch.object(main.senaite, "fetch_parent_analyses", return_value=[
             _senaite_item("U1", svc_a.keyword, result="1", review_state="verified"),
         ]):
        out = main._build_registry_debug_response(db, TEST_SAMPLE_ID)

    assert out["senaite_error"] is not None   # basic-info side failed...
    assert out["fields"] == []
    assert out["analyses"] is not None        # ...but analyses is independent
    assert out["analyses"]["error"] is None
    row = next(r for r in out["analyses"]["rows"] if r["keyword"] == svc_a.keyword)
    assert row["status"] == "in_sync"


def test_analyses_senaite_error_does_not_blank_basic_info_fields(
        db, seed_parent, two_analysis_services):
    svc_a, _ = two_analysis_services
    with patch.object(main.senaite, "fetch_parent_metadata", return_value={
        "uid": "SENAITE-UID-RD10", "ClientID": "c", "getClientTitle": "acme@x.com",
        "ClientSampleID": "CS-1", "review_state": "sample_received",
    }), patch.object(main.senaite, "fetch_secondaries", return_value=[]), \
         patch.object(main.senaite, "fetch_parent_analyses",
                      side_effect=RuntimeError("analyses catalog down")):
        out = main._build_registry_debug_response(db, TEST_SAMPLE_ID)

    assert out["senaite_error"] is None
    assert len(out["fields"]) > 0             # basic-info diff unaffected...
    assert out["analyses"]["error"] == "analyses catalog down"
    assert out["analyses"]["rows"] == []
