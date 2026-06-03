"""FastAPI router for lims_analyses.

Thin HTTP shells over the service layer. Translates typed service
exceptions to structured HTTP responses; never writes to the DB
directly.
"""

from __future__ import annotations

from typing import List, Literal, Union

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from lims_analyses import service
from lims_analyses.schemas import (
    AnalysisResponse,
    AnalysisWithTransitions,
    CreateAnalysisRequest,
    HostKind,
    PromoteRequest,
    PromoteResponse,
    PromotionRow,
    SenaiteShapeAnalysisResponse,
    SetMethodInstrumentRequest,
    SetReportableRequest,
    TransitionInfo,
    TransitionRequest,
)
from lims_analyses.state_machine import (
    InvalidTransitionError,
    TierMismatchError,
    UnknownKindError,
    UnknownStateError,
    UnknownTierError,
)


router = APIRouter(prefix="/api/lims-analyses", tags=["lims-analyses"])


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
        )
        return PromoteResponse(
            parent=AnalysisResponse.model_validate(parent_row),
            promotions=[PromotionRow.model_validate(p) for p in promotion_rows],
        )
    except Exception as e:
        raise _handle_service_error(e)
