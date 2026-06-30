"""FastAPI router for flags. Thin HTTP shell over flags.service."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from flags import service
from flags.errors import BadRequestError, ConflictError, NotFoundError, PermissionDeniedError
from flags.schemas import (
    AssignRequest, CommentRequest, CommentResponse, CreateFlagRequest,
    FlagDetailResponse, FlagResponse, StatusRequest, SummaryResponse, WatcherRequest,
)

router = APIRouter(prefix="/api/flags", tags=["flags"])
logger = logging.getLogger(__name__)


def _http(e: Exception) -> HTTPException:
    if isinstance(e, NotFoundError):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, PermissionDeniedError):
        return HTTPException(status_code=403, detail=str(e))
    if isinstance(e, ConflictError):
        return HTTPException(status_code=409, detail=str(e))
    if isinstance(e, BadRequestError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, HTTPException):
        return e
    logger.exception("unhandled flags error")
    return HTTPException(status_code=500, detail="internal error")


@router.post("", response_model=FlagResponse, status_code=status.HTTP_201_CREATED)
def create_flag(req: CreateFlagRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return FlagResponse.model_validate(service.create_flag(
            db, user=user, entity_type=req.entity_type, entity_id=req.entity_id,
            type=req.type, title=req.title, assignee_id=req.assignee_id,
            first_comment=req.first_comment))
    except Exception as e:
        raise _http(e)


@router.get("", response_model=List[FlagResponse])
def list_flags(tab: str = Query("all_open"), status: Optional[str] = None,
               entity_type: Optional[str] = None, entity_id: Optional[str] = None,
               db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        rows = service.list_flags(db, user_id=getattr(user, "id", None), tab=tab,
                                  status=status, entity_type=entity_type, entity_id=entity_id)
        return [FlagResponse.model_validate(r) for r in rows]
    except Exception as e:
        raise _http(e)


@router.get("/summary", response_model=SummaryResponse)
def summary(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return SummaryResponse(**service.summary(db, user_id=getattr(user, "id", None)))


@router.get("/{flag_id}", response_model=FlagDetailResponse)
def get_flag(flag_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return FlagDetailResponse.model_validate(service.get_flag(db, flag_id))
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/comments", response_model=CommentResponse, status_code=201)
def add_comment(flag_id: int, req: CommentRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return CommentResponse.model_validate(service.add_comment(db, user=user, flag_id=flag_id, body=req.body))
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/assign", response_model=FlagResponse)
def assign(flag_id: int, req: AssignRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return FlagResponse.model_validate(service.assign(db, user=user, flag_id=flag_id, assignee_id=req.assignee_id))
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/status", response_model=FlagResponse)
def change_status(flag_id: int, req: StatusRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return FlagResponse.model_validate(service.change_status(db, user=user, flag_id=flag_id, to_status=req.to_status))
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/watchers", status_code=201)
def add_watcher(flag_id: int, req: WatcherRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.add_watcher(db, user=user, flag_id=flag_id, user_id=req.user_id)
        return {"ok": True}
    except Exception as e:
        raise _http(e)


@router.delete("/{flag_id}/watchers/{user_id}", status_code=204)
def remove_watcher(flag_id: int, user_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.remove_watcher(db, user=user, flag_id=flag_id, user_id=user_id)
    except Exception as e:
        raise _http(e)
