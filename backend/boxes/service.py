from datetime import datetime
from typing import List

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from models import LimsBox, LimsSubSample

BOXABLE_ROLES = {"hplc", "endo", "ster"}


class BoxNotEmptyError(Exception):
    """Raised when deleting a box that still has assigned vials; unassign first."""


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
    """Delete an empty box. Raises LookupError if missing, BoxNotEmptyError if it
    still holds >= 1 assigned vial (unassign those first)."""
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    count = vial_count(db, box_id)
    if count > 0:
        raise BoxNotEmptyError(
            f"box {box_id} still has {count} assigned vial(s); unassign first"
        )
    db.delete(box)
    db.commit()


def list_for_order(db: Session, order_key: str) -> List[LimsBox]:
    return list(
        db.scalars(
            select(LimsBox).where(LimsBox.order_key == order_key).order_by(LimsBox.box_number)
        ).all()
    )
