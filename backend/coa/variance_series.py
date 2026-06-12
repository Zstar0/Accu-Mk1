"""Per-vial variance replicate records for the COA results series.

A variance order buys extra physical replicates. Each assignment_kind='variance'
sub-sample of the parent measures the same analytes; this returns one record per
variance vial (in vial_sequence order) carrying whatever it measured, keyed by
canonical peptide name. COABuilder prepends its own parent figure (style 2) and
renders the comma-delimited series, gating each figure by its own identity.

Shape: { peptide_name: [ {vial_sequence, PURITY?, QUANTITY?, IDENTITY?}, ... ] }
Values carry their unit (purity '%', quantity ' mg'); identity is the raw result.
A peptide with no variance figures is omitted.

See docs/superpowers/specs/2026-06-12-coa-variance-series-design.md.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.prep_bridge import _category
from models import AnalysisService, LimsAnalysis, LimsSubSample, Peptide

# Live result states + variance sign-off (mirrors source_resolver, plus the
# variance_verified terminal state replicates land in).
_SERIES_STATES = ("submitted", "to_be_verified", "verified", "published", "variance_verified")

_CATEGORY_TO_KEY = {"purity": "PURITY", "quantity": "QUANTITY", "identity": "IDENTITY"}


def _fmt(category: str, value: str, unit: Optional[str]) -> str:
    """Format a replicate value to match the single-cell COA convention."""
    v = (value or "").strip()
    if category == "purity":
        return v if v.endswith("%") else f"{v}%"
    if category == "quantity":
        u = (unit or "mg").strip()
        return f"{v} {u}" if u and not v.endswith(u) else v
    return v  # identity: raw


def build_variance_replicates(db: Session, parent) -> dict:
    """{peptide_name: [per-vial record, ...]} for the parent's variance vials."""
    subs = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.assignment_kind == "variance",
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    if not subs:
        return {}

    out: dict[str, list] = {}
    for sub in subs:
        rows = db.execute(
            select(LimsAnalysis, AnalysisService, Peptide)
            .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .outerjoin(Peptide, Peptide.id == AnalysisService.peptide_id)
            .where(
                LimsAnalysis.lims_sub_sample_pk == sub.id,
                LimsAnalysis.review_state.in_(_SERIES_STATES),
                LimsAnalysis.reportable == True,  # noqa: E712
                LimsAnalysis.retest_of_id.is_(None),
                LimsAnalysis.result_value.isnot(None),
                LimsAnalysis.result_value != "",
            )
        ).all()
        # Group this vial's rows by peptide → record.
        per_peptide: dict[str, dict] = {}
        for la, svc, pep in rows:
            category = _category(la.keyword)
            key = _CATEGORY_TO_KEY.get(category or "")
            if not key or pep is None:
                continue
            rec = per_peptide.setdefault(pep.name, {"vial_sequence": sub.vial_sequence})
            rec[key] = _fmt(category, la.result_value, la.result_unit)
        for pname, rec in per_peptide.items():
            # Only records that carry at least one analyte value.
            if len(rec) > 1:
                out.setdefault(pname, []).append(rec)
    # Drop peptides whose vials contributed nothing.
    return {k: v for k, v in out.items() if v}
