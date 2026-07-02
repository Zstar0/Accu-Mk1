"""Service layer for the user-managed flag-type catalog (Plan 5).

Promotes the hardcoded `catalog.FLAG_TYPES` map to a DB table. `is_valid_type`
/`kind_for_type` here are the DB-backed replacements the flag service calls when
creating a flag. Deletion is soft for built-in/in-use types (ConflictError +
deactivate); only unused custom types hard-delete. `slug` is immutable.
"""
from __future__ import annotations

import re
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from flags.errors import BadRequestError, ConflictError, NotFoundError
from flags.models import FlagFlag
from models import FlagType


# The 5 built-ins, mirroring database._run_migrations seed + catalog.FLAG_TYPES.
# (slug, label, color, kind, is_blocking, sort_order)
_BUILTINS = [
    ("blocker", "Blocker", "#e5484d", "issue", True, 0),
    ("critical", "Critical", "#e8730a", "issue", True, 1),
    ("question", "Question", "#3b82f6", "issue", False, 2),
    ("waiting_on_customer", "Waiting on Customer", "#8b5cf6", "issue", False, 3),
    ("ready_for_verification", "Ready for Verification", "#22c55e", "signal", False, 4),
]


def seed_builtins(db: Session) -> None:
    """Idempotently seed the 5 built-in types. Production seeds via
    database._run_migrations (Postgres); this is the parity path for SQLite test
    sessions (create_all builds the table but runs no migrations)."""
    for slug, label, color, kind, blocking, order in _BUILTINS:
        if get_type_by_slug(db, slug) is None:
            db.add(FlagType(slug=slug, label=label, color=color, kind=kind,
                            is_blocking=blocking, sort_order=order,
                            entity_types=[], is_builtin=True))
    db.commit()


def _slugify(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (label or "").strip().lower()).strip("_")
    return s or "type"


def _unique_slug(db: Session, base: str) -> str:
    """First free slug in the base, base_2, base_3, ... sequence."""
    if get_type_by_slug(db, base) is None:
        return base
    n = 2
    while get_type_by_slug(db, f"{base}_{n}") is not None:
        n += 1
    return f"{base}_{n}"


# --- reads ---------------------------------------------------------------
def list_types(db: Session, entity_type: Optional[str] = None,
               active_only: bool = False) -> list[FlagType]:
    """All flag types ordered by sort_order then slug.

    `active_only=True` is for the raise *picker* (hide deactivated types).
    `entity_type` keeps only types that are global (entity_types empty) OR scope
    that entity type. Color/label resolution must call this WITHOUT active_only
    so deactivated-but-still-used types keep rendering."""
    stmt = select(FlagType).order_by(FlagType.sort_order, FlagType.slug)
    if active_only:
        stmt = stmt.where(FlagType.is_active.is_(True))
    rows = list(db.execute(stmt).scalars().all())
    if entity_type is not None:
        rows = [r for r in rows if not r.entity_types or entity_type in r.entity_types]
    return rows


def get_type(db: Session, type_id: int) -> Optional[FlagType]:
    return db.get(FlagType, type_id)


def get_type_by_slug(db: Session, slug: str) -> Optional[FlagType]:
    return db.execute(select(FlagType).where(FlagType.slug == slug)).scalar_one_or_none()


def is_valid_type(db: Session, slug: str) -> bool:
    """True if a type with this slug exists (active or not — existing flags of a
    deactivated type still validate)."""
    return get_type_by_slug(db, slug) is not None


def kind_for_type(db: Session, slug: str) -> str:
    t = get_type_by_slug(db, slug)
    if t is None:
        raise ValueError(f"unknown flag type {slug!r}")
    return t.kind


def is_allowed_for_entity(db: Session, slug: str, entity_type: str) -> bool:
    """Whether a flag of this type may be RAISED on this entity type: the type
    must exist, be active, and be global (entity_types empty) or scope this
    entity type."""
    t = get_type_by_slug(db, slug)
    if t is None or not t.is_active:
        return False
    return (not t.entity_types) or (entity_type in t.entity_types)


# --- writes --------------------------------------------------------------
def create_type(db: Session, *, label: str, color: str, kind: str,
                slug: Optional[str] = None, is_blocking: bool = False,
                entity_types: Optional[list] = None,
                sort_order: Optional[int] = None,
                is_active: bool = True) -> FlagType:
    explicit = bool(slug and slug.strip())
    slug = (slug or _slugify(label)).strip()
    if explicit:
        # An explicitly-provided slug that collides is real user intent → 409.
        if get_type_by_slug(db, slug) is not None:
            raise ConflictError(f"flag type slug {slug!r} already exists")
    else:
        # Slug derived from the label (the "Add Type" create-then-rename UX
        # always POSTs the same default label with no slug): auto-uniquify
        # instead of colliding.
        slug = _unique_slug(db, slug)
    if sort_order is None:
        max_order = db.execute(select(FlagType.sort_order)).scalars().all()
        sort_order = (max(max_order) + 1) if max_order else 0
    t = FlagType(slug=slug, label=label, color=color, kind=kind,
                 is_blocking=is_blocking, entity_types=list(entity_types or []),
                 sort_order=sort_order, is_active=is_active, is_builtin=False)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def update_type(db: Session, type_id: int, **fields) -> FlagType:
    t = get_type(db, type_id)
    if t is None:
        raise NotFoundError(f"flag type {type_id} not found")
    # slug is immutable — reject a change, ignore a no-op restatement.
    if "slug" in fields:
        new_slug = fields.pop("slug")
        if new_slug is not None and new_slug != t.slug:
            raise BadRequestError("flag type slug is immutable")
    for key in ("label", "color", "kind", "is_blocking", "is_active", "sort_order"):
        if key in fields and fields[key] is not None:
            setattr(t, key, fields[key])
    if "entity_types" in fields and fields["entity_types"] is not None:
        t.entity_types = list(fields["entity_types"])
    db.commit()
    db.refresh(t)
    return t


def set_active(db: Session, type_id: int, active: bool) -> FlagType:
    return update_type(db, type_id, is_active=active)


def delete_type(db: Session, type_id: int) -> None:
    """Hard-delete an UNUSED custom type. Built-in or in-use types raise
    ConflictError — the caller should deactivate (set_active False) instead."""
    t = get_type(db, type_id)
    if t is None:
        raise NotFoundError(f"flag type {type_id} not found")
    if t.is_builtin:
        raise ConflictError("built-in flag types cannot be deleted; deactivate instead")
    in_use = db.execute(
        select(FlagFlag.id).where(FlagFlag.type == t.slug).limit(1)
    ).first()
    if in_use is not None:
        raise ConflictError("flag type is in use; deactivate instead")
    db.delete(t)
    db.commit()
