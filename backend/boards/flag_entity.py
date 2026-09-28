"""`board_node` as a flag entity (spec 2026-09-26 §6.1, §6.2, §14).

Anchors are board node ids (stringified). A node of kind `entity` is NOT an anchor: flags on
it belong to the underlying entity, so `can_raise` answers 400 pointing there. Visibility
follows the board through boards.access; an orphaned anchor (node deleted) is admin-only.
All host knowledge lives in these closures; flags.service never imports boards."""
from __future__ import annotations

import re
from typing import Optional

from sqlalchemy import String, cast, or_, select
from sqlalchemy.orm import Session

DELETED_LABEL = "Deleted board item"

# ASCII digits only, at most 9 chars: `str.isdigit()` also accepts superscripts/other
# unicode digit codepoints that fail `int()`, and an unbounded digit string can overflow
# or abort a real Postgres transaction on bind (M-2).
_ID_RE = re.compile(r"[0-9]{1,9}")


def _load(db: Session, eid: str):
    from boards.models import Board, BoardNode
    if db is None or not _ID_RE.fullmatch(str(eid)):
        return None, None
    row = db.execute(select(BoardNode, Board).join(Board, Board.id == BoardNode.board_id)
                     .where(BoardNode.id == int(eid))).first()
    return (row[0], row[1]) if row else (None, None)


def _ctx(node, board) -> dict:
    return {"label": f"{board.name} > {node.label}", "sample_id": None, "analyses": [], "lot": None,
            "deep_link": {"kind": "board_node", "id": f"{board.slug}:{node.id}"},
            "board_slug": board.slug, "node_kind": node.kind}


def _label(db, eid) -> str:
    node, board = _load(db, eid)
    return f"{board.name} > {node.label}" if node else DELETED_LABEL


def _context(db, eid) -> Optional[dict]:
    node, board = _load(db, eid)
    return _ctx(node, board) if node else None


def _contexts(db, eids) -> dict:
    from boards.models import Board, BoardNode
    ids = [int(e) for e in eids if _ID_RE.fullmatch(str(e))]
    if not ids:
        return {}
    rows = db.execute(select(BoardNode, Board).join(Board, Board.id == BoardNode.board_id)
                      .where(BoardNode.id.in_(ids))).all()
    return {str(n.id): _ctx(n, b) for n, b in rows}


def _descendants(db, eid) -> list:
    from boards.models import BoardNode
    node, _ = _load(db, eid)
    if node is None or node.kind != "frame":
        return []
    out = []
    for c in db.execute(select(BoardNode).where(BoardNode.parent_id == node.id)).scalars():
        if c.kind == "entity" and c.entity_type and c.entity_id:
            out.append((c.entity_type, c.entity_id))
        else:
            out.append(("board_node", str(c.id)))
    return out


def _can_raise(db, user, eid) -> bool:
    """can_raise wins over the legacy can_flag (flags.service prefers it when set).
    It may raise BadRequestError itself (flags.routes maps that to 400) to redirect a
    flag on an `entity`-kind node to its underlying anchor instead. Any OTHER exception
    type raised from here would propagate out of flags.service.create_flag uncaught and
    surface as a 500, so this closure must only ever raise BadRequestError deliberately."""
    from boards.access import can_edit_board, can_view_board
    from flags.errors import BadRequestError  # the flags one: flags.routes maps it to 400
    node, board = _load(db, eid)
    if node is None:
        return False
    if not can_view_board(db, user, board):
        return False  # existence is never confirmed (spec §9): check before the 400 below
    if node.kind == "entity":
        raise BadRequestError(
            f"flag the underlying {node.entity_type} {node.entity_id!r} instead of the board node")
    return can_edit_board(db, user, board)


def _can_view(db, user, eid) -> bool:
    from boards.access import can_view_board
    from groups.access import is_admin
    node, board = _load(db, eid)
    if node is None:
        return is_admin(user)  # orphaned anchor: fail closed
    return can_view_board(db, user, board)


def _visible_ids(db, user):
    from boards.access import visible_board_ids
    from boards.models import BoardNode
    from groups.access import is_admin
    if is_admin(user):
        return None
    return select(cast(BoardNode.id, String)).where(BoardNode.board_id.in_(visible_board_ids(db, user)))


def _search(db, user, q) -> list:
    from boards.access import visible_board_ids
    from boards.models import Board, BoardNode
    from flags.seams import _ilike_prefix
    pattern = "%" + _ilike_prefix(str(q))
    rows = db.execute(
        select(BoardNode, Board).join(Board, Board.id == BoardNode.board_id)
        .where(BoardNode.kind != "entity",
               BoardNode.board_id.in_(visible_board_ids(db, user)),
               or_(BoardNode.label.ilike(pattern, escape="\\"), Board.name.ilike(pattern, escape="\\")))
        .order_by(Board.name, BoardNode.label).limit(10)).all()
    return [{"entity_id": str(n.id), "label": f"{b.name} > {n.label}"} for n, b in rows]


def _snapshot(db, eid) -> Optional[dict]:
    node, board = _load(db, eid)
    return {"board": board.slug, "kind": node.kind} if node else None


def register_board_node() -> None:
    from flags.seams import register_entity
    register_entity("board_node",
                    label=_label,
                    deep_link=lambda eid: "/#boards/board",
                    can_flag=lambda user, eid: True,   # never consulted: can_raise wins
                    can_raise=_can_raise,
                    can_view=_can_view,
                    visible_entity_ids=_visible_ids,
                    context=_context,
                    contexts=_contexts,
                    descendants=_descendants,
                    search_scoped=_search,
                    snapshot=_snapshot,
                    must_exist=True)
