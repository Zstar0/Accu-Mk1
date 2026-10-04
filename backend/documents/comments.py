"""Document comments service (spec 2026-10-03 §4, §5, §6). Authorship comes from
the credential, never the body."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Actor:
    """Who is acting: a logged-in user OR a named agent token. Exactly one of
    user_id / agent is set, mirroring the DB CHECK on document_comments."""
    user_id: Optional[int]
    agent: Optional[str]
    display: str
    is_admin: bool


def display_name(user) -> str:
    """'First Last' when the row has them, else the email."""
    first = (getattr(user, "first_name", None) or "").strip()
    last = (getattr(user, "last_name", None) or "").strip()
    return (f"{first} {last}").strip() or getattr(user, "email", "") or "unknown"


def actor_from_user(user) -> Actor:
    return Actor(user_id=user.id, agent=None, display=display_name(user),
                 is_admin=getattr(user, "role", None) == "admin")


def actor_from_agent(name: str) -> Actor:
    return Actor(user_id=None, agent=name, display=name, is_admin=False)
