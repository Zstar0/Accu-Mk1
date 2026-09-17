# Documents Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Accu-Mk1 a controlled-document library (Artifacts + SOPs) that agents publish into over the API and users browse, view, retitle, and categorize in the desktop app.

**Architecture:** A new `backend/documents/` package (models, storage, service, routes) shaped like `backend/flags/` with the `hplc_methods` revision/activate/retire lifecycle; HTML bytes in the existing blob store, metadata in Postgres. The frontend adds a `documents` report sub-section (list + sandboxed `srcdoc` viewer), a Settings pane for categories, and a stdlib-only publish script that inlines a shared `accumark-docs.css` theme and pushes with the existing `X-Service-Token`.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (`Mapped`/`mapped_column`), Pydantic v2, pytest with in-memory SQLite; React 19 + TypeScript + Vite + Tailwind v4 + shadcn (new-york) + Zustand + TanStack Query v5 + TanStack Table v8, vitest + Testing Library; Python 3 stdlib for the publish script.

**Spec:** `docs/superpowers/specs/2026-09-15-documents-library-design.md` (approved 2026-09-15). Read it first; every task below cites its sections.

## Global Constraints

- **Additive only.** No existing route, table, or component changes behavior. A failing pre-existing test defaults to "the test is stale", never to rewriting production code (workspace CLAUDE.md).
- **Worktree:** all work happens in `C:\tmp\mk1-documents` on branch `feat/documents-library` (off `origin/master` v1.21.8, spec commit `feecd3ac`). Never `cd` to the primary checkout. Commit with a pathspec (`git add -- <paths>` then `git commit -- <paths>`) so another session's staged files are never swept.
- **Table names** are `document_categories`, `documents`, `document_code_counters` — **no `lims_` prefix** (spec §3; the `lims_` rule is for sample-hierarchy entities only).
- **Router prefix** is `/api` (flags style): `/api/documents`, `/api/document-categories` (spec §5).
- **Auth:** reads = `get_current_user`; writes = `require_document_writer` (admin login **or** `X-Service-Token` == env `ACCUMK1_INTERNAL_SERVICE_TOKEN`). No new secrets, no new env vars required in prod (spec §9, §11).
- **Content limits:** HTML only (first non-whitespace byte `<`), **16 MiB** cap (`16 * 1024 * 1024`), sha256 stored, identical-bytes repush on a code is a 200 no-op with a metadata patch (spec §4, §5.5).
- **Frontend package manager is npm only.** Never pnpm/yarn.
- **Backend tests:** run from `C:\tmp\mk1-documents\backend` with the primary checkout's venv interpreter: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider <files>`. The full suite is **not** green on master; the gate is a **failure-set diff** against master, never "0 failures".
- **Frontend gates:** `npm run typecheck`, `npm run lint`, `npm run test:run` — gate on the failure-set diff against a pristine master worktree (`C:\tmp\mk1-deploy-1218` is detached at origin/master).
- **Datetime convention:** naive `datetime.utcnow` Python-side defaults (`default=datetime.utcnow`, `onupdate=datetime.utcnow`), never `func.now()`.
- **Theme file** `src/docs-theme/accumark-docs.css` carries the marker `/* accumark-docs v1 */` on its first line; the publish script inlines it once and skips documents that already carry a marker (spec §6–7).
- **Version bump is NOT part of this plan.** Add a `## Unreleased` CHANGELOG entry only; the release cut happens via the `accumark-deploy` skill.

---

## File Structure

**Backend (new package, mirrors `backend/flags/`):**
- `backend/documents/__init__.py` — package marker.
- `backend/documents/models.py` — `DocumentCategory`, `Document`, `DocumentCodeCounter` on `database.Base`.
- `backend/documents/storage.py` — `DocumentStorage` protocol + `InMemoryDocumentStorage`, `FilesystemDocumentStorage`, `S3DocumentStorage`; `get_storage()` / `set_storage_for_tests()`.
- `backend/documents/errors.py` — `NotFoundError`, `BadRequestError`, `ConflictError`.
- `backend/documents/service.py` — all business rules: seed, categories CRUD, code minting, create/revise/dedupe, activate/retire lockstep, patch, list/get, content read.
- `backend/documents/schemas.py` — Pydantic v2 request/response models.
- `backend/documents/routes.py` — `APIRouter(prefix="/api")`, `require_document_writer`, thin handlers.
- Modify `backend/database.py` (`init_db`): register `documents.models`, seed categories.
- Modify `backend/main.py`: import + `include_router`.
- Tests: `backend/tests/test_documents_models.py`, `test_documents_service.py`, `test_documents_routes.py`.

**Publish skill + theme:**
- `src/docs-theme/accumark-docs.css` — the canonical theme (Appendix A).
- `.claude/skills/mk1-publish-document/SKILL.md` — when/how to publish.
- `.claude/skills/mk1-publish-document/scripts/publish_document.py` — stdlib publisher with `--self-test`.

**Frontend:**
- `src/components/documents/documents-utils.ts` — pure helpers (query building, status labels, theme stamping).
- `src/lib/api-documents.ts` — typed fetchers (new module; `src/lib/api.ts` is 8k lines and `api-priorities.ts` is the precedent for a sibling module).
- `src/services/documents.ts` — TanStack Query hooks (mirrors `src/services/flag-types.ts`).
- `src/components/documents/DocumentsPage.tsx` — list (DataTable + filters); renders the viewer when a target id is set.
- `src/components/documents/DocumentViewer.tsx` — header + sandboxed iframe + revision picker + Download/Open + Retitle.
- `src/components/documents/RetitleDialog.tsx` — admin metadata edit.
- `src/components/preferences/panes/DocumentsPane.tsx` — categories management.
- Modify: `src/store/ui-store.ts`, `src/lib/hash-navigation.ts` (three sites), `src/components/layout/AppSidebar.tsx`, `src/components/layout/MainWindowContent.tsx`, `src/components/preferences/panes.tsx`, `locales/en.json`, `locales/ar.json`, `locales/fr.json`.
- Tests: `src/lib/__tests__/documents-utils.test.ts`, `src/components/layout/__tests__/AppSidebar.test.tsx` (extend).

**Docs:** `CHANGELOG.md` (`## Unreleased`).

---

### Task 1: Backend models, storage, and table registration

**Files:**
- Create: `backend/documents/__init__.py`
- Create: `backend/documents/models.py`
- Create: `backend/documents/storage.py`
- Modify: `backend/database.py:116-121` (`init_db` imports)
- Test: `backend/tests/test_documents_models.py`

**Interfaces:**
- Consumes: `database.Base`, `sub_samples.photo_storage.S3PhotoStorage(prefix=...)`, `.save_photo(sample_id, bytes, filename) -> str`, `.fetch_photo(key) -> bytes`, `PhotoNotFoundError`.
- Produces: ORM classes `DocumentCategory(id, name, code_prefix, description, sort_order, active, created_at, updated_at)`, `Document(id, code, revision, title, description, category_id, status, effective_date, activated_at, retired_at, supersedes_id, author, source_session, created_by_user_id, content_type, storage_key, size_bytes, content_sha256, created_at, updated_at, category)`, `DocumentCodeCounter(prefix, next_number)`; storage API `get_storage() -> DocumentStorage` with `.save(code: str, revision: int, data: bytes) -> str` and `.fetch(key: str) -> bytes`, `set_storage_for_tests(storage)`, exceptions `DocumentNotFound`, `DocumentStorageError`, classes `InMemoryDocumentStorage`, `FilesystemDocumentStorage(root=None)`, `S3DocumentStorage()`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_documents_models.py`:

```python
"""Documents library — tables, constraints, blob storage (spec §3, §4)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker


def _engine():
    from database import Base
    import models  # noqa: F401  (users table: documents.created_by_user_id FK)
    import documents.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return engine


def test_tables_created():
    names = set(inspect(_engine()).get_table_names())
    assert {"document_categories", "documents", "document_code_counters"} <= names


def _row(cat_id, rev, status):
    from documents.models import Document
    return Document(code="ART-0001", revision=rev, title="t", category_id=cat_id,
                    status=status, storage_key=f"ART-0001/r{rev}.html",
                    size_bytes=1, content_sha256="0" * 64)


def test_code_revision_unique():
    from sqlalchemy.exc import IntegrityError
    from documents.models import DocumentCategory
    s = sessionmaker(bind=_engine())()
    cat = DocumentCategory(name="Artifact", code_prefix="ART")
    s.add(cat)
    s.flush()
    s.add(_row(cat.id, 1, "draft"))
    s.commit()
    s.add(_row(cat.id, 1, "draft"))
    with pytest.raises(IntegrityError):
        s.commit()


def test_one_active_revision_per_code():
    from sqlalchemy.exc import IntegrityError
    from documents.models import DocumentCategory
    s = sessionmaker(bind=_engine())()
    cat = DocumentCategory(name="Artifact", code_prefix="ART")
    s.add(cat)
    s.flush()
    s.add(_row(cat.id, 1, "active"))
    s.commit()
    s.add(_row(cat.id, 2, "active"))
    with pytest.raises(IntegrityError):
        s.commit()
    s.rollback()
    # Two retired revisions of one code are fine — the index is partial.
    s.add(_row(cat.id, 2, "retired"))
    s.add(_row(cat.id, 3, "retired"))
    s.commit()


def test_storage_roundtrips(tmp_path):
    from documents.storage import (DocumentNotFound, FilesystemDocumentStorage,
                                   InMemoryDocumentStorage)
    for st in (InMemoryDocumentStorage(), FilesystemDocumentStorage(root=str(tmp_path))):
        key = st.save("ART-0001", 1, b"<html>x</html>")
        assert key == "ART-0001/r1.html"
        assert st.fetch(key) == b"<html>x</html>"
        with pytest.raises(DocumentNotFound):
            st.fetch("ART-0001/r9.html")


def test_filesystem_refuses_traversal(tmp_path):
    from documents.storage import DocumentStorageError, FilesystemDocumentStorage
    st = FilesystemDocumentStorage(root=str(tmp_path))
    with pytest.raises(DocumentStorageError):
        st.fetch("../etc/passwd")
    with pytest.raises(DocumentStorageError):
        st.save("ART-0001", 1, b"")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `C:\tmp\mk1-documents\backend`):

```bash
C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/test_documents_models.py
```

Expected: every test errors with `ModuleNotFoundError: No module named 'documents'`.

- [ ] **Step 3: Create the package and models**

`backend/documents/__init__.py`:

```python
"""Documents library: controlled HTML documents (artifacts, SOPs) published by agents.
Spec: docs/superpowers/specs/2026-09-15-documents-library-design.md"""
```

`backend/documents/models.py`:

```python
"""SQLAlchemy models for the documents library (spec §3).

Three tables, deliberately WITHOUT the lims_ prefix (not sample-hierarchy
entities): document_categories, documents (one row per REVISION),
document_code_counters (per-prefix minting sequence).
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import (Boolean, Date, DateTime, ForeignKey, Index, Integer, String,
                        Text, UniqueConstraint, text)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class DocumentCategory(Base):
    """A managed category ("Artifact", "SOP", ...). `code_prefix` is immutable
    once any document uses it — the service enforces that, not the schema."""
    __tablename__ = "document_categories"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    code_prefix: Mapped[str] = mapped_column(String(10), unique=True, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                         server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:
        return f"<DocumentCategory(id={self.id}, name='{self.name}', prefix='{self.code_prefix}')>"


class DocumentCodeCounter(Base):
    """Next number to mint per prefix. Read + bumped under row lock (service)."""
    __tablename__ = "document_code_counters"

    prefix: Mapped[str] = mapped_column(String(10), primary_key=True)
    next_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


class Document(Base):
    """One row per revision. Same controlled-document shape as hplc_methods
    (slice 3): (code, revision) unique, at most one 'active' row per code,
    supersedes_id chains revisions, content is never rewritten."""
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("code", "revision", name="uq_documents_code_revision"),
        Index("uq_documents_code_active", "code", unique=True,
              postgresql_where=text("status = 'active'"),
              sqlite_where=text("status = 'active'")),
        Index("ix_documents_category_id", "category_id"),
        Index("ix_documents_status", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    category_id: Mapped[int] = mapped_column(
        ForeignKey("document_categories.id", ondelete="RESTRICT"), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="draft",
                                        server_default="draft")  # draft|active|retired
    effective_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    activated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    retired_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    supersedes_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("documents.id", ondelete="SET NULL"), nullable=True)
    author: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    source_session: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False,
                                              default="text/html; charset=utf-8")
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)

    category: Mapped["DocumentCategory"] = relationship("DocumentCategory", lazy="joined")

    def __repr__(self) -> str:
        return f"<Document(id={self.id}, code='{self.code}', rev={self.revision}, status='{self.status}')>"
```

- [ ] **Step 4: Create the storage module**

`backend/documents/storage.py`:

```python
"""Blob storage for document HTML (spec §4).

Same three-way shape as flags.seams' attachment storage: in-memory for tests,
filesystem in dev, S3 in prod (through sub_samples.photo_storage.S3PhotoStorage
with its own key prefix). Only the relative key is stored in documents.storage_key.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Protocol


class DocumentNotFound(LookupError):
    """fetch() could not locate a key."""


class DocumentStorageError(RuntimeError):
    """Any storage-layer failure (unsafe key, empty write, I/O)."""


class DocumentStorage(Protocol):
    def save(self, code: str, revision: int, data: bytes) -> str:
        """Persist and return the relative storage key."""

    def fetch(self, key: str) -> bytes:
        """Read bytes by key; raise DocumentNotFound if missing."""


def _rel_key(code: str, revision: int) -> str:
    return f"{code}/r{revision}.html"


def _check_key(key: str) -> None:
    if not key or key.startswith("/") or ".." in key.split("/"):
        raise DocumentStorageError(f"unsafe key: {key!r}")


class InMemoryDocumentStorage:
    """Test double. Keys and bytes live in `blobs`."""

    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}

    def save(self, code: str, revision: int, data: bytes) -> str:
        if not data:
            raise DocumentStorageError("save: empty content")
        key = _rel_key(code, revision)
        self.blobs[key] = data
        return key

    def fetch(self, key: str) -> bytes:
        _check_key(key)
        if key not in self.blobs:
            raise DocumentNotFound(key)
        return self.blobs[key]


class FilesystemDocumentStorage:
    """Dev default. {root}/{code}/r{revision}.html; root = MK1_DOCUMENTS_DIR."""

    def __init__(self, root: Optional[str] = None) -> None:
        self.root = Path(root or os.environ.get("MK1_DOCUMENTS_DIR", "/data/documents"))
        self.root.mkdir(parents=True, exist_ok=True)

    def save(self, code: str, revision: int, data: bytes) -> str:
        if not data:
            raise DocumentStorageError("save: empty content")
        key = _rel_key(code, revision)
        path = self._safe(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return key

    def fetch(self, key: str) -> bytes:
        path = self._safe(key)
        if not path.exists():
            raise DocumentNotFound(key)
        return path.read_bytes()

    def _safe(self, key: str) -> Path:
        _check_key(key)
        resolved = (self.root / key).resolve()
        try:
            resolved.relative_to(self.root.resolve())
        except ValueError as e:
            raise DocumentStorageError(f"key escapes root: {key!r}") from e
        return resolved


class S3DocumentStorage:
    """Prod. Objects at {MK1_DOCUMENTS_S3_PREFIX}{code}/{uuid}.bin in the vial-photo
    bucket (S3PhotoStorage maps unknown extensions to .bin; the DB row carries the
    real content type, so the object name never matters)."""

    def __init__(self) -> None:
        from sub_samples.photo_storage import S3PhotoStorage
        self._s3 = S3PhotoStorage(
            prefix=os.environ.get("MK1_DOCUMENTS_S3_PREFIX", "documents/"))

    def save(self, code: str, revision: int, data: bytes) -> str:
        if not data:
            raise DocumentStorageError("save: empty content")
        return self._s3.save_photo(code, data, f"r{revision}.html")

    def fetch(self, key: str) -> bytes:
        from sub_samples.photo_storage import PhotoNotFoundError
        _check_key(key)
        try:
            return self._s3.fetch_photo(key)
        except PhotoNotFoundError as e:
            raise DocumentNotFound(str(e)) from e


_storage: Optional[DocumentStorage] = None


def get_storage() -> DocumentStorage:
    """Lazy singleton: S3 when MK1_PHOTO_S3_BUCKET is set (same switch as vial
    photos), else filesystem. Lazy so importing the package never mkdirs."""
    global _storage
    if _storage is None:
        if os.environ.get("MK1_PHOTO_S3_BUCKET"):
            _storage = S3DocumentStorage()
        else:
            _storage = FilesystemDocumentStorage()
    return _storage


def set_storage_for_tests(storage: DocumentStorage) -> None:
    global _storage
    _storage = storage
```

- [ ] **Step 5: Register the models in `init_db`**

In `backend/database.py`, directly under the line `import flags.models  # noqa: F401  (register flag_* tables on Base)` add:

```python
    import documents.models  # noqa: F401  (register documents tables on Base)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run the same pytest command as Step 2. Expected: `5 passed`.

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/mk1-documents
git add -- backend/documents/__init__.py backend/documents/models.py backend/documents/storage.py backend/database.py backend/tests/test_documents_models.py
git commit -m "feat(documents): models, blob storage, table registration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/__init__.py backend/documents/models.py backend/documents/storage.py backend/database.py backend/tests/test_documents_models.py
```

---
### Task 2: Service — categories, seed, and code minting

**Files:**
- Create: `backend/documents/errors.py`
- Create: `backend/documents/service.py` (first half; Task 3 appends the document functions)
- Modify: `backend/database.py` (`init_db`, after `create_all`) — seed call
- Test: `backend/tests/test_documents_service.py`

**Interfaces:**
- Consumes: Task 1 models and storage.
- Produces (all take `db: Session` first):
  - `seed_categories(db) -> None`
  - `list_categories(db, active_only: bool = False) -> list[tuple[DocumentCategory, int]]` (category, distinct document codes using it)
  - `get_category(db, category_id: int) -> DocumentCategory` (raises `NotFoundError`)
  - `create_category(db, *, name: str, code_prefix: str, description: str | None = None, sort_order: int = 0) -> DocumentCategory`
  - `update_category(db, category_id: int, **fields) -> DocumentCategory` (fields ⊆ name, description, sort_order, active)
  - `delete_category(db, category_id: int) -> None` (raises `ConflictError` when referenced)
  - `resolve_category(db, *, category: str | None = None, category_id: int | None = None) -> DocumentCategory`
  - `mint_code(db, prefix: str) -> str`
  - Exceptions in `documents.errors`: `NotFoundError(LookupError)`, `BadRequestError(ValueError)`, `ConflictError(Exception)`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_documents_service.py`:

```python
"""Documents library service rules (spec §3.1, §3.3, §5.2, §5.4)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import documents.models  # noqa: F401
    from documents import service, storage
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    service.seed_categories(session)
    yield session
    session.close()


def _prefixes(db):
    from documents import service
    return [(c.name, c.code_prefix, n) for c, n in service.list_categories(db)]


def test_seed_is_idempotent(db):
    from documents import service
    service.seed_categories(db)
    service.seed_categories(db)
    assert _prefixes(db) == [("Artifact", "ART", 0), ("SOP", "SOP", 0)]


def test_create_category_normalizes_prefix(db):
    from documents import service
    cat = service.create_category(db, name=" Validation ", code_prefix="val")
    assert (cat.name, cat.code_prefix, cat.active) == ("Validation", "VAL", True)


@pytest.mark.parametrize("prefix", ["", "a", "TOO-LONG-PREFIX", "ab c", "A/B"])
def test_create_category_rejects_bad_prefix(db, prefix):
    from documents import service
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_category(db, name="X", code_prefix=prefix)


def test_create_category_rejects_duplicates(db):
    from documents import service
    from documents.errors import ConflictError
    with pytest.raises(ConflictError):
        service.create_category(db, name="Artifact", code_prefix="XYZ")
    with pytest.raises(ConflictError):
        service.create_category(db, name="Other", code_prefix="art")


def test_update_category_fields_and_name_conflict(db):
    from documents import service
    from documents.errors import ConflictError
    cat = service.create_category(db, name="Temp", code_prefix="TMP")
    cat = service.update_category(db, cat.id, name="Temp2", description="d",
                                  sort_order=9, active=False)
    assert (cat.name, cat.description, cat.sort_order, cat.active) == ("Temp2", "d", 9, False)
    with pytest.raises(ConflictError):
        service.update_category(db, cat.id, name="SOP")


def test_delete_unused_category(db):
    from documents import service
    from documents.errors import NotFoundError
    cat = service.create_category(db, name="Temp", code_prefix="TMP")
    service.delete_category(db, cat.id)
    with pytest.raises(NotFoundError):
        service.get_category(db, cat.id)


def test_resolve_category_by_prefix_name_or_id(db):
    from documents import service
    from documents.errors import BadRequestError, NotFoundError
    art = service.resolve_category(db, category="art")
    assert art.code_prefix == "ART"
    assert service.resolve_category(db, category="SOP").name == "SOP"
    assert service.resolve_category(db, category_id=art.id).id == art.id
    with pytest.raises(NotFoundError):
        service.resolve_category(db, category="nope")
    with pytest.raises(BadRequestError):
        service.resolve_category(db)
    service.update_category(db, art.id, active=False)
    with pytest.raises(BadRequestError):
        service.resolve_category(db, category="ART")


def test_mint_code_sequences_per_prefix(db):
    from documents import service
    assert service.mint_code(db, "ART") == "ART-0001"
    assert service.mint_code(db, "ART") == "ART-0002"
    assert service.mint_code(db, "SOP") == "SOP-0001"


def test_mint_code_skips_numbers_already_taken(db):
    from documents import service
    from documents.models import Document
    art = service.resolve_category(db, category="ART")
    db.add(Document(code="ART-0001", revision=1, title="supplied", category_id=art.id,
                    status="draft", storage_key="ART-0001/r1.html", size_bytes=1,
                    content_sha256="0" * 64))
    db.commit()
    assert service.mint_code(db, "ART") == "ART-0002"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/test_documents_service.py
```

Expected: errors with `ImportError: cannot import name 'service' from 'documents'`.

- [ ] **Step 3: Create the errors module**

`backend/documents/errors.py`:

```python
"""Typed service exceptions; routes map them to HTTP codes (404/400/409)."""


class NotFoundError(LookupError):
    """Document or category not found."""


class BadRequestError(ValueError):
    """Structurally OK but semantically invalid input."""


class ConflictError(Exception):
    """Illegal state transition, duplicate, or referenced row."""
```

- [ ] **Step 4: Create the service (categories + minting)**

`backend/documents/service.py`:

```python
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
            DocumentCategory.code_prefix == prefix))).scalar_one_or_none()
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
```

- [ ] **Step 5: Seed at boot**

In `backend/database.py` `init_db()`, directly after the line `Base.metadata.create_all(bind=engine)` add:

```python
    # Documents library: seed the Artifact/SOP categories (spec 2026-09-15 §3.1).
    try:
        from documents.service import seed_categories
        with SessionLocal() as _s:
            seed_categories(_s)
    except Exception as e:  # never block startup
        log.warning("documents_category_seed_skipped err=%s", e)
```

- [ ] **Step 6: Run the tests to verify they pass**

Same command as Step 2. Expected: `13 passed` (the parametrized test counts as 5).

- [ ] **Step 7: Commit**

```bash
git add -- backend/documents/errors.py backend/documents/service.py backend/database.py backend/tests/test_documents_service.py
git commit -m "feat(documents): categories service, boot seed, code minting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/errors.py backend/documents/service.py backend/database.py backend/tests/test_documents_service.py
```

---

### Task 3: Service — create, revise, dedupe, activate, retire, patch, list

**Files:**
- Modify: `backend/documents/service.py` (append)
- Test: `backend/tests/test_documents_service.py` (append)

**Interfaces:**
- Produces:
  - `validate_html(html: str | bytes) -> bytes`
  - `create_document(db, *, title: str, html: str | bytes, category: DocumentCategory | None, description=None, code=None, author=None, source_session=None, effective_date: date | None = None, activate: bool = True, user_id: int | None = None) -> tuple[Document, bool]` — `(row, created)`; `created=False` on the identical-bytes dedupe path.
  - `activate_document(db, doc_id) -> Document`, `retire_document(db, doc_id) -> Document`
  - `patch_document(db, doc_id, **fields) -> Document` (fields ⊆ title, description, category_id, effective_date)
  - `list_documents(db, *, q=None, category_id=None, statuses=("draft","active"), sort="updated_at", page=1, page_size=50) -> tuple[list[tuple[Document, int]], int]` — `(rows with revision_count, total)`
  - `get_document(db, doc_id) -> Document`, `get_revisions(db, code) -> list[Document]`, `revision_count(db, code) -> int`
  - `read_content(doc: Document) -> bytes`

- [ ] **Step 1: Append the failing tests**

Append to `backend/tests/test_documents_service.py`:

```python
# --- documents -------------------------------------------------------------------

HTML = "<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>"


def _art(db):
    from documents import service
    return service.resolve_category(db, category="ART")


def test_create_mints_code_and_activates_by_default(db):
    from datetime import date
    from documents import service, storage
    doc, created = service.create_document(db, title=" Audit ", html=HTML, category=_art(db),
                                           author="Claude Code", source_session="sess-1")
    assert created is True
    assert (doc.code, doc.revision, doc.status, doc.title) == ("ART-0001", 1, "active", "Audit")
    assert doc.effective_date == date.today()
    assert doc.activated_at is not None and doc.supersedes_id is None
    assert doc.size_bytes == len(HTML.encode()) and len(doc.content_sha256) == 64
    assert storage.get_storage().fetch(doc.storage_key) == HTML.encode()
    assert service.read_content(doc) == HTML.encode()


def test_create_draft_when_activate_false(db):
    from documents import service
    doc, _ = service.create_document(db, title="d", html=HTML, category=_art(db), activate=False)
    assert doc.status == "draft" and doc.effective_date is None and doc.activated_at is None


def test_create_with_supplied_code_checks_prefix(db):
    from documents import service
    from documents.errors import BadRequestError
    doc, _ = service.create_document(db, title="s", html=HTML, category=_art(db), code="art-0100")
    assert doc.code == "ART-0100"
    with pytest.raises(BadRequestError):
        service.create_document(db, title="s", html=HTML, category=_art(db), code="SOP-0001")
    with pytest.raises(BadRequestError):
        service.create_document(db, title="s", html=HTML, category=_art(db), code="bad code")


@pytest.mark.parametrize("html", ["", "   ", "not html", "{}", "x" * 10])
def test_create_rejects_non_html(db, html):
    from documents import service
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_document(db, title="s", html=html, category=_art(db))


def test_create_rejects_oversize(db):
    from documents import service
    from documents.errors import BadRequestError
    big = "<html>" + ("x" * (service.MAX_BYTES + 1)) + "</html>"
    with pytest.raises(BadRequestError):
        service.create_document(db, title="s", html=big, category=_art(db))


def test_create_requires_title_and_category(db):
    from documents import service
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_document(db, title="  ", html=HTML, category=_art(db))
    with pytest.raises(BadRequestError):
        service.create_document(db, title="t", html=HTML, category=None)


def test_repush_same_code_new_bytes_is_next_revision_and_retires_previous(db):
    from documents import service
    r1, _ = service.create_document(db, title="v1", html=HTML, category=_art(db))
    r2, created = service.create_document(db, title="v2", html=HTML.replace("hi", "hello"),
                                          category=None, code=r1.code)
    assert created is True
    assert (r2.code, r2.revision, r2.status, r2.supersedes_id) == (r1.code, 2, "active", r1.id)
    assert r2.category_id == r1.category_id  # inherited when category is None
    db.refresh(r1)
    assert r1.status == "retired" and r1.retired_at is not None
    assert service.revision_count(db, r1.code) == 2
    assert [d.revision for d in service.get_revisions(db, r1.code)] == [1, 2]


def test_repush_identical_bytes_is_a_metadata_patch_not_a_revision(db):
    from documents import service
    r1, _ = service.create_document(db, title="v1", html=HTML, category=_art(db))
    same, created = service.create_document(db, title="renamed", html=HTML, category=None,
                                            code=r1.code, description="desc")
    assert created is False and same.id == r1.id and same.revision == 1
    assert (same.title, same.description) == ("renamed", "desc")
    assert service.revision_count(db, r1.code) == 1


def test_activate_and_retire_lockstep(db):
    from documents import service
    from documents.errors import ConflictError
    r1, _ = service.create_document(db, title="v1", html=HTML, category=_art(db))
    r2, _ = service.create_document(db, title="v2", html=HTML + "<!--2-->", category=None,
                                    code=r1.code, activate=False)
    assert r2.status == "draft"
    db.refresh(r1)
    assert r1.status == "active"  # a draft revision does not disturb the active one
    with pytest.raises(ConflictError):
        service.activate_document(db, r1.id)  # active -> activate: not a draft
    r2 = service.activate_document(db, r2.id)
    db.refresh(r1)
    assert (r1.status, r2.status) == ("retired", "active")
    with pytest.raises(ConflictError):
        service.retire_document(db, r1.id)  # already retired
    r2 = service.retire_document(db, r2.id)
    assert r2.status == "retired" and r2.retired_at is not None


def test_patch_metadata_only(db):
    from datetime import date
    from documents import service
    from documents.errors import BadRequestError, NotFoundError
    doc, _ = service.create_document(db, title="v1", html=HTML, category=_art(db))
    sop = service.resolve_category(db, category="SOP")
    doc = service.patch_document(db, doc.id, title="new", description=None,
                                 category_id=sop.id, effective_date=date(2026, 1, 2))
    assert (doc.title, doc.description, doc.category_id, doc.effective_date) == \
        ("new", None, sop.id, date(2026, 1, 2))
    assert doc.revision == 1
    with pytest.raises(BadRequestError):
        service.patch_document(db, doc.id, title="   ")
    with pytest.raises(BadRequestError):
        service.patch_document(db, doc.id, status="retired")
    with pytest.raises(NotFoundError):
        service.patch_document(db, doc.id, category_id=9999)
    with pytest.raises(NotFoundError):
        service.patch_document(db, 9999, title="x")


def test_delete_category_refused_when_referenced(db):
    from documents import service
    from documents.errors import ConflictError
    cat = service.create_category(db, name="Temp", code_prefix="TMP")
    service.create_document(db, title="t", html=HTML, category=cat)
    with pytest.raises(ConflictError):
        service.delete_category(db, cat.id)


def test_list_latest_revision_per_code_with_filters(db):
    from documents import service
    art, sop = _art(db), service.resolve_category(db, category="SOP")
    a, _ = service.create_document(db, title="Alpha audit", html=HTML, category=art,
                                   description="first")
    service.create_document(db, title="Alpha audit v2", html=HTML + "<!--2-->", category=None,
                            code=a.code)
    b, _ = service.create_document(db, title="Bravo SOP", html=HTML, category=sop, activate=False)
    c, _ = service.create_document(db, title="Charlie", html=HTML, category=art)
    service.retire_document(db, c.id)

    rows, total = service.list_documents(db)
    assert total == 2
    assert [(d.code, d.revision, n) for d, n in rows] == [(b.code, 1, 1), (a.code, 2, 2)] or \
           [(d.code, d.revision, n) for d, n in rows] == [(a.code, 2, 2), (b.code, 1, 1)]

    rows, total = service.list_documents(db, statuses=("retired",))
    assert total == 1 and rows[0][0].code == c.code

    rows, total = service.list_documents(db, category_id=sop.id)
    assert total == 1 and rows[0][0].code == b.code

    rows, total = service.list_documents(db, q="bravo")
    assert total == 1 and rows[0][0].code == b.code
    rows, total = service.list_documents(db, q=a.code.lower())
    assert total == 1 and rows[0][0].code == a.code

    rows, total = service.list_documents(db, sort="title", statuses=STATUSES_ALL)
    assert [d.title for d, _ in rows] == ["Alpha audit v2", "Bravo SOP", "Charlie"]

    rows, total = service.list_documents(db, statuses=STATUSES_ALL, page=2, page_size=2)
    assert total == 3 and len(rows) == 1


STATUSES_ALL = ("draft", "active", "retired")


def test_get_document_not_found(db):
    from documents import service
    from documents.errors import NotFoundError
    with pytest.raises(NotFoundError):
        service.get_document(db, 12345)
```

- [ ] **Step 2: Run the tests to verify they fail**

Same command as Task 2 Step 2. Expected: the new tests error with `AttributeError: module 'documents.service' has no attribute 'create_document'` (and siblings); the Task 2 tests still pass.

- [ ] **Step 3: Append the document functions to the service**

Append to `backend/documents/service.py`:

```python
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


def _latest(db: Session, code: str) -> Optional[Document]:
    return db.execute(select(Document).where(Document.code == code)
                      .order_by(Document.revision.desc()).limit(1)).scalars().first()


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
        doc.effective_date = now.date()
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
        latest = _latest(db, code)

    if latest is not None:
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
                   supersedes_id=supersedes_id, author=author, source_session=source_session,
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


def patch_document(db: Session, doc_id: int, **fields) -> Document:
    """Metadata only (§5.1 PATCH). Never bumps revision, never touches content."""
    doc = get_document(db, doc_id)
    allowed = {"title", "description", "category_id", "effective_date"}
    unknown = set(fields) - allowed
    if unknown:
        raise BadRequestError(f"cannot patch {sorted(unknown)}")
    if "title" in fields:
        title = (fields["title"] or "").strip()
        if not title:
            raise BadRequestError("title is required")
        doc.title = title
    if "description" in fields:
        doc.description = fields["description"]
    if "category_id" in fields and fields["category_id"] is not None:
        doc.category_id = get_category(db, int(fields["category_id"])).id
    if "effective_date" in fields:
        doc.effective_date = fields["effective_date"]
    db.commit()
    db.refresh(doc)
    return doc


def list_documents(db: Session, *, q: Optional[str] = None, category_id: Optional[int] = None,
                   statuses=("draft", "active"), sort: str = "updated_at",
                   page: int = 1, page_size: int = 50) -> tuple[list[tuple[Document, int]], int]:
    """Latest revision per code, then filtered. Returns ([(doc, revision_count)], total)."""
    if sort not in SORTS:
        raise BadRequestError(f"sort must be one of {SORTS}")
    bad = set(statuses or ()) - set(STATUSES)
    if bad:
        raise BadRequestError(f"unknown status {sorted(bad)}")
    page = max(1, int(page))
    page_size = max(1, min(200, int(page_size)))

    latest = (select(Document.code.label("code"),
                     func.max(Document.revision).label("rev"),
                     func.count(Document.id).label("n"))
              .group_by(Document.code).subquery())
    stmt = (select(Document, latest.c.n)
            .join(latest, and_(Document.code == latest.c.code,
                               Document.revision == latest.c.rev)))
    if statuses:
        stmt = stmt.where(Document.status.in_(tuple(statuses)))
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Same command. Expected: `30 passed`.

- [ ] **Step 5: Commit**

```bash
git add -- backend/documents/service.py backend/tests/test_documents_service.py
git commit -m "feat(documents): create/revise/dedupe, activate-retire lockstep, patch, list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/service.py backend/tests/test_documents_service.py
```

---
### Task 4: Schemas, writer dependency, routes, and mounting

**Files:**
- Create: `backend/documents/schemas.py`
- Create: `backend/documents/routes.py`
- Modify: `backend/main.py:113-125` (imports) and `:575-588` (`include_router`)
- Test: `backend/tests/test_documents_routes.py`

**Interfaces:**
- Consumes: Task 2–3 service functions; `auth.get_current_user`, `auth.require_admin`, `auth.require_internal_service_token`, `database.get_db`.
- Produces: `documents.routes.router` (`APIRouter(prefix="/api", tags=["documents"])`), `documents.routes.require_document_writer` (FastAPI dependency; returns the admin `User` or `None` for service-token callers), and the wire shapes the frontend (Task 6) types against:
  - `CategoryOut {id, name, code_prefix, description, sort_order, active, document_count, created_at, updated_at}`
  - `DocumentOut {id, code, revision, title, description, category_id, category_name, category_prefix, status, effective_date, activated_at, retired_at, supersedes_id, author, source_session, created_by_user_id, content_type, size_bytes, content_sha256, created_at, updated_at, revision_count}`
  - `DocumentDetail = DocumentOut + revisions: list[DocumentOut]`
  - `DocumentListOut {items, total, page, page_size}`
  - Routes exactly as spec §5.1–5.2.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_documents_routes.py`:

```python
"""Documents library HTTP surface (spec §5, §9)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = "<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>"
SVC = {"X-Service-Token": "test-token"}
SVC_ENV = {"ACCUMK1_INTERNAL_SERVICE_TOKEN": "test-token"}


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import documents.models  # noqa: F401
    from documents import service, storage
    from documents.routes import require_document_writer

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    service.seed_categories(shared)
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())

    def _db():
        yield shared

    keys = (get_db, get_current_user, require_document_writer)
    saved = {k: app.dependency_overrides.get(k) for k in keys}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    tc.db = shared
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    shared.close()


def _as_admin(client):
    from main import app
    from documents.routes import require_document_writer
    app.dependency_overrides[require_document_writer] = lambda: SimpleNamespace(
        id=1, role="admin", email="admin@x.t")


def _publish(client, headers=None, **over):
    body = {"title": "Audit", "html": HTML, "category": "ART", "author": "Claude Code",
            "source_session": "sess-1"}
    body.update(over)
    return client.post("/api/documents", json=body, headers=headers or {})


# --- auth matrix ----------------------------------------------------------------------

def test_reads_require_login(client):
    from main import app
    from auth import get_current_user
    saved = app.dependency_overrides.pop(get_current_user)
    try:
        assert client.get("/api/documents").status_code == 401
        assert client.get("/api/document-categories").status_code == 401
    finally:
        app.dependency_overrides[get_current_user] = saved


def test_standard_user_cannot_write(client):
    assert _publish(client).status_code == 401  # no admin bearer, no service token
    assert client.post("/api/document-categories",
                       json={"name": "X", "code_prefix": "XX"}).status_code == 401


def test_service_token_can_publish(client):
    with patch.dict(os.environ, SVC_ENV):
        assert _publish(client, headers=SVC, category="nope").status_code == 404
        bad = client.post("/api/documents", json={"title": "A", "html": HTML, "category": "ART"},
                          headers={"X-Service-Token": "wrong"})
        assert bad.status_code == 401
        r = client.post("/api/documents", json={"title": "A", "html": HTML, "category": "ART"},
                        headers=SVC)
    assert r.status_code == 201, r.text
    assert r.json()["created_by_user_id"] is None


def test_writer_dependency_unit_matrix(client):
    """The real dependency, called directly (no HTTP): service token, missing
    token, standard bearer (403), admin bearer."""
    from fastapi import HTTPException
    from auth import create_access_token
    from documents.routes import require_document_writer
    from models import User
    db = client.db
    std = User(email="std@x.t", hashed_password="x", role="standard")
    adm = User(email="adm@x.t", hashed_password="x", role="admin")
    db.add_all([std, adm])
    db.commit()
    with patch.dict(os.environ, SVC_ENV):
        assert require_document_writer(x_service_token="test-token", token=None, db=db) is None
        with pytest.raises(HTTPException) as e:
            require_document_writer(x_service_token="wrong", token=None, db=db)
        assert e.value.status_code == 401
    with pytest.raises(HTTPException) as e:
        require_document_writer(x_service_token=None, token=None, db=db)
    assert e.value.status_code == 401
    with pytest.raises(HTTPException) as e:
        require_document_writer(x_service_token=None,
                                token=create_access_token({"sub": str(std.id)}), db=db)
    assert e.value.status_code == 403
    who = require_document_writer(x_service_token=None,
                                  token=create_access_token({"sub": str(adm.id)}), db=db)
    assert who.id == adm.id


# --- documents ---------------------------------------------------------------------------

def test_publish_read_content_and_list(client):
    _as_admin(client)
    r = _publish(client, description="short desc")
    assert r.status_code == 201, r.text
    d = r.json()
    assert (d["code"], d["revision"], d["status"], d["category_prefix"], d["revision_count"]) == \
        ("ART-0001", 1, "active", "ART", 1)
    assert d["created_by_user_id"] == 1

    c = client.get(f"/api/documents/{d['id']}/content")
    assert c.status_code == 200
    assert c.headers["content-type"].startswith("text/html")
    assert c.headers["content-security-policy"] == "sandbox allow-scripts"
    assert c.headers["x-content-type-options"] == "nosniff"
    assert 'filename="ART-0001-r1.html"' in c.headers["content-disposition"]
    assert c.text == HTML

    lst = client.get("/api/documents").json()
    assert lst["total"] == 1 and lst["items"][0]["id"] == d["id"]
    assert client.get("/api/documents?q=zzz").json()["total"] == 0
    assert client.get("/api/documents?status=retired").json()["total"] == 0
    assert client.get("/api/documents?status=bogus").status_code == 400
    assert client.get("/api/documents?sort=bogus").status_code == 400

    detail = client.get(f"/api/documents/{d['id']}").json()
    assert [r_["revision"] for r_ in detail["revisions"]] == [1]
    assert client.get("/api/documents/9999").status_code == 404


def test_republish_same_code_dedupes_then_revises(client):
    _as_admin(client)
    d1 = _publish(client).json()
    same = _publish(client, code=d1["code"], title="renamed")
    assert same.status_code == 200 and same.json()["id"] == d1["id"]
    assert same.json()["title"] == "renamed"
    d2 = _publish(client, code=d1["code"], html=HTML + "<!--2-->", category=None)
    assert d2.status_code == 201 and d2.json()["revision"] == 2
    assert client.get(f"/api/documents/{d1['id']}").json()["status"] == "retired"


def test_lifecycle_and_patch_routes(client):
    _as_admin(client)
    d = _publish(client, activate=False).json()
    assert d["status"] == "draft"
    assert client.post(f"/api/documents/{d['id']}/retire").status_code == 409
    a = client.post(f"/api/documents/{d['id']}/activate")
    assert a.status_code == 200 and a.json()["status"] == "active"
    assert client.post(f"/api/documents/{d['id']}/activate").status_code == 409
    p = client.patch(f"/api/documents/{d['id']}",
                     json={"title": "New title", "effective_date": "2026-01-02"})
    assert p.status_code == 200 and p.json()["title"] == "New title"
    assert p.json()["effective_date"] == "2026-01-02"
    assert client.patch(f"/api/documents/{d['id']}", json={"title": " "}).status_code == 400
    r = client.post(f"/api/documents/{d['id']}/retire")
    assert r.status_code == 200 and r.json()["status"] == "retired"


def test_publish_validation(client):
    _as_admin(client)
    assert _publish(client, html="not html").status_code == 400
    assert _publish(client, title="").status_code == 400
    assert _publish(client, category=None).status_code == 400
    assert _publish(client, code="SOP-0001").status_code == 400  # prefix mismatch


# --- categories --------------------------------------------------------------------------

def test_categories_crud_and_delete_guard(client):
    _as_admin(client)
    cats = client.get("/api/document-categories").json()
    assert [c["code_prefix"] for c in cats] == ["ART", "SOP"]
    c = client.post("/api/document-categories",
                    json={"name": "Validation", "code_prefix": "val", "description": "d"})
    assert c.status_code == 201 and c.json()["code_prefix"] == "VAL"
    cid = c.json()["id"]
    assert client.post("/api/document-categories",
                       json={"name": "Validation", "code_prefix": "VX"}).status_code == 409
    u = client.put(f"/api/document-categories/{cid}", json={"active": False, "sort_order": 5})
    assert u.status_code == 200 and u.json()["active"] is False
    assert client.get("/api/document-categories?active_only=true").json()[-1]["code_prefix"] == "SOP"
    assert client.delete(f"/api/document-categories/{cid}").status_code == 204
    art = cats[0]["id"]
    _publish(client)
    assert client.delete(f"/api/document-categories/{art}").status_code == 409
    assert client.get("/api/document-categories").json()[0]["document_count"] == 1
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/test_documents_routes.py
```

Expected: errors with `ModuleNotFoundError: No module named 'documents.routes'`.

- [ ] **Step 3: Create the schemas**

`backend/documents/schemas.py`:

```python
"""Pydantic v2 wire models for the documents API (spec §5)."""
from __future__ import annotations

from datetime import date, datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class CategoryOut(BaseModel):
    id: int
    name: str
    code_prefix: str
    description: Optional[str] = None
    sort_order: int
    active: bool
    document_count: int = 0
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class CategoryCreate(BaseModel):
    name: str
    code_prefix: str
    description: Optional[str] = None
    sort_order: int = 0


class CategoryUpdate(BaseModel):
    """All-optional partial edit. No code_prefix — immutable once created."""
    name: Optional[str] = None
    description: Optional[str] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None


class DocumentOut(BaseModel):
    id: int
    code: str
    revision: int
    title: str
    description: Optional[str] = None
    category_id: int
    category_name: str
    category_prefix: str
    status: str
    effective_date: Optional[date] = None
    activated_at: Optional[datetime] = None
    retired_at: Optional[datetime] = None
    supersedes_id: Optional[int] = None
    author: Optional[str] = None
    source_session: Optional[str] = None
    created_by_user_id: Optional[int] = None
    content_type: str
    size_bytes: int
    content_sha256: str
    created_at: datetime
    updated_at: datetime
    revision_count: int = 1


class DocumentDetail(DocumentOut):
    revisions: List[DocumentOut] = Field(default_factory=list)


class DocumentListOut(BaseModel):
    items: List[DocumentOut]
    total: int
    page: int
    page_size: int


class DocumentCreate(BaseModel):
    title: str
    html: str
    category: Optional[str] = None       # code prefix or name
    category_id: Optional[int] = None
    description: Optional[str] = None
    code: Optional[str] = None           # existing code => next revision
    author: Optional[str] = None
    source_session: Optional[str] = None
    effective_date: Optional[date] = None
    activate: bool = True


class DocumentPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    category_id: Optional[int] = None
    effective_date: Optional[date] = None
```

- [ ] **Step 4: Create the routes**

`backend/documents/routes.py`:

```python
"""FastAPI router for the documents library. Thin shell over documents.service."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin, require_internal_service_token
from database import get_db
from documents import service
from documents.errors import BadRequestError, ConflictError, NotFoundError
from documents.models import Document, DocumentCategory
from documents.schemas import (CategoryCreate, CategoryOut, CategoryUpdate, DocumentCreate,
                               DocumentDetail, DocumentListOut, DocumentOut, DocumentPatch)
from documents.storage import DocumentNotFound

router = APIRouter(prefix="/api", tags=["documents"])
logger = logging.getLogger(__name__)

_optional_bearer = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)


def require_document_writer(
    x_service_token: Optional[str] = Header(None),
    token: Optional[str] = Depends(_optional_bearer),
    db: Session = Depends(get_db),
):
    """Writers are an admin login OR the internal service token (spec §5, §9).
    A present X-Service-Token is authoritative: a wrong one is 401 even if a
    bearer is also sent. Returns the admin User, or None for service callers."""
    if x_service_token is not None:
        require_internal_service_token(x_service_token)
        return None
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")
    user = get_current_user(token=token, db=db)
    return require_admin(user)


def _http(e: Exception) -> HTTPException:
    if isinstance(e, NotFoundError) or isinstance(e, DocumentNotFound):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, ConflictError):
        return HTTPException(status_code=409, detail=str(e))
    if isinstance(e, BadRequestError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, HTTPException):
        return e
    logger.exception("unhandled documents error")
    return HTTPException(status_code=500, detail="internal error")


def _cat_out(cat: DocumentCategory, count: int) -> CategoryOut:
    out = CategoryOut.model_validate(cat)
    out.document_count = count
    return out


def _doc_out(doc: Document, revision_count: int) -> DocumentOut:
    return DocumentOut(
        id=doc.id, code=doc.code, revision=doc.revision, title=doc.title,
        description=doc.description, category_id=doc.category_id,
        category_name=doc.category.name, category_prefix=doc.category.code_prefix,
        status=doc.status, effective_date=doc.effective_date, activated_at=doc.activated_at,
        retired_at=doc.retired_at, supersedes_id=doc.supersedes_id, author=doc.author,
        source_session=doc.source_session, created_by_user_id=doc.created_by_user_id,
        content_type=doc.content_type, size_bytes=doc.size_bytes,
        content_sha256=doc.content_sha256, created_at=doc.created_at,
        updated_at=doc.updated_at, revision_count=revision_count)


# --- categories -------------------------------------------------------------------------

@router.get("/document-categories", response_model=List[CategoryOut])
def list_categories(active_only: bool = False, db: Session = Depends(get_db),
                    user=Depends(get_current_user)):
    return [_cat_out(c, n) for c, n in service.list_categories(db, active_only=active_only)]


@router.post("/document-categories", response_model=CategoryOut, status_code=201)
def create_category(req: CategoryCreate, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        cat = service.create_category(db, name=req.name, code_prefix=req.code_prefix,
                                      description=req.description, sort_order=req.sort_order)
    except Exception as e:
        raise _http(e)
    return _cat_out(cat, 0)


@router.put("/document-categories/{category_id}", response_model=CategoryOut)
def update_category(category_id: int, req: CategoryUpdate, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        cat = service.update_category(db, category_id, **req.model_dump(exclude_unset=True))
        count = dict((c.id, n) for c, n in service.list_categories(db)).get(cat.id, 0)
    except Exception as e:
        raise _http(e)
    return _cat_out(cat, count)


@router.delete("/document-categories/{category_id}", status_code=204)
def delete_category(category_id: int, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        service.delete_category(db, category_id)
    except Exception as e:
        raise _http(e)
    return Response(status_code=204)


# --- documents ----------------------------------------------------------------------------

@router.get("/documents", response_model=DocumentListOut)
def list_documents(q: Optional[str] = None, category_id: Optional[int] = None,
                   statuses: List[str] = Query(default=["draft", "active"], alias="status"),
                   sort: str = "updated_at", page: int = 1, page_size: int = 50,
                   db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        rows, total = service.list_documents(db, q=q, category_id=category_id,
                                             statuses=tuple(statuses), sort=sort,
                                             page=page, page_size=page_size)
    except Exception as e:
        raise _http(e)
    return DocumentListOut(items=[_doc_out(d, n) for d, n in rows], total=total,
                           page=max(1, page), page_size=max(1, min(200, page_size)))


@router.get("/documents/{doc_id}", response_model=DocumentDetail)
def get_document(doc_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        doc = service.get_document(db, doc_id)
        revisions = service.get_revisions(db, doc.code)
    except Exception as e:
        raise _http(e)
    n = len(revisions)
    out = _doc_out(doc, n)
    return DocumentDetail(**out.model_dump(), revisions=[_doc_out(r, n) for r in revisions])


@router.get("/documents/{doc_id}/content")
def get_document_content(doc_id: int, db: Session = Depends(get_db),
                         user=Depends(get_current_user)):
    try:
        doc = service.get_document(db, doc_id)
        data = service.read_content(doc)
    except Exception as e:
        raise _http(e)
    return Response(content=data, headers={
        "Content-Type": doc.content_type,
        "Content-Disposition": f'inline; filename="{doc.code}-r{doc.revision}.html"',
        "Content-Security-Policy": "sandbox allow-scripts",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=0",
    })


@router.post("/documents", response_model=DocumentOut, status_code=201)
def create_document(req: DocumentCreate, response: Response, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        cat = None
        if req.category_id is not None or req.category:
            cat = service.resolve_category(db, category=req.category,
                                           category_id=req.category_id)
        doc, created = service.create_document(
            db, title=req.title, html=req.html, category=cat, description=req.description,
            code=req.code, author=req.author, source_session=req.source_session,
            effective_date=req.effective_date, activate=req.activate,
            user_id=getattr(writer, "id", None))
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    if not created:
        response.status_code = 200
    return _doc_out(doc, n)


@router.patch("/documents/{doc_id}", response_model=DocumentOut)
def patch_document(doc_id: int, req: DocumentPatch, db: Session = Depends(get_db),
                   writer=Depends(require_document_writer)):
    try:
        doc = service.patch_document(db, doc_id, **req.model_dump(exclude_unset=True))
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    return _doc_out(doc, n)


@router.post("/documents/{doc_id}/activate", response_model=DocumentOut)
def activate_document(doc_id: int, db: Session = Depends(get_db),
                      writer=Depends(require_document_writer)):
    try:
        doc = service.activate_document(db, doc_id)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    return _doc_out(doc, n)


@router.post("/documents/{doc_id}/retire", response_model=DocumentOut)
def retire_document(doc_id: int, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        doc = service.retire_document(db, doc_id)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    return _doc_out(doc, n)
```

- [ ] **Step 5: Mount the router**

In `backend/main.py`, after the line `from conformance.routes import router as conformance_router` add:

```python
from documents.routes import router as documents_router
```

and after `app.include_router(conformance_router)` add:

```python
app.include_router(documents_router)
```

- [ ] **Step 6: Run the tests to verify they pass**

Same command as Step 2. Expected: `10 passed`. Then run the three documents files together plus the neighbours that share `main` import wiring, and confirm nothing new fails:

```bash
C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/test_documents_models.py tests/test_documents_service.py tests/test_documents_routes.py tests/test_flags_routes.py
```

Expected: all documents tests pass; `test_flags_routes.py` shows the same result it shows on master.

- [ ] **Step 7: Commit**

```bash
git add -- backend/documents/schemas.py backend/documents/routes.py backend/main.py backend/tests/test_documents_routes.py
git commit -m "feat(documents): API routes, writer auth (admin or service token), mount

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- backend/documents/schemas.py backend/documents/routes.py backend/main.py backend/tests/test_documents_routes.py
```

---
### Task 5: Theme stylesheet and the publish skill

**Files:**
- Create: `src/docs-theme/accumark-docs.css` (content = Appendix A, verbatim)
- Create: `.claude/skills/mk1-publish-document/SKILL.md`
- Create: `.claude/skills/mk1-publish-document/scripts/publish_document.py`

**Interfaces:**
- Consumes: `POST /api/documents` (Task 4) with `X-Service-Token`.
- Produces: the theme marker contract `/* accumark-docs v1 */` (first line of the CSS; the script and the future SOP converter both key on `/* accumark-docs v<n>`); CLI `publish_document.py FILE --title T --category ART [...]`; pure functions `wrap_fragment(html) -> str`, `inline_theme(html, css) -> str`, `find_secrets(html) -> list[str]` used by `--self-test`.

- [ ] **Step 1: Create the theme file**

Create `src/docs-theme/accumark-docs.css` with the exact contents of **Appendix A** at the end of this plan. The first line must be `/* accumark-docs v1 — ...` so the marker regex matches.

- [ ] **Step 2: Create the publish script**

`.claude/skills/mk1-publish-document/scripts/publish_document.py`:

```python
#!/usr/bin/env python3
"""Publish an HTML document to the Accu-Mk1 documents library (spec §6).

Usage:
  publish_document.py PAGE.html --title T --category ART [--description D]
      [--code ART-0012] [--author "Claude Code"] [--session ID] [--draft]
      [--effective YYYY-MM-DD] [--theme PATH] [--base-url URL]
      [--allow-secrets] [--dry-run]
  publish_document.py --self-test

Env: MK1_API_BASE_URL (e.g. http://100.73.137.3:5892), ACCUMK1_INTERNAL_SERVICE_TOKEN.
Exit: 0 ok · 1 HTTP/transport error · 2 secret-shaped content found · 3 usage/env error.
Stdlib only, on purpose: it must run from any checkout with no venv.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

THEME_MARKER_RE = re.compile(r"/\*\s*accumark-docs v\d+")
DEFAULT_THEME = Path(__file__).resolve().parents[4] / "src" / "docs-theme" / "accumark-docs.css"

# (label, pattern). Labels are printed; matched VALUES never are.
SECRET_PATTERNS = [
    ("aws access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("stripe key", re.compile(r"sk_(?:live|test)_[0-9A-Za-z]{8,}")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY")),
    ("github token", re.compile(r"ghp_[A-Za-z0-9]{36}")),
    ("slack token", re.compile(r"xox[abp]-[0-9A-Za-z-]{10,}")),
    ("bearer token", re.compile(r"Bearer [A-Za-z0-9._-]{20,}")),
    ("password assignment", re.compile(r"password\s*[:=]\s*\S+", re.IGNORECASE)),
]


def find_secrets(html: str) -> list[str]:
    return [label for label, rx in SECRET_PATTERNS if rx.search(html)]


def wrap_fragment(html: str) -> str:
    """Artifact-style fragments (no <html>) become a full document. A <title>
    in the fragment is hoisted into <head>; everything else stays in <body>."""
    if re.search(r"<html\b", html, re.IGNORECASE):
        return html
    title = ""
    m = re.search(r"<title>.*?</title>", html, re.IGNORECASE | re.DOTALL)
    if m:
        title = m.group(0)
        html = html.replace(title, "", 1)
    return ("<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
            f"{title}\n</head>\n<body>\n{html}\n</body>\n</html>\n")


def inline_theme(html: str, css: str) -> str:
    """Prepend the theme as the FIRST <style> in <head> so the document's own
    styles (later in source order) win. No-op when a marker is already present."""
    if THEME_MARKER_RE.search(html):
        return html
    block = f"<style>\n{css}\n</style>\n"
    m = re.search(r"<head\b[^>]*>", html, re.IGNORECASE)
    if m:
        i = m.end()
        return html[:i] + "\n" + block + html[i:]
    m = re.search(r"<html\b[^>]*>", html, re.IGNORECASE)
    i = m.end() if m else 0
    return html[:i] + "\n<head>\n" + block + "</head>\n" + html[i:]


def post_document(base_url: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/documents",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Service-Token": token},
        method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def self_test() -> None:
    frag = "<title>T</title><style>.x{}</style><p>hi</p>"
    doc = wrap_fragment(frag)
    head = doc.split("</head>")[0]
    assert doc.startswith("<!doctype html>") and "<title>T</title>" in head, doc
    assert "<p>hi</p>" in doc.split("<body>")[1]
    assert wrap_fragment(doc) == doc, "full documents are left alone"
    themed = inline_theme(doc, "/* accumark-docs v1 */ body{}")
    assert themed.count("accumark-docs v1") == 1
    assert themed.index("accumark-docs v1") < themed.index("<style>.x{}"), "theme must precede page CSS"
    assert inline_theme(themed, "/* accumark-docs v1 */ body{}").count("accumark-docs v1") == 1, "inlined twice"
    assert find_secrets("key AKIAABCDEFGHIJKLMNOP here") == ["aws access key"]
    assert find_secrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123") == ["bearer token"]
    assert find_secrets(themed) == []
    print("self-test ok")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Publish an HTML document to Accu-Mk1.")
    p.add_argument("file", nargs="?", help="HTML file (full document or artifact fragment)")
    p.add_argument("--title")
    p.add_argument("--category", help="category code prefix or name, e.g. ART or SOP")
    p.add_argument("--description")
    p.add_argument("--code", help="existing code => publishes the next revision")
    p.add_argument("--author", default="Claude Code")
    p.add_argument("--session", default=os.environ.get("MK1_DOC_SESSION"),
                   help="provenance: the Claude Code session id")
    p.add_argument("--draft", action="store_true", help="publish as draft (activate=false)")
    p.add_argument("--effective", help="effective date YYYY-MM-DD")
    p.add_argument("--theme", default=str(DEFAULT_THEME))
    p.add_argument("--base-url", default=os.environ.get("MK1_API_BASE_URL"))
    p.add_argument("--allow-secrets", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="print the payload summary, do not POST")
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args(argv)

    if args.self_test:
        self_test()
        return 0
    if not args.file or not args.title or not args.category:
        p.print_usage(sys.stderr)
        print("file, --title and --category are required", file=sys.stderr)
        return 3

    src = Path(args.file)
    if not src.is_file():
        print(f"no such file: {src}", file=sys.stderr)
        return 3
    theme_path = Path(args.theme)
    if not theme_path.is_file():
        print(f"theme not found: {theme_path} (pass --theme)", file=sys.stderr)
        return 3

    html = inline_theme(wrap_fragment(src.read_text(encoding="utf-8")),
                        theme_path.read_text(encoding="utf-8"))

    found = find_secrets(html)
    if found and not args.allow_secrets:
        print("refusing to publish: secret-shaped content found (" + ", ".join(found) +
              "). Pass --allow-secrets only after a human has checked it.", file=sys.stderr)
        return 2

    payload = {
        "title": args.title, "html": html, "category": args.category,
        "description": args.description, "code": args.code, "author": args.author,
        "source_session": args.session, "effective_date": args.effective,
        "activate": not args.draft,
    }
    if args.dry_run:
        summary = {k: v for k, v in payload.items() if k != "html"}
        summary["html_bytes"] = len(html.encode("utf-8"))
        print(json.dumps(summary, indent=2))
        return 0

    token = os.environ.get("ACCUMK1_INTERNAL_SERVICE_TOKEN")
    if not args.base_url or not token:
        print("MK1_API_BASE_URL (or --base-url) and ACCUMK1_INTERNAL_SERVICE_TOKEN must be set",
              file=sys.stderr)
        return 3
    try:
        doc = post_document(args.base_url, token, payload)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        print(f"publish failed: HTTP {e.code} {body}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"publish failed: {e.reason}", file=sys.stderr)
        return 1
    print(f"{doc['code']} r{doc['revision']} id={doc['id']} status={doc['status']}"
          f"  open: #reports/documents?id={doc['id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Run the self-test to verify it passes**

```bash
cd /c/tmp/mk1-documents && python .claude/skills/mk1-publish-document/scripts/publish_document.py --self-test
```

Expected: `self-test ok`. If bare `python` hangs on this machine (known), use the backend venv interpreter from the Global Constraints. Then a dry run against the audit page to prove the theme resolves and the wrapper works:

```bash
python .claude/skills/mk1-publish-document/scripts/publish_document.py "C:/Users/forre/AppData/Local/Temp/claude/C--Users-forre-OneDrive-Documents-GitHub-Accumark-Workspace/d06d233c-0b47-40cf-a036-db2773c31e8c/scratchpad/acoa-profile-audit.html" --title "Additional COA Profile Audit" --category ART --dry-run
```

Expected: a JSON summary with `"activate": true` and `html_bytes` a little above the source file size (the theme is inlined). If that scratchpad file no longer exists, use any `.html` file; the dry run never contacts the server.

- [ ] **Step 4: Write the skill card**

`.claude/skills/mk1-publish-document/SKILL.md`:

```markdown
---
name: mk1-publish-document
description: Publish an HTML page (a Claude artifact, a converted SOP, any report) into the Accu-Mk1 Documents library so it is listed under Reports → Documents and viewable in the app. Use when asked to "save this to Mk1", "publish this artifact to Accumark", "add this SOP to the library", or to push a new revision of an existing document code. Read-only otherwise; never edits Mk1 code.
---

# Publish a document to Accu-Mk1

One script, stdlib only: `scripts/publish_document.py`.

## Steps

1. Build the page as usual (artifact fragment or full HTML).
2. Dry run first — proves the theme inlines and shows the payload:
   `python scripts/publish_document.py PAGE.html --title "..." --category ART --description "..." --dry-run`
3. Publish (needs `MK1_API_BASE_URL` and `ACCUMK1_INTERNAL_SERVICE_TOKEN` in the environment; both already exist on prod and the stacks — never paste the token into chat):
   `python scripts/publish_document.py PAGE.html --title "..." --category ART --description "..." --session <claude session id>`
4. Report the printed `CODE rN id=… open: #reports/documents?id=…` line to the Handler.

## Rules

- `--category` is the prefix (`ART`, `SOP`) or the category name. Categories are managed in Mk1 Settings → Documents.
- Re-publishing with `--code ART-0012` creates the **next revision** and retires the previous active one. Identical bytes are a no-op (the server answers 200 with the existing revision).
- SOPs and anything awaiting review: add `--draft`; an admin activates in Mk1, or re-run with the code and no `--draft`.
- The script refuses to publish if the page contains secret-shaped strings (exit 2). Fix the page; `--allow-secrets` is for a human who has checked it.
- The theme (`src/docs-theme/accumark-docs.css`) is inlined once; a page that already carries an `accumark-docs` marker is left as is.
- Session id: pass `--session` with the current Claude Code session id (it is the folder name inside the scratchpad path) so the library records provenance.
```

- [ ] **Step 5: Commit**

```bash
git add -- src/docs-theme/accumark-docs.css .claude/skills/mk1-publish-document/SKILL.md .claude/skills/mk1-publish-document/scripts/publish_document.py
git commit -m "feat(documents): accumark-docs theme + mk1-publish-document skill

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/docs-theme/accumark-docs.css .claude/skills/mk1-publish-document/SKILL.md .claude/skills/mk1-publish-document/scripts/publish_document.py
```

---
### Task 6: Frontend utilities and API module

**Files:**
- Create: `src/components/documents/documents-utils.ts`
- Create: `src/lib/api-documents.ts`
- Test: `src/lib/__tests__/documents-utils.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `getBearerHeaders`, `API_BASE_URL` from `@/lib/api`; the wire shapes from Task 4.
- Produces (utils): `DocumentStatus`, `DocumentSort`, `DocTheme`, `DocumentListParams`, `DEFAULT_STATUSES`, `buildDocumentListQuery(p) -> string`, `DOC_STATUS_LABEL`, `resolveDocTheme(theme, prefersDark) -> DocTheme`, `stampDocumentTheme(html, mode) -> string`, `formatDocDate(iso) -> string`, `documentDownloadName(code, revision) -> string`.
- Produces (api): types `DocumentCategory`, `DocumentRow`, `DocumentDetail`, `DocumentListResponse`, `DocumentPatch`, `DocumentCategoryCreate`, `DocumentCategoryUpdate`; functions `listDocuments`, `getDocument`, `getDocumentContent`, `patchDocument`, `activateDocument`, `retireDocument`, `listDocumentCategories`, `createDocumentCategory`, `updateDocumentCategory`, `deleteDocumentCategory`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/documents-utils.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildDocumentListQuery,
  documentDownloadName,
  formatDocDate,
  resolveDocTheme,
  stampDocumentTheme,
} from '@/components/documents/documents-utils'

describe('buildDocumentListQuery', () => {
  it('uses the defaults: draft+active, updated_at, page 1, 50 per page', () => {
    const q = new URLSearchParams(buildDocumentListQuery({}))
    expect(q.getAll('status')).toEqual(['draft', 'active'])
    expect(q.get('sort')).toBe('updated_at')
    expect(q.get('page')).toBe('1')
    expect(q.get('page_size')).toBe('50')
    expect(q.has('q')).toBe(false)
    expect(q.has('category_id')).toBe(false)
  })

  it('carries search, category, statuses, sort and paging', () => {
    const q = new URLSearchParams(
      buildDocumentListQuery({
        q: '  audit ',
        categoryId: 3,
        statuses: ['retired'],
        sort: 'title',
        page: 2,
        pageSize: 25,
      })
    )
    expect(q.get('q')).toBe('audit')
    expect(q.get('category_id')).toBe('3')
    expect(q.getAll('status')).toEqual(['retired'])
    expect(q.get('sort')).toBe('title')
    expect(q.get('page')).toBe('2')
    expect(q.get('page_size')).toBe('25')
  })

  it('drops a blank search and a null category', () => {
    const q = new URLSearchParams(buildDocumentListQuery({ q: '   ', categoryId: null }))
    expect(q.has('q')).toBe(false)
    expect(q.has('category_id')).toBe(false)
  })
})

describe('resolveDocTheme', () => {
  it('passes explicit themes through and resolves system from the media query', () => {
    expect(resolveDocTheme('dark', false)).toBe('dark')
    expect(resolveDocTheme('light', true)).toBe('light')
    expect(resolveDocTheme('system', true)).toBe('dark')
    expect(resolveDocTheme('system', false)).toBe('light')
  })
})

describe('stampDocumentTheme', () => {
  it('adds data-theme to an unstamped <html>', () => {
    expect(stampDocumentTheme('<!doctype html><html lang="en"><body>x</body></html>', 'dark')).toBe(
      '<!doctype html><html data-theme="dark" lang="en"><body>x</body></html>'
    )
  })
  it('replaces an existing data-theme', () => {
    expect(stampDocumentTheme("<html data-theme='light'><body/></html>", 'dark')).toBe(
      "<html data-theme='dark'><body/></html>"
    )
  })
  it('wraps a bare fragment', () => {
    const out = stampDocumentTheme('<p>hi</p>', 'light')
    expect(out.startsWith('<!doctype html><html data-theme="light">')).toBe(true)
    expect(out).toContain('<p>hi</p>')
  })
})

describe('formatting helpers', () => {
  it('formats dates as YYYY-MM-DD or a dash', () => {
    expect(formatDocDate('2026-09-15T21:26:27')).toBe('2026-09-15')
    expect(formatDocDate('2026-09-15')).toBe('2026-09-15')
    expect(formatDocDate(null)).toBe('—')
    expect(formatDocDate(undefined)).toBe('—')
  })
  it('names downloads by code and revision', () => {
    expect(documentDownloadName('ART-0012', 3)).toBe('ART-0012-r3.html')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /c/tmp/mk1-documents && npm run test:run -- src/lib/__tests__/documents-utils.test.ts
```

Expected: FAIL, `Cannot find module '@/components/documents/documents-utils'`.

- [ ] **Step 3: Create the utils module**

`src/components/documents/documents-utils.ts`:

```ts
/**
 * Pure helpers for the Documents library UI. No React, no fetch — everything
 * here is unit-tested in src/lib/__tests__/documents-utils.test.ts.
 */

export type DocumentStatus = 'draft' | 'active' | 'retired'
export type DocumentSort = 'updated_at' | 'title' | 'code' | 'effective_date'
export type DocTheme = 'dark' | 'light'

export interface DocumentListParams {
  q?: string
  categoryId?: number | null
  statuses?: DocumentStatus[]
  sort?: DocumentSort
  page?: number
  pageSize?: number
}

export const DEFAULT_STATUSES: DocumentStatus[] = ['draft', 'active']

export const DOC_STATUS_LABEL: Record<DocumentStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  retired: 'Retired',
}

/** Query string for GET /api/documents (spec §5.1). */
export function buildDocumentListQuery(p: DocumentListParams): string {
  const params = new URLSearchParams()
  const q = p.q?.trim()
  if (q) params.set('q', q)
  if (p.categoryId != null) params.set('category_id', String(p.categoryId))
  for (const s of p.statuses ?? DEFAULT_STATUSES) params.append('status', s)
  params.set('sort', p.sort ?? 'updated_at')
  params.set('page', String(p.page ?? 1))
  params.set('page_size', String(p.pageSize ?? 50))
  return params.toString()
}

/** Mk1's useTheme() can return 'system'; the frame needs a concrete mode. */
export function resolveDocTheme(
  theme: 'dark' | 'light' | 'system',
  prefersDark: boolean
): DocTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
}

/**
 * Stamp Mk1's theme onto the document root so the artifact CSS
 * (`:root[data-theme="dark"]`) follows the app toggle instead of the OS.
 */
export function stampDocumentTheme(html: string, mode: DocTheme): string {
  if (/<html\b[^>]*\sdata-theme=/i.test(html)) {
    return html.replace(
      /(<html\b[^>]*\sdata-theme=)(["'])[^"']*\2/i,
      (_m, before: string, quote: string) => `${before}${quote}${mode}${quote}`
    )
  }
  if (/<html\b/i.test(html)) {
    return html.replace(/<html\b/i, `<html data-theme="${mode}"`)
  }
  return `<!doctype html><html data-theme="${mode}"><head><meta charset="utf-8"></head><body>${html}</body></html>`
}

export function formatDocDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '—'
}

export function documentDownloadName(code: string, revision: number): string {
  return `${code}-r${revision}.html`
}
```

- [ ] **Step 4: Create the API module**

`src/lib/api-documents.ts`:

```ts
/**
 * Documents library API client (spec 2026-09-15 §5). A sibling of api.ts,
 * like api-priorities.ts, so the 8k-line client does not grow further.
 */
import { API_BASE_URL, apiFetch, getBearerHeaders } from '@/lib/api'
import {
  buildDocumentListQuery,
  type DocumentListParams,
  type DocumentStatus,
} from '@/components/documents/documents-utils'

export interface DocumentCategory {
  id: number
  name: string
  code_prefix: string
  description: string | null
  sort_order: number
  active: boolean
  document_count: number
  created_at: string
  updated_at: string
}

export interface DocumentRow {
  id: number
  code: string
  revision: number
  title: string
  description: string | null
  category_id: number
  category_name: string
  category_prefix: string
  status: DocumentStatus
  effective_date: string | null
  activated_at: string | null
  retired_at: string | null
  supersedes_id: number | null
  author: string | null
  source_session: string | null
  created_by_user_id: number | null
  content_type: string
  size_bytes: number
  content_sha256: string
  created_at: string
  updated_at: string
  revision_count: number
}

export interface DocumentDetail extends DocumentRow {
  revisions: DocumentRow[]
}

export interface DocumentListResponse {
  items: DocumentRow[]
  total: number
  page: number
  page_size: number
}

export interface DocumentPatch {
  title?: string
  description?: string | null
  category_id?: number
  effective_date?: string | null
}

export interface DocumentCategoryCreate {
  name: string
  code_prefix: string
  description?: string | null
  sort_order?: number
}

export interface DocumentCategoryUpdate {
  name?: string
  description?: string | null
  sort_order?: number
  active?: boolean
}

export function listDocuments(params: DocumentListParams): Promise<DocumentListResponse> {
  return apiFetch<DocumentListResponse>(`/api/documents?${buildDocumentListQuery(params)}`)
}

export function getDocument(id: number): Promise<DocumentDetail> {
  return apiFetch<DocumentDetail>(`/api/documents/${id}`)
}

/** Raw HTML. apiFetch hardcodes response.json(), so this one uses fetch directly. */
export async function getDocumentContent(id: number): Promise<string> {
  const response = await fetch(`${API_BASE_URL()}/api/documents/${id}/content`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    throw new Error(`GET /api/documents/${id}/content failed: ${response.status}`)
  }
  return response.text()
}

export function patchDocument(id: number, data: DocumentPatch): Promise<DocumentRow> {
  return apiFetch<DocumentRow>(`/api/documents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export function activateDocument(id: number): Promise<DocumentRow> {
  return apiFetch<DocumentRow>(`/api/documents/${id}/activate`, { method: 'POST' })
}

export function retireDocument(id: number): Promise<DocumentRow> {
  return apiFetch<DocumentRow>(`/api/documents/${id}/retire`, { method: 'POST' })
}

export function listDocumentCategories(activeOnly = false): Promise<DocumentCategory[]> {
  return apiFetch<DocumentCategory[]>(
    `/api/document-categories${activeOnly ? '?active_only=true' : ''}`
  )
}

export function createDocumentCategory(
  data: DocumentCategoryCreate
): Promise<DocumentCategory> {
  return apiFetch<DocumentCategory>('/api/document-categories', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function updateDocumentCategory(
  id: number,
  data: DocumentCategoryUpdate
): Promise<DocumentCategory> {
  return apiFetch<DocumentCategory>(`/api/document-categories/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export function deleteDocumentCategory(id: number): Promise<void> {
  return apiFetch<void>(`/api/document-categories/${id}`, { method: 'DELETE' })
}
```

- [ ] **Step 5: Run the test to verify it passes, then typecheck**

```bash
npm run test:run -- src/lib/__tests__/documents-utils.test.ts && npm run typecheck
```

Expected: 9 tests pass; `tsc --noEmit` reports nothing new (compare against master if anything prints).

- [ ] **Step 6: Commit**

```bash
git add -- src/components/documents/documents-utils.ts src/lib/api-documents.ts src/lib/__tests__/documents-utils.test.ts
git commit -m "feat(documents): frontend utils and API client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/documents/documents-utils.ts src/lib/api-documents.ts src/lib/__tests__/documents-utils.test.ts
```

---

### Task 7: Query hooks, the Documents list page, and navigation wiring

**Files:**
- Create: `src/services/documents.ts`
- Create: `src/components/documents/DocumentsPage.tsx`
- Modify: `src/store/ui-store.ts` (`ReportsSubSection` :54-61, `UIState` :100-110 and :150, initial state :259, `navigateTo` :343-352, actions after `navigateToBoxes` :390-400)
- Modify: `src/lib/hash-navigation.ts` (`applyNavToStore` :83-109, `buildHash` :128-163, subscribe :184-198)
- Modify: `src/components/layout/AppSidebar.tsx:117-130`
- Modify: `src/components/layout/MainWindowContent.tsx:24-30, :80-89`
- Test: `src/components/layout/__tests__/AppSidebar.test.tsx`

**Interfaces:**
- Consumes: Task 6 utils + api; `DataTable` from `@/components/ui/data-table` (`columns`, `data`, `onRowClick`, `getRowId`); shadcn `Input`, `Badge`, `Button`, `Select*`; `useUIStore`.
- Produces: store fields `documentViewerTargetId: number | null`, actions `navigateToDocument(id: number)`, `clearDocumentViewer()`; sub-section id `'documents'`; hash `#reports/documents?id=<n>`; hooks `documentKeys`, `useDocuments(params)`, `useDocument(id)`, `useDocumentContent(id)`, `usePatchDocument()`, `useDocumentCategories(activeOnly?)`, `useCreateDocumentCategory()`, `useUpdateDocumentCategory()`, `useDeleteDocumentCategory()`; component `DocumentsPage` (renders `DocumentViewer` from Task 8 when a target id is set — Task 7 ships a placeholder `DocumentViewer` that Task 8 replaces).

- [ ] **Step 1: Write the failing sidebar tests**

Append inside the top-level `describe` of `src/components/layout/__tests__/AppSidebar.test.tsx` (next to the existing "orders AccuMark Tools sub-items" test, reusing its `renderSidebar`, `uiState`, `screen`, `fireEvent`):

```tsx
  it('orders Reports sub-items with Documents after Ready to Publish', () => {
    localStorage.setItem(
      'sidebar-expanded-sections',
      JSON.stringify({ 'accumark-tools': true, reports: true })
    )
    renderSidebar()
    const anchor = screen.getByRole('button', { name: /Ready to Publish/ })
    const subMenu = anchor.closest('[data-sidebar="menu-sub"]')
    if (!subMenu) throw new Error('Reports sub-menu not found in DOM')
    const labels = Array.from(
      subMenu.querySelectorAll('[data-sidebar="menu-sub-button"]')
    ).map(el => el.textContent?.replace(/\d+/g, '').trim() ?? '')
    expect(labels).toEqual([
      'Dashboard',
      'Check-In Times',
      'Ready to Publish',
      'Documents',
      'Lab Throughput',
      'SLA Performance',
      'Bottlenecks',
    ])
  })

  it('clicking Documents dispatches navigateTo("reports", "documents")', () => {
    localStorage.setItem(
      'sidebar-expanded-sections',
      JSON.stringify({ 'accumark-tools': true, reports: true })
    )
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }))
    expect(uiState.navigateTo).toHaveBeenCalledWith('reports', 'documents')
  })
```

(The `replace(/\d+/g, '')` strips the Ready to Publish count chips; the mock `useAuthStore` user is a standard user, so the admin-only Sync Debug item is absent — matching the expected list.)

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:run -- src/components/layout/__tests__/AppSidebar.test.tsx
```

Expected: the two new tests FAIL (no "Documents" button); the existing ones pass.

- [ ] **Step 3: Extend the store**

In `src/store/ui-store.ts`:

1. `ReportsSubSection` — add `| 'documents'` immediately after `| 'ready-to-publish'`.
2. In the `UIState` interface, next to `customerDetailTargetId: number | null` add:

```ts
  // Documents library viewer target (#reports/documents?id=N). Sticky like
  // customerDetailTargetId; generic navigateTo clears it so the sidebar
  // entry always lands on the list.
  documentViewerTargetId: number | null
```

   and next to `navigateToCustomer: (id: number) => void` add:

```ts
  navigateToDocument: (id: number) => void
  clearDocumentViewer: () => void
```

3. In the initial state, next to `customerDetailTargetId: null,` add `documentViewerTargetId: null,`.
4. In `navigateTo`, add `documentViewerTargetId: null,` to the object returned by the `set` callback (alongside `activeSection`, `activeSubSection`, `navigationKey`).
5. After the `navigateToBoxes` action add:

```ts
      navigateToDocument: id =>
        set(
          state => ({
            activeSection: 'reports',
            activeSubSection: 'documents',
            documentViewerTargetId: id,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToDocument'
        ),

      clearDocumentViewer: () =>
        set({ documentViewerTargetId: null }, undefined, 'clearDocumentViewer'),
```

- [ ] **Step 4: Wire the hash (three sites)**

In `src/lib/hash-navigation.ts`:

1. `applyNavToStore` — insert before the final `} else {` of the branch chain:

```ts
  } else if (
    subSection === 'documents' &&
    targetId &&
    !Number.isNaN(Number(targetId))
  ) {
    store.navigateToDocument(Number(targetId))
```

2. `buildHash` — add `documentViewerTargetId: number | null` to its `state` parameter type, and add a branch after the `peptide-config` one:

```ts
  } else if (
    state.activeSubSection === 'documents' &&
    state.documentViewerTargetId != null
  ) {
    hash += `?id=${encodeURIComponent(String(state.documentViewerTargetId))}`
  }
```

3. The `useUIStore.subscribe` diff — add `state.documentViewerTargetId !== prev.documentViewerTargetId ||` to the condition list.

- [ ] **Step 5: Create the query hooks**

`src/services/documents.ts`:

```ts
/**
 * TanStack Query hooks for the Documents library. Mirrors services/flag-types.ts.
 */
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createDocumentCategory,
  deleteDocumentCategory,
  getDocument,
  getDocumentContent,
  listDocumentCategories,
  listDocuments,
  patchDocument,
  updateDocumentCategory,
  type DocumentCategoryCreate,
  type DocumentCategoryUpdate,
  type DocumentPatch,
} from '@/lib/api-documents'
import type { DocumentListParams } from '@/components/documents/documents-utils'

export const documentKeys = {
  all: ['documents'] as const,
  list: (params: DocumentListParams) => ['documents', 'list', params] as const,
  detail: (id: number) => ['documents', 'detail', id] as const,
  content: (id: number) => ['documents', 'content', id] as const,
  categories: (activeOnly: boolean) => ['documents', 'categories', activeOnly] as const,
}

export function useDocuments(params: DocumentListParams) {
  return useQuery({
    queryKey: documentKeys.list(params),
    queryFn: () => listDocuments(params),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}

export function useDocument(id: number | null) {
  return useQuery({
    queryKey: documentKeys.detail(id ?? -1),
    queryFn: () => getDocument(id as number),
    enabled: id != null,
  })
}

export function useDocumentContent(id: number | null) {
  return useQuery({
    queryKey: documentKeys.content(id ?? -1),
    queryFn: () => getDocumentContent(id as number),
    enabled: id != null,
    staleTime: Infinity, // content is immutable per revision
  })
}

export function usePatchDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DocumentPatch }) => patchDocument(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: documentKeys.all })
      toast.success('Document updated')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDocumentCategories(activeOnly = false) {
  return useQuery({
    queryKey: documentKeys.categories(activeOnly),
    queryFn: () => listDocumentCategories(activeOnly),
    staleTime: 5 * 60_000,
  })
}

function invalidateCategories(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['documents', 'categories'] })
  qc.invalidateQueries({ queryKey: ['documents', 'list'] })
}

export function useCreateDocumentCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: DocumentCategoryCreate) => createDocumentCategory(data),
    onSuccess: () => {
      invalidateCategories(qc)
      toast.success('Category created')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateDocumentCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DocumentCategoryUpdate }) =>
      updateDocumentCategory(id, data),
    onSuccess: () => invalidateCategories(qc),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteDocumentCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteDocumentCategory(id),
    onSuccess: () => {
      invalidateCategories(qc)
      toast.success('Category deleted')
    },
    // 409 = still referenced; the pane explains and offers Deactivate instead.
    onError: (e: Error) => {
      if (/failed: 409/.test(e.message)) return
      toast.error(e.message)
    },
  })
}
```

- [ ] **Step 6: Create the list page (with a placeholder viewer)**

`src/components/documents/DocumentsPage.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { FileText, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUIStore } from '@/store/ui-store'
import { useDocumentCategories, useDocuments } from '@/services/documents'
import type { DocumentRow } from '@/lib/api-documents'
import {
  DEFAULT_STATUSES,
  DOC_STATUS_LABEL,
  formatDocDate,
  type DocumentSort,
  type DocumentStatus,
} from '@/components/documents/documents-utils'
import { DocumentViewer } from '@/components/documents/DocumentViewer'

type StatusFilter = 'live' | 'active' | 'draft' | 'retired' | 'all'

const STATUS_FILTERS: Record<StatusFilter, DocumentStatus[]> = {
  live: DEFAULT_STATUSES,
  active: ['active'],
  draft: ['draft'],
  retired: ['retired'],
  all: ['draft', 'active', 'retired'],
}

const STATUS_BADGE: Record<DocumentStatus, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  draft: 'secondary',
  retired: 'outline',
}

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return <Badge variant={STATUS_BADGE[status]}>{DOC_STATUS_LABEL[status]}</Badge>
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export function DocumentsPage() {
  const targetId = useUIStore(s => s.documentViewerTargetId)
  if (targetId != null) return <DocumentViewer id={targetId} />
  return <DocumentsList />
}

function DocumentsList() {
  const navigateToDocument = useUIStore(s => s.navigateToDocument)
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('live')
  const [sort, setSort] = useState<DocumentSort>('updated_at')
  const [page, setPage] = useState(1)
  const q = useDebounced(query, 250)

  const params = useMemo(
    () => ({ q, categoryId, statuses: STATUS_FILTERS[statusFilter], sort, page, pageSize: 50 }),
    [q, categoryId, statusFilter, sort, page]
  )
  const { data, isLoading, isFetching, error } = useDocuments(params)
  const categories = useDocumentCategories(false)

  const columns = useMemo<ColumnDef<DocumentRow>[]>(
    () => [
      {
        accessorKey: 'code',
        header: 'Code',
        size: 110,
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.code}</span>,
      },
      {
        accessorKey: 'title',
        header: 'Title',
        size: 380,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.original.title}</div>
            {row.original.description && (
              <div className="truncate text-xs text-muted-foreground">
                {row.original.description}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'category_name',
        header: 'Category',
        size: 110,
        cell: ({ row }) => <Badge variant="outline">{row.original.category_name}</Badge>,
      },
      {
        accessorKey: 'revision',
        header: 'Rev',
        size: 60,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.revision}
            {row.original.revision_count > 1 && (
              <span className="text-muted-foreground"> / {row.original.revision_count}</span>
            )}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        size: 90,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: 'effective_date',
        header: 'Effective',
        size: 100,
        cell: ({ row }) => <span className="tabular-nums">{formatDocDate(row.original.effective_date)}</span>,
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        size: 100,
        cell: ({ row }) => <span className="tabular-nums">{formatDocDate(row.original.updated_at)}</span>,
      },
      {
        accessorKey: 'created_at',
        header: 'Created',
        size: 100,
        cell: ({ row }) => <span className="tabular-nums">{formatDocDate(row.original.created_at)}</span>,
      },
    ],
    []
  )

  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / 50))

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Documents</h1>
          <p className="text-sm text-muted-foreground">
            Artifacts, SOPs and other controlled documents published to the lab.
          </p>
        </div>
        {isFetching && !isLoading && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="documents-search"
          placeholder="Search code, title or description…"
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setPage(1)
          }}
          className="h-8 max-w-sm text-xs"
        />
        <Select
          value={categoryId == null ? 'all' : String(categoryId)}
          onValueChange={v => {
            setCategoryId(v === 'all' ? null : Number(v))
            setPage(1)
          }}
        >
          <SelectTrigger id="documents-category" className="h-8 w-[160px] text-xs">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(categories.data ?? []).map(c => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={v => {
            setStatusFilter(v as StatusFilter)
            setPage(1)
          }}
        >
          <SelectTrigger id="documents-status" className="h-8 w-[150px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="live">Draft + Active</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="retired">Retired</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={v => setSort(v as DocumentSort)}>
          <SelectTrigger id="documents-sort" className="h-8 w-[150px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated_at">Recently updated</SelectItem>
            <SelectItem value="title">Title</SelectItem>
            <SelectItem value="code">Code</SelectItem>
            <SelectItem value="effective_date">Effective date</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {total} document{total === 1 ? '' : 's'}
        </span>
      </div>

      {error && <p className="text-sm text-destructive">Could not load documents: {error.message}</p>}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
          <FileText className="h-8 w-8" />
          <p className="text-sm">No documents match.</p>
          <p className="max-w-md text-xs">
            Documents are published by agents with the <span className="font-mono">mk1-publish-document</span>{' '}
            skill. Clear the search or widen the status filter to see more.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <DataTable
            columns={columns}
            data={data?.items ?? []}
            onRowClick={row => navigateToDocument(row.id)}
            getRowId={row => String(row.id)}
          />
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            Previous
          </Button>
          <span className="tabular-nums">
            Page {page} of {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
```

And the placeholder that Task 8 replaces — `src/components/documents/DocumentViewer.tsx`:

```tsx
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'

/** Placeholder — replaced wholesale in Task 8. */
export function DocumentViewer({ id }: { id: number }) {
  const clear = useUIStore(s => s.clearDocumentViewer)
  return (
    <div className="p-4">
      <Button variant="outline" size="sm" onClick={clear}>
        Back to documents
      </Button>
      <p className="mt-4 text-sm text-muted-foreground">Document #{id}</p>
    </div>
  )
}
```

- [ ] **Step 7: Add the nav item and the render branch**

In `src/components/layout/AppSidebar.tsx`, inside the `reports` item's `subItems`, insert after `{ id: 'ready-to-publish', label: 'Ready to Publish' },`:

```ts
      { id: 'documents', label: 'Documents' },
```

In `src/components/layout/MainWindowContent.tsx`, add the import next to the other report imports:

```tsx
import { DocumentsPage } from '@/components/documents/DocumentsPage'
```

and in `case 'reports':` add, before `if (activeSubSection === 'throughput')`:

```tsx
        if (activeSubSection === 'documents') return <DocumentsPage />
```

- [ ] **Step 8: Run the tests, typecheck, lint**

```bash
npm run test:run -- src/components/layout/__tests__/AppSidebar.test.tsx src/lib/__tests__/documents-utils.test.ts && npm run typecheck && npm run lint
```

Expected: all pass; lint reports nothing new versus master.

- [ ] **Step 9: Commit**

```bash
git add -- src/services/documents.ts src/components/documents/DocumentsPage.tsx src/components/documents/DocumentViewer.tsx src/store/ui-store.ts src/lib/hash-navigation.ts src/components/layout/AppSidebar.tsx src/components/layout/MainWindowContent.tsx src/components/layout/__tests__/AppSidebar.test.tsx
git commit -m "feat(documents): Reports → Documents list page, store + hash wiring

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/services/documents.ts src/components/documents/DocumentsPage.tsx src/components/documents/DocumentViewer.tsx src/store/ui-store.ts src/lib/hash-navigation.ts src/components/layout/AppSidebar.tsx src/components/layout/MainWindowContent.tsx src/components/layout/__tests__/AppSidebar.test.tsx
```

---
### Task 8: Document viewer and retitle dialog

**Files:**
- Replace: `src/components/documents/DocumentViewer.tsx` (the Task 7 placeholder)
- Create: `src/components/documents/RetitleDialog.tsx`

**Interfaces:**
- Consumes: `useDocument`, `useDocumentContent`, `usePatchDocument`, `useDocumentCategories` (Task 7); `stampDocumentTheme`, `resolveDocTheme`, `formatDocDate`, `documentDownloadName` (Task 6); `useTheme` from `@/hooks/use-theme`; `useAuthStore`; `useUIStore` (`clearDocumentViewer`, `navigateToDocument`); shadcn `Dialog*`, `Input`, `Textarea`, `Label`, `Select*`, `Button`, `Badge`.
- Produces: `DocumentViewer({ id: number })` and `RetitleDialog({ doc, open, onOpenChange })`.

- [ ] **Step 1: Create the retitle dialog**

`src/components/documents/RetitleDialog.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { DocumentRow } from '@/lib/api-documents'
import { useDocumentCategories, usePatchDocument } from '@/services/documents'

interface RetitleDialogProps {
  doc: DocumentRow
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Admin-only metadata edit (spec §5.1 PATCH): title, description, category,
 *  effective date. Never touches content or revision. */
export function RetitleDialog({ doc, open, onOpenChange }: RetitleDialogProps) {
  const [title, setTitle] = useState(doc.title)
  const [description, setDescription] = useState(doc.description ?? '')
  const [categoryId, setCategoryId] = useState(String(doc.category_id))
  const [effective, setEffective] = useState(doc.effective_date ?? '')
  const categories = useDocumentCategories(false)
  const patch = usePatchDocument()

  useEffect(() => {
    if (!open) return
    setTitle(doc.title)
    setDescription(doc.description ?? '')
    setCategoryId(String(doc.category_id))
    setEffective(doc.effective_date ?? '')
  }, [open, doc])

  const canSave = title.trim().length > 0 && !patch.isPending

  const save = () => {
    patch.mutate(
      {
        id: doc.id,
        data: {
          title: title.trim(),
          description: description.trim() || null,
          category_id: Number(categoryId),
          effective_date: effective || null,
        },
      },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit document details</DialogTitle>
          <DialogDescription>
            {doc.code} · revision {doc.revision}. Content is not changed here; publish a new
            revision for that.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="doc-title">Title</Label>
            <Input id="doc-title" value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="doc-description">Short description</Label>
            <Textarea
              id="doc-description"
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="doc-category">Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="doc-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(categories.data ?? []).map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="doc-effective">Effective date</Label>
              <Input
                id="doc-effective"
                type="date"
                value={effective}
                onChange={e => setEffective(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {patch.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Replace the viewer**

`src/components/documents/DocumentViewer.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { ArrowLeft, Download, ExternalLink, Loader2, Pencil } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTheme } from '@/hooks/use-theme'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import { useDocument, useDocumentContent } from '@/services/documents'
import {
  DOC_STATUS_LABEL,
  documentDownloadName,
  formatDocDate,
  resolveDocTheme,
  stampDocumentTheme,
} from '@/components/documents/documents-utils'
import { RetitleDialog } from '@/components/documents/RetitleDialog'

/**
 * Renders one revision inside a sandboxed frame (spec §8.3). `srcdoc` +
 * `sandbox="allow-scripts"` (no allow-same-origin) gives the document an
 * opaque origin: its scripts run but cannot reach Mk1's session, storage,
 * cookies, or the API. Content is fetched with the normal bearer call, so no
 * token ever lands in a URL.
 */
export function DocumentViewer({ id }: { id: number }) {
  const clear = useUIStore(s => s.clearDocumentViewer)
  const navigateToDocument = useUIStore(s => s.navigateToDocument)
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
  const { theme } = useTheme()
  const [editing, setEditing] = useState(false)

  const detail = useDocument(id)
  const content = useDocumentContent(id)

  const mode = resolveDocTheme(
    theme,
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  const srcDoc = useMemo(
    () => (content.data ? stampDocumentTheme(content.data, mode) : ''),
    [content.data, mode]
  )

  const openInWindow = () => {
    if (!content.data) return
    const url = URL.createObjectURL(new Blob([content.data], { type: 'text/html' }))
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const download = () => {
    if (!content.data || !detail.data) return
    const url = URL.createObjectURL(new Blob([content.data], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url
    a.download = documentDownloadName(detail.data.code, detail.data.revision)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const doc = detail.data

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={clear}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Documents
        </Button>
        {doc && (
          <>
            <span className="font-mono text-xs text-muted-foreground">{doc.code}</span>
            <span className="truncate font-medium">{doc.title}</span>
            <Badge variant={doc.status === 'active' ? 'default' : doc.status === 'draft' ? 'secondary' : 'outline'}>
              {DOC_STATUS_LABEL[doc.status]}
            </Badge>
            <Badge variant="outline">{doc.category_name}</Badge>
            <span className="text-xs text-muted-foreground">
              effective {formatDocDate(doc.effective_date)} · {doc.author ?? 'unknown author'} ·
              updated {formatDocDate(doc.updated_at)}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {doc.revisions.length > 1 && (
                <Select value={String(doc.id)} onValueChange={v => navigateToDocument(Number(v))}>
                  <SelectTrigger id="document-revision" className="h-8 w-[170px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {doc.revisions.map(r => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        Rev {r.revision} · {DOC_STATUS_LABEL[r.status]} · {formatDocDate(r.created_at)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button variant="outline" size="sm" onClick={openInWindow} disabled={!content.data}>
                <ExternalLink className="mr-1 h-4 w-4" />
                Open
              </Button>
              <Button variant="outline" size="sm" onClick={download} disabled={!content.data}>
                <Download className="mr-1 h-4 w-4" />
                Download
              </Button>
              {isAdmin && (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil className="mr-1 h-4 w-4" />
                  Edit details
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      {(detail.error || content.error) && (
        <p className="px-4 py-3 text-sm text-destructive">
          Could not load this document: {(detail.error ?? content.error)?.message}
        </p>
      )}

      {content.isLoading || detail.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <iframe
          title={doc?.title ?? `Document ${id}`}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      )}

      {doc && <RetitleDialog doc={doc} open={editing} onOpenChange={setEditing} />}
    </div>
  )
}
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: clean versus master. (`sandbox="allow-scripts"` and `srcDoc` are valid React iframe props; if the repo's ast-grep rules flag `window.open`, it is the same pattern `SampleDetails.tsx` uses for COA PDFs.)

- [ ] **Step 4: Manual check in the app**

Start the backend + `npm run dev` (or use a stack), publish one document with Task 5's script (`--base-url http://localhost:8000` and the local service token), then open `#reports/documents`, click the row, and confirm: the page renders inside the frame in the artifact look, toggling Mk1's theme (Settings → Appearance) re-stamps the frame, Download saves `CODE-r1.html`, Open shows it in a new window, Edit details (as admin) changes the title in the header and the list. Publish a second revision with `--code <CODE>` and confirm the revision picker lists both and the old one reads Retired.

- [ ] **Step 5: Commit**

```bash
git add -- src/components/documents/DocumentViewer.tsx src/components/documents/RetitleDialog.tsx
git commit -m "feat(documents): sandboxed document viewer with revisions, download, retitle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/documents/DocumentViewer.tsx src/components/documents/RetitleDialog.tsx
```

---

### Task 9: Settings → Documents (categories)

**Files:**
- Create: `src/components/preferences/panes/DocumentsPane.tsx`
- Modify: `src/components/preferences/panes.tsx:36-94` (union, `navigationItems`, `PANE_COMPONENTS`, icon import)
- Modify: `src/store/ui-store.ts` (`SettingsSubSection` :66-77)
- Modify: `locales/en.json`, `locales/ar.json`, `locales/fr.json` (add `"preferences.documents"`)

**Interfaces:**
- Consumes: Task 7 hooks `useDocumentCategories`, `useCreateDocumentCategory`, `useUpdateDocumentCategory`, `useDeleteDocumentCategory`; `SettingsSection` from `../shared/SettingsComponents`; `useAuthStore`.
- Produces: settings pane id `'documents'` reachable at `#settings/documents`.

- [ ] **Step 1: Register the pane**

In `src/store/ui-store.ts`, add `| 'documents'` to `SettingsSubSection` (after `| 'flags'`).

In `src/components/preferences/panes.tsx`:
1. Add `FileText,` to the `lucide-react` import list.
2. Add `| 'documents'` to `PreferencePane` (after `| 'flags'`).
3. Add `import { DocumentsPane } from './panes/DocumentsPane'` next to the other pane imports.
4. In `navigationItems`, after the `flags` entry add `{ id: 'documents', labelKey: 'preferences.documents', icon: FileText },`.
5. In `PANE_COMPONENTS`, after `flags: FlagsPane,` add `documents: DocumentsPane,`.

In each of `locales/en.json`, `locales/ar.json`, `locales/fr.json`, add next to `"preferences.flags"`:

```json
  "preferences.documents": "Documents",
```

(`fallbackLng` is `en`; the ar/fr entries keep the key present so the nav never renders the raw key.)

- [ ] **Step 2: Create the pane**

`src/components/preferences/panes/DocumentsPane.tsx`:

```tsx
import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useCreateDocumentCategory,
  useDeleteDocumentCategory,
  useDocumentCategories,
  useUpdateDocumentCategory,
} from '@/services/documents'
import type { DocumentCategory } from '@/lib/api-documents'

/** Managed document categories (spec §3.1, §8.4). Read-only with a notice
 *  for non-admins, matching the other settings panes. */
export function DocumentsPane() {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const categories = useDocumentCategories(false)

  if (categories.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (categories.isError || !categories.data) {
    return <p className="text-sm text-destructive">Could not load document categories.</p>
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">
          Only administrators can change document categories.
        </p>
      )}
      <SettingsSection title="Document categories">
        <p className="text-sm text-muted-foreground">
          Every published document belongs to one category. The prefix becomes the start of
          its code (ART-0012) and cannot change once a document uses it.
        </p>
        <div className="divide-y rounded-md border">
          {categories.data.map(c => (
            <CategoryRow key={c.id} category={c} readOnly={!isAdmin} />
          ))}
        </div>
        {isAdmin && <NewCategoryForm />}
      </SettingsSection>
    </div>
  )
}

function CategoryRow({ category, readOnly }: { category: DocumentCategory; readOnly: boolean }) {
  const [name, setName] = useState(category.name)
  const [description, setDescription] = useState(category.description ?? '')
  const update = useUpdateDocumentCategory()
  const remove = useDeleteDocumentCategory()
  const dirty = name.trim() !== category.name || (description.trim() || null) !== category.description

  return (
    <div className="grid grid-cols-[90px_1fr_1fr_auto] items-center gap-3 px-3 py-2 text-sm">
      <span className="font-mono text-xs">{category.code_prefix}</span>
      <Input
        id={`doc-cat-name-${category.id}`}
        value={name}
        onChange={e => setName(e.target.value)}
        disabled={readOnly}
        className="h-8 text-xs"
        aria-label={`${category.code_prefix} name`}
      />
      <Input
        id={`doc-cat-desc-${category.id}`}
        value={description}
        onChange={e => setDescription(e.target.value)}
        disabled={readOnly}
        placeholder="Description"
        className="h-8 text-xs"
        aria-label={`${category.code_prefix} description`}
      />
      <div className="flex items-center gap-2">
        <Badge variant={category.active ? 'default' : 'outline'}>
          {category.active ? 'Active' : 'Inactive'}
        </Badge>
        <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
          {category.document_count} doc{category.document_count === 1 ? '' : 's'}
        </span>
        {!readOnly && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty || update.isPending || !name.trim()}
              onClick={() =>
                update.mutate({
                  id: category.id,
                  data: { name: name.trim(), description: description.trim() || null },
                })
              }
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ id: category.id, data: { active: !category.active } })}
            >
              {category.active ? 'Deactivate' : 'Activate'}
            </Button>
            {category.document_count === 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(category.id)}
              >
                Delete
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function NewCategoryForm() {
  const [name, setName] = useState('')
  const [prefix, setPrefix] = useState('')
  const [description, setDescription] = useState('')
  const create = useCreateDocumentCategory()
  const valid = name.trim().length > 0 && /^[A-Za-z0-9]{2,10}$/.test(prefix.trim())

  return (
    <div className="grid grid-cols-[90px_1fr_1fr_auto] items-end gap-3 rounded-md border border-dashed px-3 py-3">
      <div className="grid gap-1">
        <Label htmlFor="doc-cat-new-prefix" className="text-xs">
          Prefix
        </Label>
        <Input
          id="doc-cat-new-prefix"
          value={prefix}
          onChange={e => setPrefix(e.target.value.toUpperCase())}
          placeholder="VAL"
          maxLength={10}
          className="h-8 font-mono text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="doc-cat-new-name" className="text-xs">
          Name
        </Label>
        <Input
          id="doc-cat-new-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Validation"
          className="h-8 text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="doc-cat-new-desc" className="text-xs">
          Description
        </Label>
        <Input
          id="doc-cat-new-desc"
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="h-8 text-xs"
        />
      </div>
      <Button
        size="sm"
        disabled={!valid || create.isPending}
        onClick={() =>
          create.mutate(
            { name: name.trim(), code_prefix: prefix.trim(), description: description.trim() || null },
            {
              onSuccess: () => {
                setName('')
                setPrefix('')
                setDescription('')
              },
            }
          )
        }
      >
        <Plus className="mr-1 h-4 w-4" />
        Add
      </Button>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck, lint, run the settings tests**

```bash
npm run typecheck && npm run lint && npm run test:run -- src/components/preferences
```

Expected: clean; existing `SettingsPage.test.tsx` (which mocks the pane registry) still passes.

- [ ] **Step 4: Manual check**

Open `#settings/documents` as admin: both seeded rows appear with counts; add `VAL / Validation`, rename it, deactivate, delete (allowed while 0 docs); try Delete on Artifact after Task 8's publish — the button is hidden because the count is non-zero, and the API would answer 409 anyway.

- [ ] **Step 5: Commit**

```bash
git add -- src/components/preferences/panes/DocumentsPane.tsx src/components/preferences/panes.tsx src/store/ui-store.ts locales/en.json locales/ar.json locales/fr.json
git commit -m "feat(documents): Settings → Documents categories pane

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/preferences/panes/DocumentsPane.tsx src/components/preferences/panes.tsx src/store/ui-store.ts locales/en.json locales/ar.json locales/fr.json
```

---
### Task 10: Changelog, gates, and the first real publish

**Files:**
- Modify: `CHANGELOG.md` (`## Unreleased`)

**Interfaces:**
- Consumes: everything above.
- Produces: a branch ready for review; the 2026-09-14 audit page in the library as `ART-0001`.

- [ ] **Step 1: Changelog entry**

Under `## Unreleased` in `CHANGELOG.md` add:

```markdown
### Added
- **Documents library.** Reports → Documents lists controlled documents published by agents (artifacts, SOPs), with search, category and status filters, a sandboxed in-app viewer, revision history, download, and admin retitle. Documents carry a code (ART-0012 / SOP-0003), a revision, draft/active/retired status and an effective date, following the Methods lifecycle; a new revision retires the previous active one and content is never rewritten. Settings → Documents manages categories. Agents publish with the `mk1-publish-document` skill over the existing service token (`POST /api/documents`). New tables `document_categories`, `documents`, `document_code_counters`; HTML bytes live in the vial-photo blob store under `documents/`. Spec: `docs/superpowers/specs/2026-09-15-documents-library-design.md`.
```

- [ ] **Step 2: Backend gate — failure-set diff against master**

From `C:\tmp\mk1-documents\backend`:

```bash
C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider -rf 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sed 's/ - .*//' | sort > /c/tmp/mk1-documents-branch-fails.txt
```

Then the same command from the pristine master worktree `C:\tmp\mk1-deploy-1218\backend` into `/c/tmp/mk1-documents-master-fails.txt`, and:

```bash
diff /c/tmp/mk1-documents-master-fails.txt /c/tmp/mk1-documents-branch-fails.txt
```

Expected: empty diff (no new ids; the pre-existing baseline failures are the same set). Any id present only on the branch is a regression to fix before continuing.

- [ ] **Step 3: Frontend gate**

From `C:\tmp\mk1-documents`:

```bash
npm run typecheck && npm run lint && npm run ast:lint && npm run format:check && npm run test:run
```

Expected: typecheck/lint/ast:lint clean; `format:check` clean for the new files (run `npx prettier --write` on only the files this plan created if it complains — never repo-wide); `test:run` failure set identical to master's (`npm run test:run` in `C:\tmp\mk1-deploy-1218` for the baseline). The Rust parts of `check:all` are untouched by this plan and need not be re-run.

- [ ] **Step 4: Smoke the deployed route in a running backend**

With a backend up (local dev, or a stack on the devbox), export `MK1_API_BASE_URL` and `ACCUMK1_INTERNAL_SERVICE_TOKEN` for that environment (never paste the token into chat or a file), then:

```bash
python .claude/skills/mk1-publish-document/scripts/publish_document.py <path-to>/acoa-profile-audit.html --title "Additional COA Profile Audit" --category ART --description "Accounts with more than five additional-COA profiles, certificates per profile, and the group-buy resale pattern (2026-09-14)." --session d06d233c-0b47-40cf-a036-db2773c31e8c
```

Expected: `ART-0001 r1 id=1 status=active  open: #reports/documents?id=1`. Re-run the exact command: expected `ART-0001 r1 id=1` again (200 dedupe, no new revision). Open the deep link in the app and confirm the page renders in the frame with the artifact look and both theme modes.

- [ ] **Step 5: Commit and hand off**

```bash
git add -- CHANGELOG.md
git commit -m "docs(changelog): documents library

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- CHANGELOG.md
git log --oneline origin/master..HEAD
```

Expected: the spec commit plus one commit per task (10 feature commits + the changelog). Push the branch and open the PR with the Unreleased entry as the body; the release cut, version bump, and deploy go through the `accumark-deploy` skill (full Mk1 deploy: backend + frontend).

---

## Self-review notes (done while writing)

- **Spec coverage:** §3 tables → Task 1; §3.3 counter + §5.4 minting → Task 2; §5.1/5.5 create-revise-dedupe-lifecycle-patch-list → Task 3; §5 routes + §9 auth → Task 4; §6 skill + §7 theme → Task 5; §8.1 nav/hash → Task 7; §8.2 list → Task 7; §8.3 viewer → Task 8; §8.4 settings → Task 9; §10 tests → each task; §11 rollout → Task 10 (seed in Task 2, changelog in Task 10). §12 follow-ons intentionally absent.
- **Type consistency:** `require_document_writer` (Task 4) is the name Tasks 4's tests and routes use; `documentViewerTargetId` / `navigateToDocument` / `clearDocumentViewer` (Task 7) are the names Tasks 8 uses; `buildDocumentListQuery` / `stampDocumentTheme` / `resolveDocTheme` / `formatDocDate` / `documentDownloadName` (Task 6) are the names Tasks 7–8 import; `DocumentRow.revision_count` matches `DocumentOut.revision_count`.
- **Known simplification:** `list_documents` computes "latest revision per code" before applying the status filter, so a code whose newest revision is a draft appears as that draft under the default filter while its active revision stays reachable through the revision picker. This is the behavior the spec's §5.1 wording ("latest revision per code matching the status filter") intends for the list; if the lab wants "newest active" instead, it is a one-clause change in the subquery.

---

## Appendix A — `src/docs-theme/accumark-docs.css`

Create the file with exactly this content (Task 5, Step 1):

```css
/* accumark-docs v1 — shared document theme for Accumark artifacts and SOPs.
   Inlined into every document at publish time; never linked. Fonts: Archivo, IBM Plex Sans, IBM Plex Mono via Google Fonts <link>.
   Tokens resolve for the un-stamped (system) theme, and for html[data-theme="light"|"dark"]. */
:root{
  color-scheme:light;
  --bg:#f4f5f7; --surface:#ffffff; --surface-2:#eceff3; --ink:#161b22; --ink-2:#596372; --ink-3:#8b94a1;
  --line:#dde1e6; --line-2:#c6ccd4; --accent:#1c5cab; --accent-ink:#ffffff; --focus:#2a78d6;
  --bar:#2a78d6; --bar-soft:#cde2fb; --ref:#596372;
  --crit:#d03b3b; --ser:#ec835a; --warn:#fab219; --good:#0ca30c;
  --crit-bg:#fbe7e7; --ser-bg:#fdece4; --warn-bg:#fff3d1; --good-bg:#e4f5e4; --neutral-bg:#eceff3; --info-bg:#e3edfa;
  --font-display:'Archivo',system-ui,'Segoe UI',sans-serif;
  --font-body:'IBM Plex Sans',system-ui,'Segoe UI',sans-serif;
  --font-mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    color-scheme:dark;
    --bg:#121416; --surface:#1b1e22; --surface-2:#23272c; --ink:#f1f3f5; --ink-2:#b4bbc5; --ink-3:#7f8894;
    --line:#2b3037; --line-2:#3a4048; --accent:#6da7ec; --accent-ink:#0d1a2b; --focus:#6da7ec;
    --bar:#3987e5; --bar-soft:#1c3352; --ref:#b4bbc5;
    --crit-bg:#3a1f1f; --ser-bg:#3b2619; --warn-bg:#3a3014; --good-bg:#1a3220; --neutral-bg:#23272c; --info-bg:#1c2f4a;
  }
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#121416; --surface:#1b1e22; --surface-2:#23272c; --ink:#f1f3f5; --ink-2:#b4bbc5; --ink-3:#7f8894;
  --line:#2b3037; --line-2:#3a4048; --accent:#6da7ec; --accent-ink:#0d1a2b; --focus:#6da7ec;
  --bar:#3987e5; --bar-soft:#1c3352; --ref:#b4bbc5;
  --crit-bg:#3a1f1f; --ser-bg:#3b2619; --warn-bg:#3a3014; --good-bg:#1a3220; --neutral-bg:#23272c; --info-bg:#1c2f4a;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font-body);padding-inline:20px;padding-block:36px 72px;-webkit-font-smoothing:antialiased}
.page{max-width:1200px;margin:0 auto;display:grid;gap:44px}
h1,h2,h3{font-family:var(--font-display);margin:0;text-wrap:balance;letter-spacing:-0.01em}
h1{font-size:clamp(28px,4vw,38px);font-weight:700;line-height:1.1}
h2{font-size:20px;font-weight:600}
h3{font-size:15px;font-weight:600}
p{margin:0}
a{color:var(--accent)}
.eyebrow{font-family:var(--font-display);font-size:11.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
.mono{font-family:var(--font-mono);font-size:.92em}
.num{font-variant-numeric:tabular-nums}
.muted{color:var(--ink-2)}
.faint{color:var(--ink-3)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}

/* masthead */
.masthead{display:grid;gap:14px;padding-bottom:28px;border-bottom:1px solid var(--line)}
.masthead .lede{max-width:68ch;color:var(--ink-2);font-size:16px}
.stamp{display:flex;flex-wrap:wrap;gap:6px 22px;font-family:var(--font-mono);font-size:12px;color:var(--ink-3)}
.stamp b{color:var(--ink-2);font-weight:500}

/* section heads */
section{display:grid;gap:18px}
.sec-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 20px}
.sec-head p{color:var(--ink-2);max-width:72ch}

/* kpis */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:14px}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:16px 18px 14px;display:grid;gap:4px;align-content:start}
.kpi .label{font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-family:var(--font-display)}
.kpi .value{font-family:var(--font-display);font-size:34px;font-weight:700;line-height:1.05;font-variant-numeric:tabular-nums;margin-top:6px}
.kpi .sub{font-size:12.5px;color:var(--ink-2)}
.kpi.hero{border-color:var(--crit);border-width:1px;box-shadow:inset 4px 0 0 var(--crit)}

/* controls */
.controls{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:end;padding:14px 16px;background:var(--surface);border:1px solid var(--line);border-radius:6px}
.ctl{display:grid;gap:4px;font-size:12px;color:var(--ink-2)}
.ctl label{font-weight:500}
.ctl input,.ctl select{font:14px var(--font-body);color:var(--ink);background:var(--bg);border:1px solid var(--line-2);border-radius:4px;padding:6px 8px;min-width:0}
.ctl input[type=number]{width:84px}
.ctl input[type=search]{width:220px;max-width:100%}
.ctl.check{display:flex;align-items:center;gap:8px;padding-bottom:7px;font-size:13px;color:var(--ink)}
.ctl.check input{width:16px;height:16px;margin:0}
.controls .count{margin-left:auto;font-size:13px;color:var(--ink-2);padding-bottom:7px}

/* chips */
.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;letter-spacing:.02em;white-space:nowrap;color:var(--ink);background:var(--neutral-bg);border:1px solid transparent}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ink-3);flex:none}
.chip.crit{background:var(--crit-bg)}.chip.crit::before{background:var(--crit)}
.chip.ser{background:var(--ser-bg)}.chip.ser::before{background:var(--ser)}
.chip.warn{background:var(--warn-bg)}.chip.warn::before{background:var(--warn)}
.chip.good{background:var(--good-bg)}.chip.good::before{background:var(--good)}
.chip.info{background:var(--info-bg)}.chip.info::before{background:var(--accent)}
.chips{display:flex;flex-wrap:wrap;gap:5px}

/* chart */
.chart{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:18px 18px 14px;display:grid;gap:12px}
.chart-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 16px;align-items:baseline}
.chart-head .legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12.5px;color:var(--ink-2)}
.legend .sw{display:inline-block;width:14px;height:10px;background:var(--bar);border-radius:0 3px 3px 0;vertical-align:-1px;margin-right:6px}
.legend .swl{display:inline-block;width:0;height:12px;border-left:2px dashed var(--ref);vertical-align:-2px;margin-right:8px}
.chart-body{--lw:230px;--vw:110px;--gap:14px;position:relative;display:grid;gap:6px}
.brow{display:grid;grid-template-columns:var(--lw) 1fr var(--vw);gap:var(--gap);align-items:center;min-height:26px}
.brow .lbl{display:flex;flex-direction:column;line-height:1.2;min-width:0}
.brow .lbl .n{font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brow .lbl .i{font-family:var(--font-mono);font-size:11px;color:var(--ink-3)}
.brow .track{position:relative;height:24px;cursor:default}
.brow .bar{position:absolute;left:0;top:2px;height:20px;background:var(--bar);border-radius:0 4px 4px 0;min-width:2px}
.brow .val{font-variant-numeric:tabular-nums;font-size:13px;white-space:nowrap}
.brow .val small{color:var(--ink-3);font-size:11.5px}
.brow .track:hover .bar{filter:brightness(1.08)}
.refline{position:absolute;top:0;bottom:0;width:0;border-left:2px dashed var(--ref);pointer-events:none;left:calc(var(--lw) + var(--gap) + (100% - var(--lw) - var(--vw) - 2 * var(--gap)) * var(--frac))}
.refline span{position:absolute;top:-4px;left:6px;transform:translateY(-100%);font-size:11px;color:var(--ink-2);white-space:nowrap;background:var(--surface);padding:0 4px}
.chart-body.has-ref{padding-top:22px}
.axis{display:grid;grid-template-columns:var(--lw) 1fr var(--vw);gap:var(--gap);font-size:11px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.axis .ticks{position:relative;height:14px;border-top:1px solid var(--line)}
.axis .ticks span{position:absolute;top:1px;transform:translateX(-50%)}
.tip{position:fixed;z-index:20;pointer-events:none;background:var(--ink);color:var(--bg);font-size:12.5px;line-height:1.45;padding:8px 10px;border-radius:5px;max-width:280px;box-shadow:0 4px 14px rgba(0,0,0,.18);display:none}
.tip b{font-weight:600}
.tip .r{display:flex;justify-content:space-between;gap:14px;font-variant-numeric:tabular-nums}
.chart-empty{color:var(--ink-3);font-size:13px;padding:8px 0}

/* table */
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;min-width:960px;font-size:13.5px}
thead th{position:sticky;top:0;background:var(--surface-2);font-family:var(--font-display);font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
thead th.r,td.r{text-align:right}
tbody td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr.acct{cursor:pointer}
tbody tr.acct:hover td{background:color-mix(in srgb,var(--surface-2) 60%,var(--surface))}
tbody tr.acct.open td{background:var(--surface-2)}
tbody tr.acct td:first-child{box-shadow:inset 4px 0 0 transparent}
tbody tr.acct.sev-crit td:first-child{box-shadow:inset 4px 0 0 var(--crit)}
tbody tr.acct.sev-ser td:first-child{box-shadow:inset 4px 0 0 var(--ser)}
tbody tr.acct.sev-warn td:first-child{box-shadow:inset 4px 0 0 var(--warn)}
tbody tr.acct.sev-good td:first-child{box-shadow:inset 4px 0 0 var(--good)}
td .name{font-weight:600}
td .sub{display:block;font-size:12px;color:var(--ink-2);margin-top:1px}
td .sub.mono{font-size:11.5px}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
td .big{font-weight:600;font-size:14.5px}
td .tiny{display:block;font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.tgl{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid var(--line-2);border-radius:4px;background:var(--surface);color:var(--ink-2);font-size:14px;line-height:1;cursor:pointer}
tr.open .tgl{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
tr.detail td{background:var(--bg);padding:16px 14px 20px 16px}
.detail-grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(280px,2fr);gap:20px}
.detail-grid h3{margin-bottom:8px}
.ptable{width:100%;min-width:0;font-size:12.5px;border:1px solid var(--line);background:var(--surface)}
.ptable th{position:static;font-size:10.5px;padding:7px 9px;background:var(--surface-2)}
.ptable td{padding:6px 9px;border-bottom:1px solid var(--line)}
.ptable tr:last-child td{border-bottom:0}
.ptable .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--good);vertical-align:0}
.ptable .dot.no{background:var(--line-2)}
.ptable tr.unused td{color:var(--ink-3)}
.side{display:grid;gap:18px;align-content:start}
.vials{display:grid;gap:6px;font-size:12.5px}
.vial{display:grid;grid-template-columns:96px 1fr 60px;gap:10px;align-items:center}
.vial .vb{height:10px;background:var(--bar);border-radius:0 3px 3px 0}
.vial .vt{position:relative;height:12px}
.vial .vn{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.orphans{font-size:12.5px;display:grid;gap:4px}
.orphans li{display:flex;justify-content:space-between;gap:12px}
.orphans ul{margin:0;padding:0;list-style:none;display:grid;gap:4px}
.facts{font-size:12.5px;color:var(--ink-2);display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0}
.facts dt{color:var(--ink-3)}
.facts dd{margin:0;color:var(--ink);font-variant-numeric:tabular-nums}
.note{font-size:12.5px;color:var(--ink-2);background:var(--info-bg);padding:8px 10px;border-radius:4px}

/* clusters */
.clusters{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.cluster{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:14px 16px;display:grid;gap:10px;align-content:start}
.cluster .accts{display:grid;gap:6px;font-size:13px}
.cluster .acct{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:baseline}
.cluster .acct .who{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cluster .acct .who b{font-weight:600}
.cluster .acct .st{font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.cluster .why{font-size:12px;color:var(--ink-2)}
.cluster .why .brand{display:inline-block;background:var(--neutral-bg);border-radius:3px;padding:1px 6px;margin:2px 3px 0 0;font-size:11.5px}
.sharedwrap{overflow-x:auto}
.shared{width:100%;min-width:600px;font-size:13px}
.shared td .who{font-size:12px;color:var(--ink-2)}

/* method */
.method{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px 32px;font-size:13.5px;color:var(--ink-2)}
.method h3{color:var(--ink)}
.method dl{margin:0;display:grid;gap:8px}
.method dt{color:var(--ink);font-weight:600}
.method dd{margin:0}
.method ul{margin:0;padding-left:18px;display:grid;gap:6px}

@media (max-width:760px){
  body{padding-inline:16px;padding-block:24px 56px}
  .page{gap:32px}
  .chart-body{--lw:132px;--vw:78px;--gap:10px}
  .brow .lbl .n{font-size:12px}
  .detail-grid{grid-template-columns:1fr}
  .controls .count{margin-left:0}
  .refline span{font-size:10px}
}
@media (prefers-reduced-motion:no-preference){
  .brow .bar{transition:width .35s ease}
}

/* prose — for converted SOPs and any document written as plain semantic HTML.
   Wrap the body copy in <article class="prose"> (or <main class="prose">). */
.prose{max-width:76ch;font-size:15.5px;line-height:1.6;display:block}
.prose>*+*{margin-top:.85em}
.prose h1{font-size:30px;margin-top:0}
.prose h2{font-size:22px;margin-top:1.8em;padding-top:.6em;border-top:1px solid var(--line)}
.prose h3{font-size:17px;margin-top:1.4em}
.prose h4{font-family:var(--font-display);font-size:14px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--ink-2);margin-top:1.2em}
.prose p{margin:0}
.prose ul,.prose ol{padding-left:1.4em;display:grid;gap:.35em}
.prose li>ul,.prose li>ol{margin-top:.35em}
.prose blockquote{margin:0;padding:10px 14px;border-left:3px solid var(--accent);background:var(--surface);color:var(--ink-2)}
.prose code{font-family:var(--font-mono);font-size:.9em;background:var(--surface-2);padding:1px 5px;border-radius:3px}
.prose pre{margin:0;padding:12px 14px;background:var(--surface-2);border:1px solid var(--line);border-radius:6px;overflow-x:auto;font-family:var(--font-mono);font-size:12.5px;line-height:1.5}
.prose pre code{background:none;padding:0;font-size:inherit}
.prose table{border-collapse:collapse;width:100%;min-width:0;font-size:13.5px;display:table}
.prose thead th{position:static;background:var(--surface-2);font-family:var(--font-display);font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
.prose tbody td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.prose figure{margin:0;display:grid;gap:6px}
.prose figcaption{font-size:12.5px;color:var(--ink-3)}
.prose img{max-width:100%;height:auto;border-radius:4px}
.prose hr{border:0;border-top:1px solid var(--line);margin:1.5em 0}
.prose a{color:var(--accent);text-underline-offset:2px}
.prose .callout{padding:10px 14px;border-radius:6px;background:var(--info-bg);font-size:14px}
.prose .callout.warn{background:var(--warn-bg)}
.prose .callout.crit{background:var(--crit-bg)}
/* controlled-document header block for SOPs: code · revision · effective · owner */
.doc-control{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px 18px;padding:12px 16px;background:var(--surface);border:1px solid var(--line);border-radius:6px;font-size:13px}
.doc-control div{display:grid;gap:2px}
.doc-control dt,.doc-control .k{font-family:var(--font-display);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.doc-control dd,.doc-control .v{margin:0;font-variant-numeric:tabular-nums}
```
