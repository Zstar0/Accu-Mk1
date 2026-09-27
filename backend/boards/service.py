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
    if "default_viewport" in fields:
        vp = fields["default_viewport"]
        board.default_viewport = None if vp is None else (vp if isinstance(vp, dict) else vp.model_dump())
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


# --- nodes ------------------------------------------------------------------------
from pydantic import ValidationError  # noqa: E402  (kept next to its only users)

from boards.models import EDGE_KINDS, NODE_KINDS  # noqa: E402
from boards.schemas import KIND_DATA  # noqa: E402

# Widget keys a `widget` node may carry. Empty in slice 1 (spec §4.7); slice 5 fills it.
ALLOWED_WIDGETS: tuple[str, ...] = ()


class StaleVersionError(ConflictError):
    """Optimistic-lock miss. `current` is the row as it is now (single PATCH);
    `stale_ids` lists the losers of a bulk positions PATCH."""
    def __init__(self, msg: str, *, current=None, stale_ids=None) -> None:
        super().__init__(msg)
        self.current = current
        self.stale_ids = stale_ids or []


def validate_node_data(db: Session, *, kind: str, data: Optional[dict], entity_type: Optional[str],
                       entity_id: Optional[str]) -> tuple[dict, Optional[str]]:
    """Returns (clean_data, label_from_registry_or_None). Raises BadRequestError."""
    from flags import seams
    if kind not in NODE_KINDS:
        raise BadRequestError(f"kind must be one of {NODE_KINDS}")
    try:
        clean = KIND_DATA[kind].model_validate(data or {})
    except ValidationError as e:
        raise BadRequestError(f"invalid data for {kind}: {e.errors()[0]['msg']}")
    label = None
    if kind == "entity":
        if not entity_type or not entity_id:
            raise BadRequestError("entity nodes need entity_type and entity_id")
        if entity_type == "board_node":
            raise BadRequestError("a board node cannot point at a board node")
        if not seams.is_registered(entity_type):
            raise BadRequestError(f"unknown entity_type {entity_type!r}")
        ctx = seams.resolve_context(db, entity_type, str(entity_id))
        if ctx is None:
            raise BadRequestError(f"{entity_type} {entity_id!r} not found")
        label = ctx.get("label")
    elif entity_type is not None or entity_id is not None:
        raise BadRequestError(f"{kind} nodes take no entity_type/entity_id")
    if kind == "person":
        from models import User
        u = db.get(User, clean.user_id)
        if u is None or not u.is_active:
            raise BadRequestError(f"unknown or inactive user {clean.user_id}")
    if kind == "widget" and clean.key not in ALLOWED_WIDGETS:
        raise BadRequestError(f"widget {clean.key!r} is not available")
    return clean.model_dump(), label


def _node_on_board(db: Session, board: Board, node_id: int) -> BoardNode:
    n = db.get(BoardNode, int(node_id))
    if n is None or n.board_id != board.id:
        raise NotFoundError(f"node {node_id} not found on board {board.slug!r}")
    return n


def _check_parent(db: Session, board: Board, parent_id: Optional[int], *, self_id: Optional[int] = None,
                  pending_parents: frozenset = frozenset()) -> None:
    if parent_id is None:
        return
    if self_id is not None and int(parent_id) == int(self_id):
        raise BadRequestError("a node cannot be its own parent")
    parent = _node_on_board(db, board, parent_id)
    if parent.kind != "frame":
        raise BadRequestError("parent must be a frame")
    if parent.parent_id is not None:
        raise BadRequestError("frames nest one level deep")
    if self_id is not None:
        has_child = db.execute(select(BoardNode.id).where(BoardNode.parent_id == self_id)
                               .limit(1)).scalar_one_or_none()
        if has_child is not None or self_id in pending_parents:
            raise BadRequestError("a frame that has children cannot be nested")


def _editable(db: Session, user, slug: str) -> Board:
    board = get_board(db, user, slug)
    access.require_edit(db, user, board)
    return board


def _node_out(db: Session, node: BoardNode) -> NodeOut:
    from flags import seams
    out = NodeOut.model_validate(node)
    if node.kind == "entity" and node.entity_type and node.entity_id:
        out.context = seams.resolve_context(db, node.entity_type, node.entity_id)
    return out


def create_node(db: Session, user, slug: str, body) -> NodeOut:
    board = _editable(db, user, slug)
    clean, reg_label = validate_node_data(db, kind=body.kind, data=body.data,
                                          entity_type=body.entity_type, entity_id=body.entity_id)
    _check_parent(db, board, body.parent_id)
    uid = getattr(user, "id", None)
    node = BoardNode(board_id=board.id, kind=body.kind, label=(body.label or reg_label or "")[:200],
                     parent_id=body.parent_id, x=body.x, y=body.y, w=body.w, h=body.h, z=body.z,
                     entity_type=body.entity_type if body.kind == "entity" else None,
                     entity_id=str(body.entity_id) if body.kind == "entity" else None,
                     data=clean, created_by=uid, updated_by=uid)
    db.add(node)
    db.commit()
    db.refresh(node)
    return _node_out(db, node)


def patch_node(db: Session, user, slug: str, node_id: int, *, version: int, **fields) -> NodeOut:
    board = _editable(db, user, slug)
    node = _node_on_board(db, board, node_id)
    if node.version != version:
        raise StaleVersionError("stale version; reload the node", current=node)
    if "data" in fields and fields["data"] is not None:
        clean, _ = validate_node_data(db, kind=node.kind, data=fields["data"],
                                      entity_type=node.entity_type, entity_id=node.entity_id)
        node.data = clean
    if "parent_id" in fields:
        _check_parent(db, board, fields["parent_id"], self_id=node.id)
        node.parent_id = fields["parent_id"]
    for f in ("label", "x", "y", "z"):
        if f in fields and fields[f] is not None:
            setattr(node, f, fields[f])
    for f in ("w", "h"):
        if f in fields:
            setattr(node, f, fields[f])
    node.version += 1
    node.updated_by = getattr(user, "id", None)
    db.commit()
    db.refresh(node)
    return _node_out(db, node)


def patch_positions(db: Session, user, slug: str, items) -> list[NodeOut]:
    """All-or-nothing: one stale version rejects the whole batch (spec §7.3)."""
    board = _editable(db, user, slug)
    nodes = [(_node_on_board(db, board, it.id), it) for it in items]
    stale = [n.id for n, it in nodes if n.version != it.version]
    if stale:
        raise StaleVersionError("stale versions in positions batch", stale_ids=stale)
    # Validate every re-parent in the batch before mutating anything. An item that sets
    # parent_id = X makes X a parent for the nesting-depth check even though X's own
    # re-parent (if any) hasn't been written yet, so the check is order-independent.
    pending_parents = frozenset(int(it.parent_id) for _, it in nodes
                                if "parent_id" in it.model_fields_set and it.parent_id is not None)
    for n, it in nodes:
        if "parent_id" in it.model_fields_set:
            _check_parent(db, board, it.parent_id, self_id=n.id, pending_parents=pending_parents)
    uid = getattr(user, "id", None)
    for n, it in nodes:
        if "parent_id" in it.model_fields_set:
            n.parent_id = it.parent_id
        n.x, n.y = it.x, it.y
        n.version += 1
        n.updated_by = uid
    db.commit()
    return [_node_out(db, n) for n, _ in nodes]


def delete_node(db: Session, user, slug: str, node_id: int) -> None:
    board = _editable(db, user, slug)
    node = _node_on_board(db, board, node_id)
    n = open_flag_count(db, [node.id])
    if n:
        raise ConflictError(f"node has {n} open flag(s); resolve them first")
    uid = getattr(user, "id", None)
    for child in db.execute(select(BoardNode).where(BoardNode.parent_id == node.id)).scalars():
        child.parent_id = None
        child.x += node.x  # keep the child where it was on the canvas
        child.y += node.y
        child.version += 1
        child.updated_by = uid
    db.query(BoardEdge).filter((BoardEdge.source_id == node.id) | (BoardEdge.target_id == node.id)).delete(
        synchronize_session=False)
    db.delete(node)
    db.commit()


# --- edges ------------------------------------------------------------------------

def _edge_on_board(db: Session, board: Board, edge_id: int) -> BoardEdge:
    e = db.get(BoardEdge, int(edge_id))
    if e is None or e.board_id != board.id:
        raise NotFoundError(f"edge {edge_id} not found on board {board.slug!r}")
    return e


def _check_edge_kind(kind: str) -> str:
    if kind not in EDGE_KINDS:
        raise BadRequestError(f"edge kind must be one of {EDGE_KINDS}")
    return kind


def create_edge(db: Session, user, slug: str, body) -> BoardEdge:
    board = _editable(db, user, slug)
    if body.source_id == body.target_id:
        raise BadRequestError("an edge needs two different nodes")
    _node_on_board(db, board, body.source_id)
    _node_on_board(db, board, body.target_id)
    kind = _check_edge_kind(body.kind)
    dup = db.execute(select(BoardEdge.id).where(
        BoardEdge.board_id == board.id, BoardEdge.source_id == body.source_id,
        BoardEdge.target_id == body.target_id, BoardEdge.kind == kind)).scalar_one_or_none()
    if dup is not None:
        raise ConflictError("that edge already exists")
    e = BoardEdge(board_id=board.id, source_id=body.source_id, target_id=body.target_id,
                  kind=kind, label=body.label)
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def patch_edge(db: Session, user, slug: str, edge_id: int, **fields) -> BoardEdge:
    board = _editable(db, user, slug)
    e = _edge_on_board(db, board, edge_id)
    if fields.get("kind") is not None:
        e.kind = _check_edge_kind(fields["kind"])
    if "label" in fields:
        e.label = fields["label"]
    db.commit()
    db.refresh(e)
    return e


def delete_edge(db: Session, user, slug: str, edge_id: int) -> None:
    board = _editable(db, user, slug)
    db.delete(_edge_on_board(db, board, edge_id))
    db.commit()
