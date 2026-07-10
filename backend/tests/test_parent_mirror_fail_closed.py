"""Task 7: read-path provenance filters + fail-closed / COA shadow-diff proof.

Every parent-FK reader that touches lims_analyses must provably exclude
provenance='shadow' rows (the SENAITE parent-analysis mirror, sentinel
review_state='senaite_mirror', Tasks 4-6). This file is the "shadow-diff"
proof: for each reader, seed a shadow row alongside (or instead of) a
canonical row and assert the shadow's data never surfaces.

House pattern (see test_parent_mirror_helper.py): module-local `db` fixture
= SessionLocal() against the real dev DB; `seed_parent_and_service` picks an
existing seeded AnalysisService and creates a fresh TEST-prefixed LimsSample;
autouse cleanup deletes TEST rows (transitions, then analyses, then the
LimsSample) after each test.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample

TEST_SAMPLE_ID = "TEST-PM7-PARENT"


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


# ─── families/service.py::_gather_analytes — MANDATORY filter ───────────────
# Pre-fix: EXPECTED RED. This query had no review_state filter at all, so the
# shadow row's fabricated keyword surfaced directly in the family/analyte
# breakdown with parent_state='senaite_mirror'.


def test_family_breakdown_ignores_shadow_rows(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    # a canonical verified row + a shadow row for a DIFFERENT keyword
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=svc.title, review_state="verified",
                        provenance="canonical", reportable=True))
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword="ANALYTE-2-ID", title="x", review_state="senaite_mirror",
                        provenance="shadow", mirror_review_state="to_be_verified", reportable=True))
    db.commit()
    from families.service import _gather_analytes
    out = _gather_analytes(db, parent, senaite_parent_payload=[])
    assert "ANALYTE-2-ID" not in out  # shadow keyword must not appear
    assert svc.keyword in out  # the canonical row is unaffected


# ─── coa/source_resolver.py::_resolve_mk1_parent_tier — fail-closed proof ───
# Pre-fix (state filter only): already GREEN — 'senaite_mirror' isn't in
# _LIVE_RESULT_STATES. Kept as the fail-closed proof; the explicit
# provenance filter is defense-in-depth on top.
#
# NOTE: the brief's placeholder name `resolve_from_native_parent` doesn't
# exist — the real function is `_resolve_mk1_parent_tier` (source_resolver.py
# ~244), which returns a dict of SourceDecision keyed by analyte_keyword.


def test_coa_source_resolver_excludes_shadow(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=svc.title, review_state="senaite_mirror",
                        provenance="shadow", mirror_review_state="verified",
                        result_value="99%", reportable=True))
    db.commit()
    from coa.source_resolver import _resolve_mk1_parent_tier
    decisions = _resolve_mk1_parent_tier(db, parent)
    assert decisions == {} or svc.keyword not in decisions


# ─── coa/variance_series.py::_parent_quantity_unit — fail-closed proof ─────
# Pre-fix (state filter only): already GREEN — 'senaite_mirror' isn't in
# _SERIES_STATES. A shadow-only quantity row must not leak its unit into the
# variance-series fallback unit.


def test_parent_quantity_unit_excludes_shadow_rows(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword="QTY_SHADOW", title="x", review_state="senaite_mirror",
                        provenance="shadow", mirror_review_state="verified",
                        result_value="5", result_unit="mg/mL", reportable=True))
    db.commit()
    from coa.variance_series import _parent_quantity_unit
    assert _parent_quantity_unit(db, parent) is None


# ─── lims_analyses/service.py::list_analyses_for_host — MANDATORY filter ───
# Additional finding beyond the brief's named sites (found by evaluating
# every parent-FK query in lims_analyses/service.py per the controller
# corrections). Pre-fix: EXPECTED RED. This reader had NO review_state filter
# AND no provenance filter for host_kind="sample" — it feeds both the plain
# `GET /analyses?host_kind=sample` route and the senaite_shape adapter used
# by the bench-tech AnalysisTable, so a shadow row would have rendered
# directly in that UI.


def test_list_analyses_for_host_excludes_shadow_rows_for_sample_host(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword="ID_SHADOW", title="x", review_state="senaite_mirror",
                        provenance="shadow", mirror_review_state="verified",
                        result_value="BPC-157", reportable=True))
    db.commit()
    from lims_analyses.service import list_analyses_for_host
    rows = list_analyses_for_host(db, host_kind="sample", host_pk=parent.id)
    assert all(r.keyword != "ID_SHADOW" for r in rows)
    assert all(r.provenance == "canonical" for r in rows)
