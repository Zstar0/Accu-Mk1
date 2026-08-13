"""Live-PG tests for the S3 identity pre-check (violations constructed in a
rolled-back transaction — nothing persists)."""
import re
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


def _drop_index_in_txn(db, index_name):
    """S3 Task 2 (database.py) added two service-id-keyed unique indexes
    whose WHERE clauses mirror this script's _VIAL_VIOLATIONS_SQL /
    _PARENT_VIOLATIONS_SQL byte-for-byte (confirmed by reading
    scripts/s3_identity_precheck.py). Once either index exists on this DB,
    the row pair these violation-construction tests build raises
    IntegrityError at flush — before vial_tier_violations/
    parent_tier_violations are ever called. That is not a fixture bug: this
    precheck is a PRE-deploy gate, and its violation fixtures inherently
    require a pre-index database.

    Postgres DDL is transactional: drop the index inside this test's already
    -open transaction instead of skipping the test. The violation rows can
    then be built and detected exactly as before, and the fixture's
    `finally: s.rollback()` restores the index wholesale via catalog
    rollback — zero residue, and it keeps the suite's only positive-
    detection coverage of vial_tier_violations/parent_tier_violations alive
    on a migrated DB instead of skipping it forever.

    SET LOCAL lock_timeout first: fails fast instead of hanging if a sibling
    worktree holds a conflicting lock on lims_analyses (the known
    concurrent-flake class — re-run in isolation if this trips). Plain DROP,
    not DROP INDEX CONCURRENTLY: CONCURRENTLY cannot run inside a
    transaction block."""
    db.execute(text("SET LOCAL lock_timeout = '5s'"))
    db.execute(text(f"DROP INDEX IF EXISTS {index_name}"))


def _construct_vial_violation(db):
    """Build (but do not commit) two live rows, same (vial, service),
    DIFFERENT keywords — the exact drift shape the new index forbids.
    Shared by the vial-tier detection test and the diagnostics-always-run
    covering test below. Returns (sub, svc)."""
    _drop_index_in_txn(db, "uq_lims_analyses_sub_service_id_root")
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
    return sub, svc


def test_constructed_vial_violation_detected(db):
    """Two live rows, same (vial, service), DIFFERENT keywords — the exact
    drift shape the new index forbids. Built raw and rolled back."""
    from scripts.s3_identity_precheck import vial_tier_violations

    _construct_vial_violation(db)

    hits = vial_tier_violations(db)
    assert any(h["distinct_keywords"] and len(h["row_ids"]) == 2 for h in hits)
    # (teardown = fixture rollback)


def test_violation_path_still_runs_diagnostics(db, capsys):
    """Regression for a review finding: run_precheck's violation branch used
    to print + `return 3` BEFORE origin_split_diagnostic()/drift_sizer() ever
    ran. The diagnostics only executed on the clean path — where
    origin_split_diagnostic is mathematically guaranteed empty, since it
    shares the same `HAVING COUNT(*) > 1` predicate as the gates it segments
    (no count>1 group at the coarser grouping means none at the
    origin-tagged one either). So the "tells you WHOSE rows to repair"
    diagnostic could never fire at the one moment repair attribution is
    actually needed. run_precheck must run both diagnostics unconditionally,
    with the exit-code decision made only afterward."""
    from scripts.s3_identity_precheck import run_precheck

    _construct_vial_violation(db)

    code = run_precheck(db, "test-env")
    out = capsys.readouterr().out

    assert code == 3
    assert "VIOLATIONS FOUND" in out
    # Non-empty origin-split section: the numbered count line, not the
    # clean-path "nothing to attribute" phrasing, and at least one row printed.
    m = re.search(r"origin split diagnostic: (\d+) row\(s\)", out)
    assert m is not None and int(m.group(1)) >= 1
    assert "nothing to attribute" not in out
    assert "drift sizer:" in out


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

    _drop_index_in_txn(db, "uq_lims_analyses_parent_service_id_root")
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
