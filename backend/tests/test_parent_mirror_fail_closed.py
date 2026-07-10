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


# ─── sub_samples/service.py::_fetch_mk1_results_for_host — MANDATORY filter ─
# Controller-added scope (post-report review): this is a SEPARATE,
# copy-pasted parent-host query (NOT a reuse of list_analyses_for_host), so
# the fix above does not cover it. It feeds get_variance_set — the lab-facing
# variance-set/lock view — where a shadow row carrying a result_value would
# have rendered as a phantom parent result. Pre-fix: EXPECTED RED. The
# sub_sample branch needs no filter: shadow rows are parent-tier only
# (lims_sub_sample_pk IS NULL, per parent_mirror.py), so a vial-host query
# can never match one — safe by construction.


def test_variance_set_parent_results_exclude_shadow_rows(db, seed_parent_and_service):
    parent, svc = seed_parent_and_service
    # a canonical parent-tier result + a shadow row for a DIFFERENT keyword,
    # both carrying result_values (the query requires result_value IS NOT NULL)
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=svc.title, review_state="verified",
                        provenance="canonical", result_value="42.0", reportable=True))
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword="QTY_SHADOW_VS", title="x", review_state="senaite_mirror",
                        provenance="shadow", mirror_review_state="verified",
                        result_value="99.9", result_unit="mg", reportable=True))
    db.commit()
    from sub_samples.service import _fetch_mk1_results_for_host
    out = _fetch_mk1_results_for_host(db, host_kind="sample", host_pk=parent.id)
    assert "QTY_SHADOW_VS" not in out  # shadow keyword must not appear
    assert svc.keyword in out  # the canonical row is unaffected
    assert out[svc.keyword]["value"] == "42.0"


# ─── lims_analyses/service.py::cascade_parent_retest_to_sources ─────────────
# Reviewer-required shadow-seeding proof for the task's one genuine
# behavior-affecting gap (audit site #8). Pre-fix, the active-parent lookup
# (`review_state.not_in(("retracted","rejected"))` — which does NOT exclude
# the sentinel 'senaite_mirror' — with no ORDER BY, `.scalars().first()`)
# could nondeterministically resolve to a SHADOW row when one coexists with
# the canonical parent row for the same (parent, keyword). A shadow row
# carries no LimsAnalysisPromotion links, so the cascade would silently
# no-op instead of retesting the promoted vial sources. With the provenance
# filter the lookup must deterministically target the CANONICAL row.
#
# The shadow row is inserted FIRST (lower id) to bias an unordered scan
# toward it — pre-fix failure is still nondeterministic by nature, but
# post-fix correctness (what this test pins) is deterministic.
# Setup mirrors test_parent_retest_cascade_unpromotes_verified_parent
# (test_lims_analyses_service.py): promoted vial source + verified canonical
# parent + promotion link; post-conditions per the function's contract:
# source retested, canonical parent retracted with figure cleared.


def test_retest_cascade_targets_canonical_not_shadow(db, seed_parent_and_service):
    from models import LimsAnalysisPromotion, LimsSubSample

    parent, svc = seed_parent_and_service
    vial = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="TEST-PM7-CASCADE-UID",
        sample_id=f"{TEST_SAMPLE_ID}-S01", vial_sequence=1, assignment_kind="core",
    )
    db.add(vial)
    db.flush()

    shadow = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title="x", review_state="senaite_mirror",
        provenance="shadow", mirror_review_state="verified",
        result_value="88.8", reportable=True,
    )
    db.add(shadow)
    db.flush()  # shadow gets the lower id
    src = LimsAnalysis(
        lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title="TEST: src", result_value="4",
        result_unit="mg", review_state="promoted",
    )
    canonical = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title="TEST: parent", result_value="4",
        result_unit="mg", review_state="verified", provenance="canonical",
    )
    db.add_all([src, canonical])
    db.flush()
    db.add(LimsAnalysisPromotion(
        parent_analysis_id=canonical.id, source_analysis_id=src.id,
        contribution_kind="chosen",
    ))
    db.commit()

    from lims_analyses.service import cascade_parent_retest_to_sources
    created_ids: list[int] = []
    try:
        created_ids = cascade_parent_retest_to_sources(
            db, parent_sample_id=parent.sample_id, keyword=svc.keyword, user_id=None,
        )
        db.refresh(shadow)
        db.refresh(src)
        db.refresh(canonical)
        # (a) the cascade resolved the CANONICAL row: the promoted vial source
        # was retested and the canonical parent was un-promoted (retracted,
        # stale figure cleared) — the function's documented post-conditions.
        # An empty created_ids here means the lookup grabbed the shadow row
        # (no promotion links) and silently no-opped: the pre-fix bug.
        assert created_ids, "cascade no-opped — parent lookup did not resolve to the canonical row"
        assert src.retested is True
        assert canonical.review_state == "retracted"
        assert canonical.result_value is None
        # (b) the SHADOW row is untouched in every respect.
        assert shadow.review_state == "senaite_mirror"
        assert shadow.mirror_review_state == "verified"
        assert shadow.result_value == "88.8"
        assert shadow.retested is False
    finally:
        all_ids = [shadow.id, src.id, canonical.id, *created_ids]
        db.execute(delete(LimsAnalysisPromotion).where(
            LimsAnalysisPromotion.parent_analysis_id == canonical.id))
        db.execute(delete(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id.in_(all_ids)))
        db.execute(delete(LimsAnalysis).where(LimsAnalysis.id.in_(all_ids)))
        db.execute(delete(LimsSubSample).where(LimsSubSample.id == vial.id))
        db.commit()
