"""FastAPI router for flags. Thin HTTP shell over flags.service."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import List, Optional

from fastapi import (
    APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status,
)
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin
from database import get_db
from flags import kinds_service, recurring, seams, service, types_service, watches
from flags.bus import BUS
from flags.errors import BadRequestError, ConflictError, NotFoundError, PermissionDeniedError
from flags.schemas import (
    ActivityItem, ActivityPage, AssignRequest, AttachmentResponse, CommentRequest,
    CommentResponse, CreateFlagRequest, DueRequest, EntityContext, EntityLinkOut,
    EntityLinkRequest, FlagDetailResponse, FlagLinkOut, FlagLinkRequest, FlagResponse,
    ArmWatchRequest, EntitySearchHit, FlagItemKindCreate, FlagItemKindResponse,
    FlagItemKindUpdate, FlagRecurringCreate, FlagRecurringResponse,
    FlagRecurringUpdate, FlagSearchHit, FlagTypeCreate, FlagTypeResponse, FlagTypeUpdate,
    ReactionAggregate, StatusRequest, SummaryResponse, WatchResponse,
    WatcherOut, WatcherRequest,
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
            first_comment=req.first_comment, due_at=req.due_at)
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
        user_id = getattr(user, "id", None)
        rows, next_cursor = service.list_activity(
            db, user_id=user_id, cursor=cursor, limit=limit)
        rel = service.compute_relevance(db, rows, user_id=user_id)
        items = [
            ActivityItem(
                id=ev.id, event_type=ev.event_type, actor_id=ev.actor_id,
                from_value=ev.from_value, to_value=ev.to_value,
                created_at=ev.created_at, flag=_with_entity(db, ev.flag),
                relevance=rel.get(ev.id, []),
            )
            for ev in rows
        ]
        return ActivityPage(items=items, next_cursor=next_cursor)
    except Exception as e:
        raise _http(e)


@router.get("/unread", response_model=List[FlagResponse])
def unread(db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Literal /unread above /{flag_id}.
    try:
        rows = service.list_unread(db, user_id=getattr(user, "id", None))
        return [_with_entity(db, r) for r in rows]
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


# --- item kinds (Slice 7) ------------------------------------------------
# Literal `/item-kinds*` routes are defined ABOVE `/{flag_id}` so they win the
# match (literal-before-param). Reads are open; mutations are admin-gated.
@router.get("/item-kinds", response_model=List[FlagItemKindResponse])
def list_item_kinds(active_only: bool = False, db: Session = Depends(get_db),
                    user=Depends(get_current_user)):
    try:
        return kinds_service.list_kinds(db, active_only=active_only)
    except Exception as e:
        raise _http(e)


@router.post("/item-kinds", response_model=FlagItemKindResponse, status_code=201)
def create_item_kind(req: FlagItemKindCreate, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    try:
        return kinds_service.create_kind(
            db, label=req.label, color=req.color, slug=req.slug,
            is_active=req.is_active, sort_order=req.sort_order)
    except Exception as e:
        raise _http(e)


@router.put("/item-kinds/{kind_id}", response_model=FlagItemKindResponse)
def update_item_kind(kind_id: int, req: FlagItemKindUpdate,
                     db: Session = Depends(get_db), admin=Depends(require_admin)):
    try:
        return kinds_service.update_kind(db, kind_id, **req.model_dump(exclude_unset=True))
    except Exception as e:
        raise _http(e)


@router.delete("/item-kinds/{kind_id}", status_code=204)
def delete_item_kind(kind_id: int, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    # Hard-delete only unused custom kinds; built-in/in-use raise ConflictError
    # → 409, signalling the client to offer the deactivate path instead.
    try:
        kinds_service.delete_kind(db, kind_id)
    except Exception as e:
        raise _http(e)


@router.get("/recurring", response_model=List[FlagRecurringResponse])
def list_recurring(db: Session = Depends(get_db), admin=Depends(require_admin)):
    # Admin-only config (like flag-type management); registered ABOVE /{flag_id}.
    try:
        return recurring.list_recurring(db)
    except Exception as e:
        raise _http(e)


@router.post("/recurring", response_model=FlagRecurringResponse, status_code=201)
def create_recurring(req: FlagRecurringCreate, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    try:
        return recurring.create_recurring(
            db, user=admin, title=req.title, type=req.type, cadence=req.cadence,
            body=req.body, assignee_id=req.assignee_id, watchers=req.watchers,
            entity_type=req.entity_type, entity_id=req.entity_id,
            skip_if_open=req.skip_if_open)
    except Exception as e:
        raise _http(e)


@router.put("/recurring/{rid}", response_model=FlagRecurringResponse)
def update_recurring(rid: int, req: FlagRecurringUpdate, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    try:
        return recurring.update_recurring(db, rid, **req.model_dump(exclude_unset=True))
    except Exception as e:
        raise _http(e)


@router.delete("/recurring/{rid}", status_code=204)
def delete_recurring(rid: int, db: Session = Depends(get_db),
                     admin=Depends(require_admin)):
    try:
        recurring.delete_recurring(db, rid)
    except Exception as e:
        raise _http(e)


@router.get("/entity-types", response_model=List[str])
def list_entity_types(db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Registered entity-type SLUGS only — the registry's `label` is a per-instance
    # callable ("Vial 42"), not a type-level name. The frontend resolves display
    # names from flag-entity.ts ENTITY_META.
    return sorted(seams._REGISTRY.keys())


@router.put("/comments/{comment_id}/reactions/{emoji}", response_model=List[ReactionAggregate])
def add_reaction(comment_id: int, emoji: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Literal /comments/... registered ABOVE /{flag_id} so it wins the match.
    try:
        return service.add_reaction(db, user=user, comment_id=comment_id, emoji=emoji)
    except Exception as e:
        raise _http(e)


@router.delete("/comments/{comment_id}/reactions/{emoji}", response_model=List[ReactionAggregate])
def remove_reaction(comment_id: int, emoji: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return service.remove_reaction(db, user=user, comment_id=comment_id, emoji=emoji)
    except Exception as e:
        raise _http(e)


@router.get("/attachments/{attachment_id}")
def get_attachment(attachment_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Literal /attachments/... registered ABOVE /{flag_id} so it wins the match.
    # Authenticated serve — no public URLs (spec §11).
    try:
        att = service.get_attachment(db, attachment_id)
        data = seams.get_attachment_storage().fetch(att.storage_key)
    except seams.AttachmentNotFound:
        raise HTTPException(status_code=404, detail="attachment file missing from storage")
    except Exception as e:
        raise _http(e)
    # Defense-in-depth: content_type is magic-byte-derived (raster images only),
    # but never let a browser second-guess it, and pin a download name that
    # can't smuggle header syntax (quotes/CRLF stripped to a safe subset).
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", att.filename or "") or "attachment"
    return Response(
        content=data,
        media_type=att.content_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f'inline; filename="{safe_name}"',
        },
    )


@router.get("/search", response_model=List[FlagSearchHit])
def search_flags(q: str = Query("", description="substring; <3 chars → empty"),
                 limit: int = Query(50, ge=1, le=100),
                 db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Literal /search registered ABOVE /{flag_id} so it wins the match
    # (literal-before-param). The service returns [] for <3 chars; the client
    # also gates at 3 chars + a 300ms debounce.
    try:
        return [FlagSearchHit.model_validate(h)
                for h in service.search_flags(db, q=q, limit=limit)]
    except Exception as e:
        raise _http(e)


@router.get("/entity-search", response_model=List[EntitySearchHit])
def entity_search(entity_type: str = Query(..., description="registered entity type"),
                  q: str = Query("", description="query; <2 chars → empty"),
                  db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Literal /entity-search registered ABOVE /{flag_id} (literal-before-param).
    # The seam is best-effort ([] for unregistered/no-resolver/error); a <2-char
    # query short-circuits before hitting the DB. The client also debounces.
    query = (q or "").strip()
    if len(query) < 2:
        return []
    try:
        return [EntitySearchHit.model_validate(h)
                for h in seams.resolve_entity_search(db, entity_type, query)]
    except Exception as e:
        raise _http(e)


# --- state-change watches (Plan 6) --------------------------------------
# Literal `/watches*` routes ABOVE `/{flag_id}` so they win the match.
@router.post("/watches", response_model=WatchResponse, status_code=201)
def arm_watch(req: ArmWatchRequest, db: Session = Depends(get_db),
              user=Depends(get_current_user)):
    try:
        w = watches.arm_watch(
            db, user=user, entity_type=req.entity_type, entity_id=req.entity_id,
            condition=req.condition.model_dump(),
            action=req.action.model_dump(exclude_none=True),
            watch_flag_id=req.watch_flag_id)
        return WatchResponse.model_validate(w)
    except Exception as e:
        raise _http(e)


@router.get("/watches", response_model=List[WatchResponse])
def list_watches(flag_id: Optional[int] = None, db: Session = Depends(get_db),
                 user=Depends(get_current_user)):
    try:
        return [WatchResponse.model_validate(w)
                for w in watches.list_watches(db, flag_id=flag_id)]
    except Exception as e:
        raise _http(e)


@router.delete("/watches/{watch_id}", status_code=204)
def cancel_watch(watch_id: int, db: Session = Depends(get_db),
                 user=Depends(get_current_user)):
    try:
        watches.cancel_watch(db, user=user, watch_id=watch_id)
    except Exception as e:
        raise _http(e)


@router.get("/{flag_id}", response_model=FlagDetailResponse)
def get_flag(flag_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        resp = _with_entity(db, service.get_flag(db, flag_id), FlagDetailResponse)
        resp.watchers = [WatcherOut.model_validate(w)
                         for w in service.list_watchers(db, flag_id)]
        resp.entity_links = []
        for link in service.list_entity_links(db, flag_id):
            out = EntityLinkOut.model_validate(link)
            ctx = seams.resolve_context(db, link.entity_type, link.entity_id)
            out.entity = EntityContext(**ctx) if ctx else None
            resp.entity_links.append(out)
        resp.flag_links = []
        for link in service.list_flag_links(db, flag_id):
            oid = link.linked_flag_id if link.flag_id == flag_id else link.flag_id
            o = service.get_flag(db, oid)
            resp.flag_links.append(FlagLinkOut(
                id=link.id, flag_id=o.id, title=o.title, status=o.status, type=o.type))
        # Reactions are an aggregate (batch query) — can't ride from_attributes.
        agg = service.aggregate_reactions(db, [c.id for c in resp.comments])
        for c in resp.comments:
            c.reactions = [ReactionAggregate(**a) for a in agg.get(c.id, [])]
        return resp
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/read", status_code=204)
def mark_read(flag_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.mark_read(db, user_id=getattr(user, "id", None), flag_id=flag_id)
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


@router.put("/{flag_id}/due", response_model=FlagResponse)
def set_due(flag_id: int, req: DueRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return _with_entity(db, service.set_due(db, user=user, flag_id=flag_id,
                                                due_at=req.due_at), FlagResponse)
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


@router.post("/{flag_id}/links/entities", status_code=201)
def add_entity_link(flag_id: int, req: EntityLinkRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        link = service.add_entity_link(db, user=user, flag_id=flag_id,
                                       entity_type=req.entity_type, entity_id=req.entity_id)
        return {"id": link.id}
    except Exception as e:
        raise _http(e)


@router.delete("/{flag_id}/links/entities/{link_id}", status_code=204)
def remove_entity_link(flag_id: int, link_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.remove_entity_link(db, user=user, flag_id=flag_id, link_id=link_id)
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/links/flags", status_code=201)
def add_flag_link(flag_id: int, req: FlagLinkRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        link = service.add_flag_link(db, user=user, flag_id=flag_id, other_id=req.flag_id)
        return {"id": link.id}
    except Exception as e:
        raise _http(e)


@router.delete("/{flag_id}/links/flags/{link_id}", status_code=204)
def remove_flag_link(flag_id: int, link_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.remove_flag_link(db, user=user, flag_id=flag_id, link_id=link_id)
    except Exception as e:
        raise _http(e)


# SYNC def (not async) so the blocking storage put + DB write run in the
# threadpool, per the documented event-loop-blocking incident.
@router.post("/{flag_id}/attachments", response_model=AttachmentResponse, status_code=201)
def add_attachment(flag_id: int, file: UploadFile = File(...),
                   db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        data = file.file.read()  # sync read of the spooled upload; threadpool-safe
        att = service.add_attachment(db, user=user, flag_id=flag_id, data=data,
                                     filename=file.filename or "upload")
        return AttachmentResponse.model_validate(att)
    except Exception as e:
        raise _http(e)
