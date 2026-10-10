"""Support ticket actions: scoping, validation, exact mutations, error mapping, duplicates, timeout confirm, audit."""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from models import SupportAction
from support_plain import client as plain_client
from support_plain import queries, service

NOW = lambda: datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731


def thread(tid):
    return {"id": tid, "ref": "T-1", "title": "t", "previewText": "p", "status": "TODO", "priority": 2,
            "isTestThread": False, "createdAt": {"iso8601": "2026-09-01T00:00:00.000Z"},
            "updatedAt": {"iso8601": "2026-09-03T00:00:00.000Z"}, "customer": {"id": "c_1", "fullName": "Kyle R"},
            "labels": [{"id": "l_1", "labelType": {"id": "lt_1", "name": "Lab"}}], "assignedTo": None,
            "lastInboundMessageInfo": None, "lastOutboundMessageInfo": None}


class Plain:
    def __init__(self):
        self.sent, self.mutate_error, self.read_fail, self.timeline = [], None, False, []

    def query(self, q, variables=None):
        if self.read_fail and q in (queries.THREADS, queries.THREAD):
            raise plain_client.SupportUnavailable("http_503")
        if q == queries.WORKSPACE:
            return {"myWorkspace": {"id": "w_1"}}
        if q == queries.CUSTOMER_BY_EMAIL:
            return {"customerByEmail": {"id": "c_1", "fullName": "Kyle R"}}
        if q == queries.THREADS:
            return {"threads": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                                "edges": [{"node": thread("th_b")}]}}
        if q == queries.THREAD:
            return {"thread": {**thread("th_b"), "timelineEntries": {
                "pageInfo": {"hasNextPage": False, "endCursor": None}, "edges": [{"node": n} for n in self.timeline]}}}
        if q == queries.USER_BY_EMAIL:
            ok = variables["email"] == "sam@accumark.example"
            return {"userByEmail": {"id": "u_1", "fullName": "Sam Parker", "publicName": "Sam",
                                    "email": "sam@accumark.example", "isDeleted": False} if ok else None}
        if q == queries.USERS:
            return {"users": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                              "edges": [{"node": {"id": "u_1", "fullName": "Sam Parker", "email": "s@x",
                                                  "isDeleted": False}}]}}
        if q == queries.LABEL_TYPES:
            return {"labelTypes": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                                   "edges": [{"node": {"id": "lt_2", "name": "Shipping", "color": None}}]}}
        raise AssertionError(q)

    def mutate(self, m, variables):
        self.sent.append((m, variables))
        if self.mutate_error:
            raise self.mutate_error
        return {"error": None}


@pytest.fixture
def api(monkeypatch):
    import main

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    plain = Plain()
    monkeypatch.setattr(service, "_client_factory", lambda: plain)
    monkeypatch.setattr(service, "_emails_fn", lambda key: {"wc:1": ["k@x.example"], "wc:2": ["o@x.example"]}.get(key))
    service.CACHE.drop("")
    service.CACHE._refresh.clear()
    main.app.dependency_overrides[get_db] = _db
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=3, role="standard",
                                                                        email="sam@accumark.example")
    yield TestClient(main.app), plain, Session
    main.app.dependency_overrides.clear()


def post(client, action, body, key="wc:1", th="th_b"):
    return client.post(f"/support/customers/{key}/threads/{th}/{action}", json=body)


def rows(Session):
    return Session().query(SupportAction).order_by(SupportAction.id).all()


def test_reply_impersonates_the_caller_and_audits(api):
    client, plain, Session = api
    r = post(client, "reply", {"markdown": "**Hi** there"})
    assert r.status_code == 200 and r.json()["detail"]["thread"]["id"] == "th_b"
    m, v = plain.sent[0]
    assert m == queries.REPLY
    assert v["input"]["threadId"] == "th_b" and v["input"]["markdownContent"] == "**Hi** there"
    assert v["input"]["textContent"] == "Hi there"
    assert v["input"]["impersonation"] == {"asUser": {"userIdentifier": {"userId": "u_1"}}}
    [row] = rows(Session)
    assert (row.action, row.outcome, row.mk1_user_id, row.plain_user_id, row.body_len) == ("reply", "ok", 3, "u_1", 12)


def test_only_reply_impersonates(api):
    client, plain, _ = api
    post(client, "note", {"markdown": "check COA"})
    post(client, "status", {"status": "done"})
    assert all("impersonation" not in v["input"] for _, v in plain.sent)
    assert plain.sent[0][1]["input"] == {"customerId": "c_1", "threadId": "th_b", "text": "Sam Parker: check COA",
                                         "markdown": "Sam Parker: check COA"}
    assert plain.sent[1] == (queries.MARK_DONE, {"input": {"threadId": "th_b"}})


def test_status_todo_snooze_and_range(api):
    client, plain, _ = api
    assert post(client, "status", {"status": "todo"}).status_code == 200
    until = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert post(client, "status", {"status": "snoozed", "until": until}).status_code == 200
    m, v = plain.sent[-1]
    assert m == queries.SNOOZE and 3500 <= v["input"]["durationSeconds"] <= 3600
    soon = (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()
    far = (datetime.now(timezone.utc) + timedelta(days=91)).isoformat()
    for u in (soon, far, None):
        r = post(client, "status", {"status": "snoozed", "until": u})
        assert r.status_code == 422, u


def test_assign_unassign_and_unknown_user(api):
    client, plain, _ = api
    post(client, "assign", {"plain_user_id": "u_1"})
    post(client, "assign", {"plain_user_id": None})
    assert [m for m, _ in plain.sent] == [queries.ASSIGN, queries.UNASSIGN]
    n = len(plain.sent)
    r = post(client, "assign", {"plain_user_id": "u_999"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_input" and len(plain.sent) == n


def test_priority_maps_to_int(api):
    client, plain, _ = api
    post(client, "priority", {"priority": "urgent"})
    assert plain.sent[-1] == (queries.PRIORITY, {"input": {"threadId": "th_b", "priority": 0}})


def test_labels_add_remove_and_validation(api):
    client, plain, _ = api
    assert post(client, "labels", {"add": ["lt_2"], "remove": ["l_1"]}).status_code == 200
    assert plain.sent == [(queries.ADD_LABELS, {"input": {"threadId": "th_b", "labelTypeIds": ["lt_2"]}}),
                          (queries.REMOVE_LABELS, {"input": {"labelIds": ["l_1"]}})]
    n = len(plain.sent)
    for body in ({"add": [], "remove": []}, {"add": ["lt_404"]}, {"remove": ["lt_1"]}):  # lt_1 is a type id
        assert post(client, "labels", body).status_code == 422, body
    assert len(plain.sent) == n


def test_body_limits(api):
    client, plain, _ = api
    assert post(client, "reply", {"markdown": "   "}).status_code == 422
    assert post(client, "reply", {"markdown": "x" * 10_001}).status_code == 422
    assert plain.sent == []


def test_foreign_thread_is_404_for_every_action(api):
    client, plain, _ = api
    for action, body in (("reply", {"markdown": "x"}), ("note", {"markdown": "x"}), ("status", {"status": "done"}),
                         ("assign", {"plain_user_id": None}), ("priority", {"priority": "low"}),
                         ("labels", {"add": ["lt_2"]})):
        r = post(client, action, body, th="th_zzz")
        assert r.status_code == 404 and r.json()["detail"]["code"] == "thread_not_found", action
    assert plain.sent == []


def test_no_seat_is_403(api):
    import main

    client, plain, _ = api
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin", email="boss@x.example")
    r = post(client, "reply", {"markdown": "hi"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "no_plain_seat" and plain.sent == []


def test_duplicate_reply_is_409_and_audited(api):
    client, plain, Session = api
    assert post(client, "reply", {"markdown": "hello"}).status_code == 200
    r = post(client, "reply", {"markdown": "hello"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "duplicate_reply" and len(plain.sent) == 1
    assert [x.outcome for x in rows(Session)] == ["ok", "duplicate"]


@pytest.mark.parametrize("code,status,out", [("cannot_reply_to_thread", 403, "not_allowed_to_reply"),
                                             ("missing_user_auth_slack_integration_for_team", 409,
                                              "slack_not_connected"),
                                             ("something_else", 502, "support_unavailable")])
def test_plain_error_codes_map(api, code, status, out):
    client, plain, Session = api
    plain.mutate_error = plain_client.PlainActionError(code, "FORBIDDEN", "m")
    r = post(client, "reply", {"markdown": "hi"})
    assert r.status_code == status and r.json()["detail"]["code"] == out
    assert rows(Session)[-1].outcome == "error" and rows(Session)[-1].error_code == code


def test_validation_type_maps_to_422(api):
    client, plain, _ = api
    plain.mutate_error = plain_client.PlainActionError("input_validation", "VALIDATION", "m")
    assert post(client, "reply", {"markdown": "hi"}).status_code == 422


def _mine(text, ago=timedelta(seconds=5)):
    at = (datetime.now(timezone.utc) - ago).isoformat().replace("+00:00", "Z")
    return {"id": "e9", "timestamp": {"iso8601": at}, "actor": {"__typename": "UserActor", "userId": "u_1",
                                                                "user": {"fullName": "Sam Parker"}},
            "entry": {"__typename": "EmailEntry", "subject": "s", "textContent": text + "\n\n> quoted history",
                      "hasMoreTextContent": False, "fullTextContent": None, "from": {"name": "Sam", "email": "s@x"}}}


def test_reply_timeout_confirmed_when_entry_present(api):
    client, plain, Session = api
    plain.mutate_error = plain_client.SupportWriteUnconfirmed("ReadTimeout")
    plain.timeline = [_mine("Thanks  for\nwaiting", ago=timedelta(0))]  # Plain stamps it during the send
    r = post(client, "reply", {"markdown": "Thanks for waiting"})
    assert r.status_code == 200 and len(plain.sent) == 1
    assert rows(Session)[-1].outcome == "confirmed_after_timeout"


def test_reply_timeout_unconfirmed_when_missing_old_or_someone_else(api):
    client, plain, Session = api
    plain.mutate_error = plain_client.SupportWriteUnconfirmed("ReadTimeout")
    other = _mine("Thanks for waiting")
    other["actor"]["userId"] = "u_2"
    plain.timeline = [_mine("Thanks for waiting", ago=timedelta(minutes=5)), other]
    r = post(client, "reply", {"markdown": "Thanks for waiting"})
    assert r.status_code == 504 and r.json()["detail"]["code"] == "reply_unconfirmed"
    assert rows(Session)[-1].outcome == "unconfirmed"


def test_non_reply_timeout_is_502(api):
    client, plain, Session = api
    plain.mutate_error = plain_client.SupportWriteUnconfirmed("ReadTimeout")
    r = post(client, "status", {"status": "done"})
    assert r.status_code == 502 and rows(Session)[-1].outcome == "unconfirmed"


def test_action_ok_but_refresh_fails_returns_null_detail(api):
    client, plain, Session = api
    client.get("/support/customers/wc:1/threads/th_b")  # warm the scoping list
    plain.read_fail = True
    r = post(client, "status", {"status": "done"})
    assert r.status_code == 200 and r.json() == {"detail": None}
    assert rows(Session)[-1].outcome == "ok"


def test_not_configured_is_503(api, monkeypatch):
    client, plain, _ = api
    plain.mutate_error = plain_client.SupportNotConfigured()
    r = post(client, "status", {"status": "done"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "support_not_configured"


def test_unconfirmed_reply_drops_the_cached_thread(api):
    client, plain, _ = api
    assert client.get("/support/customers/wc:1/threads/th_b").json()["entries"] == []
    plain.mutate_error = plain_client.SupportWriteUnconfirmed("ReadTimeout")
    assert post(client, "reply", {"markdown": "Thanks for waiting"}).status_code == 504
    plain.timeline = [_mine("Thanks for waiting", ago=timedelta(minutes=10))]  # Plain shows it a little later
    assert len(client.get("/support/customers/wc:1/threads/th_b").json()["entries"]) == 1


def test_in_flight_send_blocks_an_identical_one(api):
    client, plain, Session = api
    from support_plain import audit
    s = Session()
    audit.record(s, user_id=3, plain_user_id="u_1", customer_key="wc:1", thread_id="th_b", action="reply",
                 args={}, body="hello", outcome="pending")
    r = post(client, "reply", {"markdown": "hello"})
    assert r.status_code == 409 and plain.sent == []


def test_one_row_per_attempt_ends_with_the_final_outcome(api):
    client, plain, Session = api
    post(client, "reply", {"markdown": "hello"})
    assert [x.outcome for x in rows(Session)] == ["ok"]


def test_earlier_reply_with_the_same_opening_does_not_confirm(api):
    client, plain, Session = api
    plain.mutate_error = plain_client.SupportWriteUnconfirmed("ReadTimeout")
    plain.timeline = [_mine("Got it, checking the COA now", ago=timedelta(seconds=90))]
    r = post(client, "reply", {"markdown": "Got it"})
    assert r.status_code == 504 and rows(Session)[-1].outcome == "unconfirmed"


def test_markup_only_body_is_422(api):
    client, plain, _ = api
    assert post(client, "reply", {"markdown": "**"}).status_code == 422 and plain.sent == []
