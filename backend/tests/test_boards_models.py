"""Boards tables and constraints (spec §4.3 to §4.6)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker


def _session():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import boards.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_tables_created():
    s = _session()
    names = set(inspect(s.get_bind()).get_table_names())
    assert {"board_boards", "board_grants", "board_nodes", "board_edges"} <= names


def test_visibility_and_kind_are_checked():
    from sqlalchemy.exc import IntegrityError
    from boards.models import Board
    s = _session()
    s.add(Board(slug="a", name="A", kind="map", visibility="secret"))
    with pytest.raises(IntegrityError):
        s.commit()
    s.rollback()
    s.add(Board(slug="a", name="A", kind="poster", visibility="company"))
    with pytest.raises(IntegrityError):
        s.commit()
    s.rollback()
    s.add(Board(slug="a", name="A"))
    s.commit()
    b = s.query(Board).one()
    assert (b.kind, b.visibility) == ("custom", "company")


def test_grant_pair_unique():
    from sqlalchemy.exc import IntegrityError
    from boards.models import Board, BoardGrant
    from groups.models import UserGroup
    s = _session()
    b, g = Board(slug="a", name="A"), UserGroup(slug="exec", name="Exec")
    s.add_all([b, g])
    s.flush()
    s.add(BoardGrant(board_id=b.id, group_id=g.id))
    s.commit()
    s.add(BoardGrant(board_id=b.id, group_id=g.id, can_edit=True))
    with pytest.raises(IntegrityError):
        s.commit()


def test_node_defaults_and_edge_uniqueness():
    from sqlalchemy.exc import IntegrityError
    from boards.models import Board, BoardEdge, BoardNode
    s = _session()
    b = Board(slug="a", name="A")
    s.add(b)
    s.flush()
    n1, n2 = BoardNode(board_id=b.id, kind="frame", label="F"), BoardNode(board_id=b.id, kind="text", label="T")
    s.add_all([n1, n2])
    s.commit()
    assert (n1.version, n1.z, n1.x, n1.y, n1.parent_id) == (1, 0, 0.0, 0.0, None)
    s.add(BoardEdge(board_id=b.id, source_id=n1.id, target_id=n2.id, kind="related"))
    s.commit()
    s.add(BoardEdge(board_id=b.id, source_id=n1.id, target_id=n2.id, kind="related"))
    with pytest.raises(IntegrityError):
        s.commit()
    s.rollback()
    s.add(BoardEdge(board_id=b.id, source_id=n1.id, target_id=n2.id, kind="teleport"))
    with pytest.raises(IntegrityError):
        s.commit()
