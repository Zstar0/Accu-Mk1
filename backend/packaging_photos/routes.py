"""Packaging-photo FastAPI router.

Five Mk1-native routes for parent-sample packaging photos. Bytes decode from
base64 at the boundary (same approach as sub_samples/routes.py); business logic
delegates to packaging_photos.service. All routes require a Bearer/JWT user.

The router carries prefix "/api" so the two served path shapes are exactly
    POST/GET /api/samples/{parent_sample_id}/packaging-photos
    GET/PATCH/DELETE /api/packaging-photos/{photo_id}
"""
import base64

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user
from models import User
from users_display import user_display_name
from packaging_photos import service
from packaging_photos.schemas import (
    PackagingPhotoCreate,
    PackagingPhotoUpdate,
    PackagingPhotoOut,
)

router = APIRouter(prefix="/api", tags=["packaging-photos"])


def _decode_photo(photo_base64: str) -> bytes:
    """Decode base64 photo string to bytes. Handles data: URL prefix."""
    try:
        if photo_base64.startswith("data:"):
            photo_base64 = photo_base64.split(",", 1)[1]
        return base64.b64decode(photo_base64, validate=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid photo_base64: {e}")


# Served Content-Type by stored-key extension. The client-supplied
# content_type column is metadata only — serving it back would let a caller
# store e.g. text/html and turn the download route into a stored-XSS surface.
_EXT_MEDIA_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}


def _filename_from_bytes(photo_bytes: bytes) -> str:
    """Return a packaging filename whose extension matches the actual bytes.

    get_packaging_photo_bytes derives the served Content-Type from the stored
    key's extension, so it must stay honest regardless of source. Sniff the
    leading magic bytes; fall back to '.jpg'.
    """
    ext = ".jpg"
    if photo_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        ext = ".png"
    elif photo_bytes[:3] == b"\xff\xd8\xff":
        ext = ".jpg"
    elif photo_bytes[:6] in (b"GIF87a", b"GIF89a"):
        ext = ".gif"
    elif photo_bytes[:4] == b"RIFF" and photo_bytes[8:12] == b"WEBP":
        ext = ".webp"
    return f"packaging{ext}"


@router.post(
    "/samples/{parent_sample_id}/packaging-photos",
    status_code=status.HTTP_201_CREATED,
    response_model=PackagingPhotoOut,
)
def create_packaging_photo(
    parent_sample_id: str,
    body: PackagingPhotoCreate,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Capture a packaging photo against a parent sample."""
    photo_bytes = _decode_photo(body.photo_base64)
    try:
        photo = service.create_packaging_photo(
            db,
            parent_sample_id=parent_sample_id,
            photo_bytes=photo_bytes,
            filename=body.filename or _filename_from_bytes(photo_bytes),
            content_type=body.content_type,
            remarks=body.remarks,
            user_id=user.id,
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return PackagingPhotoOut.model_validate(photo)


@router.get(
    "/samples/{parent_sample_id}/packaging-photos",
    response_model=list[PackagingPhotoOut],
)
def list_packaging_photos(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List a parent's packaging photos, ordered."""
    photos = service.list_packaging_photos(db, parent_sample_id)
    # Uploader names, batched (one SELECT) — shown in the attachment lightbox.
    # int-guard: tolerate rows (and mocked test doubles) without a real id.
    uploader_ids = {
        p.created_by_user_id
        for p in photos
        if isinstance(getattr(p, "created_by_user_id", None), int)
    }
    name_by_id: dict[int, str] = {}
    if uploader_ids:
        name_by_id = {
            u.id: user_display_name(u)
            for u in db.execute(
                select(User).where(User.id.in_(uploader_ids))
            ).scalars()
        }
    out = []
    for p in photos:
        item = PackagingPhotoOut.model_validate(p)
        if p.created_by_user_id is not None:
            item.created_by = name_by_id.get(p.created_by_user_id)
        out.append(item)
    return out


@router.get("/packaging-photos/{photo_id}")
def get_packaging_photo_bytes(
    photo_id: int,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Stream a packaging photo's raw bytes.

    The served Content-Type derives from the stored key's extension; the
    client-supplied content_type on the row is never echoed back.
    """
    photo = service.get_packaging_photo(db, photo_id)
    if photo is None:
        raise HTTPException(status_code=404, detail=f"packaging photo {photo_id} not found")
    result = service.read_packaging_photo_bytes(db, photo_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"packaging photo {photo_id} not found")
    raw, _ = result
    basename = photo.storage_key.rsplit("/", 1)[-1]
    ext = basename.rsplit(".", 1)[-1].lower() if "." in basename else ""
    return Response(
        content=raw,
        media_type=_EXT_MEDIA_TYPES.get(ext, "application/octet-stream"),
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f'inline; filename="{basename}"',
        },
    )


@router.patch("/packaging-photos/{photo_id}", response_model=PackagingPhotoOut)
def update_packaging_photo(
    photo_id: int,
    body: PackagingPhotoUpdate,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Update a packaging photo's remarks and/or bytes."""
    photo_bytes = _decode_photo(body.photo_base64) if body.photo_base64 else None
    photo = service.update_packaging_photo(db, photo_id, photo_bytes, body.remarks)
    if photo is None:
        raise HTTPException(status_code=404, detail=f"packaging photo {photo_id} not found")
    return PackagingPhotoOut.model_validate(photo)


@router.delete("/packaging-photos/{photo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_packaging_photo(
    photo_id: int,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Delete a packaging photo (row + stored bytes)."""
    if not service.delete_packaging_photo(db, photo_id):
        raise HTTPException(status_code=404, detail=f"packaging photo {photo_id} not found")
    return None
