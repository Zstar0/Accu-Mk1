"""Business rules for the documents library (spec §3, §5).

Routes are thin; everything that can be unit-tested against SQLite lives here.
Callers commit through these functions; nothing here is left half-flushed. The
one exception is mint_code(), which flushes without committing and holds the
per-prefix counter row lock for the caller's transaction to close.
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import date, datetime
from typing import Optional

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session, lazyload

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
            DocumentCategory.id != cat.id).limit(1)).scalar_one_or_none()
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
    """Accepts an id, a code prefix, or a name (case-insensitive). A key can hit
    two rows (one by prefix, another by name), so precedence is explicit: exact
    code_prefix wins, then lowest id. Inactive categories cannot be chosen for
    new documents."""
    if category_id is not None:
        cat = get_category(db, category_id)
    elif category:
        key = category.strip()
        cat = db.execute(select(DocumentCategory).where(
            or_(DocumentCategory.code_prefix == key.upper(),
                func.lower(DocumentCategory.name) == key.lower()))
            .order_by(case((DocumentCategory.code_prefix == key.upper(), 0), else_=1),
                      DocumentCategory.id)).scalars().first()
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


# --- documents ---------------------------------------------------------------------

def validate_html(html) -> bytes:
    """UTF-8 bytes of an HTML document: <= MAX_BYTES, first non-blank byte '<'."""
    data = html.encode("utf-8") if isinstance(html, str) else bytes(html or b"")
    if len(data) > MAX_BYTES:
        raise BadRequestError(f"content exceeds {MAX_BYTES} bytes")
    head = data.lstrip(b"\xef\xbb\xbf \t\r\n")[:1]
    if head != b"<":
        raise BadRequestError("content must be an HTML document")
    return data


def _clean_code(code: str) -> str:
    code = (code or "").strip().upper()
    if not CODE_RE.match(code) or len(code) > 30:
        raise BadRequestError("code must look like ART-0012 (uppercase letters/digits, one dash after the prefix)")
    return code


def _latest(db: Session, code: str, for_update: bool = False) -> Optional[Document]:
    """Highest revision of a code. for_update row-locks it so two concurrent pushes
    to the same code cannot both read revision N and both compute N+1: the loser
    would write a row the (code, revision) unique constraint then rejects, after it
    had already spent the blob write. Storage keys carry the content hash, so
    neither push can clobber the other's bytes even if the lock is a no-op.
    Postgres honours FOR UPDATE; SQLite ignores it and is single-writer anyway.

    Document.category is lazy="joined", so a plain select emits a LEFT OUTER JOIN and
    Postgres then refuses the lock outright ("FOR UPDATE cannot be applied to the
    nullable side of an outer join"). SQLite drops FOR UPDATE silently, so this only
    ever surfaced on a real database. Drop the eager join on the locking path; the
    caller touches latest.category at most once, which lazy-loads it."""
    stmt = (select(Document).where(Document.code == code)
            .order_by(Document.revision.desc()).limit(1))
    if for_update:
        stmt = stmt.options(lazyload(Document.category)).with_for_update()
    return db.execute(stmt).scalars().first()


def _activate(db: Session, doc: Document) -> None:
    """Lockstep (mirrors main.py activate_method R-P3-2): retire EVERY other
    active row of this code, then activate self. No commit here."""
    if doc.status != "draft":
        raise ConflictError(f"only drafts activate (this revision is {doc.status})")
    now = datetime.utcnow()
    stale = db.execute(select(Document).where(
        Document.code == doc.code, Document.status == "active",
        Document.id != doc.id)).scalars().all()
    for row in stale:
        row.status = "retired"
        row.retired_at = now
    db.flush()  # clears the partial unique index before self goes active
    doc.status = "active"
    doc.activated_at = now
    if doc.effective_date is None:
        # Local business date (repo convention, 5 call sites); now stays UTC for timestamps.
        doc.effective_date = date.today()
    db.flush()


def create_document(db: Session, *, title: str, html, category: Optional[DocumentCategory],
                    description: Optional[str] = None, code: Optional[str] = None,
                    author: Optional[str] = None, source_session: Optional[str] = None,
                    effective_date: Optional[date] = None, activate: bool = True,
                    user_id: Optional[int] = None) -> tuple[Document, bool]:
    """Create revision 1 of a new code, or the next revision of an existing one.
    Identical bytes on an existing code => metadata patch, no new row (§5.5)."""
    title = (title or "").strip()
    if not title:
        raise BadRequestError("title is required")
    data = validate_html(html)
    sha = hashlib.sha256(data).hexdigest()

    latest = None
    if code:
        code = _clean_code(code)
        latest = _latest(db, code, for_update=True)  # serialize same-code pushes

    if latest is not None:
        if category is not None and category.code_prefix != code.split("-", 1)[0]:
            # Mirrors the new-code check below: the code was minted from a prefix and
            # never changes, so a revision push cannot refile it under another one.
            # Checked before the identical-bytes branch below, which commits a title
            # change: otherwise a push this guard is meant to reject still mutates the
            # row whenever the bytes happen to match.
            raise BadRequestError(
                f"code prefix must be {category.code_prefix} for category {category.name}")
        if latest.content_sha256 == sha:
            latest.title = title
            if description is not None:
                latest.description = description
            db.commit()
            db.refresh(latest)
            return latest, False
        cat = category if category is not None else latest.category
        revision = latest.revision + 1
        supersedes_id = latest.id
    else:
        if category is None:
            raise BadRequestError("category is required for a new document")
        cat = category
        if code:
            if code.split("-", 1)[0] != cat.code_prefix:
                raise BadRequestError(
                    f"code prefix must be {cat.code_prefix} for category {cat.name}")
        else:
            code = mint_code(db, cat.code_prefix)
        revision = 1
        supersedes_id = None

    key = get_storage().save(code, revision, data)
    doc = Document(code=code, revision=revision, title=title, description=description,
                   category_id=cat.id, status="draft", effective_date=effective_date,
                   supersedes_id=supersedes_id, author=author, updated_by=author,
                   source_session=source_session,
                   created_by_user_id=user_id, storage_key=key, size_bytes=len(data),
                   content_sha256=sha)
    db.add(doc)
    db.flush()
    if activate:
        _activate(db, doc)
    db.commit()
    db.refresh(doc)
    return doc, True


def get_document(db: Session, doc_id: int) -> Document:
    doc = db.get(Document, doc_id)
    if doc is None:
        raise NotFoundError(f"document {doc_id} not found")
    return doc


def get_revisions(db: Session, code: str) -> list[Document]:
    return db.execute(select(Document).where(Document.code == code)
                      .order_by(Document.revision)).scalars().all()


def revision_count(db: Session, code: str) -> int:
    return db.execute(select(func.count(Document.id))
                      .where(Document.code == code)).scalar_one()


def activate_document(db: Session, doc_id: int) -> Document:
    doc = get_document(db, doc_id)
    _activate(db, doc)
    db.commit()
    db.refresh(doc)
    return doc


def retire_document(db: Session, doc_id: int) -> Document:
    doc = get_document(db, doc_id)
    if doc.status != "active":
        raise ConflictError(f"only active revisions retire (this revision is {doc.status})")
    doc.status = "retired"
    doc.retired_at = datetime.utcnow()
    db.commit()
    db.refresh(doc)
    return doc


def delete_document(db: Session, doc_id: int, *, expect_code: str,
                    expect_revision: int) -> dict:
    """Hard-delete ONE draft revision. Controlled documents are retired, not
    deleted: `retire_document` is the answer for anything in force. This exists
    only to discard a draft that was never published.

    `expect_code`/`expect_revision` must match the target. The caller is usually
    an agent, and an id it guessed wrong would otherwise delete a real document;
    naming the code and revision makes a wrong target fail closed.
    """
    doc = get_document(db, doc_id)
    if (doc.code, doc.revision) != (expect_code, expect_revision):
        raise BadRequestError(
            f"target mismatch: id={doc_id} is {doc.code} r{doc.revision}, "
            f"caller named {expect_code} r{expect_revision}")
    if doc.status != "draft":
        raise ConflictError(
            f"only draft revisions delete (this one is {doc.status}); "
            f"retire it instead to keep the lineage")
    # A revision this one supersedes would be orphaned by the delete: its
    # successor row would vanish and leave the chain pointing at nothing.
    dependent = db.execute(
        select(Document.id).where(Document.supersedes_id == doc.id).limit(1)
    ).scalar_one_or_none()
    if dependent is not None:
        raise ConflictError(
            f"revision {doc.id} is superseded by {dependent}; retire instead")
    key, code, revision = doc.storage_key, doc.code, doc.revision
    db.delete(doc)
    db.commit()
    # Row first, bytes second. A failed blob delete leaves an inert orphan;
    # the reverse would leave a live row pointing at content that is gone.
    try:
        get_storage().delete(key)
    except Exception as e:
        logging.getLogger(__name__).warning(
            "documents blob orphaned key=%s err=%s", key, e)
    return {"deleted": True, "code": code, "revision": revision}


def patch_document(db: Session, doc_id: int, **fields) -> Document:
    """Metadata only (§5.1 PATCH). Never bumps revision, never touches content.
    Every field is validated BEFORE any attribute is assigned: a half-applied
    patch would leave the row dirty in the session, and the next autoflush would
    persist it even though the caller saw an exception."""
    doc = get_document(db, doc_id)
    updated_by = fields.pop("updated_by", None)
    allowed = {"title", "description", "category_id", "effective_date"}
    unknown = set(fields) - allowed
    if unknown:
        raise BadRequestError(f"cannot patch {sorted(unknown)}")
    title = None
    if "title" in fields:
        title = (fields["title"] or "").strip()
        if not title:
            raise BadRequestError("title is required")
    category_id = None
    if "category_id" in fields and fields["category_id"] is not None:
        cat = get_category(db, int(fields["category_id"]))
        code_prefix = doc.code.split("-", 1)[0]
        if cat.code_prefix != code_prefix:
            # The code was minted from its category's prefix and never changes;
            # a cross-prefix move would leave ART-0001 filed under SOP.
            raise BadRequestError(
                f"category prefix must be {code_prefix} for code {doc.code}")
        category_id = cat.id
    if title is not None:
        doc.title = title
    if "description" in fields:
        doc.description = fields["description"]
    if category_id is not None:
        doc.category_id = category_id
    if "effective_date" in fields:
        doc.effective_date = fields["effective_date"]
    if updated_by:
        doc.updated_by = updated_by
    db.commit()
    db.refresh(doc)
    return doc


def list_documents(db: Session, *, q: Optional[str] = None, category_id: Optional[int] = None,
                   statuses=("draft", "active"), sort: str = "updated_at",
                   page: int = 1, page_size: int = 50) -> tuple[list[tuple[Document, int]], int]:
    """Latest revision per code AMONG the rows matching `statuses`, then the other
    filters. Filter-first matters: a code whose newest revision is a draft still
    surfaces its active revision under statuses=("active",), and a retired-only
    listing surfaces the revision that a later activation retired. revision_count
    stays the UNFILTERED number of revisions for that code (its own subquery — the
    latest-revision one is status-filtered and would undercount).
    Returns ([(doc, revision_count)], total)."""
    if sort not in SORTS:
        raise BadRequestError(f"sort must be one of {SORTS}")
    bad = set(statuses or ()) - set(STATUSES)
    if bad:
        raise BadRequestError(f"unknown status {sorted(bad)}")
    page = max(1, int(page))
    page_size = max(1, min(200, int(page_size)))

    latest = select(Document.code.label("code"), func.max(Document.revision).label("rev"))
    if statuses:
        latest = latest.where(Document.status.in_(tuple(statuses)))
    latest = latest.group_by(Document.code).subquery()
    counts = (select(Document.code.label("code"), func.count(Document.id).label("n"))
              .group_by(Document.code).subquery())
    stmt = (select(Document, counts.c.n)
            .join(latest, and_(Document.code == latest.c.code,
                               Document.revision == latest.c.rev))
            .join(counts, Document.code == counts.c.code))
    if category_id is not None:
        stmt = stmt.where(Document.category_id == category_id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Document.code.ilike(like), Document.title.ilike(like),
                              Document.description.ilike(like)))
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    order = {
        "updated_at": (Document.updated_at.desc(), Document.id.desc()),
        "title": (func.lower(Document.title).asc(), Document.id.asc()),
        "code": (Document.code.asc(),),
        "effective_date": (Document.effective_date.desc(), Document.id.desc()),
    }[sort]
    rows = db.execute(stmt.order_by(*order)
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return [(doc, int(n)) for doc, n in rows], int(total)


def read_content(doc: Document) -> bytes:
    return get_storage().fetch(doc.storage_key)
