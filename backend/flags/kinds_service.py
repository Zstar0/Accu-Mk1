"""Service layer for user-managed virtual item kinds (Phase 2 slice 7).

Mirrors `types_service.py`. An item kind is a pure category a general task can
anchor to (`entity_type=<slug>`, `entity_id` NULL) with no Mk1 row behind it.
`seed_builtins` seeds the "General Task" kind that legacy NULL-anchor flags are
backfilled to. Deletion is soft for built-in/in-use kinds (ConflictError +
deactivate); only unused custom kinds hard-delete. `slug` is immutable.
"""
from __future__ import annotations

import re
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from flags.errors import BadRequestError, ConflictError, NotFoundError
from flags.models import FlagFlag
from models import FlagItemKind


# The general-task builtin. (slug, label, color, sort_order)
_BUILTINS = [
    ("general_task", "General Task", "#6b7280", 0),
]


def seed_builtins(db: Session) -> None:
    """Idempotently seed the built-in kinds. Production seeds via
    database._run_migrations (Postgres); this is the parity path for SQLite test
    sessions (create_all builds the table but runs no migrations)."""
    for slug, label, color, order in _BUILTINS:
        if get_kind_by_slug(db, slug) is None:
            db.add(FlagItemKind(slug=slug, label=label, color=color,
                                sort_order=order, is_builtin=True))
    db.commit()


def _slugify(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (label or "").strip().lower()).strip("_")
    return s or "kind"


def _unique_slug(db: Session, base: str) -> str:
    """First free slug in the base, base_2, base_3, ... sequence."""
    if get_kind_by_slug(db, base) is None:
        return base
    n = 2
    while get_kind_by_slug(db, f"{base}_{n}") is not None:
        n += 1
    return f"{base}_{n}"


# --- reads ---------------------------------------------------------------
def list_kinds(db: Session, active_only: bool = False) -> list[FlagItemKind]:
    """All kinds ordered by sort_order then slug. `active_only=True` for the
    raise/compose picker; omit for label resolution (a deactivated kind can still
    own open flags whose chips must keep rendering)."""
    stmt = select(FlagItemKind).order_by(FlagItemKind.sort_order, FlagItemKind.slug)
    if active_only:
        stmt = stmt.where(FlagItemKind.is_active.is_(True))
    return list(db.execute(stmt).scalars().all())


def get_kind(db: Session, kind_id: int) -> Optional[FlagItemKind]:
    return db.get(FlagItemKind, kind_id)


def get_kind_by_slug(db: Session, slug: str) -> Optional[FlagItemKind]:
    return db.execute(
        select(FlagItemKind).where(FlagItemKind.slug == slug)
    ).scalar_one_or_none()


# --- writes --------------------------------------------------------------
def create_kind(db: Session, *, label: str, color: str,
                slug: Optional[str] = None,
                sort_order: Optional[int] = None,
                is_active: bool = True) -> FlagItemKind:
    explicit = bool(slug and slug.strip())
    slug = (slug or _slugify(label)).strip()
    if explicit:
        if get_kind_by_slug(db, slug) is not None:
            raise ConflictError(f"item kind slug {slug!r} already exists")
    else:
        slug = _unique_slug(db, slug)
    if sort_order is None:
        max_order = db.execute(select(FlagItemKind.sort_order)).scalars().all()
        sort_order = (max(max_order) + 1) if max_order else 0
    k = FlagItemKind(slug=slug, label=label, color=color, sort_order=sort_order,
                     is_active=is_active, is_builtin=False)
    db.add(k)
    db.commit()
    db.refresh(k)
    return k


def update_kind(db: Session, kind_id: int, **fields) -> FlagItemKind:
    k = get_kind(db, kind_id)
    if k is None:
        raise NotFoundError(f"item kind {kind_id} not found")
    # slug is immutable — reject a change, ignore a no-op restatement.
    if "slug" in fields:
        new_slug = fields.pop("slug")
        if new_slug is not None and new_slug != k.slug:
            raise BadRequestError("item kind slug is immutable")
    for key in ("label", "color", "is_active", "sort_order"):
        if key in fields and fields[key] is not None:
            setattr(k, key, fields[key])
    db.commit()
    db.refresh(k)
    return k


def set_active(db: Session, kind_id: int, active: bool) -> FlagItemKind:
    return update_kind(db, kind_id, is_active=active)


def delete_kind(db: Session, kind_id: int) -> None:
    """Hard-delete an UNUSED custom kind. Built-in or in-use kinds raise
    ConflictError — the caller should deactivate (set_active False) instead."""
    k = get_kind(db, kind_id)
    if k is None:
        raise NotFoundError(f"item kind {kind_id} not found")
    if k.is_builtin:
        raise ConflictError("built-in item kinds cannot be deleted; deactivate instead")
    in_use = db.execute(
        select(FlagFlag.id).where(FlagFlag.entity_type == k.slug).limit(1)
    ).first()
    if in_use is not None:
        raise ConflictError("item kind is in use; deactivate instead")
    db.delete(k)
    db.commit()


def backfill_general_task(db: Session) -> int:
    """Point legacy NULL-anchor flags at the general_task kind. Idempotent by
    construction (the WHERE clause never re-matches). Returns the row count."""
    result = db.execute(
        update(FlagFlag)
        .where(FlagFlag.entity_type.is_(None))
        .values(entity_type="general_task")
    )
    db.commit()
    return result.rowcount or 0
