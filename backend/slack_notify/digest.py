"""Morning digest DM (Slice 5). Host-side (may import flags core — same as
planner.py). Runs from the scheduler every ~15 min; DMs each opted-in user once
per day when their lab-local hour arrives, summarizing their open work. Skips
empty digests. Reuses the notifier client + messages._esc / link_hash_for.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select

from slack_notify.messages import _esc, link_hash_for

logger = logging.getLogger(__name__)


def compute_stats(db, user_id: int, *, now: datetime) -> dict:
    """Open-work summary for one user. Queries flags tables directly."""
    from flags import seams, service
    from flags.catalog import OPEN_STATES
    from flags.models import FlagFlag

    assigned = db.execute(select(FlagFlag).where(
        FlagFlag.assignee_id == user_id,
        FlagFlag.status.in_(OPEN_STATES))).scalars().all()
    overdue = [f for f in assigned if f.due_at is not None and f.due_at < now]
    blocked = [f for f in assigned if f.status == "blocked"]
    # Unread is scoped to still-OPEN flags — a resolved flag isn't "open work" to
    # ping about in the morning (list_unread itself is status-agnostic).
    unread = [f for f in service.list_unread(db, user_id=user_id)
              if f.status in OPEN_STATES]

    oldest = None
    if overdue:
        f = min(overdue, key=lambda x: x.due_at)
        ctx = seams.resolve_context(db, f.entity_type or "", str(f.entity_id or ""))
        oldest = {"title": f.title,
                  "link_hash": link_hash_for((ctx or {}).get("deep_link"), f.id)}
    return {"assigned_open": len(assigned), "overdue": len(overdue),
            "blocked": len(blocked), "unread": len(unread), "oldest_overdue": oldest}


def _is_empty(stats: dict) -> bool:
    return stats["assigned_open"] == 0 and stats["unread"] == 0


def due_targets(db, *, now_local: datetime) -> list[tuple[int, str, dict]]:
    """(user_id, member_id, stats) for users whose digest hour has arrived, who
    haven't been DM'd today, are linked, and have a non-empty digest."""
    from models import SlackDmPrefs
    rows = db.execute(select(SlackDmPrefs).where(
        SlackDmPrefs.digest_enabled.is_(True),
        SlackDmPrefs.digest_hour == now_local.hour)).scalars().all()
    out: list[tuple[int, str, dict]] = []
    today = now_local.date()
    for row in rows:
        if row.slack_member_id is None or row.last_digest_date == today:
            continue
        stats = compute_stats(db, row.user_id, now=now_local)
        if _is_empty(stats):
            continue
        out.append((row.user_id, row.slack_member_id, stats))
    return out


def build_message(stats: dict, base_url: str) -> tuple[str, list[dict]]:
    a, o, b, u = (stats["assigned_open"], stats["overdue"],
                  stats["blocked"], stats["unread"])
    head = f"Your morning digest: *{a}* open assigned"
    if o or b:
        head += f" ({o} overdue, {b} blocked)"
    head += f" · *{u}* unread"
    blocks: list[dict] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": head}}]
    oldest = stats.get("oldest_overdue")
    if oldest:
        link = f"{base_url.rstrip('/')}/{oldest['link_hash']}"
        blocks.append({"type": "section", "text": {"type": "mrkdwn",
                       "text": f"Oldest overdue: <{link}|{_esc(oldest['title'])}>"}})
    text = head.replace("*", "")
    return text, blocks


def _lab_now(now_utc: datetime) -> datetime:
    name = os.getenv("MK1_LAB_TZ", "UTC")
    try:
        tz = ZoneInfo(name)
    except Exception:  # noqa: BLE001 — missing tzdata / bad name → UTC, never crash
        logger.warning("MK1_LAB_TZ %r not resolvable; using UTC", name)
        tz = timezone.utc
    return now_utc.replace(tzinfo=timezone.utc).astimezone(tz).replace(tzinfo=None)


def _plan(session_factory, now_local: datetime):
    db = session_factory()
    try:
        return due_targets(db, now_local=now_local)
    finally:
        db.close()


def _stamp(session_factory, user_id: int, when: date) -> None:
    from models import SlackDmPrefs
    db = session_factory()
    try:
        row = db.query(SlackDmPrefs).filter_by(user_id=user_id).first()
        if row is not None:
            row.last_digest_date = when
            db.commit()
    finally:
        db.close()


async def run(session_factory, client, base_url: str, *, now: datetime) -> int:
    """Scheduler job body. `now` is the scheduler's UTC clock."""
    now_local = _lab_now(now)
    targets = await asyncio.to_thread(_plan, session_factory, now_local)
    sent = 0
    for user_id, member_id, stats in targets:
        channel = await client.open_dm(member_id)
        if channel is None:
            continue
        text, blocks = build_message(stats, base_url)
        if await client.post_dm(channel, text, blocks):
            await asyncio.to_thread(_stamp, session_factory, user_id, now_local.date())
            sent += 1
    return sent
