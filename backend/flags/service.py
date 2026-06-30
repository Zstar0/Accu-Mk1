"""Service layer for flags. All DB writes go through here; every state-changing
call writes a flag_events audit row AND emits to the event sink in the same
transaction boundary."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from flags import catalog, permissions, seams
from flags.errors import BadRequestError, NotFoundError, PermissionDeniedError
from flags.models import FlagComment, FlagEvent, FlagFlag, FlagParticipant


def _audit(db, flag_id, actor_id, event_type, *, from_value=None, to_value=None, details=None):
    """Write the audit row AND publish to the event sink. Caller commits."""
    db.add(FlagEvent(flag_id=flag_id, actor_id=actor_id, event_type=event_type,
                     from_value=from_value, to_value=to_value, details=details))
    seams.EVENT_SINK.emit({
        "event_type": event_type, "flag_id": flag_id, "actor_id": actor_id,
        "from_value": from_value, "to_value": to_value, "details": details or {},
    })


def create_flag(db: Session, *, user, entity_type, entity_id, type, title,
                assignee_id=None, first_comment=None) -> FlagFlag:
    if not seams.is_registered(entity_type):
        raise BadRequestError(f"unknown entity_type {entity_type!r}")
    if not catalog.is_valid_type(type):
        raise BadRequestError(f"unknown flag type {type!r}")
    if not permissions.can(user, "create", None):
        raise PermissionDeniedError("not allowed to create flags")
    spec = seams.get_entity_spec(entity_type)
    if not spec.can_flag(user, str(entity_id)):
        raise PermissionDeniedError(f"not allowed to flag {entity_type} {entity_id}")

    actor_id = getattr(user, "id", None)
    flag = FlagFlag(entity_type=entity_type, entity_id=str(entity_id),
                    kind=catalog.kind_for_type(type), type=type, status="open",
                    title=title, created_by=actor_id, assignee_id=assignee_id)
    db.add(flag)
    db.flush()  # populate flag.id

    _audit(db, flag.id, actor_id, "raised", to_value="open", details={"type": type})
    if assignee_id is not None:
        db.add(FlagParticipant(flag_id=flag.id, user_id=assignee_id, role="watcher", added_by=actor_id))
        _audit(db, flag.id, actor_id, "assigned", to_value=str(assignee_id))
    if first_comment:
        db.add(FlagComment(flag_id=flag.id, author_id=actor_id, body=first_comment))
        _audit(db, flag.id, actor_id, "commented")
    db.commit()
    db.refresh(flag)
    return flag


def get_flag(db: Session, flag_id: int) -> FlagFlag:
    flag = db.get(FlagFlag, flag_id)
    if flag is None:
        raise NotFoundError(f"flag {flag_id} not found")
    return flag


def list_flags(db: Session, *, user_id: int, tab: str, status: Optional[str] = None,
               entity_type: Optional[str] = None, entity_id: Optional[str] = None) -> list[FlagFlag]:
    stmt = select(FlagFlag).order_by(FlagFlag.updated_at.desc())
    open_states = ("open", "in_progress")
    if tab == "assigned":
        stmt = stmt.where(FlagFlag.assignee_id == user_id, FlagFlag.status.in_(open_states))
    elif tab == "raised":
        stmt = stmt.where(FlagFlag.created_by == user_id)
    elif tab == "watching":
        sub = select(FlagParticipant.flag_id).where(FlagParticipant.user_id == user_id)
        stmt = stmt.where(FlagFlag.id.in_(sub))
    elif tab == "all_open":
        stmt = stmt.where(FlagFlag.status.in_(open_states))
    else:
        raise BadRequestError(f"unknown tab {tab!r}")
    if status:
        stmt = stmt.where(FlagFlag.status == status)
    if entity_type and entity_id:
        stmt = stmt.where(FlagFlag.entity_type == entity_type,
                          FlagFlag.entity_id == str(entity_id))
    return list(db.execute(stmt).scalars().all())


def summary(db: Session, *, user_id: int) -> dict:
    open_states = ("open", "in_progress")
    assigned = db.execute(
        select(FlagFlag).where(FlagFlag.assignee_id == user_id, FlagFlag.status.in_(open_states))
    ).scalars().all()
    by_type: dict[str, int] = {}
    for f in db.execute(select(FlagFlag).where(FlagFlag.status.in_(open_states))).scalars().all():
        by_type[f.type] = by_type.get(f.type, 0) + 1
    return {"assigned_to_me": len(assigned), "by_type": by_type}
