"""User groups: tables, constraints, membership helper (spec §4.1, §4.2)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker


def _session():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_tables_created():
    s = _session()
    names = set(inspect(s.get_bind()).get_table_names())
    assert {"user_groups", "user_group_members"} <= names


def test_member_pair_is_unique():
    from sqlalchemy.exc import IntegrityError
    from groups.models import UserGroup, UserGroupMember
    s = _session()
    g = UserGroup(slug="exec", name="Exec")
    s.add(g)
    s.flush()
    s.add(UserGroupMember(group_id=g.id, user_id=7))
    s.commit()
    s.add(UserGroupMember(group_id=g.id, user_id=7))
    with pytest.raises(IntegrityError):
        s.commit()


def test_slug_is_unique():
    from sqlalchemy.exc import IntegrityError
    from groups.models import UserGroup
    s = _session()
    s.add(UserGroup(slug="exec", name="Exec"))
    s.commit()
    s.add(UserGroup(slug="exec", name="Exec again"))
    with pytest.raises(IntegrityError):
        s.commit()


def test_user_group_ids_reads_membership():
    from groups.access import user_group_ids
    from groups.models import UserGroup, UserGroupMember
    s = _session()
    a = UserGroup(slug="a", name="A")
    b = UserGroup(slug="b", name="B")
    s.add_all([a, b])
    s.flush()
    s.add_all([UserGroupMember(group_id=a.id, user_id=7),
               UserGroupMember(group_id=b.id, user_id=7),
               UserGroupMember(group_id=a.id, user_id=8)])
    s.commit()
    assert user_group_ids(s, SimpleNamespace(id=7)) == frozenset({a.id, b.id})
    assert user_group_ids(s, SimpleNamespace(id=8)) == frozenset({a.id})
    assert user_group_ids(s, SimpleNamespace(id=9)) == frozenset()
    assert user_group_ids(s, None) == frozenset()


def test_is_admin_reads_role():
    from groups.access import is_admin
    assert is_admin(SimpleNamespace(role="admin")) is True
    assert is_admin(SimpleNamespace(role="standard")) is False
    assert is_admin(None) is False
