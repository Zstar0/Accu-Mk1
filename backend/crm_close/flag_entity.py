"""`crm_item` (a Close activity) as a flag entity type (spec 2026-10-12 §3). Id: `{customer_key}|{type}|{activity_id}`."""
from __future__ import annotations

import re
from typing import Optional

from fastapi import HTTPException

from flags import access
from flags.errors import BadRequestError

TYPE = "crm_item"
FALLBACK = "CRM item"
KINDS = {"email": "Email", "call": "Call", "sms": "SMS", "meeting": "Meeting", "note": "Note"}
_KEY = re.compile(r"^(wc:\d+|email:[^|\s]+)$")  # WC account or guest key (spec 3.1)
_ID = re.compile(r"^[A-Za-z0-9_]+$")  # also keeps the id safe to splice into the Close URL path


def parse(eid: object) -> Optional[tuple[str, str, str]]:
    parts = str(eid or "").split("|")
    if len(parts) != 3 or not _KEY.match(parts[0]) or parts[1] not in KINDS or not _ID.match(parts[2]):
        return None
    return parts[0], parts[1], parts[2]


def _item(eid: str) -> Optional[dict]:
    from crm_close import service
    from crm_close.client import CrmUnavailable
    p = parse(eid)
    if p is None:
        return None
    try:
        return service.activity_detail(p[0], p[2], p[1])
    except CrmUnavailable as e:
        if str(e) == "http_404":  # Close has no such activity
            return None
        raise


def _can_raise(db, user, eid: str) -> bool:
    from crm_close.client import CrmNotConfigured, CrmUnavailable
    if parse(eid) is None:
        raise BadRequestError(f"malformed crm_item id {eid!r}")
    try:
        found = _item(eid)
    except (CrmNotConfigured, CrmUnavailable):
        # Fail closed: ownership can't be checked. flags.routes passes an HTTPException through.
        raise HTTPException(status_code=503, detail={"code": "crm_unavailable"})
    if found is None:
        raise BadRequestError("that item is not one of this customer's CRM items")
    return True


def _snapshot(db, eid: str) -> dict:
    # A Close failure here raises; seams.resolve_snapshot swallows it and the label falls back.
    it = _item(eid) or {}
    kind = KINDS[parse(eid)[1]]
    parts = [x for x in (kind, it.get("title"), it.get("lead_name")) if x]
    return {"label": " · ".join(parts), "type": kind, "title": it.get("title"), "at": it.get("at"),
            "lead": it.get("lead_name")}


def _label(db, eid: str) -> str:
    return access.snapshot_label(db, TYPE, eid, FALLBACK)


def _context(db, eid: str) -> Optional[dict]:
    if parse(eid) is None:
        return None
    return {"label": _label(db, eid), "sample_id": None, "analyses": [], "lot": None,
            "deep_link": {"kind": "customer_item", "id": f"crm:{eid}"}}


def register_crm_item() -> None:
    from flags.seams import register_entity
    register_entity(TYPE, label=_label, deep_link=lambda eid: "/#customers",
                    can_flag=lambda user, eid: True,  # never consulted: can_raise wins
                    can_raise=_can_raise, context=_context, snapshot=_snapshot)
