"""The one place that answers "which groups is this user in" and "is this an admin".
Admins are implicitly members of every group for visibility purposes (spec §3)."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from groups.models import UserGroupMember


def is_admin(user) -> bool:
    return getattr(user, "role", None) == "admin"


def user_group_ids(db: Session, user) -> frozenset[int]:
    uid = getattr(user, "id", None)
    if uid is None:
        return frozenset()
    rows = db.execute(select(UserGroupMember.group_id)
                      .where(UserGroupMember.user_id == uid)).scalars().all()
    return frozenset(int(g) for g in rows)
