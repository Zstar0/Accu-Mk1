# Mk1-Native Analyses Phase 2.5 — Sub-Sample Photo Storage in Mk1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move sub-sample photo storage off SENAITE and into Mk1's own filesystem-backed blob store. New vials write the photo to a Mk1-side path; the existing photo-fetch route dual-sources by detecting the storage kind via a `mk1://` URI prefix. Existing vials with photos on SENAITE secondary ARs keep working unchanged. Future migration to S3 is mechanical (swap one storage adapter).

**Architecture:** Add a named Docker volume (`mk1_sub_sample_photos`) mounted at `/data/sub_sample_photos/` inside the backend container. New `backend/sub_samples/photo_storage.py` module owns the filesystem layer with a tiny abstract interface (`save_photo`, `fetch_photo`, `delete_photo`) so a future S3-adapter swap touches one file. `create_sub_sample` drops its `senaite.upload_photo()` call and writes via the storage module instead, persisting a `mk1://{key}` URI in `lims_sub_samples.photo_external_uid`. The photo-fetch route at `routes.py:269` branches on that prefix: `mk1://` → read from disk; anything else → existing SENAITE-proxy code path.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres (Accu-Mk1 backend), pytest. Storage layer is `pathlib` + bytes — no new Python dependencies. Docker volume for per-stack isolation.

**Spec context:** SPEC `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md` §Open Question 3 endorses moving photos off SENAITE as the long-term direction. Phase 2 stopped short of this (kept photos on SENAITE secondary AR per the Task 1 RED-fallback pivot). Phase 2.5 picks it up.

**Phase 2 predecessor:** `docs/superpowers/plans/2026-06-03-mk1-native-analyses-phase2.md` (revised). Photos currently land in SENAITE via `senaite.upload_photo()`; Phase 2.5 cuts that.

**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`, PR #9).

---

## Scope decisions (locked in; flag if you disagree before Task 1)

1. **Local filesystem via Docker named volume.** Path inside container: `/data/sub_sample_photos/`. Volume name: `mk1_sub_sample_photos`. Per-stack isolation via compose. Easy backup via `docker run --rm -v mk1_sub_sample_photos:/data alpine tar czf - /data`. Production migration to S3 is a future adapter swap.

2. **`photo_external_uid` carries a URI scheme.** New vials store `mk1://{key}` where `{key}` is `{sample_id}/{uuid4}.{ext}` (e.g. `mk1://PB-0075-S01/9a3f...c2.png`). Existing vials' values (which are SENAITE AR paths like `/senaite/clients/client-8/PB-0075-S01`) keep working because the dispatch logic in the fetch route checks for the `mk1://` prefix first; anything else falls through to the existing SENAITE proxy. No backfill.

3. **The SENAITE secondary AR continues to be created** (no change from Phase 2). Phase 2.5 only stops calling `senaite.upload_photo` — the AR itself still exists for sample_id discoverability and as a legacy anchor. Dropping the secondary AR entirely is deferred to Phase 5 cleanup.

4. **Storage key derivation:** filename is `{uuid4}.{ext}` so two vials can have the same display name without collision. Extension is sniffed from the original filename (`.jpg`, `.png`, `.jpeg`) with `.bin` fallback. The sample_id forms a subdirectory so on-disk inspection is human-readable.

5. **No multi-photo support yet.** Each vial has one photo. If a re-upload happens, the old key is overwritten (or replaced + old file deleted). Keep it simple — the data model already only supports one photo via the single `photo_external_uid` column.

6. **No S3 today** — but the abstract interface (`PhotoStorage` Protocol) is shaped so an S3 implementation can drop in without touching `create_sub_sample` or the route. Notes in the module for the future implementer.

If any decision is wrong, redirect before Task 1.

---

## File Structure

**Backend (new):**
- `backend/sub_samples/photo_storage.py` — filesystem-backed `PhotoStorage` with `save_photo(sample_id, bytes, filename) -> str`, `fetch_photo(key) -> bytes`, `delete_photo(key) -> None`. Module-level singleton wired off the `MK1_PHOTO_STORAGE_DIR` env var.
- `backend/tests/test_photo_storage.py` — unit tests for the storage layer (round-trip, key shape, missing-file behavior).

**Backend (modified):**
- `backend/sub_samples/service.py:108-234` (`create_sub_sample`) — replace `senaite.upload_photo()` call with `photo_storage.save_photo()`; persist `mk1://{key}` to `photo_external_uid`. SENAITE secondary AR creation stays.
- `backend/sub_samples/routes.py:269-356` (`get_sub_sample_photo`) — branch on `photo_external_uid` prefix: `mk1://` → read from local storage; legacy → existing SENAITE proxy code path.
- `backend/tests/test_sub_samples_service.py` — patch the senaite.upload_photo expectation in existing tests (it's no longer called for new vials); add a test for `mk1://` URI generation.

**Infrastructure (modified):**
- `accumark-stack/docker-compose.yml` — add `mk1_sub_sample_photos` to the top-level `volumes:` block; add the volume + mount to the `accu-mk1-backend:` service block; add `MK1_PHOTO_STORAGE_DIR` env var.

**Out of scope for this plan:**
- S3 storage adapter — future Phase 5 work (data already in the right shape).
- Backfill of existing vial photos from SENAITE → Mk1 storage — dual-source on read covers this indefinitely.
- Frontend changes — the photo-fetch URL `/api/sub-samples/{sample_id}/photo` returns the same shape (image bytes); UI unchanged.
- Photo deletion / re-upload UI — handled organically by `save_photo`'s overwrite-on-existing semantics; no new endpoints.
- Photo-fetch caching — out of scope.
- Multi-photo per vial — schema doesn't support it; out of scope.

---

## How to run tests

- Unit: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_photo_storage.py -v"`
- Service: same harness, `tests/test_sub_samples_service.py`
- Full suite: same harness, `tests/`. Baseline failures from Phase 2's full-suite run (13 failures, 423 passed) must not increase.

---

## Task 1: Add the photo-storage volume to the stack compose

**Files:**
- Modify: `accumark-stack/docker-compose.yml`

- [ ] **Step 1: Find the `accu-mk1-backend:` service block + the top-level `volumes:` block**

```bash
grep -n "^  accu-mk1-backend:\|^volumes:" /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/accumark-stack/docker-compose.yml
```

Note both line numbers. The volume gets defined at the top level and mounted in the service block.

- [ ] **Step 2: Add the volume to the top-level `volumes:` block**

Find the existing `volumes:` block (likely near the end of the file). Append:

```yaml
  mk1_sub_sample_photos:
    name: ${COMPOSE_PROJECT_NAME:-accumark-host}_mk1_sub_sample_photos
    driver: local
```

The `name:` field gives each stack its own isolated volume name (e.g. `accumark-subvial_mk1_sub_sample_photos`).

- [ ] **Step 3: Add `volumes:` + `MK1_PHOTO_STORAGE_DIR` env to the `accu-mk1-backend:` service block**

In the `accu-mk1-backend:` block, after the existing `environment:` map, add:

```yaml
      # Sub-sample photo storage (Phase 2.5 — see
      # docs/superpowers/plans/2026-06-03-mk1-native-analyses-phase2.5-photo-storage.md).
      # Persistent named volume so photos survive container recreate.
      MK1_PHOTO_STORAGE_DIR: /data/sub_sample_photos
```

Then add a `volumes:` key to the same service block (sibling of `environment:`, `depends_on:`, `networks:`):

```yaml
    volumes:
      - mk1_sub_sample_photos:/data/sub_sample_photos
```

If a `volumes:` key already exists on this service (per the subvial stack's source-bind-mount overlay), append the new entry rather than replacing.

- [ ] **Step 4: Recreate the Mk1 backend container so it picks up the volume**

```bash
cd /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/accumark-stack && \
  docker compose -p accumark-subvial --env-file ~/.accumark-stack/stacks/subvial/.env up -d --no-deps accu-mk1-backend
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
docker exec accumark-subvial-accu-mk1-backend ls -la /data/sub_sample_photos/
docker exec accumark-subvial-accu-mk1-backend printenv MK1_PHOTO_STORAGE_DIR
```

Expected:
- `ls` returns an empty directory (`total 0` or similar).
- `printenv` returns `/data/sub_sample_photos`.

- [ ] **Step 5: Commit the stack template change**

```bash
cd /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/accumark-stack
git add docker-compose.yml
git commit -m "feat(stack): mk1 sub_sample_photos volume + MK1_PHOTO_STORAGE_DIR env"
```

(Stack repo is separate from Mk1 — commit lives there.)

---

## Task 2: PhotoStorage module + tests

**Files:**
- Create: `backend/sub_samples/photo_storage.py`
- Create: `backend/tests/test_photo_storage.py`

- [ ] **Step 1: Write the storage module**

Create `backend/sub_samples/photo_storage.py`:

```python
"""
Mk1 sub-sample photo storage.

Filesystem-backed blob store for sub-sample photos. Photos live under
MK1_PHOTO_STORAGE_DIR (default /data/sub_sample_photos), organized by
sample_id subdirectory:

    {MK1_PHOTO_STORAGE_DIR}/{sample_id}/{uuid4}.{ext}

The save_photo() function returns the storage KEY (path relative to the
storage root). Callers persist that key as `mk1://{key}` in
lims_sub_samples.photo_external_uid so the photo-fetch route can
distinguish Mk1-stored photos from legacy SENAITE-AR-path values.

Future S3 migration: implement the same three functions against an S3
SDK and swap the module-level `_storage` singleton. The route + service
layer don't change.
"""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Protocol

log = logging.getLogger(__name__)

_DEFAULT_DIR = "/data/sub_sample_photos"
_KNOWN_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"}


class PhotoStorageError(RuntimeError):
    """Raised on any storage-layer failure (write, read, delete)."""


class PhotoNotFoundError(LookupError):
    """Raised when fetch_photo can't locate a key."""


class PhotoStorage(Protocol):
    """Minimal storage contract. Filesystem impl ships in Phase 2.5; an S3
    impl can drop in later without changing callers."""

    def save_photo(self, sample_id: str, photo_bytes: bytes, filename: str) -> str:
        """Persist photo_bytes and return the storage key (no prefix)."""

    def fetch_photo(self, key: str) -> bytes:
        """Read photo bytes by key. Raises PhotoNotFoundError if missing."""

    def delete_photo(self, key: str) -> None:
        """Remove photo by key. Idempotent — missing key is not an error."""


class FilesystemPhotoStorage:
    """Default impl. One file per photo under {root}/{sample_id}/{uuid}.{ext}."""

    def __init__(self, root: str | None = None):
        self.root = Path(root or os.environ.get("MK1_PHOTO_STORAGE_DIR", _DEFAULT_DIR))
        self.root.mkdir(parents=True, exist_ok=True)

    def save_photo(self, sample_id: str, photo_bytes: bytes, filename: str) -> str:
        if not sample_id:
            raise PhotoStorageError("save_photo: sample_id is required")
        if not photo_bytes:
            raise PhotoStorageError("save_photo: photo_bytes is empty")

        ext = self._extension_for(filename)
        photo_uuid = uuid.uuid4().hex
        rel_key = f"{sample_id}/{photo_uuid}{ext}"
        abs_path = self.root / rel_key
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_bytes(photo_bytes)
        log.info(
            "photo_storage.saved sample=%s key=%s size=%d",
            sample_id, rel_key, len(photo_bytes),
        )
        return rel_key

    def fetch_photo(self, key: str) -> bytes:
        abs_path = self._safe_resolve(key)
        if not abs_path.exists():
            raise PhotoNotFoundError(f"no photo at key={key!r}")
        return abs_path.read_bytes()

    def delete_photo(self, key: str) -> None:
        abs_path = self._safe_resolve(key)
        if abs_path.exists():
            abs_path.unlink()
            log.info("photo_storage.deleted key=%s", key)

    def _extension_for(self, filename: str) -> str:
        ext = Path(filename or "").suffix.lower()
        if ext in _KNOWN_EXTS:
            return ext
        return ".bin"

    def _safe_resolve(self, key: str) -> Path:
        """Resolve a relative key under self.root; refuse path traversal."""
        if not key or key.startswith("/") or ".." in key.split("/"):
            raise PhotoStorageError(f"unsafe key: {key!r}")
        resolved = (self.root / key).resolve()
        # Ensure resolved path is still under root after symlink resolution
        try:
            resolved.relative_to(self.root.resolve())
        except ValueError as e:
            raise PhotoStorageError(f"key escapes storage root: {key!r}") from e
        return resolved


# Module-level singleton. Wire via env at import.
_storage: PhotoStorage = FilesystemPhotoStorage()


def get_storage() -> PhotoStorage:
    """Return the active PhotoStorage instance."""
    return _storage


def set_storage_for_tests(storage: PhotoStorage) -> None:
    """Override the singleton (test-only)."""
    global _storage
    _storage = storage
```

- [ ] **Step 2: Write tests**

Create `backend/tests/test_photo_storage.py`:

```python
"""Unit tests for backend/sub_samples/photo_storage.py.

Uses a tmp_path fixture so tests are isolated from the live volume.
"""

from __future__ import annotations

import pytest

from sub_samples.photo_storage import (
    FilesystemPhotoStorage,
    PhotoNotFoundError,
    PhotoStorageError,
)


PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "89000000004949454e44ae426082"
)


@pytest.fixture
def storage(tmp_path):
    return FilesystemPhotoStorage(root=str(tmp_path))


def test_save_returns_key_with_sample_id_prefix(storage):
    key = storage.save_photo("PB-0075-S01", PNG, "vial.png")
    assert key.startswith("PB-0075-S01/")
    assert key.endswith(".png")


def test_save_and_fetch_round_trip(storage):
    key = storage.save_photo("PB-0075-S01", PNG, "vial.png")
    fetched = storage.fetch_photo(key)
    assert fetched == PNG


def test_save_uses_unique_uuid_per_call(storage):
    k1 = storage.save_photo("S-01", PNG, "a.png")
    k2 = storage.save_photo("S-01", PNG, "b.png")
    assert k1 != k2


def test_save_unknown_extension_falls_back_to_bin(storage):
    key = storage.save_photo("S-01", PNG, "weird")
    assert key.endswith(".bin")


def test_save_jpg_extension_preserved(storage):
    key = storage.save_photo("S-01", PNG, "vial.JPG")  # case-insensitive
    assert key.endswith(".jpg")


def test_save_empty_bytes_raises(storage):
    with pytest.raises(PhotoStorageError):
        storage.save_photo("S-01", b"", "vial.png")


def test_save_missing_sample_id_raises(storage):
    with pytest.raises(PhotoStorageError):
        storage.save_photo("", PNG, "vial.png")


def test_fetch_missing_key_raises(storage):
    with pytest.raises(PhotoNotFoundError):
        storage.fetch_photo("S-01/nonexistent.png")


def test_delete_is_idempotent(storage):
    key = storage.save_photo("S-01", PNG, "v.png")
    storage.delete_photo(key)
    storage.delete_photo(key)  # second call is a no-op


def test_delete_then_fetch_raises(storage):
    key = storage.save_photo("S-01", PNG, "v.png")
    storage.delete_photo(key)
    with pytest.raises(PhotoNotFoundError):
        storage.fetch_photo(key)


def test_path_traversal_rejected(storage):
    with pytest.raises(PhotoStorageError):
        storage.fetch_photo("../etc/passwd")
    with pytest.raises(PhotoStorageError):
        storage.fetch_photo("/etc/passwd")
    with pytest.raises(PhotoStorageError):
        storage.fetch_photo("S-01/../../etc/passwd")


def test_multiple_samples_isolated_by_subdir(storage, tmp_path):
    k_a = storage.save_photo("PB-001", PNG, "a.png")
    k_b = storage.save_photo("PB-002", PNG, "b.png")
    assert (tmp_path / "PB-001").is_dir()
    assert (tmp_path / "PB-002").is_dir()
    assert k_a.startswith("PB-001/")
    assert k_b.startswith("PB-002/")
```

- [ ] **Step 3: Run the tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_photo_storage.py -v"
```

Expected: 12 passed.

- [ ] **Step 4: Commit**

```bash
cd /c/tmp/Accu-Mk1-subvial
git add backend/sub_samples/photo_storage.py backend/tests/test_photo_storage.py
git commit -m "feat(mk1): filesystem-backed PhotoStorage for sub-sample photos"
```

---

## Task 3: Swap `create_sub_sample` photo write to Mk1 storage

**Files:**
- Modify: `backend/sub_samples/service.py` (the photo-upload block at lines ~196-206 of the current `create_sub_sample`)

- [ ] **Step 1: Read the current photo-upload block**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "sed -n '195,230p' /app/sub_samples/service.py"
```

Note the exact code that calls `senaite.upload_photo(create_result.path, photo_bytes, photo_filename)` and the `senaite.delete_secondary(create_result.uid)` compensation on failure.

- [ ] **Step 2: Replace the photo-upload block**

In `create_sub_sample`, find this block (currently lines ~196-206):

```python
    # 2. Upload photo. Compensate (delete the secondary) on failure so we don't
    #    leave a vial without a photo.
    try:
        senaite.upload_photo(create_result.path, photo_bytes, photo_filename)
    except Exception:
        try:
            senaite.delete_secondary(create_result.uid)
        except Exception as cleanup_err:
            log.error("sub_samples.photo_upload_orphan uid=%s cleanup_err=%s",
                      create_result.uid, cleanup_err)
        raise
```

Replace with:

```python
    # 2. Persist photo to Mk1 storage (Phase 2.5). Compensate (delete the
    #    SENAITE secondary) on failure so we don't leave a vial without a photo.
    #    The SENAITE secondary AR is kept for sample_id discoverability; only
    #    the photo write goes to Mk1 now.
    from sub_samples.photo_storage import get_storage
    photo_key: Optional[str] = None
    try:
        # Use the SENAITE-generated sample_id so on-disk path matches the
        # eventual lims_sub_samples row.
        photo_key = get_storage().save_photo(
            create_result.sample_id, photo_bytes, photo_filename,
        )
    except Exception:
        try:
            senaite.delete_secondary(create_result.uid)
        except Exception as cleanup_err:
            log.error("sub_samples.photo_save_orphan uid=%s cleanup_err=%s",
                      create_result.uid, cleanup_err)
        raise
```

Then in the `LimsSubSample(...)` constructor below it, change:

```python
        photo_external_uid=create_result.path,
```

to:

```python
        # mk1://{key} URI scheme distinguishes Mk1-stored photos from legacy
        # SENAITE secondary-AR paths during fetch-route dispatch.
        photo_external_uid=f"mk1://{photo_key}",
```

- [ ] **Step 3: Sanity-import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from sub_samples.service import create_sub_sample
from sub_samples.photo_storage import get_storage
print('imports ok; storage root=', get_storage().root)
"
```

Expected: `imports ok; storage root= /data/sub_sample_photos`.

- [ ] **Step 4: Smoke a real create end-to-end**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && cat > /tmp/_smoke_create.py << 'PYEOF'
from sqlalchemy import select, desc, delete
from database import SessionLocal
from sub_samples import service as ss
from sub_samples import senaite
from sub_samples.photo_storage import get_storage
from models import LimsSample, LimsSubSample, LimsAnalysis, LimsAnalysisTransition
from pathlib import Path

db = SessionLocal()
parent = db.execute(select(LimsSample).where(LimsSample.sample_id == 'BW-0013')).scalar_one()
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000004949454e44ae426082')
sub = ss.create_sub_sample(db, parent.sample_id, png, 'mk1smoke.png', 'PHASE2.5 SMOKE', 1)
print(f'created {sub.sample_id} photo_external_uid={sub.photo_external_uid!r}')
assert sub.photo_external_uid.startswith('mk1://'), f'Expected mk1:// prefix, got {sub.photo_external_uid!r}'
key = sub.photo_external_uid[len('mk1://'):]
print(f'storage key={key}')
on_disk = Path(get_storage().root) / key
print(f'on-disk: exists={on_disk.exists()} size={on_disk.stat().st_size if on_disk.exists() else 0}')
fetched = get_storage().fetch_photo(key)
print(f'fetched bytes match upload? {fetched == png}')
# Cleanup
get_storage().delete_photo(key)
db.execute(delete(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id.in_(
    db.execute(select(LimsAnalysis.id).where(LimsAnalysis.lims_sub_sample_pk == sub.id)).scalars().all()
)))
db.execute(delete(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == sub.id))
db.execute(delete(LimsSubSample).where(LimsSubSample.id == sub.id))
db.commit()
try:
    senaite.delete_secondary(sub.external_lims_uid)
except Exception as e:
    print(f'(orphan SENAITE secondary {sub.external_lims_uid} — pre-existing delete bug, ignore)')
db.close()
print('CLEAN')
PYEOF
python /tmp/_smoke_create.py"
```

Expected:
- `created BW-0013-S07 photo_external_uid='mk1://BW-0013-S07/<uuid>.png'`
- `on-disk: exists=True size=N`
- `fetched bytes match upload? True`
- `CLEAN`

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-subvial
git add backend/sub_samples/service.py
git commit -m "feat(mk1): create_sub_sample writes photo to Mk1 storage instead of SENAITE"
```

---

## Task 4: Dual-source the photo-fetch route

**Files:**
- Modify: `backend/sub_samples/routes.py:269-356` (`get_sub_sample_photo`)

- [ ] **Step 1: Read the current route**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "sed -n '265,360p' /app/sub_samples/routes.py"
```

Note where it diverges into SENAITE-proxy code. The new logic branches BEFORE that point if the URI starts with `mk1://`.

- [ ] **Step 2: Add the Mk1-storage branch at the top of the route body**

Find the line `if sub:` inside `get_sub_sample_photo`. Immediately after the existing `if not sub.photo_external_uid:` check, add the dispatch branch BEFORE the line that reads `ar_uid = sub.external_lims_uid`:

```python
    if sub:
        if not sub.photo_external_uid:
            raise HTTPException(404, f"No photo on file for {sample_id}")

        # Phase 2.5: dispatch on storage URI. Mk1-stored photos come back
        # directly from disk; legacy SENAITE-AR-path values fall through to
        # the existing proxy code below.
        if sub.photo_external_uid.startswith("mk1://"):
            from fastapi.responses import Response
            from sub_samples.photo_storage import (
                PhotoNotFoundError, get_storage,
            )
            key = sub.photo_external_uid[len("mk1://"):]
            try:
                photo_bytes = get_storage().fetch_photo(key)
            except PhotoNotFoundError:
                raise HTTPException(404, f"Photo missing from storage for {sample_id}")
            # Derive content-type from extension. Browsers tolerate
            # application/octet-stream but the image cell needs a real type.
            ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
            content_type = {
                "png": "image/png",
                "jpg": "image/jpeg",
                "jpeg": "image/jpeg",
                "gif": "image/gif",
                "webp": "image/webp",
                "heic": "image/heic",
            }.get(ext, "application/octet-stream")
            return Response(content=photo_bytes, media_type=content_type)

        ar_uid = sub.external_lims_uid
```

Leave everything below `ar_uid = sub.external_lims_uid` unchanged — that's the legacy SENAITE-proxy path that older vials still use.

- [ ] **Step 3: Confirm the route mounts cleanly**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
curl -sS http://localhost:5530/openapi.json | python -c "
import json, sys
spec = json.load(sys.stdin)
for p in sorted(spec['paths']):
    if 'photo' in p and 'sub-samples' in p:
        print(p, list(spec['paths'][p].keys()))
"
```

Expected: `/api/sub-samples/{sample_id}/photo ['get']`.

- [ ] **Step 4: End-to-end smoke through HTTP**

Create a real sub-sample (with the Phase 2.5 storage path), then fetch via HTTP:

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && cat > /tmp/_smoke_http.py << 'PYEOF'
from sqlalchemy import select, delete
from database import SessionLocal
from sub_samples import service as ss
from sub_samples.photo_storage import get_storage
from models import LimsSample, LimsSubSample, LimsAnalysis, LimsAnalysisTransition
import requests

db = SessionLocal()
parent = db.execute(select(LimsSample).where(LimsSample.sample_id == 'BW-0013')).scalar_one()
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000004949454e44ae426082')
sub = ss.create_sub_sample(db, parent.sample_id, png, 'http_smoke.png', 'P2.5 HTTP', 1)
sid = sub.sample_id
key = sub.photo_external_uid[len('mk1://'):]
print(f'created {sid} key={key}')
db.close()

# No-auth probe — should 401 (proves route is reachable + auth-gated)
r = requests.get(f'http://localhost:8012/api/sub-samples/{sid}/photo')
print(f'no-auth → {r.status_code}')
assert r.status_code in (401, 403), f'unexpected status {r.status_code}'

# Manually unprotect by overriding the get_current_user dep — same pattern
# the test fixtures use.
from main import app
from auth import get_current_user
app.dependency_overrides[get_current_user] = lambda: type('U',(),{'id':1})()
from fastapi.testclient import TestClient
with TestClient(app) as c:
    r = c.get(f'/api/sub-samples/{sid}/photo')
print(f'authed → {r.status_code}  ct={r.headers.get(\"content-type\")}  bytes={len(r.content)}  matches={r.content == png}')

# Cleanup
db = SessionLocal()
get_storage().delete_photo(key)
fresh = db.execute(select(LimsSubSample).where(LimsSubSample.sample_id == sid)).scalar_one()
db.execute(delete(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id.in_(
    db.execute(select(LimsAnalysis.id).where(LimsAnalysis.lims_sub_sample_pk == fresh.id)).scalars().all()
)))
db.execute(delete(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == fresh.id))
db.execute(delete(LimsSubSample).where(LimsSubSample.id == fresh.id))
db.commit()
db.close()
print('CLEAN')
PYEOF
python /tmp/_smoke_http.py"
```

Expected:
- `no-auth → 401` (or 403)
- `authed → 200  ct=image/png  bytes=70  matches=True`
- `CLEAN`

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-subvial
git add backend/sub_samples/routes.py
git commit -m "feat(mk1): photo-fetch route dual-sources mk1:// keys + legacy SENAITE paths"
```

---

## Task 5: Update the existing service-layer tests

**Files:**
- Modify: `backend/tests/test_sub_samples_service.py`

These tests patched `senaite.upload_photo` to confirm it was called. Phase 2.5 no longer calls it — those assertions must change. Also add a new test asserting the `mk1://` URI lands in `photo_external_uid`.

- [ ] **Step 1: Find the existing tests that patch upload_photo**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "grep -n 'upload_photo\|photo_external_uid' /app/tests/test_sub_samples_service.py"
```

Note each line that references `upload_photo` or asserts on `photo_external_uid`. The asserts likely expect `create_result.path` — replace with the `mk1://` URI shape.

- [ ] **Step 2: Patch the affected tests**

For each test that does:

```python
with patch("sub_samples.service.senaite.upload_photo") as mock_upload:
    sub = create_sub_sample(...)
    mock_upload.assert_called_once_with(create_result.path, photo_bytes, "...")
```

Change to patch `sub_samples.photo_storage.get_storage()` instead:

```python
from unittest.mock import patch, MagicMock

mock_storage = MagicMock()
mock_storage.save_photo.return_value = "P-0134-S01/abc123.png"

with patch("sub_samples.service.get_storage", return_value=mock_storage):
    # ^ create_sub_sample imports get_storage at call-time, so this works
    sub = create_sub_sample(...)
    mock_storage.save_photo.assert_called_once()
    assert sub.photo_external_uid == "mk1://P-0134-S01/abc123.png"
```

If a test asserts `sub.photo_external_uid == create_result.path`, change to `assert sub.photo_external_uid == "mk1://P-0134-S01/abc123.png"` (matching the mock return).

- [ ] **Step 3: Add a focused test for the URI scheme**

Append to the file:

```python
def test_create_sub_sample_persists_mk1_uri_to_photo_external_uid(
    db, monkeypatch,
):
    """Phase 2.5: photo storage writes to Mk1; photo_external_uid carries
    a mk1:// URI so the photo-fetch route can dispatch correctly."""
    from unittest.mock import MagicMock, patch
    from models import LimsSample
    from sub_samples.senaite import SecondaryCreateResult

    parent = LimsSample(
        sample_id="P-0134", external_lims_uid="PARENT_UID",
        client_uid="C", contact_uid="CT_UID", sample_type="ST",
    )
    db.add(parent)
    db.commit()

    fake_result = SecondaryCreateResult(
        uid="SECONDARY_UID", sample_id="P-0134-S01",
        path="/senaite/clients/c/P-0134-S01",
    )
    fake_storage = MagicMock()
    fake_storage.save_photo.return_value = "P-0134-S01/deadbeef.png"

    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value={"uid": "PARENT_UID", "ContactUID": "CT_UID"}), \
         patch("sub_samples.service.senaite.uid_exists", return_value=True), \
         patch("sub_samples.service.senaite.create_secondary",
               return_value=fake_result), \
         patch("sub_samples.service.senaite.extract_inheritable_fields",
               return_value={}), \
         patch("sub_samples.service.senaite.update_remarks"), \
         patch("sub_samples.service.get_storage",
               return_value=fake_storage):
        from sub_samples.service import create_sub_sample
        sub = create_sub_sample(
            db, "P-0134", b"\x89PNG", "vial.png", remarks=None, user_id=1,
        )

    fake_storage.save_photo.assert_called_once_with("P-0134-S01", b"\x89PNG", "vial.png")
    assert sub.photo_external_uid == "mk1://P-0134-S01/deadbeef.png"
    # senaite.upload_photo NOT called — assert it isn't on the senaite module
    # (the test patches above don't include upload_photo precisely because we
    # expect it untouched).
```

- [ ] **Step 4: Run the test file**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_sub_samples_service.py -v 2>&1 | tail -30"
```

Expected: all tests pass (some pre-existing baseline failures like `test_list_sub_samples_with_children` may persist — that's part of the 13-failure baseline, not a Phase 2.5 regression).

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-subvial
git add backend/tests/test_sub_samples_service.py
git commit -m "test(mk1): update create_sub_sample tests for Mk1 photo storage path"
```

---

## Task 6: Live verification through the Receive Wizard

Verification-only — no commit.

- [ ] **Step 1: Open the wizard frontend**

```
1. http://localhost:5532
2. sessionStorage.setItem('accu_mk1_api_url_override', 'http://localhost:5530'); location.reload()
3. Log in as forrest@valenceanalytical.com / test123
4. Pick a parent (BW-0013 or PB-0075) → Add Vial via the wizard
5. Capture photo → enter remarks → confirm → assign role HPLC or ENDO on the Assign step
```

- [ ] **Step 2: Inspect the new vial**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select, desc
from models import LimsSubSample
from pathlib import Path
from sub_samples.photo_storage import get_storage

db = SessionLocal()
last = db.execute(select(LimsSubSample).order_by(desc(LimsSubSample.id)).limit(1)).scalar_one()
print(f'newest sub: {last.sample_id}')
print(f'  external_lims_uid={last.external_lims_uid!r}')
print(f'  photo_external_uid={last.photo_external_uid!r}')
print(f'  assignment_role={last.assignment_role!r}')
if last.photo_external_uid and last.photo_external_uid.startswith('mk1://'):
    key = last.photo_external_uid[len('mk1://'):]
    abs_path = Path(get_storage().root) / key
    print(f'  on-disk: path={abs_path} exists={abs_path.exists()} size={abs_path.stat().st_size if abs_path.exists() else 0}')
else:
    print('  WARN: photo_external_uid does NOT start with mk1:// — Phase 2.5 not active for this vial')
db.close()
"
```

Expected:
- `photo_external_uid='mk1://{sample_id}/{uuid}.png'`
- On-disk path exists, size > 0.

- [ ] **Step 3: Confirm the photo cell renders**

Open the sub-sample's detail page in the wizard. The photo cell should render the captured image. If broken, check the Network tab for `/api/sub-samples/{sample_id}/photo` — should be 200 with `content-type: image/png` (or jpeg).

- [ ] **Step 4: Confirm SENAITE secondary AR exists but has NO attachment**

The SENAITE-side photo upload was dropped. The secondary AR should still exist (for sample_id) but with zero attachments:

```bash
SENAITE_PASS=$(grep '^SENAITE_PASSWORD=' ~/.accumark-stack/stacks/subvial/.env | cut -d= -f2)
SAMPLE_ID="<paste sample_id from Step 2>"
curl -sS -u "forrest@valenceanalytical.com:${SENAITE_PASS}" \
  "http://localhost:5538/senaite/@@API/senaite/v1/search?portal_type=AnalysisRequest&id=${SAMPLE_ID}&complete=true" \
  | python -c "import sys,json; d=json.load(sys.stdin); items=d.get('items',[])
if items:
    ar=items[0]
    print(f'AR exists: id={ar[\"id\"]} state={ar[\"review_state\"]}')
    print(f'attachments: {len(ar.get(\"Attachments\", []))}')"
```

Expected: AR exists, attachments count = 0.

- [ ] **Step 5: Confirm legacy vials still render their photos**

Pick an existing pre-Phase-2.5 sub-sample (e.g. `BW-0013-S01` through `BW-0013-S06`, which were created when the SENAITE-upload path was active). Open its detail page. Photo should still render — proving the dual-source fallback works.

---

## Verification (Phase 2.5 acceptance)

- [ ] **Volume mounted + env wired** (Task 1 Step 4)
- [ ] **PhotoStorage tests pass: 12 passed** (Task 2 Step 3)
- [ ] **Create-then-fetch round-trip works in Mk1 storage** (Task 3 Step 4 + Task 4 Step 4)
- [ ] **Photo-fetch route returns image bytes for `mk1://` keys + image/* content-type** (Task 4 Step 4)
- [ ] **New vial via wizard lands `mk1://...` in `photo_external_uid`** (Task 6 Step 2)
- [ ] **SENAITE secondary AR has zero attachments for new vials** (Task 6 Step 4)
- [ ] **Pre-Phase-2.5 vials still render their photos** (Task 6 Step 5)
- [ ] **Full suite has no NEW regressions beyond the 13-failure baseline**

---

## Risks and unknowns

- **Volume lifecycle.** Named Docker volumes persist across `docker compose down` but are removed by `docker compose down -v`. Document that for future fresh-stack spawns. For real backup, `docker run --rm -v {stack}_mk1_sub_sample_photos:/data alpine tar czf - -C /data .`.

- **Path traversal.** `_safe_resolve` rejects keys with `..`, leading `/`, and any final-resolved-path outside the storage root. The `mk1://` URI scheme prevents the storage-key-from-DB attack surface (no user input flows directly into `fetch_photo(key)` — the key comes from `lims_sub_samples.photo_external_uid`, which is set by our own service-layer code).

- **`create_sub_sample` no longer fails when SENAITE attachments are rejected** (because we don't call SENAITE for the photo anymore). If the Mk1 disk write fails (rare — out-of-space, permissions), the compensating `delete_secondary` still fires, matching the existing failure contract.

- **The pre-existing `senaite.delete_secondary` bug** (uses `deactivate` workflow transition; SENAITE expects `cancel` for received-state ARs) is unchanged. If `save_photo` fails AFTER `create_secondary` succeeds, the compensation will log a warning but the secondary will orphan. Not new with this plan — same shape as today.

- **Existing test `test_sub_samples_routes::test_list_sub_samples_with_children`** is part of the baseline 13 failures. Not in this plan's scope; ignore.

- **Frontend type assumptions.** The image cell consumes the photo via `<img src="/api/sub-samples/{id}/photo">`. As long as the response is a valid image with a proper content-type, the existing UI just works. No frontend changes needed.

## Open questions (carried forward from spec)

These are SPEC-level questions Phase 2.5 does NOT resolve:

1. **S3 migration** — left for Phase 5 cleanup. The `PhotoStorage` Protocol is the swap point.
2. **Backfill of legacy SENAITE photos into Mk1 storage** — explicitly deferred. Dual-source on read handles it indefinitely.
3. **Multi-photo per vial** — schema constraint (one `photo_external_uid` column). Defer until a real need.

## Out of scope (carried forward)

- Worksheet routing — Phase 3.
- `AnalysisTable.tsx` adapter — Phase 3.
- `promote_to_parent` + verification UI — Phase 4.
- COA resolver default-path simplification — Phase 5.
- **Dropping the SENAITE secondary AR entirely** — Phase 5 cleanup (after parent ARs move into Mk1).
- S3 storage adapter — see Open Question 1 above.
