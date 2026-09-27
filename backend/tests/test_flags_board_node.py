"""`board_node` as a flag entity type (spec §6.1, §6.2, §4.8)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", email="a@x.t", is_active=True)
EDITOR = SimpleNamespace(id=10, role="standard", email="e@x.t", is_active=True)
VIEWER = SimpleNamespace(id=11, role="standard", email="v@x.t", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", email="o@x.t", is_active=True)


@pytest.fixture
def w():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from boards.models import Board, BoardGrant, BoardNode
    from groups.models import UserGroup, UserGroupMember
    from flags import seams, types_service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    seams.register_mk1_entities()
    editors, viewers = UserGroup(slug="editors", name="Editors"), UserGroup(slug="viewers", name="Viewers")
    org = Board(slug="org", name="Org")
    exec_ = Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([editors, viewers, org, exec_])
    s.flush()
    s.add_all([UserGroupMember(group_id=editors.id, user_id=EDITOR.id),
               UserGroupMember(group_id=viewers.id, user_id=VIEWER.id),
               BoardGrant(board_id=exec_.id, group_id=editors.id, can_edit=True),
               BoardGrant(board_id=exec_.id, group_id=viewers.id, can_edit=False),
               BoardGrant(board_id=org.id, group_id=editors.id, can_edit=True)])
    frame = BoardNode(board_id=exec_.id, kind="frame", label="Marketing", x=100, y=50)
    s.add(frame)
    s.flush()
    text = BoardNode(board_id=exec_.id, kind="text", label="Q4", parent_id=frame.id)
    ent = BoardNode(board_id=exec_.id, kind="entity", label="Worksheet 1", parent_id=frame.id,
                    entity_type="worksheet", entity_id="1")
    pub = BoardNode(board_id=org.id, kind="note", label="Welcome")
    s.add_all([text, ent, pub])
    s.commit()
    return SimpleNamespace(s=s, org=org, exec_=exec_, frame=frame, text=text, ent=ent, pub=pub)


def test_registered_with_must_exist(w):
    from flags import seams
    spec = seams.get_entity_spec("board_node")
    assert spec.must_exist is True
    assert spec.can_raise and spec.can_view and spec.visible_entity_ids and spec.search_scoped


def test_context_label_and_deep_link(w):
    from flags import seams
    ctx = seams.resolve_context(w.s, "board_node", str(w.frame.id))
    assert ctx["label"] == "Exec > Marketing"
    assert ctx["deep_link"] == {"kind": "board_node", "id": f"exec:{w.frame.id}"}
    assert (ctx["board_slug"], ctx["node_kind"]) == ("exec", "frame")
    assert seams.resolve_context(w.s, "board_node", "999") is None
    assert seams.resolve_context(w.s, "board_node", "abc") is None
    assert seams.get_entity_spec("board_node").label(w.s, "999") == "Deleted board item"


def test_contexts_batch_matches_per_id(w):
    from flags import seams
    ids = [str(w.frame.id), str(w.text.id), "999"]
    batch = seams.resolve_contexts(w.s, "board_node", ids)
    assert set(batch) == {str(w.frame.id), str(w.text.id)}
    for eid in batch:
        assert batch[eid]["label"] == seams.resolve_context(w.s, "board_node", eid)["label"]


def test_descendants_of_a_frame_include_entity_children_by_their_own_anchor(w):
    from flags import seams
    pairs = set(seams.resolve_descendants(w.s, "board_node", str(w.frame.id)))
    assert pairs == {("board_node", str(w.text.id)), ("worksheet", "1")}
    assert seams.resolve_descendants(w.s, "board_node", str(w.text.id)) == []


def test_can_raise_is_can_edit_board(w):
    from flags import service
    from flags.errors import PermissionDeniedError
    f = service.create_flag(w.s, user=EDITOR, entity_type="board_node", entity_id=str(w.frame.id),
                            type="task", title="Plan Q4")
    assert f.entity_type == "board_node"
    with pytest.raises(PermissionDeniedError):
        service.create_flag(w.s, user=VIEWER, entity_type="board_node", entity_id=str(w.frame.id),
                            type="task", title="nope")
    with pytest.raises(PermissionDeniedError):
        service.create_flag(w.s, user=OUTSIDER, entity_type="board_node", entity_id=str(w.frame.id),
                            type="task", title="nope")


def test_entity_node_redirects_flags_to_underlying_entity(w):
    """Review Focus 5: a thread about an SOP must never fork onto the board copy."""
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError, match="worksheet '1'"):
        service.create_flag(w.s, user=EDITOR, entity_type="board_node", entity_id=str(w.ent.id),
                            type="task", title="x")


def test_snapshot_records_board_and_kind(w):
    from flags import service
    from flags.models import FlagEvent
    f = service.create_flag(w.s, user=EDITOR, entity_type="board_node", entity_id=str(w.frame.id),
                            type="task", title="Plan Q4")
    ev = w.s.execute(select(FlagEvent).where(FlagEvent.flag_id == f.id,
                                             FlagEvent.event_type == "raised")).scalar_one()
    assert ev.details["entity_snapshot"] == {"board": "exec", "kind": "frame"}


def test_can_view_follows_the_board(w):
    from flags import seams
    fid = str(w.frame.id)
    assert seams.can_view_entity(w.s, ADMIN, "board_node", fid) is True
    assert seams.can_view_entity(w.s, EDITOR, "board_node", fid) is True
    assert seams.can_view_entity(w.s, VIEWER, "board_node", fid) is True
    assert seams.can_view_entity(w.s, OUTSIDER, "board_node", fid) is False
    assert seams.can_view_entity(w.s, OUTSIDER, "board_node", str(w.pub.id)) is True
    assert seams.can_view_entity(w.s, OUTSIDER, "board_node", "999") is False, "orphans: admins only"
    assert seams.can_view_entity(w.s, ADMIN, "board_node", "999") is True


def test_visible_entity_ids_and_clause(w):
    from flags import seams
    from flags.models import FlagFlag
    spec = seams.get_entity_spec("board_node")
    assert spec.visible_entity_ids(w.s, ADMIN) is None
    ids = set(w.s.execute(spec.visible_entity_ids(w.s, OUTSIDER)).scalars().all())
    assert ids == {str(w.pub.id)}
    w.s.add_all([FlagFlag(entity_type="board_node", entity_id=str(w.frame.id), kind="issue", type="task",
                          status="open", title="secret", created_by=1),
                 FlagFlag(entity_type="board_node", entity_id=str(w.pub.id), kind="issue", type="task",
                          status="open", title="public", created_by=1)])
    w.s.commit()
    titles = lambda u: sorted(w.s.execute(  # noqa: E731
        select(FlagFlag.title).where(seams.visibility_clause(w.s, u))).scalars().all())
    assert titles(OUTSIDER) == ["public"] and titles(VIEWER) == ["public", "secret"]


def test_search_is_scoped_and_skips_entity_nodes(w):
    from flags import seams
    hits = lambda u, q: [h["entity_id"] for h in seams.resolve_entity_search(w.s, "board_node", q, user=u)]  # noqa: E731
    assert hits(OUTSIDER, "mar") == []
    assert hits(VIEWER, "mar") == [str(w.frame.id)]
    assert hits(VIEWER, "worksheet") == [], "entity nodes are not board_node anchors"
    assert seams.resolve_entity_search(w.s, "board_node", "mar") == []
    lab = seams.resolve_entity_search(w.s, "board_node", "wel", user=OUTSIDER)[0]["label"]
    assert lab == "Org > Welcome"


def test_delete_rules_follow_open_flags(w):
    from boards import service as boards
    from flags import service as flags
    from flags import seams
    from flags.models import FlagFlag
    from groups.errors import ConflictError
    f = flags.create_flag(w.s, user=EDITOR, entity_type="board_node", entity_id=str(w.text.id),
                          type="task", title="open one")
    with pytest.raises(ConflictError, match="1 open flag"):
        boards.delete_node(w.s, EDITOR, "exec", w.text.id)
    with pytest.raises(ConflictError):
        boards.delete_board(w.s, ADMIN, "exec")
    w.s.execute(FlagFlag.__table__.update().where(FlagFlag.id == f.id).values(status="resolved"))
    w.s.commit()
    boards.delete_node(w.s, EDITOR, "exec", w.text.id)
    assert seams.resolve_context(w.s, "board_node", str(w.text.id)) is None
    assert seams.get_entity_spec("board_node").label(w.s, str(w.text.id)) == "Deleted board item"
    frame_id = w.frame.id  # captured while the row still exists; see report deviation #2
    boards.delete_board(w.s, ADMIN, "exec")
    assert w.s.get(type(w.frame), frame_id) is None
