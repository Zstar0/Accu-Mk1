import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import hashlib, hmac, json
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

SECRET = "shhh"


class FakeClient:
    def __init__(self):
        self.updates = []
    async def update_message(self, channel, ts, text, blocks):
        self.updates.append((channel, ts, blocks))
        return True


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    from database import get_db, Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from models import User, SlackDmPrefs
    from flags.models import FlagFlag

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    shared.add(User(id=5, email="a@x.t", hashed_password="x", role="standard"))
    shared.add(SlackDmPrefs(user_id=5, slack_member_id="U5"))
    shared.add(FlagFlag(id=1, entity_type="sample", entity_id="P-1", kind="issue",
                        type="blocker", status="open", title="t", created_by=5))
    shared.commit()

    monkeypatch.setenv("SLACK_SIGNING_SECRET", SECRET)
    monkeypatch.setenv("MK1_SLACK_BOT_TOKEN", "xoxb-test")
    fake = FakeClient()
    import slack_notify.interactions as inter
    monkeypatch.setattr(inter, "_client", lambda: fake)
    # The test signs with ts="1000"; pin the verifier's clock so it's in-window.
    monkeypatch.setattr(inter.time, "time", lambda: 1000)
    # interactions uses SessionLocal directly for its worker session:
    import database
    monkeypatch.setattr(database, "SessionLocal", Session)

    app.dependency_overrides[get_db] = lambda: iter([shared])
    tc = TestClient(app)
    tc.fake = fake  # type: ignore[attr-defined]
    tc.session = shared  # type: ignore[attr-defined]
    yield tc
    app.dependency_overrides.pop(get_db, None)
    shared.close()


def _post(tc, payload):
    body = urlencode({"payload": json.dumps(payload)})
    ts = "1000"
    sig = "v0=" + hmac.new(SECRET.encode(), f"v0:{ts}:{body}".encode(),
                           hashlib.sha256).hexdigest()
    return tc.post("/api/slack/interactions", content=body,
                   headers={"X-Slack-Request-Timestamp": ts,
                            "X-Slack-Signature": sig,
                            "Content-Type": "application/x-www-form-urlencoded"})


def _payload(action_id, flag_id=1, member="U5"):
    return {"type": "block_actions", "user": {"id": member},
            "channel": {"id": "D5"}, "message": {"ts": "111.222", "text": "t",
            "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "t"}}]},
            "actions": [{"action_id": action_id, "value": str(flag_id)}]}


def test_assign_to_me_assigns_and_updates(client):
    r = _post(client, _payload("flag_assign_me"))
    assert r.status_code == 200
    from flags.models import FlagFlag
    assert client.session.get(FlagFlag, 1).assignee_id == 5
    assert client.fake.updates and "Assigned to you" in str(client.fake.updates[-1][2])


def test_resolve_routes_through_service(client):
    r = _post(client, _payload("flag_resolve"))
    assert r.status_code == 200
    from flags.models import FlagFlag
    assert client.session.get(FlagFlag, 1).status == "resolved"


def test_unmapped_member_prompts_to_link(client):
    r = _post(client, _payload("flag_mark_read", member="U-UNKNOWN"))
    assert r.status_code == 200
    assert "Preferences" in str(client.fake.updates[-1][2])


def test_bad_signature_401(client):
    body = urlencode({"payload": json.dumps(_payload("flag_mark_read"))})
    r = client.post("/api/slack/interactions", content=body,
                    headers={"X-Slack-Request-Timestamp": "1000",
                             "X-Slack-Signature": "v0=deadbeef",
                             "Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 401


def test_disabled_when_secret_unset(client, monkeypatch):
    monkeypatch.delenv("SLACK_SIGNING_SECRET", raising=False)
    r = _post(client, _payload("flag_mark_read"))
    assert r.status_code == 404
