"""Per-user Slack DM preference endpoints. Strictly self-scoped — user_id
always derives from the JWT; no admin editing of others in v1."""
from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
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
    # Morning digest (Slice 5). hour is lab-local; ge/le gives a 422 outside 0–23.
    digest_enabled: Optional[bool] = None
    digest_hour: Optional[int] = Field(default=None, ge=0, le=23)


def _row(db: Session, user_id: int) -> Optional[SlackDmPrefs]:
    return db.query(SlackDmPrefs).filter_by(user_id=user_id).first()


def _serialize(row: Optional[SlackDmPrefs]) -> dict:
    if row is None:
        # digest is opt-IN (default off) unlike the notify toggles (default on).
        out = {f: True for f in _FIELDS}
        out.update({"slack_member_id": None, "slack_display_name": None,
                    "linked": False, "digest_enabled": False, "digest_hour": 8})
        return out
    out = {f: bool(getattr(row, f)) for f in _FIELDS}
    out["slack_member_id"] = row.slack_member_id
    out["slack_display_name"] = row.slack_display_name
    out["linked"] = bool(row.slack_member_id)
    out["digest_enabled"] = bool(row.digest_enabled)
    out["digest_hour"] = row.digest_hour
    return out


@router.get("")
def get_prefs(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return _serialize(_row(db, user.id))


@router.put("")
async def put_prefs(body: SlackPrefsUpdate, db: Session = Depends(get_db),
                    user=Depends(get_current_user)):
    row = _row(db, user.id)
    if row is None:
        row = SlackDmPrefs(user_id=user.id)
        db.add(row)
    member_changed = False
    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "slack_member_id":
            value = (value or "").strip() or None
            member_changed = value != row.slack_member_id
        setattr(row, field, value)
    if member_changed:
        # Refresh WHO the id resolves to (mapping confidence in the UI).
        # Best-effort: no token / bad id → name just stays empty.
        row.slack_display_name = None
        token = os.getenv("MK1_SLACK_BOT_TOKEN")
        if token and row.slack_member_id:
            from slack_notify.client import SlackClient
            row.slack_display_name = await SlackClient(token).user_info(
                row.slack_member_id)
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
        from slack_notify.emails import alias_domains_from_env, candidate_emails
        for cand in candidate_emails(user.email, alias_domains_from_env()):
            member_id = await client.lookup_by_email(cand)
            if member_id:
                break
        if member_id is None:
            return {"ok": False, "detail": "No Slack account matched your "
                                           "email — paste your Slack member ID."}
        if row is None:
            row = SlackDmPrefs(user_id=user.id)
            db.add(row)
        row.slack_member_id = member_id
        row.slack_display_name = await client.user_info(member_id)
        db.commit()
    channel = await client.open_dm(member_id)
    if channel and await client.post_dm(
            channel, "Test from Accu-Mk1 — Slack DMs are working.", []):
        return {"ok": True, "detail": None}
    return {"ok": False, "detail": "Slack rejected the message — check the "
                                   "member ID and that the app is installed."}
