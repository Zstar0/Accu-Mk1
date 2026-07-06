"""FastAPI router for lims_analyses.

Thin HTTP shells over the service layer. Translates typed service
exceptions to structured HTTP responses; never writes to the DB
directly.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import List, Literal, Union

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from lims_analyses import senaite_writeback, service
from lims_analyses.senaite_writeback import SenaiteWritebackError, list_parent_line_states
from lims_analyses.schemas import (
    AnalysisResponse,
    AnalysisWithTransitions,
    CreateAnalysisRequest,
    HostKind,
    ParentPromotionInfo,
    PromoteRequest,
    PromoteResponse,
    PromotionRow,
    SenaiteShapeAnalysisResponse,
    SetMethodInstrumentRequest,
    SetReportableRequest,
    TransitionInfo,
    TransitionRequest,
    UnpromoteRequest,
    UnpromoteResponse,
)
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
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    from models import LimsAnalysis, LimsAnalysisPromotion, LimsSample, LimsSubSample

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

    return PromoteResponse(
        parent=AnalysisResponse.model_validate(parent_row),
        promotions=[PromotionRow.model_validate(p) for p in promotion_rows],
    )


@router.post("/unpromote", response_model=UnpromoteResponse)
def unpromote(
    req: UnpromoteRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Unlock a promotion. SENAITE guard runs BEFORE any Mk1 mutation and is
    fail-closed: if the parent AR line is verified/published — or its state
    cannot be confirmed — the unlock is refused (retract in SENAITE first)."""
    from models import LimsSample

    try:
        parent_row = service.get_analysis(db, req.parent_analysis_id)
    except service.NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # All local preconditions BEFORE any SENAITE call: a doomed request
    # (blank reason, wrong tier/state, no links) must never retract the
    # parent AR line first.
    try:
        service.validate_unpromote(
            db, parent_analysis_id=req.parent_analysis_id, reason=req.reason
        )
    except Exception as e:
        raise _handle_service_error(e)

    parent_sample = (
        db.get(LimsSample, parent_row.lims_sample_pk)
        if parent_row.lims_sample_pk is not None else None
    )
    # Fallback mirrors the promote endpoint: if the LimsSample row can't be
    # resolved, pass the raw pk string so the guard still RUNS (the lookup
    # fails inside find_parent_analysis_line → SenaiteWritebackError → 409
    # fail-closed) instead of being silently skipped.
    parent_sample_id = (
        parent_sample.sample_id if parent_sample
        else str(parent_row.lims_sample_pk)
    )

    try:
        line = senaite_writeback.find_parent_analysis_line(
            parent_sample_id, parent_row.keyword)
    except SenaiteWritebackError as e:
        raise HTTPException(
            status_code=409,
            detail=f"SENAITE state could not be confirmed — unlock "
                   f"blocked (fail-closed): {e}",
        )
    # "verified" is defense-in-depth: the reader raises for verified-only
    # lines today; "published" is the live path.
    if line["review_state"] in ("verified", "published"):
        raise HTTPException(
            status_code=409,
            detail=f"parent analysis line {parent_row.keyword!r} on "
                   f"{parent_sample_id} is {line['review_state']} in "
                   f"SENAITE — retract it in SENAITE first, then unlock",
        )

    # The original promote SUBMITTED this line (→ to_be_verified) and SENAITE
    # refuses field writes on submitted lines, so a re-promote after unlock
    # would 401 on the Result/Remarks update. Retract it now — the editable
    # retest sibling SENAITE spawns is what the next promote targets. Still
    # BEFORE any Mk1 mutation and fail-closed, same as the guard above.
    # Lines already at unassigned/assigned (e.g. manually retracted earlier)
    # are field-writable and need nothing.
    if line["review_state"] == "to_be_verified":
        try:
            senaite_writeback.retract_analysis_line(line["uid"])
        except SenaiteWritebackError as e:
            raise HTTPException(
                status_code=409,
                detail=f"SENAITE parent line could not be retracted — unlock "
                       f"blocked (fail-closed): {e}",
            )

    try:
        parent, reverted = service.unpromote_parent_analysis(
            db,
            parent_analysis_id=req.parent_analysis_id,
            reason=req.reason,
            user_id=getattr(current_user, "id", None),
        )
    except Exception as e:
        raise _handle_service_error(e)

    return UnpromoteResponse(
        parent=AnalysisResponse.model_validate(parent),
        reverted_source_ids=reverted,
    )
