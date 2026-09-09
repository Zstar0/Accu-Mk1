"""POST /api/samples/{sample_id}/cancel — native cancel (spec §8).

Order (one transaction): engine verb (catalog edge; 409 no edge, 412 unmet)
-> analysis-tier cascade + worksheet release -> sample_cancelled event ->
commit -> SENAITE tee in a background task (never blocks the user).
`dry_run` returns the same shape without writing; `confirm=false` on a real
call returns 412 carrying the preview (the dialog's gate).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import get_current_user
from database import SessionLocal, get_db
from models import LimsSample, LimsSubSampleEvent

router = APIRouter(prefix="/api/samples", tags=["samples"])


class CancelSampleBody(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)
    confirm: bool = False
    dry_run: bool = False


def _preview(db: Session, row: LimsSample) -> dict:
    from lims_analyses.service import preview_cancel
    pv = preview_cancel(db, parent_sample_pk=row.id)
    return {
        "status": row.status, "from_status": row.status,
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
            senaite_tee.tee_now(db, row, "cancel")
            db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


@router.post("/{sample_id}/cancel")
def cancel_sample(sample_id: str, body: CancelSampleBody, background_tasks: BackgroundTasks,
                  db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    from lims_analyses.service import cancel_pending_rows
    from workflow.engine import arm_native_status, execute_verb
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
    ev = execute_verb(db, row, "cancel", trigger="cancel", actor_user_id=actor_id)
    if ev is None or ev.outcome == "no_edge":
        db.rollback()
        raise HTTPException(409, f"no cancel edge from {from_status!r} in the workflow catalog")
    if ev.outcome == "requirements_unmet":
        db.rollback()
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
        "status": row.status, "from_status": from_status,
        "cancelled_rows": cascade["cancelled_rows"],
        "released_worksheets": cascade["released_worksheets"],
        "published_coa_still_live": bool(row.verification_code),
        "dry_run": False,
    }
