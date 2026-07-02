from datetime import datetime
from typing import List

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from models import LimsBox, LimsSubSample

BOXABLE_ROLES = {"hplc", "endo", "ster"}


def box_label_code(box: LimsBox) -> str:
    """Verbatim order key + running number; never adds a 'WP-' prefix."""
    return f"{box.order_key}-{box.box_number}"


def vial_count(db: Session, box_id: int) -> int:
    return db.scalar(
        select(func.count()).select_from(LimsSubSample).where(LimsSubSample.box_id == box_id)
    ) or 0


def next_box(db: Session, order_key: str, role: str, user_id: int) -> LimsBox:
    if role not in BOXABLE_ROLES:
        raise ValueError(f"role {role!r} is not boxable")
    current_max = db.scalar(
        select(func.max(LimsBox.box_number)).where(LimsBox.order_key == order_key)
    )
    box = LimsBox(
        order_key=order_key,
        box_number=(current_max or 0) + 1,
        role=role,
        created_by_user_id=user_id,
    )
    db.add(box)
    db.commit()
    db.refresh(box)
    return box


def assign_vials(db: Session, box_id: int, sub_sample_ids: List[str]) -> LimsBox:
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    subs = db.scalars(
        select(LimsSubSample).where(LimsSubSample.sample_id.in_(sub_sample_ids))
    ).all()
    found = {s.sample_id for s in subs}
    missing = set(sub_sample_ids) - found
    if missing:
        raise LookupError(f"sub-samples not found: {sorted(missing)}")
    for s in subs:
        if s.assignment_role != box.role:
            raise ValueError(
                f"vial {s.sample_id} role {s.assignment_role!r} != box role {box.role!r}"
            )
    for s in subs:
        s.box_id = box.id
    db.commit()
    db.refresh(box)
    return box


def unassign_vials(db: Session, sub_sample_ids: List[str]) -> int:
    """Clear box membership (box_id = None) for the given sub-samples. Mirrors
    how `assign_vials` selects rows. Idempotent: unassigning an already-unboxed
    vial is a no-op. Returns the number of rows that were updated."""
    subs = db.scalars(
        select(LimsSubSample).where(LimsSubSample.sample_id.in_(sub_sample_ids))
    ).all()
    for s in subs:
        s.box_id = None
    db.commit()
    return len(subs)


def mark_printed(db: Session, box_id: int, user_id: int) -> LimsBox:
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    box.printed_at = datetime.utcnow()
    box.printed_by_user_id = user_id
    db.commit()
    db.refresh(box)
    return box


def delete_box(db: Session, box_id: int) -> None:
    """Delete a box, returning any still-assigned vials to Unboxed (box_id=None).
    Non-destructive: clearing box_id mirrors unassign_vials (the FK is ON DELETE
    SET NULL anyway). Raises LookupError if the box is missing."""
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    db.execute(
        update(LimsSubSample).where(LimsSubSample.box_id == box_id).values(box_id=None)
    )
    db.delete(box)
    db.commit()


def close_box(db: Session, box_id: int, user_id: int) -> LimsBox:
    """Close out a box: return all its vials to Unboxed and stamp stored_at.

    The normal end-of-life path — unlike delete_box (the mistake path) it keeps
    the box row as a record. Idempotent: closing an already-stored box is a
    no-op (first closer's stamp wins). Raises LookupError if the box is missing.
    """
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    if box.stored_at is None:
        db.execute(
            update(LimsSubSample).where(LimsSubSample.box_id == box_id).values(box_id=None)
        )
        box.stored_at = datetime.utcnow()
        box.stored_by_user_id = user_id
        db.commit()
    db.refresh(box)
    return box


def list_active(db: Session) -> List[LimsBox]:
    """All boxes not yet closed out to storage, oldest first (Active Boxes page)."""
    return list(
        db.scalars(
            select(LimsBox).where(LimsBox.stored_at.is_(None)).order_by(LimsBox.created_at, LimsBox.id)
        )
    )


def list_for_order(db: Session, order_key: str) -> List[LimsBox]:
    return list(
        db.scalars(
            select(LimsBox)
            .where(LimsBox.order_key == order_key, LimsBox.stored_at.is_(None))
            .order_by(LimsBox.box_number)
        ).all()
    )
