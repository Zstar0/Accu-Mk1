"""Agent key format (spec 2026-10-12 section 3.3): mk1a.<username>.<secret>.
Only sha256(secret) is stored: the secret is 256 random bits, so stretching adds nothing."""
from __future__ import annotations

import hashlib
import re
import secrets
from typing import Optional

PREFIX = "mk1a."
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
EMAIL_DOMAIN = "agent.invalid"  # reserved TLD: never deliverable, never a person's address
_MIN_SECRET = 40


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def wire_key(username: str, secret: str) -> str:
    return f"{PREFIX}{username}.{secret}"


def hint(secret: str) -> str:
    return secret[:6]


def is_agent_key(token) -> bool:
    return isinstance(token, str) and token.strip().startswith(PREFIX)


def parse(token: str) -> Optional[tuple[str, str]]:
    """(username, secret), or None for anything malformed."""
    if not is_agent_key(token):
        return None
    username, sep, secret = token.strip()[len(PREFIX):].partition(".")
    if not sep or not USERNAME_RE.match(username) or len(secret) < _MIN_SECRET:
        return None
    return username, secret


def email_for(username: str) -> str:
    return f"{username}@{EMAIL_DOMAIN}"


def username_of(user) -> str:
    return (getattr(user, "email", "") or "").split("@", 1)[0]
