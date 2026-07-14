# Packaging Fan-out + QR Phone Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Packaging photos fan out to every sample in an order automatically, and a QR code on the packaging tab lets techs shoot box photos from their phone with no login, appearing on the desktop within seconds.

**Architecture:** A transactional bulk-create service in the existing `packaging_photos` backend module; a new `capture_tokens` module (hashed 256-bit tokens, 2 h TTL, frozen sample scope) exposing two JWT-authed and two token-authed routes; desktop wiring in `PackagingPanel` + a new `CaptureQrCard`; a self-contained static phone page under `public/m/`.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (backend), React 19 + TanStack Query + vitest (frontend), `qrcode.react` (already a dependency), vanilla HTML/JS static page.

**Spec:** `docs/superpowers/specs/2026-07-13-packaging-fanout-qr-phone-capture-design.md`

## Global Constraints

- Worktree: `C:\tmp\accu-mk1-pkgphone` (branch `feat/packaging-fanout-phone-capture` off origin/master v1.2.1). All paths below are relative to it.
- **Additive only.** No existing endpoint, model column, or FE behavior changes shape. Standalone (non-order) desktop save path stays byte-identical.
- **Backend tests run in the container** (local python has no deps):
  `docker run --rm -e PYTHONPATH=/work -v C:/tmp/accu-mk1-pkgphone/backend:/work -w /work ghcr.io/zstar0/accu-mk1-backend:1.2.1 sh -c "pip install -q pytest && python -m pytest <paths> -q"`
- Frontend tests: `npx vitest run <paths>` from the worktree root. Typecheck: `npm run typecheck`.
- Browser-visible API paths carry a **double `/api`** (`/api/api/...`) because these routers declare `prefix="/api"` and nginx strips one. The FE api client already handles this; the static phone page must use base `/api/api` explicitly.
- Datetime columns are **naive UTC** (`datetime.utcnow()`), matching existing models.
- Token TTL constant: `CAPTURE_TOKEN_TTL_HOURS = 2`. Caps: 10 MB/photo, 50 shots/token, 50 samples/token.
- Commit after each task with a conventional-commits message; NEVER `--no-verify`; end commit messages with the Claude Fable co-author + session trailer used on this branch (see `git log -2`).

---

## Stream A — Backend (Tasks 1–4, sequential, one agent)

### Task 1: Bulk fan-out service

**Files:**
- Modify: `backend/packaging_photos/service.py` (append)
- Test: `backend/tests/test_packaging_photos_service.py` (append)

**Interfaces:**
- Produces: `create_packaging_photos_bulk(db, parent_sample_ids: list[str], photo_bytes: bytes, filename: str, content_type: str | None, remarks: str | None, user_id: int | None) -> list[LimsPackagingPhoto]` — rows returned in `parent_sample_ids` order; raises `LookupError` naming ALL missing ids; nothing persisted on any failure. (Task 3 extends this with a `capture_token_id: int | None = None` kwarg.)
- Consumes: existing `_resolve_parent`, `get_storage()`, `_delete_stored_photo_quietly`, `LimsPackagingPhoto`.

- [ ] **Step 1: Write the failing tests** (append to the existing test file — reuse its `db`/`storage` fixtures and add a second parent fixture):

```python
@pytest.fixture
def parent_sample_2(db):
    p = LimsSample(sample_id="P-0701", external_lims_uid="u-701")
    db.add(p)
    db.flush()
    return p


def test_bulk_creates_one_row_per_parent_with_independent_storage(db, storage, parent_sample, parent_sample_2):
    from packaging_photos.service import create_packaging_photos_bulk
    photos = create_packaging_photos_bulk(
        db, [parent_sample.sample_id, parent_sample_2.sample_id],
        b"box", "packaging.jpg", "image/jpeg", "note", 1,
    )
    assert len(photos) == 2
    assert {p.parent_sample_pk for p in photos} == {parent_sample.id, parent_sample_2.id}
    # independent storage objects, keyed per sample
    keys = [p.storage_key for p in photos]
    assert len(set(keys)) == 2
    assert all(k.startswith("mk1://") for k in keys)
    for p in photos:
        raw, _ = read_packaging_photo_bytes(db, p.id)
        assert raw == b"box"
        assert p.remarks == "note"


def test_bulk_ordering_is_per_parent(db, storage, parent_sample, parent_sample_2):
    from packaging_photos.service import create_packaging_photos_bulk
    create_packaging_photo(db, parent_sample.sample_id, b"a", "a.jpg", "image/jpeg", None, 1)
    photos = create_packaging_photos_bulk(
        db, [parent_sample.sample_id, parent_sample_2.sample_id],
        b"box", "packaging.jpg", "image/jpeg", None, 1,
    )
    by_pk = {p.parent_sample_pk: p for p in photos}
    assert by_pk[parent_sample.id].ordering == 1      # parent 1 already had one
    assert by_pk[parent_sample_2.id].ordering == 0    # parent 2's first


def test_bulk_missing_parent_is_all_or_nothing(db, storage, parent_sample):
    from packaging_photos.service import create_packaging_photos_bulk
    with pytest.raises(LookupError) as ei:
        create_packaging_photos_bulk(
            db, [parent_sample.sample_id, "NOPE-1", "NOPE-2"],
            b"box", "packaging.jpg", "image/jpeg", None, 1,
        )
    assert "NOPE-1" in str(ei.value) and "NOPE-2" in str(ei.value)
    assert list_packaging_photos(db, parent_sample.sample_id) == []


```

(Only these three tests in Task 1 — the `capture_token_id` provenance test belongs to Task 3, which owns the column.)

- [ ] **Step 2: Run to verify failure** — container command from Global Constraints, path `tests/test_packaging_photos_service.py`. Expected: `ImportError`/`AttributeError` on `create_packaging_photos_bulk`.

- [ ] **Step 3: Implement** (append to `backend/packaging_photos/service.py`):

```python
def create_packaging_photos_bulk(
    db: Session,
    parent_sample_ids: list[str],
    photo_bytes: bytes,
    filename: str,
    content_type: Optional[str],
    remarks: Optional[str],
    user_id: Optional[int],
) -> list[LimsPackagingPhoto]:
    """Fan one packaging photo out to several parents — all-or-nothing.

    Resolves every parent before writing anything so a single bad id fails
    the whole call (LookupError names all missing ids). Bytes are duplicated
    per parent under that parent's storage namespace so per-sample
    edit/delete semantics stay untouched. On a storage failure midway the
    already-saved keys are best-effort deleted and nothing is committed.
    """
    parents = []
    missing = []
    for sid in parent_sample_ids:
        row = db.execute(
            select(LimsSample).where(LimsSample.sample_id == sid)
        ).scalar_one_or_none()
        if row is None:
            missing.append(sid)
        else:
            parents.append(row)
    if missing:
        raise LookupError(f"parent samples not found: {', '.join(missing)}")

    saved_keys: list[str] = []
    photos: list[LimsPackagingPhoto] = []
    try:
        for parent in parents:
            key = get_storage().save_photo(parent.sample_id, photo_bytes, filename)
            saved_keys.append(key)
            next_ordering = (db.execute(
                select(func.coalesce(func.max(LimsPackagingPhoto.ordering), -1))
                .where(LimsPackagingPhoto.parent_sample_pk == parent.id)
            ).scalar_one()) + 1
            photo = LimsPackagingPhoto(
                parent_sample_pk=parent.id,
                kind="packaging",
                storage_key=f"{_PREFIX}{key}",
                filename=filename,
                content_type=content_type,
                ordering=next_ordering,
                remarks=remarks,
                created_by_user_id=user_id,
            )
            db.add(photo)
            photos.append(photo)
        db.commit()
    except Exception:
        db.rollback()
        for key in saved_keys:
            _delete_stored_photo_quietly(key)
        raise
    for photo in photos:
        db.refresh(photo)
    return photos
```

- [ ] **Step 4: Run to verify pass** — same container command. Expected: all packaging service tests pass.
- [ ] **Step 5: Commit** — `feat(packaging): transactional bulk fan-out service`

### Task 2: Bulk route

**Files:**
- Modify: `backend/packaging_photos/schemas.py` (add `PackagingPhotoBulkCreate`)
- Modify: `backend/packaging_photos/routes.py` (add route)
- Test: `backend/tests/test_packaging_photos_routes.py` (append; mirror its existing app/client fixtures)

**Interfaces:**
- Produces: `POST /api/packaging-photos/bulk` (JWT) — body `{parent_sample_ids: [str], photo_base64: str, filename?: str, content_type?: str, remarks?: str}` → 201 `list[PackagingPhotoOut]`; 404 `{detail}` naming missing ids; 400 bad base64. Browser path: `/api/api/packaging-photos/bulk`.
- Consumes: Task 1's `create_packaging_photos_bulk`, existing `_decode_photo`, `_filename_from_bytes`.

- [ ] **Step 1: Failing test** (append; follow the existing route-test fixture pattern in that file for app + auth override):

```python
def test_bulk_route_creates_on_all_parents(client, db, two_parents):
    p1, p2 = two_parents
    resp = client.post("/api/packaging-photos/bulk", json={
        "parent_sample_ids": [p1.sample_id, p2.sample_id],
        "photo_base64": base64.b64encode(b"\xff\xd8\xffbulk").decode(),
        "remarks": "box",
    })
    assert resp.status_code == 201
    body = resp.json()
    assert len(body) == 2
    assert {b["parent_sample_id"] for b in body} == {p1.sample_id, p2.sample_id}


def test_bulk_route_404_names_missing(client, db, two_parents):
    p1, _ = two_parents
    resp = client.post("/api/packaging-photos/bulk", json={
        "parent_sample_ids": [p1.sample_id, "NOPE"],
        "photo_base64": base64.b64encode(b"\xff\xd8\xffx").decode(),
    })
    assert resp.status_code == 404
    assert "NOPE" in resp.json()["detail"]
```

(Adapt fixture names to the file's actual conventions — read it first; add a `two_parents` fixture if none exists. If `PackagingPhotoOut` lacks `parent_sample_id`, assert on the response length + a follow-up `GET /api/samples/{sid}/packaging-photos` per parent instead.)

- [ ] **Step 2: Verify failure** (405/404 on the new path).
- [ ] **Step 3: Implement** — schema:

```python
class PackagingPhotoBulkCreate(BaseModel):
    parent_sample_ids: list[str] = Field(min_length=1, max_length=50)
    photo_base64: str
    filename: Optional[str] = None
    content_type: Optional[str] = None
    remarks: Optional[str] = None
```

route (in `routes.py`, after the single create):

```python
@router.post(
    "/packaging-photos/bulk",
    status_code=status.HTTP_201_CREATED,
    response_model=list[PackagingPhotoOut],
)
def create_packaging_photos_bulk_route(
    body: PackagingPhotoBulkCreate,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Fan one packaging photo out to every listed parent (all-or-nothing)."""
    photo_bytes = _decode_photo(body.photo_base64)
    try:
        photos = service.create_packaging_photos_bulk(
            db,
            parent_sample_ids=body.parent_sample_ids,
            photo_bytes=photo_bytes,
            filename=body.filename or _filename_from_bytes(photo_bytes),
            content_type=body.content_type,
            remarks=body.remarks,
            user_id=user.id,
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return [PackagingPhotoOut.model_validate(p) for p in photos]
```

- [ ] **Step 4: Verify pass** (route tests + full packaging test files).
- [ ] **Step 5: Commit** — `feat(packaging): bulk fan-out route`

### Task 3: Capture-token model + provenance column

**Files:**
- Modify: `backend/models.py` (new `LimsCaptureToken` after `LimsPackagingPhoto`; add `capture_token_id` column to `LimsPackagingPhoto`)
- Modify: `backend/database.py` (append to the idempotent ALTER list)
- Modify: `backend/packaging_photos/service.py` (thread `capture_token_id` kwarg into the bulk constructor — Task 1 left it out)
- Test: `backend/tests/test_packaging_photos_service.py` (append)

**Interfaces:**
- Produces: `LimsCaptureToken` model (`lims_capture_tokens`): `id, token_hash (String(64), unique, index), order_label (String(100), nullable), context_json (Text), created_by_user_id (int FK users.id), created_at, expires_at, revoked_at (nullable)`; `LimsPackagingPhoto.capture_token_id` nullable FK.

- [ ] **Step 1: Failing test**:

```python
def test_bulk_stamps_capture_token_id(db, storage, parent_sample):
    from packaging_photos.service import create_packaging_photos_bulk
    photos = create_packaging_photos_bulk(
        db, [parent_sample.sample_id], b"box", "p.jpg", "image/jpeg",
        None, 1, capture_token_id=42,
    )
    assert photos[0].capture_token_id == 42
```

- [ ] **Step 2: Verify failure** (TypeError unexpected kwarg or AttributeError).
- [ ] **Step 3: Implement** — model additions (match the file's Mapped style):

```python
class LimsCaptureToken(Base):
    """A short-lived, scope-frozen token letting a phone add packaging photos.

    The raw token lives only in the QR URL; this row stores its SHA-256. The
    sample scope + display context are frozen at mint in context_json —
    [{"sample_id","lot","analytes"}] — so token-authed requests never derive
    anything. See docs/superpowers/specs/2026-07-13-packaging-fanout-qr-phone-capture-design.md.
    """

    __tablename__ = "lims_capture_tokens"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    order_label: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    context_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
```

on `LimsPackagingPhoto` (after `created_by_user_id`):

```python
    capture_token_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("lims_capture_tokens.id", ondelete="SET NULL"),
        nullable=True,
    )
```

`database.py` ALTER list (exact string, appended):

```python
        "ALTER TABLE lims_packaging_photos ADD COLUMN IF NOT EXISTS capture_token_id INTEGER REFERENCES lims_capture_tokens(id) ON DELETE SET NULL",
```

service: extend the Task 1 function — append `capture_token_id: Optional[int] = None,` to `create_packaging_photos_bulk`'s parameters and `capture_token_id=capture_token_id,` to its `LimsPackagingPhoto(...)` constructor kwargs.

- [ ] **Step 4: Verify pass** (whole packaging service test file).
- [ ] **Step 5: Commit** — `feat(capture): capture-token model + photo provenance column`

### Task 4: capture_tokens module (service + routes)

**Files:**
- Create: `backend/capture_tokens/__init__.py` (empty), `backend/capture_tokens/service.py`, `backend/capture_tokens/schemas.py`, `backend/capture_tokens/routes.py`
- Modify: `backend/main.py` (import + `app.include_router(capture_tokens_router)` beside the packaging include, lines ~82/486)
- Test: `backend/tests/test_capture_tokens_service.py`, `backend/tests/test_capture_tokens_routes.py` (mirror packaging route-test fixtures)

**Interfaces:**
- Produces (service): `CAPTURE_TOKEN_TTL_HOURS = 2`; `MAX_PHOTOS_PER_TOKEN = 50`; `mint_capture_token(db, samples: list[dict], order_label, user_id) -> tuple[LimsCaptureToken, str]` (second element = raw token); `resolve_capture_token(db, raw: str) -> LimsCaptureToken` raising `UnknownTokenError`/`GoneTokenError` (module exceptions; expired OR revoked → Gone); `revoke_capture_token(db, token_id: int) -> bool`; `token_photo_count(db, token: LimsCaptureToken) -> int` (photo rows with this token id ÷ sample count, int).
- Produces (routes, all on `APIRouter(prefix="/api", tags=["capture"])`):
  - `POST /api/capture-tokens` (JWT) body `{samples: [{sample_id, lot?, analytes?}], order_label?}` → 201 `{id, token, expires_at}`; 404 naming unknown sample_ids; 422 >50 samples.
  - `DELETE /api/capture-tokens/{token_id}` (JWT) → 204 (idempotent).
  - `GET /api/capture/{token}` (no auth) → 200 `{order_label, samples, photo_count, expires_at}`; 404 unknown; 410 expired/revoked.
  - `POST /api/capture/{token}/photos` (no auth) body `{photo_base64}` → 201 `{created, photo_count}`; 404/410 token; 413 decoded > 10 MB; 415 magic bytes not jpeg/png/webp; 429 shot cap.
- Consumes: Task 1/3 bulk service with `capture_token_id`; `_filename_from_bytes` + `_decode_photo` (import from `packaging_photos.routes`).

- [ ] **Step 1: Failing service tests** (`test_capture_tokens_service.py` — same `db` fixture pattern as packaging; users table row needed for the FK: create a `User` the way other backend tests do, or use `user_id=1` after inserting one):

```python
def test_mint_stores_hash_not_token(db, user):
    tok, raw = mint_capture_token(db, [{"sample_id": "P-1", "lot": "L", "analytes": "A"}], "WP-1", user.id)
    assert raw not in (tok.token_hash or "")
    assert tok.token_hash == hashlib.sha256(raw.encode()).hexdigest()
    assert tok.expires_at > datetime.utcnow()

def test_resolve_happy_and_unknown(db, user):
    tok, raw = mint_capture_token(db, [{"sample_id": "P-1"}], None, user.id)
    assert resolve_capture_token(db, raw).id == tok.id
    with pytest.raises(UnknownTokenError):
        resolve_capture_token(db, "not-a-token")

def test_resolve_expired_and_revoked_are_gone(db, user):
    tok, raw = mint_capture_token(db, [{"sample_id": "P-1"}], None, user.id)
    tok.expires_at = datetime.utcnow() - timedelta(minutes=1)
    db.commit()
    with pytest.raises(GoneTokenError):
        resolve_capture_token(db, raw)
    tok2, raw2 = mint_capture_token(db, [{"sample_id": "P-1"}], None, user.id)
    assert revoke_capture_token(db, tok2.id) is True
    with pytest.raises(GoneTokenError):
        resolve_capture_token(db, raw2)
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement service** (`capture_tokens/service.py`):

```python
"""Capture-token business logic: mint/resolve/revoke + session photo count.

Raw tokens are 256-bit urlsafe strings that exist only in the QR URL; the DB
stores their SHA-256. Scope (sample list + display context) freezes at mint.
"""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from models import LimsCaptureToken, LimsPackagingPhoto

CAPTURE_TOKEN_TTL_HOURS = 2
MAX_PHOTOS_PER_TOKEN = 50
MAX_SAMPLES_PER_TOKEN = 50


class UnknownTokenError(Exception):
    pass


class GoneTokenError(Exception):
    """Expired or revoked — the token existed but is no longer usable."""


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def mint_capture_token(
    db: Session, samples: list[dict], order_label: Optional[str], user_id: int,
) -> tuple[LimsCaptureToken, str]:
    raw = secrets.token_urlsafe(32)
    tok = LimsCaptureToken(
        token_hash=_hash(raw),
        order_label=order_label,
        context_json=json.dumps(samples),
        created_by_user_id=user_id,
        expires_at=datetime.utcnow() + timedelta(hours=CAPTURE_TOKEN_TTL_HOURS),
    )
    db.add(tok)
    db.commit()
    db.refresh(tok)
    return tok, raw


def resolve_capture_token(db: Session, raw: str) -> LimsCaptureToken:
    tok = db.execute(
        select(LimsCaptureToken).where(LimsCaptureToken.token_hash == _hash(raw))
    ).scalar_one_or_none()
    if tok is None:
        raise UnknownTokenError("unknown capture token")
    if tok.revoked_at is not None or tok.expires_at <= datetime.utcnow():
        raise GoneTokenError("capture token expired or revoked")
    return tok


def revoke_capture_token(db: Session, token_id: int) -> bool:
    tok = db.get(LimsCaptureToken, token_id)
    if tok is None:
        return False
    if tok.revoked_at is None:
        tok.revoked_at = datetime.utcnow()
        db.commit()
    return True


def token_photo_count(db: Session, token: LimsCaptureToken) -> int:
    rows = db.execute(
        select(func.count(LimsPackagingPhoto.id))
        .where(LimsPackagingPhoto.capture_token_id == token.id)
    ).scalar_one()
    samples = json.loads(token.context_json)
    return rows // max(1, len(samples))
```

- [ ] **Step 4: Verify service tests pass.**
- [ ] **Step 5: Failing route tests** (`test_capture_tokens_routes.py`): mint 201 + raw token returned once; mint 404 on unknown sample_id; GET context 200 with photo_count 0; GET 404 unknown / 410 after expiry-fudge; POST photo 201 fans out to ALL samples (assert per-sample list length via service) with `capture_token_id` set; POST 413 oversize (`b"\xff\xd8\xff" + b"0" * (10*1024*1024)`); POST 415 on `b"not-an-image"`; POST 429 after `MAX_PHOTOS_PER_TOKEN` monkeypatched to 1; DELETE 204 then GET 410. Follow the packaging routes test file for app construction; the two public routes must be added WITHOUT the auth dependency override mattering.
- [ ] **Step 6: Implement schemas + routes** (`capture_tokens/schemas.py`):

```python
from typing import Optional
from pydantic import BaseModel, Field


class CaptureSampleContext(BaseModel):
    sample_id: str
    lot: Optional[str] = None
    analytes: Optional[str] = None


class CaptureTokenCreate(BaseModel):
    samples: list[CaptureSampleContext] = Field(min_length=1, max_length=50)
    order_label: Optional[str] = None


class CaptureTokenOut(BaseModel):
    id: int
    token: str
    expires_at: str


class CaptureContextOut(BaseModel):
    order_label: Optional[str]
    samples: list[CaptureSampleContext]
    photo_count: int
    expires_at: str


class CapturePhotoIn(BaseModel):
    photo_base64: str


class CapturePhotoOut(BaseModel):
    created: int
    photo_count: int
```

(`capture_tokens/routes.py`):

```python
"""Capture-token router: two JWT-authed mint/revoke routes and two
token-authed phone routes. Token lookup is by SHA-256 — no session."""
import json

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import select

from database import get_db
from auth import get_current_user
from models import LimsSample
from capture_tokens import service
from capture_tokens.schemas import (
    CaptureTokenCreate, CaptureTokenOut, CaptureContextOut,
    CapturePhotoIn, CapturePhotoOut, CaptureSampleContext,
)
from packaging_photos.routes import _decode_photo, _filename_from_bytes
from packaging_photos.service import create_packaging_photos_bulk

router = APIRouter(prefix="/api", tags=["capture"])

_MAX_PHOTO_BYTES = 10 * 1024 * 1024
_ALLOWED_EXTS = {".jpg", ".png", ".webp"}


def _resolve_or_http(db: Session, token: str):
    try:
        return service.resolve_capture_token(db, token)
    except service.UnknownTokenError:
        raise HTTPException(status_code=404, detail="unknown capture token")
    except service.GoneTokenError:
        raise HTTPException(status_code=410, detail="capture token expired or revoked")


@router.post("/capture-tokens", status_code=status.HTTP_201_CREATED, response_model=CaptureTokenOut)
def mint_capture_token(
    body: CaptureTokenCreate,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    ids = [s.sample_id for s in body.samples]
    found = set(db.execute(
        select(LimsSample.sample_id).where(LimsSample.sample_id.in_(ids))
    ).scalars())
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(status_code=404, detail=f"samples not found: {', '.join(missing)}")
    tok, raw = service.mint_capture_token(
        db, [s.model_dump() for s in body.samples], body.order_label, user.id,
    )
    return CaptureTokenOut(id=tok.id, token=raw, expires_at=tok.expires_at.isoformat() + "Z")


@router.delete("/capture-tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_capture_token(
    token_id: int,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    service.revoke_capture_token(db, token_id)
    return None


@router.get("/capture/{token}", response_model=CaptureContextOut)
def get_capture_context(token: str, db: Session = Depends(get_db)):
    tok = _resolve_or_http(db, token)
    samples = [CaptureSampleContext(**s) for s in json.loads(tok.context_json)]
    return CaptureContextOut(
        order_label=tok.order_label,
        samples=samples,
        photo_count=service.token_photo_count(db, tok),
        expires_at=tok.expires_at.isoformat() + "Z",
    )


@router.post("/capture/{token}/photos", status_code=status.HTTP_201_CREATED, response_model=CapturePhotoOut)
def add_capture_photo(token: str, body: CapturePhotoIn, db: Session = Depends(get_db)):
    tok = _resolve_or_http(db, token)
    if service.token_photo_count(db, tok) >= service.MAX_PHOTOS_PER_TOKEN:
        raise HTTPException(status_code=429, detail="photo limit reached for this QR session")
    photo_bytes = _decode_photo(body.photo_base64)
    if len(photo_bytes) > _MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="photo exceeds 10 MB")
    filename = _filename_from_bytes(photo_bytes)
    if not any(filename.endswith(ext) for ext in _ALLOWED_EXTS):
        raise HTTPException(status_code=415, detail="unsupported image type")
    # _filename_from_bytes falls back to .jpg for unknown bytes — reject
    # anything whose leading bytes don't actually sniff as an allowed type.
    if photo_bytes[:3] != b"\xff\xd8\xff" and photo_bytes[:8] != b"\x89PNG\r\n\x1a\n" and not (
        photo_bytes[:4] == b"RIFF" and photo_bytes[8:12] == b"WEBP"
    ):
        raise HTTPException(status_code=415, detail="unsupported image type")
    sample_ids = [s["sample_id"] for s in json.loads(tok.context_json)]
    photos = create_packaging_photos_bulk(
        db, sample_ids, photo_bytes, filename, "image/jpeg", None,
        tok.created_by_user_id, capture_token_id=tok.id,
    )
    return CapturePhotoOut(
        created=len(photos),
        photo_count=service.token_photo_count(db, tok),
    )
```

`main.py`: `from capture_tokens.routes import router as capture_tokens_router` next to the packaging import; `app.include_router(capture_tokens_router)` next to the packaging include.

- [ ] **Step 7: Verify all backend tests pass** (both new files + both packaging files).
- [ ] **Step 8: Commit** — `feat(capture): token mint/revoke + phone capture routes`

---

## Stream B — Frontend desktop (Tasks 5–7, sequential, one agent)

### Task 5: API clients

**Files:**
- Modify: `src/lib/api.ts` (append near the existing packaging-photo clients — find `createPackagingPhoto`)

**Interfaces:**
- Produces:

```typescript
export interface CaptureSampleContext {
  sample_id: string
  lot?: string | null
  analytes?: string | null
}
export interface CaptureTokenMint {
  id: number
  token: string
  expires_at: string
}
export function createPackagingPhotosBulk(args: {
  parentSampleIds: string[]
  photoBase64: string
  remarks?: string | null
}): Promise<PackagingPhoto[]>          // POST /packaging-photos/bulk
export function mintCaptureToken(args: {
  samples: CaptureSampleContext[]
  orderLabel?: string | null
}): Promise<CaptureTokenMint>          // POST /capture-tokens
```

- [ ] **Step 1:** Read the existing `createPackagingPhoto`/`listPackagingPhotos` implementations and copy their transport idiom exactly (same fetch wrapper, same error handling, body keys `parent_sample_ids`, `photo_base64`, `remarks` / `samples`, `order_label`). No revoke client (nothing calls it yet — YAGNI; the endpoint exists for ops use).
- [ ] **Step 2:** `npm run typecheck` passes.
- [ ] **Step 3: Commit** — `feat(api): bulk packaging + capture-token clients`

### Task 6: PackagingPanel fan-out + polling

**Files:**
- Modify: `src/components/intake/ReceiveWizard/PackagingPanel.tsx`
- Modify: `src/components/intake/ReceiveWizard/PackagingImagesList.tsx` (polling)
- Modify: `src/components/intake/ReceiveWizard/ReceiveWizard.tsx` (thread props)
- Modify: `src/components/intake/OrderReceiveSession.tsx` (supply props)
- Test: `src/components/intake/ReceiveWizard/__tests__/PackagingPanel.test.tsx` (append)

**Interfaces:**
- Consumes: Task 5 clients.
- Produces: `PackagingPanel` new optional props `fanoutSampleIds?: string[]` and `captureContext?: { orderLabel: string | null; samples: CaptureSampleContext[] }` (captureContext is consumed in Task 7 — thread it now so the wiring ships once). `ReceiveWizard` accepts and forwards the same two props. `OrderReceiveSession` passes `fanoutSampleIds={boxingSampleIds}` and a `captureContext` built from its sidebar rows (it already computes lot + analytes per sample — reuse those exact values). Standalone `ReceiveWizard` (no order) builds a one-sample `captureContext` from `useParentSampleDetails` (`lot = details?.client_lot ?? null`, `analytes` = the joined analyte label it already renders) and passes NO `fanoutSampleIds`.

- [ ] **Step 1: Failing test** (append to PackagingPanel.test.tsx; mock `createPackagingPhotosBulk` in the existing `vi.mock('@/lib/api', ...)` block):

```typescript
it('fans the save out to every order sample when fanoutSampleIds is set', async () => {
  const { container } = renderPanelWithContainer({
    fanoutSampleIds: ['P-1', 'P-2', 'P-3'],
  })
  pickFile(container)
  await screen.findByAltText('Uploaded packaging')
  fireEvent.click(screen.getByRole('button', { name: 'Save packaging photo' }))
  await waitFor(() => expect(mockCreateBulk).toHaveBeenCalledTimes(1))
  expect(mockCreateBulk.mock.calls[0]?.[0]?.parentSampleIds).toEqual(['P-1', 'P-2', 'P-3'])
  expect(mockCreate).not.toHaveBeenCalled()
})

it('uses the single endpoint when fanoutSampleIds is absent', async () => {
  const { container } = renderPanelWithContainer()
  pickFile(container)
  await screen.findByAltText('Uploaded packaging')
  fireEvent.click(screen.getByRole('button', { name: 'Save packaging photo' }))
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
  expect(mockCreateBulk).not.toHaveBeenCalled()
})
```

NOTE (env quirk): the `file-path + Save` test in this file is a known-red environment failure on this machine (jsdom Blob). If `pickFile → Save` cannot drive the new tests green for the same reason, drive the fan-out test through the camera-capture path instead (mock camera as in `vial-panel-capture.test.tsx`) or assert via a directly-invoked save with `photoDataUrl` state seeded — do NOT ship a test that is red for environmental reasons.

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement:**
  - `PackagingPanel`: add the two props; in `handleSave`'s create branch, `if (fanoutSampleIds && fanoutSampleIds.length > 1)` → `await createPackagingPhotosBulk({ parentSampleIds: fanoutSampleIds, photoBase64, remarks: trimmedRemarks ?? null })`, invalidate `['packaging-photos', id]` for each id, toast `Photo added to ${fanoutSampleIds.length} samples` (the file already imports the toast util in siblings — use `sonner`'s `toast` as `ReceiveWizard.tsx` does); else the existing single-sample call untouched. Edit mode never fans out.
  - `PackagingImagesList`: add `refetchInterval: 2500` to the packaging-photos list query options (polling runs only while the list is mounted, i.e. the packaging tab).
  - `ReceiveWizard`: two new optional props, forwarded to `PackagingPanel`; standalone context built as specified in Interfaces.
  - `OrderReceiveSession`: pass both props where it renders `ReceiveWizard` (it already passes `boxing` — same site).
- [ ] **Step 4: Verify pass** (PackagingPanel tests + `npm run typecheck`).
- [ ] **Step 5: Commit** — `feat(receive): packaging photo order fan-out + live list polling`

### Task 7: CaptureQrCard

**Files:**
- Create: `src/components/intake/ReceiveWizard/CaptureQrCard.tsx`
- Modify: `src/components/intake/ReceiveWizard/PackagingPanel.tsx` (render the card in the live-capture column)
- Test: `src/components/intake/ReceiveWizard/__tests__/CaptureQrCard.test.tsx`

**Interfaces:**
- Consumes: Task 5 `mintCaptureToken`, Task 6 `captureContext` prop; `qrcode.react` (`QRCodeSVG`).
- Produces: `<CaptureQrCard captureContext={...} />` — self-contained; mints on mount, renders QR + caption, renders `null` on mint failure or while pending.

- [ ] **Step 1: Failing test:**

```typescript
vi.mock('@/lib/api', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, mintCaptureToken: vi.fn() }
})
import { mintCaptureToken } from '@/lib/api'
import { CaptureQrCard } from '@/components/intake/ReceiveWizard/CaptureQrCard'
const mockMint = vi.mocked(mintCaptureToken)

it('mints a token and renders the QR link', async () => {
  mockMint.mockResolvedValue({ id: 1, token: 'tok123', expires_at: '2099-01-01T00:00:00Z' })
  render(<CaptureQrCard captureContext={{ orderLabel: 'WP-1', samples: [{ sample_id: 'P-1' }] }} />)
  await screen.findByText(/scan with your phone/i)
  expect(mockMint).toHaveBeenCalledWith({ samples: [{ sample_id: 'P-1' }], orderLabel: 'WP-1' })
  // QRCodeSVG renders an <svg>
  expect(document.querySelector('svg')).toBeTruthy()
})

it('renders nothing when the mint fails', async () => {
  mockMint.mockRejectedValue(new Error('nope'))
  const { container } = render(
    <CaptureQrCard captureContext={{ orderLabel: null, samples: [{ sample_id: 'P-1' }] }} />
  )
  await waitFor(() => expect(mockMint).toHaveBeenCalled())
  expect(container.textContent).toBe('')
})
```

- [ ] **Step 2: Verify failure** (module not found).
- [ ] **Step 3: Implement** — component:

```tsx
import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Smartphone } from 'lucide-react'
import { mintCaptureToken, type CaptureSampleContext } from '@/lib/api'

export interface CaptureContext {
  orderLabel: string | null
  samples: CaptureSampleContext[]
}

/**
 * QR the tech scans to add packaging photos from their phone. Mints a
 * scoped 2h capture token on mount; the QR is the only place the raw token
 * ever appears. Mint failure just hides the card — the desktop camera is
 * unaffected and the QR is a pure enhancement.
 */
export function CaptureQrCard({ captureContext }: { captureContext: CaptureContext }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    mintCaptureToken({
      samples: captureContext.samples,
      orderLabel: captureContext.orderLabel,
    })
      .then(res => {
        if (!cancelled) {
          setUrl(`${window.location.origin}/m/capture.html?t=${res.token}`)
        }
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
    // context is stable for the life of the packaging tab; remount = new token
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!url) return null
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3 max-w-md">
      <QRCodeSVG value={url} size={96} className="shrink-0 rounded bg-white p-1" />
      <div className="text-sm">
        <p className="font-medium flex items-center gap-1">
          <Smartphone className="w-4 h-4" aria-hidden="true" />
          Scan with your phone to add box photos
        </p>
        <p className="text-muted-foreground text-xs mt-1">
          Photos land on {captureContext.samples.length > 1
            ? `all ${captureContext.samples.length} samples in this order`
            : 'this sample'} within a few seconds. Link expires in 2 hours.
        </p>
      </div>
    </div>
  )
}
```

  - `PackagingPanel`: render `{captureContext && cameraPhase === 'live' && <CaptureQrCard captureContext={captureContext} />}` under the controls row (both `cameraOk` branches — put it after the `</section>`-internal controls but inside the section so it shows even when the desktop camera is unavailable: the QR is MOST useful exactly then; simplest correct placement is directly after the `{cameraOk ? (...) : (...)}` ternary, still inside the section).
- [ ] **Step 4: Verify pass** (new test file + PackagingPanel file + typecheck).
- [ ] **Step 5: Commit** — `feat(receive): QR card for phone packaging capture`

---

## Stream C — Phone page (Task 8, one agent)

### Task 8: Static mobile capture page + nginx cache rule

**Files:**
- Create: `public/m/capture.html`, `public/m/capture.js`
- Modify: `nginx.conf` (no-cache for `/m/`)

**Interfaces:**
- Consumes (pinned contracts — the backend agent builds these in parallel; do NOT import anything):
  - `GET /api/api/capture/{t}` → 200 `{order_label, samples: [{sample_id, lot, analytes}], photo_count, expires_at}` | 404 | 410
  - `POST /api/api/capture/{t}/photos` body `{photo_base64}` → 201 `{created, photo_count}` | 404/410/413/415/429
  - (`/api/api` because the page bypasses the SPA's api client; nginx strips one `/api`.)

- [ ] **Step 1: Build the page.** `capture.html`: `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<meta name="color-scheme" content="light dark">`, inline CSS (system font stack, dark-aware via `prefers-color-scheme`, big thumb-friendly button ≥ 56 px tall), structure:

```html
<header>Accumark — Packaging Photos</header>
<section id="context">      <!-- order label + sample rows: ID / Lot / Analytes -->
<section id="shoot">
  <label class="capture-btn" for="camera">📦 Take photo</label>
  <input id="camera" type="file" accept="image/*" capture="environment" hidden>
  <p id="status"></p>       <!-- "Saved — 3 photos this session" / error + Retry -->
  <div id="thumbs"></div>   <!-- object-URL thumbnails of this session's shots -->
</section>
<section id="expired" hidden>This QR has expired — reopen the packaging tab on the desktop to get a fresh one.</section>
<script src="capture.js"></script>
```

`capture.js` (complete logic, vanilla):

```javascript
const API = '/api/api'
const token = new URLSearchParams(location.search).get('t')

async function loadContext() {
  const r = await fetch(`${API}/capture/${encodeURIComponent(token)}`)
  if (r.status === 404 || r.status === 410) return showExpired()
  if (!r.ok) return showStatus(`Could not load (${r.status}) — pull to refresh`, true)
  renderContext(await r.json())
}

// Downscale to max edge 2000px, re-encode JPEG q0.85 (normalizes HEIC,
// caps upload size), return base64 without the data: prefix.
async function encodeShot(file) {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
}

async function upload(dataUrl) {
  const r = await fetch(`${API}/capture/${encodeURIComponent(token)}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photo_base64: dataUrl }),
  })
  if (r.status === 404 || r.status === 410) return showExpired()
  if (!r.ok) throw new Error(`upload failed (${r.status})`)
  return r.json()
}
```

plus: `input.onchange` → spinner → `encodeShot` → `upload` → append thumbnail + update count; on throw keep the encoded shot in a `pending` var and show a Retry button that re-calls `upload`. iOS Safari < 17 lacks `createImageBitmap(File)` in some paths — wrap in try/catch and fall back to `FileReader.readAsDataURL` + `<img>` decode into the canvas.

- [ ] **Step 2: nginx** — add above the SPA fallback:

```nginx
    # Phone capture page — tiny, must never go stale across deploys
    location /m/ {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }
```

- [ ] **Step 3: Static checks** — `npm run build` succeeds and `dist/m/capture.html` + `dist/m/capture.js` exist (Vite public/ passthrough). `node --check public/m/capture.js` parses. (Interactive phone UAT happens post-merge on a stack; do not attempt to run a backend.)
- [ ] **Step 4: Commit** — `feat(capture): static phone capture page + nginx no-cache rule`

---

## Task 9: Integration gate (orchestrator, after all streams merge)

- [ ] `npm run typecheck` clean; `npx eslint` on all touched files → no NEW findings vs baseline; `npx prettier --check` on new files.
- [ ] Full backend packaging + capture test files green in the container.
- [ ] Full FE suite failure-set diff vs origin/master baseline — no new failures attributable to the change.
- [ ] `npm run build` clean.
- [ ] Commit anything outstanding; report.
