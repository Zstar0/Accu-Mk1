# Document Spaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a group-granted "space" the first level of the Documents library and the unit of read access, so accounting, leadership and lab documents can live in Mk1 without every login seeing all of them.

**Architecture:** Two new tables (`document_spaces`, `document_space_grants`) and one new column (`documents.space_id`, same on every revision of a code). One access module, `backend/documents/access.py`, mirrors `backend/boards/access.py` and is the only place that answers "can this user see this document"; every document route, the list query, the flag entity seams and the agent-token check call it. Hidden answers 404 exactly like missing. The frontend adds a space grid above the existing list, a `?space=<slug>` hash parameter, a Space select in the admin dialogs, and a Spaces section in Settings. The publish skill and labmanager-mcp gain a `space` argument; agent tokens gain an optional allow-list segment.

**Tech Stack:** FastAPI + SQLAlchemy 2 (Postgres in prod, SQLite in the suite), Pydantic v2, pytest; React 19 + TanStack Query + Zustand + shadcn/ui + vitest; Playwright on a devbox accumark-stack; Python stdlib skill script; FastMCP in labmanager-mcp.

**Spec:** `docs/superpowers/specs/2026-10-06-document-spaces-design.md` (same branch). Read it first; section numbers below refer to it.

## Global Constraints

- Additive only. No existing route changes shape except the listed `DocumentOut` additions; a failing existing test is a stale test until proven otherwise.
- Tables carry NO `lims_` prefix (documents are not sample-hierarchy entities).
- `DocumentOut` **and** `_doc_out` must both name every new field, or FastAPI's `response_model` silently drops it.
- Hidden is byte-identical to missing: same 404 status, same `detail` text as a nonexistent id. Never 403 for a read.
- General (`slug="general"`) is seeded, company-visible, undeletable, and refuses `visibility="restricted"` and `is_active=false` with 400.
- The space is a property of the code: every revision row of a code carries the same `space_id`; a move updates all of them in one transaction.
- Line endings: every file you create or append is LF. Write with the Write/Edit tools or `io.open(p, "w", newline="\n")`; never a Bash heredoc into a tracked file. Verify with `git ls-files --eol <file>` (`i/lf`).
- Commits: always `git -c core.autocrlf=true commit -m "..." -- <paths>` with an explicit pathspec. Never a bare `git commit` or `git add -A`.
- Python: `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`, run from `backend/` as the working directory. Bare `python` hangs on this machine.
- Run ONE pytest invocation at a time on this machine (two concurrent suites deadlock on the host Postgres).
- Backend gate = failure-set diff against the branch base, never a raw count. Known baseline failures include `test_api_reports_ready_to_publish::test_rows_sorted_and_totals` and the midnight-window `test_documents_service::test_create_mints_code_and_activates_by_default`.
- Frontend gate = `npm run typecheck` clean, vitest zero net-new, eslint and prettier clean on touched files (`npm run check:all` is red on master for unrelated counts).
- No new npm or Python dependencies.
- No em dashes anywhere (code comments, copy, docs).
- Worktree: `C:/tmp/mk1-groups`, branch `feat/document-spaces`, based on master v1.33.0.

## Review Focus

1. A `documents` row with `space_id IS NULL` (a boot where the backfill did not run, or a row inserted by an older image during a rolling restart) must read as General, be listed, and never crash `_doc_out`. Pinned in Task 1 (`test_null_space_reads_as_general`) and Task 3 (`test_list_includes_null_space_rows`).
2. A revision push that names a different `space` than the code already has must be refused with 400, not silently moved and not silently ignored. Pinned in Task 3 (`test_revision_cannot_change_space`).
3. Deleting a user group that still holds space grants must be refused with 409, the way boards grants already block it, so an admin cannot drop a Leadership grant by deleting the group without noticing. Pinned in Task 6 (`test_group_delete_refused_while_granted_on_a_space`).
4. An agent token entry whose third segment names a slug that does not exist yet must still parse (the slug is just a string) and must fail at write time with a 400 that names only the slug the caller sent. Pinned in Task 4 (`test_agent_tokens_third_segment`) and Task 5 (`test_agent_write_outside_allowlist`).
5. A deep link `#reports/documents?space=<slug>` for a space the caller cannot see must render the empty list state, not an error and not a 403, and must not leak the space name. Pinned in Task 5 (`test_list_for_hidden_space_is_empty`) and Task 10 (`shows the empty state for an unknown space slug`).

---

## File structure

Backend (all under `backend/`):

| File | Responsibility |
|---|---|
| `documents/models.py` (modify) | `DocumentSpace`, `DocumentSpaceGrant`, `Document.space_id` + `space` relationship |
| `documents/access.py` (create) | `can_view_space`, `visible_space_ids`, `can_view_document`, `require_view` |
| `documents/service.py` (modify) | space CRUD + seed + backfill, `resolve_space`, `latest_revision`, space on create, dedupe scope, `move_document_space`, list filter |
| `documents/schemas.py` (modify) | `SpaceOut`, `SpaceCreate`, `SpaceUpdate`, `SpaceGrantsReplace`, `SpaceGrantsOut`; `DocumentOut`, `DocumentCreate`, `DocumentPatch` additions |
| `documents/routes.py` (modify) | agent allow-list parsing, gates on every document route, space routes |
| `documents/flag_entity.py` (create) | visibility closures for the `document` flag entity |
| `flags/seams.py` (modify) | pass the five closures into `register_entity("document", ...)` |
| `database.py` (modify) | `_ensure_documents_space_column`, `seed_spaces` at boot |
| `groups/service.py` (modify) | `delete_group` also refuses when granted on a space |
| `tests/test_documents_access.py` (create), `tests/test_documents_spaces_routes.py` (create), `tests/test_documents_service.py`, `tests/test_documents_routes.py`, `tests/test_flags_documents.py`, `tests/test_groups_routes.py` (modify) | |

Frontend (under `src/`):

| File | Responsibility |
|---|---|
| `lib/api-documents.ts` (modify) | `DocumentSpace` types and fetchers; `DocumentRow` space fields; `DocumentPatch.space_id` |
| `components/documents/documents-utils.ts` (modify) | `DocumentListParams.spaceId`, query builder |
| `services/documents.ts` (modify) | `useDocumentSpaces`, space mutations, keys |
| `lib/hash-navigation.ts`, `store/ui-store.ts` (modify) | `?space=<slug>`, `documentsSpaceSlug`, `navigateToDocumentSpace` |
| `components/documents/SpacesGrid.tsx` (create) | the first level |
| `components/documents/DocumentsPage.tsx` (modify) | grid when no space selected, scoped list otherwise, breadcrumb |
| `components/documents/DocumentViewer.tsx` (modify) | space chip |
| `components/documents/RetitleDialog.tsx` (modify) | Space select (move) |
| `components/boards/DocumentPreviewFrame.tsx` (modify) | copy for a document the viewer cannot load |
| `components/preferences/panes/DocumentsPane.tsx` (modify) | Spaces section: rows, grants editor, new form |
| `locales/en.json`, `locales/ar.json`, `locales/fr.json` (modify) | flat `preferences.documents.spaces.*` keys |
| tests beside each component | |

Other:

| File | Responsibility |
|---|---|
| `.claude/skills/mk1-publish-document/scripts/publish_document.py`, `SKILL.md` (modify) | `--space` |
| labmanager-mcp `src/labmanager_mcp/tools/documents.py`, `tests/test_tools_documents.py` (modify, separate repo) | `space` on create/revise/list, `documents_spaces` tool |
| `e2e/document-spaces.spec.ts` (create) | stack proof |
| `CHANGELOG.md` (modify) | Unreleased entry |

Spec amendment carried by this plan (record it in spec section 15 in Task 9): the selected space slug lives in the UI store as `documentsSpaceSlug`, because every other deep link in this app round-trips through `hash-navigation.ts` and the store; spec 9.4 said "no new Zustand state" and is wrong on that point.

---

### Task 1: Space models, access module, seed and backfill

**Files:**
- Modify: `backend/documents/models.py`
- Create: `backend/documents/access.py`
- Modify: `backend/documents/service.py` (add space functions after the category block, before `# --- codes`)
- Test: `backend/tests/test_documents_access.py` (create), `backend/tests/test_documents_service.py` (append)

**Interfaces:**
- Produces: `DocumentSpace(id, slug, name, description, visibility, is_active, sort_order, created_at, updated_at)`, `DocumentSpaceGrant(id, space_id, group_id)`, `Document.space_id: Optional[int]`, `Document.space` (selectin relationship).
- Produces: `access.can_view_space(db, user, space) -> bool`, `access.visible_space_ids(db, user) -> Select`, `access.can_view_document(db, user, doc) -> bool`, `access.require_view(db, user, doc) -> None` (raises `documents.errors.NotFoundError("document {id} not found")`).
- Produces: `service.GENERAL_SLUG = "general"`, `service.seed_spaces(db)`, `service.general_space(db) -> DocumentSpace`, `service.get_space(db, space_id)`, `service.get_space_by_slug(db, slug)`, `service.resolve_space(db, *, space=None, space_id=None) -> DocumentSpace` (None/None returns General), `service.list_spaces(db, include_inactive=False) -> list[tuple[DocumentSpace, int]]`.

- [ ] **Step 1: Write the failing access tests**

```python
# backend/tests/test_documents_access.py
"""Document space access matrix (spec 2026-10-06 section 5). Hidden = NotFoundError."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = ("<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style>"
        "</head><body><p>hi</p></body></html>")
ADMIN = SimpleNamespace(id=1, role="admin", is_active=True)
MEMBER = SimpleNamespace(id=10, role="standard", is_active=True)
OUTSIDER = SimpleNamespace(id=11, role="standard", is_active=True)
INACTIVE = SimpleNamespace(id=12, role="standard", is_active=False)
SUSPENDED = SimpleNamespace(id=13, role="standard", is_active=True)  # in a deactivated group


@pytest.fixture
def world():
    from database import Base
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import documents.models  # noqa: F401
    from documents import service, storage
    from documents.models import DocumentSpace, DocumentSpaceGrant
    from groups.models import UserGroup, UserGroupMember
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    service.seed_categories(s)
    service.seed_spaces(s)
    leaders = UserGroup(slug="leaders", name="Leaders")
    dormant = UserGroup(slug="dormant", name="Dormant", is_active=False)
    exec_space = DocumentSpace(slug="leadership", name="Leadership", visibility="restricted")
    lab = DocumentSpace(slug="lab", name="Lab", visibility="company")
    s.add_all([leaders, dormant, exec_space, lab])
    s.flush()
    s.add_all([UserGroupMember(group_id=leaders.id, user_id=MEMBER.id),
               UserGroupMember(group_id=leaders.id, user_id=INACTIVE.id),
               UserGroupMember(group_id=dormant.id, user_id=SUSPENDED.id),
               DocumentSpaceGrant(space_id=exec_space.id, group_id=leaders.id),
               DocumentSpaceGrant(space_id=exec_space.id, group_id=dormant.id)])
    s.commit()
    cat = service.resolve_category(s, category="ART")
    secret, _ = service.create_document(s, title="Q4 plan", html=HTML, category=cat, space=exec_space)
    public, _ = service.create_document(s, title="SOP index", html=HTML + "<!--2-->", category=cat, space=lab)
    return SimpleNamespace(s=s, exec_space=exec_space, lab=lab, secret=secret, public=public,
                           general=service.general_space(s))


def test_view_space_matrix(world):
    from documents.access import can_view_space as v
    s = world.s
    users = (ADMIN, MEMBER, OUTSIDER, INACTIVE, SUSPENDED)
    assert [v(s, u, world.lab) for u in users] == [True, True, True, False, True]
    assert [v(s, u, world.exec_space) for u in users] == [True, True, False, False, False]
    assert v(s, None, world.lab) is False


def test_view_document_follows_its_space(world):
    from documents.access import can_view_document as v
    s = world.s
    assert [v(s, u, world.secret) for u in (ADMIN, MEMBER, OUTSIDER)] == [True, True, False]
    assert [v(s, u, world.public) for u in (ADMIN, MEMBER, OUTSIDER)] == [True, True, True]


def test_visible_space_ids(world):
    from documents.access import visible_space_ids
    s = world.s
    ids = lambda u: set(s.execute(visible_space_ids(s, u)).scalars().all())  # noqa: E731
    everything = {world.general.id, world.lab.id, world.exec_space.id}
    assert ids(ADMIN) == everything and ids(MEMBER) == everything
    assert ids(OUTSIDER) == {world.general.id, world.lab.id}
    assert ids(SUSPENDED) == {world.general.id, world.lab.id}
    assert ids(INACTIVE) == set()


def test_require_view_is_404_text_identical_to_missing(world):
    from documents.access import require_view
    from documents.errors import NotFoundError
    with pytest.raises(NotFoundError) as e:
        require_view(world.s, OUTSIDER, world.secret)
    assert str(e.value) == f"document {world.secret.id} not found"


def test_null_space_reads_as_general(world):
    """Review Focus 1: a pre-backfill row is General, visible to everyone active."""
    from documents.access import can_view_document
    from documents.models import Document
    world.secret.space_id = None
    world.s.commit()
    world.s.expire_all()
    row = world.s.get(Document, world.secret.id)
    assert row.space_id is None
    assert can_view_document(world.s, OUTSIDER, row) is True
    assert can_view_document(world.s, INACTIVE, row) is False
```

Append to `backend/tests/test_documents_service.py`:

```python
# --- spaces (spec 2026-10-06 section 4) --------------------------------------------------

def test_seed_spaces_is_idempotent_and_general_is_company(db):
    from documents import service
    service.seed_spaces(db)
    service.seed_spaces(db)
    rows = service.list_spaces(db)
    assert [(sp.slug, sp.visibility, sp.is_active, n) for sp, n in rows] == [("general", "company", True, 0)]
    assert service.general_space(db).slug == "general"


def test_seed_spaces_backfills_null_rows(db):
    from documents import service
    from documents.models import Document
    cat = service.resolve_category(db, category="ART")
    doc, _ = service.create_document(db, title="Old", html=HTML, category=cat)
    doc.space_id = None
    db.commit()
    service.seed_spaces(db)
    db.expire_all()
    assert db.get(Document, doc.id).space_id == service.general_space(db).id


def test_resolve_space_by_slug_id_and_default(db):
    from documents import service
    from documents.errors import NotFoundError
    general = service.general_space(db)
    assert service.resolve_space(db).id == general.id
    assert service.resolve_space(db, space=" General ").id == general.id
    assert service.resolve_space(db, space_id=general.id).id == general.id
    with pytest.raises(NotFoundError):
        service.resolve_space(db, space="nope")
```

`HTML` is not defined in `test_documents_service.py` today; add at module top, after the imports:

```python
HTML = ("<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style>"
        "</head><body><p>hi</p></body></html>")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `backend/`): `.venv/Scripts/python.exe -m pytest tests/test_documents_access.py tests/test_documents_service.py -q -p no:cacheprovider -k "space or general"`
Expected: FAIL with `ImportError` (no `documents.access`) and `AttributeError: module 'documents.service' has no attribute 'seed_spaces'`.

- [ ] **Step 3: Add the models**

In `backend/documents/models.py`, after `DocumentCodeCounter` and before `class Document`, add:

```python
SPACE_VISIBILITIES = ("company", "restricted")


class DocumentSpace(Base):
    """The first level of the library and the unit of read access (spec 2026-10-06
    section 4.1). `slug` is immutable (service enforces). `visibility` decides who
    may READ: company = every active login, restricted = granted groups + admins."""
    __tablename__ = "document_spaces"
    __table_args__ = (
        CheckConstraint("visibility IN ('company','restricted')", name="ck_document_spaces_visibility"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    visibility: Mapped[str] = mapped_column(String(20), nullable=False, default="company",
                                            server_default="company")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                            server_default="true")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:
        return f"<DocumentSpace(id={self.id}, slug='{self.slug}', visibility='{self.visibility}')>"


class DocumentSpaceGrant(Base):
    """A READ grant: members of `group_id` may see documents in `space_id`
    (spec section 4.2). Inert on a company space."""
    __tablename__ = "document_space_grants"
    __table_args__ = (
        UniqueConstraint("space_id", "group_id", name="uq_document_space_grants_pair"),
        Index("ix_document_space_grants_group_id", "group_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    space_id: Mapped[int] = mapped_column(
        ForeignKey("document_spaces.id", ondelete="CASCADE"), nullable=False)
    group_id: Mapped[int] = mapped_column(
        ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False)
```

In `class Document`, add to `__table_args__`: `Index("ix_documents_space_id", "space_id"),`. After `category_id`, add:

```python
    # The space is a property of the CODE, stored on every revision so list and
    # gate queries need no join; a move rewrites all rows of the code together.
    # Nullable in DDL because the column is added to an existing table; the
    # service treats NULL as General and the boot backfill removes them.
    space_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("document_spaces.id", ondelete="RESTRICT"), nullable=True)
```

After the `category` relationship add:

```python
    # selectin, NOT joined: _latest() takes FOR UPDATE and Postgres refuses the lock
    # on the nullable side of an outer join (the bug the category relationship hit).
    space: Mapped[Optional["DocumentSpace"]] = relationship("DocumentSpace", lazy="selectin")
```

Also update the module docstring's "Three tables" sentence to "Five tables" and name the two new ones.

- [ ] **Step 4: Create the access module**

```python
# backend/documents/access.py
"""The one module that answers every document visibility question (spec 2026-10-06
section 5). Routes, the comment routes, the flag seam and the agent-token check call
these; nothing else re-derives the rule. Mirrors boards/access.py on purpose.

  can_view_space      : admin -> True; company -> active user; restricted -> any grant
                        for one of the user's ACTIVE groups
  can_view_document   : can_view_space of the document's space (NULL reads as General)
  visible_space_ids   : Select of space ids the user may see (for IN (...) subqueries)
  require_view        : NotFoundError, never 403: existence is not confirmed

Membership is read on every call: revoking a group takes effect on the next request."""
from __future__ import annotations

from sqlalchemy import false, or_, select
from sqlalchemy.orm import Session

from documents.errors import NotFoundError
from documents.models import Document, DocumentSpace, DocumentSpaceGrant
from groups.access import is_admin, user_group_ids


def _active(user) -> bool:
    return getattr(user, "id", None) is not None and bool(getattr(user, "is_active", True))


def _granted(db: Session, space: DocumentSpace, gids: frozenset[int]) -> bool:
    if not gids:
        return False
    row = db.execute(select(DocumentSpaceGrant.id)
                     .where(DocumentSpaceGrant.space_id == space.id,
                            DocumentSpaceGrant.group_id.in_(gids)).limit(1)).scalar_one_or_none()
    return row is not None


def can_view_space(db: Session, user, space: DocumentSpace) -> bool:
    if not _active(user):
        return False
    if is_admin(user) or space.visibility == "company":
        return True
    return _granted(db, space, user_group_ids(db, user))


def can_view_document(db: Session, user, doc: Document) -> bool:
    if doc.space_id is None:
        # Pre-backfill row: it is General by definition (spec 4.4).
        return _active(user)
    space = doc.space if doc.space is not None else db.get(DocumentSpace, doc.space_id)
    if space is None:
        return is_admin(user)  # dangling id: fail closed
    return can_view_space(db, user, space)


def visible_space_ids(db: Session, user):
    if not _active(user):
        return select(DocumentSpace.id).where(false())
    if is_admin(user):
        return select(DocumentSpace.id)
    cond = DocumentSpace.visibility == "company"
    gids = user_group_ids(db, user)
    if gids:
        granted = select(DocumentSpaceGrant.space_id).where(DocumentSpaceGrant.group_id.in_(gids))
        cond = or_(cond, DocumentSpace.id.in_(granted))
    return select(DocumentSpace.id).where(cond)


def require_view(db: Session, user, doc: Document) -> None:
    if not can_view_document(db, user, doc):
        # Same text service.get_document raises for a missing id (spec 5.2).
        raise NotFoundError(f"document {doc.id} not found")
```

- [ ] **Step 5: Add the space functions to the service**

In `backend/documents/service.py`, extend the models import to `from documents.models import (Document, DocumentCategory, DocumentCodeCounter, DocumentSpace, DocumentSpaceGrant)` and add after `SORTS`:

```python
GENERAL_SLUG = "general"
SPACE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")
SPACE_VISIBILITIES = ("company", "restricted")
```

Add a new block after the categories block (before `# --- codes`):

```python
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
    shows). A code with only retired rows does not count."""
    rows = db.execute(select(Document.space_id, func.count(func.distinct(Document.code)))
                      .where(Document.status.in_(("draft", "active")))
                      .group_by(Document.space_id)).all()
    return {sid: n for sid, n in rows}


def list_spaces(db: Session, include_inactive: bool = False) -> list[tuple[DocumentSpace, int]]:
    stmt = select(DocumentSpace)
    if not include_inactive:
        stmt = stmt.where(DocumentSpace.is_active.is_(True))
    rows = db.execute(stmt.order_by(DocumentSpace.sort_order, func.lower(DocumentSpace.name))).scalars().all()
    counts = _space_counts(db)
    # General first regardless of sort_order (spec 9.1).
    rows = sorted(rows, key=lambda sp: (0 if sp.slug == GENERAL_SLUG else 1))
    return [(sp, counts.get(sp.id, 0)) for sp in rows]
```

Note: `create_document` does not accept `space=` yet; Task 3 adds it. For this task's tests to pass, add the parameter now with the minimal behaviour: `space: Optional[DocumentSpace] = None` in the signature, and in the `Document(...)` constructor pass `space_id=(space or general_space(db)).id`. Task 3 adds the revision inheritance and the refusal.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_access.py tests/test_documents_service.py -q -p no:cacheprovider`
Expected: all new tests PASS; the pre-existing `test_create_mints_code_and_activates_by_default` may fail only if run across local midnight (known).

- [ ] **Step 7: Commit**

```bash
git -c core.autocrlf=true add -- backend/documents/models.py backend/documents/access.py backend/documents/service.py backend/tests/test_documents_access.py backend/tests/test_documents_service.py
git -c core.autocrlf=true commit -m "feat(documents): spaces, grants, space_id and the access module

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/models.py backend/documents/access.py backend/documents/service.py backend/tests/test_documents_access.py backend/tests/test_documents_service.py
```

---

### Task 2: Boot wiring: column migration and seed

**Files:**
- Modify: `backend/database.py` (`init_db`, around lines 115-133)
- Test: `backend/tests/test_documents_service.py` (append)

**Interfaces:**
- Consumes: `service.seed_spaces(db)` from Task 1.
- Produces: `database._ensure_documents_space_column(bind)` (idempotent; Postgres and SQLite).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_documents_service.py`:

```python
def test_ensure_documents_space_column_is_idempotent_on_a_pre_space_table():
    """Simulates an existing deployment: `documents` exists WITHOUT space_id. The boot
    helper adds the column and index once, and a second boot changes nothing."""
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.pool import StaticPool
    from database import Base, _ensure_documents_space_column
    import models  # noqa: F401
    import documents.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with engine.begin() as c:
        c.execute(text("ALTER TABLE documents DROP COLUMN space_id"))
    assert "space_id" not in {col["name"] for col in inspect(engine).get_columns("documents")}
    _ensure_documents_space_column(engine)
    _ensure_documents_space_column(engine)
    cols = {col["name"] for col in inspect(engine).get_columns("documents")}
    assert "space_id" in cols
    names = {ix["name"] for ix in inspect(engine).get_indexes("documents")}
    assert "ix_documents_space_id" in names
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_service.py -q -p no:cacheprovider -k ensure_documents_space_column`
Expected: FAIL with `ImportError: cannot import name '_ensure_documents_space_column'`.

- [ ] **Step 3: Add the helper and call it at boot**

In `backend/database.py`, add above `def init_db():`:

```python
def _ensure_documents_space_column(bind) -> None:
    """documents.space_id references document_spaces, which create_all has to create
    FIRST, so this cannot sit in the _run_migrations list (that runs before create_all).
    Idempotent on Postgres and SQLite. A failure here raises: the ORM maps the column,
    so a backend without it cannot serve documents at all."""
    from sqlalchemy import inspect, text
    cols = {c["name"] for c in inspect(bind).get_columns("documents")}
    with bind.begin() as conn:
        if "space_id" not in cols:
            conn.execute(text(
                "ALTER TABLE documents ADD COLUMN space_id INTEGER "
                "REFERENCES document_spaces(id) ON DELETE RESTRICT"))
        if bind.dialect.name == "postgresql":
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_documents_space_id ON documents (space_id)"))
        else:
            names = {ix["name"] for ix in inspect(bind).get_indexes("documents")}
            if "ix_documents_space_id" not in names:
                conn.execute(text("CREATE INDEX ix_documents_space_id ON documents (space_id)"))
```

In `init_db()`, directly after `Base.metadata.create_all(bind=engine)` add:

```python
    # Document spaces (spec 2026-10-06 section 4.4): the FK column after the table exists.
    _ensure_documents_space_column(engine)
```

And inside the existing documents seed `try:` block, after `seed_categories(_s)` add:

```python
            from documents.service import seed_spaces
            seed_spaces(_s)
```

Keep the `except` as is (seed failures log, never block startup); the column helper is outside the try on purpose.

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_service.py -q -p no:cacheprovider -k "ensure_documents_space_column or seed_spaces"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(documents): add space_id after create_all and seed General at boot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/database.py backend/tests/test_documents_service.py
```

`backend/database.py` is CRLF in the working tree (`w/crlf`); the Edit tool preserves that. Confirm with `git ls-files --eol backend/database.py` showing `i/lf w/crlf` and `git -c core.autocrlf=true diff --stat` showing a few lines, not a whole-file rewrite.

---

### Task 3: Service rules: space on create, dedupe scope, move, list filter

**Files:**
- Modify: `backend/documents/service.py` (`create_document`, `patch_document`, `list_documents`, new `latest_revision`, `move_document_space`)
- Test: `backend/tests/test_documents_service.py` (append)

**Interfaces:**
- Consumes: Task 1 models and `resolve_space`.
- Produces: `service.create_document(..., space: Optional[DocumentSpace] = None)` (new code: `space or General`; revision: inherits, a different `space` raises `BadRequestError`), `service.latest_revision(db, code) -> Optional[Document]`, `service.move_document_space(db, code, space_id, updated_by) -> list[Document]`, `service.list_documents(..., space_id: Optional[int] = None, visible_spaces=None)` where `visible_spaces` is a `Select` of space ids or `None` for no filter.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_documents_service.py`:

```python
def _space(db, slug, visibility="company"):
    from documents.models import DocumentSpace
    sp = DocumentSpace(slug=slug, name=slug.title(), visibility=visibility)
    db.add(sp)
    db.commit()
    return sp


def test_new_document_defaults_to_general_and_revision_inherits(db):
    from documents import service
    cat = service.resolve_category(db, category="ART")
    lab = _space(db, "lab")
    d1, _ = service.create_document(db, title="A", html=HTML, category=cat)
    assert d1.space_id == service.general_space(db).id
    d2, _ = service.create_document(db, title="B", html=HTML + "<!--b-->", category=cat, space=lab)
    assert d2.space_id == lab.id
    d2r2, created = service.create_document(db, code=d2.code, html=HTML + "<!--b2-->", category=cat)
    assert created and d2r2.space_id == lab.id


def test_revision_cannot_change_space(db):
    """Review Focus 2: a revision push naming another space is refused, not moved."""
    from documents import service
    from documents.errors import BadRequestError
    cat = service.resolve_category(db, category="ART")
    lab = _space(db, "lab")
    d, _ = service.create_document(db, title="A", html=HTML, category=cat, space=lab)
    with pytest.raises(BadRequestError, match="move"):
        service.create_document(db, code=d.code, html=HTML + "<!--2-->", category=cat,
                                space=service.general_space(db))
    assert service.revision_count(db, d.code) == 1


def test_identical_bytes_dedupe_is_scoped_to_category_and_space(db):
    """A duplicate inside another space is not named (spec 5.2); same space still 409s."""
    from documents import service
    from documents.errors import ConflictError
    cat = service.resolve_category(db, category="ART")
    lab = _space(db, "lab")
    a, _ = service.create_document(db, title="A", html=HTML, category=cat, space=lab)
    b, created = service.create_document(db, title="B", html=HTML, category=cat)  # General
    assert created and b.code != a.code
    with pytest.raises(ConflictError, match=a.code):
        service.create_document(db, title="C", html=HTML, category=cat, space=lab)


def test_move_document_space_moves_every_revision(db):
    from documents import service
    cat = service.resolve_category(db, category="ART")
    lab = _space(db, "lab")
    d1, _ = service.create_document(db, title="A", html=HTML, category=cat)
    service.create_document(db, code=d1.code, html=HTML + "<!--2-->", category=cat)
    service.create_document(db, code=d1.code, html=HTML + "<!--3-->", category=cat, activate=False)
    rows = service.move_document_space(db, d1.code, lab.id, updated_by="admin@x.t")
    assert len(rows) == 3 and {r.space_id for r in rows} == {lab.id}
    assert {r.updated_by for r in rows} == {"admin@x.t"}


def test_list_filters_by_space_and_visibility(db):
    from sqlalchemy import select
    from documents import service
    from documents.models import DocumentSpace
    cat = service.resolve_category(db, category="ART")
    lab = _space(db, "lab")
    secret = _space(db, "leadership", "restricted")
    service.create_document(db, title="G", html=HTML, category=cat)
    service.create_document(db, title="L", html=HTML + "<!--l-->", category=cat, space=lab)
    service.create_document(db, title="S", html=HTML + "<!--s-->", category=cat, space=secret)
    rows, total = service.list_documents(db)
    assert total == 3
    rows, total = service.list_documents(db, space_id=lab.id)
    assert total == 1 and rows[0][0].title == "L"
    visible = select(DocumentSpace.id).where(DocumentSpace.visibility == "company")
    rows, total = service.list_documents(db, visible_spaces=visible)
    assert total == 2 and {r[0].title for r in rows} == {"G", "L"}
    rows, total = service.list_documents(db, space_id=secret.id, visible_spaces=visible)
    assert total == 0 and rows == []


def test_list_includes_null_space_rows(db):
    """Review Focus 1: a NULL space_id row is General and stays listed under a visibility filter."""
    from sqlalchemy import select
    from documents import service
    from documents.models import Document, DocumentSpace
    cat = service.resolve_category(db, category="ART")
    d, _ = service.create_document(db, title="Old", html=HTML, category=cat)
    db.execute(Document.__table__.update().where(Document.id == d.id).values(space_id=None))
    db.commit()
    visible = select(DocumentSpace.id).where(DocumentSpace.visibility == "company")
    rows, total = service.list_documents(db, visible_spaces=visible)
    assert total == 1 and rows[0][0].id == d.id
```

- [ ] **Step 2: Run them to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_service.py -q -p no:cacheprovider -k "space or dedupe or move"`
Expected: FAIL (`TypeError: unexpected keyword 'space_id'`, missing `move_document_space`, the revision test passing when it should raise).

- [ ] **Step 3: Implement**

In `create_document`, the signature already has `space: Optional[DocumentSpace] = None` from Task 1. Replace the body's space handling:

Inside `if latest is not None:` (revision branch), after the category-prefix guard and BEFORE the identical-bytes branch, add:

```python
        if space is not None and space.id != (latest.space_id or general_space(db).id):
            raise BadRequestError(
                f"revisions stay in the document's space; move {code} with PATCH space_id instead")
        space_id = latest.space_id if latest.space_id is not None else general_space(db).id
```

In the `else:` (new code) branch, at its top:

```python
        space_id = (space or general_space(db)).id
```

and change the dedupe lookup to:

```python
            existing = db.execute(
                select(Document.code, Document.revision)
                .where(Document.content_sha256 == sha,
                       Document.category_id == cat.id,
                       Document.space_id == space_id)
                .order_by(Document.id).limit(1)
            ).first()
```

Extend the comment above it: "Scoped to the category AND the space: a 409 that named a code in a space the caller cannot see would confirm that document exists (spec 5.2)."

In the `Document(...)` constructor pass `space_id=space_id`.

Add after `get_revisions`:

```python
def latest_revision(db: Session, code: str) -> Optional[Document]:
    """Highest revision of a code, or None. Public twin of _latest without the lock."""
    try:
        return _latest(db, _clean_code(code))
    except BadRequestError:
        return None


def move_document_space(db: Session, code: str, space_id: int, *, updated_by: Optional[str]) -> list[Document]:
    """Move EVERY revision of a code to another space in one transaction (spec 4.3)."""
    space = get_space(db, int(space_id))
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
```

In `patch_document`, `space_id` is NOT in `allowed` on purpose (the route calls `move_document_space` for it, admin-only). Add to the docstring: "`space_id` is not a patch field here: the route routes it to move_document_space because it rewrites every revision."

In `list_documents`, extend the signature with `space_id: Optional[int] = None, visible_spaces=None` and after the `category_id` filter add:

```python
    if space_id is not None:
        stmt = stmt.where(Document.space_id == int(space_id))
    if visible_spaces is not None:
        # NULL = General = company (spec 4.4), so it is always inside a visibility filter.
        stmt = stmt.where(or_(Document.space_id.in_(visible_spaces), Document.space_id.is_(None)))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_service.py tests/test_documents_access.py -q -p no:cacheprovider`
Expected: PASS (same midnight caveat).

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(documents): space on create, revision inherits, dedupe scoped by space, move, list filter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/service.py backend/tests/test_documents_service.py
```

---

### Task 4: Wire schemas, `_doc_out`, and the agent-token allow-list

**Files:**
- Modify: `backend/documents/schemas.py`
- Modify: `backend/documents/routes.py` (lines 31-104: `AgentWriter`, `_agent_tokens`, `_match_agent`, `_doc_out`)
- Test: `backend/tests/test_documents_routes.py` (append)

**Interfaces:**
- Produces: `AgentWriter(name: str, spaces: frozenset[str] = frozenset({"general"}))`; `_agent_tokens() -> Dict[str, tuple[str, frozenset[str]]]`; `_match_agent(presented) -> Optional[AgentWriter]`; `agent_may_write(writer, space) -> bool`.
- Produces: `DocumentOut.space_id: Optional[int]`, `space_slug: str`, `space_name: str`; `DocumentCreate.space: Optional[str]`, `space_id: Optional[int]`; `DocumentPatch.space_id: Optional[int]`; `SpaceOut`, `SpaceCreate`, `SpaceUpdate`, `SpaceGrantsReplace`, `SpaceGrantsOut`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_documents_routes.py`:

```python
# --- spaces: agent allow-list parsing (spec 2026-10-06 section 7.1) ----------------------

def test_agent_tokens_third_segment():
    """Review Focus 4: the optional third segment parses into a slug set; absent = general;
    an unknown slug still parses (it is only a string here)."""
    from documents.routes import AgentWriter, _agent_tokens, _match_agent
    tok_a, tok_b, tok_c = "a" * 40, "b" * 40, "c" * 40
    env = {"MK1_DOCUMENT_AGENT_TOKENS":
           f"jarvis:{tok_a}:general+analytical, tars:{tok_b}, codex:{tok_c}:not-yet-a-space"}
    with patch.dict(os.environ, env):
        parsed = _agent_tokens()
        assert parsed["jarvis"] == (tok_a, frozenset({"general", "analytical"}))
        assert parsed["tars"] == (tok_b, frozenset({"general"}))
        assert parsed["codex"] == (tok_c, frozenset({"not-yet-a-space"}))
        who = _match_agent(tok_a)
        assert who == AgentWriter("jarvis", frozenset({"general", "analytical"}))
        assert _match_agent("x" * 40) is None
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": f"bad:{tok_a}:Not A Slug"}):
        assert _agent_tokens() == {}  # malformed segment drops the whole entry


def test_doc_out_carries_space_fields(client):
    _as_admin(client)
    d = _publish(client).json()
    assert (d["space_slug"], d["space_name"]) == ("general", "General")
    assert d["space_id"] is not None
```

Also, in the `client` fixture of this file, after `service.seed_categories(shared)` add `service.seed_spaces(shared)` so every route test has General.

- [ ] **Step 2: Run them to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_routes.py -q -p no:cacheprovider -k "third_segment or space_fields"`
Expected: FAIL (`AgentWriter()` takes one argument; `KeyError: 'space_slug'`).

- [ ] **Step 3: Schemas**

In `backend/documents/schemas.py` add after `CategoryUpdate`:

```python
class SpaceOut(BaseModel):
    id: int
    slug: str
    name: str
    description: Optional[str] = None
    visibility: str
    is_active: bool
    sort_order: int
    document_count: int = 0
    can_write: bool = False
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class SpaceCreate(BaseModel):
    slug: str
    name: str
    description: Optional[str] = None
    visibility: str = "company"
    sort_order: int = 0


class SpaceUpdate(BaseModel):
    """Partial. No slug: immutable."""
    name: Optional[str] = None
    description: Optional[str] = None
    visibility: Optional[str] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


class SpaceGrantsReplace(BaseModel):
    group_ids: List[int]


class SpaceGrantsOut(BaseModel):
    space_id: int
    group_ids: List[int]
```

In `DocumentOut` after `category_prefix: str` add:

```python
    space_id: Optional[int] = None
    space_slug: str = "general"
    space_name: str = "General"
```

In `DocumentCreate` after `category_id` add `space: Optional[str] = None  # slug; default General` and `space_id: Optional[int] = None`. In `DocumentPatch` add `space_id: Optional[int] = None  # admin bearer only; moves every revision`.

- [ ] **Step 4: Agent writer and `_doc_out`**

In `backend/documents/routes.py` replace the `AgentWriter` dataclass, `_agent_tokens` and `_match_agent` with:

```python
_SLUG_LIST = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}(\+[a-z0-9][a-z0-9-]{0,59})*$")


@dataclass(frozen=True)
class AgentWriter:
    """A caller holding a documents-scoped agent token. Not a user: it has no id and
    no email, and it may author and archive but never delete. `spaces` is the slug
    allow-list it may publish into (spec 2026-10-06 section 7.1); absent = General."""
    name: str
    spaces: frozenset = frozenset({"general"})


def _agent_tokens() -> Dict[str, tuple]:
    """MK1_DOCUMENT_AGENT_TOKENS="jarvis:<token>:general+analytical,tars:<token>"
    -> {agent: (token, frozenset(slugs))}.

    These exist because the internal service token also opens the s2s order and
    sample endpoints, so it cannot live on a bot host. An agent token opens the
    documents API and nothing else, names the agent, and (optionally) names the
    spaces it may write to. A malformed entry is dropped (and logged), never
    half-accepted."""
    out: Dict[str, tuple] = {}
    for entry in os.environ.get("MK1_DOCUMENT_AGENT_TOKENS", "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        name, sep, rest = entry.partition(":")
        tok, _, spaces = rest.partition(":")
        name, tok, spaces = name.strip(), tok.strip(), spaces.strip().lower()
        if not sep or not _AGENT_NAME.match(name) or len(tok) < _MIN_AGENT_TOKEN:
            logger.warning("documents.agent_token_ignored agent=%r reason=malformed", name[:40])
            continue
        if spaces and not _SLUG_LIST.match(spaces):
            logger.warning("documents.agent_token_ignored agent=%r reason=bad_spaces", name[:40])
            continue
        out[name] = (tok, frozenset(spaces.split("+")) if spaces else frozenset({"general"}))
    return out


def _match_agent(presented: str) -> Optional[AgentWriter]:
    found = None
    for name, (tok, spaces) in _agent_tokens().items():  # no early exit: same work for hit or miss
        if secrets.compare_digest(presented.encode(), tok.encode()):
            found = AgentWriter(name, spaces)
    return found


def agent_may_write(writer, space) -> bool:
    """Admins and the internal service token write anywhere; an agent only to its list."""
    if isinstance(writer, AgentWriter):
        return space.slug in writer.spaces
    return True
```

In `require_document_writer`, change `return AgentWriter(agent)` to `return agent` (it is already an `AgentWriter`).

In `_doc_out`, after `category_prefix=doc.category.code_prefix,` add:

```python
        space_id=doc.space_id,
        space_slug=doc.space.slug if doc.space is not None else "general",
        space_name=doc.space.name if doc.space is not None else "General",
```

Add a helper under `_cat_out`:

```python
def _space_out(sp: DocumentSpace, count: int, can_write: bool) -> SpaceOut:
    out = SpaceOut.model_validate(sp)
    out.document_count = count
    out.can_write = can_write
    return out
```

and extend the imports: `from documents.models import Document, DocumentCategory, DocumentSpace` and the schemas import to include `SpaceCreate, SpaceGrantsOut, SpaceGrantsReplace, SpaceOut, SpaceUpdate`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_routes.py -q -p no:cacheprovider`
Expected: PASS, including every pre-existing test (the fixture now seeds General).

- [ ] **Step 6: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(documents): space fields on the wire; agent tokens carry a space allow-list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/schemas.py backend/documents/routes.py backend/tests/test_documents_routes.py
```

---

### Task 5: Gate every document route; create with space; admin move

**Files:**
- Modify: `backend/documents/routes.py` (document routes, lines 188-330)
- Test: `backend/tests/test_documents_routes.py` (append)

**Interfaces:**
- Consumes: `access.require_view`, `access.visible_space_ids`, `service.resolve_space`, `service.latest_revision`, `service.move_document_space`, `service.list_documents(space_id, visible_spaces)`, `agent_may_write`.
- Produces: `GET /api/documents?space_id=`; `POST /api/documents` body `space`/`space_id`; `PATCH /api/documents/{id}` with `space_id` (admin bearer only).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_documents_routes.py`:

```python
# --- spaces: route gates (spec 2026-10-06 sections 5, 8.2) --------------------------------

def _restricted_world(client):
    """A restricted space 'leadership' granted to group 'leaders'; user 10 is a member,
    the fixture's default user (42) is an outsider. Returns (space, secret_doc_json)."""
    from documents.models import DocumentSpace, DocumentSpaceGrant
    from groups.models import UserGroup, UserGroupMember
    db = client.db
    g = UserGroup(slug="leaders", name="Leaders")
    sp = DocumentSpace(slug="leadership", name="Leadership", visibility="restricted")
    db.add_all([g, sp])
    db.flush()
    db.add_all([UserGroupMember(group_id=g.id, user_id=10),
                DocumentSpaceGrant(space_id=sp.id, group_id=g.id)])
    db.commit()
    _as_admin(client)
    secret = _publish(client, title="Q4 plan", space="leadership").json()
    assert secret["space_slug"] == "leadership"
    return sp, secret


def _read_as(client, user_id, role="standard"):
    from main import app
    from auth import get_current_user
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=user_id, role=role, email=f"u{user_id}@x.t", is_active=True)


def test_hidden_document_is_404_identical_to_missing_on_every_read(client):
    sp, secret = _restricted_world(client)
    missing = client.get("/api/documents/999999")
    for path in (f"/api/documents/{secret['id']}", f"/api/documents/{secret['id']}/content"):
        r = client.get(path)
        assert r.status_code == 404, path
    assert client.get(f"/api/documents/{secret['id']}").json() == \
        {"detail": f"document {secret['id']} not found"}
    assert missing.json() == {"detail": "document 999999 not found"}
    lst = client.get("/api/documents").json()
    assert all(i["id"] != secret["id"] for i in lst["items"]) and lst["total"] == 0
    assert client.get("/api/documents?q=Q4").json()["total"] == 0
    _read_as(client, 10)
    assert client.get(f"/api/documents/{secret['id']}").status_code == 200
    assert client.get("/api/documents").json()["total"] == 1
    _read_as(client, 1, "admin")
    assert client.get(f"/api/documents/{secret['id']}/content").status_code == 200


def test_list_for_hidden_space_is_empty(client):
    """Review Focus 5: a direct space filter the caller cannot see is an empty list, not an error."""
    sp, secret = _restricted_world(client)
    r = client.get(f"/api/documents?space_id={sp.id}")
    assert r.status_code == 200 and r.json()["total"] == 0 and r.json()["items"] == []
    assert client.get("/api/documents?space_id=424242").json()["total"] == 0


def test_writes_on_a_hidden_document_are_404(client):
    """A standard member of nothing cannot even learn the id exists through a write."""
    sp, secret = _restricted_world(client)
    from main import app
    from documents.routes import require_document_writer
    # writer = a non-admin "admin" override would be wrong; use the internal token path
    # with a reader that cannot see the doc: the gate runs on the READ identity for
    # bearer writers, so simulate an admin bearer that IS allowed, then an agent token
    # whose allow-list excludes the space.
    app.dependency_overrides.pop(require_document_writer, None)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40}):
        h = {"X-Service-Token": "b" * 40}
        assert client.post(f"/api/documents/{secret['id']}/retire", headers=h).status_code == 404
        assert client.patch(f"/api/documents/{secret['id']}", json={"title": "x"}, headers=h).status_code == 404
        r = client.post("/api/documents", json={"code": secret["code"], "html": HTML + "<!--2-->",
                                                "category": "ART"}, headers=h)
        assert r.status_code == 404


def test_agent_write_outside_allowlist(client):
    """Review Focus 4: a new document into a space not on the list is 400 naming only the slug."""
    from main import app
    from documents.routes import require_document_writer
    app.dependency_overrides.pop(require_document_writer, None)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40 + ":general"}):
        h = {"X-Service-Token": "b" * 40}
        from documents.models import DocumentSpace
        client.db.add(DocumentSpace(slug="accounting", name="Accounting", visibility="restricted"))
        client.db.commit()
        r = client.post("/api/documents", json={"title": "Ledger", "html": HTML, "category": "ART",
                                                "author": "F", "space": "accounting"}, headers=h)
        assert r.status_code == 400
        assert r.json()["detail"] == "space 'accounting' is not allowed for this agent"
        ok = client.post("/api/documents", json={"title": "Note", "html": HTML, "category": "ART",
                                                 "author": "F"}, headers=h)
        assert ok.status_code == 201 and ok.json()["space_slug"] == "general"


def test_admin_moves_a_code_and_agents_cannot(client):
    sp, secret = _restricted_world(client)
    from documents.models import DocumentSpace
    lab = DocumentSpace(slug="lab", name="Lab")
    client.db.add(lab)
    client.db.commit()
    _read_as(client, 1, "admin")
    _as_admin(client)
    # a second revision so the move has to carry two rows
    client.post("/api/documents", json={"code": secret["code"], "html": HTML + "<!--2-->", "category": "ART"})
    r = client.patch(f"/api/documents/{secret['id']}", json={"space_id": lab.id})
    assert r.status_code == 200 and r.json()["space_slug"] == "lab"
    detail = client.get(f"/api/documents/{secret['id']}").json()
    assert {rev["space_slug"] for rev in detail["revisions"]} == {"lab"}
    from main import app
    from documents.routes import require_document_writer
    app.dependency_overrides.pop(require_document_writer, None)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40 + ":lab"}):
        r = client.patch(f"/api/documents/{secret['id']}", json={"space_id": sp.id},
                         headers={"X-Service-Token": "b" * 40})
        assert r.status_code == 403


def test_publish_into_space_by_slug_and_id(client):
    _as_admin(client)
    from documents.models import DocumentSpace
    lab = DocumentSpace(slug="lab", name="Lab")
    client.db.add(lab)
    client.db.commit()
    assert _publish(client, space="lab").json()["space_slug"] == "lab"
    assert _publish(client, html=HTML + "<!--x-->", space_id=lab.id).json()["space_slug"] == "lab"
    assert _publish(client, html=HTML + "<!--y-->", space="nope").status_code == 404
```

- [ ] **Step 2: Run them to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_routes.py -q -p no:cacheprovider -k "hidden or allowlist or moves or into_space"`
Expected: FAIL (secret document readable by the outsider; `space` ignored on publish).

- [ ] **Step 3: Implement the gates**

In `backend/documents/routes.py` add `from documents import access` to the imports, then:

A reader helper under `_http`:

```python
def _reader_for(writer, db: Session, token: Optional[str]):
    """The identity the READ gate uses on a write route. Admin bearer: that user.
    Agent token or internal token: an unrestricted pseudo-reader (their allow-list,
    not their membership, governs writes), so the gate reduces to existence."""
    if writer is None or isinstance(writer, AgentWriter):
        return SimpleNamespace(id=0, role="admin", is_active=True)
    return writer
```

Add `from types import SimpleNamespace` to the imports.

Agent tokens and the internal token are not people; a hidden document must still be 404 to an agent whose allow-list excludes the space. So define, under `agent_may_write`:

```python
def _agent_may_see(writer, doc: Document) -> bool:
    if not isinstance(writer, AgentWriter):
        return True
    slug = doc.space.slug if doc.space is not None else "general"
    return slug in writer.spaces
```

Now the routes:

`list_documents`: add `space_id: Optional[int] = None` to the parameters and pass `space_id=space_id, visible_spaces=access.visible_space_ids(db, user)` to the service.

`get_document`: after `doc = service.get_document(db, doc_id)` add `access.require_view(db, user, doc)`.

`get_document_content`: same line after `doc = service.get_document(db, doc_id)`.

`create_document`: replace the body with:

```python
    try:
        cat = None
        if req.category_id is not None or req.category:
            cat = service.resolve_category(db, category=req.category, category_id=req.category_id)
        space = None
        if req.space_id is not None or req.space:
            space = service.resolve_space(db, space=req.space, space_id=req.space_id)
        if req.code:
            latest = service.latest_revision(db, req.code)
            if latest is not None:
                if not _agent_may_see(writer, latest) or not access.can_view_document(
                        db, _reader_for(writer, db, None), latest):
                    raise NotFoundError(f"document {latest.id} not found")
        else:
            target = space if space is not None else service.general_space(db)
            if not agent_may_write(writer, target):
                raise BadRequestError(f"space {target.slug!r} is not allowed for this agent")
        doc, created = service.create_document(
            db, title=req.title, html=req.html, category=cat, description=req.description,
            code=req.code, author=req.author, source_session=req.source_session,
            effective_date=req.effective_date, activate=req.activate,
            user_id=getattr(writer, "id", None),
            co_author=writer.name if isinstance(writer, AgentWriter) else None,
            space=space)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
```

(The rest of the function is unchanged.) Note `NotFoundError` text uses the latest row's id so it is byte-identical to a missing-id read.

`patch_document`: at the top of the `try`, before `patch = ...`:

```python
        doc = service.get_document(db, doc_id)
        if not _agent_may_see(writer, doc):
            raise NotFoundError(f"document {doc.id} not found")
        access.require_view(db, _reader_for(writer, db, None), doc)
```

and after `patch = req.model_dump(exclude_unset=True)`:

```python
        move_to = patch.pop("space_id", None)
        if move_to is not None:
            if writer is None or isinstance(writer, AgentWriter):
                raise HTTPException(status.HTTP_403_FORBIDDEN,
                                    "only an admin login can move a document between spaces")
            service.move_document_space(db, doc.code, int(move_to), updated_by=writer.email)
            if not patch:
                doc = service.get_document(db, doc_id)
                n = service.revision_count(db, doc.code)
                return _doc_out(doc, n)
```

`activate_document`, `retire_document`, `delete_document`: at the top of each `try`, add the same three lines as `patch_document` (`doc = service.get_document(...)`, the `_agent_may_see` check, `access.require_view(...)`). For `delete_document` the writer is `require_document_admin_writer`, which is never an `AgentWriter`, so only the `require_view` line applies there.

The pre-existing `_audit` calls stay.

- [ ] **Step 4: Run the whole documents suite**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_routes.py tests/test_documents_service.py tests/test_documents_access.py -q -p no:cacheprovider`
Expected: PASS. If `test_writer_dependency_unit_matrix` fails on `require_document_writer(...) is None` for the internal token, that behaviour is unchanged by this task; investigate before touching it.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(documents): gate every document route by space; publish into a space; admin move

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/routes.py backend/tests/test_documents_routes.py
```

---

### Task 6: Space administration routes and the group-delete guard

**Files:**
- Modify: `backend/documents/service.py` (space CRUD)
- Modify: `backend/documents/routes.py` (new `/document-spaces` routes, placed in the categories block)
- Modify: `backend/groups/service.py` (`delete_group`)
- Test: `backend/tests/test_documents_spaces_routes.py` (create), `backend/tests/test_groups_routes.py` (append)

**Interfaces:**
- Produces: `service.create_space(db, *, slug, name, description=None, visibility="company", sort_order=0)`, `service.update_space(db, space_id, **fields)`, `service.list_space_grants(db, space_id) -> list[int]`, `service.replace_space_grants(db, space_id, group_ids) -> list[int]`, `service.delete_space(db, space_id)`.
- Produces routes: `GET/POST /api/document-spaces`, `PUT /api/document-spaces/{id}`, `GET/PUT /api/document-spaces/{id}/grants`, `DELETE /api/document-spaces/{id}`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_documents_spaces_routes.py
"""Space administration (spec 2026-10-06 section 8.1) and the General guards."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = ("<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style>"
        "</head><body><p>hi</p></body></html>")


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import groups.models  # noqa: F401
    import documents.models  # noqa: F401
    from documents import service, storage
    from documents.routes import require_document_writer
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    service.seed_categories(shared)
    service.seed_spaces(shared)
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    from groups.models import UserGroup
    shared.add_all([UserGroup(slug="leaders", name="Leaders"), UserGroup(slug="dormant", name="D", is_active=False)])
    shared.commit()

    def _db():
        yield shared

    keys = (get_db, get_current_user, require_document_writer)
    saved = {k: app.dependency_overrides.get(k) for k in keys}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t", is_active=True)
    app.dependency_overrides[require_document_writer] = lambda: SimpleNamespace(id=1, role="admin", email="admin@x.t", is_active=True)
    tc = TestClient(app)
    tc.db = shared
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    shared.close()


def _leaders_id(client):
    from groups.models import UserGroup
    return client.db.query(UserGroup).filter_by(slug="leaders").one().id


def test_list_shows_only_visible_spaces_general_first(client):
    r = client.post("/api/document-spaces", json={"slug": "Accounting", "name": "Accounting",
                                                  "visibility": "restricted", "sort_order": -5})
    assert r.status_code == 201 and r.json()["slug"] == "accounting"
    client.post("/api/document-spaces", json={"slug": "lab", "name": "Lab"})
    rows = client.get("/api/document-spaces").json()
    assert [s["slug"] for s in rows] == ["general", "lab"]  # outsider: restricted absent, General first
    assert all(s["can_write"] is False for s in rows)


def test_create_validation_and_slug_conflict(client):
    assert client.post("/api/document-spaces", json={"slug": "Bad Slug", "name": "x"}).status_code == 400
    assert client.post("/api/document-spaces", json={"slug": "ok", "name": "x", "visibility": "secret"}).status_code == 400
    assert client.post("/api/document-spaces", json={"slug": "ok", "name": "x"}).status_code == 201
    assert client.post("/api/document-spaces", json={"slug": "ok", "name": "y"}).status_code == 409


def test_general_guards(client):
    gid = client.get("/api/document-spaces").json()[0]["id"]
    assert client.put(f"/api/document-spaces/{gid}", json={"visibility": "restricted"}).status_code == 400
    assert client.put(f"/api/document-spaces/{gid}", json={"is_active": False}).status_code == 400
    assert client.delete(f"/api/document-spaces/{gid}").status_code == 400
    assert client.put(f"/api/document-spaces/{gid}", json={"name": "Everyone"}).status_code == 200


def test_update_grants_and_delete_when_empty(client):
    sp = client.post("/api/document-spaces", json={"slug": "leadership", "name": "L", "visibility": "restricted"}).json()
    sid = sp["id"]
    assert client.put(f"/api/document-spaces/{sid}", json={"slug": "other"}).status_code == 422  # unknown field
    g = client.put(f"/api/document-spaces/{sid}/grants", json={"group_ids": [_leaders_id(client)]})
    assert g.status_code == 200 and g.json()["group_ids"] == [_leaders_id(client)]
    assert client.get(f"/api/document-spaces/{sid}/grants").json()["group_ids"] == [_leaders_id(client)]
    from groups.models import UserGroup
    dormant = client.db.query(UserGroup).filter_by(slug="dormant").one().id
    assert client.put(f"/api/document-spaces/{sid}/grants", json={"group_ids": [dormant]}).status_code == 400
    assert client.put(f"/api/document-spaces/{sid}/grants", json={"group_ids": [999]}).status_code == 400
    # a document inside blocks delete
    d = client.post("/api/documents", json={"title": "x", "html": HTML, "category": "ART", "space": "leadership"})
    assert d.status_code == 201
    assert client.delete(f"/api/document-spaces/{sid}").status_code == 409
    client.post(f"/api/documents/{d.json()['id']}/retire")
    assert client.delete(f"/api/document-spaces/{sid}").status_code == 409  # retired still counts as held
    empty = client.post("/api/document-spaces", json={"slug": "temp", "name": "T"}).json()["id"]
    assert client.delete(f"/api/document-spaces/{empty}").status_code == 204


def test_agent_token_cannot_administer_spaces(client):
    from main import app
    from documents.routes import require_document_writer
    app.dependency_overrides.pop(require_document_writer, None)
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40}):
        h = {"X-Service-Token": "b" * 40}
        assert client.post("/api/document-spaces", json={"slug": "x", "name": "x"}, headers=h).status_code == 403


def test_agent_token_lists_its_allowlist(client):
    from main import app
    from auth import get_current_user
    from documents.routes import require_document_writer
    app.dependency_overrides.pop(require_document_writer, None)
    app.dependency_overrides.pop(get_current_user, None)
    client.post("/api/document-spaces", json={"slug": "lab", "name": "Lab"},
                headers={"X-Service-Token": "svc"}) if False else None
    with patch.dict(os.environ, {"MK1_DOCUMENT_AGENT_TOKENS": "bot:" + "b" * 40 + ":general+lab"}):
        r = client.get("/api/document-spaces", headers={"X-Service-Token": "b" * 40})
        assert r.status_code == 200
        assert [s["slug"] for s in r.json()] == ["general"]  # lab does not exist yet; only real spaces listed
        assert r.json()[0]["can_write"] is True
```

Append to `backend/tests/test_groups_routes.py`:

```python
def test_group_delete_refused_while_granted_on_a_space(client):
    """Review Focus 3: a Leadership grant cannot vanish by deleting its group."""
    from documents.models import DocumentSpace, DocumentSpaceGrant
    g = _mk(client)
    client.as_user(ADMIN)
    sp = DocumentSpace(slug="leadership", name="L", visibility="restricted")
    client.db.add(sp)
    client.db.flush()
    client.db.add(DocumentSpaceGrant(space_id=sp.id, group_id=g["id"]))
    client.db.commit()
    assert client.delete(f"/api/groups/{g['id']}").status_code == 409
```

(`_mk`, `ADMIN` and `client.as_user` already exist in that file.) Its fixture must import `documents.models` so the grants table exists: add `import documents.models  # noqa: F401` beside the `groups.models` import in that fixture.

- [ ] **Step 2: Run them to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_spaces_routes.py tests/test_groups_routes.py -q -p no:cacheprovider -k "space"`
Expected: FAIL with 404s on `/api/document-spaces` and the group delete returning 204.

- [ ] **Step 3: Service CRUD**

Add to `backend/documents/service.py` after `list_spaces`:

```python
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
```

- [ ] **Step 4: Routes**

In `backend/documents/routes.py`, add a reader dependency that accepts a bearer OR an agent token (for `GET /document-spaces` only):

```python
def _space_reader(
    x_service_token: Optional[str] = Header(None),
    token: Optional[str] = Depends(_optional_bearer),
    db: Session = Depends(get_db),
):
    """GET /document-spaces: a login sees what it can read; an agent token sees its
    allow-list (the MCP's documents_spaces tool). Internal token: everything."""
    if x_service_token is not None:
        agent = _match_agent(x_service_token)
        if agent is not None:
            return agent
        require_internal_service_token(x_service_token)
        return None
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")
    return get_current_user(token=token, db=db)
```

Then, after the categories routes and before `# --- documents`, add:

```python
# --- spaces (spec 2026-10-06 section 8.1) ------------------------------------------------

@router.get("/document-spaces", response_model=List[SpaceOut])
def list_spaces(include_inactive: bool = False, db: Session = Depends(get_db),
                who=Depends(_space_reader)):
    rows = service.list_spaces(db, include_inactive=include_inactive)
    if isinstance(who, AgentWriter):
        return [_space_out(sp, n, True) for sp, n in rows if sp.slug in who.spaces]
    if who is None:
        return [_space_out(sp, n, True) for sp, n in rows]
    from groups.access import is_admin
    return [_space_out(sp, n, is_admin(who)) for sp, n in rows if access.can_view_space(db, who, sp)]


@router.post("/document-spaces", response_model=SpaceOut, status_code=201)
def create_space(req: SpaceCreate, db: Session = Depends(get_db),
                 writer=Depends(require_document_admin_writer)):
    try:
        sp = service.create_space(db, slug=req.slug, name=req.name, description=req.description,
                                  visibility=req.visibility, sort_order=req.sort_order)
    except Exception as e:
        raise _http(e)
    return _space_out(sp, 0, True)


@router.put("/document-spaces/{space_id}", response_model=SpaceOut)
def update_space(space_id: int, req: SpaceUpdate, db: Session = Depends(get_db),
                 writer=Depends(require_document_admin_writer)):
    try:
        sp = service.update_space(db, space_id, **req.model_dump(exclude_unset=True))
        count = dict((s.id, n) for s, n in service.list_spaces(db, include_inactive=True)).get(sp.id, 0)
    except Exception as e:
        raise _http(e)
    return _space_out(sp, count, True)


@router.get("/document-spaces/{space_id}/grants", response_model=SpaceGrantsOut)
def get_space_grants(space_id: int, db: Session = Depends(get_db),
                     writer=Depends(require_document_admin_writer)):
    try:
        return SpaceGrantsOut(space_id=space_id, group_ids=service.list_space_grants(db, space_id))
    except Exception as e:
        raise _http(e)


@router.put("/document-spaces/{space_id}/grants", response_model=SpaceGrantsOut)
def put_space_grants(space_id: int, req: SpaceGrantsReplace, db: Session = Depends(get_db),
                     writer=Depends(require_document_admin_writer)):
    try:
        ids = service.replace_space_grants(db, space_id, req.group_ids)
    except Exception as e:
        raise _http(e)
    return SpaceGrantsOut(space_id=space_id, group_ids=ids)


@router.delete("/document-spaces/{space_id}", status_code=204)
def delete_space(space_id: int, db: Session = Depends(get_db),
                 writer=Depends(require_document_admin_writer)):
    try:
        service.delete_space(db, space_id)
    except Exception as e:
        raise _http(e)
    return Response(status_code=204)
```

`SpaceUpdate` must reject unknown fields with 422: add `model_config = ConfigDict(extra="forbid")` to `SpaceUpdate` in `schemas.py` (the test sends `slug`).

- [ ] **Step 5: Group delete guard**

In `backend/groups/service.py`, find `delete_group` (it already refuses when the group has members or board grants). Add, next to the board-grant check:

```python
    from documents.models import DocumentSpaceGrant
    if db.execute(select(DocumentSpaceGrant.id).where(DocumentSpaceGrant.group_id == group_id)
                  .limit(1)).scalar_one_or_none() is not None:
        raise ConflictError("group is granted on document spaces; remove the grants first")
```

Keep the import inside the function (groups must not import documents at module load; documents imports groups).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_spaces_routes.py tests/test_groups_routes.py tests/test_documents_routes.py -q -p no:cacheprovider`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(documents): space administration routes; a granted group cannot be deleted

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/service.py backend/documents/routes.py backend/documents/schemas.py backend/groups/service.py backend/tests/test_documents_spaces_routes.py backend/tests/test_groups_routes.py
```

---

### Task 7: Flag visibility for the `document` entity

**Files:**
- Create: `backend/documents/flag_entity.py`
- Modify: `backend/flags/seams.py` (the `register_entity("document", ...)` call, around line 798)
- Test: `backend/tests/test_flags_documents.py` (append)

**Interfaces:**
- Consumes: `access.can_view_document`, `access.visible_space_ids`, `service.latest_revision`.
- Produces: `documents.flag_entity.can_raise(db, user, eid)`, `can_view(db, user, eid)`, `visible_ids(db, user)`, `search_scoped(db, user, q)`, `audience(db, eid)`; the registration passes them as `can_raise=`, `can_view=`, `visible_entity_ids=`, `search_scoped=`, `audience=`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_flags_documents.py`:

```python
# --- spaces (spec 2026-10-06 section 6) --------------------------------------------------

ADMIN_U = SimpleNamespace(id=1, role="admin", email="a@x.t", is_active=True)
MEMBER_U = SimpleNamespace(id=10, role="standard", email="m@x.t", is_active=True)
OUTSIDER_U = SimpleNamespace(id=11, role="standard", email="o@x.t", is_active=True)


def _restricted(db):
    from documents import service as docs
    from documents.models import DocumentSpace, DocumentSpaceGrant
    from groups.models import UserGroup, UserGroupMember
    import groups.models  # noqa: F401
    docs.seed_spaces(db)
    g = UserGroup(slug="leaders", name="L")
    sp = DocumentSpace(slug="leadership", name="L", visibility="restricted")
    db.add_all([g, sp])
    db.flush()
    db.add_all([UserGroupMember(group_id=g.id, user_id=MEMBER_U.id),
                DocumentSpaceGrant(space_id=sp.id, group_id=g.id)])
    db.commit()
    cat = docs.resolve_category(db, category="ART")
    secret, _ = docs.create_document(db, title="Q4 plan", html=HTML, category=cat, space=sp)
    public, _ = docs.create_document(db, title="Public", html=HTML + "<!--p-->", category=cat)
    return g, sp, secret, public


def test_document_seams_follow_the_space(db):
    from flags import seams
    seams.register_mk1_entities()
    spec = seams.get_entity_spec("document")
    g, sp, secret, public = _restricted(db)
    assert spec.can_view(db, OUTSIDER_U, secret.code) is False
    assert spec.can_view(db, MEMBER_U, secret.code) is True
    assert spec.can_view(db, OUTSIDER_U, public.code) is True
    assert spec.can_view(db, OUTSIDER_U, "ART-9999") is False  # unknown anchor: fail closed
    assert spec.can_view(db, ADMIN_U, "ART-9999") is True
    assert spec.can_raise(db, OUTSIDER_U, secret.code) is False
    assert spec.can_raise(db, MEMBER_U, secret.code) is True
    assert spec.visible_entity_ids(db, ADMIN_U) is None
    visible = set(db.execute(spec.visible_entity_ids(db, OUTSIDER_U)).scalars().all())
    assert visible == {public.code}
    labels = [r["entity_id"] for r in spec.search_scoped(db, OUTSIDER_U, "Q4")]
    assert labels == []
    assert [r["entity_id"] for r in spec.search_scoped(db, MEMBER_U, "Q4")] == [secret.code]
    assert spec.audience(db, public.code) is None
    assert spec.audience(db, secret.code) == {"groups": [g.id]}
    assert spec.audience(db, "ART-9999") == {"groups": []}
```

The `db` fixture in this file must also import `groups.models`; add `import groups.models  # noqa: F401` beside `import documents.models` in the fixture.

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_flags_documents.py -q -p no:cacheprovider -k seams_follow`
Expected: FAIL with `TypeError: 'NoneType' object is not callable` (`spec.can_view` is None).

- [ ] **Step 3: Create the closures**

```python
# backend/documents/flag_entity.py
"""Visibility closures for the `document` flag entity (spec 2026-10-06 section 6).

The entity_id is the document CODE. Visibility follows the code's space through
documents.access. Everything imports lazily inside the closures, mirroring
boards/flag_entity.py, so flags.seams has no import-time dependency on documents."""
from __future__ import annotations

from typing import Optional


def _latest(db, code):
    from documents.service import latest_revision
    if db is None or not code:
        return None
    return latest_revision(db, str(code).strip())


def can_raise(db, user, eid) -> bool:
    from documents.access import can_view_document
    doc = _latest(db, eid)
    return doc is not None and can_view_document(db, user, doc)


def can_view(db, user, eid) -> bool:
    from documents.access import can_view_document
    from groups.access import is_admin
    doc = _latest(db, eid)
    if doc is None:
        return is_admin(user)  # unknown or deleted anchor: fail closed
    return can_view_document(db, user, doc)


def visible_ids(db, user):
    from sqlalchemy import or_, select
    from documents.access import visible_space_ids
    from documents.models import Document
    from groups.access import is_admin
    if is_admin(user):
        return None
    return (select(Document.code)
            .where(or_(Document.space_id.in_(visible_space_ids(db, user)), Document.space_id.is_(None)))
            .distinct())


def search_scoped(db, user, q) -> list:
    from sqlalchemy import or_
    from documents.access import visible_space_ids
    from documents.models import Document
    from flags.seams import _ilike_prefix
    from groups.access import is_admin
    query = (db.query(Document)
             .filter(or_(Document.code.ilike(_ilike_prefix(q), escape="\\"),
                         Document.title.ilike("%" + _ilike_prefix(q), escape="\\"))))
    if not is_admin(user):
        query = query.filter(or_(Document.space_id.in_(visible_space_ids(db, user)),
                                 Document.space_id.is_(None)))
    rows = query.order_by(Document.code, Document.revision.desc()).limit(60).all()
    out, seen = [], set()
    for r in rows:  # newest revision of each code wins
        if r.code in seen:
            continue
        seen.add(r.code)
        out.append({"entity_id": r.code, "label": f"{r.code} \u00b7 {r.title}"})
        if len(out) == 10:
            break
    return out


def audience(db, eid) -> Optional[dict]:
    """Live-event audience: everyone for a company space, the granted groups (plus
    admins) for a restricted one, admins only when the code no longer resolves."""
    from sqlalchemy import select
    from documents.models import DocumentSpaceGrant
    doc = _latest(db, eid)
    if doc is None:
        return {"groups": []}
    space = doc.space
    if space is None or space.visibility == "company":
        return None
    gids = db.execute(select(DocumentSpaceGrant.group_id).where(DocumentSpaceGrant.space_id == space.id)
                      .order_by(DocumentSpaceGrant.group_id)).scalars().all()
    return {"groups": [int(g) for g in gids]}
```

- [ ] **Step 4: Register them**

In `backend/flags/seams.py`, change the `register_entity("document", ...)` call to:

```python
    from documents.flag_entity import audience as _document_audience
    from documents.flag_entity import can_raise as _document_can_raise
    from documents.flag_entity import can_view as _document_can_view
    from documents.flag_entity import search_scoped as _document_search_scoped
    from documents.flag_entity import visible_ids as _document_visible_ids
    register_entity("document",
                    label=_document_label,
                    deep_link=lambda eid: "/#reports/documents",
                    can_flag=lambda user, eid: True,   # never consulted: can_raise wins
                    can_raise=_document_can_raise,
                    can_view=_document_can_view,
                    visible_entity_ids=_document_visible_ids,
                    context=_document_context,
                    state=_document_state,
                    search=_document_search,
                    search_scoped=_document_search_scoped,
                    snapshot=_document_snapshot,
                    audience=_document_audience,
                    must_exist=True)
```

`documents/flag_entity.py` imports nothing from `flags` at module level, so the lazy-import rule (documents must import `flags.seams` lazily) holds.

- [ ] **Step 5: Run the flag suites**

Run: `.venv/Scripts/python.exe -m pytest tests/test_flags_documents.py tests/test_flags_visibility_enforcement.py tests/test_flags_seams_visibility_hooks.py -q -p no:cacheprovider`
Expected: PASS. The enforcement suite proves the core honours `can_view` for any registered type; a failure there means the closures raised, which they must never do.

- [ ] **Step 6: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(flags): document threads follow the document's space

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/flag_entity.py backend/flags/seams.py backend/tests/test_flags_documents.py
```

---

### Task 8: Frontend API client, hooks, and list query

**Files:**
- Modify: `src/lib/api-documents.ts`
- Modify: `src/components/documents/documents-utils.ts`
- Modify: `src/services/documents.ts`
- Test: `src/lib/__tests__/documents-utils.test.ts` (append; the file exists per the utils header comment)

**Interfaces:**
- Produces types: `DocumentSpace { id, slug, name, description, visibility: 'company' | 'restricted', is_active, sort_order, document_count, can_write, created_at, updated_at }`, `DocumentSpaceCreate`, `DocumentSpaceUpdate`; `DocumentRow.space_id: number | null`, `space_slug: string`, `space_name: string`; `DocumentPatch.space_id?: number`; `DocumentListParams.spaceId?: number | null`.
- Produces fetchers: `listDocumentSpaces(includeInactive = false)`, `createDocumentSpace(data)`, `updateDocumentSpace(id, data)`, `getDocumentSpaceGrants(id) -> number[]`, `replaceDocumentSpaceGrants(id, groupIds) -> number[]`, `deleteDocumentSpace(id)`.
- Produces hooks: `useDocumentSpaces(includeInactive = false)`, `useCreateDocumentSpace`, `useUpdateDocumentSpace`, `useDocumentSpaceGrants(id)`, `useReplaceDocumentSpaceGrants`, `useDeleteDocumentSpace`; `documentKeys.allSpaces`, `documentKeys.spaces(includeInactive)`, `documentKeys.spaceGrants(id)`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/__tests__/documents-utils.test.ts`:

```ts
describe('buildDocumentListQuery space filter', () => {
  it('adds space_id when given and omits it otherwise', () => {
    expect(buildDocumentListQuery({ spaceId: 7 })).toContain('space_id=7')
    expect(buildDocumentListQuery({})).not.toContain('space_id')
    expect(buildDocumentListQuery({ spaceId: null })).not.toContain('space_id')
  })
})
```

(`buildDocumentListQuery` is already imported at the top of that test file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/__tests__/documents-utils.test.ts`
Expected: FAIL (`space_id` never emitted; TypeScript error on `spaceId`).

- [ ] **Step 3: Utils and API types**

In `documents-utils.ts`, add `spaceId?: number | null` to `DocumentListParams` and in `buildDocumentListQuery` after the category line: `if (p.spaceId != null) params.set('space_id', String(p.spaceId))`.

In `api-documents.ts`:

```ts
export type DocumentSpaceVisibility = 'company' | 'restricted'

export interface DocumentSpace {
  id: number
  slug: string
  name: string
  description: string | null
  visibility: DocumentSpaceVisibility
  is_active: boolean
  sort_order: number
  document_count: number
  /** True for admins (bearer) or for an agent token's allow-list. */
  can_write: boolean
  created_at: string
  updated_at: string
}

export interface DocumentSpaceCreate {
  slug: string
  name: string
  description?: string | null
  visibility?: DocumentSpaceVisibility
  sort_order?: number
}

export interface DocumentSpaceUpdate {
  name?: string
  description?: string | null
  visibility?: DocumentSpaceVisibility
  is_active?: boolean
  sort_order?: number
}
```

Add to `DocumentRow` after `category_prefix`: `space_id: number | null`, `space_slug: string`, `space_name: string`. Add to `DocumentPatch`: `/** Admin only. Moves every revision of the code. */ space_id?: number`.

Fetchers, after `deleteDocumentCategory`:

```ts
export function listDocumentSpaces(includeInactive = false): Promise<DocumentSpace[]> {
  return apiFetch<DocumentSpace[]>(
    `/api/document-spaces${includeInactive ? '?include_inactive=true' : ''}`
  )
}

export function createDocumentSpace(data: DocumentSpaceCreate): Promise<DocumentSpace> {
  return apiFetch<DocumentSpace>('/api/document-spaces', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function updateDocumentSpace(id: number, data: DocumentSpaceUpdate): Promise<DocumentSpace> {
  return apiFetch<DocumentSpace>(`/api/document-spaces/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function getDocumentSpaceGrants(id: number): Promise<number[]> {
  const out = await apiFetch<{ space_id: number; group_ids: number[] }>(
    `/api/document-spaces/${id}/grants`
  )
  return out.group_ids
}

export async function replaceDocumentSpaceGrants(id: number, groupIds: number[]): Promise<number[]> {
  const out = await apiFetch<{ space_id: number; group_ids: number[] }>(
    `/api/document-spaces/${id}/grants`,
    { method: 'PUT', body: JSON.stringify({ group_ids: groupIds }) }
  )
  return out.group_ids
}

export function deleteDocumentSpace(id: number): Promise<void> {
  return apiFetch<undefined>(`/api/document-spaces/${id}`, { method: 'DELETE' })
}
```

- [ ] **Step 4: Hooks**

In `services/documents.ts`, extend the import list with the six fetchers and the two types, add keys:

```ts
  allSpaces: ['documents', 'spaces'] as const,
  spaces: (includeInactive: boolean) => ['documents', 'spaces', includeInactive] as const,
  spaceGrants: (id: number) => ['documents', 'spaces', 'grants', id] as const,
```

and hooks at the end of the file:

```ts
export function useDocumentSpaces(includeInactive = false) {
  return useQuery({
    queryKey: documentKeys.spaces(includeInactive),
    queryFn: () => listDocumentSpaces(includeInactive),
    staleTime: 60_000,
  })
}

export function useDocumentSpaceGrants(id: number | null) {
  return useQuery({
    queryKey: documentKeys.spaceGrants(id ?? -1),
    queryFn: () => getDocumentSpaceGrants(id as number),
    enabled: id != null,
  })
}

function invalidateSpaces(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: documentKeys.allSpaces })
  qc.invalidateQueries({ queryKey: documentKeys.lists })
}

export function useCreateDocumentSpace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: DocumentSpaceCreate) => createDocumentSpace(data),
    onSuccess: () => {
      invalidateSpaces(qc)
      toast.success('Space created')
    },
    onError: (e: Error) =>
      toast.error(/failed: 409/.test(e.message) ? 'That slug is taken' : e.message),
  })
}

export function useUpdateDocumentSpace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DocumentSpaceUpdate }) =>
      updateDocumentSpace(id, data),
    onSuccess: () => {
      invalidateSpaces(qc)
      toast.success('Space updated')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useReplaceDocumentSpaceGrants() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, groupIds }: { id: number; groupIds: number[] }) =>
      replaceDocumentSpaceGrants(id, groupIds),
    onSuccess: (_ids, { id }) => {
      qc.invalidateQueries({ queryKey: documentKeys.spaceGrants(id) })
      invalidateSpaces(qc)
      toast.success('Access saved')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteDocumentSpace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteDocumentSpace(id),
    onSuccess: () => {
      invalidateSpaces(qc)
      toast.success('Space deleted')
    },
    onError: (e: Error) => {
      if (/failed: 409/.test(e.message)) {
        toast.error('Space still holds documents; move them first')
        return
      }
      toast.error(e.message)
    },
  })
}
```

Also make `usePatchDocument` invalidate `documentKeys.allSpaces` in its `onSuccess` (a move changes counts).

- [ ] **Step 5: Run the test and typecheck**

Run: `npx vitest run src/lib/__tests__/documents-utils.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; tsc reports errors ONLY where `DocumentRow` is constructed in existing tests without the new fields. Fix those test fixtures by adding `space_id: 1, space_slug: 'general', space_name: 'General'`; do not loosen the type.

- [ ] **Step 6: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(documents): spaces API client, hooks and list query

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/lib/api-documents.ts src/components/documents/documents-utils.ts src/services/documents.ts src/lib/__tests__/documents-utils.test.ts
```

(Add any test fixture files you had to touch to the pathspec.)

---

### Task 9: Hash parameter and store state for the selected space

**Files:**
- Modify: `src/store/ui-store.ts` (state near line 122, actions near line 435)
- Modify: `src/lib/hash-navigation.ts` (parse around line 70, apply around line 116, build around line 184)
- Modify: `docs/superpowers/specs/2026-10-06-document-spaces-design.md` (append section 15)
- Test: `src/lib/__tests__/hash-navigation.test.ts` (append; create with the same imports as its siblings if it does not exist)

**Interfaces:**
- Produces store: `documentsSpaceSlug: string | null`, `navigateToDocumentSpace(slug: string | null)`. `navigateToDocument(id)` leaves `documentsSpaceSlug` unchanged; `clearDocumentViewer()` unchanged.
- Produces hash: `#reports/documents?space=<slug>` when a space is selected and no viewer target; `?id=` wins when a viewer target is set.

- [ ] **Step 1: Write the failing tests**

```ts
describe('documents space in the hash', () => {
  it('parses ?space= into the store and builds it back', () => {
    const store = useUIStore.getState()
    applyHash('#reports/documents?space=accounting')
    expect(useUIStore.getState().documentsSpaceSlug).toBe('accounting')
    expect(useUIStore.getState().documentViewerTargetId).toBeNull()
    expect(currentHash()).toBe('#reports/documents?space=accounting')
    store.navigateToDocument(12)
    expect(currentHash()).toBe('#reports/documents?id=12')
    store.clearDocumentViewer()
    expect(currentHash()).toBe('#reports/documents?space=accounting')
    store.navigateToDocumentSpace(null)
    expect(currentHash()).toBe('#reports/documents')
  })
})
```

Use the helper names that file already exposes for "apply a hash" and "read the built hash"; if it has none, export `parseHash` and `buildHash` from `hash-navigation.ts` for the test (they are module-private today) and call `applyNavToStore(parseHash(...))` and `buildHash(useUIStore.getState())`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/__tests__/hash-navigation.test.ts`
Expected: FAIL (`documentsSpaceSlug` undefined).

- [ ] **Step 3: Store**

In `ui-store.ts` state interface, after `documentViewerTargetId: number | null` add `documentsSpaceSlug: string | null`. In the actions interface after `navigateToDocument` add `navigateToDocumentSpace: (slug: string | null) => void`. In the initial state after `documentViewerTargetId: null,` add `documentsSpaceSlug: null,`. After the `clearDocumentViewer` action add:

```ts
      navigateToDocumentSpace: slug =>
        set(
          state => ({
            activeSection: 'reports',
            activeSubSection: 'documents',
            documentsSpaceSlug: slug,
            documentViewerTargetId: null,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToDocumentSpace'
        ),
```

- [ ] **Step 4: Hash**

In `hash-navigation.ts` `parseHash`: add `let spaceSlug: string | null = null` and inside the `if (query)` block `spaceSlug = params.get('space')`; return it as `spaceSlug` and add it to the `ParsedNav` type. In `applyNavToStore`, before the `documents && targetId` branch add:

```ts
  } else if (subSection === 'documents' && nav.spaceSlug) {
    store.navigateToDocumentSpace(nav.spaceSlug)
```

(Keep it above the `documents && targetId` branch so a hash with both honours `id`; a hash with both is not something the app emits.)

In `buildHash` add `documentsSpaceSlug: string | null` to the parameter type and, in the `documents` branch:

```ts
  } else if (state.activeSubSection === 'documents' && state.documentViewerTargetId != null) {
    hash += `?id=${encodeURIComponent(String(state.documentViewerTargetId))}`
  } else if (state.activeSubSection === 'documents' && state.documentsSpaceSlug) {
    hash += `?space=${encodeURIComponent(state.documentsSpaceSlug)}`
```

Wherever `buildHash` is called with a projection of the store (around line 226, the subscribe comparison), add `documentsSpaceSlug` to both the projection and the change check.

- [ ] **Step 5: Spec amendment**

Append to the spec:

```markdown
## 15. Amendments during implementation (2026-10-06)

- Section 9.4 said the selected space slug rides the hash and not the store. Every deep link in this app round-trips through `hash-navigation.ts` and a store field, so the slug lives in `ui-store.documentsSpaceSlug` with `navigateToDocumentSpace(slug)`. `?id=` wins over `?space=` when both are present.
```

- [ ] **Step 6: Run and commit**

Run: `npx vitest run src/lib/__tests__/hash-navigation.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

```bash
git -c core.autocrlf=true commit -m "feat(documents): ?space= deep link and documentsSpaceSlug store state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/store/ui-store.ts src/lib/hash-navigation.ts src/lib/__tests__/hash-navigation.test.ts docs/superpowers/specs/2026-10-06-document-spaces-design.md
```

---

### Task 10: Space grid, scoped list, viewer chip, move select, board preview copy

**Files:**
- Create: `src/components/documents/SpacesGrid.tsx`
- Modify: `src/components/documents/DocumentsPage.tsx`
- Modify: `src/components/documents/DocumentViewer.tsx` (header badges, around line 108)
- Modify: `src/components/documents/RetitleDialog.tsx`
- Modify: `src/components/boards/DocumentPreviewFrame.tsx`
- Test: `src/components/documents/__tests__/SpacesGrid.test.tsx` (create), `src/components/documents/__tests__/DocumentsPage.test.tsx` (create or append), `src/components/boards/__tests__/DocumentPreviewFrame.test.tsx` (append)

**Interfaces:**
- Consumes: `useDocumentSpaces`, `useUIStore().documentsSpaceSlug`, `navigateToDocumentSpace`, `DocumentListParams.spaceId`, `DocumentRow.space_*`, `DocumentPatch.space_id`.
- Produces: `SpacesGrid({ spaces, onOpen })` presentational component.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/documents/__tests__/SpacesGrid.test.tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SpacesGrid } from '@/components/documents/SpacesGrid'
import type { DocumentSpace } from '@/lib/api-documents'

const space = (over: Partial<DocumentSpace>): DocumentSpace => ({
  id: 1, slug: 'general', name: 'General', description: null, visibility: 'company',
  is_active: true, sort_order: 0, document_count: 3, can_write: false,
  created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', ...over,
})

describe('SpacesGrid', () => {
  it('renders one card per space with the count and a lock on restricted ones', () => {
    const onOpen = vi.fn()
    render(<SpacesGrid spaces={[space({}), space({ id: 2, slug: 'leadership', name: 'Leadership', visibility: 'restricted', document_count: 1 })]} onOpen={onOpen} />)
    expect(screen.getByRole('button', { name: /General/ })).toHaveTextContent('3 docs')
    const exec = screen.getByRole('button', { name: /Leadership/ })
    expect(exec).toHaveTextContent('Restricted')
    fireEvent.click(exec)
    expect(onOpen).toHaveBeenCalledWith('leadership')
  })

  it('shows the empty hint when there is nothing to show', () => {
    render(<SpacesGrid spaces={[]} onOpen={() => {}} />)
    expect(screen.getByText(/No spaces you can see/)).toBeInTheDocument()
  })
})
```

For `DocumentsPage`, add a test file that mocks `@/services/documents` the way the existing documents tests in this repo mock hooks (search `vi.mock('@/services/documents'` under `src/` for the idiom and copy it):

```tsx
it('shows the grid with no space selected and the scoped list when one is', async () => {
  useUIStore.setState({ documentsSpaceSlug: null, documentViewerTargetId: null })
  render(<DocumentsPage />)
  expect(await screen.findByRole('button', { name: /General/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /General/ }))
  expect(useUIStore.getState().documentsSpaceSlug).toBe('general')
  expect(await screen.findByText('Documents / General')).toBeInTheDocument()
})

it('shows the empty state for an unknown space slug', async () => {
  // Review Focus 5: a deep link to a space the caller cannot see is an empty list, not an error.
  useUIStore.setState({ documentsSpaceSlug: 'nope', documentViewerTargetId: null })
  render(<DocumentsPage />)
  expect(await screen.findByText(/No documents match/)).toBeInTheDocument()
  expect(screen.getByText('Documents / nope')).toBeInTheDocument()
})
```

Append to `DocumentPreviewFrame.test.tsx`:

```tsx
it('says the document is restricted or missing when content cannot load', () => {
  vi.mocked(useDocumentContent).mockReturnValue({ isLoading: false, data: undefined, error: new Error('GET failed: 404') } as never)
  render(<DocumentPreviewFrame id={5} />)
  expect(screen.getByText(/restricted or no longer exists/)).toBeInTheDocument()
})
```

(Match that file's existing mocking of `useDocumentContent`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/documents src/components/boards/__tests__/DocumentPreviewFrame.test.tsx`
Expected: FAIL (no `SpacesGrid` module; grid not rendered).

- [ ] **Step 3: SpacesGrid**

```tsx
// src/components/documents/SpacesGrid.tsx
import { FolderOpen, Globe, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { DocumentSpace } from '@/lib/api-documents'

/** The first level of the Documents page (spec 2026-10-06 section 9.1): one card per
 *  space the caller can see. The server already filtered by visibility, so a
 *  restricted space here is one the viewer is granted. */
export function SpacesGrid({
  spaces,
  onOpen,
}: {
  spaces: DocumentSpace[]
  onOpen: (slug: string) => void
}) {
  if (spaces.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
        <FolderOpen className="h-8 w-8" />
        <p className="text-sm">No spaces you can see.</p>
      </div>
    )
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {spaces.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => onOpen(s.slug)}
          className="flex flex-col gap-2 rounded-md border p-4 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{s.name}</span>
            <Badge variant={s.visibility === 'restricted' ? 'secondary' : 'outline'}>
              {s.visibility === 'restricted' ? (
                <Lock className="mr-1 h-3 w-3" aria-hidden />
              ) : (
                <Globe className="mr-1 h-3 w-3" aria-hidden />
              )}
              {s.visibility === 'restricted' ? 'Restricted' : 'Company'}
            </Badge>
          </div>
          {s.description && (
            <p className="line-clamp-2 text-xs text-muted-foreground">{s.description}</p>
          )}
          <span className="mt-auto text-xs text-muted-foreground tabular-nums">
            {s.document_count} doc{s.document_count === 1 ? '' : 's'}
          </span>
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: DocumentsPage**

In `DocumentsPage.tsx`:

- Import `SpacesGrid`, `useDocumentSpaces`, `ChevronRight` from lucide.
- `DocumentsPage()`: after the viewer branch, read `const spaceSlug = useUIStore(s => s.documentsSpaceSlug)` and render `spaceSlug ? <DocumentsList spaceSlug={spaceSlug} /> : <SpacesLanding />`.
- New `SpacesLanding()`:

```tsx
function SpacesLanding() {
  const spaces = useDocumentSpaces(false)
  const navigateToDocumentSpace = useUIStore(s => s.navigateToDocumentSpace)
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div>
        <h1 className="text-lg font-semibold">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Artifacts, SOPs and other controlled documents, organised by who they are for.
        </p>
      </div>
      {spaces.error ? (
        <p className="text-sm text-destructive">Could not load spaces: {spaces.error.message}</p>
      ) : spaces.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <SpacesGrid spaces={spaces.data ?? []} onOpen={navigateToDocumentSpace} />
      )}
    </div>
  )
}
```

- `DocumentsList({ spaceSlug })`: resolve `const spaces = useDocumentSpaces(true)` and `const space = spaces.data?.find(s => s.slug === spaceSlug) ?? null`; put `spaceId: space ? space.id : -1` into `params` (an unknown slug yields `-1`, which the server answers with an empty list, Review Focus 5); wait for `spaces.isLoading` before rendering the table so the first request is not unscoped. Replace the header block with a breadcrumb:

```tsx
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-1 text-lg font-semibold">
            <button type="button" className="hover:underline" onClick={() => navigateToDocumentSpace(null)}>
              Documents
            </button>
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span>{space?.name ?? spaceSlug}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {space?.description ?? 'Artifacts, SOPs and other controlled documents published to the lab.'}
          </p>
        </div>
        ...
```

Render the visible text of the breadcrumb so the test's `Documents / General` assertion holds: add `<span className="sr-only"> / </span>` between the two parts (`findByText` matches the combined text via a custom matcher; simplest is to give the `h1` an `aria-label={`Documents / ${space?.name ?? spaceSlug}`}` and assert with `getByRole('heading', { name: 'Documents / General' })` in the tests instead; use that form in Step 1 if `findByText` proves brittle).

Keep every filter, column and the pagination unchanged.

- [ ] **Step 5: Viewer chip and move select**

`DocumentViewer.tsx`: after `<Badge variant="outline">{doc.category_name}</Badge>` add:

```tsx
            <Badge variant={doc.space_slug === 'general' ? 'outline' : 'secondary'}>
              {doc.space_name}
            </Badge>
```

`RetitleDialog.tsx`: add `const spaces = useDocumentSpaces(false)` and state `const [spaceId, setSpaceId] = useState(String(doc.space_id ?? ''))`, reset it in the open transition, add a third column to the grid:

```tsx
            <div className="grid gap-1.5">
              <Label htmlFor="doc-space">Space</Label>
              <Select value={spaceId} onValueChange={setSpaceId}>
                <SelectTrigger id="doc-space">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(spaces.data ?? []).map(s => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Moving changes every revision of {doc.code}.</p>
            </div>
```

and include `space_id: Number(spaceId)` in the patch body only when it differs from `doc.space_id`. Change the grid to `grid-cols-3`.

`DocumentPreviewFrame.tsx`: change the `!content.data` branch to:

```tsx
  if (!content.data)
    return (
      <p className="text-xs text-muted-foreground">
        {content.error ? 'This document is restricted or no longer exists.' : 'No preview.'}
      </p>
    )
```

- [ ] **Step 6: Run, lint, commit**

Run: `npx vitest run src/components/documents src/components/boards/__tests__/DocumentPreviewFrame.test.tsx && npx tsc --noEmit -p tsconfig.json && npx eslint src/components/documents src/components/boards/DocumentPreviewFrame.tsx && npx prettier --check src/components/documents src/components/boards/DocumentPreviewFrame.tsx`
Expected: all green.

```bash
git -c core.autocrlf=true commit -m "feat(documents): spaces grid as the first level; scoped list, viewer chip, admin move

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/documents/SpacesGrid.tsx src/components/documents/DocumentsPage.tsx src/components/documents/DocumentViewer.tsx src/components/documents/RetitleDialog.tsx src/components/boards/DocumentPreviewFrame.tsx src/components/documents/__tests__/SpacesGrid.test.tsx src/components/documents/__tests__/DocumentsPage.test.tsx src/components/boards/__tests__/DocumentPreviewFrame.test.tsx
```

---

### Task 11: Settings: Spaces section with grants editor

**Files:**
- Modify: `src/components/preferences/panes/DocumentsPane.tsx`
- Modify: `locales/en.json`, `locales/ar.json`, `locales/fr.json` (flat keys, after the `preferences.documents.add` line)
- Test: `src/components/preferences/panes/__tests__/DocumentsPane.test.tsx` (create, mirroring `GroupsPane.test.tsx`'s mocking of hooks and `useAuthStore`)

**Interfaces:**
- Consumes: `useDocumentSpaces(true)`, `useCreateDocumentSpace`, `useUpdateDocumentSpace`, `useDeleteDocumentSpace`, `useDocumentSpaceGrants`, `useReplaceDocumentSpaceGrants`, `useGroups()` from `@/services/groups`.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('DocumentsPane spaces', () => {
  it('lists spaces above categories and hides General guards', () => {
    render(<DocumentsPane />)
    expect(screen.getByText('Document spaces')).toBeInTheDocument()
    const general = screen.getByTestId('doc-space-row-general')
    expect(within(general).queryByRole('button', { name: /Restrict/ })).toBeNull()
    expect(within(general).queryByRole('button', { name: /Delete/ })).toBeNull()
    const exec = screen.getByTestId('doc-space-row-leadership')
    expect(within(exec).getByRole('button', { name: /Groups/ })).toBeInTheDocument()
  })

  it('creates a space from the form', () => {
    render(<DocumentsPane />)
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'accounting' } })
    fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'Accounting' } })
    fireEvent.click(screen.getByRole('button', { name: /Add space/ }))
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'accounting', name: 'Accounting', visibility: 'company' }),
      expect.anything()
    )
  })

  it('saves grants for a restricted space', () => {
    render(<DocumentsPane />)
    fireEvent.click(within(screen.getByTestId('doc-space-row-leadership')).getByRole('button', { name: /Groups/ }))
    fireEvent.click(screen.getByLabelText('Leaders'))
    fireEvent.click(screen.getByRole('button', { name: /Save access/ }))
    expect(replaceGrantsMutate).toHaveBeenCalledWith({ id: 2, groupIds: [7] }, expect.anything())
  })
})
```

Mock `useDocumentSpaces` to return General (id 1) and Leadership (id 2, restricted), `useGroups` to return one group `{ id: 7, slug: 'leaders', name: 'Leaders', is_active: true }`, `useDocumentSpaceGrants` to return `[]`, and `useAuthStore` to an admin. Mock `useDocumentCategories` as the existing GroupsPane test mocks its hooks (return `{ data: [], isLoading: false, isError: false }`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/preferences/panes/__tests__/DocumentsPane.test.tsx`
Expected: FAIL (no "Document spaces" text).

- [ ] **Step 3: Locale keys**

Append after `"preferences.documents.add": "Add",` in `locales/en.json`:

```json
  "preferences.documents.spaces.sectionTitle": "Document spaces",
  "preferences.documents.spaces.sectionHint": "Spaces are the first level of the Documents page and decide who can read what. A company space is readable by every login; a restricted space only by the groups you grant. General always exists and is always company-wide.",
  "preferences.documents.spaces.company": "Company",
  "preferences.documents.spaces.restricted": "Restricted",
  "preferences.documents.spaces.restrict": "Restrict",
  "preferences.documents.spaces.makeCompany": "Make company-wide",
  "preferences.documents.spaces.groups": "Groups",
  "preferences.documents.spaces.saveAccess": "Save access",
  "preferences.documents.spaces.accessHint": "Members of a granted group can read every document in this space. Visibility is per space, not per document.",
  "preferences.documents.spaces.noGroups": "No active groups yet. Create one in the Groups pane first.",
  "preferences.documents.spaces.newSlug": "Slug",
  "preferences.documents.spaces.newSlugPlaceholder": "accounting",
  "preferences.documents.spaces.newName": "Space name",
  "preferences.documents.spaces.newNamePlaceholder": "Accounting",
  "preferences.documents.spaces.newVisibility": "Visibility",
  "preferences.documents.spaces.add": "Add space",
  "preferences.documents.spaces.generalNote": "General cannot be restricted, deactivated or deleted.",
```

Add the same keys to `ar.json` and `fr.json` with Arabic and French values (translate, do not copy English; follow the register of the existing `preferences.documents.*` entries in each file).

- [ ] **Step 4: Pane**

In `DocumentsPane.tsx`, import `useGroups` from `@/services/groups`, the six space hooks, `DocumentSpace`, `DocumentSpaceVisibility`, and shadcn `Select` pieces. Insert, inside the returned `<div className="space-y-8">` BEFORE the categories `SettingsSection`:

```tsx
      <SettingsSection title={t('preferences.documents.spaces.sectionTitle')}>
        <p className="text-sm text-muted-foreground">{t('preferences.documents.spaces.sectionHint')}</p>
        <div className="divide-y rounded-md border">
          {(spaces.data ?? []).map(s => (
            <SpaceRow key={s.id} space={s} readOnly={!isAdmin} />
          ))}
        </div>
        {isAdmin && <NewSpaceForm />}
      </SettingsSection>
```

with `const spaces = useDocumentSpaces(true)` beside the categories query (treat its loading/error like the categories query does).

`SpaceRow`:

```tsx
function SpaceRow({ space, readOnly }: { space: DocumentSpace; readOnly: boolean }) {
  const { t } = useTranslation()
  const [name, setName] = useState(space.name)
  const [description, setDescription] = useState(space.description ?? '')
  const [showGroups, setShowGroups] = useState(false)
  const update = useUpdateDocumentSpace()
  const remove = useDeleteDocumentSpace()
  const isGeneral = space.slug === 'general'
  const dirty = name.trim() !== space.name || (description.trim() || null) !== space.description

  return (
    <div data-testid={`doc-space-row-${space.slug}`} className="px-3 py-2 text-sm">
      <div className="grid grid-cols-[120px_1fr_1fr_auto] items-center gap-3">
        <span className="font-mono text-xs">{space.slug}</span>
        <Input id={`doc-space-name-${space.id}`} value={name} onChange={e => setName(e.target.value)}
               disabled={readOnly} className="h-8 text-xs" aria-label={`${space.slug} name`} />
        <Input id={`doc-space-desc-${space.id}`} value={description} onChange={e => setDescription(e.target.value)}
               disabled={readOnly} placeholder={t('preferences.documents.descriptionPlaceholder')}
               className="h-8 text-xs" aria-label={`${space.slug} description`} />
        <div className="flex items-center gap-2">
          <Badge variant={space.visibility === 'restricted' ? 'secondary' : 'outline'}>
            {t(`preferences.documents.spaces.${space.visibility}`)}
          </Badge>
          <Badge variant={space.is_active ? 'default' : 'outline'}>
            {space.is_active ? t('preferences.documents.active') : t('preferences.documents.inactive')}
          </Badge>
          <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
            {t('preferences.documents.docCount', { count: space.document_count })}
          </span>
          {!readOnly && (
            <>
              <Button size="sm" variant="outline" disabled={!dirty || update.isPending || !name.trim()}
                      onClick={() => update.mutate({ id: space.id, data: { name: name.trim(), description: description.trim() || null } })}>
                {t('preferences.documents.save')}
              </Button>
              {!isGeneral && (
                <Button size="sm" variant="ghost" disabled={update.isPending}
                        onClick={() => update.mutate({ id: space.id, data: { visibility: space.visibility === 'restricted' ? 'company' : 'restricted' } })}>
                  {space.visibility === 'restricted'
                    ? t('preferences.documents.spaces.makeCompany')
                    : t('preferences.documents.spaces.restrict')}
                </Button>
              )}
              {!isGeneral && (
                <Button size="sm" variant="ghost" disabled={update.isPending}
                        onClick={() => update.mutate({ id: space.id, data: { is_active: !space.is_active } })}>
                  {space.is_active ? t('preferences.documents.deactivate') : t('preferences.documents.activate')}
                </Button>
              )}
              {space.visibility === 'restricted' && (
                <Button size="sm" variant="outline" onClick={() => setShowGroups(v => !v)}>
                  {t('preferences.documents.spaces.groups')}
                </Button>
              )}
              {!isGeneral && space.document_count === 0 && (
                <Button size="sm" variant="ghost" className="text-destructive" disabled={remove.isPending}
                        onClick={() => remove.mutate(space.id)}>
                  {t('preferences.documents.delete')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {isGeneral && <p className="mt-1 text-xs text-muted-foreground">{t('preferences.documents.spaces.generalNote')}</p>}
      {showGroups && <GrantsEditor spaceId={space.id} />}
    </div>
  )
}
```

`GrantsEditor` mirrors `GroupsPane.MembersEditor` with groups instead of users:

```tsx
function GrantsEditor({ spaceId }: { spaceId: number }) {
  const { t } = useTranslation()
  const grants = useDocumentSpaceGrants(spaceId)
  const groups = useGroups(false)
  const replace = useReplaceDocumentSpaceGrants()
  const [selected, setSelected] = useState<Set<number> | null>(null)
  const current = selected ?? new Set(grants.data ?? [])
  if (grants.isLoading || groups.isLoading || !groups.data) {
    return <Loader2 className="mt-2 h-4 w-4 animate-spin text-muted-foreground" />
  }
  if (groups.data.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">{t('preferences.documents.spaces.noGroups')}</p>
  }
  const toggle = (id: number) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  return (
    <div className="mt-2 rounded-md border border-dashed p-3">
      <div className="grid gap-1 sm:grid-cols-2">
        {groups.data.map(g => (
          <label key={g.id} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={current.has(g.id)} onChange={() => toggle(g.id)} aria-label={g.name} />
            <span>{g.name}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" disabled={replace.isPending || selected === null}
                onClick={() => replace.mutate({ id: spaceId, groupIds: [...current].sort((a, b) => a - b) }, { onSuccess: () => setSelected(null) })}>
          {t('preferences.documents.spaces.saveAccess')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('preferences.documents.spaces.accessHint')}</span>
      </div>
    </div>
  )
}
```

`NewSpaceForm` mirrors `NewCategoryForm`: fields `Slug` (lowercased, `/^[a-z0-9][a-z0-9-]{0,59}$/`), `Space name`, `Visibility` select (company default), `Add space` button calling `useCreateDocumentSpace().mutate({ slug, name, visibility }, { onSuccess: reset })`. Use `aria-label`/`<Label htmlFor>` text exactly `Slug`, `Space name`, `Visibility` so the tests' `getByLabelText` calls resolve.

- [ ] **Step 5: Run, lint, commit**

Run: `npx vitest run src/components/preferences && npx tsc --noEmit -p tsconfig.json && npx eslint src/components/preferences/panes/DocumentsPane.tsx && npx prettier --check src/components/preferences/panes/DocumentsPane.tsx locales/en.json locales/ar.json locales/fr.json`
Expected: green.

```bash
git -c core.autocrlf=true commit -m "feat(settings): document spaces section with grants editor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/preferences/panes/DocumentsPane.tsx src/components/preferences/panes/__tests__/DocumentsPane.test.tsx locales/en.json locales/ar.json locales/fr.json
```

---

### Task 12: Publish skill `--space`

**Files:**
- Modify: `.claude/skills/mk1-publish-document/scripts/publish_document.py` (argparse around line 88, payload around line 131, result line around line 171)
- Modify: `.claude/skills/mk1-publish-document/SKILL.md`

**Interfaces:**
- Produces: `--space <slug>` (default `general`), sent as `"space"` in the payload; result line gains `space=<slug>`.

- [ ] **Step 1: Extend the self-test**

The script has a `self_test()`; add to it:

```python
    ns = build_parser().parse_args(["x.html", "--title", "t", "--category", "ART", "--space", "Accounting"])
    assert ns.space == "accounting"
    ns = build_parser().parse_args(["x.html", "--title", "t", "--category", "ART"])
    assert ns.space == "general"
```

If the parser is built inline inside `main()`, extract it into `build_parser()` first (pure refactor, same arguments).

- [ ] **Step 2: Run the self-test to verify it fails**

Run: `.venv/Scripts/python.exe ../.claude/skills/mk1-publish-document/scripts/publish_document.py --self-test` (from `backend/`)
Expected: FAIL (`unrecognized arguments: --space`).

- [ ] **Step 3: Implement**

Add `p.add_argument("--space", default="general", type=lambda s: s.strip().lower(), help="space slug (default general); the token must be allowed to write there")`. Add `"space": args.space` to `payload`. Change the final print to include `space={doc.get('space_slug', '?')}` after `status=`.

In `SKILL.md`, in the Publish step command add `--space <slug>` and under Rules add:

```markdown
- `--space` is the slug of the space the document belongs to (default `general`). Spaces decide who can read the document; categories decide what kind it is. A revision (`--code`) always stays in its space; an admin moves it from the viewer. If the server answers `400 space 'x' is not allowed for this agent`, the token's allow-list on prod needs the slug added (Handler, `MK1_DOCUMENT_AGENT_TOKENS` third segment); do not retry with another space.
```

- [ ] **Step 4: Run the self-test to verify it passes, then commit**

Run: the same self-test command. Expected: `self-test ok` (or the script's existing success output).

```bash
git -c core.autocrlf=true commit -m "feat(skill): mk1-publish-document takes --space

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- .claude/skills/mk1-publish-document/scripts/publish_document.py .claude/skills/mk1-publish-document/SKILL.md
```

---

### Task 13: labmanager-mcp: `space` on the document tools (separate repo)

**Repo:** `C:/Users/forre/OneDrive/Documents/GitHub/labmanager-mcp`. Branch `feat/document-spaces` off `release/vial-tools-plus-doc-tools` (the bot-host build; master lags it). That checkout carries another session's uncommitted `server.py` edits: never commit them; use pathspec commits only.

**Files:**
- Modify: `src/labmanager_mcp/tools/documents.py`
- Test: `tests/test_tools_documents.py` (append)

**Interfaces:**
- Produces: `create_document(..., space="general")`, `revise_document(...)` unchanged signature (revisions never send a space), `list_documents(..., space_id=None)`, new `list_spaces(client) -> list` and tool `documents_spaces()`; tools `documents_create(space: str = "general")`, `documents_list(space_id: int | None = None)`.

- [ ] **Step 1: Write the failing tests**

```python
def test_create_sends_space_and_defaults_to_general():
    c = FakeClient()
    documents.create_document(c, "T", "<p>x</p>", "ART", "F")
    assert c.calls[-1]["json"]["space"] == "general"
    documents.create_document(c, "T", "<p>x</p>", "ART", "F", space=" Accounting ")
    assert c.calls[-1]["json"]["space"] == "accounting"


def test_revise_never_sends_a_space():
    c = FakeClient()
    documents.revise_document(c, "ART-0001", "<p>x</p>", "F")
    assert "space" not in c.calls[-1]["json"]


def test_list_filters_by_space_and_spaces_tool_reads_without_service_token():
    c = FakeClient()
    documents.list_documents(c, space_id=3)
    assert ("space_id", 3) in c.calls[-1]["params"]
    documents.list_spaces(c)
    assert c.calls[-1]["path"] == "/api/document-spaces" and c.calls[-1]["service"] is False
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest tests/test_tools_documents.py -q -k "space"` (use the repo's own venv interpreter, or the Mk1 venv if that repo has none)
Expected: FAIL (`unexpected keyword 'space'`).

- [ ] **Step 3: Implement**

In `create_document`, add `space: str = "general"` to the signature and `payload["space"] = (space or "general").strip().lower()`. In `list_documents` add `space_id=None` and `if space_id is not None: params.append(("space_id", space_id))`. Add:

```python
def list_spaces(client) -> list:
    """Spaces the bot can read (bearer). The agent token's WRITE allow-list is a server
    setting; a refused space in documents_create is for the Handler, not a retry."""
    return client.get_json("/api/document-spaces")
```

In `register()`: `documents_create(..., space: str = "general")` passing it through, with the docstring line `space` = slug of the space (default general); `documents_list(..., space_id: int | None = None)`; and:

```python
    @mcp.tool()
    def documents_spaces() -> list:
        """Document spaces the bot can read, with document counts. Spaces decide who can
        read a document; categories decide what kind it is."""
        return list_spaces(client)
```

Update `tests/test_server.py`'s tool inventory if it pins the list.

- [ ] **Step 4: Run and commit**

Run: `python -m pytest tests -q`
Expected: all pass.

```bash
git -c core.autocrlf=true commit -m "feat(documents): space on create and list; documents_spaces tool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/labmanager_mcp/tools/documents.py tests/test_tools_documents.py tests/test_server.py
```

Open the PR against `release/vial-tools-plus-doc-tools`; its body notes the Mk1 release it needs (section 8.2 of the spec) and that the bot-host cutover follows the Mk1 deploy.

---

### Task 14: Stack proof, changelog, PR

**Files:**
- Create: `e2e/document-spaces.spec.ts`
- Modify: `CHANGELOG.md` (under `## Unreleased`)
- Evidence: `docs/superpowers/evidence/<date>-document-spaces/`

**Interfaces:**
- Consumes everything above. Env: `E2E_BASE_URL`, `E2E_BACKEND_URL`, `E2E_EMAIL`, `E2E_PASSWORD` from `/c/tmp/<stack>-e2e.env` (source it in every Bash call; the accumark-stack skill explains creating the stack and reading creds).

- [ ] **Step 1: Stack**

Follow the `accumark-stack-platform` skill: create a stack named `docspaces` from the golden image with this branch mounted, validate, write `/c/tmp/docspaces-e2e.env`. Confirm the backend booted: `curl -s $E2E_BACKEND_URL/api/document-spaces -H "Authorization: Bearer <admin token>"` lists `general` with a count equal to the golden corpus's live codes.

- [ ] **Step 2: Write the spec**

Model it on `e2e/planning-boards-slice2.spec.ts` (same `login`, `asUser`, `shot`, `record`, per-run suffix). Scenarios, in order, serial:

1. Admin creates group `leaders-<run>`, users `member-<run>@accumark.local` and `outsider-<run>@accumark.local` (standard) via `POST /auth/users`, adds the member to the group.
2. Admin creates space `leadership-<run>` (restricted) and grants the group via the API; publishes `Q4 plan (<run>)` into it with `POST /api/documents` (admin bearer, `space`).
3. Admin in the browser: `#reports/documents` shows the grid with General and `Leadership`; screenshot `01-admin-grid.png`. Click Leadership: breadcrumb and the one row; screenshot `02-admin-leadership-list.png`.
4. Member in the browser: grid shows Leadership; the document opens; screenshot `03-member-sees-doc.png`. API: `GET /api/documents/{id}` 200.
5. Outsider in the browser: grid shows General only; screenshot `04-outsider-grid.png`. API: `GET /api/documents/{id}` and `/content` 404 with `detail` equal to a missing id's; `GET /api/documents?space_id=` empty; deep link `#reports/documents?id=<id>` shows the not-found state; screenshot `05-outsider-deep-link.png`.
6. Flags: member raises a `doc_review` flag on the code via `POST /api/flags`; outsider's `GET /api/flags?tab=all_open` and `/api/flags/<id>` do not show it (404 on the point read); member sees it.
7. Admin moves the code to General from the viewer's Edit details dialog; outsider now sees it; screenshot `06-moved-to-general.png`.
8. Revocation: admin removes the member from the group; member's `GET /api/documents/<other secret id>` is 404 on the next request (publish a second secret document before this step).
9. Agent path: with the stack's `MK1_DOCUMENT_AGENT_TOKENS` set to `e2e:<token>:general` (set it in the stack's backend env before the run; the skill explains overrides), run the publish script with `--space leadership-<run>` and assert exit 1 with the 400 text, then without `--space` and assert exit 0.

Record every status code in `api-summary.json` via `record()`.

- [ ] **Step 3: Run it**

Run: `source /c/tmp/docspaces-e2e.env && npx playwright test e2e/document-spaces.spec.ts --reporter=list`
Expected: all scenarios pass; screenshots and `api-summary.json` under the evidence folder.

- [ ] **Step 4: Gates on the whole branch**

Backend: `.venv/Scripts/python.exe -m pytest tests -q -p no:cacheprovider > /c/tmp/docspaces-branch.txt` once, and the same on the branch base in a detached worktree; diff the `FAILED` lines (`sed 's/^FAILED //' | sort -u`, `comm -13`). Expected: zero net-new. Frontend: `npm run typecheck`, full `npx vitest run` compared the same way against the base, eslint and prettier on every touched `src/` file.

- [ ] **Step 5: Changelog and PR**

Under `## Unreleased` in `CHANGELOG.md` add:

```markdown
### Document spaces
- **Spaces are the first level of the Documents page** and decide who can read what. A company space is readable by every login; a restricted space only by the user groups you grant. General is seeded and every existing document now lives in it.
- Every document route, the list, search, comments and attachments, and the document flag threads answer 404 for a document the caller cannot see, exactly as for a missing one.
- Admins create and grant spaces in Settings > Documents, and move a document (every revision together) from Edit details. The publish skill and labmanager-mcp take a `space`; agent tokens may carry a space allow-list (`name:token:slug+slug`, absent = General only).
```

Open the PR against `master` with the `## Verified` block: the pytest and vitest result lines, `Stack: \`docspaces\``, and the screenshots embedded by raw GitHub URL. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. State in the body that Task 15 (annotations route gates) lands as a follow-up commit on this PR once #273 to #276 merge, or as its own PR if this one merges first; either way spaces does not deploy before the annotations chain is gated.

```bash
git -c core.autocrlf=true commit -m "test(e2e): document spaces on a devbox stack; changelog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- e2e/document-spaces.spec.ts CHANGELOG.md docs/superpowers/evidence
```

---

### Task 15: Gate the annotations routes (precondition: #273 to #276 merged into master)

**Files:**
- Modify: `backend/documents/comment_routes.py` (from #273)
- Modify: `backend/documents/routes.py` (`PUT /documents/{doc_id}/content` from #275)
- Test: `backend/tests/test_documents_routes.py` or the annotations suite that owns comment routes (append)

**Interfaces:**
- Consumes: `access.require_view`, `access.visible_space_ids`, `comments.get_comment(db, id) -> DocumentComment` (has `.document_id`), `comments.get_attachment(db, id)` (has `.code`), `comment_export.list_index(...)`.

Do this task only after `git merge-base --is-ancestor <#276 merge commit> HEAD` is true on the branch. Until then it is a documented follow-up (Task 14 PR body).

- [ ] **Step 1: Write the failing tests**

```python
def test_hidden_document_comments_are_404_everywhere(client):
    sp, secret = _restricted_world(client)
    _read_as(client, 1, "admin")
    c = client.post(f"/api/documents/{secret['id']}/comments",
                    json={"kind": "comment", "body": "hello"}).json()
    _read_as(client, 42)  # the outsider
    sid = secret["id"]
    for path in (f"/api/documents/{sid}/comments", f"/api/documents/{sid}/comments/export",
                 f"/api/documents/comments/{c['id']}"):
        assert client.get(path).status_code == 404, path
    assert all(i["document_id"] != sid for i in client.get("/api/documents/comments").json()["items"])
    assert client.post(f"/api/documents/{sid}/comments", json={"kind": "comment", "body": "x"}).status_code == 404
    assert client.post(f"/api/documents/comments/{c['id']}/resolve").status_code == 404
    assert client.put(f"/api/documents/{sid}/content", json={"html": HTML}).status_code == 404
```

(Attachment serving: upload one as the admin via `/comment-attachments`, then assert the outsider's `GET /api/documents/comment-attachments/{id}` is 404.)

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_routes.py -q -p no:cacheprovider -k hidden_document_comments`
Expected: FAIL (200s).

- [ ] **Step 3: Gate**

In `comment_routes.py`, import `from documents import access` and `from documents.service import latest_revision`, and add a helper:

```python
def _gate_code(db, user, code: str) -> None:
    """Comments key on the CODE; the gate runs on the code's latest revision."""
    doc = latest_revision(db, code)
    if doc is None:
        raise NotFoundError(f"document {code!r} not found")
    access.require_view(db, user, doc)
```

Then:

- `get_comment_attachment`: after `att = comments.get_attachment(db, attachment_id)` add `_gate_code(db, user, att.code)`.
- `comments_index`: pass `visible_spaces=access.visible_space_ids(db, user)` into `comment_export.list_index` and add that filter there (`Document.space_id IN visible OR IS NULL`, joining on `DocumentComment.document_id`).
- `get_comment`: load the row, then `_gate_code(db, user, row.code)` before `comment_out`.
- `patch_comment`, `delete_comment`, `resolve_comment`, `reopen_comment`: load the row first with `comments.get_comment`, then `_gate_code(db, actor_user_or_agent_reader, row.code)`, where for an `Actor` with `.user` use that user and for an agent actor use the unrestricted pseudo-reader from `routes._reader_for` plus the `_agent_may_see` allow-list check on the latest revision.
- `export_comments`, `list_comments`, `create_comment`, `add_comment_attachment`: after `doc = service.get_document(db, doc_id)` add `access.require_view(db, <reader>, doc)` (same reader rule).
- `routes.py` `replace_document_content`: after loading the document inside the service call path, add `access.require_view(db, admin, service.get_document(db, doc_id))` as the first line in the `try` (admins see everything, so this is the existence check in the same shape; keep it for symmetry and for a future non-admin editor).

- [ ] **Step 4: Run, commit**

Run: `.venv/Scripts/python.exe -m pytest tests/test_documents_routes.py tests/test_document_comments*.py -q -p no:cacheprovider`
Expected: PASS.

```bash
git -c core.autocrlf=true commit -m "feat(documents): comment, attachment and content-write routes honour the space gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/comment_routes.py backend/documents/comment_export.py backend/documents/routes.py backend/tests/test_documents_routes.py
```

Re-run the stack spec from Task 14 with a comment and an attachment added to scenario 5 before the PR is marked ready.

---

## Self-review notes

- Spec coverage: 4.1 to 4.4 (Tasks 1 and 2); 5 and 5.1 (Tasks 1, 5, 6); 5.2 dedupe and grid absence (Tasks 3, 5, 6, 10); 6 (Task 7); 7.1 to 7.3 (Tasks 4, 5, 12, 13); 8.1 (Task 6); 8.2 (Tasks 5, 15); 9.1 to 9.3 (Task 10); 9.2 Settings (Task 11); 9.4 (Task 9, amended); 10 controls are each tested in the task that owns the code; 11 and 12 (Task 14); 13 unchanged.
- Types: `AgentWriter(name, spaces)`, `agent_may_write(writer, space)`, `_agent_may_see(writer, doc)`, `access.require_view(db, user, doc)`, `service.move_document_space(db, code, space_id, updated_by=)`, `service.list_documents(..., space_id=, visible_spaces=)`, `latest_revision(db, code)` are used with the same names and argument order in every task that calls them.
- Review Focus items 1 to 5 each have a named test in the task that owns the code.
