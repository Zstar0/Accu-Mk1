"""/crm/* API (spec section 4). Admin-only."""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_admin
from crm_close import rules, service
from crm_close.client import CrmNotConfigured, CrmUnavailable

router = APIRouter(prefix="/crm", tags=["crm"])
ItemType = Literal["email", "call", "sms", "meeting", "note"]


class Contact(BaseModel):
    name: str
    emails: list[str]
    phones: list[str]


class Opportunity(BaseModel):
    status: Optional[str] = None
    value: float
    value_period: Optional[str] = None
    confidence: Optional[int] = None
    expected_date: Optional[str] = None


class Lead(BaseModel):
    id: str
    name: str
    status: Optional[str] = None
    owner: Optional[str] = None
    url: str
    contacts: list[Contact]
    opportunities: list[Opportunity]


class Item(BaseModel):
    id: str
    type: ItemType
    at: Optional[str] = None
    direction: Optional[Literal["inbound", "outbound"]] = None
    who: str
    title: str
    preview: str
    lead_id: Optional[str] = None
    lead_name: str
    automated: bool
    support_thread_url: Optional[str] = None


class Counts(BaseModel):
    email: int
    call: int
    sms: int
    meeting: int
    note: int
    automated: int


class CustomerCrm(BaseModel):
    configured: bool
    emails_tried: list[str]
    leads: list[Lead]
    items: list[Item]
    total: int
    page: int
    page_size: int
    counts: Counts
    fetched_at: str
    stale: bool
    refresh_throttled: bool


class EmailMessage(BaseModel):
    id: str
    at: Optional[str] = None
    direction: Optional[str] = None
    sender: str
    to: list[str]
    cc: list[str]
    subject: str
    body: str


class ActivityDetail(Item):
    messages: Optional[list[EmailMessage]] = None
    duration: Optional[int] = None
    disposition: Optional[str] = None
    note: Optional[str] = None
    recording_url: Optional[str] = None
    phone: Optional[str] = None
    text: Optional[str] = None
    remote_phone: Optional[str] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    attendees: Optional[list[str]] = None


def _fail(e: Exception):
    if isinstance(e, CrmNotConfigured):
        raise HTTPException(status_code=503, detail={"code": "crm_not_configured"})
    raise HTTPException(status_code=502, detail={"code": "crm_unavailable"})


@router.get("/customers/{customer_key}", response_model=CustomerCrm)
def customer_crm(customer_key: str, refresh: bool = False, types: list[ItemType] = Query(default=[]),
                 include_automated: bool = False, page: int = Query(1, ge=1),
                 page_size: int = Query(rules.PAGE_SIZE, ge=1, le=rules.MAX_PAGE_SIZE), _u=Depends(require_admin)):
    try:
        out = service.customer_crm(customer_key, refresh=refresh, types=list(types),
                                   include_automated=include_automated, page=page, page_size=page_size)
    except (CrmNotConfigured, CrmUnavailable) as e:
        _fail(e)
    if out is None:
        raise HTTPException(status_code=404, detail="customer not found")
    return out


@router.get("/customers/{customer_key}/activities/{activity_id}", response_model=ActivityDetail)
def activity_detail(customer_key: str, activity_id: str, type: ItemType, _u=Depends(require_admin)):
    try:
        out = service.activity_detail(customer_key, activity_id, type)
    except (CrmNotConfigured, CrmUnavailable) as e:
        _fail(e)
    if out is None:
        raise HTTPException(status_code=404, detail="activity not found")
    return out
