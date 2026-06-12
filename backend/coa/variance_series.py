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

import re
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import AnalysisService, LimsAnalysis, LimsSubSample, Peptide

# Live result states + variance sign-off (mirrors source_resolver, plus the
# variance_verified terminal state replicates land in).
_SERIES_STATES = ("submitted", "to_be_verified", "verified", "published", "variance_verified")

_CATEGORY_TO_KEY = {"purity": "PURITY", "quantity": "QUANTITY", "identity": "IDENTITY"}

_ANALYTE_PUR = re.compile(r"^ANALYTE-[1-4]-PUR$")
_ANALYTE_QTY = re.compile(r"^ANALYTE-[1-4]-QTY$")


def _category(keyword: Optional[str]) -> Optional[str]:
    """Categorize a result keyword for the variance series.

    Mirrors lims_analyses.prep_bridge._category but ALSO recognizes the generic
    production quantity keyword PEPT-Total ("Peptide Total Quantity"), which the
    bridge categorizer omits. Kept local so this addition can't shift prep-bridge
    routing behavior on the shared function.
    """
    kw = (keyword or "").upper()
    if kw == "HPLC-PUR" or kw.startswith("PUR_") or _ANALYTE_PUR.match(kw):
        return "purity"
    if kw == "PEPT-TOTAL" or kw.startswith("QTY_") or _ANALYTE_QTY.match(kw):
        return "quantity"
    if kw == "HPLC-ID" or kw.startswith("ID_"):
        return "identity"
    return None


def _fmt(category: str, value: str, unit: Optional[str], default_unit: str = "mg") -> str:
    """Format a replicate value to match the single-cell COA convention."""
    v = (value or "").strip()
    if category == "purity":
        return v if v.endswith("%") else f"{v}%"
    if category == "quantity":
        u = (unit or default_unit or "").strip()
        return f"{v} {u}" if u and not v.endswith(u) else v
    return v  # identity: raw


def _parent_quantity_unit(db: Session, parent) -> Optional[str]:
    """The parent's own quantity unit (e.g. 'mg/mL'), used as the fallback for
    variance vials whose quantity rows carry no unit — so the comma series stays
    consistent rather than fabricating 'mg' next to a 'mg/mL' parent figure."""
    rows = db.execute(
        select(LimsAnalysis.keyword, LimsAnalysis.result_unit).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.review_state.in_(_SERIES_STATES),
            LimsAnalysis.reportable == True,  # noqa: E712
            LimsAnalysis.result_unit.isnot(None),
        )
    ).all()
    for kw, unit in rows:
        if _category(kw) == "quantity" and (unit or "").strip():
            return unit.strip()
    return None


def build_variance_replicates(db: Session, parent) -> dict:
    """{peptide_name: [per-vial record, ...]} for the parent's variance vials."""
    qty_unit = _parent_quantity_unit(db, parent) or "mg"
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
        # Resolve the vial's peptide(s) from the peptide-specific services it
        # carries (identity is always peptide-specific; per-substance PUR_/QTY_
        # rows are too). Generic services (HPLC-PUR, PEPT-Total, HPLC-ID) carry
        # no peptide_id, so they can only be attributed when the vial measures a
        # single peptide — which is the production single-peptide case.
        vial_peptides = {pep.name for la, svc, pep in rows if pep is not None}
        sole_peptide = next(iter(vial_peptides)) if len(vial_peptides) == 1 else None

        # Group this vial's rows by peptide → record.
        per_peptide: dict[str, dict] = {}
        for la, svc, pep in rows:
            category = _category(la.keyword)
            key = _CATEGORY_TO_KEY.get(category or "")
            if not key:
                continue
            # Peptide-specific row → its own peptide; generic row → the vial's
            # sole peptide (skip a generic row on a multi-peptide vial, where it
            # can't be disambiguated).
            pname = pep.name if pep is not None else sole_peptide
            if pname is None:
                continue
            rec = per_peptide.setdefault(pname, {"vial_sequence": sub.vial_sequence})
            rec[key] = _fmt(category, la.result_value, la.result_unit, default_unit=qty_unit)
        for pname, rec in per_peptide.items():
            # Only records that carry at least one analyte value.
            if len(rec) > 1:
                out.setdefault(pname, []).append(rec)
    # Drop peptides whose vials contributed nothing.
    return {k: v for k, v in out.items() if v}
