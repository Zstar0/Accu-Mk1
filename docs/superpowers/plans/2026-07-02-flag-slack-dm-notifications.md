# Flag Slack DM Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror flag toast notifications as Slack DMs via an env-gated bus subscriber, with per-user category preferences configurable in the Preferences → Flags pane.

**Architecture:** Host-side `backend/slack_notify/` package subscribes to the existing `flags/bus.py` `BUS` (post-commit event feed). Per event it plans recipients server-side (assignee/creator/mentioned/watchers minus actor, filtered by a new `slack_dm_prefs` table), resolves Slack member ids (email lookup with cached/manual override), and fire-and-forgets Block Kit DMs via `httpx`. The flags module stays plugin-pure — it never imports slack_notify.

**Tech Stack:** FastAPI + SQLAlchemy (create_all for the new table), httpx (already a backend dep), asyncio bus subscription; React 19 + TanStack Query + shadcn for the prefs UI.

**Spec:** `docs/superpowers/specs/2026-07-02-flag-slack-dm-notifications-design.md`

## Global Constraints

- Branch `feat/flag-slack-dm` (off master `06044d7`+). Laptop edit surface `C:/tmp/flag-ui` (no node_modules) — all checks run in the isolated devbox stack (Task 0).
- **SYNC** = laptop `git push`, then `ssh forrestparker@100.73.137.3 'cd ~/worktrees/Accu-Mk1-slackdm && git fetch -q && git reset --hard -q origin/feat/flag-slack-dm'`.
- **BE-TEST** = `ssh … 'cd ~/worktrees/Accu-Mk1-slackdm && docker compose -p accumark-slackdm exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_slack_notify*.py -q" </dev/null'` (restart backend after schema/route changes: `docker compose -p accumark-slackdm restart accu-mk1-backend`).
- **FE-TEST / TYPECHECK / BUILD** = same exec shape against `accu-mk1-frontend` with `npx vitest run <paths>` / `npm run typecheck` / `npm run build`.
- Env gate: the entire feature is dormant unless `MK1_SLACK_BOT_TOKEN` is set. Never log the token. Deep-link base = `MK1_PUBLIC_URL`, default `https://accumk1.valenceanalytical.com`.
- Event types on the bus: `raised`, `assigned`, `unassigned`, `commented`, `watcher_added`, `watcher_removed`, `status_changed`. Event dict: `{event_type, flag_id, actor_id, from_value, to_value, details, event_id, flag:{id,title,type,kind,status,entity_type,entity_id,assignee_id,created_by}}`.
- Category resolution order (first match wins, one DM per event per user): assigned → mentioned → raised_activity (creator) → watching_activity (participant) → status_changes (assignee). `raised`/`unassigned`/`watcher_*` events never DM.
- No Slack SDK. No new pip deps. Slack failures log-and-drop; never raise into flag ops.
- `npm run check:all` aggregate is red at baseline — gate on typecheck + targeted vitest + targeted pytest + build only.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 0: Dev stack + spec amendment

**Files:**
- Modify: `docs/superpowers/specs/2026-07-02-flag-slack-dm-notifications-design.md` (deep-link line)

- [ ] **Step 1:** Amend the spec's deep-link paragraph: replace the sentence containing `#flags?open=<id>` with:

```markdown
Add a `flag` query param to the existing `#section/subsection?…` hash scheme:
`applyNavToStore` in `src/lib/hash-navigation.ts` reads `?flag=<id>` on
load/back-forward and calls `openFlagThread(id)`. Slack messages link to
`{MK1_PUBLIC_URL}/#dashboard/orders?flag=<id>`.
```

- [ ] **Step 2:** Commit (`docs(flags): deep link is ?flag= on the standard hash scheme`).

- [ ] **Step 3:** Spin up the isolated stack — invoke the `accumark-stack-platform` skill; create devbox worktree `~/worktrees/Accu-Mk1-slackdm` on `feat/flag-slack-dm` and stack `slackdm` mounted on it. Verify backend + frontend containers healthy, then run one no-op BE-TEST (`pytest tests/test_flags_service.py -q`) to prove the loop.

---

### Task 1: `SlackDmPrefs` model + DM planner

**Files:**
- Modify: `backend/models.py` (append model)
- Create: `backend/slack_notify/__init__.py` (empty)
- Create: `backend/slack_notify/planner.py`
- Test: `backend/tests/test_slack_notify_planner.py`

**Interfaces:**
- Produces: `SlackDmPrefs` ORM model (table `slack_dm_prefs`); `PlannedDM(user_id: int, category: str)` dataclass; `plan_dms(db, event: dict) -> list[PlannedDM]`; `DEFAULTS: dict[str, bool]` (all five categories True).

- [ ] **Step 1: Write the failing planner test**

`backend/tests/test_slack_notify_planner.py`:

```python
"""plan_dms: recipient + category planning for Slack DMs (pure DB logic)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import SlackDmPrefs
from flags.models import FlagFlag, FlagParticipant
from slack_notify.planner import plan_dms, PlannedDM


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def _flag(db, *, created_by=1, assignee_id=None, watchers=()):
    f = FlagFlag(entity_type="sample", entity_id="P-1", kind="issue",
                 type="blocker", status="open", title="t", created_by=created_by,
                 assignee_id=assignee_id)
    db.add(f)
    db.flush()
    for uid in watchers:
        db.add(FlagParticipant(flag_id=f.id, user_id=uid))
    db.commit()
    return f


def _event(f, event_type, actor_id, *, to_value=None, details=None):
    return {"event_type": event_type, "flag_id": f.id, "actor_id": actor_id,
            "from_value": None, "to_value": to_value, "details": details or {},
            "event_id": 1,
            "flag": {"id": f.id, "title": f.title, "type": f.type, "kind": f.kind,
                     "status": f.status, "entity_type": f.entity_type,
                     "entity_id": f.entity_id, "assignee_id": f.assignee_id,
                     "created_by": f.created_by}}


def test_assigned_dms_the_assignee_only(db):
    f = _flag(db, created_by=1, assignee_id=2)
    out = plan_dms(db, _event(f, "assigned", actor_id=1, to_value="2"))
    assert out == [PlannedDM(user_id=2, category="assigned")]


def test_actor_is_never_dmed(db):
    f = _flag(db, created_by=1, assignee_id=1)
    assert plan_dms(db, _event(f, "assigned", actor_id=1, to_value="1")) == []


def test_raised_never_dms(db):
    f = _flag(db, created_by=1, assignee_id=2)
    assert plan_dms(db, _event(f, "raised", actor_id=1, to_value="open")) == []


def test_comment_mention_beats_watcher_category(db):
    f = _flag(db, created_by=1, watchers=(3,))
    out = plan_dms(db, _event(f, "commented", actor_id=2,
                              details={"mentions": [3]}))
    assert PlannedDM(user_id=3, category="mentioned") in out
    # creator gets raised_activity
    assert PlannedDM(user_id=1, category="raised_activity") in out
    assert len(out) == 2


def test_comment_watcher_gets_watching_activity(db):
    f = _flag(db, created_by=1, watchers=(4,))
    out = plan_dms(db, _event(f, "commented", actor_id=1))
    assert out == [PlannedDM(user_id=4, category="watching_activity")]


def test_status_change_creator_watcher_assignee(db):
    f = _flag(db, created_by=1, assignee_id=5, watchers=(4,))
    out = plan_dms(db, _event(f, "status_changed", actor_id=9,
                              to_value="resolved"))
    assert PlannedDM(user_id=1, category="raised_activity") in out
    assert PlannedDM(user_id=4, category="watching_activity") in out
    assert PlannedDM(user_id=5, category="status_changes") in out


def test_prefs_filter_disabled_master_and_category(db):
    f = _flag(db, created_by=1, watchers=(4, 6))
    db.add(SlackDmPrefs(user_id=4, enabled=False))
    db.add(SlackDmPrefs(user_id=6, notify_watching_activity=False))
    db.commit()
    assert plan_dms(db, _event(f, "commented", actor_id=1)) == []


def test_absent_prefs_row_means_defaults_on(db):
    f = _flag(db, created_by=1, watchers=(4,))
    out = plan_dms(db, _event(f, "commented", actor_id=1))
    assert out == [PlannedDM(user_id=4, category="watching_activity")]
```

- [ ] **Step 2:** SYNC, BE-TEST → expect FAIL (`ModuleNotFoundError: slack_notify` / no `SlackDmPrefs`). Commit the test first (`test(slack): planner tests (RED)`).

- [ ] **Step 3: Model** — append to `backend/models.py` (after the last model, following file style):

```python
class SlackDmPrefs(Base):
    """Per-user Slack DM notification preferences for the flag system.

    Absent row = all defaults (enabled, every category on). slack_member_id is
    cached from users.lookupByEmail or pasted manually in Preferences.
    """
    __tablename__ = "slack_dm_prefs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    slack_member_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    notify_assigned: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notify_mentioned: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notify_raised_activity: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notify_watching_activity: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notify_status_changes: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)
```

(`create_all` creates the table on startup — new tables need no hand-rolled migration.)

- [ ] **Step 4: Planner** — `backend/slack_notify/planner.py`:

```python
"""Plan which users get a Slack DM for a flag event, and under which category.

Pure DB logic — no Slack calls. Category resolution order (first match wins):
assigned > mentioned > raised_activity (creator) > watching_activity
(participant) > status_changes (assignee). The actor never gets a DM.
`raised` never DMs (creator == actor, no watchers yet) — this IS the
raised+assigned collapse: the follow-up `assigned` event is the one DM.
"""
from __future__ import annotations

from dataclasses import dataclass

from models import SlackDmPrefs
from flags.models import FlagParticipant

CATEGORIES = ("assigned", "mentioned", "raised_activity",
              "watching_activity", "status_changes")
DEFAULTS = {c: True for c in CATEGORIES}

_PREF_COLUMN = {
    "assigned": "notify_assigned",
    "mentioned": "notify_mentioned",
    "raised_activity": "notify_raised_activity",
    "watching_activity": "notify_watching_activity",
    "status_changes": "notify_status_changes",
}


@dataclass(frozen=True)
class PlannedDM:
    user_id: int
    category: str


def _wants(db, user_id: int, category: str) -> bool:
    row = db.query(SlackDmPrefs).filter(SlackDmPrefs.user_id == user_id).first()
    if row is None:
        return True
    if not row.enabled:
        return False
    return bool(getattr(row, _PREF_COLUMN[category]))


def plan_dms(db, event: dict) -> list[PlannedDM]:
    etype = event.get("event_type")
    flag = event.get("flag") or {}
    actor_id = event.get("actor_id")
    planned: dict[int, str] = {}   # user_id -> category (first match wins)

    def consider(user_id, category):
        if user_id is None or user_id == actor_id or user_id in planned:
            return
        planned[user_id] = category

    if etype == "assigned":
        to_value = event.get("to_value")
        if to_value is not None:
            consider(int(to_value), "assigned")
    elif etype in ("commented", "status_changed"):
        if etype == "commented":
            for uid in (event.get("details") or {}).get("mentions") or []:
                consider(int(uid), "mentioned")
        consider(flag.get("created_by"), "raised_activity")
        watcher_ids = [
            uid for (uid,) in db.query(FlagParticipant.user_id)
            .filter(FlagParticipant.flag_id == event.get("flag_id")).all()
        ]
        for uid in watcher_ids:
            consider(uid, "watching_activity")
        if etype == "status_changed":
            consider(flag.get("assignee_id"), "status_changes")
    else:
        return []   # raised / unassigned / watcher_* never DM

    return [PlannedDM(user_id=u, category=c) for u, c in planned.items()
            if _wants(db, u, c)]
```

Create empty `backend/slack_notify/__init__.py`.

- [ ] **Step 5:** SYNC, BE-TEST → all planner tests PASS. Commit (`feat(slack): slack_dm_prefs model + DM planner`).

---

### Task 2: Message builder

**Files:**
- Create: `backend/slack_notify/messages.py`
- Test: `backend/tests/test_slack_notify_messages.py`

**Interfaces:**
- Produces: `build_message(event: dict, category: str, actor_label: str, base_url: str) -> tuple[str, list[dict]]` (fallback text, Block Kit blocks).

- [ ] **Step 1: Failing test** — `backend/tests/test_slack_notify_messages.py`:

```python
from slack_notify.messages import build_message


def _event(**over):
    e = {"event_type": "assigned", "flag_id": 7, "actor_id": 1,
         "from_value": None, "to_value": "2", "details": {},
         "event_id": 10,
         "flag": {"id": 7, "title": "Vial cloudy", "type": "blocker",
                  "kind": "issue", "status": "open", "entity_type": "sub_sample",
                  "entity_id": "42", "assignee_id": 2, "created_by": 1}}
    e.update(over)
    return e


def test_assigned_message_has_action_title_context_and_link():
    text, blocks = build_message(_event(), "assigned", "Nick",
                                 "https://mk1.example")
    assert "Nick assigned you a flag" in text
    assert "Vial cloudy" in text
    flat = str(blocks)
    assert "Vial 42" in flat and "Blocker" in flat and "Open" in flat
    assert "https://mk1.example/#dashboard/orders?flag=7" in flat


def test_comment_excerpt_truncated():
    e = _event(event_type="commented",
               details={"mentions": [], "body_excerpt": "x" * 300})
    text, blocks = build_message(e, "watching_activity", "Nick",
                                 "https://mk1.example")
    assert "commented on a flag you're watching" in text
    assert ("x" * 140) in str(blocks) and ("x" * 141) not in str(blocks)
```

- [ ] **Step 2:** SYNC, BE-TEST → FAIL (module missing). Commit RED.

- [ ] **Step 3: Implement** — `backend/slack_notify/messages.py`:

```python
"""Block Kit DM payloads for flag events. Pure — no I/O."""
from __future__ import annotations

_ENTITY_LABEL = {"sample": "Sample", "sub_sample": "Vial", "worksheet": "Worksheet"}
_STATUS_LABEL = {"open": "Open", "in_progress": "In progress", "blocked": "Blocked",
                 "resolved": "Resolved", "closed": "Closed"}

_ACTION = {
    "assigned": "{actor} assigned you a flag",
    "mentioned": "{actor} mentioned you in a flag comment",
    "raised_activity": "{actor} updated a flag you raised",
    "watching_activity": "{actor} commented on a flag you're watching",
    "status_changes": "{actor} changed the status of your flag",
}

_EXCERPT_MAX = 140


def _entity_label(flag: dict) -> str:
    kind = _ENTITY_LABEL.get(flag.get("entity_type"), flag.get("entity_type", ""))
    return f"{kind} {flag.get('entity_id', '')}".strip()


def build_message(event: dict, category: str, actor_label: str,
                  base_url: str) -> tuple[str, list[dict]]:
    flag = event.get("flag") or {}
    action = _ACTION.get(category, "{actor} updated a flag").format(actor=actor_label)
    if event.get("event_type") == "status_changed" and event.get("to_value"):
        action += f" → {_STATUS_LABEL.get(event['to_value'], event['to_value'])}"
    title = flag.get("title", "")
    status = _STATUS_LABEL.get(flag.get("status"), flag.get("status", ""))
    context = f"{_entity_label(flag)} · {str(flag.get('type', '')).replace('_', ' ').title()} · {status}"
    link = f"{base_url.rstrip('/')}/#dashboard/orders?flag={flag.get('id')}"

    text = f"{action}: {title}"
    blocks: list[dict] = [
        {"type": "section",
         "text": {"type": "mrkdwn", "text": f"*{action}*\n<{link}|{title}>"}},
        {"type": "context",
         "elements": [{"type": "mrkdwn", "text": context}]},
    ]
    excerpt = (event.get("details") or {}).get("body_excerpt")
    if excerpt:
        blocks.insert(1, {"type": "section",
                          "text": {"type": "mrkdwn",
                                   "text": f"> {excerpt[:_EXCERPT_MAX]}"}})
    return text, blocks
```

- [ ] **Step 4:** `details.body_excerpt` doesn't exist yet — add it at the emit site: in `backend/flags/service.py` `add_comment`, where the `commented` `_audit` call builds `details` (~line 247), include `"body_excerpt": body[:140]` alongside `mentions`. Show the exact edit in-place when executing (the details dict literal gains one key). This is additive to the event payload; the FE ignores unknown detail keys.

- [ ] **Step 5:** SYNC, BE-TEST (messages + the existing `tests/test_flags_mentions.py` to prove the details addition broke nothing) → PASS. Commit (`feat(slack): Block Kit message builder + comment excerpt on events`).

---

### Task 3: Slack HTTP client

**Files:**
- Create: `backend/slack_notify/client.py`
- Test: `backend/tests/test_slack_notify_client.py`

**Interfaces:**
- Produces: `SlackClient(token: str, transport: httpx.AsyncBaseTransport | None = None)` with async methods `lookup_by_email(email) -> str | None`, `open_dm(member_id) -> str | None`, `post_dm(channel, text, blocks) -> bool`. All failures return None/False and log at WARNING; nothing raises.

- [ ] **Step 1: Failing test** — `backend/tests/test_slack_notify_client.py`:

```python
import asyncio
import httpx

from slack_notify.client import SlackClient


def _client(handler):
    return SlackClient("xoxb-test", transport=httpx.MockTransport(handler))


def test_lookup_by_email_hit_and_miss():
    def handler(request):
        assert request.headers["Authorization"] == "Bearer xoxb-test"
        if b"hit@x.com" in request.content or "hit%40x.com" in str(request.url):
            return httpx.Response(200, json={"ok": True, "user": {"id": "U123"}})
        return httpx.Response(200, json={"ok": False, "error": "users_not_found"})
    c = _client(handler)
    assert asyncio.run(c.lookup_by_email("hit@x.com")) == "U123"
    assert asyncio.run(c.lookup_by_email("miss@x.com")) is None


def test_open_dm_and_post_dm():
    def handler(request):
        if request.url.path.endswith("conversations.open"):
            return httpx.Response(200, json={"ok": True, "channel": {"id": "D9"}})
        return httpx.Response(200, json={"ok": True})
    c = _client(handler)
    assert asyncio.run(c.open_dm("U123")) == "D9"
    assert asyncio.run(c.post_dm("D9", "hi", [])) is True


def test_http_error_returns_falsey_never_raises():
    def handler(request):
        return httpx.Response(500)
    c = _client(handler)
    assert asyncio.run(c.lookup_by_email("a@b.c")) is None
    assert asyncio.run(c.post_dm("D9", "hi", [])) is False
```

- [ ] **Step 2:** SYNC, BE-TEST → FAIL. Commit RED.

- [ ] **Step 3: Implement** — `backend/slack_notify/client.py`:

```python
"""Minimal Slack Web API client (3 endpoints) — no SDK. Never raises; failures
log at WARNING and return None/False so a Slack outage can't touch flag ops.
The token is never logged."""
from __future__ import annotations

import json
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)
_BASE = "https://slack.com/api"


class SlackClient:
    def __init__(self, token: str,
                 transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        self._headers = {"Authorization": f"Bearer {token}"}
        self._transport = transport

    async def _call(self, method: str, payload: dict) -> Optional[dict]:
        try:
            async with httpx.AsyncClient(transport=self._transport,
                                         timeout=10.0) as http:
                resp = await http.post(f"{_BASE}/{method}",
                                       headers=self._headers, json=payload)
            data = resp.json()
            if resp.status_code != 200 or not data.get("ok"):
                logger.warning("slack %s failed: %s", method,
                               data.get("error", resp.status_code))
                return None
            return data
        except Exception as exc:                      # noqa: BLE001
            logger.warning("slack %s errored: %s", method, exc)
            return None

    async def lookup_by_email(self, email: str) -> Optional[str]:
        data = await self._call("users.lookupByEmail", {"email": email})
        return (data or {}).get("user", {}).get("id") or None

    async def open_dm(self, member_id: str) -> Optional[str]:
        data = await self._call("conversations.open", {"users": member_id})
        return (data or {}).get("channel", {}).get("id") or None

    async def post_dm(self, channel: str, text: str, blocks: list) -> bool:
        return await self._call("chat.postMessage",
                                {"channel": channel, "text": text,
                                 "blocks": blocks}) is not None
```

(Note: `users.lookupByEmail` officially takes form-encoded args, but accepts JSON — if the live test in Task 8 disagrees, switch that one call to `data=` form encoding; the MockTransport tests don't care.)

- [ ] **Step 4:** SYNC, BE-TEST → PASS. Commit (`feat(slack): minimal Slack Web API client`).

---

### Task 4: Notifier (bus glue) + lifespan wiring

**Files:**
- Create: `backend/slack_notify/notifier.py`
- Modify: `backend/main.py` (lifespan, right after `_flag_seams.set_event_sink(...)` ~line 329)
- Test: `backend/tests/test_slack_notify_notifier.py`

**Interfaces:**
- Consumes: `plan_dms`, `build_message`, `SlackClient`, `flags.bus.FlagEventBus`.
- Produces: `SlackNotifier(client, session_factory, base_url)` with `async def handle_event(event) -> int` (DMs sent) and `def start(bus) -> asyncio.Task`; module-level `maybe_start(bus) -> asyncio.Task | None` (env-gated).

- [ ] **Step 1: Failing test** — `backend/tests/test_slack_notify_notifier.py`:

```python
"""handle_event: plan -> resolve member id -> post. Uses a fake client + sqlite."""
import asyncio
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

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
    async def open_dm(self, member_id):
        return f"D-{member_id}"
    async def post_dm(self, channel, text, blocks):
        self.posted.append((channel, text))
        return True


@pytest.fixture()
def session_factory():
    engine = create_engine("sqlite://",
                           connect_args={"check_same_thread": False})
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
    db.close()


def test_manual_member_id_skips_lookup(session_factory):
    fid = _seed(session_factory, prefs_member="U-MANUAL")
    fake = FakeClient()
    n = SlackNotifier(fake, session_factory, "https://mk1.example")
    asyncio.run(n.handle_event(_event(fid)))
    assert fake.lookups == []
    assert fake.posted[0][0] == "D-U-MANUAL"


def test_unresolvable_user_is_skipped_silently(session_factory):
    fid = _seed(session_factory)
    db = session_factory()
    db.query(User).filter_by(id=2).update({"email": "unknown@lab.com"})
    db.commit(); db.close()
    fake = FakeClient()
    n = SlackNotifier(fake, session_factory, "https://mk1.example")
    assert asyncio.run(n.handle_event(_event(fid))) == 0
    assert fake.posted == []
```

- [ ] **Step 2:** SYNC, BE-TEST → FAIL. Commit RED.

- [ ] **Step 3: Implement** — `backend/slack_notify/notifier.py`:

```python
"""Bus subscriber that mirrors relevant flag events as Slack DMs.

Wired in main.py's lifespan ONLY when MK1_SLACK_BOT_TOKEN is set — otherwise
the feature is dormant (zero overhead). Fire-and-forget: any failure logs and
drops; nothing propagates to flag operations. DB access runs in a worker
thread (asyncio.to_thread) because Sessions are sync."""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

from slack_notify.client import SlackClient
from slack_notify.messages import build_message
from slack_notify.planner import plan_dms

logger = logging.getLogger(__name__)


class SlackNotifier:
    def __init__(self, client, session_factory, base_url: str) -> None:
        self._client = client
        self._session_factory = session_factory
        self._base_url = base_url

    # -- sync helpers (run via to_thread) ---------------------------------
    def _plan_and_enrich(self, event: dict):
        """Plan DMs and load emails/cached member ids + actor label in one
        short-lived session. Returns (actor_label, [(user_id, category,
        email, member_id_or_None)])."""
        from models import SlackDmPrefs, User
        db = self._session_factory()
        try:
            planned = plan_dms(db, event)
            if not planned:
                return "", []
            actor = db.query(User).get(event.get("actor_id")) if event.get("actor_id") else None
            actor_label = (f"{actor.first_name} {actor.last_name}".strip()
                           if actor and (actor.first_name or actor.last_name)
                           else (actor.email if actor else "Someone"))
            out = []
            for p in planned:
                user = db.query(User).get(p.user_id)
                if user is None:
                    continue
                row = db.query(SlackDmPrefs).filter_by(user_id=p.user_id).first()
                out.append((p.user_id, p.category, user.email,
                            row.slack_member_id if row else None))
            return actor_label, out
        finally:
            db.close()

    def _cache_member_id(self, user_id: int, member_id: str) -> None:
        from models import SlackDmPrefs
        db = self._session_factory()
        try:
            row = db.query(SlackDmPrefs).filter_by(user_id=user_id).first()
            if row is None:
                row = SlackDmPrefs(user_id=user_id)
                db.add(row)
            row.slack_member_id = member_id
            db.commit()
        finally:
            db.close()

    # -- async pipeline ----------------------------------------------------
    async def handle_event(self, event: dict) -> int:
        try:
            actor_label, targets = await asyncio.to_thread(
                self._plan_and_enrich, event)
            sent = 0
            for user_id, category, email, member_id in targets:
                if member_id is None:
                    member_id = await self._client.lookup_by_email(email)
                    if member_id is None:
                        continue          # unresolved — UI shows "Not linked"
                    await asyncio.to_thread(self._cache_member_id,
                                            user_id, member_id)
                channel = await self._client.open_dm(member_id)
                if channel is None:
                    continue
                text, blocks = build_message(event, category, actor_label,
                                             self._base_url)
                if await self._client.post_dm(channel, text, blocks):
                    sent += 1
            return sent
        except Exception as exc:                     # noqa: BLE001
            logger.warning("slack notify failed for event %s: %s",
                           event.get("event_id"), exc)
            return 0

    async def run(self, bus) -> None:
        sub = bus.subscribe(None)
        logger.info("slack notifier subscribed to flag bus")
        try:
            while True:
                event = await sub.get()
                await self.handle_event(event)
        finally:
            sub.close()

    def start(self, bus) -> asyncio.Task:
        return asyncio.create_task(self.run(bus), name="slack-notifier")


def maybe_start(bus) -> Optional[asyncio.Task]:
    """Env-gated entry point for main.py's lifespan."""
    token = os.getenv("MK1_SLACK_BOT_TOKEN")
    if not token:
        return None
    from database import SessionLocal
    base_url = os.getenv("MK1_PUBLIC_URL", "https://accumk1.valenceanalytical.com")
    notifier = SlackNotifier(SlackClient(token), SessionLocal, base_url)
    return notifier.start(bus)
```

(If `database.py` names its factory differently than `SessionLocal`, use the name `get_db` yields from — check at execution.)

- [ ] **Step 4: Wire lifespan** — in `backend/main.py`, immediately after `_flag_seams.set_event_sink(_flag_bus.SSEEventSink(_flag_bus.BUS))` (~line 329):

```python
    # Slack DM notifications (spec 2026-07-02) — dormant without the token.
    from slack_notify.notifier import maybe_start as _slack_maybe_start
    _slack_notifier_task = _slack_maybe_start(_flag_bus.BUS)
```

- [ ] **Step 5:** SYNC, restart backend, BE-TEST (all `test_slack_notify*` + `tests/test_flags_stream.py` to prove the extra subscriber doesn't disturb SSE) → PASS. Backend log shows NO "slack notifier subscribed" (token unset in the stack — dormant path verified). Commit (`feat(slack): notifier bus subscriber + env-gated lifespan wiring`).

---

### Task 5: Prefs API

**Files:**
- Create: `backend/slack_notify/routes.py`
- Modify: `backend/main.py` (include router, next to `app.include_router(flags_router)` ~line 402)
- Test: `backend/tests/test_slack_notify_routes.py`

**Interfaces:**
- Produces: `GET /api/slack-prefs` → `{enabled, slack_member_id, notify_*×5, linked: bool}`; `PUT /api/slack-prefs` (partial body, same fields writable); `POST /api/slack-prefs/test` → `{ok: bool, detail: str|None}`. All `Depends(get_current_user)`, self-scoped.

- [ ] **Step 1: Failing test** — `backend/tests/test_slack_notify_routes.py`, mirroring the TestClient + auth-override pattern used in `backend/tests/test_flags_routes.py` (reuse its fixture style verbatim — app import, `dependency_overrides[get_current_user]`, sqlite override for `get_db`):

```python
def test_get_defaults_when_no_row(client):
    r = client.get("/api/slack-prefs")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True and body["linked"] is False
    assert all(body[f"notify_{c}"] is True for c in
               ("assigned", "mentioned", "raised_activity",
                "watching_activity", "status_changes"))


def test_put_upserts_and_persists(client):
    r = client.put("/api/slack-prefs",
                   json={"notify_watching_activity": False,
                         "slack_member_id": "U777"})
    assert r.status_code == 200
    r2 = client.get("/api/slack-prefs")
    assert r2.json()["notify_watching_activity"] is False
    assert r2.json()["linked"] is True


def test_test_endpoint_without_token_reports_not_configured(client):
    r = client.post("/api/slack-prefs/test")
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "not configured" in r.json()["detail"].lower()
```

- [ ] **Step 2:** SYNC, BE-TEST → FAIL (404s). Commit RED.

- [ ] **Step 3: Implement** — `backend/slack_notify/routes.py`:

```python
"""Per-user Slack DM preference endpoints. Strictly self-scoped — user_id
always derives from the JWT; no admin editing of others in v1."""
from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import SlackDmPrefs

router = APIRouter(prefix="/api/slack-prefs", tags=["slack-prefs"])

_FIELDS = ("enabled", "notify_assigned", "notify_mentioned",
           "notify_raised_activity", "notify_watching_activity",
           "notify_status_changes")


class SlackPrefsUpdate(BaseModel):
    enabled: Optional[bool] = None
    slack_member_id: Optional[str] = None
    notify_assigned: Optional[bool] = None
    notify_mentioned: Optional[bool] = None
    notify_raised_activity: Optional[bool] = None
    notify_watching_activity: Optional[bool] = None
    notify_status_changes: Optional[bool] = None


def _row(db: Session, user_id: int) -> Optional[SlackDmPrefs]:
    return db.query(SlackDmPrefs).filter_by(user_id=user_id).first()


def _serialize(row: Optional[SlackDmPrefs]) -> dict:
    if row is None:
        out = {f: True for f in _FIELDS}
        out.update({"slack_member_id": None, "linked": False})
        return out
    out = {f: bool(getattr(row, f)) for f in _FIELDS}
    out["slack_member_id"] = row.slack_member_id
    out["linked"] = bool(row.slack_member_id)
    return out


@router.get("")
def get_prefs(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return _serialize(_row(db, user.id))


@router.put("")
def put_prefs(body: SlackPrefsUpdate, db: Session = Depends(get_db),
              user=Depends(get_current_user)):
    row = _row(db, user.id)
    if row is None:
        row = SlackDmPrefs(user_id=user.id)
        db.add(row)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value if field != "slack_member_id"
                else (value.strip() or None if value else None))
    db.commit()
    db.refresh(row)
    return _serialize(row)


@router.post("/test")
async def test_dm(db: Session = Depends(get_db),
                  user=Depends(get_current_user)):
    token = os.getenv("MK1_SLACK_BOT_TOKEN")
    if not token:
        return {"ok": False, "detail": "Slack is not configured on the server "
                                       "(MK1_SLACK_BOT_TOKEN unset)."}
    from slack_notify.client import SlackClient
    client = SlackClient(token)
    row = _row(db, user.id)
    member_id = row.slack_member_id if row else None
    if member_id is None:
        member_id = await client.lookup_by_email(user.email)
        if member_id is None:
            return {"ok": False, "detail": "No Slack account matched your "
                                           "email — paste your Slack member ID."}
        if row is None:
            row = SlackDmPrefs(user_id=user.id)
            db.add(row)
        row.slack_member_id = member_id
        db.commit()
    channel = await client.open_dm(member_id)
    if channel and await client.post_dm(channel,
                                        "Test from Accu-Mk1 — Slack DMs are working.", []):
        return {"ok": True, "detail": None}
    return {"ok": False, "detail": "Slack rejected the message — check the "
                                   "member ID and that the app is installed."}
```

In `main.py`, next to the flags router include (~line 402):

```python
from slack_notify.routes import router as slack_prefs_router
app.include_router(slack_prefs_router)
```

(Match `auth`/`database` import names to what `flags/routes.py` actually imports — verify at execution.)

- [ ] **Step 4:** SYNC, restart backend, BE-TEST → PASS. Commit (`feat(slack): per-user prefs API (get/put/test)`).

---

### Task 6: Preferences UI — Slack notifications section

**Files:**
- Create: `src/lib/slack-prefs-api.ts`
- Create: `src/services/slack-prefs.ts`
- Create: `src/components/preferences/panes/SlackPrefsSection.tsx`
- Modify: `src/components/preferences/panes/FlagsPane.tsx` (render section at top)
- Modify: `locales/en.json`, `locales/fr.json`, `locales/ar.json`
- Test: `src/components/preferences/panes/__tests__/SlackPrefsSection.test.tsx`

**Interfaces:**
- Consumes: Task 5's endpoints.
- Produces: `SlackPrefsSection` (no props) rendered inside `FlagsPane`.

- [ ] **Step 1: API + hooks**

`src/lib/slack-prefs-api.ts`:

```ts
import { apiFetch } from '@/lib/api'

export interface SlackDmPrefs {
  enabled: boolean
  slack_member_id: string | null
  linked: boolean
  notify_assigned: boolean
  notify_mentioned: boolean
  notify_raised_activity: boolean
  notify_watching_activity: boolean
  notify_status_changes: boolean
}

export type SlackDmPrefsUpdate = Partial<
  Omit<SlackDmPrefs, 'linked'>
>

export interface SlackTestResult {
  ok: boolean
  detail: string | null
}

export const getSlackPrefs = () => apiFetch<SlackDmPrefs>('/api/slack-prefs')

export const putSlackPrefs = (body: SlackDmPrefsUpdate) =>
  apiFetch<SlackDmPrefs>('/api/slack-prefs', {
    method: 'PUT',
    body: JSON.stringify(body),
  })

export const testSlackDm = () =>
  apiFetch<SlackTestResult>('/api/slack-prefs/test', { method: 'POST' })
```

(Match `apiFetch`'s actual signature/casing to `src/lib/flags-api.ts` at execution — reuse its import and call style verbatim.)

`src/services/slack-prefs.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getSlackPrefs,
  putSlackPrefs,
  testSlackDm,
  type SlackDmPrefsUpdate,
} from '@/lib/slack-prefs-api'

const KEY = ['slack-prefs'] as const

export function useSlackPrefs() {
  return useQuery({ queryKey: KEY, queryFn: getSlackPrefs })
}

export function useUpdateSlackPrefs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SlackDmPrefsUpdate) => putSlackPrefs(body),
    onSuccess: data => qc.setQueryData(KEY, data),
  })
}

export function useTestSlackDm() {
  return useMutation({ mutationFn: testSlackDm })
}
```

- [ ] **Step 2: Failing component test** — `src/components/preferences/panes/__tests__/SlackPrefsSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'

const update = vi.fn()
const test = vi.fn()
const prefs = {
  enabled: true,
  slack_member_id: null as string | null,
  linked: false,
  notify_assigned: true,
  notify_mentioned: true,
  notify_raised_activity: true,
  notify_watching_activity: true,
  notify_status_changes: true,
}
vi.mock('@/services/slack-prefs', () => ({
  useSlackPrefs: () => ({ data: prefs, isLoading: false, isError: false }),
  useUpdateSlackPrefs: () => ({ mutate: update, isPending: false }),
  useTestSlackDm: () => ({ mutate: test, isPending: false, data: undefined }),
}))

describe('SlackPrefsSection', () => {
  beforeEach(() => {
    update.mockReset()
    test.mockReset()
  })

  it('renders master toggle, five category toggles, link state', async () => {
    const { SlackPrefsSection } = await import(
      '@/components/preferences/panes/SlackPrefsSection'
    )
    render(<SlackPrefsSection />)
    expect(screen.getByText(/not linked/i)).toBeInTheDocument()
    // master + 5 categories
    expect(screen.getAllByRole('switch')).toHaveLength(6)
  })

  it('toggling a category saves that field', async () => {
    const { SlackPrefsSection } = await import(
      '@/components/preferences/panes/SlackPrefsSection'
    )
    render(<SlackPrefsSection />)
    const switches = screen.getAllByRole('switch')
    await userEvent.click(switches[4]!)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ notify_watching_activity: false })
    )
  })

  it('test button fires the test mutation', async () => {
    const { SlackPrefsSection } = await import(
      '@/components/preferences/panes/SlackPrefsSection'
    )
    render(<SlackPrefsSection />)
    await userEvent.click(
      screen.getByRole('button', { name: /send test dm/i })
    )
    expect(test).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3:** SYNC, FE-TEST → FAIL (module missing). Commit RED.

- [ ] **Step 4: Implement the section** — `src/components/preferences/panes/SlackPrefsSection.tsx`:

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsSection } from '../shared/SettingsComponents'
import {
  useSlackPrefs,
  useUpdateSlackPrefs,
  useTestSlackDm,
} from '@/services/slack-prefs'
import type { SlackDmPrefs } from '@/lib/slack-prefs-api'

/** Per-user Slack DM notification prefs (spec 2026-07-02). Server-stored —
 *  the backend notifier is the consumer. Category toggles save on change. */

const CATEGORIES = [
  'notify_assigned',
  'notify_mentioned',
  'notify_raised_activity',
  'notify_watching_activity',
  'notify_status_changes',
] as const

export function SlackPrefsSection() {
  const { t } = useTranslation()
  const prefsQuery = useSlackPrefs()
  const update = useUpdateSlackPrefs()
  const testDm = useTestSlackDm()
  const [memberIdDraft, setMemberIdDraft] = useState<string | null>(null)

  if (prefsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }
  const prefs = prefsQuery.data
  if (!prefs) return null

  const memberId = memberIdDraft ?? prefs.slack_member_id ?? ''

  return (
    <SettingsSection title={t('preferences.slack.title')}>
      <p className="text-sm text-muted-foreground">
        {t('preferences.slack.blurb')}
      </p>

      <div className="flex items-center justify-between py-1.5">
        <span className="text-sm">{t('preferences.slack.master')}</span>
        <Switch
          checked={prefs.enabled}
          onCheckedChange={v => update.mutate({ enabled: v })}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {prefs.linked
            ? t('preferences.slack.linked')
            : t('preferences.slack.notLinked')}
        </span>
        <Input
          value={memberId}
          onChange={e => setMemberIdDraft(e.target.value)}
          onBlur={() => {
            if (memberIdDraft !== null)
              update.mutate({ slack_member_id: memberIdDraft.trim() || null })
          }}
          placeholder={t('preferences.slack.memberIdPlaceholder')}
          className="h-8 w-56 text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={testDm.isPending}
          onClick={() => testDm.mutate()}
        >
          {t('preferences.slack.sendTest')}
        </Button>
      </div>
      {testDm.data && (
        <p
          className={
            testDm.data.ok
              ? 'text-xs text-emerald-600'
              : 'text-xs text-destructive'
          }
        >
          {testDm.data.ok
            ? t('preferences.slack.testOk')
            : (testDm.data.detail ?? t('preferences.slack.testFail'))}
        </p>
      )}

      <div className="space-y-1 pt-1">
        {CATEGORIES.map(key => (
          <div key={key} className="flex items-center justify-between py-1">
            <span className="text-sm">{t(`preferences.slack.${key}`)}</span>
            <Switch
              checked={prefs[key as keyof SlackDmPrefs] as boolean}
              disabled={!prefs.enabled}
              onCheckedChange={v => update.mutate({ [key]: v })}
            />
          </div>
        ))}
      </div>
    </SettingsSection>
  )
}

export default SlackPrefsSection
```

In `FlagsPane.tsx`: `import { SlackPrefsSection } from './SlackPrefsSection'` and render `<SlackPrefsSection />` as the first child of the returned `<div className="space-y-8">`.

- [ ] **Step 5: i18n keys** — add to `locales/en.json` under `preferences` (mirror to `fr.json`/`ar.json` with translations):

```json
"slack": {
  "title": "Slack notifications",
  "blurb": "Get flag notifications as Slack DMs — assignments, mentions, and activity on flags you raised or watch.",
  "master": "Send me Slack DMs",
  "linked": "Slack linked",
  "notLinked": "Not linked",
  "memberIdPlaceholder": "Slack member ID (e.g. U0123ABCD)",
  "sendTest": "Send test DM",
  "testOk": "Test DM sent — check Slack.",
  "testFail": "Test failed.",
  "notify_assigned": "When a flag is assigned to me",
  "notify_mentioned": "When I'm @mentioned",
  "notify_raised_activity": "Activity on flags I raised",
  "notify_watching_activity": "Activity on flags I'm watching",
  "notify_status_changes": "Status changes on my flags"
}
```

- [ ] **Step 6:** SYNC, FE-TEST + TYPECHECK → PASS. Commit (`feat(slack-ui): Slack DM prefs section in the Flags pane`).

---

### Task 7: Deep link — `?flag=<id>` on the hash scheme

**Files:**
- Modify: `src/lib/hash-navigation.ts` (parse + apply)
- Test: `src/lib/__tests__/hash-navigation-flag.test.ts`

**Interfaces:**
- Consumes: `useUIStore.openFlagThread(id)` (existing).
- Produces: any `#section/subsection?…&flag=<id>` URL opens that flag's thread on load and on back/forward. `buildHash` never emits it (one-shot).

- [ ] **Step 1: Failing test** — `src/lib/__tests__/hash-navigation-flag.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUIStore } from '@/store/ui-store'
import { useHashNavigation } from '@/lib/hash-navigation'

describe('hash navigation ?flag= deep link', () => {
  beforeEach(() => {
    useUIStore.setState({ flagsFlyoutOpen: false, flagsThreadId: null })
  })

  it('opens the flag thread from the initial hash', () => {
    window.location.hash = '#dashboard/orders?flag=42'
    renderHook(() => useHashNavigation())
    expect(useUIStore.getState().flagsFlyoutOpen).toBe(true)
    expect(useUIStore.getState().flagsThreadId).toBe(42)
  })

  it('ignores a non-numeric flag param', () => {
    window.location.hash = '#dashboard/orders?flag=abc'
    renderHook(() => useHashNavigation())
    expect(useUIStore.getState().flagsThreadId).toBeNull()
  })
})
```

- [ ] **Step 2:** SYNC, FE-TEST → FAIL. Commit RED.

- [ ] **Step 3: Implement** — in `hash-navigation.ts`:

Add `flagId: number | null` to `ParsedNav`; in `parseNavHash` after `targetId`:

```ts
  let flagId: number | null = null
  if (query) {
    const params = new URLSearchParams(query)
    targetId = params.get('id')
    const rawFlag = params.get('flag')
    if (rawFlag && !Number.isNaN(Number(rawFlag))) flagId = Number(rawFlag)
  }
```

(fold the existing `targetId` read into this block — one `URLSearchParams`). At the END of `applyNavToStore`:

```ts
  // Slack DM deep link (spec 2026-07-02): one-shot open of a flag thread.
  // buildHash never re-emits ?flag=, so the param clears on the next nav.
  if (nav.flagId != null) {
    store.openFlagThread(nav.flagId)
  }
```

- [ ] **Step 4:** SYNC, FE-TEST + TYPECHECK → PASS. Commit (`feat(flags-ui): ?flag= hash deep link opens the thread`).

---

### Task 8: Gates, live smoke, PR

- [ ] **Step 1:** Full gates in the stack: all `test_slack_notify*` + `tests/test_flags_*.py` pytest; flag vitest + new FE tests; TYPECHECK; BUILD; prettier `--check` on touched files (fix in-container, commit from devbox — CRLF gotcha).
- [ ] **Step 2: Dormant-path live check** (no token in the stack): backend up healthy, log contains NO "slack notifier subscribed", `GET /api/slack-prefs` returns defaults, `POST /api/slack-prefs/test` returns `ok:false` "not configured", prefs section renders at the stack's Mk1 URL and saves toggles.
- [ ] **Step 3: Full live acceptance (BLOCKED on the Handler creating the Slack app)** — documented, not executed now: set `MK1_SLACK_BOT_TOKEN` in the stack backend env, restart, link a user (email or member-ID+test-DM), raise/assign/mention → 3 DMs with working `?flag=` deep links. Runs whenever the token exists.
- [ ] **Step 4:** Open PR `feat/flag-slack-dm` → master, body summarizing spec/decisions/gates + the blocked live-acceptance item. **HELD for user sign-off — do not merge.**

## Self-review notes

- Spec coverage: setup→manifest (already committed); architecture/planner→T1; collapse semantics→T1 (raised never DMs) + planner docstring; messages/excerpt→T2; client→T3; fire-and-forget/env gate/lifespan→T4; API→T5; UI/prefs page→T6; deep link→T7 (+spec amendment T0); failure modes→T3/T4 tests; dormant verification→T8. ISO/security sections need no code beyond the above.
- Type consistency: `PlannedDM(user_id, category)` used T1→T4; `build_message(event, category, actor_label, base_url)` T2→T4; `SlackClient.lookup_by_email/open_dm/post_dm` T3→T4/T5; FE `SlackDmPrefs`/hooks T6 only.
- Known verify-at-execution points (named in-place): `SessionLocal` name, `auth`/`database` import names, `apiFetch` signature, lookupByEmail JSON-vs-form.
