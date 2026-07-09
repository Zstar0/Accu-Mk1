"""Service layer for flags. All DB writes go through here; every state-changing
call writes a flag_events audit row AND emits to the event sink in the same
transaction boundary."""
from __future__ import annotations

import base64
from datetime import datetime
from typing import Optional

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from flags import catalog, permissions, seams, types_service
from flags.errors import BadRequestError, NotFoundError, PermissionDeniedError
from flags.models import FlagComment, FlagEvent, FlagFlag, FlagParticipant, FlagRead


def _flag_summary(flag) -> dict:
    return {
        "id": flag.id, "title": flag.title, "type": flag.type, "kind": flag.kind,
        "status": flag.status, "entity_type": flag.entity_type, "entity_id": flag.entity_id,
        "assignee_id": flag.assignee_id, "created_by": flag.created_by,
    }


def _audit(db, flag, actor_id, event_type, *, from_value=None, to_value=None, details=None):
    """Write the audit row now; STAGE the sink event to fire after commit.

    Accepts a FlagFlag object (preferred — enables the summary) so the emitted
    event can carry a post-mutation snapshot. Pass the object, not the id.
    """
    row = FlagEvent(flag_id=flag.id, actor_id=actor_id, event_type=event_type,
                    from_value=from_value, to_value=to_value, details=details)
    db.add(row)
    pending = db.info.setdefault("flag_pending_events", [])
    pending.append((row, {
        "event_type": event_type, "flag_id": flag.id, "actor_id": actor_id,
        "from_value": from_value, "to_value": to_value, "details": details or {},
        "event_id": None,                 # filled in post-commit from row.id
        "flag": _flag_summary(flag),
    }))


def _commit_and_emit(db):
    """Flush to populate row ids, commit, then emit staged events in order.

    event_id is read after flush (ids populated) but before commit (rows not yet
    expired) so the post-commit emit needs no per-event reload. Emit is strictly
    post-commit: a rollback never reaches the sink.
    """
    pending = db.info.pop("flag_pending_events", [])
    db.flush()                       # populate FlagEvent.id on every staged row
    for row, event in pending:
        event["event_id"] = row.id
    db.commit()
    for _row, event in pending:
        seams.EVENT_SINK.emit(event)


def create_flag(db: Session, *, user, entity_type, entity_id, type, title,
                assignee_id=None, first_comment=None) -> FlagFlag:
    if not seams.is_registered(entity_type):
        raise BadRequestError(f"unknown entity_type {entity_type!r}")
    if not types_service.is_valid_type(db, type):
        raise BadRequestError(f"unknown flag type {type!r}")
    if not permissions.can(user, "create", None):
        raise PermissionDeniedError("not allowed to create flags")
    spec = seams.get_entity_spec(entity_type)
    if not spec.can_flag(user, str(entity_id)):
        raise PermissionDeniedError(f"not allowed to flag {entity_type} {entity_id}")
    if not types_service.is_allowed_for_entity(db, type, entity_type):
        raise BadRequestError(f"flag type {type!r} is not allowed for {entity_type}")

    actor_id = getattr(user, "id", None)
    flag = FlagFlag(entity_type=entity_type, entity_id=str(entity_id),
                    kind=types_service.kind_for_type(db, type), type=type, status="open",
                    title=title, created_by=actor_id, assignee_id=assignee_id)
    db.add(flag)
    db.flush()  # populate flag.id

    _audit(db, flag, actor_id, "raised", to_value="open", details={"type": type})
    if assignee_id is not None:
        db.add(FlagParticipant(flag_id=flag.id, user_id=assignee_id, role="watcher", added_by=actor_id))
        _audit(db, flag, actor_id, "assigned", to_value=str(assignee_id))
    if first_comment:
        db.add(FlagComment(flag_id=flag.id, author_id=actor_id, body=first_comment))
        _audit(db, flag, actor_id, "commented")
    _commit_and_emit(db)
    db.refresh(flag)
    return flag


def get_flag(db: Session, flag_id: int) -> FlagFlag:
    flag = db.get(FlagFlag, flag_id)
    if flag is None:
        raise NotFoundError(f"flag {flag_id} not found")
    return flag


def _valid_user_ids(db: Session, ids) -> list[int]:
    """Existing user ids only, order-preserving + deduped."""
    from models import User
    if not ids:
        return []
    uniq = list(dict.fromkeys(int(i) for i in ids))
    present = set(db.execute(select(User.id).where(User.id.in_(uniq))).scalars().all())
    return [i for i in uniq if i in present]


def _relevant_flag_ids(user_id: int):
    """Flags the user is the assignee/creator/participant of (a Select of ids)."""
    return select(FlagFlag.id).where(or_(
        FlagFlag.assignee_id == user_id,
        FlagFlag.created_by == user_id,
        FlagFlag.id.in_(select(FlagParticipant.flag_id)
                        .where(FlagParticipant.user_id == user_id)),
    ))


def list_flags(db: Session, *, user_id: int, tab: str, status: Optional[str] = None,
               entity_type: Optional[str] = None, entity_id: Optional[str] = None,
               include_descendants: bool = False) -> list[FlagFlag]:
    stmt = select(FlagFlag).order_by(FlagFlag.updated_at.desc())
    open_states = catalog.OPEN_STATES
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
        # The matched set is the entity itself plus — when rolling up — its
        # registry-resolved descendants (a sample's vials). The hierarchy lives
        # entirely behind `resolve_descendants`; this stays entity-agnostic.
        pairs = [(entity_type, str(entity_id))]
        if include_descendants:
            pairs.extend(seams.resolve_descendants(db, entity_type, str(entity_id)))
        stmt = stmt.where(or_(*[
            and_(FlagFlag.entity_type == et, FlagFlag.entity_id == eid)
            for et, eid in pairs
        ]))
    return list(db.execute(stmt).scalars().all())


def _encode_cursor(ev: FlagEvent) -> str:
    raw = f"{ev.created_at.isoformat()}|{ev.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        ts_str, id_str = raw.rsplit("|", 1)
        return datetime.fromisoformat(ts_str), int(id_str)
    except Exception:
        raise BadRequestError("bad activity cursor")


def list_activity(db: Session, *, user_id: int, cursor: Optional[str] = None,
                  limit: int = 25) -> tuple[list[FlagEvent], Optional[str]]:
    """Newest-first feed of flag events relevant to `user_id`: events on flags
    they're the assignee/creator/watcher of, unioned with their own actions.
    Keyset paginated on (created_at, id); returns (rows, next_cursor)."""
    limit = max(1, min(limit, 50))
    stmt = select(FlagEvent).where(or_(
        FlagEvent.actor_id == user_id,
        FlagEvent.flag_id.in_(_relevant_flag_ids(user_id)),
    ))
    if cursor:
        c_ts, c_id = _decode_cursor(cursor)
        stmt = stmt.where(or_(
            FlagEvent.created_at < c_ts,
            and_(FlagEvent.created_at == c_ts, FlagEvent.id < c_id),
        ))
    stmt = stmt.order_by(FlagEvent.created_at.desc(), FlagEvent.id.desc()).limit(limit + 1)
    rows = list(db.execute(stmt).scalars().all())
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = _encode_cursor(rows[-1])
    return rows, next_cursor


def list_unread(db: Session, *, user_id: int) -> list[FlagFlag]:
    """Flags relevant to the user that changed since they last read them
    (never-read counts as unread), newest-updated first."""
    stmt = (select(FlagFlag)
            .outerjoin(FlagRead, and_(FlagRead.flag_id == FlagFlag.id,
                                      FlagRead.user_id == user_id))
            .where(FlagFlag.id.in_(_relevant_flag_ids(user_id)))
            .where(or_(FlagRead.last_read_at.is_(None),
                       FlagFlag.updated_at > FlagRead.last_read_at))
            .order_by(FlagFlag.updated_at.desc()))
    return list(db.execute(stmt).scalars().all())


def mark_read(db: Session, *, user_id: int, flag_id: int) -> None:
    get_flag(db, flag_id)  # 404 if the flag doesn't exist
    row = db.execute(select(FlagRead).where(
        FlagRead.user_id == user_id, FlagRead.flag_id == flag_id)).scalar_one_or_none()
    if row is None:
        db.add(FlagRead(user_id=user_id, flag_id=flag_id, last_read_at=datetime.utcnow()))
    else:
        row.last_read_at = datetime.utcnow()
    db.commit()


def summary(db: Session, *, user_id: int) -> dict:
    # Header-button counts are personal: both the total and the per-type
    # breakdown are scoped to flags assigned to ME (open only). by_type drives
    # the colored chips on FlagsHeaderButton, so it must not leak other users'
    # or unassigned flags into my badge.
    open_states = catalog.OPEN_STATES
    assigned = db.execute(
        select(FlagFlag).where(FlagFlag.assignee_id == user_id, FlagFlag.status.in_(open_states))
    ).scalars().all()
    by_type: dict[str, int] = {}
    for f in assigned:
        by_type[f.type] = by_type.get(f.type, 0) + 1
    return {"assigned_to_me": len(assigned), "by_type": by_type}


def add_comment(db: Session, *, user, flag_id, body, mention_ids=None) -> FlagComment:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "comment", flag):
        raise PermissionDeniedError("not allowed to comment")
    if not body or not body.strip():
        raise BadRequestError("comment body required")
    actor_id = getattr(user, "id", None)
    valid = _valid_user_ids(db, mention_ids or [])
    c = FlagComment(flag_id=flag.id, author_id=actor_id, body=body.strip(),
                    mentions=valid or None)
    db.add(c)
    # A mention loops the user in: add as a watcher (silent — no watcher_added
    # event; dedup against existing participants).
    for uid in valid:
        exists = db.execute(select(FlagParticipant).where(
            FlagParticipant.flag_id == flag.id,
            FlagParticipant.user_id == uid)).scalar_one_or_none()
        if exists is None:
            db.add(FlagParticipant(flag_id=flag.id, user_id=uid,
                                   role="watcher", added_by=actor_id))
    flag.updated_at = datetime.utcnow()
    # body_excerpt rides the event for notification transports (Slack DMs);
    # additive detail key — consumers ignore unknown keys.
    details = {"body_excerpt": body.strip()[:140]}
    if valid:
        details["mentions"] = valid
    _audit(db, flag, actor_id, "commented", details=details)
    _commit_and_emit(db)
    db.refresh(c)
    return c


def assign(db: Session, *, user, flag_id, assignee_id) -> FlagFlag:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "assign", flag):
        raise PermissionDeniedError("not allowed to assign")
    actor_id = getattr(user, "id", None)
    prev = flag.assignee_id
    flag.assignee_id = assignee_id
    flag.updated_at = datetime.utcnow()
    if assignee_id is not None:
        exists = db.execute(
            select(FlagParticipant).where(FlagParticipant.flag_id == flag.id,
                                          FlagParticipant.user_id == assignee_id)
        ).scalar_one_or_none()
        if exists is None:
            db.add(FlagParticipant(flag_id=flag.id, user_id=assignee_id, role="watcher", added_by=actor_id))
    _audit(db, flag, actor_id, "assigned" if assignee_id is not None else "unassigned",
           from_value=str(prev) if prev is not None else None,
           to_value=str(assignee_id) if assignee_id is not None else None)
    _commit_and_emit(db)
    db.refresh(flag)
    return flag


def add_watcher(db: Session, *, user, flag_id, user_id) -> FlagParticipant:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "watch", flag):
        raise PermissionDeniedError("not allowed to watch")
    existing = db.execute(
        select(FlagParticipant).where(FlagParticipant.flag_id == flag.id,
                                      FlagParticipant.user_id == user_id)
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    p = FlagParticipant(flag_id=flag.id, user_id=user_id, role="watcher",
                        added_by=getattr(user, "id", None))
    db.add(p)
    _audit(db, flag, getattr(user, "id", None), "watcher_added", to_value=str(user_id))
    _commit_and_emit(db)
    db.refresh(p)
    return p


def remove_watcher(db: Session, *, user, flag_id, user_id) -> None:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "watch", flag):
        raise PermissionDeniedError("not allowed")
    row = db.execute(
        select(FlagParticipant).where(FlagParticipant.flag_id == flag.id,
                                      FlagParticipant.user_id == user_id)
    ).scalar_one_or_none()
    if row is not None:
        db.delete(row)
        _audit(db, flag, getattr(user, "id", None), "watcher_removed", from_value=str(user_id))
        _commit_and_emit(db)


def list_watchers(db: Session, flag_id: int) -> list[FlagParticipant]:
    """Watcher participants for a flag, oldest first. 404s on a missing flag."""
    get_flag(db, flag_id)
    return list(db.execute(
        select(FlagParticipant)
        .where(FlagParticipant.flag_id == flag_id,
               FlagParticipant.role == "watcher")
        .order_by(FlagParticipant.added_at.asc(), FlagParticipant.id.asc())
    ).scalars().all())


def change_status(db: Session, *, user, flag_id, to_status) -> FlagFlag:
    from flags.errors import ConflictError
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "change_status", flag):
        raise PermissionDeniedError("not allowed to change status")
    if not catalog.is_legal_transition(flag.status, to_status):
        raise ConflictError(f"illegal transition {flag.status} -> {to_status}")
    actor_id = getattr(user, "id", None)
    from_status = flag.status
    flag.status = to_status
    flag.updated_at = datetime.utcnow()
    if to_status == "resolved":
        flag.resolved_at = datetime.utcnow()
        flag.resolved_by = actor_id
    elif to_status in catalog.OPEN_STATES:
        flag.resolved_at = None
        flag.resolved_by = None
    _audit(db, flag, actor_id, "status_changed", from_value=from_status, to_value=to_status)
    _commit_and_emit(db)
    db.refresh(flag)
    return flag
