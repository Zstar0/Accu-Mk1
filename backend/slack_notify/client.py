"""Minimal Slack Web API client (3 endpoints) — no SDK. Never raises; failures
log at WARNING and return None/False so a Slack outage can't touch flag ops.
The token is never logged."""
from __future__ import annotations

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

    async def open_dm(self, member_id: str) -> Optional[str]:
        data = await self._call("conversations.open", {"users": member_id})
        return (data or {}).get("channel", {}).get("id") or None

    async def post_dm(self, channel: str, text: str, blocks: list) -> bool:
        return await self._call("chat.postMessage",
                                {"channel": channel, "text": text,
                                 "blocks": blocks}) is not None
