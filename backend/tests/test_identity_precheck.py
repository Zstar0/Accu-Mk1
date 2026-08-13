"""Live-PG tests for the S3 identity pre-check (violations constructed in a
rolled-back transaction — nothing persists)."""
import uuid

import pytest
from sqlalchemy import text

from database import SessionLocal
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def test_clean_db_reports_no_vial_violations(db):
    from scripts.s3_identity_precheck import vial_tier_violations
    assert vial_tier_violations(db) == []


def test_constructed_vial_violation_detected(db):
    """Two live rows, same (vial, service), DIFFERENT keywords — the exact
    drift shape the new index forbids. Built raw and rolled back."""
    from scripts.s3_identity_precheck import vial_tier_violations

    # Arrange: minimal parent sample + sub sample + catalog service + two rows.
    uid = uuid.uuid4().hex[:8]
    svc = AnalysisService(title="TEST S3 Precheck Service", keyword="TEST-S3-CURRENT",
                          origin="mk1")
    db.add(svc)
    db.flush()

    parent = LimsSample(sample_id=f"TEST-S3-PRECHECK-{uid}", sample_type="x",
                        status="received")
    db.add(parent)
    db.flush()

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=f"TEST-S3-PRECHECK-{uid}-UID",
        sample_id=f"TEST-S3-PRECHECK-{uid}-S01",
        vial_sequence=1,
    )
    db.add(sub)
    db.flush()

    # Two live (non-retracted/rejected, non-retest) rows for the SAME
    # (vial, service) but with DIFFERENT denormalized keyword text — the
    # exact drift the existing keyword-uniqueness index cannot see (it keys
    # on keyword, not analysis_service_id) but the new S3 index forbids.
    row_a = LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword="TEST-S3-KW-A", title="TEST: S3 precheck row A",
        review_state="unassigned",
    )
    row_b = LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword="TEST-S3-KW-B", title="TEST: S3 precheck row B",
        review_state="unassigned",
    )
    db.add_all([row_a, row_b])
    db.flush()

    hits = vial_tier_violations(db)
    assert any(h["distinct_keywords"] and len(h["row_ids"]) == 2 for h in hits)
    # (teardown = fixture rollback)


def test_clean_db_reports_no_parent_violations(db):
    from scripts.s3_identity_precheck import parent_tier_violations
    assert parent_tier_violations(db) == []


def test_constructed_parent_violation_detected(db):
    """Parent-tier mirror of test_constructed_vial_violation_detected: two
    live CANONICAL rows on the same parent sample for the SAME service,
    DIFFERENT keywords. uq_lims_analyses_parent_service_root is scoped
    `AND provenance = 'canonical'`, so — like the vial case — different
    keyword text keeps this pair clear of the EXISTING keyword index while
    still tripping the new (lims_sample_pk, analysis_service_id) gate."""
    from scripts.s3_identity_precheck import parent_tier_violations

    uid = uuid.uuid4().hex[:8]
    svc = AnalysisService(title="TEST S3 Precheck Parent Service",
                          keyword="TEST-S3-PARENT-CURRENT", origin="mk1")
    db.add(svc)
    db.flush()

    parent = LimsSample(sample_id=f"TEST-S3-PPRECHECK-{uid}", sample_type="x",
                        status="received")
    db.add(parent)
    db.flush()

    row_a = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="TEST-S3-PKW-A", title="TEST: S3 precheck parent row A",
        review_state="unassigned", provenance="canonical",
    )
    row_b = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="TEST-S3-PKW-B", title="TEST: S3 precheck parent row B",
        review_state="unassigned", provenance="canonical",
    )
    db.add_all([row_a, row_b])
    db.flush()

    hits = parent_tier_violations(db)
    assert any(h["distinct_keywords"] and len(h["row_ids"]) == 2 for h in hits)
    # (teardown = fixture rollback)


def test_canary_runs_first_and_detects(db):
    from scripts.s3_identity_precheck import keyword_index_canary
    assert keyword_index_canary(db) == []


def test_drift_sizer_returns_rows_not_failures(db):
    from scripts.s3_identity_precheck import drift_sizer
    drift_sizer(db)  # diagnostic — must not raise on any data
