"""Flag-based read access to the item a flag is about, and snapshot labels (spec 2026-10-12 §3.2, §3.3).

Anyone on a flag (creator, assignee or participant), open or resolved, may read that one item.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from flags.models import FlagEvent, FlagFlag, FlagParticipant


def flag_for_user(db: Session, user_id: Optional[int], entity_type: str, entity_id: str) -> Optional[int]:
    if user_id is None:
        return None
    q = (select(FlagFlag.id)
         .outerjoin(FlagParticipant, and_(FlagParticipant.flag_id == FlagFlag.id,
                                          FlagParticipant.user_id == user_id))
         .where(FlagFlag.entity_type == entity_type, FlagFlag.entity_id == entity_id,
                or_(FlagFlag.created_by == user_id, FlagFlag.assignee_id == user_id,
                    FlagParticipant.id.is_not(None)))
         .order_by(FlagFlag.id.desc()).limit(1))
    return db.execute(q).scalar()


def on_flag_for(db: Session, user_id: Optional[int], entity_type: str, entity_id: str) -> bool:
    return flag_for_user(db, user_id, entity_type, entity_id) is not None


def snapshot_label(db: Optional[Session], entity_type: str, entity_id: str, fallback: str) -> str:
    if db is None:
        return fallback
    q = (select(FlagEvent.details).join(FlagFlag, FlagFlag.id == FlagEvent.flag_id)
         .where(FlagFlag.entity_type == entity_type, FlagFlag.entity_id == entity_id,
                FlagEvent.event_type == "raised")
         .order_by(FlagEvent.id.desc()).limit(1))
    details = db.execute(q).scalar()
    snap = details.get("entity_snapshot") if isinstance(details, dict) else None
    label = snap.get("label") if isinstance(snap, dict) else None
    return label or fallback
