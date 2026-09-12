"""Native retest auto check-in (HPLC native-born slice 6, M8, Task 3).

When a retest sample arrives via the S2S registry signal with meta
`AutoCheckin` true and its `retest_of_sample_id` original is a native-born
row that has already been received, the customer never re-uploads a vial
photo or re-types a remark for what is, from the lab's perspective, the same
physical retest. This copies the original's receive photo + receive-time
remark onto the new row and drives the same native receive phase the manual
wizard uses (`main._receive_native_phase`), so the new row ends up
`sample_received` with the engine touchpoint fired (and, via that, the
status relay to IS).

Never raises: scheduled as a BackgroundTask off the S2S route, same
hardening pattern as the other `_..._bg` helpers in main.py.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.hplc_native import is_native_born
from models import LimsParentAttachment, LimsSample, LimsSampleRemark, LimsSubSampleEvent
from sub_samples.photo_storage import PhotoNotFoundError, get_storage
from workflow.status_relay import flush_pending_relays

log = logging.getLogger(__name__)

# Mirrors _receive_native_phase's PRE_RECEIVED_STATES — a new row already
# past this set has already been (or is being) received some other way.
_PRE_RECEIVED = {None, "", "sample_due", "sample_registered", "to_be_sampled"}

_REMARK_WINDOW = timedelta(seconds=5)


def native_auto_checkin(sample_id: str) -> dict:
    """Copy the retest original's receive photo/remark onto `sample_id` and
    run the native receive phase. Never raises — every failure path returns
    `{"ok": False, ...}` instead."""
    from database import SessionLocal
    from main import _receive_native_phase

    db = None
    try:
        db = SessionLocal()
        new_row = db.execute(
            select(LimsSample).where(LimsSample.sample_id == sample_id)
        ).scalar_one_or_none()
        if new_row is None:
            return {"ok": False, "skipped": "new_row_missing"}
        if not new_row.retest_of_sample_id:
            return {"ok": False, "skipped": "no_retest_of_sample_id"}
        if new_row.status not in _PRE_RECEIVED:
            return {"ok": False, "skipped": "new_row_already_received"}

        original = db.execute(
            select(LimsSample).where(
                LimsSample.sample_id == new_row.retest_of_sample_id
            )
        ).scalar_one_or_none()
        if original is None:
            return {"ok": False, "skipped": "original_missing"}
        if not is_native_born(original):
            return {"ok": False, "skipped": "original_not_native_born"}
        if original.date_received is None:
            return {"ok": False, "skipped": "original_not_received"}

        image_bytes, copied_image = _copy_receive_image(db, original)
        remark, copied_remark = _copy_receive_remark(db, original)

        phase = _receive_native_phase(
            sample_id=new_row.sample_id,
            image_bytes=image_bytes,
            remarks=remark,
            user_id=None,
        )

        # M8 flush point: the phase above queued a status relay to IS via
        # the engine writer. Same never-raise shape as main.py's other
        # flush points (e.g. _after_publish_native).
        try:
            flush_pending_relays()
        except Exception:
            log.exception("status_relay.flush_failed after native_auto_checkin "
                          "(never-raise) sample_id=%s", sample_id)

        db.add(LimsSubSampleEvent(
            lims_sample_pk=new_row.id,
            event="native_auto_checkin",
            details={
                "original": original.sample_id,
                "copied_image": copied_image,
                "copied_remark": copied_remark,
                "steps": phase.get("steps") or [],
                "ok": phase.get("ok", False),
            },
        ))
        db.commit()
        return {
            "ok": phase.get("ok", False),
            "copied_image": copied_image,
            "copied_remark": copied_remark,
            "steps": phase.get("steps") or [],
        }
    except Exception as e:  # noqa: BLE001 — never raise off a bg task
        if db is not None:
            try:
                db.rollback()
            except Exception:
                pass
        log.warning("native_auto_checkin.failed sample_id=%s err=%s", sample_id, e)
        return {"ok": False, "skipped": f"error: {e}"}
    finally:
        if db is not None:
            db.close()


def _copy_receive_image(db: Session, original: LimsSample) -> tuple[bytes | None, bool]:
    """Fetch the bytes of the original's newest `receive_image` attachment.
    Any failure (no attachment, storage miss) proceeds without an image."""
    att = db.execute(
        select(LimsParentAttachment)
        .where(
            LimsParentAttachment.lims_sample_pk == original.id,
            LimsParentAttachment.kind == "receive_image",
            LimsParentAttachment.storage == "s3",
        )
        .order_by(LimsParentAttachment.created_at.desc(), LimsParentAttachment.id.desc())
    ).scalars().first()
    if att is None or not att.storage_key:
        return None, False
    try:
        return get_storage().fetch_photo(att.storage_key), True
    except PhotoNotFoundError:
        return None, False
    except Exception as e:  # noqa: BLE001 — storage outage must not block check-in
        log.warning("native_auto_checkin.photo_fetch_failed sample_id=%s err=%s",
                    original.sample_id, e)
        return None, False


def _copy_receive_remark(db: Session, original: LimsSample) -> tuple[str | None, bool]:
    """The original's receive-time remark: an authored remark created within
    +/-5s of date_received, else the newest authored remark, else None."""
    authored = db.execute(
        select(LimsSampleRemark)
        .where(
            LimsSampleRemark.lims_sample_pk == original.id,
            LimsSampleRemark.author_user_id.isnot(None),
        )
        .order_by(LimsSampleRemark.created_at.desc())
    ).scalars().all()
    if not authored:
        return None, False
    received_at = original.date_received
    if received_at is not None:
        for r in authored:
            if abs(r.created_at - received_at) <= _REMARK_WINDOW:
                return r.content, True
    return authored[0].content, True
