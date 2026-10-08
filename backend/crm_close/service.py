"""Orchestration: match (cached), timeline (cached), refresh, stale fallback, detail scoping."""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

from crm_close import match, rules, timeline
from crm_close.cache import TTLCache
from crm_close.client import CrmNotConfigured, CrmUnavailable, get_client

logger = logging.getLogger(__name__)
CACHE = TTLCache()
_client_factory = get_client
_emails_fn = match.customer_emails
_PATHS = {"email": "activity/email/", "call": "activity/call/", "sms": "activity/sms/",
          "meeting": "activity/meeting/", "note": "activity/note/"}


def _iso(monotonic_at: float) -> str:
    age = max(0.0, time.monotonic() - monotonic_at)
    return datetime.fromtimestamp(time.time() - age, timezone.utc).isoformat().replace("+00:00", "Z")


def _load(customer_key: str, emails: list[str]) -> dict[str, Any]:
    client = _client_factory()
    raw_leads, _ = CACHE.get_or_load(f"m:{customer_key}", rules.MATCH_TTL,
                                     lambda: match.find_leads(emails, client))
    leads = [match.shape_lead(l) for l in raw_leads]
    names = {l["id"]: l["name"] for l in leads}
    acts: list[dict] = []
    for lead in leads:
        acts.extend(client.paginate("activity/", {"lead_id": lead["id"]}))
    return {"leads": leads, "items": timeline.build(acts, names)}


def customer_crm(customer_key: str, *, refresh: bool, types: list[str], include_automated: bool,
                 page: int, page_size: int) -> dict[str, Any] | None:
    emails = _emails_fn(customer_key)
    if emails is None:
        return None
    key = f"t:{customer_key}"
    throttled = False
    if refresh:
        if CACHE.allow_refresh(customer_key, rules.REFRESH_COOLDOWN):
            stale_copy = CACHE.peek(key)
            CACHE.drop(f"m:{customer_key}")
            CACHE.drop(key)
        else:
            throttled = True
            stale_copy = None
    else:
        stale_copy = None
    stale = False
    try:
        if not emails:
            data, at = {"leads": [], "items": []}, time.monotonic()
        else:
            data, at = CACHE.get_or_load(key, rules.TIMELINE_TTL, lambda: _load(customer_key, emails))
    except CrmUnavailable:
        fallback = stale_copy or CACHE.peek(key)
        if fallback is None:
            raise
        data, at = fallback
        stale = True
    except CrmNotConfigured:
        raise
    items = data["items"]
    counts = {t: sum(1 for i in items if i["type"] == t and not i["automated"])
              for t in ("email", "call", "sms", "meeting", "note")}
    counts["automated"] = sum(1 for i in items if i["automated"])
    shown = [i for i in items if (include_automated or not i["automated"]) and (not types or i["type"] in types)]
    logger.info("crm_close.customer key_kind=%s leads=%d items=%d stale=%s", customer_key.split(":")[0],
                len(data["leads"]), len(items), stale)
    start = (page - 1) * page_size
    return {"configured": True, "emails_tried": emails, "leads": data["leads"],
            "items": shown[start:start + page_size], "total": len(shown), "page": page, "page_size": page_size,
            "counts": counts, "fetched_at": _iso(at), "stale": stale, "refresh_throttled": throttled}


def activity_detail(customer_key: str, activity_id: str, kind: str) -> dict[str, Any] | None:
    if kind not in _PATHS:
        return None
    emails = _emails_fn(customer_key)
    if not emails:
        return None
    client = _client_factory()
    raw_leads, _ = CACHE.get_or_load(f"m:{customer_key}", rules.MATCH_TTL,
                                     lambda: match.find_leads(emails, client))
    names = {l["id"]: match.shape_lead(l)["name"] for l in raw_leads}
    a = client.get(f"{_PATHS[kind]}{activity_id}/")
    if a.get("lead_id") not in names:
        return None
    thread: list[dict] = []
    if kind == "email" and a.get("thread_id"):
        page = client.get("activity/email/", {"lead_id": a["lead_id"], "thread_id": a["thread_id"], "_limit": 100})
        thread = [m for m in page.get("data") or [] if m.get("thread_id") == a["thread_id"]]
    a.setdefault("_type", {"email": "Email", "call": "Call", "sms": "SMS", "meeting": "Meeting", "note": "Note"}[kind])
    return timeline.detail(a, thread, names)
