"""Blob storage for document HTML (spec §4).

Same three-way shape as flags.seams' attachment storage: in-memory for tests,
filesystem in dev, S3 in prod (through sub_samples.photo_storage.S3PhotoStorage
with its own key prefix). Only the relative key is stored in documents.storage_key.
"""
from __future__ import annotations

import hashlib
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

    def delete(self, key: str) -> None:
        """Remove bytes by key. Already-gone is success, not an error: delete
        runs after the row is gone, so a retry must not wedge on a missing blob."""


def _blob_name(revision: int, data: bytes) -> str:
    """r{revision}-{sha12}.html. The content hash is what makes the key unique:
    two pushes that both compute revision N+1 for one code write different blobs,
    so the loser's bytes can never replace the winner's (the (code, revision)
    unique constraint still rejects the losing ROW, after the blob is safely its
    own object)."""
    return f"r{revision}-{hashlib.sha256(data).hexdigest()[:12]}.html"


def _rel_key(code: str, revision: int, data: bytes) -> str:
    return f"{code}/{_blob_name(revision, data)}"


def _check_key(key: str) -> None:
    if not key or key.startswith("/") or ".." in key.split("/"):
        raise DocumentStorageError(f"unsafe key: {key!r}")


class InMemoryDocumentStorage:
    """Test double. Keys ({code}/r{revision}-{sha12}.html) and bytes live in `blobs`."""

    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}

    def save(self, code: str, revision: int, data: bytes) -> str:
        if not data:
            raise DocumentStorageError("save: empty content")
        key = _rel_key(code, revision, data)
        self.blobs[key] = data
        return key

    def fetch(self, key: str) -> bytes:
        _check_key(key)
        if key not in self.blobs:
            raise DocumentNotFound(key)
        return self.blobs[key]

    def delete(self, key: str) -> None:
        _check_key(key)
        self.blobs.pop(key, None)


class FilesystemDocumentStorage:
    """Dev default. {root}/{code}/r{revision}-{sha12}.html.

    Root = MK1_DOCUMENTS_DIR when set, else {MK1_PHOTO_STORAGE_DIR or /app/data}
    /documents. The fallback sits inside the vial-photo volume because that is the
    only blob volume the stacks mount; a root of its own would live on the
    container filesystem and vanish on the next recreate."""

    def __init__(self, root: Optional[str] = None) -> None:
        if root is None:
            root = os.environ.get("MK1_DOCUMENTS_DIR") or str(
                Path(os.environ.get("MK1_PHOTO_STORAGE_DIR") or "/app/data") / "documents")
        self.root = Path(root)
        try:
            self.root.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise DocumentStorageError(
                f"cannot create documents root {self.root}: {e}") from e

    def save(self, code: str, revision: int, data: bytes) -> str:
        if not data:
            raise DocumentStorageError("save: empty content")
        key = _rel_key(code, revision, data)
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

    def delete(self, key: str) -> None:
        path = self._safe(key)
        try:
            path.unlink(missing_ok=True)
        except OSError as e:
            raise DocumentStorageError(f"delete failed for {key!r}: {e}") from e

    def _safe(self, key: str) -> Path:
        _check_key(key)
        resolved = (self.root / key).resolve()
        try:
            resolved.relative_to(self.root.resolve())
        except ValueError as e:
            raise DocumentStorageError(f"key escapes root: {key!r}") from e
        return resolved


def _s3_prefix() -> str:
    """Default to documents/ NESTED UNDER the vial-photo prefix, not beside it.
    Prod's IAM key is scoped to the photo prefix, so a top-level documents/ is
    AccessDenied there while sub-sample-photos/documents/ is allowed (probed
    from the prod backend 2026-09-17). MK1_DOCUMENTS_S3_PREFIX still overrides."""
    explicit = os.environ.get("MK1_DOCUMENTS_S3_PREFIX")
    if explicit:
        return explicit
    photo = os.environ.get("MK1_PHOTO_S3_PREFIX", "sub-sample-photos/")
    if photo and not photo.endswith("/"):
        photo += "/"
    return f"{photo}documents/"


class S3DocumentStorage:
    """Prod. Objects at {prefix}{code}/{uuid}.bin in the vial-photo bucket
    (S3PhotoStorage maps unknown extensions to .bin; the DB row carries the real
    content type, so the object name never matters). Prefix: see _s3_prefix."""

    def __init__(self) -> None:
        from sub_samples.photo_storage import S3PhotoStorage
        self._s3 = S3PhotoStorage(
            prefix=_s3_prefix())

    def save(self, code: str, revision: int, data: bytes) -> str:
        if not data:
            raise DocumentStorageError("save: empty content")
        try:
            return self._s3.save_photo(code, data, _blob_name(revision, data))
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

    def delete(self, key: str) -> None:
        from sub_samples.photo_storage import PhotoNotFoundError
        _check_key(key)
        try:
            self._s3.delete_photo(key)
        except PhotoNotFoundError:
            return  # already gone
        except Exception as e:
            raise DocumentStorageError(f"delete failed for {key!r}: {e}") from e


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
