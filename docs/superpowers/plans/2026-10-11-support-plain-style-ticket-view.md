# Plain-Style Support Ticket View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Support ticket slide-out to read and work like Plain's ticket screen: a two-column view (conversation plus details sidebar), Plain-style cards and events, a bottom action bar, and Plain's palette in light and dark.

**Architecture:**
- **Backend (additive):** the thread detail and the timeline entries gain the data the sidebar and cards need (status detail, assignees, tier, thread fields with schema labels, customer block, avatars, email to/from, markdown, structured events). Actions gain the "waiting" statuses and additional assignees.
- **Frontend:** the panel splits into `TicketTimeline`, `TicketSidebar` and `TicketActionBar` under a `.plain-view` wrapper with scoped CSS variables. Two columns use Tailwind 4 container queries (`@container` / `@min-[820px]:`).

**Tech Stack:** FastAPI + pydantic 2.9, httpx (MockTransport fakes), pytest; React 19, TanStack Query, Tailwind 4, vitest + Testing Library, lucide-react, the existing `renderCommentHtml` sanitizer.

**Spec:** `docs/superpowers/specs/2026-10-11-support-plain-style-ticket-view-design.md`

## Global Constraints

- **Additive data:** existing response keys keep their names and types; `entry.text` is unchanged. Every new key is declared on its pydantic response model, because FastAPI silently drops undeclared keys.
- **Writes** use the 1.44.0 path unchanged: `PlainClient.mutate` (no retry), seat permission, customer scoping, one `support_actions` row per attempt.
- **Theme:** Plain's palette lives only inside `.plain-view` (the ticket slide-out), with light and dark sets switched by Mk1's `.dark` class.
- **Layout:**
  - Two columns at a container width of 820 px or more; the sidebar is 300 px.
  - Below that, a **Details** toggle.
  - The slide-out defaults to 1,100 px, stored under its own key `mk1.supportSlideoutWidth`, so the CRM slide-out keeps its own width.
- **Conversation:** oldest first by default, scrolled to the newest on open. The newest-first toggle stays (`mk1.supportConversationOrder`).
- **Keys:** R and N fire only when focus is not in an input, textarea, select or contenteditable element. Esc closes the composer and keeps the draft.
- **Read-only:** thread fields and customer details.
- **Frontend tooling:** npm only. No em dashes in UI copy.
- **Backend tests:** `cd backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python -m pytest <files> -q`. Run one suite at a time.
- **Frontend tests:** run `npm ci` once in the worktree, then `npx vitest run <files>`. The gate is `npx tsc --noEmit -p <abs>/tsconfig.json` plus eslint on the changed files; master's `check:all` fails for pre-existing reasons. Do not run Prettier on `CustomerSupportTab.tsx` if it reformats unrelated lines.

## Review Focus

1. **A thread whose Plain data lacks the new fields** (older threads, no tier, no thread fields, `statusDetail` null, a customer with no company or external id).
   - Expect: the sidebar shows muted placeholders and nothing throws.
   - Pinned in Task 1: `test_detail_extras_tolerate_missing_fields`.
2. **The thread field schema query fails or is denied for the key.**
   - Expect: the fields render with their keys as labels and the panel still loads.
   - Pinned in Task 1: `test_field_schema_failure_falls_back_to_keys`.
3. **A note mentioning someone, and an automated email with no author name.**
   - Expect: the mention renders as a chip, and the automated email is collapsed with a label rather than shown as a blank author.
   - Pinned in Task 3: `renders mention chips and collapses automated mail`.
4. **Pressing R or N while typing in the composer.**
   - Expect: the letter is typed, and no composer switch happens.
   - Pinned in Task 5: `R and N do nothing while typing`.
5. **Removing an additional assignee who isn't on the thread, or adding a non-teammate.**
   - Expect: 422 `invalid_input`, no mutation sent.
   - Pinned in Task 2: `test_assignees_validation`.

---

### Task 1: Detail data (queries, builders, response models)

**Files:**
- Modify: `backend/support_plain/queries.py`
- Modify: `backend/support_plain/threads.py`
- Modify: `backend/support_plain/service.py` (`thread_detail.load`, new `_field_schemas`)
- Modify: `backend/support_plain/routes.py` (models)
- Modify: `backend/tests/test_support_plain_routes.py`, `backend/tests/test_support_plain_actions.py` (fakes answer the new schema query)
- Test: `backend/tests/test_support_plain_detail.py` (new)

**Interfaces:**
- Produces:
  - `queries.THREAD_FIELD_SCHEMAS` (in `ALL`, paged under root `threadFieldSchemas`, nodes `{key label order}`).
  - `threads.status_detail(t) -> {"kind", "label", "until"}`
  - `threads.assignees(t) -> [{"plain_user_id", "name", "avatar_url", "primary"}]`
  - `threads.fields(t, schemas) -> [{"key", "label", "value"}]`
  - `threads.customer_block(t) -> dict | None`
  - `threads.detail_extras(t, schemas) -> {"status_detail", "assignees", "tier", "fields", "customer"}`
  - Entries gain `author_avatar_url`, `automated`, `email_to`, `email_from`, `markdown`, `event: {icon, actor, text} | None`.
  - The detail `thread` object carries the `detail_extras` keys.

- [ ] **Step 1: Failing tests**

`backend/tests/test_support_plain_detail.py`:

```python
"""Plain-style view data: status detail, assignees, tier, fields, customer, entry extras (spec 3)."""
import pytest

from support_plain import threads

SCHEMAS = [{"key": "wp_user_id", "label": "WP User ID", "order": 2},
           {"key": "verification_code", "label": "Verification Code", "order": 1},
           {"key": "total_spent", "label": "Total Spent", "order": 3}]


def raw(**kw):
    t = {"id": "th_1", "status": "TODO", "customer": {"id": "c_1", "fullName": "Lilia Billones"}}
    t.update(kw)
    return t


@pytest.mark.parametrize("typename,status,kind,label", [
    ("ThreadStatusDetailCreated", "TODO", "needs_first_response", "Needs first response"),
    ("ThreadStatusDetailNewReply", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailUnsnoozed", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailThreadLinkUpdated", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailLinearUpdated", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailThreadDiscussionResolved", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailReplied", "TODO", "in_progress", "In progress"),
    ("ThreadStatusDetailInProgress", "TODO", "in_progress", "In progress"),
    ("ThreadStatusDetailWaitingForCustomer", "SNOOZED", "waiting_for_customer", "Waiting for customer"),
    ("ThreadStatusDetailWaitingIndefinitely", "SNOOZED", "waiting", "Waiting"),
    ("ThreadStatusDetailDoneManuallySet", "DONE", "done", "Done"),
    ("ThreadStatusDetailIgnored", "DONE", "done", "Done"),
    ("ThreadStatusDetailDoneAutomaticallySet", "DONE", "done_auto", "Done automatically"),
])
def test_status_detail_labels(typename, status, kind, label):
    d = threads.status_detail(raw(status=status, statusDetail={"__typename": typename}))
    assert (d["kind"], d["label"]) == (kind, label)


def test_waiting_until_carries_the_date():
    d = threads.status_detail(raw(status="SNOOZED", statusDetail={
        "__typename": "ThreadStatusDetailWaitingForDuration", "waitingUntil": {"iso8601": "2026-10-20T13:00:00.000Z"}}))
    assert d["kind"] == "waiting_until" and d["until"] == "2026-10-20T13:00:00.000Z"
    assert d["label"].startswith("Waiting until ")


@pytest.mark.parametrize("status,kind", [("TODO", "needs_next_response"), ("SNOOZED", "waiting"), ("DONE", "done")])
def test_null_detail_falls_back_to_status(status, kind):
    assert threads.status_detail(raw(status=status, statusDetail=None))["kind"] == kind


def test_assignees_primary_then_additional_users_and_bots():
    t = raw(assignedTo={"__typename": "User", "id": "u_1", "fullName": "Forrest Parker", "avatarUrl": "https://a/f.png"},
            additionalAssignees=[{"__typename": "User", "id": "u_2", "fullName": "Lauren Hamilton", "avatarUrl": None},
                                 {"__typename": "MachineUser", "id": "mu_1", "fullName": "Sidekick"}])
    assert threads.assignees(t) == [
        {"plain_user_id": "u_1", "name": "Forrest Parker", "avatar_url": "https://a/f.png", "primary": True},
        {"plain_user_id": "u_2", "name": "Lauren Hamilton", "avatar_url": None, "primary": False},
        {"plain_user_id": None, "name": "Sidekick", "avatar_url": None, "primary": False},
    ]


def test_fields_follow_schema_order_and_keep_empty_ones():
    t = raw(threadFields=[{"key": "wp_user_id", "stringValue": None, "numberValue": 3173.0},
                          {"key": "unknown_key", "stringValue": "x"}])
    assert threads.fields(t, SCHEMAS) == [
        {"key": "verification_code", "label": "Verification Code", "value": None},
        {"key": "wp_user_id", "label": "WP User ID", "value": "3173"},
        {"key": "total_spent", "label": "Total Spent", "value": None},
        {"key": "unknown_key", "label": "unknown_key", "value": "x"},
    ]


def test_field_values_by_type():
    t = raw(threadFields=[{"key": "a", "booleanValue": True}, {"key": "b", "numberValue": 160.5},
                          {"key": "c", "dateValue": {"iso8601": "2026-09-01T00:00:00.000Z"}}])
    assert [f["value"] for f in threads.fields(t, [])] == ["Yes", "160.5", "2026-09-01"]


def test_field_schema_failure_falls_back_to_keys():
    assert threads.fields(raw(threadFields=[{"key": "sales_rep", "stringValue": "Scott"}]), []) == [
        {"key": "sales_rep", "label": "sales_rep", "value": "Scott"}]


def test_customer_block_and_wp_link():
    t = raw(customer={"id": "c_1", "fullName": "Lilia Billones", "externalId": "3173", "avatarUrl": None,
                      "email": {"email": "lilia@example.com"}, "company": {"name": "Acme"},
                      "createdAt": {"iso8601": "2026-08-25T00:00:00.000Z"},
                      "updatedAt": {"iso8601": "2026-08-26T00:00:00.000Z"}})
    assert threads.customer_block(t) == {
        "name": "Lilia Billones", "email": "lilia@example.com", "external_id": "3173", "avatar_url": None,
        "company": "Acme", "created_at": "2026-08-25T00:00:00.000Z", "updated_at": "2026-08-26T00:00:00.000Z",
        "wp_profile_url": "https://accumarklabs.com/wp-admin/user-edit.php?user_id=3173"}
    t["customer"]["externalId"] = "abc"
    assert threads.customer_block(t)["wp_profile_url"] is None


def test_detail_extras_tolerate_missing_fields():
    x = threads.detail_extras({"id": "th_1", "status": "TODO", "customer": None}, [])
    assert x == {"status_detail": {"kind": "needs_next_response", "label": "Needs next response", "until": None},
                 "assignees": [], "tier": None, "fields": [], "customer": None}


def _node(entry, actor, nid="e1"):
    return {"id": nid, "timestamp": {"iso8601": "2026-10-09T10:00:00.000Z"}, "actor": actor, "entry": entry}


def test_email_entry_extras():
    e = threads.build_entries([_node(
        {"__typename": "EmailEntry", "subject": "Re: lot", "textContent": "Hi", "hasMoreTextContent": False,
         "markdownContent": "**Hi**", "hasMoreMarkdownContent": False,
         "from": {"name": "Lauren Hamilton", "email": "support@accumarklabs.com"},
         "to": {"name": None, "email": "lilia@example.com"}},
        {"__typename": "UserActor", "userId": "u_2", "user": {"fullName": "Lauren Hamilton", "avatarUrl": "https://a/l.png"}})],
        "Lilia Billones")[0]
    assert e["text"] == "Hi" and e["markdown"] == "**Hi**" and e["automated"] is False
    assert e["email_from"] == "Lauren Hamilton <support@accumarklabs.com>" and e["email_to"] == "lilia@example.com"
    assert e["author_avatar_url"] == "https://a/l.png" and e["event"] is None


def test_system_email_is_automated_but_a_form_is_not():
    auto = threads.build_entries([_node({"__typename": "EmailEntry", "subject": "Re: x", "textContent": "auto",
                                         "hasMoreTextContent": False, "from": {"email": "support@accumarklabs.com"},
                                         "to": {"email": "c@x"}}, {"__typename": "SystemActor", "systemId": "s"})], "C")[0]
    form = threads.build_entries([_node({"__typename": "CustomEntry", "title": "Contact form",
                                         "components": [{"__typename": "ComponentText", "text": "hi"}]},
                                        {"__typename": "MachineUserActor", "machineUser": {"fullName": "Website"}})], "C")[0]
    assert auto["automated"] is True and form["automated"] is False


def test_events_are_structured_and_text_is_unchanged():
    nodes = [_node({"__typename": "ThreadStatusTransitionedEntry", "nextStatus": "DONE"},
                   {"__typename": "UserActor", "userId": "u_2", "user": {"fullName": "Lauren Hamilton"}}, "e1"),
             _node({"__typename": "ThreadLabelsChangedEntry", "nextLabels": [{"labelType": {"name": "Engineering"}}]},
                   {"__typename": "MachineUserActor", "machineUser": {"fullName": "Plain Sidekick"}}, "e2"),
             _node({"__typename": "ThreadAssignmentTransitionedEntry",
                    "nextAssignee": {"__typename": "User", "fullName": "Forrest Parker"}},
                   {"__typename": "SystemActor", "systemId": "s"}, "e3"),
             _node({"__typename": "ThreadPriorityChangedEntry", "nextPriority": 1},
                   {"__typename": "UserActor", "userId": "u_2", "user": {"fullName": "Lauren Hamilton"}}, "e4")]
    ev = [e["event"] for e in threads.build_entries(nodes, "C")]
    assert ev == [{"icon": "status", "actor": "Lauren Hamilton", "text": "changed status to Done"},
                  {"icon": "label", "actor": "Plain Sidekick", "text": "set labels to Engineering"},
                  {"icon": "assign", "actor": "Plain", "text": "assigned Forrest Parker"},
                  {"icon": "priority", "actor": "Lauren Hamilton", "text": "set priority to High"}]
    assert threads.build_entries(nodes, "C")[0]["text"] == "Marked done by Lauren Hamilton"
```

Append to `backend/tests/test_support_plain_routes.py`:

```python
def test_detail_declares_the_view_keys(api):
    client, _ = api
    body = client.get("/support/customers/wc:1/threads/th_b").json()
    assert {"status_detail", "assignees", "tier", "fields", "customer"} <= set(body["thread"])
    assert {"author_avatar_url", "automated", "email_to", "email_from", "markdown", "event"} <= set(body["entries"][0])
```

In that file's `FakePlain.query`, add `queries.THREAD_FIELD_SCHEMAS: "schemas"` to the op map and, before the thread branch, `if op == "schemas": return {"threadFieldSchemas": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "edges": []}}`. In `backend/tests/test_support_plain_actions.py`, `Plain.query`, add before the final `raise`: `if q == queries.THREAD_FIELD_SCHEMAS: return {"threadFieldSchemas": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "edges": []}}`.

- [ ] **Step 2: Run to watch it fail**

Run: `cd backend && <venv python> -m pytest tests/test_support_plain_detail.py -q`
Expected: FAIL with `AttributeError: module 'support_plain.threads' has no attribute 'status_detail'`.

- [ ] **Step 3: Queries**

In `queries.py`:
- In `_ACTOR`, replace the UserActor and CustomerActor lines with `... on UserActor { userId user { fullName avatarUrl } }` and `... on CustomerActor { customer { fullName avatarUrl } }`, and add `... on SystemActor { systemId }`.
- In `THREAD`'s `EmailEntry` fragment, replace it with `... on EmailEntry { subject textContent hasMoreTextContent fullTextContent markdownContent hasMoreMarkdownContent fullMarkdownContent from { name email } to { name email } }`.
- Add the detail-only selection, and put `%s` for it right after the existing `%s` in `THREAD`'s `thread(threadId: $threadId) {` block:

```python
_DETAIL_FIELDS = """statusDetail { __typename
        ... on ThreadStatusDetailWaitingForDuration { waitingUntil { iso8601 } }
        ... on ThreadStatusDetailSnoozed { snoozedUntil { iso8601 } } }
      assignedTo { ... on User { avatarUrl } }
      additionalAssignees { __typename ... on User { id fullName avatarUrl } ... on MachineUser { id fullName } }
      tier { name color }
      threadFields { key stringValue numberValue booleanValue dateValue { iso8601 } }
      customer { id fullName externalId avatarUrl email { email } company { name }
        createdAt { iso8601 } updatedAt { iso8601 } }"""

THREAD_FIELD_SCHEMAS = """query ThreadFieldSchemas($after: String) {
  threadFieldSchemas(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { key label order } }
  }
}"""
```

Change `THREAD`'s formatting tuple to `% (_THREAD_FIELDS, _DETAIL_FIELDS, _ACTOR)`, and add `THREAD_FIELD_SCHEMAS` to `ALL`. `_DETAIL_FIELDS` must be defined above `THREAD`.

- [ ] **Step 4: Builders**

Add to `threads.py` (after `_label_refs`):

```python
_DETAIL = {
    "ThreadStatusDetailCreated": ("needs_first_response", "Needs first response"),
    "ThreadStatusDetailNewReply": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailUnsnoozed": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailThreadLinkUpdated": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailLinearUpdated": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailThreadDiscussionResolved": ("needs_next_response", "Needs next response"),
    "ThreadStatusDetailReplied": ("in_progress", "In progress"),
    "ThreadStatusDetailInProgress": ("in_progress", "In progress"),
    "ThreadStatusDetailWaitingForCustomer": ("waiting_for_customer", "Waiting for customer"),
    "ThreadStatusDetailWaitingIndefinitely": ("waiting", "Waiting"),
    "ThreadStatusDetailDoneManuallySet": ("done", "Done"),
    "ThreadStatusDetailIgnored": ("done", "Done"),
    "ThreadStatusDetailDoneAutomaticallySet": ("done_auto", "Done automatically"),
}
_BY_STATUS = {"TODO": ("needs_next_response", "Needs next response"), "SNOOZED": ("waiting", "Waiting"),
              "DONE": ("done", "Done")}
WP_PROFILE = "https://accumarklabs.com/wp-admin/user-edit.php?user_id={}"


def status_detail(t: dict) -> dict[str, Any]:
    d = t.get("statusDetail") or {}
    typ = d.get("__typename")
    until = _iso(d.get("waitingUntil") or d.get("snoozedUntil"))
    if typ in ("ThreadStatusDetailWaitingForDuration", "ThreadStatusDetailSnoozed") and until:
        return {"kind": "waiting_until", "label": f"Waiting until {until[:10]}", "until": until}
    kind, label = _DETAIL.get(typ) or _BY_STATUS.get(t.get("status"), _BY_STATUS["TODO"])
    return {"kind": kind, "label": label, "until": None}


def _person(a: dict | None, primary: bool) -> dict[str, Any] | None:
    if not a or not a.get("fullName"):
        return None
    is_user = a.get("__typename") == "User"
    return {"plain_user_id": a.get("id") if is_user else None, "name": a["fullName"],
            "avatar_url": a.get("avatarUrl") if is_user else None, "primary": primary}


def assignees(t: dict) -> list[dict[str, Any]]:
    people = [_person(t.get("assignedTo"), True)] + [_person(a, False) for a in t.get("additionalAssignees") or []]
    return [p for p in people if p]


def _field_value(f: dict) -> str | None:
    if f.get("stringValue") not in (None, ""):
        return str(f["stringValue"])
    if f.get("booleanValue") is not None:
        return "Yes" if f["booleanValue"] else "No"
    if f.get("numberValue") is not None:
        n = f["numberValue"]
        return str(int(n)) if float(n).is_integer() else str(n)
    date = _iso(f.get("dateValue"))
    return date[:10] if date else None


def fields(t: dict, schemas: list[dict]) -> list[dict[str, Any]]:
    values = {f["key"]: _field_value(f) for f in t.get("threadFields") or [] if f.get("key")}
    known = sorted((s for s in schemas if s.get("key")), key=lambda s: s.get("order") or 0)
    out = [{"key": s["key"], "label": s.get("label") or s["key"], "value": values.pop(s["key"], None)} for s in known]
    return out + [{"key": k, "label": k, "value": v} for k, v in values.items()]


def customer_block(t: dict) -> dict[str, Any] | None:
    c = t.get("customer") or {}
    if not c.get("fullName"):
        return None
    ext = c.get("externalId")
    return {"name": c["fullName"], "email": (c.get("email") or {}).get("email"), "external_id": ext,
            "avatar_url": c.get("avatarUrl"), "company": (c.get("company") or {}).get("name"),
            "created_at": _iso(c.get("createdAt")), "updated_at": _iso(c.get("updatedAt")),
            "wp_profile_url": WP_PROFILE.format(ext) if ext and str(ext).isdigit() else None}


def detail_extras(t: dict, schemas: list[dict]) -> dict[str, Any]:
    tier = t.get("tier") or {}
    return {"status_detail": status_detail(t), "assignees": assignees(t),
            "tier": {"name": tier["name"], "color": tier.get("color")} if tier.get("name") else None,
            "fields": fields(t, schemas), "customer": customer_block(t)}
```

Update `_actor` to return the avatar, and make `_entry` add the extras:

```python
def _actor(a: dict | None) -> tuple[str | None, str, str | None, str | None]:
    """(name, author_kind, avatar_url, actor typename)."""
    kind = (a or {}).get("__typename")
    if kind == "CustomerActor":
        c = a.get("customer") or {}
        return _name(c), "customer", c.get("avatarUrl"), kind
    if kind == "UserActor":
        u = a.get("user") or {}
        return _name(u), "agent", u.get("avatarUrl"), kind
    if kind == "MachineUserActor":
        return _name(a.get("machineUser")), "agent", None, kind
    return None, "system", None, kind


_STATUS_WORD = {"open": "Todo", "snoozed": "Snoozed", "done": "Done"}


def _event(typ: str, e: dict, who: str | None) -> dict[str, str]:
    actor = who or "Plain"
    if typ == "ThreadStatusTransitionedEntry":
        word = _STATUS_WORD[rules.STATUS.get(e.get("nextStatus"), "open")]
        return {"icon": "status", "actor": actor, "text": f"changed status to {word}"}
    if typ == "ThreadLabelsChangedEntry":
        names = _labels(e.get("nextLabels"))
        return {"icon": "label", "actor": actor, "text": f"set labels to {', '.join(names)}" if names else "removed all labels"}
    if typ == "ThreadAssignmentTransitionedEntry":
        to = _name(e.get("nextAssignee"))
        return {"icon": "assign", "actor": actor, "text": f"assigned {to}" if to else "unassigned the thread"}
    level = rules.PRIORITY.get(e.get("nextPriority"), "normal")
    return {"icon": "priority", "actor": actor, "text": f"set priority to {level.capitalize()}"}


def _fmt(p: dict | None) -> str | None:
    p = p or {}
    if not p.get("email"):
        return None
    return f"{p['name']} <{p['email']}>" if p.get("name") else p["email"]
```

In `_entry`:
- Unpack `who, kind, avatar, actor_type = _actor(node.get("actor"))`.
- Add to `base`: `"author_avatar_url": avatar, "automated": False, "email_to": None, "email_from": None, "markdown": None, "event": None`.
- In the `EmailEntry` branch, add `"email_to": _fmt(e.get("to")), "email_from": _fmt(frm)`, plus `"markdown": (e.get("fullMarkdownContent") if e.get("hasMoreMarkdownContent") and e.get("fullMarkdownContent") else e.get("markdownContent")) or None`, and `"automated": actor_type in ("SystemActor", "MachineUserActor")`.
- In the `_TEXT` branch, for `ChatEntry` only, set `"automated": actor_type in ("SystemActor", "MachineUserActor")`.
- In the `_EVENTS` branch, add `"event": _event(typ, e, who)`. Keep `"text": _event_text(typ, e, who)` unchanged.

- [ ] **Step 5: Service and models**

`service.py`:

```python
def _field_schemas(client) -> list[dict]:
    """Thread field labels; on failure the view falls back to keys (spec 5)."""
    try:
        schemas, _ = CACHE.get_or_load("fieldschemas", rules.PEOPLE_TTL,
                                       lambda: paged(client, queries.THREAD_FIELD_SCHEMAS, "threadFieldSchemas"))
        return schemas
    except (SupportUnavailable, KeyError, TypeError):
        return []
```

In `thread_detail.load`, build the thread as `{**threads.thread_item(t, _workspace(client)), **threads.detail_extras(t, _field_schemas(client))}`.

`routes.py`, add the models and declare them:

```python
class StatusDetail(BaseModel):
    kind: str
    label: str
    until: Optional[str] = None


class Assignee(BaseModel):
    plain_user_id: Optional[str] = None
    name: str
    avatar_url: Optional[str] = None
    primary: bool = False


class Tier(BaseModel):
    name: str
    color: Optional[str] = None


class ThreadFieldValue(BaseModel):
    key: str
    label: str
    value: Optional[str] = None


class CustomerBlock(BaseModel):
    name: str
    email: Optional[str] = None
    external_id: Optional[str] = None
    avatar_url: Optional[str] = None
    company: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    wp_profile_url: Optional[str] = None


class EventInfo(BaseModel):
    icon: Literal["status", "label", "assign", "priority"]
    actor: str
    text: str
```

On `Thread`, add `status_detail: Optional[StatusDetail] = None`, `assignees: list[Assignee] = []`, `tier: Optional[Tier] = None`, `fields: list[ThreadFieldValue] = []` and `customer: Optional[CustomerBlock] = None`. These classes must be defined above `Thread`. On `Entry`, add `author_avatar_url: Optional[str] = None`, `automated: bool = False`, `email_to: Optional[str] = None`, `email_from: Optional[str] = None`, `markdown: Optional[str] = None` and `event: Optional[EventInfo] = None`.

- [ ] **Step 6: Run to watch it pass, then the neighbours**

Run each of these:
- `cd backend && <venv python> -m pytest tests/test_support_plain_detail.py -q`
- `<venv python> -m pytest tests/test_support_plain_threads.py tests/test_support_plain_routes.py tests/test_support_plain_actions.py tests/test_customer_review_tools.py -q`

Expected: PASS. If `test_support_plain_threads.py` asserts exact entry dicts, add the six new keys with their defaults to those expectations. That is a stale-test update, not a behaviour change.

- [ ] **Step 7: Commit**

```bash
git add backend/support_plain/queries.py backend/support_plain/threads.py backend/support_plain/service.py backend/support_plain/routes.py backend/tests/test_support_plain_detail.py backend/tests/test_support_plain_routes.py backend/tests/test_support_plain_actions.py backend/tests/test_support_plain_threads.py
git commit -m "feat(support): Plain-style view data (status detail, assignees, tier, fields, customer, entry extras)"
```

---

### Task 2: Waiting statuses and additional assignees

**Files:**
- Modify: `backend/support_plain/queries.py` (two mutations)
- Modify: `backend/support_plain/actions.py` (`_plan`)
- Modify: `backend/support_plain/routes.py` (`StatusBody`, new `AssigneesBody` and route)
- Test: `backend/tests/test_support_plain_actions.py`

**Interfaces:**
- Consumes: Task 1's `thread["assignees"]` (non-primary entries carry `plain_user_id`).
- Produces:
  - `POST .../status` accepts `waiting_for_customer` and `waiting`. Snoozes now send `statusDetail: WAITING_FOR_DURATION`.
  - `POST /support/customers/{key}/threads/{th}/assignees` takes `{add: [id], remove: [id]}`.
  - New mutations `queries.ADD_ASSIGNEES` and `queries.REMOVE_ASSIGNEES`.

- [ ] **Step 1: Failing tests**

In `test_support_plain_actions.py`, give `Plain.__init__` `self.additional = []` and make its THREAD branch return `{**thread("th_b"), "additionalAssignees": self.additional, "timelineEntries": ...}`. Then append:

```python
def test_waiting_statuses_snooze_with_detail(api):
    client, plain, _ = api
    assert post(client, "status", {"status": "waiting_for_customer"}).status_code == 200
    assert plain.sent[-1] == (queries.SNOOZE, {"input": {"threadId": "th_b", "statusDetail": "WAITING_FOR_CUSTOMER"}})
    assert post(client, "status", {"status": "waiting"}).status_code == 200
    assert plain.sent[-1] == (queries.SNOOZE, {"input": {"threadId": "th_b", "statusDetail": "WAITING_INDEFINITELY"}})
    until = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    post(client, "status", {"status": "snoozed", "until": until})
    assert plain.sent[-1][1]["input"]["statusDetail"] == "WAITING_FOR_DURATION"


def test_add_and_remove_additional_assignees(api):
    client, plain, Session = api
    plain.additional = [{"__typename": "User", "id": "u_1", "fullName": "Sam Parker"}]
    r = post(client, "assignees", {"add": ["u_1"], "remove": ["u_1"]})
    assert r.status_code == 200
    assert plain.sent == [(queries.ADD_ASSIGNEES, {"input": {"threadId": "th_b", "userIds": ["u_1"]}}),
                          (queries.REMOVE_ASSIGNEES, {"input": {"threadId": "th_b", "userIds": ["u_1"]}})]
    assert rows(Session)[-1].action == "assignees"


def test_assignees_validation(api):
    client, plain, _ = api
    for body in ({"add": [], "remove": []}, {"add": ["u_999"]}, {"remove": ["u_1"]}):
        r = post(client, "assignees", body)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_input", body
    assert plain.sent == []
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd backend && <venv python> -m pytest tests/test_support_plain_actions.py -q`
Expected: the three new tests FAIL (422 on the waiting statuses, 404/405 on `/assignees`).

- [ ] **Step 3: Implement**

`queries.py`: add `ADD_ASSIGNEES = _m("AddAdditionalAssignees", "addAdditionalAssignees", "AddAdditionalAssigneesInput")` and `REMOVE_ASSIGNEES = _m("RemoveAdditionalAssignees", "removeAdditionalAssignees", "RemoveAdditionalAssigneesInput")`, then add both to `MUTATIONS`.

`actions.py`, `_plan`, status branch, after the `done` line:

```python
        if s == "waiting_for_customer":
            return [(queries.SNOOZE, {"input": {"threadId": tid, "statusDetail": "WAITING_FOR_CUSTOMER"}})], None
        if s == "waiting":
            return [(queries.SNOOZE, {"input": {"threadId": tid, "statusDetail": "WAITING_INDEFINITELY"}})], None
```

and change the snooze return to `{"input": {"threadId": tid, "durationSeconds": secs, "statusDetail": "WAITING_FOR_DURATION"}}`. Add before the final `raise _bad()`:

```python
    if action == "assignees":
        add, remove = list(body.get("add") or []), list(body.get("remove") or [])
        if not add and not remove:
            raise _bad()
        team = {m["plain_user_id"] for m in service.workspace_people()["teammates"]}
        current = {a["plain_user_id"] for a in thread.get("assignees") or [] if not a.get("primary") and a.get("plain_user_id")}
        if not set(add) <= team or not set(remove) <= current:
            raise _bad()
        steps = []
        if add:
            steps.append((queries.ADD_ASSIGNEES, {"input": {"threadId": tid, "userIds": add}}))
        if remove:
            steps.append((queries.REMOVE_ASSIGNEES, {"input": {"threadId": tid, "userIds": remove}}))
        return steps, None
```

`routes.py`: change `StatusBody.status` to `Literal["todo", "done", "snoozed", "waiting_for_customer", "waiting"]`, then add:

```python
class AssigneesBody(BaseModel):
    add: list[str] = []
    remove: list[str] = []


@router.post("/customers/{customer_key}/threads/{thread_id}/assignees", response_model=ActionResult)
def assignees(customer_key: str, body: AssigneesBody, thread_id: str = _TH, su=Depends(require_seat),
              db: Session = Depends(get_db)):
    return _act("assignees", customer_key, thread_id, body, su, db)
```

- [ ] **Step 4: Run to watch it pass, then every support suite**

Run each of these:
- `cd backend && <venv python> -m pytest tests/test_support_plain_actions.py -q`
- `<venv python> -m pytest tests/test_support_plain_client.py tests/test_support_plain_detail.py tests/test_support_plain_routes.py tests/test_support_plain_threads.py -q`

Expected: PASS. (`test_mutations_and_queries_are_disjoint` covers the new mutations.)

- [ ] **Step 5: Commit**

```bash
git add backend/support_plain/queries.py backend/support_plain/actions.py backend/support_plain/routes.py backend/tests/test_support_plain_actions.py
git commit -m "feat(support): waiting-for-customer status and additional assignees"
```

---

### Task 3: Palette, avatar, time helpers and the timeline

**Files:**
- Modify: `src/lib/api-support.ts` (types)
- Create: `src/components/customers/plain-view.css`
- Create: `src/components/customers/plain-time.ts`
- Create: `src/components/customers/PlainAvatar.tsx`
- Create: `src/components/customers/TicketTimeline.tsx`
- Test: `src/components/customers/TicketTimeline.test.tsx`

**Interfaces:**
- Consumes: Task 1's JSON shapes.
- Produces:
  - Types `SupportStatusDetail`, `SupportAssignee`, `SupportField`, `SupportCustomerBlock` and `SupportEventInfo`.
  - New optional fields on `SupportThread` and `SupportEntry`.
  - `ago(iso)`, `dayLabel(iso)` and `<PlainAvatar name url size?/>`.
  - `<TicketTimeline entries customerFirstName viewerName />`, which renders entries in the order given.

- [ ] **Step 1: Types**

Add to `src/lib/api-support.ts`:

```ts
export interface SupportStatusDetail {
  kind: string
  label: string
  until: string | null
}
export interface SupportAssignee {
  plain_user_id: string | null
  name: string
  avatar_url: string | null
  primary: boolean
}
export interface SupportField {
  key: string
  label: string
  value: string | null
}
export interface SupportCustomerBlock {
  name: string
  email: string | null
  external_id: string | null
  avatar_url: string | null
  company: string | null
  created_at: string | null
  updated_at: string | null
  wp_profile_url: string | null
}
export interface SupportEventInfo {
  icon: 'status' | 'label' | 'assign' | 'priority'
  actor: string
  text: string
}
```

On `SupportThread`, add optional `status_detail?: SupportStatusDetail | null`, `assignees?: SupportAssignee[]`, `tier?: { name: string; color: string | null } | null`, `fields?: SupportField[]` and `customer?: SupportCustomerBlock | null`. On `SupportEntry`, add optional `author_avatar_url?: string | null`, `automated?: boolean`, `email_to?: string | null`, `email_from?: string | null`, `markdown?: string | null` and `event?: SupportEventInfo | null`.

- [ ] **Step 2: Failing test**

`src/components/customers/TicketTimeline.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SupportEntry } from '@/lib/api-support'
import { TicketTimeline } from './TicketTimeline'

const base = {
  author_kind: 'customer' as const,
  internal: false,
  subject: null,
  author_avatar_url: null,
  automated: false,
  email_to: null,
  email_from: null,
  markdown: null,
  event: null,
}
const entries: SupportEntry[] = [
  { ...base, id: 'e1', at: '2026-09-15T10:00:00Z', kind: 'form', author: 'Lilia Billones', subject: 'Contact form', text: 'Can the lot code be changed?' },
  { ...base, id: 'e2', at: '2026-09-15T10:01:00Z', kind: 'email', author: null, author_kind: 'system', automated: true, subject: 'Re: Contact form', text: 'We got your message' },
  { ...base, id: 'e3', at: '2026-09-15T11:00:00Z', kind: 'event', author: 'Lauren Hamilton', author_kind: 'agent', text: 'Marked done by Lauren Hamilton', event: { icon: 'status', actor: 'Lauren Hamilton', text: 'changed status to Done' } },
  { ...base, id: 'e4', at: '2026-09-16T09:00:00Z', kind: 'note', author: 'Forrest Parker', author_kind: 'agent', internal: true, text: '@Lauren Hamilton did we ever receive the 10ml?' },
  { ...base, id: 'e5', at: '2026-09-16T09:30:00Z', kind: 'email', author: 'Lauren Hamilton', author_kind: 'agent', subject: 'Re: Contact form', email_to: 'lilia@example.com', email_from: 'support@accumarklabs.com', text: 'We can not change the LOT code.' },
  { ...base, id: 'e6', at: '2026-09-16T10:00:00Z', kind: 'event', author: 'Forrest Parker', author_kind: 'agent', text: 'x', event: { icon: 'assign', actor: 'Forrest Parker', text: 'assigned Lauren Hamilton' } },
]

function setup() {
  render(<TicketTimeline entries={entries} customerFirstName="Lilia" viewerName="Forrest Parker" />)
}

describe('TicketTimeline', () => {
  it('splits days with Plain-style dividers', () => {
    setup()
    expect(screen.getByText('Tue, Sep 15, 2026')).toBeInTheDocument()
    expect(screen.getByText('Wed, Sep 16, 2026')).toBeInTheDocument()
  })

  it('picks the card for each kind of entry', () => {
    setup()
    expect(screen.getByText('Can the lot code be changed?').closest('[data-card]')).toHaveAttribute('data-card', 'customer')
    expect(screen.getByText('We can not change the LOT code.').closest('[data-card]')).toHaveAttribute('data-card', 'team')
    expect(screen.getByText(/did we ever receive/).closest('[data-card]')).toHaveAttribute('data-card', 'note')
    expect(screen.getByText('to: lilia@example.com, from: support@accumarklabs.com')).toBeInTheDocument()
  })

  it('renders mention chips and collapses automated mail', async () => {
    setup()
    expect(screen.getByText('@Lauren Hamilton')).toHaveAttribute('data-mention')
    expect(screen.getByText('Not visible to Lilia')).toBeInTheDocument()
    expect(screen.getByText('This email was sent automatically')).toBeInTheDocument()
    expect(screen.queryByText('We got your message')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show message' }))
    expect(screen.getByText('We got your message')).toBeInTheDocument()
  })

  it('writes events as one line and says You for the viewer', () => {
    setup()
    expect(screen.getAllByText('Lauren Hamilton').length).toBeGreaterThan(0)
    expect(screen.getByText(/changed status to Done/)).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText(/assigned Lauren Hamilton/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run to watch it fail**

Run: `npx vitest run src/components/customers/TicketTimeline.test.tsx`
Expected: FAIL, unresolved import `./TicketTimeline`.

- [ ] **Step 4: Implement**

`src/components/customers/plain-view.css`:

```css
/* Plain's palette, scoped to the Support ticket view (spec 4.4). Mk1's .dark class switches the set. */
.plain-view {
  --pv-bg: #ffffff;
  --pv-surface: #f7f7f8;
  --pv-card: #f4f4f5;
  --pv-card-team: #eef2fb;
  --pv-card-note: #fdf6e3;
  --pv-note-ink: #9a6700;
  --pv-border: #e4e4e7;
  --pv-ink: #18181b;
  --pv-ink-2: #52525b;
  --pv-ink-3: #a1a1aa;
  --pv-accent: #4f46e5;
  --pv-chip: #eef0ff;
  background: var(--pv-bg);
  color: var(--pv-ink);
}
.dark .plain-view {
  --pv-bg: #18181b;
  --pv-surface: #1f1f23;
  --pv-card: #26262b;
  --pv-card-team: #0f1626;
  --pv-card-note: #2a2312;
  --pv-note-ink: #e8b04a;
  --pv-border: #2e2e33;
  --pv-ink: #ececf1;
  --pv-ink-2: #a1a1aa;
  --pv-ink-3: #71717a;
  --pv-accent: #8b9cff;
  --pv-chip: #252a45;
}
```

`src/components/customers/plain-time.ts`:

```ts
/** "2d ago" style relative time, Plain's way. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const m = Math.round((now - new Date(iso).getTime()) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 24 * 60) return `${Math.round(m / 60)}h ago`
  if (m < 30 * 24 * 60) return `${Math.round(m / 1440)}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Tue, Sep 15, 2026" day divider label. */
export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export const exact = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : ''
```

`src/components/customers/PlainAvatar.tsx`:

```tsx
import { useState } from 'react'
import { cn } from '@/lib/utils'

const COLORS = ['bg-violet-500', 'bg-rose-500', 'bg-amber-600', 'bg-emerald-600', 'bg-sky-600', 'bg-fuchsia-600']

function colorFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length] ?? 'bg-violet-500'
}

/** Image avatar, or the first initial on a color derived from the name. */
export function PlainAvatar({ name, url, size = 32 }: { name: string; url?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size }
  if (url && !broken) {
    return <img src={url} alt="" style={style} className="shrink-0 rounded-md object-cover" onError={() => setBroken(true)} />
  }
  return (
    <span
      aria-hidden
      style={style}
      className={cn('flex shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white', colorFor(name))}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}
```

`src/components/customers/TicketTimeline.tsx`:

```tsx
import { Fragment, useState, type ReactNode } from 'react'
import { CircleCheck, EyeOff, Flag, Tag, UserRound } from 'lucide-react'
import { renderCommentHtml } from '@/components/flags/comment-markdown'
import type { SupportEntry } from '@/lib/api-support'
import { cn } from '@/lib/utils'
import { PlainAvatar } from './PlainAvatar'
import { ago, dayLabel, exact } from './plain-time'

const ICON = { status: CircleCheck, label: Tag, assign: UserRound, priority: Flag } as const
const MENTION = /(@[A-Z][\w'.-]*(?: [A-Z][\w'.-]*)?)/g

function withMentions(text: string): ReactNode[] {
  return text.split(MENTION).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} data-mention className="rounded bg-[var(--pv-chip)] px-1 text-[var(--pv-accent)]">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
}

function Body({ e }: { e: SupportEntry }) {
  if (e.markdown) {
    return (
      <div
        className="break-words text-sm [&_a]:text-[var(--pv-accent)] [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4"
        // Sanitised by renderCommentHtml (markdown-it html:false + DOMPurify).
        dangerouslySetInnerHTML={{ __html: renderCommentHtml(e.markdown, []) }}
      />
    )
  }
  return <p className="whitespace-pre-wrap break-words text-sm">{e.internal ? withMentions(e.text) : e.text}</p>
}

function Card({ e, customerFirstName }: { e: SupportEntry; customerFirstName: string }) {
  const [open, setOpen] = useState(false)
  const kind = e.internal ? 'note' : e.author_kind === 'customer' ? 'customer' : 'team'
  const name = e.author ?? (kind === 'customer' ? 'Customer' : 'Accumark Labs')
  const bg =
    kind === 'note' ? 'bg-[var(--pv-card-note)]' : kind === 'team' ? 'bg-[var(--pv-card-team)]' : 'bg-[var(--pv-card)]'
  return (
    <div className="flex gap-3">
      <PlainAvatar name={name} url={e.author_avatar_url} />
      <div data-card={kind} className={cn('min-w-0 flex-1 rounded-lg border border-[var(--pv-border)] p-3', bg)}>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="font-semibold">{e.automated ? `${name} (Autoresponse)` : name}</span>
          <span className="text-xs text-[var(--pv-ink-3)]" title={exact(e.at)}>
            {ago(e.at)}
          </span>
        </div>
        {e.subject && <div className="font-medium">{e.subject}</div>}
        {(e.email_to || e.email_from) && (
          <div className="mb-2 text-xs text-[var(--pv-ink-2)]">
            {`to: ${e.email_to ?? ''}, from: ${e.email_from ?? ''}`}
          </div>
        )}
        {e.automated && !open ? (
          <div className="flex flex-col items-center gap-2 py-1 text-sm text-[var(--pv-ink-2)]">
            <span>This email was sent automatically</span>
            <button type="button" className="rounded-md border border-[var(--pv-border)] px-2 py-1 text-xs" onClick={() => setOpen(true)}>
              Show message
            </button>
          </div>
        ) : (
          <Body e={e} />
        )}
        {kind === 'note' && (
          <div className="mt-2 flex items-center gap-1 text-xs text-[var(--pv-note-ink)]">
            <EyeOff className="h-3 w-3" /> Not visible to {customerFirstName}
          </div>
        )}
      </div>
    </div>
  )
}

function EventLine({ e, viewerName }: { e: SupportEntry; viewerName: string }) {
  const ev = e.event
  if (!ev) return <div className="pl-11 text-xs text-[var(--pv-ink-3)]">{e.text}</div>
  const Icon = ICON[ev.icon]
  return (
    <div className="flex items-center gap-2 pl-11 text-xs text-[var(--pv-ink-2)]">
      <Icon className="h-3.5 w-3.5 text-[var(--pv-ink-3)]" />
      <span className="font-medium text-[var(--pv-ink)]">{ev.actor === viewerName ? 'You' : ev.actor}</span>
      <span>{ev.text}</span>
      <span className="text-[var(--pv-ink-3)]" title={exact(e.at)}>
        · {ago(e.at)}
      </span>
    </div>
  )
}

/** Plain-style conversation: day dividers, cards and one-line events, in the order given. */
export function TicketTimeline({
  entries,
  customerFirstName,
  viewerName,
}: {
  entries: SupportEntry[]
  customerFirstName: string
  viewerName: string
}) {
  let lastDay = ''
  return (
    <div className="flex flex-col gap-3">
      {entries.map(e => {
        const day = e.at ? dayLabel(e.at) : ''
        const divider = day && day !== lastDay
        lastDay = day || lastDay
        return (
          <Fragment key={e.id}>
            {divider && <div className="pt-2 text-xs font-semibold text-[var(--pv-ink)]">{day}</div>}
            {e.kind === 'event' ? (
              <EventLine e={e} viewerName={viewerName} />
            ) : (
              <Card e={e} customerFirstName={customerFirstName} />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 5: Run to watch it pass**

Run: `npx vitest run src/components/customers/TicketTimeline.test.tsx`, then `npx tsc --noEmit -p /c/tmp/mk1-plain-view/tsconfig.json`.
Expected: PASS, and `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-support.ts src/components/customers/plain-view.css src/components/customers/plain-time.ts src/components/customers/PlainAvatar.tsx src/components/customers/TicketTimeline.tsx src/components/customers/TicketTimeline.test.tsx
git commit -m "feat(support): Plain-style timeline, avatar and palette"
```

---

### Task 4: The details sidebar

**Files:**
- Create: `src/components/customers/TicketSidebar.tsx`
- Create: `src/components/customers/TicketSidebar.test.tsx`
- Delete: `src/components/customers/SupportThreadControls.tsx` (its controls move into the sidebar with the same accessible names)

**Interfaces:**
- Consumes: Task 3's types; `getSupportWorkspace` and `SupportAction` from `@/lib/api-support`; `supportErrorMessage` from `./support-errors`; `PlainAvatar`.
- Produces: `<TicketSidebar thread={SupportThread} threads={SupportThread[]} canEdit={boolean} run={(action, body) => Promise<void>} onSelect={(t: SupportThread) => void} />`.
  - Accessible names stay as before: `Status`, `Priority`, `Assignee`, `Add label`, `Remove label {name}`.
  - New names: `Add assignee`, `Remove assignee {name}`.
  - `Status` option values: `open`, `waiting_for_customer`, `done`, `snooze:1h`, `snooze:tomorrow`, `snooze:monday`, `snooze:custom`, plus the current `snoozed` when snoozed.

- [ ] **Step 1: Failing test**

`src/components/customers/TicketSidebar.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as support from '@/lib/api-support'
import type { SupportThread } from '@/lib/api-support'
import { TicketSidebar } from './TicketSidebar'

vi.mock('@/lib/api-support', async () => {
  const actual = await vi.importActual<typeof support>('@/lib/api-support')
  return { ...actual, getSupportWorkspace: vi.fn() }
})

const thread: SupportThread = {
  id: 'th_b', ref: 'T-1540', title: 'Contact form', status: 'open', priority: 'high', labels: ['Engineering'],
  label_refs: [{ id: 'l_1', type_id: 'lt_1', name: 'Engineering' }], assignee: 'Forrest Parker', assignee_id: 'u_1',
  customer_plain_id: 'c_1', created_at: null, updated_at: null, preview: '', waiting_since: null, plain_url: 'https://p/x',
  status_detail: { kind: 'needs_next_response', label: 'Needs next response', until: null },
  assignees: [
    { plain_user_id: 'u_1', name: 'Forrest Parker', avatar_url: null, primary: true },
    { plain_user_id: 'u_2', name: 'Lauren Hamilton', avatar_url: null, primary: false },
  ],
  tier: { name: 'Regular Support', color: '#3b82f6' },
  fields: [
    { key: 'verification_code', label: 'Verification Code', value: null },
    { key: 'wp_user_id', label: 'WP User ID', value: '3173' },
    { key: 'total_orders', label: 'Total Orders', value: '2' },
    { key: 'total_spent', label: 'Total Spent', value: '$160.00' },
    { key: 'company', label: 'Company', value: null },
    { key: 'sales_rep', label: 'Sales Rep', value: 'Scott' },
  ],
  customer: { name: 'Lilia Billones', email: 'lilia@example.com', external_id: '3173', avatar_url: null, company: null,
              created_at: '2026-08-25T00:00:00Z', updated_at: '2026-08-25T00:00:00Z',
              wp_profile_url: 'https://accumarklabs.com/wp-admin/user-edit.php?user_id=3173' },
}
const other: SupportThread = { ...thread, id: 'th_a', ref: 'T-1500', title: 'Older one', status: 'done' }

function setup(canEdit = true) {
  vi.mocked(support.getSupportWorkspace).mockResolvedValue({
    teammates: [{ plain_user_id: 'u_1', name: 'Forrest Parker', email: 'f@x' },
                { plain_user_id: 'u_2', name: 'Lauren Hamilton', email: 'l@x' },
                { plain_user_id: 'u_3', name: 'Scott Joseph', email: 's@x' }],
    label_types: [{ id: 'lt_2', name: 'Shipping', color: null }],
  })
  const run = vi.fn().mockResolvedValue(undefined)
  const onSelect = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TicketSidebar thread={thread} threads={[thread, other]} canEdit={canEdit} run={run} onSelect={onSelect} />
    </QueryClientProvider>
  )
  return { run, onSelect }
}

const ready = async (label: string) => {
  const el = await screen.findByLabelText(label)
  await waitFor(() => expect(el).toBeEnabled())
  return el
}

describe('TicketSidebar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows Plain details, tier, the first fields and the customer', async () => {
    setup()
    expect(screen.getByText('Regular Support')).toBeInTheDocument()
    expect(screen.getByText('3173', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.queryByText('Sales Rep')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show more fields' }))
    expect(screen.getByText('Sales Rep')).toBeInTheDocument()
    expect(screen.getByText('lilia@example.com')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '3173' })).toHaveAttribute('href', thread.customer?.wp_profile_url)
  })

  it('status menu includes waiting for customer', async () => {
    const { run } = setup()
    await userEvent.selectOptions(await ready('Status'), 'waiting_for_customer')
    await waitFor(() => expect(run).toHaveBeenCalledWith('status', { status: 'waiting_for_customer' }))
  })

  it('adds and removes additional assignees', async () => {
    const { run } = setup()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove assignee Lauren Hamilton' }))
    await waitFor(() => expect(run).toHaveBeenCalledWith('assignees', { remove: ['u_2'] }))
    await userEvent.selectOptions(await ready('Add assignee'), 'u_3')
    await waitFor(() => expect(run).toHaveBeenCalledWith('assignees', { add: ['u_3'] }))
  })

  it('priority and labels still call their actions', async () => {
    const { run } = setup()
    await userEvent.selectOptions(await ready('Priority'), 'urgent')
    await waitFor(() => expect(run).toHaveBeenCalledWith('priority', { priority: 'urgent' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Remove label Engineering' }))
    await waitFor(() => expect(run).toHaveBeenCalledWith('labels', { remove: ['l_1'] }))
  })

  it('recent threads switch the ticket', async () => {
    const { onSelect } = setup()
    await userEvent.click(screen.getByRole('button', { name: /T-1500/ }))
    expect(onSelect).toHaveBeenCalledWith(other)
  })

  it('is read-only without a seat', () => {
    setup(false)
    expect(screen.queryByLabelText('Status')).toBeNull()
    expect(screen.getByText('Needs next response')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove label/ })).toBeNull()
  })
})
```

- [ ] **Step 2: Run to watch it fail**

Run: `npx vitest run src/components/customers/TicketSidebar.test.tsx`
Expected: FAIL, unresolved import `./TicketSidebar`.

- [ ] **Step 3: Implement**

`src/components/customers/TicketSidebar.tsx`:

```tsx
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, CircleCheck, Clock, Loader2, Reply, X } from 'lucide-react'
import { getSupportWorkspace, type SupportAction, type SupportThread } from '@/lib/api-support'
import { cn } from '@/lib/utils'
import { PlainAvatar } from './PlainAvatar'
import { supportErrorMessage } from './support-errors'
import { exact } from './plain-time'

type Run = (action: SupportAction, body: Record<string, unknown>) => Promise<void>

function at8(daysAhead: number, weekday?: number): string {
  const d = new Date()
  if (weekday !== undefined) d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7 || 7))
  else d.setDate(d.getDate() + daysAhead)
  d.setHours(8, 0, 0, 0)
  return d.toISOString()
}

export const SNOOZE_PRESETS: Record<string, () => string> = {
  'snooze:1h': () => new Date(Date.now() + 3_600_000).toISOString(),
  'snooze:tomorrow': () => at8(1),
  'snooze:monday': () => at8(0, 1),
}

const sel = 'rounded-md border border-[var(--pv-border)] bg-[var(--pv-surface)] px-2 py-1 text-sm'
const FIRST_FIELDS = 5

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-2 py-1 text-sm">
      <dt className="font-medium text-[var(--pv-ink-2)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="border-b border-[var(--pv-border)] px-4 py-3">
      <button type="button" className="flex w-full items-center justify-between font-semibold" onClick={() => setOpen(o => !o)}>
        {title}
        <ChevronDown className={cn('h-4 w-4 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  )
}

const statusIcon = (status: string) => (status === 'done' ? CircleCheck : status === 'snoozed' ? Clock : Reply)

/** Plain's right-hand details: thread details, customer details, recent threads (spec 4.3). */
export function TicketSidebar({
  thread,
  threads,
  canEdit,
  run,
  onSelect,
}: {
  thread: SupportThread
  threads: SupportThread[]
  canEdit: boolean
  run: Run
  onSelect: (t: SupportThread) => void
}) {
  const ws = useQuery({ queryKey: ['support', 'workspace'], queryFn: getSupportWorkspace, staleTime: 600_000, enabled: canEdit })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [moreFields, setMoreFields] = useState(false)
  const [customUntil, setCustomUntil] = useState<string | null>(null)

  const act = async (action: SupportAction, body: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await run(action, body)
    } catch (e) {
      setError(supportErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onStatus = (v: string) => {
    if (v === 'open') return void act('status', { status: 'todo' })
    if (v === 'done' || v === 'waiting_for_customer') return void act('status', { status: v })
    const preset = SNOOZE_PRESETS[v]
    if (preset) return void act('status', { status: 'snoozed', until: preset() })
    if (v === 'snooze:custom') setCustomUntil('')
  }

  const detail = thread.status_detail
  const assignees = thread.assignees ?? []
  const primary = assignees.find(a => a.primary)
  const extra = assignees.filter(a => !a.primary)
  const refs = thread.label_refs ?? []
  const fields = thread.fields ?? []
  const shown = moreFields ? fields : fields.slice(0, FIRST_FIELDS)
  const c = thread.customer
  const teammates = ws.data?.teammates ?? []
  const addable = teammates.filter(t => !assignees.some(a => a.plain_user_id === t.plain_user_id))
  const unusedLabels = (ws.data?.label_types ?? []).filter(lt => !refs.some(r => r.type_id === lt.id))
  const StatusIcon = statusIcon(thread.status)
  const disabled = busy || !ws.data

  return (
    <div className="text-[var(--pv-ink)]">
      <Section title="Thread details">
        <div className="mb-2 font-semibold">{thread.title}</div>
        <dl>
          <Row label="Company">{c?.company ?? <span className="text-[var(--pv-ink-3)]">No company</span>}</Row>
          <Row label="Customer">
            {c ? (
              <span className="flex items-center gap-2">
                <PlainAvatar name={c.name} url={c.avatar_url} size={20} /> {c.name}
              </span>
            ) : null}
          </Row>
          <Row label="Status">
            {canEdit ? (
              <span className="flex flex-col gap-1">
                <select aria-label="Status" className={sel} disabled={disabled}
                  value={thread.status === 'snoozed' ? (detail?.kind === 'waiting_for_customer' ? 'waiting_for_customer' : 'snoozed') : thread.status}
                  onChange={e => onStatus(e.target.value)}>
                  <option value="open">Needs next response</option>
                  <option value="waiting_for_customer">Waiting for customer</option>
                  {thread.status === 'snoozed' && detail?.kind !== 'waiting_for_customer' && (
                    <option value="snoozed">{detail?.label ?? 'Snoozed'}</option>
                  )}
                  <option value="snooze:1h">Snooze 1 hour</option>
                  <option value="snooze:tomorrow">Snooze until tomorrow 8 am</option>
                  <option value="snooze:monday">Snooze until Monday 8 am</option>
                  <option value="snooze:custom">Snooze until...</option>
                  <option value="done">Done</option>
                </select>
                {customUntil !== null && (
                  <span className="flex gap-1">
                    <input type="datetime-local" aria-label="Snooze until" className={sel} onChange={e => setCustomUntil(e.target.value)} />
                    <button type="button" className={sel} disabled={!customUntil}
                      onClick={() => {
                        const until = new Date(customUntil ?? '').toISOString()
                        setCustomUntil(null)
                        void act('status', { status: 'snoozed', until })
                      }}>
                      Snooze
                    </button>
                  </span>
                )}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <StatusIcon className="h-4 w-4 text-[var(--pv-accent)]" /> {detail?.label ?? thread.status}
              </span>
            )}
          </Row>
          <Row label="Assignee">
            <div className="flex flex-col gap-1">
              {canEdit ? (
                <select aria-label="Assignee" className={sel} disabled={disabled} value={primary?.plain_user_id ?? ''}
                  onChange={e => void act('assign', { plain_user_id: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {teammates.map(t => (
                    <option key={t.plain_user_id} value={t.plain_user_id}>{t.name}</option>
                  ))}
                </select>
              ) : primary ? (
                <span className="flex items-center gap-2"><PlainAvatar name={primary.name} url={primary.avatar_url} size={20} /> {primary.name}</span>
              ) : (
                <span className="text-[var(--pv-ink-3)]">Unassigned</span>
              )}
              {extra.map(a => (
                <span key={a.name} className="ml-4 flex items-center gap-2">
                  <PlainAvatar name={a.name} url={a.avatar_url} size={20} /> {a.name}
                  {canEdit && a.plain_user_id && (
                    <button type="button" aria-label={`Remove assignee ${a.name}`} disabled={busy}
                      onClick={() => void act('assignees', { remove: [a.plain_user_id] })}>
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
              {canEdit && (
                <select aria-label="Add assignee" className={cn(sel, 'ml-4')} disabled={disabled} value=""
                  onChange={e => { if (e.target.value) void act('assignees', { add: [e.target.value] }) }}>
                  <option value="">+ Assign</option>
                  {addable.map(t => (
                    <option key={t.plain_user_id} value={t.plain_user_id}>{t.name}</option>
                  ))}
                </select>
              )}
            </div>
          </Row>
          <Row label="Priority">
            {canEdit ? (
              <select aria-label="Priority" className={sel} disabled={disabled} value={thread.priority}
                onChange={e => void act('priority', { priority: e.target.value })}>
                {(['urgent', 'high', 'normal', 'low'] as const).map(p => (
                  <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
            ) : (
              thread.priority.charAt(0).toUpperCase() + thread.priority.slice(1)
            )}
          </Row>
          <Row label="Labels">
            <span className="flex flex-wrap items-center gap-1">
              {refs.map(r => (
                <span key={r.id} className="inline-flex items-center gap-1 rounded-md border border-[var(--pv-border)] px-2 py-0.5">
                  {r.name}
                  {canEdit && (
                    <button type="button" aria-label={`Remove label ${r.name}`} disabled={busy}
                      onClick={() => void act('labels', { remove: [r.id] })}>
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
              {canEdit && (
                <select aria-label="Add label" className={sel} disabled={disabled} value=""
                  onChange={e => { if (e.target.value) void act('labels', { add: [e.target.value] }) }}>
                  <option value="">+</option>
                  {unusedLabels.map(lt => (
                    <option key={lt.id} value={lt.id}>{lt.name}</option>
                  ))}
                </select>
              )}
            </span>
          </Row>
          {thread.tier && (
            <Row label="Thread tier">
              <span className="inline-flex items-center gap-1 rounded-md border border-[var(--pv-border)] px-2 py-0.5">
                <span className="h-2 w-2 rounded-sm" style={{ background: thread.tier.color ?? 'var(--pv-accent)' }} />
                {thread.tier.name}
              </span>
            </Row>
          )}
          {shown.map(f => (
            <Row key={f.key} label={f.label}>
              {f.value ?? <span className="text-[var(--pv-ink-3)]">{f.label}</span>}
            </Row>
          ))}
        </dl>
        {fields.length > FIRST_FIELDS && (
          <button type="button" className="mt-1 text-sm text-[var(--pv-ink-2)]" onClick={() => setMoreFields(m => !m)}>
            {moreFields ? 'Show fewer fields' : 'Show more fields'}
          </button>
        )}
        {busy && <Loader2 className="mt-2 h-3 w-3 animate-spin text-[var(--pv-ink-3)]" />}
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </Section>
      {c && (
        <Section title="Customer details">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <PlainAvatar name={c.name} url={c.avatar_url} /> {c.name}
          </div>
          <dl>
            <Row label="Email">{c.email}</Row>
            <Row label="External ID">
              {c.wp_profile_url ? (
                <a className="text-[var(--pv-accent)] underline" href={c.wp_profile_url} target="_blank" rel="noreferrer">
                  {c.external_id}
                </a>
              ) : (
                c.external_id
              )}
            </Row>
            <Row label="Created at">{exact(c.created_at).split(',').slice(0, 2).join(',')}</Row>
            <Row label="Updated at">{exact(c.updated_at).split(',').slice(0, 2).join(',')}</Row>
          </dl>
        </Section>
      )}
      <Section title="Recent threads">
        <ul className="flex flex-col gap-1">
          {threads.filter(t => t.id !== thread.id).map(t => {
            const Icon = statusIcon(t.status)
            return (
              <li key={t.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-[var(--pv-surface)]"
                  onClick={() => onSelect(t)}>
                  <Icon className="h-4 w-4 shrink-0 text-[var(--pv-ink-3)]" />
                  <span className="text-[var(--pv-ink-3)]">{t.ref}</span>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </Section>
    </div>
  )
}
```

Delete `src/components/customers/SupportThreadControls.tsx`. Its only importer is `SupportThreadPanel.tsx`, which Task 5 rewrites. Do the delete in Task 5's commit, so this task's tree still typechecks: until then, leave the file in place.

- [ ] **Step 4: Run to watch it pass**

Run: `npx vitest run src/components/customers/TicketSidebar.test.tsx`, then `npx tsc --noEmit -p /c/tmp/mk1-plain-view/tsconfig.json`.
Expected: PASS, and `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/customers/TicketSidebar.tsx src/components/customers/TicketSidebar.test.tsx
git commit -m "feat(support): Plain-style details sidebar"
```

---

### Task 5: Action bar, two-column panel and wiring

**Files:**
- Create: `src/components/customers/TicketActionBar.tsx`
- Modify: `src/components/customers/SupportComposer.tsx` (`initialTab` and `onClose` props, Esc)
- Modify: `src/components/customers/useSlideoutWidth.ts` and `ResizableSheetContent.tsx` (`widthKey` and `defaultWidth`)
- Modify: `src/components/customers/SupportThreadPanel.tsx` (layout)
- Modify: `src/components/customers/CustomerSupportTab.tsx` (pass `threads` and `onSelect`)
- Delete: `src/components/customers/SupportThreadControls.tsx`
- Modify: `src/components/customers/SupportThreadPanel.test.tsx` (open the composer through the bar; the new layout tests)

**Interfaces:**
- Consumes: Tasks 3 and 4 (`TicketTimeline`, `TicketSidebar`, `SNOOZE_PRESETS`, `plain-view.css`).
- Produces:
  - `<TicketActionBar customerFirstName onOpen={(tab: 'reply' | 'note') => void} onMore={(action: string) => void} />`, which listens for R/N on `window`.
  - `useSlideoutWidth({ key?, defaultWidth? })`.
  - `<ResizableSheetContent widthKey? defaultWidth?>`.
  - `SupportThreadPanel` gains the optional props `threads?: SupportThread[]` and `onSelect?: (t: SupportThread) => void`.

- [ ] **Step 1: Failing tests**

In `SupportThreadPanel.test.tsx`, the composer is no longer open by default, which is a behaviour change from the spec:
- Add the helper `const openReply = async () => userEvent.click(await screen.findByRole('button', { name: /Reply to/ }))`. Call it before every existing test that types into the Reply box.
- For the note test, call `userEvent.click(await screen.findByRole('button', { name: 'Add note' }))` instead of clicking the Note tab.
- Delete the old test `status, priority, assignee and labels call their actions`; it moved to `TicketSidebar.test.tsx`.
- Delete the old test `snooze presets send an until in the future`; Task 4 covers the presets.

Then append:

```tsx
  it('lays out Plain-style: action bar, sidebar, oldest first', async () => {
    setup()
    expect(await screen.findByRole('button', { name: 'Reply to Kyle' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument()
    expect(screen.getByText('Thread details')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Oldest first/ })).toBeInTheDocument()
  })

  it('R and N open the composer, Esc closes it', async () => {
    setup()
    await screen.findByRole('button', { name: 'Add note' })
    await userEvent.keyboard('n')
    expect(await screen.findByRole('textbox', { name: /Note/ })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /Note/ })).toBeNull())
    await userEvent.keyboard('r')
    expect(await screen.findByRole('textbox', { name: /Reply/ })).toBeInTheDocument()
  })

  it('R and N do nothing while typing', async () => {
    setup()
    await userEvent.keyboard('r')
    const box = await screen.findByRole('textbox', { name: /Reply/ })
    await userEvent.type(box, 'rn')
    expect(box).toHaveValue('rn')
    expect(screen.queryByRole('textbox', { name: /Note/ })).toBeNull()
  })

  it('More offers waiting for customer', async () => {
    setup()
    await userEvent.click(await screen.findByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Waiting for customer' }))
    await waitFor(() =>
      expect(support.supportAction).toHaveBeenCalledWith('wc:1', 'th_b', 'status', { status: 'waiting_for_customer' })
    )
  })
```

In the same file's `setup`:
- Give the `detail` fixture's `thread` the fields `customer: { name: 'Kyle Robertson', email: 'k@x', external_id: null, avatar_url: null, company: null, created_at: null, updated_at: null, wp_profile_url: null }`, `assignees: []` and `fields: []`.
- Clear `localStorage` in `beforeEach`, as it already does.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run src/components/customers/SupportThreadPanel.test.tsx`
Expected: FAIL, because there is no `Reply to Kyle` button and no `Thread details`.

- [ ] **Step 3: Width hook and sheet**

In `useSlideoutWidth.ts`, change the signature to `export function useSlideoutWidth({ key = KEY, defaultWidth = DEFAULT_WIDTH }: { key?: string; defaultWidth?: number } = {})`. Make `readStored(key, defaultWidth)` and `writeStored(key, w)` take those parameters, and pass them through at their two call sites. In `ResizableSheetContent.tsx`, add `widthKey?: string; defaultWidth?: number` to the props (destructure them so they are not spread onto `SheetContent`) and call `useSlideoutWidth({ key: widthKey, defaultWidth })`.

- [ ] **Step 4: Composer props**

In `SupportComposer.tsx`:
- Add the props `initialTab?: Tab` and `onClose?: () => void`.
- Initialise `useState<Tab>(initialTab ?? 'reply')`, and add `useEffect(() => { if (initialTab) setTab(initialTab) }, [initialTab])`.
- Add `autoFocus` to the textarea so R/N put the cursor in the composer.
- Esc is handled by the panel's `onEscapeKeyDown` on the sheet (Radix closes the whole sheet on Esc otherwise, before any textarea handler runs); `onClose` stays for that caller.

- [ ] **Step 5: Action bar**

`src/components/customers/TicketActionBar.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { MoreHorizontal, NotebookPen, Reply } from 'lucide-react'
import { SNOOZE_PRESETS } from './TicketSidebar'

const TYPING = 'input, textarea, select, [contenteditable="true"]'
const MORE = [
  ['done', 'Mark done'],
  ['waiting_for_customer', 'Waiting for customer'],
  ['snooze:1h', 'Snooze for 1 hour'],
  ['snooze:tomorrow', 'Snooze until tomorrow 8 am'],
  ['snooze:monday', 'Snooze until Monday 8 am'],
  ['todo', 'Back to Todo'],
] as const

/** Plain's bottom bar: Reply (R), Add note (N), More. Keys ignored while typing. */
export function TicketActionBar({
  customerFirstName,
  onOpen,
  onMore,
}: {
  customerFirstName: string
  onOpen: (tab: 'reply' | 'note') => void
  onMore: (action: string, until?: string) => void
}) {
  const [menu, setMenu] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.target instanceof Element && e.target.closest(TYPING)) return
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        onOpen('reply')
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        onOpen('note')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen])

  const btn = 'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-[var(--pv-surface)]'
  const kbd = 'rounded border border-[var(--pv-border)] px-1 text-xs text-[var(--pv-ink-3)]'
  return (
    <div className="relative flex justify-center p-3">
      <div className="flex items-center gap-1 rounded-xl border border-[var(--pv-border)] bg-[var(--pv-card)] p-1 shadow-sm">
        <button type="button" className={btn} onClick={() => onOpen('reply')}>
          <Reply className="h-4 w-4 text-[var(--pv-accent)]" /> Reply to {customerFirstName} <kbd className={kbd}>R</kbd>
        </button>
        <button type="button" className={btn} onClick={() => onOpen('note')}>
          <NotebookPen className="h-4 w-4 text-[var(--pv-note-ink)]" /> Add note <kbd className={kbd}>N</kbd>
        </button>
        <button type="button" className={btn} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)}>
          <MoreHorizontal className="h-4 w-4" /> More
        </button>
      </div>
      {menu && (
        <div role="menu" className="absolute bottom-14 z-10 flex min-w-56 flex-col rounded-lg border border-[var(--pv-border)] bg-[var(--pv-card)] p-1 shadow-lg">
          {MORE.map(([value, label]) => (
            <button key={value} role="menuitem" type="button" className={btn}
              onClick={() => {
                setMenu(false)
                const preset = SNOOZE_PRESETS[value]
                onMore(preset ? 'snoozed' : value, preset ? preset() : undefined)
              }}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Panel layout**

Rewrite the body of `SupportThreadPanel` (keep the query, `run`, the seat and the order state):
- Change `readOrder` so it returns `'newest'` only when stored as `'newest'`, and `'oldest'` otherwise.
- Add `import './plain-view.css'`.
- Add `const [composer, setComposer] = useState<'reply' | 'note' | null>(null)` and `const [details, setDetails] = useState(false)`.
- Add a ref `const scroller = useRef<HTMLDivElement>(null)` and an effect that scrolls it to the bottom when `d` first loads and `order === 'oldest'`: `useEffect(() => { const el = scroller.current; if (el && order === 'oldest') el.scrollTop = el.scrollHeight }, [d?.thread.id, order])`.
- Derive `const first = (current?.customer?.name ?? 'customer').split(' ')[0]`.
- `onMore = (action, until) => void run('status', action === 'todo' ? { status: 'todo' } : until ? { status: 'snoozed', until } : { status: action })`.

Render:

```tsx
<Sheet open={thread !== null} onOpenChange={o => !o && onClose()}>
  <ResizableSheetContent widthKey="mk1.supportSlideoutWidth" defaultWidth={1100}
    className="plain-view @container flex flex-col gap-0 overflow-hidden p-0"
    onEscapeKeyDown={e => {
      // Esc closes the composer first (draft kept); only a second Esc closes the slide-out.
      if (composer) {
        e.preventDefault()
        setComposer(null)
      }
    }}>
    <SheetHeader className="border-b border-[var(--pv-border)] px-4 py-3">
      <SheetTitle className="flex items-center gap-2 text-[var(--pv-ink)]">
        <span className="text-[var(--pv-ink-3)]">{current?.ref}</span> {current?.title}
      </SheetTitle>
      <SheetDescription className="flex flex-wrap items-center gap-2 text-[var(--pv-ink-2)]">
        <span>{current?.status_detail?.label ?? current?.status}</span>
        <span>· {current?.priority}</span>
        {current && (
          <a className="text-[var(--pv-accent)] hover:underline" href={current.plain_url} target="_blank" rel="noreferrer">
            Open in Plain
          </a>
        )}
      </SheetDescription>
    </SheetHeader>
    <div className="flex min-h-0 flex-1 flex-col @min-[820px]:flex-row">
      <button type="button" className="border-b border-[var(--pv-border)] px-4 py-2 text-left text-sm @min-[820px]:hidden"
        onClick={() => setDetails(v => !v)}>
        {details ? 'Hide details' : 'Details'}
      </button>
      <aside className={cn('overflow-y-auto border-[var(--pv-border)] @min-[820px]:order-2 @min-[820px]:block @min-[820px]:w-[300px] @min-[820px]:shrink-0 @min-[820px]:border-l',
        details ? 'block border-b' : 'hidden')}>
        {current && (
          <TicketSidebar thread={current} threads={threads ?? []} canEdit={hasSeat} run={run}
            onSelect={t => { setComposer(null); onSelect?.(t) }} />
        )}
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* existing loading / error / stale lines, then the order toggle, then: */}
          {d && <TicketTimeline entries={entries} customerFirstName={first} viewerName={seat.data?.name ?? ''} />}
        </div>
        {current && hasSeat && composer && (
          <SupportComposer threadId={current.id} threadStatus={current.status} sendAs={seat.data?.name ?? 'you'}
            initialTab={composer} onClose={() => setComposer(null)}
            onSubmit={(tab, markdown) => run(tab, { markdown })} />
        )}
        {current && hasSeat && (
          <TicketActionBar customerFirstName={first} onOpen={setComposer} onMore={onMore} />
        )}
        {seat.data && !hasSeat && (
          <p className="px-4 pb-3 text-xs text-[var(--pv-ink-3)]">Replying needs a Plain account under your Mk1 email.</p>
        )}
      </section>
    </div>
  </ResizableSheetContent>
</Sheet>
```

Imports: `useEffect` and `useRef` from react; `TicketTimeline`, `TicketSidebar`, `TicketActionBar`. Remove the `SupportThreadControls` import and the old inline entry rendering, then delete `SupportThreadControls.tsx`.

In `CustomerSupportTab.tsx`, pass `threads={q.data?.threads ?? []}` and `onSelect={setOpen}` to `<SupportThreadPanel>` (only those two props; do not reformat the file).

- [ ] **Step 7: Run to watch them pass, then everything Support**

Run:
- `npx vitest run src/components/customers/`
- `npx tsc --noEmit -p /c/tmp/mk1-plain-view/tsconfig.json`
- `npx eslint` on every created or modified file

Expected: PASS, `tsc` clean, eslint clean on those files.

- [ ] **Step 8: Commit**

```bash
git add src/components/customers/TicketActionBar.tsx src/components/customers/SupportComposer.tsx src/components/customers/useSlideoutWidth.ts src/components/customers/ResizableSheetContent.tsx src/components/customers/SupportThreadPanel.tsx src/components/customers/SupportThreadPanel.test.tsx src/components/customers/CustomerSupportTab.tsx
git rm src/components/customers/SupportThreadControls.tsx
git commit -m "feat(support): two-column Plain-style ticket view with action bar"
```

---

## After the tasks (not code)

1. Look at the real view in the browser on a devbox or local dev, in both themes, at about 1,100 px and at about 700 px.
2. Ship per spec section 7. No env or schema change.
