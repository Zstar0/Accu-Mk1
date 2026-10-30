# Customer Insights Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Insights page's at-risk card with an At risk / New customers / Cohorts tabbed section whose lists carry last-CRM and last-Support touch columns that open the customer's CRM or Support tab.

**Architecture:** Backend stays additive inside `backend/customer_insights/`: two new row fields, three `/list` filters, and one `/touchpoints` route that fans out through the existing cached Close and Plain services. The CRM timeline learns real sequence detection and carries the email status. Frontend restructures `CustomerInsights.tsx` into a tabbed card with a pure `TouchCell`, a shared sortable customer table, and store-held view state so drill-downs survive opening a customer.

**Tech Stack:** FastAPI + Pydantic + pytest (backend); React 19, TanStack Query, Zustand, shadcn `Tabs`/`Tooltip`, lucide, Vitest + Testing Library, Playwright (frontend). npm only.

**Spec:** `docs/superpowers/specs/2026-10-19-customer-insights-tabs-design.md`

## Global Constraints

- Work on branch `feat/customer-insights-tabs` from `origin/master` in its own worktree under `C:/tmp/` (superpowers:using-git-worktrees). The main checkout at `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1` is shared and on a docs branch: never switch it.
- This repo has `core.autocrlf=false` and files written by the Bash heredoc or Write tool here come out CRLF. Before every `git add` of a file you created, run `sed -i 's/\r$//' <file>`, then confirm `git ls-files --eol -- <file>` shows `i/lf w/lf`. Commit by pathspec (`git commit -m ... -- <paths>`).
- `FastAPI response_model` silently drops undeclared keys: every new response field in this plan must be declared on its Pydantic model.
- Backend tests run from `backend/` with `python -m pytest tests/<file> -q` (needs the host dev Postgres that `backend/.env` points at). They hit that shared database, so run ONE pytest process at a time, never two in parallel. If `python` hangs in this worktree, run the same file in the container instead: `docker exec accu-mk1-backend python -m pytest tests/<file> -q` on a checkout the container mounts.
- Frontend: `npm` only (never pnpm). `useUIStore` reads use selector syntax `useUIStore(state => state.x)` (ast-grep enforced). Non-trivial hovers use the shadcn `Tooltip` card pattern already in `CustomerInsights.tsx` (`font-mono`, sectioned), never `title=`.
- No em dashes anywhere (code, copy, docs, commit messages).
- Repo rule (CLAUDE.md): when the GitNexus MCP is available, run `gitnexus_impact` on an existing function before editing it and `gitnexus_detect_changes()` before committing. If the index is stale or the MCP is absent, say so in the task report and continue.
- Copy pinned by the spec: tab labels `At risk`, `New customers`, `Cohorts`; New customers subtitle `First testing order in this period, ranked by lifetime spend`; empty cohort hint `Pick a cohort to see its customers`; touch cell texts `none` and `n/a`.
- Version bump and release are not in this plan (the `accumark-deploy` skill owns them); the CHANGELOG entry goes under `## Unreleased`.

## Review Focus

1. A customer with paid but no testing orders (ACOA-only) must never crash `/list?new_only=true` or `cohort=`: `first_order_at` is null and the row is simply excluded. Pinned in Task 3.
2. A guest `email:` key the integration DB does not know returns `None` from both services; the touch row must say `none` with `reason=unknown_customer`, and the other keys in the same request must still be `ok`. Pinned in Task 4.
3. An email whose `status` is missing (not in Close's schema but possible in fixtures or older rows) must count as a touch, while `draft`, `scheduled`, `outbox` and `error` never do. Pinned in Task 1 and Task 4.
4. `period=all` resolves `lo` to `None`; `new_only=true` must then keep every customer with a testing order rather than comparing against `None`. Pinned in Task 3.
5. An admin opening At risk with more than 50 rows must get every cell: the hook chunks keys at 50 and merges, and one failed chunk degrades only its own rows. Pinned in Task 8.

---

### Task 1: CRM timeline knows sequences and carries the email status

**Files:**
- Modify: `backend/crm_close/rules.py` (after line 10)
- Modify: `backend/crm_close/timeline.py:47-83` (`normalize`)
- Modify: `backend/crm_close/routes.py:43-55` (`Item`)
- Modify: `src/lib/api-crm.ts:21-31` (`CrmItem`)
- Test: `backend/tests/test_crm_close_timeline.py`, `backend/tests/test_crm_close_routes.py`

**Interfaces:**
- Produces: `rules.AUTOMATED_FIELDS: tuple[str, ...] = ("sequence_id", "sequence_subscription_id", "bulk_email_action_id", "agent_config_id")`; normalized items gain `"email_status": str | None` (Close's `status` for emails, `None` for every other type); `Item.email_status: Optional[str] = None`.

- [ ] **Step 1: Update the exact-dict assertion and add the failing tests**

In `test_crm_close_timeline.py`, add `"email_status": None` to the expected dict in `test_email_normalized_with_inbound_direction_and_preview` (the fixture `email()` carries no `status`), then add:

```python
def test_sequence_bulk_and_agent_emails_are_automated():
    for field in ("sequence_id", "sequence_subscription_id", "bulk_email_action_id", "agent_config_id"):
        assert timeline.normalize(email(**{field: "x_1"}), LEADS)["automated"] is True
    assert timeline.normalize(email(sequence_id=None), LEADS)["automated"] is False


def test_email_status_is_carried_and_none_for_other_types():
    assert timeline.normalize(email(status="draft"), LEADS)["email_status"] == "draft"
    assert timeline.normalize(email(status="sent"), LEADS)["email_status"] == "sent"
    call = {"_type": "Call", "id": "acti_c", "lead_id": "lead_A", "date_created": "2026-09-03T10:00:00Z",
            "direction": "outbound", "duration": 60, "user_name": "Scott"}
    assert timeline.normalize(call, LEADS)["email_status"] is None
```

In `test_crm_close_routes.py::test_timeline_hides_automated_by_default_and_declares_every_key`, append:

```python
    assert "email_status" in body["items"][1]  # acti_1 is the email; declared on Item, so it survives response_model
```

- [ ] **Step 2: Run the three tests to verify they fail**

Run: `python -m pytest tests/test_crm_close_timeline.py tests/test_crm_close_routes.py -q`
Expected: FAIL (`KeyError: 'email_status'` / dict mismatch / `automated` is False for `sequence_id`).

- [ ] **Step 3: Implement**

`rules.py`: add `AUTOMATED_FIELDS` as in Interfaces, with a comment citing the Close email activity reference (2026-10-19).
`timeline.normalize`: in the `kind == "email"` branch, `automated` is true when the existing subject or sender rule matches OR `any(a.get(f) for f in rules.AUTOMATED_FIELDS)`; set `email_status = a.get("status")` for emails and `None` otherwise; add `"email_status": email_status` to the returned dict.
`routes.Item`: add `email_status: Optional[str] = None`.
`api-crm.ts`: add `email_status?: string | null` to `CrmItem`.

- [ ] **Step 4: Run the two backend files and the frontend typecheck**

Run: `python -m pytest tests/test_crm_close_timeline.py tests/test_crm_close_routes.py -q` then `npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(crm): sequence, bulk and agent emails count as automated; items carry email_status" -- backend/crm_close/rules.py backend/crm_close/timeline.py backend/crm_close/routes.py src/lib/api-crm.ts backend/tests/test_crm_close_timeline.py backend/tests/test_crm_close_routes.py
```

---

### Task 2: Customer rows carry first order and testing-order count

**Files:**
- Modify: `backend/customer_insights/metrics.py:191-218` (`customer_rows`)
- Modify: `backend/customer_insights/routes.py:123-139` (`CustomerRow`), `:178-179` (`SortField`)
- Test: `backend/tests/test_customer_insights_metrics.py`, `backend/tests/test_customer_insights_routes.py`

**Interfaces:**
- Produces: every row from `customer_rows` (and so `at_risk` and `/list`) has `first_order_at: str | None` (ISO of `min(dates)`, the first testing order) and `testing_orders: int`. `SortField` accepts `"first_order_at"` and `"testing_orders"`.

- [ ] **Step 1: Write the failing tests**

`test_customer_insights_metrics.py`:

```python
def test_customer_rows_first_order_and_testing_count() -> None:
    data = ds([o("wc:1", 0, "100"), o("wc:1", 5, "40", testing=False), o("wc:1", 20, "100"), o("wc:2", 3, "80", testing=False)])
    rows = {r["key"]: r for r in metrics.customer_rows(data, start=None, end=T0 + timedelta(days=30), tz=TZ)}
    assert rows["wc:1"]["first_order_at"] == (T0).isoformat() and rows["wc:1"]["testing_orders"] == 2
    assert rows["wc:1"]["orders"] == 3
    assert rows["wc:2"]["first_order_at"] is None and rows["wc:2"]["testing_orders"] == 0
```

`test_customer_insights_routes.py`, extend `test_orders_json_and_at_risk_fields_survive`:

```python
    assert {"first_order_at", "testing_orders"} <= set(risk)
    lst = client.get("/reports/customers/list?period=all&sort=first_order_at&dir=asc").json()
    assert lst["rows"][0]["first_order_at"] is not None
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_customer_insights_metrics.py tests/test_customer_insights_routes.py -q`
Expected: FAIL with `KeyError: 'first_order_at'` and a 422 on the sort field.

- [ ] **Step 3: Implement**

In `customer_rows`, add `"first_order_at": min(dates).isoformat() if dates else None` and `"testing_orders": len(dates)` to the row dict. Declare both on `CustomerRow` (`first_order_at: Optional[str] = None`, `testing_orders: int`). Add both names to `SortField`.

- [ ] **Step 4: Run both files to verify they pass**

Run: `python -m pytest tests/test_customer_insights_metrics.py tests/test_customer_insights_routes.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(insights): customer rows carry first_order_at and testing_orders" -- backend/customer_insights/metrics.py backend/customer_insights/routes.py backend/tests/test_customer_insights_metrics.py backend/tests/test_customer_insights_routes.py
```

---

### Task 3: `/list` filters for new customers and cohort members

**Files:**
- Modify: `backend/customer_insights/metrics.py` (new helper next to `cohorts`)
- Modify: `backend/customer_insights/routes.py:219-236` (`customers_list`)
- Test: `backend/tests/test_customer_insights_routes.py`

**Interfaces:**
- Consumes: `first_order_at` from Task 2; `rules.lab_month(dt, tz)`; `metrics.cohorts`.
- Produces: `metrics.filter_rows(rows: list[dict], ds: Dataset, *, lo: datetime | None, hi: datetime, tz: str, new_only: bool = False, cohort: str | None = None, returned_in: str | None = None) -> list[dict]` (pure). `/list` query params `new_only: bool = False`, `cohort: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}$")`, `returned_in: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}$")`.

- [ ] **Step 1: Write the failing tests**

Add to `test_customer_insights_routes.py` (fixture `DS`: `wc:1` has three testing orders 200/190/180 days before `NOW` = 2026-10-05, i.e. first order 2026-03-19 lab time, cohort `2026-03`, later orders in `2026-03` and `2026-04`; the guest has one order 10 days before `NOW`, cohort `2026-09`):

```python
def test_list_new_only_follows_the_period_window(client) -> None:
    assert client.get("/reports/customers/list?period=30d&new_only=true").json()["total"] == 1
    assert client.get("/reports/customers/list?period=all&new_only=true").json()["total"] == 2
    assert client.get("/reports/customers/list?from=2026-03-01&to=2026-03-31&new_only=true").json()["rows"][0]["key"] == "wc:1"


def test_list_cohort_total_matches_the_grid_and_returned_in_narrows(client) -> None:
    grid = {r["cohort"]: r for r in client.get("/reports/customers/cohorts").json()["rows"]}
    for month, row in grid.items():
        got = client.get(f"/reports/customers/list?cohort={month}&exclude_launch_accounts=true&page_size=1").json()
        assert got["total"] == row["size"], month
    assert client.get("/reports/customers/list?cohort=2026-03&returned_in=2026-04").json()["total"] == 1
    assert client.get("/reports/customers/list?cohort=2026-03&returned_in=2026-05").json()["total"] == 0


def test_list_cohort_validation(client) -> None:
    assert client.get("/reports/customers/list?returned_in=2026-04").status_code == 422
    assert client.get("/reports/customers/list?cohort=2026-03&returned_in=2026-03").status_code == 422
    assert client.get("/reports/customers/list?cohort=March").status_code == 422


def test_list_filters_skip_customers_without_a_testing_order(client, monkeypatch) -> None:
    from dataclasses import replace
    addon_only = replace(DS, orders=DS.orders + (replace(_o("wc:7", 3, "60", oid=9), is_testing=False, samples=0, tests=()),))
    monkeypatch.setattr(sources, "load_dataset", lambda db, now: addon_only)
    keys = {r["key"] for r in client.get("/reports/customers/list?period=all&new_only=true").json()["rows"]}
    assert "wc:7" not in keys
    assert client.get("/reports/customers/list?cohort=2026-10").json()["total"] == 0
```

(`DS.customers` has no `wc:7` entry; `customer_rows` falls back to the key as the name, so no fixture change is needed.)

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_customer_insights_routes.py -q -k "new_only or cohort"`
Expected: FAIL (unknown query params are ignored, so totals are wrong; validation tests get 200).

- [ ] **Step 3: Implement `metrics.filter_rows` and wire it into `customers_list`**

`filter_rows` keeps a row only if: with `new_only`, `first_order_at` is not None and (`lo is None or lo <= first`) and `first <= hi`; with `cohort`, `first_order_at` is not None and `rules.lab_month(first, tz) == cohort`; with `returned_in`, the customer has a testing order whose lab month equals `returned_in` (compute from `ds.orders` the same way `cohorts()` builds `months_by_key`). Parse `first_order_at` back with `datetime.fromisoformat`. In the route: `returned_in` without `cohort`, or equal to it, raises `HTTPException(422)`; apply `filter_rows` before the search filter so `total` reflects it.

- [ ] **Step 4: Run the whole file to verify it passes**

Run: `python -m pytest tests/test_customer_insights_routes.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(insights): /list filters new_only, cohort and returned_in" -- backend/customer_insights/metrics.py backend/customer_insights/routes.py backend/tests/test_customer_insights_routes.py
```

---

### Task 4: `/reports/customers/touchpoints`

**Files:**
- Create: `backend/customer_insights/touchpoints.py`
- Modify: `backend/customer_insights/rules.py` (constants)
- Modify: `backend/customer_insights/routes.py` (new route placed between `/changes` at line 402 and the `/{customer_key}` route at line 412)
- Modify: `backend/crm_close/service.py:60-61` and `backend/support_plain/service.py:86-88` (refresh success paths)
- Create: `backend/tests/test_customer_insights_touchpoints.py`

**Interfaces:**
- Consumes: `crm_close.service.customer_crm(key, *, refresh, types, include_automated, page, page_size)`, `support_plain.service.customer_support(key, *, refresh, statuses, page, page_size)`, `support_plain.seat.is_support_reader(user)`, both services' module-level `CACHE` (`TTLCache` with `get_or_load`, `drop`).
- Produces, in `touchpoints.py`:
  - `rules.TOUCH_TTL = 900`, `rules.TOUCH_SCAN = 10`, `rules.TOUCH_WORKERS = 4`, `rules.TOUCH_MAX_KEYS = 50`, `rules.TOUCH_EMAIL_STATUSES = frozenset({"sent", "inbox"})`.
  - Pydantic models `CrmTouch`, `SupportTouch`, `Touchpoints`, `TouchpointsResponse` exactly as spec 4.1 (every field declared; `state: Literal["ok", "none", "unavailable"]`; `reason: Optional[Literal["not_configured", "unavailable", "unknown_customer"]]`; `stale: bool = False`).
  - `class Unavailable(Exception)` carrying `reason`.
  - `crm_touch(key: str) -> dict` and `support_touch(key: str) -> dict`: return an `ok`/`none` dict or raise `Unavailable`. Read through `_crm_cache.get_or_load(f"touch:{key}", rules.TOUCH_TTL, loader)` / `_support_cache...`; because `get_or_load` stores only what the loader returns, a raised `Unavailable` is never cached.
  - `collect(keys: list[str], *, crm: bool, support: bool) -> dict[str, dict]`: `ThreadPoolExecutor(max_workers=rules.TOUCH_WORKERS)`, one future per key, catches `Unavailable` per field into `{"state": "unavailable", "reason": ..., "stale": False}`, and catches any other exception the same way with `reason="unavailable"` plus a warning log naming the key kind only.
  - Module-level seams for tests: `_crm_fn = crm_service.customer_crm`, `_support_fn = support_service.customer_support`, `_crm_cache = crm_service.CACHE`, `_support_cache = support_service.CACHE`, `_is_support_reader = seat.is_support_reader`.
  - Route `GET /reports/customers/touchpoints` with `keys: list[str] = Query(...)` (required, so no keys is a 422), `_u=Depends(get_current_user)`; the body raises `HTTPException(422)` when `len(keys) > rules.TOUCH_MAX_KEYS`; `crm_visible = _u.role == "admin"`, `support_visible = _is_support_reader(_u)`. One `logger.info` per request with the key count, both visible flags and the count of rows per state; never an email address.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_customer_insights_touchpoints.py`, following the `api` fixture style of `test_crm_close_routes.py` (dependency override for `get_current_user`, `CACHE.drop("")` on both caches in setup):

```python
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
```

Also add one test each to `test_crm_close_routes.py` and `test_support_plain_routes.py` proving a `?refresh=true` call drops the summary (the refresh path is the only writer the touchpoints module relies on):

```python
def test_refresh_drops_the_touch_summary(api):
    client, _ = api
    service.CACHE.put("touch:wc:1", {"state": "none"})
    assert client.get("/crm/customers/wc:1?refresh=true").status_code == 200   # /support/customers/wc:1 in the Plain file
    assert service.CACHE.peek("touch:wc:1") is None
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_customer_insights_touchpoints.py -q`
Expected: FAIL at import (`touchpoints` module missing).

- [ ] **Step 3: Implement `touchpoints.py`, the constants, the route, and the two refresh drops**

Touch selection in `crm_touch`: iterate `items` newest first; take the first whose `type == "call"` or (`type == "email"` and `email_status in rules.TOUCH_EMAIL_STATUSES or email_status is None`); if none qualifies and `total > rules.TOUCH_SCAN`, call `_crm_fn` once more with `page=2`; map `lead_id` to `lead_url` via the returned `leads`. `support_touch`: `threads[0]` and `counts["open"]`; `last_contact_at` is `at`. Map `CrmNotConfigured`/`SupportNotConfigured` to `Unavailable("not_configured")`, `CrmUnavailable`/`SupportUnavailable` to `Unavailable("unavailable")`, a `None` service result to `{"state": "none", "reason": "unknown_customer"}`. In the route, build `rows` with `crm`/`support` set to `None` when not visible. In each service's refresh branch add `CACHE.drop(f"touch:{customer_key}")` right after the existing `CACHE.put(key, data)`.

- [ ] **Step 4: Run the new file plus both service route files**

Run: `python -m pytest tests/test_customer_insights_touchpoints.py tests/test_crm_close_routes.py tests/test_support_plain_routes.py tests/test_customer_insights_routes.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(insights): /reports/customers/touchpoints (last human CRM touch, last support touch) with gating and fan-out" -- backend/customer_insights/touchpoints.py backend/customer_insights/rules.py backend/customer_insights/routes.py backend/crm_close/service.py backend/support_plain/service.py backend/tests/test_customer_insights_touchpoints.py backend/tests/test_crm_close_routes.py backend/tests/test_support_plain_routes.py
```

---

### Task 5: API client types and fetchers

**Files:**
- Modify: `src/lib/api.ts:9557-9641` (insights block)
- Test: `src/lib/__tests__/customer-touchpoints-fetch.test.ts` (new; mock `fetch` the way `src/lib/__tests__/sla-performance-fetch.test.ts` does)

**Interfaces:**
- Produces (exported from `@/lib/api`): `CustomerRow` gains `first_order_at: string | null` and `testing_orders: number`; `getCustomerList` accepts `new_only?: boolean`, `cohort?: string`, `returned_in?: string`, `exclude_launch_accounts?: boolean`; new types `TouchState = 'ok' | 'none' | 'unavailable'`, `CrmTouch`, `SupportTouch`, `Touchpoints = { crm?: CrmTouch | null; support?: SupportTouch | null }`, `TouchpointsResponse = { crm_visible: boolean; support_visible: boolean; rows: Record<string, Touchpoints> }`, mirroring Task 4 field for field; `getCustomerTouchpoints(keys: string[]): Promise<TouchpointsResponse>` sending `keys` as a repeated query param.

- [ ] **Step 1: Write the failing test**

```ts
it('getCustomerTouchpoints repeats keys and returns the body', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ crm_visible: true, support_visible: false, rows: {} }) })
  vi.stubGlobal('fetch', fetchMock)
  const body = await getCustomerTouchpoints(['wc:1', 'email:g@x.com'])
  expect(body.crm_visible).toBe(true)
  const url = String(fetchMock.mock.calls[0][0])
  expect(url).toContain('/reports/customers/touchpoints?')
  expect(url).toContain('keys=wc%3A1')
  expect(url).toContain('keys=email%3Ag%40x.com')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/customer-touchpoints-fetch.test.ts`
Expected: FAIL (`getCustomerTouchpoints` is not exported).

- [ ] **Step 3: Implement**

Add the types and fields. `getCustomerTouchpoints` builds its own `URLSearchParams` with `append('keys', k)` per key (the shared `getReport` helper takes flat params only) and reuses `API_BASE_URL()` and `getBearerHeaders()` as `getReport` does, throwing on `!response.ok` with the same message shape.

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx vitest run src/lib/__tests__/customer-touchpoints-fetch.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (the `CustomerInsights.test.tsx` fixture will need the two new `CustomerRow` fields added to its at-risk row to stay type-correct; add `first_order_at: '2026-03-02T15:00:00Z', testing_orders: 29`).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(insights): client types for list filters and touchpoints" -- src/lib/api.ts src/lib/__tests__/customer-touchpoints-fetch.test.ts src/components/customers/CustomerInsights.test.tsx
```

---

### Task 6: Store: open a customer on a tab, remember where from, remember the Insights view

**Files:**
- Modify: `src/store/ui-store.ts` (state at lines 130-170, actions at 199, 694-708, 714-741, defaults at 325-345)
- Test: `src/store/ui-store.test.ts`

**Interfaces:**
- Produces: `type CustomerDetailTab = 'orders' | 'dashboard' | 'crm' | 'support' | 'ai-review'` (export the existing union under this name); `type InsightsTab = 'at-risk' | 'new' | 'cohorts'`; `interface InsightsView { tab: InsightsTab; period: InsightsPeriod; cohort: string | null; month: string | null }` (import `InsightsPeriod` from `@/lib/api`); state `customerDetailOrigin: 'customers' | 'customer-insights'` (default `'customers'`) and `insightsView` (default `{ tab: 'at-risk', period: '90d', cohort: null, month: null }`); actions `navigateToCustomerKey(key: string, opts?: { tab?: CustomerDetailTab; origin?: 'customers' | 'customer-insights' })` and `setInsightsView(patch: Partial<InsightsView>)`. `navigateToCustomers()` returns to `activeSubSection: 'customer-insights'` when `customerDetailOrigin === 'customer-insights'` and resets the origin to `'customers'`; everything else it clears today stays cleared.

- [ ] **Step 1: Write the failing tests**

```ts
it('navigateToCustomerKey takes a tab and an origin; back returns to the origin', () => {
  useUIStore.getState().navigateToCustomerKey('wc:2243', { tab: 'crm', origin: 'customer-insights' })
  let s = useUIStore.getState()
  expect(s.customerDetailTab).toBe('crm')
  expect(s.customerDetailOrigin).toBe('customer-insights')
  useUIStore.getState().navigateToCustomers()
  s = useUIStore.getState()
  expect(s.activeSubSection).toBe('customer-insights')
  expect(s.customerDetailOrigin).toBe('customers')
  expect(s.customerDetailTargetId).toBeNull()
})

it('navigateToCustomerKey without options keeps the old defaults', () => {
  useUIStore.getState().navigateToCustomerKey('wc:5')
  expect(useUIStore.getState().customerDetailTab).toBe('dashboard')
  useUIStore.getState().navigateToCustomers()
  expect(useUIStore.getState().activeSubSection).toBe('customers')
})

it('setInsightsView merges a patch', () => {
  useUIStore.getState().setInsightsView({ tab: 'cohorts', cohort: '2026-07' })
  expect(useUIStore.getState().insightsView).toEqual({ tab: 'cohorts', period: '90d', cohort: '2026-07', month: null })
  useUIStore.getState().setInsightsView({ month: 'M3' })
  expect(useUIStore.getState().insightsView.cohort).toBe('2026-07')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/store/ui-store.test.ts`
Expected: FAIL (`setInsightsView` undefined; `customerDetailTab` is `'dashboard'` not `'crm'`).

- [ ] **Step 3: Implement**

Follow the existing `set(state => ({...}), undefined, 'actionName')` style. The existing test at `ui-store.test.ts:114` (`back-nav clears both`) keeps passing because the origin defaults to `'customers'`.

- [ ] **Step 4: Run the store tests**

Run: `npx vitest run src/store/ui-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(store): customer detail tab and origin on navigateToCustomerKey; insightsView" -- src/store/ui-store.ts src/store/ui-store.test.ts
```

---

### Task 7: `TouchCell`, a pure cell with a hover card

**Files:**
- Create: `src/components/customers/TouchCell.tsx`
- Create: `src/components/customers/TouchCell.test.tsx`

**Interfaces:**
- Consumes: `CrmTouch`, `SupportTouch` from Task 5; `Tooltip` primitives; lucide `Mail`, `Phone`, `ArrowDownLeft`, `ArrowUpRight`.
- Produces: `export function TouchCell(props: { kind: 'crm' | 'support'; touch: CrmTouch | SupportTouch | null | undefined; tz: string; now?: Date; onOpen: () => void })`. `undefined` = loading (muted pulsing dash, `aria-busy`); `null` or `state === 'none'` = text `none`; `state === 'unavailable'` = text `n/a` with the reason in the hover card; `state === 'ok'` = a `<button type="button">` showing the short date (`Oct 12`, `timeZone: tz`) and the age (`7 d`; `today` when under one day), CRM adds the direction and type glyphs, Support adds a status chip when `status` is `open` or `waiting_since` is set. The button's `onClick` calls `e.stopPropagation()` then `onOpen()`; Enter does the same. Hover card content is a pure, exported component `TouchCard({ kind, touch })` (CRM: who, title, preview, lead name, `cached` note when `stale`; Support: title, status, waiting since, open count).

- [ ] **Step 1: Write the failing tests**

```tsx
const NOW = new Date('2026-10-19T18:00:00Z')
const crm = (over: Partial<CrmTouch> = {}): CrmTouch => ({ state: 'ok', at: '2026-10-12T15:00:00Z', type: 'email', direction: 'inbound', who: 'Zack', title: 'Re: COA', preview: 'thanks', lead_name: 'UMS Rx', lead_url: 'https://app.close.com/lead/x/', stale: false, reason: null, ...over })

it('renders the date, the age and opens on click without bubbling', async () => {
  const onOpen = vi.fn(); const onRow = vi.fn()
  render(<table><tbody><tr onClick={onRow}><td><TouchCell kind="crm" touch={crm()} tz="America/Los_Angeles" now={NOW} onOpen={onOpen} /></td></tr></tbody></table>)
  const btn = screen.getByRole('button')
  expect(btn).toHaveTextContent('Oct 12')
  expect(btn).toHaveTextContent('7 d')
  await userEvent.click(btn)
  expect(onOpen).toHaveBeenCalledTimes(1)
  expect(onRow).not.toHaveBeenCalled()
})

it('shows none, n/a and a loading state', () => {
  const { rerender } = render(<TouchCell kind="support" touch={{ state: 'none', stale: false, reason: null }} tz="UTC" onOpen={vi.fn()} />)
  expect(screen.getByText('none')).toBeInTheDocument()
  rerender(<TouchCell kind="support" touch={{ state: 'unavailable', stale: false, reason: 'not_configured' }} tz="UTC" onOpen={vi.fn()} />)
  expect(screen.getByText('n/a')).toBeInTheDocument()
  expect(screen.queryByRole('button')).toBeNull()
  rerender(<TouchCell kind="support" touch={undefined} tz="UTC" onOpen={vi.fn()} />)
  expect(screen.getByLabelText(/loading/i)).toHaveAttribute('aria-busy', 'true')
})

it('TouchCard lists the CRM fields and the stale note', () => {
  render(<TouchCard kind="crm" touch={crm({ stale: true })} />)
  for (const t of ['Zack', 'Re: COA', 'thanks', 'UMS Rx', /cached/i]) expect(screen.getByText(t)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/customers/TouchCell.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `TouchCell.tsx`**

Use the `CustomerInsights.tsx` tooltip card classes (`flex flex-col gap-1.5 p-3 font-mono text-xs`, header `border-b border-primary-foreground/20 pb-1.5 font-semibold`). Age text: whole days from `now ?? new Date()`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/components/customers/TouchCell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(insights): TouchCell with CRM and support hover cards" -- src/components/customers/TouchCell.tsx src/components/customers/TouchCell.test.tsx
```

---

### Task 8: Tabbed card, At risk tab with touch columns, touchpoints hook

**Files:**
- Create: `src/components/customers/useTouchpoints.ts`, `src/components/customers/useTouchpoints.test.tsx`
- Modify: `src/components/customers/CustomerInsights.tsx` (period state at 127-128, header 153-180, chart card 257-320, cohort card 322-364, at-risk section 367-488)
- Modify: `src/components/customers/CustomerInsights.test.tsx`
- Modify: `src/components/AccuMarkTools.tsx:33-38`

**Interfaces:**
- Consumes: `getCustomerTouchpoints`, `Touchpoints` (Task 5); `insightsView`, `setInsightsView`, `navigateToCustomerKey` (Task 6); `TouchCell` (Task 7); `Tabs, TabsList, TabsTrigger, TabsContent` from `@/components/ui/tabs`.
- Produces: `useTouchpoints(keys: string[]): { rows: Record<string, Touchpoints>; crmVisible: boolean; supportVisible: boolean; isLoading: boolean }` using `useQueries` over chunks of 50 (`queryKey: ['customers', 'touchpoints', chunk]`, `staleTime: 300_000`, `refetchOnWindowFocus: false`, `enabled: chunk.length > 0`); a failed chunk contributes `{ state: 'unavailable', reason: 'unavailable', stale: false }` for each of its keys on both fields; visibility comes from the first settled chunk. `CustomerInsights` prop becomes `onOpenCustomer: (key: string, tab?: 'crm' | 'support') => void`. `AccuMarkTools` passes `(key, tab) => navigateToCustomerKey(key, { tab, origin: 'customer-insights' })`.

- [ ] **Step 1: Write the failing tests**

`useTouchpoints.test.tsx` (render the hook inside a `QueryClientProvider`, mock `getCustomerTouchpoints`):

```tsx
it('chunks at 50, merges rows and degrades a failed chunk', async () => {
  const keys = Array.from({ length: 51 }, (_, i) => `wc:${i}`)
  vi.mocked(api.getCustomerTouchpoints)
    .mockResolvedValueOnce({ crm_visible: true, support_visible: true, rows: Object.fromEntries(keys.slice(0, 50).map(k => [k, { crm: { state: 'none', stale: false, reason: null }, support: null }])) })
    .mockRejectedValueOnce(new Error('boom'))
  const { result } = renderHook(() => useTouchpoints(keys), { wrapper })
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(vi.mocked(api.getCustomerTouchpoints)).toHaveBeenCalledTimes(2)
  expect(vi.mocked(api.getCustomerTouchpoints).mock.calls[0][0]).toHaveLength(50)
  expect(result.current.crmVisible).toBe(true)
  expect(result.current.rows['wc:0'].crm?.state).toBe('none')
  expect(result.current.rows['wc:50'].crm?.state).toBe('unavailable')
})
```

`CustomerInsights.test.tsx`: add `getCustomerTouchpoints: vi.fn()` and `getCustomerList: vi.fn()` to the mock; in `setup`, resolve touchpoints with `{ crm_visible: true, support_visible: false, rows: { 'wc:1': { crm: { state: 'ok', at: '2026-10-12T15:00:00Z', type: 'email', direction: 'outbound', who: 'Scott', title: 'Checking in', preview: '', lead_name: 'Halcyon', lead_url: null, stale: false, reason: null }, support: null } } }`; reset the store before each test with `useUIStore.setState({ insightsView: { tab: 'at-risk', period: '90d', cohort: null, month: null } })`. Add:

```tsx
it('has three tabs, shows the CRM touch on the at-risk row and opens the CRM tab from it', async () => {
  const onOpen = vi.fn()
  setup({ onOpen })
  expect(await screen.findByRole('tab', { name: /At risk/ })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: /New customers/ })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: /Cohorts/ })).toBeInTheDocument()
  const row = (await screen.findByText('Halcyon Research Supply')).closest('tr')!
  expect(row).toHaveTextContent('Oct 12')
  expect(screen.getByRole('columnheader', { name: 'Last CRM' })).toBeInTheDocument()
  expect(screen.queryByRole('columnheader', { name: 'Last support' })).toBeNull()
  await userEvent.click(within(row).getByRole('button'))
  expect(onOpen).toHaveBeenCalledWith('wc:1', 'crm')
  await userEvent.click(within(row).getByText('Halcyon Research Supply'))
  expect(onOpen).toHaveBeenLastCalledWith('wc:1', undefined)
})
```

Update the existing `setup()` signature to `setup({ riskFails = false, onOpen = vi.fn() } = {})` and its two callers. The existing assertion on `'12.9%'` (a cohort cell) moves into Task 10's test because the grid is no longer on the first tab.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/customers/useTouchpoints.test.tsx src/components/customers/CustomerInsights.test.tsx`
Expected: FAIL (hook missing; no tabs; no `Last CRM` header).

- [ ] **Step 3: Implement**

In `CustomerInsights.tsx`: read `period` and `tab` from `insightsView` (selector syntax) instead of local state; move the `Exclude launch accounts` switch into the header next to the period control; make the chart card span the full row; replace the cohort card and the at-risk section with one `CARD` that wraps `<Tabs value={tab} onValueChange={t => setInsightsView({ tab })}>` with triggers `At risk (N)` when `risk.data` is loaded, `New customers`, `Cohorts`; keep the at-risk table as is and append the `Last CRM` and `Last support` columns, each rendered only when the matching `*_visible` flag is true, each cell a `TouchCell` fed from `useTouchpoints(risk.data?.rows.map(r => r.key) ?? [])` and `onOpen={() => onOpenCustomer(r.key, 'crm' | 'support')}`. The `New customers` and `Cohorts` contents render placeholders in this task (filled by Tasks 9 and 10). Update `AccuMarkTools.tsx` as in Interfaces.

- [ ] **Step 4: Run both test files, the typecheck and the lint**

Run: `npx vitest run src/components/customers && npm run typecheck && npm run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(insights): tabbed card; at-risk rows show last CRM and support touch" -- src/components/customers/useTouchpoints.ts src/components/customers/useTouchpoints.test.tsx src/components/customers/CustomerInsights.tsx src/components/customers/CustomerInsights.test.tsx src/components/AccuMarkTools.tsx
```

---

### Task 9: New customers tab and the shared customer table

**Files:**
- Create: `src/components/customers/InsightsCustomerTable.tsx`, `src/components/customers/InsightsCustomerTable.test.tsx`
- Modify: `src/components/customers/CustomerInsights.tsx` (the `New customers` `TabsContent`)
- Modify: `src/components/customers/CustomerInsights.test.tsx`

**Interfaces:**
- Consumes: `getCustomerList` with `new_only`, `exclude_launch_accounts`, `sort`, `dir`, `page`, `page_size` (Task 5); `CustomerRow.first_order_at`, `testing_orders`; `useTouchpoints`, `TouchCell`; `STATUS_LABEL`, `STATUS_CLASS`, `fmtMoney` from `insights-utils`.
- Produces: `export type InsightsSortField = 'name' | 'company' | 'rep' | 'first_order_at' | 'testing_orders' | 'lifetime' | 'last_order_at' | 'status'`; `export function InsightsCustomerTable(props: { rows: CustomerRow[]; total: number; page: number; pageSize: number; onPage: (p: number) => void; sort: InsightsSortField; dir: 'asc' | 'desc'; onSort: (f: InsightsSortField) => void; tz: string; touch: ReturnType<typeof useTouchpoints>; onOpenCustomer: (key: string, tab?: 'crm' | 'support') => void; emptyText: string })`. Columns in order: Customer, Company, Rep, First order, Testing orders, Lifetime, Last order, Status, Last CRM (if `crmVisible`), Last support (if `supportVisible`). Header buttons toggle sort (same field flips `dir`); a pager line `x–y of total` with Previous/Next like `CustomerStatusPage.tsx:555-575`. Row click opens the Dashboard; touch cells open their tab. Page size 25.

- [ ] **Step 1: Write the failing tests**

`InsightsCustomerTable.test.tsx`:

```tsx
it('renders columns, sorts on header click, pages, and opens customers and tabs', async () => {
  const onSort = vi.fn(); const onPage = vi.fn(); const onOpen = vi.fn()
  render(<InsightsCustomerTable rows={[row({ key: 'wc:2243', name: 'Zackary Smith', company: 'UMS Rx LLC', lifetime: '90051.25', testing_orders: 31, first_order_at: '2026-07-22T15:00:00Z' })]} total={60} page={2} pageSize={25} onPage={onPage} sort="lifetime" dir="desc" onSort={onSort} tz="America/Los_Angeles" touch={touch({ crmVisible: true, supportVisible: true })} onOpenCustomer={onOpen} emptyText="none" />)
  const tr = screen.getByText('Zackary Smith').closest('tr')!
  expect(tr).toHaveTextContent('UMS Rx LLC'); expect(tr).toHaveTextContent('$90,051'); expect(tr).toHaveTextContent('Jul 22'); expect(tr).toHaveTextContent('31')
  expect(screen.getByText('26–26 of 60')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /Testing orders/ }))
  expect(onSort).toHaveBeenCalledWith('testing_orders')
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(onPage).toHaveBeenCalledWith(3)
  await userEvent.click(screen.getByText('Zackary Smith'))
  expect(onOpen).toHaveBeenCalledWith('wc:2243', undefined)
})

it('shows the empty text and hides touch columns the server did not grant', () => {
  render(<InsightsCustomerTable rows={[]} total={0} page={1} pageSize={25} onPage={vi.fn()} sort="lifetime" dir="desc" onSort={vi.fn()} tz="UTC" touch={touch({ crmVisible: false, supportVisible: false })} onOpenCustomer={vi.fn()} emptyText="No new customers in this period" />)
  expect(screen.getByText('No new customers in this period')).toBeInTheDocument()
  expect(screen.queryByRole('columnheader', { name: /Last CRM/ })).toBeNull()
})
```

`CustomerInsights.test.tsx`:

```tsx
it('New customers tab queries new_only with the period and the launch switch', async () => {
  vi.mocked(api.getCustomerList).mockResolvedValue({ tz: 'America/Los_Angeles', synced_at: null, total: 1, page: 1, page_size: 25, rows: [row({ key: 'wc:2243', name: 'Zackary Smith' })] })
  setup()
  await userEvent.click(await screen.findByRole('tab', { name: /New customers/ }))
  expect(await screen.findByText('Zackary Smith')).toBeInTheDocument()
  expect(vi.mocked(api.getCustomerList)).toHaveBeenLastCalledWith(expect.objectContaining({ new_only: true, period: '90d', exclude_launch_accounts: false, sort: 'lifetime', dir: 'desc', page: 1, page_size: 25 }))
  expect(screen.getByText('First testing order in this period, ranked by lifetime spend')).toBeInTheDocument()
})
```

(Two fixture helpers live in a new `src/components/customers/insights-test-fixtures.ts`, shared with Task 10: `row(over: Partial<CustomerRow> = {}): CustomerRow` returning a complete row, and `touch(over: { crmVisible?: boolean; supportVisible?: boolean; rows?: Record<string, Touchpoints> } = {}): ReturnType<typeof useTouchpoints>` with `isLoading: false`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/customers`
Expected: FAIL (table module missing; `getCustomerList` never called).

- [ ] **Step 3: Implement**

`InsightsCustomerTable` is a hand-rolled `<table>` in the style of the at-risk table (the repo's `ui/data-table.tsx` is not used here, so the three tables look alike). In `CustomerInsights.tsx`, the New customers tab keeps `page`, `sort`, `dir` in local state (reset when `period` changes), queries `['customers', 'list', 'new', period, excludeLaunch, sort, dir, page]`, feeds `useTouchpoints` with the page's keys, and shows the tab count from `total` once loaded.

- [ ] **Step 4: Run the folder, the typecheck and the lint**

Run: `npx vitest run src/components/customers && npm run typecheck && npm run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(insights): New customers tab with the shared sortable customer table" -- src/components/customers/InsightsCustomerTable.tsx src/components/customers/InsightsCustomerTable.test.tsx src/components/customers/insights-test-fixtures.ts src/components/customers/CustomerInsights.tsx src/components/customers/CustomerInsights.test.tsx
```

---

### Task 10: Cohorts tab with drill-down

**Files:**
- Create: `src/components/customers/CohortGrid.tsx`, `src/components/customers/CohortGrid.test.tsx`
- Modify: `src/components/customers/CustomerInsights.tsx` (the `Cohorts` `TabsContent`)
- Modify: `src/components/customers/CustomerInsights.test.tsx`

**Interfaces:**
- Consumes: `getCustomerCohorts(true)` (existing query), `getCustomerList` with `cohort`, `returned_in`, `exclude_launch_accounts: true`, `period: 'all'`; `insightsView.cohort`, `insightsView.month`, `setInsightsView`; `InsightsCustomerTable`; `cohortTint`, `fmtPct`.
- Produces: `export function CohortGrid(props: { months: string[]; rows: CustomerCohorts['rows']; selectedCohort: string | null; selectedMonth: string | null; onSelect: (cohort: string | null, month: string | null) => void })`: all 12 month columns; each cohort label is a `<button>` (`aria-pressed` when selected) calling `onSelect(cohort, null)`; each non-null cell is a `<button>` calling `onSelect(cohort, 'M<k>')`; clicking the selected row or cell again clears to `(null, null)`. The drill-down header reads `{cohort} cohort · {size} customers` or `{cohort} cohort · came back in {month} ({calendar month}) · {total} of {size}`; the calendar month is `cohort` plus `k` months, computed in a small helper `addMonths(ym: string, n: number): string` exported from `insights-utils.ts`.

- [ ] **Step 1: Write the failing tests**

`CohortGrid.test.tsx`:

```tsx
it('selects a cohort, then a cell, and clears on a second click', async () => {
  const onSelect = vi.fn()
  render(<CohortGrid months={['M1', 'M2']} rows={[{ cohort: '2026-08', size: 163, cells: [0.129, null] }]} selectedCohort={null} selectedMonth={null} onSelect={onSelect} />)
  await userEvent.click(screen.getByRole('button', { name: '2026-08' }))
  expect(onSelect).toHaveBeenCalledWith('2026-08', null)
  await userEvent.click(screen.getByRole('button', { name: '12.9%' }))
  expect(onSelect).toHaveBeenCalledWith('2026-08', 'M1')
  expect(screen.queryByRole('button', { name: '' })).toBeNull()  // the null cell is not a button
})

it('a selected cell is pressed and clicking it clears', async () => {
  const onSelect = vi.fn()
  render(<CohortGrid months={['M1']} rows={[{ cohort: '2026-08', size: 163, cells: [0.129] }]} selectedCohort="2026-08" selectedMonth="M1" onSelect={onSelect} />)
  const cell = screen.getByRole('button', { name: '12.9%' })
  expect(cell).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(cell)
  expect(onSelect).toHaveBeenCalledWith(null, null)
})
```

`insights-utils.test.ts`: `expect(addMonths('2026-07', 3)).toBe('2026-10'); expect(addMonths('2026-11', 2)).toBe('2027-01')`.

`CustomerInsights.test.tsx`:

```tsx
it('Cohorts tab shows the grid, drills into members with the right query, and keeps the selection in the store', async () => {
  vi.mocked(api.getCustomerList).mockResolvedValue({ tz: 'America/Los_Angeles', synced_at: null, total: 41, page: 1, page_size: 25, rows: [row({ key: 'wc:9', name: 'Member One' })] })
  setup()
  await userEvent.click(await screen.findByRole('tab', { name: /Cohorts/ }))
  expect(await screen.findByText('12.9%')).toBeInTheDocument()
  expect(screen.getByText('Pick a cohort to see its customers')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '12.9%' }))
  expect(await screen.findByText('Member One')).toBeInTheDocument()
  expect(screen.getByText('2026-08 cohort · came back in M1 (2026-09) · 41 of 163')).toBeInTheDocument()
  expect(vi.mocked(api.getCustomerList)).toHaveBeenLastCalledWith(expect.objectContaining({ cohort: '2026-08', returned_in: '2026-09', exclude_launch_accounts: true, period: 'all', sort: 'lifetime', dir: 'desc' }))
  expect(useUIStore.getState().insightsView).toMatchObject({ tab: 'cohorts', cohort: '2026-08', month: 'M1' })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/customers`
Expected: FAIL (`CohortGrid` missing; `addMonths` missing).

- [ ] **Step 3: Implement**

`CohortGrid` reuses the existing grid markup from `CustomerInsights.tsx:334-362` without the `.slice(0, 6)`. In `CustomerInsights.tsx`, the Cohorts tab renders the grid above a members panel; the members query key is `['customers', 'list', 'cohort', cohort, month, sort, dir, page]` and is `enabled` only when `cohort` is set; `returned_in` is `addMonths(cohort, k)` where `k` is the number in `month`. Page and sort state reset when the selection changes.

- [ ] **Step 4: Run the folder, the typecheck and the lint**

Run: `npx vitest run src/components/customers && npm run typecheck && npm run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(insights): Cohorts tab with member drill-down" -- src/components/customers/CohortGrid.tsx src/components/customers/CohortGrid.test.tsx src/components/customers/insights-utils.ts src/components/customers/insights-utils.test.ts src/components/customers/CustomerInsights.tsx src/components/customers/CustomerInsights.test.tsx
```

---

### Task 11: Back to Insights, tab refresh invalidation, changelog, e2e

**Files:**
- Create: `src/components/customers/BackToOrigin.tsx`, `src/components/customers/BackToOrigin.test.tsx`
- Modify: `src/components/CustomerStatusPage.tsx:975-982` and `:1588-1596` (back buttons)
- Modify: `src/components/customers/CustomerCrmTab.tsx:257-261`, `src/components/customers/CustomerSupportTab.tsx:167-171` (refresh click handlers)
- Modify: `CHANGELOG.md` (top)
- Modify: `e2e/customer-insights.spec.ts`
- Test: `src/components/customers/CustomerCrmTab.test.tsx`, `src/components/customers/CustomerSupportTab.test.tsx`

**Interfaces:**
- Consumes: `customerDetailOrigin`, `navigateToCustomers` (Task 6); query key `['customers', 'touchpoints']` (Task 8).
- Produces: `export function BackToOrigin()`: reads `customerDetailOrigin` and `navigateToCustomers` from the store (selector syntax) and renders the existing back button markup (`text-sm text-primary hover:underline mb-4`) with the label `← Back to Insights` when the origin is `customer-insights`, else `← Back to Customers`. Both detail views replace their inline button with it.

- [ ] **Step 1: Write the failing tests**

`BackToOrigin.test.tsx`:

```tsx
it('labels by origin and navigates back', async () => {
  useUIStore.setState({ customerDetailOrigin: 'customer-insights', activeSubSection: 'customer-detail' })
  render(<BackToOrigin />)
  await userEvent.click(screen.getByRole('button', { name: /Back to Insights/ }))
  expect(useUIStore.getState().activeSubSection).toBe('customer-insights')
  useUIStore.setState({ customerDetailOrigin: 'customers' })
  render(<BackToOrigin />)
  expect(screen.getByRole('button', { name: /Back to Customers/ })).toBeInTheDocument()
})
```

In `CustomerCrmTab.test.tsx` and `CustomerSupportTab.test.tsx`, where the Refresh button is already exercised, spy on the `QueryClient` (`vi.spyOn(qc, 'invalidateQueries')`) and assert it is called with `{ queryKey: ['customers', 'touchpoints'] }` after the click.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/customers/BackToOrigin.test.tsx src/components/customers/CustomerCrmTab.test.tsx src/components/customers/CustomerSupportTab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `BackToOrigin` and use it in `CustomerDetailView` and `GuestCustomerDetailView` in place of the two inline buttons (Task 6's `navigateToCustomers` already routes by origin). Refresh handlers: add a second `qc.invalidateQueries({ queryKey: ['customers', 'touchpoints'] })` beside the existing one.

CHANGELOG, above `## v1.49.2`, in the existing voice:

```markdown
## Unreleased

### Customer Insights: at-risk, new customers and cohorts in one place
- **Three tabs replace the at-risk card.** At risk is unchanged. New customers lists everyone whose first testing order fell in the selected period, biggest lifetime spend first. Cohorts shows the full 12-month re-order grid; click a cohort to see its customers, or a cell to see who came back that month.
- **Last CRM and last support contact on every list.** Admins see the last human email or call from Close (sequence and bulk sends do not count); admins and Plain seat holders see the last support thread. Click either to open that tab on the customer.
- **Back from a customer returns to Insights** when that is where you came from, on the same tab and selection.
- **CRM tab:** sequence, bulk and AI-agent emails now sit behind "include automated".
```

e2e: in `e2e/customer-insights.spec.ts`, set `SHOTS` for the new run to `docs/superpowers/e2e/2026-10-19-customer-insights-tabs` and add one test `tabs render, cells degrade without Close or Plain, cohort drill-down matches the grid`: open the page, assert the three tabs, assert the At risk table's `Last CRM` cells read `n/a` (stacks have no Close), shoot `01-at-risk.png`; click `New customers`, assert the subtitle, shoot `02-new-customers.png`; click `Cohorts`, read `/reports/customers/cohorts` through `api()`, click the first cohort label, assert the header shows `{size} customers` and that `/reports/customers/list?cohort=...&exclude_launch_accounts=true&page_size=1` has `total === size`, shoot `03-cohorts.png`. Keep the existing tests; the `at-risk list` test's click target is unchanged.

- [ ] **Step 4: Run the unit tests, the full gate, then the e2e on a devbox stack**

Run: `npm run check:all` (typecheck, lint, ast lint, format, rust, tests). Then the backend gate by failure-set diff: run `python -m pytest tests -q` once on the branch and once on the base commit (`git stash` is not enough; use a second worktree at `origin/master` or the container), normalise each output with `grep '^FAILED' | sed 's/^FAILED //' | sort -u`, and `comm -13 base.txt branch.txt` must print nothing. The suite has a known flaky baseline (about 19 to 22 failures); zero failures is not the bar, zero net-new is.
Then on a devbox stack (accumark-stack-platform skill; source the env in every Bash call): `npx playwright test e2e/customer-insights.spec.ts`.
Expected: check:all clean; backend failure set identical to baseline; e2e PASS with three new screenshots.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(insights): back to Insights, touch refresh invalidation, changelog, e2e evidence" -- src/components/customers/BackToOrigin.tsx src/components/customers/BackToOrigin.test.tsx src/components/CustomerStatusPage.tsx src/components/customers/CustomerCrmTab.tsx src/components/customers/CustomerSupportTab.tsx src/components/customers/CustomerCrmTab.test.tsx src/components/customers/CustomerSupportTab.test.tsx CHANGELOG.md e2e/customer-insights.spec.ts docs/superpowers/e2e/2026-10-19-customer-insights-tabs
```

---

### Task 12: Pull request

- [ ] **Step 1: Push the branch and open the PR against `master`** with the spec's section 9 as the Risk and How-to-revert section, the e2e screenshots as evidence, and the acceptance checklist (spec section 7) as unchecked items for the Handler to run read-only on prod after deploy.
- [ ] **Step 2: Request review** (superpowers:requesting-code-review); do not merge. Release and deploy are the `accumark-deploy` skill's job (Mk1 1.50.0).
