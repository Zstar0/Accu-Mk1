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
            actor = (db.query(User).get(event.get("actor_id"))
                     if event.get("actor_id") else None)
            actor_label = (f"{actor.first_name or ''} {actor.last_name or ''}".strip()
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

    def start(self, bus) -> "asyncio.Task":
        return asyncio.create_task(self.run(bus), name="slack-notifier")


def maybe_start(bus) -> Optional["asyncio.Task"]:
    """Env-gated entry point for main.py's lifespan."""
    token = os.getenv("MK1_SLACK_BOT_TOKEN")
    if not token:
        return None
    from database import SessionLocal
    base_url = os.getenv("MK1_PUBLIC_URL", "https://accumk1.valenceanalytical.com")
    notifier = SlackNotifier(SlackClient(token), SessionLocal, base_url)
    return notifier.start(bus)
