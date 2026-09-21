"""Shared display-name rule for users. Mirrored on the FE in
src/lib/user-display.ts — keep the two in sync.

Rule: "First Last" when both set; the single name when only one set;
the email when neither set (names are optional — email is the identity key).
"""


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


def user_short_name(user) -> str:
    """Compact name for narrow table cells: "F. Last" when the profile has BOTH
    a first and a last name (Handler 2026-09-21, the analyses table's Analyst
    column). Anything less falls back to user_display_name: the single name
    that is set, else the email."""
    if user is None:
        return ""
    first = (getattr(user, "first_name", None) or "").strip()
    last = (getattr(user, "last_name", None) or "").strip()
    if first and last:
        return f"{first[0].upper()}. {last}"
    return user_display_name(user)
