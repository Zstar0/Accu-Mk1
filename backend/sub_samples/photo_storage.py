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

_CONTENT_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
}


def _extension_for(filename: str) -> str:
    """Return lowercased suffix if in _KNOWN_EXTS, else '.bin'."""
    ext = Path(filename or "").suffix.lower()
    return ext if ext in _KNOWN_EXTS else ".bin"


def _build_rel_key(sample_id: str, filename: str) -> str:
    """Build relative key 'sample_id/uuid.ext'; raise if sample_id is falsy."""
    if not sample_id:
        raise PhotoStorageError("save_photo: sample_id is required")
    return f"{sample_id}/{uuid.uuid4().hex}{_extension_for(filename)}"


def _content_type_for_key(key: str) -> str:
    """Return MIME type by extension, else 'application/octet-stream'."""
    return _CONTENT_TYPES.get(Path(key).suffix.lower(), "application/octet-stream")


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
        if not photo_bytes:
            raise PhotoStorageError("save_photo: photo_bytes is empty")
        rel_key = _build_rel_key(sample_id, filename)
        abs_path = self.root / rel_key
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_bytes(photo_bytes)
        log.info("photo_storage.saved sample=%s key=%s size=%d", sample_id, rel_key, len(photo_bytes))
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


class S3PhotoStorage:
    """S3-backed PhotoStorage. Objects live at {prefix}{rel_key}; the DB keeps
    the prefix-less rel_key as mk1://{rel_key}, so existing pointers resolve."""

    def __init__(self, bucket=None, prefix=None, region=None, client=None):
        self.bucket = bucket or os.environ["MK1_PHOTO_S3_BUCKET"]
        p = prefix if prefix is not None else os.environ.get("MK1_PHOTO_S3_PREFIX", "sub-sample-photos/")
        self.prefix = p if (p == "" or p.endswith("/")) else p + "/"
        self.region = region or os.environ.get("S3_REGION") or os.environ.get("AWS_REGION", "us-west-1")
        if client is not None:
            self._client = client
        else:
            import boto3
            from botocore.config import Config
            self._client = boto3.client(
                "s3", region_name=self.region,
                config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
            )

    def _object_key(self, rel_key: str) -> str:
        if not rel_key or rel_key.startswith("/") or ".." in rel_key.split("/"):
            raise PhotoStorageError(f"unsafe key: {rel_key!r}")
        return f"{self.prefix}{rel_key}"

    def save_photo(self, sample_id: str, photo_bytes: bytes, filename: str) -> str:
        if not photo_bytes:
            raise PhotoStorageError("save_photo: photo_bytes is empty")
        rel_key = _build_rel_key(sample_id, filename)
        self._client.put_object(
            Bucket=self.bucket, Key=self._object_key(rel_key),
            Body=photo_bytes, ContentType=_content_type_for_key(rel_key),
        )
        log.info("photo_storage.s3_saved sample=%s key=%s size=%d", sample_id, rel_key, len(photo_bytes))
        return rel_key

    def fetch_photo(self, key: str) -> bytes:
        obj_key = self._object_key(key)
        from botocore.exceptions import ClientError
        try:
            resp = self._client.get_object(Bucket=self.bucket, Key=obj_key)
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code == "NoSuchKey":
                raise PhotoNotFoundError(f"no photo at key={key!r}")
            raise
        return resp["Body"].read()

    def delete_photo(self, key: str) -> None:
        self._client.delete_object(Bucket=self.bucket, Key=self._object_key(key))


# Module-level singleton. Wire via env at import.
_storage: PhotoStorage = FilesystemPhotoStorage()


def get_storage() -> PhotoStorage:
    """Return the active PhotoStorage instance."""
    return _storage


def set_storage_for_tests(storage: PhotoStorage) -> None:
    """Override the singleton (test-only)."""
    global _storage
    _storage = storage
