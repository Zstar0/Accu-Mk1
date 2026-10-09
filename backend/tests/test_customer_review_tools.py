"""customer_review.tools: scoped, read-only, ledgered, capped."""
import json
from types import SimpleNamespace

import pytest

from customer_review import tools

THREAD = {"id": "th_1", "ref": "T-948", "title": "COA late", "status": "done", "priority": "normal", "labels": ["Lab"],
          "assignee": "Lauren", "created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-03T00:00:00Z",
          "preview": "where", "waiting_since": None, "plain_url": "https://app.plain.com/workspace/w/thread/th_1"}
CRM = {"id": "acti_1", "type": "email", "at": "2026-09-02T00:00:00Z", "direction": "inbound", "who": "k@x",
       "title": "COA question", "preview": "Where", "lead_id": "lead_A", "lead_name": "Valor", "automated": False,
       "support_thread_url": None}
ORDERS = [SimpleNamespace(order_id=501, order_number="8642", customer_key="wc:1"),
          SimpleNamespace(order_id=502, order_number="8700", customer_key="wc:2")]


@pytest.fixture
def ctx(monkeypatch):
    s = SimpleNamespace(calls=[])
    monkeypatch.setattr(tools, "_support_list", lambda key: [THREAD] if key == "wc:1" else [])
    monkeypatch.setattr(tools, "_support_detail", lambda key, tid: {"thread": THREAD, "entries": [
        {"id": "e1", "at": "2026-09-02T00:00:00Z", "kind": "email", "author": "Kyle", "author_kind": "customer",
         "internal": False, "subject": "Hi", "text": "x" * 5000}]})
    monkeypatch.setattr(tools, "_crm_list", lambda key, kind: [CRM])
    monkeypatch.setattr(tools, "_crm_detail", lambda key, aid, kind: ({**CRM, "messages": []} if aid == "acti_1" else None))
    monkeypatch.setattr(tools, "_dossier", lambda c: {"identity": {"name": "Kyle"}, "kpis": {"orders": 2},
                                                      "monthly": [1] * 99, "orders": [1] * 99,
                                                      "recent": [{"order_number": "8642"}]})
    monkeypatch.setattr(tools, "_customer_orders", lambda c: [o for o in ORDERS if o.customer_key == c.customer_key])
    monkeypatch.setattr(tools, "_samples_for_orders", lambda c, numbers, since: [
        {"sample_id": "P-2390", "order": "WP-8642", "tests": ["Purity"], "status": "published",
         "received": "2026-09-01", "is_retest": False}] if numbers else [])
    monkeypatch.setattr(tools, "_sla_by_sample", lambda c: {"P-2390": {"late": True, "bh": 30.0, "target": 24.0}})
    monkeypatch.setattr(tools, "_sample_activity", lambda c, sid: [{"timestamp": "t", "event": "retest_created",
                                                                   "label": "Retest created", "details": {"reason": "low"}}])
    monkeypatch.setattr(tools, "_sample_notes", lambda c, sid: {"remarks": ["checked"], "customer_remarks": None, "flags": []})
    monkeypatch.setattr(tools, "_coa_rows", lambda order_id: [{"sample_id": "P-2390", "generation_number": 2, "status": "published",
                                                               "published_at": "2026-09-05", "superseded_at": None}])
    return tools.Ctx(customer_key="wc:1", db=None)


def test_overview_trims_heavy_keys_and_ledgers_orders(ctx):
    out = tools.call(ctx, "customer_overview", {})
    assert out["identity"]["name"] == "Kyle" and "monthly" not in out and "orders" not in out
    assert ("order", "8642") in ctx.ledger and ctx.ledger[("order", "8642")]["order_id"] == "501"


def test_tickets_list_and_read_are_ledgered_and_capped(ctx):
    listing = tools.call(ctx, "list_tickets", {})
    assert listing["tickets"][0]["ref"] == "T-948" and ("ticket", "T-948") in ctx.ledger
    read = tools.call(ctx, "read_ticket", {"ref": "T-948"})
    assert len(read["entries"][0]["text"]) == tools.MAX_TEXT
    assert ctx.ledger[("ticket", "T-948")]["thread"]["id"] == "th_1"


def test_foreign_ticket_sample_and_order_are_refused(ctx):
    assert "error" in tools.call(ctx, "read_ticket", {"ref": "T-1"})
    assert "error" in tools.call(ctx, "sample_history", {"sample_id": "P-9999"})
    assert "error" in tools.call(ctx, "coa_versions", {"order_number": "8700"})
    assert not any(k[1] in ("T-1", "P-9999", "8700") for k in ctx.ledger)


def test_crm_list_and_read(ctx):
    assert tools.call(ctx, "list_crm", {})["items"][0]["id"] == "acti_1"
    assert ("crm", "acti_1") in ctx.ledger
    assert "error" in tools.call(ctx, "read_crm_item", {"id": "acti_9", "type": "email"})


def test_samples_with_sla_and_history(ctx):
    out = tools.call(ctx, "list_samples", {})
    assert out["samples"][0]["sla"] == {"late": True, "missed_by_business_hours": 6.0}
    assert ("sample", "P-2390") in ctx.ledger
    hist = tools.call(ctx, "sample_history", {"sample_id": "P-2390"})
    assert hist["events"][0]["label"] == "Retest created" and hist["remarks"] == ["checked"]


def test_coa_versions_accepts_either_order_number_form(ctx):
    assert tools.call(ctx, "coa_versions", {"order_number": "WP-8642"})["versions"][0]["generation_number"] == 2
    assert tools.call(ctx, "coa_versions", {"order_number": "8642"})["versions"]


def test_unknown_tool_and_tool_crash_return_errors(ctx, monkeypatch):
    assert "error" in tools.call(ctx, "delete_everything", {})

    def boom(key):
        raise RuntimeError("down")

    monkeypatch.setattr(tools, "_support_list", boom)
    assert tools.call(ctx, "list_tickets", {}) == {"error": "list_tickets failed (RuntimeError)"}


def test_capped_json():
    s = tools.capped_json({"x": "y" * 20_000})
    assert len(s) <= tools.MAX_RESULT_CHARS and s.endswith("[truncated]")
    json.loads(tools.capped_json({"a": 1}))


def test_every_tool_has_a_schema_and_no_customer_argument():
    for name, t in tools.TOOLS.items():
        assert t.schema["type"] == "object"
        assert not any("customer" in p for p in t.schema.get("properties", {})), name
