# Workflow State System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship SENAITE phase-out slice 3 — a data-driven workflow catalog (both scopes), a complete native transition log in the Mk1 DB (sample table + analysis observer), an IS-stream sync + historical seed, and an admin Settings page with a React Flow graph.

**Architecture:** Everything additive and read-dormant (spec `docs/superpowers/specs/2026-07-12-workflow-state-system-design.md`). New `backend/workflow/` package holds catalog, sample-log recorder, IS-stream sync, and observer. Three capture sources write one sample log, deduped by precedence. FE adds a `workflow` preferences pane with a lazy-loaded React Flow canvas; editing is form-driven.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (`Mapped[]`), psycopg2 for the IS DB (`integration_db.get_integration_db`), React 19 + TS + TanStack Query + shadcn, `@xyflow/react` + `@dagrejs/dagre` (new deps, FE only).

## Global Constraints

- **Additive only.** No existing reader/CHECK/behavior changes beyond the two explicitly planned CHECK edits (adding `'observed'` to `transition_kind`).
- **`lims_` table prefix** for all new tables.
- **Never-fail mirror posture:** log/observer/sync writes use the slice-2 `_bg` idiom — `run_in_threadpool`, own `SessionLocal`, rollback-guarded, `logger.warning`, never raises (see `main.py:13820` `_mirror_parent_analysis_bg` as the canonical example).
- **Frontend is npm only.** New deps: `@xyflow/react`, `@dagrejs/dagre`.
- **Helpers flush, never commit** (callers/bg wrappers own the commit) — the `parent_mirror.py` convention.
- **Test gate:** full-suite failure-SET diff vs base `8856e28`, not zero failures (known baseline failures exist). New tests follow the house pattern: live dev DB, `TEST-`prefixed rows, FK-safe cleanup, `pytest.skip` if seed rows missing (see `tests/test_parent_mirror_hooks.py`).
- **Commits:** small, per-task, message style `feat(workflow): …`, each ending with the repo's two trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01U4dHcTi4YBPmuKnn1W7j59`.
- Worktree: `C:\tmp\Accu-Mk1-state-system`, branch `feat/state-system-mirror`. Backend tests run in a bind-mounted container (executor sets one up like `parent-mirror-test`; `docker exec <c> sh -c "cd /app && python -m pytest …"` — `-w /app` breaks on Windows).

## File Structure (locked)

```
backend/workflow/__init__.py          (empty package marker)
backend/workflow/catalog.py           Task 2 — catalog CRUD service + requirement validation + graph payload
backend/workflow/routes.py            Task 2 — APIRouter /api/workflow (admin-gated)
backend/workflow/sample_log.py        Task 3 — record_sample_transition + dedup
backend/workflow/is_event_stream.py   Task 5 — cursor sync from IS sample_status_events (retirable module)
backend/workflow/observer.py          Task 7 — passive analysis drift observer
backend/workflow/seeds.py             Task 1 — seed data + seed_workflow_catalog(db)
backend/scripts/backfill_sample_transitions_from_is.py   Task 6
backend/tests/test_workflow_schema_seeds.py               Task 1
backend/tests/test_workflow_catalog_api.py                Task 2
backend/tests/test_sample_transition_log.py               Tasks 3-4
backend/tests/test_is_event_stream_sync.py                Task 5
backend/tests/test_backfill_sample_transitions.py         Task 6
backend/tests/test_analysis_drift_observer.py             Task 7
backend/tests/test_registry_debug_transitions.py          Task 8
src/lib/workflow-api.ts                                   Task 9
src/components/preferences/panes/WorkflowPane.tsx          Task 9
src/components/preferences/panes/workflow/WorkflowDrawers.tsx  Task 9
src/components/preferences/panes/workflow/GraphCanvas.tsx  Task 10 (lazy)
src/components/preferences/panes/__tests__/WorkflowPane.test.tsx  Tasks 9-10
```

Modified: `backend/database.py` (DDL appended before the list-close at ~line 1165; `transition_kind` CHECKs at `:585` and `:763-766` gain `'observed'`), `backend/models.py` (4 new classes after `LimsAnalysisTransition` ~line 1390), `backend/main.py` (router include ~line 489; hooks at `publish_sample_coa` ~10314 and `receive_senaite_sample` ~13648-13672; observer hook in `lookup_senaite_sample` ~12942 and `_build_analysis_debug_rows` ~17296; sync startup near ~361; registry-debug payload ~17280+), `backend/sub_samples/service.py` (`_refresh_parent_from_senaite` :331), `src/components/preferences/panes.tsx`, `src/lib/api.ts` (registry-debug type only), `src/components/senaite/SampleRegistryDebug.tsx`, `package.json` (deps).

---

### Task 1: Schema, models, and catalog seeds

**Files:**
- Modify: `backend/database.py` (append DDL before list-close ~`:1165`; edit CHECKs at `:583-586` and `:763-766`; call seeder in `init_db`)
- Modify: `backend/models.py` (after `LimsAnalysisTransition`, ~`:1390`)
- Create: `backend/workflow/__init__.py`, `backend/workflow/seeds.py`
- Test: `backend/tests/test_workflow_schema_seeds.py`

**Interfaces:**
- Produces models: `LimsWorkflowState`, `LimsWorkflowTransition`, `LimsSampleTransition`, `LimsWorkflowSyncState` (importable from `models`).
- Produces `workflow.seeds.seed_workflow_catalog(db) -> dict` (idempotent; returns `{"states_created": int, "transitions_created": int}`).
- Later tasks rely on exact column names given below.

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_workflow_schema_seeds.py
"""Schema + seed tests for the workflow state system (slice 3, Task 1)."""
from sqlalchemy import inspect, text
import pytest
from database import SessionLocal, engine
from models import (LimsWorkflowState, LimsWorkflowTransition,
                    LimsSampleTransition, LimsWorkflowSyncState)
from workflow.seeds import seed_workflow_catalog


@pytest.fixture()
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


def test_tables_exist():
    names = inspect(engine).get_table_names()
    for t in ("lims_workflow_states", "lims_workflow_transitions",
              "lims_sample_transitions", "lims_workflow_sync_state"):
        assert t in names


def test_transition_kind_check_accepts_observed(db):
    row = db.execute(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname='lims_analysis_transitions_transition_kind_check'"
    )).scalar()
    assert "observed" in (row or "")


def test_sample_transitions_source_check(db):
    row = db.execute(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname='lims_sample_transitions_source_check'")).scalar()
    for s in ("mk1", "senaite", "reconcile", "is_seed"):
        assert s in row


def test_seed_idempotent(db):
    first = seed_workflow_catalog(db)
    db.commit()
    again = seed_workflow_catalog(db)
    db.commit()
    assert again == {"states_created": 0, "transitions_created": 0}
    # spot-check content
    slugs = {s.slug for s in db.query(LimsWorkflowState)
             .filter(LimsWorkflowState.entity_scope == "sample")}
    assert {"sample_due", "sample_received", "published", "cancelled",
            "waiting_for_addon_results"} <= slugs
    sentinel = (db.query(LimsWorkflowState)
                .filter_by(entity_scope="analysis", slug="senaite_mirror").one())
    assert sentinel.is_active is False and sentinel.category == "exception"


def test_seed_requirements_shape(db):
    seed_workflow_catalog(db)
    db.commit()
    verify = (db.query(LimsWorkflowTransition)
              .join(LimsWorkflowState, LimsWorkflowTransition.to_state_id == LimsWorkflowState.id)
              .filter(LimsWorkflowTransition.entity_scope == "sample",
                      LimsWorkflowTransition.verb == "verify").one())
    assert verify.requirements == [
        {"kind": "all_analyses_in_state", "value": "verified", "note": None}]
```

- [ ] **Step 2: Run tests, verify failure** — `python -m pytest tests/test_workflow_schema_seeds.py -x -q` → ImportError (models missing).

- [ ] **Step 3: DDL in `database.py`** — append these strings immediately before the migrations list-close (`]` at ~`:1165`):

```python
        # ── workflow state system (phase-out slice 3, spec 2026-07-12) ──
        """
        CREATE TABLE IF NOT EXISTS lims_workflow_states (
            id           SERIAL PRIMARY KEY,
            entity_scope TEXT NOT NULL CHECK (entity_scope IN ('sample','analysis')),
            slug         TEXT NOT NULL,
            label        TEXT NOT NULL,
            description  TEXT,
            category     TEXT NOT NULL DEFAULT 'active'
                         CHECK (category IN ('active','terminal','exception')),
            color        TEXT,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            is_builtin   BOOLEAN NOT NULL DEFAULT FALSE,
            is_active    BOOLEAN NOT NULL DEFAULT TRUE,
            created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_lims_workflow_states_scope_slug UNIQUE (entity_scope, slug)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS lims_workflow_transitions (
            id            SERIAL PRIMARY KEY,
            entity_scope  TEXT NOT NULL CHECK (entity_scope IN ('sample','analysis')),
            from_state_id INTEGER NOT NULL REFERENCES lims_workflow_states(id),
            to_state_id   INTEGER NOT NULL REFERENCES lims_workflow_states(id),
            verb          TEXT NOT NULL,
            label         TEXT,
            description   TEXT,
            requirements  JSONB NOT NULL DEFAULT '[]',
            sort_order    INTEGER NOT NULL DEFAULT 0,
            is_builtin    BOOLEAN NOT NULL DEFAULT FALSE,
            is_active     BOOLEAN NOT NULL DEFAULT TRUE,
            created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_lims_workflow_transitions_edge UNIQUE (entity_scope, from_state_id, verb)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS lims_sample_transitions (
            id             SERIAL PRIMARY KEY,
            lims_sample_pk INTEGER NOT NULL REFERENCES lims_samples(id) ON DELETE CASCADE,
            verb           TEXT,
            from_status    TEXT,
            to_status      TEXT NOT NULL,
            source         TEXT NOT NULL
                           CONSTRAINT lims_sample_transitions_source_check
                           CHECK (source IN ('mk1','senaite','reconcile','is_seed')),
            actor_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
            occurred_at    TIMESTAMP NOT NULL,
            is_event_id    TEXT,
            created_at     TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_sample_transitions_sample ON lims_sample_transitions (lims_sample_pk, occurred_at)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_sample_transitions_event ON lims_sample_transitions (is_event_id) WHERE is_event_id IS NOT NULL",
        """
        CREATE TABLE IF NOT EXISTS lims_workflow_sync_state (
            name              TEXT PRIMARY KEY,
            cursor_created_at TIMESTAMPTZ,
            updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """,
```

Then edit **both** `transition_kind` CHECK lists to add `'observed'`:
- the CREATE at `database.py:583-586`
- the DROP/re-ADD pair at `database.py:763-766` (this one re-runs every boot, so editing it migrates existing DBs)

```sql
('assign','submit','verify','retract','reject',
 'retest','publish','reset','auto','variance_verify','observed')
```

Do **NOT** add `observed` to `state_machine.TRANSITION_KINDS` (`lims_analyses/state_machine.py:84`) — it is not a performable verb; observer rows are written directly, bypassing `apply_transition`. Add a one-line comment saying so next to the frozenset.

Finally, in `init_db()` after the migrations loop, call the seeder (import inside the function to avoid cycles):

```python
    try:
        from workflow.seeds import seed_workflow_catalog
        with SessionLocal() as _wf_db:
            seed_workflow_catalog(_wf_db)
            _wf_db.commit()
    except Exception as e:  # never block startup
        log.warning("workflow_seed_skipped err=%s", e)
```

- [ ] **Step 4: Models in `models.py`** (insert after `LimsAnalysisTransition`, before `LimsSubSampleEvent` ~`:1393`; match the file's `Mapped[]` style):

```python
class LimsWorkflowState(Base):
    """Workflow catalog: one state definition per (entity_scope, slug).

    Descriptive while SENAITE is system of record — no live path reads it
    until the authority-swap slice (spec 2026-07-12 §3)."""
    __tablename__ = "lims_workflow_states"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    entity_scope: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    category: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    color: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)


class LimsWorkflowTransition(Base):
    """Workflow catalog edge: from → to via verb, with machine-checkable
    (but dormant) requirement entries. See workflow/catalog.py for the
    requirement-kind registry."""
    __tablename__ = "lims_workflow_transitions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    entity_scope: Mapped[str] = mapped_column(Text, nullable=False)
    from_state_id: Mapped[int] = mapped_column(Integer, ForeignKey("lims_workflow_states.id"), nullable=False)
    to_state_id: Mapped[int] = mapped_column(Integer, ForeignKey("lims_workflow_states.id"), nullable=False)
    verb: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    requirements: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)

    from_state: Mapped["LimsWorkflowState"] = relationship("LimsWorkflowState", foreign_keys=[from_state_id])
    to_state: Mapped["LimsWorkflowState"] = relationship("LimsWorkflowState", foreign_keys=[to_state_id])


class LimsSampleTransition(Base):
    """Append-only sample-level transition log (mirror of SENAITE reality).

    source: 'mk1' (our endpoint, actor known) | 'senaite' (IS event stream)
          | 'reconcile' (drift synthesized) | 'is_seed' (historical backfill).
    """
    __tablename__ = "lims_sample_transitions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    lims_sample_pk: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_samples.id", ondelete="CASCADE"), nullable=False)
    verb: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    from_status: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    actor_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id"), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    is_event_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class LimsWorkflowSyncState(Base):
    """Single-row-per-stream cursor for the IS event-stream sync (retired at
    the Mk1→IS inversion; spec §7)."""
    __tablename__ = "lims_workflow_sync_state"

    name: Mapped[str] = mapped_column(Text, primary_key=True)
    cursor_created_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)
```

(`JSONB` import: `from sqlalchemy.dialects.postgresql import JSONB` — check the top of models.py; add if absent.)

- [ ] **Step 5: Seeds — `backend/workflow/seeds.py`**

```python
"""Idempotent workflow-catalog seeds (spec §5.5). Handler curates via the
settings page afterward — seed descriptions are deliberately minimal."""
from sqlalchemy.orm import Session
from models import LimsWorkflowState, LimsWorkflowTransition

# (scope, slug, label, category, sort_order, description)
SEED_STATES = [
    ("sample", "sample_registered", "Registered", "active", 10, "Order created; not yet due at the lab."),
    ("sample", "sample_due", "Due", "active", 20, "Expected at the lab; not yet received."),
    ("sample", "sample_received", "Received", "active", 30, "Checked in at the lab."),
    ("sample", "ready_for_initial_review", "Ready for Initial Review", "active", 40, "Custom Accumark state."),
    ("sample", "waiting_for_addon_results", "Waiting for Add-on Results", "active", 50, "Custom Accumark state."),
    ("sample", "to_be_verified", "To Be Verified", "active", 60, "All results submitted; awaiting review."),
    ("sample", "verified", "Verified", "active", 70, "Results verified by the lab."),
    ("sample", "published", "Published", "terminal", 80, "COA published to the customer."),
    ("sample", "dispatched", "Dispatched", "terminal", 90, "Physically dispatched/stored out."),
    ("sample", "cancelled", "Cancelled", "exception", 100, "Cancelled before completion."),
    ("sample", "invalid", "Invalid", "exception", 110, "Invalidated after publish (retest issued)."),
    ("analysis", "registered", "Registered", "active", 5, "Line created, workflow not started."),
    ("analysis", "unassigned", "Unassigned", "active", 10, "Awaiting worksheet assignment."),
    ("analysis", "assigned", "Assigned", "active", 20, "On a worksheet."),
    ("analysis", "to_be_verified", "To Be Verified", "active", 30, "Result submitted."),
    ("analysis", "verified", "Verified", "active", 40, "Result verified."),
    ("analysis", "published", "Published", "terminal", 50, "On a published COA."),
    ("analysis", "promoted", "Promoted", "terminal", 55, "Sub-sample result promoted to parent."),
    ("analysis", "variance_verified", "Variance Verified", "active", 45, "Verified within the variance flow."),
    ("analysis", "rejected", "Rejected", "exception", 60, "Rejected by the lab."),
    ("analysis", "retracted", "Retracted", "exception", 70, "Retired; SENAITE spawns a replacement copy."),
    ("analysis", "cancelled", "Cancelled", "exception", 80, "Cancelled with its sample."),
    ("analysis", "senaite_mirror", "SENAITE Mirror (sentinel)", "exception", 999,
     "Internal sentinel — shadow mirror rows; never a real workflow position."),
]

# (scope, from_slug, to_slug, verb, requirements, description)
SEED_TRANSITIONS = [
    ("sample", "sample_registered", "sample_due", "to_due", [], "Order dispatched toward the lab."),
    ("sample", "sample_due", "sample_received", "receive", [], "Lab check-in."),
    ("sample", "sample_received", "to_be_verified", "submit", [], "All analyses submitted."),
    ("sample", "to_be_verified", "verified", "verify",
     [{"kind": "all_analyses_in_state", "value": "verified", "note": None}],
     "Lab verification of all results."),
    ("sample", "verified", "published", "publish",
     [{"kind": "all_analyses_in_state", "value": "verified", "note": "COA generated and published via Mk1"}],
     "COA publish."),
    ("sample", "sample_received", "dispatched", "dispatch", [], "Physical dispatch."),
    ("sample", "sample_due", "cancelled", "cancel", [], "Cancel before receipt."),
    ("sample", "sample_received", "cancelled", "cancel", [], "Cancel after receipt."),
    ("sample", "published", "invalid", "invalidate", [], "Invalidate a published sample (spawns retest)."),
    ("analysis", "registered", "unassigned", "init", [], "Line enters the workflow."),
    ("analysis", "unassigned", "assigned", "assign", [], "Worksheet assignment."),
    ("analysis", "unassigned", "to_be_verified", "submit", [], "Result entry + submit."),
    ("analysis", "assigned", "to_be_verified", "submit", [], "Result entry + submit."),
    ("analysis", "to_be_verified", "verified", "verify", [], "Result verification."),
    ("analysis", "to_be_verified", "variance_verified", "variance_verify", [], "Variance-flow verification."),
    ("analysis", "to_be_verified", "rejected", "reject", [], "Reject a submitted result."),
    ("analysis", "unassigned", "rejected", "reject", [], "Reject an unstarted line."),
    ("analysis", "to_be_verified", "retracted", "retract", [],
     "Retire-and-replace: original retracted, SENAITE spawns an unassigned copy with the result carried."),
    ("analysis", "verified", "retracted", "retract", [],
     "Retire-and-replace from verified."),
    ("analysis", "verified", "verified", "retest", [],
     "Spawns a new unassigned retest line (retest_of link); the original stays verified, flagged retested."),
    ("analysis", "verified", "published", "publish", [], "Rides the sample COA publish."),
    ("analysis", "verified", "promoted", "promote", [], "Sub-sample tier: promote result to parent."),
]


def seed_workflow_catalog(db: Session) -> dict:
    created_s = created_t = 0
    by_key: dict[tuple, LimsWorkflowState] = {}
    for scope, slug, label, category, sort_order, desc in SEED_STATES:
        row = (db.query(LimsWorkflowState)
               .filter_by(entity_scope=scope, slug=slug).one_or_none())
        if row is None:
            row = LimsWorkflowState(
                entity_scope=scope, slug=slug, label=label, category=category,
                sort_order=sort_order, description=desc, is_builtin=True,
                is_active=(slug != "senaite_mirror"))
            db.add(row)
            db.flush()
            created_s += 1
        by_key[(scope, slug)] = row
    for scope, f, t, verb, reqs, desc in SEED_TRANSITIONS:
        frm, to = by_key[(scope, f)], by_key[(scope, t)]
        exists = (db.query(LimsWorkflowTransition)
                  .filter_by(entity_scope=scope, from_state_id=frm.id, verb=verb)
                  .one_or_none())
        if exists is None:
            db.add(LimsWorkflowTransition(
                entity_scope=scope, from_state_id=frm.id, to_state_id=to.id,
                verb=verb, requirements=reqs, description=desc, is_builtin=True))
            db.flush()
            created_t += 1
    return {"states_created": created_s, "transitions_created": created_t}
```

- [ ] **Step 6: Apply migrations in the test container** — rerun `init_db()` (`docker exec <c> sh -c "cd /app && python -c 'from database import init_db; init_db()'"`), then run tests: `python -m pytest tests/test_workflow_schema_seeds.py -x -q` → all PASS.

- [ ] **Step 7: Commit** — `git add backend/database.py backend/models.py backend/workflow/ backend/tests/test_workflow_schema_seeds.py` → `feat(workflow): catalog + sample-transition schema, models, idempotent seeds`

---

### Task 2: Catalog service + admin API

**Files:**
- Create: `backend/workflow/catalog.py`, `backend/workflow/routes.py`
- Modify: `backend/main.py` (`app.include_router(workflow_router)` after `:489`; import beside the slack router imports `:84-85`)
- Test: `backend/tests/test_workflow_catalog_api.py`

**Interfaces:**
- Consumes Task-1 models.
- Produces `workflow.catalog`: `REQUIREMENT_KINDS: frozenset`, `validate_requirements(entries) -> list` (raises `ValueError`), `graph_payload(db, scope: str) -> dict`, `usage_counts(db, scope: str) -> dict[str, int]`.
- Produces routes (all `Depends(require_admin)` from `auth.py:127`):
  `GET /api/workflow/graph?scope=`, `POST/PATCH/DELETE /api/workflow/states[/{id}]`, `POST/PATCH/DELETE /api/workflow/transitions[/{id}]`.

- [ ] **Step 1: Write failing tests** — key cases (TestClient with `require_admin` override, house pattern; TEST slugs prefixed `test_wf_`):

```python
# backend/tests/test_workflow_catalog_api.py  (representative cases — implement all)
def test_graph_payload_shape(client, db):        # states+transitions+usage_count present
def test_create_state_and_transition(client):    # POST both, 200, slug round-trip
def test_cross_scope_edge_rejected(client):      # sample from-state + analysis to-state -> 422
def test_unknown_requirement_kind_rejected(client):  # kind="frobnicate" -> 422
def test_delete_builtin_409(client):             # DELETE seeded state -> 409, detail mentions deactivate
def test_delete_state_with_usage_409(client, db):  # state slug matching a live lims_samples.status -> 409
def test_delete_unused_custom_state_ok(client):  # create fresh custom state -> DELETE -> 204
def test_deactivate_instead(client):             # PATCH is_active=false on builtin -> 200
def test_requires_admin(client_non_admin):       # any route without admin -> 403
```

Usage-count rule (implement in `usage_counts`): sample scope = `SELECT status, COUNT(*) FROM lims_samples GROUP BY status`; analysis scope = canonical rows by `review_state` **plus** shadow rows by `mirror_review_state`, summed per slug.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `catalog.py`**

```python
"""Workflow catalog service. Descriptive-only while SENAITE is authority —
validation here guards catalog INTEGRITY, never live workflow behavior."""
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from models import (LimsWorkflowState, LimsWorkflowTransition,
                    LimsSample, LimsAnalysis)

REQUIREMENT_KINDS = frozenset({"all_analyses_in_state", "field_present",
                               "role_at_least", "manual"})


def validate_requirements(entries):
    if not isinstance(entries, list):
        raise ValueError("requirements must be a list")
    cleaned = []
    for e in entries:
        if not isinstance(e, dict) or e.get("kind") not in REQUIREMENT_KINDS:
            raise ValueError(f"unknown requirement kind: {e!r}")
        if e["kind"] != "manual" and not e.get("value"):
            raise ValueError(f"requirement kind {e['kind']} needs a value")
        cleaned.append({"kind": e["kind"], "value": e.get("value"),
                        "note": e.get("note")})
    return cleaned


def usage_counts(db: Session, scope: str) -> dict:
    if scope == "sample":
        rows = db.execute(select(LimsSample.status, func.count())
                          .group_by(LimsSample.status)).all()
        return {s: c for s, c in rows if s}
    counts: dict[str, int] = {}
    for col, flt in ((LimsAnalysis.review_state, LimsAnalysis.provenance == "canonical"),
                     (LimsAnalysis.mirror_review_state, LimsAnalysis.provenance == "shadow")):
        for s, c in db.execute(select(col, func.count()).where(flt).group_by(col)).all():
            if s:
                counts[s] = counts.get(s, 0) + c
    return counts


def graph_payload(db: Session, scope: str) -> dict:
    usage = usage_counts(db, scope)
    states = (db.query(LimsWorkflowState).filter_by(entity_scope=scope)
              .order_by(LimsWorkflowState.sort_order).all())
    transitions = (db.query(LimsWorkflowTransition).filter_by(entity_scope=scope)
                   .order_by(LimsWorkflowTransition.sort_order,
                             LimsWorkflowTransition.id).all())
    return {
        "scope": scope,
        "states": [{
            "id": s.id, "slug": s.slug, "label": s.label,
            "description": s.description, "category": s.category,
            "color": s.color, "sort_order": s.sort_order,
            "is_builtin": s.is_builtin, "is_active": s.is_active,
            "usage_count": usage.get(s.slug, 0),
        } for s in states],
        "transitions": [{
            "id": t.id, "from_state_id": t.from_state_id,
            "to_state_id": t.to_state_id, "verb": t.verb, "label": t.label,
            "description": t.description, "requirements": t.requirements,
            "is_builtin": t.is_builtin, "is_active": t.is_active,
        } for t in transitions],
    }
```

- [ ] **Step 4: Implement `routes.py`** — `router = APIRouter(prefix="/api/workflow", tags=["workflow"], dependencies=[Depends(require_admin)])`; Pydantic bodies (`StateCreate`, `StateUpdate`, `TransitionCreate`, `TransitionUpdate`); guardrails in the handlers:
  - create/patch transition: both states fetched, must exist and share `entity_scope` else 422; `requirements` through `validate_requirements` (ValueError → 422).
  - DELETE state: 409 if `is_builtin`, if `usage_counts` shows live rows for its slug, or if any transition references it (detail says "deactivate instead"); else hard delete.
  - DELETE transition: 409 if `is_builtin`, else delete.
  - PATCH: `slug`/`entity_scope` immutable (not in the update model).
  - All writes `db.commit()` in the handler (routes own their commits — matches flags routes convention).
Mount in `main.py`: `from workflow.routes import router as workflow_router` beside `:84-85`, `app.include_router(workflow_router)` after `:489`.

- [ ] **Step 5: Run tests → PASS; run Task-1 tests too (no regressions).**

- [ ] **Step 6: Commit** — `feat(workflow): catalog CRUD API with guardrails + graph payload`

---

### Task 3: Sample-transition recorder + the two Mk1 hooks

**Files:**
- Create: `backend/workflow/sample_log.py`
- Modify: `backend/main.py` — `_record_sample_transition_bg` helper next to `_mirror_parent_analysis_bg` (~`:13820`); hook in `publish_sample_coa` beside the `actual_state == "published"` gate (~`:10314`); hook in `receive_senaite_sample` inside the verified-receive branch (~`:13648-13672`)
- Test: `backend/tests/test_sample_transition_log.py`

**Interfaces:**
- Produces `workflow.sample_log.record_sample_transition(db, *, sample_id: str, to_status: str, source: str, verb: str | None = None, from_status: str | None = None, actor_user_id: int | None = None, occurred_at: datetime | None = None, is_event_id: str | None = None) -> bool` — resolves `lims_samples` by `sample_id` string (returns False if absent), **flushes, never commits**; returns False on dedup/skip.
- Dedup rules inside the recorder (spec §6.2/§6.3):
  - `source='senaite'`: skip if an `mk1` row exists for same `(lims_sample_pk, verb)` with `occurred_at` within ±5 min.
  - `source='reconcile'`: skip if ANY row exists with same `(lims_sample_pk, to_status)` and `occurred_at` within the last 60 min.
  - `is_event_id` uniqueness enforced by the DB partial index (IntegrityError → return False, caller rolls back only the failed insert via nested savepoint `db.begin_nested()`).
- Produces `main._record_sample_transition_bg(**kwargs) -> None` (own session, commits; copies the `_mirror_parent_analysis_bg` idiom `main.py:13820-13868` exactly, logging `workflow.sample_log_failed`).

- [ ] **Step 1: Failing tests** — recorder unit cases (insert, senaite-dedup-window skip, reconcile-explained skip, unknown sample False, event-id duplicate False) + endpoint hook cases via TestClient with SENAITE mocked (`patch("httpx.AsyncClient")` idiom from `tests/test_parent_mirror_hooks.py:69`):
  - publish flow writes `verb='publish', source='mk1', actor_user_id set`
  - receive flow writes `verb='receive'`
  - recorder raising inside the bg wrapper does NOT change the endpoint response (never-fail proof — patch `record_sample_transition` to raise).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `sample_log.py`** (single function + private `_explained` helper; ~70 lines; use `db.begin_nested()` around the insert so an IntegrityError on `is_event_id` doesn't poison the caller's transaction).

- [ ] **Step 4: Wire the two hooks.** Publish (inside the `actual_state == "published"` block, after the shadow-mark schedule at `:10314-10316`):

```python
await run_in_threadpool(
    _record_sample_transition_bg,
    sample_id=sample_id, verb="publish", to_status="published",
    from_status=(_parent_row.status if _parent_row is not None else None),
    source="mk1",
    actor_user_id=getattr(current_user, "id", None),
)
```

Receive (inside `receive_senaite_sample` immediately after the `new_state == "sample_received"` verification succeeds):

```python
await run_in_threadpool(
    _record_sample_transition_bg,
    sample_id=req.sample_id, verb="receive", to_status="sample_received",
    from_status="sample_due", source="mk1",
    actor_user_id=getattr(current_user, "id", None),
)
```

(Adjust the exact sample-id variable name to what the endpoint has in scope — read the function first; it verifies `new_state` at `:13648-13672`.)

- [ ] **Step 5: Run tests → PASS. Step 6: Commit** — `feat(workflow): native sample-transition log + publish/receive mk1 hooks`

---

### Task 4: Reconcile drift synthesis

**Files:**
- Modify: `backend/sub_samples/service.py` `_refresh_parent_from_senaite` (`:331`)
- Test: extend `backend/tests/test_sample_transition_log.py`

**Interfaces:**
- Consumes `record_sample_transition` (Task 3).
- Behavior: capture `old = parent.status` before `_populate_basic_info`; after it, if `parent.status != old`, call `record_sample_transition(db, sample_id=parent.sample_id, to_status=parent.status, from_status=old, source="reconcile", occurred_at=None)` wrapped in `try/except Exception: logger.warning("workflow.reconcile_log_failed ...")` — the refresh must never fail because of logging. The recorder's 60-min explained-window (Task 3) prevents double-logging transitions already captured by mk1/senaite rows.

- [ ] **Step 1: Failing tests** — patch `sub_samples.senaite.fetch_parent_metadata` to return a changed `review_state`; call `_refresh_parent_from_senaite`; assert a `source='reconcile'` row with correct from/to. Second test: pre-insert an `mk1` row with same `to_status` 1 min ago → no reconcile row. Third: recorder raising → refresh still succeeds.
- [ ] **Step 2-4: Run fail → implement (≈8 lines) → run pass.**
- [ ] **Step 5: Commit** — `feat(workflow): reconcile drift synthesis into the sample-transition log`

---

### Task 5: IS event-stream incremental sync

**Files:**
- Create: `backend/workflow/is_event_stream.py`
- Modify: `backend/main.py` startup (beside `_slack_maybe_start`, ~`:361`)
- Test: `backend/tests/test_is_event_stream_sync.py`

**Interfaces:**
- Consumes `integration_db.get_integration_db()` (`integration_db.py:103` — sync psycopg2 contextmanager, `RealDictCursor`) and `record_sample_transition`.
- IS source-of-truth columns (`sample_status_events`): `sample_id` (str), `transition` (str), `new_status` (str), `event_id` (str|null), `event_timestamp` (**unix int**, nullable), `created_at` (tz-aware). Convert: `occurred_at = datetime.utcfromtimestamp(event_timestamp) if event_timestamp else created_at (tz stripped to naive UTC)`.
- Produces:
  - `sync_once(db_factory, *, batch_size: int = 500, overlap_minutes: int = 10) -> dict` — stats `{"fetched", "inserted", "dup", "no_sample", "errors"}`. Reads cursor row `name='is_sample_events'` from `lims_workflow_sync_state`; queries IS `WHERE created_at > cursor - overlap ORDER BY created_at ASC LIMIT batch`; per event calls `record_sample_transition(..., source="senaite", verb=ev["transition"], to_status=ev["new_status"], is_event_id=ev["event_id"] or f"synth:{ev['id']}")`; commits per batch; advances cursor to max `created_at` seen **only after commit**. Missing sample → `no_sample` count (skip).
  - `maybe_start(app) -> None` — if `INTEGRATION_DB` config resolves and `os.getenv("MK1_IS_EVENT_SYNC_ENABLED", "1") != "0"`: spawn `asyncio.create_task` loop `while True: await run_in_threadpool(sync_once, SessionLocal); await asyncio.sleep(int(os.getenv("MK1_IS_EVENT_SYNC_INTERVAL_SECONDS", "300")))`, each tick try/except + `logger.warning("workflow.is_sync_failed err=…")`. Wire `maybe_start(app)` in main.py startup next to the slack starter.
- **Retirement banner:** module docstring MUST state this is the only IS→Mk1 puller and is deleted wholesale at the Mk1→IS inversion (spec §7).

- [ ] **Step 1: Failing tests** — patch `workflow.is_event_stream._fetch_events` (extract the IS query into that seam) to return fabricated event dicts: (a) fresh event → inserted + cursor advanced; (b) same event re-synced → dup (event_id partial unique); (c) event matching an mk1 row within ±5 min → dup (window rule); (d) unknown sample_id → no_sample; (e) `_fetch_events` raising → stats errors, cursor NOT advanced.
- [ ] **Step 2-4: Run fail → implement → run pass.**
- [ ] **Step 5: Commit** — `feat(workflow): IS event-stream incremental sync (retirable puller)`

---

### Task 6: Historical seed backfill script

**Files:**
- Create: `backend/scripts/backfill_sample_transitions_from_is.py`
- Test: `backend/tests/test_backfill_sample_transitions.py`

**Interfaces:**
- Consumes `record_sample_transition` + `get_integration_db`.
- Mirrors the shipped backfill's operational shape (`scripts/backfill_parent_analysis_shadows.py`): argparse `--batch-size` (default 1000), `--checkpoint` (default `/tmp/backfill_sample_transitions.checkpoint.json`, atomic `{"last_created_at": iso}` via tmp+`os.replace`), `--dry-run` (would_insert counts, zero writes, no checkpoint), `--limit N`; stats `{"fetched","inserted","dup","no_sample","would_insert","errors"}`; `main()` prints `json.dumps(stats)`, exit `1 if errors else 0`. Inserts use `source="is_seed"`. No sleep throttle needed (DB-to-DB) — but keep `--sleep` (default 0) for operator control.
- Ordering: pages IS events by `created_at ASC` from the checkpoint; checkpoint advances per page **after** commit.

- [ ] **Step 1: Failing tests** — same seam-patching approach as Task 5 (`_fetch_events` page fabrication): dry-run writes nothing + counts; real run inserts `source='is_seed'`; re-run → all dup; checkpoint resume skips earlier pages; unknown samples counted.
- [ ] **Step 2-4: fail → implement → pass. Step 5: Commit** — `feat(workflow): sample-transition history seed backfill from IS`

---

### Task 7: Passive analysis drift observer

**Files:**
- Create: `backend/workflow/observer.py`
- Modify: `backend/main.py` — hook in `lookup_senaite_sample` right after `senaite_analyses` is fully built (immediately before the response assembly that uses it at ~`:12942`), and in `_build_analysis_debug_rows` after `items = senaite.fetch_parent_analyses(sample_id)` (~`:17296`); add `_observe_parent_analyses_bg` beside the other `_bg` helpers.
- Test: `backend/tests/test_analysis_drift_observer.py`

**Interfaces:**
- Produces `workflow.observer.observe_parent_analyses(db, *, sample_id: str, observed: list[dict]) -> int` — `observed` dicts need keys `keyword`, `review_state`, `result` (the panel path passes `fetch_parent_analyses` items which already have exactly these — `sub_samples/senaite.py:295-311`; the lookup path projects them from the `SenaiteAnalysis` pydantic objects — first read `class SenaiteAnalysis` in main.py to map its field names for keyword/state/result, then build `[{"keyword": a.<kw>, "review_state": a.<state>, "result": a.<result>} for a in senaite_analyses]`).
- Behavior per keyword (reuses slice-2 selection): find the live shadow row (`provenance='shadow' AND retested=FALSE`, newest id) for `(sample, keyword)`; if `mirror_review_state != observed review_state` (both non-null): update shadow `mirror_review_state` (+ `result_value` when changed) AND `db.add(LimsAnalysisTransition(analysis_id=shadow.id, from_state=<old mirror>, to_state=<new>, transition_kind="observed", user_id=None, reason="SENAITE-direct change observed via display fetch"))`. Flush-never-commit; returns count of drift rows written. No shadow row → skip (backfill owns creation).
- Produces `main._observe_parent_analyses_bg(sample_id: str, observed: list[dict])` — the standard own-session/commit/never-raise wrapper (`workflow.observer_failed` warning). Both hook sites schedule via `await run_in_threadpool(...)` **only when the fetch succeeded**; failures never affect the page.

- [ ] **Step 1: Failing tests** — seed parent + shadow (slice-2 fixture idiom from `test_parent_mirror_hooks.py:117`): (a) observed state differs → shadow healed + `transition_kind='observed'` row with correct from/to; (b) observed matches → zero writes; (c) no shadow row → zero writes; (d) result drift only → result healed, no transition row (state unchanged); (e) bg wrapper never raises when observer explodes.
- [ ] **Step 2-4: fail → implement → pass. Step 5: Commit** — `feat(workflow): passive analysis drift observer (transition_kind=observed)`

---

### Task 8: Registry-inspect "recent transitions" tail

**Files:**
- Modify: `backend/main.py` `_build_registry_debug_response` (~`:17280+`) — add `"transitions"` key
- Modify: `src/lib/api.ts` — extend the registry-debug response type
- Modify: `src/components/senaite/SampleRegistryDebug.tsx` — render the tail under the analyses column
- Test: `backend/tests/test_registry_debug_transitions.py` + extend `src/components/senaite/__tests__/SampleRegistryDebug.test.tsx`

**Interfaces:**
- Backend payload addition: `"transitions": {"rows": [{"verb", "from_status", "to_status", "source", "occurred_at" (iso)} × ≤5 newest], "error": None}` — own try/except like the analyses section (`main.py:17276` posture): failure yields `{"rows": [], "error": str(e)}`, never blanks the rest. `row is None` case → `"transitions": None`.
- FE: `transitions?: { rows: Array<{verb: string|null; from_status: string|null; to_status: string; source: string; occurred_at: string}>; error: string|null } | null` on the debug type; render as a compact mono list (`verb from→to · source · time`) below the analyses summary, matching the panel's existing font-mono styling.

- [ ] Steps: failing BE test (seed 6 log rows → newest 5 returned, order desc) + FE test (rows render, empty → "no transitions yet") → implement → pass → commit `feat(workflow): registry-inspect recent-transitions tail`.

---

### Task 9: FE — workflow API client, pane registration, drawers/forms (form-driven CRUD, no graph yet)

**Files:**
- Create: `src/lib/workflow-api.ts`, `src/components/preferences/panes/WorkflowPane.tsx`, `src/components/preferences/panes/workflow/WorkflowDrawers.tsx`
- Modify: `src/components/preferences/panes.tsx` (union id `'workflow'`, nav item, `PANE_COMPONENTS`)
- Test: `src/components/preferences/panes/__tests__/WorkflowPane.test.tsx`

**Interfaces:**
- `workflow-api.ts` (import `{ apiFetch }` from `'@/lib/api'`; snake_case fields mirroring backend):

```ts
export interface RequirementEntry { kind: 'all_analyses_in_state'|'field_present'|'role_at_least'|'manual'; value: string|null; note: string|null }
export interface WorkflowState { id: number; slug: string; label: string; description: string|null; category: 'active'|'terminal'|'exception'; color: string|null; sort_order: number; is_builtin: boolean; is_active: boolean; usage_count: number }
export interface WorkflowTransition { id: number; from_state_id: number; to_state_id: number; verb: string; label: string|null; description: string|null; requirements: RequirementEntry[]; is_builtin: boolean; is_active: boolean }
export interface WorkflowGraph { scope: 'sample'|'analysis'; states: WorkflowState[]; transitions: WorkflowTransition[] }
export const getWorkflowGraph = (scope: 'sample'|'analysis') => apiFetch<WorkflowGraph>(`/api/workflow/graph?scope=${scope}`)
// createWorkflowState / updateWorkflowState / deleteWorkflowState
// createWorkflowTransition / updateWorkflowTransition / deleteWorkflowTransition
// (POST/PATCH/DELETE via apiFetch with method+body; DELETE surfaces 409 detail text in the thrown Error)
```

- `panes.tsx`: add `'workflow'` to the `PreferencePane` union; nav item `{ id: 'workflow', labelKey: 'preferences.workflow', icon: GitBranch }` (lucide `GitBranch`); `PANE_COMPONENTS.workflow = WorkflowPane`. i18n: grep how `preferences.flags` resolves (check `src/i18n/`); add `preferences.workflow → "Workflow"` in the same resource; if the app renders raw keys for missing entries, the resource entry is mandatory.
- `WorkflowPane.tsx`: shadcn Tabs scope switcher (`sample`/`analysis`) → TanStack `useQuery(['workflow-graph', scope], () => getWorkflowGraph(scope))`; persistent Alert banner (*"Descriptive while SENAITE is system of record — requirements are documentation until the authority swap."*); admin check `useAuthStore(s => s.user?.role === 'admin')` gating Add/edit controls (read-only view otherwise); **temporary list rendering** of states/transitions (replaced by the canvas in Task 10 — keep the list behind the graph as the a11y/test fallback); "Add state"/"Add transition" buttons → dialogs in `WorkflowDrawers.tsx`; selecting a state/transition opens the detail Sheet (label, description, category select, requirements editor rows [kind select + value input + note input, add/remove], active switch, builtin badge, usage badge, "defined — not yet reachable" badge when `usage_count === 0 && !is_builtin`, Delete with 409-detail toast via sonner).
- Mutations invalidate `['workflow-graph', scope]`.

- [ ] **Step 1: Failing FE tests** (`@/test/test-utils` render; `vi.mock('@/lib/workflow-api', …)` spread-actual pattern; `useAuthStore.setState({user:{id:1, role:'admin'}})`): pane renders both scope tabs + banner; states list shows seeded labels + usage badges; create-state dialog submits and invalidates; 409 delete shows toast; non-admin sees read-only (no Add buttons).
- [ ] **Step 2-4: fail → implement → `npx tsc --noEmit` + `npx vitest run src/components/preferences/panes/__tests__/WorkflowPane.test.tsx` pass.**
- [ ] **Step 5: Commit** — `feat(workflow): settings pane with form-driven catalog CRUD`

---

### Task 10: FE — React Flow graph canvas

**Files:**
- Modify: `package.json` (deps), `src/components/preferences/panes/WorkflowPane.tsx` (swap list for lazy canvas; keep list as Suspense fallback)
- Create: `src/components/preferences/panes/workflow/GraphCanvas.tsx`
- Test: extend `WorkflowPane.test.tsx`

**Interfaces:**
- Deps: `npm install @xyflow/react @dagrejs/dagre` (**npm only**). `@dagrejs/dagre` ships its own types; if TS complains add `// @ts-expect-error` on the import and note it.
- `GraphCanvas.tsx` default-exports `function GraphCanvas(props: { graph: WorkflowGraph; showInactive: boolean; onSelectState: (id: number) => void; onSelectTransition: (id: number) => void })`:
  - `layoutGraph(graph)` helper: dagre `rankdir: 'LR'`, node size 180×64; returns positioned React Flow `nodes`/`edges`. Self-loops (retest) render with `type: 'default'` and a slight label offset — acceptable v1.
  - Node = custom `StateNode` component: label, usage-count Badge, category color strip (`active`=blue, `terminal`=green, `exception`=amber; `color` field overrides), ghost opacity when `!is_active` (hidden entirely unless `showInactive`).
  - Edges labeled with `verb`; `onNodeClick`/`onEdgeClick` → the props callbacks (drawer opens in the pane).
  - Import `'@xyflow/react/dist/style.css'` inside GraphCanvas (stays in the lazy chunk).
- `WorkflowPane.tsx`: `const GraphCanvas = React.lazy(() => import('./workflow/GraphCanvas'))`, rendered in `<Suspense fallback={<the Task-9 list />}>` — first `React.lazy` in the codebase (deliberate: keeps ~150 kB of graph code out of the main bundle; vite splits it natively). Add a "show inactive" Switch.

- [ ] **Step 1: Failing tests** — `vi.mock('./workflow/GraphCanvas', () => ({ default: (p) => <div data-testid="graph" data-nodes={p.graph.states.length} /> }))` (mocking the module neutralizes lazy in jsdom); assert canvas receives the graph and node-click plumbing opens the drawer (invoke the mocked prop).
- [ ] **Step 2-4: fail → implement → `npx tsc --noEmit` + vitest pass; `npm run build` completes and emits a separate chunk for GraphCanvas (verify in build output list).**
- [ ] **Step 5: Commit** — `feat(workflow): React Flow graph canvas (lazy, dagre layout)` (include `package.json` + `package-lock.json`)

---

### Task 11: Full-suite gate + ledger

- [ ] Backend: full `python -m pytest -q` in the container → failure-SET diff vs base `8856e28` (capture both lists; assert set-identical modulo the new passing tests).
- [ ] Frontend: `npx tsc --noEmit`, `npx vitest run` failure-set diff, `npm run build`.
- [ ] Update `.superpowers/sdd/progress.md` with per-task outcomes.
- [ ] Commit any stragglers — branch ready for final whole-branch review.

## Self-review notes (done at write time)

- Spec §5 tables → Task 1; §5.3 kinds → Task 2 `REQUIREMENT_KINDS`; §6.1 hooks → Task 3 (exactly two real sites per grounding — the spec's "receive path(s)" resolves to `receive_senaite_sample`; the write-surface audit confirmed `PUT /samples/{id}/reject` is the internal mass-spec model, NOT a LIMS transition, and no cancel/dispatch/invalidate sites exist in Mk1); §6.2 sync → Task 5; §6.3 → Task 4; §6.4 observer → Task 7; §6.5 seed → Task 6; §7 inversion → Task 5 docstring + schema completeness; §8 page → Tasks 2/9/10; §8 registry tail → Task 8; §9 invariants → distributed (never-fail tests in 3/4/5/7); §10 testing → per-task; §11 rollback needs no task (additive).
- IS-stream verbs (receive/submit/partial_submit/worksheet_assigned/verify/partial_verify/publish) never include reject/cancel — the reconcile fallback (Task 4) is the only capture path for those; noted in Task 4's purpose.
- Type consistency: `record_sample_transition` keyword args identical across Tasks 3/4/5/6; `WorkflowGraph` fields identical between Task 2 payload and Task 9 TS types.
