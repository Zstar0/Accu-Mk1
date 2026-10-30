"""/reports/customers/touchpoints (spec 2026-10-19, 4.1): last human CRM touch and last support touch.

Reads only through the CRM and Support services; the per-key summary is cached in each
service's own CACHE under `touch:<key>:`, which that service's refresh path drops (the trailing
colon keeps a prefix drop of `wc:1` off `wc:10`).
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Literal, Optional

from pydantic import BaseModel

from crm_close import service as crm_service
from crm_close.client import CrmNotConfigured, CrmUnavailable
from customer_insights import rules
from support_plain import seat
from support_plain import service as support_service
from support_plain.client import SupportNotConfigured, SupportUnavailable

logger = logging.getLogger(__name__)

State = Literal["ok", "none", "unavailable"]
Reason = Optional[Literal["not_configured", "unavailable", "unknown_customer"]]

# Seams for tests.
_crm_fn = crm_service.customer_crm
_support_fn = support_service.customer_support
_crm_cache = crm_service.CACHE
_support_cache = support_service.CACHE
_is_support_reader = seat.is_support_reader


class CrmTouch(BaseModel):
    state: State
    at: Optional[str] = None
    type: Optional[Literal["email", "call"]] = None
    direction: Optional[Literal["inbound", "outbound"]] = None
    who: Optional[str] = None
    title: Optional[str] = None
    preview: Optional[str] = None
    lead_name: Optional[str] = None
    lead_url: Optional[str] = None
    stale: bool = False
    reason: Reason = None


class SupportTouch(BaseModel):
    state: State
    at: Optional[str] = None
    thread_id: Optional[str] = None
    title: Optional[str] = None
    status: Optional[str] = None
    waiting_since: Optional[str] = None
    plain_url: Optional[str] = None
    open_count: Optional[int] = None
    stale: bool = False
    reason: Reason = None


class Touchpoints(BaseModel):
    crm: Optional[CrmTouch] = None
    support: Optional[SupportTouch] = None


class TouchpointsResponse(BaseModel):
    crm_visible: bool
    support_visible: bool
    rows: dict[str, Touchpoints]


class Unavailable(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


_UNKNOWN = {"state": "none", "reason": "unknown_customer", "stale": False}


def _is_touch(item: dict) -> bool:
    if item["type"] == "call":
        return True
    return item["type"] == "email" and (item.get("email_status") is None
                                        or item["email_status"] in rules.TOUCH_EMAIL_STATUSES)


def _crm_page(key: str, page: int) -> dict | None:
    return _crm_fn(key, refresh=False, types=["email", "call"], include_automated=False,
                   page=page, page_size=rules.TOUCH_SCAN)


def _load_crm(key: str) -> dict:
    try:
        data = _crm_page(key, 1)
        if data is None:
            return dict(_UNKNOWN)
        hit = next((i for i in data["items"] if _is_touch(i)), None)
        if hit is None and data["total"] > rules.TOUCH_SCAN:
            data = _crm_page(key, 2) or data
            hit = next((i for i in data["items"] if _is_touch(i)), None)
    except CrmNotConfigured as e:
        raise Unavailable("not_configured") from e
    except CrmUnavailable as e:
        raise Unavailable("unavailable") from e
    if hit is None:
        return {"state": "none", "stale": data["stale"]}
    urls = {l["id"]: l.get("url") for l in data["leads"]}
    return {"state": "ok", "at": hit["at"], "type": hit["type"], "direction": hit["direction"], "who": hit["who"],
            "title": hit["title"], "preview": hit["preview"], "lead_name": hit["lead_name"],
            "lead_url": urls.get(hit.get("lead_id")), "stale": data["stale"]}


def _load_support(key: str) -> dict:
    try:
        data = _support_fn(key, refresh=False, statuses=[], page=1, page_size=1)
    except SupportNotConfigured as e:
        raise Unavailable("not_configured") from e
    except SupportUnavailable as e:
        raise Unavailable("unavailable") from e
    if data is None:
        return dict(_UNKNOWN)
    if not data["threads"]:
        return {"state": "none", "stale": data["stale"]}
    t = data["threads"][0]
    return {"state": "ok", "at": data["last_contact_at"], "thread_id": t["id"], "title": t["title"],
            "status": t["status"], "waiting_since": t["waiting_since"], "plain_url": t["plain_url"],
            "open_count": data["counts"]["open"], "stale": data["stale"]}


def crm_touch(key: str) -> dict:
    # get_or_load stores only what the loader returns, so a raised Unavailable is never cached.
    return _crm_cache.get_or_load(f"touch:{key}:", rules.TOUCH_TTL, lambda: _load_crm(key))[0]


def support_touch(key: str) -> dict:
    return _support_cache.get_or_load(f"touch:{key}:", rules.TOUCH_TTL, lambda: _load_support(key))[0]


def _safe(fn: Callable[[str], dict], key: str) -> dict:
    try:
        return fn(key)
    except Unavailable as e:
        return {"state": "unavailable", "reason": e.reason, "stale": False}
    except Exception as e:  # noqa: BLE001 (logged without a traceback on purpose)
        # No traceback: an upstream exception message could carry customer data.
        logger.warning("customer_insights.touchpoints %s failed key_kind=%s error=%s", fn.__name__,
                       key.split(":")[0], type(e).__name__)
        return {"state": "unavailable", "reason": "unavailable", "stale": False}


def collect(keys: list[str], *, crm: bool, support: bool) -> dict[str, dict[str, Any]]:
    def one(key: str) -> dict[str, Any]:
        return {"crm": _safe(crm_touch, key) if crm else None,
                "support": _safe(support_touch, key) if support else None}

    if not (crm or support):
        return {k: {"crm": None, "support": None} for k in keys}
    unique = list(dict.fromkeys(keys))
    with ThreadPoolExecutor(max_workers=rules.TOUCH_WORKERS) as pool:
        return dict(zip(unique, pool.map(one, unique)))
