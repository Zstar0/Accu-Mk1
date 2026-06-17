"""
Bridge a vial-scoped HPLC Sample Prep result onto the vial's lims_analyses rows.

A Sample Prep (accumark_mk1.sample_preps) may carry a lims_sub_sample_pk — the
vial it was prepped for. When the HPLC run for that prep produces an
HPLCAnalysis (purity_percent / identity_conforms / quantity_mg), this writes the
matching result onto the vial's unassigned HPLC lims_analyses rows and runs the
existing 'submit' transition (-> to_be_verified). Verify/promote stay manual.

Purity/quantity routing is PRIMARY by per-substance keyword: the prep peptide's
own PUR_<X>/QTY_<X> row is resolved via a catalog lookup (analysis_services.
peptide_id -> keyword) and matched directly — no SENAITE/slot resolution. This
disambiguates blend vials carrying multiple PUR_<X>/QTY_<X> rows. Legacy shapes
remain as fallbacks: per-analyte ANALYTE-{slot}-* (route by SENAITE-resolved
slot) and the generic HPLC-PUR / single QTY_* row, for vials seeded before the
per-substance mirror.

Idempotent: only 'unassigned' rows are touched.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import AnalysisService, HPLCAnalysis, LimsAnalysis, LimsSample, LimsSubSample, Peptide
from lims_analyses.service import apply_transition

logger = logging.getLogger(__name__)

_ANALYTE_PUR = re.compile(r"^ANALYTE-[1-4]-PUR$")
_ANALYTE_QTY = re.compile(r"^ANALYTE-[1-4]-QTY$")


def _norm(s: Optional[str]) -> str:
    """Uppercase, alphanumerics only — for analyte token matching."""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _peptide_service_keyword(db: Session, *, peptide: Optional[Peptide], prefix: str) -> Optional[str]:
    """The per-substance service keyword for `peptide` and prefix ('PUR_'/'QTY_'),
    e.g. PUR_BPC157, or None. Catalog lookup by peptide_id — no SENAITE.

    Assumes one PUR_/QTY_ service per peptide (the 1:1 invariant the migration
    establishes). `order_by(keyword)` makes the pick deterministic and matches the
    seeder mirror's selection (which also picks the lowest keyword per peptide) so
    the row the mirror seeds is the row the bridge resolves, even in the
    (currently nonexistent) two-services-per-peptide edge."""
    if not peptide:
        return None
    return db.execute(
        select(AnalysisService.keyword).where(
            AnalysisService.peptide_id == peptide.id,
            AnalysisService.keyword.like(prefix.replace("_", r"\_") + "%", escape="\\"),
        ).order_by(AnalysisService.keyword).limit(1)
    ).scalar_one_or_none()


def _category(keyword: Optional[str]) -> Optional[str]:
    # Note: there is intentionally no ANALYTE-N-IDENT branch. Parent ARs express
    # identity via the per-peptide ID_* keywords (e.g. ID_GHKCU) and the generic
    # HPLC-ID — never as ANALYTE-N-IDENT — so that form is not a categorized/
    # bridged shape. Its absence here is deliberate, not a gap.
    kw = (keyword or "").upper()
    if kw == "HPLC-PUR" or kw.startswith("PUR_") or _ANALYTE_PUR.match(kw):
        return "purity"
    if kw == "HPLC-ID" or kw.startswith("ID_"):
        return "identity"
    if kw.startswith("QTY_") or _ANALYTE_QTY.match(kw):
        return "quantity"
    return None


def _resolve_slot(db: Session, *, parent_sample_id: Optional[str], peptide: Optional[Peptide]) -> Optional[int]:
    """Return the parent's analyte slot (1-4) for `peptide`, else None.

    Matches the parent AR's Analyte{N}Peptide TITLE (which is built from the
    peptide *name*) against the prep peptide's name OR abbreviation — either may
    be the form the parent used. First matching slot wins (a parent should never
    list the same analyte twice)."""
    if not parent_sample_id or not peptide:
        return None
    from sub_samples.senaite import fetch_parent_analyte_slots
    slots = fetch_parent_analyte_slots(parent_sample_id)
    wants = {_norm(t) for t in (peptide.name, peptide.abbreviation) if t}
    for n, title in slots.items():
        name = re.sub(r"\s*-\s*identity\s*\(hplc\)\s*$", "", title or "", flags=re.I)
        if _norm(name) in wants:
            return n
    return None


def _fmt_num(v: Optional[float]) -> Optional[str]:
    if v is None:
        return None
    return f"{v:.3f}".rstrip("0").rstrip(".")


def _result_for(category: str, analysis: HPLCAnalysis, peptide: Optional[Peptide]) -> Optional[str]:
    if category == "purity":
        return _fmt_num(analysis.purity_percent)
    if category == "quantity":
        return _fmt_num(analysis.quantity_mg)
    if category == "identity":
        if analysis.identity_conforms is None:
            return None
        if analysis.identity_conforms:
            # Conforming identity result_value is the peptide name (matches the
            # live ID_* convention, e.g. ID_BPC157 -> "BPC-157").
            return peptide.name if peptide else "Conforms"
        return "Non-conforming"
    return None


def _pick_target(category: str, candidates: list[LimsAnalysis], *, slot: Optional[int],
                 peptide_kw: Optional[str], id_kw: Optional[str] = None,
                 pep_token: str = "") -> Optional[LimsAnalysis]:
    """Choose the single target row for a category, or None if ambiguous/empty.

    Identity routing, in order:
      1. per-substance: the prep peptide's OWN ID_<X> row, matched by the
         catalog-resolved `id_kw` (peptide_id -> keyword). Primary — robust for
         fragment-suffixed names (TB500-17-23) and disambiguates ID_TB500 vs
         ID_TB500-17-23, which keyword-token matching cannot.
      2. token fallback: when `id_kw` is None (no catalog ID_ service, e.g. unit
         fixtures), match an ID_<X> row whose normalized suffix equals `pep_token`.
      3. generic HPLC-ID — only when the vial carries NO peptide-specific ID_
         rows at all (legacy single-peptide shape). A blend's generic HPLC-ID is
         never contaminated by a component's identity.

    Purity/quantity routing, in order:
      1. per-substance: the prep peptide's OWN PUR_<X>/QTY_<X> row, matched by
         the catalog-resolved `peptide_kw`. This is primary and handles blends
         with multiple PUR_/QTY_ rows (the peptide selects which).
      2. legacy per-analyte ANALYTE-{slot}-* rows (route by SENAITE-resolved slot).
      3. legacy generic row (HPLC-PUR, or a single QTY_* row) — exactly one.
    """
    if category == "identity":
        specific = [r for r in candidates if (r.keyword or "").upper().startswith("ID_")]
        if id_kw:
            m = [r for r in specific if (r.keyword or "").upper() == id_kw.upper()]
            if len(m) == 1:
                return m[0]
            if m:
                return None  # duplicate specific rows — ambiguous
        elif pep_token:
            m = [r for r in specific if _norm((r.keyword or "")[3:]) == pep_token]
            if len(m) == 1:
                return m[0]
            if m:
                return None
        # Generic HPLC-ID only when there are NO peptide-specific ID_ rows on the
        # vial (legacy single-peptide). Never write a blend's generic row.
        if not specific:
            generic = [r for r in candidates if (r.keyword or "").upper() == "HPLC-ID"]
            if len(generic) == 1:
                return generic[0]
        return None
    # purity / quantity
    # 1. per-substance: the prep peptide's own PUR_<X>/QTY_<X> row.
    if peptide_kw:
        ps = [r for r in candidates if (r.keyword or "").upper() == peptide_kw.upper()]
        if len(ps) == 1:
            return ps[0]
        if ps:
            return None
    # 2. legacy per-analyte ANALYTE-{slot}-*
    suffix = "PUR" if category == "purity" else "QTY"
    analyte = [r for r in candidates if re.match(r"^ANALYTE-[1-4]-" + suffix + "$", (r.keyword or "").upper())]
    if analyte:
        if slot is None:
            return None
        want = f"ANALYTE-{slot}-{suffix}"
        match = [r for r in analyte if (r.keyword or "").upper() == want]
        return match[0] if len(match) == 1 else None
    # 3. legacy generic
    if category == "purity":
        # HPLC-PUR is a disjoint, peptide-agnostic generic keyword — safe to use
        # as the legacy fallback even when a per-substance pur_kw exists.
        generic = [r for r in candidates if (r.keyword or "").upper() == "HPLC-PUR"]
    elif peptide_kw is None:
        # Quantity has no distinct generic keyword — QTY_<X> IS the per-substance
        # namespace. Only fall back to a lone QTY_ row when we have NO per-substance
        # keyword for this peptide (true legacy vial); otherwise tier 1 is
        # authoritative and substituting a foreign peptide's QTY_ row would be a
        # wrong-result guess.
        generic = [r for r in candidates if (r.keyword or "").upper().startswith("QTY_")]
    else:
        generic = []
    return generic[0] if len(generic) == 1 else None


def _component_key(keyword: Optional[str], suffix: str) -> Optional[str]:
    """Component identity for a per-substance PUR_/QTY_ or legacy ANALYTE-N row.
    Returns e.g. 'BPC157' for 'PUR_BPC157' / 'QTY_BPC157', or 'ANALYTE-2' for
    'ANALYTE-2-PUR' — the shared key used to pair a component's purity & quantity.
    None for non-component rows (BLEND-PUR, PEPT-Total, HPLC-PUR, ...)."""
    kw = (keyword or "").upper()
    if kw.startswith(suffix + "_"):
        return kw[len(suffix) + 1:]
    m = re.match(r"^(ANALYTE-[1-4])-" + suffix + r"$", kw)
    return m.group(1) if m else None


def _parse_float(s: Optional[str]) -> Optional[float]:
    try:
        return float(s) if s not in (None, "") else None
    except (TypeError, ValueError):
        return None


def bridge_blend_aggregates(
    db: Session,
    *,
    lims_sub_sample_pk: int,
    user_id: Optional[int] = None,
) -> list[int]:
    """Compute & write a blend vial's aggregate rows from its filled per-component
    rows: BLEND-PUR (mass-weighted mean purity, Σ(qty·purity)/Σqty) and PEPT-Total
    (Σ quantity). Mirrors the flyout summary formula.

    Gated on a BLEND-PUR row existing — that keyword is blend-only, so single-
    peptide vials (which also carry PEPT-Total) are never touched. Writes only
    once EVERY per-component purity AND quantity row is filled (so a partial blend
    never writes a wrong aggregate), and only onto still-'unassigned' aggregate
    rows. Computes from the same vial rows it gates on (no divergent source).
    Returns the aggregate row ids that were written.
    """
    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == lims_sub_sample_pk,
        )
    ).scalars().all()

    blend_pur = next((r for r in rows if (r.keyword or "").upper() == "BLEND-PUR"), None)
    pept_total = next((r for r in rows if (r.keyword or "").upper() == "PEPT-TOTAL"), None)
    if blend_pur is None:  # not a blend vial — leave singles alone
        return []

    # Pair each component's purity + quantity by shared key.
    comps: dict[str, dict[str, Optional[float]]] = {}
    pur_rows, qty_rows = [], []
    for r in rows:
        pk_ = _component_key(r.keyword, "PUR")
        qk_ = _component_key(r.keyword, "QTY")
        if pk_:
            pur_rows.append(r)
            comps.setdefault(pk_, {})["pur"] = _parse_float(r.result_value)
        elif qk_:
            qty_rows.append(r)
            comps.setdefault(qk_, {})["qty"] = _parse_float(r.result_value)

    # Completeness: at least one component pair, and every per-component purity &
    # quantity row is filled (no longer 'unassigned').
    comp_rows = pur_rows + qty_rows
    if not comp_rows or any(r.review_state == "unassigned" for r in comp_rows):
        return []

    total_qty = sum(c["qty"] for c in comps.values() if c.get("qty") is not None)
    weighted = sum(
        c["qty"] * c["pur"]
        for c in comps.values()
        if c.get("qty") is not None and c.get("pur") is not None
    )

    written: list[int] = []
    # Total quantity → PEPT-Total
    if pept_total is not None and pept_total.review_state == "unassigned":
        val = _fmt_num(total_qty)
        if val is not None:
            apply_transition(db, analysis_id=pept_total.id, kind="submit", result_value=val,
                             reason="auto: blend total quantity (Σ component quantity)",
                             user_id=user_id)
            written.append(pept_total.id)
    # Mass-weighted blend purity → BLEND-PUR (needs Σqty > 0 to weight)
    if blend_pur.review_state == "unassigned" and total_qty > 0:
        val = _fmt_num(weighted / total_qty)
        if val is not None:
            apply_transition(db, analysis_id=blend_pur.id, kind="submit", result_value=val,
                             reason="auto: blend purity (mass-weighted component mean)",
                             user_id=user_id)
            written.append(blend_pur.id)
    return written


def stamp_prep_assignment(
    db: Session,
    *,
    lims_sub_sample_pk: int,
    instrument_id: Optional[int],
    method_id: Optional[int],
    user_id: Optional[int] = None,
) -> list[int]:
    """Stamp the prep's instrument + the peptide's method onto the vial's
    unassigned HPLC-category lims_analyses rows at prep-creation time.

    Before this, method was always manual (the vial page picker) and
    instrument only landed at results-bridge time on the rows that bridged —
    even though the wizard already knows both when the prep is saved.

    Fill-only-NULL: a value already on a row (bench overlay, earlier prep) is
    never overwritten. Micro rows (no HPLC category per _category) and rows
    past 'unassigned' are untouched. Audit rides set_method_instrument's
    existing 'auto' transition. Returns the ids of rows that changed.
    """
    if instrument_id is None and method_id is None:
        return []
    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == lims_sub_sample_pk,
            LimsAnalysis.review_state == "unassigned",
        )
    ).scalars().all()

    from lims_analyses.service import set_method_instrument

    changed: list[int] = []
    for row in rows:
        if _category(row.keyword) is None:
            continue
        new_method = row.method_id if row.method_id is not None else method_id
        new_instrument = row.instrument_id if row.instrument_id is not None else instrument_id
        if new_method == row.method_id and new_instrument == row.instrument_id:
            continue
        set_method_instrument(
            db,
            analysis_id=row.id,
            method_id=new_method,
            instrument_id=new_instrument,
            user_id=user_id,
        )
        changed.append(row.id)
    return changed


def rebridge_prep(db: Session, *, prep_id: int, user_id: Optional[int] = None) -> list[int]:
    """Re-run the bridge for every HPLC analysis recorded against a vial-scoped
    prep. Used by the flyout's vial-results view "Auto-fill" — covers rows the
    create-time bridge skipped (or rows seeded after the analysis was saved).
    Safe to repeat: the underlying bridge only touches 'unassigned' rows.

    Raises LookupError (unknown prep) or ValueError (parent-scoped prep / no
    HPLC analyses yet) for the route to map onto 404/409.
    """
    import mk1_db

    prep = mk1_db.get_sample_prep(prep_id)
    if not prep:
        raise LookupError(f"sample prep {prep_id} not found")
    sub_pk = prep.get("lims_sub_sample_pk")
    if sub_pk is None:
        raise ValueError(f"sample prep {prep_id} is not vial-scoped")

    analyses = db.execute(
        select(HPLCAnalysis)
        .where(HPLCAnalysis.sample_prep_id == prep_id)
        .order_by(HPLCAnalysis.id)
    ).scalars().all()
    if not analyses:
        raise ValueError(f"sample prep {prep_id} has no HPLC analyses yet")

    submitted: list[int] = []
    for analysis in analyses:
        peptide = db.get(Peptide, analysis.peptide_id) if analysis.peptide_id else None
        submitted.extend(bridge_prep_result_to_vial(
            db,
            lims_sub_sample_pk=sub_pk,
            analysis=analysis,
            peptide=peptide,
            user_id=user_id,
        ))
    # Blend aggregates (BLEND-PUR / PEPT-Total) once all component rows are filled.
    submitted.extend(bridge_blend_aggregates(db, lims_sub_sample_pk=sub_pk, user_id=user_id))
    return submitted


def bridge_prep_result_to_vial(
    db: Session,
    *,
    lims_sub_sample_pk: int,
    analysis: HPLCAnalysis,
    peptide: Optional[Peptide],
    user_id: Optional[int] = None,
) -> list[int]:
    """
    Write `analysis`'s results onto the vial's unassigned HPLC lims_analyses
    rows and submit them. Returns submitted analysis ids.

    Guards: only 'unassigned' rows; peptide-specific identity rows (ID_<PEPTIDE>)
    must match `peptide`; a result category with 0 or 2+ matching rows is skipped
    (never guess); rows with no derivable value are skipped.
    """
    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == lims_sub_sample_pk,
            LimsAnalysis.review_state == "unassigned",
        )
    ).scalars().all()

    pep_token = _norm(peptide.abbreviation or peptide.name) if peptide else ""

    # Bucket candidate rows by result category. Identity rows are NOT filtered
    # here by token; _pick_target selects the right ID_<X> row per-peptide
    # (catalog id_kw primary, token fallback), which is what disambiguates blends.
    by_category: dict[str, list[LimsAnalysis]] = {}
    for row in rows:
        category = _category(row.keyword)
        if category is None:
            continue
        by_category.setdefault(category, []).append(row)

    # Lazy slot resolution: only hit SENAITE when a per-analyte row is present.
    needs_slot = any(
        _ANALYTE_PUR.match((r.keyword or "").upper()) or _ANALYTE_QTY.match((r.keyword or "").upper())
        for cands in by_category.values() for r in cands
    )
    slot: Optional[int] = None
    if needs_slot:
        sub = db.get(LimsSubSample, lims_sub_sample_pk)
        parent = db.get(LimsSample, sub.parent_sample_pk) if sub else None
        parent_sample_id = parent.sample_id if parent else None
        slot = _resolve_slot(db, parent_sample_id=parent_sample_id, peptide=peptide)
        if slot is None:
            logger.warning(
                "prep_bridge: vial=%s peptide=%s could not be matched to a parent "
                "analyte slot — analyte rows skipped",
                lims_sub_sample_pk, (peptide.name if peptide else None),
            )

    # Per-substance keywords for THIS prep's peptide (catalog lookup, no SENAITE).
    # Primary routing target — selects the peptide's own PUR_<X>/QTY_<X> row.
    pur_kw = _peptide_service_keyword(db, peptide=peptide, prefix="PUR_")
    qty_kw = _peptide_service_keyword(db, peptide=peptide, prefix="QTY_")
    id_kw = _peptide_service_keyword(db, peptide=peptide, prefix="ID_")

    submitted: list[int] = []
    for category, candidates in by_category.items():
        peptide_kw = pur_kw if category == "purity" else (qty_kw if category == "quantity" else None)
        row = _pick_target(category, candidates, slot=slot, peptide_kw=peptide_kw,
                           id_kw=id_kw, pep_token=pep_token)
        if row is None:
            logger.warning(
                "prep_bridge: ambiguous/unresolved %s match for vial=%s (%d candidates) — skipping",
                category, lims_sub_sample_pk, len(candidates),
            )
            continue
        value = _result_for(category, analysis, peptide)
        if value is None:
            continue
        # Instrument from the HPLC run; method is not carried on HPLCAnalysis
        # (left for the bench/overlay to set).
        if analysis.instrument_id is not None:
            row.instrument_id = analysis.instrument_id
        apply_transition(
            db,
            analysis_id=row.id,
            kind="submit",
            result_value=value,
            reason=f"auto: HPLC sample-prep result (analysis #{analysis.id})",
            user_id=user_id,
        )
        submitted.append(row.id)

    if not submitted:
        logger.warning(
            "prep_bridge: no unambiguous HPLC lims_analyses rows matched for vial=%s (analysis #%s)",
            lims_sub_sample_pk, analysis.id,
        )
    return submitted
