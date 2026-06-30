"""Schema round-trip tests for the flags module (SQLite)."""
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def session():
    from database import Base
    import flags.models  # noqa: F401  (register tables on Base)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_flag_roundtrip_with_children(session):
    from flags.models import FlagFlag, FlagComment, FlagParticipant, FlagEvent

    flag = FlagFlag(
        entity_type="sub_sample", entity_id="123",
        kind="issue", type="blocker", status="open",
        title="Crashed out", created_by=42,
    )
    session.add(flag)
    session.flush()

    session.add(FlagComment(flag_id=flag.id, author_id=42, body="cloudy", audience="internal"))
    session.add(FlagParticipant(flag_id=flag.id, user_id=7, role="watcher", added_by=42))
    session.add(FlagEvent(flag_id=flag.id, actor_id=42, event_type="raised",
                          from_value=None, to_value="open", details={"type": "blocker"}))
    session.commit()

    got = session.get(FlagFlag, flag.id)
    assert got.status == "open"
    assert got.title == "Crashed out"
    assert len(session.query(FlagComment).all()) == 1
    assert session.query(FlagEvent).first().details == {"type": "blocker"}
    assert session.query(FlagParticipant).first().role == "watcher"
