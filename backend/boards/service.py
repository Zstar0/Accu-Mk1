"""Boards, grants, reverse lookup (spec §4.8, §5, §7.2). Nodes and edges: Task 6."""
from __future__ import annotations

from typing import Iterable, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from boards import access
from boards.models import BOARD_KINDS, VISIBILITIES, Board, BoardEdge, BoardGrant, BoardNode
from boards.schemas import BoardDetail, BoardOut, EdgeOut, GrantOut, NodeOut
from groups.access import is_admin
from groups.errors import BadRequestError, ConflictError, NotFoundError, PermissionDeniedError
from groups.models import UserGroup
from groups.service import clean_slug

# Flipped to True by slice 2 (flag visibility enforcement). Until then a restricted board
# would leak its flags into every staff member's All Open tab, so it cannot exist.
RESTRICTED_BOARDS_ENABLED = False


def _require_admin(user) -> None:
    if not is_admin(user):
        raise PermissionDeniedError("admin only")


def _check_visibility(visibility: str) -> str:
    if visibility not in VISIBILITIES:
        raise BadRequestError(f"visibility must be one of {VISIBILITIES}")
    if visibility == "restricted" and not RESTRICTED_BOARDS_ENABLED:
        raise BadRequestError("restricted boards are not enabled yet")
    return visibility


def _check_kind(kind: str) -> str:
    if kind not in BOARD_KINDS:
        raise BadRequestError(f"kind must be one of {BOARD_KINDS}")
    return kind


def _clean_name(name: str) -> str:
    n = (name or "").strip()
    if not n or len(n) > 120:
        raise BadRequestError("name is required (max 120 chars)")
    return n


def open_flag_count(db: Session, node_ids: Iterable[int]) -> int:
    """Open flags anchored on these board nodes (board_node + str(id)). Spec §4.8."""
    from flags.catalog import OPEN_STATES
    from flags.models import FlagFlag
    ids = [str(i) for i in node_ids]
    if not ids:
        return 0
    return int(db.execute(select(func.count()).select_from(FlagFlag).where(
        FlagFlag.entity_type == "board_node", FlagFlag.entity_id.in_(ids),
        FlagFlag.status.in_(OPEN_STATES))).scalar_one())


# --- boards ---------------------------------------------------------------------

def list_boards(db: Session, user) -> list[Board]:
    return list(db.execute(select(Board).where(Board.id.in_(access.visible_board_ids(db, user)))
                           .order_by(Board.name)).scalars().all())


def get_board(db: Session, user, slug: str) -> Board:
    board = db.execute(select(Board).where(Board.slug == slug)).scalar_one_or_none()
    if board is None:
        raise NotFoundError(f"board {slug!r} not found")
    access.require_view(db, user, board)
    return board


def create_board(db: Session, user, *, slug: str, name: str, kind: str, visibility: str) -> Board:
    _require_admin(user)
    slug = clean_slug(slug)
    if db.execute(select(Board.id).where(Board.slug == slug)).scalar_one_or_none():
        raise ConflictError(f"board slug {slug!r} already exists")
    board = Board(slug=slug, name=_clean_name(name), kind=_check_kind(kind),
                  visibility=_check_visibility(visibility), created_by=getattr(user, "id", None))
    db.add(board)
    db.commit()
    db.refresh(board)
    return board


def patch_board(db: Session, user, slug: str, **fields) -> Board:
    board = get_board(db, user, slug)
    access.require_edit(db, user, board)
    if fields.get("visibility") is not None:
        _require_admin(user)
        board.visibility = _check_visibility(fields["visibility"])
    if fields.get("name") is not None:
        board.name = _clean_name(fields["name"])
    if fields.get("kind") is not None:
        board.kind = _check_kind(fields["kind"])
    if fields.get("default_viewport") is not None:
        vp = fields["default_viewport"]
        board.default_viewport = vp if isinstance(vp, dict) else vp.model_dump()
    db.commit()
    db.refresh(board)
    return board


def delete_board(db: Session, user, slug: str) -> None:
    board = get_board(db, user, slug)
    _require_admin(user)
    node_ids = list(db.execute(select(BoardNode.id).where(BoardNode.board_id == board.id)).scalars())
    n = open_flag_count(db, node_ids)
    if n:
        raise ConflictError(f"board has {n} open flag(s) on its nodes; resolve them first")
    # Explicit cascade so SQLite tests and Postgres behave the same (spec §14).
    db.query(BoardEdge).filter(BoardEdge.board_id == board.id).delete()
    db.query(BoardNode).filter(BoardNode.board_id == board.id).update({BoardNode.parent_id: None})
    db.query(BoardNode).filter(BoardNode.board_id == board.id).delete()
    db.query(BoardGrant).filter(BoardGrant.board_id == board.id).delete()
    db.delete(board)
    db.commit()


def node_counts(db: Session, board_ids: Iterable[int]) -> dict[int, int]:
    ids = list(board_ids)
    if not ids:
        return {}
    rows = db.execute(select(BoardNode.board_id, func.count()).where(BoardNode.board_id.in_(ids))
                      .group_by(BoardNode.board_id)).all()
    return {bid: n for bid, n in rows}


# --- grants -----------------------------------------------------------------------

def list_grants(db: Session, board: Board) -> list[GrantOut]:
    rows = db.execute(select(BoardGrant, UserGroup).join(UserGroup, UserGroup.id == BoardGrant.group_id)
                      .where(BoardGrant.board_id == board.id).order_by(UserGroup.name)).all()
    return [GrantOut(group_id=g.id, group_slug=g.slug, group_name=g.name, can_edit=gr.can_edit)
            for gr, g in rows]


def replace_grants(db: Session, user, slug: str, grants) -> list[GrantOut]:
    board = get_board(db, user, slug)
    _require_admin(user)
    wanted = {}
    for g in grants:
        wanted[int(g.group_id)] = bool(g.can_edit)  # last one wins on duplicates
    if wanted:
        ok = set(db.execute(select(UserGroup.id).where(UserGroup.id.in_(list(wanted)))).scalars())
        bad = sorted(set(wanted) - ok)
        if bad:
            raise BadRequestError(f"unknown group ids: {bad}")
    db.query(BoardGrant).filter(BoardGrant.board_id == board.id).delete()
    for gid, can_edit in wanted.items():
        db.add(BoardGrant(board_id=board.id, group_id=gid, can_edit=can_edit))
    db.commit()
    return list_grants(db, board)


# --- reverse lookup ----------------------------------------------------------------

def boards_for_entity(db: Session, user, entity_type: str, entity_id: str) -> list[tuple[Board, BoardNode]]:
    rows = db.execute(select(Board, BoardNode).join(BoardNode, BoardNode.board_id == Board.id)
                      .where(BoardNode.entity_type == entity_type, BoardNode.entity_id == str(entity_id),
                             Board.id.in_(access.visible_board_ids(db, user)))
                      .order_by(Board.name, BoardNode.id)).all()
    return [(b, n) for b, n in rows]


# --- serialization -----------------------------------------------------------------

def board_out(db: Session, user, board: Board, counts: Optional[dict] = None) -> BoardOut:
    out = BoardOut.model_validate(board)
    out.node_count = (counts or node_counts(db, [board.id])).get(board.id, 0)
    out.can_edit = access.can_edit_board(db, user, board)
    return out


def board_detail_payload(db: Session, user, board: Board) -> BoardDetail:
    from flags import seams
    nodes = list(db.execute(select(BoardNode).where(BoardNode.board_id == board.id)
                            .order_by(BoardNode.z, BoardNode.id)).scalars().all())
    edges = list(db.execute(select(BoardEdge).where(BoardEdge.board_id == board.id)
                            .order_by(BoardEdge.id)).scalars().all())
    by_type: dict[str, list[str]] = {}
    for n in nodes:
        if n.kind == "entity" and n.entity_type and n.entity_id:
            by_type.setdefault(n.entity_type, []).append(n.entity_id)
    ctx = {(t, eid): c for t, ids in by_type.items()
           for eid, c in seams.resolve_contexts(db, t, ids).items()}
    base = board_out(db, user, board)
    detail = BoardDetail(**base.model_dump())
    for n in nodes:
        o = NodeOut.model_validate(n)
        if n.kind == "entity":
            o.context = ctx.get((n.entity_type, n.entity_id))
        detail.nodes.append(o)
    detail.edges = [EdgeOut.model_validate(e) for e in edges]
    detail.grants = list_grants(db, board)
    return detail
