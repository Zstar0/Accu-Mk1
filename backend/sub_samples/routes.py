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
from models import LimsSample, LimsSubSample
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
    AggregatesRequest, AggregatesResponse, ParentAggregate,
    VarianceSetResponse, VarianceVialResult, VarianceStatsEntry,
    PatchVarianceMembershipRequest,
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
        assignment_role=sub.assignment_role,
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
def list_sub_samples(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
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
            assignment_role=parent.assignment_role,
        ),
        sub_samples=[_serialize(s) for s in subs],
    )


@router.post("/aggregates", response_model=AggregatesResponse)
def aggregate_parents(
    body: AggregatesRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Batch sub-sample count + role breakdown per parent_sample_id.

    Used by the SENAITE samples list page to render Vials / Assigned columns
    without N round-trips. Sample IDs not present in lims_samples are simply
    omitted from the response — frontend treats absence as zero.
    """
    raw = service.aggregate_by_parent(db, body.parent_sample_ids)
    return AggregatesResponse(
        aggregates={
            pid: ParentAggregate(**agg) for pid, agg in raw.items()
        }
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


@router.get("/{parent_sample_id}/vial-demand")
def get_vial_demand(
    parent_sample_id: str,
    _db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Return just the vial demand for a sample's WP order — no DB side effects.

    Used by the capture step to display "expected vs received" counts in the
    wizard header without triggering auto-assign (which is reserved for the
    assign step's /vial-plan call).
    """
    try:
        services_resp = service.fetch_sample_services(parent_sample_id)
    except Exception:
        services_resp = None
    if services_resp is None:
        return {
            "demand": {"hplc": 0, "endo": 0, "ster": 0},
            "wp_order_number": None,
            "is_unreachable": True,
        }
    return {
        "demand": service.derive_demand(services_resp.get("services") or {}),
        "wp_order_number": services_resp.get("wp_order_number"),
        "is_unreachable": False,
    }


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
    """Stream the most-recent photo attached to a sample's AR (sub-sample or parent).

    Resolves the AR via the local row's `external_lims_uid`, fetches the AR
    detail with `complete=true` to get the `Attachment` reference list, picks
    the last attachment, and proxies its binary `download` URL.

    For sub-samples, `photo_external_uid` is set at create-time as a sentinel
    that a photo was uploaded. For parents, we just attempt the lookup and
    return 404 if no attachments exist (the receive wizard always uploads a
    photo on first vial check-in, so any received parent should have one).
    """
    # Try sub-sample first, then fall back to parent AR.
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()

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
    else:
        parent = db.execute(
            select(LimsSample).where(LimsSample.sample_id == sample_id)
        ).scalar_one_or_none()
        if not parent:
            raise HTTPException(404, f"Sample {sample_id} not found")
        if not parent.external_lims_uid:
            raise HTTPException(404, f"Sample {sample_id} has no SENAITE UID")
        ar_uid = parent.external_lims_uid

    # Fetch AR detail with attachments expanded.
    detail_url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest/{ar_uid}"
    detail_resp = _get(detail_url, params={"complete": "true"})
    if detail_resp.status_code >= 300:
        raise HTTPException(
            502,
            f"SENAITE AR detail fetch failed ({detail_resp.status_code}): {detail_resp.text[:200]}",
        )
    items = detail_resp.json().get("items", [])
    if not items:
        raise HTTPException(404, f"No SENAITE AR for uid={ar_uid}")

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


# ── Variance set endpoints (worksheet-variance design 2026-06-02) ────────────

@router.get("/{parent_sample_id}/variance-set", response_model=VarianceSetResponse)
def get_variance_set_endpoint(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    result = service.get_variance_set(db, parent_sample_id)
    if not result:
        raise HTTPException(
            status_code=404,
            detail=f"parent {parent_sample_id} has no variance set yet",
        )
    parent = result["parent"]
    return VarianceSetResponse(
        parent=ParentSampleSummary(
            sample_id=parent.sample_id,
            external_lims_uid=parent.external_lims_uid,
            peptide_name=parent.peptide_name,
            status=parent.status,
            sub_sample_count=len(parent.sub_samples),
            last_synced_at=parent.last_synced_at,
            assignment_role=parent.assignment_role,
        ),
        vials=[VarianceVialResult(**v) for v in result["vials"]],
        stats={k: VarianceStatsEntry(**v) for k, v in result["stats"].items()},
        locked=result["locked"],
        locked_at=result["locked_at"],
        locked_by_user_id=result["locked_by_user_id"],
    )


@router.patch("/{sample_id}/variance-set")
def patch_variance_membership_endpoint(
    sample_id: str,
    body: PatchVarianceMembershipRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    try:
        return service.set_variance_membership(
            db, sample_id, body.in_variance_set, body.exclusion_reason
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except service.VarianceLockedError as e:
        raise HTTPException(
            status_code=409,
            detail={"code": "variance_locked", "message": str(e)},
        )


@router.post("/{parent_sample_id}/variance-set/lock")
def lock_variance_set_endpoint(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    try:
        parent = service.lock_variance_set(db, parent_sample_id, user.id)
        return {
            "parent_sample_id": parent.sample_id,
            "locked_at": parent.variance_locked_at,
            "locked_by_user_id": parent.variance_locked_by_user_id,
        }
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except service.VarianceTooFewVialsError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": "variance_too_few_vials", "message": str(e)},
        )


@router.post("/{parent_sample_id}/variance-set/unlock")
def unlock_variance_set_endpoint(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    # Admin gate intentionally relaxed for now — variance sets are a new
    # workflow and techs need self-service unlock while the lab finds its
    # footing. Re-gate to admin once the Variance Addon COA phase ships
    # and lock semantics become contractual for the customer-facing COA.
    try:
        parent = service.unlock_variance_set(db, parent_sample_id)
        return {"parent_sample_id": parent.sample_id, "locked": False}
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
