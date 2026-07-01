"""Sub-samples FastAPI router.

Provides REST API for creating, listing, updating, and deleting sub-samples (vials).
Handles base64 photo decoding at the boundary, delegates business logic to service layer,
and provides structured error handling for SecondaryFalloutError.
"""
import base64
from datetime import datetime
from typing import Callable, Optional
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
    CreateBulkSubSamplesRequest, BulkSubSampleResponse,
    SubSampleResponse, SubSampleListResponse, ParentSampleSummary,
    VialPlanResponse, VialPlanItem, AssignmentPatchRequest,
    AggregatesRequest, AggregatesResponse, ParentAggregate,
    VarianceSetResponse, VarianceVialResult, VarianceStatsEntry,
    PatchVarianceMembershipRequest, VarianceEntitlementResponse,
    VarianceOverrideRequest,
    SubSampleAttachmentResponse, SubSampleAttachmentListResponse,
    AddSubSampleAttachmentRequest,
    CustomerRemarksUpdate,
    OrderedProduct, OrderedProductsResponse,
)
from sub_samples.product_registry import build_ordered_products


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
        assignment_kind=sub.assignment_kind,
        external_lims_uid=sub.external_lims_uid,
        box_id=sub.box_id,
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


def _filename_from_request(photo_bytes: bytes) -> str:
    """Return a photo filename whose extension matches the ACTUAL image bytes.

    The stored key's extension drives the served Content-Type, so it must stay
    honest regardless of source — a camera capture (PNG or JPEG) or an uploaded
    file of any format. Sniff the leading magic bytes; fall back to '.jpg'.
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
    return f"vial{ext}"


def _select_photo_attachment(
    raw_attachments: list,
    fetch_meta: Callable[[str], Optional[dict]],
) -> Optional[dict]:
    """Pick the most-recent IMAGE attachment on an AR, or None.

    `raw_attachments` is the AR's `Attachment` reference list (oldest first);
    `fetch_meta(api_url)` resolves one reference to its attachment item dict.
    Iterates newest-first and returns the first reference that is an image —
    content_type `image/*` or AttachmentType "Sample Image". Non-images (COA
    PDFs, HPLC-graph CSVs that COA generation appends to the parent AR) are
    skipped, so the header thumbnail never receives undecodable bytes.
    """
    for ref in reversed(raw_attachments):
        if not isinstance(ref, dict):
            continue
        api_url = ref.get("api_url")
        if not api_url:
            continue
        att_item = fetch_meta(api_url)
        if not att_item:
            continue
        att_file = att_item.get("AttachmentFile") or {}
        content_type = (att_file.get("content_type") or "").lower()
        att_type = att_item.get("AttachmentType") or att_item.get("getAttachmentType")
        if isinstance(att_type, dict):
            att_type = att_type.get("title") or att_type.get("Title")
        if content_type.startswith("image/") or att_type == "Sample Image":
            return att_item
    return None


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
            photo_filename=_filename_from_request(photo_bytes),
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


@router.post("/bulk", status_code=status.HTTP_201_CREATED, response_model=BulkSubSampleResponse)
def create_sub_samples_bulk(
    body: CreateBulkSubSamplesRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Create N identical vials (same photo + remarks) for a parent in one call.

    Decodes the photo once and loops the tested single-create path; each vial
    gets its own sequential vial_sequence and a distinct storage key. Created
    vials carry assignment_role=NULL — the caller refreshes the vial-plan
    afterward to run auto-assignment (same as the single-create flow).

    Partial failure is tolerated: vials created before an error are kept and
    returned with `failed` > 0. If ZERO vials are created, the originating error
    is surfaced (502, mirroring the single-create path).
    """
    photo_bytes = _decode_photo(body.photo_base64)
    created, err = service.create_sub_samples_bulk(
        db,
        parent_sample_id=body.parent_sample_id,
        photo_bytes=photo_bytes,
        photo_filename=_filename_from_request(photo_bytes),
        remarks=body.remarks,
        user_id=user.id,
        count=body.count,
    )
    if not created and err is not None:
        if isinstance(err, SecondaryFalloutError):
            raise HTTPException(status_code=502, detail={
                "code": "secondary_fallout",
                "message": str(err),
                "orphan_uid": err.orphan_uid,
                "orphan_sample_id": err.orphan_sample_id,
            })
        raise HTTPException(status_code=502, detail=str(err))
    return BulkSubSampleResponse(
        created=[_serialize(s) for s in created],
        requested=body.count,
        failed=body.count - len(created),
    )


@router.post("/{parent_sample_id}/ensure", response_model=ParentSampleSummary)
def ensure_parent_sample(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Materialize the parent's lims_samples row NOW (lazy upsert) and return
    its summary. The receive wizard calls this on mount so container_mode is
    authoritative BEFORE the first-vial save decides between the legacy
    photo-on-parent path and the container create-S01 path — without it, a
    brand-new family has no row yet, the list endpoint's fallback reports
    container_mode=false, and the first vial would take the legacy path on a
    family that is then flagged container at first plan/print touch."""
    try:
        parent = service.ensure_sample_row(db, parent_sample_id)
        db.commit()
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return ParentSampleSummary(
        sample_id=parent.sample_id,
        external_lims_uid=parent.external_lims_uid,
        peptide_name=parent.peptide_name,
        status=parent.status,
        sub_sample_count=len(parent.sub_samples),
        last_synced_at=parent.last_synced_at,
        assignment_role=parent.assignment_role,
        container_mode=parent.container_mode,
        customer_remarks=parent.customer_remarks,
        customer_remarks_include=parent.customer_remarks_include,
        customer_remarks_delivered_at=parent.customer_remarks_delivered_at,
    )


@router.put("/parent/{parent_sample_id}/customer-remarks")
def update_customer_remarks(
    parent_sample_id: str,
    body: CustomerRemarksUpdate,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Set the parent's customer-facing remarks (delivered with the COA)."""
    try:
        return service.set_customer_remarks(
            db, parent_sample_id, body.remarks, include=body.include,
            user_id=user.id,
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        # set_customer_remarks lazily creates the lims_samples row via
        # ensure_sample_row, which hits SENAITE on a cache miss. A SENAITE
        # outage (or a genuinely unknown AR) surfaces as RuntimeError -> 502
        # (upstream failure), not a misleading 500.
        raise HTTPException(status_code=502, detail=str(e))


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
            container_mode=parent.container_mode,
            customer_remarks=parent.customer_remarks,
            customer_remarks_include=parent.customer_remarks_include,
            customer_remarks_delivered_at=parent.customer_remarks_delivered_at,
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
            _filename_from_request(photo_bytes) if photo_bytes else None,
            body.remarks,
            user_id=user.id,
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
            "variance": {"hplc": 0, "endo": 0, "ster": 0},
            "base_demand": {"hplc": 0, "endo": 0, "ster": 0},
            "wp_order_number": None,
            "is_unreachable": True,
        }
    services = services_resp.get("services") or {}
    return {
        "demand": service.derive_demand(services),
        "variance": service.derive_variance_demand(services),
        "base_demand": service.derive_base_demand(services),
        "wp_order_number": services_resp.get("wp_order_number"),
        "is_unreachable": False,
    }


@router.patch("/{sample_id}/assignment")
def patch_assignment(
    sample_id: str,
    body: AssignmentPatchRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Set the assignment_role on a vial.

    - Sub-samples: role may be null (resets to auto-assign on next /vial-plan).
    - Parent AR: null role is coerced to 'hplc' (preserves "primary always HPLC").
    """
    try:
        return service.set_assignment_role(db, sample_id, body.role, kind=body.kind, user_id=user.id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except service.VarianceLockedError as e:
        raise HTTPException(
            status_code=409,
            detail={"code": "variance_locked", "message": str(e)},
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"SENAITE unavailable while seeding analyses: {e}")


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

    # Pick the most-recent IMAGE attachment — NOT simply the last attachment.
    # COA generation appends a COA PDF and HPLC-graph CSVs to the parent AR, so
    # the last attachment is frequently not the vial photo; proxying it streamed
    # CSV/PDF bytes to the header <img>, which rendered broken.
    def _fetch_att_meta(api_url: str) -> Optional[dict]:
        resp = _get(api_url)
        if resp.status_code >= 300:
            return None
        data = resp.json()
        return data["items"][0] if data.get("items") else data

    att_item = _select_photo_attachment(raw_attachments, _fetch_att_meta)
    if att_item is None:
        raise HTTPException(404, f"No image attachment on AR for {sample_id}")
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


@router.delete("/{sample_id}/photo", status_code=status.HTTP_204_NO_CONTENT)
def delete_sub_sample_photo(
    sample_id: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Remove a vial's check-in photo (Mk1-stored only). Idempotent.

    Legacy SENAITE-attachment photos → 409: they live on the parent AR and
    deleting them is a SENAITE-side operation we don't perform from here."""
    try:
        service.delete_sub_sample_photo(db, sample_id, user_id=user.id)
    except service.PhotoNotMk1Error as e:
        raise HTTPException(status_code=409, detail={
            "code": "photo_not_mk1", "message": str(e),
        })
    return None


@router.get("/{sample_id}/chromatograms")
def list_sub_sample_chromatograms(
    sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Chromatogram candidates from vial-scoped sample preps.

    A vial's chromatogram is the chromatogram_data on the hplc_analyses rows
    of preps tagged with that vial (sample_preps.lims_sub_sample_pk) — no
    separate storage. Vial id → its own candidates; parent id → candidates
    across the whole family. Newest first. Render via
    POST /hplc/analyses/{id}/chromatogram-image; push to the parent AR via
    POST /hplc/analyses/{id}/chromatogram-to-senaite.
    """
    import mk1_db
    from models import HPLCAnalysis, Peptide

    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if sub is not None:
        subs = [sub]
    else:
        parent = db.execute(
            select(LimsSample).where(LimsSample.sample_id == sample_id)
        ).scalar_one_or_none()
        if parent is None:
            raise HTTPException(404, f"Sample {sample_id} not found")
        subs = list(parent.sub_samples)

    pk_to_sub = {s.id: s for s in subs}
    preps = mk1_db.list_sample_preps_for_sub_samples(list(pk_to_sub))
    prep_by_id = {p["id"]: p for p in preps}
    if not prep_by_id:
        return {"chromatograms": []}

    analyses = db.execute(
        select(HPLCAnalysis).where(
            HPLCAnalysis.sample_prep_id.in_(list(prep_by_id)),
            HPLCAnalysis.chromatogram_data.is_not(None),
        ).order_by(HPLCAnalysis.id.desc())
    ).scalars().all()

    out = []
    pep_cache: dict = {}
    for a in analyses:
        chrom = a.chromatogram_data or {}
        if not chrom.get("times") or not chrom.get("signals"):
            continue
        prep = prep_by_id.get(a.sample_prep_id)
        s = pk_to_sub.get(prep["lims_sub_sample_pk"]) if prep else None
        if s is None:
            continue
        pep = None
        if a.peptide_id is not None:
            if a.peptide_id not in pep_cache:
                pep_cache[a.peptide_id] = db.get(Peptide, a.peptide_id)
            pep = pep_cache[a.peptide_id]
        out.append({
            "analysis_id": a.id,
            "vial_sample_id": s.sample_id,
            "vial_sequence": s.vial_sequence,
            "assignment_role": s.assignment_role,
            "assignment_kind": s.assignment_kind,
            "peptide_abbreviation": pep.abbreviation if pep else None,
            "prep_id": prep["id"],
            "created_at": a.created_at.isoformat() if a.created_at else None,
            # Raw series for in-app chart rendering (~800 LTTB points, a few
            # KB) — the FE renders the same recharts chart used everywhere
            # else instead of the branded PNG.
            "data": {"times": chrom["times"], "signals": chrom["signals"]},
        })
    return {"chromatograms": out}


# ── Sub-sample image attachments (2026-06-11 design) ─────────────────────────

def _serialize_attachment(att) -> SubSampleAttachmentResponse:
    return SubSampleAttachmentResponse(
        id=att.id,
        filename=att.filename,
        content_type=att.content_type,
        created_at=att.created_at,
    )


@router.get("/{sample_id}/attachments", response_model=SubSampleAttachmentListResponse)
def list_sub_sample_attachments(
    sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List extra sample images on a vial (excludes the check-in photo,
    which is served by GET /{sample_id}/photo)."""
    try:
        atts = service.list_attachments(db, sample_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return SubSampleAttachmentListResponse(
        attachments=[_serialize_attachment(a) for a in atts]
    )


@router.post(
    "/{sample_id}/attachments",
    status_code=status.HTTP_201_CREATED,
    response_model=SubSampleAttachmentResponse,
)
def add_sub_sample_attachment(
    sample_id: str,
    body: AddSubSampleAttachmentRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Attach an extra sample image to a vial. Images only."""
    image_bytes = _decode_photo(body.image_base64)
    try:
        att = service.add_attachment(
            db, sample_id, image_bytes, body.filename, user_id=user.id
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return _serialize_attachment(att)


@router.get("/{sample_id}/attachments/{attachment_id}")
def get_sub_sample_attachment(
    sample_id: str,
    attachment_id: int,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Stream an attachment's image bytes."""
    from fastapi.responses import Response
    from sub_samples.photo_storage import PhotoNotFoundError, get_storage
    try:
        att = service.get_attachment(db, sample_id, attachment_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    try:
        image_bytes = get_storage().fetch_photo(att.storage_key)
    except PhotoNotFoundError:
        raise HTTPException(404, f"Attachment file missing from storage for {sample_id}")
    return Response(content=image_bytes, media_type=att.content_type)


@router.post(
    "/{sample_id}/attachments/{attachment_id}/make-primary",
    response_model=SubSampleResponse,
)
def make_attachment_primary(
    sample_id: str,
    attachment_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Promote an extra image to be the vial's primary (check-in) photo.
    The previous Mk1-stored primary is demoted to a regular attachment."""
    try:
        sub = service.set_primary_attachment(db, sample_id, attachment_id, user_id=user.id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except service.PhotoNotMk1Error as e:
        raise HTTPException(status_code=409, detail={
            "code": "photo_not_mk1", "message": str(e),
        })
    return _serialize(sub)


@router.delete(
    "/{sample_id}/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_sub_sample_attachment(
    sample_id: str,
    attachment_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Remove an extra sample image (row + stored file)."""
    try:
        service.delete_attachment(db, sample_id, attachment_id, user_id=user.id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return None


# ── Variance set endpoints (worksheet-variance design 2026-06-02) ────────────

@router.get("/{sample_id}/ordered-products", response_model=OrderedProductsResponse)
def get_ordered_products(sample_id: str, _user=Depends(get_current_user)):
    """Customer-ordered products for the sample-page PRODUCTS section.
    Source: IS order data (no SENAITE). 404 = no linked order; 502 = IS unreachable."""
    try:
        raw = service.fetch_sample_services(sample_id)
    except (requests.RequestException, RuntimeError) as e:
        raise HTTPException(
            status_code=502,
            detail={"message": "integration service unreachable",
                    "sample_id": sample_id, "upstream_error": str(e)},
        )
    if raw is None:
        raise HTTPException(status_code=404, detail=f"no order linked to {sample_id}")
    products = build_ordered_products(raw.get("services") or {}, raw.get("package"))
    return OrderedProductsResponse(
        sample_id=sample_id,
        wp_order_number=raw.get("wp_order_number"),
        products=products,
    )


@router.get(
    "/{parent_sample_id}/variance-entitlement",
    response_model=VarianceEntitlementResponse,
)
def get_variance_entitlement(
    parent_sample_id: str,
    _user=Depends(get_current_user),
):
    """FE gating data for the Verify (Variance) action. Read-only; no DB."""
    services = service._fetch_wp_services_for_parent(parent_sample_id)
    if services is None:
        return VarianceEntitlementResponse(variance={}, unreachable=True)
    return VarianceEntitlementResponse(
        variance=service.normalize_variance_entitlement(services),
        unreachable=False,
    )


@router.put("/{parent_sample_id}/variance-override")
def put_variance_override(
    parent_sample_id: str,
    body: VarianceOverrideRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Set/clear the lab-side variance override (UAT + interim until the WP
    variance addon ships). Stored normalized; returns the effective map."""
    try:
        cleaned = service.set_variance_override(db, parent_sample_id, body.variance)
        return {"variance": cleaned}
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except service.VarianceLockedError as e:
        raise HTTPException(
            status_code=409,
            detail={"code": "variance_locked", "message": str(e)},
        )


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
            container_mode=parent.container_mode,
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
    except service.VarianceSeriesIncompleteError as e:
        raise HTTPException(
            status_code=409,
            detail={"code": "variance_series_incomplete", "message": str(e)},
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
        parent = service.unlock_variance_set(db, parent_sample_id, user.id)
        return {"parent_sample_id": parent.sample_id, "locked": False}
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
