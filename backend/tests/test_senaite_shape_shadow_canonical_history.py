"""A SENAITE shadow row is hidden once its keyword has ANY canonical history
(PB-0469, 2026-09-08).

Un-promote / retest retracts the parent's canonical row, but SENAITE keeps
its verified line (locked -- it can never be retracted there), so the mirror
row kept resurfacing the withdrawn value on the parent table AND on the COA
wire (``coa.legacy_rows`` delegates row selection here). The collapse used
to key on LIVE canonical keywords only; it now keys on every keyword the
canonical tier ever held -- the same rule ``native_parent_line_states``
already applies ("canonical tier owns any keyword it EVER held").
"""
from __future__ import annotations

from models import AnalysisService, LimsAnalysis, LimsSample


def _mk_parent(db, sample_id="TEST-SHADOW-HIST"):
    p = LimsSample(sample_id=sample_id)
    db.add(p)
    db.flush()
    return p


def _mk_service(db, keyword, title="TEST svc"):
    svc = AnalysisService(keyword=keyword, title=title)
    db.add(svc)
    db.flush()
    return svc


def _mk_parent_analysis(
    db, parent, svc, *,
    provenance="canonical", review_state="verified",
    mirror_review_state=None, retested=False, **kw,
):
    a = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title,
        review_state=review_state,
        provenance=provenance,
        mirror_review_state=mirror_review_state,
        retested=retested,
        **kw,
    )
    db.add(a)
    db.flush()
    return a


def _keywords(rows):
    return sorted(r.keyword for r in rows)


def test_shadow_hidden_when_the_canonical_row_was_retracted(db_session):
    """PB-0469's shape: un-promote retracted ANALYTE-2-PUR natively, SENAITE
    still says verified 99.975 -- the withdrawn value must not resurface."""
    from lims_analyses.service import list_parent_analyses_senaite_shape

    parent = _mk_parent(db_session)
    svc = _mk_service(db_session, "ANALYTE-2-PUR", "Analyte 2 (Purity)")
    _mk_parent_analysis(
        db_session, parent, svc, provenance="canonical",
        review_state="retracted", result_value=None,
    )
    _mk_parent_analysis(
        db_session, parent, svc, provenance="shadow",
        review_state="senaite_mirror", mirror_review_state="verified",
        result_value="99.975",
    )

    rows = list_parent_analyses_senaite_shape(db_session, parent.sample_id)
    assert _keywords(rows) == []


def test_shadow_hidden_when_the_canonical_row_was_rejected(db_session):
    from lims_analyses.service import list_parent_analyses_senaite_shape

    parent = _mk_parent(db_session)
    svc = _mk_service(db_session, "ANALYTE-2-QTY", "Analyte 2 (Quantity)")
    _mk_parent_analysis(
        db_session, parent, svc, provenance="canonical",
        review_state="rejected", result_value=None,
    )
    _mk_parent_analysis(
        db_session, parent, svc, provenance="shadow",
        review_state="senaite_mirror", mirror_review_state="verified",
        result_value="54.478",
    )

    rows = list_parent_analyses_senaite_shape(db_session, parent.sample_id)
    assert _keywords(rows) == []


def test_shadow_kept_when_the_keyword_has_no_canonical_history(db_session):
    """Regression pin: legacy senaite-only lines (no promotion ever) still
    render from the mirror."""
    from lims_analyses.service import list_parent_analyses_senaite_shape

    parent = _mk_parent(db_session)
    svc_total = _mk_service(db_session, "PEPT-Total", "Peptide Total Quantity")
    svc_other = _mk_service(db_session, "ANALYTE-3-PUR", "Analyte 3 (Purity)")
    _mk_parent_analysis(
        db_session, parent, svc_total, provenance="shadow",
        review_state="senaite_mirror", mirror_review_state="verified",
        result_value="76.08",
    )
    # canonical history on a DIFFERENT keyword must not bleed over
    _mk_parent_analysis(
        db_session, parent, svc_other, provenance="canonical",
        review_state="retracted",
    )

    rows = list_parent_analyses_senaite_shape(db_session, parent.sample_id)
    assert _keywords(rows) == ["PEPT-Total"]


def test_live_canonical_still_wins_over_its_shadow(db_session):
    from lims_analyses.service import list_parent_analyses_senaite_shape

    parent = _mk_parent(db_session)
    svc = _mk_service(db_session, "ANALYTE-1-PUR", "Analyte 1 (Purity)")
    canonical = _mk_parent_analysis(
        db_session, parent, svc, provenance="canonical",
        review_state="verified", result_value="99.975",
    )
    _mk_parent_analysis(
        db_session, parent, svc, provenance="shadow",
        review_state="senaite_mirror", mirror_review_state="verified",
        result_value="99.975",
    )

    rows = list_parent_analyses_senaite_shape(db_session, parent.sample_id)
    assert [r.uid for r in rows] == [f"mk1:{canonical.id}"]
