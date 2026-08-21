"""S3 index tests (live PG). The migrations list only runs at app boot, so the
test creates the indexes itself with the same idempotent statements."""
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from database import SessionLocal, engine
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample

VIAL_IDX = """
CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_sub_service_id_root
    ON lims_analyses (lims_sub_sample_pk, analysis_service_id)
    WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL
      AND review_state NOT IN ('retracted', 'rejected')
"""
PARENT_IDX = """
CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_parent_service_id_root
    ON lims_analyses (lims_sample_pk, analysis_service_id)
    WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
      AND review_state NOT IN ('retracted', 'rejected')
      AND provenance = 'canonical'
"""
# Pre-existing index from the native-parent-placeholders slice (database.py,
# Task 1 of that slice). The coexistence test needs it alongside PARENT_IDX;
# created here too (idempotent IF NOT EXISTS) so this file never depends on
# whether the app has booted against this DB since that migration landed.
ORDERED_IDX = """
CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_parent_service_ordered
    ON lims_analyses (lims_sample_pk, analysis_service_id)
    WHERE provenance = 'ordered' AND lims_sample_pk IS NOT NULL
      AND review_state NOT IN ('retracted', 'rejected')
"""


@pytest.fixture(autouse=True, scope="module")
def _ensure_indexes():
    """All four tests below need at least one of the three service-id-keyed
    indexes present; create them once per module rather than per test."""
    with engine.connect() as c:
        c.execute(text(VIAL_IDX))
        c.execute(text(PARENT_IDX))
        c.execute(text(ORDERED_IDX))
        c.commit()


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def test_migration_list_contains_both_statements():
    import database, inspect
    src = inspect.getsource(database)
    assert "uq_lims_analyses_sub_service_id_root" in src
    assert "uq_lims_analyses_parent_service_id_root" in src
    # no DROP pair for either (last-boot-wins hazard)
    assert "DROP INDEX IF EXISTS uq_lims_analyses_sub_service_id_root" not in src
    assert "DROP INDEX IF EXISTS uq_lims_analyses_parent_service_id_root" not in src


def test_verify_identity_indexes_reports_missing_and_present():
    from database import verify_identity_indexes
    with engine.connect() as c:
        c.execute(text(VIAL_IDX)); c.execute(text(PARENT_IDX)); c.commit()
    assert verify_identity_indexes(engine) == []


def test_verify_identity_indexes_reports_missing(caplog):
    """The loud branch — verify_identity_indexes' entire justification is
    logging + returning the names of indexes that AREN'T there, but the test
    above only exercises the all-present case. A stub engine stands in for a
    DB where uq_lims_analyses_parent_service_id_root is absent, without
    dropping anything on the shared live dev Postgres (other worktrees use
    it concurrently)."""
    import logging

    from database import verify_identity_indexes

    class _FakeResult:
        def all(self):
            return [("uq_lims_analyses_sub_service_id_root",)]

    class _FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, *_a, **_kw):
            return _FakeResult()

    class _FakeEngine:
        def connect(self):
            return _FakeConn()

    with caplog.at_level(logging.ERROR, logger="database"):
        missing = verify_identity_indexes(_FakeEngine())

    assert missing == ["uq_lims_analyses_parent_service_id_root"]
    assert any(
        "identity_index_missing" in r.getMessage()
        and "uq_lims_analyses_parent_service_id_root" in r.getMessage()
        for r in caplog.records
    )


def test_ordered_placeholder_coexists_with_canonical_same_service(db):
    """The one interaction that could break promote_to_parent: the new parent
    index's provenance='canonical' term is mutually exclusive with the
    'ordered' placeholder index — an ordered row and a canonical row for the
    same (parent, service) must BOTH insert cleanly. Pins the shipped
    WP-3280/P-0145 coexistence (ordered 3661 + canonical 3663).

    Built raw in a rolled-back transaction, mirroring
    test_identity_precheck.py's live-PG builder idiom: a fresh AnalysisService
    + LimsSample flushed (never committed), then an 'ordered' row and a
    'canonical' row for the same (lims_sample_pk, analysis_service_id).
    Neither flush should raise — PARENT_IDX only constrains provenance=
    'canonical' rows, ORDERED_IDX only constrains provenance='ordered' rows,
    so this pair shares a key but never collides under either index."""
    uid = uuid.uuid4().hex[:8]
    svc = AnalysisService(title="TEST S3 Coexist Service",
                          keyword=f"TEST-S3-COEXIST-{uid}", origin="mk1")
    db.add(svc)
    db.flush()

    parent = LimsSample(sample_id=f"TEST-S3-COEXIST-{uid}", sample_type="x",
                        status="received")
    db.add(parent)
    db.flush()

    ordered_row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword=svc.keyword,
        title="TEST: S3 coexist ordered", review_state="unassigned",
        provenance="ordered",
    )
    db.add(ordered_row)
    db.flush()  # must not raise: sole 'ordered' row for this (parent, service)

    canonical_row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword=svc.keyword,
        title="TEST: S3 coexist canonical", review_state="parent_to_verify",
        provenance="canonical",
    )
    db.add(canonical_row)
    db.flush()  # must not raise: sole 'canonical' row for this (parent, service)

    assert ordered_row.id is not None
    assert canonical_row.id is not None
    assert ordered_row.analysis_service_id == canonical_row.analysis_service_id
    # (teardown = fixture rollback — nothing persists)


def test_new_vial_index_rejects_same_service_duplicate(db):
    """Two live vial rows, same (vial, service), different keywords → the
    second INSERT raises IntegrityError once the index exists. Construct in a
    transaction, expect the error, rollback.

    This is the exact drift shape uq_lims_analyses_sub_service_id_root exists
    to forbid: the pre-S3 keyword-keyed index (uq_lims_analyses_sub_service_root)
    cannot see it, because these two rows carry different keyword text for
    the same analysis_service_id."""
    uid = uuid.uuid4().hex[:8]
    svc = AnalysisService(title="TEST S3 Vial Dup Service",
                          keyword=f"TEST-S3-VIALDUP-{uid}", origin="mk1")
    db.add(svc)
    db.flush()

    parent = LimsSample(sample_id=f"TEST-S3-VIALDUP-{uid}", sample_type="x",
                        status="received")
    db.add(parent)
    db.flush()

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=f"TEST-S3-VIALDUP-{uid}-UID",
        sample_id=f"TEST-S3-VIALDUP-{uid}-S01",
        vial_sequence=1,
    )
    db.add(sub)
    db.flush()

    row_a = LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword="TEST-S3-VIALDUP-KW-A", title="TEST: S3 vial dup row A",
        review_state="unassigned",
    )
    db.add(row_a)
    db.flush()  # first row for this (vial, service) — must not raise

    row_b = LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword="TEST-S3-VIALDUP-KW-B", title="TEST: S3 vial dup row B",
        review_state="unassigned",
    )
    db.add(row_b)
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()
