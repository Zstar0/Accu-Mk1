"""The one module that answers every board visibility question (spec §5).
Routes and the board_node flag seam call these; nothing else re-derives the rule.

  can_view_board : admin -> True; company -> active user; restricted -> any grant for
                   one of the user's groups
  can_edit_board : admin -> True; else a grant with can_edit for one of the user's groups
  visible_board_ids : Select of board ids the user may see (for IN (...) subqueries)

Membership is read on every call: revoking a group takes effect on the next request."""
from __future__ import annotations

from sqlalchemy import false, or_, select
from sqlalchemy.orm import Session

from boards.models import Board, BoardGrant
from groups.access import is_admin, user_group_ids
from groups.errors import NotFoundError, PermissionDeniedError


def _active(user) -> bool:
    return getattr(user, "id", None) is not None and bool(getattr(user, "is_active", True))


def _has_grant(db: Session, board: Board, gids: frozenset[int], *, edit: bool) -> bool:
    if not gids:
        return False
    stmt = select(BoardGrant.id).where(BoardGrant.board_id == board.id,
                                       BoardGrant.group_id.in_(gids))
    if edit:
        stmt = stmt.where(BoardGrant.can_edit.is_(True))
    return db.execute(stmt.limit(1)).scalar_one_or_none() is not None


def can_view_board(db: Session, user, board: Board) -> bool:
    if not _active(user):
        return False
    if is_admin(user) or board.visibility == "company":
        return True
    return _has_grant(db, board, user_group_ids(db, user), edit=False)


def can_edit_board(db: Session, user, board: Board) -> bool:
    if not _active(user):
        return False
    if is_admin(user):
        return True
    return _has_grant(db, board, user_group_ids(db, user), edit=True)


def visible_board_ids(db: Session, user):
    if not _active(user):
        return select(Board.id).where(false())
    if is_admin(user):
        return select(Board.id)
    cond = Board.visibility == "company"
    gids = user_group_ids(db, user)
    if gids:
        granted = select(BoardGrant.board_id).where(BoardGrant.group_id.in_(gids))
        cond = or_(cond, Board.id.in_(granted))
    return select(Board.id).where(cond)


def require_view(db: Session, user, board: Board) -> None:
    if not can_view_board(db, user, board):
        # 404, never 403: do not confirm a restricted board exists.
        raise NotFoundError(f"board {board.slug!r} not found")


def require_edit(db: Session, user, board: Board) -> None:
    require_view(db, user, board)
    if not can_edit_board(db, user, board):
        raise PermissionDeniedError(f"not allowed to edit board {board.slug!r}")
