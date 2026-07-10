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
