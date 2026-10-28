# Flags on Support Tickets and CRM Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise flags on Plain tickets and Close CRM activities, list them lab-wide, and let anyone on such a flag read that one item.

**Architecture:**
- **Entity types.** Two new flag entity types, `support_ticket` and `crm_item`. They are registered in `flags/seams.register_mk1_entities()` from small `flag_entity.py` modules in `support_plain` and `crm_close`.
- **Labels and access.** Labels come from the snapshot stored on the flag's "raised" event. A new `flags/access.py` answers "is this user on a flag for this item", and the two detail routes use it to admit flag participants read-only, returning `via_flag`.
- **Frontend.** The frontend adds:
  - the Flag button to both slide-outs
  - list markers
  - a `customer_item` deep-link kind
  - a page-level opener that shows the flagged item even to viewers who cannot see the tab

**Tech Stack:** FastAPI, SQLAlchemy 2 (SQLite in tests), pytest; React 19, TanStack Query, zustand ui-store, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-12-flags-on-support-and-crm-items-design.md`

## Global Constraints

- **Entity ids:**
  - `support_ticket`: `{customer_key}|{thread_id}`
  - `crm_item`: `{customer_key}|{type}|{activity_id}`
  - The customer key must be `wc:<digits>`. The thread id must match `support_plain.rules.THREAD_ID_PATTERN`. The CRM type is one of `email`, `call`, `sms`, `meeting`, `note`.
- **Who can do what:**
  - Anyone logged in can raise, see and work these flags (no `can_view` or `visible_entity_ids` restriction).
  - Raising checks that the item belongs to the customer.
  - Flag access means read-only access to that one item for its creator, assignee or participants, whether the flag is open or resolved.
  - List routes and all writes keep their gates.
- **Labels never call Plain or Close.** Snapshots may call them once, at raise time, and raising must not fail if they do.
- **No new tables, no schema change.** Every new response key is declared on its pydantic model.
- **Frontend tooling:** npm only, no em dashes in UI copy. Gate on `npx tsc --noEmit -p <abs>/tsconfig.json` plus eslint on changed files.
- **Backend tests:** run with `cd backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python -m pytest <files> -q -p no:cacheprovider`, one suite at a time.

## Review Focus

1. **A participant reads with a well-formed id for a different customer** (the `wc:` key swapped). Expect 404, because customer scoping still applies. Pinned in Task 4: `test_flag_access_still_scopes_to_the_customer`.
2. **A non-participant who can see flags opens a flag's link.** Expect the detail route to answer 403, with no data leaked through the response body. Pinned in Task 4: `test_non_participant_without_seat_is_refused`.
3. **Plain or Close is down when a flag is raised.** Expect the flag to be created with the fallback label. Pinned in Task 2: `test_snapshot_failure_still_raises_with_fallback_label`.
4. **A malformed entity id on raise** (a missing part, a bad thread id, an unknown CRM type). Expect 400 and no flag. Pinned in Tasks 2 and 3: `test_malformed_ids_are_refused`.
5. **The customer page receives a `customer_item` link for a CRM item while the viewer cannot see the CRM tab.** Expect the slide-out to open anyway. Pinned in Task 5: `opens a pending CRM item for a viewer without the tab`.

## Rulings made while planning

- **List markers are passive.** Spec 5.2 makes the list marker clickable, but it sits inside the row's `<button>`, and a nested interactive element is invalid HTML. The marker is therefore a non-interactive indicator; the flags open from the slide-out's Flag pill. Cost if wrong: one extra click.
- **Parse helpers live per module.** The spec mentions "a shared helper" for parsing ids. Each `flag_entity.py` parses its own id format with a small function; the shared part is `flags/access.py`. Cost if wrong: about ten duplicated lines.

---

### Task 1: Flag access and snapshot labels (`flags/access.py`)

**Files:**
- Create: `backend/flags/access.py`
- Test: `backend/tests/test_flags_item_access.py`

**Interfaces:**
- Produces:
  - `flag_for_user(db, user_id: int | None, entity_type: str, entity_id: str) -> int | None` returns the newest flag id the user is on (creator, assignee or participant; any status).
  - `on_flag_for(db, user_id, entity_type, entity_id) -> bool`.
  - `snapshot_label(db, entity_type, entity_id, fallback: str) -> str` returns the latest "raised" event's `details.entity_snapshot.label`, or `fallback`.

- [ ] **Step 1: Failing tests**

```python
"""flags.access: who is 'on a flag' for an item, and labels from the raise-time snapshot (spec 3.2, 3.3)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


EID = "wc:1|th_01ABC"


def _flag(db, **kw):
    from flags.models import FlagFlag
    f = FlagFlag(entity_type=kw.pop("entity_type", "support_ticket"), entity_id=kw.pop("entity_id", EID),
                 kind="issue", type="question", status=kw.pop("status", "open"), title="t",
                 created_by=kw.pop("created_by", 1), assignee_id=kw.pop("assignee_id", None))
    db.add(f)
    db.commit()
    return f


def test_creator_assignee_and_watcher_are_on_the_flag(db):
    from flags import access
    from flags.models import FlagParticipant
    f = _flag(db, created_by=1, assignee_id=2)
    db.add(FlagParticipant(flag_id=f.id, user_id=3, role="watcher"))
    db.commit()
    for uid in (1, 2, 3):
        assert access.on_flag_for(db, uid, "support_ticket", EID), uid
    assert not access.on_flag_for(db, 4, "support_ticket", EID)
    assert not access.on_flag_for(db, None, "support_ticket", EID)


def test_resolved_flags_still_count_and_newest_wins(db):
    from flags import access
    old = _flag(db, created_by=5, status="resolved")
    new = _flag(db, created_by=5, status="closed")
    assert access.flag_for_user(db, 5, "support_ticket", EID) == new.id != old.id


def test_other_items_and_types_do_not_count(db):
    from flags import access
    _flag(db, created_by=1, entity_id="wc:1|th_OTHER")
    _flag(db, created_by=1, entity_type="crm_item", entity_id=EID)
    assert not access.on_flag_for(db, 1, "support_ticket", EID)


def test_snapshot_label_from_the_latest_raised_event(db):
    from flags import access
    from flags.models import FlagEvent
    f = _flag(db)
    db.add(FlagEvent(flag_id=f.id, actor_id=1, event_type="raised",
                     details={"type": "question", "entity_snapshot": {"label": "T-1 · Old title · Kyle"}}))
    g = _flag(db)
    db.add(FlagEvent(flag_id=g.id, actor_id=1, event_type="raised",
                     details={"type": "question", "entity_snapshot": {"label": "T-1 · New title · Kyle"}}))
    db.commit()
    assert access.snapshot_label(db, "support_ticket", EID, "Support ticket") == "T-1 · New title · Kyle"


def test_snapshot_label_falls_back(db):
    from flags import access
    assert access.snapshot_label(db, "support_ticket", EID, "Support ticket") == "Support ticket"
    assert access.snapshot_label(None, "support_ticket", EID, "Support ticket") == "Support ticket"
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd backend && <venv python> -m pytest tests/test_flags_item_access.py -q -p no:cacheprovider`
Expected: FAIL with `ModuleNotFoundError: flags.access` or an `ImportError`.

- [ ] **Step 3: Implement**

`backend/flags/access.py`:

```python
"""Flag-based read access to the item a flag is about, and snapshot labels (spec 2026-10-12 §3.2, §3.3).

Anyone on a flag (creator, assignee or participant), open or resolved, may read that one item.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from flags.models import FlagEvent, FlagFlag, FlagParticipant


def flag_for_user(db: Session, user_id: Optional[int], entity_type: str, entity_id: str) -> Optional[int]:
    if user_id is None:
        return None
    q = (select(FlagFlag.id)
         .outerjoin(FlagParticipant, and_(FlagParticipant.flag_id == FlagFlag.id,
                                          FlagParticipant.user_id == user_id))
         .where(FlagFlag.entity_type == entity_type, FlagFlag.entity_id == entity_id,
                or_(FlagFlag.created_by == user_id, FlagFlag.assignee_id == user_id,
                    FlagParticipant.id.is_not(None)))
         .order_by(FlagFlag.id.desc()).limit(1))
    return db.execute(q).scalar()


def on_flag_for(db: Session, user_id: Optional[int], entity_type: str, entity_id: str) -> bool:
    return flag_for_user(db, user_id, entity_type, entity_id) is not None


def snapshot_label(db: Optional[Session], entity_type: str, entity_id: str, fallback: str) -> str:
    if db is None:
        return fallback
    q = (select(FlagEvent.details).join(FlagFlag, FlagFlag.id == FlagEvent.flag_id)
         .where(FlagFlag.entity_type == entity_type, FlagFlag.entity_id == entity_id,
                FlagEvent.event_type == "raised")
         .order_by(FlagEvent.id.desc()).limit(1))
    details = db.execute(q).scalar()
    snap = details.get("entity_snapshot") if isinstance(details, dict) else None
    label = snap.get("label") if isinstance(snap, dict) else None
    return label or fallback
```

- [ ] **Step 4: Run to watch it pass**, using the same command as Step 2. Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/flags/access.py backend/tests/test_flags_item_access.py
git commit -m "feat(flags): who is on a flag for an item, and snapshot labels"
```

---

### Task 2: `support_ticket` entity type

**Files:**
- Create: `backend/support_plain/flag_entity.py`
- Modify: `backend/flags/seams.py`: at the end of `register_mk1_entities()`, after the `document` registration, add `from support_plain.flag_entity import register as _register_support; _register_support(register_entity)`.
- Test: `backend/tests/test_flags_support_ticket.py`

**Interfaces:**
- Consumes: `flags.access.snapshot_label`; `support_plain.service.thread_detail(customer_key, thread_id)`, which returns `None` for a foreign or unknown thread; `support_plain.rules.THREAD_ID_PATTERN`.
- Produces:
  - `parse(eid) -> tuple[str, str] | None` returns `(customer_key, thread_id)`.
  - `register(register_entity) -> None`.
  - The entity type `support_ticket`, whose context `deep_link` is `{"kind": "customer_item", "id": "support:" + eid}`.

- [ ] **Step 1: Failing tests**

```python
"""support_ticket flags: ids, raise checks, snapshot labels, deep link (spec 3.1, 3.2)."""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

USER = SimpleNamespace(id=7, role="standard", email="cs@x.t")
EID = "wc:1572|th_01KNK2DP78S9Z8P62PZV6M7F8M"
DETAIL = {"thread": {"id": "th_01KNK2DP78S9Z8P62PZV6M7F8M", "ref": "T-1540", "title": "Contact form",
                     "customer": {"name": "Lilia Billones"}}, "entries": []}


@pytest.fixture
def db(monkeypatch):
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    from support_plain import service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    monkeypatch.setattr(service, "thread_detail",
                        lambda key, th, **kw: DETAIL if (key, th) == ("wc:1572", DETAIL["thread"]["id"]) else None)
    seams.register_mk1_entities()
    yield s
    s.close()


def test_parse():
    from support_plain import flag_entity as fe
    assert fe.parse(EID) == ("wc:1572", "th_01KNK2DP78S9Z8P62PZV6M7F8M")
    for bad in ("wc:1572", "wc:1572|abc", "x:1|th_01", "wc:1572|th_01|extra", "", "wc:|th_01"):
        assert fe.parse(bad) is None, bad


def test_raise_snapshots_and_labels(db):
    from flags import seams, service
    flag = service.create_flag(db, user=USER, entity_type="support_ticket", entity_id=EID,
                               type="question", title="Need lab help")
    assert flag.entity_id == EID
    assert seams.get_entity_spec("support_ticket").label(db, EID) == "T-1540 · Contact form · Lilia Billones"
    ctx = seams.resolve_context(db, "support_ticket", EID)
    assert ctx["deep_link"] == {"kind": "customer_item", "id": "support:" + EID}


def test_malformed_ids_are_refused(db):
    from flags import service
    from flags.errors import BadRequestError
    for bad in ("wc:1572", "wc:1572|abc", "nope"):
        with pytest.raises(BadRequestError):
            service.create_flag(db, user=USER, entity_type="support_ticket", entity_id=bad,
                                type="question", title="x")


def test_foreign_ticket_is_refused(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=USER, entity_type="support_ticket",
                            entity_id="wc:999|th_01KNK2DP78S9Z8P62PZV6M7F8M", type="question", title="x")


def test_snapshot_failure_still_raises_with_fallback_label(db, monkeypatch):
    from flags import seams, service
    from support_plain import service as support
    from support_plain.client import SupportUnavailable
    calls = {"n": 0}

    def flaky(key, th, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return DETAIL  # the raise-time ownership check passes
        raise SupportUnavailable("http_503")  # the snapshot lookup fails

    monkeypatch.setattr(support, "thread_detail", flaky)
    service.create_flag(db, user=USER, entity_type="support_ticket", entity_id=EID, type="question", title="x")
    assert seams.get_entity_spec("support_ticket").label(db, EID) == "Support ticket"
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd backend && <venv python> -m pytest tests/test_flags_support_ticket.py -q -p no:cacheprovider`
Expected: FAIL (`ImportError: support_plain.flag_entity`, or `unknown entity_type 'support_ticket'`).

- [ ] **Step 3: Implement**

`backend/support_plain/flag_entity.py`:

```python
"""`support_ticket` as a flag entity type (spec 2026-10-12 §3)."""
from __future__ import annotations

import re
from typing import Optional

from flags import access
from flags.errors import BadRequestError
from support_plain import rules

TYPE = "support_ticket"
FALLBACK = "Support ticket"
_KEY = re.compile(r"^wc:\d+$")
_THREAD = re.compile(rules.THREAD_ID_PATTERN)


def parse(eid: object) -> Optional[tuple[str, str]]:
    parts = str(eid or "").split("|")
    if len(parts) != 2 or not _KEY.match(parts[0]) or not _THREAD.match(parts[1]):
        return None
    return parts[0], parts[1]


def _detail(eid: str) -> Optional[dict]:
    from support_plain import service
    p = parse(eid)
    return service.thread_detail(p[0], p[1]) if p else None


def can_raise(db, user, eid: str) -> bool:
    if parse(eid) is None:
        raise BadRequestError(f"malformed support_ticket id {eid!r}")
    if _detail(eid) is None:
        raise BadRequestError("that ticket is not one of this customer's tickets")
    return True


def snapshot(db, eid: str) -> dict:
    try:
        d = _detail(eid) or {}
        t = d.get("thread") or {}
        customer = (t.get("customer") or {}).get("name")
        parts = [x for x in (t.get("ref"), t.get("title"), customer) if x]
        return {"label": " · ".join(parts) or FALLBACK, "ref": t.get("ref"), "title": t.get("title"),
                "customer": customer}
    except Exception:  # noqa: BLE001 - raising a flag must never fail on a Plain hiccup (spec 3.2)
        return {"label": FALLBACK}


def label(db, eid: str) -> str:
    return access.snapshot_label(db, TYPE, eid, FALLBACK)


def context(db, eid: str) -> Optional[dict]:
    if parse(eid) is None:
        return None
    return {"label": label(db, eid), "sample_id": None, "analyses": [], "lot": None,
            "deep_link": {"kind": "customer_item", "id": f"support:{eid}"}}


def register(register_entity) -> None:
    register_entity(TYPE, label=label, deep_link=lambda eid: "/#customers",
                    can_flag=lambda user, eid: True, can_raise=can_raise, context=context, snapshot=snapshot)
```

Add the registration call to `seams.register_mk1_entities()` as described under Files.

- [ ] **Step 4: Run to watch it pass, then the document flag suite.**
  - Run Step 2's command. Expected: PASS (5 tests).
  - Then run `<venv python> -m pytest tests/test_flags_documents.py -q -p no:cacheprovider`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/support_plain/flag_entity.py backend/flags/seams.py backend/tests/test_flags_support_ticket.py
git commit -m "feat(flags): support_ticket entity type"
```

---

### Task 3: `crm_item` entity type

**Files:**
- Create: `backend/crm_close/flag_entity.py`
- Modify: `backend/flags/seams.py`: after the support registration, add `from crm_close.flag_entity import register as _register_crm; _register_crm(register_entity)`.
- Test: `backend/tests/test_flags_crm_item.py`

**Interfaces:**
- Consumes: `flags.access.snapshot_label`; `crm_close.service.activity_detail(customer_key, activity_id, kind)`, which returns `None` for a foreign or unknown item.
- Produces:
  - `parse(eid) -> tuple[str, str, str] | None` returns `(customer_key, type, activity_id)`.
  - `register(register_entity)`.
  - The entity type `crm_item`, whose deep link id is `"crm:" + eid`.

- [ ] **Step 1: Failing tests**

```python
"""crm_item flags: ids, raise checks, snapshot labels, deep link (spec 3.1, 3.2)."""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

USER = SimpleNamespace(id=7, role="standard", email="cs@x.t")
EID = "wc:1551|email|acti_8f2abc"
ITEM = {"id": "acti_8f2abc", "type": "email", "title": "Re: COA timing", "lead_name": "Kyle Robertson",
        "at": "2026-10-01T10:00:00Z"}


@pytest.fixture
def db(monkeypatch):
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from crm_close import service
    from flags import seams, types_service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    monkeypatch.setattr(service, "activity_detail",
                        lambda key, aid, kind: ITEM if (key, aid, kind) == ("wc:1551", "acti_8f2abc", "email") else None)
    seams.register_mk1_entities()
    yield s
    s.close()


def test_parse():
    from crm_close import flag_entity as fe
    assert fe.parse(EID) == ("wc:1551", "email", "acti_8f2abc")
    for bad in ("wc:1551|email", "wc:1551|fax|acti_1", "wc:1551|email|", "x|email|acti_1", ""):
        assert fe.parse(bad) is None, bad


def test_raise_snapshots_and_labels(db):
    from flags import seams, service
    service.create_flag(db, user=USER, entity_type="crm_item", entity_id=EID, type="question", title="x")
    assert seams.get_entity_spec("crm_item").label(db, EID) == "Email · Re: COA timing · Kyle Robertson"
    assert seams.resolve_context(db, "crm_item", EID)["deep_link"] == {"kind": "customer_item", "id": "crm:" + EID}


def test_malformed_ids_are_refused(db):
    from flags import service
    from flags.errors import BadRequestError
    for bad in ("wc:1551|email", "wc:1551|fax|acti_1"):
        with pytest.raises(BadRequestError):
            service.create_flag(db, user=USER, entity_type="crm_item", entity_id=bad, type="question", title="x")


def test_foreign_item_is_refused(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=USER, entity_type="crm_item", entity_id="wc:2|email|acti_8f2abc",
                            type="question", title="x")
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd backend && <venv python> -m pytest tests/test_flags_crm_item.py -q -p no:cacheprovider`
Expected: FAIL (`ImportError: crm_close.flag_entity`).

- [ ] **Step 3: Implement**

`backend/crm_close/flag_entity.py`:

```python
"""`crm_item` (a Close activity) as a flag entity type (spec 2026-10-12 §3)."""
from __future__ import annotations

import re
from typing import Optional

from flags import access
from flags.errors import BadRequestError

TYPE = "crm_item"
FALLBACK = "CRM item"
KINDS = {"email": "Email", "call": "Call", "sms": "SMS", "meeting": "Meeting", "note": "Note"}
_KEY = re.compile(r"^wc:\d+$")
_ID = re.compile(r"^[A-Za-z0-9_]+$")


def parse(eid: object) -> Optional[tuple[str, str, str]]:
    parts = str(eid or "").split("|")
    if len(parts) != 3 or not _KEY.match(parts[0]) or parts[1] not in KINDS or not _ID.match(parts[2]):
        return None
    return parts[0], parts[1], parts[2]


def _item(eid: str) -> Optional[dict]:
    from crm_close import service
    p = parse(eid)
    return service.activity_detail(p[0], p[2], p[1]) if p else None


def can_raise(db, user, eid: str) -> bool:
    if parse(eid) is None:
        raise BadRequestError(f"malformed crm_item id {eid!r}")
    if _item(eid) is None:
        raise BadRequestError("that item is not one of this customer's CRM items")
    return True


def snapshot(db, eid: str) -> dict:
    try:
        it = _item(eid) or {}
        kind = KINDS.get((parse(eid) or ("", "", ""))[1], "")
        parts = [x for x in (kind, it.get("title"), it.get("lead_name")) if x]
        return {"label": " · ".join(parts) or FALLBACK, "type": kind, "title": it.get("title"),
                "at": it.get("at"), "lead": it.get("lead_name")}
    except Exception:  # noqa: BLE001 - raising a flag must never fail on a Close hiccup (spec 3.2)
        return {"label": FALLBACK}


def label(db, eid: str) -> str:
    return access.snapshot_label(db, TYPE, eid, FALLBACK)


def context(db, eid: str) -> Optional[dict]:
    if parse(eid) is None:
        return None
    return {"label": label(db, eid), "sample_id": None, "analyses": [], "lot": None,
            "deep_link": {"kind": "customer_item", "id": f"crm:{eid}"}}


def register(register_entity) -> None:
    register_entity(TYPE, label=label, deep_link=lambda eid: "/#customers",
                    can_flag=lambda user, eid: True, can_raise=can_raise, context=context, snapshot=snapshot)
```

Add the registration call as described under Files.

- [ ] **Step 4: Run to watch it pass.**
  - Run Step 2's command. Expected: PASS (4 tests).
  - Then run `<venv python> -m pytest tests/test_flags_support_ticket.py tests/test_flags_documents.py -q -p no:cacheprovider`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/crm_close/flag_entity.py backend/flags/seams.py backend/tests/test_flags_crm_item.py
git commit -m "feat(flags): crm_item entity type"
```

---

### Task 4: Detail routes admit flag participants (`via_flag`)

**Files:**
- Modify: `backend/support_plain/seat.py` (add `is_support_reader(user) -> bool`, and make `require_support_reader` use it)
- Modify: `backend/support_plain/routes.py` (`thread_detail` route; `ThreadDetail.via_flag`)
- Modify: `backend/crm_close/routes.py` (`activity_detail` route; `ActivityDetail.via_flag`)
- Test: `backend/tests/test_flags_item_routes.py`

**Interfaces:**
- Consumes: `flags.access.flag_for_user`.
- Produces:
  - `GET /support/customers/{key}/threads/{th}` and `GET /crm/customers/{key}/activities/{id}?type=` admit flag participants.
  - Both responses gain `via_flag: int | None`. It is set only when the read was admitted through a flag.

- [ ] **Step 1: Failing tests**

```python
"""Detail routes admit flag participants read-only (spec 3.3); lists and writes keep their gates."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db

TH = "th_01KNK2DP78S9Z8P62PZV6M7F8M"
DETAIL = {"thread": {"id": TH, "ref": "T-1540", "title": "Contact form", "status": "open", "priority": "normal",
                     "labels": [], "assignee": None, "created_at": None, "updated_at": None, "preview": "",
                     "waiting_since": None, "plain_url": "https://p/x"},
          "entries": [], "fetched_at": "2026-10-12T00:00:00Z", "stale": False}
ITEM = {"id": "acti_1", "type": "email", "at": None, "direction": "inbound", "who": "Kyle", "title": "Re: COA",
        "preview": "", "lead_id": "lead_1", "lead_name": "Kyle", "automated": False, "support_thread_url": None}


@pytest.fixture
def api(monkeypatch):
    import main
    from crm_close import service as crm
    from flags.models import FlagFlag
    from support_plain import seat, service as support
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    s.add(FlagFlag(entity_type="support_ticket", entity_id=f"wc:1|{TH}", kind="issue", type="question",
                   status="resolved", title="t", created_by=1, assignee_id=50))
    s.add(FlagFlag(entity_type="crm_item", entity_id="wc:1|email|acti_1", kind="issue", type="question",
                   status="open", title="t", created_by=1, assignee_id=50))
    s.commit()

    def _db():
        d = Session()
        try:
            yield d
        finally:
            d.close()

    monkeypatch.setattr(support, "thread_detail", lambda key, th, **kw: DETAIL if (key, th) == ("wc:1", TH) else None)
    monkeypatch.setattr(crm, "activity_detail", lambda key, aid, kind: ITEM if (key, aid) == ("wc:1", "acti_1") else None)
    monkeypatch.setattr(seat, "resolve", lambda email: None)  # nobody has a Plain seat in these tests
    main.app.dependency_overrides[get_db] = _db
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def _as(uid, role="standard"):
    import main
    main.app.dependency_overrides[get_current_user] = lambda: MagicMock(id=uid, role=role, email=f"u{uid}@x")


def test_assignee_without_seat_reads_the_ticket_and_sees_why(api):
    _as(50)
    r = api.get(f"/support/customers/wc:1/threads/{TH}")
    assert r.status_code == 200 and r.json()["via_flag"] == 1


def test_non_participant_without_seat_is_refused(api):
    _as(51)
    r = api.get(f"/support/customers/wc:1/threads/{TH}")
    assert r.status_code == 403 and "T-1540" not in r.text


def test_flag_access_still_scopes_to_the_customer(api):
    _as(50)
    assert api.get(f"/support/customers/wc:2/threads/{TH}").status_code in (403, 404)


def test_flag_access_does_not_open_the_list_or_writes(api):
    _as(50)
    assert api.get("/support/customers/wc:1").status_code == 403
    assert api.post(f"/support/customers/wc:1/threads/{TH}/note", json={"markdown": "x"}).status_code == 403


def test_admin_reads_without_via_flag(api):
    _as(1, role="admin")
    assert api.get(f"/support/customers/wc:1/threads/{TH}").json()["via_flag"] is None


def test_crm_participant_reads_one_item_only(api):
    _as(50)
    r = api.get("/crm/customers/wc:1/activities/acti_1?type=email")
    assert r.status_code == 200 and r.json()["via_flag"] == 2
    assert api.get("/crm/customers/wc:1").status_code == 403
    _as(51)
    assert api.get("/crm/customers/wc:1/activities/acti_1?type=email").status_code == 403
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd backend && <venv python> -m pytest tests/test_flags_item_routes.py -q -p no:cacheprovider`
Expected: the participant tests FAIL with 403, and `via_flag` is missing.

- [ ] **Step 3: Implement**

In `seat.py`, add the following and change `require_support_reader` so it raises 403 when `not is_support_reader(user)`:

```python
def is_support_reader(user) -> bool:
    if getattr(user, "role", None) == "admin":
        return True
    try:
        return resolve(getattr(user, "email", None)) is not None
    except (SupportNotConfigured, SupportUnavailable):
        return False
```

In `support_plain/routes.py`:
- Add `via_flag: Optional[int] = None` to `ThreadDetail`.
- Replace the detail route's `_u=Depends(require_support_reader)` with `user=Depends(get_current_user), db: Session = Depends(get_db)`.
- At the top of the handler:

```python
    via_flag = None
    if not seat.is_support_reader(user):
        from flags.access import flag_for_user
        via_flag = flag_for_user(db, getattr(user, "id", None), "support_ticket", f"{customer_key}|{thread_id}")
        if via_flag is None:
            raise HTTPException(status_code=403, detail="Admin access, a Plain seat, or a flag on this ticket required")
```

and return `{**out, "via_flag": via_flag}`.

In `crm_close/routes.py`:
- Add `via_flag: Optional[int] = None` to `ActivityDetail`.
- Replace `_u=Depends(require_admin)` on `activity_detail` with `user=Depends(get_current_user), db: Session = Depends(get_db)`, and add imports: `from auth import get_current_user`, `from database import get_db`, `from sqlalchemy.orm import Session`.
- At the top of the handler:

```python
    via_flag = None
    if getattr(user, "role", None) != "admin":
        from flags.access import flag_for_user
        via_flag = flag_for_user(db, getattr(user, "id", None), "crm_item", f"{customer_key}|{type}|{activity_id}")
        if via_flag is None:
            raise HTTPException(status_code=403, detail="Admin access or a flag on this item required")
```

and return `{**out, "via_flag": via_flag}`.

- [ ] **Step 4: Run to watch it pass, then the neighbouring suites**

Run each:
- `cd backend && <venv python> -m pytest tests/test_flags_item_routes.py -q -p no:cacheprovider`
- `<venv python> -m pytest tests/test_support_plain_routes.py tests/test_support_plain_actions.py tests/test_crm_close_routes.py tests/test_support_plain_seat.py -q -p no:cacheprovider`

Expected: PASS. If an existing CRM or support route test asserts an exact key set for the detail response, add `via_flag`. That is a stale-test update.

- [ ] **Step 5: Commit**

```bash
git add backend/support_plain/seat.py backend/support_plain/routes.py backend/crm_close/routes.py backend/tests/test_flags_item_routes.py
git commit -m "feat(flags): flag participants read the flagged ticket or CRM item"
```

---

### Task 5: Frontend link kind, registry and page-level opener

**Files:**
- Modify: `src/components/flags/flag-entity.ts` (meta entries, `CODE_ENTITY_TYPES`, `customer_item` deep link)
- Modify: `src/components/flags/FlagsFilterBar.tsx` (`ENTITY_TYPES`)
- Modify: `src/store/ui-store.ts` (`pendingCustomerItem`, `setPendingCustomerItem`, `consumePendingCustomerItem`)
- Modify: `src/lib/api-support.ts` (`SupportThreadDetail.via_flag?`) and `src/lib/api-crm.ts` (`CrmActivityDetail.via_flag?`)
- Create: `src/components/customers/FlaggedItemOpener.tsx`
- Modify: `src/components/CustomerStatusPage.tsx`: render `<FlaggedItemOpener customerKey={...} />` once in each customer detail view (the `wc:` view and the guest view), next to the existing tab content
- Test: `src/components/customers/FlaggedItemOpener.test.tsx`

**Interfaces:**
- Consumes: Task 2 and 3 deep links `{kind: 'customer_item', id: 'support:<eid>' | 'crm:<eid>'}`; `SupportThreadPanel`; `CrmActivityPanel`.
- Produces:
  - `setPendingCustomerItem({ kind: 'support' | 'crm', entityId: string } | null)` and `consumePendingCustomerItem()`.
  - `<FlaggedItemOpener customerKey />`.

- [ ] **Step 1: Failing test**

`src/components/customers/FlaggedItemOpener.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/store/ui-store'
import { navigateToDeepLink } from '@/components/flags/flag-entity'
import { FlaggedItemOpener } from './FlaggedItemOpener'

vi.mock('./SupportThreadPanel', () => ({
  SupportThreadPanel: ({ thread }: { thread: { id: string } | null }) => (
    <div>support panel {thread?.id}</div>
  ),
}))
vi.mock('./CrmActivityPanel', () => ({
  CrmActivityPanel: ({ item }: { item: { id: string; type: string } | null }) => (
    <div>
      crm panel {item?.id} {item?.type}
    </div>
  ),
}))

function setup(key = 'wc:1572') {
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <FlaggedItemOpener customerKey={key} />
    </QueryClientProvider>
  )
}

describe('FlaggedItemOpener', () => {
  beforeEach(() => useUIStore.setState({ pendingCustomerItem: null }))

  it('a customer_item deep link sets the pending item and navigates', () => {
    const nav = vi.spyOn(useUIStore.getState(), 'navigateToCustomerKey')
    expect(
      navigateToDeepLink({ kind: 'customer_item', id: 'support:wc:1572|th_01ABC' })
    ).toBe(true)
    expect(nav).toHaveBeenCalledWith('wc:1572')
    expect(useUIStore.getState().pendingCustomerItem).toEqual({
      kind: 'support',
      entityId: 'wc:1572|th_01ABC',
    })
  })

  it('opens a pending ticket for this customer', () => {
    useUIStore.setState({
      pendingCustomerItem: { kind: 'support', entityId: 'wc:1572|th_01ABC' },
    })
    setup()
    expect(screen.getByText('support panel th_01ABC')).toBeInTheDocument()
    expect(useUIStore.getState().pendingCustomerItem).toBeNull()
  })

  it('opens a pending CRM item for a viewer without the tab', () => {
    useUIStore.setState({
      pendingCustomerItem: { kind: 'crm', entityId: 'wc:1572|email|acti_1' },
    })
    setup()
    expect(screen.getByText('crm panel acti_1 email')).toBeInTheDocument()
  })

  it("ignores a pending item for another customer", () => {
    useUIStore.setState({
      pendingCustomerItem: { kind: 'support', entityId: 'wc:9|th_01ABC' },
    })
    setup()
    expect(screen.queryByText(/support panel/)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to watch it fail**

Run: `npx vitest run src/components/customers/FlaggedItemOpener.test.tsx`
Expected: FAIL (unresolved `./FlaggedItemOpener`).

- [ ] **Step 3: Implement**

`ui-store.ts`:
- Add to the state type `pendingCustomerItem: { kind: 'support' | 'crm'; entityId: string } | null`, with initial value `null`.
- Add the actions, mirroring `setPendingBoardNode` and `consumePendingBoardNode`:

```ts
      setPendingCustomerItem: item =>
        set({ pendingCustomerItem: item }, undefined, 'setPendingCustomerItem'),
      consumePendingCustomerItem: () => {
        const item = get().pendingCustomerItem
        if (item != null)
          set({ pendingCustomerItem: null }, undefined, 'consumePendingCustomerItem')
        return item
      },
```

`flag-entity.ts`:
- Import `LifeBuoy` and `Contact` from lucide-react.
- Add to `ENTITY_META`:

```ts
  support_ticket: { Icon: LifeBuoy, label: 'Support ticket', canDeepLink: false },
  crm_item: { Icon: Contact, label: 'CRM item', canDeepLink: false },
```

- Add `'support_ticket'` and `'crm_item'` to `CODE_ENTITY_TYPES`.
- In `navigateToDeepLink`, add before `default:`:

```ts
    case 'customer_item': {
      const sep = deepLink.id.indexOf(':')
      const kind = deepLink.id.slice(0, sep)
      const entityId = deepLink.id.slice(sep + 1)
      const key = entityId.split('|')[0]
      if ((kind !== 'support' && kind !== 'crm') || !key) return false
      store.closeFlagsFlyout()
      store.setPendingCustomerItem({ kind, entityId })
      store.navigateToCustomerKey(key)
      return true
    }
```

If the `DeepLink` kind union in `flags-api.ts` is a literal union, add `'customer_item'` to it.

`FlagsFilterBar.tsx`: `const ENTITY_TYPES = ['sample', 'sub_sample', 'worksheet', 'document', 'support_ticket', 'crm_item']`.

`api-support.ts`: add `via_flag?: number | null` to `SupportThreadDetail`. `api-crm.ts`: add `via_flag?: number | null` to `CrmActivityDetail`.

`src/components/customers/FlaggedItemOpener.tsx`:

```tsx
import { useState } from 'react'
import type { CrmItem, CrmItemType } from '@/lib/api-crm'
import type { SupportThread } from '@/lib/api-support'
import { useUIStore } from '@/store/ui-store'
import { CrmActivityPanel } from './CrmActivityPanel'
import { SupportThreadPanel } from './SupportThreadPanel'

type Opened =
  | { kind: 'support'; thread: SupportThread }
  | { kind: 'crm'; item: CrmItem }

function fromPending(customerKey: string): Opened | null {
  const pending = useUIStore.getState().pendingCustomerItem
  if (!pending || pending.entityId.split('|')[0] !== customerKey) return null
  useUIStore.getState().consumePendingCustomerItem()
  const parts = pending.entityId.split('|')
  if (pending.kind === 'support' && parts[1]) {
    return {
      kind: 'support',
      thread: {
        id: parts[1], ref: '', title: '', status: 'open', priority: 'normal', labels: [],
        assignee: null, created_at: null, updated_at: null, preview: '', waiting_since: null, plain_url: '',
      },
    }
  }
  if (pending.kind === 'crm' && parts[1] && parts[2]) {
    return {
      kind: 'crm',
      item: {
        id: parts[2], type: parts[1] as CrmItemType, at: null, direction: null, who: '', title: '',
        preview: '', lead_id: null, lead_name: '', automated: false, support_thread_url: null,
      },
    }
  }
  return null
}

/** Opens the ticket or CRM item a flag link points at, whether or not the viewer can see its tab (spec 4). */
export function FlaggedItemOpener({ customerKey }: { customerKey: string }) {
  const [opened, setOpened] = useState<Opened | null>(() => fromPending(customerKey))
  if (!opened) return null
  return opened.kind === 'support' ? (
    <SupportThreadPanel customerKey={customerKey} thread={opened.thread} onClose={() => setOpened(null)} />
  ) : (
    <CrmActivityPanel customerKey={customerKey} item={opened.item} onClose={() => setOpened(null)} />
  )
}
```

`CustomerStatusPage.tsx`: in the `wc:` detail component, render `<FlaggedItemOpener customerKey={`wc:${customerDetailTargetId}`} />` right after `</Tabs>`. In the guest view, render `<FlaggedItemOpener customerKey={customerKey} />` after `<CustomerDashboard …/>`. Change only those lines.

- [ ] **Step 4: Run to watch it pass**

Run: `npx vitest run src/components/customers/FlaggedItemOpener.test.tsx src/components/flags/`, then `npx tsc --noEmit -p /c/tmp/mk1-flags-items/tsconfig.json`.
Expected: PASS and `tsc` clean. Load-timing flakes in unrelated flag files pass when run alone.

- [ ] **Step 5: Commit**

```bash
git add src/components/flags/flag-entity.ts src/components/flags/FlagsFilterBar.tsx src/store/ui-store.ts src/lib/api-support.ts src/lib/api-crm.ts src/components/customers/FlaggedItemOpener.tsx src/components/customers/FlaggedItemOpener.test.tsx src/components/CustomerStatusPage.tsx
git commit -m "feat(flags): customer_item links open the flagged ticket or CRM item"
```

---

### Task 6: Flag buttons, read-only line and list markers

**Files:**
- Modify: `src/components/customers/SupportThreadPanel.tsx` (header `EntityFlagButton`; `via_flag` line)
- Modify: `src/components/customers/CrmActivityPanel.tsx` (header `EntityFlagButton`; `via_flag` line)
- Create: `src/components/customers/useItemFlagCounts.ts`
- Modify: `src/components/customers/CustomerSupportTab.tsx` and `CustomerCrmTab.tsx` (row markers)
- Test: `src/components/customers/ItemFlags.test.tsx`

**Interfaces:**
- Consumes: `EntityFlagButton` (`entityType`, `entityId`, `size`); `useFlagsList(tab, params)` from `@/hooks/use-flags`; the `via_flag` field from Task 4.
- Produces: `useItemFlagCounts(entityType: 'support_ticket' | 'crm_item', customerKey: string): Map<string, number>`, keyed by the part of the entity id after `{customerKey}|`.

- [ ] **Step 1: Failing test**

`src/components/customers/ItemFlags.test.tsx`:

```tsx
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useItemFlagCounts } from './useItemFlagCounts'

vi.mock('@/hooks/use-flags', () => ({
  useFlagsList: () => ({
    data: [
      { id: 1, entity_type: 'support_ticket', entity_id: 'wc:1|th_A', status: 'open' },
      { id: 2, entity_type: 'support_ticket', entity_id: 'wc:1|th_A', status: 'blocked' },
      { id: 3, entity_type: 'support_ticket', entity_id: 'wc:1|th_B', status: 'open' },
      { id: 4, entity_type: 'support_ticket', entity_id: 'wc:12|th_C', status: 'open' },
    ],
  }),
}))

describe('useItemFlagCounts', () => {
  it('counts open flags per item for this customer only', () => {
    const { result } = renderHook(() => useItemFlagCounts('support_ticket', 'wc:1'))
    expect(Object.fromEntries(result.current)).toEqual({ th_A: 2, th_B: 1 })
  })
})
```

Also append to `src/components/customers/SupportThreadPanel.test.tsx`:

```tsx
  it('has a Flag button and explains flag access', async () => {
    vi.mocked(support.getSupportThread).mockResolvedValue({ ...detail, via_flag: 42 })
    setup(false)
    expect(await screen.findByText(/because you're on flag #42/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /raise a flag on this item/i })).toBeInTheDocument()
  })
```

If that test file does not already mock `@/hooks/use-flags`, add `vi.mock('@/hooks/use-flags', async orig => ({ ...((await orig()) as object), useEntityFlags: () => ({ data: [] }) }))` at the top of the file. Do the same for `@/components/flags/flag-users` (`useFlagUsers: () => new Map(), nameForUser: () => 'User'`) if raising the compose needs it.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run src/components/customers/ItemFlags.test.tsx src/components/customers/SupportThreadPanel.test.tsx`
Expected: FAIL (no hook, no Flag button, no via-flag line).

- [ ] **Step 3: Implement**

`src/components/customers/useItemFlagCounts.ts`:

```ts
import { useFlagsList } from '@/hooks/use-flags'

/** Open flags of one item type for one customer, counted per item (one request per tab, spec 5.2). */
export function useItemFlagCounts(
  entityType: 'support_ticket' | 'crm_item',
  customerKey: string
): Map<string, number> {
  const q = useFlagsList('all_open', { entity_type: entityType })
  const prefix = `${customerKey}|`
  const counts = new Map<string, number>()
  for (const f of q.data ?? []) {
    if (!f.entity_id?.startsWith(prefix)) continue
    const rest = f.entity_id.slice(prefix.length)
    counts.set(rest, (counts.get(rest) ?? 0) + 1)
  }
  return counts
}
```

`SupportThreadPanel.tsx`:
- Inside `SheetDescription`, after the "Open in Plain" link, add:

```tsx
            {current && (
              <EntityFlagButton
                entityType="support_ticket"
                entityId={`${customerKey}|${current.id}`}
              />
            )}
```

- Immediately above the timeline (inside the scroller, before the order toggle), add:

```tsx
              {d?.via_flag != null && (
                <p className="mb-2 rounded-md border border-[var(--pv-border)] bg-[var(--pv-surface)] px-3 py-2 text-xs text-[var(--pv-ink-2)]">
                  You're seeing this ticket because you're on flag #{d.via_flag}.
                </p>
              )}
```

- Import `EntityFlagButton` from `@/components/flags/EntityFlagButton`.

`CrmActivityPanel.tsx`:
- After `<SheetDescription>…</SheetDescription>`, add:

```tsx
          {item && (
            <EntityFlagButton
              entityType="crm_item"
              entityId={`${customerKey}|${item.type}|${item.id}`}
            />
          )}
```

- Before `{d && (`, add:

```tsx
        {d?.via_flag != null && (
          <p className="mx-4 mt-2 rounded-md border px-3 py-2 text-xs text-muted-foreground">
            You're seeing this item because you're on flag #{d.via_flag}.
          </p>
        )}
```

`CustomerSupportTab.tsx`: call `const flagCounts = useItemFlagCounts('support_ticket', customerKey)`. In each row's first `<span className="flex flex-wrap items-center gap-2">`, after the title span, add:

```tsx
              {(flagCounts.get(t.id) ?? 0) > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 text-xs text-red-500"
                  aria-label={`${flagCounts.get(t.id)} open flag${flagCounts.get(t.id) === 1 ? '' : 's'}`}
                >
                  <Flag className="h-3 w-3" fill="currentColor" />
                  {(flagCounts.get(t.id) ?? 0) > 1 ? flagCounts.get(t.id) : null}
                </span>
              )}
```

`CustomerCrmTab.tsx`: call `const flagCounts = useItemFlagCounts('crm_item', customerKey)`. In each row, after the type `Icon`, add the same marker keyed by `` `${it.type}|${it.id}` ``.

Import `Flag` from lucide-react where missing. Edit only these lines in both tab files, and do not run Prettier over unrelated code.

- [ ] **Step 4: Run to watch them pass, then the neighbours**

Run:
- `npx vitest run src/components/customers/ src/components/flags/`
- `npx tsc --noEmit -p /c/tmp/mk1-flags-items/tsconfig.json`
- `npx eslint` on the changed files

Expected: PASS and clean. Load-timing flakes in other flag test files pass alone. If `CustomerSupportTab.test.tsx` or `CustomerCrmTab` tests now call the unmocked `useFlagsList`, add `vi.mock('@/hooks/use-flags', async orig => ({ ...((await orig()) as object), useFlagsList: () => ({ data: [] }), useEntityFlags: () => ({ data: [] }) }))`. That is a stale-test update.

- [ ] **Step 5: Commit**

```bash
git add src/components/customers/useItemFlagCounts.ts src/components/customers/ItemFlags.test.tsx src/components/customers/SupportThreadPanel.tsx src/components/customers/SupportThreadPanel.test.tsx src/components/customers/CrmActivityPanel.tsx src/components/customers/CustomerSupportTab.tsx src/components/customers/CustomerCrmTab.tsx
git commit -m "feat(flags): Flag buttons on tickets and CRM items, list markers, flag-access line"
```

---

## After the tasks (not code)

1. Ship one release: frontend and backend, no env change.
2. Smoke test on prod (spec section 8):
   - raise a flag on a test ticket assigned to a non-seat user
   - open the flag's link as that user and read the ticket
   - confirm they can't reply
   - resolve the flag and confirm they can still read it
