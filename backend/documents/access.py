"""The one module that answers every document visibility question (spec 2026-10-06
section 5). Routes, the comment routes, the flag seam and the agent-token check call
these; nothing else re-derives the rule. Mirrors boards/access.py on purpose.

  can_view_space      : admin -> True; company -> active user; restricted -> any grant
                        for one of the user's ACTIVE groups
  can_view_document   : can_view_space of the document's space (NULL reads as General)
  visible_space_ids   : Select of space ids the user may see (for IN (...) subqueries)
  require_view        : NotFoundError, never 403: existence is not confirmed

Membership is read on every call: revoking a group takes effect on the next request."""
from __future__ import annotations

from sqlalchemy import false, or_, select
from sqlalchemy.orm import Session

from documents.errors import NotFoundError
from documents.models import Document, DocumentSpace, DocumentSpaceGrant
from groups.access import is_admin, user_group_ids


def _active(user) -> bool:
    return getattr(user, "id", None) is not None and bool(getattr(user, "is_active", True))


def _granted(db: Session, space: DocumentSpace, gids: frozenset[int]) -> bool:
    if not gids:
        return False
    row = db.execute(select(DocumentSpaceGrant.id)
                     .where(DocumentSpaceGrant.space_id == space.id,
                            DocumentSpaceGrant.group_id.in_(gids)).limit(1)).scalar_one_or_none()
    return row is not None


def can_view_space(db: Session, user, space: DocumentSpace) -> bool:
    if not _active(user):
        return False
    if is_admin(user) or space.visibility == "company":
        return True
    return _granted(db, space, user_group_ids(db, user))


def can_view_document(db: Session, user, doc: Document) -> bool:
    if doc.space_id is None:
        # Pre-backfill row: it is General by definition (spec 4.4).
        return _active(user)
    space = doc.space if doc.space is not None else db.get(DocumentSpace, doc.space_id)
    if space is None:
        return is_admin(user)  # dangling id: fail closed
    return can_view_space(db, user, space)


def visible_space_ids(db: Session, user):
    if not _active(user):
        return select(DocumentSpace.id).where(false())
    if is_admin(user):
        return select(DocumentSpace.id)
    cond = DocumentSpace.visibility == "company"
    gids = user_group_ids(db, user)
    if gids:
        granted = select(DocumentSpaceGrant.space_id).where(DocumentSpaceGrant.group_id.in_(gids))
        cond = or_(cond, DocumentSpace.id.in_(granted))
    return select(DocumentSpace.id).where(cond)


def require_view(db: Session, user, doc: Document) -> None:
    if not can_view_document(db, user, doc):
        # Same text service.get_document raises for a missing id (spec 5.2).
        raise NotFoundError(f"document {doc.id} not found")
