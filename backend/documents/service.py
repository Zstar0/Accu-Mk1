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
from functools import lru_cache
from pathlib import Path
from typing import Callable, Optional

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session, lazyload

from documents.errors import BadRequestError, ConflictError, NotFoundError
from documents.models import (Document, DocumentCategory, DocumentCodeCounter, DocumentSpace,
                              DocumentSpaceGrant, SPACE_VISIBILITIES)
from documents.storage import get_storage

PREFIX_RE = re.compile(r"^[A-Z0-9]{2,10}$")
CODE_RE = re.compile(r"^[A-Z0-9]+-[A-Z0-9-]+$")
MAX_BYTES = 16 * 1024 * 1024
STATUSES = ("draft", "active", "retired")
SORTS = ("updated_at", "title", "code", "effective_date")
GENERAL_SLUG = "general"
SPACE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")

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


# --- spaces (spec 2026-10-06 section 4) ------------------------------------------------

def seed_spaces(db: Session) -> None:
    """Idempotent: upsert General, then backfill any document row without a space.
    Runs at every boot; a no-op after the first."""
    general = db.execute(select(DocumentSpace).where(DocumentSpace.slug == GENERAL_SLUG)
                         ).scalar_one_or_none()
    if general is None:
        general = DocumentSpace(slug=GENERAL_SLUG, name="General",
                                description="Documents every login can read", visibility="company",
                                sort_order=0)
        db.add(general)
        db.flush()
    db.execute(Document.__table__.update().where(Document.space_id.is_(None))
               .values(space_id=general.id))
    db.commit()


def general_space(db: Session) -> DocumentSpace:
    sp = db.execute(select(DocumentSpace).where(DocumentSpace.slug == GENERAL_SLUG)).scalar_one_or_none()
    if sp is None:
        seed_spaces(db)
        sp = db.execute(select(DocumentSpace).where(DocumentSpace.slug == GENERAL_SLUG)).scalar_one()
    return sp


def _clean_slug(slug: str) -> str:
    slug = (slug or "").strip().lower()
    if not SPACE_SLUG_RE.match(slug):
        raise BadRequestError("slug must be 1-60 chars of a-z, 0-9 and '-', starting with a letter or digit")
    return slug


def get_space(db: Session, space_id: int) -> DocumentSpace:
    sp = db.get(DocumentSpace, space_id)
    if sp is None:
        raise NotFoundError(f"space {space_id} not found")
    return sp


def get_space_by_slug(db: Session, slug: str) -> DocumentSpace:
    sp = db.execute(select(DocumentSpace).where(DocumentSpace.slug == (slug or "").strip().lower())
                    ).scalar_one_or_none()
    if sp is None:
        raise NotFoundError(f"space {slug!r} not found")
    return sp


def resolve_space(db: Session, *, space: Optional[str] = None,
                  space_id: Optional[int] = None) -> DocumentSpace:
    """Slug or id; neither means General."""
    if space_id is not None:
        return get_space(db, int(space_id))
    if space and space.strip():
        return get_space_by_slug(db, space)
    return general_space(db)


def _space_counts(db: Session) -> dict[int, int]:
    """Distinct codes per space whose rows are draft or active (what the default list
    shows). A code with only retired rows does not count. NULL space_id reads as General."""
    general_id = db.execute(select(DocumentSpace.id).where(DocumentSpace.slug == GENERAL_SLUG)
                            ).scalar_one_or_none()
    sid = func.coalesce(Document.space_id, general_id) if general_id is not None else Document.space_id
    rows = db.execute(select(sid, func.count(func.distinct(Document.code)))
                      .where(Document.status.in_(("draft", "active")))
                      .group_by(sid)).all()
    return {k: n for k, n in rows}


def list_spaces(db: Session, include_inactive: bool = False) -> list[tuple[DocumentSpace, int]]:
    stmt = select(DocumentSpace)
    if not include_inactive:
        stmt = stmt.where(DocumentSpace.is_active.is_(True))
    rows = db.execute(stmt.order_by(DocumentSpace.sort_order, func.lower(DocumentSpace.name))).scalars().all()
    counts = _space_counts(db)
    # General first regardless of sort_order (spec 9.1).
    rows = sorted(rows, key=lambda sp: (0 if sp.slug == GENERAL_SLUG else 1))
    return [(sp, counts.get(sp.id, 0)) for sp in rows]



def create_space(db: Session, *, slug: str, name: str, description: Optional[str] = None,
                 visibility: str = "company", sort_order: int = 0) -> DocumentSpace:
    slug = _clean_slug(slug)
    name = _clean_name(name)
    if visibility not in SPACE_VISIBILITIES:
        raise BadRequestError(f"visibility must be one of {SPACE_VISIBILITIES}")
    if db.execute(select(DocumentSpace.id).where(DocumentSpace.slug == slug)).scalar_one_or_none():
        raise ConflictError(f"space slug {slug!r} is taken")
    sp = DocumentSpace(slug=slug, name=name, description=(description or "").strip() or None,
                       visibility=visibility, sort_order=int(sort_order))
    db.add(sp)
    db.commit()
    db.refresh(sp)
    return sp


def update_space(db: Session, space_id: int, **fields) -> DocumentSpace:
    sp = get_space(db, space_id)
    allowed = {"name", "description", "visibility", "is_active", "sort_order"}
    unknown = set(fields) - allowed
    if unknown:
        raise BadRequestError(f"cannot update {sorted(unknown)}")
    if sp.slug == GENERAL_SLUG:
        if fields.get("visibility") == "restricted":
            raise BadRequestError("General is always company-visible")
        if fields.get("is_active") is False:
            raise BadRequestError("General cannot be deactivated")
    if fields.get("visibility") is not None and fields["visibility"] not in SPACE_VISIBILITIES:
        raise BadRequestError(f"visibility must be one of {SPACE_VISIBILITIES}")
    if fields.get("name") is not None:
        sp.name = _clean_name(fields["name"])
    if "description" in fields:
        sp.description = (fields["description"] or "").strip() or None
    if fields.get("visibility") is not None:
        sp.visibility = fields["visibility"]
    if fields.get("is_active") is not None:
        sp.is_active = bool(fields["is_active"])
    if fields.get("sort_order") is not None:
        sp.sort_order = int(fields["sort_order"])
    db.commit()
    db.refresh(sp)
    return sp


def list_space_grants(db: Session, space_id: int) -> list[int]:
    get_space(db, space_id)
    return sorted(int(g) for g in db.execute(
        select(DocumentSpaceGrant.group_id).where(DocumentSpaceGrant.space_id == space_id)).scalars())


def replace_space_grants(db: Session, space_id: int, group_ids: list[int]) -> list[int]:
    """Whole-list replace. Every id must be an ACTIVE group (spec 8.1)."""
    from groups.models import UserGroup
    get_space(db, space_id)
    wanted = sorted(set(int(g) for g in group_ids))
    if wanted:
        ok = set(db.execute(select(UserGroup.id).where(UserGroup.id.in_(wanted),
                                                       UserGroup.is_active.is_(True))).scalars())
        bad = [g for g in wanted if g not in ok]
        if bad:
            raise BadRequestError(f"unknown or inactive group ids: {bad}")
    db.query(DocumentSpaceGrant).filter(DocumentSpaceGrant.space_id == space_id).delete()
    db.add_all([DocumentSpaceGrant(space_id=space_id, group_id=g) for g in wanted])
    db.commit()
    return wanted


def delete_space(db: Session, space_id: int) -> None:
    sp = get_space(db, space_id)
    if sp.slug == GENERAL_SLUG:
        raise BadRequestError("General cannot be deleted")
    held = db.execute(select(func.count(Document.id)).where(Document.space_id == sp.id)).scalar_one()
    if held:
        raise ConflictError(f"space {sp.slug!r} still holds {held} document revision(s); move them first")
    db.delete(sp)
    db.commit()


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


# --- house theme ------------------------------------------------------------------------
# Applied HERE, not by clients, so every writer (publish skill, labmanager MCP, admin) gets
# the same look. Inlined, never linked: revisions are snapshots and must not change when the
# theme file changes later (spec §7). Prepended as the FIRST <style> in <head> so a page that
# carries its own CSS (artifact pages do) still wins on every rule it sets.
THEME_PATH = Path(__file__).with_name("accumark-docs.css")
THEME_MARKER_RE = re.compile(r"/\*\s*accumark-docs v\d+")
FONTS_HOST = "fonts.googleapis.com"
FONTS_LINK = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2'
              '?family=Archivo:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600'
              '&family=IBM+Plex+Mono:wght@400;500&display=swap">')


@lru_cache(maxsize=1)
def theme_css() -> str:
    return THEME_PATH.read_text(encoding="utf-8")


def inline_theme(html: str) -> str:
    """Return html with the house theme inlined once. No-op when a marker is present.
    Adds the Google Fonts link when the document carries none, so the theme's faces
    resolve inside the viewer frame (fallback stacks apply offline)."""
    if THEME_MARKER_RE.search(html):
        return html
    block = f"<style>\n{theme_css()}\n</style>\n"
    if FONTS_HOST not in html:
        block = FONTS_LINK + "\n" + block
    m = re.search(r"<head\b[^>]*>", html, re.IGNORECASE)
    if m:
        i = m.end()
        return html[:i] + "\n" + block + html[i:]
    m = re.search(r"<html\b[^>]*>", html, re.IGNORECASE)
    i = m.end() if m else 0
    return html[:i] + "\n<head>\n" + block + "</head>\n" + html[i:]


def validate_html(html) -> bytes:
    """UTF-8 bytes of a THEMED HTML document: first non-blank byte '<', theme inlined
    once, <= MAX_BYTES after theming (the stored bytes are what the limit protects)."""
    text = html if isinstance(html, str) else bytes(html or b"").decode("utf-8", "replace")
    if text.lstrip("\ufeff \t\r\n")[:1] != "<":
        raise BadRequestError("content must be an HTML document")
    data = inline_theme(text).encode("utf-8")
    if len(data) > MAX_BYTES:
        raise BadRequestError(f"content exceeds {MAX_BYTES} bytes")
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
        # The lab's calendar day, not the container's. date.today() looks local but
        # the container runs UTC, so an evening publish stamped tomorrow. Same
        # BusinessHoursConfig + lab_day the SLA and throughput reports use.
        doc.effective_date = _lab_today(db)
    db.flush()


def _lab_today(db: Session) -> date:
    """Today on the lab's clock. Falls back to America/Los_Angeles exactly as the
    reports do when the config row is missing."""
    from models import BusinessHoursConfig
    from throughput import lab_day
    cfg = db.get(BusinessHoursConfig, 1)
    tz = (cfg.timezone if cfg and cfg.timezone else "America/Los_Angeles")
    return lab_day(datetime.utcnow(), tz)


def create_document(db: Session, *, title: str = "", html, category: Optional[DocumentCategory],
                    description: Optional[str] = None, code: Optional[str] = None,
                    author: Optional[str] = None, source_session: Optional[str] = None,
                    effective_date: Optional[date] = None, activate: bool = True,
                    user_id: Optional[int] = None,
                    co_author: Optional[str] = None,
                    space: Optional[DocumentSpace] = None,
                    may_revise: Optional[Callable[[Document], bool]] = None) -> tuple[Document, bool]:
    """Create revision 1 of a new code, or the next revision of an existing one.
    Identical bytes on an existing code => metadata patch, no new row (§5.5).
    `may_revise` is checked under the row lock: False reads as an unknown code, so a
    code minted into a hidden space between the caller's check and this lock is never
    revised (or named) by a caller who cannot see it."""
    title = (title or "").strip()
    data = validate_html(html)
    sha = hashlib.sha256(data).hexdigest()

    latest = None
    if code:
        code = _clean_code(code)
        latest = _latest(db, code, for_update=True)  # serialize same-code pushes
        if latest is not None and may_revise is not None and not may_revise(latest):
            raise NotFoundError(f"document {code!r} not found")

    if latest is not None:
        # A revision push may omit title and description: "revise SOP-0001 with this
        # content" should not have to restate them. Omitted = inherit from the
        # revision being superseded; sending them still overrides.
        title = title or latest.title
        if description is None:
            description = latest.description
        if category is not None and category.code_prefix != code.split("-", 1)[0]:
            # Mirrors the new-code check below: the code was minted from a prefix and
            # never changes, so a revision push cannot refile it under another one.
            # Checked before the identical-bytes branch below, which commits a title
            # change: otherwise a push this guard is meant to reject still mutates the
            # row whenever the bytes happen to match.
            raise BadRequestError(
                f"code prefix must be {category.code_prefix} for category {category.name}")
        if space is not None and space.id != (latest.space_id or general_space(db).id):
            raise BadRequestError(
                f"revisions stay in the document's space; move {code} with PATCH space_id instead")
        space_id = latest.space_id if latest.space_id is not None else general_space(db).id
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
        if not title:
            raise BadRequestError("title is required for a new document")
        if category is None:
            raise BadRequestError("category is required for a new document")
        cat = category
        space_id = (space or general_space(db)).id
        if code:
            if code.split("-", 1)[0] != cat.code_prefix:
                raise BadRequestError(
                    f"code prefix must be {cat.code_prefix} for category {cat.name}")
        else:
            existing = db.execute(
                select(Document.code, Document.revision)
                .where(Document.content_sha256 == sha,
                       Document.category_id == cat.id,
                       (or_(Document.space_id == space_id, Document.space_id.is_(None))
                        if space_id == general_space(db).id else Document.space_id == space_id))
                .order_by(Document.id).limit(1)
            ).first()
            if existing is not None:
                # Without this a retry mints a SECOND controlled document holding
                # identical content, which is how ART-0002 was born. Dedupe on an
                # existing code lives in the `if code:` branch above; here the
                # caller has to say which document it meant.
                # Scoped to the category on purpose: an SOP and an artifact that
                # share bytes are different controlled documents, and the code
                # prefix a category fixes is what makes them different.
                # Scoped to the category AND the space: a 409 that named a code in a
                # space the caller cannot see would confirm that document exists
                # (spec 5.2).
                raise ConflictError(
                    f"this content is already published as {existing[0]} "
                    f"r{existing[1]}; pass code={existing[0]} to publish it as a new "
                    f"revision, or change the content to mint a new document")
            code = mint_code(db, cat.code_prefix)
        revision = 1
        supersedes_id = None

    key = get_storage().save(code, revision, data)
    doc = Document(code=code, revision=revision, title=title, description=description,
                   category_id=cat.id, space_id=space_id,
                   status="draft", effective_date=effective_date,
                   supersedes_id=supersedes_id, author=author, updated_by=author,
                   co_author=co_author,
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


def latest_revision(db: Session, code: str) -> Optional[Document]:
    """Highest revision of a code, or None. Public twin of _latest without the lock."""
    try:
        return _latest(db, _clean_code(code))
    except BadRequestError:
        return None


def move_document_space(db: Session, code: str, space_id: int, *, updated_by: Optional[str]) -> list[Document]:
    """Move EVERY revision of a code to another space in one transaction (spec 4.3)."""
    space = get_space(db, int(space_id))
    if not space.is_active:
        raise BadRequestError(f"space {space.slug!r} is inactive")
    code = _clean_code(code)
    # Take the same row lock create_document holds while it inserts revision r+1, so
    # a concurrent push either lands before this read (and is moved) or waits until
    # the move commits (and inherits the new space). Without it the newest revision
    # could be left behind in the old, possibly more visible, space.
    _latest(db, code, for_update=True)
    rows = get_revisions(db, code)
    if not rows:
        raise NotFoundError(f"document {code!r} not found")
    for r in rows:
        r.space_id = space.id
        if updated_by:
            r.updated_by = updated_by
    db.commit()
    for r in rows:
        db.refresh(r)
    logging.getLogger(__name__).info("documents.space_moved code=%s to=%s by=%s", code, space.slug, updated_by)
    return rows


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
    persist it even though the caller saw an exception.
    `space_id` is not a patch field here: the route routes it to move_document_space
    because it rewrites every revision."""
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
                   space_id: Optional[int] = None, visible_spaces=None,
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
    if space_id is not None:
        space_id = int(space_id)
        if space_id == general_space(db).id:
            # NULL reads as General everywhere (spec 4.4).
            stmt = stmt.where(or_(Document.space_id == space_id, Document.space_id.is_(None)))
        else:
            stmt = stmt.where(Document.space_id == space_id)
    if visible_spaces is not None:
        # NULL = General = company (spec 4.4), so it is always inside a visibility filter.
        stmt = stmt.where(or_(Document.space_id.in_(visible_spaces), Document.space_id.is_(None)))
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
