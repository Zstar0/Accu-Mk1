# Customer CRM tab (Close) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins see a customer's Close CRM history (emails, calls, SMS, meetings, notes, plus lead/contact/opportunity header) in a new CRM tab on the Accu-Mk1 customer page, with drill-down and a Refresh control.

**Architecture:** A pure backend package `backend/crm_close/` reads Close's REST API live (GET only) through a thin httpx client, matches a Mk1 customer key to Close leads by email, normalizes activities into one timeline shape, and caches results in memory. Two admin-only routes serve the tab. The frontend adds `CustomerCrmTab` + `CrmActivityPanel` and an `api-crm.ts` client. Nothing is persisted.

**Tech Stack:** FastAPI + pydantic v2, httpx (already in `backend/requirements.txt`), psycopg2 via `integration_db.get_integration_db`, pytest; React 19 + TanStack Query + Tailwind + shadcn `Tabs`/`Sheet`, vitest + Testing Library. Frontend is **npm only**.

**Spec:** `docs/superpowers/specs/2026-10-07-customer-crm-tab-design.md`

## Global Constraints

- Admin-only: backend `require_admin` (from `auth`) on every `/crm/*` route; frontend renders the tab only when `useAuthStore(state => state.user)?.role === 'admin'`.
- Close client issues **GET only**. Base URL `https://api.close.com/api/v1/`. Auth: HTTP Basic with `CLOSE_API_KEY` as username, empty password. Timeout 10 s. One retry on 429 (sleep `min(Retry-After, 5)` s) and on 5xx.
- Env var: `CLOSE_API_KEY`. Never logged, never returned, never sent to the browser.
- Cache TTLs: lead match 3600 s; timeline 300 s; Close user names 3600 s. Refresh cooldown 10 s per customer key.
- Timeline types: `email`, `call`, `sms`, `meeting`, `note`. `EmailThread` and all other Close types are dropped.
- Automated email: subject matches `^\[Accumark Labs\]: You've got a new order`, or sender in `AUTOMATED_SENDERS` (starts empty; filled in Task 6 from live data).
- Email bodies leave the backend as plain text only (`body_text`, else `body_html` stripped to text). No HTML is rendered in the browser.
- Logs carry ids and counts only; never bodies, note text, emails or phones.
- No database tables, no migration, no IS/WP change.
- Copy and docs: no em dashes.
- Pydantic `response_model` drops undeclared keys silently: declare every key returned.

## Review Focus

1. **A customer with no email on file (guest key malformed, or `wc_customers.email` null and no orders)** should return 200 with `leads: []` and `emails_tried: []`, never 500. Test in Task 3.
2. **Close returns a lead whose `contacts` or `opportunities` key is missing or null** should render the lead with empty lists. Test in Task 3.
3. **An activity with no date fields at all** should sort last, not crash the sort. Test in Task 1.
4. **Refresh while Close is down** should keep showing the cached timeline with `stale: true` rather than erroring the tab. Test in Task 4.
5. **Detail request for an activity on a lead that belongs to a different customer** must 404 (no cross-customer browsing). Test in Task 4.

---

## File map

| File | Responsibility |
|---|---|
| `backend/crm_close/__init__.py` | empty package marker |
| `backend/crm_close/rules.py` | constants (patterns, TTLs, page sizes, kept types) |
| `backend/crm_close/timeline.py` | pure normalization: Close activity dict -> item dict; HTML-to-text; sort; detail shaping |
| `backend/crm_close/client.py` | `CloseClient` (GET only), `CrmNotConfigured`, `CrmUnavailable` |
| `backend/crm_close/cache.py` | `TTLCache` with single-flight `get_or_load`, `drop`, refresh cooldown |
| `backend/crm_close/match.py` | customer key -> emails (IS DB) -> leads (Close); lead shaping |
| `backend/crm_close/service.py` | orchestration: `customer_crm(...)`, `activity_detail(...)` |
| `backend/crm_close/routes.py` | `/crm/*` router + pydantic models |
| `backend/main.py` | import + `include_router` |
| `backend/tests/test_crm_close_*.py` | tests per unit |
| `src/lib/api-crm.ts` | types + fetchers |
| `src/components/customers/CustomerCrmTab.tsx` | header, controls, timeline |
| `src/components/customers/CrmActivityPanel.tsx` | drill-down side panel |
| `src/components/customers/CustomerCrmTab.test.tsx` | frontend tests |
| `src/components/CustomerStatusPage.tsx` | CRM tab trigger (admin) + guest-view section |
| `src/store/ui-store.ts` | `customerDetailTab` union gains `'crm'` |

---

### Task 1: Rules and timeline normalization (pure)

**Files:**
- Create: `backend/crm_close/__init__.py`, `backend/crm_close/rules.py`, `backend/crm_close/timeline.py`
- Test: `backend/tests/test_crm_close_timeline.py`

**Interfaces:**
- Produces:
  - `rules.KEPT_TYPES: dict[str, str]` Close `_type` -> item type: `{"Email": "email", "Call": "call", "SMS": "sms", "Meeting": "meeting", "Note": "note"}`
  - `rules.AUTOMATED_SUBJECT: re.Pattern`, `rules.AUTOMATED_SENDERS: frozenset[str]`, `rules.PLAIN_URL: re.Pattern`
  - `rules.MATCH_TTL = 3600`, `rules.TIMELINE_TTL = 300`, `rules.USERS_TTL = 3600`, `rules.REFRESH_COOLDOWN = 10`, `rules.PAGE_SIZE = 50`, `rules.MAX_PAGE_SIZE = 200`, `rules.PREVIEW_CHARS = 160`
  - `timeline.html_to_text(html: str | None) -> str`
  - `timeline.normalize(activity: dict, lead_names: dict[str, str]) -> dict | None` (None for dropped types)
  - `timeline.build(activities: list[dict], lead_names: dict[str, str]) -> list[dict]` (normalized, newest first)
  - `timeline.detail(activity: dict, thread: list[dict], lead_names: dict[str, str]) -> dict`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_crm_close_timeline.py`:

```python
"""crm_close.timeline: Close activity dicts -> one normalized timeline (pure)."""
from crm_close import timeline

LEADS = {"lead_A": "Valor Peptides"}


def email(**over):
    a = {"_type": "Email", "id": "acti_e1", "lead_id": "lead_A", "date_created": "2026-09-02T15:00:00Z",
         "activity_at": "2026-09-02T15:00:00Z", "direction": "incoming", "subject": "Question about COA",
         "sender": "Kyle <kyle@x.example>", "to": ["forrest@accumarklabs.com"], "cc": [],
         "body_text": "Hi team,\nWhere is my COA?", "body_html": "", "thread_id": "thr_1", "user_name": None}
    a.update(over)
    return a


def test_email_normalized_with_inbound_direction_and_preview():
    item = timeline.normalize(email(), LEADS)
    assert item == {
        "id": "acti_e1", "type": "email", "at": "2026-09-02T15:00:00Z", "direction": "inbound",
        "who": "Kyle <kyle@x.example>", "title": "Question about COA",
        "preview": "Hi team, Where is my COA?", "lead_id": "lead_A", "lead_name": "Valor Peptides",
        "automated": False, "support_thread_url": None,
    }


def test_order_notification_is_automated():
    item = timeline.normalize(email(subject="[Accumark Labs]: You've got a new order: #3636",
                                    direction="outgoing"), LEADS)
    assert item["automated"] is True and item["direction"] == "outbound"


def test_html_only_body_becomes_text():
    item = timeline.normalize(email(body_text="", body_html="<p>Hello <b>there</b></p><script>x()</script>"), LEADS)
    assert item["preview"] == "Hello there"
    assert timeline.html_to_text("<div>a<br>b</div>&amp; c") == "a\nb\n& c"


def test_call_sms_meeting_note_shapes():
    call = {"_type": "Call", "id": "acti_c", "lead_id": "lead_A", "date_created": "2026-09-03T10:00:00Z",
            "direction": "outbound", "duration": 125, "disposition": "answered", "note": "Talked pricing",
            "user_name": "Scott Joseph", "recording_url": None}
    sms = {"_type": "SMS", "id": "acti_s", "lead_id": "lead_A", "date_created": "2026-09-04T10:00:00Z",
           "direction": "inbound", "text": "Thanks!", "remote_phone": "+15550100", "user_name": None}
    meeting = {"_type": "Meeting", "id": "acti_m", "lead_id": "lead_A", "starts_at": "2026-09-05T15:00:00Z",
               "date_created": "2026-09-01T00:00:00Z", "title": "AccuVerify Plugin", "user_name": "Forrest Parker",
               "note": "Demo"}
    note = {"_type": "Note", "id": "acti_n", "lead_id": "lead_A", "date_created": "2026-09-06T10:00:00Z",
            "note": "Referred by RJ from Elevate\nsecond line", "user_name": "Scott Joseph"}
    c, s, m, n = (timeline.normalize(x, LEADS) for x in (call, sms, meeting, note))
    assert (c["type"], c["title"], c["who"], c["preview"]) == ("call", "Call, answered, 2 min", "Scott Joseph", "Talked pricing")
    assert (s["type"], s["direction"], s["who"], s["preview"]) == ("sms", "inbound", "+15550100", "Thanks!")
    assert (m["type"], m["at"], m["title"]) == ("meeting", "2026-09-05T15:00:00Z", "AccuVerify Plugin")
    assert (n["type"], n["title"], n["preview"]) == ("note", "Referred by RJ from Elevate", "Referred by RJ from Elevate second line")


def test_plain_link_note_becomes_support_thread():
    url = "https://app.plain.com/workspace/w_01KN/thread/th_01M4/"
    n = timeline.normalize({"_type": "Note", "id": "acti_p", "lead_id": "lead_A",
                            "date_created": "2026-10-07T17:12:52Z", "note": f"<{url}>"}, LEADS)
    assert n["title"] == "Support thread" and n["support_thread_url"] == url


def test_dropped_types_and_sort_with_missing_dates_last():
    acts = [email(id="a1", activity_at="2026-09-01T00:00:00Z", date_created="2026-09-01T00:00:00Z"),
            {"_type": "EmailThread", "id": "t1", "lead_id": "lead_A", "date_created": "2026-09-09T00:00:00Z"},
            {"_type": "LeadStatusChange", "id": "x1", "lead_id": "lead_A", "date_created": "2026-09-09T00:00:00Z"},
            {"_type": "Note", "id": "n0", "lead_id": "lead_A", "note": "undated"},
            email(id="a2", activity_at="2026-09-03T00:00:00Z", date_created="2026-09-03T00:00:00Z")]
    assert [i["id"] for i in timeline.build(acts, LEADS)] == ["a2", "a1", "n0"]


def test_email_detail_includes_thread_oldest_first():
    first = email(id="a1", activity_at="2026-09-01T00:00:00Z", body_text="first")
    second = email(id="a2", activity_at="2026-09-02T00:00:00Z", body_text="second", direction="outgoing")
    d = timeline.detail(second, [second, first], LEADS)
    assert d["type"] == "email" and d["id"] == "a2"
    assert [m["body"] for m in d["messages"]] == ["first", "second"]
    assert d["messages"][1]["direction"] == "outbound"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_crm_close_timeline.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'crm_close'`

- [ ] **Step 3: Implement**

`backend/crm_close/__init__.py`: empty file.

`backend/crm_close/rules.py`:

```python
"""Customer CRM tab (Close) definitions. Spec: docs/superpowers/specs/2026-10-07-customer-crm-tab-design.md."""
import re

KEPT_TYPES = {"Email": "email", "Call": "call", "SMS": "sms", "Meeting": "meeting", "Note": "note"}
AUTOMATED_SUBJECT = re.compile(r"^\[Accumark Labs\]: You've got a new order", re.I)
# Senders seen sending only system mail. Filled from live data (plan Task 6); lowercase.
AUTOMATED_SENDERS: frozenset[str] = frozenset()
PLAIN_URL = re.compile(r"https://app\.plain\.com/\S*?/thread/[A-Za-z0-9_]+/?")

MATCH_TTL = 3600
TIMELINE_TTL = 300
USERS_TTL = 3600
REFRESH_COOLDOWN = 10
PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
PREVIEW_CHARS = 160
```

`backend/crm_close/timeline.py`:

```python
"""Close activities -> one normalized timeline. Pure: no I/O."""
from __future__ import annotations

import html
import re
from typing import Any

from crm_close import rules

_TAG = re.compile(r"<[^>]+>")
_BLOCK = re.compile(r"<\s*(br|/p|/div|/li|/tr|/h\d)\s*/?>", re.I)
_DROP = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.I | re.S)
_DIRECTIONS = {"incoming": "inbound", "inbound": "inbound", "outgoing": "outbound", "outbound": "outbound"}


def html_to_text(raw: str | None) -> str:
    if not raw:
        return ""
    s = _DROP.sub("", raw)
    s = _BLOCK.sub("\n", s)
    s = html.unescape(_TAG.sub("", s))
    return "\n".join(line.strip() for line in s.splitlines() if line.strip())


def _text_body(a: dict[str, Any]) -> str:
    return (a.get("body_text") or "").strip() or html_to_text(a.get("body_html"))


def _preview(text: str) -> str:
    return " ".join(text.split())[: rules.PREVIEW_CHARS]


def _at(a: dict[str, Any]) -> str | None:
    return a.get("starts_at") or a.get("activity_at") or a.get("date_sent") or a.get("date_created")


def _call_title(a: dict[str, Any]) -> str:
    parts = ["Call"]
    if a.get("disposition"):
        parts.append(str(a["disposition"]))
    secs = a.get("duration") or 0
    if secs:
        parts.append(f"{max(1, round(secs / 60))} min")
    return ", ".join(parts)


def normalize(a: dict[str, Any], lead_names: dict[str, str]) -> dict[str, Any] | None:
    kind = rules.KEPT_TYPES.get(a.get("_type", ""))
    if kind is None:
        return None
    direction = _DIRECTIONS.get((a.get("direction") or "").lower())
    support_url = None
    automated = False
    if kind == "email":
        body = _text_body(a)
        sender = (a.get("sender") or "").lower()
        automated = bool(rules.AUTOMATED_SUBJECT.search(a.get("subject") or "")) or any(
            s in sender for s in rules.AUTOMATED_SENDERS)
        who, title = a.get("sender") or a.get("user_name") or "", a.get("subject") or "(no subject)"
    elif kind == "call":
        body = a.get("note") or ""
        who, title = a.get("user_name") or a.get("phone") or "", _call_title(a)
    elif kind == "sms":
        body = a.get("text") or ""
        who, title = (a.get("remote_phone") if direction == "inbound" else a.get("user_name")) or "", "SMS"
    elif kind == "meeting":
        body = html_to_text(a.get("note")) if "<" in (a.get("note") or "") else (a.get("note") or "")
        who, title = a.get("user_name") or "", a.get("title") or "Meeting"
    else:  # note
        body = a.get("note") or html_to_text(a.get("note_html"))
        stripped = body.strip().strip("<>").strip()
        m = rules.PLAIN_URL.fullmatch(stripped) if stripped else None
        if m:
            support_url, title = m.group(0), "Support thread"
        else:
            title = (body.strip().splitlines() or [""])[0][:120]
        who = a.get("user_name") or ""
    return {
        "id": a["id"], "type": kind, "at": _at(a), "direction": direction, "who": who, "title": title,
        "preview": "" if support_url else _preview(body), "lead_id": a.get("lead_id"),
        "lead_name": lead_names.get(a.get("lead_id") or "", ""), "automated": automated,
        "support_thread_url": support_url,
    }


def build(activities: list[dict[str, Any]], lead_names: dict[str, str]) -> list[dict[str, Any]]:
    items = [i for i in (normalize(a, lead_names) for a in activities) if i is not None]
    dated = sorted((i for i in items if i["at"]), key=lambda i: i["at"], reverse=True)
    return dated + [i for i in items if not i["at"]]


def _email_message(a: dict[str, Any]) -> dict[str, Any]:
    return {"id": a["id"], "at": _at(a), "direction": _DIRECTIONS.get((a.get("direction") or "").lower()),
            "sender": a.get("sender") or "", "to": list(a.get("to") or []), "cc": list(a.get("cc") or []),
            "subject": a.get("subject") or "", "body": _text_body(a)}


def detail(a: dict[str, Any], thread: list[dict[str, Any]], lead_names: dict[str, str]) -> dict[str, Any]:
    """Full item. `thread` = the lead's emails sharing a.thread_id (ignored for other types)."""
    item = normalize(a, lead_names) or {}
    extra: dict[str, Any] = {}
    if item.get("type") == "email":
        msgs = thread or [a]
        extra["messages"] = [_email_message(m) for m in sorted(msgs, key=lambda m: _at(m) or "")]
    elif item.get("type") == "call":
        extra.update(duration=a.get("duration"), disposition=a.get("disposition"),
                     note=a.get("note") or "", recording_url=a.get("recording_url"), phone=a.get("phone"))
    elif item.get("type") == "sms":
        extra.update(text=a.get("text") or "", remote_phone=a.get("remote_phone"))
    elif item.get("type") == "meeting":
        extra.update(starts_at=a.get("starts_at"), ends_at=a.get("ends_at"),
                     attendees=[x.get("email") or x.get("name") for x in a.get("attendees") or []],
                     note=html_to_text(a.get("note")) if "<" in (a.get("note") or "") else (a.get("note") or ""))
    elif item.get("type") == "note":
        extra["note"] = a.get("note") or html_to_text(a.get("note_html"))
    return {**item, **extra}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_crm_close_timeline.py -q`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add backend/crm_close/__init__.py backend/crm_close/rules.py backend/crm_close/timeline.py backend/tests/test_crm_close_timeline.py
git commit -m "feat(crm): Close activity normalization (pure)"
```

---

### Task 2: GET-only Close client

**Files:**
- Create: `backend/crm_close/client.py`
- Test: `backend/tests/test_crm_close_client.py`

**Interfaces:**
- Produces:
  - `class CrmNotConfigured(Exception)`, `class CrmUnavailable(Exception)`
  - `class CloseClient: __init__(api_key: str | None = None, transport: httpx.BaseTransport | None = None, sleep=time.sleep)`; `get(path: str, params: dict | None = None) -> dict`; `paginate(path: str, params: dict, limit: int = 100, max_items: int = 2000) -> list[dict]`
  - `def get_client() -> CloseClient` (module-level factory reading `os.environ["CLOSE_API_KEY"]`; raises `CrmNotConfigured` when unset or blank)

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_crm_close_client.py`:

```python
"""crm_close.client: GET-only, retry once, typed failures."""
import httpx
import pytest

from crm_close import client as c


def _client(handler, sleeps=None):
    return c.CloseClient(api_key="k", transport=httpx.MockTransport(handler),
                         sleep=(sleeps.append if sleeps is not None else (lambda s: None)))


def test_get_sends_basic_auth_and_returns_json():
    seen = {}

    def handler(req):
        seen["auth"] = req.headers["authorization"]
        seen["url"] = str(req.url)
        return httpx.Response(200, json={"ok": True})

    assert _client(handler).get("me/") == {"ok": True}
    assert seen["auth"].startswith("Basic ") and seen["url"] == "https://api.close.com/api/v1/me/"


def test_retries_once_on_429_honouring_retry_after_capped():
    calls, sleeps = [], []

    def handler(req):
        calls.append(1)
        return httpx.Response(429, headers={"Retry-After": "30"}) if len(calls) == 1 else httpx.Response(200, json={})

    _client(handler, sleeps).get("lead/")
    assert len(calls) == 2 and sleeps == [5]


def test_second_failure_raises_unavailable():
    with pytest.raises(c.CrmUnavailable):
        _client(lambda req: httpx.Response(503)).get("lead/")


def test_timeout_raises_unavailable():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    with pytest.raises(c.CrmUnavailable):
        _client(handler).get("lead/")


def test_paginate_follows_has_more_and_caps():
    def handler(req):
        skip = int(req.url.params["_skip"])
        return httpx.Response(200, json={"data": [{"id": skip}], "has_more": skip < 2})

    assert [x["id"] for x in _client(handler).paginate("activity/", {"lead_id": "L"}, limit=1)] == [0, 1, 2]


def test_get_only_surface():
    public = {n for n in dir(c.CloseClient) if not n.startswith("_")}
    assert public == {"get", "paginate"}


def test_missing_key_raises_not_configured(monkeypatch):
    monkeypatch.delenv("CLOSE_API_KEY", raising=False)
    with pytest.raises(c.CrmNotConfigured):
        c.get_client()
    monkeypatch.setenv("CLOSE_API_KEY", "  ")
    with pytest.raises(c.CrmNotConfigured):
        c.get_client()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_crm_close_client.py -q`
Expected: FAIL, `ImportError: cannot import name 'client'`

- [ ] **Step 3: Implement**

`backend/crm_close/client.py`:

```python
"""Thin Close REST client. GET only (the key itself can write; this client never does)."""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Callable

import httpx

BASE_URL = "https://api.close.com/api/v1/"
logger = logging.getLogger(__name__)


class CrmNotConfigured(Exception):
    """CLOSE_API_KEY is not set."""


class CrmUnavailable(Exception):
    """Close failed after one retry (429/5xx/timeout/network)."""


class CloseClient:
    def __init__(self, api_key: str | None = None, transport: httpx.BaseTransport | None = None,
                 sleep: Callable[[float], Any] = time.sleep) -> None:
        self._http = httpx.Client(base_url=BASE_URL, auth=(api_key or "", ""), timeout=10.0, transport=transport)
        self._sleep = sleep

    def get(self, path: str, params: dict | None = None) -> dict:
        for attempt in (1, 2):
            try:
                r = self._http.get(path, params=params)
            except httpx.HTTPError as e:
                logger.warning("crm_close.request_failed path=%s attempt=%s error=%s", path, attempt, type(e).__name__)
                if attempt == 2:
                    raise CrmUnavailable(type(e).__name__) from e
                continue
            if r.status_code == 429 or r.status_code >= 500:
                logger.warning("crm_close.http_%s path=%s attempt=%s", r.status_code, path, attempt)
                if attempt == 2:
                    raise CrmUnavailable(f"http_{r.status_code}")
                if r.status_code == 429:
                    try:
                        wait = float(r.headers.get("Retry-After", "1"))
                    except ValueError:
                        wait = 1.0
                    self._sleep(min(wait, 5))
                continue
            if r.status_code >= 400:
                raise CrmUnavailable(f"http_{r.status_code}")
            return r.json()
        raise CrmUnavailable("unreachable")

    def paginate(self, path: str, params: dict, limit: int = 100, max_items: int = 2000) -> list[dict]:
        out: list[dict] = []
        skip = 0
        while len(out) < max_items:
            page = self.get(path, {**params, "_limit": limit, "_skip": skip})
            data = page.get("data") or []
            out.extend(data)
            if not page.get("has_more") or not data:
                break
            skip += len(data)
        return out[:max_items]


def get_client() -> CloseClient:
    key = (os.environ.get("CLOSE_API_KEY") or "").strip()
    if not key:
        raise CrmNotConfigured()
    return CloseClient(api_key=key)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_crm_close_client.py -q`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add backend/crm_close/client.py backend/tests/test_crm_close_client.py
git commit -m "feat(crm): GET-only Close client with one retry"
```

---

### Task 3: Cache and customer-to-lead matching

**Files:**
- Create: `backend/crm_close/cache.py`, `backend/crm_close/match.py`
- Test: `backend/tests/test_crm_close_match.py`

**Interfaces:**
- Consumes: `CloseClient.get` (Task 2)
- Produces:
  - `class TTLCache: __init__(clock=time.monotonic)`; `get_or_load(key: str, ttl: float, loader: Callable[[], T]) -> tuple[T, float]` (value, loaded_at monotonic); `peek(key) -> tuple[T, float] | None` (ignores TTL, for stale fallback); `drop(prefix: str) -> None`; `allow_refresh(key: str, cooldown: float) -> bool`
  - `match.customer_emails(customer_key: str, conn_factory=get_integration_db) -> list[str] | None` (None = unknown `wc:` id)
  - `match.find_leads(emails: list[str], client: CloseClient) -> list[dict]` (raw Close leads, deduped by id, first-seen order)
  - `match.shape_lead(raw: dict) -> dict` with keys `id, name, status, owner, url, contacts[{name, emails, phones}], opportunities[{status, value, value_period, confidence, expected_date}]`; `value` in dollars (Close stores cents)

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_crm_close_match.py`:

```python
"""crm_close.match + cache."""
from contextlib import contextmanager

from crm_close import match
from crm_close.cache import TTLCache


class _Cur:
    def __init__(self, rows):
        self.rows, self.sql = rows, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.sql.append((sql, params))

    def fetchall(self):
        return self.rows.pop(0)


def _conn(rows):
    cur = _Cur(rows)

    @contextmanager
    def factory():
        class C:
            def cursor(self):
                return cur
        yield C()
    return factory


def test_wc_key_collects_account_and_billing_emails_lowercased_deduped():
    rows = [[("Kyle@X.example",)], [("kyle@x.example",), ("ops@valor.example ",), (None,)]]
    assert match.customer_emails("wc:1551", conn_factory=_conn(rows)) == ["kyle@x.example", "ops@valor.example"]


def test_unknown_wc_key_is_none_and_email_key_passes_through():
    assert match.customer_emails("wc:99", conn_factory=_conn([[], []])) is None
    assert match.customer_emails("email:G@X.com", conn_factory=_conn([])) == ["g@x.com"]
    assert match.customer_emails("email:", conn_factory=_conn([])) == []
    assert match.customer_emails("bogus", conn_factory=_conn([])) is None


def test_wc_key_with_no_email_anywhere_is_empty_list():
    assert match.customer_emails("wc:5", conn_factory=_conn([[(None,)], []])) == []


class _Close:
    def __init__(self, by_email):
        self.by_email, self.calls = by_email, []

    def get(self, path, params=None):
        self.calls.append(params["query"])
        email = params["query"].split('"')[1]
        return {"data": self.by_email.get(email, [])}


def test_find_leads_dedupes_across_emails():
    a = {"id": "lead_A", "display_name": "Valor"}
    b = {"id": "lead_B", "display_name": "NxGen"}
    close = _Close({"kyle@x.example": [a], "ops@valor.example": [a, b]})
    leads = match.find_leads(["kyle@x.example", "ops@valor.example"], close)
    assert [l["id"] for l in leads] == ["lead_A", "lead_B"]
    assert close.calls[0] == 'email_address:"kyle@x.example"'


def test_shape_lead_handles_missing_lists_and_converts_cents():
    raw = {"id": "lead_A", "display_name": "Valor", "status_label": "Active Customer", "html_url": "https://app.close.com/lead/lead_A/",
           "contacts": None,
           "opportunities": [{"status_label": "Won", "value": 125000, "value_period": "one_time", "confidence": 90,
                              "expected_date": "2026-11-01", "user_name": "Scott Joseph", "date_updated": "2026-09-01"}]}
    s = match.shape_lead(raw)
    assert s["contacts"] == [] and s["owner"] == "Scott Joseph"
    assert s["opportunities"] == [{"status": "Won", "value": 1250.0, "value_period": "one_time",
                                   "confidence": 90, "expected_date": "2026-11-01"}]
    assert match.shape_lead({"id": "lead_B"})["opportunities"] == []


def test_cache_ttl_drop_peek_and_cooldown():
    now = [0.0]
    cache = TTLCache(clock=lambda: now[0])
    loads = []
    v, _ = cache.get_or_load("m:wc:1", 10, lambda: loads.append(1) or "x")
    v2, _ = cache.get_or_load("m:wc:1", 10, lambda: loads.append(1) or "y")
    assert (v, v2, len(loads)) == ("x", "x", 1)
    now[0] = 11
    assert cache.get_or_load("m:wc:1", 10, lambda: "z")[0] == "z"
    cache.drop("m:wc:1")
    assert cache.peek("m:wc:1") is None
    assert cache.allow_refresh("wc:1", 10) is True and cache.allow_refresh("wc:1", 10) is False
    now[0] = 22
    assert cache.allow_refresh("wc:1", 10) is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_crm_close_match.py -q`
Expected: FAIL, `ImportError: cannot import name 'match'`

- [ ] **Step 3: Implement**

`backend/crm_close/cache.py`:

```python
"""In-process TTL cache with single-flight loads (same pattern as customer_insights.sources)."""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, TypeVar

T = TypeVar("T")


class TTLCache:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._data: dict[str, tuple[float, Any]] = {}
        self._refresh: dict[str, float] = {}
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()

    def _fresh(self, key: str, ttl: float):
        hit = self._data.get(key)
        return hit if hit and self._clock() - hit[0] < ttl else None

    def get_or_load(self, key: str, ttl: float, loader: Callable[[], T]) -> tuple[T, float]:
        with self._lock:
            hit = self._fresh(key, ttl)
        if hit:
            return hit[1], hit[0]
        with self._load_lock:
            with self._lock:
                hit = self._fresh(key, ttl)
            if hit:
                return hit[1], hit[0]
            value = loader()
            at = self._clock()
            with self._lock:
                self._data[key] = (at, value)
            return value, at

    def peek(self, key: str):
        with self._lock:
            hit = self._data.get(key)
        return (hit[1], hit[0]) if hit else None

    def drop(self, prefix: str) -> None:
        with self._lock:
            for k in [k for k in self._data if k.startswith(prefix)]:
                del self._data[k]

    def allow_refresh(self, key: str, cooldown: float) -> bool:
        with self._lock:
            last = self._refresh.get(key)
            if last is not None and self._clock() - last < cooldown:
                return False
            self._refresh[key] = self._clock()
            return True
```

`backend/crm_close/match.py`:

```python
"""Mk1 customer key -> customer emails (IS DB) -> Close leads."""
from __future__ import annotations

from typing import Any, Callable

from integration_db import get_integration_db

_ACCOUNT_EMAIL_SQL = "SELECT email FROM wc_customers WHERE id = %s AND deleted_at IS NULL"
_BILLING_EMAILS_SQL = ("SELECT DISTINCT billing_email FROM wc_orders "
                       "WHERE customer_id = %s AND billing_email IS NOT NULL")


def _clean(values) -> list[str]:
    out: list[str] = []
    for v in values:
        e = (v or "").strip().lower()
        if e and e not in out:
            out.append(e)
    return out


def customer_emails(customer_key: str, conn_factory: Callable = get_integration_db) -> list[str] | None:
    if customer_key.startswith("email:"):
        return _clean([customer_key[6:]])
    if not customer_key.startswith("wc:") or not customer_key[3:].isdigit():
        return None
    cid = int(customer_key[3:])
    with conn_factory() as conn, conn.cursor() as cur:
        cur.execute(_ACCOUNT_EMAIL_SQL, (cid,))
        account = cur.fetchall()
        cur.execute(_BILLING_EMAILS_SQL, (cid,))
        billing = cur.fetchall()
    if not account and not billing:
        return None
    return _clean([r[0] for r in account] + [r[0] for r in billing])


_LEAD_FIELDS = "id,display_name,status_label,html_url,contacts,opportunities"


def find_leads(emails: list[str], client) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for e in emails:
        page = client.get("lead/", {"query": f'email_address:"{e}"', "_fields": _LEAD_FIELDS})
        for lead in page.get("data") or []:
            seen.setdefault(lead["id"], lead)
    return list(seen.values())


def shape_lead(raw: dict[str, Any]) -> dict[str, Any]:
    opps = sorted(raw.get("opportunities") or [], key=lambda o: o.get("date_updated") or "", reverse=True)
    return {
        "id": raw["id"],
        "name": raw.get("display_name") or raw["id"],
        "status": raw.get("status_label"),
        # Close leads have no built-in owner: the rep on the most recently updated opportunity.
        "owner": opps[0].get("user_name") if opps else None,
        "url": raw.get("html_url") or f"https://app.close.com/lead/{raw['id']}/",
        "contacts": [{"name": c.get("name") or "",
                      "emails": [x.get("email") for x in c.get("emails") or [] if x.get("email")],
                      "phones": [x.get("phone") for x in c.get("phones") or [] if x.get("phone")]}
                     for c in raw.get("contacts") or []],
        "opportunities": [{"status": o.get("status_label"),
                           "value": round((o.get("value") or 0) / 100, 2),
                           "value_period": o.get("value_period"), "confidence": o.get("confidence"),
                           "expected_date": o.get("expected_date")} for o in opps],
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_crm_close_match.py -q`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add backend/crm_close/cache.py backend/crm_close/match.py backend/tests/test_crm_close_match.py
git commit -m "feat(crm): customer-to-lead matching and TTL cache"
```

---

### Task 4: Service and admin routes

**Files:**
- Create: `backend/crm_close/service.py`, `backend/crm_close/routes.py`
- Modify: `backend/main.py` (import beside line 127 `from customer_insights.routes import router as customer_insights_router`; include beside line 638 `app.include_router(customer_insights_router)`)
- Test: `backend/tests/test_crm_close_routes.py`

**Interfaces:**
- Consumes: Tasks 1-3 (`timeline.build`, `timeline.detail`, `get_client`, `CrmNotConfigured`, `CrmUnavailable`, `TTLCache`, `match.*`, `rules.*`)
- Produces:
  - `service.CACHE: TTLCache` (module singleton)
  - `service.customer_crm(customer_key: str, *, refresh: bool, types: list[str], include_automated: bool, page: int, page_size: int) -> dict | None` (None = unknown customer)
  - `service.activity_detail(customer_key: str, activity_id: str, kind: str) -> dict | None` (None = not found / not this customer's)
  - Test seams: module attributes `service._client_factory` (default `client.get_client`) and `service._emails_fn` (default `match.customer_emails`); tests monkeypatch these.
  - Routes `GET /crm/customers/{customer_key}` and `GET /crm/customers/{customer_key}/activities/{activity_id}?type=`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_crm_close_routes.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_crm_close_routes.py -q`
Expected: FAIL, `ImportError: cannot import name 'service'`

- [ ] **Step 3: Implement**

`backend/crm_close/service.py`:

```python
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
```

`backend/crm_close/routes.py`:

```python
"""/crm/* API (spec section 4). Admin-only."""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_admin
from crm_close import rules, service
from crm_close.client import CrmNotConfigured, CrmUnavailable

router = APIRouter(prefix="/crm", tags=["crm"])
ItemType = Literal["email", "call", "sms", "meeting", "note"]


class Contact(BaseModel):
    name: str
    emails: list[str]
    phones: list[str]


class Opportunity(BaseModel):
    status: Optional[str] = None
    value: float
    value_period: Optional[str] = None
    confidence: Optional[int] = None
    expected_date: Optional[str] = None


class Lead(BaseModel):
    id: str
    name: str
    status: Optional[str] = None
    owner: Optional[str] = None
    url: str
    contacts: list[Contact]
    opportunities: list[Opportunity]


class Item(BaseModel):
    id: str
    type: ItemType
    at: Optional[str] = None
    direction: Optional[Literal["inbound", "outbound"]] = None
    who: str
    title: str
    preview: str
    lead_id: Optional[str] = None
    lead_name: str
    automated: bool
    support_thread_url: Optional[str] = None


class Counts(BaseModel):
    email: int
    call: int
    sms: int
    meeting: int
    note: int
    automated: int


class CustomerCrm(BaseModel):
    configured: bool
    emails_tried: list[str]
    leads: list[Lead]
    items: list[Item]
    total: int
    page: int
    page_size: int
    counts: Counts
    fetched_at: str
    stale: bool
    refresh_throttled: bool


class EmailMessage(BaseModel):
    id: str
    at: Optional[str] = None
    direction: Optional[str] = None
    sender: str
    to: list[str]
    cc: list[str]
    subject: str
    body: str


class ActivityDetail(Item):
    messages: Optional[list[EmailMessage]] = None
    duration: Optional[int] = None
    disposition: Optional[str] = None
    note: Optional[str] = None
    recording_url: Optional[str] = None
    phone: Optional[str] = None
    text: Optional[str] = None
    remote_phone: Optional[str] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    attendees: Optional[list[str]] = None


def _fail(e: Exception):
    if isinstance(e, CrmNotConfigured):
        raise HTTPException(status_code=503, detail={"code": "crm_not_configured"})
    raise HTTPException(status_code=502, detail={"code": "crm_unavailable"})


@router.get("/customers/{customer_key}", response_model=CustomerCrm)
def customer_crm(customer_key: str, refresh: bool = False, types: list[ItemType] = Query(default=[]),
                 include_automated: bool = False, page: int = Query(1, ge=1),
                 page_size: int = Query(rules.PAGE_SIZE, ge=1, le=rules.MAX_PAGE_SIZE), _u=Depends(require_admin)):
    try:
        out = service.customer_crm(customer_key, refresh=refresh, types=list(types),
                                   include_automated=include_automated, page=page, page_size=page_size)
    except (CrmNotConfigured, CrmUnavailable) as e:
        _fail(e)
    if out is None:
        raise HTTPException(status_code=404, detail="customer not found")
    return out


@router.get("/customers/{customer_key}/activities/{activity_id}", response_model=ActivityDetail)
def activity_detail(customer_key: str, activity_id: str, type: ItemType, _u=Depends(require_admin)):
    try:
        out = service.activity_detail(customer_key, activity_id, type)
    except (CrmNotConfigured, CrmUnavailable) as e:
        _fail(e)
    if out is None:
        raise HTTPException(status_code=404, detail="activity not found")
    return out
```

`backend/main.py`: add after line 127:

```python
from crm_close.routes import router as crm_close_router
```

and after line 638 (`app.include_router(customer_insights_router)`):

```python
app.include_router(crm_close_router)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_crm_close_routes.py tests/test_crm_close_timeline.py tests/test_crm_close_client.py tests/test_crm_close_match.py -q`
Expected: all pass (7 + 7 + 7 + 6 = 27)

- [ ] **Step 5: Gate against the backend baseline**

Run one suite at a time (two concurrent suites deadlock the host dev Postgres):
`cd backend && python -m pytest -q -p no:cacheprovider 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sort > /tmp/crm_after.txt`
Compare with the same command on `origin/master` in a temp worktree; the only allowed difference is new passing tests. Anchor the grep to `^(FAILED|ERROR) tests/` (captured log lines carry random UUIDs).

- [ ] **Step 6: Commit**

```bash
git add backend/crm_close/service.py backend/crm_close/routes.py backend/main.py backend/tests/test_crm_close_routes.py
git commit -m "feat(crm): admin-only /crm routes with refresh, stale fallback and detail scoping"
```

---

### Task 5: Frontend CRM tab

**Files:**
- Create: `src/lib/api-crm.ts`, `src/components/customers/CustomerCrmTab.tsx`, `src/components/customers/CrmActivityPanel.tsx`, `src/components/customers/CustomerCrmTab.test.tsx`
- Modify: `src/store/ui-store.ts` (line 145 and 201: `'orders' | 'dashboard'` -> `'orders' | 'dashboard' | 'crm'`), `src/components/CustomerStatusPage.tsx` (tabs at ~1050-1084; guest view ~1576-1580)

**Interfaces:**
- Consumes: routes from Task 4 (response shapes exactly as `CustomerCrm` / `ActivityDetail`)
- Produces: `getCustomerCrm(key, opts)`, `getCrmActivity(key, id, type)`, `CustomerCrmTab({ customerKey })`

- [ ] **Step 1: Write the failing tests**

`src/components/customers/CustomerCrmTab.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as crm from '@/lib/api-crm'
import type { CustomerCrm } from '@/lib/api-crm'
import { CustomerCrmTab } from './CustomerCrmTab'

vi.mock('@/lib/api-crm', async () => {
  const actual = await vi.importActual<typeof crm>('@/lib/api-crm')
  return { ...actual, getCustomerCrm: vi.fn(), getCrmActivity: vi.fn() }
})

const base: CustomerCrm = {
  configured: true,
  emails_tried: ['k@x.example'],
  leads: [{ id: 'lead_A', name: 'Valor', status: 'Active Customer', owner: 'Scott Joseph',
            url: 'https://app.close.com/lead/lead_A/', contacts: [], opportunities: [] }],
  items: [
    { id: 'acti_3', type: 'note', at: '2026-09-04T10:00:00Z', direction: null, who: 'Scott Joseph',
      title: 'Call back Friday', preview: 'Call back Friday', lead_id: 'lead_A', lead_name: 'Valor',
      automated: false, support_thread_url: null },
    { id: 'acti_1', type: 'email', at: '2026-09-02T10:00:00Z', direction: 'inbound', who: 'k@x.example',
      title: 'COA question', preview: 'Where is it', lead_id: 'lead_A', lead_name: 'Valor',
      automated: false, support_thread_url: null },
  ],
  total: 2, page: 1, page_size: 50,
  counts: { email: 1, call: 0, sms: 0, meeting: 0, note: 1, automated: 3 },
  fetched_at: new Date().toISOString(), stale: false, refresh_throttled: false,
}

function setup(data: CustomerCrm | Error = base) {
  if (data instanceof Error) vi.mocked(crm.getCustomerCrm).mockRejectedValue(data)
  else vi.mocked(crm.getCustomerCrm).mockResolvedValue(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><CustomerCrmTab customerKey="wc:1" /></QueryClientProvider>)
}

describe('CustomerCrmTab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the lead header and timeline newest first', async () => {
    setup()
    expect(await screen.findByText('Valor')).toBeInTheDocument()
    expect(screen.getByText('Active Customer')).toBeInTheDocument()
    expect(screen.getByText('Owner: Scott Joseph')).toBeInTheDocument()
    const rows = screen.getAllByRole('button', { name: /COA question|Call back Friday/ })
    expect(rows[0]).toHaveTextContent('Call back Friday')
  })

  it('type chip and automated toggle refetch with filters', async () => {
    setup()
    await screen.findByText('Valor')
    await userEvent.click(screen.getByRole('button', { name: /^Emails/ }))
    expect(crm.getCustomerCrm).toHaveBeenLastCalledWith('wc:1', expect.objectContaining({ types: ['email'] }))
    await userEvent.click(screen.getByRole('switch', { name: /Show automated/ }))
    expect(crm.getCustomerCrm).toHaveBeenLastCalledWith('wc:1', expect.objectContaining({ includeAutomated: true }))
  })

  it('refresh asks for refresh=true', async () => {
    setup()
    await screen.findByText('Valor')
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    expect(crm.getCustomerCrm).toHaveBeenLastCalledWith('wc:1', expect.objectContaining({ refresh: true }))
  })

  it('opens the drill-down panel with the email body as text', async () => {
    vi.mocked(crm.getCrmActivity).mockResolvedValue({
      ...base.items[1], messages: [{ id: 'acti_1', at: '2026-09-02T10:00:00Z', direction: 'inbound',
        sender: 'k@x.example', to: ['forrest@accumarklabs.com'], cc: [], subject: 'COA question',
        body: '<b>not html</b>\nline two' }],
    })
    setup()
    await userEvent.click(await screen.findByRole('button', { name: /COA question/ }))
    const panel = await screen.findByRole('dialog')
    expect(within(panel).getByText(/<b>not html<\/b>/)).toBeInTheDocument()
    expect(crm.getCrmActivity).toHaveBeenCalledWith('wc:1', 'acti_1', 'email')
  })

  it('empty, not configured and unreachable states', async () => {
    setup({ ...base, leads: [], items: [], total: 0 })
    expect(await screen.findByText(/No Close lead found for k@x.example/)).toBeInTheDocument()
  })

  it('shows not configured on 503', async () => {
    setup(new crm.CrmError(503, 'crm_not_configured'))
    expect(await screen.findByText(/CRM not configured/)).toBeInTheDocument()
  })

  it('shows unreachable with retry on 502', async () => {
    setup(new crm.CrmError(502, 'crm_unavailable'))
    expect(await screen.findByText(/Close is unreachable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/customers/CustomerCrmTab.test.tsx`
Expected: FAIL, cannot resolve `@/lib/api-crm`

- [ ] **Step 3: Implement the API client**

`src/lib/api-crm.ts`:

```ts
import { API_BASE_URL, getBearerHeaders } from '@/lib/api'

export type CrmItemType = 'email' | 'call' | 'sms' | 'meeting' | 'note'

export interface CrmLead {
  id: string
  name: string
  status: string | null
  owner: string | null
  url: string
  contacts: { name: string; emails: string[]; phones: string[] }[]
  opportunities: {
    status: string | null
    value: number
    value_period: string | null
    confidence: number | null
    expected_date: string | null
  }[]
}

export interface CrmItem {
  id: string
  type: CrmItemType
  at: string | null
  direction: 'inbound' | 'outbound' | null
  who: string
  title: string
  preview: string
  lead_id: string | null
  lead_name: string
  automated: boolean
  support_thread_url: string | null
}

export interface CustomerCrm {
  configured: boolean
  emails_tried: string[]
  leads: CrmLead[]
  items: CrmItem[]
  total: number
  page: number
  page_size: number
  counts: Record<CrmItemType | 'automated', number>
  fetched_at: string
  stale: boolean
  refresh_throttled: boolean
}

export interface CrmEmailMessage {
  id: string
  at: string | null
  direction: string | null
  sender: string
  to: string[]
  cc: string[]
  subject: string
  body: string
}

export interface CrmActivityDetail extends CrmItem {
  messages?: CrmEmailMessage[] | null
  duration?: number | null
  disposition?: string | null
  note?: string | null
  recording_url?: string | null
  phone?: string | null
  text?: string | null
  remote_phone?: string | null
  starts_at?: string | null
  ends_at?: string | null
  attendees?: string[] | null
}

export class CrmError extends Error {
  constructor(public status: number, public code: string | null) {
    super(`crm ${status}${code ? ` ${code}` : ''}`)
  }
}

async function crmFetch<T>(path: string, qs: URLSearchParams): Promise<T> {
  const suffix = qs.toString() ? `?${qs}` : ''
  const r = await fetch(`${API_BASE_URL()}${path}${suffix}`, { headers: getBearerHeaders() })
  if (!r.ok) {
    let code: string | null = null
    try {
      code = (await r.json())?.detail?.code ?? null
    } catch {
      code = null
    }
    throw new CrmError(r.status, code)
  }
  return r.json() as Promise<T>
}

export interface CrmQuery {
  types?: CrmItemType[]
  includeAutomated?: boolean
  page?: number
  refresh?: boolean
}

export function getCustomerCrm(key: string, q: CrmQuery = {}): Promise<CustomerCrm> {
  const qs = new URLSearchParams()
  for (const t of q.types ?? []) qs.append('types', t)
  if (q.includeAutomated) qs.set('include_automated', 'true')
  if (q.page && q.page > 1) qs.set('page', String(q.page))
  if (q.refresh) qs.set('refresh', 'true')
  return crmFetch(`/crm/customers/${encodeURIComponent(key)}`, qs)
}

export function getCrmActivity(key: string, id: string, type: CrmItemType): Promise<CrmActivityDetail> {
  return crmFetch(
    `/crm/customers/${encodeURIComponent(key)}/activities/${encodeURIComponent(id)}`,
    new URLSearchParams({ type })
  )
}
```

- [ ] **Step 4: Implement the drill-down panel**

`src/components/customers/CrmActivityPanel.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { getCrmActivity, type CrmItem } from '@/lib/api-crm'

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : ''

/** Full CRM item. Bodies are plain text (whitespace-pre-wrap), never HTML. */
export function CrmActivityPanel({
  customerKey,
  item,
  onClose,
}: {
  customerKey: string
  item: CrmItem | null
  onClose: () => void
}) {
  const q = useQuery({
    queryKey: ['crm', 'activity', customerKey, item?.id],
    queryFn: () => getCrmActivity(customerKey, item!.id, item!.type),
    enabled: item !== null,
    staleTime: 300_000,
  })
  const d = q.data
  return (
    <Sheet open={item !== null} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{item?.title}</SheetTitle>
          <SheetDescription>
            {item?.lead_name} · {when(item?.at)} {item?.who ? `· ${item.who}` : ''}
          </SheetDescription>
        </SheetHeader>
        {q.isLoading && <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-muted-foreground" />}
        {q.isError && <p className="mt-4 text-sm text-red-500">Could not load this item.</p>}
        {d && (
          <div className="mt-4 flex flex-col gap-4 px-4 text-sm">
            {d.messages?.map(m => (
              <div key={m.id} className="rounded-md border border-border/50 p-3">
                <div className="mb-2 text-xs text-muted-foreground">
                  {m.direction === 'inbound' ? 'From' : 'Sent by'} {m.sender} · to {m.to.join(', ')}
                  {m.cc.length > 0 && ` · cc ${m.cc.join(', ')}`} · {when(m.at)}
                </div>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </div>
            ))}
            {d.type === 'call' && (
              <div className="flex flex-col gap-1">
                <div>
                  {d.direction === 'inbound' ? 'Inbound' : 'Outbound'} call
                  {d.duration ? `, ${Math.max(1, Math.round(d.duration / 60))} min` : ''}
                  {d.disposition ? `, ${d.disposition}` : ''}
                </div>
                {d.note && <p className="whitespace-pre-wrap">{d.note}</p>}
                {d.recording_url && (
                  <a className="text-sky-500 hover:underline" href={d.recording_url} target="_blank" rel="noreferrer">
                    Recording
                  </a>
                )}
              </div>
            )}
            {d.type === 'sms' && <p className="whitespace-pre-wrap">{d.text}</p>}
            {d.type === 'meeting' && (
              <div className="flex flex-col gap-1">
                <div>
                  {when(d.starts_at)}
                  {d.ends_at ? ` to ${when(d.ends_at)}` : ''}
                </div>
                {d.attendees && d.attendees.length > 0 && <div>Attendees: {d.attendees.join(', ')}</div>}
                {d.note && <p className="whitespace-pre-wrap">{d.note}</p>}
              </div>
            )}
            {d.type === 'note' &&
              (d.support_thread_url ? (
                <a className="text-sky-500 hover:underline" href={d.support_thread_url} target="_blank" rel="noreferrer">
                  Open support thread in Plain
                </a>
              ) : (
                <p className="whitespace-pre-wrap">{d.note}</p>
              ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 5: Implement the tab**

`src/components/customers/CustomerCrmTab.tsx`:

```tsx
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  StickyNote,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  CrmError,
  getCustomerCrm,
  type CrmItem,
  type CrmItemType,
  type CustomerCrm,
} from '@/lib/api-crm'
import { CrmActivityPanel } from './CrmActivityPanel'

const CARD = 'rounded-lg border border-border/50 bg-card/30 p-3'
const CHIPS: { key: CrmItemType | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'email', label: 'Emails' },
  { key: 'call', label: 'Calls' },
  { key: 'sms', label: 'SMS' },
  { key: 'meeting', label: 'Meetings' },
  { key: 'note', label: 'Notes' },
]
const ICON = { email: Mail, call: Phone, sms: MessageSquare, meeting: Users, note: StickyNote }
const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'Undated'
const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  return m < 1 ? 'just now' : `${m} min ago`
}

export function CustomerCrmTab({ customerKey }: { customerKey: string }) {
  const [type, setType] = useState<CrmItemType | 'all'>('all')
  const [includeAutomated, setIncludeAutomated] = useState(false)
  const [pages, setPages] = useState(1)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [open, setOpen] = useState<CrmItem | null>(null)
  const qc = useQueryClient()
  const types = type === 'all' ? [] : [type]
  const q = useQuery({
    queryKey: ['crm', customerKey, types, includeAutomated, pages, refreshNonce],
    queryFn: () =>
      getCustomerCrm(customerKey, {
        types,
        includeAutomated,
        page: 1,
        refresh: refreshNonce > 0,
      }).then(async first => {
        if (pages <= 1) return first
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) =>
            getCustomerCrm(customerKey, { types, includeAutomated, page: i + 2 })
          )
        )
        return { ...first, items: [first, ...rest].flatMap(r => r.items) }
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  })

  if (q.error) {
    const e = q.error
    if (e instanceof CrmError && e.code === 'crm_not_configured')
      return <p className="text-sm text-muted-foreground">CRM not configured: CLOSE_API_KEY is not set on the server.</p>
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-red-500">Close is unreachable.</span>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button>
      </div>
    )
  }
  const d: CustomerCrm | undefined = q.data
  if (!d) return <Loader2 className="mx-auto mt-8 h-5 w-5 animate-spin text-muted-foreground" />
  if (d.leads.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No Close lead found for {d.emails_tried.length ? d.emails_tried.join(', ') : 'this customer (no email on file)'}.
      </p>
    )

  const groups: [string, CrmItem[]][] = []
  for (const it of d.items) {
    const k = day(it.at)
    const g = groups.find(([gk]) => gk === k)
    if (g) g[1].push(it)
    else groups.push([k, [it]])
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-2">
        {d.leads.map(l => (
          <section key={l.id} className={CARD}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">{l.name}</h3>
              <a className="text-xs text-sky-500 hover:underline" href={l.url} target="_blank" rel="noreferrer">
                Open in Close
              </a>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              {l.status && <span className="rounded-full bg-emerald-500/15 px-2 text-emerald-700 dark:text-emerald-300">{l.status}</span>}
              {l.owner && <span className="text-muted-foreground">Owner: {l.owner}</span>}
            </div>
            {l.contacts.map(c => (
              <div key={c.name + c.emails.join()} className="mt-2 text-xs text-muted-foreground">
                <span className="text-foreground">{c.name || 'Contact'}</span> {c.emails.join(', ')} {c.phones.join(', ')}
              </div>
            ))}
            {l.opportunities.map((o, i) => (
              <div key={i} className="mt-1 text-xs">
                {o.status} · {money(o.value)}
                {o.value_period && o.value_period !== 'one_time' ? ` / ${o.value_period}` : ''}
                {o.expected_date ? ` · expected ${o.expected_date}` : ''}
              </div>
            ))}
          </section>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {CHIPS.map(c => {
          const n = c.key === 'all' ? null : d.counts[c.key]
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={type === c.key}
              onClick={() => { setType(c.key); setPages(1) }}
              className={cn(
                'rounded-full border px-3 py-0.5 text-xs font-medium',
                type === c.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {c.label}
              {n !== null ? ` ${n}` : ''}
            </button>
          )
        })}
        <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            aria-label="Show automated"
            checked={includeAutomated}
            onCheckedChange={v => { setIncludeAutomated(v); setPages(1) }}
          />
          Show automated ({d.counts.automated})
        </label>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {d.stale && <span className="text-amber-500">Showing data from {ago(d.fetched_at)}</span>}
          {!d.stale && <span>Updated {ago(d.fetched_at)}</span>}
          {d.refresh_throttled && <span>(refreshed moments ago)</span>}
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setRefreshNonce(n => n + 1); void qc.invalidateQueries({ queryKey: ['crm', 'activity', customerKey] }) }}
            disabled={q.isFetching}
          >
            <RefreshCw className={cn('mr-1 h-3 w-3', q.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <section className={CARD}>
        {d.items.length === 0 && <p className="text-sm text-muted-foreground">No activity of this type.</p>}
        {groups.map(([label, items]) => (
          <div key={label} className="mb-3">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
            {items.map(it => {
              const Icon = ICON[it.type]
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setOpen(it)}
                  className="flex w-full items-start gap-2 rounded px-1 py-1.5 text-left hover:bg-muted/30"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  {it.direction === 'inbound' && <ArrowDownLeft className="mt-0.5 h-3 w-3 text-sky-500" />}
                  {it.direction === 'outbound' && <ArrowUpRight className="mt-0.5 h-3 w-3 text-emerald-500" />}
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{it.title}</span>
                    {it.support_thread_url && <span className="ml-2 rounded-full bg-violet-500/15 px-2 text-[10px] text-violet-500">Support thread</span>}
                    <span className="block truncate text-xs text-muted-foreground">
                      {it.who}
                      {it.preview ? ` · ${it.preview}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{time(it.at)}</span>
                </button>
              )
            })}
          </div>
        ))}
        {d.items.length < d.total && (
          <Button variant="ghost" size="sm" onClick={() => setPages(p => p + 1)}>Load more</Button>
        )}
      </section>

      <CrmActivityPanel customerKey={customerKey} item={open} onClose={() => setOpen(null)} />
    </div>
  )
}
```

- [ ] **Step 6: Wire into the customer page**

`src/store/ui-store.ts` lines 145 and 201: change `'orders' | 'dashboard'` to `'orders' | 'dashboard' | 'crm'`.

`src/components/CustomerStatusPage.tsx`:

1. Imports (beside the existing `CustomerDashboard` import):

```tsx
import { CustomerCrmTab } from '@/components/customers/CustomerCrmTab'
import { useAuthStore } from '@/store/auth-store'
```

2. In `CustomerDetailView`, near the other store reads: `const isAdminUser = useAuthStore(state => state.user)?.role === 'admin'`
3. Tabs block: change the `onValueChange` cast to `v as 'orders' | 'dashboard' | 'crm'`; after `<TabsTrigger value="dashboard">Dashboard</TabsTrigger>` add `{isAdminUser && <TabsTrigger value="crm">CRM</TabsTrigger>}`; after the dashboard `TabsContent` add:

```tsx
{isAdminUser && (
  <TabsContent value="crm" className="mt-4">
    <CustomerCrmTab customerKey={`wc:${customerDetailTargetId}`} />
  </TabsContent>
)}
```

4. In `GuestCustomerDetailView`, read `const isAdminUser = useAuthStore(state => state.user)?.role === 'admin'` and after `<CustomerDashboard .../>` add:

```tsx
{isAdminUser && (
  <section className="mt-4">
    <h2 className="mb-2 text-sm font-medium">CRM</h2>
    <CustomerCrmTab customerKey={customerKey} />
  </section>
)}
```

5. If `customerDetailTab === 'crm'` and the user is not admin, the Tabs value falls back: pass `value={customerDetailTab === 'crm' && !isAdminUser ? 'orders' : customerDetailTab}`.

- [ ] **Step 7: Add the admin-visibility test**

Append to `src/test/customer-status-page.test.tsx` (it already renders `CustomerDetailView` with mocked stores; reuse its setup helpers) two cases: with `useAuthStore.setState({ user: { ...user, role: 'standard' } })` there is no `tab` named "CRM"; with role `'admin'` the `tab` named "CRM" exists. Use `screen.queryByRole('tab', { name: 'CRM' })`.

- [ ] **Step 8: Run tests and checks**

Run: `npx vitest run src/components/customers src/test/customer-status-page.test.tsx` (expect all pass), then `npx tsc --noEmit -p .` (clean), then `npx eslint --max-warnings 0 src/lib/api-crm.ts src/components/customers/CustomerCrmTab.tsx src/components/customers/CrmActivityPanel.tsx` (clean), then `npx prettier --write` on the three new files only (do not reformat existing files whole; compare prettier hunk counts against `origin/master` for the two modified files).

- [ ] **Step 9: Commit**

```bash
git add src/lib/api-crm.ts src/components/customers/CustomerCrmTab.tsx src/components/customers/CrmActivityPanel.tsx src/components/customers/CustomerCrmTab.test.tsx src/store/ui-store.ts src/components/CustomerStatusPage.tsx src/test/customer-status-page.test.tsx
git commit -m "feat(crm): CRM tab on the customer page (admin)"
```

---

### Task 6: Live verification and automated-sender list

**Files:**
- Modify: `backend/crm_close/rules.py` (`AUTOMATED_SENDERS`), `backend/.env.example` (document `CLOSE_API_KEY=` with a comment, no value)
- Test: none new (live check)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Read-only live probe with the vault key (never printed)**

From PowerShell, load the key into the environment of one Python process and run a probe that prints only counts and sender addresses on order-notification emails:

```powershell
$env:CLOSE_API_KEY = Get-Secret CLOSE_API_KEY -Vault Accumark -AsPlainText
python -c "import collections,sys; sys.path.insert(0,'backend'); from crm_close.client import get_client; from crm_close import match, timeline; c=get_client(); leads=match.find_leads(['kyle.a.robertson@icloud.com'], c); acts=[a for l in leads for a in c.paginate('activity/', {'lead_id': l['id']})]; print('leads', len(leads), 'acts', len(acts), collections.Counter(a.get('_type') for a in acts).most_common()); print('order-mail senders', collections.Counter((a.get('sender') or '').split('<')[-1].rstrip('>').lower() for a in acts if a.get('_type')=='Email' and timeline.rules.AUTOMATED_SUBJECT.search(a.get('subject') or '')).most_common(5)); items=timeline.build(acts, {l['id']: l['display_name'] for l in leads}); print('items', len(items), 'automated', sum(i['automated'] for i in items))"
Remove-Item Env:CLOSE_API_KEY
```

Expected: 1 lead, activity count > 0, the Email/Note mix printed, sender list printed. Confirm every kept `_type` normalizes (no exception) and that `items` excludes `EmailThread`.

- [ ] **Step 2: Fill `AUTOMATED_SENDERS`** with only addresses from Step 1 that sent order notifications (lowercase), e.g. `frozenset({"<address seen>"})`. If Step 1 shows none beyond the subject match, leave it empty and say so in the commit message.

- [ ] **Step 3: Repeat the probe for one customer with calls and notes** (pick a lead from Close with recent Call/Note activity; print only counts) and open one of each type through `service.activity_detail` to confirm the detail paths (`activity/call/<id>/`, `activity/note/<id>/`, `activity/email/<id>/`) return the fields the panel uses.

- [ ] **Step 4: Document the env var** in `backend/.env.example`:

```
# Close CRM (customer CRM tab). Read-only use; key = a Close user's API key. Admin-only feature.
CLOSE_API_KEY=
```

- [ ] **Step 5: Commit**

```bash
git add backend/crm_close/rules.py backend/.env.example
git commit -m "chore(crm): automated sender list from live data; document CLOSE_API_KEY"
```

- [ ] **Step 6: Devbox click-check** (stack with this branch mounted, `CLOSE_API_KEY` set in the stack backend env from the vault, as admin): open Kyle Robertson's customer page, CRM tab: header shows Valor/Active Customer, timeline loads, automated hidden by default and count shown, chips filter, Refresh updates "Updated just now", an email opens with plain-text body, a note opens. Log in as a standard user: no CRM tab.

## Self-review

- Spec coverage: matching (Task 3), client + GET-only + retry (Task 2), normalization incl. automated, Plain-link notes, HTML-to-text, EmailThread drop (Task 1), caching/refresh/cooldown/stale (Tasks 3-4), routes + response models + 404/502/503 + detail scoping (Task 4), UI header/controls/timeline/panel/states (Task 5), admin gate both sides (Tasks 4-5), guest keys (Task 5 step 6), logging without content (Task 2/4 code), env var docs + live check + AUTOMATED_SENDERS (Task 6).
- Spec deviation recorded: lead `owner` comes from the most recently updated opportunity's `user_name` because Close leads have no built-in owner field (Task 3 `shape_lead`).
- Review Focus tests: no email on file (Task 3 `test_wc_key_with_no_email_anywhere_is_empty_list` + Task 5 empty state copy), missing contacts/opportunities (Task 3), undated activity (Task 1), refresh while down (Task 4 `test_failure_without_cache_is_502_and_with_cache_is_stale`), cross-customer detail (Task 4 `test_detail_scoped_to_customer_leads`).
