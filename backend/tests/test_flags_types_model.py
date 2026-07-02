"""Schema round-trip tests for the flag_types catalog table + blocked status.

Runs on SQLite (Base.metadata.create_all) — note this means the Postgres-only
status CHECK constraint does NOT exist here, so the `status="blocked"` assertion
proves the ORM/column accept it, NOT that the live Postgres CHECK was extended
(that is verified over the wire against the live stack in Plan 5 Task 9)."""
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def session():
    from database import Base
    import models  # noqa: F401  (register FlagType on Base)
    import flags.models  # noqa: F401  (register flag_flags on Base)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_flag_type_roundtrip(session):
    from models import FlagType

    ft = FlagType(
        slug="custom_review", label="Custom Review", color="#abcdef",
        kind="issue", is_blocking=True, is_active=True, sort_order=7,
        entity_types=["sub_sample", "worksheet"], is_builtin=False,
    )
    session.add(ft)
    session.commit()

    got = session.query(FlagType).filter_by(slug="custom_review").one()
    assert got.label == "Custom Review"
    assert got.color == "#abcdef"
    assert got.kind == "issue"
    assert got.is_blocking is True
    assert got.is_active is True
    assert got.sort_order == 7
    assert got.entity_types == ["sub_sample", "worksheet"]
    assert got.is_builtin is False
    assert isinstance(got.created_at, datetime)


def test_flag_type_defaults(session):
    """is_active defaults true, is_blocking/is_builtin false, entity_types []."""
    from models import FlagType

    ft = FlagType(slug="minimal", label="Minimal", color="#111111", kind="signal")
    session.add(ft)
    session.commit()

    got = session.query(FlagType).filter_by(slug="minimal").one()
    assert got.is_active is True
    assert got.is_blocking is False
    assert got.is_builtin is False
    assert got.entity_types == []
    assert got.sort_order == 0


def test_slug_is_unique(session):
    from sqlalchemy.exc import IntegrityError
    from models import FlagType

    session.add(FlagType(slug="dup", label="A", color="#000000", kind="issue"))
    session.commit()
    session.add(FlagType(slug="dup", label="B", color="#000000", kind="issue"))
    with pytest.raises(IntegrityError):
        session.commit()


def test_flag_flags_accepts_blocked_status(session):
    """The ORM/column accept status='blocked'. (The Postgres CHECK extension is
    verified in the live stack — see module docstring.)"""
    from flags.models import FlagFlag

    flag = FlagFlag(
        entity_type="sub_sample", entity_id="123",
        kind="issue", type="blocker", status="blocked",
        title="Awaiting reagent", created_by=42,
    )
    session.add(flag)
    session.commit()

    got = session.get(FlagFlag, flag.id)
    assert got.status == "blocked"
