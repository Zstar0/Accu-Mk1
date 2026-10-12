"""`support_ticket` as a flag entity type (spec 2026-10-12 §3). Id: `{customer_key}|{thread_id}`."""
from __future__ import annotations

import re
from typing import Optional

from flags import access
from flags.errors import BadRequestError
from support_plain import rules

TYPE = "support_ticket"
FALLBACK = "Support ticket"
_KEY = re.compile(r"^(wc:\d+|email:[^|\s]+)$")  # WC account or guest key (spec 3.1)
_THREAD = re.compile(rules.THREAD_ID_PATTERN)


def parse(eid: object) -> Optional[tuple[str, str]]:
    parts = str(eid or "").split("|")
    if len(parts) != 2 or not _KEY.match(parts[0]) or not _THREAD.match(parts[1]):
        return None
    return parts[0], parts[1]


def _detail(eid: str) -> Optional[dict]:
    from support_plain import service
    p = parse(eid)
    return service.thread_detail(p[0], p[1]) if p else None


def _can_raise(db, user, eid: str) -> bool:
    if parse(eid) is None:
        raise BadRequestError(f"malformed support_ticket id {eid!r}")
    if _detail(eid) is None:
        raise BadRequestError("that ticket is not one of this customer's tickets")
    return True


def _snapshot(db, eid: str) -> dict:
    # A Plain failure here raises; seams.resolve_snapshot swallows it and the label falls back.
    t = (_detail(eid) or {}).get("thread") or {}
    customer = (t.get("customer") or {}).get("name")
    parts = [x for x in (t.get("ref"), t.get("title"), customer) if x]
    return {"label": " · ".join(parts) or FALLBACK, "ref": t.get("ref"), "title": t.get("title"),
            "customer": customer}


def _label(db, eid: str) -> str:
    return access.snapshot_label(db, TYPE, eid, FALLBACK)


def _context(db, eid: str) -> Optional[dict]:
    if parse(eid) is None:
        return None
    return {"label": _label(db, eid), "sample_id": None, "analyses": [], "lot": None,
            "deep_link": {"kind": "customer_item", "id": f"support:{eid}"}}


def register_support_ticket() -> None:
    from flags.seams import register_entity
    register_entity(TYPE, label=_label, deep_link=lambda eid: "/#customers",
                    can_flag=lambda user, eid: True,  # never consulted: can_raise wins
                    can_raise=_can_raise, context=_context, snapshot=_snapshot)
