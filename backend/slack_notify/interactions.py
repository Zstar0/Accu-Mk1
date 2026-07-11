"""Slack interactivity endpoint (Phase 2). POST /api/slack/interactions.

This task supplies the signature verifier; the router lands in Task 4. The verify
is fail-closed: an unset signing secret returns False (the endpoint 404s), and the
5-minute replay window rejects stale/replayed requests. The HMAC is computed over
the RAW request body — the caller must pass the undecoded-form body string.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional

_REPLAY_WINDOW = 300  # seconds


def verify_slack_signature(signing_secret: Optional[str], timestamp: Optional[str],
                           signature: Optional[str], body: str, *,
                           now: Optional[float] = None,
                           window: int = _REPLAY_WINDOW) -> bool:
    if not signing_secret:
        return False
    try:
        ts = int(timestamp)                       # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    now = time.time() if now is None else now
    if abs(now - ts) > window:
        return False
    base = f"v0:{timestamp}:{body}".encode()
    expected = "v0=" + hmac.new(signing_secret.encode(), base,
                                hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


import asyncio
import json
import logging
import os
from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/slack", tags=["slack-interactions"])


def _client():
    """SlackClient factory (patched to a fake in tests)."""
    from slack_notify.client import SlackClient
    return SlackClient(os.environ["MK1_SLACK_BOT_TOKEN"])


def _map_actor(db, member_id: Optional[str]):
    """Reverse-map a verified Slack member id to an Mk1 User (or None)."""
    if not member_id:
        return None
    from models import SlackDmPrefs, User
    row = db.query(SlackDmPrefs).filter_by(slack_member_id=member_id).first()
    return db.get(User, row.user_id) if row else None


def _dispatch(db, user, action_id: str, flag_id: int) -> str:
    """Run the button as `user`; return a confirmation line. Every action goes
    through the SAME service permission path as the UI — a declined action
    returns a message, never a 500 into Slack (Slack has a 3s budget)."""
    from flags import service
    from flags.errors import PermissionDeniedError
    try:
        if action_id == "flag_assign_me":
            flag = service.get_flag(db, flag_id)
            if flag.assignee_id == user.id:
                return "Already assigned to you."
            service.assign(db, user=user, flag_id=flag_id, assignee_id=user.id)
            return "Assigned to you."
        if action_id == "flag_mark_read":
            service.mark_read(db, user_id=user.id, flag_id=flag_id)
            return "Marked as read."
        if action_id == "flag_resolve":
            service.change_status(db, user=user, flag_id=flag_id, to_status="resolved")
            return "Resolved."
        return "Unknown action."
    except PermissionDeniedError:
        return "You don't have permission to do that."
    except Exception as exc:                        # noqa: BLE001 — never 500 into Slack
        logger.warning("interaction %s on flag %s failed: %s", action_id, flag_id, exc)
        return "Sorry — that didn't go through."


@router.post("/interactions")
async def interactions(request: Request):
    secret = os.getenv("SLACK_SIGNING_SECRET")
    if not secret:
        raise HTTPException(status_code=404)        # disabled / fail-closed
    raw = (await request.body()).decode()
    if not verify_slack_signature(
            secret, request.headers.get("X-Slack-Request-Timestamp"),
            request.headers.get("X-Slack-Signature"), raw):
        raise HTTPException(status_code=401, detail="bad signature")

    payloads = parse_qs(raw).get("payload")
    if not payloads:
        raise HTTPException(status_code=400, detail="missing payload")
    payload = json.loads(payloads[0])
    if payload.get("type") != "block_actions":
        return {"ok": True}
    actions = payload.get("actions") or []
    if not actions:
        return {"ok": True}
    member_id = (payload.get("user") or {}).get("id")
    action_id = actions[0].get("action_id")
    try:
        flag_id = int(actions[0].get("value"))
    except (TypeError, ValueError):
        return {"ok": True}

    def _work() -> Optional[str]:
        from database import SessionLocal
        db = SessionLocal()
        try:
            user = _map_actor(db, member_id)
            if user is None:
                return None
            return _dispatch(db, user, action_id, flag_id)
        finally:
            db.close()

    confirmation = await asyncio.to_thread(_work)
    if confirmation is None:
        confirmation = ("Link your Slack account in Accu-Mk1 Preferences "
                        "to use these buttons.")
    # chat.update: append a context line to the message's existing blocks.
    channel = (payload.get("channel") or {}).get("id")
    ts_msg = (payload.get("message") or {}).get("ts")
    if channel and ts_msg and os.getenv("MK1_SLACK_BOT_TOKEN"):
        blocks = list((payload.get("message") or {}).get("blocks") or [])
        blocks.append({"type": "context",
                       "elements": [{"type": "mrkdwn", "text": f"✓ {confirmation}"}]})
        await _client().update_message(
            channel, ts_msg, (payload.get("message") or {}).get("text", ""), blocks)
    return {"ok": True}
