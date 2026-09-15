"""Business rules for the documents library (spec §3, §5).

Routes are thin; everything that can be unit-tested against SQLite lives here.
Callers commit through these functions; nothing here is left half-flushed.
"""
from __future__ import annotations

import hashlib
import re
from datetime import date, datetime
from typing import Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from documents.errors import BadRequestError, ConflictError, NotFoundError
from documents.models import Document, DocumentCategory, DocumentCodeCounter
from documents.storage import get_storage

PREFIX_RE = re.compile(r"^[A-Z0-9]{2,10}$")
CODE_RE = re.compile(r"^[A-Z0-9]+-[A-Z0-9-]+$")
MAX_BYTES = 16 * 1024 * 1024
STATUSES = ("draft", "active", "retired")
SORTS = ("updated_at", "title", "code", "effective_date")

# (name, code_prefix, description, sort_order) — seeded idempotently at boot.
_SEED_CATEGORIES = (
    ("Artifact", "ART", "Report pages and analyses built by agents", 0),
    ("SOP", "SOP", "Standard operating procedures", 1),
)


# --- categories ---------------------------------------------------------------

def seed_categories(db: Session) -> None:
    """Idempotent by name. Production and tests both go through here (the
    tables come from create_all, so there is no _run_migrations twin)."""
    for name, prefix, desc, order in _SEED_CATEGORIES:
        exists = db.execute(select(DocumentCategory.id)
                            .where(DocumentCategory.name == name)).scalar_one_or_none()
        if exists is None:
            db.add(DocumentCategory(name=name, code_prefix=prefix, description=desc,
                                    sort_order=order))
    db.commit()


def _document_counts(db: Session) -> dict[int, int]:
    rows = db.execute(select(Document.category_id,
                             func.count(func.distinct(Document.code)))
                      .group_by(Document.category_id)).all()
    return {cid: n for cid, n in rows}


def list_categories(db: Session, active_only: bool = False) -> list[tuple[DocumentCategory, int]]:
    stmt = select(DocumentCategory)
    if active_only:
        stmt = stmt.where(DocumentCategory.active.is_(True))
    stmt = stmt.order_by(DocumentCategory.sort_order, DocumentCategory.name)
    counts = _document_counts(db)
    return [(c, counts.get(c.id, 0)) for c in db.execute(stmt).scalars().all()]


def get_category(db: Session, category_id: int) -> DocumentCategory:
    cat = db.get(DocumentCategory, category_id)
    if cat is None:
        raise NotFoundError(f"category {category_id} not found")
    return cat


def _clean_prefix(code_prefix: str) -> str:
    prefix = (code_prefix or "").strip().upper()
    if not PREFIX_RE.match(prefix):
        raise BadRequestError("code_prefix must be 2-10 uppercase letters or digits")
    return prefix


def _clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise BadRequestError("name is required")
    return name


def create_category(db: Session, *, name: str, code_prefix: str,
                    description: Optional[str] = None, sort_order: int = 0) -> DocumentCategory:
    name = _clean_name(name)
    prefix = _clean_prefix(code_prefix)
    dup = db.execute(select(DocumentCategory.id).where(
        or_(func.lower(DocumentCategory.name) == name.lower(),
            DocumentCategory.code_prefix == prefix)).limit(1)).scalar_one_or_none()
    if dup is not None:
        raise ConflictError("a category with that name or prefix already exists")
    cat = DocumentCategory(name=name, code_prefix=prefix, description=description,
                           sort_order=sort_order)
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


def update_category(db: Session, category_id: int, **fields) -> DocumentCategory:
    cat = get_category(db, category_id)
    allowed = {"name", "description", "sort_order", "active"}
    unknown = set(fields) - allowed
    if unknown:
        raise BadRequestError(f"cannot update {sorted(unknown)}")
    if "name" in fields:
        name = _clean_name(fields["name"])
        dup = db.execute(select(DocumentCategory.id).where(
            func.lower(DocumentCategory.name) == name.lower(),
            DocumentCategory.id != cat.id)).scalar_one_or_none()
        if dup is not None:
            raise ConflictError("a category with that name already exists")
        cat.name = name
    if "description" in fields:
        cat.description = fields["description"]
    if "sort_order" in fields:
        cat.sort_order = int(fields["sort_order"])
    if "active" in fields:
        cat.active = bool(fields["active"])
    db.commit()
    db.refresh(cat)
    return cat


def delete_category(db: Session, category_id: int) -> None:
    cat = get_category(db, category_id)
    used = db.execute(select(Document.id).where(Document.category_id == cat.id)
                      .limit(1)).scalar_one_or_none()
    if used is not None:
        raise ConflictError("category is referenced by documents; deactivate it instead")
    db.delete(cat)
    db.commit()


def resolve_category(db: Session, *, category: Optional[str] = None,
                     category_id: Optional[int] = None) -> DocumentCategory:
    """Accepts an id, a code prefix, or a name (case-insensitive). Inactive
    categories cannot be chosen for new documents."""
    if category_id is not None:
        cat = get_category(db, category_id)
    elif category:
        key = category.strip()
        cat = db.execute(select(DocumentCategory).where(
            or_(DocumentCategory.code_prefix == key.upper(),
                func.lower(DocumentCategory.name) == key.lower()))).scalars().first()
        if cat is None:
            raise NotFoundError(f"category {category!r} not found")
    else:
        raise BadRequestError("category is required")
    if not cat.active:
        raise BadRequestError(f"category {cat.name!r} is inactive")
    return cat


# --- code minting --------------------------------------------------------------

def mint_code(db: Session, prefix: str) -> str:
    """{prefix}-{NNNN} from the per-prefix counter, skipping any number a
    supplied code already occupies (spec §3.3, §5.4). Row-locked on Postgres;
    SQLite ignores FOR UPDATE, which is fine for tests."""
    counter = db.get(DocumentCodeCounter, prefix, with_for_update=True)
    if counter is None:
        counter = DocumentCodeCounter(prefix=prefix, next_number=1)
        db.add(counter)
        db.flush()
    n = counter.next_number
    while True:
        code = f"{prefix}-{n:04d}"
        taken = db.execute(select(Document.id).where(Document.code == code)
                           .limit(1)).scalar_one_or_none()
        if taken is None:
            break
        n += 1
    counter.next_number = n + 1
    db.flush()
    return code
