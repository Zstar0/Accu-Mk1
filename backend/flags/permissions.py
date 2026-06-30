"""Host-resolved permissions for flags (Mk1 role rules).

v1 rules:
  - create / comment / watch / assign  -> any active user
  - change_type / change_status / resolve / close / reopen
        -> the flag's assignee, its raiser (created_by), or an admin
Internal-only is enforced by the host's auth (all users are staff). User-group
permissions are a future swap of THIS function only (see spec §8).
"""
from __future__ import annotations

_OPEN_ACTIONS = {"create", "comment", "watch", "assign"}
_LIFECYCLE_ACTIONS = {"change_type", "change_status", "resolve", "close", "reopen"}


def can(user, action: str, flag=None) -> bool:
    if action in _OPEN_ACTIONS:
        return user is not None
    if action in _LIFECYCLE_ACTIONS:
        if getattr(user, "role", None) == "admin":
            return True
        if flag is None:
            return False
        uid = getattr(user, "id", None)
        return uid is not None and uid in (
            getattr(flag, "created_by", None), getattr(flag, "assignee_id", None))
    return False
