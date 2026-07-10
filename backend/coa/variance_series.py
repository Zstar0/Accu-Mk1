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

# Per-vial COA enumeration also accepts 'promoted' — the core HPLC vial whose
# result was promoted to the parent still has valid, reportable figures and
# should be able to spin off its own per-vial COA ("a COA for each vial with
# HPLC results"). The variance SERIES deliberately omits 'promoted' (the
# promoted core is represented by the parent figure there), so this is a
# vial-COA-only widening.
_VIAL_COA_STATES = _SERIES_STATES + ("promoted",)

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
            # SENAITE phase-out defense-in-depth: sentinel review_state
            # 'senaite_mirror' isn't in _SERIES_STATES, so a shadow row can't
            # reach this already — explicit clause per the fail-closed audit.
            LimsAnalysis.provenance == "canonical",
        )
    ).all()
    for kw, unit in rows:
        if _category(kw) == "quantity" and (unit or "").strip():
            return unit.strip()
    return None


def build_variance_replicates(db: Session, parent) -> dict:
    """{peptide_name: [per-vial record, ...]} for the parent's variance vials.

    Includes ALL in-set sub-vials (core + variance) so each physical vial is its
    own row. The core vial's results land in 'promoted' state; the variance vials'
    results land in 'variance_verified'. Non-variance samples (no in-set variance
    vial) return {} — the variance path must never fire for standard certs.
    """
    qty_unit = _parent_quantity_unit(db, parent) or "mg"
    # Variance sample = has >=1 in-set variance vial. Then list ALL in-set subs
    # (core + variance) so each physical vial is its own row; the parent record
    # is never a row (its figure is a promoted copy of one of these vials).
    subs = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.in_variance_set.is_(True),
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    if not any(s.assignment_kind == "variance" for s in subs):
        return {}

    out: dict[str, list] = {}
    for sub in subs:
        rows = db.execute(
            select(LimsAnalysis, AnalysisService, Peptide)
            .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .outerjoin(Peptide, Peptide.id == AnalysisService.peptide_id)
            .where(
                LimsAnalysis.lims_sub_sample_pk == sub.id,
                LimsAnalysis.review_state.in_(_VIAL_COA_STATES),  # _SERIES_STATES + 'promoted'
                LimsAnalysis.reportable == True,  # noqa: E712
                # Current vial result = retested IS False (the newest row in the
                # retest chain). retest_of_id IS NULL grabs the *canonical
                # original*, which becomes retested=True once a retest exists —
                # so it would report the SUPERSEDED value (P-0149 S03 regression).
                # Mirrors the vial-row idiom in sub_samples.lock_variance_set.
                LimsAnalysis.retested.is_(False),
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


def build_vial_figures(db: Session, sub: LimsSubSample, qty_unit: str = "mg") -> dict:
    """{peptide_name: {PURITY?, QUANTITY?, IDENTITY?}} for ONE HPLC vial.

    The per-vial COA shape COABuilder's engine consumes as `vial_figures`: a
    single record per peptide (no list, no vial_sequence inside) carrying whatever
    this vial measured. Same result-selection rules as the variance series
    (current row = retested False, reportable, live states). Empty when the vial
    has no reportable HPLC results.
    """
    rows = db.execute(
        select(LimsAnalysis, AnalysisService, Peptide)
        .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
        .outerjoin(Peptide, Peptide.id == AnalysisService.peptide_id)
        .where(
            LimsAnalysis.lims_sub_sample_pk == sub.id,
            LimsAnalysis.review_state.in_(_VIAL_COA_STATES),
            LimsAnalysis.reportable == True,  # noqa: E712
            LimsAnalysis.retested.is_(False),
            LimsAnalysis.result_value.isnot(None),
            LimsAnalysis.result_value != "",
        )
    ).all()
    vial_peptides = {pep.name for la, svc, pep in rows if pep is not None}
    sole_peptide = next(iter(vial_peptides)) if len(vial_peptides) == 1 else None
    per_peptide: dict[str, dict] = {}
    for la, svc, pep in rows:
        category = _category(la.keyword)
        key = _CATEGORY_TO_KEY.get(category or "")
        if not key:
            continue
        pname = pep.name if pep is not None else sole_peptide
        if pname is None:
            continue
        rec = per_peptide.setdefault(pname, {})
        rec[key] = _fmt(category, la.result_value, la.result_unit, default_unit=qty_unit)
    return {k: v for k, v in per_peptide.items() if v}


def list_hplc_vials_with_figures(db: Session, parent) -> list[tuple[int, dict]]:
    """[(vial_sequence, vial_figures), ...] for the parent's HPLC vials that carry
    reportable results, in vial_sequence order — the source set for per-vial COAs.

    Covers every assignment_role='hplc' vial (core AND variance), so each physical
    HPLC vial can be spun off into its own honest-verdict COA.
    """
    qty_unit = _parent_quantity_unit(db, parent) or "mg"
    subs = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.assignment_role == "hplc",
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    out: list[tuple[int, dict]] = []
    for sub in subs:
        figs = build_vial_figures(db, sub, qty_unit)
        if figs:
            out.append((sub.vial_sequence, figs))
    return out


def process_variance_fields(db: Session, parent) -> dict:
    """The variance portion of the COABuilder /process body for a parent.

    Returns {"variance_replicates": ..., "variance_analytes": ...}, omitting any
    key whose builder yields nothing. Shared by EVERY path that POSTs to
    COABuilder /process (initial generate AND regen-primary) so a regenerated COA
    keeps the same variance series — regen used to omit it, stripping the series
    off the certified COA. Best-effort: a builder error contributes no key rather
    than blocking generation.
    """
    fields: dict = {}
    try:
        reps = build_variance_replicates(db, parent)
        if reps:
            fields["variance_replicates"] = reps
    except Exception:  # noqa: BLE001 — a builder error must not block generation
        pass
    try:
        avar = build_variance_analyte_series(db, parent)
        if avar:
            fields["variance_analytes"] = avar
    except Exception:  # noqa: BLE001
        pass
    return fields


def build_variance_analyte_series(db: Session, parent) -> dict:
    """{keyword: {"unit": str, "values": [str, ...]}} for the parent's variance
    vials, limited to variance_capable analysis services.

    Keyed by SENAITE keyword (the same key COABuilder matches on in
    _Analyses_Detailed) so the generic engine can pair each series to its
    results_table row + baked spec. Values are per-vial current results
    (retested=False) in vial-sequence order; COABuilder prepends its own parent
    figure. Generic and analyte-agnostic — no peptide attribution, no
    purity/quantity/identity categories."""
    subs = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.assignment_kind == "variance",
            # Honor the overlay's "select which vials participate" — a deselected
            # vial (in_variance_set=False, e.g. "Customer request") must not reach
            # the COA, so the certified series matches the locked selection.
            LimsSubSample.in_variance_set.is_(True),
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    if not subs:
        return {}
    out: dict[str, dict] = {}
    for sub in subs:
        rows = db.execute(
            select(LimsAnalysis, AnalysisService)
            .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .where(
                LimsAnalysis.lims_sub_sample_pk == sub.id,
                AnalysisService.variance_capable.is_(True),
                LimsAnalysis.review_state.in_(_SERIES_STATES),
                LimsAnalysis.reportable == True,  # noqa: E712
                # Current vial result = retested IS False (the newest row in the
                # retest chain). retest_of_id IS NULL grabs the *canonical
                # original*, which becomes retested=True once a retest exists —
                # so it would report the SUPERSEDED value (P-0149 S03 regression).
                # Mirrors the vial-row idiom in build_variance_replicates above.
                LimsAnalysis.retested.is_(False),
                LimsAnalysis.result_value.isnot(None),
                LimsAnalysis.result_value != "",
            )
            .order_by(LimsAnalysis.keyword)
        ).all()
        for la, svc in rows:
            kw = (la.keyword or svc.keyword or "").strip()
            if not kw:
                continue
            # Unit locked from the first vial seen for this keyword
            # (la.result_unit, else the lab-configured svc.unit). A keyword maps
            # to one physical measurement, so vials share a unit; divergence
            # isn't detected.
            entry = out.setdefault(
                kw, {"unit": (la.result_unit or svc.unit or "").strip(), "values": []}
            )
            entry["values"].append(str(la.result_value).strip())
    return {k: v for k, v in out.items() if v["values"]}
