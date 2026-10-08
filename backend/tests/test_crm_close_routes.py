"""/crm/* routes: admin gate, shapes, refresh, failures, detail scoping."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from auth import get_current_user
from crm_close import client as close_client
from crm_close import service

LEAD = {"id": "lead_A", "display_name": "Valor", "status_label": "Active Customer",
        "html_url": "https://app.close.com/lead/lead_A/", "contacts": [], "opportunities": []}
ACTS = [
    {"_type": "Email", "id": "acti_1", "lead_id": "lead_A", "activity_at": "2026-09-02T10:00:00Z", "direction": "incoming",
     "subject": "COA question", "sender": "k@x.example", "body_text": "Where is it", "thread_id": "t1"},
    {"_type": "Email", "id": "acti_2", "lead_id": "lead_A", "activity_at": "2026-09-03T10:00:00Z", "direction": "outgoing",
     "subject": "[Accumark Labs]: You've got a new order: #1", "sender": "shop@x.example", "body_text": "Order"},
    {"_type": "Note", "id": "acti_3", "lead_id": "lead_A", "date_created": "2026-09-04T10:00:00Z", "note": "Call back Friday"},
]


class FakeClose:
    def __init__(self, fail=False):
        self.fail, self.calls = fail, 0

    def get(self, path, params=None):
        self.calls += 1
        if self.fail:
            raise close_client.CrmUnavailable("http_503")
        if path == "lead/":
            return {"data": [LEAD]}
        if path == "activity/email/":  # thread lookup (list); must precede the single-item branch
            return {"data": [a for a in ACTS if a["_type"] == "Email"], "has_more": False}
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "activity":  # activity/<type>/<id>/
            return next(a for a in ACTS if a["id"] == parts[2])
        return {"data": [], "has_more": False}

    def paginate(self, path, params, limit=100, max_items=2000):
        if self.fail:
            raise close_client.CrmUnavailable("http_503")
        return list(ACTS)


@pytest.fixture
def api(monkeypatch):
    import main

    fake = {"close": FakeClose()}
    monkeypatch.setattr(service, "_client_factory", lambda: fake["close"])
    monkeypatch.setattr(service, "_emails_fn", lambda key: {"wc:1": ["k@x.example"], "wc:2": ["other@x.example"]}.get(key))
    service.CACHE.drop("")
    service.CACHE._refresh.clear()
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    yield TestClient(main.app), fake
    main.app.dependency_overrides.clear()


def test_standard_user_is_forbidden(api):
    import main

    client, _ = api
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=2, role="standard")
    assert client.get("/crm/customers/wc:1").status_code == 403


def test_timeline_hides_automated_by_default_and_declares_every_key(api):
    client, _ = api
    body = client.get("/crm/customers/wc:1").json()
    assert body["configured"] is True and body["emails_tried"] == ["k@x.example"]
    assert [l["name"] for l in body["leads"]] == ["Valor"]
    assert [i["id"] for i in body["items"]] == ["acti_3", "acti_1"]
    assert body["counts"] == {"email": 1, "call": 0, "sms": 0, "meeting": 0, "note": 1, "automated": 1}
    assert set(body) == {"configured", "emails_tried", "leads", "items", "total", "page", "page_size", "counts",
                         "fetched_at", "stale", "refresh_throttled"}
    shown = client.get("/crm/customers/wc:1?include_automated=true&types=email").json()
    assert [i["id"] for i in shown["items"]] == ["acti_2", "acti_1"]


def test_unknown_customer_404_and_no_lead_is_empty(api, monkeypatch):
    client, _ = api
    assert client.get("/crm/customers/wc:999").status_code == 404
    monkeypatch.setattr(FakeClose, "get", lambda self, path, params=None: {"data": []})
    body = client.get("/crm/customers/wc:2").json()
    assert body["leads"] == [] and body["items"] == [] and body["emails_tried"] == ["other@x.example"]


def test_not_configured_is_503(api, monkeypatch):
    client, _ = api

    def boom():
        raise close_client.CrmNotConfigured()

    monkeypatch.setattr(service, "_client_factory", boom)
    r = client.get("/crm/customers/wc:1")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "crm_not_configured"


def test_failure_without_cache_is_502_and_with_cache_is_stale(api):
    client, fake = api
    fake["close"] = FakeClose(fail=True)
    r = client.get("/crm/customers/wc:1")
    assert r.status_code == 502 and r.json()["detail"]["code"] == "crm_unavailable"
    fake["close"] = FakeClose()
    assert client.get("/crm/customers/wc:1").json()["stale"] is False
    fake["close"] = FakeClose(fail=True)
    stale = client.get("/crm/customers/wc:1?refresh=true").json()
    assert stale["stale"] is True and [i["id"] for i in stale["items"]] == ["acti_3", "acti_1"]


def test_refresh_bypasses_cache_then_throttles(api):
    client, fake = api
    client.get("/crm/customers/wc:1")
    before = fake["close"].calls
    client.get("/crm/customers/wc:1")
    assert fake["close"].calls == before  # cached
    first = client.get("/crm/customers/wc:1?refresh=true").json()
    assert fake["close"].calls > before and first["refresh_throttled"] is False
    again = client.get("/crm/customers/wc:1?refresh=true").json()
    assert again["refresh_throttled"] is True


def test_detail_scoped_to_customer_leads(api):
    client, _ = api
    ok = client.get("/crm/customers/wc:1/activities/acti_1?type=email").json()
    assert ok["type"] == "email" and [m["body"] for m in ok["messages"]] == ["Where is it"]
    assert client.get("/crm/customers/wc:1/activities/acti_3?type=note").json()["note"] == "Call back Friday"
    LEAD_OTHER = dict(LEAD, id="lead_Z")
    import crm_close.service as svc
    svc.CACHE.drop("")
    orig = FakeClose.get

    def other_lead(self, path, params=None):
        return {"data": [LEAD_OTHER]} if path == "lead/" else orig(self, path, params)

    FakeClose.get = other_lead
    try:
        assert client.get("/crm/customers/wc:2/activities/acti_1?type=email").status_code == 404
    finally:
        FakeClose.get = orig
