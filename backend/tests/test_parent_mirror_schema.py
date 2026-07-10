"""Schema tests for the parent-analysis native mirror (Task 1): the
`provenance` / `mirror_review_state` columns, the `'senaite_mirror'`
sentinel review_state, and the provenance-aware
`uq_lims_analyses_parent_service_root` partial unique index.

House pattern (see test_lims_analyses_service.py): module-local `db`
fixture = SessionLocal(); pick an existing seeded AnalysisService (skip
if none); create our own TEST-prefixed LimsSample + LimsAnalysis rows;
autouse cleanup deletes TEST rows (transitions, then analyses, then the
LimsSample) after each test.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample

TEST_SAMPLE_ID = "TEST-PM1-PARENT"


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
            select(LimsAnalysis.id).where(LimsAnalysis.title.like("TEST:%"))
        )
    ))
    db.execute(delete(LimsAnalysis).where(LimsAnalysis.title.like("TEST:%")))
    db.execute(delete(LimsSample).where(LimsSample.sample_id == TEST_SAMPLE_ID))
    db.commit()


def test_shadow_and_canonical_coexist_for_same_parent_service(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service  # LimsSample, AnalysisService
    canonical = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title="TEST: " + svc.title,
        review_state="verified", provenance="canonical",
    )
    shadow = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title="TEST: " + svc.title,
        review_state="senaite_mirror", provenance="shadow",
        mirror_review_state="to_be_verified",
    )
    db.add_all([canonical, shadow])
    db.commit()  # must NOT raise: index excludes provenance='shadow'
    rows = db.query(LimsAnalysis).filter(LimsAnalysis.lims_sample_pk == parent.id).all()
    assert {r.provenance for r in rows} == {"canonical", "shadow"}


def test_default_provenance_is_canonical(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    row = LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                       keyword=svc.keyword, title="TEST: " + svc.title, review_state="verified")
    db.add(row); db.commit()
    assert row.provenance == "canonical"
