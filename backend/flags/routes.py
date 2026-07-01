"""FastAPI router for flags. Thin HTTP shell over flags.service."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin
from database import get_db
from flags import seams, service, types_service
from flags.bus import BUS
from flags.errors import BadRequestError, ConflictError, NotFoundError, PermissionDeniedError
from flags.schemas import (
    ActivityItem, ActivityPage, AssignRequest, CommentRequest, CommentResponse,
    CreateFlagRequest, EntityContext, FlagDetailResponse, FlagResponse,
    FlagTypeCreate, FlagTypeResponse, FlagTypeUpdate, StatusRequest,
    SummaryResponse, WatcherRequest,
)

router = APIRouter(prefix="/api/flags", tags=["flags"])
logger = logging.getLogger(__name__)


def _with_entity(db: Session, flag, resp_cls=FlagResponse):
    """Serialize a flag ORM row and decorate it with resolved entity context.

    Context is best-effort (a card without it still renders) — `resolve_context`
    swallows resolver errors and returns None, which leaves `entity` unset.
    """
    resp = resp_cls.model_validate(flag)
    ctx = seams.resolve_context(db, flag.entity_type, flag.entity_id)
    if ctx is not None:
        resp.entity = EntityContext.model_validate(ctx)
    return resp


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
        flag = service.create_flag(
            db, user=user, entity_type=req.entity_type, entity_id=req.entity_id,
            type=req.type, title=req.title, assignee_id=req.assignee_id,
            first_comment=req.first_comment)
        return _with_entity(db, flag)
    except Exception as e:
        raise _http(e)


@router.get("", response_model=List[FlagResponse])
def list_flags(tab: str = Query("all_open"), status: Optional[str] = None,
               entity_type: Optional[str] = None, entity_id: Optional[str] = None,
               include_descendants: bool = False,
               db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        rows = service.list_flags(db, user_id=getattr(user, "id", None), tab=tab,
                                  status=status, entity_type=entity_type, entity_id=entity_id,
                                  include_descendants=include_descendants)
        return [_with_entity(db, r) for r in rows]
    except Exception as e:
        raise _http(e)


@router.get("/summary", response_model=SummaryResponse)
def summary(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return SummaryResponse(**service.summary(db, user_id=getattr(user, "id", None)))


@router.get("/activity", response_model=ActivityPage)
def activity(cursor: Optional[str] = None, limit: int = Query(25, ge=1, le=50),
             db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Literal /activity is registered ABOVE /{flag_id} so it wins the match.
    try:
        rows, next_cursor = service.list_activity(
            db, user_id=getattr(user, "id", None), cursor=cursor, limit=limit)
        items = [
            ActivityItem(
                id=ev.id, event_type=ev.event_type, actor_id=ev.actor_id,
                from_value=ev.from_value, to_value=ev.to_value,
                created_at=ev.created_at, flag=_with_entity(db, ev.flag),
            )
            for ev in rows
        ]
        return ActivityPage(items=items, next_cursor=next_cursor)
    except Exception as e:
        raise _http(e)


@router.get("/stream")
async def stream(request: Request, user=Depends(get_current_user)):
    sub = BUS.subscribe(getattr(user, "id", None))

    async def gen():
        yield ": connected\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(sub.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                frame = ""
                if event.get("event_id") is not None:
                    frame += f"id: {event['event_id']}\n"
                frame += f"event: {event['event_type']}\ndata: {json.dumps(event)}\n\n"
                yield frame
        finally:
            sub.close()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# --- flag types (Plan 5) -------------------------------------------------
# Literal `/types*` + `/entity-types` routes are defined ABOVE `/{flag_id}` so
# they win the match (literal-before-param). Mutations are admin-gated.
@router.get("/types", response_model=List[FlagTypeResponse])
def list_flag_types(entity_type: Optional[str] = None, active_only: bool = False,
                    db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return types_service.list_types(db, entity_type=entity_type, active_only=active_only)
    except Exception as e:
        raise _http(e)


@router.post("/types", response_model=FlagTypeResponse, status_code=201)
def create_flag_type(req: FlagTypeCreate, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    try:
        return types_service.create_type(
            db, label=req.label, color=req.color, kind=req.kind, slug=req.slug,
            is_blocking=req.is_blocking, is_active=req.is_active,
            sort_order=req.sort_order, entity_types=req.entity_types)
    except Exception as e:
        raise _http(e)


@router.put("/types/{type_id}", response_model=FlagTypeResponse)
def update_flag_type(type_id: int, req: FlagTypeUpdate, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    try:
        return types_service.update_type(db, type_id, **req.model_dump(exclude_unset=True))
    except Exception as e:
        raise _http(e)


@router.delete("/types/{type_id}", status_code=204)
def delete_flag_type(type_id: int, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    # Hard-delete only unused custom types; built-in/in-use raise ConflictError
    # → 409, signalling the client to offer the deactivate path instead.
    try:
        types_service.delete_type(db, type_id)
    except Exception as e:
        raise _http(e)


@router.get("/entity-types", response_model=List[str])
def list_entity_types(db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Registered entity-type SLUGS only — the registry's `label` is a per-instance
    # callable ("Vial 42"), not a type-level name. The frontend resolves display
    # names from flag-entity.ts ENTITY_META.
    return sorted(seams._REGISTRY.keys())


@router.get("/{flag_id}", response_model=FlagDetailResponse)
def get_flag(flag_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return _with_entity(db, service.get_flag(db, flag_id), FlagDetailResponse)
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/comments", response_model=CommentResponse, status_code=201)
def add_comment(flag_id: int, req: CommentRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return CommentResponse.model_validate(
            service.add_comment(db, user=user, flag_id=flag_id, body=req.body,
                                mention_ids=req.mention_ids))
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
