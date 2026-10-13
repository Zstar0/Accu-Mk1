"""`board` as a flag entity type (spec 14, slice 4d): the board itself carries flags."""
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
    import documents.models  # noqa: F401  (list_flags visibility clauses join documents)
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
    note = BoardNode(board_id=org.id, kind="note", label="Welcome")
    s.add(note)
    s.commit()
    return SimpleNamespace(s=s, org=org, exec_=exec_, note=note)


def test_registered_with_must_exist(w):
    from flags import seams
    spec = seams.get_entity_spec("board")
    assert spec.must_exist is True
    assert spec.can_raise and spec.can_view and spec.visible_entity_ids and spec.search_scoped
    assert spec.descendants is None


def test_context_label_and_deep_link(w):
    from flags import seams
    ctx = seams.resolve_context(w.s, "board", str(w.exec_.id))
    assert ctx["label"] == "Exec"
    assert ctx["deep_link"] == {"kind": "board", "id": "exec"}
    assert ctx["board_slug"] == "exec"
    assert seams.resolve_context(w.s, "board", "999") is None
    assert seams.resolve_context(w.s, "board", "abc") is None
    assert seams.get_entity_spec("board").label(w.s, "999") == "Deleted board"
    assert seams.resolve_contexts(w.s, "board", [str(w.org.id), "999"]).keys() == {str(w.org.id)}


def test_can_raise_is_can_edit_board(w):
    from flags import seams
    spec = seams.get_entity_spec("board")
    eid = str(w.exec_.id)
    assert spec.can_raise(w.s, ADMIN, eid) is True
    assert spec.can_raise(w.s, EDITOR, eid) is True
    assert spec.can_raise(w.s, VIEWER, eid) is False
    assert spec.can_raise(w.s, OUTSIDER, eid) is False   # invisible: never confirmed
    assert spec.can_raise(w.s, EDITOR, "999") is False


def test_can_view_follows_the_board(w):
    from flags import seams
    spec = seams.get_entity_spec("board")
    assert [spec.can_view(w.s, u, str(w.exec_.id)) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER)] == \
        [True, True, True, False]
    assert [spec.can_view(w.s, u, str(w.org.id)) for u in (VIEWER, OUTSIDER)] == [True, True]
    assert spec.can_view(w.s, OUTSIDER, "999") is False and spec.can_view(w.s, ADMIN, "999") is True


def test_visible_entity_ids_and_clause(w):
    from flags import seams, service as flags
    from flags.models import FlagFlag
    spec = seams.get_entity_spec("board")
    assert spec.visible_entity_ids(w.s, ADMIN) is None
    ids = set(w.s.execute(spec.visible_entity_ids(w.s, OUTSIDER)).scalars().all())
    assert ids == {str(w.org.id)}
    flags.create_flag(w.s, user=EDITOR, entity_type="board", entity_id=str(w.exec_.id), type="task", title="exec task")
    flags.create_flag(w.s, user=EDITOR, entity_type="board", entity_id=str(w.org.id), type="task", title="org task")
    seen = {f.title for f in flags.list_flags(w.s, user_id=OUTSIDER.id, tab="all_open", user=OUTSIDER)}
    assert "org task" in seen and "exec task" not in seen


def test_audience_and_snapshot(w):
    from flags import seams
    spec = seams.get_entity_spec("board")
    assert spec.audience(w.s, str(w.org.id)) is None
    aud = spec.audience(w.s, str(w.exec_.id))
    assert set(aud["groups"]) == {g.id for g in w.s.execute(select(__import__("groups.models", fromlist=["UserGroup"]).UserGroup)).scalars()}
    assert spec.audience(w.s, "999") == {"groups": []}
    assert spec.snapshot(w.s, str(w.exec_.id)) == {"board": "exec"}


def test_search_is_scoped_to_visible_boards(w):
    from flags import seams
    hits = seams.resolve_entity_search(w.s, "board", "e", user=OUTSIDER)
    assert [h["label"] for h in hits] == []   # "Exec" hidden, "Org" does not match "e" as a prefix
    hits = seams.resolve_entity_search(w.s, "board", "ex", user=VIEWER)
    assert [(h["entity_id"], h["label"]) for h in hits] == [(str(w.exec_.id), "Exec")]


def test_delete_board_counts_board_level_flags(w):
    from boards import service as boards
    from flags import service as flags
    from flags.models import FlagFlag
    from groups.errors import ConflictError
    f = flags.create_flag(w.s, user=EDITOR, entity_type="board", entity_id=str(w.org.id), type="task", title="t")
    assert boards.open_board_flag_count(w.s, w.org.id) == 1
    with pytest.raises(ConflictError, match="1 open flag"):
        boards.delete_board(w.s, ADMIN, "org")
    w.s.execute(FlagFlag.__table__.update().where(FlagFlag.id == f.id).values(status="resolved"))
    w.s.commit()
    boards.delete_board(w.s, ADMIN, "org")
    assert w.s.get(type(w.org), w.org.id) is None
