"""/support/* routes: admin gate, shapes, filters, refresh, failures, detail scoping."""
from unittest.mock import MagicMock

import psycopg2
import pytest
from fastapi.testclient import TestClient

from auth import get_current_user
from support_plain import client as plain_client
from support_plain import queries, service


def thread(tid, status="TODO", updated="2026-09-02T10:00:00.000Z", inbound=None, outbound=None):
    return {"id": tid, "ref": "T-" + tid[3:], "title": "t " + tid, "previewText": "p", "status": status, "priority": 2,
            "isTestThread": False, "createdAt": {"iso8601": "2026-09-01T00:00:00.000Z"}, "updatedAt": {"iso8601": updated},
            "customer": {"id": "c_1", "fullName": "Kyle R"}, "labels": [], "assignedTo": None,
            "lastInboundMessageInfo": inbound and {"timestamp": {"iso8601": inbound}},
            "lastOutboundMessageInfo": outbound and {"timestamp": {"iso8601": outbound}}}


THREADS = [thread("th_a", "DONE", "2026-09-01T00:00:00.000Z"),
           thread("th_b", "TODO", "2026-09-03T00:00:00.000Z", inbound="2026-09-03T00:00:00.000Z"),
           thread("th_c", "SNOOZED", "2026-09-02T00:00:00.000Z")]
ENTRY = {"id": "e1", "timestamp": {"iso8601": "2026-09-03T00:00:00.000Z"},
         "actor": {"__typename": "CustomerActor", "customer": {"fullName": "Kyle R"}},
         "entry": {"__typename": "ChatEntry", "chatText": "hello"}}


class FakePlain:
    def __init__(self, fail=False):
        self.fail, self.ops = fail, []

    def query(self, q, variables=None):
        op = {queries.WORKSPACE: "ws", queries.CUSTOMER_BY_EMAIL: "cust", queries.THREADS: "threads",
              queries.THREAD: "thread"}[q]
        self.ops.append(op)
        if self.fail:
            raise plain_client.SupportUnavailable("http_503")
        if op == "ws":
            return {"myWorkspace": {"id": "w_1"}}
        if op == "cust":  # both test emails resolve to the same Plain customer
            return {"customerByEmail": {"id": "c_1", "fullName": "Kyle R"}}
        if op == "threads":
            assert variables["customerIds"] == ["c_1"]
            return {"threads": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                                "edges": [{"node": t} for t in THREADS + THREADS[:1]]}}
        t = next(x for x in THREADS if x["id"] == variables["threadId"])
        return {"thread": {**t, "timelineEntries": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                                                    "edges": [{"node": ENTRY}]}}}


@pytest.fixture
def api(monkeypatch):
    import main

    fake = {"plain": FakePlain()}
    monkeypatch.setattr(service, "_client_factory", lambda: fake["plain"])
    monkeypatch.setattr(service, "_emails_fn",
                        lambda key: {"wc:1": ["k@x.example", "k2@x.example"], "wc:2": [], "wc:3": ["o@x.example"]}.get(key))
    service.CACHE.drop("")
    service.CACHE._refresh.clear()
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    yield TestClient(main.app), fake
    main.app.dependency_overrides.clear()


def test_standard_user_is_forbidden_on_both_routes(api):
    import main

    client, _ = api
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=2, role="standard")
    assert client.get("/support/customers/wc:1").status_code == 403
    assert client.get("/support/customers/wc:1/threads/th_b").status_code == 403


def test_list_dedupes_sorts_counts_and_declares_every_key(api):
    client, _ = api
    body = client.get("/support/customers/wc:1").json()
    assert set(body) == {"customer_key", "matched", "threads", "total", "page", "page_size", "counts",
                         "last_contact_at", "oldest_waiting_since", "fetched_at", "stale", "refresh_throttled"}
    assert body["matched"] == 1
    assert [t["id"] for t in body["threads"]] == ["th_b", "th_c", "th_a"]
    assert body["counts"] == {"open": 1, "snoozed": 1, "done": 1, "waiting": 1}
    assert body["last_contact_at"] == "2026-09-03T00:00:00.000Z"
    assert body["oldest_waiting_since"] == "2026-09-03T00:00:00.000Z"
    assert set(body["threads"][0]) == {"id", "ref", "title", "status", "priority", "labels", "assignee", "created_at",
                                       "updated_at", "preview", "waiting_since", "plain_url",
                                       "assignee_id", "customer_plain_id", "label_refs"}


def test_list_declares_new_thread_keys(api):
    client, _ = api
    t = client.get("/support/customers/wc:1").json()["threads"][0]
    assert t["customer_plain_id"] == "c_1" and t["label_refs"] == [] and t["assignee_id"] is None


def test_status_filter_keeps_counts_whole(api):
    client, _ = api
    body = client.get("/support/customers/wc:1?status=done&status=snoozed").json()
    assert [t["id"] for t in body["threads"]] == ["th_c", "th_a"] and body["total"] == 2
    assert body["counts"]["open"] == 1


def test_unknown_customer_404_and_no_email_is_empty(api):
    client, fake = api
    assert client.get("/support/customers/wc:404").status_code == 404
    body = client.get("/support/customers/wc:2").json()
    assert body["threads"] == [] and body["matched"] == 0 and fake["plain"].ops == []


def test_detail_returns_thread_and_entries(api):
    client, _ = api
    body = client.get("/support/customers/wc:1/threads/th_b").json()
    assert set(body) == {"thread", "entries", "fetched_at", "stale"}
    assert body["thread"]["id"] == "th_b"
    assert body["entries"] == [{"id": "e1", "at": "2026-09-03T00:00:00.000Z", "kind": "chat", "author": "Kyle R",
                                "author_kind": "customer", "internal": False, "subject": None, "text": "hello"}]


def test_foreign_or_unknown_thread_is_404_without_a_thread_query(api, monkeypatch):
    client, fake = api
    monkeypatch.setattr(service, "_emails_fn", lambda key: {"wc:1": ["k@x.example"], "wc:3": ["o@x.example"]}.get(key))
    assert client.get("/support/customers/wc:1/threads/th_zzz").status_code == 404
    assert "thread" not in fake["plain"].ops


def test_malformed_thread_id_is_422(api):
    client, _ = api
    assert client.get("/support/customers/wc:1/threads/abc").status_code == 422


def test_refresh_is_throttled(api):
    client, _ = api
    assert client.get("/support/customers/wc:1?refresh=true").json()["refresh_throttled"] is False
    assert client.get("/support/customers/wc:1?refresh=true").json()["refresh_throttled"] is True


def test_failed_refresh_keeps_cached_list_and_conversation(api):
    client, fake = api
    client.get("/support/customers/wc:1")
    client.get("/support/customers/wc:1/threads/th_b")
    fake["plain"] = FakePlain(fail=True)
    assert client.get("/support/customers/wc:1?refresh=true").json()["stale"] is True
    later = client.get("/support/customers/wc:1")
    assert later.status_code == 200 and later.json()["stale"] is False
    detail = client.get("/support/customers/wc:1/threads/th_b")
    assert detail.status_code == 200 and detail.json()["stale"] is False


def test_plain_down_on_uncached_detail_is_502_and_cached_detail_is_stale(api):
    client, fake = api
    client.get("/support/customers/wc:1")
    client.get("/support/customers/wc:1/threads/th_c")
    fake["plain"] = FakePlain(fail=True)
    assert client.get("/support/customers/wc:1/threads/th_b").status_code == 502
    stale = client.get("/support/customers/wc:1/threads/th_c?refresh=true")
    assert stale.status_code == 200 and stale.json()["stale"] is True


def test_plain_down_with_nothing_cached_is_502(api):
    client, fake = api
    fake["plain"] = FakePlain(fail=True)
    r = client.get("/support/customers/wc:1")
    assert r.status_code == 502 and r.json()["detail"]["code"] == "support_unavailable"


def test_not_configured_is_503(api, monkeypatch):
    client, _ = api

    def boom():
        raise plain_client.SupportNotConfigured()

    monkeypatch.setattr(service, "_client_factory", boom)
    r = client.get("/support/customers/wc:1")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "support_not_configured"


def test_integration_db_error_is_502(api, monkeypatch):
    client, _ = api

    def db_down(key):
        raise psycopg2.OperationalError("down")

    monkeypatch.setattr(service, "_emails_fn", db_down)
    assert client.get("/support/customers/wc:1").status_code == 502


class ShapelessPlain(FakePlain):
    """Plain answers 200 with data that lacks the fields we read."""

    def query(self, q, variables=None):
        self.ops.append("shapeless")
        return {"customerByEmail": {"id": "c_1"}} if q == queries.CUSTOMER_BY_EMAIL else {}


def test_malformed_plain_data_falls_back_to_stale_not_500(api):
    client, fake = api
    client.get("/support/customers/wc:1")
    client.get("/support/customers/wc:1/threads/th_b")
    fake["plain"] = ShapelessPlain()
    listing = client.get("/support/customers/wc:1?refresh=true")
    assert listing.status_code == 200 and listing.json()["stale"] is True
    detail = client.get("/support/customers/wc:1/threads/th_b?refresh=true")
    assert detail.status_code == 200 and detail.json()["stale"] is True
    service.CACHE.drop("")
    assert client.get("/support/customers/wc:1").status_code == 502
