"""Shared display-name rule for users. Mirrored on the FE in
src/lib/user-display.ts — keep the two in sync.

Rule: "First Last" when both set; the single name when only one set;
the email when neither set (names are optional — email is the identity key).
"""
from typing import Optional


def user_display_name(user) -> str:
    """Return the user's display name, falling back to email.

    `user` is any object exposing first_name / last_name / email (the ORM
    User, or a SimpleNamespace in tests). Returns "" for None.
    """
    if user is None:
        return ""
    first = (getattr(user, "first_name", None) or "").strip()
    last = (getattr(user, "last_name", None) or "").strip()
    full = " ".join(p for p in (first, last) if p)
    return full or (getattr(user, "email", None) or "")
