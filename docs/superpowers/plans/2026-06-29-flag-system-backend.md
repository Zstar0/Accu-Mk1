# Flag System — Backend Module Implementation Plan (Phase 1, Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Accu-Mk1 backend `flags` module — schema, host seams, service layer with audit, host-resolved permissions, and the REST API — producing a pytest-tested backend for raising/assigning/commenting/resolving flags on work-product entities.

**Architecture:** A self-contained `backend/flags/` package (models, catalog, seams, permissions, service, schemas, routes) that anchors flags to entities by an opaque `(entity_type, entity_id)` pair with **no FKs to host domain tables**. It talks to the host through three thin seams — entity registry, user provider, event sink — so the bones are reusable. Real-time (SSE) and the frontend are separate plans (2 and 3); the event sink is built here as the attachment point for Plan 2.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0 (typed `Mapped`/`mapped_column`), Pydantic v2, pytest (in-memory SQLite + `TestClient`). No Alembic — tables created via `init_db()` raw idempotent DDL + `Base.metadata.create_all` backstop.

## Global Constraints

- **Bare imports only** — backend runs with CWD=`backend/`. Use `from database import ...`, `from flags.service import ...` — never `from backend....`.
- **Table prefix `flag_`** (neutral, NOT `lims_`) — tables: `flag_flags`, `flag_comments`, `flag_participants`, `flag_events`.
- **No FK to host domain tables.** Entity anchor is opaque `entity_type TEXT` + `entity_id TEXT`. User references are `INTEGER` with **no FK constraint** to `users` (the module must not couple to the host's user table; the user-provider seam resolves display).
- **Internal-only.** Flags never surface to customers. `flag_comments.audience` defaults `'internal'` (the future customer seam — do not implement customer routing here).
- **Model fields:** `kind ∈ {issue, signal}`, `type ∈ {blocker, critical, question, waiting_on_customer, ready_for_verification}` (extensible), `status ∈ {open, in_progress, resolved, closed}`.
- **Audit in the service layer**, same transaction as the mutation — every state-changing service call writes exactly one `flag_events` row.
- **JSONB columns** use `JSONB().with_variant(JSON(), "sqlite")` (tests run on SQLite).
- **Permissions are host-resolved** — the module calls `permissions.can(user, action, flag)`; never hard-code role logic in routes/service beyond calling the resolver.
- **SQLAlchemy 2.0 typed style**, mirroring `backend/models.py` (`Mapped[...] = mapped_column(...)`).
- Run tests from `backend/`: `cd backend && pytest tests/test_flags_*.py -v`. On the stack: `docker compose -p accumark-flags exec accu-mk1-backend sh -c "cd /app && pytest tests/test_flags_*.py -v"`.

---

## File Structure

**Create:**
- `backend/flags/__init__.py` — package marker (docstring only).
- `backend/flags/models.py` — `FlagFlag`, `FlagComment`, `FlagParticipant`, `FlagEvent` ORM models.
- `backend/flags/catalog.py` — type→kind/color catalog + status lifecycle helpers (pure, no DB).
- `backend/flags/seams.py` — entity registry, user provider, event sink (interfaces + in-process defaults) and Mk1 entity-type registrations.
- `backend/flags/permissions.py` — `can(user, action, flag)` resolver (Mk1 role rules).
- `backend/flags/errors.py` — typed exceptions (`NotFoundError`, `BadRequestError`, `PermissionDeniedError`, `ConflictError`).
- `backend/flags/service.py` — all DB writes + audit + event emission.
- `backend/flags/schemas.py` — Pydantic request/response models.
- `backend/flags/routes.py` — FastAPI router (`/api/flags`).
- `backend/tests/test_flags_catalog.py`, `test_flags_seams.py`, `test_flags_permissions.py`, `test_flags_service.py`, `test_flags_routes.py`.

**Modify:**
- `backend/database.py` — add `import flags.models` in `init_db()`; append `CREATE TABLE IF NOT EXISTS` + index DDL to the `migrations` list (before the per-statement loop ~line 751).
- `backend/main.py` — import + `app.include_router(flags_router)`.

**Responsibility split:** `catalog.py`/`permissions.py`/`seams.py` are pure/host-facing and independently testable; `service.py` is the only writer; `routes.py` is a thin HTTP shell; `models.py` holds schema. This mirrors `backend/lims_analyses/`.

---

### Task 1: Schema — models + DDL + startup registration

**Files:**
- Create: `backend/flags/__init__.py`, `backend/flags/models.py`
- Modify: `backend/database.py` (init_db import + migrations DDL)
- Test: `backend/tests/test_flags_models.py`

**Interfaces:**
- Produces: ORM classes `FlagFlag`, `FlagComment`, `FlagParticipant`, `FlagEvent` (importable `from flags.models import ...`). Columns as in the code below — later tasks rely on these exact names.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_flags_models.py`:
```python
"""Schema round-trip tests for the flags module (SQLite)."""
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def session():
    from database import Base
    import flags.models  # noqa: F401  (register tables on Base)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_flag_roundtrip_with_children(session):
    from flags.models import FlagFlag, FlagComment, FlagParticipant, FlagEvent

    flag = FlagFlag(
        entity_type="sub_sample", entity_id="123",
        kind="issue", type="blocker", status="open",
        title="Crashed out", created_by=42,
    )
    session.add(flag)
    session.flush()

    session.add(FlagComment(flag_id=flag.id, author_id=42, body="cloudy", audience="internal"))
    session.add(FlagParticipant(flag_id=flag.id, user_id=7, role="watcher", added_by=42))
    session.add(FlagEvent(flag_id=flag.id, actor_id=42, event_type="raised",
                          from_value=None, to_value="open", details={"type": "blocker"}))
    session.commit()

    got = session.get(FlagFlag, flag.id)
    assert got.status == "open"
    assert got.audience_default == "internal" or True  # placeholder-free: flag has no audience
    assert len(session.query(FlagComment).all()) == 1
    assert session.query(FlagEvent).first().details == {"type": "blocker"}
    assert session.query(FlagParticipant).first().role == "watcher"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/test_flags_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'flags'`.

- [ ] **Step 3: Create the package + models**

`backend/flags/__init__.py`:
```python
"""Flag System — lab-anchored task/thread module. See docs/superpowers/specs/2026-06-27-flag-system-design.md."""
```

`backend/flags/models.py`:
```python
"""SQLAlchemy models for the flags module.

Anchors to host entities by opaque (entity_type, entity_id) — NO FK to host
tables. User references are INTEGER with no FK (the user-provider seam resolves
display). Tables use the neutral `flag_` prefix.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Integer, Text, DateTime, ForeignKey, JSON, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class FlagFlag(Base):
    """A flag = a task/thread anchored to one work-product entity."""
    __tablename__ = "flag_flags"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    entity_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)          # 'issue' | 'signal'
    type: Mapped[str] = mapped_column(Text, nullable=False)          # 'blocker' | ...
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open",
                                        server_default="open", index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[int] = mapped_column(Integer, nullable=False)
    assignee_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    comments: Mapped[list["FlagComment"]] = relationship(
        "FlagComment", back_populates="flag", cascade="all, delete-orphan",
        order_by="FlagComment.created_at",
    )
    participants: Mapped[list["FlagParticipant"]] = relationship(
        "FlagParticipant", back_populates="flag", cascade="all, delete-orphan",
    )
    events: Mapped[list["FlagEvent"]] = relationship(
        "FlagEvent", back_populates="flag", cascade="all, delete-orphan",
        order_by="FlagEvent.created_at",
    )


class FlagComment(Base):
    __tablename__ = "flag_comments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    author_id: Mapped[int] = mapped_column(Integer, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    audience: Mapped[str] = mapped_column(Text, nullable=False, default="internal",
                                          server_default="internal")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    edited_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    flag: Mapped["FlagFlag"] = relationship("FlagFlag", back_populates="comments")


class FlagParticipant(Base):
    __tablename__ = "flag_participants"
    __table_args__ = (UniqueConstraint("flag_id", "user_id", name="uq_flag_participant"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, default="watcher",
                                      server_default="watcher")
    added_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    added_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    flag: Mapped["FlagFlag"] = relationship("FlagFlag", back_populates="participants")


class FlagEvent(Base):
    """Append-only audit log. One row per state-changing action."""
    __tablename__ = "flag_events"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    actor_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    from_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    to_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    details: Mapped[Optional[dict]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    flag: Mapped["FlagFlag"] = relationship("FlagFlag", back_populates="events")
```

Then fix the test's placeholder line: replace `assert got.audience_default == "internal" or True  # ...` with `assert got.title == "Crashed out"`.

- [ ] **Step 4: Register models + DDL in `database.py`**

In `backend/database.py` `init_db()`, add the flags import next to `import models`:
```python
def init_db():
    """Initialize database tables."""
    import models  # noqa: F401
    import flags.models  # noqa: F401  (register flag_* tables on Base)
    _run_migrations()
    Base.metadata.create_all(bind=engine)
    _seed_federal_holidays_window()
```
In `_run_migrations()`, append these strings to the `migrations` list (just before the closing `]` at ~line 751):
```python
        # --- flags module ---
        """
        CREATE TABLE IF NOT EXISTS flag_flags (
            id           SERIAL PRIMARY KEY,
            entity_type  TEXT NOT NULL,
            entity_id    TEXT NOT NULL,
            kind         TEXT NOT NULL,
            type         TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'open'
                         CONSTRAINT flag_flags_status_check
                         CHECK (status IN ('open','in_progress','resolved','closed')),
            title        TEXT NOT NULL,
            created_by   INTEGER NOT NULL,
            assignee_id  INTEGER,
            created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMP NOT NULL DEFAULT NOW(),
            resolved_at  TIMESTAMP,
            resolved_by  INTEGER
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_flags_entity   ON flag_flags (entity_type, entity_id)",
        "CREATE INDEX IF NOT EXISTS ix_flag_flags_assignee ON flag_flags (assignee_id)",
        "CREATE INDEX IF NOT EXISTS ix_flag_flags_status   ON flag_flags (status, updated_at)",
        """
        CREATE TABLE IF NOT EXISTS flag_comments (
            id         SERIAL PRIMARY KEY,
            flag_id    INTEGER NOT NULL REFERENCES flag_flags(id) ON DELETE CASCADE,
            author_id  INTEGER NOT NULL,
            body       TEXT NOT NULL,
            audience   TEXT NOT NULL DEFAULT 'internal',
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            edited_at  TIMESTAMP
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_comments_flag ON flag_comments (flag_id)",
        """
        CREATE TABLE IF NOT EXISTS flag_participants (
            id        SERIAL PRIMARY KEY,
            flag_id   INTEGER NOT NULL REFERENCES flag_flags(id) ON DELETE CASCADE,
            user_id   INTEGER NOT NULL,
            role      TEXT NOT NULL DEFAULT 'watcher',
            added_at  TIMESTAMP NOT NULL DEFAULT NOW(),
            added_by  INTEGER,
            CONSTRAINT uq_flag_participant UNIQUE (flag_id, user_id)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_participants_flag ON flag_participants (flag_id)",
        "CREATE INDEX IF NOT EXISTS ix_flag_participants_user ON flag_participants (user_id)",
        """
        CREATE TABLE IF NOT EXISTS flag_events (
            id          SERIAL PRIMARY KEY,
            flag_id     INTEGER NOT NULL REFERENCES flag_flags(id) ON DELETE CASCADE,
            actor_id    INTEGER,
            event_type  TEXT NOT NULL,
            from_value  TEXT,
            to_value    TEXT,
            details     JSONB,
            created_at  TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_events_flag ON flag_events (flag_id)",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && pytest tests/test_flags_models.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/flags/__init__.py backend/flags/models.py backend/database.py backend/tests/test_flags_models.py
git commit -m "feat(flags): schema — flag_flags/comments/participants/events + idempotent DDL"
```

---

### Task 2: Type catalog + status lifecycle (pure)

**Files:**
- Create: `backend/flags/catalog.py`
- Test: `backend/tests/test_flags_catalog.py`

**Interfaces:**
- Produces: `FLAG_TYPES: dict[str, dict]`; `kind_for_type(type) -> str`; `is_valid_type(type) -> bool`; `STATUSES: list[str]`; `LEGAL_TRANSITIONS: dict[str, set[str]]`; `is_legal_transition(frm, to) -> bool`. Service (Task 6) uses these.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_flags_catalog.py`:
```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_kind_mapping_and_validity():
    from flags.catalog import kind_for_type, is_valid_type
    assert kind_for_type("blocker") == "issue"
    assert kind_for_type("ready_for_verification") == "signal"
    assert is_valid_type("question") is True
    assert is_valid_type("nope") is False


def test_legal_transitions():
    from flags.catalog import is_legal_transition
    assert is_legal_transition("open", "in_progress") is True
    assert is_legal_transition("in_progress", "resolved") is True
    assert is_legal_transition("resolved", "closed") is True
    assert is_legal_transition("closed", "open") is True       # reopen
    assert is_legal_transition("open", "closed") is False      # must pass through resolve? no — allow
    assert is_legal_transition("resolved", "open") is True     # reopen from resolved
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && pytest tests/test_flags_catalog.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'flags.catalog'`.

- [ ] **Step 3: Implement**

`backend/flags/catalog.py`:
```python
"""Pure type/status catalog for flags. No DB, no host coupling.

Type definitions are data here (a config map). Promote to a DB table only if
the lab needs to self-manage types (deferred).
"""
from __future__ import annotations

# type -> definition. `kind` groups behavior; `color` is the UI accent;
# `blocking` marks types that should weight triage; `signal` types are positive.
FLAG_TYPES: dict[str, dict] = {
    "blocker":               {"kind": "issue",  "label": "Blocker",              "color": "#e5484d", "blocking": True},
    "critical":              {"kind": "issue",  "label": "Critical",             "color": "#e8730a", "blocking": True},
    "question":              {"kind": "issue",  "label": "Question",             "color": "#3b82f6", "blocking": False},
    "waiting_on_customer":   {"kind": "issue",  "label": "Waiting on Customer",  "color": "#8b5cf6", "blocking": False},
    "ready_for_verification":{"kind": "signal", "label": "Ready for Verification","color": "#22c55e", "blocking": False},
}

STATUSES = ["open", "in_progress", "resolved", "closed"]

# Lifecycle. Forward flow plus reopen from resolved/closed. open->closed and
# open->resolved are allowed (a flag can be resolved/closed directly).
LEGAL_TRANSITIONS: dict[str, set[str]] = {
    "open":        {"in_progress", "resolved", "closed"},
    "in_progress": {"resolved", "closed", "open"},
    "resolved":    {"closed", "open", "in_progress"},
    "closed":      {"open", "in_progress"},
}


def is_valid_type(type_: str) -> bool:
    return type_ in FLAG_TYPES


def kind_for_type(type_: str) -> str:
    try:
        return FLAG_TYPES[type_]["kind"]
    except KeyError:
        raise ValueError(f"unknown flag type {type_!r}")


def is_legal_transition(frm: str, to: str) -> bool:
    if to not in STATUSES:
        return False
    return to in LEGAL_TRANSITIONS.get(frm, set())
```

Fix the test's `open->closed` assertion to match (`open->closed` is legal): change that line to `assert is_legal_transition("open", "closed") is True`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && pytest tests/test_flags_catalog.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/flags/catalog.py backend/tests/test_flags_catalog.py
git commit -m "feat(flags): type catalog + status lifecycle helpers"
```

---

### Task 3: Host seams — entity registry, user provider, event sink

**Files:**
- Create: `backend/flags/seams.py`
- Test: `backend/tests/test_flags_seams.py`

**Interfaces:**
- Produces:
  - `register_entity(entity_type: str, *, label: Callable[[Session, str], str], deep_link: Callable[[str], str], can_flag: Callable[[object, str], bool]) -> None`
  - `get_entity_spec(entity_type: str) -> EntitySpec` (raises `KeyError` if unknown); `is_registered(entity_type) -> bool`
  - `resolve_user(db, user_id: int) -> dict` → `{"id": int, "display": str, "avatar": str|None}` (host provider; default queries `models.User`)
  - `EVENT_SINK` — an object with `.emit(event: dict) -> None`; `set_event_sink(sink)`; default `InMemoryEventSink` exposing `.events: list`. Plan 2 swaps in the SSE sink.
  - `register_mk1_entities()` — registers `sample`, `sub_sample`, `worksheet`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_flags_seams.py`:
```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import pytest


def test_register_and_resolve_entity():
    from flags import seams
    seams.register_entity("widget",
                           label=lambda db, eid: f"Widget {eid}",
                           deep_link=lambda eid: f"/widgets/{eid}",
                           can_flag=lambda user, eid: True)
    assert seams.is_registered("widget")
    spec = seams.get_entity_spec("widget")
    assert spec.label(None, "9") == "Widget 9"
    assert spec.deep_link("9") == "/widgets/9"
    assert spec.can_flag(object(), "9") is True
    with pytest.raises(KeyError):
        seams.get_entity_spec("nonexistent-type")


def test_in_memory_event_sink_captures():
    from flags import seams
    sink = seams.InMemoryEventSink()
    seams.set_event_sink(sink)
    seams.EVENT_SINK.emit({"event_type": "raised", "flag_id": 1})
    assert sink.events == [{"event_type": "raised", "flag_id": 1}]
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && pytest tests/test_flags_seams.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'flags.seams'`.

- [ ] **Step 3: Implement**

`backend/flags/seams.py`:
```python
"""Host seams for the flags module.

The module never imports host domain models directly for entity resolution —
the host registers entity types and supplies a user provider + event sink.
Defaults wire Mk1, but the core depends only on these callables.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from sqlalchemy.orm import Session


@dataclass
class EntitySpec:
    entity_type: str
    label: Callable[[Optional[Session], str], str]
    deep_link: Callable[[str], str]
    can_flag: Callable[[object, str], bool]


_REGISTRY: dict[str, EntitySpec] = {}


def register_entity(entity_type: str, *, label, deep_link, can_flag) -> None:
    _REGISTRY[entity_type] = EntitySpec(entity_type, label, deep_link, can_flag)


def is_registered(entity_type: str) -> bool:
    return entity_type in _REGISTRY


def get_entity_spec(entity_type: str) -> EntitySpec:
    return _REGISTRY[entity_type]  # raises KeyError if unknown


# --- user provider -------------------------------------------------------
def resolve_user(db: Session, user_id: int) -> dict:
    """Default Mk1 provider: id -> {id, display, avatar}. Host-swappable."""
    from models import User
    u = db.get(User, user_id)
    if u is None:
        return {"id": user_id, "display": f"User {user_id}", "avatar": None}
    name = " ".join(x for x in [getattr(u, "first_name", None), getattr(u, "last_name", None)] if x)
    return {"id": u.id, "display": name or u.email, "avatar": None}


# --- event sink ----------------------------------------------------------
class InMemoryEventSink:
    """Default no-network sink. Plan 2 replaces with an SSE-backed sink."""
    def __init__(self) -> None:
        self.events: list[dict] = []

    def emit(self, event: dict) -> None:
        self.events.append(event)


EVENT_SINK: InMemoryEventSink = InMemoryEventSink()


def set_event_sink(sink) -> None:
    global EVENT_SINK
    EVENT_SINK = sink


# --- Mk1 registrations ---------------------------------------------------
def register_mk1_entities() -> None:
    """Register the Phase-1 flaggable entity types. Called at startup."""
    def _sample_label(db, eid):
        from models import LimsSample
        row = db.get(LimsSample, int(eid)) if str(eid).isdigit() else None
        return getattr(row, "sample_id", None) or f"Sample {eid}"

    def _sub_sample_label(db, eid):
        from models import LimsSubSample
        row = db.get(LimsSubSample, int(eid)) if str(eid).isdigit() else None
        return getattr(row, "sample_id", None) or f"Vial {eid}"

    register_entity("sample",
                    label=_sample_label,
                    deep_link=lambda eid: f"/#senaite/sample-details?id={eid}",
                    can_flag=lambda user, eid: True)
    register_entity("sub_sample",
                    label=_sub_sample_label,
                    deep_link=lambda eid: f"/#vials/{eid}",
                    can_flag=lambda user, eid: True)
    register_entity("worksheet",
                    label=lambda db, eid: f"Worksheet {eid}",
                    deep_link=lambda eid: f"/#worksheets/{eid}",
                    can_flag=lambda user, eid: True)
```

> Note: the deep-link paths above are placeholders for the frontend routes — Plan 3 will confirm the exact Mk1 hash routes and adjust `deep_link` here. They are non-load-bearing for the backend (stored/returned as strings only).

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && pytest tests/test_flags_seams.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/flags/seams.py backend/tests/test_flags_seams.py
git commit -m "feat(flags): host seams — entity registry, user provider, event sink"
```

---

### Task 4: Permissions resolver

**Files:**
- Create: `backend/flags/permissions.py`
- Test: `backend/tests/test_flags_permissions.py`

**Interfaces:**
- Produces: `can(user, action: str, flag) -> bool`. `action ∈ {create, comment, watch, assign, change_type, change_status, resolve, close, reopen}`. For `create`, `flag` may be `None`. `user` is a `models.User`-like object with `.id` and `.role`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_flags_permissions.py`:
```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace


def _user(id, role="standard"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def _flag(created_by, assignee_id=None):
    return SimpleNamespace(created_by=created_by, assignee_id=assignee_id)


def test_open_actions_any_user():
    from flags.permissions import can
    u = _user(5)
    for action in ("create", "comment", "watch", "assign"):
        assert can(u, action, _flag(created_by=99)) is True


def test_lifecycle_requires_assignee_raiser_or_admin():
    from flags.permissions import can
    raiser, assignee, other, admin = _user(1), _user(2), _user(3), _user(4, "admin")
    f = _flag(created_by=1, assignee_id=2)
    for action in ("resolve", "close", "reopen", "change_status", "change_type"):
        assert can(raiser, action, f) is True
        assert can(assignee, action, f) is True
        assert can(admin, action, f) is True
        assert can(other, action, f) is False
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && pytest tests/test_flags_permissions.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`backend/flags/permissions.py`:
```python
"""Host-resolved permissions for flags (Mk1 role rules).

v1 rules:
  - create / comment / watch / assign  -> any active user
  - change_type / change_status / resolve / close / reopen
        -> the flag's assignee, its raiser (created_by), or an admin
Internal-only is enforced by the host's auth (all users are staff). User-group
permissions are a future swap of THIS function only (see spec §8).
"""
from __future__ import annotations

_OPEN_ACTIONS = {"create", "comment", "watch", "assign"}
_LIFECYCLE_ACTIONS = {"change_type", "change_status", "resolve", "close", "reopen"}


def can(user, action: str, flag=None) -> bool:
    if action in _OPEN_ACTIONS:
        return user is not None
    if action in _LIFECYCLE_ACTIONS:
        if getattr(user, "role", None) == "admin":
            return True
        if flag is None:
            return False
        uid = getattr(user, "id", None)
        return uid is not None and uid in (
            getattr(flag, "created_by", None), getattr(flag, "assignee_id", None))
    return False
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && pytest tests/test_flags_permissions.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/flags/permissions.py backend/tests/test_flags_permissions.py
git commit -m "feat(flags): host-resolved permissions resolver (roles v1)"
```

---

### Task 5: Errors + service — create / get / list / summary

**Files:**
- Create: `backend/flags/errors.py`, `backend/flags/service.py`
- Test: `backend/tests/test_flags_service.py`

**Interfaces:**
- Produces (`flags.errors`): `NotFoundError(LookupError)`, `BadRequestError(ValueError)`, `PermissionDeniedError(Exception)`, `ConflictError(Exception)`.
- Produces (`flags.service`):
  - `create_flag(db, *, user, entity_type, entity_id, type, title, assignee_id=None, first_comment=None) -> FlagFlag`
  - `get_flag(db, flag_id) -> FlagFlag` (raises NotFoundError)
  - `list_flags(db, *, user_id, tab, status=None, entity_type=None, entity_id=None) -> list[FlagFlag]` — `tab ∈ {assigned, raised, watching, all_open}`
  - `summary(db, *, user_id) -> dict` → `{"assigned_to_me": int, "by_type": {type: count}}` over open+in_progress flags.
- Consumes: `flags.models`, `flags.catalog`, `flags.seams`, `flags.permissions`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_flags_service.py`:
```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import flags.models  # noqa: F401
    from flags import seams
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample",
                           label=lambda d, e: f"Vial {e}",
                           deep_link=lambda e: f"/v/{e}",
                           can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _user(id=1, role="standard"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def test_create_flag_writes_event_and_emits(db):
    from flags import service, seams
    from flags.models import FlagEvent
    f = service.create_flag(db, user=_user(7), entity_type="sub_sample", entity_id="123",
                            type="blocker", title="Crashed out", first_comment="cloudy")
    assert f.id and f.status == "open" and f.kind == "issue" and f.created_by == 7
    evs = db.query(FlagEvent).filter_by(flag_id=f.id).all()
    assert any(e.event_type == "raised" for e in evs)
    assert seams.EVENT_SINK.events[0]["event_type"] == "raised"
    assert len(f.comments) == 1 and f.comments[0].body == "cloudy"


def test_create_flag_unknown_entity_type_rejected(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=_user(), entity_type="nope", entity_id="1",
                            type="blocker", title="x")


def test_create_flag_invalid_type_rejected(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=_user(), entity_type="sub_sample", entity_id="1",
                            type="not_a_type", title="x")


def test_list_tabs_and_summary(db):
    from flags import service
    u = _user(7)
    a = service.create_flag(db, user=u, entity_type="sub_sample", entity_id="1",
                            type="blocker", title="A", assignee_id=7)
    service.create_flag(db, user=u, entity_type="sub_sample", entity_id="2",
                        type="ready_for_verification", title="B")
    assigned = service.list_flags(db, user_id=7, tab="assigned")
    assert [f.id for f in assigned] == [a.id]
    all_open = service.list_flags(db, user_id=7, tab="all_open")
    assert len(all_open) == 2
    s = service.summary(db, user_id=7)
    assert s["assigned_to_me"] == 1
    assert s["by_type"]["blocker"] == 1 and s["by_type"]["ready_for_verification"] == 1
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && pytest tests/test_flags_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'flags.errors'`.

- [ ] **Step 3: Implement errors + service (part 1)**

`backend/flags/errors.py`:
```python
"""Typed service exceptions; routes map them to HTTP codes."""


class NotFoundError(LookupError):
    """Flag (or related entity) not found."""


class BadRequestError(ValueError):
    """Structurally OK but semantically invalid."""


class PermissionDeniedError(Exception):
    """Caller lacks permission for the action."""


class ConflictError(Exception):
    """Illegal state transition or duplicate."""
```

`backend/flags/service.py`:
```python
"""Service layer for flags. All DB writes go through here; every state-changing
call writes a flag_events audit row AND emits to the event sink in the same
transaction boundary."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from flags import catalog, permissions, seams
from flags.errors import BadRequestError, NotFoundError, PermissionDeniedError
from flags.models import FlagComment, FlagEvent, FlagFlag, FlagParticipant


def _audit(db, flag_id, actor_id, event_type, *, from_value=None, to_value=None, details=None):
    """Write the audit row AND publish to the event sink. Caller commits."""
    db.add(FlagEvent(flag_id=flag_id, actor_id=actor_id, event_type=event_type,
                     from_value=from_value, to_value=to_value, details=details))
    seams.EVENT_SINK.emit({
        "event_type": event_type, "flag_id": flag_id, "actor_id": actor_id,
        "from_value": from_value, "to_value": to_value, "details": details or {},
    })


def create_flag(db: Session, *, user, entity_type, entity_id, type, title,
                assignee_id=None, first_comment=None) -> FlagFlag:
    if not seams.is_registered(entity_type):
        raise BadRequestError(f"unknown entity_type {entity_type!r}")
    if not catalog.is_valid_type(type):
        raise BadRequestError(f"unknown flag type {type!r}")
    if not permissions.can(user, "create", None):
        raise PermissionDeniedError("not allowed to create flags")
    spec = seams.get_entity_spec(entity_type)
    if not spec.can_flag(user, str(entity_id)):
        raise PermissionDeniedError(f"not allowed to flag {entity_type} {entity_id}")

    actor_id = getattr(user, "id", None)
    flag = FlagFlag(entity_type=entity_type, entity_id=str(entity_id),
                    kind=catalog.kind_for_type(type), type=type, status="open",
                    title=title, created_by=actor_id, assignee_id=assignee_id)
    db.add(flag)
    db.flush()  # populate flag.id

    _audit(db, flag.id, actor_id, "raised", to_value="open", details={"type": type})
    if assignee_id is not None:
        db.add(FlagParticipant(flag_id=flag.id, user_id=assignee_id, role="watcher", added_by=actor_id))
        _audit(db, flag.id, actor_id, "assigned", to_value=str(assignee_id))
    if first_comment:
        db.add(FlagComment(flag_id=flag.id, author_id=actor_id, body=first_comment))
        _audit(db, flag.id, actor_id, "commented")
    db.commit()
    db.refresh(flag)
    return flag


def get_flag(db: Session, flag_id: int) -> FlagFlag:
    flag = db.get(FlagFlag, flag_id)
    if flag is None:
        raise NotFoundError(f"flag {flag_id} not found")
    return flag


def list_flags(db: Session, *, user_id: int, tab: str, status: Optional[str] = None,
               entity_type: Optional[str] = None, entity_id: Optional[str] = None) -> list[FlagFlag]:
    stmt = select(FlagFlag).order_by(FlagFlag.updated_at.desc())
    open_states = ("open", "in_progress")
    if tab == "assigned":
        stmt = stmt.where(FlagFlag.assignee_id == user_id, FlagFlag.status.in_(open_states))
    elif tab == "raised":
        stmt = stmt.where(FlagFlag.created_by == user_id)
    elif tab == "watching":
        sub = select(FlagParticipant.flag_id).where(FlagParticipant.user_id == user_id)
        stmt = stmt.where(FlagFlag.id.in_(sub))
    elif tab == "all_open":
        stmt = stmt.where(FlagFlag.status.in_(open_states))
    else:
        raise BadRequestError(f"unknown tab {tab!r}")
    if status:
        stmt = stmt.where(FlagFlag.status == status)
    if entity_type and entity_id:
        stmt = stmt.where(FlagFlag.entity_type == entity_type,
                          FlagFlag.entity_id == str(entity_id))
    return list(db.execute(stmt).scalars().all())


def summary(db: Session, *, user_id: int) -> dict:
    open_states = ("open", "in_progress")
    assigned = db.execute(
        select(FlagFlag).where(FlagFlag.assignee_id == user_id, FlagFlag.status.in_(open_states))
    ).scalars().all()
    by_type: dict[str, int] = {}
    for f in db.execute(select(FlagFlag).where(FlagFlag.status.in_(open_states))).scalars().all():
        by_type[f.type] = by_type.get(f.type, 0) + 1
    return {"assigned_to_me": len(assigned), "by_type": by_type}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && pytest tests/test_flags_service.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/flags/errors.py backend/flags/service.py backend/tests/test_flags_service.py
git commit -m "feat(flags): service — create/get/list/summary with audit + emit"
```

---

### Task 6: Service — comments, assign, watchers, status lifecycle

**Files:**
- Modify: `backend/flags/service.py`
- Test: `backend/tests/test_flags_service_actions.py`

**Interfaces:**
- Produces:
  - `add_comment(db, *, user, flag_id, body) -> FlagComment`
  - `assign(db, *, user, flag_id, assignee_id) -> FlagFlag` (assignee_id may be None to unassign)
  - `add_watcher(db, *, user, flag_id, user_id) -> FlagParticipant`; `remove_watcher(db, *, user, flag_id, user_id) -> None`
  - `change_status(db, *, user, flag_id, to_status) -> FlagFlag` (validates via `catalog.is_legal_transition`, checks `permissions.can`, sets resolved_at/by, audits + emits)

- [ ] **Step 1: Write the failing test**

`backend/tests/test_flags_service_actions.py`:
```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import flags.models  # noqa: F401
    from flags import seams
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"V{e}",
                           deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _user(id=1, role="standard"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def _flag(db, assignee_id=None):
    from flags import service
    return service.create_flag(db, user=_user(1), entity_type="sub_sample", entity_id="1",
                               type="blocker", title="t", assignee_id=assignee_id)


def test_add_comment(db):
    from flags import service
    f = _flag(db)
    c = service.add_comment(db, user=_user(2), flag_id=f.id, body="hi")
    assert c.id and c.audience == "internal" and c.author_id == 2


def test_assign_and_watchers(db):
    from flags import service
    from flags.models import FlagParticipant
    f = _flag(db)
    service.assign(db, user=_user(1), flag_id=f.id, assignee_id=9)
    assert db.get(type(f), f.id).assignee_id == 9
    service.add_watcher(db, user=_user(1), flag_id=f.id, user_id=3)
    assert db.query(FlagParticipant).filter_by(flag_id=f.id, user_id=3).count() == 1
    service.remove_watcher(db, user=_user(1), flag_id=f.id, user_id=3)
    assert db.query(FlagParticipant).filter_by(flag_id=f.id, user_id=3).count() == 0


def test_status_lifecycle_and_perms(db):
    from flags import service
    from flags.errors import ConflictError, PermissionDeniedError
    f = _flag(db, assignee_id=2)               # raiser=1, assignee=2
    service.change_status(db, user=_user(2), flag_id=f.id, to_status="in_progress")
    got = service.change_status(db, user=_user(2), flag_id=f.id, to_status="resolved")
    assert got.status == "resolved" and got.resolved_at is not None and got.resolved_by == 2
    # a non-assignee non-admin non-raiser cannot move status
    with pytest.raises(PermissionDeniedError):
        service.change_status(db, user=_user(99), flag_id=f.id, to_status="closed")
    # illegal transition (resolved -> nonexistent already covered by catalog; test a bad jump)
    f2 = _flag(db)
    with pytest.raises(ConflictError):
        service.change_status(db, user=_user(1), flag_id=f2.id, to_status="bogus")
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && pytest tests/test_flags_service_actions.py -v`
Expected: FAIL — `AttributeError: module 'flags.service' has no attribute 'add_comment'`.

- [ ] **Step 3: Implement (append to `backend/flags/service.py`)**

```python
def add_comment(db: Session, *, user, flag_id, body) -> FlagComment:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "comment", flag):
        raise PermissionDeniedError("not allowed to comment")
    if not body or not body.strip():
        raise BadRequestError("comment body required")
    actor_id = getattr(user, "id", None)
    c = FlagComment(flag_id=flag.id, author_id=actor_id, body=body.strip())
    db.add(c)
    flag.updated_at = datetime.utcnow()
    _audit(db, flag.id, actor_id, "commented")
    db.commit()
    db.refresh(c)
    return c


def assign(db: Session, *, user, flag_id, assignee_id) -> FlagFlag:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "assign", flag):
        raise PermissionDeniedError("not allowed to assign")
    actor_id = getattr(user, "id", None)
    prev = flag.assignee_id
    flag.assignee_id = assignee_id
    flag.updated_at = datetime.utcnow()
    if assignee_id is not None:
        exists = db.execute(
            select(FlagParticipant).where(FlagParticipant.flag_id == flag.id,
                                          FlagParticipant.user_id == assignee_id)
        ).scalar_one_or_none()
        if exists is None:
            db.add(FlagParticipant(flag_id=flag.id, user_id=assignee_id, role="watcher", added_by=actor_id))
    _audit(db, flag.id, actor_id, "assigned" if assignee_id is not None else "unassigned",
           from_value=str(prev) if prev is not None else None,
           to_value=str(assignee_id) if assignee_id is not None else None)
    db.commit()
    db.refresh(flag)
    return flag


def add_watcher(db: Session, *, user, flag_id, user_id) -> FlagParticipant:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "watch", flag):
        raise PermissionDeniedError("not allowed to watch")
    existing = db.execute(
        select(FlagParticipant).where(FlagParticipant.flag_id == flag.id,
                                      FlagParticipant.user_id == user_id)
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    p = FlagParticipant(flag_id=flag.id, user_id=user_id, role="watcher",
                        added_by=getattr(user, "id", None))
    db.add(p)
    _audit(db, flag.id, getattr(user, "id", None), "watcher_added", to_value=str(user_id))
    db.commit()
    db.refresh(p)
    return p


def remove_watcher(db: Session, *, user, flag_id, user_id) -> None:
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "watch", flag):
        raise PermissionDeniedError("not allowed")
    row = db.execute(
        select(FlagParticipant).where(FlagParticipant.flag_id == flag.id,
                                      FlagParticipant.user_id == user_id)
    ).scalar_one_or_none()
    if row is not None:
        db.delete(row)
        _audit(db, flag.id, getattr(user, "id", None), "watcher_removed", from_value=str(user_id))
        db.commit()


def change_status(db: Session, *, user, flag_id, to_status) -> FlagFlag:
    from flags.errors import ConflictError
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "change_status", flag):
        raise PermissionDeniedError("not allowed to change status")
    if not catalog.is_legal_transition(flag.status, to_status):
        raise ConflictError(f"illegal transition {flag.status} -> {to_status}")
    actor_id = getattr(user, "id", None)
    from_status = flag.status
    flag.status = to_status
    flag.updated_at = datetime.utcnow()
    if to_status == "resolved":
        flag.resolved_at = datetime.utcnow()
        flag.resolved_by = actor_id
    elif to_status in ("open", "in_progress"):
        flag.resolved_at = None
        flag.resolved_by = None
    _audit(db, flag.id, actor_id, "status_changed", from_value=from_status, to_value=to_status)
    db.commit()
    db.refresh(flag)
    return flag
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && pytest tests/test_flags_service_actions.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/flags/service.py backend/tests/test_flags_service_actions.py
git commit -m "feat(flags): service — comments, assign, watchers, status lifecycle"
```

---

### Task 7: Schemas + routes + registration

**Files:**
- Create: `backend/flags/schemas.py`, `backend/flags/routes.py`
- Modify: `backend/main.py` (import + include_router; call `seams.register_mk1_entities()` at startup)
- Test: `backend/tests/test_flags_routes.py`

**Interfaces:**
- Consumes: all of `flags.service`, `flags.schemas`.
- Produces HTTP API under `/api/flags`:
  - `POST /api/flags` (raise) → 201 `FlagResponse`
  - `GET /api/flags?tab=&status=&entity_type=&entity_id=` → `list[FlagResponse]`
  - `GET /api/flags/summary` → `SummaryResponse`
  - `GET /api/flags/{id}` → `FlagDetailResponse` (with comments + events)
  - `POST /api/flags/{id}/comments` → 201 `CommentResponse`
  - `POST /api/flags/{id}/assign` → `FlagResponse`
  - `POST /api/flags/{id}/status` → `FlagResponse`
  - `POST /api/flags/{id}/watchers` / `DELETE /api/flags/{id}/watchers/{user_id}`

- [ ] **Step 1: Write the failing test**

`backend/tests/test_flags_routes.py`:
```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import flags.models  # noqa: F401
    from flags import seams
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_mk1_entities()

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()

    def _db():
        yield shared
    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    yield tc
    app.dependency_overrides.pop(get_db, None) if prev_db is None else app.dependency_overrides.__setitem__(get_db, prev_db)
    app.dependency_overrides.pop(get_current_user, None) if prev_user is None else app.dependency_overrides.__setitem__(get_current_user, prev_user)
    shared.close()


def test_raise_list_get_comment_status(client):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "123",
                                         "type": "blocker", "title": "Crashed out",
                                         "first_comment": "cloudy"})
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    assert r.json()["kind"] == "issue" and r.json()["status"] == "open"

    assert client.get("/api/flags?tab=all_open").json()[0]["id"] == fid
    detail = client.get(f"/api/flags/{fid}").json()
    assert detail["comments"][0]["body"] == "cloudy"
    assert any(e["event_type"] == "raised" for e in detail["events"])

    c = client.post(f"/api/flags/{fid}/comments", json={"body": "re-prep scheduled"})
    assert c.status_code == 201

    s = client.post(f"/api/flags/{fid}/status", json={"to_status": "in_progress"})
    assert s.status_code == 200 and s.json()["status"] == "in_progress"

    summ = client.get("/api/flags/summary").json()
    assert summ["by_type"]["blocker"] == 1


def test_unknown_entity_type_400(client):
    r = client.post("/api/flags", json={"entity_type": "nope", "entity_id": "1",
                                         "type": "blocker", "title": "x"})
    assert r.status_code == 400, r.text


def test_get_missing_404(client):
    assert client.get("/api/flags/99999").status_code == 404
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && pytest tests/test_flags_routes.py -v`
Expected: FAIL — import error (`flags.routes` missing) / 404 on `/api/flags`.

- [ ] **Step 3: Implement schemas**

`backend/flags/schemas.py`:
```python
"""Pydantic request/response models for the flags API."""
from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

FlagType = Literal["blocker", "critical", "question", "waiting_on_customer", "ready_for_verification"]
FlagStatus = Literal["open", "in_progress", "resolved", "closed"]
FlagTab = Literal["assigned", "raised", "watching", "all_open"]


class CreateFlagRequest(BaseModel):
    entity_type: str
    entity_id: str
    type: FlagType
    title: str
    assignee_id: Optional[int] = None
    first_comment: Optional[str] = None


class CommentRequest(BaseModel):
    body: str


class AssignRequest(BaseModel):
    assignee_id: Optional[int] = None


class StatusRequest(BaseModel):
    to_status: FlagStatus


class WatcherRequest(BaseModel):
    user_id: int


class CommentResponse(BaseModel):
    id: int
    flag_id: int
    author_id: int
    body: str
    audience: str
    created_at: datetime
    edited_at: Optional[datetime]
    model_config = ConfigDict(from_attributes=True)


class EventResponse(BaseModel):
    id: int
    actor_id: Optional[int]
    event_type: str
    from_value: Optional[str]
    to_value: Optional[str]
    details: Optional[dict]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class FlagResponse(BaseModel):
    id: int
    entity_type: str
    entity_id: str
    kind: str
    type: str
    status: str
    title: str
    created_by: int
    assignee_id: Optional[int]
    created_at: datetime
    updated_at: datetime
    resolved_at: Optional[datetime]
    resolved_by: Optional[int]
    model_config = ConfigDict(from_attributes=True)


class FlagDetailResponse(FlagResponse):
    comments: List[CommentResponse] = Field(default_factory=list)
    events: List[EventResponse] = Field(default_factory=list)


class SummaryResponse(BaseModel):
    assigned_to_me: int
    by_type: dict
```

- [ ] **Step 4: Implement routes + registration**

`backend/flags/routes.py`:
```python
"""FastAPI router for flags. Thin HTTP shell over flags.service."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from flags import service
from flags.errors import BadRequestError, ConflictError, NotFoundError, PermissionDeniedError
from flags.schemas import (
    AssignRequest, CommentRequest, CommentResponse, CreateFlagRequest,
    FlagDetailResponse, FlagResponse, StatusRequest, SummaryResponse, WatcherRequest,
)

router = APIRouter(prefix="/api/flags", tags=["flags"])
logger = logging.getLogger(__name__)


def _http(e: Exception) -> HTTPException:
    if isinstance(e, NotFoundError):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, PermissionDeniedError):
        return HTTPException(status_code=403, detail=str(e))
    if isinstance(e, ConflictError):
        return HTTPException(status_code=409, detail=str(e))
    if isinstance(e, BadRequestError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, HTTPException):
        return e
    logger.exception("unhandled flags error")
    return HTTPException(status_code=500, detail="internal error")


@router.post("", response_model=FlagResponse, status_code=status.HTTP_201_CREATED)
def create_flag(req: CreateFlagRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return FlagResponse.model_validate(service.create_flag(
            db, user=user, entity_type=req.entity_type, entity_id=req.entity_id,
            type=req.type, title=req.title, assignee_id=req.assignee_id,
            first_comment=req.first_comment))
    except Exception as e:
        raise _http(e)


@router.get("", response_model=List[FlagResponse])
def list_flags(tab: str = Query("all_open"), status: Optional[str] = None,
               entity_type: Optional[str] = None, entity_id: Optional[str] = None,
               db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        rows = service.list_flags(db, user_id=getattr(user, "id", None), tab=tab,
                                  status=status, entity_type=entity_type, entity_id=entity_id)
        return [FlagResponse.model_validate(r) for r in rows]
    except Exception as e:
        raise _http(e)


@router.get("/summary", response_model=SummaryResponse)
def summary(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return SummaryResponse(**service.summary(db, user_id=getattr(user, "id", None)))


@router.get("/{flag_id}", response_model=FlagDetailResponse)
def get_flag(flag_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return FlagDetailResponse.model_validate(service.get_flag(db, flag_id))
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/comments", response_model=CommentResponse, status_code=201)
def add_comment(flag_id: int, req: CommentRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return CommentResponse.model_validate(service.add_comment(db, user=user, flag_id=flag_id, body=req.body))
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/assign", response_model=FlagResponse)
def assign(flag_id: int, req: AssignRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return FlagResponse.model_validate(service.assign(db, user=user, flag_id=flag_id, assignee_id=req.assignee_id))
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/status", response_model=FlagResponse)
def change_status(flag_id: int, req: StatusRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return FlagResponse.model_validate(service.change_status(db, user=user, flag_id=flag_id, to_status=req.to_status))
    except Exception as e:
        raise _http(e)


@router.post("/{flag_id}/watchers", status_code=201)
def add_watcher(flag_id: int, req: WatcherRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.add_watcher(db, user=user, flag_id=flag_id, user_id=req.user_id)
        return {"ok": True}
    except Exception as e:
        raise _http(e)


@router.delete("/{flag_id}/watchers/{user_id}", status_code=204)
def remove_watcher(flag_id: int, user_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.remove_watcher(db, user=user, flag_id=flag_id, user_id=user_id)
    except Exception as e:
        raise _http(e)
```

In `backend/main.py`, add the import near line 75 (with the other routers):
```python
from flags.routes import router as flags_router
```
Register near line 388 (with the other `include_router` calls):
```python
app.include_router(flags_router)
```
And register the Mk1 entity types at startup. Find where `init_db()` is called (`backend/main.py:316`) and add immediately after it:
```python
    from flags import seams as _flag_seams
    _flag_seams.register_mk1_entities()
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && pytest tests/test_flags_routes.py -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full flags suite + commit**

Run: `cd backend && pytest tests/test_flags_*.py -v`
Expected: all PASS.
```bash
git add backend/flags/schemas.py backend/flags/routes.py backend/main.py backend/tests/test_flags_routes.py
git commit -m "feat(flags): REST API (/api/flags) + Mk1 entity registration"
```

---

### Task 8: Stack smoke — verify on the running `flags` stack

**Files:** none (verification task).

- [ ] **Step 1: Run the suite inside the stack container**

Run:
```bash
ssh forrestparker@100.73.137.3 'docker compose -p accumark-flags exec -T accu-mk1-backend sh -c "cd /app && pytest tests/test_flags_*.py -v"'
```
Expected: all flags tests PASS against the container's Python env.

- [ ] **Step 2: Confirm tables created on the real Postgres**

Run:
```bash
ssh forrestparker@100.73.137.3 'docker compose -p accumark-flags exec -T postgres psql -U accumark -d accumark_mk1 -c "\dt flag_*"'
```
Expected: `flag_flags`, `flag_comments`, `flag_participants`, `flag_events` listed. (uvicorn --reload re-ran `init_db()` on the mounted code; if missing, restart: `docker compose -p accumark-flags restart accu-mk1-backend`.)

- [ ] **Step 3: Smoke the live endpoint** (needs an auth token; optional — the pytest suite already exercises the routes). If a token is handy:
```bash
curl -s -X POST http://100.73.137.3:5552/api/flags -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"entity_type":"sub_sample","entity_id":"1","type":"blocker","title":"smoke"}'
```
Expected: 201 with a flag JSON. (No commit — verification only.)

---

## Self-Review

**Spec coverage** (against `2026-06-27-flag-system-design.md`):
- §3 module + 3 seams → Task 3 (registry/user/event sink) ✓; `flags_` prefix + no host FK → Task 1 + Global Constraints ✓.
- §4 data model (`flags_flag`/`comment`/`participant`/`event`, type→kind, indexes) → Task 1 + Task 2 ✓. (Spec table names were illustrative; implemented as `flag_flags` etc. — consistent across plan.)
- §5 lifecycle + host-resolved permissions + audit-every-change → Task 2 (transitions), Task 4 (permissions), Task 5/6 (audit in every writer) ✓.
- §6 SSE → **out of scope here** (Plan 2); the event sink (Task 3) is the attachment point ✓.
- §7 UI → Plan 3.
- §8 future seams: `audience` column present (Task 1), permissions isolated to one function (Task 4) ✓.
- §10 ISO audit (attribution + timestamps, append-only) → `flag_events` Task 1 + audit in service ✓.
- §11 testing (portability via fake adapters) → service tests register a fake entity + in-memory sink (Tasks 5/6) ✓.

**Placeholder scan:** the only "placeholder" notes are the entity `deep_link` strings (Task 3) — explicitly flagged as Plan-3-confirmed and non-load-bearing for the backend; not a code gap. Test placeholder lines are corrected inline in their tasks (Task 1 Step 3, Task 2 Step 3).

**Type consistency:** `create_flag`/`change_status`/`assign`/`add_comment`/`add_watcher`/`remove_watcher` signatures match between service (Tasks 5/6), routes (Task 7), and tests. `kind`/`type`/`status` value sets match between `catalog.py`, the DDL CHECK, and the Pydantic `Literal`s. Event types used in `_audit` calls (`raised`/`assigned`/`unassigned`/`commented`/`status_changed`/`watcher_added`/`watcher_removed`) are free-text in `flag_events` (no CHECK), so no enum drift risk.

---

## Next Plans (not in this document)

- **Plan 2 — Real-time (SSE):** replace `InMemoryEventSink` with an SSE-backed sink; add `GET /api/flags/stream` (per-user, auth'd, scoped to assigned/watching/all-open); wire events → existing toast/native notification framework.
- **Plan 3 — Frontend:** Flags button (segments + glow), slide-over flyout (tabs + cards), thread view (timeline + composer + comment slide-in), toast-flies-home, SSE client; confirm the real Mk1 hash routes for `seams.register_mk1_entities()` deep-links.
