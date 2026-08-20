"""FastAPI router for lims_analyses.

Thin HTTP shells over the service layer. Translates typed service
exceptions to structured HTTP responses; never writes to the DB
directly.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import List, Literal, Union

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin
from database import get_db
from lims_analyses import manage_native, senaite_writeback, service
from lims_analyses.senaite_writeback import SenaiteWritebackError, list_parent_line_states
from lims_analyses.schemas import (
    AddNativeProfileRequest,
    AddNativeProfileResponse,
    AnalysisResponse,
    AnalysisWithTransitions,
    CreateAnalysisRequest,
    HostKind,
    NativeParentAnalysisRow,
    NativeProfileOut,
    ParentPromotionInfo,
    ParentRetestRequest,
    ParentRetestResponse,
    PromoteRequest,
    PromoteResponse,
    PromotionRow,
    RemoveNativeAnalysisResponse,
    ResyncFromOrderResponse,
    SenaiteShapeAnalysisResponse,
    SetMethodInstrumentRequest,
    SetReportableRequest,
    SourceRetestRequest,
    SourceRetestResponse,
    TransitionInfo,
    TransitionRequest,
)
from models import AnalysisProfile, LimsSample
from lims_analyses.state_machine import (
    InvalidTransitionError,
    TierMismatchError,
    UnknownKindError,
    UnknownStateError,
    UnknownTierError,
)


router = APIRouter(prefix="/api/lims-analyses", tags=["lims-analyses"])

logger = logging.getLogger(__name__)


# ─── Error translation helpers ───────────────────────────────────────────────


def _handle_service_error(e: Exception) -> HTTPException:
    """Map a service-layer exception to an HTTPException."""
    if isinstance(e, service.NotFoundError):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, service.BadRequestError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, service.ConflictError):
        return HTTPException(
            status_code=409,
            detail={
                "code": "published_parent_conflict",
                "message": str(e),
            },
        )
    if isinstance(e, InvalidTransitionError):
        return HTTPException(
            status_code=409,
            detail={
                "code": "invalid_transition",
                "from_state": e.from_state,
                "kind": e.kind,
                "message": str(e),
            },
        )
    if isinstance(e, TierMismatchError):
        return HTTPException(
            status_code=409,
            detail={
                "code": "tier_mismatch",
                "tier": e.tier,
                "kind": e.kind,
                "message": str(e),
            },
        )
    if isinstance(e, (UnknownStateError, UnknownKindError, UnknownTierError)):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, SenaiteWritebackError):
        # Parent-tier verify tee (read-flip seam fix, 2026-08-20): same 502
        # semantics as the promote route's write-back failure — the upstream
        # system refused, nothing was committed.
        return HTTPException(
            status_code=502,
            detail=f"SENAITE write-back failed — transition aborted: {e}",
        )
    if isinstance(e, IntegrityError):
        # The most common case is the partial unique index on
        # (lims_sample_pk, keyword) WHERE retest_of_id IS NULL — i.e. a
        # parent-tier row already exists for this (parent, analyte).
        return HTTPException(
            status_code=409,
            detail={
                "code": "parent_row_already_exists",
                "message": (
                    "A parent-tier row already exists for this parent + "
                    "keyword. Retract the existing parent row first, then "
                    "re-promote."
                ),
            },
        )
    # Unknown — let FastAPI 500 it
    raise e


def _schedule_sbs_cascade(background_tasks, db, row, current_user) -> None:
    """Side-by-side engine (2026-07-26 spec §5): after a parent-analysis
    state change, evaluate sample-tier auto_fire edges post-response.
    Never-raise by construction: resolution failures are swallowed and the
    bg target itself is own-session never-raise."""
    try:
        from models import LimsSubSample
        from workflow.engine import run_cascades_bg, shadow_enabled
        if not shadow_enabled():
            return
        if row.lims_sample_pk is not None:
            parent_pk = row.lims_sample_pk
        elif row.lims_sub_sample_pk is not None:
            sub = db.get(LimsSubSample, row.lims_sub_sample_pk)
            parent_pk = sub.parent_sample_pk if sub else None
        else:
            parent_pk = None
        if parent_pk is not None:
            background_tasks.add_task(
                run_cascades_bg, parent_pk,
                getattr(current_user, "id", None))
    except Exception:
        logger.exception(
            "sbs cascade scheduling failed (never-raise)")


# ─── Endpoints ───────────────────────────────────────────────────────────────


@router.post("", response_model=AnalysisResponse, status_code=status.HTTP_201_CREATED)
def create_analysis(
    req: CreateAnalysisRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.create_analysis(
            db,
            host_kind=req.host_kind,
            host_pk=req.host_pk,
            analysis_service_id=req.analysis_service_id,
            keyword=req.keyword,
            title=req.title,
            result_value=req.result_value,
            result_unit=req.result_unit,
            method_id=req.method_id,
            instrument_id=req.instrument_id,
            created_by_user_id=getattr(current_user, "id", None),
        )
        return AnalysisResponse.model_validate(row)
    except Exception as e:
        raise _handle_service_error(e)


@router.get("", response_model=Union[List[AnalysisResponse], List[SenaiteShapeAnalysisResponse]])
def list_for_host(
    host_kind: HostKind = Query(...),
    host_pk: int = Query(...),
    include_retests: bool = Query(True),
    as_: Literal["default", "senaite_shape"] = Query("default", alias="as"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        if as_ == "senaite_shape":
            return service.list_analyses_in_senaite_shape(
                db,
                host_kind=host_kind,
                host_pk=host_pk,
                include_retests=include_retests,
            )
        rows = service.list_analyses_for_host(
            db,
            host_kind=host_kind,
            host_pk=host_pk,
            include_retests=include_retests,
        )
        return [AnalysisResponse.model_validate(r) for r in rows]
    except Exception as e:
        raise _handle_service_error(e)


@router.get("/parent-line-states")
def get_parent_line_states(
    parent_sample_id: str = Query(...),
    current_user=Depends(get_current_user),
):
    """Return SENAITE analysis states keyed by keyword for a parent AR.

    Best-effort: transport or SENAITE errors return {"states": {}} rather
    than propagating as 5xx.  The frontend uses this to lock vial rows whose
    parent line is already verified.
    """
    try:
        states = list_parent_line_states(parent_sample_id)
        return {"states": states}
    except SenaiteWritebackError:
        logger.warning(
            "list_parent_line_states failed for %s — returning empty states",
            parent_sample_id,
        )
        return {"states": {}}


@router.get("/promotions", response_model=List[ParentPromotionInfo])
def list_promotions(
    parent_sample_id: str = Query(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Return promotions (parent-tier analyses with their vial sources) for a
    parent LimsSample. Returns [] when the sample is unknown."""
    try:
        return service.list_promotions_for_parent(db, parent_sample_id)
    except Exception as e:
        raise _handle_service_error(e)


@router.get(
    "/parent/{sample_id}/native-analyses",
    response_model=Union[List[NativeParentAnalysisRow], List[SenaiteShapeAnalysisResponse]],
)
def list_native_parent_analyses(
    sample_id: str,
    as_: Literal["default", "senaite_shape"] = Query("default", alias="as"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Read-only "Accu-Mk1 Analyses" card (Task 5b): current, origin='mk1'
    parent-tier rows for a parent LimsSample. The main Analyses table on the
    parent page stays SENAITE-sourced by design (SampleDetails.tsx) — this is
    the separate reader that surfaces native results (e.g. Heavy Metals) that
    table structurally can't show. 404 when the sample is unknown to Mk1
    (service.NotFoundError, translated by _handle_service_error).

    ?as=senaite_shape projects the rows through the shared senaite-shape
    serializer for the AnalysisTable-backed card — full lineage, all states.
    """
    try:
        if as_ == "senaite_shape":
            return service.list_native_parent_analyses_senaite_shape(db, sample_id)
        return service.list_native_parent_analyses(db, sample_id)
    except Exception as e:
        raise _handle_service_error(e)


@router.post("/parent/{sample_id}/retest", response_model=ParentRetestResponse)
def parent_retest(
    sample_id: str,
    req: ParentRetestRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Native parent-tier retest (AnalysisTable card verb): retests the
    promoted source vial rows and un-promotes the verified parent row via
    cascade_parent_retest_to_sources. 409 invalid_transition unless the
    active parent row is 'verified' or 'parent_to_verify' (awaiting
    sign-off) — published parents are protected."""
    try:
        new_ids, state = service.parent_retest(
            db,
            sample_id=sample_id,
            keyword=req.keyword,
            user_id=getattr(current_user, "id", None),
            reason=req.reason,
        )
        return ParentRetestResponse(new_row_ids=new_ids, parent_review_state=state)
    except Exception as e:
        raise _handle_service_error(e)


# ── Native Manage Analyses (spec 2026-08-18) ─────────────────────────────────

def _load_parent_or_404(db: Session, sample_id: str) -> LimsSample:
    parent = db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)).scalar_one_or_none()
    if parent is None:
        raise HTTPException(status_code=404, detail=f"sample {sample_id!r} not found")
    return parent


def _manage_native_error(e: Exception) -> HTTPException:
    code = getattr(e, "code", None)
    if isinstance(e, manage_native.ProfileAlreadyOnSampleError) or isinstance(e, manage_native.PromotedResultExistsError):
        return HTTPException(status_code=409, detail={"code": code, "message": str(e)})
    if isinstance(e, (manage_native.ProfileNotNativeError, manage_native.ProfileInactiveError,
                      manage_native.ProfileHasNoMembersError)):
        return HTTPException(status_code=422, detail={"code": code, "message": str(e)})
    if isinstance(e, manage_native.RemovalNeedsConfirm):
        return HTTPException(status_code=412, detail={"code": "confirm_required", "impact": e.impact})
    if isinstance(e, manage_native.OrderServicesUnavailable):
        return HTTPException(status_code=502, detail={"code": "order_services_unavailable", "message": str(e)})
    return _handle_service_error(e)


@router.get("/parent/{sample_id}/native-profiles", response_model=List[NativeProfileOut])
def native_profiles(sample_id: str, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """Picker for the Manage Analyses overlay: active all-mk1 profiles, whether
    the sample already carries them, and which existing vials would host them."""
    parent = _load_parent_or_404(db, sample_id)
    return manage_native.native_profiles_for_parent(db, parent=parent)


@router.post("/parent/{sample_id}/profiles", response_model=AddNativeProfileResponse,
             status_code=status.HTTP_201_CREATED)
def add_native_profile(sample_id: str, req: AddNativeProfileRequest,
                       db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """Ruling A/P: put a native profile on the sample — parent placeholders +
    host custody edge + vial rows on every matching-role vial."""
    parent = _load_parent_or_404(db, sample_id)
    profile = db.get(AnalysisProfile, req.profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"analysis profile id={req.profile_id} not found")
    try:
        result = manage_native.add_profile_to_parent(
            db, parent=parent, profile=profile, user_id=getattr(current_user, "id", None))
        db.commit()
        return result
    except Exception as e:
        db.rollback()
        raise _manage_native_error(e)


@router.delete("/parent/{sample_id}/native-analyses/{analysis_id}", response_model=RemoveNativeAnalysisResponse)
def remove_native_analysis(sample_id: str, analysis_id: int, confirm: bool = Query(False),
                           db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """Ruling P/R1: remove one native parent placeholder; cascades to the vial
    rows (delete pristine / reject worked with ?confirm=true) and soft-rejects
    the placeholder. 409 when a promoted result exists; 412 when confirmation
    is required (body carries the impact for RemovalConfirmModal)."""
    parent = _load_parent_or_404(db, sample_id)
    try:
        return manage_native.remove_parent_native_analysis(
            db, parent=parent, analysis_id=analysis_id, confirm=confirm,
            user_id=getattr(current_user, "id", None))
    except Exception as e:
        db.rollback()
        raise _manage_native_error(e)


@router.post("/parent/{sample_id}/resync-from-order", response_model=ResyncFromOrderResponse)
def resync_from_order(sample_id: str, db: Session = Depends(get_db), current_user=Depends(require_admin)):
    """Ruling 2: admin-only additive heal from the WP order (placeholders,
    host edges, vial rows). 502 with zero writes when the IS is unavailable."""
    parent = _load_parent_or_404(db, sample_id)
    try:
        result = manage_native.resync_parent_from_order(
            db, parent=parent, user_id=getattr(current_user, "id", None))
        db.commit()
        return result
    except Exception as e:
        db.rollback()
        raise _manage_native_error(e)


@router.post("/{analysis_id}/source-retest", response_model=SourceRetestResponse)
def source_retest(
    analysis_id: int,
    req: SourceRetestRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Native vial-side (source) retest (Task 5): the up-cascade mirror of
    parent_retest. Retests ONE named promoted, mk1-origin, vial-hosted row
    directly, then un-promotes its promotion parent when the parent is
    still 'verified' or 'parent_to_verify' — a published parent is a
    citable COA source and is left untouched. 400 when the row's service
    is SENAITE-origin; 409 invalid_transition when the row isn't a
    vial-hosted 'promoted' row."""
    try:
        new_row_id, parent_unverified, parent_state = service.vial_source_retest(
            db,
            analysis_id=analysis_id,
            user_id=getattr(current_user, "id", None),
            reason=req.reason,
        )
        return SourceRetestResponse(
            new_row_id=new_row_id,
            parent_unverified=parent_unverified,
            parent_review_state=parent_state,
        )
    except Exception as e:
        raise _handle_service_error(e)


@router.get("/{analysis_id}", response_model=AnalysisWithTransitions)
def get_by_id(
    analysis_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.get_analysis(db, analysis_id)
        return AnalysisWithTransitions(
            **AnalysisResponse.model_validate(row).model_dump(),
            transitions=[
                TransitionInfo.model_validate(t) for t in row.transitions
            ],
        )
    except Exception as e:
        raise _handle_service_error(e)


@router.post("/{analysis_id}/transitions", response_model=AnalysisResponse)
def transition(
    analysis_id: int,
    req: TransitionRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.apply_transition(
            db,
            analysis_id=analysis_id,
            kind=req.kind,
            result_value=req.result_value,
            reason=req.reason,
            user_id=getattr(current_user, "id", None),
        )
        # side-by-side engine: schedules workflow.engine.run_cascades_bg post-response
        _schedule_sbs_cascade(background_tasks, db, row, current_user)
        return AnalysisResponse.model_validate(row)
    except Exception as e:
        raise _handle_service_error(e)


@router.patch("/{analysis_id}/reportable", response_model=AnalysisResponse)
def patch_reportable(
    analysis_id: int,
    req: SetReportableRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.set_reportable(
            db,
            analysis_id=analysis_id,
            reportable=req.reportable,
            reason=req.reason,
            user_id=getattr(current_user, "id", None),
        )
        return AnalysisResponse.model_validate(row)
    except Exception as e:
        raise _handle_service_error(e)


@router.patch("/{analysis_id}/method-instrument", response_model=AnalysisResponse)
def patch_method_instrument(
    analysis_id: int,
    req: SetMethodInstrumentRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.set_method_instrument(
            db,
            analysis_id=analysis_id,
            method_id=req.method_id,
            instrument_id=req.instrument_id,
            user_id=getattr(current_user, "id", None),
        )
        return AnalysisResponse.model_validate(row)
    except Exception as e:
        raise _handle_service_error(e)


@router.post("/promote", response_model=PromoteResponse, status_code=status.HTTP_201_CREATED)
def promote(
    req: PromoteRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    from models import AnalysisService, LimsAnalysis, LimsAnalysisPromotion, LimsSample, LimsSubSample

    # Resolve the parent SENAITE sample_id + parent-AR target keyword BEFORE
    # promoting, so per-substance vial keywords (PUR_<X>/QTY_<X>) land on the
    # parent's generic ANALYTE-{slot} line. Native keywords pass through
    # unchanged (no SENAITE read).
    first_src = db.get(LimsAnalysis, req.sources[0].analysis_id)
    if first_src is None:
        raise HTTPException(status_code=404, detail="source analysis not found")
    if first_src.lims_sub_sample_pk is not None:
        _sub = db.get(LimsSubSample, first_src.lims_sub_sample_pk)
        _parent = db.get(LimsSample, _sub.parent_sample_pk) if _sub else None
    else:
        _parent = db.get(LimsSample, first_src.lims_sample_pk)
    parent_sample_id = _parent.sample_id if _parent else None

    # Native (origin='mk1') sources have no per-substance SENAITE translation
    # and no SENAITE keyword contract at all — the caller-supplied req.keyword
    # is advisory, not identity. Force promote_to_parent's native-identity
    # override (service-derived keyword/title/unit, service.py step 4c) to
    # fire by passing None through, instead of trusting a request string that
    # can drift or arrive empty. Detected off the FIRST SOURCE's service:
    # native keywords never match the PUR_/QTY_ per-substance regex, so
    # resolve_parent_analyte_target would be a no-op for them anyway — this
    # just skips the call and is explicit about why, rather than relying on
    # that no-op to coincidentally pass req.keyword through unchanged.
    _first_src_svc = db.get(AnalysisService, first_src.analysis_service_id)
    _first_src_is_native = _first_src_svc is not None and _first_src_svc.origin == "mk1"

    if _first_src_is_native:
        parent_keyword, parent_service_id, parent_title = None, None, None
    else:
        try:
            if parent_sample_id:
                parent_keyword, parent_service_id, parent_title = service.resolve_parent_analyte_target(
                    db, vial_keyword=req.keyword, parent_sample_id=parent_sample_id)
            else:
                parent_keyword, parent_service_id, parent_title = req.keyword, None, None
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"parent slot resolution failed: {e}")

    try:
        parent_row, promotion_rows = service.promote_to_parent(
            db,
            keyword=req.keyword,
            result_value=req.result_value,
            result_unit=req.result_unit,
            method_id=req.method_id,
            instrument_id=req.instrument_id,
            sources=[s.model_dump() for s in req.sources],
            user_id=getattr(current_user, "id", None),
            reason=req.reason,
            parent_keyword=parent_keyword,
            parent_analysis_service_id=parent_service_id,
            parent_title=parent_title,
            commit=False,
        )
    except Exception as e:
        raise _handle_service_error(e)

    # ── SENAITE write-back (fail-closed) ──────────────────────────────────────
    # parent_sample_id was derived above (one definition). If it could not be
    # resolved, fall back to the parent-tier row's sample_id label.
    if parent_sample_id is None:
        parent_sample_obj = db.get(LimsSample, parent_row.lims_sample_pk)
        parent_sample_id = parent_sample_obj.sample_id if parent_sample_obj else str(parent_row.lims_sample_pk)

    # Collect source-vial sample_id labels from sub-sample rows.
    vial_ids: list[str] = []
    for prom in promotion_rows:
        src_analysis = db.get(LimsAnalysis, prom.source_analysis_id)
        if src_analysis and src_analysis.lims_sub_sample_pk is not None:
            sub = db.get(LimsSubSample, src_analysis.lims_sub_sample_pk)
            if sub is not None:
                vial_ids.append(sub.sample_id)

    email = getattr(current_user, "email", None) or "unknown"
    remark = (
        f"Promoted from {', '.join(vial_ids) if vial_ids else '(unknown vials)'} "
        f"(Accu-Mk1) by {email} on {date.today().isoformat()}"
    )

    # ── Origin gate (native COA sections, spec 2) ─────────────────────────────
    # A service with origin='mk1' has no SENAITE representation: there is no
    # analysis line to write back to, so the Mk1-side commit IS the promotion.
    # Read origin from the service backing the PARENT row — never the vial row:
    # resolve_parent_analyte_target translates per-substance keywords, and its
    # notion of "native" (not PUR_/QTY_) is a different predicate from
    # origin='mk1'.
    _parent_svc = db.get(AnalysisService, parent_row.analysis_service_id)
    _skip_writeback = _parent_svc is not None and _parent_svc.origin == "mk1"

    if not _skip_writeback:
        try:
            senaite_writeback.writeback_promotion(
                parent_sample_id,
                parent_row.keyword,        # parent ANALYTE-{slot} (was req.keyword)
                req.result_value,
                remark,
            )
        except SenaiteWritebackError as e:
            db.rollback()
            raise HTTPException(
                status_code=502,
                detail=f"SENAITE write-back failed — promote aborted: {e}",
            )
    else:
        logger.info(
            "native_promote_writeback_skipped parent_analysis_id=%s service_id=%s keyword=%s",
            parent_row.id, parent_row.analysis_service_id, parent_row.keyword,
        )

    try:
        db.commit()
    except Exception:
        # SENAITE is now AHEAD of Mk1: the parent AR line was written and
        # verified but the Mk1 promote failed to persist. Surface loudly so
        # an operator reconciles (a retry will 502 with "already verified").
        logger.error(
            "SENAITE write-back committed but Mk1 commit failed for "
            "parent=%s keyword=%s — manual reconciliation required",
            parent_sample_id, parent_row.keyword,
        )
        raise
    db.refresh(parent_row)
    for p in promotion_rows:
        db.refresh(p)

    # side-by-side engine: schedules workflow.engine.run_cascades_bg post-response
    _schedule_sbs_cascade(background_tasks, db, parent_row, current_user)

    return PromoteResponse(
        parent=AnalysisResponse.model_validate(parent_row),
        promotions=[PromotionRow.model_validate(p) for p in promotion_rows],
    )
