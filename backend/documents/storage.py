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
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        except OSError as e:
            raise DocumentStorageError(f"write failed for {key!r}: {e}") from e
        return key

    def fetch(self, key: str) -> bytes:
        path = self._safe(key)
        if path.is_dir():
            raise DocumentStorageError(f"key names a directory: {key!r}")
        if not path.is_file():
            raise DocumentNotFound(key)
        try:
            return path.read_bytes()
        except OSError as e:
            raise DocumentStorageError(f"read failed for {key!r}: {e}") from e

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
        try:
            return self._s3.save_photo(code, data, f"r{revision}.html")
        except Exception as e:  # PhotoStorageError, ClientError, credentials, ...
            raise DocumentStorageError(
                f"save failed for {code!r} r{revision}: {e}") from e

    def fetch(self, key: str) -> bytes:
        from sub_samples.photo_storage import PhotoNotFoundError
        _check_key(key)
        try:
            return self._s3.fetch_photo(key)
        except PhotoNotFoundError as e:
            raise DocumentNotFound(str(e)) from e
        except Exception as e:  # AccessDenied, NoSuchBucket, throttling, creds, ...
            raise DocumentStorageError(f"fetch failed for {key!r}: {e}") from e


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
