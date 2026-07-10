"""Parent analysis SENAITE->Mk1 shadow mirror (SENAITE phase-out slice).

Best-effort dual-write: mirror parent-AR analysis line items into native
lims_analyses SHADOW rows. Shadow rows carry provenance='shadow' + sentinel
review_state=SHADOW_STATE so no live COA/variance/family reader picks them
up (fail-closed). SENAITE stays system-of-record; nothing reads shadows this slice.
"""
from __future__ import annotations
from datetime import datetime
from typing import Optional, Tuple
from sqlalchemy import select
from sqlalchemy.orm import Session
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSample

SHADOW_STATE = "senaite_mirror"


def resolve_shadow_target(db: Session, *, sample_id: str, keyword: str
                          ) -> Optional[Tuple[LimsSample, AnalysisService]]:
    """Resolve (parent LimsSample, AnalysisService) from a SENAITE getRequestID
    + Keyword. Returns None when the parent isn't in the registry yet, or the
    service keyword is unknown — the documented no-op contract."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return None
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword == keyword)
    ).scalar_one_or_none()
    if svc is None:
        return None
    return parent, svc


def _existing_shadow(db: Session, parent_id: int, service_id: int) -> Optional[LimsAnalysis]:
    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_id,
            LimsAnalysis.analysis_service_id == service_id,
            LimsAnalysis.provenance == "shadow",
            LimsAnalysis.retest_of_id.is_(None),
            LimsAnalysis.retested.is_(False),
        )
    ).scalar_one_or_none()


def mirror_parent_analysis(db: Session, *, sample_id: str, keyword: str,
                           mirror_review_state: Optional[str] = None,
                           result_value: Optional[str] = None,
                           result_unit: Optional[str] = None,
                           method_id: Optional[int] = None,
                           instrument_id: Optional[int] = None,
                           is_retest: bool = False) -> bool:
    """Upsert a parent shadow row. Returns False (no-op) if the parent isn't
    registered. Caller commits. Best-effort — callers wrap in try/except."""
    target = resolve_shadow_target(db, sample_id=sample_id, keyword=keyword)
    if target is None:
        return False
    parent, svc = target

    row = _existing_shadow(db, parent.id, svc.id)
    if row is None:
        row = LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            review_state=SHADOW_STATE, provenance="shadow",
        )
        db.add(row)
        db.flush()
        db.add(LimsAnalysisTransition(
            analysis_id=row.id, from_state=None, to_state=SHADOW_STATE,
            transition_kind="auto", reason="shadow mirror: initial insert",
        ))

    if mirror_review_state is not None:
        row.mirror_review_state = mirror_review_state
    if result_value is not None:
        row.result_value = result_value
    if result_unit is not None:
        row.result_unit = result_unit
    if method_id is not None:
        row.method_id = method_id
    if instrument_id is not None:
        row.instrument_id = instrument_id
    row.updated_at = datetime.utcnow()
    db.flush()
    return True
