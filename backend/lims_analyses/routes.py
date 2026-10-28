"""FastAPI router for lims_analyses.

Thin HTTP shells over the service layer. Translates typed service
exceptions to structured HTTP responses; never writes to the DB
directly.
"""

from __future__ import annotations

import logging
from typing import List, Literal, Union

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin
from database import get_db
# senaite_writeback stays imported here although promote moved out: tests
# patch lims_analyses.routes.senaite_writeback.writeback_promotion, which is the
# same module object promote_flow calls.
from lims_analyses import manage_native, senaite_writeback, service  # noqa: F401
from lims_analyses.promote_flow import PromoteError, run_promote
from lims_analyses.senaite_writeback import (
    SenaiteWritebackError,
    list_parent_line_states,
)
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
    RelabelNativeSlotRequest,
    RelabelNativeSlotResponse,
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
    if isinstance(e, service.StateLockedError):
        return HTTPException(
            status_code=409,
            detail={
                "code": "state_locked",
                "review_state": e.review_state,
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
    source: str = Query("senaite"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Return analysis states keyed by keyword for a parent AR — the FE's
    isLockedByParent lock map for vial rows.

    source='senaite' (default): live SENAITE line states, best-effort —
    transport or SENAITE errors return {"states": {}} rather than 5xx.
    source='mk1' (the page's effective read source, passed by the FE): the
    native map — canonical tier owns its keywords, shadow fallback for
    keywords with no canonical history, zero SENAITE reads. Post promote-
    divergence (1.12.1) the SENAITE line stays verified forever, so mirroring
    it would permanently lock retested keywords' vials.
    """
    if source == "mk1":
        return {"states": service.native_parent_line_states(db, parent_sample_id)}
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
    """Native parent-tier retest: retests the promoted source vial rows via
    cascade_parent_retest_to_sources. A 'verified' or 'parent_to_verify'
    parent is un-promoted (retracted, value cleared); a 'published' parent
    keeps its citable value live and is superseded later by the retest's
    re-promote (Handler ruling 2026-08-28). 409 invalid_transition for any
    other state.

    analysis_service_id (S3, optional) identifies the parent row by its native
    identity key; without it the keyword resolves the row as before (exact
    stored keyword, then an mk1-catalog rescue on a miss)."""
    try:
        new_ids, state = service.parent_retest(
            db,
            sample_id=sample_id,
            keyword=req.keyword,
            user_id=getattr(current_user, "id", None),
            reason=req.reason,
            analysis_service_id=req.analysis_service_id,
            slot=req.slot,
            parent_analysis_id=req.parent_analysis_id,
        )
        return ParentRetestResponse(new_row_ids=new_ids, parent_review_state=state)
    except Exception as e:
        raise _handle_service_error(e)


@router.post("/parent/{sample_id}/native-slots/{slot}/relabel", response_model=RelabelNativeSlotResponse)
def relabel_native_slot_route(
    sample_id: str,
    slot: int,
    req: RelabelNativeSlotRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """The only sanctioned way to change a native-born sample's analyte slot
    (spec M6). 409 native_slot_locked (not native-born / bench activity),
    409 peptide_not_found, 409 duplicate_peptide, or 404 native_slot_not_found
    (empty slot)."""
    from lims_analyses.hplc_native import NativeSlotLockedError, NativeSlotNotFoundError, relabel_native_slot
    parent = _load_parent_or_404(db, sample_id)
    try:
        out = relabel_native_slot(
            db, parent=parent, slot=slot, new_peptide_id=req.new_peptide_id,
            user_id=getattr(current_user, "id", None), reason=req.reason,
        )
    except NativeSlotNotFoundError as e:
        raise HTTPException(status_code=404, detail={"code": e.code, "message": str(e)})
    except NativeSlotLockedError as e:
        raise HTTPException(status_code=409, detail={"code": e.code, "message": str(e)})
    return RelabelNativeSlotResponse(**out)


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
            method_id=req.method_id,
            instrument_id=req.instrument_id,
        )
        if req.kind == "submit":
            # Native blend aggregates are calculated, never typed: a slot result
            # entered by hand must fill/correct them exactly as Process HPLC
            # does. No-op for every row that is not a native per-slot
            # purity/quantity line on a vial.
            from lims_analyses.blend_aggregates import recalc_vial_aggregates_for_row
            recalc_vial_aggregates_for_row(db, row, getattr(current_user, "id", None))
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
    """The body lives in promote_flow.run_promote, shared with the worksheet
    endpoint. A PromoteError carries the exact status and detail this route
    raised before the move. Result limits are the worksheet promote's alone
    (final review I-3): it checks them against the stored reading and calls
    run_promote directly. The sample page never sends them, so a body that
    carries one is refused; without them the source's own are copied."""
    if (req.loq is not None or req.lod is not None or req.lod_unit is not None
            or req.result_floor is not None):
        raise HTTPException(status_code=400, detail="result limits are set by the worksheet promote")
    try:
        # run_promote schedules workflow.engine.run_cascades_bg on
        # background_tasks post-response, as this route always did.
        return run_promote(db, current_user, req, background_tasks=background_tasks)
    except PromoteError as e:
        raise HTTPException(status_code=e.status, detail=e.body)
