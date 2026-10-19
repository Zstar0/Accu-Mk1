"""/reports/customers/touchpoints: humans-only CRM touch, support touch, gating, fan-out, caching."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from auth import get_current_user
from crm_close.client import CrmUnavailable
from customer_insights import rules, touchpoints


def crm_items(*items):
    return {"leads": [{"id": "lead_A", "name": "Valor", "url": "https://app.close.com/lead/lead_A/"}],
            "items": list(items), "total": len(items), "stale": False}


def it(id, type="email", at="2026-10-01T10:00:00Z", status="sent", direction="outbound", automated=False):
    return {"id": id, "type": type, "at": at, "direction": direction, "who": "Scott", "title": "t " + id,
            "preview": "p", "lead_id": "lead_A", "lead_name": "Valor", "automated": automated,
            "email_status": status if type == "email" else None, "support_thread_url": None}


def support_threads(*threads, open_count=1):
    return {"threads": list(threads), "total": len(threads), "counts": {"open": open_count, "snoozed": 0, "done": 0, "waiting": 0},
            "last_contact_at": threads[0]["updated_at"] if threads else None, "stale": False}


def th(id="th_1", updated="2026-10-02T09:00:00Z", status="open"):
    return {"id": id, "title": "COA question", "status": status, "updated_at": updated, "waiting_since": None,
            "plain_url": f"https://app.plain.com/w/thread/{id}/"}


@pytest.fixture
def api(monkeypatch):
    import main

    calls = {"crm": [], "support": []}
    data = {"wc:1": crm_items(it("draft", status="draft", at="2026-10-03T10:00:00Z"), it("sent1")),
            "wc:2": crm_items(it("call1", type="call", at="2026-10-04T10:00:00Z"), it("sent2"))}
    sup = {"wc:1": support_threads(th()), "wc:2": support_threads()}

    def crm(key, **kw):
        calls["crm"].append((key, kw))
        if key == "wc:boom":
            raise CrmUnavailable("http_503")
        return data.get(key)

    def support(key, **kw):
        calls["support"].append((key, kw))
        return sup.get(key)

    monkeypatch.setattr(touchpoints, "_crm_fn", crm)
    monkeypatch.setattr(touchpoints, "_support_fn", support)
    monkeypatch.setattr(touchpoints, "_is_support_reader", lambda u: u.role in ("admin", "seat"))
    touchpoints._crm_cache.drop("")
    touchpoints._support_cache.drop("")
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    yield TestClient(main.app), calls
    main.app.dependency_overrides.clear()


def test_crm_touch_skips_drafts_and_takes_calls(api):
    client, calls = api
    body = client.get("/reports/customers/touchpoints?keys=wc:1&keys=wc:2").json()
    assert body["crm_visible"] is True and body["support_visible"] is True
    assert body["rows"]["wc:1"]["crm"]["state"] == "ok" and body["rows"]["wc:1"]["crm"]["title"] == "t sent1"
    assert body["rows"]["wc:1"]["crm"]["lead_url"] == "https://app.close.com/lead/lead_A/"
    assert body["rows"]["wc:2"]["crm"]["type"] == "call" and body["rows"]["wc:2"]["crm"]["at"] == "2026-10-04T10:00:00Z"
    kw = calls["crm"][0][1]
    assert kw["types"] == ["email", "call"] and kw["include_automated"] is False and kw["page_size"] == rules.TOUCH_SCAN
    assert body["rows"]["wc:1"]["support"] == {"state": "ok", "at": "2026-10-02T09:00:00Z", "thread_id": "th_1",
                                               "title": "COA question", "status": "open", "waiting_since": None,
                                               "plain_url": "https://app.plain.com/w/thread/th_1/", "open_count": 1,
                                               "stale": False, "reason": None}
    assert body["rows"]["wc:2"]["support"]["state"] == "none"


def test_missing_email_status_counts_as_a_touch(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(touchpoints, "_crm_fn", lambda key, **kw: crm_items(it("old", status=None)))
    assert client.get("/reports/customers/touchpoints?keys=wc:1").json()["rows"]["wc:1"]["crm"]["title"] == "t old"


def test_gating_omits_fields_and_skips_upstream_calls(api):
    import main

    client, calls = api
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=2, role="standard")
    body = client.get("/reports/customers/touchpoints?keys=wc:1").json()
    assert body == {"crm_visible": False, "support_visible": False, "rows": {"wc:1": {"crm": None, "support": None}}}
    assert calls["crm"] == [] and calls["support"] == []
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=3, role="seat")
    body = client.get("/reports/customers/touchpoints?keys=wc:1").json()
    assert body["crm_visible"] is False and body["rows"]["wc:1"]["crm"] is None
    assert body["rows"]["wc:1"]["support"]["state"] == "ok" and calls["crm"] == []


def test_one_failing_key_does_not_fail_the_rest_and_unknown_is_none(api):
    client, _ = api
    body = client.get("/reports/customers/touchpoints?keys=wc:1&keys=wc:boom&keys=email:nobody@x.com").json()["rows"]
    assert body["wc:1"]["crm"]["state"] == "ok"
    assert body["wc:boom"]["crm"] == {"state": "unavailable", "reason": "unavailable", "stale": False, "at": None,
                                       "type": None, "direction": None, "who": None, "title": None, "preview": None,
                                       "lead_name": None, "lead_url": None}
    assert body["email:nobody@x.com"]["crm"]["state"] == "none"
    assert body["email:nobody@x.com"]["crm"]["reason"] == "unknown_customer"


def test_summary_is_cached_and_unavailable_is_not(api):
    client, calls = api
    client.get("/reports/customers/touchpoints?keys=wc:1&keys=wc:boom")
    client.get("/reports/customers/touchpoints?keys=wc:1&keys=wc:boom")
    assert [k for k, _ in calls["crm"]].count("wc:1") == 1 and [k for k, _ in calls["crm"]].count("wc:boom") == 2
    assert touchpoints._crm_cache.peek("touch:wc:1") is not None
    assert touchpoints._crm_cache.peek("touch:wc:boom") is None


def test_key_cap_and_route_order(api):
    client, _ = api
    assert client.get("/reports/customers/touchpoints?" + "&".join(f"keys=wc:{i}" for i in range(51))).status_code == 422
    assert client.get("/reports/customers/touchpoints").status_code == 422
    assert client.get("/reports/customers/touchpoints?keys=wc:1").status_code == 200  # not swallowed by /{customer_key}
