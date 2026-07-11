"""handle_event: plan -> resolve member id -> post. Uses a fake client + sqlite."""
import asyncio
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base
from models import SlackDmPrefs, User
from flags.models import FlagFlag
from slack_notify.notifier import SlackNotifier


class FakeClient:
    def __init__(self):
        self.posted = []
        self.lookups = []
    async def lookup_by_email(self, email):
        self.lookups.append(email)
        return "U-FROM-EMAIL" if email == "two@lab.com" else None
    async def user_info(self, member_id):
        return "Forrest (fake)"
    async def user_profile(self, member_id):
        from slack_notify.client import SlackProfile
        return SlackProfile("Forrest (fake)",
                            "https://avatars.slack-edge.com/fake_72.png")
    async def open_dm(self, member_id):
        return f"D-{member_id}"
    async def post_dm(self, channel, text, blocks):
        self.posted.append((channel, text))
        return True


@pytest.fixture()
def session_factory():
    # StaticPool: one shared connection across threads — handle_event touches
    # the DB from asyncio.to_thread, and per-thread connections would each see
    # their own empty in-memory database.
    engine = create_engine("sqlite://",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _seed(Session, *, prefs_member=None):
    db = Session()
    db.add(User(id=1, email="one@lab.com", hashed_password="x"))
    db.add(User(id=2, email="two@lab.com", hashed_password="x"))
    if prefs_member:
        db.add(SlackDmPrefs(user_id=2, slack_member_id=prefs_member))
    f = FlagFlag(entity_type="sample", entity_id="P-1", kind="issue",
                 type="blocker", status="open", title="t", created_by=1,
                 assignee_id=2)
    db.add(f)
    db.commit()
    fid = f.id
    db.close()
    return fid


def _event(fid):
    return {"event_type": "assigned", "flag_id": fid, "actor_id": 1,
            "from_value": None, "to_value": "2", "details": {}, "event_id": 5,
            "flag": {"id": fid, "title": "t", "type": "blocker", "kind": "issue",
                     "status": "open", "entity_type": "sample", "entity_id": "P-1",
                     "assignee_id": 2, "created_by": 1}}


def test_email_lookup_caches_member_id_and_posts(session_factory):
    fid = _seed(session_factory)
    fake = FakeClient()
    n = SlackNotifier(fake, session_factory, "https://mk1.example")
    sent = asyncio.run(n.handle_event(_event(fid)))
    assert sent == 1
    assert fake.posted and fake.posted[0][0] == "D-U-FROM-EMAIL"
    db = session_factory()
    row = db.query(SlackDmPrefs).filter_by(user_id=2).one()
    assert row.slack_member_id == "U-FROM-EMAIL"
    # The auto-link also caches WHO it resolved to — surfaced in the prefs UI
    # so users can confirm the mapping hit the right Slack account.
    assert row.slack_display_name == "Forrest (fake)"
    # The avatar is captured in the same users.info touchpoint as the name.
    assert row.slack_avatar_url == "https://avatars.slack-edge.com/fake_72.png"
    db.close()


def test_manual_member_id_skips_lookup(session_factory):
    fid = _seed(session_factory, prefs_member="U-MANUAL")
    fake = FakeClient()
    n = SlackNotifier(fake, session_factory, "https://mk1.example")
    asyncio.run(n.handle_event(_event(fid)))
    assert fake.lookups == []
    assert fake.posted[0][0] == "D-U-MANUAL"


def test_alias_domain_fallback_resolves_and_caches(session_factory):
    # Login email misses; the same local-part on an alias domain hits.
    db = session_factory()
    db.add(User(id=1, email="one@lab.com", hashed_password="x"))
    db.add(User(id=7, email="nova@valence.test", hashed_password="x"))
    f = FlagFlag(entity_type="sample", entity_id="P-1", kind="issue",
                 type="blocker", status="open", title="t", created_by=1,
                 assignee_id=7)
    db.add(f)
    db.commit()
    fid = f.id
    db.close()

    class AliasFake(FakeClient):
        async def lookup_by_email(self, email):
            self.lookups.append(email)
            return "U-ALT" if email == "nova@accumark.test" else None

    fake = AliasFake()
    n = SlackNotifier(fake, session_factory, "https://mk1.example",
                      alias_domains=["valence.test", "accumark.test"])
    ev = _event(fid)
    ev["to_value"] = "7"
    sent = asyncio.run(n.handle_event(ev))
    assert sent == 1
    assert fake.posted[0][0] == "D-U-ALT"
    assert fake.lookups == ["nova@valence.test", "nova@accumark.test"]
    db = session_factory()
    assert db.query(SlackDmPrefs).filter_by(user_id=7).one().slack_member_id == "U-ALT"
    db.close()


def test_unresolvable_user_is_skipped_silently(session_factory):
    fid = _seed(session_factory)
    db = session_factory()
    db.query(User).filter_by(id=2).update({"email": "unknown@lab.com"})
    db.commit(); db.close()
    fake = FakeClient()
    n = SlackNotifier(fake, session_factory, "https://mk1.example")
    assert asyncio.run(n.handle_event(_event(fid))) == 0
    assert fake.posted == []
