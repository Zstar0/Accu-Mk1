"""Group CRUD and membership (spec §4.1, §4.2, §7.1). Routes stay thin."""
from __future__ import annotations

import re
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from groups.errors import BadRequestError, ConflictError, NotFoundError
from groups.models import UserGroup, UserGroupMember

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,59}$")


def clean_slug(slug: str) -> str:
    s = (slug or "").strip()
    if not SLUG_RE.match(s):
        raise BadRequestError("slug must match ^[a-z0-9][a-z0-9-]{1,59}$")
    return s


def _clean_name(name: str) -> str:
    n = (name or "").strip()
    if not n or len(n) > 120:
        raise BadRequestError("name is required (max 120 chars)")
    return n


def member_counts(db: Session) -> dict[int, int]:
    rows = db.execute(select(UserGroupMember.group_id, func.count())
                      .group_by(UserGroupMember.group_id)).all()
    return {gid: n for gid, n in rows}


def list_groups(db: Session, *, include_inactive: bool = False) -> list[UserGroup]:
    stmt = select(UserGroup).order_by(UserGroup.name)
    if not include_inactive:
        stmt = stmt.where(UserGroup.is_active.is_(True))
    return list(db.execute(stmt).scalars().all())


def get_group(db: Session, group_id: int) -> UserGroup:
    g = db.get(UserGroup, group_id)
    if g is None:
        raise NotFoundError(f"group {group_id} not found")
    return g


def create_group(db: Session, *, slug: str, name: str, description: Optional[str]) -> UserGroup:
    slug = clean_slug(slug)
    if db.execute(select(UserGroup.id).where(UserGroup.slug == slug)).scalar_one_or_none():
        raise ConflictError(f"group slug {slug!r} already exists")
    g = UserGroup(slug=slug, name=_clean_name(name), description=(description or None))
    db.add(g)
    db.commit()
    db.refresh(g)
    return g


def update_group(db: Session, group_id: int, **fields) -> UserGroup:
    g = get_group(db, group_id)
    if "slug" in fields and fields["slug"] is not None and fields["slug"] != g.slug:
        raise BadRequestError("slug is immutable")
    if fields.get("name") is not None:
        g.name = _clean_name(fields["name"])
    if "description" in fields and fields["description"] is not None:
        g.description = fields["description"].strip() or None
    if fields.get("is_active") is not None:
        g.is_active = bool(fields["is_active"])
    db.commit()
    db.refresh(g)
    return g


def delete_group(db: Session, group_id: int) -> None:
    g = get_group(db, group_id)
    used = db.execute(select(UserGroupMember.id)
                      .where(UserGroupMember.group_id == g.id).limit(1)).scalar_one_or_none()
    if used is None:
        # Boards are registered later (Task 5); this import stays lazy so groups never
        # depend on boards at import time.
        try:
            from boards.models import BoardGrant
            used = db.execute(select(BoardGrant.id)
                              .where(BoardGrant.group_id == g.id).limit(1)).scalar_one_or_none()
        except ImportError:
            used = None
    if used is not None:
        raise ConflictError("group has members or board grants; deactivate it instead")
    db.delete(g)
    db.commit()


def list_members(db: Session, group_id: int) -> list[int]:
    get_group(db, group_id)
    return list(db.execute(select(UserGroupMember.user_id)
                           .where(UserGroupMember.group_id == group_id)
                           .order_by(UserGroupMember.user_id)).scalars().all())


def replace_members(db: Session, group_id: int, user_ids: list[int]) -> list[int]:
    from models import User
    get_group(db, group_id)
    wanted = sorted(set(int(u) for u in user_ids))
    if wanted:
        ok = set(db.execute(select(User.id).where(User.id.in_(wanted),
                                                   User.is_active.is_(True))).scalars().all())
        bad = [u for u in wanted if u not in ok]
        if bad:
            raise BadRequestError(f"unknown or inactive user ids: {bad}")
    db.query(UserGroupMember).filter(UserGroupMember.group_id == group_id).delete()
    for uid in wanted:
        db.add(UserGroupMember(group_id=group_id, user_id=uid))
    db.commit()
    return wanted


def my_groups(db: Session, user) -> list[UserGroup]:
    uid = getattr(user, "id", None)
    if uid is None:
        return []
    return list(db.execute(
        select(UserGroup)
        .join(UserGroupMember, UserGroupMember.group_id == UserGroup.id)
        .where(UserGroupMember.user_id == uid, UserGroup.is_active.is_(True))
        .order_by(UserGroup.name)).scalars().all())
