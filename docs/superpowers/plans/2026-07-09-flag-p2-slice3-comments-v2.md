# Flag P2 Slice 3 — Comments v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Markdown-lite comment rendering (bold/italic/code/code-block/lists/links + bare-URL linkify, composing with existing @mentions), a light composer toolbar (B/I/code/list/link + Ctrl+B/I) over a plain textarea, image attachments (paste/drag → upload → inline `<img>` with click-to-full-size, backed by a new storage seam), and curated emoji reactions on comments with live SSE updates — all additive to the Phase-1 flag thread.

**Architecture:**

- **Rendering** is a pure string pipeline: `markdown-it` (`html:false`, `linkify:true`, image rule disabled) → a custom core rule that substitutes `@mention` tokens and `{attachment:ID}` tokens **only on `text` tokens** (code spans / fences are distinct token types, so anything inside them stays literal — this is the authoritative resolution of the spec's "mentions parse before markdown so `@name` in code stays literal" self-contradiction: the *goal* wins, and the token-stream approach makes it fall out for free) → `dompurify` sanitize backstop. Mentions render as a `<span class="flag-mention">`; attachments render as `<img class="flag-attach" data-attachment-id="ID">` **with no `src`** — a React effect resolves each to a bearer-authed blob object URL (a plain `<img src>` to the authed endpoint would 401; this mirrors `fetchPackagingPhotoUrl` in `src/lib/api.ts`).
- **Attachments** get a new `flag_attachments` table, a `POST /api/flags/{id}/attachments` **multipart** upload (magic-byte sniffed, ~10 MB cap, **sync `def` route** so the blocking DB + storage `put` run in the threadpool — NOT `async def`, per the documented event-loop-blocking incident), an authed `GET /api/flags/attachments/{id}` serve, and a new **module-pure** `attachment_storage` seam (host wires an S3-backed adapter in `main.py`; the flags module never imports boto3 or host modules).
- **Reactions** get a new `flag_comment_reactions` table (unique `(comment_id, user_id, emoji)`), idempotent `PUT`/`DELETE` endpoints, a `reactions` aggregate on `CommentResponse` (populated explicitly after `model_validate` — it can't ride `from_attributes`), and a `comment_reaction` SSE event emitted **directly to the sink (no `flag_events` row, no `updated_at` bump, no `_audit`)** so reactions never mark a thread unread or DM.

**Tech Stack:** React 18 + TypeScript + shadcn (Textarea/Tooltip/Button) + TanStack Query (frontend); FastAPI + SQLAlchemy + Pydantic v2 (backend). New deps: `markdown-it` + `dompurify` (pinned, npm only). Spec: `docs/superpowers/specs/2026-07-09-flag-system-phase2-design.md` §6 (+ §2 decisions, §10 analytics, §11 security).

## Global Constraints

- **npm only** for the Accu-Mk1 frontend (never pnpm/yarn). New deps pinned with `--save-exact`; commit `package-lock.json`.
- **Additive only** — no mass reformats, no behavior change to existing flag flows. Existing plain-text comments must render unchanged (markdown is a superset — spec §2). Failing baseline tests default to "stale test," not "code wrong."
- **Module purity** — `backend/flags/` imports no Mk1 host models and no boto3. Host knowledge (S3 storage, user display) enters only via `seams.py`. The FE resolves display names client-side via `useFlagUsers()`.
- **Migrations** = idempotent SQL strings appended to the `flags module` block in `backend/database.py` (~line 796–917), same idiom as the existing `flag_*` statements (per-statement isolation; SQLite test path swallows Postgres-only statements). Every new table is defined **twice**: a SQLAlchemy model (so the test path's `create_all` builds it) AND raw idempotent SQL (Postgres prod).
- **No new SSE endpoints** — `comment_reaction` and `attachment_added` ride the existing `/api/flags/stream` bus (spec §12), so no nginx unbuffered-location work.
- **Analytics (§10):** `attachment_added` writes a `flag_events` row with real `actor_id`; reactions are **intentionally NOT** in `flag_events` (the reactions table is the analytics source).
- **Reactions must not mark threads unread** — no toast, no Slack DM, no unread bump, no `flag_events` row, `flag.updated_at` untouched.
- **Test gates** — per task: `npx vitest run <file>` (FE) / `python -m pytest <file> -q` (BE). Slice end: `npm run check:all` + `npm run build` + `python -m pytest backend/tests -q`, gated by **new-failure-set diff** vs the known baseline (~19 backend / 34 frontend known failures), never raw counts.
- **Branch:** `feat/flag-p2-comments` off `feat/flag-p2-tasks` (this slice stacks on Slice 2's nullable-anchor schema; do NOT branch off master). Commit after every task. **Final task = gates only, NO push/PR.**
- **Orphan attachment GC is Slice 5's job** (the scheduler deletes uploads left with `comment_id IS NULL` after 24 h) — NOT this slice. Just leave unreferenced rows.

---

### Task 1: Backend — `attachment_storage` seam (Protocol + defaults)

**Files:**
- Modify: `backend/flags/seams.py` (add the storage Protocol, in-memory + filesystem impls, singleton accessors)
- Test: `backend/tests/test_flags_attachment_storage.py` (create)

**Interfaces:**
- Produces:
  - `class AttachmentStorage(Protocol)` — `save(self, flag_id: str, data: bytes, filename: str) -> str` (returns opaque storage key), `fetch(self, key: str) -> bytes` (raises `AttachmentNotFound`), `delete(self, key: str) -> None` (idempotent).
  - `class AttachmentNotFound(LookupError)`, `class AttachmentStorageError(RuntimeError)`.
  - `class InMemoryAttachmentStorage` (test/dev default), `class FilesystemAttachmentStorage` (prod default under `MK1_FLAG_ATTACH_DIR`, default `/data/flag_attachments`).
  - `get_attachment_storage() -> AttachmentStorage` (lazy — instantiates `FilesystemAttachmentStorage` on first use so import never touches disk), `set_attachment_storage(s)` (host wiring), `set_attachment_storage_for_tests(s)`.
- Consumes: stdlib only (`os`, `uuid`, `pathlib`) — mirrors `backend/sub_samples/photo_storage.py` but lives inside the flags module with no boto3.

- [ ] **Step 1: Write the failing test**

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import pytest


def test_inmemory_roundtrip_and_notfound():
    from flags import seams
    s = seams.InMemoryAttachmentStorage()
    key = s.save("7", b"\x89PNG\r\n\x1a\nrest", "upload.png")
    assert key and s.fetch(key) == b"\x89PNG\r\n\x1a\nrest"
    s.delete(key)
    with pytest.raises(seams.AttachmentNotFound):
        s.fetch(key)


def test_filesystem_roundtrip(tmp_path):
    from flags import seams
    s = seams.FilesystemAttachmentStorage(root=str(tmp_path))
    key = s.save("7", b"abc", "x.jpg")
    assert (tmp_path / key).exists()
    assert s.fetch(key) == b"abc"
    s.delete(key)  # idempotent
    s.delete(key)


def test_filesystem_refuses_traversal(tmp_path):
    from flags import seams
    s = seams.FilesystemAttachmentStorage(root=str(tmp_path))
    with pytest.raises(seams.AttachmentStorageError):
        s.fetch("../escape")


def test_singleton_override_for_tests():
    from flags import seams
    mem = seams.InMemoryAttachmentStorage()
    seams.set_attachment_storage_for_tests(mem)
    assert seams.get_attachment_storage() is mem
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_flags_attachment_storage.py -q`
Expected: FAIL — `AttachmentStorage`/`InMemoryAttachmentStorage` don't exist yet (ImportError).

- [ ] **Step 3: Implement** — append to `backend/flags/seams.py` (after the event-sink section, before `register_mk1_entities`). Add the stdlib imports (`os`, `uuid`, `Protocol`, `Path`) at the top of the file if absent:

```python
# --- attachment storage seam (Plan 3) ------------------------------------
# The flags module never imports boto3 or host storage modules. The host wires
# an S3-backed adapter (see main.py) that satisfies this Protocol; the default
# is a local filesystem store so dev/test work with zero config.
import os
import uuid
from pathlib import Path
from typing import Protocol


class AttachmentNotFound(LookupError):
    """fetch() could not locate a key."""


class AttachmentStorageError(RuntimeError):
    """Any storage-layer failure (bad key, write/read error)."""


class AttachmentStorage(Protocol):
    def save(self, flag_id: str, data: bytes, filename: str) -> str: ...
    def fetch(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...


def _attach_ext(filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    return ext if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp"} else ".bin"


class InMemoryAttachmentStorage:
    """No-disk store for tests/dev. Key = 'flag_id/uuid.ext'."""
    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}

    def save(self, flag_id: str, data: bytes, filename: str) -> str:
        key = f"{flag_id}/{uuid.uuid4().hex}{_attach_ext(filename)}"
        self._blobs[key] = data
        return key

    def fetch(self, key: str) -> bytes:
        if key not in self._blobs:
            raise AttachmentNotFound(key)
        return self._blobs[key]

    def delete(self, key: str) -> None:
        self._blobs.pop(key, None)


class FilesystemAttachmentStorage:
    """Prod default. One file per attachment under {root}/{flag_id}/{uuid}.{ext}."""
    def __init__(self, root: str | None = None) -> None:
        self.root = Path(root or os.environ.get("MK1_FLAG_ATTACH_DIR", "/data/flag_attachments"))
        self.root.mkdir(parents=True, exist_ok=True)

    def save(self, flag_id: str, data: bytes, filename: str) -> str:
        rel = f"{flag_id}/{uuid.uuid4().hex}{_attach_ext(filename)}"
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return rel

    def fetch(self, key: str) -> bytes:
        p = self._safe(key)
        if not p.exists():
            raise AttachmentNotFound(key)
        return p.read_bytes()

    def delete(self, key: str) -> None:
        p = self._safe(key)
        if p.exists():
            p.unlink()

    def _safe(self, key: str) -> Path:
        if not key or key.startswith("/") or ".." in key.split("/"):
            raise AttachmentStorageError(f"unsafe key: {key!r}")
        resolved = (self.root / key).resolve()
        try:
            resolved.relative_to(self.root.resolve())
        except ValueError as e:
            raise AttachmentStorageError(f"key escapes root: {key!r}") from e
        return resolved


_ATTACHMENT_STORAGE: "AttachmentStorage | None" = None


def get_attachment_storage() -> "AttachmentStorage":
    global _ATTACHMENT_STORAGE
    if _ATTACHMENT_STORAGE is None:
        _ATTACHMENT_STORAGE = FilesystemAttachmentStorage()
    return _ATTACHMENT_STORAGE


def set_attachment_storage(storage: "AttachmentStorage") -> None:
    global _ATTACHMENT_STORAGE
    _ATTACHMENT_STORAGE = storage


def set_attachment_storage_for_tests(storage: "AttachmentStorage") -> None:
    set_attachment_storage(storage)
```

- [ ] **Step 4: Run to verify it passes** — same command, expected PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): attachment_storage seam (protocol + fs/memory defaults)"`

---

### Task 2: Backend — attachments table, model, service, routes, host S3 wiring

**Files:**
- Modify: `backend/flags/models.py` (add `FlagAttachment`)
- Modify: `backend/database.py` (append `flag_attachments` DDL + indexes to the flags migration block, after the `mentions` ALTER at ~line 917)
- Modify: `backend/flags/service.py` (`add_attachment`, `get_attachment`, `_sniff_image`, `_link_attachments`, call `_link_attachments` inside `add_comment`)
- Modify: `backend/flags/schemas.py` (`AttachmentResponse`)
- Modify: `backend/flags/routes.py` (`POST /{flag_id}/attachments` multipart, `GET /attachments/{attachment_id}` serve)
- Modify: `backend/main.py` (host S3 adapter wiring in lifespan, after `register_mk1_entities()`)
- Test: `backend/tests/test_flags_attachments.py` (create; reuse the `client` fixture idiom from `test_flags_routes.py`)

**Interfaces:**
- Produces:
  - `FlagAttachment` ORM: `id, flag_id (FK CASCADE, not null), comment_id (FK flag_comments SET NULL, nullable), uploaded_by (int, nullable), filename (text), content_type (text), size_bytes (int), storage_key (text), created_at`.
  - `service.add_attachment(db, *, user, flag_id, data: bytes, filename: str) -> FlagAttachment` — sniffs magic bytes, enforces `MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024`, saves via `seams.get_attachment_storage()`, writes an `attachment_added` audit+sink event (`details={"attachment_id", "body_excerpt": "📎 image"}`), does **not** bump `flag.updated_at`.
  - `service.get_attachment(db, attachment_id) -> FlagAttachment` (raises `NotFoundError`).
  - `service._link_attachments(db, flag_id, comment_id, body)` — sets `comment_id` on `flag_attachments` rows whose id appears as `{attachment:ID}` in `body`, scoped to the flag and only where `comment_id IS NULL`.
  - `AttachmentResponse` schema (mirrored FE-side in Task 7 as `FlagAttachment`).
  - Route `POST /api/flags/{flag_id}/attachments` → 201 `AttachmentResponse` (multipart field `file`); route `GET /api/flags/attachments/{attachment_id}` → raw bytes `Response(media_type=content_type)`.
- Consumes: Task 1 seam; existing `_audit`, `_commit_and_emit`, `permissions.can(user, "comment", flag)`, `_http`.

- [ ] **Step 1: Write the failing test**

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

_PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
_NOT_IMAGE = b"%PDF-1.4 not an image"


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.set_attachment_storage_for_tests(seams.InMemoryAttachmentStorage())
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    types_service.seed_builtins(shared)

    def _db():
        yield shared
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    yield tc
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    shared.close()


def _new_flag(client):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                        "type": "blocker", "title": "t"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_upload_sniffs_image_and_serves_bytes(client):
    fid = _new_flag(client)
    up = client.post(f"/api/flags/{fid}/attachments",
                     files={"file": ("shot.png", _PNG, "image/png")})
    assert up.status_code == 201, up.text
    body = up.json()
    assert body["content_type"] == "image/png" and body["comment_id"] is None
    got = client.get(f"/api/flags/attachments/{body['id']}")
    assert got.status_code == 200 and got.content == _PNG
    assert got.headers["content-type"].startswith("image/png")


def test_upload_rejects_non_image_by_magic_bytes(client):
    fid = _new_flag(client)
    # content-type header LIES ("image/png") — magic-byte sniff must reject.
    up = client.post(f"/api/flags/{fid}/attachments",
                     files={"file": ("x.png", _NOT_IMAGE, "image/png")})
    assert up.status_code == 400, up.text


def test_comment_links_attachment_and_emits_event(client):
    from flags import seams
    fid = _new_flag(client)
    aid = client.post(f"/api/flags/{fid}/attachments",
                      files={"file": ("s.png", _PNG, "image/png")}).json()["id"]
    # attachment_added rode the sink
    assert any(e["event_type"] == "attachment_added"
               for e in seams.EVENT_SINK.events)
    c = client.post(f"/api/flags/{fid}/comments",
                    json={"body": "see {attachment:%d}" % aid})
    assert c.status_code == 201
    detail = client.get(f"/api/flags/{fid}").json()
    att_row = detail  # attachment now FKs the comment
    # re-fetch the attachment row via a fresh upload-less path: assert linkage in DB
    from flags.models import FlagAttachment
    linked = client.app.dependency_overrides  # noqa: F841  (DB asserted below via service)
```

(The last test's DB assertion is awkward through the client; instead assert linkage directly against the shared session. Replace the final three lines with a service-level check using the fixture's session — grab it via a module-level helper, or split into a `service`-level test mirroring `test_flags_service_actions.py`'s `db` fixture. Prefer a second small test file `test_flags_attachments_service.py` using the in-memory `db` fixture for the `_link_attachments` + `add_attachment` unit assertions; keep the `client` file for HTTP behavior.)

- [ ] **Step 2: Run — FAIL**

Run: `cd backend && python -m pytest tests/test_flags_attachments.py -q`
Expected: FAIL — route + model don't exist (404 / ImportError).

- [ ] **Step 3: Implement.**

`backend/flags/models.py` — add after `FlagRead`:

```python
class FlagAttachment(Base):
    """An uploaded image on a flag. Linked to a comment (comment_id) once the
    comment referencing {attachment:ID} is saved; unlinked rows are GC'd by the
    scheduler (Plan 5)."""
    __tablename__ = "flag_attachments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    comment_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("flag_comments.id", ondelete="SET NULL"), nullable=True, index=True)
    uploaded_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
```

`backend/database.py` — append to the `migrations` list inside the flags block (after the `flag_comments … ADD COLUMN … mentions` statement, ~line 917):

```python
        # --- flag attachments (Plan 3) ---
        """
        CREATE TABLE IF NOT EXISTS flag_attachments (
            id           SERIAL PRIMARY KEY,
            flag_id      INTEGER NOT NULL REFERENCES flag_flags(id) ON DELETE CASCADE,
            comment_id   INTEGER REFERENCES flag_comments(id) ON DELETE SET NULL,
            uploaded_by  INTEGER,
            filename     TEXT NOT NULL,
            content_type TEXT NOT NULL,
            size_bytes   INTEGER NOT NULL,
            storage_key  TEXT NOT NULL,
            created_at   TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_attachments_flag ON flag_attachments (flag_id)",
        "CREATE INDEX IF NOT EXISTS ix_flag_attachments_comment ON flag_attachments (comment_id)",
```

`backend/flags/service.py` — add the sniffer, cap, attachment ops, and the linker; import `re` and `FlagAttachment`:

```python
import re
from flags.models import FlagAttachment  # add to the existing models import line

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
_ATTACHMENT_TOKEN = re.compile(r"\{attachment:(\d+)\}")


def _sniff_image(data: bytes) -> str:
    """Return the image content-type from magic bytes; raise on non-image.
    Do NOT trust the client's Content-Type header (spec §11)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise BadRequestError("attachment must be a PNG, JPEG, GIF, or WEBP image")


_EXT_FOR_CT = {"image/png": ".png", "image/jpeg": ".jpg",
               "image/gif": ".gif", "image/webp": ".webp"}


def add_attachment(db: Session, *, user, flag_id, data: bytes, filename: str) -> FlagAttachment:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "comment", flag):
        raise PermissionDeniedError("not allowed to attach")
    if not data:
        raise BadRequestError("empty upload")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise BadRequestError("attachment exceeds 10 MB")
    content_type = _sniff_image(data)
    actor_id = getattr(user, "id", None)
    key = seams.get_attachment_storage().save(str(flag.id), data, f"upload{_EXT_FOR_CT[content_type]}")
    att = FlagAttachment(flag_id=flag.id, comment_id=None, uploaded_by=actor_id,
                         filename=(filename or f"upload{_EXT_FOR_CT[content_type]}")[:255],
                         content_type=content_type, size_bytes=len(data), storage_key=key)
    db.add(att)
    db.flush()  # populate att.id for the event detail
    # attachment_added is analytics+audit (real actor_id). It does NOT bump
    # updated_at — the comment that references it is the unread trigger.
    _audit(db, flag, actor_id, "attachment_added",
           details={"attachment_id": att.id, "body_excerpt": "📎 image"})
    _commit_and_emit(db)
    db.refresh(att)
    return att


def get_attachment(db: Session, attachment_id: int) -> FlagAttachment:
    att = db.get(FlagAttachment, attachment_id)
    if att is None:
        raise NotFoundError(f"attachment {attachment_id} not found")
    return att


def _link_attachments(db: Session, flag_id: int, comment_id: int, body: str) -> None:
    """FK the {attachment:ID} tokens in a saved comment's body back to it, so
    they survive orphan GC. Only unlinked rows on THIS flag are claimed."""
    ids = {int(m) for m in _ATTACHMENT_TOKEN.findall(body or "")}
    if not ids:
        return
    for att in db.execute(select(FlagAttachment).where(
            FlagAttachment.flag_id == flag_id,
            FlagAttachment.id.in_(ids),
            FlagAttachment.comment_id.is_(None))).scalars():
        att.comment_id = comment_id
```

In `add_comment`, after `db.add(c)` and before the watcher loop, flush to get `c.id` then link:

```python
    db.add(c)
    db.flush()                       # populate c.id for attachment linkage
    _link_attachments(db, flag.id, c.id, body)
```

`backend/flags/schemas.py` — add:

```python
class AttachmentResponse(BaseModel):
    id: int
    flag_id: int
    comment_id: Optional[int] = None
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)
```

`backend/flags/routes.py` — add `File, UploadFile` to the `fastapi` import, `AttachmentResponse` to the schemas import, and register the serve route in the literal-before-param block (above `@router.get("/{flag_id}")`) plus the upload route with the other `/{flag_id}/…` mutations:

```python
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status

# ... in the literal-route section (above GET /{flag_id}) ...
@router.get("/attachments/{attachment_id}")
def get_attachment(attachment_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    from fastapi.responses import Response
    try:
        att = service.get_attachment(db, attachment_id)
        data = seams.get_attachment_storage().fetch(att.storage_key)
    except seams.AttachmentNotFound:
        raise HTTPException(status_code=404, detail="attachment file missing from storage")
    except Exception as e:
        raise _http(e)
    return Response(content=data, media_type=att.content_type)


# ... with the /{flag_id}/… routes. SYNC def (not async) so the blocking storage
# put + DB write run in the threadpool, per the event-loop-blocking incident. ...
@router.post("/{flag_id}/attachments", response_model=AttachmentResponse, status_code=201)
def add_attachment(flag_id: int, file: UploadFile = File(...),
                   db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        data = file.file.read()   # sync read of the spooled upload; threadpool-safe
        att = service.add_attachment(db, user=user, flag_id=flag_id, data=data,
                                     filename=file.filename or "upload")
        return AttachmentResponse.model_validate(att)
    except Exception as e:
        raise _http(e)
```

`backend/main.py` — in `lifespan`, after `_flag_seams.register_mk1_entities()`, wire the S3 adapter when the vial-photo S3 bucket is configured (reuses `S3PhotoStorage`; keeps flags boto3-free):

```python
    # Flag attachments reuse the S3 blob store used by vial photos when
    # configured (module purity: the adapter lives here, not in flags/).
    if os.environ.get("MK1_PHOTO_S3_BUCKET"):
        from sub_samples.photo_storage import S3PhotoStorage, PhotoNotFoundError

        class _S3FlagAttachmentStorage:
            def __init__(self):
                self._s3 = S3PhotoStorage(
                    prefix=os.environ.get("MK1_FLAG_ATTACH_S3_PREFIX", "flag-attachments/"))

            def save(self, flag_id, data, filename):
                return self._s3.save_photo(flag_id, data, filename)

            def fetch(self, key):
                try:
                    return self._s3.fetch_photo(key)
                except PhotoNotFoundError as e:
                    raise _flag_seams.AttachmentNotFound(str(e))

            def delete(self, key):
                self._s3.delete_photo(key)

        _flag_seams.set_attachment_storage(_S3FlagAttachmentStorage())
```

- [ ] **Step 4: Run — PASS**, then the whole flag suite: `cd backend && python -m pytest tests -k flag -q` — no new failures vs baseline.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): image attachments (upload/serve/link + host S3 seam)"`

---

### Task 3: Backend — Slack `body_excerpt` markdown-strip

**Files:**
- Modify: `backend/flags/service.py` (`strip_markdown`, `_excerpt_for_comment`; use it where `details = {"body_excerpt": …}` is built in `add_comment`)
- Test: `backend/tests/test_flags_body_excerpt.py` (create)

**Interfaces:**
- Produces: `strip_markdown(text: str) -> str` (drops `**`/`*`/`_`/backticks, `[label](url)` → `label`, list markers, `{attachment:ID}` tokens; keeps `@Name` literal; collapses whitespace). `_excerpt_for_comment(body: str) -> str` → stripped text capped at 140, or `"📎 image"` when the stripped body is empty (image-only comment).
- Consumes: nothing new. The Slack `messages.py` `_esc()` mrkdwn escaping stays unchanged (it escapes the already-plain excerpt).

- [ ] **Step 1: Write the failing test**

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_strip_markdown_plain_passthrough():
    from flags.service import strip_markdown
    assert strip_markdown("just plain text") == "just plain text"


def test_strip_markdown_removes_tokens_keeps_mention():
    from flags.service import strip_markdown
    out = strip_markdown("**bold** _em_ `code` see [docs](http://x) hi @Ann Lee")
    assert "**" not in out and "`" not in out and "](" not in out
    assert "bold" in out and "em" in out and "code" in out and "docs" in out
    assert "@Ann Lee" in out


def test_excerpt_image_only_comment():
    from flags.service import _excerpt_for_comment
    assert _excerpt_for_comment("{attachment:12}") == "📎 image"
    assert _excerpt_for_comment("look {attachment:12}").strip() == "look"


def test_comment_event_excerpt_is_stripped():
    # integration: add_comment stores a plain excerpt on the commented event
    import pytest  # noqa: F401
    from types import SimpleNamespace
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, service, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"V{e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()
    types_service.seed_builtins(db)
    u = SimpleNamespace(id=1, role="standard", email="u@x.t")
    f = service.create_flag(db, user=u, entity_type="sub_sample", entity_id="1",
                            type="blocker", title="t")
    service.add_comment(db, user=u, flag_id=f.id, body="**cloudy** `x`")
    ev = [e for e in seams.EVENT_SINK.events if e["event_type"] == "commented"][-1]
    assert "*" not in ev["details"]["body_excerpt"]
    assert "cloudy" in ev["details"]["body_excerpt"]
```

- [ ] **Step 2: Run — FAIL** (`strip_markdown` missing).

Run: `cd backend && python -m pytest tests/test_flags_body_excerpt.py -q`

- [ ] **Step 3: Implement** — in `backend/flags/service.py` (near the other `re` helpers):

```python
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_INLINE = re.compile(r"[*_`~]+")
_MD_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.MULTILINE)


def strip_markdown(text: str) -> str:
    """Flatten markdown-lite source to plain text for the Slack excerpt.
    Keeps @mentions literal; drops attachment tokens and formatting marks."""
    t = _MD_LINK.sub(r"\1", text or "")           # [label](url) -> label
    t = _ATTACHMENT_TOKEN.sub("", t)              # drop {attachment:ID}
    t = _MD_BULLET.sub("", t)                      # list markers
    t = _MD_INLINE.sub("", t)                      # ** * _ ` ~
    return " ".join(t.split())                     # collapse whitespace/newlines


def _excerpt_for_comment(body: str) -> str:
    return (strip_markdown(body) or "📎 image")[:140]
```

Then in `add_comment`, replace `details = {"body_excerpt": body.strip()[:140]}` with `details = {"body_excerpt": _excerpt_for_comment(body)}`.

- [ ] **Step 4: Run — PASS**; then `python -m pytest tests/test_slack_notify_messages.py -q` (those pass literal excerpts, so they stay green).
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): strip markdown for Slack body_excerpt; image-only -> 📎 image"`

---

### Task 4: Backend — emoji reactions (table, service, routes, aggregate, SSE)

**Files:**
- Modify: `backend/flags/models.py` (add `FlagCommentReaction`)
- Modify: `backend/database.py` (append `flag_comment_reactions` DDL + index to the flags block)
- Modify: `backend/flags/service.py` (`CURATED_EMOJI`, `add_reaction`, `remove_reaction`, `aggregate_reactions`, `_emit_reaction`)
- Modify: `backend/flags/schemas.py` (`ReactionAggregate`; add `reactions` to `CommentResponse`)
- Modify: `backend/flags/routes.py` (`PUT`/`DELETE /comments/{comment_id}/reactions/{emoji}`; populate `reactions` in `get_flag`)
- Test: `backend/tests/test_flags_reactions.py` (create)

**Interfaces:**
- Produces:
  - `FlagCommentReaction` ORM: `id, comment_id (FK flag_comments CASCADE, not null), user_id (int, not null), emoji (text), created_at`; unique `(comment_id, user_id, emoji)`.
  - `service.CURATED_EMOJI: tuple[str, ...]` = `("👍", "✅", "👀", "🎉", "❤️", "😂", "🤔", "🚨")` — **the single canonical list** (`❤️` = U+2764 U+FE0F, `✅`/`👀`/`🚨` carry VS16; the FE constant in Task 8 must byte-match).
  - `service.add_reaction(db, *, user, comment_id, emoji) -> list[dict]` / `remove_reaction(...) -> list[dict]` — idempotent; return that comment's aggregate `[{"emoji", "count", "user_ids"}]`. Reject non-curated emoji (`BadRequestError`), missing comment (`NotFoundError`). Emit `comment_reaction` on the sink; **no `_audit`, no `flag_events` row, no `updated_at` bump**.
  - `service.aggregate_reactions(db, comment_ids) -> dict[int, list[dict]]` (batch — one query, no N+1).
  - `ReactionAggregate` schema `{emoji: str, count: int, user_ids: list[int]}`; `CommentResponse.reactions: List[ReactionAggregate] = []`.
  - Routes `PUT`/`DELETE /api/flags/comments/{comment_id}/reactions/{emoji}` → `List[ReactionAggregate]`.
- Consumes: `seams.EVENT_SINK.emit`, `_flag_summary`, `permissions.can(user, "comment", flag)`.

- [ ] **Step 1: Write the failing test**

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from urllib.parse import quote
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    types_service.seed_builtins(shared)

    def _db():
        yield shared
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    yield tc
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    shared.close()


def _flag_with_comment(client):
    fid = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                          "type": "blocker", "title": "t"}).json()["id"]
    cid = client.post(f"/api/flags/{fid}/comments", json={"body": "hi"}).json()["id"]
    return fid, cid


def test_add_is_idempotent_and_aggregates(client):
    from flags import service
    _fid, cid = _flag_with_comment(client)
    e = quote("👍")
    r1 = client.put(f"/api/flags/comments/{cid}/reactions/{e}")
    r2 = client.put(f"/api/flags/comments/{cid}/reactions/{e}")   # idempotent
    assert r1.status_code == 200 and r2.status_code == 200
    agg = {a["emoji"]: a for a in r2.json()}
    assert agg["👍"]["count"] == 1 and agg["👍"]["user_ids"] == [42]


def test_curated_set_round_trips_every_emoji(client):
    from flags.service import CURATED_EMOJI
    _fid, cid = _flag_with_comment(client)
    for emo in CURATED_EMOJI:
        r = client.put(f"/api/flags/comments/{cid}/reactions/{quote(emo)}")
        assert r.status_code == 200, (emo, r.text)
    detail = client.get(f"/api/flags/{cid and _fid}").json()
    got = {a["emoji"] for a in detail["comments"][0]["reactions"]}
    assert got == set(CURATED_EMOJI)


def test_non_curated_emoji_rejected(client):
    _fid, cid = _flag_with_comment(client)
    assert client.put(f"/api/flags/comments/{cid}/reactions/{quote('🦄')}").status_code == 400


def test_delete_removes_only_own(client):
    _fid, cid = _flag_with_comment(client)
    e = quote("✅")
    client.put(f"/api/flags/comments/{cid}/reactions/{e}")
    d = client.delete(f"/api/flags/comments/{cid}/reactions/{e}")
    assert d.status_code == 200 and d.json() == []


def test_reaction_emits_comment_reaction_without_audit_or_updated_at(client):
    from flags import seams
    fid, cid = _flag_with_comment(client)
    before = client.get(f"/api/flags/{fid}").json()["updated_at"]
    seams.EVENT_SINK.events.clear()
    client.put(f"/api/flags/comments/{cid}/reactions/{quote('🎉')}")
    kinds = [e["event_type"] for e in seams.EVENT_SINK.events]
    assert kinds == ["comment_reaction"]              # nothing else on the sink
    after = client.get(f"/api/flags/{fid}").json()
    assert after["updated_at"] == before              # not bumped
    assert not any(ev["event_type"].startswith("comment_reaction")
                   for ev in after["events"])         # no flag_events row
```

- [ ] **Step 2: Run — FAIL** (`404`/ImportError — routes + model missing).

Run: `cd backend && python -m pytest tests/test_flags_reactions.py -q`

- [ ] **Step 3: Implement.**

`backend/flags/models.py`:

```python
class FlagCommentReaction(Base):
    __tablename__ = "flag_comment_reactions"
    __table_args__ = (UniqueConstraint("comment_id", "user_id", "emoji",
                                       name="uq_flag_comment_reaction"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    comment_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("flag_comments.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    emoji: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
```

`backend/database.py` — append to the flags block:

```python
        # --- flag comment reactions (Plan 3) ---
        """
        CREATE TABLE IF NOT EXISTS flag_comment_reactions (
            id         SERIAL PRIMARY KEY,
            comment_id INTEGER NOT NULL REFERENCES flag_comments(id) ON DELETE CASCADE,
            user_id    INTEGER NOT NULL,
            emoji      TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_flag_comment_reaction UNIQUE (comment_id, user_id, emoji)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_comment_reactions_comment ON flag_comment_reactions (comment_id)",
```

`backend/flags/service.py` — import `FlagComment, FlagCommentReaction`; add:

```python
CURATED_EMOJI = ("👍", "✅", "👀", "🎉", "❤️", "😂", "🤔", "🚨")


def _load_comment(db: Session, comment_id: int) -> FlagComment:
    c = db.get(FlagComment, comment_id)
    if c is None:
        raise NotFoundError(f"comment {comment_id} not found")
    return c


def aggregate_reactions(db: Session, comment_ids) -> dict[int, list[dict]]:
    """Batch: comment_id -> [{emoji, count, user_ids}]. One query, no N+1."""
    ids = list(comment_ids)
    if not ids:
        return {}
    rows = db.execute(select(FlagCommentReaction).where(
        FlagCommentReaction.comment_id.in_(ids))
        .order_by(FlagCommentReaction.id.asc())).scalars().all()
    by_comment: dict[int, dict[str, list[int]]] = {}
    for r in rows:
        by_comment.setdefault(r.comment_id, {}).setdefault(r.emoji, []).append(r.user_id)
    return {cid: [{"emoji": e, "count": len(us), "user_ids": us}
                  for e, us in emo.items()]
            for cid, emo in by_comment.items()}


def _emit_reaction(db: Session, comment: FlagComment, actor_id, emoji: str, action: str) -> None:
    """Fan a reaction onto the SSE bus WITHOUT an audit row or updated_at bump —
    reactions must not mark a thread unread (spec §6). event_id stays None (no
    flag_events row backs it)."""
    flag = db.get(FlagFlag, comment.flag_id)
    seams.EVENT_SINK.emit({
        "event_type": "comment_reaction", "flag_id": comment.flag_id,
        "comment_id": comment.id, "emoji": emoji, "action": action,
        "actor_id": actor_id, "from_value": None, "to_value": None,
        "details": {}, "event_id": None, "flag": _flag_summary(flag),
    })


def add_reaction(db: Session, *, user, comment_id, emoji) -> list[dict]:
    if emoji not in CURATED_EMOJI:
        raise BadRequestError(f"unsupported emoji {emoji!r}")
    comment = _load_comment(db, comment_id)
    if not permissions.can(user, "comment", get_flag(db, comment.flag_id)):
        raise PermissionDeniedError("not allowed to react")
    uid = getattr(user, "id", None)
    existing = db.execute(select(FlagCommentReaction).where(
        FlagCommentReaction.comment_id == comment_id,
        FlagCommentReaction.user_id == uid,
        FlagCommentReaction.emoji == emoji)).scalar_one_or_none()
    if existing is None:
        db.add(FlagCommentReaction(comment_id=comment_id, user_id=uid, emoji=emoji))
        db.commit()
        _emit_reaction(db, comment, uid, emoji, "added")
    return aggregate_reactions(db, [comment_id]).get(comment_id, [])


def remove_reaction(db: Session, *, user, comment_id, emoji) -> list[dict]:
    comment = _load_comment(db, comment_id)
    uid = getattr(user, "id", None)
    row = db.execute(select(FlagCommentReaction).where(
        FlagCommentReaction.comment_id == comment_id,
        FlagCommentReaction.user_id == uid,
        FlagCommentReaction.emoji == emoji)).scalar_one_or_none()
    if row is not None:
        db.delete(row)
        db.commit()
        _emit_reaction(db, comment, uid, emoji, "removed")
    return aggregate_reactions(db, [comment_id]).get(comment_id, [])
```

`backend/flags/schemas.py`:

```python
class ReactionAggregate(BaseModel):
    emoji: str
    count: int
    user_ids: List[int] = Field(default_factory=list)
```

and on `CommentResponse` add: `reactions: List[ReactionAggregate] = Field(default_factory=list)`.

`backend/flags/routes.py` — import `ReactionAggregate`; add the reaction routes (in the literal-before-param section for clarity — `/comments/…` never collides with `/{flag_id}`) and populate reactions in `get_flag`:

```python
@router.put("/comments/{comment_id}/reactions/{emoji}", response_model=List[ReactionAggregate])
def add_reaction(comment_id: int, emoji: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return service.add_reaction(db, user=user, comment_id=comment_id, emoji=emoji)
    except Exception as e:
        raise _http(e)


@router.delete("/comments/{comment_id}/reactions/{emoji}", response_model=List[ReactionAggregate])
def remove_reaction(comment_id: int, emoji: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return service.remove_reaction(db, user=user, comment_id=comment_id, emoji=emoji)
    except Exception as e:
        raise _http(e)


@router.get("/{flag_id}", response_model=FlagDetailResponse)
def get_flag(flag_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        resp = _with_entity(db, service.get_flag(db, flag_id), FlagDetailResponse)
        agg = service.aggregate_reactions(db, [c.id for c in resp.comments])
        for c in resp.comments:
            c.reactions = [ReactionAggregate(**a) for a in agg.get(c.id, [])]
        return resp
    except Exception as e:
        raise _http(e)
```

(Replace the existing `get_flag` body with this — it is the only edit to that route.)

- [ ] **Step 4: Run — PASS**; full `-k flag` suite green (baseline diff only).
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): comment emoji reactions (idempotent PUT/DELETE, SSE, aggregate)"`

---

### Task 5: Frontend — markdown-lite renderer module (+ deps)

**Files:**
- Modify: `package.json` / `package-lock.json` (add `markdown-it`, `dompurify`, `@types/markdown-it`)
- Create: `src/components/flags/comment-markdown.ts`
- Test: `src/components/flags/__tests__/comment-markdown.test.ts`

**Interfaces:**
- Produces:
  - `interface MentionToken { id: number; tok: string }` (`tok` is the `@Display Name` string).
  - `renderCommentHtml(body: string, mentionTokens: MentionToken[]): string` — sanitized HTML. Bold/italic/inline-code/code-block/lists/links; bare URLs linkified with `target="_blank" rel="noopener noreferrer"`; raw HTML escaped; markdown image syntax disabled; `@mention` tokens → `<span class="flag-mention">@Name</span>` (escaped); `{attachment:ID}` tokens → `<img class="flag-attach" data-attachment-id="ID" alt="attachment">` (no `src`). **Substitution runs only on `text` tokens**, so tokens inside code spans/fences stay literal.
- Consumes: `markdown-it`, `dompurify`. Task 6 (`CommentBody`) calls `renderCommentHtml`.

- [ ] **Step 1: Install deps** (npm only, exact-pinned; commit the lockfile):

```
npm install --save-exact markdown-it@14.1.0 dompurify@3.2.4
npm install --save-dev --save-exact @types/markdown-it@14.1.2
```

(If `npm install` resolves a newer patch, pin whatever it writes — the requirement is *pinned + committed lockfile*, not these exact numbers. `dompurify@3` ships its own types; `markdown-it` needs `@types/markdown-it`.)

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { renderCommentHtml } from '@/components/flags/comment-markdown'

const M = [{ id: 7, tok: '@Ann Lee' }]

describe('renderCommentHtml', () => {
  it('plain text renders unchanged (superset claim)', () => {
    expect(renderCommentHtml('just a note', [])).toContain('just a note')
  })
  it('bold/italic/inline-code/lists render', () => {
    const h = renderCommentHtml('**b** _i_ `c`\n\n- one\n- two', [])
    expect(h).toMatch(/<strong>b<\/strong>/)
    expect(h).toMatch(/<em>i<\/em>/)
    expect(h).toMatch(/<code>c<\/code>/)
    expect(h).toMatch(/<li>one<\/li>/)
  })
  it('fenced code block renders', () => {
    expect(renderCommentHtml('```\nx=1\n```', [])).toMatch(/<pre>/)
  })
  it('linkifies bare URLs with hardened rel/target', () => {
    const h = renderCommentHtml('see http://example.com now', [])
    expect(h).toMatch(/<a[^>]+href="http:\/\/example\.com"/)
    expect(h).toMatch(/target="_blank"/)
    expect(h).toMatch(/rel="[^"]*noopener/)
  })
  it('escapes raw HTML (no injection)', () => {
    const h = renderCommentHtml('<script>alert(1)</script>', [])
    expect(h).not.toContain('<script>')
  })
  it('does NOT render markdown image syntax', () => {
    const h = renderCommentHtml('![x](http://evil/p.png)', [])
    expect(h).not.toMatch(/<img[^>]+src=/)
  })
  it('renders a mention as a highlighted span', () => {
    const h = renderCommentHtml('hi @Ann Lee', M)
    expect(h).toMatch(/<span class="flag-mention">@Ann Lee<\/span>/)
  })
  it('leaves @name literal inside inline code', () => {
    const h = renderCommentHtml('`@Ann Lee`', M)
    expect(h).toMatch(/<code>@Ann Lee<\/code>/)
    expect(h).not.toContain('flag-mention')
  })
  it('renders an attachment token as a src-less img', () => {
    const h = renderCommentHtml('shot {attachment:12}', [])
    expect(h).toMatch(/<img[^>]+class="flag-attach"[^>]+data-attachment-id="12"/)
    expect(h).not.toMatch(/<img[^>]+src=/)
  })
})
```

- [ ] **Step 3: Run — FAIL** (module missing).

Run: `npx vitest run src/components/flags/__tests__/comment-markdown.test.ts`

- [ ] **Step 4: Implement** `src/components/flags/comment-markdown.ts`:

```ts
/**
 * Markdown-lite comment renderer (spec §6). A sanitizing pipeline:
 * markdown-it (html:false, linkify:true, image rule disabled) → a core rule
 * that swaps @mention + {attachment:ID} tokens ONLY on `text` tokens (code
 * spans/fences are distinct token types, so their contents stay literal — this
 * is the authoritative resolution of the spec's "mentions parse before markdown
 * so @name in code stays literal": the goal wins) → DOMPurify backstop.
 */
import MarkdownIt from 'markdown-it'
import type { StateCore } from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import DOMPurify from 'dompurify'

export interface MentionToken {
  id: number
  /** The literal `@Display Name` string to match in the body. */
  tok: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const ATTACHMENT_RE = /^\{attachment:(\d+)\}/

/** Split one `text` token into text + injected html_inline (mention/attachment)
 *  tokens. Mentions are matched longest-first so overlapping names win greedily
 *  (mirrors renderCommentSegments in mention-parse.ts). */
function splitTextToken(
  state: StateCore,
  src: Token,
  mentions: MentionToken[]
): Token[] {
  const body = src.content
  const out: Token[] = []
  let buf = ''
  const flush = () => {
    if (!buf) return
    const t = new state.Token('text', '', 0)
    t.content = buf
    out.push(t)
    buf = ''
  }
  const pushHtml = (html: string) => {
    flush()
    const t = new state.Token('html_inline', '', 0)
    t.content = html
    out.push(t)
  }
  let i = 0
  while (i < body.length) {
    const attach = body.slice(i).match(ATTACHMENT_RE)
    if (attach) {
      pushHtml(
        `<img class="flag-attach" data-attachment-id="${attach[1]}" alt="attachment">`
      )
      i += attach[0].length
      continue
    }
    const hit = mentions.find(m => body.startsWith(m.tok, i))
    if (hit) {
      pushHtml(`<span class="flag-mention">${escapeHtml(hit.tok)}</span>`)
      i += hit.tok.length
      continue
    }
    buf += body[i]
    i += 1
  }
  flush()
  return out
}

function flagTokenPlugin(md: MarkdownIt): void {
  md.core.ruler.push('flag_tokens', (state: StateCore) => {
    const env = (state.env ?? {}) as { mentionTokens?: MentionToken[] }
    const mentions = [...(env.mentionTokens ?? [])].sort(
      (a, b) => b.tok.length - a.tok.length
    )
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue
      const next: Token[] = []
      for (const child of block.children) {
        if (child.type === 'text') next.push(...splitTextToken(state, child, mentions))
        else next.push(child) // code_inline / link / etc. — never touched
      }
      block.children = next
    }
  })
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
md.disable('image') // no markdown image syntax — images come from attachments

// Harden every link: open in a new tab, drop referrer + window.opener.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}
md.use(flagTokenPlugin)

/** Render markdown-lite comment body → sanitized HTML string. */
export function renderCommentHtml(
  body: string,
  mentionTokens: MentionToken[]
): string {
  const raw = md.render(body ?? '', { mentionTokens })
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'strong', 'em', 'b', 'i', 'code', 'pre',
      'ul', 'ol', 'li', 'a', 'blockquote', 'span', 'img',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'data-attachment-id', 'alt'],
    // Injected imgs have no src at this stage; the effect sets a blob: URL. This
    // also blocks javascript:/data: on links.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  })
}
```

- [ ] **Step 5: Run — PASS.** Note the `markdown-it/lib/token.mjs` type import path — if the installed 14.x exposes types differently, `import type MarkdownIt from 'markdown-it'` and typing tokens as `MarkdownIt.Token`/`unknown[]` is an acceptable adjustment; keep the runtime logic identical.
- [ ] **Step 6: Commit** — `git commit -m "feat(flags): markdown-lite comment renderer (mentions + attachment tokens)"`

---

### Task 6: Frontend — `CommentBody` (render + attachment blob img + lightbox)

**Files:**
- Create: `src/components/flags/CommentBody.tsx`
- Modify: `src/components/flags/FlagThread.tsx` (replace the `renderCommentSegments(...)` block inside `CommentRow` with `<CommentBody body={comment.body} mentions={comment.mentions ?? []} users={users} />`)
- Modify: `src/lib/flags-api.ts` (add `fetchFlagAttachmentUrl` + `invalidateFlagAttachment` — the blob helpers, mirroring `fetchPackagingPhotoUrl`)
- Test: `src/components/flags/__tests__/CommentBody.test.tsx`

**Interfaces:**
- Consumes: `renderCommentHtml`, `MentionToken` (Task 5); `useFlagUsers`, `nameForUser` (`flag-users.ts`); `fetchFlagAttachmentUrl`.
- Produces: `<CommentBody body={string} mentions={number[]} users={UserMap} />` — sets sanitized HTML via `dangerouslySetInnerHTML`, resolves each `img.flag-attach[data-attachment-id]` to a bearer-authed blob object URL in an effect keyed on the rendered html, and opens a lightbox on attachment-image click (delegated on the container). `fetchFlagAttachmentUrl(id): Promise<string | null>` (blob object URL, cached per id) + `invalidateFlagAttachment(id)` (revokes + evicts).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) => (id == null ? '—' : `User ${id}`),
}))
const fetchUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/flags-api', async orig => ({
  ...(await orig()),
  fetchFlagAttachmentUrl: fetchUrl,
}))

describe('CommentBody', () => {
  beforeEach(() => fetchUrl.mockReset())

  it('renders markdown and resolves attachment blob src', async () => {
    fetchUrl.mockResolvedValue('blob:abc')
    const { CommentBody } = await import('@/components/flags/CommentBody')
    render(<CommentBody body="**hi** {attachment:5}" mentions={[]} users={new Map()} />)
    expect(document.querySelector('strong')?.textContent).toBe('hi')
    await waitFor(() =>
      expect(document.querySelector('img.flag-attach')?.getAttribute('src')).toBe('blob:abc')
    )
    expect(fetchUrl).toHaveBeenCalledWith(5)
  })

  it('opens a lightbox when an attachment image is clicked', async () => {
    fetchUrl.mockResolvedValue('blob:abc')
    const { CommentBody } = await import('@/components/flags/CommentBody')
    render(<CommentBody body="{attachment:5}" mentions={[]} users={new Map()} />)
    const img = await waitFor(() => {
      const el = document.querySelector('img.flag-attach') as HTMLImageElement
      expect(el.getAttribute('src')).toBe('blob:abc')
      return el
    })
    fireEvent.click(img)
    expect(screen.getByRole('dialog', { name: /attachment/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run — FAIL** (component + api helper missing).

Run: `npx vitest run src/components/flags/__tests__/CommentBody.test.tsx`

- [ ] **Step 3: Implement.**

`src/lib/flags-api.ts` — add near the top-level imports `import { getApiBaseUrl } from '@/lib/config'` and `import { getAuthToken } from '@/store/auth-store'` (matching `flag-stream.ts`), then:

```ts
function bearerHeaders(): Record<string, string> {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Upload an image to a flag (multipart). The browser sets the multipart
 *  boundary — do NOT set Content-Type. */
export async function addFlagAttachment(
  flagId: number,
  file: File
): Promise<FlagAttachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${getApiBaseUrl()}/api/flags/${flagId}/attachments`, {
    method: 'POST',
    headers: bearerHeaders(),
    body: form,
  })
  if (!res.ok) throw new Error(`attachment upload failed: ${res.status}`)
  return res.json() as Promise<FlagAttachment>
}

const _flagAttachmentCache = new Map<number, string>()

/** Resolve an attachment's bytes to a renderable blob object URL. The serve
 *  endpoint requires Bearer auth, so a plain <img src> would 401; we fetch as a
 *  blob and wrap it. Mirrors fetchPackagingPhotoUrl. Cached per id. */
export async function fetchFlagAttachmentUrl(
  attachmentId: number
): Promise<string | null> {
  const cached = _flagAttachmentCache.get(attachmentId)
  if (cached) return cached
  const res = await fetch(
    `${getApiBaseUrl()}/api/flags/attachments/${attachmentId}`,
    { headers: bearerHeaders() }
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`fetchFlagAttachmentUrl failed: ${res.status}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  _flagAttachmentCache.set(attachmentId, url)
  return url
}

export function invalidateFlagAttachment(attachmentId: number): void {
  const prev = _flagAttachmentCache.get(attachmentId)
  if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
  _flagAttachmentCache.delete(attachmentId)
}
```

Also add the `FlagAttachment` interface (mirrors `AttachmentResponse`):

```ts
/** Mirrors backend `AttachmentResponse`. */
export interface FlagAttachment {
  id: number
  flag_id: number
  comment_id: number | null
  filename: string
  content_type: string
  size_bytes: number
  created_at: string
}
```

`src/components/flags/CommentBody.tsx`:

```tsx
/**
 * Renders one comment body: markdown-lite HTML (via renderCommentHtml) set with
 * dangerouslySetInnerHTML, then an effect resolves each attachment token's
 * <img> to a bearer-authed blob object URL (module-pure: the backend serves
 * bytes, not public URLs). Clicking an attachment image opens a lightbox.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { renderCommentHtml, type MentionToken } from '@/components/flags/comment-markdown'
import { nameForUser, type UserMap } from '@/components/flags/flag-users'
import { fetchFlagAttachmentUrl } from '@/lib/flags-api'

export function CommentBody({
  body,
  mentions,
  users,
}: {
  body: string
  mentions: number[]
  users: UserMap
}) {
  const html = useMemo(() => {
    const tokens: MentionToken[] = mentions.map(id => ({
      id,
      tok: `@${nameForUser(users, id)}`,
    }))
    return renderCommentHtml(body, tokens)
  }, [body, mentions, users])

  const ref = useRef<HTMLDivElement>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    const imgs = el.querySelectorAll<HTMLImageElement>(
      'img.flag-attach[data-attachment-id]'
    )
    imgs.forEach(img => {
      const id = Number(img.dataset.attachmentId)
      if (!Number.isFinite(id)) return
      void fetchFlagAttachmentUrl(id).then(url => {
        if (!cancelled && url) img.src = url
      })
    })
    return () => {
      cancelled = true
    }
  }, [html])

  return (
    <>
      <div
        ref={ref}
        className="flag-body text-[13px] leading-relaxed text-foreground/90 [&_p]:m-0 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_.flag-mention]:rounded [&_.flag-mention]:bg-primary/15 [&_.flag-mention]:px-1 [&_.flag-mention]:font-medium [&_.flag-mention]:text-primary [&_img.flag-attach]:mt-1 [&_img.flag-attach]:max-h-48 [&_img.flag-attach]:cursor-pointer [&_img.flag-attach]:rounded [&_img.flag-attach]:border"
        // eslint-disable-next-line react/no-danger -- sanitized by DOMPurify in renderCommentHtml
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={e => {
          const t = e.target as HTMLElement
          if (t.tagName === 'IMG' && t.classList.contains('flag-attach')) {
            setLightbox((t as HTMLImageElement).src)
          }
        }}
      />
      {lightbox && (
        <div
          role="dialog"
          aria-label="attachment preview"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="attachment full size" className="max-h-full max-w-full rounded" />
        </div>
      )}
    </>
  )
}
```

`src/components/flags/FlagThread.tsx` — in `CommentRow`, replace the `renderCommentSegments(...).map(...)` expression (inside the `<div className="text-[13px] leading-relaxed ...">`) with `<CommentBody body={comment.body} mentions={comment.mentions ?? []} users={users} />`; add the import; drop the now-unused `renderCommentSegments` import if nothing else uses it (`activeMentionQuery` + `mentionIdsInBody` stay).

- [ ] **Step 4: Run — PASS**; then `npx vitest run src/components/flags/__tests__/FlagThread.test.tsx` — the interleave/submit tests stay green (the plain-text bodies still render their text).
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): CommentBody markdown render + inline attachment images"`

---

### Task 7: Frontend — composer textarea + toolbar + paste/drag upload

**Files:**
- Modify: `src/components/flags/FlagThread.tsx` (composer: `Input` → `Textarea`; add a toolbar row; Ctrl+B/I; paste/drag → upload → insert `{attachment:ID}`)
- Test: `src/components/flags/__tests__/FlagComposer.test.tsx` (create — render `FlagThread`, exercise the composer)

**Interfaces:**
- Consumes: `addFlagAttachment` (Task 6). Reuses the existing mention menu (`activeMentionQuery`, `mentionIdsInBody`, `selected`/`menu`/`activeIdx` state) and submit logic — all of which read `selectionStart`, which works identically on `<textarea>`.
- Produces: a light formatting toolbar (Bold / Italic / Code / List / Link) that wraps or inserts markdown tokens at the textarea selection; `Ctrl/Cmd+B` and `Ctrl/Cmd+I`; paste/drop of an image → `addFlagAttachment` → insert `{attachment:ID}` at the caret. No new exported symbols.

**Highest-regression task in the slice** — the @mention menu, `selectionStart`, and Enter-submit / Shift+Enter-newline all live in this composer. Keeping `FlagThread.test.tsx` green is an explicit gate (Step 5).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@/test/test-utils'
import type { FlagDetailResponse } from '@/lib/flags-api'

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) => (id == null ? '—' : `User ${id}`),
  initialsForUser: () => 'U',
  avatarColor: () => '#888',
}))
const addFlagAttachment = vi.hoisted(() => vi.fn())
vi.mock('@/lib/flags-api', async orig => ({
  ...(await orig()),
  addFlagAttachment,
  fetchFlagAttachmentUrl: vi.fn().mockResolvedValue('blob:x'),
}))
const useFlag = vi.fn()
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  const stub = () => ({ mutate: vi.fn(), isPending: false })
  return { ...actual, useFlag: (...a: unknown[]) => useFlag(...a),
    useChangeStatus: stub, useAssignFlag: stub,
    useAddComment: () => ({ mutate: vi.fn(), isPending: false }),
    useAddWatcher: stub, useRemoveWatcher: stub }
})

function detail(): FlagDetailResponse {
  return {
    id: 7, entity_type: 'sub_sample', entity_id: '1', kind: 'issue', type: 'blocker',
    status: 'in_progress', title: 't', created_by: 1, assignee_id: 2,
    created_at: '', updated_at: '', resolved_at: null, resolved_by: null,
    comments: [], events: [],
  }
}

describe('FlagComposer', () => {
  beforeEach(() => {
    addFlagAttachment.mockReset().mockResolvedValue({ id: 99 })
    useFlag.mockReturnValue({ data: detail(), isLoading: false, isError: false })
  })

  it('bold toolbar button wraps the selection in **', async () => {
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)
    const ta = screen.getByPlaceholderText(/Write a comment/) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'word' } })
    ta.setSelectionRange(0, 4)
    fireEvent.click(screen.getByRole('button', { name: /bold/i }))
    expect(ta.value).toBe('**word**')
  })

  it('pasting an image uploads it and inserts an attachment token', async () => {
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)
    const ta = screen.getByPlaceholderText(/Write a comment/) as HTMLTextAreaElement
    const file = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' })
    fireEvent.paste(ta, { clipboardData: { files: [file], items: [] } })
    await waitFor(() => expect(addFlagAttachment).toHaveBeenCalledWith(7, file))
    await waitFor(() => expect(ta.value).toContain('{attachment:99}'))
  })
})
```

- [ ] **Step 2: Run — FAIL** (no toolbar button; `Input` not `textarea`; no paste handler).

Run: `npx vitest run src/components/flags/__tests__/FlagComposer.test.tsx`

- [ ] **Step 3: Implement** in `src/components/flags/FlagThread.tsx`:

- Swap the composer control from `<Input>` to a `<Textarea>` (import `Textarea` from `@/components/ui/textarea` — verify the file exists; if absent, use a native `<textarea>` with the same `className` and the shared field styles). Keep `ref={inputRef}` (retype to `HTMLTextAreaElement | null`), `value={draft}`, the existing `onChange`/`onKeyDown` (they already use `selectionStart` and `!e.shiftKey`, so Enter submits and Shift+Enter inserts a newline on a textarea), and `placeholder="Write a comment… use @ to mention"`.
- Add a small helper to mutate the draft at the current selection:

```tsx
const surround = (before: string, after = before) => {
  const ta = inputRef.current
  if (!ta) return
  const s = ta.selectionStart ?? draft.length
  const e = ta.selectionEnd ?? s
  const next = draft.slice(0, s) + before + draft.slice(s, e) + after + draft.slice(e)
  setDraft(next)
  queueMicrotask(() => {
    ta.focus()
    ta.setSelectionRange(s + before.length, e + before.length)
  })
}
const insertAtCaret = (text: string) => {
  const ta = inputRef.current
  const at = ta?.selectionStart ?? draft.length
  setDraft(draft.slice(0, at) + text + draft.slice(at))
  queueMicrotask(() => {
    ta?.focus()
    const pos = at + text.length
    ta?.setSelectionRange(pos, pos)
  })
}
```

- Toolbar row directly above the textarea (inside the composer container), buttons calling `surround`/`insertAtCaret`:

```tsx
<div className="flex items-center gap-0.5 px-1">
  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="Bold"
    onClick={() => surround('**')}><Bold className="h-3.5 w-3.5" /></Button>
  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="Italic"
    onClick={() => surround('_')}><Italic className="h-3.5 w-3.5" /></Button>
  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="Code"
    onClick={() => surround('`')}><Code className="h-3.5 w-3.5" /></Button>
  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="List"
    onClick={() => insertAtCaret('\n- ')}><List className="h-3.5 w-3.5" /></Button>
  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="Link"
    onClick={() => surround('[', '](url)')}><LinkIcon className="h-3.5 w-3.5" /></Button>
</div>
```

(Import `Bold, Italic, Code, List, Link as LinkIcon` from `lucide-react`.)

- Ctrl/Cmd+B / +I inside the existing `onKeyDown` (before the Enter branch, only when the mention menu is closed):

```tsx
if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'i')) {
  e.preventDefault()
  surround(e.key === 'b' ? '**' : '_')
  return
}
```

- Image upload on paste + drop. Factor a helper and wire it to the textarea:

```tsx
const uploadImage = async (file: File) => {
  try {
    const att = await addFlagAttachment(flagId, file)
    insertAtCaret(`{attachment:${att.id}}`)
  } catch {
    /* surfaced by the failing send if the token dangles; no toast in v1 */
  }
}
// on the <Textarea>:
onPaste={e => {
  const img = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'))
  if (img) { e.preventDefault(); void uploadImage(img) }
}}
onDrop={e => {
  const img = Array.from(e.dataTransfer?.files ?? []).find(f => f.type.startsWith('image/'))
  if (img) { e.preventDefault(); void uploadImage(img) }
}}
```

(Import `addFlagAttachment` from `@/lib/flags-api`.)

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Regression gate** — `npx vitest run src/components/flags/__tests__/FlagThread.test.tsx` MUST stay green (mention menu + Enter-submit unchanged). If red, the composer refactor regressed the mention/submit path — fix before committing.
- [ ] **Step 6: Commit** — `git commit -m "feat(flags): markdown composer toolbar + paste/drag image upload"`

---

### Task 8: Frontend — reactions API, UI, and stream-glue guard

**Files:**
- Modify: `src/lib/flags-api.ts` (`ReactionAggregate`, `reactions` on `CommentResponse`, `FLAG_REACTION_EMOJI`, `addReaction`, `removeReaction`)
- Modify: `src/hooks/use-flags.ts` (`useAddReaction`, `useRemoveReaction`)
- Create: `src/components/flags/FlagReactions.tsx`
- Modify: `src/components/flags/FlagThread.tsx` (mount `<FlagReactions>` in `CommentRow`, pass `flagId` + `currentUserId`)
- Modify: `src/components/flags/use-flag-stream-glue.ts` (first-branch guard for `comment_reaction` + `attachment_added`)
- Modify: `src/lib/flag-stream.ts` (add `comment_reaction` to the `FlagEventType` union; optional `comment_id`/`emoji`/`action` fields)
- Test: `src/components/flags/__tests__/FlagReactions.test.tsx`, `src/components/flags/__tests__/flag-stream-glue-reactions.test.ts`

**Interfaces:**
- Consumes: backend Task 4 (`ReactionAggregate`, PUT/DELETE, `comment_reaction` event); `useFlagUsers`/`nameForUser`; existing `flagKeys.detail`.
- Produces:
  - `FLAG_REACTION_EMOJI = ['👍','✅','👀','🎉','❤️','😂','🤔','🚨'] as const` — **byte-identical** to backend `CURATED_EMOJI` (VS16-carrying emoji included).
  - `interface ReactionAggregate { emoji: string; count: number; user_ids: number[] }`; `CommentResponse.reactions?: ReactionAggregate[]` (optional — existing fixtures omit it; backend always sends `[]`).
  - `addReaction(commentId, emoji)` / `removeReaction(commentId, emoji)` → `apiFetch<ReactionAggregate[]>` (emoji `encodeURIComponent`'d).
  - `useAddReaction(flagId)` / `useRemoveReaction(flagId)` — invalidate `flagKeys.detail(flagId)` on success.
  - `<FlagReactions commentId flagId currentUserId reactions />` — hover bar of the 8 curated emoji + existing-reaction pills (count + who-tooltip), click toggles.

- [ ] **Step 1: Write the failing tests**

`flag-stream-glue-reactions.test.ts` (the guard — reactions must not toast):

```ts
import { describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
const markUnseen = vi.fn()
vi.mock('@/components/flags/use-flag-unseen', () => ({
  useFlagUnseen: { getState: () => ({ markUnseen, acknowledge: vi.fn(), clearJustOpened: vi.fn() }) },
}))
let handler: (e: unknown) => void
vi.mock('@/lib/flag-stream', () => ({
  useFlagStream: (cb: (e: unknown) => void) => { handler = cb },
}))

describe('stream glue ignores comment_reaction', () => {
  it('does not toast or mark unseen on a reaction event', async () => {
    const { useFlagStreamGlue } = await import('@/components/flags/use-flag-stream-glue')
    const { renderHook } = await import('@testing-library/react')
    renderHook(() => useFlagStreamGlue())
    handler({
      event_type: 'comment_reaction', flag_id: 7, comment_id: 3, actor_id: 1,
      details: {}, event_id: null,
      flag: { id: 7, title: 't', type: 'blocker', kind: 'issue', status: 'open',
              entity_type: 'sub_sample', entity_id: '1', assignee_id: 42, created_by: 42 },
    })
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(markUnseen).not.toHaveBeenCalled()
  })
})
```

`FlagReactions.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map([[7, { id: 7, email: 'a@x', first_name: 'Ann', last_name: 'Lee' }]]),
  nameForUser: (_m: unknown, id: number | null) => (id === 7 ? 'Ann Lee' : `User ${id}`),
}))
const api = vi.hoisted(() => ({ addReaction: vi.fn().mockResolvedValue([]), removeReaction: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/flags-api', async orig => ({ ...(await orig()), ...api }))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('FlagReactions', () => {
  beforeEach(() => { api.addReaction.mockClear(); api.removeReaction.mockClear() })

  it('renders existing reaction pills with counts', async () => {
    const { FlagReactions } = await import('@/components/flags/FlagReactions')
    render(wrap(<FlagReactions commentId={3} flagId={7} currentUserId={9}
      reactions={[{ emoji: '👍', count: 2, user_ids: [7, 8] }]} />))
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(screen.getByText('👍')).toBeInTheDocument()
  })

  it('clicking a curated emoji adds my reaction', async () => {
    const { FlagReactions } = await import('@/components/flags/FlagReactions')
    render(wrap(<FlagReactions commentId={3} flagId={7} currentUserId={9} reactions={[]} />))
    fireEvent.click(screen.getByRole('button', { name: 'React 🎉' }))
    await waitFor(() => expect(api.addReaction).toHaveBeenCalledWith(3, '🎉'))
  })

  it('clicking a pill I already reacted to removes it', async () => {
    const { FlagReactions } = await import('@/components/flags/FlagReactions')
    render(wrap(<FlagReactions commentId={3} flagId={7} currentUserId={7}
      reactions={[{ emoji: '👍', count: 1, user_ids: [7] }]} />))
    fireEvent.click(screen.getByRole('button', { name: /👍 1/ }))
    await waitFor(() => expect(api.removeReaction).toHaveBeenCalledWith(3, '👍'))
  })
})
```

- [ ] **Step 2: Run — FAIL** (module + guard missing).

Run: `npx vitest run src/components/flags/__tests__/FlagReactions.test.tsx src/components/flags/__tests__/flag-stream-glue-reactions.test.ts`

- [ ] **Step 3: Implement.**

`src/lib/flags-api.ts`:

```ts
/** Curated reaction set (spec §6). BYTE-IDENTICAL to backend CURATED_EMOJI —
 *  VS16-carrying glyphs included, or the server 400s a reaction the UI sent. */
export const FLAG_REACTION_EMOJI = ['👍', '✅', '👀', '🎉', '❤️', '😂', '🤔', '🚨'] as const
export type FlagReactionEmoji = (typeof FLAG_REACTION_EMOJI)[number]

/** Mirrors backend `ReactionAggregate`. */
export interface ReactionAggregate {
  emoji: string
  count: number
  user_ids: number[]
}

export const addReaction = (commentId: number, emoji: string) =>
  apiFetch<ReactionAggregate[]>(
    `/api/flags/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'PUT' }
  )

export const removeReaction = (commentId: number, emoji: string) =>
  apiFetch<ReactionAggregate[]>(
    `/api/flags/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'DELETE' }
  )
```

Add `reactions?: ReactionAggregate[]` to the `CommentResponse` interface.

`src/hooks/use-flags.ts` — import `addReaction, removeReaction`; add:

```ts
/** Toggle a reaction on a comment → refresh the open thread. */
export function useAddReaction(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: number; emoji: string }) =>
      addReaction(commentId, emoji),
    onSuccess: () => qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) }),
  })
}

export function useRemoveReaction(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: number; emoji: string }) =>
      removeReaction(commentId, emoji),
    onSuccess: () => qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) }),
  })
}
```

`src/components/flags/FlagReactions.tsx`:

```tsx
/**
 * Reaction bar + pills for one comment. Hover reveals the curated set; existing
 * reactions render as pills (count + who-tooltip). Clicking toggles my own
 * reaction. Names resolve client-side (module purity); reacted-by-me derives
 * from user_ids vs currentUserId.
 */
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import { useAddReaction, useRemoveReaction } from '@/hooks/use-flags'
import { useFlagUsers, nameForUser } from '@/components/flags/flag-users'
import { FLAG_REACTION_EMOJI, type ReactionAggregate } from '@/lib/flags-api'
import { cn } from '@/lib/utils'

export function FlagReactions({
  commentId,
  flagId,
  currentUserId,
  reactions,
}: {
  commentId: number
  flagId: number
  currentUserId: number | null
  reactions: ReactionAggregate[]
}) {
  const users = useFlagUsers()
  const add = useAddReaction(flagId)
  const remove = useRemoveReaction(flagId)

  const toggle = (emoji: string, mine: boolean) =>
    (mine ? remove : add).mutate({ commentId, emoji })

  return (
    <TooltipProvider delayDuration={200}>
    <div className="group/react mt-1 flex flex-wrap items-center gap-1">
      {reactions.map(r => {
        const mine = currentUserId != null && r.user_ids.includes(currentUserId)
        const who = r.user_ids.map(id => nameForUser(users, id)).join(', ')
        return (
          <Tooltip key={r.emoji}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${r.emoji} ${r.count}`}
                onClick={() => toggle(r.emoji, mine)}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]',
                  mine ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground'
                )}
              >
                <span>{r.emoji}</span>
                <span>{r.count}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="font-mono text-[11px]">{who}</TooltipContent>
          </Tooltip>
        )
      })}

      <div className="hidden items-center gap-0.5 group-hover/react:flex">
        {FLAG_REACTION_EMOJI.map(emoji => (
          <button
            key={emoji}
            type="button"
            aria-label={`React ${emoji}`}
            onClick={() =>
              toggle(
                emoji,
                currentUserId != null &&
                  (reactions.find(r => r.emoji === emoji)?.user_ids.includes(currentUserId) ?? false)
              )
            }
            className="rounded px-1 text-[13px] opacity-70 hover:opacity-100"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
    </TooltipProvider>
  )
}
```

`src/components/flags/FlagThread.tsx` — `CommentRow` needs `flagId` + `currentUserId`; pass them from the timeline render (both already in scope in `FlagThread`). Mount `<FlagReactions commentId={comment.id} flagId={flagId} currentUserId={currentUserId} reactions={comment.reactions ?? []} />` directly under the `<CommentBody>` inside the bubble.

`src/components/flags/use-flag-stream-glue.ts` — make the reaction/attachment guard the FIRST branch inside `useFlagStream(e => { … })`, before any `e.flag.*` access:

```ts
  useFlagStream((e: FlagStreamEvent) => {
    // Cheap blanket refresh: lists, summary badge, and any open thread.
    queryClient.invalidateQueries({ queryKey: flagKeys.all })

    // Reactions (and in-flight attachment uploads) refresh the thread live but
    // must NOT toast, ping unread, or fly home — reactions never mark a thread
    // unread (spec §6). Guard first, before any relevance/e.flag access.
    if (e.event_type === 'comment_reaction' || e.event_type === 'attachment_added') return

    const me = useAuthStore.getState().user?.id ?? null
    // …existing relevance/notify logic unchanged…
```

`src/lib/flag-stream.ts` — add `'comment_reaction'` to the `FlagEventType` union and optional fields to `FlagStreamEvent`:

```ts
export type FlagEventType =
  | 'raised' | 'assigned' | 'unassigned' | 'commented'
  | 'status_changed' | 'watcher_added' | 'watcher_removed'
  | 'comment_reaction'

// on FlagStreamEvent:
  comment_id?: number
  emoji?: string
  action?: 'added' | 'removed'
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Regression gate** — `npx vitest run src/components/flags/__tests__/FlagThread.test.tsx` stays green.
- [ ] **Step 6: Commit** — `git commit -m "feat(flags): comment emoji reactions UI + live SSE (no unread bump)"`

---

### Task 8b: Thread due-date editor (Slice 2 gap closure)

**Why here:** Slice 2 shipped `PUT /api/flags/{flag_id}/due` (backend `set_due` with `due_set`/`due_changed`/`due_cleared` events) and a due field on the COMPOSE form, but nothing wires the THREAD: no due display, no edit/clear, zero FE callers of the PUT. Spec §5 requires "editable from thread". This slice already reworks FlagThread — close the gap here.

**Files:**
- Modify: `src/lib/flags-api.ts` (add `setDue`), `src/hooks/use-flags.ts` (add `useSetDue`, mirroring `useAssignFlag`'s shape exactly), `src/components/flags/FlagThread.tsx` (due row in the header controls area, directly after the status/assignee selects)
- Test: `src/components/flags/__tests__/FlagThread-due.test.tsx` (create; mock idiom = whatever FlagThread.test.tsx already uses)

**Interfaces:**
- Consumes: Slice 2's `PUT /api/flags/{flag_id}/due` (body `{"due_at": "<iso>" | null}` → FlagResponse), `dueLabel(due_at)` from `flag-format.ts`, `FlagResponse.due_at: string | null`.
- Produces:

```ts
/** `PUT /api/flags/{id}/due` — set, change, or clear (null) the due date. */
export const setDue = (id: number, due_at: string | null) =>
  apiFetch<FlagResponse>(`/api/flags/${id}/due`, {
    method: 'PUT',
    body: JSON.stringify({ due_at }),
  })
```

  and `useSetDue(flagId)` invalidating the same keys `useAssignFlag` does.

- [ ] **Step 1: Failing test** — render FlagThread (existing test fixture) with `due_at` set on the detail payload; assert the due label text (from `dueLabel`) renders; click the due control, pick a date via the native input, assert `setDue` called with the flag id + ISO string; click "Clear", assert `setDue(id, null)`.

- [ ] **Step 2: Run — FAIL.**
Run: `npx vitest run src/components/flags/__tests__/FlagThread-due.test.tsx`

- [ ] **Step 3: Implement.** In the FlagThread header controls row (after the assignee Select), a compact due control:

```tsx
{/* Due date: display + inline edit/clear (PUT /due; Slice 2 backend). */}
<div className="flex items-center gap-1.5">
  <Input
    type="date"
    aria-label="Due date"
    className="h-8 w-36 text-xs"
    value={flag.due_at ? flag.due_at.slice(0, 10) : ''}
    onChange={e =>
      setDueM.mutate(
        e.target.value
          ? new Date(`${e.target.value}T17:00:00`).toISOString()
          : null
      )
    }
  />
  {flag.due_at && (
    <>
      <span
        className={
          dueLabel(flag.due_at)?.overdue
            ? 'text-xs font-medium text-destructive'
            : 'text-xs text-muted-foreground'
        }
      >
        {dueLabel(flag.due_at)?.text}
      </span>
      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs"
              onClick={() => setDueM.mutate(null)}>
        Clear
      </Button>
    </>
  )}
</div>
```

with `const setDueM = useSetDue(flagId)` beside the other mutation hooks (5 pm local on set — same end-of-workday semantics as the composer; keep the comment). The audit line for `due_set`/`due_changed`/`due_cleared` events already renders via the generic event line — verify the label reads sensibly and, if the event-line formatter has a switch of known event types, add the three due events with human wording ("due date set to Jul 15" — format via `formatDateTime`).

- [ ] **Step 4: Run — PASS**, plus `npx vitest run src/components/flags/__tests__/FlagThread.test.tsx` stays green.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): thread due-date editor (set/change/clear)"`

---

### Task 9: Slice gates

- [ ] **Step 1: Frontend full gate** — `npm run check:all` (typecheck + lint + ast:lint + format + rust + tests). Compare the failing test SET to the ~34-frontend baseline; only the intended new specs may differ. Note: `dangerouslySetInnerHTML` is intentionally used in `CommentBody` (DOMPurify-sanitized) — keep the inline eslint-disable; do NOT globally relax the rule.
- [ ] **Step 2: Build** — `npm run build` succeeds (markdown-it + dompurify bundle cleanly).
- [ ] **Step 3: Backend full gate** — `cd backend && python -m pytest tests -q`. Failure SET matches the ~19 known baseline (no NEW failures). The new `flag_attachments` / `flag_comment_reactions` tables build under the SQLite `create_all` path via their models; the raw-SQL migrations are Postgres-only and are swallowed per-statement on SQLite (expected `migration_skipped` warnings, benign).
- [ ] **Step 4: Commit stragglers** — `git commit -am "chore(flags): slice 3 gates"`. **Do NOT push and do NOT open a PR** (leave the branch local for the reviewer, per the slice convention).

---

## Self-review — §6 coverage map

| §6 requirement | Task |
|---|---|
| markdown-it (html:false, linkify) + dompurify, pinned, npm | 5 |
| bold/italic/inline-code/code-block/lists/links | 5 |
| bare-URL linkify, target=_blank rel=noopener | 5 |
| NO raw HTML; NO markdown image syntax | 5 |
| @mentions compose with renderer; parse order + tests; literal in code | 5 |
| composer plain textarea + toolbar (B/I/code/list/link) + Ctrl+B/I | 7 |
| Slack body_excerpt plain-text strip server-side | 3 |
| flag_attachments table (all columns) | 2 |
| POST multipart, image/* magic-byte sniff, ~10MB cap | 2 |
| storage seam attachment_storage; host S3 impl; no boto3 in module | 1, 2 |
| authenticated GET serve | 2 (serve) + 6 (blob img) |
| composer paste/drag → upload → insert {attachment:ID} | 7 |
| renderer swaps token → inline img, click-to-full-size | 6 |
| comment_id set on comment save | 2 |
| attachment_added audit+analytics event; excerpt "📎 image" | 2, 3 |
| orphan GC = slice 5 (noted, not done) | Global constraints |
| flag_comment_reactions table, unique(comment,user,emoji) | 4 |
| curated 8-emoji set, no picker dep | 4 (server), 8 (FE) |
| PUT/DELETE reactions idempotent | 4 |
| CommentResponse.reactions aggregate | 4 |
| hover bar + pills + counts + who-tooltip | 8 |
| SSE comment_reaction, NO toast/DM/unread/flag_events/updated_at | 4 (emit) + 8 (glue) + planner returns [] |

**Ambiguities resolved:**
1. **Mention/markdown parse order** — the spec's "mentions parse before markdown so `@name` in code stays literal" is internally contradictory (parsing before markdown would turn `@name` in code into a pill). Resolved by making the *goal* authoritative: a markdown-it core rule substitutes tokens only on `text` tokens; `code_inline`/`fence` are distinct token types, so their contents are never `text` and stay literal — no ordering hack needed. Stated explicitly in Task 5.
2. **Authed-image serving** — a plain `<img src="/api/flags/attachments/ID">` would 401 (bearer-header auth). Resolved by mirroring the established `fetchPackagingPhotoUrl` pattern: render `<img data-attachment-id>` with no `src`, resolve to a bearer-authed blob object URL in a `CommentBody` effect. No token-in-URL serving route invented.
3. **`attachment_added` live noise** — it rides the sink (uniform `_audit`/emit) but is added to the stream-glue's first-branch guard alongside `comment_reaction` so an in-flight upload never toasts the flag creator before the comment lands. Slack planner already returns `[]` for it (no DM).
4. **`CommentResponse.reactions` population** — cannot come through `from_attributes` (it's an aggregate needing a batch query). Populated explicitly after `model_validate` in `get_flag`; `reacted_by_me` derived client-side from `user_ids`. FE field left optional so existing fixtures stay green.
5. **Upload route concurrency** — kept a sync `def` (threadpool) reading via `file.file.read()`, NOT `async def` with blocking DB + S3, per the documented event-loop-blocking / SharePoint-OOM lineage.
