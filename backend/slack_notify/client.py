"""Minimal Slack Web API client (3 endpoints) — no SDK. Never raises; failures
log at WARNING and return None/False so a Slack outage can't touch flag ops.
The token is never logged."""
from __future__ import annotations

import logging
from typing import NamedTuple, Optional

import httpx

logger = logging.getLogger(__name__)
_BASE = "https://slack.com/api"


class SlackProfile(NamedTuple):
    """The bits of a Slack user we cache at link time (one users.info call)."""
    display_name: Optional[str]
    avatar_url: Optional[str]


class SlackClient:
    def __init__(self, token: str,
                 transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        self._headers = {"Authorization": f"Bearer {token}"}
        self._transport = transport

    async def _call(self, method: str, payload: dict,
                    *, form: bool = False) -> Optional[dict]:
        try:
            async with httpx.AsyncClient(transport=self._transport,
                                         timeout=10.0) as http:
                kwargs = {"data": payload} if form else {"json": payload}
                resp = await http.post(f"{_BASE}/{method}",
                                       headers=self._headers, **kwargs)
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
        # users.lookupByEmail rejects JSON bodies (invalid_arguments) — form only.
        data = await self._call("users.lookupByEmail", {"email": email},
                                form=True)
        return (data or {}).get("user", {}).get("id") or None

    async def user_profile(self, member_id: str) -> Optional[SlackProfile]:
        """Display name (fallback real name) + avatar for a member id, from a
        single users.info call. Returns None only when the call itself fails so
        callers can distinguish "no data" from "linked but no photo". Form-
        encoded like lookupByEmail."""
        data = await self._call("users.info", {"user": member_id}, form=True)
        if not data:
            return None
        user = data.get("user") or {}
        profile = user.get("profile") or {}
        name = (profile.get("display_name") or user.get("real_name")
                or profile.get("real_name") or None)
        # image_72 is the small (72px) avatar — plenty for a 18-22px circle.
        avatar = profile.get("image_72") or None
        return SlackProfile(name, avatar)

    async def user_info(self, member_id: str) -> Optional[str]:
        """Display name (fallback real name) for a member id — mapping
        confidence in the prefs UI. Thin wrapper over user_profile."""
        prof = await self.user_profile(member_id)
        return prof.display_name if prof else None

    async def open_dm(self, member_id: str) -> Optional[str]:
        data = await self._call("conversations.open", {"users": member_id})
        return (data or {}).get("channel", {}).get("id") or None

    async def post_dm(self, channel: str, text: str, blocks: list) -> bool:
        return await self._call("chat.postMessage",
                                {"channel": channel, "text": text,
                                 "blocks": blocks}) is not None

    async def update_message(self, channel: str, ts: str, text: str,
                             blocks: list) -> bool:
        # chat.update takes JSON like chat.postMessage — the form=True path is
        # only for users.lookupByEmail / users.info.
        return await self._call("chat.update",
                                {"channel": channel, "ts": ts, "text": text,
                                 "blocks": blocks}) is not None
