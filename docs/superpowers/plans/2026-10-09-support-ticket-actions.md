# Support Ticket Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Mk1 user with a Plain seat reply to, note, and triage (status, snooze, assignee, priority, labels) a customer's Plain tickets from the Support tab.

**Architecture:** Direct writes through the Mk1 backend. A new no-retry `PlainClient.mutate` sends only allowlisted mutations; `seat.py` maps the caller's Mk1 email to a Plain user (the permission); `actions.py` validates, guards duplicates, calls Plain, confirms timed-out replies, and writes one `support_actions` audit row per attempt; routes return the refreshed thread. The frontend adds a composer and header controls to the existing `SupportThreadPanel`, and opens the Support tab to seat holders.

**Tech Stack:** FastAPI + pydantic 2.9, SQLAlchemy 2, httpx (MockTransport in tests), pytest; React 19, TanStack Query, vitest + Testing Library, markdown-it + DOMPurify (existing `renderCommentHtml`).

**Spec:** `docs/superpowers/specs/2026-10-09-support-ticket-actions-design.md`

## Global Constraints

- Additive only: existing response keys keep their names and types; new keys are added beside them.
- Every new response key must be declared on the route's pydantic `response_model` (FastAPI silently drops undeclared keys).
- Writes never retry. `PlainClient.query()` must keep refusing mutation strings.
- Never store message text in the database or logs; never log the API key.
- Reply impersonation uses only the seat resolved from the caller's own email. No endpoint accepts an "as user" field.
- Body limit: 1 to 10,000 characters after trim. Snooze: 5 minutes to 90 days ahead. Duplicate window: 60 s. Reply confirmation window: 3 minutes, first 200 normalised characters.
- Seat cache 300 s (positive and negative); workspace people/labels cache 600 s.
- Table is `support_actions` (not `lims_`: support data, not LIMS data).
- Frontend is npm only (never pnpm). No em dashes in UI copy.
- Backend tests: `cd backend && .venv/Scripts/python -m pytest <files> -q` (in the worktree, use the main checkout's venv: `/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python`). Run one backend suite at a time.
- Frontend: run `npm ci` once in the worktree, then `npx vitest run <files>`; before the final commit `npm run check:all`.

## Review Focus

1. **A 5xx or proxy error after Plain actually sent the reply.** Expect: treated as unconfirmed (re-read the thread), never as a plain failure that invites a resend. Pinned in Task 1 (`test_mutate_5xx_is_unconfirmed`) and Task 5 (`test_reply_timeout_confirmed_when_entry_present`).
2. **A non-admin seat holder on the existing list/detail routes, and a non-admin without a seat.** Expect: the seat holder reads; the other gets 403; Plain being down during seat lookup gives a non-admin 403, never a 500. Pinned in Task 4.
3. **Response keys added in `threads.thread_item` but not declared on `Thread`.** Expect: `assignee_id`, `customer_plain_id`, `label_refs` reach the browser. Pinned in Task 2 (`test_list_declares_new_thread_keys`).
4. **Plain refreshes fail right after a successful write.** Expect: 200 with `detail: null` (the action happened), never an error that invites a repeat. Pinned in Task 5 (`test_action_ok_but_refresh_fails_returns_null_detail`).
5. **Removing a label by its type id instead of the instance id, or assigning to a user who is not a teammate.** Expect: 422 `invalid_input`, no mutation sent. Pinned in Task 5.

## Rulings made while planning

- Spec 3.7 says the thread's `labels` gains objects. `labels: string[]` is read by the list UI and the AI review tools, so the plan keeps it and adds `label_refs: [{id, type_id, name}]` beside it (additive doctrine). Cost if wrong: one extra field.
- Spec section 4 says actions return `{thread}`. A write can succeed while the refresh fails, so actions return `{detail: ThreadDetail | null}`; the UI re-fetches when `detail` is null. Cost if wrong: a rename.
- Spec 3.5 lists `mk1_user_id` as a FK and `id` as bigint. The plan mirrors `customer_ai_reviews` (plain `Integer`, no FK) so SQLite tests and `create_all` behave the same. Cost if wrong: an index-only difference.
- `test_no_mutation_text_anywhere_in_the_package` (client tests) encodes the old read-only rule. It is replaced by `test_query_refuses_mutations` plus `test_mutations_and_queries_are_disjoint`, which keep the protection the old test bought (reads cannot send writes).
- Non-reply actions that time out return 502 `support_unavailable` with audit outcome `unconfirmed` (they are safe to repeat); only replies get the 504 confirmation path.
- 429 on a write means Plain refused it before processing: `SupportUnavailable`, not unconfirmed.

---

### Task 1: Write path in the Plain client and the new GraphQL documents

**Files:**
- Modify: `backend/support_plain/queries.py`
- Modify: `backend/support_plain/client.py`
- Modify: `backend/support_plain/rules.py`
- Test: `backend/tests/test_support_plain_client.py`

**Interfaces:**
- Produces: `queries.USER_BY_EMAIL`, `queries.USERS`, `queries.LABEL_TYPES` (in `queries.ALL`); `queries.REPLY`, `NOTE`, `MARK_DONE`, `MARK_TODO`, `SNOOZE`, `ASSIGN`, `UNASSIGN`, `PRIORITY`, `ADD_LABELS`, `REMOVE_LABELS` (in `queries.MUTATIONS`); `PlainClient.mutate(mutation: str, variables: dict) -> dict` returning the root payload; exceptions `client.PlainActionError(code: str, type_: str, message: str)` and `client.SupportWriteUnconfirmed`; `rules.SEAT_TTL = 300`, `rules.PEOPLE_TTL = 600`, `rules.MAX_BODY = 10_000`, `rules.DUPLICATE_WINDOW = 60`, `rules.CONFIRM_WINDOW = 180`, `rules.CONFIRM_PREFIX = 200`, `rules.SNOOZE_MIN = 300`, `rules.SNOOZE_MAX = 90 * 86400`, `rules.WRITE_TIMEOUT = 20.0`.
- The thread fields selection gains `labels { id labelType { id name } }`, `assignedTo { ... on User { id fullName } ... on MachineUser { id fullName } }`; `_ACTOR` gains `userId` on `UserActor`.

- [ ] **Step 1: Replace the stale read-only test and add the write-path tests**

In `backend/tests/test_support_plain_client.py`, delete `test_no_mutation_text_anywhere_in_the_package` and append:

```python
def test_query_refuses_mutations():
    for m in queries.MUTATIONS:
        with pytest.raises(ValueError):
            _client(lambda req: httpx.Response(200, json={"data": {}})).query(m)


def test_mutations_and_queries_are_disjoint():
    assert not (queries.MUTATIONS & queries.ALL)
    assert all(m.lstrip().startswith("mutation ") for m in queries.MUTATIONS)
    assert all(q.lstrip().startswith("query ") for q in queries.ALL)


def test_mutate_refuses_unknown_documents():
    with pytest.raises(ValueError):
        _client(lambda req: httpx.Response(200, json={"data": {}})).mutate("mutation { x }", {})


def test_mutate_returns_root_payload_once():
    calls = []

    def handler(req):
        calls.append(json.loads(req.content))
        return httpx.Response(200, json={"data": {"markThreadAsDone": {"error": None}}})

    assert _client(handler).mutate(queries.MARK_DONE, {"input": {"threadId": "th_1"}}) == {"error": None}
    assert len(calls) == 1 and calls[0]["variables"] == {"input": {"threadId": "th_1"}}


def test_mutate_error_payload_raises_action_error():
    body = {"data": {"replyToThread": {"error": {"code": "cannot_reply_to_thread", "type": "FORBIDDEN",
                                                 "message": "no"}}}}
    with pytest.raises(c.PlainActionError) as e:
        _client(lambda req: httpx.Response(200, json=body)).mutate(queries.REPLY, {"input": {}})
    assert e.value.code == "cannot_reply_to_thread" and e.value.type_ == "FORBIDDEN"


def test_mutate_never_retries_network_errors():
    calls = []

    def handler(req):
        calls.append(1)
        raise httpx.ReadTimeout("slow")

    with pytest.raises(c.SupportWriteUnconfirmed):
        _client(handler).mutate(queries.REPLY, {"input": {}})
    assert len(calls) == 1


def test_mutate_5xx_is_unconfirmed():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(502)

    with pytest.raises(c.SupportWriteUnconfirmed):
        _client(handler).mutate(queries.REPLY, {"input": {}})
    assert len(calls) == 1


def test_mutate_429_is_unavailable_and_401_is_not_configured():
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(429)).mutate(queries.MARK_DONE, {"input": {}})
    with pytest.raises(c.SupportNotConfigured):
        _client(lambda req: httpx.Response(401)).mutate(queries.MARK_DONE, {"input": {}})


def test_mutate_graphql_errors_are_unavailable():
    with pytest.raises(c.SupportUnavailable):
        _client(lambda req: httpx.Response(200, json={"errors": [{"message": "x"}]})).mutate(queries.MARK_DONE, {})
```

- [ ] **Step 2: Run them to watch them fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_support_plain_client.py -q`
Expected: FAIL with `AttributeError: module 'support_plain.queries' has no attribute 'MUTATIONS'`.

- [ ] **Step 3: Add the documents to `queries.py`**

Change the module docstring to `"""Fixed Plain GraphQL documents (spec 3.2). Reads in ALL, writes in MUTATIONS; the client sends nothing else."""`. In `_THREAD_FIELDS` replace the `labels` and `assignedTo` lines with:

```python
      labels { id labelType { id name } }
      assignedTo { __typename ... on User { id fullName } ... on MachineUser { id fullName } }
```

In `_ACTOR` replace the `UserActor` line with `... on UserActor { userId user { fullName } }`. Then replace the final `ALL = ...` line with:

```python
USER_BY_EMAIL = """query UserByEmail($email: String!) {
  userByEmail(email: $email) { id fullName publicName email isDeleted }
}"""

USERS = """query Users($after: String) {
  users(first: 100, after: $after, filters: {isAssignableToThread: true}) {
    pageInfo { hasNextPage endCursor }
    edges { node { id fullName email isDeleted } }
  }
}"""

LABEL_TYPES = """query LabelTypes($after: String) {
  labelTypes(first: 100, after: $after, filters: {isArchived: false}) {
    pageInfo { hasNextPage endCursor }
    edges { node { id name color } }
  }
}"""

ALL = frozenset({WORKSPACE, CUSTOMER_BY_EMAIL, THREADS, THREAD, USER_BY_EMAIL, USERS, LABEL_TYPES})

_ERR = "error { message type code }"


def _m(name: str, field: str, input_type: str) -> str:
    return "mutation %s($input: %s!) { %s(input: $input) { %s } }" % (name, input_type, field, _ERR)


REPLY = _m("ReplyToThread", "replyToThread", "ReplyToThreadInput")
NOTE = _m("CreateNote", "createNote", "CreateNoteInput")
MARK_DONE = _m("MarkThreadAsDone", "markThreadAsDone", "MarkThreadAsDoneInput")
MARK_TODO = _m("MarkThreadAsTodo", "markThreadAsTodo", "MarkThreadAsTodoInput")
SNOOZE = _m("SnoozeThread", "snoozeThread", "SnoozeThreadInput")
ASSIGN = _m("AssignThread", "assignThread", "AssignThreadInput")
UNASSIGN = _m("UnassignThread", "unassignThread", "UnassignThreadInput")
PRIORITY = _m("ChangeThreadPriority", "changeThreadPriority", "ChangeThreadPriorityInput")
ADD_LABELS = _m("AddLabels", "addLabels", "AddLabelsInput")
REMOVE_LABELS = _m("RemoveLabels", "removeLabels", "RemoveLabelsInput")

MUTATIONS = frozenset({REPLY, NOTE, MARK_DONE, MARK_TODO, SNOOZE, ASSIGN, UNASSIGN, PRIORITY, ADD_LABELS,
                       REMOVE_LABELS})
```

- [ ] **Step 4: Add `mutate` and the exceptions to `client.py`**

Change the module docstring to `"""Thin Plain GraphQL client. Reads retry once; writes (mutate) never retry (spec 3.2)."""`. After `class SupportUnavailable` add:

```python
class SupportWriteUnconfirmed(Exception):
    """A write may or may not have reached Plain (network error, timeout, 5xx). Never retried."""


class PlainActionError(Exception):
    """Plain answered the mutation with an error payload."""

    def __init__(self, code: str, type_: str, message: str) -> None:
        super().__init__(code)
        self.code, self.type_, self.message = code, type_, message
```

Add `from support_plain import queries, rules` (replacing the existing `queries` import) and, inside `PlainClient` after `query`:

```python
    def mutate(self, mutation: str, variables: dict) -> dict:
        if mutation not in queries.MUTATIONS:
            raise ValueError("unknown mutation")
        op = mutation.split()[1].split("(")[0]
        try:
            r = self._http.post(API_URL, json={"query": mutation, "variables": variables},
                                timeout=rules.WRITE_TIMEOUT)
        except httpx.HTTPError as e:
            logger.warning("support_plain.write_unconfirmed op=%s error=%s", op, type(e).__name__)
            raise SupportWriteUnconfirmed(type(e).__name__) from e
        if r.status_code in (401, 403):
            raise SupportNotConfigured()
        if r.status_code >= 500:
            logger.warning("support_plain.write_unconfirmed op=%s status=%s", op, r.status_code)
            raise SupportWriteUnconfirmed(f"http_{r.status_code}")
        if r.status_code >= 400:  # 429 and other 4xx: Plain refused before acting
            logger.warning("support_plain.write_refused op=%s status=%s", op, r.status_code)
            raise SupportUnavailable(f"http_{r.status_code}")
        try:
            body = r.json()
        except ValueError:
            body = None
        if not isinstance(body, dict) or body.get("errors") or not isinstance(body.get("data"), dict):
            logger.warning("support_plain.write_bad_response op=%s", op)
            raise SupportUnavailable("graphql_errors" if isinstance(body, dict) and body.get("errors")
                                     else "bad_response")
        payload = next(iter(body["data"].values()), None)
        if not isinstance(payload, dict):
            raise SupportUnavailable("bad_response")
        err = payload.get("error")
        if err:
            logger.warning("support_plain.write_error op=%s code=%s", op, err.get("code"))
            raise PlainActionError(str(err.get("code") or ""), str(err.get("type") or ""), str(err.get("message") or ""))
        return payload
```

Append to `rules.py`:

```python
SEAT_TTL = 300
PEOPLE_TTL = 600
MAX_BODY = 10_000
DUPLICATE_WINDOW = 60
CONFIRM_WINDOW = 180
CONFIRM_PREFIX = 200
SNOOZE_MIN = 300
SNOOZE_MAX = 90 * 86400
WRITE_TIMEOUT = 20.0
PRIORITY_IN = {"urgent": 0, "high": 1, "normal": 2, "low": 3}
```

- [ ] **Step 5: Run the client tests, then all support_plain tests**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_support_plain_client.py -q` then `.venv/Scripts/python -m pytest tests/test_support_plain_threads.py tests/test_support_plain_routes.py tests/test_support_plain_match.py -q`
Expected: client tests PASS. The other three files PASS too (the extra selected fields are ignored by the fakes).

- [ ] **Step 6: Commit**

```bash
git add backend/support_plain/queries.py backend/support_plain/client.py backend/support_plain/rules.py backend/tests/test_support_plain_client.py
git commit -m "feat(support): no-retry Plain write path and mutation allowlist"
```

---

### Task 2: Thread items carry ids for actions

**Files:**
- Modify: `backend/support_plain/threads.py` (`thread_item`)
- Modify: `backend/support_plain/routes.py` (`Thread` model)
- Test: `backend/tests/test_support_plain_threads.py`, `backend/tests/test_support_plain_routes.py`

**Interfaces:**
- Produces: every thread dict (list and detail) gains `assignee_id: str | None`, `customer_plain_id: str | None`, `label_refs: list[{"id", "type_id", "name"}]`. `labels: list[str]` unchanged.

- [ ] **Step 1: Update the stale shape tests and add the new ones**

In `test_support_plain_threads.py`, change `raw_thread()`'s labels to `[{"id": "l_1", "labelType": {"id": "lt_1", "name": "Lab"}}]`, its `assignedTo` to `{"__typename": "User", "id": "u_9", "fullName": "Lauren"}` and its customer to include `"id": "c_1"` if absent. In `test_thread_item_maps_fields`, add to the expected dict:

```python
"assignee_id": "u_9", "customer_plain_id": "c_1",
"label_refs": [{"id": "l_1", "type_id": "lt_1", "name": "Lab"}],
```

Append:

```python
def test_label_refs_skip_labels_without_ids():
    item = threads.thread_item(raw_thread(labels=[{"labelType": {"name": "Old"}}]), WS)
    assert item["labels"] == ["Old"] and item["label_refs"] == []


def test_unassigned_thread_has_no_assignee_id():
    assert threads.thread_item(raw_thread(assignedTo=None), WS)["assignee_id"] is None
```

(If `raw_thread` does not accept `labels`/`assignedTo` overrides, give it `**overrides` merged last: `return {**base, **overrides}`.)

In `test_support_plain_routes.py`, extend the expected key set in `test_list_dedupes_sorts_counts_and_declares_every_key` with `"assignee_id", "customer_plain_id", "label_refs"`, and append:

```python
def test_list_declares_new_thread_keys(api):
    client, _ = api
    t = client.get("/support/customers/wc:1").json()["threads"][0]
    assert t["customer_plain_id"] == "c_1" and t["label_refs"] == [] and t["assignee_id"] is None
```

- [ ] **Step 2: Run to watch them fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_support_plain_threads.py tests/test_support_plain_routes.py -q`
Expected: FAIL with `KeyError: 'label_refs'` / missing keys.

- [ ] **Step 3: Implement**

In `threads.py` add:

```python
def _label_refs(labels) -> list[dict[str, str]]:
    out = []
    for l in labels or []:
        lt = l.get("labelType") or {}
        if l.get("id") and lt.get("id") and lt.get("name"):
            out.append({"id": l["id"], "type_id": lt["id"], "name": lt["name"]})
    return out
```

and in `thread_item`'s returned dict add:

```python
            "assignee_id": (t.get("assignedTo") or {}).get("id"),
            "customer_plain_id": (t.get("customer") or {}).get("id"),
            "label_refs": _label_refs(t.get("labels")),
```

In `routes.py` add before `class Thread`:

```python
class LabelRef(BaseModel):
    id: str
    type_id: str
    name: str
```

and to `class Thread`:

```python
    assignee_id: Optional[str] = None
    customer_plain_id: Optional[str] = None
    label_refs: list[LabelRef] = []
```

- [ ] **Step 4: Run to watch them pass**

Run: same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/support_plain/threads.py backend/support_plain/routes.py backend/tests/test_support_plain_threads.py backend/tests/test_support_plain_routes.py
git commit -m "feat(support): thread items carry assignee, customer and label ids"
```

---

### Task 3: `support_actions` audit table

**Files:**
- Modify: `backend/models.py` (new model after `CustomerAiReview`)
- Create: `backend/support_plain/audit.py`
- Test: `backend/tests/test_support_plain_audit.py`

**Interfaces:**
- Produces: `models.SupportAction`; `audit.body_hash(text: str) -> str`; `audit.record(db, *, user_id: int, plain_user_id: str | None, customer_key: str, thread_id: str, action: str, args: dict, body: str | None, outcome: str, error_code: str | None = None) -> SupportAction`; `audit.is_duplicate(db, *, user_id: int, thread_id: str, action: str, body: str, now: datetime | None = None) -> bool`.

- [ ] **Step 1: Write the failing tests**

```python
"""support_plain.audit: one row per attempt, no message text, duplicate window."""
from datetime import datetime, timedelta, timezone

from models import SupportAction
from support_plain import audit


def _rec(db, body="hello", outcome="ok", action="reply"):
    return audit.record(db, user_id=7, plain_user_id="u_1", customer_key="wc:1", thread_id="th_1", action=action,
                        args={"status": "done"}, body=body, outcome=outcome)


def test_record_stores_hash_and_length_never_text(db_session):
    row = _rec(db_session, body="secret words")
    assert row.body_sha256 == audit.body_hash("secret words") and row.body_len == 12
    assert "secret" not in repr({c.name: getattr(row, c.name) for c in SupportAction.__table__.columns})


def test_non_text_action_has_null_body_fields(db_session):
    row = _rec(db_session, body=None, action="status")
    assert row.body_sha256 is None and row.body_len is None and row.args == {"status": "done"}


def test_duplicate_within_window_only_for_sent_rows(db_session):
    assert not audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello")
    _rec(db_session, outcome="error")
    assert not audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello")
    _rec(db_session)
    assert audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello")
    assert not audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="note", body="hello")
    assert not audit.is_duplicate(db_session, user_id=8, thread_id="th_1", action="reply", body="hello")
    later = datetime.now(timezone.utc) + timedelta(seconds=61)
    assert not audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello", now=later)


def test_confirmed_after_timeout_counts_as_sent(db_session):
    _rec(db_session, outcome="confirmed_after_timeout")
    assert audit.is_duplicate(db_session, user_id=7, thread_id="th_1", action="reply", body="hello")
```

- [ ] **Step 2: Run to watch them fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_support_plain_audit.py -q`
Expected: FAIL with `ImportError: cannot import name 'SupportAction'`.

- [ ] **Step 3: Implement the model and module**

In `models.py`, after `CustomerAiReview`:

```python
class SupportAction(Base):
    """One attempted Support ticket action from Mk1 (spec 2026-10-09-support-ticket-actions-design.md, 3.5).

    Never stores message text: Plain holds it; the hash and length prove what was sent.
    """
    __tablename__ = "support_actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    mk1_user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    plain_user_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    customer_key: Mapped[str] = mapped_column(String(255), nullable=False)
    thread_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    args: Mapped[dict] = mapped_column(JSONB().with_variant(JSON(), "sqlite"), nullable=False, default=dict)
    body_sha256: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    body_len: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    outcome: Mapped[str] = mapped_column(String(32), nullable=False)
    error_code: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
```

Create `backend/support_plain/audit.py`:

```python
"""support_actions writes and the duplicate guard (spec 3.5)."""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import SupportAction
from support_plain import rules

SENT = ("ok", "confirmed_after_timeout")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def body_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def record(db: Session, *, user_id: int, plain_user_id: str | None, customer_key: str, thread_id: str, action: str,
           args: dict, body: str | None, outcome: str, error_code: str | None = None) -> SupportAction:
    row = SupportAction(at=_now(), mk1_user_id=user_id, plain_user_id=plain_user_id, customer_key=customer_key,
                        thread_id=thread_id, action=action, args=args,
                        body_sha256=body_hash(body) if body is not None else None,
                        body_len=len(body) if body is not None else None, outcome=outcome, error_code=error_code)
    db.add(row)
    db.commit()
    return row


def is_duplicate(db: Session, *, user_id: int, thread_id: str, action: str, body: str,
                 now: datetime | None = None) -> bool:
    since = (now or _now()) - timedelta(seconds=rules.DUPLICATE_WINDOW)
    hit = db.execute(select(SupportAction.id).where(
        SupportAction.mk1_user_id == user_id, SupportAction.thread_id == thread_id, SupportAction.action == action,
        SupportAction.body_sha256 == body_hash(body), SupportAction.outcome.in_(SENT),
        SupportAction.at >= since).limit(1)).first()
    return hit is not None
```

(SQLite returns naive datetimes; the comparison `at >= since` still works because SQLite compares the stored ISO strings. If the duplicate test fails on SQLite for that reason, compare against `since.replace(tzinfo=None)` when `db.bind.dialect.name == "sqlite"`, mirroring `customer_review/store._aware`.)

- [ ] **Step 4: Run to watch them pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_support_plain_audit.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/models.py backend/support_plain/audit.py backend/tests/test_support_plain_audit.py
git commit -m "feat(support): support_actions audit table and duplicate guard"
```

---

### Task 4: Seat resolution, `/support/me`, `/support/workspace`, readers

**Files:**
- Create: `backend/support_plain/seat.py`
- Modify: `backend/support_plain/service.py` (add `paged`, `workspace_people`)
- Modify: `backend/support_plain/routes.py` (read gates, two GET routes)
- Test: `backend/tests/test_support_plain_seat.py`, `backend/tests/test_support_plain_routes.py`

**Interfaces:**
- Consumes: `queries.USER_BY_EMAIL`, `USERS`, `LABEL_TYPES`; `rules.SEAT_TTL`, `PEOPLE_TTL`; `service.CACHE`, `service._client_factory`.
- Produces: `seat.Seat(plain_user_id: str, full_name: str, public_name: str, email: str)` (frozen dataclass); `seat.resolve(email: object) -> Seat | None`; `seat.SeatUser(user, seat)` (dataclass); FastAPI dependencies `seat.require_seat -> SeatUser` and `seat.require_support_reader -> user`; `service.paged(client, query: str, root: str) -> list[dict]`; `service.workspace_people() -> {"teammates": [{"plain_user_id", "name", "email"}], "label_types": [{"id", "name", "color"}]}`.

- [ ] **Step 1: Write the failing seat tests**

`backend/tests/test_support_plain_seat.py`:

```python
"""support_plain.seat: Mk1 email -> Plain user, cached both ways, fails closed."""
import pytest

from support_plain import client as plain_client
from support_plain import queries, seat, service


class Users:
    def __init__(self, users=None, fail=False):
        self.users, self.fail, self.calls = users or {}, fail, []

    def query(self, q, variables=None):
        assert q == queries.USER_BY_EMAIL
        self.calls.append(variables["email"])
        if self.fail:
            raise plain_client.SupportUnavailable("http_503")
        return {"userByEmail": self.users.get(variables["email"])}


@pytest.fixture
def plain(monkeypatch):
    box = {"p": Users({"sam@accumark.example": {"id": "u_1", "fullName": "Sam Parker", "publicName": "Sam",
                                                "email": "sam@accumark.example", "isDeleted": False},
                       "gone@accumark.example": {"id": "u_2", "fullName": "Gone", "publicName": "Gone",
                                                 "email": "gone@accumark.example", "isDeleted": True}})}
    monkeypatch.setattr(service, "_client_factory", lambda: box["p"])
    service.CACHE.drop("")
    return box


def test_match_is_case_insensitive_and_cached(plain):
    s = seat.resolve("Sam@Accumark.example ")
    assert s == seat.Seat("u_1", "Sam Parker", "Sam", "sam@accumark.example")
    assert seat.resolve("sam@accumark.example") == s and plain["p"].calls == ["sam@accumark.example"]


def test_unknown_deleted_and_non_string_emails_have_no_seat(plain):
    assert seat.resolve("nobody@x.example") is None
    assert seat.resolve("gone@accumark.example") is None
    assert seat.resolve(None) is None and seat.resolve(object()) is None
    seat.resolve("nobody@x.example")
    assert plain["p"].calls.count("nobody@x.example") == 1  # negative result cached


def test_plain_down_raises(plain):
    plain["p"] = Users(fail=True)
    with pytest.raises(plain_client.SupportUnavailable):
        seat.resolve("sam@accumark.example")
```

- [ ] **Step 2: Add the failing route tests**

In `test_support_plain_routes.py`, extend `FakePlain.query`'s op map with `queries.USER_BY_EMAIL: "user", queries.USERS: "users", queries.LABEL_TYPES: "labels"` and these branches before the final thread branch:

```python
        if op == "user":
            u = {"sam@accumark.example": {"id": "u_1", "fullName": "Sam Parker", "publicName": "Sam",
                                          "email": "sam@accumark.example", "isDeleted": False}}
            return {"userByEmail": u.get(variables["email"])}
        if op == "users":
            return {"users": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                              "edges": [{"node": {"id": "u_1", "fullName": "Sam Parker", "email": "sam@accumark.example",
                                                  "isDeleted": False}},
                                        {"node": {"id": "u_2", "fullName": "Gone", "email": "g@x", "isDeleted": True}}]}}
        if op == "labels":
            return {"labelTypes": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                                   "edges": [{"node": {"id": "lt_1", "name": "Lab", "color": "#fff"}}]}}
```

Append:

```python
def _as(email, role="standard"):
    import main
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=3, role=role, email=email)


def test_seat_holder_without_admin_reads(api):
    client, _ = api
    _as("sam@accumark.example")
    assert client.get("/support/customers/wc:1").status_code == 200
    assert client.get("/support/customers/wc:1/threads/th_b").status_code == 200


def test_no_seat_non_admin_is_403_even_when_plain_is_down(api):
    client, fake = api
    _as("nobody@x.example")
    assert client.get("/support/customers/wc:1").status_code == 403
    fake["plain"] = FakePlain(fail=True)
    service.CACHE.drop("")
    assert client.get("/support/customers/wc:1").status_code == 403


def test_me_reports_the_seat(api):
    client, _ = api
    _as("sam@accumark.example")
    assert client.get("/support/me").json() == {"has_seat": True, "plain_user_id": "u_1", "name": "Sam Parker",
                                                "email": "sam@accumark.example", "unavailable": False}
    _as("nobody@x.example", role="admin")
    assert client.get("/support/me").json()["has_seat"] is False


def test_me_when_plain_is_down(api):
    client, fake = api
    fake["plain"] = FakePlain(fail=True)
    _as("sam@accumark.example")
    body = client.get("/support/me").json()
    assert body["has_seat"] is False and body["unavailable"] is True


def test_workspace_needs_a_seat_and_lists_active_teammates(api):
    client, _ = api
    _as("nobody@x.example", role="admin")
    assert client.get("/support/workspace").status_code == 403
    _as("sam@accumark.example")
    body = client.get("/support/workspace").json()
    assert body == {"teammates": [{"plain_user_id": "u_1", "name": "Sam Parker", "email": "sam@accumark.example"}],
                    "label_types": [{"id": "lt_1", "name": "Lab", "color": "#fff"}]}
```

Also in the `api` fixture change the admin override to `MagicMock(id=1, role="admin", email="admin@accumark.example")`.

- [ ] **Step 3: Run to watch them fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_support_plain_seat.py tests/test_support_plain_routes.py -q`
Expected: FAIL (`ModuleNotFoundError: support_plain.seat`; 404 on `/support/me`).

- [ ] **Step 4: Implement `seat.py`**

```python
"""The Plain seat is the permission (spec 3.1): a Mk1 user may act when their login email is an active Plain user."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException

from auth import get_current_user
from support_plain import queries, rules, service
from support_plain.client import SupportNotConfigured, SupportUnavailable

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Seat:
    plain_user_id: str
    full_name: str
    public_name: str
    email: str


@dataclass(frozen=True)
class SeatUser:
    user: Any
    seat: Seat


def resolve(email: object) -> Seat | None:
    if not isinstance(email, str) or not email.strip():
        return None
    e = email.strip().lower()

    def load() -> Seat | None:
        try:
            u = service._client_factory().query(queries.USER_BY_EMAIL, {"email": e})["userByEmail"]
            if not u or u.get("isDeleted"):
                return None
            return Seat(u["id"], u["fullName"], u.get("publicName") or u["fullName"], u["email"])
        except (KeyError, TypeError) as err:
            raise SupportUnavailable("bad_shape") from err

    found, _ = service.CACHE.get_or_load(f"seat:{e}", rules.SEAT_TTL, load)
    return found


def require_seat(user=Depends(get_current_user)) -> SeatUser:
    try:
        found = resolve(getattr(user, "email", None))
    except SupportNotConfigured:
        raise HTTPException(status_code=503, detail={"code": "support_not_configured"})
    except SupportUnavailable:  # fail closed
        raise HTTPException(status_code=502, detail={"code": "support_unavailable"})
    if found is None:
        raise HTTPException(status_code=403, detail={"code": "no_plain_seat"})
    return SeatUser(user, found)


def require_support_reader(user=Depends(get_current_user)):
    if user.role == "admin":
        return user
    try:
        found = resolve(getattr(user, "email", None))
    except (SupportNotConfigured, SupportUnavailable):
        found = None
    if found is None:
        raise HTTPException(status_code=403, detail="Admin access or a Plain seat required")
    return user
```

- [ ] **Step 5: Add `paged` and `workspace_people` to `service.py`**

```python
def paged(client, query: str, root: str) -> list[dict]:
    out: list[dict] = []
    after = None
    while len(out) < rules.MAX_THREADS:
        page = client.query(query, {"after": after})[root]
        out.extend(e["node"] for e in page["edges"])
        if not page["pageInfo"]["hasNextPage"]:
            break
        after = page["pageInfo"]["endCursor"]
    return out


def workspace_people() -> dict[str, Any]:
    @_shape_safe
    def load() -> dict[str, Any]:
        client = _client_factory()
        users = paged(client, queries.USERS, "users")
        labels = paged(client, queries.LABEL_TYPES, "labelTypes")
        return {"teammates": [{"plain_user_id": u["id"], "name": u["fullName"], "email": u["email"]}
                              for u in users if not u.get("isDeleted")],
                "label_types": [{"id": l["id"], "name": l["name"], "color": l.get("color")} for l in labels]}

    data, _ = CACHE.get_or_load("people", rules.PEOPLE_TTL, load)
    return data
```

- [ ] **Step 6: Routes**

In `routes.py`: `from support_plain import rules, seat, service` and `from support_plain.seat import require_seat, require_support_reader`; replace both `_u=Depends(require_admin)` with `_u=Depends(require_support_reader)`; drop the now-unused `require_admin` import; change the module docstring to `"""/support/* API. Reads: admin or Plain seat. Writes: Plain seat (spec 2026-10-09 section 4)."""`. Add:

```python
class SupportMe(BaseModel):
    has_seat: bool
    plain_user_id: Optional[str] = None
    name: Optional[str] = None
    email: Optional[str] = None
    unavailable: bool = False


class Teammate(BaseModel):
    plain_user_id: str
    name: str
    email: str


class LabelType(BaseModel):
    id: str
    name: str
    color: Optional[str] = None


class Workspace(BaseModel):
    teammates: list[Teammate]
    label_types: list[LabelType]


@router.get("/me", response_model=SupportMe)
def me(user=Depends(get_current_user)):
    try:
        found = seat.resolve(getattr(user, "email", None))
    except (SupportNotConfigured, SupportUnavailable):
        return {"has_seat": False, "unavailable": True}
    if found is None:
        return {"has_seat": False}
    return {"has_seat": True, "plain_user_id": found.plain_user_id, "name": found.full_name, "email": found.email}


@router.get("/workspace", response_model=Workspace)
def workspace(_su=Depends(require_seat)):
    try:
        return service.workspace_people()
    except (SupportNotConfigured, SupportUnavailable) as e:
        _fail(e)
```

with `from auth import get_current_user`.

- [ ] **Step 7: Run to watch them pass**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_support_plain_seat.py tests/test_support_plain_routes.py -q`
Expected: PASS, including the existing `test_standard_user_is_forbidden_on_both_routes` (a `MagicMock` email is not a `str`, so no seat).

- [ ] **Step 8: Commit**

```bash
git add backend/support_plain/seat.py backend/support_plain/service.py backend/support_plain/routes.py backend/tests/test_support_plain_seat.py backend/tests/test_support_plain_routes.py
git commit -m "feat(support): Plain seat as permission, /support/me and /support/workspace"
```

---

### Task 5: Actions and the POST routes

**Files:**
- Create: `backend/support_plain/actions.py`
- Modify: `backend/support_plain/service.py` (add `invalidate`, `raw_timeline`; `thread_detail.load` uses `raw_timeline`)
- Modify: `backend/support_plain/routes.py` (six POST routes)
- Test: `backend/tests/test_support_plain_actions.py`

**Interfaces:**
- Consumes: Tasks 1 to 4 (`mutate`, exceptions, mutation constants, `rules.*`, `audit.record`, `audit.is_duplicate`, `seat.Seat`, `seat.require_seat`, `service.workspace_people`, thread `customer_plain_id` / `label_refs`).
- Produces: `actions.ActionFailed(status: int, code: str)`; `actions.run(db, user, seat: Seat, customer_key: str, thread_id: str, action: str, body: dict) -> dict | None` (fresh `thread_detail`, or None when the refresh failed after a successful write); `service.invalidate(customer_key, thread_id) -> None`; `service.raw_timeline(client, thread_id) -> list[dict]`; routes `POST /support/customers/{key}/threads/{th}/{reply|note|status|assign|priority|labels}` returning `{"detail": ThreadDetail | null}`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_support_plain_actions.py`:

```python
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
        assert post(client, action, body, th="th_zzz").status_code == 404, action
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
    plain.timeline = [_mine("Thanks  for\nwaiting")]
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
```

- [ ] **Step 2: Run to watch them fail**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_support_plain_actions.py -q`
Expected: FAIL with 404/405 on the POST routes (routes not defined).

- [ ] **Step 3: Service helpers**

In `service.py` add:

```python
def invalidate(customer_key: str, thread_id: str) -> None:
    # drop() is prefix-based: "l:wc:1" also drops "l:wc:12". Extra invalidation only, never stale data.
    CACHE.drop(f"l:{customer_key}")
    CACHE.drop(f"d:{customer_key}:{thread_id}")


def raw_timeline(client, thread_id: str) -> tuple[dict, list[dict]]:
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
    return t, nodes[:rules.MAX_ENTRIES]
```

and replace the body of `thread_detail`'s inner `load()` with:

```python
        client = _client_factory()
        t, nodes = raw_timeline(client, thread_id)
        return {"thread": threads.thread_item(t, _workspace(client)),
                "entries": threads.build_entries(nodes, (t.get("customer") or {}).get("fullName"))}
```

- [ ] **Step 4: `actions.py`**

```python
"""Support ticket actions (spec 3.3-3.6): validate, guard, one Plain write, confirm, audit, refresh."""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from support_plain import audit, queries, rules, service
from support_plain.client import (PlainActionError, SupportNotConfigured, SupportUnavailable,
                                  SupportWriteUnconfirmed)
from support_plain.seat import Seat

logger = logging.getLogger(__name__)
_CODES = {"cannot_reply_to_thread": (403, "not_allowed_to_reply"),
          "missing_user_auth_slack_integration_for_team": (409, "slack_not_connected")}


class ActionFailed(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status, self.code = status, code


def _bad() -> ActionFailed:
    return ActionFailed(422, "invalid_input")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def plain_text(md: str) -> str:
    """Markdown to the text Plain shows in clients that cannot render markdown."""
    t = re.sub(r"!?\[([^\]]*)\]\(([^)]+)\)", r"\1 (\2)", md)
    t = re.sub(r"^\s{0,3}(#{1,6}|>)\s?", "", t, flags=re.M)
    t = re.sub(r"(\*\*|__|\*|_|`)", "", t)
    return t.strip()


def _norm(s: str) -> str:
    return " ".join(s.split())


def _markdown(body: dict) -> str:
    md = (body.get("markdown") or "").strip()
    if not md or len(md) > rules.MAX_BODY:
        raise _bad()
    return md


def _plan(action: str, body: dict, seat: Seat, thread: dict) -> tuple[list[tuple[str, dict]], str | None]:
    tid = thread["id"]
    if action == "reply":
        md = _markdown(body)
        return [(queries.REPLY, {"input": {"threadId": tid, "textContent": plain_text(md), "markdownContent": md,
                                           "impersonation": {"asUser": {"userIdentifier":
                                                                        {"userId": seat.plain_user_id}}}}})], md
    if action == "note":
        md = _markdown(body)
        if not thread.get("customer_plain_id"):
            raise ActionFailed(502, "support_unavailable")
        text = f"{seat.full_name}: {md}"
        return [(queries.NOTE, {"input": {"customerId": thread["customer_plain_id"], "threadId": tid,
                                          "text": plain_text(text), "markdown": text}})], md
    if action == "status":
        s = body.get("status")
        if s == "todo":
            return [(queries.MARK_TODO, {"input": {"threadId": tid}})], None
        if s == "done":
            return [(queries.MARK_DONE, {"input": {"threadId": tid}})], None
        if s != "snoozed" or not body.get("until"):
            raise _bad()
        try:
            until = datetime.fromisoformat(str(body["until"]).replace("Z", "+00:00"))
        except ValueError:
            raise _bad()
        if until.tzinfo is None:
            raise _bad()
        secs = int((until - _now()).total_seconds())
        if not rules.SNOOZE_MIN <= secs <= rules.SNOOZE_MAX:
            raise _bad()
        return [(queries.SNOOZE, {"input": {"threadId": tid, "durationSeconds": secs}})], None
    if action == "assign":
        uid = body.get("plain_user_id")
        if uid is None:
            return [(queries.UNASSIGN, {"input": {"threadId": tid}})], None
        if uid not in {t["plain_user_id"] for t in service.workspace_people()["teammates"]}:
            raise _bad()
        return [(queries.ASSIGN, {"input": {"threadId": tid, "userId": uid}})], None
    if action == "priority":
        p = rules.PRIORITY_IN.get(body.get("priority"))
        if p is None:
            raise _bad()
        return [(queries.PRIORITY, {"input": {"threadId": tid, "priority": p}})], None
    if action == "labels":
        add, remove = list(body.get("add") or []), list(body.get("remove") or [])
        if not add and not remove:
            raise _bad()
        if add and not set(add) <= {l["id"] for l in service.workspace_people()["label_types"]}:
            raise _bad()
        if not set(remove) <= {l["id"] for l in thread.get("label_refs") or []}:
            raise _bad()
        steps = []
        if add:
            steps.append((queries.ADD_LABELS, {"input": {"threadId": tid, "labelTypeIds": add}}))
        if remove:
            steps.append((queries.REMOVE_LABELS, {"input": {"labelIds": remove}}))
        return steps, None
    raise _bad()


def _confirmed(client, thread_id: str, seat: Seat, md: str) -> bool:
    try:
        _, nodes = service.raw_timeline(client, thread_id)
    except (SupportUnavailable, SupportNotConfigured, KeyError, TypeError):
        return False
    want = _norm(plain_text(md))[:rules.CONFIRM_PREFIX]
    cutoff = _now() - timedelta(seconds=rules.CONFIRM_WINDOW)
    for n in nodes:
        actor = n.get("actor") or {}
        if actor.get("__typename") != "UserActor" or actor.get("userId") != seat.plain_user_id:
            continue
        try:
            at = datetime.fromisoformat(n["timestamp"]["iso8601"].replace("Z", "+00:00"))
        except (KeyError, TypeError, ValueError):
            continue
        if at < cutoff:
            continue
        e = n.get("entry") or {}
        text = e.get("textContent") or e.get("chatText") or e.get("slackText") or e.get("slackReplyText") or ""
        if _norm(text).startswith(want):
            return True
    return False


def run(db: Session, user: Any, seat: Seat, customer_key: str, thread_id: str, action: str,
        body: dict) -> dict | None:
    detail = service.thread_detail(customer_key, thread_id)
    if detail is None:
        raise ActionFailed(404, "thread_not_found")
    steps, md = _plan(action, body, seat, detail["thread"])
    args = {k: v for k, v in body.items() if k != "markdown"}

    def rec(outcome: str, code: str | None = None) -> None:
        audit.record(db, user_id=user.id, plain_user_id=seat.plain_user_id, customer_key=customer_key,
                     thread_id=thread_id, action=action, args=args, body=md, outcome=outcome, error_code=code)

    if md is not None and audit.is_duplicate(db, user_id=user.id, thread_id=thread_id, action=action, body=md):
        rec("duplicate")
        raise ActionFailed(409, "duplicate_reply")
    client = service._client_factory()
    try:
        for mutation, variables in steps:
            client.mutate(mutation, variables)
    except PlainActionError as e:
        rec("error", e.code)
        status, code = _CODES.get(e.code) or ((422, "invalid_input") if e.type_.upper() == "VALIDATION"
                                              else (502, "support_unavailable"))
        raise ActionFailed(status, code)
    except SupportWriteUnconfirmed:
        if action == "reply" and _confirmed(client, thread_id, seat, md or ""):
            rec("confirmed_after_timeout")
        else:
            rec("unconfirmed")
            raise ActionFailed(504, "reply_unconfirmed") if action == "reply" else ActionFailed(502, "support_unavailable")
    except SupportNotConfigured:
        rec("error", "not_configured")
        raise ActionFailed(503, "support_not_configured")
    except SupportUnavailable as e:
        rec("error", str(e)[:64])
        raise ActionFailed(502, "support_unavailable")
    else:
        rec("ok")
    logger.info("support_plain.action action=%s thread=%s", action, thread_id)
    service.invalidate(customer_key, thread_id)
    try:
        return service.thread_detail(customer_key, thread_id)
    except (SupportUnavailable, SupportNotConfigured):
        return None
```

- [ ] **Step 5: POST routes**

In `routes.py` add imports `from datetime import datetime`, `from pydantic import Field`, `from sqlalchemy.orm import Session`, `from database import get_db`, `from support_plain import actions` and:

```python
class TextBody(BaseModel):
    markdown: str = Field(max_length=20_000)


class StatusBody(BaseModel):
    status: Literal["todo", "done", "snoozed"]
    until: Optional[datetime] = None


class AssignBody(BaseModel):
    plain_user_id: Optional[str] = None


class PriorityBody(BaseModel):
    priority: Literal["urgent", "high", "normal", "low"]


class LabelsBody(BaseModel):
    add: list[str] = []
    remove: list[str] = []


class ActionResult(BaseModel):
    detail: Optional[ThreadDetail] = None


def _act(action: str, customer_key: str, thread_id: str, body: BaseModel, su, db: Session):
    try:
        out = actions.run(db, su.user, su.seat, customer_key, thread_id, action, body.model_dump(mode="json"))
    except actions.ActionFailed as e:
        raise HTTPException(status_code=e.status, detail={"code": e.code})
    except (SupportNotConfigured, SupportUnavailable) as e:  # the scoping read
        _fail(e)
    return {"detail": out}


_TH = Path(pattern=rules.THREAD_ID_PATTERN)


@router.post("/customers/{customer_key}/threads/{thread_id}/reply", response_model=ActionResult)
def reply(customer_key: str, body: TextBody, thread_id: str = _TH, su=Depends(require_seat),
          db: Session = Depends(get_db)):
    return _act("reply", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/note", response_model=ActionResult)
def note(customer_key: str, body: TextBody, thread_id: str = _TH, su=Depends(require_seat),
         db: Session = Depends(get_db)):
    return _act("note", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/status", response_model=ActionResult)
def status(customer_key: str, body: StatusBody, thread_id: str = _TH, su=Depends(require_seat),
           db: Session = Depends(get_db)):
    return _act("status", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/assign", response_model=ActionResult)
def assign(customer_key: str, body: AssignBody, thread_id: str = _TH, su=Depends(require_seat),
           db: Session = Depends(get_db)):
    return _act("assign", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/priority", response_model=ActionResult)
def priority(customer_key: str, body: PriorityBody, thread_id: str = _TH, su=Depends(require_seat),
             db: Session = Depends(get_db)):
    return _act("priority", customer_key, thread_id, body, su, db)


@router.post("/customers/{customer_key}/threads/{thread_id}/labels", response_model=ActionResult)
def labels(customer_key: str, body: LabelsBody, thread_id: str = _TH, su=Depends(require_seat),
           db: Session = Depends(get_db)):
    return _act("labels", customer_key, thread_id, body, su, db)
```

(A naive `until` from the browser fails pydantic's ISO parse only if malformed; a timezone-less value reaches `_plan` and is rejected there as 422.)

- [ ] **Step 6: Run the new suite, then every support_plain suite**

Run: `cd backend && .venv/Scripts/python -m pytest tests/test_support_plain_actions.py -q`, then `.venv/Scripts/python -m pytest tests/test_support_plain_client.py tests/test_support_plain_threads.py tests/test_support_plain_routes.py tests/test_support_plain_match.py tests/test_support_plain_seat.py tests/test_support_plain_audit.py -q`, then the AI review tools suite that reads Support data: `.venv/Scripts/python -m pytest tests/test_customer_review_tools.py -q`.
Expected: all PASS.

- [ ] **Step 7: Lint and commit**

Run: `cd backend && .venv/Scripts/python -m ruff check support_plain tests/test_support_plain_*.py` (skip if ruff is not configured for the backend).

```bash
git add backend/support_plain/actions.py backend/support_plain/service.py backend/support_plain/routes.py backend/tests/test_support_plain_actions.py
git commit -m "feat(support): reply, note, status, assign, priority and label actions"
```

---

### Task 6: Frontend API, seat hook, and the Support tab for seat holders

**Files:**
- Modify: `src/lib/api-support.ts`
- Create: `src/components/customers/useSupportSeat.ts`
- Modify: `src/components/CustomerStatusPage.tsx` (lines ~783, ~1057-1112, ~1575, ~1615-1630)
- Test: `src/lib/api-support.test.ts`

**Interfaces:**
- Produces (TypeScript): `SupportLabelRef {id, type_id, name}`; `SupportThread` gains optional `assignee_id?: string | null`, `customer_plain_id?: string | null`, `label_refs?: SupportLabelRef[]`; `SupportMe {has_seat, plain_user_id, name, email, unavailable}`; `SupportWorkspace {teammates: {plain_user_id, name, email}[], label_types: {id, name, color: string | null}[]}`; `SupportAction = 'reply' | 'note' | 'status' | 'assign' | 'priority' | 'labels'`; `getSupportMe()`, `getSupportWorkspace()`, `supportAction(key, threadId, action, body): Promise<{detail: SupportThreadDetail | null}>`; hook `useSupportSeat()` returning the TanStack query for `['support', 'me']`.

- [ ] **Step 1: Install and write the failing test**

Run once in the worktree: `npm ci`.

`src/lib/api-support.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { supportAction } from './api-support'

describe('supportAction', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs JSON to the action path and returns the detail', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: null }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await supportAction('wc:1', 'th_b', 'status', { status: 'done' })
    expect(out).toEqual({ detail: null })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/support/customers/wc%3A1/threads/th_b/status')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ status: 'done' })
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('surfaces the error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: { code: 'duplicate_reply' } }), { status: 409 })
      )
    )
    await expect(
      supportAction('wc:1', 'th_b', 'reply', { markdown: 'hi' })
    ).rejects.toMatchObject({ status: 409, code: 'duplicate_reply' })
  })
})
```

- [ ] **Step 2: Run to watch it fail**

Run: `npx vitest run src/lib/api-support.test.ts`
Expected: FAIL with `supportAction is not a function` (no export).

- [ ] **Step 3: Implement the API additions**

Append to `src/lib/api-support.ts` (and add the three optional fields to `SupportThread`):

```ts
export interface SupportLabelRef {
  id: string
  type_id: string
  name: string
}

export interface SupportMe {
  has_seat: boolean
  plain_user_id: string | null
  name: string | null
  email: string | null
  unavailable: boolean
}

export interface SupportWorkspace {
  teammates: { plain_user_id: string; name: string; email: string }[]
  label_types: { id: string; name: string; color: string | null }[]
}

export type SupportAction =
  | 'reply'
  | 'note'
  | 'status'
  | 'assign'
  | 'priority'
  | 'labels'

export function getSupportMe(): Promise<SupportMe> {
  return crmFetch('/support/me', new URLSearchParams())
}

export function getSupportWorkspace(): Promise<SupportWorkspace> {
  return crmFetch('/support/workspace', new URLSearchParams())
}

export function supportAction(
  key: string,
  threadId: string,
  action: SupportAction,
  body: Record<string, unknown>
): Promise<{ detail: SupportThreadDetail | null }> {
  return crmFetch(
    `/support/customers/${encodeURIComponent(key)}/threads/${encodeURIComponent(threadId)}/${action}`,
    new URLSearchParams(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
}
```

`SupportThread` additions:

```ts
  assignee_id?: string | null
  customer_plain_id?: string | null
  label_refs?: SupportLabelRef[]
```

`src/components/customers/useSupportSeat.ts`:

```ts
import { useQuery } from '@tanstack/react-query'
import { getSupportMe } from '@/lib/api-support'

/** Whether the signed-in user has a Plain seat (the Support write permission). */
export function useSupportSeat() {
  return useQuery({
    queryKey: ['support', 'me'],
    queryFn: getSupportMe,
    staleTime: 300_000,
    retry: false,
  })
}
```

- [ ] **Step 4: Open the Support tab to seat holders**

In `CustomerStatusPage.tsx`, in both components that define `isAdminUser` (around lines 783 and 1575), add right after it:

```tsx
  const supportSeat = useSupportSeat()
  const canSupport = isAdminUser || supportSeat.data?.has_seat === true
```

with `import { useSupportSeat } from '@/components/customers/useSupportSeat'`. Then:
- In the `Tabs value` guard, split the condition so `support` falls back only when `!canSupport` and `crm` / `ai-review` keep `!isAdminUser`:

```tsx
        value={
          ((customerDetailTab === 'crm' || customerDetailTab === 'ai-review') && !isAdminUser) ||
          (customerDetailTab === 'support' && !canSupport)
            ? 'orders'
            : customerDetailTab
        }
```

- `{isAdminUser && <TabsTrigger value="support">Support</TabsTrigger>}` becomes `{canSupport && ...}`, and the matching `TabsContent` guard likewise.
- In the guest-checkout view (~1615), move the Support `<section>` out of the `isAdminUser` fragment into its own `{canSupport && (...)}` block, keeping CRM and AI review admin-only.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/lib/api-support.test.ts src/components/customers/CustomerSupportTab.test.tsx` then `npx tsc --noEmit -p .`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-support.ts src/lib/api-support.test.ts src/components/customers/useSupportSeat.ts src/components/CustomerStatusPage.tsx
git commit -m "feat(support): action API client and Support tab for Plain seat holders"
```

---

### Task 7: Composer and header controls in the thread panel

**Files:**
- Create: `src/components/customers/SupportComposer.tsx`
- Create: `src/components/customers/SupportThreadControls.tsx`
- Create: `src/components/customers/support-errors.ts`
- Modify: `src/components/customers/SupportThreadPanel.tsx`
- Test: `src/components/customers/SupportThreadPanel.test.tsx`

**Interfaces:**
- Consumes: Task 6 (`supportAction`, `getSupportWorkspace`, `useSupportSeat`, `SupportThreadDetail`, `SupportLabelRef`), `renderCommentHtml(body, [])` from `@/components/flags/comment-markdown`, `CrmError` from `@/lib/api-crm`.
- Produces: `supportErrorMessage(e: unknown): string`; `<SupportComposer onSubmit={(tab: 'reply' | 'note', markdown: string) => Promise<void>} sendAs={string} threadId={string} threadStatus={SupportStatus} />`; `<SupportThreadControls thread={SupportThread} run={(action, body) => Promise<void>} />`.

- [ ] **Step 1: Write the failing component tests**

`src/components/customers/SupportThreadPanel.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as support from '@/lib/api-support'
import type { SupportThread, SupportThreadDetail } from '@/lib/api-support'
import { CrmError } from '@/lib/api-crm'
import { SupportThreadPanel } from './SupportThreadPanel'

vi.mock('@/lib/api-support', async () => {
  const actual = await vi.importActual<typeof support>('@/lib/api-support')
  return {
    ...actual,
    getSupportThread: vi.fn(),
    getSupportMe: vi.fn(),
    getSupportWorkspace: vi.fn(),
    supportAction: vi.fn(),
  }
})

const thread: SupportThread = {
  id: 'th_b',
  ref: 'T-482',
  title: 'COA late',
  status: 'open',
  priority: 'normal',
  labels: ['Lab'],
  label_refs: [{ id: 'l_1', type_id: 'lt_1', name: 'Lab' }],
  assignee: null,
  assignee_id: null,
  customer_plain_id: 'c_1',
  created_at: null,
  updated_at: null,
  preview: '',
  waiting_since: null,
  plain_url: 'https://app.plain.com/x',
}
const detail: SupportThreadDetail = {
  thread,
  entries: [],
  fetched_at: new Date().toISOString(),
  stale: false,
}

function setup(hasSeat = true) {
  vi.mocked(support.getSupportThread).mockResolvedValue(detail)
  vi.mocked(support.getSupportMe).mockResolvedValue({
    has_seat: hasSeat,
    plain_user_id: hasSeat ? 'u_1' : null,
    name: hasSeat ? 'Sam Parker' : null,
    email: hasSeat ? 'sam@accumark.example' : null,
    unavailable: false,
  })
  vi.mocked(support.getSupportWorkspace).mockResolvedValue({
    teammates: [{ plain_user_id: 'u_1', name: 'Sam Parker', email: 's@x' }],
    label_types: [{ id: 'lt_2', name: 'Shipping', color: null }],
  })
  vi.mocked(support.supportAction).mockResolvedValue({ detail })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SupportThreadPanel customerKey="wc:1" thread={thread} onClose={() => {}} />
    </QueryClientProvider>
  )
}

describe('SupportThreadPanel actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('hides controls without a seat and explains why', async () => {
    setup(false)
    expect(await screen.findByText(/Replying needs a Plain account/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Send as/ })).toBeNull()
  })

  it('reply asks once, sends, and clears the draft', async () => {
    setup()
    const box = await screen.findByRole('textbox', { name: /Reply/ })
    await userEvent.type(box, 'Thanks for waiting')
    await userEvent.click(screen.getByRole('button', { name: 'Send as Sam Parker' }))
    expect(support.supportAction).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Yes, send' }))
    await waitFor(() =>
      expect(support.supportAction).toHaveBeenCalledWith('wc:1', 'th_b', 'reply', {
        markdown: 'Thanks for waiting',
      })
    )
    await waitFor(() => expect(box).toHaveValue(''))
    expect(localStorage.getItem('mk1.supportDraft.th_b.reply')).toBeNull()
  })

  it('send is disabled when empty', async () => {
    setup()
    expect(
      await screen.findByRole('button', { name: 'Send as Sam Parker' })
    ).toBeDisabled()
  })

  it('a failed reply keeps the draft and shows the reason', async () => {
    setup()
    vi.mocked(support.supportAction).mockRejectedValueOnce(
      new CrmError(403, 'not_allowed_to_reply')
    )
    const box = await screen.findByRole('textbox', { name: /Reply/ })
    await userEvent.type(box, 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send as Sam Parker' }))
    await userEvent.click(screen.getByRole('button', { name: 'Yes, send' }))
    expect(await screen.findByText(/hasn't allowed Mk1 to send as you/)).toBeInTheDocument()
    expect(box).toHaveValue('hello')
  })

  it('note sends without confirmation', async () => {
    setup()
    await userEvent.click(await screen.findByRole('tab', { name: 'Note' }))
    await userEvent.type(screen.getByRole('textbox', { name: /Note/ }), 'check COA')
    await userEvent.click(screen.getByRole('button', { name: 'Add internal note' }))
    await waitFor(() =>
      expect(support.supportAction).toHaveBeenCalledWith('wc:1', 'th_b', 'note', {
        markdown: 'check COA',
      })
    )
  })

  it('draft survives closing the panel', async () => {
    setup()
    await userEvent.type(await screen.findByRole('textbox', { name: /Reply/ }), 'half')
    expect(localStorage.getItem('mk1.supportDraft.th_b.reply')).toBe('half')
  })

  it('status, priority, assignee and labels call their actions', async () => {
    setup()
    // Controls disable while an action is in flight and until the workspace loads.
    const ready = async (label: string) => {
      const el = await screen.findByLabelText(label)
      await waitFor(() => expect(el).toBeEnabled())
      return el
    }
    await userEvent.selectOptions(await ready('Status'), 'done')
    await waitFor(() =>
      expect(support.supportAction).toHaveBeenCalledWith('wc:1', 'th_b', 'status', { status: 'done' })
    )
    await userEvent.selectOptions(await ready('Priority'), 'urgent')
    await userEvent.selectOptions(await ready('Assignee'), 'u_1')
    await ready('Status')
    await userEvent.click(screen.getByRole('button', { name: 'Remove label Lab' }))
    await userEvent.selectOptions(await ready('Add label'), 'lt_2')
    await ready('Status')
    const calls = vi.mocked(support.supportAction).mock.calls.map(c => [c[2], c[3]])
    expect(calls).toEqual(
      expect.arrayContaining([
        ['priority', { priority: 'urgent' }],
        ['assign', { plain_user_id: 'u_1' }],
        ['labels', { remove: ['l_1'] }],
        ['labels', { add: ['lt_2'] }],
      ])
    )
  })

  it('snooze presets send an until in the future', async () => {
    setup()
    await userEvent.selectOptions(await screen.findByLabelText('Status'), 'snooze:1h')
    await waitFor(() => expect(support.supportAction).toHaveBeenCalled())
    const body = vi.mocked(support.supportAction).mock.calls[0][3] as { status: string; until: string }
    expect(body.status).toBe('snoozed')
    expect(new Date(body.until).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000)
  })
})
```

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run src/components/customers/SupportThreadPanel.test.tsx`
Expected: FAIL (no "Replying needs a Plain account" text, no Send button).

- [ ] **Step 3: `support-errors.ts`**

```ts
import { CrmError } from '@/lib/api-crm'

const MESSAGES: Record<string, string> = {
  not_allowed_to_reply:
    "Plain hasn't allowed Mk1 to send as you yet. Ask an admin to add you to the Mk1 key's impersonation allow list.",
  slack_not_connected:
    'This is a Slack thread and your Slack is not connected in Plain. Reply from Plain or connect Slack there.',
  duplicate_reply: 'Already sent a moment ago.',
  reply_unconfirmed: 'Not confirmed. Check the thread before sending again.',
  no_plain_seat: 'You need a Plain account under your Mk1 email to do this.',
  invalid_input: 'Plain did not accept that. Check the values and try again.',
  thread_not_found: 'This ticket is no longer on this customer.',
  support_not_configured: 'Support actions are not configured on the server.',
}

export function supportErrorMessage(e: unknown): string {
  if (e instanceof CrmError && e.code && MESSAGES[e.code]) return MESSAGES[e.code]
  return 'Plain is unavailable right now. Try again in a moment.'
}
```

- [ ] **Step 4: `SupportComposer.tsx`**

```tsx
import { useEffect, useState, type KeyboardEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { renderCommentHtml } from '@/components/flags/comment-markdown'
import type { SupportStatus } from '@/lib/api-support'
import { supportErrorMessage } from './support-errors'

type Tab = 'reply' | 'note'
const MAX = 10_000
const draftKey = (threadId: string, tab: Tab) => `mk1.supportDraft.${threadId}.${tab}`

function readDraft(threadId: string, tab: Tab): string {
  try {
    return localStorage.getItem(draftKey(threadId, tab)) ?? ''
  } catch {
    return ''
  }
}

function writeDraft(threadId: string, tab: Tab, text: string) {
  try {
    if (text) localStorage.setItem(draftKey(threadId, tab), text)
    else localStorage.removeItem(draftKey(threadId, tab))
  } catch {
    // storage blocked: drafts just won't persist
  }
}

/** Reply to the customer (impersonated) or add an internal note. */
export function SupportComposer({
  threadId,
  threadStatus,
  sendAs,
  onSubmit,
}: {
  threadId: string
  threadStatus: SupportStatus
  sendAs: string
  onSubmit: (tab: Tab, markdown: string) => Promise<void>
}) {
  const [tab, setTab] = useState<Tab>('reply')
  const [text, setText] = useState(() => readDraft(threadId, 'reply'))
  const [preview, setPreview] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmedOnce, setConfirmedOnce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setText(readDraft(threadId, tab))
    setConfirming(false)
    setError(null)
  }, [threadId, tab])

  const update = (v: string) => {
    setText(v)
    writeDraft(threadId, tab, v)
  }
  const empty = text.trim().length === 0 || text.trim().length > MAX

  const send = async () => {
    if (empty || busy) return
    if (tab === 'reply' && !confirmedOnce && !confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(tab, text.trim())
      setConfirmedOnce(true)
      setConfirming(false)
      update('')
    } catch (e) {
      setError(supportErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    }
  }

  const label = tab === 'reply' ? 'Reply' : 'Note'
  return (
    <div className="sticky bottom-0 border-t bg-background p-3">
      <div role="tablist" className="mb-2 flex gap-1 text-xs">
        {(['reply', 'note'] as const).map(t => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-2 py-1',
              tab === t ? 'bg-accent font-medium' : 'text-muted-foreground'
            )}
          >
            {t === 'reply' ? 'Reply' : 'Note'}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPreview(p => !p)}
          className="ml-auto rounded-md px-2 py-1 text-muted-foreground"
        >
          {preview ? 'Edit' : 'Preview'}
        </button>
      </div>
      {preview ? (
        <div
          className="min-h-24 rounded-md border p-2 text-sm [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4"
          // Sanitised by renderCommentHtml (markdown-it html:false + DOMPurify).
          dangerouslySetInnerHTML={{ __html: renderCommentHtml(text, []) }}
        />
      ) : (
        <textarea
          aria-label={label}
          value={text}
          onChange={e => update(e.target.value)}
          onKeyDown={onKey}
          rows={4}
          className={cn(
            'w-full resize-y rounded-md border p-2 text-sm',
            tab === 'note' && 'border-amber-500/40 bg-amber-500/10'
          )}
          placeholder={
            tab === 'reply'
              ? 'Write to the customer. Markdown works.'
              : 'Internal note, only the team sees this.'
          }
        />
      )}
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        {confirming ? (
          <>
            <span className="text-xs">Send this reply to the customer?</span>
            <Button size="sm" onClick={() => void send()} disabled={busy}>
              {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Yes, send
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => void send()} disabled={empty || busy}>
            {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {tab === 'reply' ? `Send as ${sendAs}` : 'Add internal note'}
          </Button>
        )}
        {tab === 'reply' && threadStatus !== 'open' && (
          <span className="text-xs text-muted-foreground">
            Replying moves this ticket back to Todo.
          </span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: `SupportThreadControls.tsx`**

```tsx
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import {
  getSupportWorkspace,
  type SupportAction,
  type SupportThread,
} from '@/lib/api-support'
import { supportErrorMessage } from './support-errors'

type Run = (action: SupportAction, body: Record<string, unknown>) => Promise<void>

function at8(daysAhead: number, weekday?: number): string {
  const d = new Date()
  if (weekday !== undefined) {
    const delta = (weekday - d.getDay() + 7) % 7 || 7
    d.setDate(d.getDate() + delta)
  } else d.setDate(d.getDate() + daysAhead)
  d.setHours(8, 0, 0, 0)
  return d.toISOString()
}

const SNOOZE: Record<string, () => string> = {
  'snooze:1h': () => new Date(Date.now() + 3600_000).toISOString(),
  'snooze:tomorrow': () => at8(1),
  'snooze:monday': () => at8(0, 1),
}

const sel = 'rounded-md border bg-background px-2 py-1 text-xs'

/** Status, snooze, assignee, priority and labels for one ticket. Each applies immediately. */
export function SupportThreadControls({ thread, run }: { thread: SupportThread; run: Run }) {
  const ws = useQuery({
    queryKey: ['support', 'workspace'],
    queryFn: getSupportWorkspace,
    staleTime: 600_000,
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [customUntil, setCustomUntil] = useState('')

  const act = async (key: string, action: SupportAction, body: Record<string, unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await run(action, body)
    } catch (e) {
      setError(supportErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const onStatus = (v: string) => {
    if (v === 'open') return void act('status', 'status', { status: 'todo' })
    if (v === 'done') return void act('status', 'status', { status: 'done' })
    if (SNOOZE[v]) return void act('status', 'status', { status: 'snoozed', until: SNOOZE[v]() })
    if (v === 'snooze:custom') setCustomUntil(' ')
  }

  const refs = thread.label_refs ?? []
  const unused = (ws.data?.label_types ?? []).filter(
    lt => !refs.some(r => r.type_id === lt.id)
  )
  return (
    <div className="flex flex-col gap-2 border-b px-4 pb-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          Status
          <select
            aria-label="Status"
            className={sel}
            value={thread.status === 'snoozed' ? 'snoozed' : thread.status}
            onChange={e => onStatus(e.target.value)}
            disabled={busy !== null}
          >
            <option value="open">Todo</option>
            <option value="done">Done</option>
            {thread.status === 'snoozed' && <option value="snoozed">Snoozed</option>}
            <option value="snooze:1h">Snooze 1 hour</option>
            <option value="snooze:tomorrow">Snooze until tomorrow 8 am</option>
            <option value="snooze:monday">Snooze until Monday 8 am</option>
            <option value="snooze:custom">Snooze until...</option>
          </select>
        </label>
        {customUntil && (
          <span className="flex items-center gap-1">
            <input
              type="datetime-local"
              aria-label="Snooze until"
              className={sel}
              onChange={e => setCustomUntil(e.target.value)}
            />
            <button
              type="button"
              className={sel}
              disabled={customUntil.trim() === ''}
              onClick={() => {
                const until = new Date(customUntil).toISOString()
                setCustomUntil('')
                void act('status', 'status', { status: 'snoozed', until })
              }}
            >
              Snooze
            </button>
          </span>
        )}
        <label className="flex items-center gap-1">
          Priority
          <select
            aria-label="Priority"
            className={sel}
            value={thread.priority}
            onChange={e => void act('priority', 'priority', { priority: e.target.value })}
            disabled={busy !== null}
          >
            {(['urgent', 'high', 'normal', 'low'] as const).map(p => (
              <option key={p} value={p}>
                {p[0].toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Assignee
          <select
            aria-label="Assignee"
            className={sel}
            value={thread.assignee_id ?? ''}
            onChange={e =>
              void act('assign', 'assign', { plain_user_id: e.target.value || null })
            }
            disabled={busy !== null || !ws.data}
          >
            <option value="">Unassigned</option>
            {ws.data?.teammates.map(t => (
              <option key={t.plain_user_id} value={t.plain_user_id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {refs.map(r => (
          <span key={r.id} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
            {r.name}
            <button
              type="button"
              aria-label={`Remove label ${r.name}`}
              onClick={() => void act('labels', 'labels', { remove: [r.id] })}
              disabled={busy !== null}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <select
          aria-label="Add label"
          className={sel}
          value=""
          onChange={e => {
            if (e.target.value) void act('labels', 'labels', { add: [e.target.value] })
          }}
          disabled={busy !== null || !ws.data}
        >
          <option value="">+ Label</option>
          {unused.map(lt => (
            <option key={lt.id} value={lt.id}>
              {lt.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-red-500">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 6: Wire both into `SupportThreadPanel.tsx`**

Add imports:

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { supportAction, type SupportAction } from '@/lib/api-support'
import { SupportComposer } from './SupportComposer'
import { SupportThreadControls } from './SupportThreadControls'
import { useSupportSeat } from './useSupportSeat'
```

Inside the component after `const d = q.data`:

```tsx
  const qc = useQueryClient()
  const seat = useSupportSeat()
  const hasSeat = seat.data?.has_seat === true
  const current = d?.thread ?? thread
  const run = async (action: SupportAction, body: Record<string, unknown>) => {
    if (!thread) return
    const out = await supportAction(customerKey, thread.id, action, body)
    const key = ['support', 'thread', customerKey, thread.id]
    if (out.detail) qc.setQueryData(key, out.detail)
    else void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['support', customerKey] })
  }
```

Render, right after `</SheetHeader>`:

```tsx
        {current && hasSeat && <SupportThreadControls thread={current} run={run} />}
        {seat.data && !hasSeat && (
          <p className="px-4 text-xs text-muted-foreground">
            Replying needs a Plain account under your Mk1 email.
          </p>
        )}
```

and as the last child inside `ResizableSheetContent`:

```tsx
        {current && hasSeat && (
          <SupportComposer
            threadId={current.id}
            threadStatus={current.status}
            sendAs={seat.data?.name ?? 'you'}
            onSubmit={(tab, markdown) => run(tab, { markdown })}
          />
        )}
```

- [ ] **Step 7: Run to watch them pass, then the neighbours**

Run: `npx vitest run src/components/customers/SupportThreadPanel.test.tsx src/components/customers/CustomerSupportTab.test.tsx src/lib/api-support.test.ts`
Expected: PASS. (`CustomerSupportTab.test.tsx` mocks only two api functions; if its panel now calls the unmocked `getSupportMe`, add `getSupportMe: vi.fn().mockResolvedValue({ has_seat: false, plain_user_id: null, name: null, email: null, unavailable: false })` to its mock. That is the stale-test fix, not a behaviour change.)

- [ ] **Step 8: Full gate and commit**

Run: `npm run check:all`
Expected: typecheck, lint, ast:lint, format and tests pass (format with `npm run format` first if only formatting fails).

```bash
git add src/components/customers/SupportComposer.tsx src/components/customers/SupportThreadControls.tsx src/components/customers/support-errors.ts src/components/customers/SupportThreadPanel.tsx src/components/customers/SupportThreadPanel.test.tsx src/components/customers/CustomerSupportTab.test.tsx
git commit -m "feat(support): reply/note composer and ticket controls in the thread panel"
```

---

## After the tasks (not code)

Rollout per spec section 7 is the Handler's and the deploy skill's: create the Plain key with the listed permissions and the impersonation allow list, deploy, swap `PLAIN_API_KEY` with a dated backup, smoke on a test thread, retire `Mira_APIkey_plain`.
