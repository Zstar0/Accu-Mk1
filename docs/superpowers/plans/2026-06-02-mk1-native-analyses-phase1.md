# Mk1-Native Analyses Phase 1 — Schema + State Machine + Transition API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the foundation that every later phase depends on — the `lims_analyses` + `lims_analysis_transitions` tables, their ORM models, a pure state-machine validator, a service layer that creates analyses and applies transitions (with audit-log writes), Pydantic schemas, and a REST router that exposes the transitions for Phase 2/3 to call. No Receive Wizard changes, no worksheet changes, no UI changes. Zero risk to existing flows.

**Architecture:** New package `backend/lims_analyses/` mirroring the `sub_samples/` layout (`__init__.py`, `state_machine.py`, `service.py`, `schemas.py`, `routes.py`). Pure state-machine module owns the allowed-transitions table; service layer wraps DB writes + audit; routes are thin HTTP shells. Two new tables added to `_run_migrations()` as plain SQL strings. No SENAITE round-trips at all in this phase.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres (Accu-Mk1 backend), pytest. No frontend.

**Spec:** `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md`

**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`).

**Out of scope for this plan:**
- Receive Wizard backend swap — Phase 2 of the broader spec.
- Worksheet routing (`worksheet_items.lims_analysis_id`) — Phase 3.
- `AnalysisTable.tsx` adapter — Phase 3.
- COA resolver `_gather_candidates_for` swap — Phase 4.
- Family-state derivation, WP signaling, prelim-COA opt-in — Phases 4-5.
- Retest UI; data model carries `retest_of_id` but no UI work here.
- Photo storage decision (Open Question 3 in the spec); not touched in Phase 1.

**How to run tests:**
- Unit + service: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Full suite: same harness, no `-m` flag. Baseline failures from the current handoff stay unchanged.

---

## File Structure

**Backend (new):**
- `backend/lims_analyses/__init__.py` — package marker.
- `backend/lims_analyses/state_machine.py` — pure functions: `allowed_transitions(from_state)`, `apply_transition(from_state, kind) → to_state`, exception types.
- `backend/lims_analyses/service.py` — DB-aware helpers: `create_analysis`, `get_analysis`, `list_analyses_for_host`, `apply_transition_to_analysis`, `set_reportable`. Writes audit rows.
- `backend/lims_analyses/schemas.py` — Pydantic request/response models.
- `backend/lims_analyses/routes.py` — `APIRouter(prefix="/api/lims-analyses")` with GET / POST transition / PATCH reportable endpoints.
- `backend/tests/test_lims_analyses_state_machine.py` — pure state-machine unit tests (no DB).
- `backend/tests/test_lims_analyses_service.py` — service-layer integration tests against the real DB.
- `backend/tests/test_lims_analyses_routes.py` — HTTP-level tests via FastAPI TestClient.

**Backend (modified):**
- `backend/database.py` — append two `CREATE TABLE IF NOT EXISTS` statements to `_run_migrations()`.
- `backend/models.py` — add `LimsAnalysis` + `LimsAnalysisTransition` ORM classes.
- `backend/main.py` — import + mount the new router.

---

## Task 1: DB migrations — `lims_analyses` + `lims_analysis_transitions`

**Files:**
- Modify: `backend/database.py`

- [ ] **Step 1: Append the two table creations to `_run_migrations()` migrations list**

Append at the end of the list (just before the closing `]` on line 424, after the `analysis_reportable` table from the COA roll-up Phase 1):

```python
# ── Mk1-native analyses (spec 2026-06-02-mk1-native-analyses-design.md) ──
# Polymorphic host: each row belongs to either a parent (lims_sample_pk) or
# a sub-sample (lims_sub_sample_pk), enforced by CHECK + the partial unique
# indexes below. Service identity is denormalized for fast filtering.
"""
CREATE TABLE IF NOT EXISTS lims_analyses (
    id                    SERIAL PRIMARY KEY,
    lims_sample_pk        INTEGER REFERENCES lims_samples(id) ON DELETE CASCADE,
    lims_sub_sample_pk    INTEGER REFERENCES lims_sub_samples(id) ON DELETE CASCADE,
    CHECK ((lims_sample_pk IS NULL) <> (lims_sub_sample_pk IS NULL)),

    analysis_service_id   INTEGER NOT NULL REFERENCES analysis_services(id) ON DELETE RESTRICT,
    keyword               TEXT NOT NULL,
    title                 TEXT NOT NULL,

    result_value          TEXT,
    result_unit           TEXT,

    review_state          TEXT NOT NULL DEFAULT 'unassigned'
                          CHECK (review_state IN (
                              'unassigned', 'assigned', 'to_be_verified',
                              'verified', 'published', 'rejected', 'retracted'
                          )),

    method_id             INTEGER REFERENCES hplc_methods(id) ON DELETE SET NULL,
    instrument_id         INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    analyst_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,

    captured_at           TIMESTAMP,
    submitted_at          TIMESTAMP,
    verified_at           TIMESTAMP,
    published_at          TIMESTAMP,

    retested              BOOLEAN NOT NULL DEFAULT FALSE,
    retest_of_id          INTEGER REFERENCES lims_analyses(id) ON DELETE SET NULL,

    reportable            BOOLEAN NOT NULL DEFAULT TRUE,
    reportable_reason     TEXT,

    created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
)
""",
"CREATE INDEX IF NOT EXISTS ix_lims_analyses_sample        ON lims_analyses (lims_sample_pk)",
"CREATE INDEX IF NOT EXISTS ix_lims_analyses_sub_sample    ON lims_analyses (lims_sub_sample_pk)",
"CREATE INDEX IF NOT EXISTS ix_lims_analyses_keyword       ON lims_analyses (keyword)",
"CREATE INDEX IF NOT EXISTS ix_lims_analyses_review_state  ON lims_analyses (review_state)",
# One non-retest row per (host, keyword). Retests share keyword but
# are linked via retest_of_id and excluded from the uniqueness check
# via the partial index predicate.
"""
CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_sub_service_root
    ON lims_analyses (lims_sub_sample_pk, keyword)
    WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL
""",
"""
CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_parent_service_root
    ON lims_analyses (lims_sample_pk, keyword)
    WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
""",
# Per-transition audit log. Every state change writes a row.
"""
CREATE TABLE IF NOT EXISTS lims_analysis_transitions (
    id                SERIAL PRIMARY KEY,
    analysis_id       INTEGER NOT NULL REFERENCES lims_analyses(id) ON DELETE CASCADE,
    from_state        TEXT,
    to_state          TEXT NOT NULL,
    transition_kind   TEXT NOT NULL
                      CHECK (transition_kind IN
                          ('assign','submit','verify','retract','reject',
                           'retest','publish','reset','auto')),
    user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason            TEXT,
    occurred_at       TIMESTAMP NOT NULL DEFAULT NOW()
)
""",
"CREATE INDEX IF NOT EXISTS ix_lims_analysis_transitions_analysis ON lims_analysis_transitions (analysis_id)",
```

- [ ] **Step 2: Restart backend so migrations run**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend
until curl -s http://localhost:5530/health >/dev/null 2>&1; do sleep 2; done
curl -s http://localhost:5530/health
```

Expected: `{"status":"ok",...}`.

- [ ] **Step 3: Verify both tables + indexes exist**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from sqlalchemy import text
from database import engine
with engine.connect() as c:
    for table in ('lims_analyses', 'lims_analysis_transitions'):
        r = c.execute(text('SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = :t ORDER BY ordinal_position'), {'t': table})
        cols = list(r)
        print(f'=== {table} ({len(cols)} cols) ===')
        for col in cols:
            print(f'  {col.column_name:30s} {col.data_type:25s} nullable={col.is_nullable}')
    r = c.execute(text(\"SELECT indexname FROM pg_indexes WHERE tablename IN ('lims_analyses','lims_analysis_transitions') ORDER BY indexname\"))
    print('--- indexes ---')
    for row in r:
        print(' ', row.indexname)
"
```

Expected:
- `lims_analyses` has 21 columns.
- `lims_analysis_transitions` has 7 columns.
- 6 indexes including `uq_lims_analyses_sub_service_root` and `uq_lims_analyses_parent_service_root`.

- [ ] **Step 4: Verify the CHECK constraint and partial unique indexes work**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from sqlalchemy import text
from database import engine
with engine.connect() as c:
    # Find an analysis_service to use as FK
    asid = c.execute(text(\"SELECT id, keyword, title FROM analysis_services WHERE keyword IS NOT NULL LIMIT 1\")).first()
    assert asid is not None, 'no analysis_services row available — seed first'
    print(f'using analysis_service id={asid.id} keyword={asid.keyword}')
    # Find a lims_sub_sample to use as host
    sub = c.execute(text(\"SELECT id, sample_id FROM lims_sub_samples LIMIT 1\")).first()
    assert sub is not None, 'no lims_sub_samples row available — seed via Receive Wizard first'
    print(f'using lims_sub_sample id={sub.id} sample_id={sub.sample_id}')
    # Polymorphic CHECK: both null must fail
    try:
        c.execute(text('INSERT INTO lims_analyses (analysis_service_id, keyword, title) VALUES (:asid, :kw, :t)'),
                  {'asid': asid.id, 'kw': asid.keyword, 't': asid.title})
        c.commit()
        print('FAIL: insert with both NULL hosts should have raised')
    except Exception as e:
        c.rollback()
        print('OK: both-null CHECK fired ->', type(e).__name__)
    # Polymorphic CHECK: both non-null must also fail
    parent = c.execute(text(\"SELECT id FROM lims_samples LIMIT 1\")).first()
    try:
        c.execute(text('INSERT INTO lims_analyses (lims_sample_pk, lims_sub_sample_pk, analysis_service_id, keyword, title) VALUES (:p, :s, :asid, :kw, :t)'),
                  {'p': parent.id, 's': sub.id, 'asid': asid.id, 'kw': asid.keyword, 't': asid.title})
        c.commit()
        print('FAIL: insert with both non-NULL hosts should have raised')
    except Exception as e:
        c.rollback()
        print('OK: both-non-null CHECK fired ->', type(e).__name__)
    # Cleanup any test inserts in case the second one was the failing one
    c.execute(text('DELETE FROM lims_analyses WHERE lims_sample_pk IS NULL AND lims_sub_sample_pk IS NULL'))
    c.commit()
"
```

Expected: both `OK:` lines, no `FAIL:`. The Mk1 `analysis_services` table is seeded from SENAITE on first start — must be present.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/database.py
git commit -m "feat(mk1): add lims_analyses + lims_analysis_transitions tables"
```

---

## Task 2: ORM models

**Files:**
- Modify: `backend/models.py`

- [ ] **Step 1: Append `LimsAnalysis` ORM class at the end of `backend/models.py`**

After the existing `AnalysisReportable` class:

```python
# ── Mk1-native analyses (spec 2026-06-02-mk1-native-analyses-design.md) ──


class LimsAnalysis(Base):
    """
    Mk1-owned analysis instance. Polymorphic host: belongs to either a
    parent (lims_sample_pk) or a sub-sample (lims_sub_sample_pk) — CHECK
    constraint at the DB layer enforces exactly-one.

    Sub-sample analyses live entirely in Mk1 (no SENAITE round-trip).
    Parent analyses will migrate here in a future phase; today they
    still live in SENAITE.
    """

    __tablename__ = "lims_analyses"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    lims_sample_pk: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("lims_samples.id", ondelete="CASCADE"), nullable=True
    )
    lims_sub_sample_pk: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("lims_sub_samples.id", ondelete="CASCADE"), nullable=True
    )

    analysis_service_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("analysis_services.id"), nullable=False
    )
    keyword: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)

    result_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    result_unit: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    review_state: Mapped[str] = mapped_column(
        Text, nullable=False, default="unassigned", server_default="unassigned",
        index=True,
    )

    method_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("hplc_methods.id"), nullable=True
    )
    instrument_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("instruments.id"), nullable=True
    )
    analyst_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )

    captured_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    retested: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    retest_of_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("lims_analyses.id"), nullable=True
    )

    reportable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    reportable_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )

    transitions: Mapped[list["LimsAnalysisTransition"]] = relationship(
        "LimsAnalysisTransition",
        back_populates="analysis",
        cascade="all, delete-orphan",
        order_by="LimsAnalysisTransition.occurred_at",
    )

    def __repr__(self) -> str:
        host = (
            f"parent_pk={self.lims_sample_pk}" if self.lims_sample_pk is not None
            else f"sub_pk={self.lims_sub_sample_pk}"
        )
        return (
            f"<LimsAnalysis(id={self.id}, {host}, "
            f"kw={self.keyword!r}, state={self.review_state})>"
        )


class LimsAnalysisTransition(Base):
    """
    One row per state change on a LimsAnalysis. Append-only audit log.

    transition_kind tracks the verb that caused the state change (assign,
    submit, verify, retract, reject, retest, publish, reset, auto). The
    state-machine module enforces which kinds are legal from which
    from_states.
    """

    __tablename__ = "lims_analysis_transitions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    analysis_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_analyses.id", ondelete="CASCADE"), nullable=False
    )
    from_state: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    to_state: Mapped[str] = mapped_column(Text, nullable=False)
    transition_kind: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    analysis: Mapped["LimsAnalysis"] = relationship(
        "LimsAnalysis", back_populates="transitions"
    )

    def __repr__(self) -> str:
        return (
            f"<LimsAnalysisTransition(analysis_id={self.analysis_id}, "
            f"{self.from_state}->{self.to_state} kind={self.transition_kind})>"
        )
```

- [ ] **Step 2: Verify models load**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from models import LimsAnalysis, LimsAnalysisTransition
print('LimsAnalysis cols:', sorted(c.name for c in LimsAnalysis.__table__.columns))
print('LimsAnalysisTransition cols:', sorted(c.name for c in LimsAnalysisTransition.__table__.columns))
"
```

Expected: 21 columns on `LimsAnalysis` (matching the migration) + 7 on `LimsAnalysisTransition`.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/models.py
git commit -m "feat(mk1): ORM models for LimsAnalysis + LimsAnalysisTransition"
```

---

## Task 3: State machine module (pure logic)

**Files:**
- New: `backend/lims_analyses/__init__.py`
- New: `backend/lims_analyses/state_machine.py`

- [ ] **Step 1: Create the package directory**

```bash
mkdir -p C:/tmp/Accu-Mk1-subvial/backend/lims_analyses
```

Write `backend/lims_analyses/__init__.py`:

```python
# Mk1-native analyses. See:
# docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md
```

- [ ] **Step 2: Write `backend/lims_analyses/state_machine.py`**

```python
"""
Pure state-machine for lims_analyses. No DB, no I/O — just the
allowed-transitions table and a validator.

States and transitions mirror SENAITE's vocabulary so the existing UI
palette + transition handlers in AnalysisTable.tsx work unchanged when
the result-entry hooks swap to the Mk1 endpoint.

Decision flow per kind:
  assign:   unassigned -> assigned
  submit:   assigned -> to_be_verified         (requires result_value)
            unassigned -> to_be_verified       (autoEdit shortcut from UI)
  verify:   to_be_verified -> verified
  retract:  to_be_verified -> retracted
            verified -> retracted              (admin override)
  reject:   unassigned -> rejected
            assigned -> rejected
            to_be_verified -> rejected
  publish:  verified -> published
  reset:    assigned -> unassigned             (clear without saving)
  retest:   (creates a NEW analysis row pointing at the old one via
             retest_of_id; not a transition on the old row)
  auto:     reserved for system-driven transitions (e.g. order-priority
            recompute). Allowed from any non-terminal state to itself.

Terminal states: rejected, published.
"""

from __future__ import annotations

from typing import Dict, FrozenSet, Optional, Tuple


# ─── State + kind constants ──────────────────────────────────────────────────

STATES: FrozenSet[str] = frozenset({
    "unassigned",
    "assigned",
    "to_be_verified",
    "verified",
    "published",
    "rejected",
    "retracted",
})

TERMINAL_STATES: FrozenSet[str] = frozenset({"published", "rejected"})

TRANSITION_KINDS: FrozenSet[str] = frozenset({
    "assign", "submit", "verify", "retract", "reject",
    "retest", "publish", "reset", "auto",
})


# ─── Allowed-transitions table ───────────────────────────────────────────────
# (from_state, kind) -> to_state

_ALLOWED: Dict[Tuple[str, str], str] = {
    ("unassigned",     "assign"):   "assigned",
    ("unassigned",     "submit"):   "to_be_verified",
    ("unassigned",     "reject"):   "rejected",

    ("assigned",       "submit"):   "to_be_verified",
    ("assigned",       "reject"):   "rejected",
    ("assigned",       "reset"):    "unassigned",

    ("to_be_verified", "verify"):   "verified",
    ("to_be_verified", "retract"):  "retracted",
    ("to_be_verified", "reject"):   "rejected",

    ("verified",       "publish"):  "published",
    ("verified",       "retract"):  "retracted",
}


# ─── Public API ──────────────────────────────────────────────────────────────


class InvalidTransitionError(ValueError):
    """Raised when a transition kind is not allowed from the current state."""

    def __init__(self, from_state: str, kind: str, message: Optional[str] = None):
        self.from_state = from_state
        self.kind = kind
        super().__init__(
            message or f"transition {kind!r} is not allowed from state {from_state!r}"
        )


class UnknownStateError(ValueError):
    """Raised when an unknown state is supplied."""


class UnknownKindError(ValueError):
    """Raised when an unknown transition kind is supplied."""


def allowed_kinds(from_state: str) -> FrozenSet[str]:
    """Return the set of transition kinds legal from this state."""
    if from_state not in STATES:
        raise UnknownStateError(from_state)
    return frozenset(k for (s, k) in _ALLOWED if s == from_state)


def next_state(from_state: str, kind: str) -> str:
    """
    Apply a transition. Returns the new state. Raises if the (from, kind)
    pair isn't in the allowed table.
    """
    if from_state not in STATES:
        raise UnknownStateError(from_state)
    if kind not in TRANSITION_KINDS:
        raise UnknownKindError(kind)
    try:
        return _ALLOWED[(from_state, kind)]
    except KeyError:
        raise InvalidTransitionError(from_state, kind)


def is_terminal(state: str) -> bool:
    """True iff the state is terminal (no transitions out)."""
    if state not in STATES:
        raise UnknownStateError(state)
    return state in TERMINAL_STATES
```

- [ ] **Step 3: Verify the module imports**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.state_machine import (
    STATES, TERMINAL_STATES, TRANSITION_KINDS,
    allowed_kinds, next_state, is_terminal,
    InvalidTransitionError, UnknownStateError, UnknownKindError,
)
print('STATES:', sorted(STATES))
print('TERMINAL:', sorted(TERMINAL_STATES))
print('KINDS:', sorted(TRANSITION_KINDS))
print('unassigned -> assign ->', next_state('unassigned', 'assign'))
print('terminal published?', is_terminal('published'))
print('allowed from to_be_verified:', sorted(allowed_kinds('to_be_verified')))
"
```

Expected:
- `STATES`: 7 states
- `TERMINAL`: `['published', 'rejected']`
- `KINDS`: 9 kinds
- `unassigned -> assign -> assigned`
- `terminal published? True`
- `allowed from to_be_verified: ['reject', 'retract', 'verify']`

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/lims_analyses/
git commit -m "feat(mk1): pure state machine for lims_analyses transitions"
```

---

## Task 4: State machine unit tests

**Files:**
- New: `backend/tests/test_lims_analyses_state_machine.py`

- [ ] **Step 1: Write the tests**

```python
"""Unit tests for the lims_analyses pure state machine.

No DB — these exercise the allowed-transitions table in isolation.
"""

from __future__ import annotations

import pytest

from lims_analyses.state_machine import (
    STATES, TERMINAL_STATES, TRANSITION_KINDS,
    allowed_kinds, next_state, is_terminal,
    InvalidTransitionError, UnknownStateError, UnknownKindError,
)


# ── basic membership ─────────────────────────────────────────────────────────


def test_states_set_is_complete():
    assert STATES == {
        "unassigned", "assigned", "to_be_verified",
        "verified", "published", "rejected", "retracted",
    }


def test_terminal_states():
    assert TERMINAL_STATES == {"published", "rejected"}
    assert is_terminal("published")
    assert is_terminal("rejected")
    assert not is_terminal("verified")
    assert not is_terminal("retracted")  # retracted is recoverable via retest


def test_transition_kinds_set():
    assert TRANSITION_KINDS == {
        "assign", "submit", "verify", "retract", "reject",
        "retest", "publish", "reset", "auto",
    }


# ── happy-path transitions ───────────────────────────────────────────────────


def test_unassigned_to_assigned_via_assign():
    assert next_state("unassigned", "assign") == "assigned"


def test_assigned_to_to_be_verified_via_submit():
    assert next_state("assigned", "submit") == "to_be_verified"


def test_unassigned_to_to_be_verified_via_submit_autoedit_shortcut():
    # The autoEdit path in AnalysisTable submits directly without an
    # intermediate 'assign'.
    assert next_state("unassigned", "submit") == "to_be_verified"


def test_to_be_verified_to_verified_via_verify():
    assert next_state("to_be_verified", "verify") == "verified"


def test_verified_to_published_via_publish():
    assert next_state("verified", "publish") == "published"


def test_assigned_to_unassigned_via_reset():
    assert next_state("assigned", "reset") == "unassigned"


# ── retraction + rejection paths ─────────────────────────────────────────────


def test_to_be_verified_to_retracted_via_retract():
    assert next_state("to_be_verified", "retract") == "retracted"


def test_verified_to_retracted_via_retract_admin_path():
    assert next_state("verified", "retract") == "retracted"


@pytest.mark.parametrize("from_state", ["unassigned", "assigned", "to_be_verified"])
def test_reject_from_each_pre_terminal_state(from_state):
    assert next_state(from_state, "reject") == "rejected"


# ── disallowed transitions ───────────────────────────────────────────────────


def test_cannot_verify_from_unassigned():
    with pytest.raises(InvalidTransitionError):
        next_state("unassigned", "verify")


def test_cannot_publish_from_to_be_verified():
    with pytest.raises(InvalidTransitionError):
        next_state("to_be_verified", "publish")


def test_cannot_transition_out_of_published():
    for kind in TRANSITION_KINDS:
        if kind == "auto":
            continue  # 'auto' is reserved; not in the allowed table
        with pytest.raises(InvalidTransitionError):
            next_state("published", kind)


def test_cannot_transition_out_of_rejected():
    for kind in TRANSITION_KINDS:
        if kind == "auto":
            continue
        with pytest.raises(InvalidTransitionError):
            next_state("rejected", kind)


def test_unknown_state_raises():
    with pytest.raises(UnknownStateError):
        next_state("not_a_state", "verify")


def test_unknown_kind_raises():
    with pytest.raises(UnknownKindError):
        next_state("unassigned", "fly_to_the_moon")


# ── allowed_kinds() introspection (drives UI dropdowns) ──────────────────────


def test_allowed_kinds_from_unassigned():
    assert allowed_kinds("unassigned") == {"assign", "submit", "reject"}


def test_allowed_kinds_from_to_be_verified():
    assert allowed_kinds("to_be_verified") == {"verify", "retract", "reject"}


def test_allowed_kinds_from_verified():
    assert allowed_kinds("verified") == {"publish", "retract"}


def test_allowed_kinds_from_published_is_empty():
    assert allowed_kinds("published") == set()


def test_allowed_kinds_unknown_state_raises():
    with pytest.raises(UnknownStateError):
        allowed_kinds("not_a_state")
```

- [ ] **Step 2: Run the tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend \
  bash -c "cd /app && python -m pytest tests/test_lims_analyses_state_machine.py -v"
```

Expected: ~22 passed, 0 failures.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/tests/test_lims_analyses_state_machine.py
git commit -m "test(mk1): pure state-machine unit tests for lims_analyses"
```

---

## Task 5: Pydantic schemas

**Files:**
- New: `backend/lims_analyses/schemas.py`

- [ ] **Step 1: Write the schemas**

```python
"""Request/response models for the lims_analyses API.

Kept separate from the service-layer types so route-level Pydantic
validation is decoupled from internal data shapes.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


# ─── Enums (string-literal aliases for documentation) ────────────────────────

ReviewState = Literal[
    "unassigned", "assigned", "to_be_verified",
    "verified", "published", "rejected", "retracted",
]

TransitionKind = Literal[
    "assign", "submit", "verify", "retract", "reject",
    "retest", "publish", "reset", "auto",
]

HostKind = Literal["sample", "sub_sample"]


# ─── Create + response shapes ────────────────────────────────────────────────


class CreateAnalysisRequest(BaseModel):
    """
    Insert a new lims_analyses row. Caller must specify exactly one host
    (sample vs sub_sample); the polymorphic CHECK at the DB layer enforces.
    """
    host_kind: HostKind
    host_pk: int
    analysis_service_id: int
    keyword: str
    title: str
    result_value: Optional[str] = None
    result_unit: Optional[str] = None
    method_id: Optional[int] = None
    instrument_id: Optional[int] = None


class TransitionRequest(BaseModel):
    """Apply a state transition. result_value is required when kind='submit'
    on a row that doesn't already have one — service layer validates."""
    kind: TransitionKind
    result_value: Optional[str] = None
    reason: Optional[str] = None


class SetReportableRequest(BaseModel):
    reportable: bool
    reason: Optional[str] = None


class TransitionInfo(BaseModel):
    """One audit-log row."""
    id: int
    from_state: Optional[str]
    to_state: str
    transition_kind: str
    user_id: Optional[int]
    reason: Optional[str]
    occurred_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AnalysisResponse(BaseModel):
    """Full lims_analyses row shape, for GET endpoints."""
    id: int
    lims_sample_pk: Optional[int]
    lims_sub_sample_pk: Optional[int]
    analysis_service_id: int
    keyword: str
    title: str
    result_value: Optional[str]
    result_unit: Optional[str]
    review_state: str
    method_id: Optional[int]
    instrument_id: Optional[int]
    analyst_user_id: Optional[int]
    captured_at: Optional[datetime]
    submitted_at: Optional[datetime]
    verified_at: Optional[datetime]
    published_at: Optional[datetime]
    retested: bool
    retest_of_id: Optional[int]
    reportable: bool
    reportable_reason: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AnalysisWithTransitions(AnalysisResponse):
    """AnalysisResponse + the full audit-log chain. Used by GET-by-id."""
    transitions: List[TransitionInfo] = Field(default_factory=list)
```

- [ ] **Step 2: Verify schemas import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.schemas import (
    CreateAnalysisRequest, TransitionRequest, SetReportableRequest,
    TransitionInfo, AnalysisResponse, AnalysisWithTransitions,
    ReviewState, TransitionKind, HostKind,
)
req = CreateAnalysisRequest(
    host_kind='sub_sample', host_pk=1,
    analysis_service_id=1, keyword='ENDO_LAL', title='Endotoxin (LAL)',
)
print('OK', req)
"
```

Expected: `OK CreateAnalysisRequest(host_kind='sub_sample', host_pk=1, ...)`.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/lims_analyses/schemas.py
git commit -m "feat(mk1): Pydantic schemas for lims_analyses API"
```

---

## Task 6: Service layer

**Files:**
- New: `backend/lims_analyses/service.py`

The service layer is the only place that writes to the DB + audit log. The route layer is a thin wrapper.

- [ ] **Step 1: Write the service module**

```python
"""
Service layer for lims_analyses.

All DB writes go through here. Every state change writes a
LimsAnalysisTransition audit row in the same DB transaction as the
LimsAnalysis update — the two stay consistent or both roll back.

Service functions raise typed exceptions (NotFoundError, BadRequestError,
plus the state-machine exceptions re-exported from state_machine.py).
The route layer translates them to HTTP responses.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.state_machine import (
    InvalidTransitionError,
    is_terminal,
    next_state,
)
from models import LimsAnalysis, LimsAnalysisTransition


# ─── Typed exceptions ────────────────────────────────────────────────────────


class NotFoundError(LookupError):
    """Analysis (or related entity) not found."""


class BadRequestError(ValueError):
    """Request is structurally OK but semantically invalid (e.g. missing
    result on submit). Distinct from state-machine errors which are about
    the (from_state, kind) edge."""


# ─── Reads ───────────────────────────────────────────────────────────────────


def get_analysis(db: Session, analysis_id: int) -> LimsAnalysis:
    row = db.get(LimsAnalysis, analysis_id)
    if row is None:
        raise NotFoundError(f"lims_analysis id={analysis_id} not found")
    return row


def list_analyses_for_host(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    include_retests: bool = True,
) -> List[LimsAnalysis]:
    """List analyses attached to a single host. Retests included by default;
    set include_retests=False to filter to the current (non-retest) rows
    that drive the AnalysisTable view."""
    if host_kind == "sample":
        stmt = select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == host_pk)
    elif host_kind == "sub_sample":
        stmt = select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == host_pk)
    else:
        raise BadRequestError(f"invalid host_kind={host_kind!r}")
    if not include_retests:
        stmt = stmt.where(LimsAnalysis.retest_of_id.is_(None))
    return list(db.execute(stmt.order_by(LimsAnalysis.keyword)).scalars().all())


# ─── Creation ────────────────────────────────────────────────────────────────


def create_analysis(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    analysis_service_id: int,
    keyword: str,
    title: str,
    result_value: Optional[str] = None,
    result_unit: Optional[str] = None,
    method_id: Optional[int] = None,
    instrument_id: Optional[int] = None,
    created_by_user_id: Optional[int] = None,
) -> LimsAnalysis:
    """Insert a new lims_analyses row in state='unassigned'. Writes the
    initial audit row (from_state=NULL, to_state='unassigned',
    transition_kind='auto')."""
    if host_kind == "sample":
        lims_sample_pk, lims_sub_sample_pk = host_pk, None
    elif host_kind == "sub_sample":
        lims_sample_pk, lims_sub_sample_pk = None, host_pk
    else:
        raise BadRequestError(f"invalid host_kind={host_kind!r}")

    row = LimsAnalysis(
        lims_sample_pk=lims_sample_pk,
        lims_sub_sample_pk=lims_sub_sample_pk,
        analysis_service_id=analysis_service_id,
        keyword=keyword,
        title=title,
        result_value=result_value,
        result_unit=result_unit,
        review_state="unassigned",
        method_id=method_id,
        instrument_id=instrument_id,
        created_by_user_id=created_by_user_id,
    )
    db.add(row)
    db.flush()  # populate row.id before writing the audit log

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=None,
        to_state="unassigned",
        transition_kind="auto",
        user_id=created_by_user_id,
        reason="initial insert",
    ))
    db.commit()
    db.refresh(row)
    return row


# ─── Transitions ─────────────────────────────────────────────────────────────


def apply_transition(
    db: Session,
    *,
    analysis_id: int,
    kind: str,
    result_value: Optional[str] = None,
    reason: Optional[str] = None,
    user_id: Optional[int] = None,
) -> LimsAnalysis:
    """
    Validate (from_state, kind) via the state machine, apply the
    state change, update timestamps, write the audit row, commit.

    Semantic guards beyond the state machine:
      - 'submit' requires a result_value (either already on the row or
        supplied in this call).
      - 'verify' requires the row to already carry a result_value.
    """
    row = get_analysis(db, analysis_id)
    from_state = row.review_state

    if is_terminal(from_state):
        # State machine will also reject this, but we surface a clearer
        # message: "this analysis is closed" rather than "kind not allowed".
        raise InvalidTransitionError(
            from_state, kind,
            message=f"analysis is in terminal state {from_state!r}; no transitions allowed",
        )

    to_state = next_state(from_state, kind)

    # Semantic guards
    if kind == "submit":
        # Accept inline result_value as the submitted result.
        if result_value is not None:
            row.result_value = result_value
        if not row.result_value:
            raise BadRequestError(
                "submit requires a result_value (either pre-existing on the "
                "row or supplied in this request)"
            )
    elif kind == "verify":
        if not row.result_value:
            raise BadRequestError("verify requires a result_value on the row")
    elif kind == "reset":
        # Clear any draft result + provenance on the way back to unassigned.
        row.result_value = None
        row.result_unit = None
        row.method_id = None
        row.instrument_id = None
        row.captured_at = None
        row.submitted_at = None
    elif kind == "retract":
        # Clear timestamps from the verified attempt; the row is now an
        # auditable record of "this attempt was retracted." A new attempt
        # (retest) is a separate row pointing here via retest_of_id.
        row.verified_at = None

    now = datetime.utcnow()

    # Timestamp markers per state.
    if to_state == "to_be_verified":
        row.submitted_at = row.submitted_at or now
        if not row.captured_at:
            row.captured_at = now
    elif to_state == "verified":
        row.verified_at = now
    elif to_state == "published":
        row.published_at = now

    row.review_state = to_state
    row.updated_at = now

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=from_state,
        to_state=to_state,
        transition_kind=kind,
        user_id=user_id,
        reason=reason,
    ))
    db.commit()
    db.refresh(row)
    return row


def set_reportable(
    db: Session,
    *,
    analysis_id: int,
    reportable: bool,
    reason: Optional[str] = None,
    user_id: Optional[int] = None,
) -> LimsAnalysis:
    """Flip the reportable flag. Not a state-machine transition — written
    to the audit log with transition_kind='auto' and from_state==to_state."""
    row = get_analysis(db, analysis_id)
    if row.reportable == reportable:
        return row  # no-op

    row.reportable = reportable
    row.reportable_reason = reason
    row.updated_at = datetime.utcnow()

    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=row.review_state,
        to_state=row.review_state,
        transition_kind="auto",
        user_id=user_id,
        reason=(
            f"reportable={reportable}" + (f": {reason}" if reason else "")
        ),
    ))
    db.commit()
    db.refresh(row)
    return row
```

- [ ] **Step 2: Verify the module imports**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.service import (
    create_analysis, apply_transition, set_reportable,
    get_analysis, list_analyses_for_host,
    NotFoundError, BadRequestError,
)
print('imports ok')
"
```

Expected: `imports ok`.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/lims_analyses/service.py
git commit -m "feat(mk1): service layer for lims_analyses — create, transition, set_reportable"
```

---

## Task 7: Service-layer integration tests

**Files:**
- New: `backend/tests/test_lims_analyses_service.py`

- [ ] **Step 1: Write the tests**

```python
"""Service-layer integration tests for lims_analyses.

Each test cleans up its own rows. Uses the live subvial DB session
(same convention as test_variance_set.py).
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from lims_analyses.service import (
    BadRequestError,
    NotFoundError,
    apply_transition,
    create_analysis,
    get_analysis,
    list_analyses_for_host,
    set_reportable,
)
from lims_analyses.state_machine import InvalidTransitionError
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    """Pick any seeded analysis_service with a non-null keyword."""
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def sub_sample(db):
    """Pick any existing sub-sample to host the test analyses."""
    sub = db.execute(select(LimsSubSample)).scalars().first()
    if sub is None:
        pytest.skip("no lims_sub_samples row available — seed via Receive Wizard")
    return sub


@pytest.fixture(autouse=True)
def cleanup(db):
    """Wipe any TEST-prefixed analyses + their audit rows after each test."""
    yield
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.reason.like("TEST:%")
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.title.like("TEST:%")
    ))
    db.commit()


def _create(db, sub, svc, **kw):
    return create_analysis(
        db,
        host_kind="sub_sample",
        host_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=kw.get("keyword", svc.keyword),
        title=kw.get("title", "TEST: " + (svc.title or svc.keyword)),
        result_value=kw.get("result_value"),
    )


# ── creation ────────────────────────────────────────────────────────────────


def test_create_sub_sample_analysis_starts_unassigned(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    assert row.review_state == "unassigned"
    assert row.lims_sub_sample_pk == sub_sample.id
    assert row.lims_sample_pk is None
    # Initial audit row written
    txns = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id
        )
    ).scalars().all()
    assert len(txns) == 1
    assert txns[0].from_state is None
    assert txns[0].to_state == "unassigned"
    assert txns[0].transition_kind == "auto"


def test_create_with_invalid_host_kind_raises(db, sub_sample, analysis_service):
    with pytest.raises(BadRequestError):
        create_analysis(
            db, host_kind="garbage", host_pk=sub_sample.id,
            analysis_service_id=analysis_service.id,
            keyword=analysis_service.keyword,
            title="TEST: garbage host",
        )


# ── happy-path transitions ──────────────────────────────────────────────────


def test_unassigned_to_verified_full_path(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    row = apply_transition(
        db, analysis_id=row.id, kind="assign",
        reason="TEST: assigning",
    )
    assert row.review_state == "assigned"

    row = apply_transition(
        db, analysis_id=row.id, kind="submit",
        result_value="98.55", reason="TEST: submit",
    )
    assert row.review_state == "to_be_verified"
    assert row.result_value == "98.55"
    assert row.submitted_at is not None
    assert row.captured_at is not None

    row = apply_transition(
        db, analysis_id=row.id, kind="verify",
        reason="TEST: verify",
    )
    assert row.review_state == "verified"
    assert row.verified_at is not None

    row = apply_transition(
        db, analysis_id=row.id, kind="publish",
        reason="TEST: publish",
    )
    assert row.review_state == "published"
    assert row.published_at is not None


def test_submit_without_result_raises(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: assign")
    with pytest.raises(BadRequestError):
        apply_transition(db, analysis_id=row.id, kind="submit",
                         reason="TEST: missing result")


def test_verify_without_result_raises(db, sub_sample, analysis_service):
    # Walk in via the unassigned -> to_be_verified shortcut WITHOUT a
    # result by going around the guard via direct row mutation in a
    # hypothetical; in practice the submit guard catches first.
    # Use a fresh row + autoEdit-style submit to ensure result is set:
    row = _create(db, sub_sample, analysis_service, result_value=None)
    # We can't actually reach to_be_verified without a result via the
    # service layer (guard fires on submit). So just assert the submit
    # guard.
    with pytest.raises(BadRequestError):
        apply_transition(db, analysis_id=row.id, kind="submit",
                         reason="TEST: no result")


def test_reset_clears_draft_and_returns_to_unassigned(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: assign")
    # Reset
    row = apply_transition(db, analysis_id=row.id, kind="reset",
                           reason="TEST: reset")
    assert row.review_state == "unassigned"
    assert row.result_value is None


# ── disallowed transitions surface as InvalidTransitionError ────────────────


def test_publish_from_unassigned_raises(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    with pytest.raises(InvalidTransitionError):
        apply_transition(db, analysis_id=row.id, kind="publish",
                         reason="TEST: too early")


def test_no_transition_out_of_terminal_published(db, sub_sample, analysis_service):
    # Walk to published, then try anything
    row = _create(db, sub_sample, analysis_service)
    for kind, value in [
        ("assign", None), ("submit", "1.0"),
        ("verify", None), ("publish", None),
    ]:
        kwargs = {"result_value": value} if value else {}
        row = apply_transition(db, analysis_id=row.id, kind=kind,
                               reason=f"TEST: walk {kind}", **kwargs)
    assert row.review_state == "published"
    with pytest.raises(InvalidTransitionError):
        apply_transition(db, analysis_id=row.id, kind="retract",
                         reason="TEST: cannot leave terminal")


# ── retract preserves audit; clears verified_at ──────────────────────────────


def test_retract_from_verified_clears_verified_at(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value="42", reason="TEST")
    apply_transition(db, analysis_id=row.id, kind="verify", reason="TEST")
    # Sanity
    fresh = get_analysis(db, row.id)
    assert fresh.verified_at is not None
    # Retract
    after = apply_transition(db, analysis_id=row.id, kind="retract",
                             reason="TEST: oops")
    assert after.review_state == "retracted"
    assert after.verified_at is None
    # Audit chain
    txns = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id
        ).order_by(LimsAnalysisTransition.occurred_at)
    ).scalars().all()
    kinds = [t.transition_kind for t in txns]
    assert kinds == ["auto", "assign", "submit", "verify", "retract"]


# ── reportable flag flip writes an audit row ─────────────────────────────────


def test_set_reportable_writes_audit_row(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    assert row.reportable is True

    set_reportable(db, analysis_id=row.id, reportable=False,
                   reason="TEST: excluded from COA")
    fresh = get_analysis(db, row.id)
    assert fresh.reportable is False
    assert fresh.reportable_reason == "TEST: excluded from COA"

    audit = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id,
            LimsAnalysisTransition.transition_kind == "auto",
        ).order_by(LimsAnalysisTransition.occurred_at.desc())
    ).scalars().first()
    assert audit is not None
    # The reportable=False reason gets prefixed into the audit reason.
    assert "reportable=False" in (audit.reason or "")


def test_set_reportable_idempotent_no_audit_when_unchanged(db, sub_sample, analysis_service):
    row = _create(db, sub_sample, analysis_service)
    set_reportable(db, analysis_id=row.id, reportable=True, reason="TEST: noop")
    audit_count = db.execute(
        select(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id,
            LimsAnalysisTransition.transition_kind == "auto",
        )
    ).scalars().all()
    # Only the initial-insert audit row; the no-op set_reportable wrote nothing.
    assert len(audit_count) == 1


# ── list_analyses_for_host ──────────────────────────────────────────────────


def test_list_analyses_for_host_returns_only_that_hosts_rows(
    db, sub_sample, analysis_service,
):
    row1 = _create(db, sub_sample, analysis_service,
                   title="TEST: list 1")
    rows = list_analyses_for_host(db, host_kind="sub_sample", host_pk=sub_sample.id)
    assert row1.id in {r.id for r in rows}
    # Listing for a different sub-sample doesn't return row1
    other = db.execute(
        select(LimsSubSample).where(LimsSubSample.id != sub_sample.id).limit(1)
    ).scalar_one_or_none()
    if other is not None:
        other_rows = list_analyses_for_host(
            db, host_kind="sub_sample", host_pk=other.id,
        )
        assert row1.id not in {r.id for r in other_rows}


def test_get_analysis_not_found_raises(db):
    with pytest.raises(NotFoundError):
        get_analysis(db, 99_999_999)
```

- [ ] **Step 2: Run the tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend \
  bash -c "cd /app && python -m pytest tests/test_lims_analyses_service.py -v"
```

Expected: all tests pass (count depends on parametrize; aim for >= 12 passed). Skipped if no `analysis_services` or `lims_sub_samples` rows in the test DB.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/tests/test_lims_analyses_service.py
git commit -m "test(mk1): service-layer integration tests for lims_analyses"
```

---

## Task 8: REST router

**Files:**
- New: `backend/lims_analyses/routes.py`

- [ ] **Step 1: Write the router**

```python
"""FastAPI router for lims_analyses.

Thin HTTP shells over the service layer. Translates typed service
exceptions to structured HTTP responses; never writes to the DB
directly.
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from lims_analyses import service
from lims_analyses.schemas import (
    AnalysisResponse,
    AnalysisWithTransitions,
    CreateAnalysisRequest,
    HostKind,
    SetReportableRequest,
    TransitionInfo,
    TransitionRequest,
)
from lims_analyses.state_machine import (
    InvalidTransitionError,
    UnknownKindError,
    UnknownStateError,
)


router = APIRouter(prefix="/api/lims-analyses", tags=["lims-analyses"])


# ─── Error translation helpers ───────────────────────────────────────────────


def _handle_service_error(e: Exception) -> HTTPException:
    """Map a service-layer exception to an HTTPException."""
    if isinstance(e, service.NotFoundError):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, service.BadRequestError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, InvalidTransitionError):
        return HTTPException(
            status_code=409,
            detail={
                "code": "invalid_transition",
                "from_state": e.from_state,
                "kind": e.kind,
                "message": str(e),
            },
        )
    if isinstance(e, (UnknownStateError, UnknownKindError)):
        return HTTPException(status_code=400, detail=str(e))
    # Unknown — let FastAPI 500 it
    raise e


# ─── Endpoints ───────────────────────────────────────────────────────────────


@router.post("", response_model=AnalysisResponse, status_code=status.HTTP_201_CREATED)
def create_analysis(
    req: CreateAnalysisRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.create_analysis(
            db,
            host_kind=req.host_kind,
            host_pk=req.host_pk,
            analysis_service_id=req.analysis_service_id,
            keyword=req.keyword,
            title=req.title,
            result_value=req.result_value,
            result_unit=req.result_unit,
            method_id=req.method_id,
            instrument_id=req.instrument_id,
            created_by_user_id=getattr(current_user, "id", None),
        )
        return AnalysisResponse.model_validate(row)
    except Exception as e:
        raise _handle_service_error(e)


@router.get("", response_model=List[AnalysisResponse])
def list_for_host(
    host_kind: HostKind = Query(...),
    host_pk: int = Query(...),
    include_retests: bool = Query(True),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        rows = service.list_analyses_for_host(
            db,
            host_kind=host_kind,
            host_pk=host_pk,
            include_retests=include_retests,
        )
        return [AnalysisResponse.model_validate(r) for r in rows]
    except Exception as e:
        raise _handle_service_error(e)


@router.get("/{analysis_id}", response_model=AnalysisWithTransitions)
def get_by_id(
    analysis_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.get_analysis(db, analysis_id)
        return AnalysisWithTransitions(
            **AnalysisResponse.model_validate(row).model_dump(),
            transitions=[
                TransitionInfo.model_validate(t) for t in row.transitions
            ],
        )
    except Exception as e:
        raise _handle_service_error(e)


@router.post("/{analysis_id}/transitions", response_model=AnalysisResponse)
def transition(
    analysis_id: int,
    req: TransitionRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.apply_transition(
            db,
            analysis_id=analysis_id,
            kind=req.kind,
            result_value=req.result_value,
            reason=req.reason,
            user_id=getattr(current_user, "id", None),
        )
        return AnalysisResponse.model_validate(row)
    except Exception as e:
        raise _handle_service_error(e)


@router.patch("/{analysis_id}/reportable", response_model=AnalysisResponse)
def patch_reportable(
    analysis_id: int,
    req: SetReportableRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        row = service.set_reportable(
            db,
            analysis_id=analysis_id,
            reportable=req.reportable,
            reason=req.reason,
            user_id=getattr(current_user, "id", None),
        )
        return AnalysisResponse.model_validate(row)
    except Exception as e:
        raise _handle_service_error(e)
```

- [ ] **Step 2: Mount the router in `backend/main.py`**

Near the other `include_router` calls (around `app.include_router(sub_samples_router)` at line 384):

```python
# Existing import
from sub_samples.routes import router as sub_samples_router
# Add:
from lims_analyses.routes import router as lims_analyses_router

# ... near line 384, after app.include_router(sub_samples_router):
app.include_router(lims_analyses_router)
```

- [ ] **Step 3: Restart backend and confirm the router mounts**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend
until curl -s http://localhost:5530/health >/dev/null 2>&1; do sleep 2; done
curl -s http://localhost:5530/openapi.json | python -c "
import json, sys
spec = json.load(sys.stdin)
paths = [p for p in spec['paths'] if '/api/lims-analyses' in p]
for p in paths:
    methods = list(spec['paths'][p].keys())
    print(f'  {p:50s}  {methods}')
"
```

Expected: 5 paths listed — POST `/api/lims-analyses`, GET `/api/lims-analyses`, GET `/api/lims-analyses/{analysis_id}`, POST `/api/lims-analyses/{analysis_id}/transitions`, PATCH `/api/lims-analyses/{analysis_id}/reportable`.

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/lims_analyses/routes.py backend/main.py
git commit -m "feat(mk1): REST router for lims_analyses — create/list/transition/reportable"
```

---

## Task 9: Route-level tests

**Files:**
- New: `backend/tests/test_lims_analyses_routes.py`

- [ ] **Step 1: Look at how existing route tests authenticate**

```bash
docker exec accumark-subvial-accu-mk1-backend grep -l "TestClient\|FastAPI" /app/tests/*.py | head -5
```

Read one of those to confirm the auth-bypass pattern. If a test fixture for an authed client exists, reuse it. If tests use `app.dependency_overrides[get_current_user]`, mirror that approach.

- [ ] **Step 2: Write the route tests**

Pattern (adapt to whatever auth pattern the existing route tests use):

```python
"""HTTP-level tests for the lims_analyses router."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from auth import get_current_user
from database import SessionLocal
from main import app
from models import (
    AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSubSample, User,
)


class _FakeUser:
    """Minimal stand-in for the authed user; only id is read."""
    id = 1


def _override_user():
    return _FakeUser()


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = _override_user
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def sub_sample(db):
    sub = db.execute(select(LimsSubSample)).scalars().first()
    if sub is None:
        pytest.skip("no lims_sub_samples row available")
    return sub


@pytest.fixture
def analysis_service(db):
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.reason.like("HTTP-TEST:%")
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.title.like("HTTP-TEST:%")
    ))
    db.commit()


def _create_payload(sub, svc):
    return {
        "host_kind": "sub_sample",
        "host_pk": sub.id,
        "analysis_service_id": svc.id,
        "keyword": svc.keyword,
        "title": "HTTP-TEST: " + (svc.title or svc.keyword),
    }


# ── POST /api/lims-analyses ─────────────────────────────────────────────────


def test_create_returns_201_unassigned(client, sub_sample, analysis_service):
    resp = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["review_state"] == "unassigned"
    assert body["lims_sub_sample_pk"] == sub_sample.id


# ── transition endpoint ────────────────────────────────────────────────────


def test_transition_happy_path_to_verified(client, sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]

    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "assign", "reason": "HTTP-TEST: assign"})
    assert r.status_code == 200
    assert r.json()["review_state"] == "assigned"

    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "submit", "result_value": "98.55",
                          "reason": "HTTP-TEST: submit"})
    assert r.status_code == 200
    assert r.json()["review_state"] == "to_be_verified"

    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "verify", "reason": "HTTP-TEST: verify"})
    assert r.status_code == 200
    assert r.json()["review_state"] == "verified"


def test_invalid_transition_returns_409(client, sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "publish", "reason": "HTTP-TEST: too early"})
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_transition"
    assert detail["from_state"] == "unassigned"
    assert detail["kind"] == "publish"


def test_submit_without_result_returns_400(client, sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    client.post(f"/api/lims-analyses/{aid}/transitions",
                json={"kind": "assign", "reason": "HTTP-TEST: assign"})
    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "submit", "reason": "HTTP-TEST: no result"})
    assert r.status_code == 400


def test_not_found_returns_404(client):
    r = client.get("/api/lims-analyses/99999999")
    assert r.status_code == 404


# ── reportable PATCH ────────────────────────────────────────────────────────


def test_patch_reportable_writes_audit(client, sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    r = client.patch(f"/api/lims-analyses/{aid}/reportable",
                     json={"reportable": False, "reason": "HTTP-TEST: not reportable"})
    assert r.status_code == 200
    assert r.json()["reportable"] is False

    r = client.get(f"/api/lims-analyses/{aid}")
    assert r.status_code == 200
    audit = r.json()["transitions"]
    # Initial auto + the reportable flip
    assert any(
        t["transition_kind"] == "auto" and "reportable=False" in (t.get("reason") or "")
        for t in audit
    )


# ── GET list for host ────────────────────────────────────────────────────────


def test_list_for_host_returns_created_row(client, sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    r = client.get(
        "/api/lims-analyses",
        params={"host_kind": "sub_sample", "host_pk": sub_sample.id},
    )
    assert r.status_code == 200
    ids = {row["id"] for row in r.json()}
    assert created["id"] in ids
```

- [ ] **Step 3: Run the tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend \
  bash -c "cd /app && python -m pytest tests/test_lims_analyses_routes.py -v"
```

Expected: all tests pass (skipped if seed data unavailable).

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/tests/test_lims_analyses_routes.py
git commit -m "test(mk1): HTTP-level tests for lims_analyses router"
```

---

## Task 10: Smoke verify end-to-end via curl

This is verification-only — no code changes.

- [ ] **Step 1: Get a token via the existing login flow** (or via the dev override if your env uses one). Skip if you already have a token from another session.

- [ ] **Step 2: Find a sub-sample to host the smoke test**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import LimsSubSample, AnalysisService
db = SessionLocal()
sub = db.execute(select(LimsSubSample)).scalars().first()
svc = db.execute(select(AnalysisService).where(AnalysisService.keyword.isnot(None))).scalars().first()
print('sub_pk=', sub and sub.id, 'sample_id=', sub and sub.sample_id)
print('service_id=', svc and svc.id, 'keyword=', svc and svc.keyword)
db.close()
"
```

- [ ] **Step 3: Create, walk through states, inspect**

```bash
TOKEN="<paste token here>"
SUB_PK=<from step 2>
SVC_ID=<from step 2>
KW=<from step 2>

# Create
AID=$(curl -s -X POST http://localhost:5530/api/lims-analyses \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"host_kind\":\"sub_sample\",\"host_pk\":$SUB_PK,\"analysis_service_id\":$SVC_ID,\"keyword\":\"$KW\",\"title\":\"SMOKE: $KW\"}" \
  | python -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "created id=$AID"

# Walk: assign -> submit -> verify -> publish
for body in \
  '{"kind":"assign","reason":"smoke"}' \
  '{"kind":"submit","result_value":"42.0","reason":"smoke"}' \
  '{"kind":"verify","reason":"smoke"}' \
  '{"kind":"publish","reason":"smoke"}'; do
  STATE=$(curl -s -X POST "http://localhost:5530/api/lims-analyses/$AID/transitions" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$body" | python -c "import sys,json; print(json.load(sys.stdin)['review_state'])")
  echo "$body -> $STATE"
done

# Inspect audit chain
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:5530/api/lims-analyses/$AID" \
  | python -m json.tool

# Cleanup
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import delete
from models import LimsAnalysis, LimsAnalysisTransition
db = SessionLocal()
db.execute(delete(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == $AID))
db.execute(delete(LimsAnalysis).where(LimsAnalysis.id == $AID))
db.commit()
db.close()
print('cleaned')
"
```

Expected:
- create returns a fresh `id` in `unassigned`.
- Each transition prints the new state in order: `assigned`, `to_be_verified`, `verified`, `published`.
- GET-by-id shows the full audit chain: 5 transitions (initial auto + 4 user-driven).

---

## Verification (Phase 1 acceptance)

- [ ] `lims_analyses` + `lims_analysis_transitions` tables exist with the expected columns + indexes (Task 1 step 3).
- [ ] CHECK constraints enforce polymorphic host (Task 1 step 4).
- [ ] ORM models import cleanly (Task 2 step 2).
- [ ] State machine unit tests: ~22 passed (Task 4 step 2).
- [ ] Service layer integration tests: >= 12 passed (Task 7 step 2).
- [ ] HTTP route tests: 7+ passed (Task 9 step 3).
- [ ] OpenAPI lists 5 new endpoints under `/api/lims-analyses` (Task 8 step 3).
- [ ] curl smoke walk creates a row, traverses to `published`, the audit chain has the right 5 transitions in order (Task 10).
- [ ] Full suite has no NEW regressions beyond the existing baseline failures from the current handoff.

## Risks and unknowns

- **Pydantic V1 vs V2 in this codebase.** `from_attributes=True` (Pydantic V2 idiom) is used in the schemas. The project is on Pydantic V2 per the warnings in the test output; should Just Work. If something breaks, swap to `Config: orm_mode = True` (V1) or `class Config: from_attributes = True` (V2 backward-compat).
- **Auth dependency override in route tests.** Existing route tests may use a different pattern (e.g. a fixture that creates a real User row + signs a token). Task 9 step 1 reads existing tests first — match whatever's there. The pattern in the plan is a fallback; replace with the project's idiom.
- **`analysis_services.title` may be null.** The migration's `title TEXT NOT NULL` on `lims_analyses` requires the caller to supply one. Test fixtures fall back to keyword if title is missing. If your seed data has null titles, the service layer will reject — that's intentional.
- **Subset of transitions exercised in Task 7 tests.** Retest creation (new row with `retest_of_id`) is NOT exercised here — `retest` as a kind isn't a state transition on the original row, it's a new-row creation in service-layer code not yet written. Phase 1 of THIS plan ships the data model + the state machine; retest-creation behavior is intentionally deferred to a follow-on plan once a real retest case lands.

## Open questions for the planner / reviewer

These are SPEC open questions Phase 1 leaves untouched:

1. **Speculative analysis seeding for XTRA vials** (SPEC §Open Questions §1). Phase 2 of the broader spec decides; Phase 1 just ships the data model that supports either choice.
2. **Retest UI** (SPEC §Open Questions §2). The data column lands here; the UI work doesn't.
3. **Photo storage** (SPEC §Open Questions §3). Untouched by Phase 1.
4. **`source_analysis_uid` polymorphism** for the COA resolver (SPEC §Open Questions §4). Phase 4 work; Phase 1 unaffected.

## Out of scope (carried forward)

- Receive Wizard backend rewrite (Phase 2).
- Worksheet routing (`worksheet_items.lims_analysis_id`, inbox query rewrite) — Phase 3.
- `AnalysisTable.tsx` adapter (Phase 3).
- COA resolver `_gather_candidates_for` upgrade (Phase 4).
- Family-state derivation + WP signaling (Phase 4).
- Prelim-COA opt-in customer flow (Phase 5).
- Retest creation in the service layer (deferred until first real case).
- SLA timing for vial analyses (Open Question 6).
- Customer-facing UI for sub-samples (Open Question 7 — recommend drop).
