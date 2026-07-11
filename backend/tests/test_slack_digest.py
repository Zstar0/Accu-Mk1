import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import asyncio
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


class FakeClient:
    def __init__(self):
        self.posted = []
    async def open_dm(self, member_id):
        return f"D-{member_id}"
    async def post_dm(self, channel, text, blocks):
        self.posted.append((channel, text))
        return True


@pytest.fixture
def session_factory():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _seed(Session, *, hour=8, enabled=True, member="U1", overdue=True):
    from models import User, SlackDmPrefs
    from flags.models import FlagFlag
    db = Session()
    db.add(User(id=1, email="a@x.t", hashed_password="x"))
    db.add(SlackDmPrefs(user_id=1, slack_member_id=member,
                        digest_enabled=enabled, digest_hour=hour))
    due = datetime(2026, 7, 1) if overdue else None
    db.add(FlagFlag(entity_type="sample", entity_id="P-1", kind="issue",
                    type="blocker", status="open", title="Old one", created_by=1,
                    assignee_id=1, due_at=due))
    db.commit(); db.close()


def test_due_targets_hour_and_dedup(session_factory):
    from slack_notify import digest
    _seed(session_factory)
    db = session_factory()
    now_local = datetime(2026, 7, 9, 8, 30)          # hour 8 matches
    targets = digest.due_targets(db, now_local=now_local)
    assert [t[0] for t in targets] == [1]
    # after a send today, the same day dedups
    from models import SlackDmPrefs
    db.query(SlackDmPrefs).filter_by(user_id=1).update(
        {"last_digest_date": date(2026, 7, 9)})
    db.commit()
    assert digest.due_targets(db, now_local=now_local) == []
    db.close()


def test_wrong_hour_skipped(session_factory):
    from slack_notify import digest
    _seed(session_factory, hour=9)
    db = session_factory()
    assert digest.due_targets(db, now_local=datetime(2026, 7, 9, 8, 30)) == []
    db.close()


def test_empty_digest_skipped(session_factory):
    from slack_notify import digest
    _seed(session_factory, overdue=False)            # no overdue; still has 1 assigned-open
    db = session_factory()
    # assigned-open>0 => NOT empty; make it empty by resolving the only flag
    from flags.models import FlagFlag
    db.query(FlagFlag).update({"status": "resolved"})
    db.commit()
    assert digest.due_targets(db, now_local=datetime(2026, 7, 9, 8, 30)) == []
    db.close()


def test_run_sends_and_stamps(session_factory):
    from slack_notify import digest
    from models import SlackDmPrefs
    _seed(session_factory)
    fake = FakeClient()
    asyncio.run(digest.run(session_factory, fake, "https://mk1.example",
                           now=datetime(2026, 7, 9, 8, 30)))   # UTC hour 8
    assert fake.posted and fake.posted[0][0] == "D-U1"
    db = session_factory()
    assert db.query(SlackDmPrefs).filter_by(user_id=1).one().last_digest_date \
        == date(2026, 7, 9)
    db.close()
