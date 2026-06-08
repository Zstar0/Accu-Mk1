"""
Bridge a vial-scoped HPLC Sample Prep result onto the vial's lims_analyses rows.

A Sample Prep (accumark_mk1.sample_preps) may carry a lims_sub_sample_pk — the
vial it was prepped for. When the HPLC run for that prep produces an
HPLCAnalysis (purity_percent / identity_conforms / quantity_mg), this writes the
matching result onto the vial's unassigned HPLC lims_analyses rows and runs the
existing 'submit' transition (-> to_be_verified). Verify/promote stay manual.

Idempotent: only 'unassigned' rows are touched.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import HPLCAnalysis, LimsAnalysis, Peptide
from lims_analyses.service import apply_transition

logger = logging.getLogger(__name__)


def _norm(s: Optional[str]) -> str:
    """Uppercase, alphanumerics only — for analyte token matching."""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _category(keyword: Optional[str]) -> Optional[str]:
    kw = (keyword or "").upper()
    if kw == "HPLC-PUR":
        return "purity"
    if kw == "HPLC-ID" or kw.startswith("ID_"):
        return "identity"
    if kw.startswith("QTY_"):
        return "quantity"
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

    # Bucket candidate rows by result category, applying the peptide guard for
    # analyte-specific identity rows (ID_<PEPTIDE>).
    by_category: dict[str, list[LimsAnalysis]] = {}
    for row in rows:
        category = _category(row.keyword)
        if category is None:
            continue
        if category == "identity" and (row.keyword or "").upper().startswith("ID_"):
            row_token = _norm((row.keyword or "").upper()[3:])
            if pep_token and row_token and row_token != pep_token:
                logger.info(
                    "prep_bridge: skip vial=%s row=%s kw=%s — analyte %s != prep %s",
                    lims_sub_sample_pk, row.id, row.keyword, row_token, pep_token,
                )
                continue
        by_category.setdefault(category, []).append(row)

    submitted: list[int] = []
    for category, candidates in by_category.items():
        if len(candidates) != 1:
            logger.warning(
                "prep_bridge: ambiguous %s match for vial=%s (%d rows) — skipping",
                category, lims_sub_sample_pk, len(candidates),
            )
            continue
        row = candidates[0]
        value = _result_for(category, analysis, peptide)
        if value is None:
            continue
        # Instrument from the HPLC run; method is not carried on HPLCAnalysis
        # (left for the bench/overlay to set).
        if analysis.instrument_id is not None:
            row.instrument_id = analysis.instrument_id
        db.flush()
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
