"""Service layer for flags. All DB writes go through here; every state-changing
call writes a flag_events audit row AND emits to the event sink in the same
transaction boundary."""
from __future__ import annotations

import base64
import re
from datetime import datetime
from typing import Optional

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from flags import catalog, permissions, seams, types_service
from flags.errors import BadRequestError, NotFoundError, PermissionDeniedError
from flags.models import (
    FlagAttachment, FlagComment, FlagCommentReaction, FlagEntityLink, FlagEvent,
    FlagFlag, FlagLink, FlagParticipant, FlagRead,
)

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
_ATTACHMENT_TOKEN = re.compile(r"\{attachment:(\d+)\}")

_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_INLINE = re.compile(r"[*_`~]+")
_MD_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.MULTILINE)


def strip_markdown(text: str) -> str:
    """Flatten markdown-lite source to plain text for the Slack excerpt.
    Keeps @mentions literal; drops attachment tokens and formatting marks."""
    t = _MD_LINK.sub(r"\1", text or "")           # [label](url) -> label
    t = _ATTACHMENT_TOKEN.sub("", t)              # drop {attachment:ID}
    t = _MD_BULLET.sub("", t)                     # list markers
    t = _MD_INLINE.sub("", t)                     # ** * _ ` ~
    return " ".join(t.split())                    # collapse whitespace/newlines


def _excerpt_for_comment(body: str) -> str:
    return (strip_markdown(body) or "📎 image")[:140]


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
                assignee_id=None, first_comment=None, due_at=None) -> FlagFlag:
    # A NULL anchor = a general task (spec §5). entity_id without an entity_type
    # is malformed; a present entity_type must be registered.
    if entity_type is None:
        if entity_id is not None:
            raise BadRequestError("entity_id requires entity_type")
    else:
        if not seams.is_registered(entity_type):
            raise BadRequestError(f"unknown entity_type {entity_type!r}")
    if not types_service.is_valid_type(db, type):
        raise BadRequestError(f"unknown flag type {type!r}")
    if not permissions.can(user, "create", None):
        raise PermissionDeniedError("not allowed to create flags")
    if entity_type is not None:
        spec = seams.get_entity_spec(entity_type)
        if not spec.can_flag(user, str(entity_id)):
            raise PermissionDeniedError(f"not allowed to flag {entity_type} {entity_id}")
    # Enforces "general task ⇒ global type": is_allowed_for_entity returns True
    # for entity_type=None only when the type's entity_types list is empty.
    if not types_service.is_allowed_for_entity(db, type, entity_type):
        raise BadRequestError(
            f"flag type {type!r} is not allowed for {entity_type or 'general tasks'}")

    actor_id = getattr(user, "id", None)
    flag = FlagFlag(entity_type=entity_type,
                    entity_id=str(entity_id) if entity_id is not None else None,
                    kind=types_service.kind_for_type(db, type), type=type, status="open",
                    title=title, created_by=actor_id, assignee_id=assignee_id,
                    due_at=due_at)
    db.add(flag)
    db.flush()  # populate flag.id

    _audit(db, flag, actor_id, "raised", to_value="open", details={"type": type})
    if due_at is not None:
        _audit(db, flag, actor_id, "due_set", to_value=due_at.isoformat())
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


def compute_relevance(db: Session, events: list[FlagEvent], *,
                      user_id: int) -> dict[int, list[str]]:
    """Why each event is in this user's feed, keyed by event id. Markers are a
    subset of actor/assigned/raised/watching/mentioned. Batch queries — no N+1."""
    flag_ids = {e.flag_id for e in events}
    flags = {f.id: f for f in db.execute(
        select(FlagFlag).where(FlagFlag.id.in_(flag_ids))).scalars()}
    watching = {fid for (fid,) in db.execute(
        select(FlagParticipant.flag_id).where(
            FlagParticipant.user_id == user_id,
            FlagParticipant.flag_id.in_(flag_ids),
            FlagParticipant.role == "watcher"))}
    out: dict[int, list[str]] = {}
    for e in events:
        rel: list[str] = []
        f = flags.get(e.flag_id)
        if e.actor_id == user_id:
            rel.append("actor")
        if f is not None and f.assignee_id == user_id:
            rel.append("assigned")
        if f is not None and f.created_by == user_id:
            rel.append("raised")
        if e.flag_id in watching:
            rel.append("watching")
        if user_id in ((e.details or {}).get("mentions") or []):
            rel.append("mentioned")
        out[e.id] = rel
    return out


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
    db.flush()  # populate c.id for attachment linkage
    _link_attachments(db, flag.id, c.id, c.body)
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
    # markdown-stripped to plain text (image-only comments -> "📎 image").
    details = {"body_excerpt": _excerpt_for_comment(body)}
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


# --- image attachments (Plan 3) -----------------------------------------
def _sniff_image(data: bytes) -> str:
    """Return the image content-type from magic bytes; raise on non-image.
    Do NOT trust the client's Content-Type header (spec §11)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise BadRequestError("attachment must be a PNG, JPEG, GIF, or WEBP image")


_EXT_FOR_CT = {"image/png": ".png", "image/jpeg": ".jpg",
               "image/gif": ".gif", "image/webp": ".webp"}


def add_attachment(db: Session, *, user, flag_id, data: bytes, filename: str) -> FlagAttachment:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "comment", flag):
        raise PermissionDeniedError("not allowed to attach")
    if not data:
        raise BadRequestError("empty upload")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise BadRequestError("attachment exceeds 10 MB")
    content_type = _sniff_image(data)
    actor_id = getattr(user, "id", None)
    key = seams.get_attachment_storage().save(str(flag.id), data, f"upload{_EXT_FOR_CT[content_type]}")
    att = FlagAttachment(flag_id=flag.id, comment_id=None, uploaded_by=actor_id,
                         filename=(filename or f"upload{_EXT_FOR_CT[content_type]}")[:255],
                         content_type=content_type, size_bytes=len(data), storage_key=key)
    db.add(att)
    db.flush()  # populate att.id for the event detail
    # attachment_added is analytics+audit (real actor_id). It does NOT bump
    # updated_at — the comment that references it is the unread trigger.
    _audit(db, flag, actor_id, "attachment_added",
           details={"attachment_id": att.id, "body_excerpt": "📎 image"})
    _commit_and_emit(db)
    db.refresh(att)
    return att


def get_attachment(db: Session, attachment_id: int) -> FlagAttachment:
    att = db.get(FlagAttachment, attachment_id)
    if att is None:
        raise NotFoundError(f"attachment {attachment_id} not found")
    return att


# --- comment emoji reactions (Plan 3) -----------------------------------
CURATED_EMOJI = ("👍", "✅", "👀", "🎉", "❤️", "😂", "🤔", "🚨")


def _load_comment(db: Session, comment_id: int) -> FlagComment:
    c = db.get(FlagComment, comment_id)
    if c is None:
        raise NotFoundError(f"comment {comment_id} not found")
    return c


def aggregate_reactions(db: Session, comment_ids) -> dict[int, list[dict]]:
    """Batch: comment_id -> [{emoji, count, user_ids}]. One query, no N+1."""
    ids = list(comment_ids)
    if not ids:
        return {}
    rows = db.execute(select(FlagCommentReaction).where(
        FlagCommentReaction.comment_id.in_(ids))
        .order_by(FlagCommentReaction.id.asc())).scalars().all()
    by_comment: dict[int, dict[str, list[int]]] = {}
    for r in rows:
        by_comment.setdefault(r.comment_id, {}).setdefault(r.emoji, []).append(r.user_id)
    return {cid: [{"emoji": e, "count": len(us), "user_ids": us}
                  for e, us in emo.items()]
            for cid, emo in by_comment.items()}


def _emit_reaction(db: Session, comment: FlagComment, actor_id, emoji: str, action: str) -> None:
    """Fan a reaction onto the SSE bus WITHOUT an audit row or updated_at bump —
    reactions must not mark a thread unread (spec §6). event_id stays None (no
    flag_events row backs it)."""
    flag = db.get(FlagFlag, comment.flag_id)
    seams.EVENT_SINK.emit({
        "event_type": "comment_reaction", "flag_id": comment.flag_id,
        "comment_id": comment.id, "emoji": emoji, "action": action,
        "actor_id": actor_id, "from_value": None, "to_value": None,
        "details": {}, "event_id": None, "flag": _flag_summary(flag),
    })


def add_reaction(db: Session, *, user, comment_id, emoji) -> list[dict]:
    if emoji not in CURATED_EMOJI:
        raise BadRequestError(f"unsupported emoji {emoji!r}")
    comment = _load_comment(db, comment_id)
    if not permissions.can(user, "comment", get_flag(db, comment.flag_id)):
        raise PermissionDeniedError("not allowed to react")
    uid = getattr(user, "id", None)
    existing = db.execute(select(FlagCommentReaction).where(
        FlagCommentReaction.comment_id == comment_id,
        FlagCommentReaction.user_id == uid,
        FlagCommentReaction.emoji == emoji)).scalar_one_or_none()
    if existing is None:
        db.add(FlagCommentReaction(comment_id=comment_id, user_id=uid, emoji=emoji))
        db.commit()
        _emit_reaction(db, comment, uid, emoji, "added")
    return aggregate_reactions(db, [comment_id]).get(comment_id, [])


def remove_reaction(db: Session, *, user, comment_id, emoji) -> list[dict]:
    comment = _load_comment(db, comment_id)
    uid = getattr(user, "id", None)
    row = db.execute(select(FlagCommentReaction).where(
        FlagCommentReaction.comment_id == comment_id,
        FlagCommentReaction.user_id == uid,
        FlagCommentReaction.emoji == emoji)).scalar_one_or_none()
    if row is not None:
        db.delete(row)
        db.commit()
        _emit_reaction(db, comment, uid, emoji, "removed")
    return aggregate_reactions(db, [comment_id]).get(comment_id, [])


def _link_attachments(db: Session, flag_id: int, comment_id: int, body: str) -> None:
    """FK the {attachment:ID} tokens in a saved comment's body back to it, so
    they survive orphan GC. Only unlinked rows on THIS flag are claimed."""
    ids = {int(m) for m in _ATTACHMENT_TOKEN.findall(body or "")}
    if not ids:
        return
    for att in db.execute(select(FlagAttachment).where(
            FlagAttachment.flag_id == flag_id,
            FlagAttachment.id.in_(ids),
            FlagAttachment.comment_id.is_(None))).scalars():
        att.comment_id = comment_id


# --- entity reference links (Phase 2 slice 2) ---------------------------
def add_entity_link(db: Session, *, user, flag_id: int, entity_type: str,
                    entity_id: str) -> FlagEntityLink:
    """Attach a navigational 'related item' to a flag. NOT a rollup anchor."""
    flag = get_flag(db, flag_id)
    if not seams.is_registered(entity_type):
        raise BadRequestError(f"unknown entity_type {entity_type!r}")
    dup = db.execute(select(FlagEntityLink).where(
        FlagEntityLink.flag_id == flag_id,
        FlagEntityLink.entity_type == entity_type,
        FlagEntityLink.entity_id == str(entity_id))).scalar_one_or_none()
    if dup is not None:
        raise BadRequestError("already linked")
    link = FlagEntityLink(flag_id=flag_id, entity_type=entity_type,
                          entity_id=str(entity_id),
                          added_by=getattr(user, "id", None))
    db.add(link)
    _audit(db, flag, getattr(user, "id", None), "entity_link_added",
           to_value=f"{entity_type}:{entity_id}")
    _commit_and_emit(db)
    db.refresh(link)
    return link


def remove_entity_link(db: Session, *, user, flag_id: int, link_id: int) -> None:
    flag = get_flag(db, flag_id)
    link = db.get(FlagEntityLink, link_id)
    if link is None or link.flag_id != flag_id:
        raise NotFoundError(f"link {link_id} not found on flag {flag_id}")
    db.delete(link)
    _audit(db, flag, getattr(user, "id", None), "entity_link_removed",
           from_value=f"{link.entity_type}:{link.entity_id}")
    _commit_and_emit(db)


def list_entity_links(db: Session, flag_id: int) -> list[FlagEntityLink]:
    return list(db.execute(select(FlagEntityLink)
        .where(FlagEntityLink.flag_id == flag_id)
        .order_by(FlagEntityLink.created_at.asc())).scalars().all())


# --- flag <-> flag links (Phase 2 slice 2) ------------------------------
def add_flag_link(db: Session, *, user, flag_id: int, other_id: int) -> FlagLink:
    """Link two flags 'related'. Stored normalized (lo/hi) so a pair is one row;
    events land on BOTH flags. Symmetric — the link shows in both threads."""
    if flag_id == other_id:
        raise BadRequestError("cannot link a flag to itself")
    flag = get_flag(db, flag_id)
    other = get_flag(db, other_id)
    lo, hi = sorted((flag_id, other_id))
    dup = db.execute(select(FlagLink).where(
        FlagLink.flag_id == lo, FlagLink.linked_flag_id == hi)).scalar_one_or_none()
    if dup is not None:
        raise BadRequestError("already linked")
    link = FlagLink(flag_id=lo, linked_flag_id=hi, added_by=getattr(user, "id", None))
    db.add(link)
    actor = getattr(user, "id", None)
    _audit(db, flag, actor, "flag_link_added", to_value=str(other_id))
    _audit(db, other, actor, "flag_link_added", to_value=str(flag_id))
    _commit_and_emit(db)
    db.refresh(link)
    return link


def remove_flag_link(db: Session, *, user, flag_id: int, link_id: int) -> None:
    flag = get_flag(db, flag_id)
    link = db.get(FlagLink, link_id)
    if link is None or flag_id not in (link.flag_id, link.linked_flag_id):
        raise NotFoundError(f"link {link_id} not found on flag {flag_id}")
    other_id = link.linked_flag_id if link.flag_id == flag_id else link.flag_id
    other = get_flag(db, other_id)
    db.delete(link)
    actor = getattr(user, "id", None)
    _audit(db, flag, actor, "flag_link_removed", from_value=str(other_id))
    _audit(db, other, actor, "flag_link_removed", from_value=str(flag_id))
    _commit_and_emit(db)


def list_flag_links(db: Session, flag_id: int) -> list[FlagLink]:
    return list(db.execute(select(FlagLink).where(
        or_(FlagLink.flag_id == flag_id, FlagLink.linked_flag_id == flag_id))
        .order_by(FlagLink.created_at.asc())).scalars().all())


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


def set_due(db: Session, *, user, flag_id: int,
            due_at: Optional[datetime]) -> FlagFlag:
    """Set/change/clear a flag's due date; no-op if unchanged. Same permission
    tier as status changes (assignee/creator/admin) per spec §5."""
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "change_status", flag):
        raise PermissionDeniedError("not allowed to edit this flag")
    if flag.due_at == due_at:
        return flag
    old = flag.due_at
    flag.due_at = due_at
    flag.updated_at = datetime.utcnow()
    event = ("due_set" if old is None else
             "due_cleared" if due_at is None else "due_changed")
    _audit(db, flag, getattr(user, "id", None), event,
           from_value=old.isoformat() if old else None,
           to_value=due_at.isoformat() if due_at else None)
    _commit_and_emit(db)
    db.refresh(flag)
    return flag
