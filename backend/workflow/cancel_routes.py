"""POST /api/samples/{sample_id}/cancel — native cancel (spec §8).

Order (one transaction): engine verb (catalog edge; 409 no edge, 412 unmet)
-> analysis-tier cascade + worksheet release -> sample_cancelled event ->
commit -> SENAITE tee in a background task (never blocks the user).
`dry_run` returns the same shape without writing; `confirm=false` on a real
call returns 412 carrying the preview (the dialog's gate).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import get_current_user
from database import SessionLocal, get_db
from models import LimsSample, LimsSubSampleEvent, LimsWorkflowShadowEvaluation

router = APIRouter(prefix="/api/samples", tags=["samples"])

log = logging.getLogger(__name__)


class CancelSampleBody(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)
    confirm: bool = False
    dry_run: bool = False


def _preview(db: Session, row: LimsSample) -> dict:
    """Preview shape for both dry_run and confirm=false (412) responses.

    In senaite-authority mode `lims_samples.status` still mirrors SENAITE
    until the tee lands, so `status`/`from_status` report the engine's own
    view (`native_status`, falling back to `status` for an unseeded sample)
    rather than the mirrored column.
    """
    from lims_analyses.service import preview_cancel
    pv = preview_cancel(db, parent_sample_pk=row.id)
    engine_view = row.native_status or row.status
    return {
        "status": engine_view, "from_status": engine_view,
        "cancelled_rows": pv["cancelled_rows"],
        "released_worksheets": pv["released_worksheets"],
        "published_coa_still_live": bool(row.verification_code),
        "dry_run": True,
    }


def _tee_cancel_bg(sample_pk: int) -> None:
    from workflow import senaite_tee
    db = SessionLocal()
    try:
        row = db.get(LimsSample, sample_pk)
        if row is not None:
            result = senaite_tee.tee_now(db, row, "cancel")
            log.info("cancel_tee sample=%s result=%s", row.sample_id, result)
            db.commit()
    except Exception:
        log.exception("cancel_tee_bg_failed sample_pk=%s", sample_pk)
        db.rollback()
    finally:
        db.close()


@router.post("/{sample_id}/cancel")
def cancel_sample(sample_id: str, body: CancelSampleBody, background_tasks: BackgroundTasks,
                  db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    from lims_analyses.service import cancel_pending_rows
    from workflow.engine import _find_edge, arm_native_status, execute_verb
    row = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id).with_for_update()
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, f"sample {sample_id} not found")
    if row.status == "cancelled" or row.native_status == "cancelled":
        raise HTTPException(409, f"{sample_id} is already cancelled")
    preview = _preview(db, row)
    if body.dry_run:
        return preview
    if not body.confirm:
        raise HTTPException(412, detail=preview)
    actor_id = getattr(current_user, "id", None)
    if row.native_status is None:
        arm_native_status(db, row, row.status, trigger="cancel", actor_user_id=actor_id)
    from_status = row.native_status
    # Pre-check the edge before calling execute_verb: _record's delta-dedup
    # (engine.py::_record) returns None for a REPEATED identical refusal, not
    # just a genuinely missing edge — execute_verb returning None conflates
    # the two. Checking _find_edge first makes "no edge" unambiguous and
    # lets the ev-is-None branch below mean "deduped repeat" only.
    if _find_edge(db, from_status, "cancel") is None:
        db.commit()  # persist the arming above; nothing else pending
        raise HTTPException(409, f"no cancel edge from {from_status!r} in the workflow catalog")
    ev = execute_verb(db, row, "cancel", trigger="cancel", actor_user_id=actor_id)
    if ev is None:
        # Deduped repeat of an identical refusal (_record returned None) —
        # the edge exists (just checked), so this is not "no edge". Load the
        # latest recorded refusal for this sample/verb to report requirements.
        latest = db.execute(
            select(LimsWorkflowShadowEvaluation)
            .where(LimsWorkflowShadowEvaluation.lims_sample_pk == row.id,
                   LimsWorkflowShadowEvaluation.verb == "cancel")
            .order_by(LimsWorkflowShadowEvaluation.id.desc())
            .limit(1)
        ).scalars().first()
        db.commit()
        raise HTTPException(412, detail={"requirements": latest.outcomes if latest else []})
    if ev.outcome == "no_edge":
        # Defensive; unreachable after the _find_edge pre-check above.
        db.commit()
        raise HTTPException(409, f"no cancel edge from {from_status!r} in the workflow catalog")
    if ev.outcome == "requirements_unmet":
        db.commit()
        raise HTTPException(412, detail={"requirements": ev.outcomes})
    cascade = cancel_pending_rows(db, parent_sample_pk=row.id, user_id=actor_id, reason=body.reason)
    db.add(LimsSubSampleEvent(
        lims_sample_pk=row.id, event="sample_cancelled", user_id=actor_id,
        details={"reason": body.reason, "from_status": from_status,
                 "published_coa": bool(row.verification_code),
                 "cancelled_rows": len(cascade["cancelled_rows"]),
                 "released_worksheets": cascade["released_worksheets"]},
    ))
    db.commit()
    background_tasks.add_task(_tee_cancel_bg, row.id)
    return {
        "status": row.native_status or row.status, "from_status": from_status,
        "cancelled_rows": cascade["cancelled_rows"],
        "released_worksheets": cascade["released_worksheets"],
        "published_coa_still_live": bool(row.verification_code),
        "dry_run": False,
    }
