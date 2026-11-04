"""ai_chat.routes: the chat routes and the per-user event stream (spec 8).

Every route is `async def`, because `reserve`, `start_turn` and `APPROVALS.decide` create tasks and resolve futures,
which only the loop thread may do. A route that awaits the agent commits first, so its connection is back in the
pool for the wait, and reads no ORM attribute (the user's included) after that commit: the user is on the route's
own session, and an attribute read reopens a transaction that then stays open for the whole agent wait.

Every chat route goes through `_access`: the chat is the caller's and the provider still allows the caller's role.
Errors are `HTTPException(detail={"code": ..., "field": ...})`, the codes in the plan's error table. Values are
checked by hand, so a missing, empty or too long one gets a 422 of that shape, which never echoes what was sent. (A
body field of the wrong JSON type gets FastAPI's own 422, as in providers.py.)

Nothing here logs prompts, titles, tool details or exception text.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_chat import approvals, context, hub, sessions
from ai_chat.models import AcpProvider, AiChat, AiChatMessage, _utcnow
from auth import get_current_user
from database import get_db
from integration_keys import store

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ai-chat", tags=["ai-chat"])
KEEPALIVE_S = 15.0  # keeps both 120 s nginx hops open; a module attribute so a test can shorten it
_TEXT_MAX = 8000
_TITLE_MAX = 60  # the column's length


class ProviderItem(BaseModel):
    id: int
    slug: str
    display_name: str


class PendingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    permission_id: str
    source: str
    title: str
    detail: str
    can_allow: bool


class ChatOut(BaseModel):
    id: int
    provider_id: int
    title: str
    archived: bool
    created_at: str
    updated_at: str
    running_turn_id: str | None
    pending_approvals: list[PendingOut]


class MessageOut(BaseModel):
    id: int
    seq: int
    role: str
    text: str
    meta: dict[str, Any] | None
    created_at: str


class PromptOut(BaseModel):
    turn_id: str


class CancelOut(BaseModel):
    cancelled: bool


class DecisionOut(BaseModel):
    decision: str


# Bodies declare plain types and everything is optional, so a missing field is an `invalid_input` of the table's
# shape too. Unknown keys are ignored.
class ChatIn(BaseModel):
    model_config = ConfigDict(strict=True)
    provider_id: int | None = None


class ChatPatch(BaseModel):
    model_config = ConfigDict(strict=True)
    title: str | None = None
    archived: bool | None = None


class PromptIn(BaseModel):
    model_config = ConfigDict(strict=True)
    text: str | None = None
    page_context: Any = None  # `clean_context` takes anything and returns a dict or None


class DecisionIn(BaseModel):
    model_config = ConfigDict(strict=True)
    decision: str | None = None


# ---- helpers ------------------------------------------------------------------------------------

def _fail(status: int, code: str, field: str | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **({"field": field} if field else {})})


def _who(user) -> tuple[int, str]:
    """The caller's id and role as plain values, before anything commits."""
    return user.id, user.role


def _stripped(raw: str | None, field: str, limit: int) -> str:
    text = raw.strip() if raw is not None else ""
    if not 1 <= len(text) <= limit:
        raise _fail(422, "invalid_input", field)
    return text


def _check_role(provider: AcpProvider, role: str) -> None:
    if role not in (provider.allowed_roles or ()):
        raise _fail(403, "role_not_allowed")


def _access(db: Session, chat_id: int, user_id: int, role: str) -> tuple[AiChat, AcpProvider]:
    """The caller's chat and its provider. Other users' chats, an admin's included, are not found."""
    chat = db.get(AiChat, chat_id)
    if chat is None or chat.user_id != user_id:
        raise _fail(404, "chat_not_found")
    provider = db.get(AcpProvider, chat.provider_id)
    if provider is None:  # the foreign key forbids it
        raise _fail(404, "provider_not_found")
    _check_role(provider, role)
    return chat, provider


def _chat_out(chat: AiChat) -> ChatOut:
    return ChatOut(
        id=chat.id, provider_id=chat.provider_id, title=chat.title, archived=chat.archived,
        created_at=store._iso(chat.created_at), updated_at=store._iso(chat.updated_at),
        running_turn_id=sessions.MANAGER.running_turn(chat.id),
        # A card the browser was told about: `row_seq` is set in the step that publishes `permission_requested`.
        pending_approvals=[PendingOut.model_validate(p) for p in approvals.APPROVALS.pending_for_chat(chat.id)
                           if p.row_seq is not None])


# ---- providers and chats ------------------------------------------------------------------------

@router.get("/providers", response_model=list[ProviderItem])
async def list_providers(db: Session = Depends(get_db), user=Depends(get_current_user)):
    _, role = _who(user)
    rows = db.scalars(select(AcpProvider).where(AcpProvider.enabled.is_(True)).order_by(AcpProvider.id)).all()
    return [ProviderItem(id=r.id, slug=r.slug, display_name=r.display_name)
            for r in rows if role in (r.allowed_roles or ())]


@router.get("/chats", response_model=list[ChatOut])
async def list_chats(db: Session = Depends(get_db), user=Depends(get_current_user)):
    user_id, role = _who(user)
    rows = db.execute(
        select(AiChat, AcpProvider.allowed_roles).join(AcpProvider, AcpProvider.id == AiChat.provider_id)
        .where(AiChat.user_id == user_id, AiChat.archived.is_(False))
        .order_by(AiChat.updated_at.desc(), AiChat.id.desc())).all()
    return [_chat_out(chat) for chat, roles in rows if role in (roles or ())]


@router.post("/chats", response_model=ChatOut, status_code=201)
async def create_chat(body: ChatIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    user_id, role = _who(user)
    if body.provider_id is None:
        raise _fail(422, "invalid_input", "provider_id")
    provider = db.get(AcpProvider, body.provider_id)
    if provider is None:
        raise _fail(404, "provider_not_found")
    _check_role(provider, role)
    if not provider.enabled:
        raise _fail(404, "provider_not_found")
    chat = AiChat(user_id=user_id, provider_id=provider.id)
    db.add(chat)
    db.commit()
    return _chat_out(chat)


@router.patch("/chats/{chat_id}", response_model=ChatOut)
async def update_chat(chat_id: int, body: ChatPatch, db: Session = Depends(get_db), user=Depends(get_current_user)):
    user_id, role = _who(user)
    title = None if body.title is None else _stripped(body.title, "title", _TITLE_MAX)
    chat, _ = _access(db, chat_id, user_id, role)
    if title is not None:
        chat.title = title
    if body.archived is not None:
        chat.archived = body.archived
    db.commit()
    if body.archived:
        await sessions.MANAGER.close_chat(chat_id)  # nothing of the caller's is read between the commit and here
    return _chat_out(chat)


@router.get("/chats/{chat_id}/messages", response_model=list[MessageOut])
async def list_messages(chat_id: int, after_seq: int = 0, db: Session = Depends(get_db),
                        user=Depends(get_current_user)):
    user_id, role = _who(user)
    _access(db, chat_id, user_id, role)
    rows = db.scalars(select(AiChatMessage).where(AiChatMessage.chat_id == chat_id, AiChatMessage.seq > after_seq)
                      .order_by(AiChatMessage.seq)).all()
    return [MessageOut(id=m.id, seq=m.seq, role=m.role, text=m.text, meta=m.meta, created_at=store._iso(m.created_at))
            for m in rows]


# ---- turns and approvals ------------------------------------------------------------------------

@router.post("/chats/{chat_id}/prompt", response_model=PromptOut, status_code=202)
async def prompt(chat_id: int, body: PromptIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Stores the user's message and starts the turn. There is no `await` anywhere in this body, on purpose: from
    the `running_turn` check to `start_turn` nothing else may run on the loop. With a gap, two prompts both pass
    the check and start two turns, and another chat's `reserve` can evict the session this one reserved."""
    user_id, role = _who(user)
    text = _stripped(body.text, "text", _TEXT_MAX)
    chat, provider = _access(db, chat_id, user_id, role)
    if not provider.enabled:
        raise _fail(404, "provider_not_found")
    if sessions.MANAGER.running_turn(chat_id) is not None:
        raise _fail(409, "turn_running")
    stored_session_id = chat.acp_session_id  # read now, from this request's row: the turn restores that session
    try:
        session = sessions.MANAGER.reserve(chat_id, user_id, sessions.ProviderSnapshot.from_row(provider))
    except sessions.ProviderBusy:
        raise _fail(429, "provider_busy") from None
    page_context = context.clean_context(body.page_context)
    # A short blocking write, called directly rather than through `to_thread`: any await here would be that gap.
    user_seq = sessions.persist_message(chat_id, "user", text, {"page_context": page_context})
    if not chat.title:
        chat.title = text[:_TITLE_MAX]
    chat.updated_at = _utcnow()  # explicit: `onupdate` does not fire when the title was already set
    db.commit()
    try:
        turn_id = sessions.MANAGER.start_turn(session, text, page_context, stored_session_id, user_seq)
    except sessions.TurnRunning:
        raise _fail(409, "turn_running") from None
    except sessions.ProviderBusy:
        raise _fail(429, "provider_busy") from None
    return PromptOut(turn_id=turn_id)


@router.post("/chats/{chat_id}/cancel", response_model=CancelOut)
async def cancel(chat_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    user_id, role = _who(user)
    _access(db, chat_id, user_id, role)
    db.commit()  # ends the read transaction: the connection is back in the pool while the agent is stopped
    return CancelOut(cancelled=await sessions.MANAGER.cancel(chat_id))


@router.post("/chats/{chat_id}/permissions/{permission_id}", response_model=DecisionOut)
async def decide_permission(chat_id: int, permission_id: str, body: DecisionIn, db: Session = Depends(get_db),
                            user=Depends(get_current_user)):
    user_id, role = _who(user)
    if body.decision not in ("allow", "deny"):
        raise _fail(422, "invalid_input", "decision")
    decision = body.decision  # allow or deny, checked above
    _access(db, chat_id, user_id, role)
    # Spec 8: the entry's turn must still be the running one. The registry is bound to a turn, so this is the
    # second line; it leaves the entry as it is.
    running = sessions.MANAGER.running_turn(chat_id)
    if any(p.permission_id == permission_id and p.turn_id != running
           for p in approvals.APPROVALS.pending_for_chat(chat_id)):
        raise _fail(404, "permission_not_found")
    try:
        approvals.APPROVALS.decide(permission_id, user_id, decision, chat_id=chat_id)
    except approvals.ApprovalNotFound:
        raise _fail(404, "permission_not_found") from None
    except approvals.ApprovalConflict:
        raise _fail(409, "permission_decided") from None
    except approvals.AllowNotOffered:
        raise _fail(409, "allow_not_offered") from None
    # This is what the user asked for, not how the card ends: a Stop that lands first still settles it as
    # `cancelled`. Only `permission_resolved` (and the stored row) carry the outcome, so the browser must not show
    # "allowed" from this response.
    return DecisionOut(decision=decision)


# ---- the stream ---------------------------------------------------------------------------------

def _frame(event: dict) -> str | None:
    try:
        return hub.format_frame(event)
    except (TypeError, ValueError):  # not JSON: skipped, or it would break every reconnect's replay too
        logger.warning("ai_chat.stream_frame_skipped type=%s", event.get("type"))
        return None


async def _events(request: Request, user_id: int, last_event_id: str | None):
    # Subscribed in here, not in the route: a generator that never starts (the client left first) has subscribed to
    # nothing, and the `finally` below is the only way out of a subscription.
    sub = hub.HUB.subscribe(user_id, last_event_id)
    try:
        yield ": connected\n\n"
        for event in sub.backlog:
            if (data := _frame(event)) is not None:
                yield data
        while True:
            if await request.is_disconnected():
                break
            try:
                event = await asyncio.wait_for(sub.get(), KEEPALIVE_S)
            except TimeoutError:
                yield ": keepalive\n\n"
                continue
            if (data := _frame(event)) is not None:
                yield data
    finally:
        sub.close()


@router.get("/stream")
async def stream(request: Request, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """One stream per user, for all of that user's chats. Resume is server side: `Last-Event-ID` replays what the
    hub still holds, or answers `resync`."""
    user_id, role = _who(user)
    allowed = db.scalars(select(AcpProvider.allowed_roles).where(AcpProvider.enabled.is_(True))).all()
    if not any(role in (roles or ()) for roles in allowed):
        raise _fail(403, "role_not_allowed")
    last_event_id = request.headers.get("last-event-id")
    db.close()  # the stream stays open for hours: no connection is held for it
    return StreamingResponse(_events(request, user_id, last_event_id), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                                      "X-Accel-Buffering": "no"})
