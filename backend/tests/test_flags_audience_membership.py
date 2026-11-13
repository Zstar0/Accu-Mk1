"""Audience + membership seams for the SSE stream and the target guards (spec §6.4, §14)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", is_active=True)
INACTIVE_ADMIN = SimpleNamespace(id=2, role="admin", is_active=False)
MEMBER = SimpleNamespace(id=10, role="standard", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", is_active=True)


@pytest.fixture
def w():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    import flags.models  # noqa: F401
    from boards.models import Board, BoardGrant, BoardNode
    from groups.models import UserGroup, UserGroupMember
    from models import User
    from flags import seams, types_service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for u in (ADMIN, INACTIVE_ADMIN, MEMBER, OUTSIDER):
        s.add(User(id=u.id, email=f"u{u.id}@x.t", hashed_password="x", role=u.role, is_active=u.is_active))
    types_service.seed_builtins(s)
    seams.register_mk1_entities()
    g = UserGroup(slug="exec", name="Exec")
    org = Board(slug="org", name="Org")
    exec_ = Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([g, org, exec_])
    s.flush()
    s.add_all([UserGroupMember(group_id=g.id, user_id=MEMBER.id),
               BoardGrant(board_id=exec_.id, group_id=g.id, can_edit=True)])
    pub = BoardNode(board_id=org.id, kind="frame", label="Public")
    sec = BoardNode(board_id=exec_.id, kind="frame", label="Secret")
    s.add_all([pub, sec])
    s.commit()
    return SimpleNamespace(s=s, g=g, pub=pub, sec=sec)


def test_audience_follows_the_board(w):
    from flags import seams
    assert seams.resolve_audience(w.s, "board_node", str(w.pub.id)) is None
    assert seams.resolve_audience(w.s, "board_node", str(w.sec.id)) == {"groups": [w.g.id]}
    assert seams.resolve_audience(w.s, "board_node", "999") == {"groups": []}, "orphan: admins only"
    assert seams.resolve_audience(w.s, "sample", "P-1") is None
    assert seams.resolve_audience(w.s, None, None) is None


def test_audience_fails_closed_when_the_closure_raises(w):
    from flags import seams
    spec = seams.get_entity_spec("board_node")

    def boom(db, eid):
        raise RuntimeError("boom")
    seams.register_entity("thing", label=spec.label, deep_link=spec.deep_link, can_flag=spec.can_flag,
                          audience=boom)
    try:
        assert seams.resolve_audience(w.s, "thing", "1") == {"groups": []}
    finally:
        seams._REGISTRY.pop("thing", None)


def test_load_user_returns_the_row_or_none(w):
    from flags import seams
    assert seams.load_user(w.s, MEMBER.id).email == "u10@x.t"
    assert seams.load_user(w.s, 999) is None
    assert seams.load_user(w.s, None) is None


def test_membership_resolver_is_host_registered(w):
    from flags import seams
    gids, adm = seams.resolve_membership(w.s, MEMBER)
    assert gids == frozenset({w.g.id}) and adm is False
    gids, adm = seams.resolve_membership(w.s, OUTSIDER)
    assert gids == frozenset() and adm is False
    gids, adm = seams.resolve_membership(w.s, ADMIN)
    assert adm is True


def test_inactive_admin_is_not_admin_for_membership(w):
    """Review Focus 3 (closes slice 1's deferred T4 cell)."""
    from flags import seams
    _, adm = seams.resolve_membership(w.s, INACTIVE_ADMIN)
    assert adm is False


def test_membership_default_without_resolver():
    from flags import seams
    saved = seams._MEMBERSHIP_RESOLVER
    seams.set_membership_resolver(None)
    try:
        assert seams.resolve_membership(None, ADMIN) == (frozenset(), True)
        assert seams.resolve_membership(None, INACTIVE_ADMIN) == (frozenset(), False)
        assert seams.resolve_membership(None, MEMBER) == (frozenset(), False)
    finally:
        seams.set_membership_resolver(saved)


# --- fix round 1 item 1: inactive users carry no group authority -----------
def test_inactive_user_group_membership_row_does_not_count(w):
    """groups/access.py user_group_ids is the one place every caller (board
    grants, the SSE membership resolver, the recurring/watches actor fallbacks)
    consults for group ids. Deactivation does not delete the membership row, so
    this must be checked here rather than trusted to every caller."""
    from groups.access import user_group_ids
    from groups.models import UserGroupMember
    w.s.add(UserGroupMember(group_id=w.g.id, user_id=INACTIVE_ADMIN.id))
    w.s.commit()
    assert user_group_ids(w.s, INACTIVE_ADMIN) == frozenset()


def test_is_view_scoped(w):
    from flags import seams
    assert seams.is_view_scoped("board_node") is True
    assert seams.is_view_scoped("sample") is False
    assert seams.is_view_scoped(None) is False
    assert seams.is_view_scoped("nope") is False
