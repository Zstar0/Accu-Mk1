"""Packaging-photo business logic.

Storage-backed CRUD for parent-sample packaging photos. Bytes live in the same
Mk1 PhotoStorage as vial photos (sub_samples/photo_storage.py); the metadata
row lives in lims_packaging_photos. Photos are keyed by the PARENT sample_id ->
{parent_sample_id}/{uuid}.{ext}, and storage_key persists the mk1://{key} URI
(same convention as lims_sub_samples.photo_external_uid).
"""

from __future__ import annotations

import logging
from typing import Optional, Tuple

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from models import LimsSample, LimsPackagingPhoto
from sub_samples.photo_storage import get_storage

log = logging.getLogger(__name__)

_PREFIX = "mk1://"


def _resolve_parent(db: Session, parent_sample_id: str) -> LimsSample:
    """Return the parent LimsSample by its sample_id, or raise LookupError."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise LookupError(f"parent sample {parent_sample_id!r} not found")
    return parent


def create_packaging_photo(
    db: Session,
    parent_sample_id: str,
    photo_bytes: bytes,
    filename: str,
    content_type: Optional[str],
    remarks: Optional[str],
    user_id: Optional[int],
) -> LimsPackagingPhoto:
    """Persist a packaging photo against a parent sample.

    Raises LookupError if the parent sample is unknown. Assigns
    ordering = max+1 per parent. Bytes go to PhotoStorage keyed by the parent
    sample_id; storage_key holds mk1://{key}.
    """
    parent = _resolve_parent(db, parent_sample_id)

    key = get_storage().save_photo(parent_sample_id, photo_bytes, filename)

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
    db.commit()
    db.refresh(photo)
    return photo


def list_packaging_photos(db: Session, parent_sample_id: str) -> list[LimsPackagingPhoto]:
    """Return the parent's packaging photos ordered by `ordering` (then id)."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if parent is None:
        return []
    return list(db.execute(
        select(LimsPackagingPhoto)
        .where(LimsPackagingPhoto.parent_sample_pk == parent.id)
        .order_by(LimsPackagingPhoto.ordering, LimsPackagingPhoto.id)
    ).scalars())


def get_packaging_photo(db: Session, photo_id: int) -> Optional[LimsPackagingPhoto]:
    """Return a packaging photo by id, or None if missing."""
    return db.get(LimsPackagingPhoto, photo_id)


def read_packaging_photo_bytes(
    db: Session, photo_id: int
) -> Optional[Tuple[bytes, Optional[str]]]:
    """Return (bytes, content_type) for a packaging photo, or None if missing.

    Strips the mk1:// prefix before fetching from storage.
    """
    photo = db.get(LimsPackagingPhoto, photo_id)
    if photo is None:
        return None
    key = photo.storage_key[len(_PREFIX):] if photo.storage_key.startswith(_PREFIX) else photo.storage_key
    raw = get_storage().fetch_photo(key)
    return raw, photo.content_type


def update_packaging_photo(
    db: Session,
    photo_id: int,
    photo_bytes: Optional[bytes],
    remarks: Optional[str],
) -> Optional[LimsPackagingPhoto]:
    """Update a packaging photo's remarks and/or bytes; None if missing.

    When photo_bytes is given: save the new file, swap storage_key, commit,
    and only then delete the old key — deleting before the commit would lose
    both copies if the commit fails (same order as delete_packaging_photo).
    remarks is only written when provided (None leaves it alone).
    """
    photo = db.get(LimsPackagingPhoto, photo_id)
    if photo is None:
        return None
    if remarks is not None:
        photo.remarks = remarks
    old_key = None
    new_key = None
    if photo_bytes is not None:
        parent = db.get(LimsSample, photo.parent_sample_pk)
        parent_sample_id = parent.sample_id if parent else str(photo.parent_sample_pk)
        old_key = (
            photo.storage_key[len(_PREFIX):]
            if photo.storage_key.startswith(_PREFIX) else photo.storage_key
        )
        new_key = get_storage().save_photo(
            parent_sample_id, photo_bytes, photo.filename or "packaging.jpg"
        )
        photo.storage_key = f"{_PREFIX}{new_key}"
    db.commit()
    db.refresh(photo)
    if old_key and old_key != new_key:
        _delete_stored_photo_quietly(old_key)
    return photo


def delete_packaging_photo(db: Session, photo_id: int) -> bool:
    """Delete a packaging photo row + its stored bytes. False if missing."""
    photo = db.get(LimsPackagingPhoto, photo_id)
    if photo is None:
        return False
    key = (
        photo.storage_key[len(_PREFIX):]
        if photo.storage_key.startswith(_PREFIX) else photo.storage_key
    )
    db.delete(photo)
    db.commit()
    _delete_stored_photo_quietly(key)
    return True


def _delete_stored_photo_quietly(key: str) -> None:
    """Best-effort storage delete — a leaked file must never fail the request."""
    from sub_samples.photo_storage import PhotoStorageError
    try:
        get_storage().delete_photo(key)
    except PhotoStorageError as e:
        log.warning("packaging_photos.photo_cleanup_failed key=%s err=%s", key, e)
