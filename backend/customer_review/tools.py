"""Read-only tools for the review agent (spec 3.2).

The customer is fixed per run (Ctx.customer_key); no tool takes a customer argument, and every id
argument is checked against this customer's own lists. Every id a tool returns is added to the run
ledger with the metadata the UI needs to link it; the agent drops citations not in the ledger.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import select

logger = logging.getLogger(__name__)
MAX_RESULT_CHARS = 12_000
MAX_TEXT = 4_000
MAX_ROWS = 50
_DROP_FROM_OVERVIEW = ("monthly", "order_dates", "orders", "test_prices", "coupons", "free_tests")


@dataclass
class Ctx:
    customer_key: str
    db: Any
    ledger: dict[tuple[str, str], dict] = field(default_factory=dict)
    memo: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Tool:
    fn: Callable[..., dict]
    description: str
    schema: dict
    label: Callable[[dict], str]


def capped_json(obj: Any) -> str:
    s = json.dumps(obj, default=str)
    if len(s) <= MAX_RESULT_CHARS:
        return s
    return s[:MAX_RESULT_CHARS - len("...[truncated]")] + "...[truncated]"


def _cut(text: str | None) -> str:
    return (text or "")[:MAX_TEXT]


def _bare(order_number: str) -> str:
    from customer_insights.dataset import norm_order_number
    return norm_order_number(order_number)


# ---- data seams (patched in tests) --------------------------------------------------------------

def _support_list(key: str) -> list[dict]:
    from support_plain import service
    out = service.customer_support(key, refresh=False, statuses=[], page=1, page_size=500)
    return (out or {}).get("threads", [])


def _support_detail(key: str, thread_id: str) -> dict | None:
    from support_plain import service
    return service.thread_detail(key, thread_id)


def _crm_list(key: str, kind: str | None) -> list[dict]:
    from crm_close import service
    out = service.customer_crm(key, refresh=False, types=[kind] if kind else [], include_automated=False,
                               page=1, page_size=200)
    return (out or {}).get("items", [])


def _crm_detail(key: str, activity_id: str, kind: str) -> dict | None:
    from crm_close import service
    return service.activity_detail(key, activity_id, kind)


def _insights(c: Ctx):
    if "insights" not in c.memo:
        from customer_insights.routes import _ctx
        c.memo["insights"] = _ctx(c.db, "all", None, None, False)
    return c.memo["insights"]


def _dossier(c: Ctx) -> dict | None:
    from customer_insights import metrics
    ds, _lo, hi, tz, _meta = _insights(c)
    return metrics.dossier(ds, c.customer_key, end=hi, tz=tz)


def _customer_orders(c: Ctx) -> list:
    ds = _insights(c)[0]
    return [o for o in (*ds.orders, *ds.free_orders) if o.customer_key == c.customer_key]


def _samples_for_orders(c: Ctx, numbers: list[str], since: date) -> list[dict]:
    from models import LimsAnalysis, LimsSample
    variants = {v for n in numbers for v in (n, f"WP-{n}")}
    rows = c.db.execute(select(LimsSample).where(LimsSample.client_order_number.in_(variants))
                        .order_by(LimsSample.date_received.desc())).scalars().all()
    out = []
    for s in rows:
        received = s.date_received.date() if isinstance(s.date_received, datetime) else s.date_received
        if received and received < since:
            continue
        titles = sorted(set(c.db.execute(select(LimsAnalysis.title).where(LimsAnalysis.lims_sample_pk == s.id))
                            .scalars()))
        out.append({"sample_id": s.sample_id, "order": s.client_order_number, "tests": titles, "status": s.status,
                    "received": str(received) if received else None, "is_retest": bool(s.is_retest)})
    return out


def _sla_by_sample(c: Ctx) -> dict[str, dict]:
    import main  # local: main imports the routes of this package
    recs = main.sla_sample_records(c.db, datetime.now(timezone.utc))
    return {r["sid"]: r for r in recs if r.get("sid")}


def _sample_activity(c: Ctx, sample_id: str) -> list[dict]:
    import main
    out = asyncio.run(main.get_sample_activity(sample_id, db=c.db, _current_user=None))
    return out.get("events", [])


def _sample_notes(c: Ctx, sample_id: str) -> dict:
    from models import LimsSample
    from sub_samples.registry_details import native_sample_remarks
    s = c.db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)).scalars().first()
    flags = _flags_for(c.db, sample_id, s.id) if s is not None else []
    return {"remarks": [_cut(r.content) for r in native_sample_remarks(c.db, sample_id)],
            "customer_remarks": _cut(getattr(s, "customer_remarks", None)) or None, "flags": flags}


def _flags_for(db, sample_id: str, pk: int) -> list[dict]:
    """Sample flags are keyed by the human id (P-2390) in the UI; some older rows use the pk."""
    from flags.models import FlagFlag
    rows = db.execute(select(FlagFlag).where(FlagFlag.entity_type == "sample",
                                             FlagFlag.entity_id.in_([sample_id, str(pk)]))).scalars()
    return [{"title": f.title, "type": f.type, "status": f.status} for f in rows]


def _coa_rows(order_id: str) -> list[dict]:
    from integration_db import fetch_coa_generations_for_order
    return fetch_coa_generations_for_order(order_id)


# ---- scope helpers ---------------------------------------------------------------------------------

def _tickets(c: Ctx) -> list[dict]:
    if "tickets" not in c.memo:
        c.memo["tickets"] = _support_list(c.customer_key)
    return c.memo["tickets"]


def _orders_by_number(c: Ctx) -> dict[str, Any]:
    if "orders" not in c.memo:
        c.memo["orders"] = {_bare(o.order_number): o for o in _customer_orders(c)}
    return c.memo["orders"]


def _sample_ids(c: Ctx) -> set[str]:
    if "sample_ids" not in c.memo:
        since = date.today() - timedelta(days=3650)
        c.memo["sample_ids"] = {s["sample_id"] for s in _samples_for_orders(c, list(_orders_by_number(c)), since)}
    return c.memo["sample_ids"]


def _ledger_order(c: Ctx, number: str) -> None:
    o = _orders_by_number(c).get(_bare(number))
    if o is not None:
        c.ledger[("order", _bare(number))] = {"order_id": str(o.order_id)}


# ---- tools -----------------------------------------------------------------------------------------

def customer_overview(c: Ctx) -> dict:
    d = _dossier(c)
    if d is None:
        return {"note": "no paid orders on record for this customer"}
    for number in _orders_by_number(c):
        _ledger_order(c, number)
    return {k: v for k, v in d.items() if k not in _DROP_FROM_OVERVIEW}


def list_tickets(c: Ctx, status: str | None = None) -> dict:
    rows = [t for t in _tickets(c) if not status or t["status"] == status]
    for t in rows:
        c.ledger[("ticket", t["ref"])] = {"thread": t}
    keep = ("ref", "title", "status", "priority", "labels", "created_at", "updated_at", "waiting_since", "preview")
    return {"tickets": [{k: t.get(k) for k in keep} for t in rows[:MAX_ROWS]], "more": len(rows) > MAX_ROWS}


def read_ticket(c: Ctx, ref: str) -> dict:
    t = next((x for x in _tickets(c) if x["ref"] == ref), None)
    if t is None:
        return {"error": f"{ref} is not one of this customer's tickets"}
    d = _support_detail(c.customer_key, t["id"]) or {}
    c.ledger[("ticket", ref)] = {"thread": t}
    entries = [{**e, "text": _cut(e.get("text"))} for e in d.get("entries", [])]
    return {"ref": ref, "title": t["title"], "status": t["status"], "entries": entries}


def list_crm(c: Ctx, type: str | None = None) -> dict:
    rows = _crm_list(c.customer_key, type)
    for it in rows:
        c.ledger[("crm", it["id"])] = {"item": it}
    keep = ("id", "type", "at", "direction", "title", "preview")
    return {"items": [{k: it.get(k) for k in keep} for it in rows[:MAX_ROWS]], "more": len(rows) > MAX_ROWS}


def read_crm_item(c: Ctx, id: str, type: str) -> dict:
    d = _crm_detail(c.customer_key, id, type)
    if d is None:
        return {"error": f"{id} is not one of this customer's CRM items"}
    item_keys = ("id", "type", "at", "direction", "who", "title", "preview", "lead_id", "lead_name", "automated",
                 "support_thread_url")
    c.ledger[("crm", id)] = {"item": {k: d.get(k) for k in item_keys}}
    out = {k: d.get(k) for k in ("id", "type", "at", "direction", "who", "title")}
    out["messages"] = [{**m, "body": _cut(m.get("body"))} for m in d.get("messages") or []]
    for k in ("note", "text", "disposition", "duration", "starts_at", "ends_at"):
        if d.get(k) is not None:
            out[k] = _cut(d[k]) if isinstance(d[k], str) else d[k]
    return out


def list_samples(c: Ctx, since: str | None = None) -> dict:
    try:
        start = date.fromisoformat(since) if since else date.today() - timedelta(days=365)
    except ValueError:
        return {"error": "since must be an ISO date (YYYY-MM-DD)"}
    rows = _samples_for_orders(c, list(_orders_by_number(c)), start)
    sla = _sla_by_sample(c)
    for s in rows:
        r = sla.get(s["sample_id"])
        s["sla"] = None if r is None else {
            "late": bool(r.get("late")),
            "missed_by_business_hours": round(r["bh"] - r["target"], 1) if r.get("late") and r.get("target") else 0.0}
        c.ledger[("sample", s["sample_id"])] = {}
        _ledger_order(c, s["order"])
    return {"samples": rows[:MAX_ROWS], "more": len(rows) > MAX_ROWS,
            "note": "SLA covers samples received from February 2026; business hours"}


def sample_history(c: Ctx, sample_id: str) -> dict:
    if sample_id not in _sample_ids(c):
        return {"error": f"{sample_id} is not one of this customer's samples"}
    c.ledger[("sample", sample_id)] = {}
    events = [{"at": e.get("timestamp"), "event": e.get("event"), "label": _cut(e.get("label")),
               "details": e.get("details")} for e in _sample_activity(c, sample_id)[:MAX_ROWS]]
    return {"sample_id": sample_id, "events": events, **_sample_notes(c, sample_id)}


def coa_versions(c: Ctx, order_number: str) -> dict:
    o = _orders_by_number(c).get(_bare(order_number))
    if o is None:
        return {"error": f"{order_number} is not one of this customer's orders"}
    _ledger_order(c, order_number)
    keep = ("sample_id", "generation_number", "status", "published_at", "superseded_at")
    rows = [{k: r.get(k) for k in keep} for r in _coa_rows(str(o.order_id))]
    for r in rows:
        if r.get("sample_id"):
            c.ledger[("sample", r["sample_id"])] = {}
    return {"order_number": _bare(order_number), "versions": rows[:MAX_ROWS]}


def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


_S = {"type": "string"}
TOOLS: dict[str, Tool] = {
    "customer_overview": Tool(customer_overview, "Customer identity, KPIs, on-time rate vs the lab, test mix and recent orders. Start here.",
                              _obj({}), lambda a: "Read customer overview"),
    "list_tickets": Tool(list_tickets, "List the customer's Plain support tickets, newest activity first.",
                         _obj({"status": {"type": "string", "enum": ["open", "snoozed", "done"]}}),
                         lambda a: "Listed support tickets"),
    "read_ticket": Tool(read_ticket, "Read one support ticket's full conversation, including internal notes.",
                        _obj({"ref": {"type": "string", "description": "Ticket ref such as T-948"}}, ["ref"]),
                        lambda a: f"Reading {a.get('ref')}"),
    "list_crm": Tool(list_crm, "List the customer's Close CRM emails, calls, SMS, meetings and notes (automated mail excluded).",
                     _obj({"type": {"type": "string", "enum": ["email", "call", "sms", "meeting", "note"]}}),
                     lambda a: "Listed CRM activity"),
    "read_crm_item": Tool(read_crm_item, "Read one Close CRM item in full (email thread, call note, note).",
                          _obj({"id": _S, "type": {"type": "string", "enum": ["email", "call", "sms", "meeting", "note"]}},
                               ["id", "type"]),
                          lambda a: f"Reading CRM {a.get('type')}"),
    "list_samples": Tool(list_samples, "List the customer's samples with tests, status, received date, retest flag and SLA (late, missed by business hours).",
                         _obj({"since": {"type": "string", "description": "ISO date; default 12 months back"}}),
                         lambda a: "Listed samples"),
    "sample_history": Tool(sample_history, "One sample's timeline: retests and reasons, COA generated/published/superseded, status changes, remarks, customer remarks, flags.",
                           _obj({"sample_id": {"type": "string", "description": "Sample id such as P-2390"}}, ["sample_id"]),
                           lambda a: f"Checking {a.get('sample_id')}"),
    "coa_versions": Tool(coa_versions, "Every COA version for one of the customer's orders.",
                         _obj({"order_number": {"type": "string", "description": "Order number such as 8642"}}, ["order_number"]),
                         lambda a: f"COA versions for order {a.get('order_number')}"),
}


def call(c: Ctx, name: str, args: dict) -> dict:
    t = TOOLS.get(name)
    if t is None:
        return {"error": f"unknown tool {name}"}
    try:
        return t.fn(c, **(args or {}))
    except TypeError:
        return {"error": f"bad arguments for {name}"}
    except Exception as e:  # a data source failing is information for the model, not a crashed run
        logger.warning("customer_review.tool_failed tool=%s error=%s", name, type(e).__name__)
        rollback = getattr(c.db, "rollback", None)
        if rollback is not None:  # a failed statement must not poison the run's session
            try:
                rollback()
            except Exception:
                logger.warning("customer_review.rollback_failed tool=%s", name)
        return {"error": f"{name} failed ({type(e).__name__})"}
