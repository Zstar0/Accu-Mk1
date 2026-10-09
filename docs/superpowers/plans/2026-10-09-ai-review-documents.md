# AI Review as Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each successful AI review is published as a styled, escaped HTML document (one code per customer, one revision per run) in a company-visible "Customer reviews" space, staff names are scrubbed before publishing, and the customer page shows the review in its own "AI review" tab with the document embedded.

**Architecture:** Backend: review shape v2 (headline; items with title/detail/severity/theme), `customer_review/names.py` (scrub), `customer_review/document.py` (metrics from the dossier, HTML renderer, space/category bootstrap, publish via `documents.service.create_document`), runner publishes after `done`, four new columns on `customer_ai_reviews`. Frontend: `DocumentViewer` gains `embedded` and `onNavigate`; `CustomerAiReviewCard` becomes `CustomerAiReviewTab` (summary bar + embedded document); the customer page gets an "AI review" tab after Support.

**Tech Stack:** FastAPI, SQLAlchemy 2 (SQLite unit tests), pytest; React 19, TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-review-documents-design.md`

## Global Constraints

- Every model-written string that reaches HTML goes through `html.escape(..., quote=True)`; links are built by us from ledger metadata, never taken from model text.
- Names are scrubbed before anything is stored as the final review or published.
- Space slug `customer-reviews`, name "Customer reviews", visibility `company`; category name "Customer review", prefix `CR`.
- Deep links base: `os.environ.get("MK1_PUBLIC_URL", "https://accumk1.valenceanalytical.com")`.
- New columns via model + `ALTER TABLE customer_ai_reviews ADD COLUMN IF NOT EXISTS ...` appended to the `migrations` list in `backend/database.py::_run_migrations`.
- Admin-only routes and tab; every response key declared on its `response_model`.
- Frontend npm only; commit with `git -c core.autocrlf=true commit ... -- <paths>`; write files with editor tools or explicit utf-8 (never Python stdout redirects); after each task `grep -c $'\xef\xbf\xbd'` on touched files is 0. No em dashes.
- Backend tests `cd backend && python -m pytest <files> -q`; full suite one at a time.

## Review Focus

1. A model string containing `<script>`, `"` or `</div>` must render as text in the document, never markup. Pinned in Task 4.
2. A staff name in possessive form ("Scott's") or inside a full name ("Scott Joseph") is scrubbed; a word that merely contains a name ("Scottsdale") is not. Pinned in Task 3.
3. A second review for the same customer creates revision 2 of the same `CR-` code, never a second code. Pinned in Task 5.
4. Publishing fails (DB error, validation): the run stays `done` with `document_error`, and the tab still shows the summary. Pinned in Task 5.
5. The embedded viewer must not hijack the Documents page state (no back button; revision switching stays in the tab). Pinned in Task 6.

---

### Task 1: Storage columns

**Files:**
- Modify: `backend/models.py` (`CustomerAiReview`: four columns)
- Modify: `backend/database.py` (`_run_migrations` list: four ALTERs before the closing `]`)
- Modify: `backend/customer_review/store.py` (`finish` accepts and `to_dict` returns the new fields)
- Modify: `backend/customer_review/routes.py` (`Run` model declares them)
- Test: `backend/tests/test_customer_review_store.py`, `backend/tests/test_customer_review_routes.py`

**Interfaces:**
- Produces: `store.finish(..., document_id=None, document_code=None, names_scrubbed=0, document_error=None)`; `to_dict` keys `document_id`, `document_code`, `names_scrubbed`, `document_error`; `store.document_code_for(db, key) -> str | None` (newest non-null code for the customer).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_customer_review_store.py`:

```python
def test_document_fields_round_trip_and_code_lookup(db_session):
    a = store.create_run(db_session, "wc:1", 7, "m")
    store.finish(db_session, a.id, status="done", tool_calls=[], input_tokens=0, output_tokens=0, cost_usd=0,
                 document_id=11, document_code="CR-0001", names_scrubbed=2)
    b = store.create_run(db_session, "wc:1", 7, "m")
    store.finish(db_session, b.id, status="done", tool_calls=[], input_tokens=0, output_tokens=0, cost_usd=0,
                 document_error="publish failed")
    d = store.to_dict(store.get_run(db_session, a.id))
    assert (d["document_id"], d["document_code"], d["names_scrubbed"], d["document_error"]) == (11, "CR-0001", 2, None)
    assert store.to_dict(store.get_run(db_session, b.id))["document_error"] == "publish failed"
    assert store.document_code_for(db_session, "wc:1") == "CR-0001"
    assert store.document_code_for(db_session, "wc:2") is None


def test_migrations_add_the_document_columns():
    import inspect

    import database

    src = inspect.getsource(database._run_migrations)
    for col in ("document_id INTEGER", "document_code VARCHAR(32)", "names_scrubbed INTEGER", "document_error TEXT"):
        assert f"ALTER TABLE customer_ai_reviews ADD COLUMN IF NOT EXISTS {col}" in src
```

In `backend/tests/test_customer_review_store.py::test_create_and_finish_round_trip` and `backend/tests/test_customer_review_routes.py::test_latest_and_history_shapes`, add `"document_id", "document_code", "names_scrubbed", "document_error"` to the expected key sets.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_customer_review_store.py tests/test_customer_review_routes.py -q`
Expected: FAIL (`finish() got an unexpected keyword argument 'document_id'`, key-set mismatches, missing ALTERs)

- [ ] **Step 3: Write minimal implementation**

`backend/models.py`, in `CustomerAiReview` after `error`:

```python
    document_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    document_code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    names_scrubbed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    document_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
```

`backend/database.py`, append inside the `migrations` list (before its closing `]`):

```python
        # AI review as documents (2026-10-09): the review's document and the name scrub count.
        "ALTER TABLE customer_ai_reviews ADD COLUMN IF NOT EXISTS document_id INTEGER",
        "ALTER TABLE customer_ai_reviews ADD COLUMN IF NOT EXISTS document_code VARCHAR(32)",
        "ALTER TABLE customer_ai_reviews ADD COLUMN IF NOT EXISTS names_scrubbed INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE customer_ai_reviews ADD COLUMN IF NOT EXISTS document_error TEXT",
```

`backend/customer_review/store.py`: `finish` gains keyword args `document_id: int | None = None, document_code: str | None = None, names_scrubbed: int = 0, document_error: str | None = None` and assigns them with the others; `to_dict` adds `"document_id": row.document_id, "document_code": row.document_code, "names_scrubbed": row.names_scrubbed or 0, "document_error": row.document_error`; new:

```python
def document_code_for(db: Session, key: str) -> str | None:
    return db.execute(select(CustomerAiReview.document_code)
                      .where(CustomerAiReview.customer_key == key, CustomerAiReview.document_code.is_not(None))
                      .order_by(CustomerAiReview.id.desc()).limit(1)).scalar_one_or_none()
```

`backend/customer_review/routes.py`, `Run` model, add:

```python
    document_id: Optional[int] = None
    document_code: Optional[str] = None
    names_scrubbed: int = 0
    document_error: Optional[str] = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_customer_review_store.py tests/test_customer_review_routes.py -q`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(ai-review): document columns on customer_ai_reviews" -- backend/models.py backend/database.py backend/customer_review/store.py backend/customer_review/routes.py backend/tests/test_customer_review_store.py backend/tests/test_customer_review_routes.py
```

---

### Task 2: Review shape v2

**Files:**
- Modify: `backend/customer_review/prompts.py` (SYSTEM wording, SUBMIT_TOOL schema)
- Modify: `backend/customer_review/agent.py` (`validate`)
- Test: `backend/tests/test_customer_review_agent.py`

**Interfaces:**
- Produces: validated review `{"headline": str, "sentiment": {...}, "open_issues"|"shortfalls"|"strengths"|"next_steps": [{"title", "detail", "severity"?, "theme"?, "citations"}]}` (severity on open_issues and shortfalls; theme on shortfalls).

- [ ] **Step 1: Write the failing test**

In `backend/tests/test_customer_review_agent.py` replace the `review()` helper with:

```python
def item(title="Reply on T-948 took 3 days", **kw):
    return {"title": title, "detail": "Customer waited for an answer.", "severity": "high",
            "citations": [{"kind": "ticket", "id": "T-948"}], **kw}


def review(**over):
    base = {"headline": "Happy overall, one slow reply.",
            "sentiment": {"score": 1, "trend": "steady", "reason": "Happy overall",
                          "citations": [{"kind": "ticket", "id": "T-948"}]},
            "open_issues": [], "shortfalls": [item(theme="communication")], "strengths": [], "next_steps": []}
    base.update(over)
    return base
```

Update existing tests that build items with `"text"` to use `item(...)`: in `test_uncited_and_foreign_citations_are_dropped` use `item("Invented", citations=[{"kind": "ticket", "id": "T-1"}])` and `item("Mixed", citations=[{"kind": "ticket", "id": "T-948"}, {"kind": "sample", "id": "P-0"}])`; in `test_items_are_trimmed_and_capped` use `[item("t" * 200, detail="y" * 900)] * 12` and assert `len(out.review["next_steps"]) == 8`, `len(out.review["next_steps"][0]["title"]) == 80`, `len(out.review["next_steps"][0]["detail"]) == 400`. Then add:

```python
def test_v2_shape_defaults_and_headline(ctx):
    r = review(open_issues=[{"title": "No severity given", "detail": "d", "citations": [{"kind": "ticket", "id": "T-948"}]}],
               shortfalls=[{"title": "No theme", "detail": "d", "severity": "low", "citations": [{"kind": "ticket", "id": "T-948"}]}],
               headline="h" * 500)
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", r, "u2")])
    out, _ = run(llm, ctx)
    assert out.review["open_issues"][0]["severity"] == "medium"
    assert out.review["shortfalls"][0]["theme"] == "other" and out.review["shortfalls"][0]["severity"] == "low"
    assert len(out.review["headline"]) == 300
    assert "severity" not in out.review["strengths"][0] if out.review["strengths"] else True


def test_v1_text_items_are_invalid(ctx):
    r = review(open_issues=[{"text": "old shape", "citations": [{"kind": "ticket", "id": "T-948"}]}])
    llm = ScriptedLLM([use("list_tickets", {})], [use("submit_review", r, "u2")])
    out, _ = run(llm, ctx)
    assert out.status == "failed" and out.error == "invalid review"


def test_submit_schema_requires_headline_and_titles():
    from customer_review import prompts

    schema = prompts.SUBMIT_TOOL["input_schema"]
    assert "headline" in schema["required"]
    item_schema = schema["properties"]["shortfalls"]["items"]
    assert set(item_schema["required"]) == {"title", "citations"}
    assert item_schema["properties"]["theme"]["enum"] == ["turnaround", "coa_quality", "communication", "billing", "other"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_customer_review_agent.py -q`
Expected: FAIL (items rejected for missing `text`; headline/defaults absent; schema assertions)

- [ ] **Step 3: Write minimal implementation**

`backend/customer_review/agent.py`: replace the constants and `validate` with:

```python
SECTIONS = ("open_issues", "shortfalls", "strengths", "next_steps")
TRENDS = ("improving", "steady", "declining")
SEVERITIES = ("high", "medium", "low")
THEMES = ("turnaround", "coa_quality", "communication", "billing", "other")
MAX_ITEM_CHARS = 400
MAX_TITLE_CHARS = 80
MAX_HEADLINE_CHARS = 300
MAX_ITEMS = 8


def validate(raw: dict, ledger: dict) -> tuple[dict, int]:
    if not isinstance(raw, dict) or not isinstance(raw.get("sentiment"), dict):
        raise InvalidReview("sentiment missing")
    s = raw["sentiment"]
    score = s.get("score")
    if not isinstance(score, int) or isinstance(score, bool) or not -2 <= score <= 2 or s.get("trend") not in TRENDS:
        raise InvalidReview("bad sentiment")
    cites, dropped = _cites(s.get("citations"), ledger)
    out: dict[str, Any] = {
        "headline": str(raw.get("headline") or "")[:MAX_HEADLINE_CHARS],
        "sentiment": {"score": score, "trend": s["trend"], "reason": str(s.get("reason") or "")[:MAX_ITEM_CHARS],
                      "citations": cites, "unsupported": not cites}}
    for name in SECTIONS:
        items = raw.get(name) or []
        if not isinstance(items, list):
            raise InvalidReview(f"{name} is not a list")
        kept = []
        for it in items:
            if not isinstance(it, dict) or not isinstance(it.get("title"), str) or not it["title"].strip():
                raise InvalidReview(f"bad item in {name}")
            cites, n = _cites(it.get("citations"), ledger)
            dropped += n
            if not cites:
                continue
            row = {"title": it["title"].strip()[:MAX_TITLE_CHARS], "detail": str(it.get("detail") or "")[:MAX_ITEM_CHARS],
                   "citations": cites}
            if name in ("open_issues", "shortfalls"):
                row["severity"] = it.get("severity") if it.get("severity") in SEVERITIES else "medium"
            if name == "shortfalls":
                row["theme"] = it.get("theme") if it.get("theme") in THEMES else "other"
            kept.append(row)
        out[name] = kept[:MAX_ITEMS]
    return out, dropped
```

`backend/customer_review/prompts.py`: in `SYSTEM`, replace the last bullet with

```
- When you are done, call submit_review exactly once: a one or two sentence headline a busy reader can act on, then \
findings. Each finding has a short title (under 80 characters, no ids needed), one or two sentences of detail, and its \
citations. Rate open issues and shortfalls high, medium or low by impact on the customer; tag each shortfall with its \
theme. At most 8 findings per section.
```

and add after the "Never attribute" bullet: `- This includes possessives and greetings: never write a staff member's name anywhere in the review, for example \
"Scott's reply"; write "our reply" instead.` Replace `_ITEMS` and `SUBMIT_TOOL` with:

```python
def _items(severity: bool = False, theme: bool = False) -> dict:
    props = {"title": {"type": "string", "maxLength": 80}, "detail": {"type": "string"}, "citations": _CITES}
    if severity:
        props["severity"] = {"type": "string", "enum": ["high", "medium", "low"]}
    if theme:
        props["theme"] = {"type": "string", "enum": ["turnaround", "coa_quality", "communication", "billing", "other"]}
    return {"type": "array", "items": {"type": "object", "properties": props, "required": ["title", "citations"]}}


SUBMIT_TOOL = {
    "name": "submit_review",
    "description": "Submit the finished review. Call exactly once, at the end.",
    "input_schema": {"type": "object", "properties": {
        "headline": {"type": "string"},
        "sentiment": {"type": "object", "properties": {
            "score": {"type": "integer", "minimum": -2, "maximum": 2},
            "trend": {"type": "string", "enum": ["improving", "steady", "declining"]},
            "reason": {"type": "string"}, "citations": _CITES}, "required": ["score", "trend", "reason"]},
        "open_issues": _items(severity=True), "shortfalls": _items(severity=True, theme=True),
        "strengths": _items(), "next_steps": _items()},
        "required": ["headline", "sentiment", "open_issues", "shortfalls", "strengths", "next_steps"]},
}
```

(`_ITEMS` is deleted.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_customer_review_agent.py -q`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(ai-review): review shape v2 (headline, titled findings, severity, theme)" -- backend/customer_review/prompts.py backend/customer_review/agent.py backend/tests/test_customer_review_agent.py
```

---

### Task 3: Staff-name scrub

**Files:**
- Create: `backend/customer_review/names.py`
- Modify: `backend/customer_review/tools.py` (collect staff names into `c.memo["staff"]`)
- Test: `backend/tests/test_customer_review_names.py`

**Interfaces:**
- Produces: `names.staff_names(db, ctx) -> set[str]`; `names.scrub(review: dict, staff: set[str]) -> tuple[dict, int]`; tools add to `c.memo.setdefault("staff", set())`: dossier `identity.rep`, ticket entries with `author_kind == "agent"` (author), CRM items/messages with `direction == "outbound"` (`who` / `sender` display part).

- [ ] **Step 1: Write the failing test**

```python
"""customer_review.names: staff names never reach a published review."""
from types import SimpleNamespace

from customer_review import names


def test_scrub_full_names_first_possessives_and_boundaries():
    review = {"headline": "Scott Joseph's reply came late; Scottsdale office fine.",
              "sentiment": {"reason": "Lauren answered fast", "citations": []},
              "open_issues": [{"title": "Scott's Sep 17 reply", "detail": "Ask Scott.", "citations": []}],
              "shortfalls": [], "strengths": [], "next_steps": []}
    out, n = names.scrub(review, {"Scott Joseph", "Scott", "Joseph", "Lauren"})
    assert out["headline"] == "the team's reply came late; Scottsdale office fine."
    assert out["sentiment"]["reason"] == "the team answered fast"
    assert out["open_issues"][0]["title"] == "the team's Sep 17 reply"
    assert out["open_issues"][0]["detail"] == "Ask the team."
    assert n == 4


def test_short_names_are_ignored_and_empty_set_is_a_no_op():
    review = {"headline": "Al and Bo", "sentiment": {"reason": "", "citations": []},
              "open_issues": [], "shortfalls": [], "strengths": [], "next_steps": []}
    assert names.scrub(review, {"Al", "Bo"}) == (review, 0)
    assert names.scrub(review, set()) == (review, 0)


def test_staff_names_from_users_and_run(db_session):
    from models import User

    db_session.add(User(email="s@x.example", hashed_password="x", role="admin", first_name="Scott", last_name="Joseph"))
    db_session.commit()
    ctx = SimpleNamespace(memo={"staff": {"Lauren Smith"}})
    got = names.staff_names(db_session, ctx)
    assert {"Scott", "Joseph", "Scott Joseph", "Lauren Smith", "Lauren", "Smith"} <= got


def test_tools_collect_staff_names(monkeypatch):
    from customer_review import tools

    c = tools.Ctx(customer_key="wc:1", db=None)
    monkeypatch.setattr(tools, "_dossier", lambda cx: {"identity": {"name": "Kyle", "rep": "Scott Joseph"}})
    monkeypatch.setattr(tools, "_customer_orders", lambda cx: [])
    tools.call(c, "customer_overview", {})
    thread = {"id": "th_1", "ref": "T-1", "title": "t", "status": "open"}
    monkeypatch.setattr(tools, "_support_list", lambda key: [thread])
    monkeypatch.setattr(tools, "_support_detail", lambda key, tid: {"entries": [
        {"author": "Lauren Smith", "author_kind": "agent", "text": "hi"},
        {"author": "Kyle R", "author_kind": "customer", "text": "yo"}]})
    tools.call(c, "read_ticket", {"ref": "T-1"})
    monkeypatch.setattr(tools, "_crm_list", lambda key, kind: [
        {"id": "a1", "type": "email", "direction": "outbound", "who": "Dana Lee"},
        {"id": "a2", "type": "email", "direction": "inbound", "who": "Kyle R"}])
    tools.call(c, "list_crm", {})
    assert c.memo["staff"] == {"Scott Joseph", "Lauren Smith", "Dana Lee"}
```

Check the `User` model's required columns before running (`grep -n "class User(Base)" -A20 backend/models.py`); adjust the constructor in the test to supply every non-nullable column.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_customer_review_names.py -q`
Expected: ERROR, `cannot import name 'names' from 'customer_review'`

- [ ] **Step 3: Write minimal implementation**

`backend/customer_review/names.py`:

```python
"""Staff names never reach a published review (spec 2026-10-09 section 3.2). Prompting alone did not hold."""
from __future__ import annotations

import copy
import re
from typing import Any

from sqlalchemy import select

REPLACEMENT = "the team"
MIN_LEN = 3
_SECTIONS = ("open_issues", "shortfalls", "strengths", "next_steps")


def staff_names(db, ctx) -> set[str]:
    from models import User
    out: set[str] = set()
    full_names = set(getattr(ctx, "memo", {}).get("staff", set()))
    if db is not None:
        for first, last in db.execute(select(User.first_name, User.last_name)).all():
            full_names.add(" ".join(p for p in (first, last) if p))
    for full in full_names:
        full = (full or "").strip()
        if not full:
            continue
        out.add(full)
        out.update(p for p in full.split() if len(p) >= MIN_LEN)
    return {n for n in out if len(n) >= MIN_LEN}


def _pattern(staff: set[str]) -> re.Pattern | None:
    usable = sorted((n for n in staff if len(n) >= MIN_LEN), key=len, reverse=True)  # full names first
    if not usable:
        return None
    return re.compile(r"\b(?:" + "|".join(re.escape(n) for n in usable) + r")\b")


def scrub(review: dict[str, Any], staff: set[str]) -> tuple[dict[str, Any], int]:
    pat = _pattern(staff)
    if pat is None:
        return review, 0
    out = copy.deepcopy(review)
    count = 0

    def fix(text: str) -> str:
        nonlocal count
        new, n = pat.subn(REPLACEMENT, text or "")
        count += n
        return new

    out["headline"] = fix(out.get("headline", ""))
    out["sentiment"]["reason"] = fix(out["sentiment"].get("reason", ""))
    for name in _SECTIONS:
        for it in out.get(name) or []:
            it["title"] = fix(it.get("title", ""))
            it["detail"] = fix(it.get("detail", ""))
    return out, count
```

`backend/customer_review/tools.py`:
- add helper `def _note_staff(c: Ctx, name) -> None: if name and str(name).strip(): c.memo.setdefault("staff", set()).add(str(name).strip())`;
- in `customer_overview`, after the `None` check: `_note_staff(c, (d.get("identity") or {}).get("rep"))`;
- in `read_ticket`, before building `entries`: `for e in d.get("entries", []): if e.get("author_kind") == "agent": _note_staff(c, e.get("author"))`;
- in `list_crm`, inside the loop: `if it.get("direction") == "outbound": _note_staff(c, it.get("who"))`;
- in `read_crm_item`, after the `None` check: `if d.get("direction") == "outbound": _note_staff(c, d.get("who"))` and for each message `if m.get("direction") == "outbound": _note_staff(c, (m.get("sender") or "").split("<")[0])`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_customer_review_names.py tests/test_customer_review_tools.py -q`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(ai-review): enforced staff-name scrub" -- backend/customer_review/names.py backend/customer_review/tools.py backend/tests/test_customer_review_names.py
```

---

### Task 4: Document renderer

**Files:**
- Create: `backend/customer_review/document.py` (renderer half)
- Test: `backend/tests/test_customer_review_document.py`

**Interfaces:**
- Produces: `document.metrics(dossier: dict | None) -> list[dict]` (each `{"label", "value", "note"?, "tone"?}`); `document.render_html(review: dict, *, customer_name: str, customer_key: str, generated_at: str, model: str, lookups: int, cost_usd: float, metric_cards: list[dict]) -> str`; `document.link_for(citation: dict) -> str | None`.

- [ ] **Step 1: Write the failing test**

```python
"""customer_review.document: escaped HTML report, metrics from the dossier, links per citation kind."""
from customer_review import document

REVIEW = {
    "headline": "Cooling off <script>alert(1)</script> & \"quoted\"",
    "sentiment": {"score": -1, "trend": "steady", "reason": "r", "citations": [], "unsupported": True},
    "open_issues": [
        {"title": "Low thing", "detail": "d", "severity": "low", "citations": [{"kind": "sample", "id": "P-1", "label": "P-1"}]},
        {"title": "High thing</div>", "detail": "<b>x</b>", "severity": "high",
         "citations": [{"kind": "ticket", "id": "T-9", "label": "T-9", "thread": {"plain_url": "https://app.plain.com/w/t/th_9"}}]}],
    "shortfalls": [{"title": "Slow COA", "detail": "d", "severity": "medium", "theme": "coa_quality",
                    "citations": [{"kind": "order", "id": "8642", "label": "Order 8642", "order_id": "501"}]}],
    "strengths": [{"title": "Fast replies", "detail": "", "citations": [{"kind": "crm", "id": "acti_1", "label": "Email",
                                                                         "item": {"lead_id": "lead_A"}}]}],
    "next_steps": [{"title": "Call them", "detail": "", "citations": []}],
}


def render(**kw):
    args = dict(customer_name="Triumphant <Labs>", customer_key="wc:1572", generated_at="2026-10-09T03:00:00Z",
                model="claude-sonnet-5-5", lookups=17, cost_usd=0.18, metric_cards=[{"label": "On time", "value": "56%"}])
    args.update(kw)
    return document.render_html(REVIEW, **args)


def test_model_text_is_escaped():
    html = render()
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert "High thing&lt;/div&gt;" in html and "&lt;b&gt;x&lt;/b&gt;" in html
    assert "Triumphant &lt;Labs&gt;" in html and "&quot;quoted&quot;" in html


def test_sections_order_and_severity_sort():
    html = render()
    for heading in ("Needs attention", "Where we fell short", "Next steps", "Going well"):
        assert heading in html
    assert html.index("High thing") < html.index("Low thing")
    assert "COA quality" in html and "Negative" in html and "56%" in html


def test_links_per_kind(monkeypatch):
    monkeypatch.setenv("MK1_PUBLIC_URL", "https://mk1.example")
    assert document.link_for({"kind": "ticket", "thread": {"plain_url": "https://app.plain.com/w/t/th_9"}}) == "https://app.plain.com/w/t/th_9"
    assert document.link_for({"kind": "crm", "item": {"lead_id": "lead_A"}}) == "https://app.close.com/lead/lead_A/"
    assert document.link_for({"kind": "sample", "id": "P-1"}) == "https://mk1.example/#dashboard/sample-details?id=P-1"
    assert document.link_for({"kind": "order", "id": "8642", "order_id": "501"}) == "https://mk1.example/#accumark-tools/order-explorer?id=501"
    assert document.link_for({"kind": "crm", "item": {}}) is None
    assert document.link_for({"kind": "ticket", "thread": {"plain_url": "javascript:alert(1)"}}) is None


def test_metrics_from_dossier():
    d = {"kpis": {"lifetime": "33012.50", "rank": 7, "customers": 814, "on_time_rate": 0.56, "lab_on_time_rate": 0.58,
                  "usual_gap_days": 14.0},
         "spend_delta_pct": -0.65, "days_since_last": 27.2}
    cards = document.metrics(d)
    labels = [c["label"] for c in cards]
    assert labels == ["Lifetime spend", "Spend vs prior", "On time", "Last order"]
    assert cards[0]["value"] == "$33,013" and cards[0]["note"] == "rank 7 of 814"
    assert cards[1]["value"] == "-65%" and cards[1]["tone"] == "bad"
    assert cards[2]["value"] == "56%" and cards[2]["note"] == "lab 58%"
    assert cards[3]["value"] == "27 days" and cards[3]["note"] == "usual gap 14 days"
    assert document.metrics(None) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_customer_review_document.py -q`
Expected: ERROR, `cannot import name 'document' from 'customer_review'`

- [ ] **Step 3: Write minimal implementation**

`backend/customer_review/document.py`:

```python
"""AI review as a document (spec 2026-10-09 section 3.3): metrics, escaped HTML, publish."""
from __future__ import annotations

import os
from html import escape
from typing import Any

SPACE_SLUG = "customer-reviews"
SPACE_NAME = "Customer reviews"
CATEGORY_NAME = "Customer review"
CATEGORY_PREFIX = "CR"
SENTIMENT = {-2: "Very negative", -1: "Negative", 0: "Neutral", 1: "Positive", 2: "Very positive"}
THEME_LABEL = {"turnaround": "Turnaround", "coa_quality": "COA quality", "communication": "Communication",
               "billing": "Billing", "other": "Other"}
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def _e(v: Any) -> str:
    return escape(str(v if v is not None else ""), quote=True)


def _base() -> str:
    return os.environ.get("MK1_PUBLIC_URL", "https://accumk1.valenceanalytical.com").rstrip("/")


def link_for(c: dict) -> str | None:
    kind = c.get("kind")
    if kind == "ticket":
        url = ((c.get("thread") or {}).get("plain_url") or "")
        return url if url.startswith("https://") else None
    if kind == "crm":
        lead = (c.get("item") or {}).get("lead_id")
        return f"https://app.close.com/lead/{lead}/" if lead else None
    if kind == "sample":
        return f"{_base()}/#dashboard/sample-details?id={c.get('id')}"
    if kind == "order" and c.get("order_id"):
        return f"{_base()}/#accumark-tools/order-explorer?id={c['order_id']}"
    return None


def _pct(v: float | None) -> str:
    return f"{round(v * 100)}%" if isinstance(v, (int, float)) else "n/a"


def metrics(d: dict | None) -> list[dict]:
    if not d:
        return []
    k = d.get("kpis") or {}
    cards = []
    try:
        lifetime = f"${float(k.get('lifetime') or 0):,.0f}"
    except (TypeError, ValueError):
        lifetime = "n/a"
    cards.append({"label": "Lifetime spend", "value": lifetime,
                  "note": f"rank {k['rank']} of {k['customers']}" if k.get("rank") and k.get("customers") else None})
    delta = d.get("spend_delta_pct")
    cards.append({"label": "Spend vs prior", "value": (("+" if delta > 0 else "") + _pct(delta)) if isinstance(delta, (int, float)) else "n/a",
                  "tone": "bad" if isinstance(delta, (int, float)) and delta < -0.1 else None})
    cards.append({"label": "On time", "value": _pct(k.get("on_time_rate")),
                  "note": f"lab {_pct(k.get('lab_on_time_rate'))}" if k.get("lab_on_time_rate") is not None else None})
    days = d.get("days_since_last")
    gap = k.get("usual_gap_days")
    cards.append({"label": "Last order", "value": f"{round(days)} days" if isinstance(days, (int, float)) else "n/a",
                  "note": f"usual gap {round(gap)} days" if isinstance(gap, (int, float)) else None})
    return cards


_CSS = """
.cr-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:6px}
.cr-chip{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12px}
.cr-bad{background:#fcebeb;color:#a32d2d}.cr-warn{background:#faeeda;color:#854f0b}
.cr-ok{background:#eaf3de;color:#3b6d11}.cr-muted{color:#6b6b6b;font-size:13px}
.cr-headline{font-family:Georgia,serif;font-size:19px;line-height:1.6;margin:14px 0 18px}
.cr-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:22px}
.cr-card{border:1px solid #e5e3dc;border-radius:10px;padding:10px 12px}
.cr-card .v{font-size:22px;font-weight:600}.cr-card .l{font-size:12px;color:#6b6b6b}
.cr-issues{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin-bottom:22px}
.cr-issue{border:1px solid #e5e3dc;border-left:4px solid #b4b2a9;padding:10px 12px}
.cr-issue.high{border-left-color:#e24b4a}.cr-issue.medium{border-left-color:#ef9f27}
.cr-issue h4{margin:4px 0;font-size:15px}.cr-issue p{margin:4px 0 6px;font-size:14px}
.cr-cite{display:inline-block;margin:2px 4px 0 0;padding:0 8px;border-radius:999px;background:#e6f1fb;color:#0c447c;font-size:12px;text-decoration:none}
.cr-list{list-style:none;padding:0;margin:0 0 20px}.cr-list li{padding:8px 0;border-bottom:1px solid #eeece6}
.cr-theme{font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:.04em}
.cr-foot{margin-top:24px;font-size:12px;color:#6b6b6b}
"""


def _cites(cs: list[dict]) -> str:
    out = []
    for c in cs or []:
        url = link_for(c)
        label = _e(c.get("label") or c.get("id"))
        out.append(f'<a class="cr-cite" href="{_e(url)}" target="_blank" rel="noopener">{label}</a>' if url
                   else f'<span class="cr-cite">{label}</span>')
    return "".join(out)


def _sev_chip(sev: str) -> str:
    cls = {"high": "cr-bad", "medium": "cr-warn"}.get(sev, "cr-ok")
    return f'<span class="cr-chip {cls}">{_e(sev.capitalize())}</span>'


def render_html(review: dict, *, customer_name: str, customer_key: str, generated_at: str, model: str,
                lookups: int, cost_usd: float, metric_cards: list[dict]) -> str:
    s = review.get("sentiment") or {}
    score = s.get("score", 0)
    tone = "cr-bad" if score < 0 else ("cr-ok" if score > 0 else "")
    parts = [f"<style>{_CSS}</style>",
             f'<h1>{_e(customer_name)}</h1>',
             '<div class="cr-head">'
             f'<span class="cr-chip {tone}">{_e(SENTIMENT.get(score, "Neutral"))} · {_e(s.get("trend", ""))}</span>'
             f'<span class="cr-muted">AI review · {_e(customer_key)} · generated {_e(generated_at[:10])}</span></div>',
             f'<p class="cr-headline">{_e(review.get("headline"))}</p>']
    if metric_cards:
        parts.append('<div class="cr-cards">' + "".join(
            f'<div class="cr-card"><div class="l">{_e(c["label"])}</div>'
            f'<div class="v"{" style=\"color:#a32d2d\"" if c.get("tone") == "bad" else ""}>{_e(c["value"])}</div>'
            + (f'<div class="l">{_e(c["note"])}</div>' if c.get("note") else "") + "</div>"
            for c in metric_cards) + "</div>")
    issues = sorted(review.get("open_issues") or [], key=lambda i: SEVERITY_ORDER.get(i.get("severity"), 1))
    parts.append("<h2>Needs attention</h2>")
    parts.append('<div class="cr-issues">' + "".join(
        f'<div class="cr-issue {_e(i.get("severity"))}">{_sev_chip(i.get("severity", "medium"))}'
        f'<h4>{_e(i["title"])}</h4><p>{_e(i.get("detail"))}</p>{_cites(i.get("citations"))}</div>'
        for i in issues) + "</div>" if issues else '<p class="cr-muted">No open issues found.</p>')
    parts.append("<h2>Where we fell short</h2>")
    falls = sorted(review.get("shortfalls") or [], key=lambda i: (i.get("theme", "other"), SEVERITY_ORDER.get(i.get("severity"), 1)))
    parts.append('<ul class="cr-list">' + "".join(
        f'<li><div class="cr-theme">{_e(THEME_LABEL.get(i.get("theme"), "Other"))} · {_e(i.get("severity", "medium"))}</div>'
        f'<strong>{_e(i["title"])}</strong> {_e(i.get("detail"))} {_cites(i.get("citations"))}</li>'
        for i in falls) + "</ul>" if falls else '<p class="cr-muted">Nothing found.</p>')
    for heading, key, mark in (("Next steps", "next_steps", "&#9744;"), ("Going well", "strengths", "&#10003;")):
        rows = review.get(key) or []
        parts.append(f"<h2>{heading}</h2>")
        parts.append('<ul class="cr-list">' + "".join(
            f'<li>{mark} <strong>{_e(i["title"])}</strong> {_e(i.get("detail"))} {_cites(i.get("citations"))}</li>'
            for i in rows) + "</ul>" if rows else '<p class="cr-muted">None.</p>')
    parts.append(f'<p class="cr-muted">Sentiment: {_e(s.get("reason"))} {_cites(s.get("citations"))}</p>')
    parts.append(f'<p class="cr-foot">Generated by {_e(model)} from {_e(lookups)} lookups (${_e(f"{cost_usd:.2f}")}). '
                 "Findings cite what the agent read; verify before acting.</p>")
    return "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" + "".join(parts) + "</body></html>"
```

Note: the f-string with an escaped `style` attribute inside an expression uses a backslash, which Python before 3.12 rejects; if the backend runs Python < 3.12 (check `python --version` in the backend image via `backend/Dockerfile`), compute `style = ' style="color:#a32d2d"' if c.get("tone") == "bad" else ""` in a loop instead of inside the f-string.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_customer_review_document.py -q`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(ai-review): escaped HTML review document renderer" -- backend/customer_review/document.py backend/tests/test_customer_review_document.py
```

---

### Task 5: Publish and runner wiring

**Files:**
- Modify: `backend/customer_review/document.py` (publish half)
- Modify: `backend/customer_review/routes.py` (`_execute` scrubs, publishes, records)
- Test: `backend/tests/test_customer_review_publish.py`; update `backend/tests/test_customer_review_routes.py`

**Interfaces:**
- Consumes: `documents.service.create_document`, `create_space`, `create_category`, `get_space_by_slug`; `documents.models.DocumentSpace`, `DocumentCategory`; `store.document_code_for`; `names.staff_names`, `names.scrub`; `tools._dossier`.
- Produces: `document.ensure_space_and_category(db) -> tuple[DocumentSpace, DocumentCategory]`; `document.publish(db, *, review, customer_key, customer_name, author, run_id, model, lookups, cost_usd, metric_cards, code) -> tuple[int, str]` (document id, code).

- [ ] **Step 1: Write the failing test**

`backend/tests/test_customer_review_publish.py`:

```python
"""Publishing a review: company space + CR category, one code per customer, revisions."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from customer_review import document


@pytest.fixture
def db():
    import documents.models  # noqa: F401  register documents tables before create_all
    import models  # noqa: F401
    from database import Base
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


REVIEW = {"headline": "h", "sentiment": {"score": 0, "trend": "steady", "reason": "r", "citations": [], "unsupported": True},
          "open_issues": [], "shortfalls": [], "strengths": [], "next_steps": []}


def pub(db, code=None, headline="h"):
    return document.publish(db, review={**REVIEW, "headline": headline}, customer_key="wc:1", customer_name="Kyle",
                            author="Forrest Parker", run_id=1, model="m", lookups=3, cost_usd=0.1, metric_cards=[],
                            code=code)


def test_first_publish_creates_space_category_and_code(db):
    from documents.models import Document, DocumentSpace

    doc_id, code = pub(db)
    assert code.startswith("CR-")
    sp = db.query(DocumentSpace).filter_by(slug="customer-reviews").one()
    assert sp.visibility == "company"
    d = db.get(Document, doc_id)
    assert d.space_id == sp.id and d.title == "Customer review: Kyle" and d.author == "Forrest Parker"


def test_second_publish_is_a_new_revision_of_the_same_code(db):
    from documents.models import Document

    first_id, code = pub(db)
    second_id, code2 = pub(db, code=code, headline="changed")
    assert code2 == code and second_id != first_id
    assert db.get(Document, second_id).revision == db.get(Document, first_id).revision + 1


def test_ensure_is_idempotent(db):
    a = document.ensure_space_and_category(db)
    b = document.ensure_space_and_category(db)
    assert (a[0].id, a[1].id) == (b[0].id, b[1].id)
```

Before writing, read `backend/documents/models.py` (`Document` columns: confirm `revision`, `space_id`, `title`, `author`) and `documents.service.create_document`'s return value; align the assertions with the real column names.

In `backend/tests/test_customer_review_routes.py::test_runner_records_done_failed_and_unavailable`, patch publishing: `monkeypatch.setattr(routes.document, "publish", lambda db, **kw: (42, "CR-0001"))`, `monkeypatch.setattr(routes, "_dossier_for", lambda db, key: None)`, give the fake `done` Outcome a v2 review (`{"headline": "Scott was slow", "sentiment": {"score": 0, "trend": "steady", "reason": "", "citations": [], "unsupported": True}, "open_issues": [], "shortfalls": [], "strengths": [], "next_steps": []}`), patch `routes.names.staff_names` to return `{"Scott"}`, and assert the done row has `document_id == 42`, `document_code == "CR-0001"`, `names_scrubbed == 1`, and `review["headline"] == "the team was slow"`. Add:

```python
def test_publish_failure_keeps_the_run_done(api, monkeypatch):
    _, Session, _ = api
    with Session() as db:
        run_id = store.create_run(db, "wc:1", 1, "m").id
    monkeypatch.setattr(llm, "get_client", lambda: object())
    good = {"headline": "h", "sentiment": {"score": 0, "trend": "steady", "reason": "", "citations": [], "unsupported": True},
            "open_issues": [], "shortfalls": [], "strengths": [], "next_steps": []}
    monkeypatch.setattr(routes.agent, "run", lambda **kw: agent.Outcome(status="done", review=good))
    monkeypatch.setattr(routes, "_dossier_for", lambda db, key: None)

    def boom(db, **kw):
        raise RuntimeError("documents down")

    monkeypatch.setattr(routes.document, "publish", boom)
    routes._execute(run_id, "wc:1")
    with Session() as db:
        row = store.get_run(db, run_id)
        assert row.status == "done" and row.document_id is None and row.document_error == "document publish failed"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_customer_review_publish.py tests/test_customer_review_routes.py -q`
Expected: FAIL (`document.publish` missing; runner does not publish)

- [ ] **Step 3: Write minimal implementation**

Append to `backend/customer_review/document.py`:

```python
def ensure_space_and_category(db):
    from sqlalchemy import select

    from documents.models import DocumentCategory, DocumentSpace
    from documents.service import create_category, create_space
    space = db.execute(select(DocumentSpace).where(DocumentSpace.slug == SPACE_SLUG)).scalar_one_or_none()
    if space is None:
        space = create_space(db, slug=SPACE_SLUG, name=SPACE_NAME,
                             description="AI customer reviews, one document per customer", visibility="company")
    category = db.execute(select(DocumentCategory).where(DocumentCategory.code_prefix == CATEGORY_PREFIX)
                          ).scalar_one_or_none()
    if category is None:
        category = create_category(db, name=CATEGORY_NAME, code_prefix=CATEGORY_PREFIX,
                                   description="AI customer review")
    return space, category


def publish(db, *, review: dict, customer_key: str, customer_name: str, author: str | None, run_id: int,
            model: str, lookups: int, cost_usd: float, metric_cards: list[dict], code: str | None) -> tuple[int, str]:
    from datetime import datetime, timezone

    from documents.service import create_document
    space, category = ensure_space_and_category(db)
    html = render_html(review, customer_name=customer_name, customer_key=customer_key,
                       generated_at=datetime.now(timezone.utc).isoformat(), model=model, lookups=lookups,
                       cost_usd=cost_usd, metric_cards=metric_cards)
    doc, _created = create_document(
        db, title=f"Customer review: {customer_name}", html=html, category=category,
        description=f"AI review · {model} · {lookups} lookups · ${cost_usd:.2f}", code=code, author=author,
        source_session=f"ai-review-run-{run_id}", space=space)
    return doc.id, doc.code
```

(If `create_space`/`create_category` commit internally or require a flush, follow their contract; if `create_document` commits, nothing else is needed; otherwise `db.commit()` after it.)

`backend/customer_review/routes.py`: import `document, names` from `customer_review`; add

```python
def _dossier_for(db, key: str) -> dict | None:
    try:
        return tools._dossier(tools.Ctx(customer_key=key, db=db))
    except Exception as e:
        logger.warning("customer_review.dossier_failed error=%s", type(e).__name__)
        return None


def _author(db, user_id: int | None) -> str | None:
    from models import User
    u = db.get(User, user_id) if user_id else None
    if u is None:
        return None
    return " ".join(p for p in (u.first_name, u.last_name) if p) or u.email
```

and in `_execute`, replace the success path (`outcome = agent.run(...)` through `_finish(...)`) with:

```python
        ctx = tools.Ctx(customer_key=key, db=db)
        outcome = agent.run(llm=llm.get_client(), ctx=ctx, on_step=lambda step: store.add_step(db, run_id, step))
        doc_fields: dict = {}
        review = outcome.review
        if outcome.status == "done" and review:
            review, scrubbed = names.scrub(review, names.staff_names(db, ctx))
            doc_fields["names_scrubbed"] = scrubbed
            try:
                dossier = _dossier_for(db, key)
                row = store.get_run(db, run_id)
                doc_id, code = document.publish(
                    db, review=review, customer_key=key,
                    customer_name=((dossier or {}).get("identity") or {}).get("name") or key,
                    author=_author(db, row.created_by if row else None), run_id=run_id, model=llm.MODEL,
                    lookups=len(outcome.tool_calls), cost_usd=float(outcome.cost),
                    metric_cards=document.metrics(dossier), code=store.document_code_for(db, key))
                doc_fields.update(document_id=doc_id, document_code=code)
            except Exception as e:
                db.rollback()
                logger.warning("customer_review.publish_failed run=%s error=%s", run_id, type(e).__name__)
                doc_fields["document_error"] = "document publish failed"
        db.close()
        _finish(run_id, status=outcome.status, review=review, tool_calls=outcome.tool_calls,
                input_tokens=outcome.input_tokens, output_tokens=outcome.output_tokens, cost_usd=outcome.cost,
                citations_dropped=outcome.citations_dropped, error=outcome.error, **doc_fields)
```

(`store.finish` already accepts the new keywords from Task 1.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_customer_review_publish.py tests/test_customer_review_routes.py tests/test_customer_review_agent.py tests/test_customer_review_names.py tests/test_customer_review_document.py tests/test_customer_review_store.py tests/test_customer_review_tools.py tests/test_customer_review_llm.py -q`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true commit -m "feat(ai-review): publish each review as a Customer reviews document" -- backend/customer_review/document.py backend/customer_review/routes.py backend/tests/test_customer_review_publish.py backend/tests/test_customer_review_routes.py
```

---

### Task 6: Embedded viewer and the AI review tab

**Files:**
- Modify: `src/components/documents/DocumentViewer.tsx` (props `embedded`, `onNavigate`)
- Modify: `src/lib/api-ai-review.ts` (types: v2 review, document fields)
- Rename + rewrite: `src/components/customers/CustomerAiReviewCard.tsx` -> `src/components/customers/CustomerAiReviewTab.tsx` (and its test)
- Modify: `src/components/CustomerStatusPage.tsx`, `src/store/ui-store.ts`, `src/test/customer-status-page.test.tsx`
- Test: `src/components/customers/CustomerAiReviewTab.test.tsx`, `src/components/documents/DocumentViewer.embedded.test.tsx`

**Interfaces:**
- Produces: `DocumentViewer({ id, embedded?: boolean, onNavigate?: (id: number) => void })`; `<CustomerAiReviewTab customerKey />`; tab value `'ai-review'` with label "AI review".

- [ ] **Step 1: Write the failing tests**

`src/components/documents/DocumentViewer.embedded.test.tsx`: render `DocumentViewer` with `embedded` and a stubbed `useDocument` (follow the mocking pattern of the existing DocumentViewer tests in `src/components/documents/__tests__` or `src/test/`; find them with `grep -rln "DocumentViewer" src --include=*.test.tsx`) for a document with two revisions; assert there is no button named "Documents" (the back button), and that choosing the other revision in the revision select calls the `onNavigate` mock with its id and does not call the store's `navigateToDocument`.

`src/components/customers/CustomerAiReviewTab.test.tsx`: adapt the six existing `CustomerAiReviewCard` tests to the tab (no "Show details"; no history select): empty state Generate starts a run and shows steps plus "Working · started N min ago"; mounting mid-run then finishing shows the summary; done with `document_id` renders the headline, the sentiment chip "Negative · steady", counts, cost line, and a mocked `DocumentViewer` (mock `@/components/documents/DocumentViewer` to render `<div>viewer {id} {String(embedded)}</div>`) with `viewer 42 true`; done without a document shows "No review document yet" and the `document_error`; failed run keeps the last good summary; 503 shows "AI review not configured". Fixtures use the v2 review shape and `document_id`.

In `src/test/customer-status-page.test.tsx` (admin-only test): replace the `region` "AI review" assertions with tab assertions: standard user sees no tab named "AI review"; admin sees it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/documents/DocumentViewer.embedded.test.tsx src/components/customers/CustomerAiReviewTab.test.tsx src/test/customer-status-page.test.tsx -t "admins only|embedded|CustomerAiReviewTab"`
Expected: FAIL (props unsupported; component missing; tab missing)

- [ ] **Step 3: Write minimal implementation**

`DocumentViewer.tsx`: signature `export function DocumentViewer({ id, embedded = false, onNavigate }: { id: number; embedded?: boolean; onNavigate?: (id: number) => void })`; after the store selectors add `const goTo = onNavigate ?? navigateToDocument`; replace the three `navigateToDocument(...)` calls (post-edit new revision, revision select, "Newest revision") with `goTo(...)`; wrap the back `<Button>` in `{!embedded && (...)}`.

`api-ai-review.ts`: `ReviewItem` becomes `{ title: string; detail: string; severity?: 'high' | 'medium' | 'low'; theme?: string; citations: ReviewCitation[] }`; `Review` gains `headline: string`; `ReviewRun` gains `document_id: number | null; document_code: string | null; names_scrubbed: number; document_error: string | null`.

`CustomerAiReviewTab.tsx` (from the card): keep the data logic (reviews query, running query with 2 s polling, finished-run effect, start mutation, last-good selection); drop the expanded sections, chips, history select and lookups list; render:
- a summary bar: Sparkles icon, sentiment chip (`SENTIMENT[score + 2] · trend`), the headline (line-clamped to 2 lines), counts ("N open issues · N where we fell short"), "Generated <date> · <age>", cost and lookups (`model · N lookups · $x.xx`), "Open in Documents" link (`#reports/documents?id=<document_id>`) when a document exists, and Generate/Regenerate (spinner + disabled while running);
- the running step list with "Working · started N min ago";
- failed / not configured / could not start messages as today;
- below: when the last good run has `document_id`, `<div className="mt-3 h-[75vh] overflow-hidden rounded-lg border"><DocumentViewer id={viewId ?? document_id} embedded onNavigate={setViewId} /></div>` (local `viewId` state, reset when a new run finishes); otherwise "No review document yet: Regenerate to create one." plus `document_error` when present.

`CustomerStatusPage.tsx`: import `CustomerAiReviewTab` (remove the card import); remove the card block above the tabs; extend the `value` fallback condition to `(customerDetailTab === 'crm' || customerDetailTab === 'support' || customerDetailTab === 'ai-review') && !isAdminUser`; `onValueChange` cast adds `'ai-review'`; add `{isAdminUser && <TabsTrigger value="ai-review">AI review</TabsTrigger>}` after Support and a matching `TabsContent` rendering `<CustomerAiReviewTab customerKey={`wc:${customerDetailTargetId}`} />`; guest view: move the AI review block after the Support section, rendered as `<section className="mt-4"><h2 className="mb-2 text-sm font-medium">AI review</h2><CustomerAiReviewTab customerKey={customerKey} /></section>`.

`ui-store.ts`: both `'orders' | 'dashboard' | 'crm' | 'support'` unions gain `| 'ai-review'` (keep prettier line breaks).

Delete `CustomerAiReviewCard.tsx` and `CustomerAiReviewCard.test.tsx` (`git rm`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/customers src/components/documents src/test/customer-status-page.test.tsx`
Expected: all passed

- [ ] **Step 5: Typecheck, lint, format, commit**

Run: `npx tsc --noEmit && npx eslint src/components/customers src/components/documents/DocumentViewer.tsx src/lib/api-ai-review.ts src/components/CustomerStatusPage.tsx src/store/ui-store.ts` and prettier on new/changed files (only touched hunks in files that already fail prettier on master).

```bash
git -c core.autocrlf=true commit -m "feat(ai-review): AI review tab with the review document embedded" -- src/components/documents/DocumentViewer.tsx src/components/documents/DocumentViewer.embedded.test.tsx src/lib/api-ai-review.ts src/components/customers/CustomerAiReviewTab.tsx src/components/customers/CustomerAiReviewTab.test.tsx src/components/customers/CustomerAiReviewCard.tsx src/components/customers/CustomerAiReviewCard.test.tsx src/components/CustomerStatusPage.tsx src/store/ui-store.ts src/test/customer-status-page.test.tsx
```

---

### Task 7: Gates, review and live check

- [ ] **Step 1:** Full vitest; backend full suite on the branch then on a temporary `origin/master` worktree (sequential, node_modules via junction removed before the worktree); compare failure sets. Expected: no new failures.
- [ ] **Step 2:** Fresh whole-branch review on the most capable model with this plan's Review Focus; one fix pass for Critical/Important, each RED->GREEN.
- [ ] **Step 3:** Live: stage the branch's `customer_review` package plus `documents` untouched in the prod backend container `/tmp`, run `agent.run` + `names.scrub` + `document.render_html` read-only for wc:1572 and save the HTML locally for the Handler to open (no publish, no DB write). Publishing itself is verified after deploy by one real Regenerate.
