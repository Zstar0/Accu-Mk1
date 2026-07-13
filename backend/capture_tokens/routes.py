"""Capture-token router: two JWT-authed mint/revoke routes and two
token-authed phone routes. Token lookup is by SHA-256 — no session."""
import json

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user
from capture_tokens import service
from sub_samples.service import ensure_sample_row
from capture_tokens.schemas import (
    CaptureTokenCreate, CaptureTokenOut, CaptureContextOut,
    CapturePhotoIn, CapturePhotoOut, CaptureSampleContext,
)
from packaging_photos.routes import _decode_photo, _filename_from_bytes
from packaging_photos.service import create_packaging_photos_bulk

router = APIRouter(prefix="/api", tags=["capture"])

_MAX_PHOTO_BYTES = 10 * 1024 * 1024
# Base64 inflates by 4/3 plus a little slack for a data: URL prefix — checked
# against the raw string BEFORE decoding, since this route is unauthenticated
# and a full in-memory decode of an arbitrarily large body is unnecessary work
# an anonymous caller can force. The post-decode _MAX_PHOTO_BYTES check below
# stays as defense in depth.
_MAX_PHOTO_B64_CHARS = (_MAX_PHOTO_BYTES * 4) // 3 + 1024
_ALLOWED_EXTS = {".jpg", ".png", ".webp"}
_EXT_CONTENT_TYPES = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


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
    # Order-flow sibling ids come from SENAITE-shaped searches, and only the
    # actively-touched sample gets eagerly materialized into lims_samples —
    # an untouched sibling may have no local row yet. Resolve each one via
    # the same lazy first-touch path as the packaging bulk-fanout service
    # (ensure_sample_row) instead of a bare local SELECT, so those siblings
    # get lazily upserted from SENAITE rather than 404ing the whole mint.
    # Only an id ensure_sample_row truly cannot resolve (RuntimeError:
    # SENAITE unreachable or has no such AR) counts as missing.
    missing = []
    for sid in (s.sample_id for s in body.samples):
        try:
            ensure_sample_row(db, sid)
        except RuntimeError:
            missing.append(sid)
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
    if len(body.photo_base64) > _MAX_PHOTO_B64_CHARS:
        raise HTTPException(status_code=413, detail="photo exceeds 10 MB")
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
    # filename already sniffed above; the 415 checks guarantee its extension
    # is one of _ALLOWED_EXTS, so PNG/WebP no longer get mislabeled jpeg.
    content_type = _EXT_CONTENT_TYPES["." + filename.rsplit(".", 1)[-1]]
    sample_ids = [s["sample_id"] for s in json.loads(tok.context_json)]
    photos = create_packaging_photos_bulk(
        db, sample_ids, photo_bytes, filename, content_type, None,
        tok.created_by_user_id, capture_token_id=tok.id,
    )
    return CapturePhotoOut(
        created=len(photos),
        photo_count=service.token_photo_count(db, tok),
    )
