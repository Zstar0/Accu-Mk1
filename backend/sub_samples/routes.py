"""Sub-samples FastAPI router.

Provides REST API for creating, listing, updating, and deleting sub-samples (vials).
Handles base64 photo decoding at the boundary, delegates business logic to service layer,
and provides structured error handling for SecondaryFalloutError.
"""
import base64
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from database import get_db
from auth import get_current_user
from sub_samples import service
from sub_samples.senaite import SecondaryFalloutError
from sub_samples.schemas import (
    CreateSubSampleRequest, UpdateSubSampleRequest,
    SubSampleResponse, SubSampleListResponse, ParentSampleSummary,
)


router = APIRouter(prefix="/api/sub-samples", tags=["sub-samples"])


def _serialize(sub) -> SubSampleResponse:
    """Convert LimsSubSample ORM model to response schema."""
    return SubSampleResponse(
        id=sub.id,
        sample_id=sub.sample_id,
        parent_sample_id=sub.parent_sample.sample_id,
        vial_sequence=sub.vial_sequence,
        received_at=sub.received_at,
        received_by_user_id=sub.received_by_user_id,
        photo_external_uid=sub.photo_external_uid,
        remarks=sub.remarks,
    )


def _decode_photo(photo_base64: str) -> bytes:
    """Decode base64 photo string to bytes. Handles data: URL prefix."""
    try:
        # Strip data: URL prefix if present (e.g., "data:image/jpeg;base64,...")
        if photo_base64.startswith("data:"):
            photo_base64 = photo_base64.split(",", 1)[1]
        return base64.b64decode(photo_base64, validate=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid photo_base64: {e}")


def _filename_from_request() -> str:
    """Return photo filename. v1: hardcoded 'vial.jpg' since the wizard
    always sends JPEG. If we ever accept PNG or other formats, the schema
    should grow a filename field and we'd derive the extension from there."""
    return "vial.jpg"


@router.post("", status_code=status.HTTP_201_CREATED, response_model=SubSampleResponse)
def create_sub_sample(
    body: CreateSubSampleRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Create a new sub-sample (vial) with photo and optional remarks.

    - Decodes base64 photo and uploads to SENAITE
    - Creates secondary AR in SENAITE and local DB row atomically
    - Returns 502 with orphan AR info if secondary creation fails
    """
    photo_bytes = _decode_photo(body.photo_base64)
    try:
        sub = service.create_sub_sample(
            db,
            parent_sample_id=body.parent_sample_id,
            photo_bytes=photo_bytes,
            photo_filename=_filename_from_request(),
            remarks=body.remarks,
            user_id=user.id,
        )
    except SecondaryFalloutError as e:
        # Surface orphan info structurally so the frontend can display
        # "Orphan AR P-XXXX created — needs manual cleanup in SENAITE UI"
        raise HTTPException(status_code=502, detail={
            "code": "secondary_fallout",
            "message": str(e),
            "orphan_uid": e.orphan_uid,
            "orphan_sample_id": e.orphan_sample_id,
        })
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return _serialize(sub)


@router.get("", response_model=SubSampleListResponse)
def list_sub_samples(parent_sample_id: str, db: Session = Depends(get_db)):
    """List all sub-samples (vials) for a parent sample.

    Returns parent summary + list of sub-samples. If parent doesn't exist locally,
    returns empty list with the requested sample_id.
    """
    parent, subs = service.list_sub_samples(db, parent_sample_id)
    if not parent:
        return SubSampleListResponse(
            parent=ParentSampleSummary(
                sample_id=parent_sample_id,
                external_lims_uid=None,
                peptide_name=None,
                status=None,
                sub_sample_count=0,
                last_synced_at=datetime.utcnow(),
            ),
            sub_samples=[],
        )
    return SubSampleListResponse(
        parent=ParentSampleSummary(
            sample_id=parent.sample_id,
            external_lims_uid=parent.external_lims_uid,
            peptide_name=parent.peptide_name,
            status=parent.status,
            sub_sample_count=len(subs),
            last_synced_at=parent.last_synced_at,
        ),
        sub_samples=[_serialize(s) for s in subs],
    )


@router.patch("/{sample_id}", response_model=SubSampleResponse)
def update_sub_sample(
    sample_id: str,
    body: UpdateSubSampleRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Update a sub-sample's photo and/or remarks.

    Both fields are optional. Pass None to skip updating that field.
    """
    photo_bytes = _decode_photo(body.photo_base64) if body.photo_base64 else None
    try:
        sub = service.update_sub_sample(
            db,
            sample_id,
            photo_bytes,
            _filename_from_request() if photo_bytes else None,
            body.remarks,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return _serialize(sub)


@router.delete("/{sample_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sub_sample(
    sample_id: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Delete a sub-sample and its secondary AR from SENAITE."""
    try:
        service.delete_sub_sample(db, sample_id)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return None
