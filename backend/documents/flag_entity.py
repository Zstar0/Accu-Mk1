"""Visibility closures for the `document` flag entity (spec 2026-10-06 section 6).

The entity_id is the document CODE. Visibility follows the code's space through
documents.access. Everything imports lazily inside the closures, mirroring
boards/flag_entity.py, so flags.seams has no import-time dependency on documents."""
from __future__ import annotations

from typing import Optional


def _latest(db, code):
    from documents.service import latest_revision
    if db is None or not code:
        return None
    return latest_revision(db, str(code).strip())


def can_raise(db, user, eid) -> bool:
    from documents.access import can_view_document
    doc = _latest(db, eid)
    return doc is not None and can_view_document(db, user, doc)


def can_view(db, user, eid) -> bool:
    from documents.access import can_view_document
    from groups.access import is_admin
    doc = _latest(db, eid)
    if doc is None:
        return is_admin(user)  # unknown or deleted anchor: fail closed
    return can_view_document(db, user, doc)


def visible_ids(db, user):
    from sqlalchemy import or_, select
    from documents.access import visible_space_ids
    from documents.models import Document
    from groups.access import is_admin
    if is_admin(user):
        return None
    return (select(Document.code)
            .where(or_(Document.space_id.in_(visible_space_ids(db, user)), Document.space_id.is_(None)))
            .distinct())


def search_scoped(db, user, q) -> list:
    from sqlalchemy import or_
    from documents.access import visible_space_ids
    from documents.models import Document
    from flags.seams import _ilike_prefix
    from groups.access import is_admin
    query = (db.query(Document)
             .filter(or_(Document.code.ilike(_ilike_prefix(q), escape="\\"),
                         Document.title.ilike("%" + _ilike_prefix(q), escape="\\"))))
    if not is_admin(user):
        query = query.filter(or_(Document.space_id.in_(visible_space_ids(db, user)),
                                 Document.space_id.is_(None)))
    rows = query.order_by(Document.code, Document.revision.desc()).limit(60).all()
    out, seen = [], set()
    for r in rows:  # newest revision of each code wins
        if r.code in seen:
            continue
        seen.add(r.code)
        out.append({"entity_id": r.code, "label": f"{r.code} \u00b7 {r.title}"})
        if len(out) == 10:
            break
    return out


def audience(db, eid) -> Optional[dict]:
    """Live-event audience: everyone for a company space, the granted groups (plus
    admins) for a restricted one, admins only when the code no longer resolves."""
    from sqlalchemy import select
    from documents.models import DocumentSpaceGrant
    doc = _latest(db, eid)
    if doc is None:
        return {"groups": []}
    space = doc.space
    if space is None or space.visibility == "company":
        return None
    gids = db.execute(select(DocumentSpaceGrant.group_id).where(DocumentSpaceGrant.space_id == space.id)
                      .order_by(DocumentSpaceGrant.group_id)).scalars().all()
    return {"groups": [int(g) for g in gids]}
