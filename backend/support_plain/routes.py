"""/support/* API. Reads: admin or Plain seat. Writes: Plain seat (spec 2026-10-09 section 4)."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from support_plain import actions, rules, seat, service
from support_plain.client import SupportNotConfigured, SupportUnavailable
from support_plain.seat import require_seat, require_support_reader

router = APIRouter(prefix="/support", tags=["support"])
Status = Literal["open", "snoozed", "done"]


class LabelRef(BaseModel):
    id: str
    type_id: str
    name: str


class Thread(BaseModel):
    id: str
    ref: str
    title: str
    status: Status
    priority: Literal["urgent", "high", "normal", "low"]
    labels: list[str]
    assignee: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    preview: str
    waiting_since: Optional[str] = None
    plain_url: str
    assignee_id: Optional[str] = None
    customer_plain_id: Optional[str] = None
    label_refs: list[LabelRef] = []


class Counts(BaseModel):
    open: int
    snoozed: int
    done: int
    waiting: int


class CustomerSupport(BaseModel):
    customer_key: str
    matched: int
    threads: list[Thread]
    total: int
    page: int
    page_size: int
    counts: Counts
    last_contact_at: Optional[str] = None
    oldest_waiting_since: Optional[str] = None
    fetched_at: str
    stale: bool
    refresh_throttled: bool


class Entry(BaseModel):
    id: str
    at: Optional[str] = None
    kind: Literal["email", "chat", "slack", "note", "discussion", "form", "event"]
    author: Optional[str] = None
    author_kind: Literal["customer", "agent", "system"]
    internal: bool
    subject: Optional[str] = None
    text: str


class ThreadDetail(BaseModel):
    thread: Thread
    entries: list[Entry]
    fetched_at: str
    stale: bool


def _fail(e: Exception):
    if isinstance(e, SupportNotConfigured):
        raise HTTPException(status_code=503, detail={"code": "support_not_configured"})
    raise HTTPException(status_code=502, detail={"code": "support_unavailable"})


@router.get("/customers/{customer_key}", response_model=CustomerSupport)
def customer_support(customer_key: str, refresh: bool = False, status: list[Status] = Query(default=[]),
                     page: int = Query(1, ge=1),
                     page_size: int = Query(rules.PAGE_SIZE, ge=1, le=rules.MAX_PAGE_SIZE),
                     _u=Depends(require_support_reader)):
    try:
        out = service.customer_support(customer_key, refresh=refresh, statuses=list(status), page=page,
                                       page_size=page_size)
    except (SupportNotConfigured, SupportUnavailable) as e:
        _fail(e)
    if out is None:
        raise HTTPException(status_code=404, detail="customer not found")
    return out


@router.get("/customers/{customer_key}/threads/{thread_id}", response_model=ThreadDetail)
def thread_detail(customer_key: str, thread_id: str = Path(pattern=rules.THREAD_ID_PATTERN), refresh: bool = False,
                  _u=Depends(require_support_reader)):
    try:
        out = service.thread_detail(customer_key, thread_id, refresh=refresh)
    except (SupportNotConfigured, SupportUnavailable) as e:
        _fail(e)
    if out is None:
        raise HTTPException(status_code=404, detail="thread not found")
    return out


class SupportMe(BaseModel):
    has_seat: bool
    plain_user_id: Optional[str] = None
    name: Optional[str] = None
    email: Optional[str] = None
    unavailable: bool = False


class Teammate(BaseModel):
    plain_user_id: str
    name: str
    email: str


class LabelType(BaseModel):
    id: str
    name: str
    color: Optional[str] = None


class Workspace(BaseModel):
    teammates: list[Teammate]
    label_types: list[LabelType]


@router.get("/me", response_model=SupportMe)
def me(user=Depends(get_current_user)):
    try:
        found = seat.resolve(getattr(user, "email", None))
    except (SupportNotConfigured, SupportUnavailable):
        return {"has_seat": False, "unavailable": True}
    if found is None:
        return {"has_seat": False}
    return {"has_seat": True, "plain_user_id": found.plain_user_id, "name": found.full_name, "email": found.email}


@router.get("/workspace", response_model=Workspace)
def workspace(_su=Depends(require_seat)):
    try:
        return service.workspace_people()
    except (SupportNotConfigured, SupportUnavailable) as e:
        _fail(e)


class TextBody(BaseModel):
    markdown: str = Field(max_length=20_000)


class StatusBody(BaseModel):
    status: Literal["todo", "done", "snoozed"]
    until: Optional[datetime] = None


class AssignBody(BaseModel):
    plain_user_id: Optional[str] = None


class PriorityBody(BaseModel):
    priority: Literal["urgent", "high", "normal", "low"]


class LabelsBody(BaseModel):
    add: list[str] = []
    remove: list[str] = []


class ActionResult(BaseModel):
    detail: Optional[ThreadDetail] = None


def _act(action: str, customer_key: str, thread_id: str, body: BaseModel, su, db: Session):
    try:
        out = actions.run(db, su.user, su.seat, customer_key, thread_id, action, body.model_dump(mode="json"))
    except actions.ActionFailed as e:
        raise HTTPException(status_code=e.status, detail={"code": e.code})
    except (SupportNotConfigured, SupportUnavailable) as e:  # the scoping read
        _fail(e)
    return {"detail": out}


_TH = Path(pattern=rules.THREAD_ID_PATTERN)


@router.post("/customers/{customer_key}/threads/{thread_id}/reply", response_model=ActionResult)
def reply(customer_key: str, body: TextBody, thread_id: str = _TH, su=Depends(require_seat),
          db: Session = Depends(get_db)):
    return _act("reply", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/note", response_model=ActionResult)
def note(customer_key: str, body: TextBody, thread_id: str = _TH, su=Depends(require_seat),
         db: Session = Depends(get_db)):
    return _act("note", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/status", response_model=ActionResult)
def status(customer_key: str, body: StatusBody, thread_id: str = _TH, su=Depends(require_seat),
           db: Session = Depends(get_db)):
    return _act("status", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/assign", response_model=ActionResult)
def assign(customer_key: str, body: AssignBody, thread_id: str = _TH, su=Depends(require_seat),
           db: Session = Depends(get_db)):
    return _act("assign", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/priority", response_model=ActionResult)
def priority(customer_key: str, body: PriorityBody, thread_id: str = _TH, su=Depends(require_seat),
             db: Session = Depends(get_db)):
    return _act("priority", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/labels", response_model=ActionResult)
def labels(customer_key: str, body: LabelsBody, thread_id: str = _TH, su=Depends(require_seat),
           db: Session = Depends(get_db)):
    return _act("labels", customer_key, thread_id, body, su, db)
