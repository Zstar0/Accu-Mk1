"""Sub-samples FastAPI router.

Provides REST API for creating, listing, updating, and deleting sub-samples (vials).
Handles base64 photo decoding at the boundary, delegates business logic to service layer,
and provides structured error handling for SecondaryFalloutError.
"""
import base64
from datetime import datetime
import requests
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from database import get_db
from auth import get_current_user
from models import LimsSubSample
from sub_samples import service
from sub_samples.senaite import (
    SecondaryFalloutError,
    SENAITE_BASE_URL,
    SENAITE_USER,
    SENAITE_PASSWORD,
    _get,
)
from sub_samples.schemas import (
    CreateSubSampleRequest, UpdateSubSampleRequest,
    SubSampleResponse, SubSampleListResponse, ParentSampleSummary,
    VialPlanResponse, VialPlanItem, AssignmentPatchRequest,
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


@router.get("/{parent_sample_id}/vial-plan", response_model=VialPlanResponse)
def get_vial_plan(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Return per-vial assignment for the parent's full vial set.

    Side-effect: runs auto-assign for any sub-sample with NULL assignment_role,
    persisting the result. Subsequent calls with the same DB state are
    idempotent.
    """
    plan = service.compute_vial_plan(db, parent_sample_id)
    return VialPlanResponse(**plan)


@router.patch("/{sample_id}/assignment")
def patch_assignment(
    sample_id: str,
    body: AssignmentPatchRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Set the assignment_role on a vial.

    - Sub-samples: role may be null (resets to auto-assign on next /vial-plan).
    - Parent AR: null role is coerced to 'hplc' (preserves "primary always HPLC").
    """
    try:
        return service.set_assignment_role(db, sample_id, body.role)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{sample_id}/photo")
def get_sub_sample_photo(
    sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Stream the most-recent photo attached to a sub-sample's secondary AR.

    Resolves the AR via the local row's `external_lims_uid`, fetches the AR
    detail with `complete=true` to get the `Attachment` reference list, picks
    the last attachment, and proxies its binary `download` URL.

    Note: `photo_external_uid` on the row holds the AR PATH (set at
    create-time as `secondary_path` — see service.create_sub_sample), NOT an
    attachment UID. We use it as a "has-photo" sentinel only; the AR's UID
    is what we hit for the API lookup.
    """
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if not sub:
        raise HTTPException(404, f"Sub-sample {sample_id} not found")
    if not sub.photo_external_uid:
        raise HTTPException(404, f"No photo on file for {sample_id}")

    # Fetch AR detail with attachments expanded.
    detail_url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest/{sub.external_lims_uid}"
    detail_resp = _get(detail_url, params={"complete": "true"})
    if detail_resp.status_code >= 300:
        raise HTTPException(
            502,
            f"SENAITE AR detail fetch failed ({detail_resp.status_code}): {detail_resp.text[:200]}",
        )
    items = detail_resp.json().get("items", [])
    if not items:
        raise HTTPException(404, f"No SENAITE AR for uid={sub.external_lims_uid}")

    raw_attachments = items[0].get("Attachment") or []
    if not raw_attachments:
        raise HTTPException(404, f"No attachments on AR for {sample_id}")

    # Each entry is a reference dict with `uid` and `api_url`. Take the last
    # one — most-recently uploaded (consistent with how the wizard appends).
    last_ref = raw_attachments[-1]
    if not isinstance(last_ref, dict):
        raise HTTPException(502, "Unparsable attachment reference shape")
    att_api_url = last_ref.get("api_url")
    if not att_api_url:
        raise HTTPException(502, "Attachment reference missing api_url")

    # Resolve the attachment's binary download URL + content type.
    att_resp = _get(att_api_url)
    if att_resp.status_code >= 300:
        raise HTTPException(
            502,
            f"SENAITE attachment metadata fetch failed ({att_resp.status_code})",
        )
    att_data = att_resp.json()
    att_item = att_data["items"][0] if att_data.get("items") else att_data
    att_file = att_item.get("AttachmentFile") or {}
    download_url = att_file.get("download")
    content_type = att_file.get("content_type") or "image/jpeg"
    if not download_url:
        raise HTTPException(502, "Attachment has no download URL")

    bin_resp = requests.get(
        download_url,
        auth=(SENAITE_USER, SENAITE_PASSWORD),
        timeout=30,
        stream=True,
    )
    if bin_resp.status_code >= 300:
        raise HTTPException(
            502, f"SENAITE attachment fetch failed: {bin_resp.status_code}"
        )

    return StreamingResponse(bin_resp.iter_content(8192), media_type=content_type)
