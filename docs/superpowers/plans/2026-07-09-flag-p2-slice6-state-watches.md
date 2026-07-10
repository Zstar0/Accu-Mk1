# Flag P2 Slice 6 — State-Change Watches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arm a watch on a host entity ("when sample PB-0102 hits Received") that fires ONCE — either commenting on an existing flag thread or minting a new flag — evaluated by a scheduler-driven poller. No instrumentation of the (many) write paths that change entity state; poll instead (spec §2).

**Architecture:** A new `flag_entity_watches` table + a module-pure watches engine in `backend/flags/watches.py` that reads entity state ONLY through a new `seams.state` closure and acts ONLY through `flags.service` (`create_flag`/`add_comment`). A poller job registered on the Slice-5 scheduler evaluates armed watches every ~2 min; a match fires the action and flips `status='armed' → 'fired'` in the SAME transaction (one-shot v1). The engine knows nothing about samples — only the Mk1 host registration closure reads `LimsSample.status`.

**Tech Stack:** FastAPI + SQLAlchemy + idempotent-DDL migrations (`database.py`, no alembic in Mk1); React 18 + TypeScript + shadcn + TanStack Query. Spec: `docs/superpowers/specs/2026-07-09-flag-system-phase2-design.md` §9 (+ §2 poll-don't-instrument, §10 analytics, §12 testing).

## Global Constraints

- **npm only** for the Accu-Mk1 frontend (never pnpm/yarn). No new dependencies in this slice.
- **Additive only** — new columns/tables/kwargs; existing callers of `create_flag`/`add_comment` unchanged; existing tests stay green (gate = normalized failure-set diff vs the known baseline, ~19 backend / 34 frontend known failures).
- **Module purity is the load-bearing constraint here.** The watches engine (`backend/flags/watches.py`) imports NO host models. It reads entity state ONLY via `seams.resolve_state` and mutates ONLY via `flags.service`. The single place any Mk1 model is touched is the `_sample_state` closure inside `seams.register_mk1_entities()`.
- **Analytics readiness (spec §10):** every automated mutation attributes the watch **creator** (`created_by`) and carries `details.automated: true` — on the raised/commented event AND on the `watch_fired` event.
- **Scheduler tests use the injectable `run_watch_poll(db, *, now=None)` core** — no sleeps, no real scheduler, no `SessionLocal` in the tested path (spec §12).
- Backend gates per task: `python -m pytest backend/tests/<file> -q`, then `python -m pytest backend/tests -k flag -q` (no NEW failures). Frontend per task: `npx vitest run <file>`. Slice gate: `npm run check:all` + `npm run build` + `python -m pytest backend/tests -q`.
- **Depends on Slice 5** (the poller rides its scheduler): branch `feat/flag-p2-watches` off `feat/flag-p2-slack2`. **Final task = gates only. NO push, NO PR** — the orchestrator reviews first.

---

### Task 1: Migration + model — `flag_entity_watches`

**Files:**
- Modify: `backend/flags/models.py` (new `FlagEntityWatch`), `backend/database.py` (append to the flags migration block, after the `lims_boxes` statements ~line 937 — the current tail of the list)
- Test: `backend/tests/test_flags_watches.py` (create)

**Interfaces:**
- Produces: `FlagEntityWatch(id, entity_type, entity_id, condition JSON, action JSON, created_by, watch_flag_id nullable FK→flag_flags CASCADE, status TEXT armed|fired|cancelled, created_at, fired_at)`. Every later backend task builds on this row.

- [ ] **Step 1: Failing test**

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_watch_row_roundtrips(db):
    from flags.models import FlagEntityWatch
    w = FlagEntityWatch(entity_type="sample", entity_id="PB-1",
                        condition={"field": "state", "equals": "received"},
                        action={"kind": "comment", "flag_id": 1, "body": "hi"},
                        created_by=42, status="armed")
    db.add(w); db.commit(); db.refresh(w)
    assert w.id and w.status == "armed" and w.fired_at is None
    assert w.condition["equals"] == "received"
```

- [ ] **Step 2: Run — FAIL** (no `FlagEntityWatch`).
Run: `python -m pytest backend/tests/test_flags_watches.py -q`

- [ ] **Step 3: Implement.** `models.py` — append after `FlagRead` (reuse the file's existing `JSONB().with_variant(JSON(), "sqlite")` idiom):

```python
class FlagEntityWatch(Base):
    """An armed watch on a host entity's workflow state (Plan 6).

    A scheduler poller (flags/watches.py) evaluates `condition` against the
    `state` seam every ~2 min and fires `action` ONCE (one-shot v1; re-arm is
    manual). Anchors by opaque (entity_type, entity_id) like a flag — NO FK to
    host tables. `watch_flag_id` is set when armed from a flag thread (fire =
    comment on that flag); NULL for a standalone watch armed from an entity page
    (fire = mint a new flag)."""
    __tablename__ = "flag_entity_watches"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[str] = mapped_column(Text, nullable=False)
    condition: Mapped[dict] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=False)
    action: Mapped[dict] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=False)
    created_by: Mapped[int] = mapped_column(Integer, nullable=False)
    watch_flag_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
        nullable=True, index=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="armed",
                                        server_default="armed", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    fired_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
```

`database.py` — append to the migrations list (same string-list idiom):

```python
        # --- Phase 2 slice 6: state-change watches ---
        """
        CREATE TABLE IF NOT EXISTS flag_entity_watches (
            id            SERIAL PRIMARY KEY,
            entity_type   TEXT NOT NULL,
            entity_id     TEXT NOT NULL,
            condition     JSONB NOT NULL,
            action        JSONB NOT NULL,
            created_by    INTEGER NOT NULL,
            watch_flag_id INTEGER REFERENCES flag_flags(id) ON DELETE CASCADE,
            status        TEXT NOT NULL DEFAULT 'armed'
                          CONSTRAINT flag_entity_watches_status_check
                          CHECK (status IN ('armed','fired','cancelled')),
            created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
            fired_at      TIMESTAMP
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_entity_watches_status ON flag_entity_watches (status)",
        "CREATE INDEX IF NOT EXISTS ix_flag_entity_watches_flag   ON flag_entity_watches (watch_flag_id)",
```

- [ ] **Step 4: Run — PASS.** Full flag suite: `python -m pytest backend/tests -k flag -q` — no new failures.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): flag_entity_watches table + model"`

---

### Task 2: `state` seam + `resolve_state`/`has_state_seam` + `sample` closure

**Files:**
- Modify: `backend/flags/seams.py` (`EntitySpec.state`, `register_entity` param, `resolve_state`, `has_state_seam`, `_sample_state` closure)
- Test: `backend/tests/test_flags_watch_seam.py` (create)

**Interfaces:**
- Produces: `EntitySpec.state: Optional[Callable[[Session, str], Optional[str]]] = None`; `seams.resolve_state(db, entity_type, entity_id) -> Optional[str]` (best-effort, swallows to None — mirrors `resolve_context`); `seams.has_state_seam(entity_type) -> bool` (checks `spec.state is not None` **directly** — this is what arm-time validation uses; a `resolve_state` that returns None can mean "no seam" OR "unresolvable now", so the two must not be conflated). `sample` gets a state closure reading `LimsSample.status`; `sub_sample`/`worksheet` do NOT (no state column → unwatchable, 400 on arm).

**Resolved ambiguity (the real Mk1 state field):** the team lead's hint named `LimsSample.review_state`, but the model has **no** such column — `LimsSample.status` (`String(50)`, nullable) is the workflow field, fed from SENAITE's `review_state` at `backend/sub_samples/service.py:90` and set to `"received"` on check-in (confirmed across many tests, e.g. `test_assignment_kind.py:22`). `review_state` (`backend/models.py:1250`) belongs to **`LimsAnalysis`**, not the sample. `LimsSubSample` has **no** state column at all. So the `sample` closure reads `.status`, and `sub_sample` is deliberately left unwatchable.

- [ ] **Step 1: Failing test**

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams
    seams._REGISTRY.clear()
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_sample_is_watchable_others_are_not(db):
    from flags import seams
    assert seams.has_state_seam("sample") is True
    assert seams.has_state_seam("sub_sample") is False
    assert seams.has_state_seam("worksheet") is False
    assert seams.has_state_seam("nope") is False


def test_resolve_state_reads_sample_status(db):
    from flags import seams
    from models import LimsSample
    db.add(LimsSample(sample_id="PB-0102", status="received")); db.commit()
    assert seams.resolve_state(db, "sample", "PB-0102") == "received"
    # unresolvable (missing row) → None, NOT an exception
    assert seams.resolve_state(db, "sample", "GHOST-9") is None
    # no seam → None (and has_state_seam already said False)
    assert seams.resolve_state(db, "sub_sample", "1") is None
```

- [ ] **Step 2: Run — FAIL** (`has_state_seam`/`resolve_state` missing).
Run: `python -m pytest backend/tests/test_flags_watch_seam.py -q`

- [ ] **Step 3: Implement.** `seams.py` — add `state` to the dataclass (after `descendants`):

```python
    # Optional state resolver (Plan 6 — state-change watches). Returns the
    # entity's current host-domain workflow state (e.g. a sample's status) or
    # None when unresolvable. ONLY entity types that register a `state` closure
    # are watchable; the rest 400 at arm time.
    state: Optional[Callable[[Session, str], Optional[str]]] = None
```

`register_entity` — thread the new kwarg:

```python
def register_entity(entity_type: str, *, label, deep_link, can_flag,
                    context=None, descendants=None, state=None) -> None:
    _REGISTRY[entity_type] = EntitySpec(entity_type, label, deep_link, can_flag,
                                        context=context, descendants=descendants,
                                        state=state)
```

Add the two resolvers (next to `resolve_context`/`resolve_descendants`):

```python
def has_state_seam(entity_type: str) -> bool:
    """True when the entity type registered a `state` closure (→ watchable).
    Deliberately distinct from `resolve_state` returning None, which can mean
    'unresolvable right now'. Arm-time validation uses THIS."""
    spec = _REGISTRY.get(entity_type)
    return spec is not None and spec.state is not None


def resolve_state(db: Session, entity_type: str, entity_id: str) -> Optional[str]:
    """Current host state for an entity, or None (unregistered, no `state`
    closure, row gone, or resolver error). Best-effort — never raises into the
    poller (a transient None just means 'no match this tick')."""
    spec = _REGISTRY.get(entity_type)
    if spec is None or spec.state is None:
        return None
    try:
        return spec.state(db, str(entity_id))
    except Exception:  # noqa: BLE001 — state read is best-effort
        return None
```

In `register_mk1_entities()` — add a `_sample_state` closure (reuse the existing `_load_sample` helper) and pass it ONLY on the `sample` registration:

```python
    def _sample_state(db, eid):
        row = _load_sample(db, eid)
        return getattr(row, "status", None)
```

```python
    register_entity("sample",
                    label=_sample_label,
                    deep_link=lambda eid: f"/#senaite/sample-details?id={eid}",
                    can_flag=lambda user, eid: True,
                    context=_sample_context,
                    descendants=_sample_descendants,
                    state=_sample_state)
```

(Leave `sub_sample` and `worksheet` registrations unchanged — no `state=`, so they stay unwatchable.)

- [ ] **Step 4: Run — PASS**; full flag suite: no new failures. (The existing `test_flags_seams_context.py` still passes — `state` defaults to None everywhere it isn't set.)
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): state seam + resolve_state (sample.status)"`

---

### Task 3: Additive `extra_event_details` on `create_flag` + `add_comment`

**Files:**
- Modify: `backend/flags/service.py` (`create_flag`, `add_comment`)
- Test: `backend/tests/test_flags_watches.py` (extend)

**Interfaces:**
- Produces: `service.create_flag(..., extra_event_details: Optional[dict] = None)` merges the dict into the **raised** event's `details`; `service.add_comment(..., extra_event_details: Optional[dict] = None)` merges into the **commented** event's `details`. Existing callers pass nothing → behavior identical. Task 5's poller passes `{"automated": True, "watch_id": N}` so §10's analytics lineage lands on the action's own event.

**Why this task exists:** `create_flag` hardcodes `details={"type": type}` on the raised event (`service.py:81`) and `add_comment` builds `details` inline (`service.py:253`). The spec (§9/§10) requires the automated marker **on the raised/commented event**, so a merge hook is needed — reusing the service (not reinventing flag creation) demands it.

- [ ] **Step 1: Failing tests** (append to `test_flags_watches.py`; add the shared unit fixture — reuse the `db`/`_user` idiom from `backend/tests/test_flags_activity.py`: in-memory sqlite, `seams.set_event_sink(InMemoryEventSink())`, `seams.register_mk1_entities()`, `types_service.seed_builtins(s)`, `_user(id)=SimpleNamespace(id=..., role="standard", email=...)`)

```python
def test_create_flag_merges_extra_event_details(db):
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="sample",
                            entity_id="PB-1", type="blocker", title="t",
                            extra_event_details={"automated": True, "watch_id": 7})
    raised = [e for e in f.events if e.event_type == "raised"][-1]
    assert raised.details["automated"] is True and raised.details["watch_id"] == 7
    assert raised.details["type"] == "blocker"          # original key preserved


def test_add_comment_merges_extra_event_details(db):
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="sample",
                            entity_id="PB-1", type="blocker", title="t")
    service.add_comment(db, user=_user(1), flag_id=f.id, body="done",
                        extra_event_details={"automated": True})
    ev = [e for e in service.get_flag(db, f.id).events
          if e.event_type == "commented"][-1]
    assert ev.details["automated"] is True and ev.details["body_excerpt"] == "done"
```

- [ ] **Step 2: Run — FAIL** (unexpected kwarg).

- [ ] **Step 3: Implement.** `create_flag` — add `extra_event_details=None` to the signature and merge on the raised audit:

```python
    _audit(db, flag, actor_id, "raised", to_value="open",
           details={"type": type, **(extra_event_details or {})})
```

`add_comment` — add `extra_event_details=None` to the signature; after building `details` (and the `mentions` key), before `_audit`:

```python
    if extra_event_details:
        details.update(extra_event_details)
```

- [ ] **Step 4: Run — PASS**; full flag suite: no new failures.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): extra_event_details merge hook on create_flag/add_comment"`

---

### Task 4: Watches engine — arm / cancel / list (+ `watch_armed`/`watch_cancelled`)

**Files:**
- Create: `backend/flags/watches.py`
- Test: `backend/tests/test_flags_watches.py` (extend)

**Interfaces:**
- Produces: `watches.arm_watch(db, *, user, entity_type, entity_id, condition, action, watch_flag_id=None) -> FlagEntityWatch`; `watches.cancel_watch(db, *, user, watch_id) -> None` (creator or admin only); `watches.list_watches(db, *, flag_id=None, status="armed") -> list[FlagEntityWatch]`. Arm validates: entity registered, `has_state_seam` (else 400), condition shape (`{"field":"state","equals":<non-empty str>}`), action shape (`create_flag` → valid `type` + `title`; `comment` → existing `flag_id` + non-empty `body`), and (when set) that `watch_flag_id` resolves. **Event boundary (spec §9):** `watch_armed`/`watch_cancelled` emit on the associated flag ONLY when `watch_flag_id` is set; for a standalone watch the row itself is the record (its `status`/`created_at`).

- [ ] **Step 1: Failing tests** (extend `test_flags_watches.py`; the `db`/`_user` unit fixture from Task 3 already registers `sample` as watchable)

```python
def test_arm_cancel_list_lifecycle(db):
    from flags import service, watches
    f = service.create_flag(db, user=_user(1), entity_type="sample",
                            entity_id="PB-1", type="blocker", title="t")
    w = watches.arm_watch(db, user=_user(1), entity_type="sample",
                          entity_id="PB-1",
                          condition={"field": "state", "equals": "received"},
                          action={"kind": "comment", "flag_id": f.id, "body": "here"},
                          watch_flag_id=f.id)
    assert w.status == "armed"
    assert [x.id for x in watches.list_watches(db, flag_id=f.id)] == [w.id]
    # watch_armed rode the associated flag
    assert "watch_armed" in [e.event_type for e in service.get_flag(db, f.id).events]
    watches.cancel_watch(db, user=_user(1), watch_id=w.id)
    assert db.get(type(w), w.id).status == "cancelled"
    assert watches.list_watches(db, flag_id=f.id) == []          # armed-only
    assert "watch_cancelled" in [e.event_type for e in service.get_flag(db, f.id).events]


def test_arm_rejects_unwatchable_entity(db):
    import pytest
    from flags import watches
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        watches.arm_watch(db, user=_user(1), entity_type="sub_sample",
                          entity_id="9",
                          condition={"field": "state", "equals": "received"},
                          action={"kind": "create_flag", "type": "blocker", "title": "x"})


def test_cancel_requires_creator_or_admin(db):
    import pytest
    from flags import watches
    from flags.errors import PermissionDeniedError
    w = watches.arm_watch(db, user=_user(1), entity_type="sample", entity_id="PB-2",
                          condition={"field": "state", "equals": "received"},
                          action={"kind": "create_flag", "type": "blocker", "title": "x"})
    with pytest.raises(PermissionDeniedError):
        watches.cancel_watch(db, user=_user(2), watch_id=w.id)         # not creator
    watches.cancel_watch(db, user=SimpleNamespace(id=99, role="admin"), watch_id=w.id)
```

- [ ] **Step 2: Run — FAIL** (`flags.watches` missing).

- [ ] **Step 3: Implement.** Create `backend/flags/watches.py`:

```python
"""State-change watches engine (Plan 6).

Poll-don't-instrument (spec §2): a scheduler job evaluates armed watches against
the host `state` seam every ~2 min and fires each ONCE. Module-pure — this file
imports NO host models. It reads entity state ONLY via `seams.resolve_state` and
raises flags / posts comments ONLY through `flags.service`.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from flags import permissions, seams, service, types_service
from flags.errors import BadRequestError, NotFoundError, PermissionDeniedError
from flags.models import FlagEntityWatch

log = logging.getLogger(__name__)


@dataclass
class _ActorRef:
    """Minimal actor for automated fires — carries the watch creator's id so
    service permission checks (create/comment are OPEN actions) pass and emitted
    events attribute the creator (spec §10). Avoids a host User import."""
    id: int
    role: Optional[str] = None


# --- validation ----------------------------------------------------------
def _validate_condition(condition: dict) -> None:
    if not isinstance(condition, dict) or condition.get("field") != "state":
        raise BadRequestError("condition must be {'field':'state','equals':<str>}")
    if not isinstance(condition.get("equals"), str) or not condition["equals"].strip():
        raise BadRequestError("condition.equals must be a non-empty string")


def _validate_action(db: Session, action: dict) -> None:
    if not isinstance(action, dict):
        raise BadRequestError("action must be an object")
    kind = action.get("kind")
    if kind == "create_flag":
        if not action.get("title"):
            raise BadRequestError("create_flag action needs a title")
        atype = action.get("type") or "task"
        if not types_service.is_valid_type(db, atype):
            raise BadRequestError(f"unknown flag type {atype!r}")
    elif kind == "comment":
        if not action.get("flag_id"):
            raise BadRequestError("comment action needs a flag_id")
        if not (action.get("body") or "").strip():
            raise BadRequestError("comment action needs a body")
        service.get_flag(db, int(action["flag_id"]))  # 404 if the target is gone
    else:
        raise BadRequestError(f"unknown action kind {kind!r}")


# --- arm / cancel / list -------------------------------------------------
def arm_watch(db: Session, *, user, entity_type: str, entity_id: str,
              condition: dict, action: dict,
              watch_flag_id: Optional[int] = None) -> FlagEntityWatch:
    if not permissions.can(user, "watch", None):
        raise PermissionDeniedError("not allowed to arm watches")
    if not seams.is_registered(entity_type):
        raise BadRequestError(f"unknown entity_type {entity_type!r}")
    if not seams.has_state_seam(entity_type):
        raise BadRequestError(f"{entity_type} has no watchable state")
    _validate_condition(condition)
    _validate_action(db, action)
    flag = service.get_flag(db, watch_flag_id) if watch_flag_id is not None else None
    uid = getattr(user, "id", None)
    watch = FlagEntityWatch(entity_type=entity_type, entity_id=str(entity_id),
                            condition=condition, action=action, created_by=uid,
                            watch_flag_id=watch_flag_id, status="armed")
    db.add(watch)
    db.flush()  # populate watch.id
    if flag is not None:
        service._audit(db, flag, uid, "watch_armed",
                       details={"watch_id": watch.id,
                                "entity": f"{entity_type}:{entity_id}"})
        service._commit_and_emit(db)
    else:
        db.commit()  # standalone watch: the row is its own record, no flag event
    db.refresh(watch)
    return watch


def cancel_watch(db: Session, *, user, watch_id: int) -> None:
    watch = db.get(FlagEntityWatch, watch_id)
    if watch is None:
        raise NotFoundError(f"watch {watch_id} not found")
    uid = getattr(user, "id", None)
    if uid != watch.created_by and getattr(user, "role", None) != "admin":
        raise PermissionDeniedError("only the creator or an admin can cancel a watch")
    if watch.status != "armed":
        return  # already fired/cancelled — idempotent
    watch.status = "cancelled"
    if watch.watch_flag_id is not None:
        flag = service.get_flag(db, watch.watch_flag_id)
        service._audit(db, flag, uid, "watch_cancelled", details={"watch_id": watch.id})
        service._commit_and_emit(db)
    else:
        db.commit()


def list_watches(db: Session, *, flag_id: Optional[int] = None,
                 status: str = "armed") -> list[FlagEntityWatch]:
    """Watches in `status` (default armed), optionally scoped to a thread."""
    stmt = select(FlagEntityWatch).where(FlagEntityWatch.status == status)
    if flag_id is not None:
        stmt = stmt.where(FlagEntityWatch.watch_flag_id == flag_id)
    return list(db.execute(
        stmt.order_by(FlagEntityWatch.created_at.asc())).scalars().all())
```

- [ ] **Step 4: Run — PASS**; full flag suite: no new failures.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): watch arm/cancel/list engine"`

---

### Task 5: Poller — `run_watch_poll` core + `_fire` + scheduler registration

**Files:**
- Modify: `backend/flags/watches.py` (`_condition_met`, `_fire`, `run_watch_poll`, `_watch_poll_job`, `register_watch_jobs`), `backend/main.py` (register in `lifespan`)
- Test: `backend/tests/test_flags_watch_poller.py` (create)

**Interfaces:**
- Produces: `watches.run_watch_poll(db, *, now=None) -> int` (the injectable, Session-owning-caller core — returns fire count); `watches._watch_poll_job()` (thin `SessionLocal` wrapper for the scheduler); `watches.register_watch_jobs()` (registers `flag_watch_poller` @ ~120 s on the Slice-5 scheduler). A match fires the action + flips `status='fired'`/`fired_at` in the SAME transaction (spec §9 one-shot); `watch_fired` emits on the minted flag (`create_flag`) or the associated/target flag (`comment`), carrying `{"automated": true, "watch_id": N}`.

- [ ] **Step 1: Failing tests** (`test_flags_watch_poller.py`; register a **fake** watchable entity so the poller test controls state without host rows — the module-purity payoff: the engine never needs a real sample)

```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Mutable fake-entity state the tests flip to simulate a transition.
_STATE = {}


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams._REGISTRY.clear()
    seams.register_entity("widget",
                          label=lambda d, e: f"Widget {e}",
                          deep_link=lambda e: f"/w/{e}",
                          can_flag=lambda u, e: True,
                          state=lambda d, e: _STATE.get(e))
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    _STATE.clear()
    try:
        yield s
    finally:
        s.close()
        seams._REGISTRY.clear()


def _user(i):
    return SimpleNamespace(id=i, role="standard", email=f"u{i}@x.t")


def test_poll_fires_comment_when_state_matches(db):
    from flags import service, watches
    f = service.create_flag(db, user=_user(1), entity_type="widget", entity_id="W1",
                            type="blocker", title="t")
    watches.arm_watch(db, user=_user(1), entity_type="widget", entity_id="W1",
                      condition={"field": "state", "equals": "received"},
                      action={"kind": "comment", "flag_id": f.id, "body": "W1 received"},
                      watch_flag_id=f.id)
    assert watches.run_watch_poll(db) == 0            # not received yet
    _STATE["W1"] = "received"
    assert watches.run_watch_poll(db) == 1            # fires
    assert watches.run_watch_poll(db) == 0            # one-shot: no re-fire
    detail = service.get_flag(db, f.id)
    assert any(c.body == "W1 received" for c in detail.comments)
    fired = [e for e in detail.events if e.event_type == "watch_fired"][-1]
    assert fired.details["automated"] is True
    commented = [e for e in detail.events if e.event_type == "commented"][-1]
    assert commented.details["automated"] is True     # §10 marker on the action too


def test_poll_fires_create_flag_and_links_minted_flag(db):
    from flags import watches
    from flags.models import FlagEntityWatch
    w = watches.arm_watch(db, user=_user(3), entity_type="widget", entity_id="W2",
                          condition={"field": "state", "equals": "done"},
                          action={"kind": "create_flag", "type": "blocker",
                                  "title": "W2 is done", "assignee_id": 3})
    _STATE["W2"] = "done"
    assert watches.run_watch_poll(db) == 1
    row = db.get(FlagEntityWatch, w.id)
    assert row.status == "fired" and row.fired_at is not None
    assert row.watch_flag_id is not None              # linked to the minted flag


def test_one_poison_watch_does_not_stall_the_rest(db):
    from flags import service, watches
    # A comment watch whose target flag will be deleted → fire raises, is isolated.
    f = service.create_flag(db, user=_user(1), entity_type="widget", entity_id="W3",
                            type="blocker", title="t")
    watches.arm_watch(db, user=_user(1), entity_type="widget", entity_id="W3",
                      condition={"field": "state", "equals": "x"},
                      action={"kind": "comment", "flag_id": f.id, "body": "hi"},
                      watch_flag_id=f.id)
    good = watches.arm_watch(db, user=_user(1), entity_type="widget", entity_id="W4",
                             condition={"field": "state", "equals": "x"},
                             action={"kind": "create_flag", "type": "blocker", "title": "ok"})
    db.delete(f); db.commit()                          # poison the first watch
    _STATE["W3"] = "x"; _STATE["W4"] = "x"
    assert watches.run_watch_poll(db) == 1             # W4 still fires
    from flags.models import FlagEntityWatch
    assert db.get(FlagEntityWatch, good.id).status == "fired"
```

- [ ] **Step 2: Run — FAIL** (`run_watch_poll` missing).
Run: `python -m pytest backend/tests/test_flags_watch_poller.py -q`

- [ ] **Step 3: Implement.** Append to `backend/flags/watches.py`:

```python
# --- poller --------------------------------------------------------------
def _condition_met(db: Session, watch: FlagEntityWatch) -> bool:
    cond = watch.condition or {}
    if cond.get("field") != "state":
        return False  # v1 evaluates state-equality only
    current = seams.resolve_state(db, watch.entity_type, watch.entity_id)
    return current is not None and current == cond.get("equals")


def _fire(db: Session, watch: FlagEntityWatch) -> None:
    """Execute the action + mark the watch fired ATOMICALLY (spec §9 one-shot).

    `status='fired'`/`fired_at` are set on the session BEFORE the service call;
    the action's own `_commit_and_emit` commit flushes the dirty watch in the
    SAME transaction — action + status-flip are all-or-nothing (a raise inside
    the action rolls both back, leaving the watch armed for the next tick). The
    `watch_fired` audit event is emitted in a follow-up commit (best-effort:
    losing only the meta event on a mid-fire crash beats double-firing)."""
    action = watch.action or {}
    kind = action.get("kind")
    actor = _ActorRef(id=watch.created_by)
    marker = {"automated": True, "watch_id": watch.id}
    watch.status = "fired"
    watch.fired_at = datetime.utcnow()
    if kind == "create_flag":
        flag = service.create_flag(
            db, user=actor, entity_type=None, entity_id=None,
            type=action.get("type") or "task", title=action["title"],
            assignee_id=action.get("assignee_id"), extra_event_details=marker)
        if watch.watch_flag_id is None:
            watch.watch_flag_id = flag.id      # link standalone watch to its flag
        target_flag_id = flag.id
    elif kind == "comment":
        service.add_comment(db, user=actor, flag_id=int(action["flag_id"]),
                            body=action["body"], extra_event_details=marker)
        target_flag_id = watch.watch_flag_id or int(action["flag_id"])
    else:
        raise BadRequestError(f"unknown action kind {kind!r}")
    target = service.get_flag(db, target_flag_id)
    service._audit(db, target, watch.created_by, "watch_fired", details=marker)
    service._commit_and_emit(db)


def run_watch_poll(db: Session, *, now: Optional[datetime] = None) -> int:
    """Evaluate every armed watch once; fire the matches; return the fire count.

    Pure + injectable — no scheduler, no sleeps, opens no Session (the caller
    owns it) — so slice-§12 tests drive it directly with a fake `state` seam.
    Each watch is re-fetched by id and re-checked `armed` inside the loop so a
    `rollback()` in one iteration never acts on stale batch-loaded rows; a
    per-watch try/except isolates one poison watch from the rest."""
    _ = now  # v1 conditions are state-only; `now` reserved for future time conds
    armed_ids = list(db.execute(
        select(FlagEntityWatch.id)
        .where(FlagEntityWatch.status == "armed")
        .order_by(FlagEntityWatch.id.asc())).scalars().all())
    fired = 0
    for wid in armed_ids:
        try:
            watch = db.get(FlagEntityWatch, wid)
            if watch is None or watch.status != "armed":
                continue
            if not _condition_met(db, watch):
                continue
            _fire(db, watch)
            fired += 1
        except Exception:  # noqa: BLE001 — isolate one poison watch
            db.rollback()
            log.warning("flag_watch_fire_failed watch_id=%s", wid, exc_info=True)
    return fired


def _watch_poll_job() -> None:
    """Scheduler entry point: open a Session, run one poll pass, close it. Thin
    wrapper so `run_watch_poll` stays Session-injectable + test-friendly (§12).
    Jobs run in the scheduler's threadpool (sync DB)."""
    from database import SessionLocal
    db = SessionLocal()
    try:
        run_watch_poll(db)
    finally:
        db.close()


def register_watch_jobs() -> None:
    """Register the ~2-min watch poller on the Slice-5 scheduler.

    ⚠️ CONTENT ANCHOR — the scheduler registry API is defined by Slice 5
    (`feat/flag-p2-slack2`, spec §8: registry of `(name, interval, fn)`, jitter,
    a `flag_scheduler_runs` per-job lock). This slice branches off Slice 5, so by
    build time `backend/flags/scheduler.py` EXISTS: OPEN it and match the REAL
    `register_job` signature — the kwarg name (`interval_seconds` here vs a
    cron-like string) and whether `fn` is zero-arg (assumed) MAY differ.
    Reconcile ONLY this one call; `run_watch_poll`/`_fire` are API-independent."""
    from flags import scheduler
    scheduler.register_job("flag_watch_poller", interval_seconds=120,
                           fn=_watch_poll_job)
```

- [ ] **Step 4: Wire `lifespan`.** In `backend/main.py`'s `lifespan` (~line 329, near `register_mk1_entities()`), register the poller. **CONTENT ANCHOR:** the scheduler must be STARTED by Slice 5 first — grep `scheduler` in `lifespan` to find where Slice 5 wired its digest/recurring jobs and register the watch poller ALONGSIDE them (order-independent among jobs). Assumed line:

```python
    from flags import watches as _flag_watches
    _flag_watches.register_watch_jobs()
```

If Slice 5's scheduler start is NOT yet present on this branch (slices merged out of order), leave a `# TODO(slice5): register_watch_jobs() once the scheduler lifespan lands` and rely on the Task-5 unit tests — `run_watch_poll` is fully exercised without the scheduler.

- [ ] **Step 5: Run — PASS**; full flag suite: no new failures.
- [ ] **Step 6: Commit** — `git commit -m "feat(flags): watch poller (run_watch_poll + scheduler job)"`

---

### Task 6: Routes — `POST`/`GET`/`DELETE /api/flags/watches` + schemas

**Files:**
- Modify: `backend/flags/schemas.py` (`WatchConditionModel`, `WatchActionModel`, `ArmWatchRequest`, `WatchResponse`), `backend/flags/routes.py` (3 routes + imports)
- Test: `backend/tests/test_flags_watch_routes.py` (create; mirror the `client` fixture in `backend/tests/test_flags_routes.py`)

**Interfaces:**
- Produces: `POST /api/flags/watches` (arm; 201 `WatchResponse`; validates entity registered + has state seam + condition/action shape), `GET /api/flags/watches?flag_id=` (armed watches for a thread; 200 `List[WatchResponse]`), `DELETE /api/flags/watches/{watch_id}` (cancel; 204; creator or admin). **All three literal `/watches*` routes MUST be registered ABOVE `@router.get("/{flag_id}")`** (the file's literal-before-param rule — same reason `/types`, `/activity`, `/entity-types` sit above it).

- [ ] **Step 1: Failing test**

```python
# reuse the `client` fixture verbatim from backend/tests/test_flags_routes.py
def test_arm_list_cancel_via_api(client):
    # seed a watchable sample through the shared session
    from models import LimsSample
    client.db.add(LimsSample(sample_id="PB-0102", status="new")); client.db.commit()
    f = client.post("/api/flags", json={"entity_type": "sample", "entity_id": "PB-0102",
                                        "type": "blocker", "title": "t"}).json()
    r = client.post("/api/flags/watches", json={
        "entity_type": "sample", "entity_id": "PB-0102",
        "condition": {"field": "state", "equals": "received"},
        "action": {"kind": "comment", "flag_id": f["id"], "body": "arrived"},
        "watch_flag_id": f["id"]})
    assert r.status_code == 201, r.text
    wid = r.json()["id"]
    assert r.json()["status"] == "armed"
    lst = client.get(f"/api/flags/watches?flag_id={f['id']}").json()
    assert [w["id"] for w in lst] == [wid]
    assert client.delete(f"/api/flags/watches/{wid}").status_code == 204
    assert client.get(f"/api/flags/watches?flag_id={f['id']}").json() == []


def test_arm_on_unwatchable_type_400(client):
    r = client.post("/api/flags/watches", json={
        "entity_type": "sub_sample", "entity_id": "9",
        "condition": {"field": "state", "equals": "received"},
        "action": {"kind": "create_flag", "type": "blocker", "title": "x"}})
    assert r.status_code == 400, r.text
```

- [ ] **Step 2: Run — FAIL** (404 — routes missing).
Run: `python -m pytest backend/tests/test_flags_watch_routes.py -q`

- [ ] **Step 3: Implement.** `schemas.py` (append):

```python
class WatchConditionModel(BaseModel):
    field: Literal["state"]
    equals: str


class WatchActionModel(BaseModel):
    kind: Literal["create_flag", "comment"]
    # create_flag
    type: Optional[str] = None
    title: Optional[str] = None
    assignee_id: Optional[int] = None
    # comment
    flag_id: Optional[int] = None
    body: Optional[str] = None


class ArmWatchRequest(BaseModel):
    entity_type: str
    entity_id: str
    condition: WatchConditionModel
    action: WatchActionModel
    watch_flag_id: Optional[int] = None


class WatchResponse(BaseModel):
    id: int
    entity_type: str
    entity_id: str
    condition: dict
    action: dict
    created_by: int
    watch_flag_id: Optional[int] = None
    status: str
    created_at: datetime
    fired_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)
```

`routes.py` — add `watches` to the `from flags import ...` line and `ArmWatchRequest, WatchResponse` to the schemas import. Insert the three routes **directly after the `/entity-types` route and before `@router.get("/{flag_id}")`**:

```python
# --- state-change watches (Plan 6) --------------------------------------
# Literal `/watches*` routes ABOVE `/{flag_id}` so they win the match.
@router.post("/watches", response_model=WatchResponse, status_code=201)
def arm_watch(req: ArmWatchRequest, db: Session = Depends(get_db),
              user=Depends(get_current_user)):
    try:
        w = watches.arm_watch(
            db, user=user, entity_type=req.entity_type, entity_id=req.entity_id,
            condition=req.condition.model_dump(),
            action=req.action.model_dump(exclude_none=True),
            watch_flag_id=req.watch_flag_id)
        return WatchResponse.model_validate(w)
    except Exception as e:
        raise _http(e)


@router.get("/watches", response_model=List[WatchResponse])
def list_watches(flag_id: Optional[int] = None, db: Session = Depends(get_db),
                 user=Depends(get_current_user)):
    try:
        return [WatchResponse.model_validate(w)
                for w in watches.list_watches(db, flag_id=flag_id)]
    except Exception as e:
        raise _http(e)


@router.delete("/watches/{watch_id}", status_code=204)
def cancel_watch(watch_id: int, db: Session = Depends(get_db),
                 user=Depends(get_current_user)):
    try:
        watches.cancel_watch(db, user=user, watch_id=watch_id)
    except Exception as e:
        raise _http(e)
```

- [ ] **Step 4: Run — PASS**; full flag suite: no new failures.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): watch arm/list/cancel routes"`

---

### Task 7: Frontend — API mirrors + hooks + watchable-types constant

**Files:**
- Modify: `src/lib/flags-api.ts` (`EntityWatch`, `ArmWatchBody`, `armWatch`/`cancelWatch`/`listWatches`), `src/hooks/use-flags.ts` (`flagKeys.watches`, `useFlagWatches`, `useArmWatch`, `useCancelWatch`), `src/components/flags/flag-entity.ts` (`WATCHABLE_ENTITY_TYPES`)
- Test: `src/components/flags/__tests__/flag-watches-api.test.ts` (create; light — key shape + watchable guard)

**Interfaces:**
- Produces: TS mirror `EntityWatch` (of `WatchResponse`); `armWatch(body)`/`cancelWatch(id)`/`listWatches(flagId)`; `flagKeys.watches(flagId) = ['flags','watches',flagId]` (under `['flags']` so the SSE glue's blanket invalidate refreshes it live); `useFlagWatches`/`useArmWatch(flagId?)`/`useCancelWatch(flagId?)`; `WATCHABLE_ENTITY_TYPES: ReadonlySet<string>` = `new Set(['sample'])` (mirrors the backend `state=` seam registrations — Tasks 8/9 gate their affordances on it).

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { flagKeys } from '@/hooks/use-flags'
import { WATCHABLE_ENTITY_TYPES } from '@/components/flags/flag-entity'

describe('watch api wiring', () => {
  it('watches key nests under [flags] for blanket invalidation', () => {
    expect(flagKeys.watches(12)).toEqual(['flags', 'watches', 12])
  })
  it('sample is watchable, vials/worksheets are not', () => {
    expect(WATCHABLE_ENTITY_TYPES.has('sample')).toBe(true)
    expect(WATCHABLE_ENTITY_TYPES.has('sub_sample')).toBe(false)
  })
})
```

- [ ] **Step 2: Run — FAIL** (missing exports).

- [ ] **Step 3: Implement.** `flags-api.ts` (append after the watcher endpoints):

```ts
// --- state-change watches (Plan 6) --------------------------------------

/** Mirrors `WatchResponse`. `condition`/`action` are the stored JSON blobs. */
export interface EntityWatch {
  id: number
  entity_type: string
  entity_id: string
  condition: { field: 'state'; equals: string }
  action:
    | { kind: 'create_flag'; type?: string; title?: string; assignee_id?: number | null }
    | { kind: 'comment'; flag_id?: number; body?: string }
  created_by: number
  watch_flag_id: number | null
  status: 'armed' | 'fired' | 'cancelled'
  created_at: string
  fired_at: string | null
}

/** Mirrors `ArmWatchRequest`. */
export interface ArmWatchBody {
  entity_type: string
  entity_id: string
  condition: { field: 'state'; equals: string }
  action: EntityWatch['action']
  watch_flag_id?: number | null
}

/** `POST /api/flags/watches` — arm a watch (comment-on-fire with `watch_flag_id`,
 *  else create-flag-on-fire). 400 when the entity type has no watchable state. */
export const armWatch = (body: ArmWatchBody) =>
  apiFetch<EntityWatch>('/api/flags/watches', {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** `DELETE /api/flags/watches/{id}` — cancel an armed watch (204). */
export const cancelWatch = (id: number) =>
  apiFetch<undefined>(`/api/flags/watches/${id}`, { method: 'DELETE' })

/** `GET /api/flags/watches?flag_id=` — armed watches on a thread. */
export const listWatches = (flagId: number) =>
  apiFetch<EntityWatch[]>(`/api/flags/watches?flag_id=${flagId}`)
```

`flag-entity.ts` (add near `ENTITY_META`):

```ts
/** Entity types with a backend `state` seam (→ watchable). Mirror of the
 *  `state=` registrations in backend/flags/seams.py `register_mk1_entities`.
 *  Update both together if another type opts in. */
export const WATCHABLE_ENTITY_TYPES: ReadonlySet<string> = new Set(['sample'])
```

`use-flags.ts` — extend the imports from `flags-api` with `armWatch, cancelWatch, listWatches, type ArmWatchBody`; add the key + hooks:

```ts
// in flagKeys:
  watches: (flagId: number) => ['flags', 'watches', flagId] as const,
```

```ts
/** Armed watches on one thread. Under ['flags', …] for live blanket-invalidate. */
export function useFlagWatches(flagId: number | null) {
  return useQuery({
    queryKey: flagKeys.watches(flagId ?? -1),
    queryFn: () => listWatches(flagId as number),
    enabled: flagId != null,
    staleTime: 5_000,
  })
}

/** Arm a watch → refresh the thread's watch chips + its detail. */
export function useArmWatch(flagId?: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ArmWatchBody) => armWatch(body),
    onSuccess: () => {
      if (flagId != null) {
        qc.invalidateQueries({ queryKey: flagKeys.watches(flagId) })
        qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) })
      }
    },
  })
}

/** Cancel a watch → same refresh. */
export function useCancelWatch(flagId?: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => cancelWatch(id),
    onSuccess: () => {
      if (flagId != null) {
        qc.invalidateQueries({ queryKey: flagKeys.watches(flagId) })
        qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) })
      }
    },
  })
}
```

- [ ] **Step 4: Run — PASS** + `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): watch API client + hooks"`

---

### Task 8: Frontend — thread watch affordance + armed-watch chip row

**Files:**
- Create: `src/components/flags/FlagWatchChips.tsx`
- Modify: `src/components/flags/FlagThread.tsx` (mount)
- Test: `src/components/flags/__tests__/FlagWatchChips.test.tsx` (create)

**Interfaces:**
- Consumes: `useFlagWatches`/`useArmWatch`/`useCancelWatch`, `WATCHABLE_ENTITY_TYPES`, `entityLabel`.
- Produces: `<FlagWatchChips flagId entityType entityId />`. When `entityType` is watchable: renders each armed watch as a cancellable chip (`⏱ waiting: {label} → {equals}`, ✕ removes) and a "＋ Watch for state…" toggler → an inline free-text state Input (placeholder `received`) + Arm; arming posts a `comment`-on-fire watch tied to `watch_flag_id = flagId`. When `entityType` is not watchable (vial/worksheet/general), renders **nothing** (the anchor can't be watched — no dead affordance). Backend 400s surface as inline error text.

- [ ] **Step 1: Failing test**

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FlagWatchChips } from '@/components/flags/FlagWatchChips'

const api = vi.hoisted(() => ({
  listWatches: vi.fn(),
  armWatch: vi.fn().mockResolvedValue({ id: 5 }),
  cancelWatch: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/flags-api', async orig => ({ ...(await orig()), ...api }))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('FlagWatchChips', () => {
  it('renders nothing for an unwatchable anchor', () => {
    api.listWatches.mockResolvedValue([])
    const { container } = render(wrap(
      <FlagWatchChips flagId={1} entityType="sub_sample" entityId="9" />))
    expect(container).toBeEmptyDOMElement()
  })

  it('lists an armed watch and cancels it', async () => {
    api.listWatches.mockResolvedValue([
      { id: 5, entity_type: 'sample', entity_id: 'PB-0102', status: 'armed',
        condition: { field: 'state', equals: 'received' },
        action: { kind: 'comment', flag_id: 1 }, watch_flag_id: 1,
        created_by: 1, created_at: '', fired_at: null },
    ])
    render(wrap(<FlagWatchChips flagId={1} entityType="sample" entityId="PB-0102" />))
    expect(await screen.findByText(/received/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /cancel watch/i }))
    await waitFor(() => expect(api.cancelWatch).toHaveBeenCalledWith(5))
  })

  it('arms a comment-on-fire watch tied to this flag', async () => {
    api.listWatches.mockResolvedValue([])
    render(wrap(<FlagWatchChips flagId={1} entityType="sample" entityId="PB-0102" />))
    fireEvent.click(await screen.findByRole('button', { name: /watch for state/i }))
    fireEvent.change(screen.getByPlaceholderText('received'),
      { target: { value: 'received' } })
    fireEvent.click(screen.getByRole('button', { name: /^arm$/i }))
    await waitFor(() => expect(api.armWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'sample', entity_id: 'PB-0102', watch_flag_id: 1,
        condition: { field: 'state', equals: 'received' },
        action: expect.objectContaining({ kind: 'comment', flag_id: 1 }),
      })))
  })
})
```

- [ ] **Step 2: Run — FAIL** (component missing).

- [ ] **Step 3: Implement** `FlagWatchChips.tsx`:

```tsx
/**
 * State-change watches on a flag's anchor entity, rendered in the thread.
 * Armed watches show as cancellable "⏱ waiting: PB-0102 → received" chips; a
 * small inline form arms a new comment-on-fire watch (posts a comment to THIS
 * flag when the entity reaches the typed state). Renders nothing when the
 * anchor entity type has no backend `state` seam (spec §9 — unwatchable).
 */
import { useState } from 'react'
import { Clock, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useFlagWatches, useArmWatch, useCancelWatch } from '@/hooks/use-flags'
import { WATCHABLE_ENTITY_TYPES, entityLabel } from '@/components/flags/flag-entity'

export function FlagWatchChips({
  flagId, entityType, entityId,
}: {
  flagId: number
  entityType: string | null
  entityId: string | null
}) {
  const watchable = !!entityType && WATCHABLE_ENTITY_TYPES.has(entityType)
  const { data: watches } = useFlagWatches(watchable ? flagId : null)
  const arm = useArmWatch(flagId)
  const cancel = useCancelWatch(flagId)
  const [adding, setAdding] = useState(false)
  const [equals, setEquals] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!watchable || !entityType || !entityId) return null
  const label = entityLabel(entityType, entityId)

  const submit = () => {
    const value = equals.trim()
    if (!value) return
    setError(null)
    arm.mutate(
      {
        entity_type: entityType,
        entity_id: entityId,
        condition: { field: 'state', equals: value },
        action: {
          kind: 'comment',
          flag_id: flagId,
          body: `⏱ ${label} reached "${value}".`,
        },
        watch_flag_id: flagId,
      },
      {
        onSuccess: () => { setEquals(''); setAdding(false) },
        onError: e =>
          setError(e instanceof Error ? e.message : 'Could not arm watch'),
      }
    )
  }

  const armed = watches ?? []
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {armed.map(w => (
        <span
          key={w.id}
          className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5"
        >
          <Clock className="h-3 w-3" />
          waiting: {label} → {w.condition.equals}
          <button
            type="button"
            aria-label="Cancel watch"
            className="hover:text-destructive"
            onClick={() => cancel.mutate(w.id)}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {adding ? (
        <span className="inline-flex items-center gap-1">
          <Input
            autoFocus
            value={equals}
            onChange={e => setEquals(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="received"
            className="h-6 w-28 text-xs"
          />
          <Button size="sm" className="h-6 px-2 text-xs" disabled={arm.isPending}
            onClick={submit}>
            Arm
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs"
            onClick={() => { setAdding(false); setError(null) }}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs"
          onClick={() => setAdding(true)}>
          <Plus className="h-3 w-3" /> Watch for state…
        </Button>
      )}
      {error && <span className="text-destructive">{error}</span>}
    </div>
  )
}
```

`FlagThread.tsx` — mount it in the header, directly below the Slice-2 `<FlagLinkChips>` row (**CONTENT ANCHOR:** if slices landed out of order and that row isn't present, mount below the Slice-1 watcher row; else below the status/assignee controls `~line 346`):

```tsx
<FlagWatchChips flagId={flag.id} entityType={flag.entity_type} entityId={flag.entity_id} />
```

(import `FlagWatchChips`; `flag.entity_type`/`entity_id` are nullable since Slice 2 — the component guards.)

- [ ] **Step 4: Run — PASS** + `npx vitest run src/components/flags` (flag suite baseline + new) + tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): thread watch chips (arm/cancel state watches)"`

---

### Task 9: Frontend — EntityFlagButton "Watch for state change" (standalone → create_flag)

**Files:**
- Create: `src/components/flags/WatchStateButton.tsx`
- Modify: `src/components/flags/EntityFlagButton.tsx` (render alongside the flag affordances)
- Test: `src/components/flags/__tests__/WatchStateButton.test.tsx` (create)

**Interfaces:**
- Consumes: `useArmWatch` (no flagId — standalone, nothing to invalidate), `useFlagUsers`, `WATCHABLE_ENTITY_TYPES`, shadcn `Popover`.
- Produces: `<WatchStateButton entityType entityId targetLabel />` — a clock-icon popover that arms a **standalone** watch (no `watch_flag_id`) whose action is `create_flag` (type `task`, free-text title defaulting to `"{label} reached {state}"`, optional assignee). Rendered by `EntityFlagButton` ONLY when `WATCHABLE_ENTITY_TYPES.has(entityType)`. State value input is free-text (placeholder `received`; the seam's domain is host-defined — no enum).

- [ ] **Step 1: Failing test**

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WatchStateButton } from '@/components/flags/WatchStateButton'

const api = vi.hoisted(() => ({ armWatch: vi.fn().mockResolvedValue({ id: 9 }) }))
vi.mock('@/lib/flags-api', async orig => ({ ...(await orig()), ...api }))
vi.mock('@/lib/api', async orig => ({
  ...(await orig()),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
}))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('WatchStateButton', () => {
  it('arms a standalone create_flag watch (no watch_flag_id)', async () => {
    render(wrap(<WatchStateButton entityType="sample" entityId="PB-0102"
      targetLabel="PB-0102" />))
    fireEvent.click(screen.getByRole('button', { name: /watch for state change/i }))
    fireEvent.change(await screen.findByPlaceholderText('received'),
      { target: { value: 'received' } })
    fireEvent.click(screen.getByRole('button', { name: /^arm$/i }))
    await waitFor(() => expect(api.armWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'sample', entity_id: 'PB-0102',
        condition: { field: 'state', equals: 'received' },
        action: expect.objectContaining({ kind: 'create_flag', type: 'task' }),
      })))
    const body = api.armWatch.mock.calls[0][0]
    expect('watch_flag_id' in body ? body.watch_flag_id : null).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run — FAIL** (component missing).

- [ ] **Step 3: Implement** `WatchStateButton.tsx` (use the shadcn `Popover` idiom already in the tree — mirror an existing popover import; assignee Select reuses `useFlagUsers`/`displayName` like `FlagsFilterBar`):

```tsx
/**
 * "Watch for state change" affordance on an entity page. Arms a STANDALONE
 * watch (no flag yet) that mints a Task flag when the entity reaches the typed
 * state. Only rendered for entity types with a backend `state` seam. Free-text
 * state value — the seam's domain is host-defined (spec §9).
 */
import { useState } from 'react'
import { Clock } from 'lucide-react'
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useArmWatch } from '@/hooks/use-flags'
import { useFlagUsers } from '@/components/flags/flag-users'
import { displayName } from '@/lib/user-display'

export function WatchStateButton({
  entityType, entityId, targetLabel,
}: {
  entityType: string
  entityId: string
  targetLabel: string
}) {
  const arm = useArmWatch()
  const users = useFlagUsers()
  const [open, setOpen] = useState(false)
  const [equals, setEquals] = useState('')
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState<string>('none')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const value = equals.trim()
    if (!value) return
    setError(null)
    arm.mutate(
      {
        entity_type: entityType,
        entity_id: entityId,
        condition: { field: 'state', equals: value },
        action: {
          kind: 'create_flag',
          type: 'task',
          title: title.trim() || `${targetLabel} reached ${value}`,
          assignee_id: assignee === 'none' ? null : Number(assignee),
        },
      },
      {
        onSuccess: () => {
          setOpen(false); setEquals(''); setTitle(''); setAssignee('none')
        },
        onError: e =>
          setError(e instanceof Error ? e.message : 'Could not arm watch'),
      }
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Watch for state change"
          title="Watch for state change" className="gap-1.5 text-muted-foreground">
          <Clock className="h-3.5 w-3.5" /> Watch
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2">
        <p className="text-xs font-semibold">Watch {targetLabel} for a state change</p>
        <div className="space-y-1">
          <Label htmlFor="watch-state" className="text-xs">When state equals</Label>
          <Input id="watch-state" value={equals} placeholder="received"
            onChange={e => setEquals(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="watch-title" className="text-xs">Create task titled (optional)</Label>
          <Input id="watch-title" value={title}
            placeholder={`${targetLabel} reached ${equals || '…'}`}
            onChange={e => setTitle(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Assign to (optional)</Label>
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger size="sm" className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Unassigned</SelectItem>
              {[...users.values()]
                .sort((a, b) => displayName(a).localeCompare(displayName(b)))
                .map(u => (
                  <SelectItem key={u.id} value={String(u.id)}>{displayName(u)}</SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" className="h-7 text-xs"
            onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" className="h-7 text-xs" disabled={arm.isPending || !equals.trim()}
            onClick={submit}>Arm</Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
```

`EntityFlagButton.tsx` — render it next to the existing affordances (both the unflagged outline button and the flagged pill), gated on watchability. Add the import + a top-of-component const, then include `{watchable && <WatchStateButton entityType={entityType} entityId={entityId} targetLabel={entityLabel(entityType, entityId)} />}` in each return branch (wrap the unflagged branch's `<RaiseFlagButton>` and the new button in a `<span className="inline-flex items-center gap-1">` so layout stays tidy):

```tsx
import { WatchStateButton } from '@/components/flags/WatchStateButton'
import { WATCHABLE_ENTITY_TYPES } from '@/components/flags/flag-entity'
// inside the component, before the returns:
const watchable = WATCHABLE_ENTITY_TYPES.has(entityType)
```

- [ ] **Step 4: Run — PASS** + `npx vitest run src/components/flags` + tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): entity 'watch for state change' affordance"`

---

### Task 10: Slice gates

- [ ] **Step 1:** `npm run check:all` — typecheck, lint, ast:lint, format, rust, tests. Green except the documented baseline (compare the failure SET to baseline, not the count).
- [ ] **Step 2:** `npm run build` — succeeds.
- [ ] **Step 3:** `python -m pytest backend/tests -q` — failure set matches the ~19 known baseline (no NEW failures). Spot-check the new files: `python -m pytest backend/tests/test_flags_watches.py backend/tests/test_flags_watch_seam.py backend/tests/test_flags_watch_poller.py backend/tests/test_flags_watch_routes.py -q`.
- [ ] **Step 4:** Final commit for any straggler formatting: `git commit -am "chore(flags): slice 6 gates"`. **STOP — do NOT push or open a PR.** The orchestrator reviews (and reconciles the Task-5 scheduler CONTENT ANCHOR against the real Slice-5 `register_job` API) before integration.
