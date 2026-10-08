"""/support/* API (spec section 4). Admin-only."""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel

from auth import require_admin
from support_plain import rules, service
from support_plain.client import SupportNotConfigured, SupportUnavailable

router = APIRouter(prefix="/support", tags=["support"])
Status = Literal["open", "snoozed", "done"]


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
                     _u=Depends(require_admin)):
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
                  _u=Depends(require_admin)):
    try:
        out = service.thread_detail(customer_key, thread_id, refresh=refresh)
    except (SupportNotConfigured, SupportUnavailable) as e:
        _fail(e)
    if out is None:
        raise HTTPException(status_code=404, detail="thread not found")
    return out
