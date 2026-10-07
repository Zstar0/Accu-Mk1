# backend/documents/comment_export.py
"""Agent-facing views (spec §6.2 index, §6.3 export)."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from documents import comments, labels
from documents.errors import BadRequestError
from documents.models import Document, DocumentComment

FOOTER = ("---\n"
          "Address each item. Post the next revision with `documents_revise`. Then resolve what you "
          "handled with `documents_comment_resolve`, or answer with `documents_comment_reply` where "
          "you disagree. Do not edit comments you did not write.\n")


def _when(dt) -> str:
    return dt.strftime("%Y-%m-%d %H:%M")


def _heading(item: dict) -> str:
    label = labels.get_label(item["label"])
    if item["kind"] == "suggestion":
        kind = "Suggestion"
    elif item["anchor"] is None:
        kind = "Global"
    elif label:
        kind = f"{label.emoji} {label.text}"
    else:
        kind = "Comment"
    if label and item["kind"] != "comment":
        kind = f"{kind} ({label.emoji} {label.text})"
    return f"## {item['number']}. {kind} — {item['author']}, on r{item['revision']}, {_when(item['created_at'])}"


def _where(anchor: Optional[dict]) -> Optional[str]:
    ctx = (anchor or {}).get("elementContext") or {}
    parts = [p for p in (ctx.get("heading"), ctx.get("path")) if p]
    return "Where: " + " › ".join(parts) if parts else None


def _entry(item: dict) -> str:
    lines = [_heading(item)]
    quote = (item["anchor"] or {}).get("originalText") if item["anchor"] else None
    if quote:
        lines.append(f'> "{quote}"')
    where = _where(item["anchor"])
    if where:
        lines.append(where)
    if item["body"]:
        lines.append(item["body"])
    if item["kind"] == "suggestion":
        lines.append("Replace with:")
        lines.append(f'> "{item["suggested_text"]}"')
    label = labels.get_label(item["label"])
    if label and label.tip:
        lines.append(f"Agent tip: {label.tip}")
    if item["attachments"]:
        lines.append("Attachments: " + " ".join(f"{{attachment:{a['id']}}}" for a in item["attachments"]))
    if item["replies"]:
        lines.append("Replies:")
        for r in item["replies"]:
            lines.append(f"- {r['author']}, {_when(r['created_at'])}: {r['body']}")
    return "\n".join(lines) + "\n"


def export_markdown(db: Session, code: str, status: str = "open") -> str:
    listing = comments.list_comments(db, code, status=status)
    latest = db.execute(select(Document).where(Document.code == code)
                        .order_by(Document.revision.desc()).limit(1)).scalars().first()
    if latest is None:
        raise BadRequestError(f"unknown document code {code!r}")
    head = (f'# Comments on {code} "{latest.title}"\n'
            f"Latest revision: r{latest.revision} ({latest.status}). {listing['open_count']} open.\n")
    body = "\n".join(_entry(item) for item in listing["items"])
    return head + "\n" + body + ("\n" if body else "") + FOOTER


def list_index(db: Session, *, status: str = "open", author_agent: Optional[str] = None,
               code_prefix: Optional[str] = None, limit: int = 100) -> list[dict]:
    if status not in comments.STATUSES + ("all",):
        raise BadRequestError("status must be open, resolved, or all")
    stmt = select(DocumentComment).where(DocumentComment.parent_id.is_(None))
    if status != "all":
        stmt = stmt.where(DocumentComment.status == status)
    if author_agent:
        stmt = stmt.where(DocumentComment.author_agent == author_agent)
    if code_prefix:
        stmt = stmt.where(DocumentComment.code.like(f"{code_prefix.upper()}-%"))
    rows = db.execute(stmt.order_by(DocumentComment.created_at.desc(), DocumentComment.id.desc())
                      .limit(max(1, min(500, limit)))).scalars().all()
    if not rows:
        return []
    docs = {d.id: d for d in db.execute(select(Document).where(
        Document.id.in_({r.document_id for r in rows}))).scalars()}
    names = comments._user_names(db, [r.author_user_id for r in rows])
    out = []
    for r in rows:
        d = docs.get(r.document_id)
        out.append({"id": r.id, "code": r.code, "title": d.title if d else "", "document_id": r.document_id,
                    "revision": d.revision if d else 0, "number": r.number, "kind": r.kind,
                    "label": r.label, "author": comments._who(r.author_user_id, r.author_agent, names) or "unknown",
                    "status": r.status, "created_at": r.created_at, "body_excerpt": (r.body or "")[:140]})
    return out
