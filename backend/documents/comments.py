"""Document comments service (spec 2026-10-03 §4, §5, §6). Authorship comes from
the credential, never the body."""
from __future__ import annotations

from dataclasses import dataclass
import logging
import re
from datetime import datetime
from typing import Iterable, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from documents import anchors, labels
from documents.errors import BadRequestError, ForbiddenError, NotFoundError
from documents.models import (Document, DocumentComment, DocumentCommentAttachment,
                              DocumentCommentCounter)


@dataclass(frozen=True)
class Actor:
    """Who is acting: a logged-in user OR a named agent token. Exactly one of
    user_id / agent is set, mirroring the DB CHECK on document_comments."""
    user_id: Optional[int]
    agent: Optional[str]
    display: str
    is_admin: bool


def display_name(user) -> str:
    """'First Last' when the row has them, else the email."""
    first = (getattr(user, "first_name", None) or "").strip()
    last = (getattr(user, "last_name", None) or "").strip()
    return (f"{first} {last}").strip() or getattr(user, "email", "") or "unknown"


def actor_from_user(user) -> Actor:
    return Actor(user_id=user.id, agent=None, display=display_name(user),
                 is_admin=getattr(user, "role", None) == "admin")


def actor_from_agent(name: str) -> Actor:
    return Actor(user_id=None, agent=name, display=name, is_admin=False)


logger = logging.getLogger(__name__)
KINDS = ("comment", "suggestion")
STATUSES = ("open", "resolved")


def _doc(db: Session, document_id: int) -> Document:
    doc = db.get(Document, document_id)
    if doc is None:
        raise NotFoundError(f"document {document_id} not found")
    return doc


def get_comment(db: Session, comment_id: int) -> DocumentComment:
    row = db.get(DocumentComment, comment_id)
    if row is None:
        raise NotFoundError(f"comment {comment_id} not found")
    return row


def _can_edit(actor: Actor, row: DocumentComment) -> bool:
    if actor.is_admin:
        return True
    if actor.user_id is not None:
        return row.author_user_id == actor.user_id
    return actor.agent is not None and row.author_agent == actor.agent


def create_comment(db: Session, *, document_id: int, actor: Actor, kind: str = "comment",
                   body: str = "", anchor=None, label: Optional[str] = None,
                   suggested_text: Optional[str] = None,
                   parent_id: Optional[int] = None) -> DocumentComment:
    doc = _doc(db, document_id)
    if kind not in KINDS:
        raise BadRequestError(f"kind must be one of {KINDS}")
    body = (body or "").strip()
    if kind == "suggestion":
        if not (suggested_text or "").strip():
            raise BadRequestError("a suggestion needs suggested_text")
    elif suggested_text is not None:
        raise BadRequestError("only a suggestion carries suggested_text")
    if label is not None and label not in labels.label_ids():
        raise BadRequestError(f"unknown label {label!r}")
    parent = None
    if parent_id is not None:
        parent = get_comment(db, parent_id)
        if parent.code != doc.code:
            raise BadRequestError("a reply must be on the same document as its parent")
        if parent.parent_id is not None:
            raise BadRequestError("replies cannot have replies")
        anchor = None  # a reply inherits its parent's place in the UI; nothing stored
    else:
        anchor = anchors.validate_anchor(anchor)
        if anchors.is_quote_only(anchor):
            from documents.service import read_content  # local: service imports nothing from here
            html = read_content(doc).decode("utf-8", "replace")
            if not anchors.quote_occurs(anchor["originalText"], html):
                raise BadRequestError(
                    f'quote not found in {doc.code} r{doc.revision}: "{anchor["originalText"]}"')
    if not body and label is None and kind == "comment":
        raise BadRequestError("a comment needs a body or a label")
    number = None
    if parent_id is None:
        counter = db.get(DocumentCommentCounter, doc.code, with_for_update=True)
        if counter is None:
            counter = DocumentCommentCounter(code=doc.code, next_number=1)
            db.add(counter)
            db.flush()
        number = counter.next_number
        counter.next_number += 1
    row = DocumentComment(code=doc.code, document_id=doc.id, parent_id=parent_id, number=number, kind=kind,
                          anchor=anchor, label=label, body=body,
                          suggested_text=(suggested_text.strip() if kind == "suggestion" else None),
                          author_user_id=actor.user_id, author_agent=actor.agent, status="open")
    db.add(row)
    db.flush()
    _link_attachments(db, row.code, row.id, row.body)
    db.commit()
    db.refresh(row)
    return row


def _link_attachments(db: Session, code: str, comment_id: int, body: str) -> None:
    """FK the {attachment:ID} tokens in a saved body back to the comment so
    they survive the orphan sweep. Only unlinked rows on THIS code are claimed."""
    ids = {int(m) for m in _ATTACHMENT_TOKEN.findall(body or "")}
    if not ids:
        return
    for att in db.execute(select(DocumentCommentAttachment).where(
            DocumentCommentAttachment.code == code,
            DocumentCommentAttachment.id.in_(ids),
            DocumentCommentAttachment.comment_id.is_(None))).scalars():
        att.comment_id = comment_id


def patch_comment(db: Session, comment_id: int, actor: Actor, *, body: Optional[str] = None,
                  suggested_text: Optional[str] = None) -> DocumentComment:
    row = get_comment(db, comment_id)
    if not _can_edit(actor, row):
        raise ForbiddenError("only the author or an admin may edit this comment")
    if suggested_text is not None and row.kind != "suggestion":
        raise BadRequestError("only a suggestion carries suggested_text")
    new_body = body.strip() if body is not None else row.body
    new_suggested = row.suggested_text
    if suggested_text is not None:
        new_suggested = suggested_text.strip()
        if not new_suggested:
            raise BadRequestError("a suggestion needs suggested_text")
    if row.kind == "comment" and not new_body and row.label is None:
        raise BadRequestError("a comment needs a body or a label")
    if new_body == row.body and new_suggested == row.suggested_text:
        return row
    row.body = new_body
    row.suggested_text = new_suggested
    row.edited_at = datetime.utcnow()
    _link_attachments(db, row.code, row.id, row.body)
    db.commit()
    db.refresh(row)
    return row


def _subtree_ids(db: Session, root_ids: Iterable[int]) -> list[int]:
    ids = list(root_ids)
    if not ids:
        return []
    replies = db.execute(select(DocumentComment.id).where(
        DocumentComment.parent_id.in_(ids))).scalars().all()
    return ids + list(replies)


def _attachment_keys(db: Session, comment_ids: list[int]) -> list[str]:
    if not comment_ids:
        return []
    return list(db.execute(select(DocumentCommentAttachment.storage_key).where(
        DocumentCommentAttachment.comment_id.in_(comment_ids))).scalars().all())


def _delete_rows(db: Session, comment_ids: list[int]) -> None:
    if not comment_ids:
        return
    db.execute(delete(DocumentCommentAttachment).where(
        DocumentCommentAttachment.comment_id.in_(comment_ids)))
    db.execute(delete(DocumentComment).where(DocumentComment.id.in_(comment_ids)))


def _delete_blobs(keys: list[str]) -> None:
    """Row first, bytes second: a failed blob delete leaves an inert orphan."""
    if not keys:
        return
    from flags import seams as flag_seams  # lazy: flags.seams imports documents.models
    storage = flag_seams.get_attachment_storage()
    for key in keys:
        try:
            storage.delete(key)
        except Exception as e:  # noqa: BLE001
            logger.warning("document comment attachment orphaned key=%s err=%s", key, e)


def delete_comment(db: Session, comment_id: int, actor: Actor) -> None:
    row = get_comment(db, comment_id)
    if not _can_edit(actor, row):
        raise ForbiddenError("only the author or an admin may delete this comment")
    ids = _subtree_ids(db, [row.id])
    keys = _attachment_keys(db, ids)
    _delete_rows(db, ids)
    db.commit()
    _delete_blobs(keys)


def purge_for_document(db: Session, document_id: int) -> list[str]:
    """Called by service.delete_document before the draft row goes: removes the
    draft's comments and their replies, returns blob keys for the caller to
    delete AFTER its own commit."""
    roots = db.execute(select(DocumentComment.id).where(
        DocumentComment.document_id == document_id)).scalars().all()
    ids = _subtree_ids(db, roots)
    keys = _attachment_keys(db, ids)
    _delete_rows(db, ids)
    return keys


def set_status(db: Session, comment_id: int, actor: Actor, status: str) -> DocumentComment:
    if status not in STATUSES:
        raise BadRequestError(f"status must be one of {STATUSES}")
    row = get_comment(db, comment_id)
    if row.parent_id is not None:
        raise BadRequestError("resolve the top-level comment, not a reply")
    if row.status != status:
        row.status = status
        if status == "resolved":
            row.resolved_at = datetime.utcnow()
            row.resolved_by_user_id = actor.user_id
            row.resolved_by_agent = actor.agent
        else:
            row.resolved_at = None
            row.resolved_by_user_id = None
            row.resolved_by_agent = None
        db.commit()
        db.refresh(row)
    return row


def open_comment_counts(db: Session, codes: Iterable[str]) -> dict[str, int]:
    codes = list(set(codes))
    if not codes:
        return {}
    rows = db.execute(select(DocumentComment.code, func.count()).where(
        DocumentComment.code.in_(codes), DocumentComment.status == "open",
        DocumentComment.parent_id.is_(None)).group_by(DocumentComment.code)).all()
    return {code: n for code, n in rows}


def _user_names(db: Session, ids: Iterable[Optional[int]]) -> dict[int, str]:
    from models import User
    wanted = [i for i in set(ids) if i is not None]
    if not wanted:
        return {}
    return {u.id: display_name(u) for u in db.execute(select(User).where(User.id.in_(wanted))).scalars()}


def _who(row_user_id, row_agent, names: dict[int, str]) -> Optional[str]:
    if row_agent:
        return row_agent
    if row_user_id is not None:
        return names.get(row_user_id, f"user {row_user_id}")
    return None


def _out(row: DocumentComment, *, number: Optional[int], revision: int, names: dict[int, str],
         attachments: list[DocumentCommentAttachment], replies: list[dict]) -> dict:
    return {
        "id": row.id, "code": row.code, "document_id": row.document_id, "revision": revision,
        "parent_id": row.parent_id, "number": number, "kind": row.kind, "anchor": row.anchor,
        "label": row.label, "body": row.body, "suggested_text": row.suggested_text,
        "author": _who(row.author_user_id, row.author_agent, names) or "unknown",
        "author_user_id": row.author_user_id, "author_agent": row.author_agent,
        "status": row.status, "resolved_at": row.resolved_at,
        "resolved_by": _who(row.resolved_by_user_id, row.resolved_by_agent, names),
        "created_at": row.created_at, "updated_at": row.updated_at, "edited_at": row.edited_at,
        "attachments": [{"id": a.id, "filename": a.filename, "content_type": a.content_type,
                         "size_bytes": a.size_bytes, "created_at": a.created_at} for a in attachments],
        "replies": replies,
    }


def comment_out(db: Session, row: DocumentComment) -> dict:
    """One comment (any level) in CommentOut shape, numbered within its code."""
    listing = list_comments(db, row.code, status="all")
    for item in listing["items"]:
        if item["id"] == row.id:
            return item
        for reply in item["replies"]:
            if reply["id"] == row.id:
                return reply
    raise NotFoundError(f"comment {row.id} not found")


def list_comments(db: Session, code: str, status: str = "open") -> dict:
    """Every top-level comment for the CODE (spec §4.1 numbering: 1-based position
    by created_at then id across ALL statuses, so a number never changes), then
    filtered, with replies nested and attachments attached."""
    if status not in STATUSES + ("all",):
        raise BadRequestError("status must be open, resolved, or all")
    tops = db.execute(select(DocumentComment).where(
        DocumentComment.code == code, DocumentComment.parent_id.is_(None)
    ).order_by(DocumentComment.number, DocumentComment.id)).scalars().all()
    numbered = [(r.number, r) for r in tops]
    shown = [(n, r) for n, r in numbered if status == "all" or r.status == status]
    top_ids = [r.id for _, r in shown]
    replies = db.execute(select(DocumentComment).where(
        DocumentComment.parent_id.in_(top_ids)
    ).order_by(DocumentComment.created_at, DocumentComment.id)).scalars().all() if top_ids else []
    all_rows = [r for _, r in shown] + list(replies)
    atts: dict[int, list] = {}
    if all_rows:
        for a in db.execute(select(DocumentCommentAttachment).where(
                DocumentCommentAttachment.comment_id.in_([r.id for r in all_rows]))).scalars():
            atts.setdefault(a.comment_id, []).append(a)
    revisions = dict(db.execute(select(Document.id, Document.revision).where(
        Document.code == code)).all())
    names = _user_names(db, [r.author_user_id for r in all_rows] + [r.resolved_by_user_id for r in all_rows])
    by_parent: dict[int, list[dict]] = {}
    for r in replies:
        by_parent.setdefault(r.parent_id, []).append(_out(
            r, number=None, revision=revisions.get(r.document_id, 0), names=names,
            attachments=atts.get(r.id, []), replies=[]))
    items = [_out(r, number=n, revision=revisions.get(r.document_id, 0), names=names,
                  attachments=atts.get(r.id, []), replies=by_parent.get(r.id, []))
             for n, r in shown]
    latest = max(revisions.values()) if revisions else 0
    return {"items": items, "code": code, "latest_revision": latest,
            "open_count": sum(1 for _, r in numbered if r.status == "open")}


MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
_ATTACHMENT_TOKEN = re.compile(r"\{attachment:(\d+)\}")
_EXT_FOR_CT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}


def _sniff_image(data: bytes) -> str:
    """Magic bytes decide; the client's Content-Type is never trusted. Same four
    raster types as flag attachments (a copy, not an import: flags.service
    raises its own BadRequestError class, which our routes would not map)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise BadRequestError("attachment must be a PNG, JPEG, GIF, or WEBP image")


def _attachment_storage():
    """The flag attachment seam, reused (spec §4.2). Imported lazily because
    flags/seams.py imports documents.models for the entity registration."""
    from flags import seams as flag_seams
    return flag_seams.get_attachment_storage()


def add_attachment(db: Session, *, doc: Document, actor: Actor, data: bytes,
                   filename: str) -> DocumentCommentAttachment:
    if not data:
        raise BadRequestError("empty upload")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise BadRequestError("attachment exceeds 10 MB")
    content_type = _sniff_image(data)
    ext = _EXT_FOR_CT[content_type]
    key = _attachment_storage().save(f"documents/{doc.code}", data, f"upload{ext}")
    att = DocumentCommentAttachment(
        code=doc.code, comment_id=None, uploaded_by_user_id=actor.user_id,
        uploaded_by_agent=actor.agent, filename=(filename or f"upload{ext}")[:255],
        content_type=content_type, size_bytes=len(data), storage_key=key)
    db.add(att)
    db.commit()
    db.refresh(att)
    return att


def get_attachment(db: Session, attachment_id: int) -> DocumentCommentAttachment:
    att = db.get(DocumentCommentAttachment, attachment_id)
    if att is None:
        raise NotFoundError(f"attachment {attachment_id} not found")
    return att
