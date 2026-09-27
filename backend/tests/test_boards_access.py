"""Access matrix (spec §5). Invisible = NotFoundError; visible-not-editable = PermissionDeniedError."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

ADMIN = SimpleNamespace(id=1, role="admin", is_active=True)
EDITOR = SimpleNamespace(id=10, role="standard", is_active=True)
VIEWER = SimpleNamespace(id=11, role="standard", is_active=True)
OUTSIDER = SimpleNamespace(id=12, role="standard", is_active=True)
INACTIVE = SimpleNamespace(id=13, role="standard", is_active=False)


@pytest.fixture
def world():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    from boards.models import Board, BoardGrant
    from groups.models import UserGroup, UserGroupMember
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    editors, viewers = UserGroup(slug="editors", name="E"), UserGroup(slug="viewers", name="V")
    company, secret = Board(slug="org", name="Org"), Board(slug="exec", name="Exec", visibility="restricted")
    s.add_all([editors, viewers, company, secret])
    s.flush()
    s.add_all([UserGroupMember(group_id=editors.id, user_id=EDITOR.id),
               UserGroupMember(group_id=viewers.id, user_id=VIEWER.id),
               UserGroupMember(group_id=viewers.id, user_id=INACTIVE.id),
               BoardGrant(board_id=secret.id, group_id=editors.id, can_edit=True),
               BoardGrant(board_id=secret.id, group_id=viewers.id, can_edit=False),
               BoardGrant(board_id=company.id, group_id=editors.id, can_edit=True)])
    s.commit()
    return SimpleNamespace(s=s, company=company, secret=secret, viewers=viewers)


def test_view_matrix(world):
    from boards.access import can_view_board as v
    s = world.s
    assert [v(s, u, world.company) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER, INACTIVE)] == \
        [True, True, True, True, False]
    assert [v(s, u, world.secret) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER, INACTIVE)] == \
        [True, True, True, False, False]
    assert v(s, None, world.company) is False


def test_edit_matrix(world):
    from boards.access import can_edit_board as e
    s = world.s
    assert [e(s, u, world.company) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER)] == [True, True, False, False]
    assert [e(s, u, world.secret) for u in (ADMIN, EDITOR, VIEWER, OUTSIDER)] == [True, True, False, False]


def test_visible_board_ids(world):
    from boards.access import visible_board_ids
    s = world.s
    ids = lambda u: set(s.execute(visible_board_ids(s, u)).scalars().all())  # noqa: E731
    both = {world.company.id, world.secret.id}
    assert ids(ADMIN) == both and ids(EDITOR) == both and ids(VIEWER) == both
    assert ids(OUTSIDER) == {world.company.id}
    assert ids(INACTIVE) == set()


def test_require_helpers_map_to_errors(world):
    from boards.access import require_edit, require_view
    from groups.errors import NotFoundError, PermissionDeniedError
    s = world.s
    require_view(s, VIEWER, world.secret)
    with pytest.raises(NotFoundError):
        require_view(s, OUTSIDER, world.secret)
    with pytest.raises(NotFoundError):
        require_edit(s, OUTSIDER, world.secret)
    with pytest.raises(PermissionDeniedError):
        require_edit(s, VIEWER, world.secret)
    require_edit(s, EDITOR, world.secret)


def test_visibility_reads_membership_live(world):
    """A user pulled from every group loses access on the next call, same session,
    same user object, no re-login (Review Focus 1)."""
    from boards.access import can_view_board
    from groups.models import UserGroupMember
    s = world.s
    assert can_view_board(s, VIEWER, world.secret) is True
    s.query(UserGroupMember).filter(UserGroupMember.user_id == VIEWER.id).delete()
    s.commit()
    assert can_view_board(s, VIEWER, world.secret) is False
