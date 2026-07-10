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
    """The live shadow row for (parent, service) — baseline or retest alike.

    Deliberately does NOT filter on retest_of_id: after a retest, the live
    row is the NEW row, which carries retest_of_id != NULL. Filtering on
    retest_of_id IS NULL would miss it and a subsequent update would CREATE
    a spurious third row instead of updating the live one. `retested` is
    the only liveness signal — the newest non-retested shadow row IS the
    live one. Ordered by id desc + take-first (not scalar_one_or_none): if
    an anomaly ever produces more than one live row, resolve deterministically
    to the newest rather than raising.
    """
    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_id,
            LimsAnalysis.analysis_service_id == service_id,
            LimsAnalysis.provenance == "shadow",
            LimsAnalysis.retested.is_(False),
        ).order_by(LimsAnalysis.id.desc())
    ).scalars().first()


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

    if is_retest:
        old = _existing_shadow(db, parent.id, svc.id)
        if old is not None:
            old.retested = True
            db.add(LimsAnalysisTransition(
                analysis_id=old.id, from_state=old.review_state, to_state=old.review_state,
                transition_kind="retest", reason="shadow mirror: superseded by retest",
            ))
            # Flush the old row's retested=True BEFORE inserting the new row:
            # the shadow partial unique index (lims_sample_pk,
            # analysis_service_id) WHERE provenance='shadow' AND retested=FALSE
            # must never see two "live" rows for this (parent, service) within
            # the same transaction, even momentarily.
            db.flush()
        new_row = LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            review_state=SHADOW_STATE, provenance="shadow",
            mirror_review_state=mirror_review_state,
            result_value=result_value, result_unit=result_unit,
            method_id=method_id, instrument_id=instrument_id,
            retest_of_id=(old.id if old is not None else None),
        )
        db.add(new_row)
        db.flush()
        db.add(LimsAnalysisTransition(
            analysis_id=new_row.id, from_state=None, to_state=SHADOW_STATE,
            transition_kind="auto", reason="shadow mirror: retest insert",
        ))
        db.flush()
        return True

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
