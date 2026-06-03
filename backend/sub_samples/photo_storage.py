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
