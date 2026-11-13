# Customer Support Tab (Plain) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-only Support tab on the Accu-Mk1 customer page that lists the customer's Plain tickets and shows any ticket's full conversation, including internal notes.

**Architecture:** New backend package `backend/support_plain/` laid out like `backend/crm_close/`: fixed read-only GraphQL queries, a thin client, pure normalization, a cached service and two admin routes. It reuses `crm_close.cache.TTLCache`, `crm_close.match.customer_emails` / `_EMAIL` and `crm_close.service._iso` by import. Frontend adds `CustomerSupportTab` + `SupportThreadPanel` next to the CRM components and reuses `crmFetch` / `CrmError` from `api-crm.ts`.

**Tech Stack:** FastAPI + pydantic v2, httpx (MockTransport in tests), pytest; React 19, TanStack Query, shadcn Sheet, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-08-customer-support-tab-design.md`

## Global Constraints

- Additive only: new package, new routes, new tab. No migration, no change to `crm_close` behaviour.
- Read-only toward Plain: only query strings from `support_plain/queries.py` are ever sent; the word `mutation` appears nowhere in `backend/support_plain/`.
- Admin-only: both routes `Depends(require_admin)`; tab rendered only when `user.role === 'admin'`.
- Every response key is declared on the route's pydantic `response_model` (undeclared keys are silently dropped).
- Bodies are plain text; never render HTML or markdown (`whitespace-pre-wrap`).
- Never log the Plain key, Authorization header, customer emails or message text.
- Accu-Mk1 frontend uses npm only.
- Commit with `git -c core.autocrlf=true commit ... -- <paths>` (this repo has `core.autocrlf=false` locally).
- No em dashes in code, copy or docs.
- Backend tests run from `backend/` with `python -m pytest`; run one backend suite at a time (the full suite shares the host dev Postgres).

## Review Focus

1. A customer whose account and billing emails resolve to the same Plain customer: threads must appear once (dedupe by customer id, then by thread id). Pinned in Task 3.
2. An email with `hasMoreTextContent: true` but `fullTextContent: null`: show `textContent`, never an empty body. Pinned in Task 1.
3. Plain down when a ticket is opened after the list is cached: a cached conversation is served stale, otherwise 502, never 500. Pinned in Task 4.
4. A thread id that belongs to another customer, or is unknown: 404 without any THREAD query reaching Plain. Pinned in Task 4.
5. Refresh while Plain is down: the cached list and cached conversations survive. Pinned in Task 4.

---

### Task 1: Rules and pure normalization

**Files:**
- Create: `backend/support_plain/__init__.py` (empty)
- Create: `backend/support_plain/rules.py`
- Create: `backend/support_plain/threads.py`
- Test: `backend/tests/test_support_plain_threads.py`

**Interfaces:**
- Produces: `rules.STATUS`, `rules.PRIORITY`, `rules.THREAD_ID_PATTERN`, TTL/limit constants; `threads.thread_item(raw: dict, workspace_id: str) -> dict`, `threads.build_threads(raw: list[dict], workspace_id: str) -> list[dict]`, `threads.build_entries(nodes: list[dict], customer_name: str | None) -> list[dict]`, `threads.plain_url(workspace_id, thread_id) -> str`.

- [ ] **Step 1: Write the failing test**

```python
"""support_plain.threads: pure normalization of Plain threads and timelines (spec 3.3, 3.4)."""
from support_plain import threads

WS = "w_1"


def raw_thread(**kw):
    t = {"id": "th_1", "ref": "T-1", "title": "COA late", "previewText": "  Where   is\nit  ", "status": "TODO",
         "priority": 2, "isTestThread": False, "createdAt": {"iso8601": "2026-09-01T10:00:00.000Z"},
         "updatedAt": {"iso8601": "2026-09-02T10:00:00.000Z"}, "customer": {"id": "c_1", "fullName": "Kyle R"},
         "labels": [{"labelType": {"name": "Lab"}}], "assignedTo": {"__typename": "User", "fullName": "Lauren"},
         "lastInboundMessageInfo": {"timestamp": {"iso8601": "2026-09-02T09:00:00.000Z"}},
         "lastOutboundMessageInfo": {"timestamp": {"iso8601": "2026-09-01T11:00:00.000Z"}}}
    t.update(kw)
    return t


def node(typename, actor=None, at="2026-09-01T10:00:00.000Z", nid="e1", **entry):
    return {"id": nid, "timestamp": {"iso8601": at}, "actor": actor or {"__typename": "SystemActor"},
            "entry": {"__typename": typename, **entry}}


CUST = {"__typename": "CustomerActor", "customer": {"fullName": "Kyle R"}}
AGENT = {"__typename": "UserActor", "user": {"fullName": "Lauren"}}
BOT = {"__typename": "MachineUserActor", "machineUser": {"fullName": "Website"}}


def test_thread_item_maps_fields():
    item = threads.thread_item(raw_thread(), WS)
    assert item == {"id": "th_1", "ref": "T-1", "title": "COA late", "status": "open", "priority": "normal",
                    "labels": ["Lab"], "assignee": "Lauren", "created_at": "2026-09-01T10:00:00.000Z",
                    "updated_at": "2026-09-02T10:00:00.000Z", "preview": "Where is it",
                    "waiting_since": "2026-09-02T09:00:00.000Z",
                    "plain_url": "https://app.plain.com/workspace/w_1/thread/th_1"}


def test_status_and_priority_maps():
    assert threads.thread_item(raw_thread(status="SNOOZED", priority=0), WS)["status"] == "snoozed"
    assert threads.thread_item(raw_thread(priority=0), WS)["priority"] == "urgent"
    assert threads.thread_item(raw_thread(priority=1), WS)["priority"] == "high"
    assert threads.thread_item(raw_thread(priority=3), WS)["priority"] == "low"
    assert threads.thread_item(raw_thread(priority=None, title=None), WS)["priority"] == "normal"


def test_waiting_since_cases():
    replied = {"timestamp": {"iso8601": "2026-09-03T00:00:00.000Z"}}
    assert threads.thread_item(raw_thread(lastOutboundMessageInfo=replied), WS)["waiting_since"] is None
    assert threads.thread_item(raw_thread(status="DONE"), WS)["waiting_since"] is None
    assert threads.thread_item(raw_thread(lastInboundMessageInfo=None), WS)["waiting_since"] is None
    assert threads.thread_item(raw_thread(lastOutboundMessageInfo=None), WS)["waiting_since"] == "2026-09-02T09:00:00.000Z"


def test_unassigned_and_untitled():
    item = threads.thread_item(raw_thread(assignedTo=None, title=None, labels=None), WS)
    assert item["assignee"] is None and item["title"] == "(no subject)" and item["labels"] == []


def test_build_threads_drops_test_threads_and_sorts_newest_first():
    old = raw_thread(id="th_old", updatedAt={"iso8601": "2026-08-01T00:00:00.000Z"})
    test = raw_thread(id="th_test", isTestThread=True)
    out = threads.build_threads([old, raw_thread(), test], WS)
    assert [t["id"] for t in out] == ["th_1", "th_old"]


def test_email_uses_full_text_when_truncated_and_falls_back():
    full = node("EmailEntry", CUST, subject="Hi", textContent="short", hasMoreTextContent=True,
                fullTextContent="short and the rest", **{"from": {"name": "Kyle R", "email": "k@x.example"}})
    missing = node("EmailEntry", CUST, nid="e2", subject="Hi", textContent="short", hasMoreTextContent=True,
                   fullTextContent=None, **{"from": {"name": None, "email": "k@x.example"}})
    out = threads.build_entries([full, missing], "Kyle R")
    assert out[0] == {"id": "e1", "at": "2026-09-01T10:00:00.000Z", "kind": "email", "author": "Kyle R",
                      "author_kind": "customer", "internal": False, "subject": "Hi", "text": "short and the rest"}
    assert out[1]["text"] == "short"


def test_internal_notes_and_discussions_are_flagged():
    out = threads.build_entries([
        node("NoteEntry", AGENT, nid="n", noteText="Retest promised"),
        node("ThreadDiscussionMessageEntry", {"__typename": "SystemActor"}, nid="d", at="2026-09-01T11:00:00.000Z",
             discussionText="Slack: checking with lab"),
        node("ChatEntry", CUST, nid="c", at="2026-09-01T12:00:00.000Z", chatText="hello"),
        node("SlackReplyEntry", AGENT, nid="s", at="2026-09-01T13:00:00.000Z", slackReplyText="on it"),
    ], "Kyle R")
    assert [(e["kind"], e["internal"], e["author_kind"], e["text"]) for e in out] == [
        ("note", True, "agent", "Retest promised"), ("discussion", True, "system", "Slack: checking with lab"),
        ("chat", False, "customer", "hello"), ("slack", False, "agent", "on it")]


def test_contact_form_is_the_customers_message():
    form = node("CustomEntry", BOT, title="Contact form submission",
                components=[{"__typename": "ComponentText", "text": "Need a quote"}, {"__typename": "ComponentDivider"}])
    (e,) = threads.build_entries([form], "Kyle R")
    assert (e["kind"], e["author"], e["author_kind"], e["subject"], e["text"]) == (
        "form", "Kyle R", "customer", "Contact form submission", "Need a quote")


def test_event_one_liners():
    out = threads.build_entries([
        node("ThreadStatusTransitionedEntry", AGENT, nid="1", nextStatus="DONE"),
        node("ThreadLabelsChangedEntry", BOT, nid="2", nextLabels=[{"labelType": {"name": "Lab"}}]),
        node("ThreadAssignmentTransitionedEntry", AGENT, nid="3", nextAssignee={"__typename": "User", "fullName": "Scott"}),
        node("ThreadAssignmentTransitionedEntry", AGENT, nid="4", nextAssignee=None),
        node("ThreadPriorityChangedEntry", {"__typename": "SystemActor"}, nid="5", nextPriority=0),
    ], "Kyle R")
    assert [e["text"] for e in out] == ["Marked done by Lauren", "Labels: Lab by Website", "Assigned to Scott by Lauren",
                                         "Unassigned by Lauren", "Priority set to urgent"]
    assert {e["kind"] for e in out} == {"event"}


def test_unknown_types_are_dropped_and_order_is_oldest_first(caplog):
    caplog.set_level("INFO")
    out = threads.build_entries([
        node("ChatEntry", CUST, nid="late", at="2026-09-02T00:00:00.000Z", chatText="b"),
        node("ServiceLevelAgreementStatusTransitionedEntry", nid="sla"),
        node("ChatEntry", CUST, nid="early", at="2026-09-01T00:00:00.000Z", chatText="a"),
    ], "Kyle R")
    assert [e["id"] for e in out] == ["early", "late"]
    assert "ServiceLevelAgreementStatusTransitionedEntry" in caplog.text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_support_plain_threads.py -q`
Expected: FAIL / ERROR with `ModuleNotFoundError: No module named 'support_plain'`

- [ ] **Step 3: Write minimal implementation**

`backend/support_plain/__init__.py`: empty file.

`backend/support_plain/rules.py`:

```python
"""Constants for the Support (Plain) tab (spec 3.2-3.5)."""
MATCH_TTL = 3600
LIST_TTL = 300
THREAD_TTL = 300
REFRESH_COOLDOWN = 10
PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
PREVIEW_CHARS = 160
MAX_THREADS = 500
MAX_ENTRIES = 1000
STATUS = {"TODO": "open", "SNOOZED": "snoozed", "DONE": "done"}
PRIORITY = {0: "urgent", 1: "high", 2: "normal", 3: "low"}
THREAD_ID_PATTERN = r"^th_[A-Za-z0-9]+$"
```

`backend/support_plain/threads.py`:

```python
"""Pure normalization of Plain threads and timeline entries (spec 3.3, 3.4). No I/O."""
from __future__ import annotations

import logging
from typing import Any

from support_plain import rules

logger = logging.getLogger(__name__)
_logged_unknown: set[str] = set()

# Entry types whose `text` is aliased per type in queries.THREAD (same name, different nullability).
_TEXT = {"ChatEntry": ("chat", "chatText", False), "NoteEntry": ("note", "noteText", True),
         "SlackMessageEntry": ("slack", "slackText", False), "SlackReplyEntry": ("slack", "slackReplyText", False),
         "ThreadDiscussionMessageEntry": ("discussion", "discussionText", True)}
_EVENTS = {"ThreadStatusTransitionedEntry", "ThreadLabelsChangedEntry", "ThreadAssignmentTransitionedEntry",
           "ThreadPriorityChangedEntry"}


def _iso(dt: dict | None) -> str | None:
    return (dt or {}).get("iso8601")


def _name(obj: dict | None) -> str | None:
    return (obj or {}).get("fullName") or None


def _labels(labels) -> list[str]:
    return [l["labelType"]["name"] for l in labels or [] if (l.get("labelType") or {}).get("name")]


def plain_url(workspace_id: str, thread_id: str) -> str:
    return f"https://app.plain.com/workspace/{workspace_id}/thread/{thread_id}"


def _waiting_since(t: dict, status: str) -> str | None:
    if status == "done":
        return None
    inbound = _iso((t.get("lastInboundMessageInfo") or {}).get("timestamp"))
    outbound = _iso((t.get("lastOutboundMessageInfo") or {}).get("timestamp"))
    if not inbound or (outbound and outbound >= inbound):
        return None
    return inbound


def thread_item(t: dict, workspace_id: str) -> dict[str, Any]:
    status = rules.STATUS.get(t.get("status"), "open")
    preview = " ".join((t.get("previewText") or "").split())
    return {"id": t["id"], "ref": t.get("ref") or "", "title": t.get("title") or "(no subject)", "status": status,
            "priority": rules.PRIORITY.get(t.get("priority"), "normal"), "labels": _labels(t.get("labels")),
            "assignee": _name(t.get("assignedTo")), "created_at": _iso(t.get("createdAt")),
            "updated_at": _iso(t.get("updatedAt")), "preview": preview[:rules.PREVIEW_CHARS],
            "waiting_since": _waiting_since(t, status), "plain_url": plain_url(workspace_id, t["id"])}


def build_threads(raw: list[dict], workspace_id: str) -> list[dict[str, Any]]:
    items = [thread_item(t, workspace_id) for t in raw if not t.get("isTestThread")]
    return sorted(items, key=lambda i: i["updated_at"] or "", reverse=True)


def _actor(a: dict | None) -> tuple[str | None, str]:
    kind = (a or {}).get("__typename")
    if kind == "CustomerActor":
        return _name(a.get("customer")), "customer"
    if kind == "UserActor":
        return _name(a.get("user")), "agent"
    if kind == "MachineUserActor":
        return _name(a.get("machineUser")), "agent"
    return None, "system"


def _event_text(typ: str, e: dict, who: str | None) -> str:
    by = f" by {who}" if who else ""
    if typ == "ThreadStatusTransitionedEntry":
        return f"Marked {rules.STATUS.get(e.get('nextStatus'), 'open')}{by}"
    if typ == "ThreadLabelsChangedEntry":
        names = _labels(e.get("nextLabels"))
        return f"Labels: {', '.join(names) if names else 'none'}{by}"
    if typ == "ThreadAssignmentTransitionedEntry":
        to = _name(e.get("nextAssignee"))
        return (f"Assigned to {to}" if to else "Unassigned") + by
    return f"Priority set to {rules.PRIORITY.get(e.get('nextPriority'), 'normal')}{by}"


def _entry(node: dict, customer_name: str | None) -> dict[str, Any] | None:
    e = node.get("entry") or {}
    typ = e.get("__typename")
    who, kind = _actor(node.get("actor"))
    base = {"id": node["id"], "at": _iso(node.get("timestamp")), "author": who, "author_kind": kind,
            "internal": False, "subject": None}
    if typ == "EmailEntry":
        text = e.get("fullTextContent") if e.get("hasMoreTextContent") and e.get("fullTextContent") else e.get("textContent")
        frm = e.get("from") or {}
        return {**base, "kind": "email", "author": who or frm.get("name") or frm.get("email"),
                "subject": e.get("subject"), "text": text or ""}
    if typ == "CustomEntry":  # website contact form, posted by our machine user on the customer's behalf
        text = "\n".join(c["text"] for c in e.get("components") or [] if c.get("text"))
        return {**base, "kind": "form", "author": customer_name, "author_kind": "customer",
                "subject": e.get("title"), "text": text}
    if typ in _TEXT:
        kind_name, field, internal = _TEXT[typ]
        return {**base, "kind": kind_name, "internal": internal, "text": e.get(field) or ""}
    if typ in _EVENTS:
        return {**base, "kind": "event", "text": _event_text(typ, e, who)}
    if typ and typ not in _logged_unknown:
        _logged_unknown.add(typ)
        logger.info("support_plain.entry_dropped type=%s", typ)
    return None


def build_entries(nodes: list[dict], customer_name: str | None) -> list[dict[str, Any]]:
    out = [x for x in (_entry(n, customer_name) for n in nodes) if x]
    return sorted(out, key=lambda x: x["at"] or "")
```

Note: `_logged_unknown` makes the drop log fire once per type per process; the test asserts the first occurrence, so it must not be pre-populated by another test (only this test uses `ServiceLevelAgreementStatusTransitionedEntry`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_support_plain_threads.py -q`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add backend/support_plain backend/tests/test_support_plain_threads.py
git -c core.autocrlf=true commit -m "feat(support): Plain thread and timeline normalization (pure)" -- backend/support_plain backend/tests/test_support_plain_threads.py
```

---

### Task 2: Fixed queries and the read-only client

**Files:**
- Create: `backend/support_plain/queries.py`
- Create: `backend/support_plain/client.py`
- Test: `backend/tests/test_support_plain_client.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `queries.WORKSPACE`, `queries.CUSTOMER_BY_EMAIL`, `queries.THREADS`, `queries.THREAD` (strings); `client.PlainClient(api_key, transport=None, sleep=time.sleep)` with `.query(query: str, variables: dict | None = None) -> dict` (the GraphQL `data` object); `client.get_client() -> PlainClient`; exceptions `client.SupportNotConfigured`, `client.SupportUnavailable`; `client.API_URL`.

- [ ] **Step 1: Write the failing test**

```python
"""support_plain.client: fixed queries only, GraphQL errors are failures, retry once."""
import json
import pathlib

import httpx
import pytest

from support_plain import client as c
from support_plain import queries


def _client(handler, sleeps=None):
    return c.PlainClient(api_key="k", transport=httpx.MockTransport(handler),
                         sleep=(sleeps.append if sleeps is not None else (lambda s: None)))


def test_posts_query_with_bearer_and_returns_data():
    seen = {}

    def handler(req):
        seen["auth"] = req.headers["authorization"]
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"data": {"myWorkspace": {"id": "w_1"}}})

    assert _client(handler).query(queries.WORKSPACE) == {"myWorkspace": {"id": "w_1"}}
    assert seen["auth"] == "Bearer k" and seen["url"] == c.API_URL
    assert seen["body"] == {"query": queries.WORKSPACE, "variables": {}}


def test_refuses_any_query_not_in_queries_module():
    with pytest.raises(ValueError):
        _client(lambda req: httpx.Response(200, json={"data": {}})).query("query { me { id } }")


def test_no_mutation_text_anywhere_in_the_package():
    pkg = pathlib.Path(c.__file__).parent
    for f in pkg.glob("*.py"):
        assert "mutation" not in f.read_text(encoding="utf-8").lower(), f.name


def test_graphql_errors_in_a_200_are_unavailable():
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(200, json={"errors": [{"message": "x"}], "data": None})).query(queries.WORKSPACE)


def test_retries_once_on_429_honouring_retry_after_capped():
    calls, sleeps = [], []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "30"})
        return httpx.Response(200, json={"data": {"myWorkspace": {"id": "w"}}})

    _client(handler, sleeps).query(queries.WORKSPACE)
    assert len(calls) == 2 and sleeps == [5]


def test_second_5xx_and_401_raise_unavailable():
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(503)).query(queries.WORKSPACE)
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(401, json={"message": "no"})).query(queries.WORKSPACE)


def test_network_error_twice_raises_unavailable():
    def handler(req):
        raise httpx.ConnectError("down")

    with pytest.raises(c.SupportUnavailable):
        _client(handler).query(queries.WORKSPACE)


def test_get_client_requires_key_and_reuses_one_client_per_key(monkeypatch):
    monkeypatch.delenv("PLAIN_API_KEY", raising=False)
    with pytest.raises(c.SupportNotConfigured):
        c.get_client()
    monkeypatch.setenv("PLAIN_API_KEY", "k1")
    a = c.get_client()
    assert c.get_client() is a
    monkeypatch.setenv("PLAIN_API_KEY", "k2")
    assert c.get_client() is not a
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_support_plain_client.py -q`
Expected: ERROR with `ImportError: cannot import name 'client' from 'support_plain'`

- [ ] **Step 3: Write minimal implementation**

`backend/support_plain/queries.py` (these exact strings were run against Plain read-only on 2026-10-08):

```python
"""Fixed, read-only Plain GraphQL queries (spec 3.2). The client sends nothing else."""

WORKSPACE = "query Workspace { myWorkspace { id } }"

CUSTOMER_BY_EMAIL = """query CustomerByEmail($email: String!) {
  customerByEmail(email: $email) { id fullName }
}"""

_THREAD_FIELDS = """id ref title previewText status priority isTestThread
      createdAt { iso8601 }
      updatedAt { iso8601 }
      customer { id fullName }
      labels { labelType { name } }
      assignedTo { __typename ... on User { fullName } ... on MachineUser { fullName } }
      lastInboundMessageInfo { timestamp { iso8601 } }
      lastOutboundMessageInfo { timestamp { iso8601 } }"""

THREADS = """query CustomerThreads($customerIds: [ID!]!, $after: String) {
  threads(first: 50, after: $after, filters: {customerIds: $customerIds, isMarkedAsSpam: false}) {
    pageInfo { hasNextPage endCursor }
    edges { node { %s } }
  }
}""" % _THREAD_FIELDS

_ACTOR = """__typename
        ... on UserActor { user { fullName } }
        ... on CustomerActor { customer { fullName } }
        ... on MachineUserActor { machineUser { fullName } }"""

# `text` is aliased per entry type: Plain declares it String on some and String! on others,
# which GraphQL rejects as a field conflict in one selection.
THREAD = """query Thread($threadId: ID!, $after: String) {
  thread(threadId: $threadId) {
    %s
    timelineEntries(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        timestamp { iso8601 }
        actor { %s }
        entry {
          __typename
          ... on EmailEntry { subject textContent hasMoreTextContent fullTextContent from { name email } }
          ... on ChatEntry { chatText: text }
          ... on NoteEntry { noteText: text }
          ... on SlackMessageEntry { slackText: text }
          ... on SlackReplyEntry { slackReplyText: text }
          ... on ThreadDiscussionMessageEntry { discussionText: text }
          ... on CustomEntry { title components { __typename ... on ComponentText { text } } }
          ... on ThreadStatusTransitionedEntry { nextStatus }
          ... on ThreadLabelsChangedEntry { nextLabels { labelType { name } } }
          ... on ThreadAssignmentTransitionedEntry { nextAssignee { __typename ... on User { fullName } ... on MachineUser { fullName } } }
          ... on ThreadPriorityChangedEntry { nextPriority }
        }
      } }
    }
  }
}""" % (_THREAD_FIELDS, _ACTOR)

ALL = frozenset({WORKSPACE, CUSTOMER_BY_EMAIL, THREADS, THREAD})
```

Note: the `CustomEntry` fragment adds a second `text` (inside `ComponentText`), which is a different parent type and does not conflict. Task 6's live smoke re-runs THREAD against Plain and will catch any rejection.

`backend/support_plain/client.py`:

```python
"""Thin Plain GraphQL client. Sends only the fixed queries in queries.py (the key itself can write)."""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Callable

import httpx

from support_plain import queries

API_URL = "https://core-api.uk.plain.com/graphql/v1"
logger = logging.getLogger(__name__)


class SupportNotConfigured(Exception):
    """PLAIN_API_KEY is not set."""


class SupportUnavailable(Exception):
    """Plain failed after one retry (429/5xx/timeout/network), refused the key, or returned GraphQL errors."""


class PlainClient:
    def __init__(self, api_key: str | None = None, transport: httpx.BaseTransport | None = None,
                 sleep: Callable[[float], Any] = time.sleep) -> None:
        self._http = httpx.Client(timeout=10.0, transport=transport,
                                  headers={"Authorization": f"Bearer {api_key or ''}"})
        self._sleep = sleep

    def query(self, query: str, variables: dict | None = None) -> dict:
        if query not in queries.ALL:
            raise ValueError("unknown query")
        op = query.split()[1].split("(")[0]  # operation name, for logs only
        for attempt in (1, 2):
            try:
                r = self._http.post(API_URL, json={"query": query, "variables": variables or {}})
            except httpx.HTTPError as e:
                logger.warning("support_plain.request_failed op=%s attempt=%s error=%s", op, attempt, type(e).__name__)
                if attempt == 2:
                    raise SupportUnavailable(type(e).__name__) from e
                continue
            if r.status_code == 429 or r.status_code >= 500:
                logger.warning("support_plain.http_%s op=%s attempt=%s", r.status_code, op, attempt)
                if attempt == 2:
                    raise SupportUnavailable(f"http_{r.status_code}")
                if r.status_code == 429:
                    try:
                        wait = float(r.headers.get("Retry-After", "1"))
                    except ValueError:
                        wait = 1.0
                    self._sleep(min(wait, 5))
                continue
            if r.status_code >= 400:
                logger.warning("support_plain.http_%s op=%s", r.status_code, op)
                raise SupportUnavailable(f"http_{r.status_code}")
            body = r.json()
            if body.get("errors"):
                logger.warning("support_plain.graphql_errors op=%s count=%d", op, len(body["errors"]))
                raise SupportUnavailable("graphql_errors")
            return body.get("data") or {}
        raise SupportUnavailable("unreachable")


_shared: dict[str, PlainClient] = {}


def get_client() -> PlainClient:
    """One pooled client per key for the life of the process."""
    key = (os.environ.get("PLAIN_API_KEY") or "").strip()
    if not key:
        raise SupportNotConfigured()
    if key not in _shared:
        _shared.clear()
        _shared[key] = PlainClient(api_key=key)
    return _shared[key]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_support_plain_client.py -q`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add backend/support_plain/queries.py backend/support_plain/client.py backend/tests/test_support_plain_client.py
git -c core.autocrlf=true commit -m "feat(support): fixed read-only Plain queries and client" -- backend/support_plain/queries.py backend/support_plain/client.py backend/tests/test_support_plain_client.py
```

---

### Task 3: Customer matching

**Files:**
- Create: `backend/support_plain/match.py`
- Test: `backend/tests/test_support_plain_match.py`

**Interfaces:**
- Consumes: `queries.CUSTOMER_BY_EMAIL`; a client object with `.query(query, variables) -> dict`; `crm_close.match._EMAIL`.
- Produces: `match.find_customers(emails: list[str], client) -> list[dict]` (each `{"id", "fullName"}`, de-duplicated by id, input order kept).

- [ ] **Step 1: Write the failing test**

```python
"""support_plain.match: customer emails -> Plain customers."""
from support_plain import match, queries


class FakePlain:
    def __init__(self, by_email):
        self.by_email, self.calls = by_email, []

    def query(self, q, variables=None):
        assert q == queries.CUSTOMER_BY_EMAIL
        self.calls.append(variables["email"])
        return {"customerByEmail": self.by_email.get(variables["email"])}


def test_each_email_is_looked_up_and_customers_deduped():
    kyle = {"id": "c_1", "fullName": "Kyle R"}
    plain = FakePlain({"a@x.example": kyle, "b@x.example": kyle, "c@x.example": {"id": "c_2", "fullName": "Bo"}})
    out = match.find_customers(["a@x.example", "b@x.example", "c@x.example", "none@x.example"], plain)
    assert [c["id"] for c in out] == ["c_1", "c_2"]
    assert plain.calls == ["a@x.example", "b@x.example", "c@x.example", "none@x.example"]


def test_unsafe_emails_are_skipped():
    plain = FakePlain({})
    assert match.find_customers(['x"@y.com', "not-an-email", "ok@y.com"], plain) == []
    assert plain.calls == ["ok@y.com"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_support_plain_match.py -q`
Expected: ERROR with `ImportError: cannot import name 'match' from 'support_plain'`

- [ ] **Step 3: Write minimal implementation**

`backend/support_plain/match.py`:

```python
"""Customer emails (from crm_close.match.customer_emails) -> Plain customers."""
from __future__ import annotations

from typing import Any

from crm_close.match import _EMAIL
from support_plain import queries


def find_customers(emails: list[str], client) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for e in emails:
        if not _EMAIL.match(e):
            continue
        found = client.query(queries.CUSTOMER_BY_EMAIL, {"email": e}).get("customerByEmail")
        if found and found.get("id"):
            seen.setdefault(found["id"], found)
    return list(seen.values())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_support_plain_match.py -q`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add backend/support_plain/match.py backend/tests/test_support_plain_match.py
git -c core.autocrlf=true commit -m "feat(support): match customer emails to Plain customers" -- backend/support_plain/match.py backend/tests/test_support_plain_match.py
```

---

### Task 4: Service and admin routes

**Files:**
- Create: `backend/support_plain/service.py`
- Create: `backend/support_plain/routes.py`
- Modify: `backend/main.py` (import after the `crm_close_router` import at line 128; `app.include_router` after line 640)
- Modify: `backend/.env.example` (append after the `CLOSE_API_KEY=` block)
- Test: `backend/tests/test_support_plain_routes.py`

**Interfaces:**
- Consumes: Tasks 1-3; `crm_close.cache.TTLCache` (`get_or_load`, `put`, `peek`, `drop`, `allow_refresh`, `_refresh`); `crm_close.match.customer_emails(key) -> list[str] | None`; `crm_close.service._iso(monotonic_at) -> str`; `auth.require_admin`.
- Produces: `GET /support/customers/{customer_key}` (response `CustomerSupport`), `GET /support/customers/{customer_key}/threads/{thread_id}` (response `ThreadDetail`); `service.customer_support(key, *, refresh, statuses, page, page_size) -> dict | None`; `service.thread_detail(key, thread_id, *, refresh) -> dict | None`; test seams `service._client_factory`, `service._emails_fn`, `service.CACHE`.

- [ ] **Step 1: Write the failing test**

```python
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
                                       "updated_at", "preview", "waiting_since", "plain_url"}


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_support_plain_routes.py -q`
Expected: ERROR with `ImportError: cannot import name 'service' from 'support_plain'`

- [ ] **Step 3: Write minimal implementation**

`backend/support_plain/service.py`:

```python
"""Orchestration: customer match, thread list and conversations (all cached), refresh, stale fallback, scoping."""
from __future__ import annotations

import logging
import time
from typing import Any

import psycopg2

from crm_close import match as crm_match
from crm_close.cache import TTLCache
from crm_close.service import _iso
from support_plain import match, queries, rules, threads
from support_plain.client import SupportUnavailable, get_client

logger = logging.getLogger(__name__)
CACHE = TTLCache()
_client_factory = get_client
_emails_fn = crm_match.customer_emails


def _emails(customer_key: str) -> list[str] | None:
    try:
        return _emails_fn(customer_key)
    except psycopg2.Error as e:
        logger.warning("support_plain.is_db_error error=%s", type(e).__name__)
        raise SupportUnavailable("is_db") from e


def _workspace(client) -> str:
    ws, _ = CACHE.get_or_load("ws", float("inf"), lambda: client.query(queries.WORKSPACE)["myWorkspace"]["id"])
    return ws


def _load(customer_key: str, emails: list[str], *, fresh: bool = False) -> dict[str, Any]:
    client = _client_factory()
    mkey = f"m:{customer_key}"
    if fresh:  # refresh: re-match, and replace the cached match only once Plain answered
        customers = match.find_customers(emails, client)
        CACHE.put(mkey, customers)
    else:
        customers, _ = CACHE.get_or_load(mkey, rules.MATCH_TTL, lambda: match.find_customers(emails, client))
    raw: list[dict] = []
    if customers:
        ws = _workspace(client)
        after = None
        while len(raw) < rules.MAX_THREADS:
            page = client.query(queries.THREADS, {"customerIds": [c["id"] for c in customers], "after": after})["threads"]
            raw.extend(e["node"] for e in page["edges"])
            if not page["pageInfo"]["hasNextPage"]:
                break
            after = page["pageInfo"]["endCursor"]
        unique = list({t["id"]: t for t in raw[:rules.MAX_THREADS]}.values())
        return {"matched": len(customers), "threads": threads.build_threads(unique, ws)}
    return {"matched": 0, "threads": []}


def customer_support(customer_key: str, *, refresh: bool, statuses: list[str], page: int,
                     page_size: int) -> dict[str, Any] | None:
    emails = _emails(customer_key)
    if emails is None:
        return None
    key = f"l:{customer_key}"
    do_refresh = bool(refresh) and CACHE.allow_refresh(customer_key, rules.REFRESH_COOLDOWN)
    throttled = bool(refresh) and not do_refresh
    stale = False
    try:
        if not emails:
            data, at = {"matched": 0, "threads": []}, time.monotonic()
        elif do_refresh:
            # Load first; cached copies are replaced only on success (spec 3.5).
            data = _load(customer_key, emails, fresh=True)
            at = CACHE.put(key, data)
            CACHE.drop(f"d:{customer_key}:")
        else:
            data, at = CACHE.get_or_load(key, rules.LIST_TTL, lambda: _load(customer_key, emails))
    except SupportUnavailable:
        fallback = CACHE.peek(key)
        if fallback is None:
            raise
        data, at = fallback
        stale = True
    every = data["threads"]
    counts = {s: sum(1 for t in every if t["status"] == s) for s in ("open", "snoozed", "done")}
    counts["waiting"] = sum(1 for t in every if t["waiting_since"])
    waiting = sorted(t["waiting_since"] for t in every if t["waiting_since"])
    shown = [t for t in every if not statuses or t["status"] in statuses]
    logger.info("support_plain.customer key_kind=%s matched=%d threads=%d stale=%s",
                customer_key.split(":")[0], data["matched"], len(every), stale)
    start = (page - 1) * page_size
    return {"customer_key": customer_key, "matched": data["matched"], "threads": shown[start:start + page_size],
            "total": len(shown), "page": page, "page_size": page_size, "counts": counts,
            "last_contact_at": every[0]["updated_at"] if every else None,
            "oldest_waiting_since": waiting[0] if waiting else None,
            "fetched_at": _iso(at), "stale": stale, "refresh_throttled": throttled}


def thread_detail(customer_key: str, thread_id: str, *, refresh: bool = False) -> dict[str, Any] | None:
    listing = customer_support(customer_key, refresh=False, statuses=[], page=1, page_size=rules.MAX_THREADS)
    if listing is None or not any(t["id"] == thread_id for t in listing["threads"]):
        return None  # unknown or another customer's thread never reaches Plain
    key = f"d:{customer_key}:{thread_id}"

    def load() -> dict[str, Any]:
        client = _client_factory()
        nodes: list[dict] = []
        after = None
        while len(nodes) < rules.MAX_ENTRIES:
            t = client.query(queries.THREAD, {"threadId": thread_id, "after": after})["thread"]
            if t is None:
                raise SupportUnavailable("thread_missing")
            conn = t["timelineEntries"]
            nodes.extend(e["node"] for e in conn["edges"])
            if not conn["pageInfo"]["hasNextPage"]:
                break
            after = conn["pageInfo"]["endCursor"]
        return {"thread": threads.thread_item(t, _workspace(client)),
                "entries": threads.build_entries(nodes[:rules.MAX_ENTRIES], (t.get("customer") or {}).get("fullName"))}

    stale = False
    try:
        if refresh and CACHE.allow_refresh(key, rules.REFRESH_COOLDOWN):
            data = load()
            at = CACHE.put(key, data)
        else:
            data, at = CACHE.get_or_load(key, rules.THREAD_TTL, load)
    except SupportUnavailable:
        fallback = CACHE.peek(key)
        if fallback is None:
            raise
        data, at = fallback
        stale = True
    return {**data, "fetched_at": _iso(at), "stale": stale}
```

`backend/support_plain/routes.py`:

```python
"""/support/* API (spec section 4). Admin-only."""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel

from auth import require_admin
from support_plain import rules, service
from support_plain.client import SupportNotConfigured, SupportUnavailable

router = APIRouter(prefix="/support", tags=["support"])
Status = Literal["open", "snoozed", "done"]


class Thread(BaseModel):
    id: str
    ref: str
    title: str
    status: Status
    priority: Literal["urgent", "high", "normal", "low"]
    labels: list[str]
    assignee: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    preview: str
    waiting_since: Optional[str] = None
    plain_url: str


class Counts(BaseModel):
    open: int
    snoozed: int
    done: int
    waiting: int


class CustomerSupport(BaseModel):
    customer_key: str
    matched: int
    threads: list[Thread]
    total: int
    page: int
    page_size: int
    counts: Counts
    last_contact_at: Optional[str] = None
    oldest_waiting_since: Optional[str] = None
    fetched_at: str
    stale: bool
    refresh_throttled: bool


class Entry(BaseModel):
    id: str
    at: Optional[str] = None
    kind: Literal["email", "chat", "slack", "note", "discussion", "form", "event"]
    author: Optional[str] = None
    author_kind: Literal["customer", "agent", "system"]
    internal: bool
    subject: Optional[str] = None
    text: str


class ThreadDetail(BaseModel):
    thread: Thread
    entries: list[Entry]
    fetched_at: str
    stale: bool


def _fail(e: Exception):
    if isinstance(e, SupportNotConfigured):
        raise HTTPException(status_code=503, detail={"code": "support_not_configured"})
    raise HTTPException(status_code=502, detail={"code": "support_unavailable"})


@router.get("/customers/{customer_key}", response_model=CustomerSupport)
def customer_support(customer_key: str, refresh: bool = False, status: list[Status] = Query(default=[]),
                     page: int = Query(1, ge=1),
                     page_size: int = Query(rules.PAGE_SIZE, ge=1, le=rules.MAX_PAGE_SIZE),
                     _u=Depends(require_admin)):
    try:
        out = service.customer_support(customer_key, refresh=refresh, statuses=list(status), page=page,
                                       page_size=page_size)
    except (SupportNotConfigured, SupportUnavailable) as e:
        _fail(e)
    if out is None:
        raise HTTPException(status_code=404, detail="customer not found")
    return out


@router.get("/customers/{customer_key}/threads/{thread_id}", response_model=ThreadDetail)
def thread_detail(customer_key: str, thread_id: str = Path(pattern=rules.THREAD_ID_PATTERN), refresh: bool = False,
                  _u=Depends(require_admin)):
    try:
        out = service.thread_detail(customer_key, thread_id, refresh=refresh)
    except (SupportNotConfigured, SupportUnavailable) as e:
        _fail(e)
    if out is None:
        raise HTTPException(status_code=404, detail="thread not found")
    return out
```

`backend/main.py`: after `from crm_close.routes import router as crm_close_router` add

```python
from support_plain.routes import router as support_plain_router
```

and after `app.include_router(crm_close_router)` add

```python
app.include_router(support_plain_router)
```

`backend/.env.example`: after the `CLOSE_API_KEY=` line append

```
# Plain (customer Support tab, admin-only). A Plain API key; Mk1 only reads with it.
PLAIN_API_KEY=
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_support_plain_routes.py tests/test_support_plain_threads.py tests/test_support_plain_client.py tests/test_support_plain_match.py tests/test_crm_close_routes.py -q`
Expected: all passed (13 new route tests plus the earlier tasks' and the CRM route tests unchanged)

- [ ] **Step 5: Commit**

```bash
git add backend/support_plain/service.py backend/support_plain/routes.py backend/main.py backend/.env.example backend/tests/test_support_plain_routes.py
git -c core.autocrlf=true commit -m "feat(support): admin-only /support routes with refresh, stale fallback and thread scoping" -- backend/support_plain/service.py backend/support_plain/routes.py backend/main.py backend/.env.example backend/tests/test_support_plain_routes.py
```

---

### Task 5: Frontend Support tab and thread panel

**Files:**
- Modify: `src/lib/api-crm.ts` (export `crmFetch`)
- Create: `src/lib/api-support.ts`
- Create: `src/components/customers/CustomerSupportTab.tsx`
- Create: `src/components/customers/SupportThreadPanel.tsx`
- Test: `src/components/customers/CustomerSupportTab.test.tsx`

**Interfaces:**
- Consumes: Task 4 routes and shapes; `crmFetch<T>(path: string, qs: URLSearchParams): Promise<T>` and `CrmError(status, code)` from `@/lib/api-crm`.
- Produces: `getCustomerSupport(key, {statuses?, page?, refresh?}) -> Promise<CustomerSupport>`, `getSupportThread(key, id, {refresh?}) -> Promise<SupportThreadDetail>`; `<CustomerSupportTab customerKey={string} />`.

- [ ] **Step 1: Write the failing test**

`src/components/customers/CustomerSupportTab.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as support from '@/lib/api-support'
import type { CustomerSupport, SupportThread } from '@/lib/api-support'
import { CrmError } from '@/lib/api-crm'
import { CustomerSupportTab } from './CustomerSupportTab'

vi.mock('@/lib/api-support', async () => {
  const actual = await vi.importActual<typeof support>('@/lib/api-support')
  return { ...actual, getCustomerSupport: vi.fn(), getSupportThread: vi.fn() }
})

const waitingSince = new Date(Date.now() - 2 * 3600_000).toISOString()
const open: SupportThread = {
  id: 'th_b',
  ref: 'T-482',
  title: 'COA late',
  status: 'open',
  priority: 'urgent',
  labels: ['Lab'],
  assignee: 'Lauren',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
  preview: 'Where is my COA',
  waiting_since: waitingSince,
  plain_url: 'https://app.plain.com/workspace/w_1/thread/th_b',
}
const done: SupportThread = {
  ...open,
  id: 'th_a',
  ref: 'T-100',
  title: 'Shipping label',
  status: 'done',
  priority: 'normal',
  labels: [],
  waiting_since: null,
  updated_at: '2026-08-01T00:00:00Z',
}
const base: CustomerSupport = {
  customer_key: 'wc:1',
  matched: 1,
  threads: [open, done],
  total: 2,
  page: 1,
  page_size: 50,
  counts: { open: 1, snoozed: 0, done: 1, waiting: 1 },
  last_contact_at: '2026-09-03T00:00:00Z',
  oldest_waiting_since: waitingSince,
  fetched_at: new Date().toISOString(),
  stale: false,
  refresh_throttled: false,
}

function setup(data: CustomerSupport | Error = base) {
  if (data instanceof Error)
    vi.mocked(support.getCustomerSupport).mockRejectedValue(data)
  else vi.mocked(support.getCustomerSupport).mockResolvedValue(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CustomerSupportTab customerKey="wc:1" />
    </QueryClientProvider>
  )
}

describe('CustomerSupportTab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the summary, waiting badge and rows newest first', async () => {
    setup()
    expect(await screen.findByText(/2 tickets · 1 open · 1 waiting on us/)).toBeInTheDocument()
    expect(screen.getByText(/Waiting on us 2h/)).toBeInTheDocument()
    const rows = screen.getAllByRole('button', { name: /T-482|T-100/ })
    expect(rows[0]).toHaveTextContent('COA late')
    expect(rows[0]).toHaveTextContent('Urgent')
    expect(rows[1]).not.toHaveTextContent('Normal')
  })

  it('status chip refetches with the status filter', async () => {
    setup()
    await screen.findByText('COA late')
    await userEvent.click(screen.getByRole('button', { name: /^Done/ }))
    expect(support.getCustomerSupport).toHaveBeenLastCalledWith(
      'wc:1',
      expect.objectContaining({ statuses: ['done'] })
    )
  })

  it('refresh is one-shot', async () => {
    setup()
    await screen.findByText('COA late')
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    expect(support.getCustomerSupport).toHaveBeenLastCalledWith(
      'wc:1',
      expect.objectContaining({ refresh: true })
    )
    await userEvent.click(screen.getByRole('button', { name: /^Open/ }))
    expect(vi.mocked(support.getCustomerSupport).mock.lastCall?.[1]?.refresh).toBeFalsy()
  })

  it('opens the conversation with internal notes marked and events as one-liners', async () => {
    vi.mocked(support.getSupportThread).mockResolvedValue({
      thread: open,
      entries: [
        { id: 'e1', at: '2026-09-02T00:00:00Z', kind: 'email', author: 'Kyle R', author_kind: 'customer', internal: false, subject: 'COA late', text: '<b>not html</b>\nline two' },
        { id: 'e2', at: '2026-09-02T01:00:00Z', kind: 'note', author: 'Lauren', author_kind: 'agent', internal: true, subject: null, text: 'Retest promised' },
        { id: 'e3', at: '2026-09-02T02:00:00Z', kind: 'event', author: 'Lauren', author_kind: 'agent', internal: false, subject: null, text: 'Marked done by Lauren' },
      ],
      fetched_at: new Date().toISOString(),
      stale: false,
    })
    setup()
    await userEvent.click(await screen.findByRole('button', { name: /T-482/ }))
    const panel = await screen.findByRole('dialog')
    expect(within(panel).getByText(/<b>not html<\/b>/)).toBeInTheDocument()
    expect(within(panel).getByText('Internal')).toBeInTheDocument()
    expect(within(panel).getByText('Retest promised').closest('[data-internal="true"]')).not.toBeNull()
    expect(within(panel).getByText(/Marked done by Lauren/)).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: /Open in Plain/ })).toHaveAttribute('href', open.plain_url)
    expect(support.getSupportThread).toHaveBeenCalledWith('wc:1', 'th_b', { refresh: false })
  })

  it('shows the empty state', async () => {
    setup({ ...base, threads: [], total: 0, counts: { open: 0, snoozed: 0, done: 0, waiting: 0 }, last_contact_at: null, oldest_waiting_since: null })
    expect(await screen.findByText('No support tickets for this customer.')).toBeInTheDocument()
  })

  it('shows not configured on 503', async () => {
    setup(new CrmError(503, 'support_not_configured'))
    expect(await screen.findByText(/Support not configured/)).toBeInTheDocument()
  })

  it('shows unavailable with retry on 502', async () => {
    setup(new CrmError(502, 'support_unavailable'))
    expect(await screen.findByText(/Plain unavailable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })

  it('shows the stale notice', async () => {
    setup({ ...base, stale: true, fetched_at: new Date(Date.now() - 4 * 60_000).toISOString() })
    expect(await screen.findByText(/Plain is unavailable, showing data from 4 min ago/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/customers/CustomerSupportTab.test.tsx`
Expected: FAIL with `Failed to resolve import "@/lib/api-support"`

- [ ] **Step 3: Write minimal implementation**

`src/lib/api-crm.ts`: change `async function crmFetch<T>(` to `export async function crmFetch<T>(` (no other change).

`src/lib/api-support.ts`:

```ts
import { crmFetch } from '@/lib/api-crm'

export type SupportStatus = 'open' | 'snoozed' | 'done'

export interface SupportThread {
  id: string
  ref: string
  title: string
  status: SupportStatus
  priority: 'urgent' | 'high' | 'normal' | 'low'
  labels: string[]
  assignee: string | null
  created_at: string | null
  updated_at: string | null
  preview: string
  waiting_since: string | null
  plain_url: string
}

export interface CustomerSupport {
  customer_key: string
  matched: number
  threads: SupportThread[]
  total: number
  page: number
  page_size: number
  counts: Record<SupportStatus | 'waiting', number>
  last_contact_at: string | null
  oldest_waiting_since: string | null
  fetched_at: string
  stale: boolean
  refresh_throttled: boolean
}

export interface SupportEntry {
  id: string
  at: string | null
  kind: 'email' | 'chat' | 'slack' | 'note' | 'discussion' | 'form' | 'event'
  author: string | null
  author_kind: 'customer' | 'agent' | 'system'
  internal: boolean
  subject: string | null
  text: string
}

export interface SupportThreadDetail {
  thread: SupportThread
  entries: SupportEntry[]
  fetched_at: string
  stale: boolean
}

export function getCustomerSupport(
  key: string,
  q: { statuses?: SupportStatus[]; page?: number; refresh?: boolean } = {}
): Promise<CustomerSupport> {
  const qs = new URLSearchParams()
  for (const s of q.statuses ?? []) qs.append('status', s)
  if (q.page && q.page > 1) qs.set('page', String(q.page))
  if (q.refresh) qs.set('refresh', 'true')
  return crmFetch(`/support/customers/${encodeURIComponent(key)}`, qs)
}

export function getSupportThread(
  key: string,
  id: string,
  q: { refresh?: boolean } = {}
): Promise<SupportThreadDetail> {
  const qs = new URLSearchParams()
  if (q.refresh) qs.set('refresh', 'true')
  return crmFetch(
    `/support/customers/${encodeURIComponent(key)}/threads/${encodeURIComponent(id)}`,
    qs
  )
}
```

`src/components/customers/SupportThreadPanel.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { getSupportThread, type SupportThread } from '@/lib/api-support'

const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : ''

/** Full Plain conversation. Bodies are plain text (whitespace-pre-wrap), never HTML. */
export function SupportThreadPanel({
  customerKey,
  thread,
  onClose,
}: {
  customerKey: string
  thread: SupportThread | null
  onClose: () => void
}) {
  const q = useQuery({
    queryKey: ['support', 'thread', customerKey, thread?.id],
    queryFn: () =>
      thread
        ? getSupportThread(customerKey, thread.id, { refresh: false })
        : Promise.reject(new Error('no thread')),
    enabled: thread !== null,
    staleTime: 300_000,
  })
  const d = q.data
  return (
    <Sheet open={thread !== null} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>
            {thread?.ref} · {thread?.title}
          </SheetTitle>
          <SheetDescription>
            {thread?.status}
            {thread?.labels.length ? ` · ${thread.labels.join(', ')}` : ''}
            {' · '}
            {thread && (
              <a
                className="text-sky-500 hover:underline"
                href={thread.plain_url}
                target="_blank"
                rel="noreferrer"
              >
                Open in Plain
              </a>
            )}
          </SheetDescription>
        </SheetHeader>
        {q.isLoading && (
          <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-muted-foreground" />
        )}
        {q.isError && (
          <p className="mt-4 px-4 text-sm text-red-500">
            Could not load this conversation.
          </p>
        )}
        {d?.stale && (
          <p className="mt-2 px-4 text-xs text-amber-500">
            Plain is unavailable, showing a saved copy.
          </p>
        )}
        {d && (
          <div className="mt-4 flex flex-col gap-3 px-4 text-sm">
            {d.entries.map(e =>
              e.kind === 'event' ? (
                <div
                  key={e.id}
                  className="text-center text-xs text-muted-foreground"
                >
                  {e.text} · {when(e.at)}
                </div>
              ) : (
                <div
                  key={e.id}
                  data-internal={e.internal ? 'true' : 'false'}
                  className={cn(
                    'rounded-md border p-3',
                    e.internal
                      ? 'border-amber-500/40 bg-amber-500/10'
                      : 'border-border/50'
                  )}
                >
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    {e.internal && (
                      <span className="rounded-full bg-amber-500/20 px-2 font-medium text-amber-700 dark:text-amber-300">
                        Internal
                      </span>
                    )}
                    <span className="text-foreground">
                      {e.author ?? (e.author_kind === 'customer' ? 'Customer' : 'Team')}
                    </span>
                    <span>{when(e.at)}</span>
                  </div>
                  {e.subject && <div className="mb-1 font-medium">{e.subject}</div>}
                  <p className="whitespace-pre-wrap break-words">{e.text}</p>
                </div>
              )
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
```

`src/components/customers/CustomerSupportTab.tsx`:

```tsx
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CrmError } from '@/lib/api-crm'
import {
  getCustomerSupport,
  type CustomerSupport,
  type SupportStatus,
  type SupportThread,
} from '@/lib/api-support'
import { SupportThreadPanel } from './SupportThreadPanel'

const CARD = 'rounded-lg border border-border/50 bg-card/30 p-3'
const CHIPS: { key: SupportStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'done', label: 'Done' },
]
const STATUS_STYLE: Record<SupportStatus, string> = {
  open: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  snoozed: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  done: 'bg-muted text-muted-foreground',
}
const minutesSince = (iso: string) =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
const age = (iso: string) => {
  const m = minutesSince(iso)
  if (m < 60) return `${m}m`
  if (m < 48 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}
const ago = (iso: string) => {
  const m = minutesSince(iso)
  return m < 1 ? 'just now' : `${m} min ago`
}
const relative = (iso: string | null) => (iso ? `updated ${age(iso)} ago` : '')
const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'never'

export function CustomerSupportTab({ customerKey }: { customerKey: string }) {
  const [status, setStatus] = useState<SupportStatus | 'all'>('all')
  const [pages, setPages] = useState(1)
  const [refreshNonce, setRefreshNonce] = useState(0)
  // Refresh is one-shot: only the first fetch after a Refresh click asks for it.
  const sentRefresh = useRef(0)
  const [open, setOpen] = useState<SupportThread | null>(null)
  const qc = useQueryClient()
  const statuses = status === 'all' ? [] : [status]
  const takeRefresh = () => {
    const due = refreshNonce > sentRefresh.current
    sentRefresh.current = refreshNonce
    return due
  }
  const q = useQuery({
    queryKey: ['support', customerKey, statuses, pages, refreshNonce],
    queryFn: () =>
      getCustomerSupport(customerKey, {
        statuses,
        page: 1,
        refresh: takeRefresh(),
      }).then(async first => {
        if (pages <= 1) return first
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) =>
            getCustomerSupport(customerKey, { statuses, page: i + 2 })
          )
        )
        return {
          ...first,
          threads: [first, ...rest].flatMap(r => r.threads),
        }
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  })

  if (q.error) {
    const e = q.error
    if (e instanceof CrmError && e.code === 'support_not_configured')
      return (
        <p className="text-sm text-muted-foreground">
          Support not configured: PLAIN_API_KEY is not set on the server.
        </p>
      )
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-red-500">Plain unavailable.</span>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  const d: CustomerSupport | undefined = q.data
  if (!d)
    return (
      <Loader2 className="mx-auto mt-8 h-5 w-5 animate-spin text-muted-foreground" />
    )
  const all = d.counts.open + d.counts.snoozed + d.counts.done

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {all} tickets · {d.counts.open} open · {d.counts.waiting} waiting on
          us · last contact {date(d.last_contact_at)}
        </span>
        {d.oldest_waiting_since && (
          <span className="rounded-full bg-red-500/15 px-2 text-xs font-medium text-red-600 dark:text-red-400">
            Waiting on us {age(d.oldest_waiting_since)}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {CHIPS.map(c => {
          const n = c.key === 'all' ? all : d.counts[c.key]
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={status === c.key}
              onClick={() => {
                setStatus(c.key)
                setPages(1)
              }}
              className={cn(
                'rounded-full border px-3 py-0.5 text-xs font-medium',
                status === c.key
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {c.label} {n}
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {d.stale ? (
            <span className="text-amber-500">
              Plain is unavailable, showing data from {ago(d.fetched_at)}
            </span>
          ) : (
            <span>Updated {ago(d.fetched_at)}</span>
          )}
          {d.refresh_throttled && <span>(refreshed moments ago)</span>}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshNonce(n => n + 1)
              void qc.invalidateQueries({
                queryKey: ['support', 'thread', customerKey],
              })
            }}
            disabled={q.isFetching}
          >
            <RefreshCw
              className={cn('mr-1 h-3 w-3', q.isFetching && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>
      </div>

      <section className={CARD}>
        {d.threads.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {all === 0
              ? 'No support tickets for this customer.'
              : 'No tickets with this status.'}
          </p>
        )}
        {d.threads.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setOpen(t)}
            className="flex w-full flex-col gap-0.5 rounded px-1 py-1.5 text-left hover:bg-muted/30"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t.ref}</span>
              <span className="font-medium">{t.title}</span>
              <span
                className={cn(
                  'rounded-full px-2 text-[10px] capitalize',
                  STATUS_STYLE[t.status]
                )}
              >
                {t.status}
              </span>
              {(t.priority === 'urgent' || t.priority === 'high') && (
                <span className="rounded-full bg-red-500/15 px-2 text-[10px] text-red-600 dark:text-red-400">
                  {t.priority === 'urgent' ? 'Urgent' : 'High'}
                </span>
              )}
              {t.labels.map(l => (
                <span
                  key={l}
                  className="rounded-full bg-muted px-2 text-[10px] text-muted-foreground"
                >
                  {l}
                </span>
              ))}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {t.assignee ?? 'Unassigned'} · {relative(t.updated_at)}
              {t.preview ? ` · ${t.preview}` : ''}
            </span>
          </button>
        ))}
        {d.threads.length < d.total && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPages(p => p + 1)}
          >
            Load more
          </Button>
        )}
      </section>

      <SupportThreadPanel
        customerKey={customerKey}
        thread={open}
        onClose={() => setOpen(null)}
      />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/customers/CustomerSupportTab.test.tsx src/components/customers/CustomerCrmTab.test.tsx`
Expected: 8 passed (Support) + 8 passed (CRM, unchanged)

- [ ] **Step 5: Typecheck, lint, format, commit**

Run: `npx tsc --noEmit && npx eslint src/lib/api-support.ts src/lib/api-crm.ts src/components/customers/CustomerSupportTab.tsx src/components/customers/SupportThreadPanel.tsx src/components/customers/CustomerSupportTab.test.tsx && npx prettier --write src/lib/api-support.ts src/components/customers/CustomerSupportTab.tsx src/components/customers/SupportThreadPanel.tsx src/components/customers/CustomerSupportTab.test.tsx`
Expected: no errors; prettier rewrites only the new files.

```bash
git add src/lib/api-crm.ts src/lib/api-support.ts src/components/customers/CustomerSupportTab.tsx src/components/customers/SupportThreadPanel.tsx src/components/customers/CustomerSupportTab.test.tsx
git -c core.autocrlf=true commit -m "feat(support): Support tab and conversation panel" -- src/lib/api-crm.ts src/lib/api-support.ts src/components/customers/CustomerSupportTab.tsx src/components/customers/SupportThreadPanel.tsx src/components/customers/CustomerSupportTab.test.tsx
```

---

### Task 6: Wire the tab into the customer page, then verify end to end

**Files:**
- Modify: `src/store/ui-store.ts:145` and `:201` (add `'support'` to the `customerDetailTab` union)
- Modify: `src/components/CustomerStatusPage.tsx` (import near line 90; Tabs block around lines 1055-1098; guest section around line 1595)
- Modify: `src/test/customer-status-page.test.tsx:777-800` (extend the admin-only test to the Support tab)

**Interfaces:**
- Consumes: `<CustomerSupportTab customerKey />` from Task 5.
- Produces: the visible feature.

- [ ] **Step 1: Write the failing test**

In `src/test/customer-status-page.test.tsx`, rename the test `'shows the CRM tab to admins only'` to `'shows the CRM and Support tabs to admins only'` and add, right after `expect(screen.queryByRole('tab', { name: 'CRM' })).toBeNull()`:

```tsx
      expect(screen.queryByRole('tab', { name: 'Support' })).toBeNull()
```

and right after the `expect(await screen.findByRole('tab', { name: 'CRM' })).toBeInTheDocument()` assertion:

```tsx
      expect(screen.getByRole('tab', { name: 'Support' })).toBeInTheDocument()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/customer-status-page.test.tsx -t "admins only"`
Expected: FAIL, unable to find role "tab" with name "Support"

- [ ] **Step 3: Write minimal implementation**

`src/store/ui-store.ts`: both occurrences of `'orders' | 'dashboard' | 'crm'` become `'orders' | 'dashboard' | 'crm' | 'support'`.

`src/components/CustomerStatusPage.tsx`:

After `import { CustomerCrmTab } from '@/components/customers/CustomerCrmTab'` add:

```tsx
import { CustomerSupportTab } from '@/components/customers/CustomerSupportTab'
```

Replace the Tabs `value` and `onValueChange` props:

```tsx
        value={
          (customerDetailTab === 'crm' || customerDetailTab === 'support') &&
          !isAdminUser
            ? 'orders'
            : customerDetailTab
        }
        onValueChange={v =>
          setCustomerDetailTab(v as 'orders' | 'dashboard' | 'crm' | 'support')
        }
```

After `{isAdminUser && <TabsTrigger value="crm">CRM</TabsTrigger>}` add:

```tsx
          {isAdminUser && <TabsTrigger value="support">Support</TabsTrigger>}
```

After the CRM `TabsContent` block (`{isAdminUser && (<TabsContent value="crm" ...>...</TabsContent>)}`) add:

```tsx
        {isAdminUser && (
          <TabsContent value="support" className="mt-4">
            <CustomerSupportTab customerKey={`wc:${customerDetailTargetId}`} />
          </TabsContent>
        )}
```

In the guest view, after the CRM `<section>` (`<h2 ...>CRM</h2> <CustomerCrmTab customerKey={customerKey} />`) and inside the same `{isAdminUser && (...)}` guard, turn the single section into a fragment holding both:

```tsx
      {isAdminUser && (
        <>
          <section className="mt-4">
            <h2 className="mb-2 text-sm font-medium">CRM</h2>
            <CustomerCrmTab customerKey={customerKey} />
          </section>
          <section className="mt-4">
            <h2 className="mb-2 text-sm font-medium">Support</h2>
            <CustomerSupportTab customerKey={customerKey} />
          </section>
        </>
      )}
```

Format only the touched blocks (do not reformat the whole file): run `npx prettier --check src/components/CustomerStatusPage.tsx src/store/ui-store.ts src/test/customer-status-page.test.tsx`; if it flags lines outside your edits, leave them and fix only your own hunks by hand.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/customer-status-page.test.tsx src/components/customers`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add src/store/ui-store.ts src/components/CustomerStatusPage.tsx src/test/customer-status-page.test.tsx
git -c core.autocrlf=true commit -m "feat(support): Support tab on the customer page (admin)" -- src/store/ui-store.ts src/components/CustomerStatusPage.tsx src/test/customer-status-page.test.tsx
```

- [ ] **Step 6: Gates**

Run, one at a time, each to a log file:

```bash
npx tsc --noEmit
npx eslint src/components/customers src/lib/api-support.ts src/lib/api-crm.ts src/components/CustomerStatusPage.tsx src/store/ui-store.ts src/test/customer-status-page.test.tsx
npx vitest run
cd backend && python -m pytest -q -p no:cacheprovider > /tmp/support-full.log 2>&1; grep -E "^(FAILED|ERROR) tests/" /tmp/support-full.log | sort > /tmp/support-fails.txt
```

Expected: tsc and eslint clean; vitest all passed; the backend failure set equals master's. Produce master's set the same way from a temporary detached worktree of `origin/master` (`git worktree add --detach /c/tmp/mk1-support-base origin/master`, run the suite there afterwards, never at the same time) and `diff` the two sorted files: expected no lines only in this branch. Remove the temp worktree after.

- [ ] **Step 7: Live read-only smoke**

With `PLAIN_API_KEY` loaded into the process environment from the vault (`Get-Secret Mira_APIkey_plain -Vault Accumark -AsPlainText`, never printed, cleared after), run a TestClient script against the real routes with `service._emails_fn` stubbed to known customer emails (Kyle: `wc:1551`) and an admin user override. Print only status codes, counts, entry kinds and booleans: list 200 with `matched >= 1`; detail 200 for the newest thread with at least one `email` entry and every entry's `kind` in the allowed set; a malformed id 422; a standard user 403. This also proves Plain accepts the exact `queries.THREAD` text.

Expected: all as listed. Any GraphQL rejection here means `queries.py` must change; fix it with a failing unit test first.
