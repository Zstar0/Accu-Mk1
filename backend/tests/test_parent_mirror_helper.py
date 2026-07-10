"""Tests for the parent-analysis SENAITE->Mk1 shadow mirror helper (Task 2):
`resolve_shadow_target` + `mirror_parent_analysis` (create path only).

House pattern (see test_lims_analyses_service.py): module-local `db`
fixture = SessionLocal(); pick an existing seeded AnalysisService (skip
if none); create our own TEST-prefixed LimsSample per test; autouse
cleanup deletes TEST rows (transitions, then analyses, then the
LimsSample) after each test.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from lims_analyses.parent_mirror import SHADOW_STATE, mirror_parent_analysis
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample

TEST_SAMPLE_ID = "TEST-PM2-PARENT"
TEST_NOEXIST_SAMPLE_ID = "TEST-PM2-NOEXIST"


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


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id.in_(
            select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sample_pk.in_(
                    select(LimsSample.id).where(
                        LimsSample.sample_id.in_([TEST_SAMPLE_ID, TEST_NOEXIST_SAMPLE_ID])
                    )
                )
            )
        )
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk.in_(
            select(LimsSample.id).where(
                LimsSample.sample_id.in_([TEST_SAMPLE_ID, TEST_NOEXIST_SAMPLE_ID])
            )
        )
    ))
    db.execute(delete(LimsSample).where(
        LimsSample.sample_id.in_([TEST_SAMPLE_ID, TEST_NOEXIST_SAMPLE_ID])
    ))
    db.commit()


def test_no_op_when_parent_not_in_registry(db, analysis_service):
    assert mirror_parent_analysis(
        db, sample_id=TEST_NOEXIST_SAMPLE_ID, keyword=analysis_service.keyword,
        mirror_review_state="to_be_verified", result_value="OK",
    ) is False


def test_creates_shadow_row_with_sentinel_state(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    ok = mirror_parent_analysis(
        db, sample_id=parent.sample_id, keyword=svc.keyword,
        mirror_review_state="to_be_verified", result_value="99.2%",
    )
    assert ok is True
    row = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").one()
    assert row.review_state == SHADOW_STATE
    assert row.mirror_review_state == "to_be_verified"
    assert row.result_value == "99.2%"
    assert row.analysis_service_id == svc.id
    tr = db.query(LimsAnalysisTransition).filter_by(analysis_id=row.id).all()
    assert len(tr) == 1  # audit row for the mirrored create


def test_second_call_updates_same_shadow_row(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="to_be_verified", result_value="1")
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified")
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").all()
    assert len(rows) == 1
    assert rows[0].mirror_review_state == "verified"
    assert rows[0].result_value == "1"  # unchanged fields preserved


def test_retest_creates_new_row_and_marks_old(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="1")
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="2", is_retest=True)
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").order_by(LimsAnalysis.id).all()
    assert len(rows) == 2
    assert rows[0].retested is True
    assert rows[1].retest_of_id == rows[0].id and rows[1].retested is False


def test_update_after_retest_targets_retest_row_not_a_third(db, seed_parent_and_service):
    """Amendment 1 regression test: the pre-fix `_existing_shadow` filter
    (retest_of_id IS NULL AND retested IS FALSE) misses the live row after a
    retest (retest_of_id is set on the new row), so a further update call
    would fall into the create branch and mint a spurious THIRD row. The
    fixed filter (provenance='shadow' AND retested IS FALSE, newest first)
    must find the retest row and update it in place."""
    parent, svc = seed_parent_and_service
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="1")
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="verified", result_value="2", is_retest=True)
    mirror_parent_analysis(db, sample_id=parent.sample_id, keyword=svc.keyword,
                           mirror_review_state="to_be_verified", result_value="3")
    rows = db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance="shadow").order_by(LimsAnalysis.id).all()
    assert len(rows) == 2  # no spurious third row
    assert rows[0].retested is True
    assert rows[1].retest_of_id == rows[0].id
    assert rows[1].retested is False
    assert rows[1].result_value == "3"
    assert rows[1].mirror_review_state == "to_be_verified"
