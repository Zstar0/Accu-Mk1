# Sample Priority — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Data-driven priorities with a four-level resolver, audit, SLA snapshots and an API that every list can embed, shipping behaviour-neutral until the lab maps a priority to a tier.

**Architecture:** New `backend/priority/` package (pure resolver + DB loader + assign service + snapshot helper + APIRouter). New tables `priorities`, `customer_priorities`, `priority_audit`; nullable `priority_key` on `lims_orders`, `lims_samples`, `lims_sub_samples`; snapshot columns on samples and sub-samples. Existing `sla_priority_tiers` gains an FK to `priorities.key`. The activity log derives its priority lines from `priority_audit` at read time (no dual write).

**Tech Stack:** FastAPI, SQLAlchemy 2 typed mappings, raw idempotent DDL in `database._run_migrations`, pytest with `backend/tests/conftest.py::db_session` and `TestClient` with `auth.get_current_user` overridden (see `backend/tests/test_api_sla_priority_tiers.py`).

**Spec:** `docs/superpowers/specs/2026-09-09-sample-priority-design.md`

## Global Constraints

- Additive only: no existing endpoint changes shape except adding optional fields. `sample_priorities` and `worksheet_items.priority` are NOT dropped in this plan (follow-up release).
- LIMS tables use the `lims_` prefix; new non-LIMS tables are `priorities`, `customer_priorities`, `priority_audit`.
- Migrations live in the `_run_migrations` statement list in `backend/database.py`; every statement is idempotent (`IF NOT EXISTS`, guarded seeds).
- Priority keys are lowercase slugs `^[a-z][a-z0-9_-]{0,39}$`, immutable after create.
- Icon enum: `chevrons-up`, `chevron-up`, `minus`, `chevron-down`, `chevrons-down`, `flame`. Color enum: `red`, `amber`, `emerald`, `sky`, `violet`, `zinc`.
- Resolution order: vial → sample → order → customer → default. Inactive keys resolve as NULL.
- Run backend tests from the repo root with `cd backend && python -m pytest tests/<file> -q` (the suite expects the dev Postgres from `backend/.env`; the container form is in each test file's docstring).
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `backend/models.py` | `Priority`, `CustomerPriority`, `PriorityAudit` models; `priority_key` + snapshot columns on `LimsOrder`, `LimsSample`, `LimsSubSample` |
| `backend/database.py` | DDL + seed in `_run_migrations` |
| `backend/priority/__init__.py` | package marker |
| `backend/priority/resolver.py` | pure `resolve()` + `load_effective()` batched loader |
| `backend/priority/service.py` | `assign()` (column + audit + snapshot), `list_priorities()`, `priority_map()` cache |
| `backend/priority/snapshot.py` | `refresh()` SLA snapshot writer |
| `backend/priority/schemas.py` | Pydantic request/response models |
| `backend/priority/routes.py` | `APIRouter(prefix="/priorities")` + customer routes |
| `backend/main.py` | include router; embed `priority` in list rows; order ingest mapping; activity log lines; `sla-priority-tiers` validation; delete inbox copy-from-order |
| `backend/sla_engine.py` | remove `PRIORITIES` constant |
| `backend/tests/fixtures/priority_cases.json` | shared resolver cases (TS mirror reads the same file) |
| `backend/tests/test_priority_resolver.py`, `test_priority_service.py`, `test_api_priorities.py`, `test_priority_snapshot.py`, `test_priority_migration.py` | tests |

---

### Task 1: Models and migration

**Files:**
- Modify: `backend/models.py` (after `class SlaPriorityTier`, ~line 1720; `LimsOrder` ~1302; `LimsSample` ~1165; `LimsSubSample` ~1417)
- Modify: `backend/database.py` `_run_migrations` statement list (append after the `uq_sla_priority_per_group` index, ~line 491)
- Test: `backend/tests/test_priority_migration.py`

**Interfaces:**
- Produces: ORM classes `Priority(key, name, rank, icon, color, pulse, is_default, is_active)`, `CustomerPriority(wp_customer_user_id, priority_key, note, updated_by, updated_at)`, `PriorityAudit(at, user_id, level, entity_id, old_key, new_key, source, note)`; columns `LimsOrder.priority_key`, `LimsOrder.priority_source`, `LimsSample.priority_key`, `LimsSubSample.priority_key`, and on both sample tables `sla_priority_key`, `sla_priority_source`, `sla_target_minutes`, `sla_snapshot_at`.

- [ ] **Step 1: Write the failing migration test**

```python
# backend/tests/test_priority_migration.py
"""Schema + seed assertions for the priority feature. Runs against the dev DB
after `database._run_migrations()` has executed on import of main."""
from sqlalchemy import text

from database import engine
import main  # noqa: F401  (triggers migrations)


def _cols(table: str) -> set[str]:
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :t"
        ), {"t": table}).scalars().all()
    return set(rows)


def test_priorities_table_seeded_with_three_rows():
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT key, rank, icon, color, pulse, is_default, is_active FROM priorities ORDER BY rank"
        )).all()
    by_key = {r[0]: r for r in rows}
    assert set(by_key) >= {"default", "high", "expedited"}
    assert by_key["default"][1:] == (0, "minus", "zinc", False, True, True)
    assert by_key["high"][1:] == (10, "chevron-up", "amber", False, False, True)
    assert by_key["expedited"][1:] == (20, "chevrons-up", "red", True, False, True)


def test_single_default_index_exists():
    with engine.connect() as c:
        n = c.execute(text(
            "SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_priorities_single_default'"
        )).scalar()
    assert n == 1


def test_level_columns_exist():
    assert "priority_key" in _cols("lims_orders")
    assert "priority_source" in _cols("lims_orders")
    assert {"priority_key", "sla_priority_key", "sla_priority_source",
            "sla_target_minutes", "sla_snapshot_at"} <= _cols("lims_samples")
    assert {"priority_key", "sla_priority_key", "sla_priority_source",
            "sla_target_minutes", "sla_snapshot_at"} <= _cols("lims_sub_samples")
    assert {"wp_customer_user_id", "priority_key", "note"} <= _cols("customer_priorities")
    assert {"level", "entity_id", "old_key", "new_key", "source"} <= _cols("priority_audit")


def test_sla_priority_tiers_has_fk_to_priorities():
    with engine.connect() as c:
        n = c.execute(text(
            "SELECT count(*) FROM information_schema.table_constraints "
            "WHERE table_name='sla_priority_tiers' AND constraint_name='fk_sla_priority_tiers_priority'"
        )).scalar()
    assert n == 1
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_priority_migration.py -q`
Expected: FAIL — `relation "priorities" does not exist`.

- [ ] **Step 3: Add the ORM models**

Append after `class SlaPriorityTier` in `backend/models.py`:

```python
PRIORITY_ICONS = ("chevrons-up", "chevron-up", "minus", "chevron-down", "chevrons-down", "flame")
PRIORITY_COLORS = ("red", "amber", "emerald", "sky", "violet", "zinc")
PRIORITY_LEVELS = ("customer", "order", "sample", "vial")
PRIORITY_SOURCES = ("ui", "order-payload", "migration", "bulk")


class Priority(Base):
    """A managed sample priority (spec 2026-09-09-sample-priority-design §3.1).

    `key` is an immutable slug referenced by sla_priority_tiers.priority and by
    every level's priority_key column. Exactly one row is the default (partial
    unique index uq_priorities_single_default). Rows are deactivated, never
    deleted; an inactive key resolves as "inherit".
    """

    __tablename__ = "priorities"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    rank: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    icon: Mapped[str] = mapped_column(String(30), nullable=False, default="minus")
    color: Mapped[str] = mapped_column(String(20), nullable=False, default="zinc")
    pulse: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    def __repr__(self) -> str:
        return f"<Priority(key='{self.key}', rank={self.rank}, active={self.is_active})>"


class CustomerPriority(Base):
    """Customer-level explicit priority keyed by the WordPress customer user id
    (lims_orders.customer_user_id). Mk1 is the authority (spec §2 decision 3)."""

    __tablename__ = "customer_priorities"

    wp_customer_user_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    priority_key: Mapped[str] = mapped_column(
        ForeignKey("priorities.key", ondelete="RESTRICT"), nullable=False
    )
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class PriorityAudit(Base):
    """One row per priority change at any level (spec §3.4). The sample
    activity log derives its priority lines from this table at read time."""

    __tablename__ = "priority_audit"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    level: Mapped[str] = mapped_column(String(10), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    old_key: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    new_key: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="ui")
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
```

Add to `LimsOrder` (after `customer_email`):

```python
    # Order-level explicit priority (NULL = inherit from customer). Source
    # records whether the UI or the WordPress order payload set it.
    priority_key: Mapped[Optional[str]] = mapped_column(
        ForeignKey("priorities.key", ondelete="SET NULL"), nullable=True
    )
    priority_source: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
```

Add to BOTH `LimsSample` and `LimsSubSample` (after their `external_lims_uid`):

```python
    # Explicit priority at this level (NULL = inherit). Spec §3.3.
    priority_key: Mapped[Optional[str]] = mapped_column(
        ForeignKey("priorities.key", ondelete="SET NULL"), nullable=True
    )
    # SLA snapshot at the clock events (receive / in-flight change / completion). Spec §3.5.
    sla_priority_key: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    sla_priority_source: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    sla_target_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    sla_snapshot_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
```

- [ ] **Step 4: Add the migration statements**

Append to the statement list in `_run_migrations` in `backend/database.py`, directly after the `uq_sla_priority_per_group` index statement:

```python
        # ── Sample priority (spec 2026-09-09-sample-priority-design) ──
        """
        CREATE TABLE IF NOT EXISTS priorities (
            id         SERIAL PRIMARY KEY,
            key        VARCHAR(40) NOT NULL UNIQUE,
            name       VARCHAR(100) NOT NULL,
            rank       INTEGER NOT NULL DEFAULT 0,
            icon       VARCHAR(30) NOT NULL DEFAULT 'minus',
            color      VARCHAR(20) NOT NULL DEFAULT 'zinc',
            pulse      BOOLEAN NOT NULL DEFAULT FALSE,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            is_active  BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_priorities_single_default ON priorities (is_default) WHERE is_default",
        # Seed the three legacy literals. `normal` becomes `default`. Idempotent.
        """
        INSERT INTO priorities (key, name, rank, icon, color, pulse, is_default, is_active)
        SELECT * FROM (VALUES
            ('default',   'Default',   0,  'minus',       'zinc',  FALSE, TRUE,  TRUE),
            ('high',      'High',      10, 'chevron-up',  'amber', FALSE, FALSE, TRUE),
            ('expedited', 'Expedited', 20, 'chevrons-up', 'red',   TRUE,  FALSE, TRUE)
        ) AS v(key, name, rank, icon, color, pulse, is_default, is_active)
        WHERE NOT EXISTS (SELECT 1 FROM priorities)
        """,
        """
        CREATE TABLE IF NOT EXISTS customer_priorities (
            wp_customer_user_id INTEGER PRIMARY KEY,
            priority_key VARCHAR(40) NOT NULL REFERENCES priorities(key) ON DELETE RESTRICT,
            note         TEXT,
            updated_by   INTEGER,
            updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS priority_audit (
            id        SERIAL PRIMARY KEY,
            at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            user_id   INTEGER,
            level     VARCHAR(10) NOT NULL,
            entity_id VARCHAR(100) NOT NULL,
            old_key   VARCHAR(40),
            new_key   VARCHAR(40),
            source    VARCHAR(20) NOT NULL DEFAULT 'ui',
            note      TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_priority_audit_entity ON priority_audit (level, entity_id)",
        "CREATE INDEX IF NOT EXISTS ix_priority_audit_at ON priority_audit (at)",
        "ALTER TABLE lims_orders ADD COLUMN IF NOT EXISTS priority_key VARCHAR(40) REFERENCES priorities(key) ON DELETE SET NULL",
        "ALTER TABLE lims_orders ADD COLUMN IF NOT EXISTS priority_source VARCHAR(20)",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS priority_key VARCHAR(40) REFERENCES priorities(key) ON DELETE SET NULL",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS sla_priority_key VARCHAR(40)",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS sla_priority_source VARCHAR(10)",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS sla_target_minutes INTEGER",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS sla_snapshot_at TIMESTAMP",
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS priority_key VARCHAR(40) REFERENCES priorities(key) ON DELETE SET NULL",
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS sla_priority_key VARCHAR(40)",
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS sla_priority_source VARCHAR(10)",
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS sla_target_minutes INTEGER",
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS sla_snapshot_at TIMESTAMP",
        # Backfill the legacy per-sample table into lims_samples.priority_key.
        # 'normal' = inherit (NULL). One audit row per backfilled sample.
        """
        UPDATE lims_samples s
           SET priority_key = sp.priority
          FROM sample_priorities sp
         WHERE sp.sample_uid = s.external_lims_uid
           AND sp.priority IN ('high', 'expedited')
           AND s.priority_key IS NULL
        """,
        """
        INSERT INTO priority_audit (level, entity_id, old_key, new_key, source, note)
        SELECT 'sample', s.id::text, NULL, sp.priority, 'migration', 'backfill from sample_priorities'
          FROM sample_priorities sp
          JOIN lims_samples s ON s.external_lims_uid = sp.sample_uid
         WHERE sp.priority IN ('high', 'expedited')
           AND NOT EXISTS (
                SELECT 1 FROM priority_audit a
                 WHERE a.level = 'sample' AND a.entity_id = s.id::text AND a.source = 'migration')
        """,
        # FK from the sparse SLA override map to the priorities table. Only
        # after every existing value is a known key (the seed guarantees the
        # three legacy literals; 'normal' never had a row by the sparsity contract).
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                            WHERE table_name = 'sla_priority_tiers'
                              AND constraint_name = 'fk_sla_priority_tiers_priority')
               AND NOT EXISTS (SELECT 1 FROM sla_priority_tiers t
                                LEFT JOIN priorities p ON p.key = t.priority
                               WHERE p.key IS NULL) THEN
                ALTER TABLE sla_priority_tiers
                    ADD CONSTRAINT fk_sla_priority_tiers_priority
                    FOREIGN KEY (priority) REFERENCES priorities(key) ON DELETE CASCADE;
            END IF;
        END $$
        """,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && python -m pytest tests/test_priority_migration.py -q`
Expected: 4 passed.

- [ ] **Step 6: Run the existing SLA tier tests to prove nothing regressed**

Run: `cd backend && python -m pytest tests/test_api_sla_priority_tiers.py -q`
Expected: all pass (the FK accepts the seeded keys).

- [ ] **Step 7: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_priority_migration.py
git commit -m "feat(priority): priorities, customer_priorities, priority_audit tables + level and snapshot columns

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Pure resolver with shared fixture

**Files:**
- Create: `backend/priority/__init__.py` (empty)
- Create: `backend/priority/resolver.py`
- Create: `backend/tests/fixtures/priority_cases.json`
- Test: `backend/tests/test_priority_resolver.py`

**Interfaces:**
- Produces: `Effective` dataclass `(key: str, rank: int, source_level: str, source_id: str | None)`; `resolve(explicit: Mapping[str, str | None], priorities: Mapping[str, PriorityInfo]) -> Effective`; `PriorityInfo` dataclass `(key, rank, is_active, is_default)`. `explicit` keys are exactly `vial`, `sample`, `order`, `customer`; `source_id` is the entity id string the caller supplies via `explicit_ids`.
- The JSON fixture is the contract the TypeScript mirror (frontend plan Task 2) also consumes.

- [ ] **Step 1: Write the shared fixture**

```json
{
  "priorities": [
    {"key": "default", "rank": 0, "is_active": true, "is_default": true},
    {"key": "high", "rank": 10, "is_active": true, "is_default": false},
    {"key": "expedited", "rank": 20, "is_active": true, "is_default": false},
    {"key": "low", "rank": -10, "is_active": true, "is_default": false},
    {"key": "retired", "rank": 30, "is_active": false, "is_default": false}
  ],
  "cases": [
    {"name": "all inherit → default", "explicit": {}, "expect": {"key": "default", "rank": 0, "source_level": "default"}},
    {"name": "customer only", "explicit": {"customer": "high"}, "expect": {"key": "high", "rank": 10, "source_level": "customer"}},
    {"name": "order beats customer", "explicit": {"customer": "high", "order": "expedited"}, "expect": {"key": "expedited", "rank": 20, "source_level": "order"}},
    {"name": "sample lowers order", "explicit": {"order": "expedited", "sample": "low"}, "expect": {"key": "low", "rank": -10, "source_level": "sample"}},
    {"name": "vial beats everything", "explicit": {"customer": "expedited", "order": "expedited", "sample": "expedited", "vial": "high"}, "expect": {"key": "high", "rank": 10, "source_level": "vial"}},
    {"name": "inactive key is inherit", "explicit": {"sample": "retired", "order": "high"}, "expect": {"key": "high", "rank": 10, "source_level": "order"}},
    {"name": "unknown key is inherit", "explicit": {"sample": "nope"}, "expect": {"key": "default", "rank": 0, "source_level": "default"}},
    {"name": "explicit default at sample wins over order", "explicit": {"order": "expedited", "sample": "default"}, "expect": {"key": "default", "rank": 0, "source_level": "sample"}}
  ]
}
```

- [ ] **Step 2: Write the failing test**

```python
# backend/tests/test_priority_resolver.py
import json
from pathlib import Path

import pytest

from priority.resolver import PriorityInfo, resolve

FIXTURE = Path(__file__).parent / "fixtures" / "priority_cases.json"
DATA = json.loads(FIXTURE.read_text())
PRIOS = {p["key"]: PriorityInfo(**p) for p in DATA["priorities"]}


@pytest.mark.parametrize("case", DATA["cases"], ids=[c["name"] for c in DATA["cases"]])
def test_resolver_matches_fixture(case):
    eff = resolve(case["explicit"], PRIOS)
    assert (eff.key, eff.rank, eff.source_level) == (
        case["expect"]["key"], case["expect"]["rank"], case["expect"]["source_level"]
    )


def test_source_id_comes_from_explicit_ids():
    eff = resolve({"order": "high"}, PRIOS, explicit_ids={"order": "42"})
    assert eff.source_level == "order" and eff.source_id == "42"


def test_no_default_row_raises():
    with pytest.raises(ValueError):
        resolve({}, {"high": PriorityInfo("high", 10, True, False)})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_priority_resolver.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'priority'`.

- [ ] **Step 4: Implement the resolver**

```python
# backend/priority/resolver.py
"""Effective-priority resolution (spec §4). Pure and DB-free; `load_effective`
in service.py feeds it. Mirrored in src/lib/priority-resolver.ts against the
shared fixture backend/tests/fixtures/priority_cases.json."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional

LEVELS = ("vial", "sample", "order", "customer")


@dataclass(frozen=True)
class PriorityInfo:
    key: str
    rank: int
    is_active: bool
    is_default: bool


@dataclass(frozen=True)
class Effective:
    key: str
    rank: int
    source_level: str  # vial | sample | order | customer | default
    source_id: Optional[str] = None

    def as_dict(self) -> dict:
        return {"key": self.key, "rank": self.rank,
                "source_level": self.source_level, "source_id": self.source_id}


def resolve(
    explicit: Mapping[str, Optional[str]],
    priorities: Mapping[str, PriorityInfo],
    explicit_ids: Optional[Mapping[str, str]] = None,
) -> Effective:
    """Most specific explicit ACTIVE key wins: vial > sample > order > customer;
    otherwise the default priority. An unknown or inactive key at a level is
    treated as NULL (inherit)."""
    for level in LEVELS:
        key = explicit.get(level)
        if not key:
            continue
        info = priorities.get(key)
        if info is None or not info.is_active:
            continue
        sid = (explicit_ids or {}).get(level)
        return Effective(info.key, info.rank, level, sid)
    for info in priorities.values():
        if info.is_default:
            return Effective(info.key, info.rank, "default", None)
    raise ValueError("no default priority configured")
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && python -m pytest tests/test_priority_resolver.py -q`
Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/priority/__init__.py backend/priority/resolver.py backend/tests/fixtures/priority_cases.json backend/tests/test_priority_resolver.py
git commit -m "feat(priority): pure four-level resolver with shared fixture

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Batched loader and priority cache

**Files:**
- Create: `backend/priority/service.py`
- Test: `backend/tests/test_priority_service.py`

**Interfaces:**
- Consumes: `resolve`, `PriorityInfo`, `Effective` from Task 2; ORM models from Task 1.
- Produces: `priority_map(db) -> dict[str, PriorityInfo]` (60 s per-process cache, `invalidate_priority_cache()` to clear); `load_effective(db, sample_pks=(), sub_sample_pks=()) -> tuple[dict[int, Effective], dict[int, Effective]]` returning `(by_sample_pk, by_sub_sample_pk)`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_priority_service.py
"""Loader tests. Uses the conftest db_session (rolled back per test)."""
from models import CustomerPriority, LimsOrder, LimsSample, LimsSubSample
from priority import service


def _mk(db, *, order_no="WP-9001", customer_id=777):
    db.add(LimsOrder(wp_order_id=9001, order_number=order_no, customer_user_id=customer_id))
    s = LimsSample(sample_id="PB-9001", external_lims_uid="uid-9001", client_order_number=order_no)
    db.add(s); db.flush()
    v = LimsSubSample(parent_sample_pk=s.id, sample_id="PB-9001-S01",
                      external_lims_uid="uid-9001-s01", vial_sequence=1)
    db.add(v); db.flush()
    return s, v


def test_inherit_chain_customer_to_vial(db_session):
    service.invalidate_priority_cache()
    s, v = _mk(db_session)
    db_session.add(CustomerPriority(wp_customer_user_id=777, priority_key="high"))
    db_session.flush()
    by_s, by_v = service.load_effective(db_session, sample_pks=[s.id], sub_sample_pks=[v.id])
    assert by_s[s.id].key == "high" and by_s[s.id].source_level == "customer"
    assert by_v[v.id].key == "high" and by_v[v.id].source_level == "customer"
    assert by_s[s.id].source_id == "777"


def test_vial_overrides_sample(db_session):
    service.invalidate_priority_cache()
    s, v = _mk(db_session)
    s.priority_key = "expedited"; v.priority_key = "default"; db_session.flush()
    by_s, by_v = service.load_effective(db_session, sample_pks=[s.id], sub_sample_pks=[v.id])
    assert by_s[s.id].key == "expedited" and by_s[s.id].source_level == "sample"
    assert by_v[v.id].key == "default" and by_v[v.id].source_level == "vial"


def test_missing_ids_resolve_default(db_session):
    service.invalidate_priority_cache()
    by_s, by_v = service.load_effective(db_session, sample_pks=[999999])
    assert by_s[999999].key == "default" and by_s[999999].source_level == "default"
    assert by_v == {}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_priority_service.py -q`
Expected: FAIL — `ModuleNotFoundError` for `priority.service`.

- [ ] **Step 3: Implement the loader**

```python
# backend/priority/service.py
"""DB-facing priority helpers: cached priority map, batched effective loader,
and (Task 4) assign(). Spec §4/§5."""
from __future__ import annotations

import time
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import CustomerPriority, LimsOrder, LimsSample, LimsSubSample, Priority
from priority.resolver import Effective, PriorityInfo, resolve

_CACHE_TTL_S = 60.0
_cache: dict = {"at": 0.0, "map": None}


def invalidate_priority_cache() -> None:
    _cache["at"] = 0.0
    _cache["map"] = None


def priority_map(db: Session) -> dict[str, PriorityInfo]:
    """All priorities (active and inactive) keyed by key; 60 s per-process cache
    like the throughput row cache. Inactive rows are kept so the resolver can
    treat them as inherit instead of unknown."""
    now = time.monotonic()
    if _cache["map"] is not None and now - _cache["at"] < _CACHE_TTL_S:
        return _cache["map"]
    rows = db.execute(select(Priority)).scalars().all()
    m = {r.key: PriorityInfo(r.key, r.rank, r.is_active, r.is_default) for r in rows}
    _cache["map"], _cache["at"] = m, now
    return m


def load_effective(
    db: Session,
    sample_pks: Iterable[int] = (),
    sub_sample_pks: Iterable[int] = (),
) -> tuple[dict[int, Effective], dict[int, Effective]]:
    """Batched: one query per level. Sub-samples resolve through their parent
    sample's chain. Unknown pks resolve to the default so callers never KeyError."""
    prios = priority_map(db)
    sample_pks = list(dict.fromkeys(sample_pks))
    sub_pks = list(dict.fromkeys(sub_sample_pks))

    subs: dict[int, LimsSubSample] = {}
    if sub_pks:
        for v in db.execute(select(LimsSubSample).where(LimsSubSample.id.in_(sub_pks))).scalars():
            subs[v.id] = v
        sample_pks = list(dict.fromkeys(sample_pks + [v.parent_sample_pk for v in subs.values()]))

    samples: dict[int, LimsSample] = {}
    if sample_pks:
        for s in db.execute(select(LimsSample).where(LimsSample.id.in_(sample_pks))).scalars():
            samples[s.id] = s

    order_nos = {s.client_order_number for s in samples.values() if s.client_order_number}
    orders: dict[str, LimsOrder] = {}
    if order_nos:
        for o in db.execute(select(LimsOrder).where(LimsOrder.order_number.in_(order_nos))).scalars():
            orders[o.order_number] = o

    cust_ids = {o.customer_user_id for o in orders.values() if o.customer_user_id is not None}
    customers: dict[int, CustomerPriority] = {}
    if cust_ids:
        for c in db.execute(
            select(CustomerPriority).where(CustomerPriority.wp_customer_user_id.in_(cust_ids))
        ).scalars():
            customers[c.wp_customer_user_id] = c

    def chain(sample: Optional[LimsSample], vial: Optional[LimsSubSample]) -> Effective:
        order = orders.get(sample.client_order_number) if sample and sample.client_order_number else None
        cust = customers.get(order.customer_user_id) if order and order.customer_user_id is not None else None
        explicit = {
            "vial": vial.priority_key if vial else None,
            "sample": sample.priority_key if sample else None,
            "order": order.priority_key if order else None,
            "customer": cust.priority_key if cust else None,
        }
        ids = {
            "vial": str(vial.id) if vial else None,
            "sample": str(sample.id) if sample else None,
            "order": order.order_number if order else None,
            "customer": str(cust.wp_customer_user_id) if cust else None,
        }
        return resolve(explicit, prios, explicit_ids={k: v for k, v in ids.items() if v})

    by_sample = {pk: chain(samples.get(pk), None) for pk in sample_pks}
    by_vial = {pk: chain(samples.get(v.parent_sample_pk), v) for pk, v in subs.items()}
    return by_sample, by_vial
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && python -m pytest tests/test_priority_service.py -q`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/priority/service.py backend/tests/test_priority_service.py
git commit -m "feat(priority): cached priority map + batched effective loader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: SLA snapshot helper

**Files:**
- Create: `backend/priority/snapshot.py`
- Test: `backend/tests/test_priority_snapshot.py`

**Interfaces:**
- Consumes: `load_effective`, `priority_map`; `SlaTier`, `SlaPriorityTier` models.
- Produces: `refresh(db, sample_pks: Iterable[int], *, only_in_flight: bool = False) -> int` (rows written). Target rule (spec §4 consumers): the GLOBAL `sla_priority_tiers` row for the effective key if present, else the default tier's `target_minutes`. In-flight = `lims_samples.status` not in `("published", "cancelled", "invalid")`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_priority_snapshot.py
from sqlalchemy import select

from models import LimsSample, LimsSubSample, SlaPriorityTier, SlaTier
from priority import service, snapshot


def _sample(db, key=None, status="received"):
    s = LimsSample(sample_id="PB-9100", external_lims_uid="uid-9100", status=status, priority_key=key)
    db.add(s); db.flush()
    v = LimsSubSample(parent_sample_pk=s.id, sample_id="PB-9100-S01", external_lims_uid="uid-9100-s01", vial_sequence=1)
    db.add(v); db.flush()
    return s, v


def test_snapshot_uses_default_tier_when_unmapped(db_session):
    service.invalidate_priority_cache()
    default_tier = db_session.execute(select(SlaTier).where(SlaTier.is_default)).scalar_one()
    s, v = _sample(db_session, key="high")
    n = snapshot.refresh(db_session, [s.id])
    assert n == 1
    assert s.sla_priority_key == "high" and s.sla_priority_source == "sample"
    assert s.sla_target_minutes == default_tier.target_minutes and s.sla_snapshot_at is not None
    assert v.sla_priority_key == "high" and v.sla_target_minutes == default_tier.target_minutes


def test_snapshot_uses_global_priority_tier(db_session):
    service.invalidate_priority_cache()
    fast = SlaTier(name="_test_fast", target_minutes=120)
    db_session.add(fast); db_session.flush()
    db_session.add(SlaPriorityTier(priority="expedited", sla_tier_id=fast.id, service_group_id=None))
    db_session.flush()
    s, _ = _sample(db_session, key="expedited")
    snapshot.refresh(db_session, [s.id])
    assert s.sla_target_minutes == 120


def test_only_in_flight_skips_published(db_session):
    service.invalidate_priority_cache()
    s, _ = _sample(db_session, key="high", status="published")
    assert snapshot.refresh(db_session, [s.id], only_in_flight=True) == 0
    assert s.sla_snapshot_at is None
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_priority_snapshot.py -q`
Expected: FAIL — no module `priority.snapshot`.

- [ ] **Step 3: Implement**

```python
# backend/priority/snapshot.py
"""SLA snapshot writer (spec §3.5). Records what was promised at the clock
events so reports never re-grade history against today's mapping."""
from __future__ import annotations

from datetime import datetime
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import LimsSample, LimsSubSample, SlaPriorityTier, SlaTier
from priority.service import load_effective

TERMINAL_STATUSES = ("published", "cancelled", "invalid")


def _targets(db: Session) -> tuple[int, dict[str, int]]:
    default = db.execute(select(SlaTier).where(SlaTier.is_default)).scalar_one()
    rows = db.execute(
        select(SlaPriorityTier).where(SlaPriorityTier.service_group_id.is_(None))
    ).scalars().all()
    return default.target_minutes, {r.priority: r.tier.target_minutes for r in rows}


def refresh(db: Session, sample_pks: Iterable[int], *, only_in_flight: bool = False) -> int:
    pks = list(dict.fromkeys(sample_pks))
    if not pks:
        return 0
    samples = db.execute(select(LimsSample).where(LimsSample.id.in_(pks))).scalars().all()
    if only_in_flight:
        samples = [s for s in samples if (s.status or "") not in TERMINAL_STATUSES]
    if not samples:
        return 0
    vials = db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk.in_([s.id for s in samples]))
    ).scalars().all()
    by_s, by_v = load_effective(db, sample_pks=[s.id for s in samples], sub_sample_pks=[v.id for v in vials])
    default_target, by_key = _targets(db)
    now = datetime.utcnow()
    for s in samples:
        eff = by_s[s.id]
        s.sla_priority_key, s.sla_priority_source = eff.key, eff.source_level
        s.sla_target_minutes, s.sla_snapshot_at = by_key.get(eff.key, default_target), now
    for v in vials:
        eff = by_v[v.id]
        v.sla_priority_key, v.sla_priority_source = eff.key, eff.source_level
        v.sla_target_minutes, v.sla_snapshot_at = by_key.get(eff.key, default_target), now
    db.flush()
    return len(samples)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && python -m pytest tests/test_priority_snapshot.py -q`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/priority/snapshot.py backend/tests/test_priority_snapshot.py
git commit -m "feat(priority): SLA snapshot writer for receive / change / completion

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Assign service (column + audit + snapshot)

**Files:**
- Modify: `backend/priority/service.py` (append)
- Test: `backend/tests/test_priority_service.py` (append)

**Interfaces:**
- Produces: `assign(db, *, level: str, entity_id: str, priority_key: str | None, user_id: int | None, source: str = "ui", note: str | None = None) -> AssignResult` with `AssignResult(level, entity_id, old_key, new_key, affected_sample_pks: list[int])`. `entity_id` per level: customer = wp customer user id, order = `lims_orders.order_number`, sample = `lims_samples.id`, vial = `lims_sub_samples.id`. Raises `ValueError` for unknown level/key or missing entity. Writes one `PriorityAudit` row and calls `snapshot.refresh(..., only_in_flight=True)` on affected samples.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_priority_service.py`:

```python
from sqlalchemy import select
from models import PriorityAudit


def test_assign_sample_writes_column_audit_and_snapshot(db_session):
    service.invalidate_priority_cache()
    s, v = _mk(db_session)
    res = service.assign(db_session, level="sample", entity_id=str(s.id), priority_key="expedited", user_id=5)
    assert (res.old_key, res.new_key) == (None, "expedited") and res.affected_sample_pks == [s.id]
    assert s.priority_key == "expedited"
    audit = db_session.execute(select(PriorityAudit).where(PriorityAudit.entity_id == str(s.id))).scalar_one()
    assert (audit.level, audit.new_key, audit.user_id, audit.source) == ("sample", "expedited", 5, "ui")
    assert s.sla_priority_key == "expedited" and s.sla_priority_source == "sample"


def test_assign_customer_affects_every_sample_on_their_orders(db_session):
    service.invalidate_priority_cache()
    s, _ = _mk(db_session)
    res = service.assign(db_session, level="customer", entity_id="777", priority_key="high", user_id=1, note="VIP")
    assert res.affected_sample_pks == [s.id]
    assert s.sla_priority_key == "high" and s.sla_priority_source == "customer"


def test_assign_clear_to_inherit(db_session):
    service.invalidate_priority_cache()
    s, _ = _mk(db_session)
    service.assign(db_session, level="sample", entity_id=str(s.id), priority_key="high", user_id=1)
    res = service.assign(db_session, level="sample", entity_id=str(s.id), priority_key=None, user_id=1)
    assert (res.old_key, res.new_key) == ("high", None) and s.priority_key is None


def test_assign_rejects_unknown_key_and_level(db_session):
    import pytest
    s, _ = _mk(db_session)
    with pytest.raises(ValueError):
        service.assign(db_session, level="sample", entity_id=str(s.id), priority_key="nope", user_id=1)
    with pytest.raises(ValueError):
        service.assign(db_session, level="planet", entity_id="1", priority_key="high", user_id=1)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_priority_service.py -q -k assign`
Expected: FAIL — `AttributeError: module 'priority.service' has no attribute 'assign'`.

- [ ] **Step 3: Implement assign**

Append to `backend/priority/service.py`:

```python
from dataclasses import dataclass, field
from models import PRIORITY_LEVELS, PRIORITY_SOURCES, PriorityAudit


@dataclass
class AssignResult:
    level: str
    entity_id: str
    old_key: Optional[str]
    new_key: Optional[str]
    affected_sample_pks: list[int] = field(default_factory=list)


def _samples_for_order_numbers(db: Session, order_numbers: list[str]) -> list[int]:
    if not order_numbers:
        return []
    return list(db.execute(
        select(LimsSample.id).where(LimsSample.client_order_number.in_(order_numbers))
    ).scalars())


def assign(
    db: Session, *, level: str, entity_id: str, priority_key: Optional[str],
    user_id: Optional[int], source: str = "ui", note: Optional[str] = None,
) -> AssignResult:
    """Set (or clear, with None) the explicit priority at one level. One audit
    row; SLA snapshot refreshed for every in-flight sample whose effective
    value could have changed. Spec §5 `PUT /priorities/assign`."""
    from priority import snapshot  # local import: snapshot imports this module

    if level not in PRIORITY_LEVELS:
        raise ValueError(f"unknown level {level!r}")
    if source not in PRIORITY_SOURCES:
        raise ValueError(f"unknown source {source!r}")
    if priority_key is not None and priority_key not in priority_map(db):
        raise ValueError(f"unknown priority {priority_key!r}")

    affected: list[int] = []
    if level == "customer":
        cid = int(entity_id)
        row = db.get(CustomerPriority, cid)
        old = row.priority_key if row else None
        if priority_key is None:
            if row:
                db.delete(row)
        elif row:
            row.priority_key, row.note, row.updated_by = priority_key, note, user_id
        else:
            db.add(CustomerPriority(wp_customer_user_id=cid, priority_key=priority_key, note=note, updated_by=user_id))
        order_nos = list(db.execute(
            select(LimsOrder.order_number).where(LimsOrder.customer_user_id == cid)
        ).scalars())
        affected = _samples_for_order_numbers(db, order_nos)
    elif level == "order":
        order = db.execute(select(LimsOrder).where(LimsOrder.order_number == entity_id)).scalar_one_or_none()
        if order is None:
            raise ValueError(f"order {entity_id!r} not found")
        old = order.priority_key
        order.priority_key = priority_key
        order.priority_source = None if priority_key is None else source
        affected = _samples_for_order_numbers(db, [order.order_number])
    elif level == "sample":
        sample = db.get(LimsSample, int(entity_id))
        if sample is None:
            raise ValueError(f"sample {entity_id!r} not found")
        old = sample.priority_key
        sample.priority_key = priority_key
        affected = [sample.id]
    else:  # vial
        vial = db.get(LimsSubSample, int(entity_id))
        if vial is None:
            raise ValueError(f"vial {entity_id!r} not found")
        old = vial.priority_key
        vial.priority_key = priority_key
        affected = [vial.parent_sample_pk]

    db.add(PriorityAudit(user_id=user_id, level=level, entity_id=str(entity_id),
                         old_key=old, new_key=priority_key, source=source, note=note))
    db.flush()
    snapshot.refresh(db, affected, only_in_flight=True)
    return AssignResult(level, str(entity_id), old, priority_key, sorted(affected))
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && python -m pytest tests/test_priority_service.py -q`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/priority/service.py backend/tests/test_priority_service.py
git commit -m "feat(priority): assign() writes level column, audit row and in-flight SLA snapshot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Priorities API router

**Files:**
- Create: `backend/priority/schemas.py`
- Create: `backend/priority/routes.py`
- Modify: `backend/main.py` — add `from priority.routes import router as priority_router` beside the other router imports and `app.include_router(priority_router)` after line 555 (`app.include_router(workflow_router)`)
- Test: `backend/tests/test_api_priorities.py`

**Interfaces:**
- Produces routes (all under `/priorities`, JWT via `auth.get_current_user`):
  `GET /priorities` → `list[PriorityOut]` sorted rank desc;
  `POST /priorities` body `PriorityCreate{name, rank, icon, color, pulse?, sla_tier_id?}` → `PriorityOut` (key = slug of name);
  `PATCH /priorities/{key}` body `PriorityPatch{name?, rank?, icon?, color?, pulse?, is_active?, sla_tier_id?: int | null}` (sla_tier_id writes/deletes the GLOBAL `sla_priority_tiers` row) → `PriorityOut`;
  `DELETE /priorities/{key}` → deactivates; 409 on default;
  `PUT /priorities/default/{key}` → moves the default marker;
  `PUT /priorities/assign` body `AssignIn{level, id, priority_key: str|null, note?}` → `AssignOut`;
  `PUT /priorities/assign/bulk` body `{items: list[AssignIn]}` → `list[AssignOut]`;
  `POST /priorities/resolve` body `{sample_pks?: list[int], sub_sample_pks?: list[int]}` → `{samples: {pk: EffectiveOut}, sub_samples: {pk: EffectiveOut}}`;
  `GET /priorities/customers` → `list[CustomerPriorityOut{wp_customer_user_id, priority_key, note, updated_at, customer_name, customer_email}]`;
  `GET /priorities/customers/seen?q=` → `list[{wp_customer_user_id, customer_name, customer_email, last_order_at}]` (distinct from `lims_orders`, max 25).
- `PriorityOut{key, name, rank, icon, color, pulse, is_default, is_active, sla_tier_id: int|null}`; `EffectiveOut{key, rank, source_level, source_id}`.

- [ ] **Step 1: Write the failing API tests**

```python
# backend/tests/test_api_priorities.py
"""API tests for /priorities. Self-restoring: deletes rows it created."""
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup():
    created: list[str] = []
    yield created
    with engine.begin() as c:
        for key in created:
            c.execute(text("DELETE FROM sla_priority_tiers WHERE priority = :k"), {"k": key})
            c.execute(text("DELETE FROM priority_audit WHERE new_key = :k OR old_key = :k"), {"k": key})
            c.execute(text("DELETE FROM priorities WHERE key = :k"), {"k": key})


def test_list_has_seeded_default_first_by_rank_desc():
    r = client.get("/priorities"); assert r.status_code == 200
    keys = [p["key"] for p in r.json()]
    assert keys.index("expedited") < keys.index("high") < keys.index("default")


def test_create_patch_map_and_deactivate(_cleanup):
    name = f"Rush {uuid.uuid4().hex[:6]}"
    r = client.post("/priorities", json={"name": name, "rank": 30, "icon": "flame", "color": "red", "pulse": True})
    assert r.status_code == 201, r.text
    key = r.json()["key"]; _cleanup.append(key)
    assert key.startswith("rush-") and r.json()["sla_tier_id"] is None

    tier_id = client.get("/sla-tiers").json()[0]["id"]
    r = client.patch(f"/priorities/{key}", json={"sla_tier_id": tier_id, "rank": 35})
    assert r.status_code == 200 and r.json()["sla_tier_id"] == tier_id and r.json()["rank"] == 35
    assert any(row["priority"] == key for row in client.get("/sla-priority-tiers").json())

    r = client.patch(f"/priorities/{key}", json={"sla_tier_id": None})
    assert r.json()["sla_tier_id"] is None

    r = client.delete(f"/priorities/{key}"); assert r.status_code == 200
    assert next(p for p in client.get("/priorities").json() if p["key"] == key)["is_active"] is False


def test_bad_icon_rejected_and_default_undeletable():
    r = client.post("/priorities", json={"name": "x", "rank": 1, "icon": "star", "color": "red"})
    assert r.status_code == 422
    assert client.delete("/priorities/default").status_code == 409


def test_assign_rejects_unknown_level():
    r = client.put("/priorities/assign", json={"level": "planet", "id": "1", "priority_key": "high"})
    assert r.status_code == 422


def test_resolve_unknown_pk_returns_default():
    r = client.post("/priorities/resolve", json={"sample_pks": [999999]})
    assert r.status_code == 200
    assert r.json()["samples"]["999999"]["key"] == "default"


def test_customers_seen_is_bounded():
    r = client.get("/priorities/customers/seen", params={"q": ""})
    assert r.status_code == 200 and len(r.json()) <= 25
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_priorities.py -q`
Expected: FAIL — 404s (router not mounted).

- [ ] **Step 3: Write the schemas**

```python
# backend/priority/schemas.py
from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

from models import PRIORITY_COLORS, PRIORITY_ICONS

Icon = Literal["chevrons-up", "chevron-up", "minus", "chevron-down", "chevrons-down", "flame"]
Color = Literal["red", "amber", "emerald", "sky", "violet", "zinc"]
Level = Literal["customer", "order", "sample", "vial"]
KEY_RE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return s[:40] or "priority"


class PriorityOut(BaseModel):
    key: str
    name: str
    rank: int
    icon: str
    color: str
    pulse: bool
    is_default: bool
    is_active: bool
    sla_tier_id: Optional[int] = None


class PriorityCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    rank: int = 0
    icon: Icon = "minus"
    color: Color = "zinc"
    pulse: bool = False
    sla_tier_id: Optional[int] = None


class PriorityPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    rank: Optional[int] = None
    icon: Optional[Icon] = None
    color: Optional[Color] = None
    pulse: Optional[bool] = None
    is_active: Optional[bool] = None
    # tri-state: omitted = leave; null = clear the global tier row; int = set
    sla_tier_id: Optional[int] = None
    model_config = {"extra": "forbid"}


class AssignIn(BaseModel):
    level: Level
    id: str
    priority_key: Optional[str] = None
    note: Optional[str] = None

    @field_validator("priority_key")
    @classmethod
    def _key(cls, v):
        if v is not None and not KEY_RE.match(v):
            raise ValueError("bad priority key")
        return v


class AssignOut(BaseModel):
    level: str
    id: str
    old_key: Optional[str]
    new_key: Optional[str]
    affected_sample_pks: list[int]


class BulkAssignIn(BaseModel):
    items: list[AssignIn] = Field(min_length=1, max_length=500)


class ResolveIn(BaseModel):
    sample_pks: list[int] = Field(default_factory=list, max_length=2000)
    sub_sample_pks: list[int] = Field(default_factory=list, max_length=5000)


class EffectiveOut(BaseModel):
    key: str
    rank: int
    source_level: str
    source_id: Optional[str] = None


class ResolveOut(BaseModel):
    samples: dict[str, EffectiveOut]
    sub_samples: dict[str, EffectiveOut]


class CustomerPriorityOut(BaseModel):
    wp_customer_user_id: int
    priority_key: str
    note: Optional[str]
    updated_at: Optional[str]
    customer_name: Optional[str]
    customer_email: Optional[str]


class CustomerSeenOut(BaseModel):
    wp_customer_user_id: int
    customer_name: Optional[str]
    customer_email: Optional[str]
    last_order_at: Optional[str]
```

- [ ] **Step 4: Write the router**

```python
# backend/priority/routes.py
"""/priorities API (spec §5)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import CustomerPriority, LimsOrder, Priority, SlaPriorityTier, SlaTier
from priority import service
from priority.schemas import (
    AssignIn, AssignOut, BulkAssignIn, CustomerPriorityOut, CustomerSeenOut, EffectiveOut,
    PriorityCreate, PriorityOut, PriorityPatch, ResolveIn, ResolveOut, slugify,
)

router = APIRouter(prefix="/priorities", tags=["priorities"])


def _global_tier_ids(db: Session) -> dict[str, int]:
    rows = db.execute(select(SlaPriorityTier).where(SlaPriorityTier.service_group_id.is_(None))).scalars()
    return {r.priority: r.sla_tier_id for r in rows}


def _out(p: Priority, tiers: dict[str, int]) -> PriorityOut:
    return PriorityOut(key=p.key, name=p.name, rank=p.rank, icon=p.icon, color=p.color, pulse=p.pulse,
                       is_default=p.is_default, is_active=p.is_active, sla_tier_id=tiers.get(p.key))


def _get(db: Session, key: str) -> Priority:
    p = db.execute(select(Priority).where(Priority.key == key)).scalar_one_or_none()
    if p is None:
        raise HTTPException(404, f"priority {key!r} not found")
    return p


def _set_global_tier(db: Session, key: str, tier_id: int | None) -> None:
    row = db.execute(select(SlaPriorityTier).where(
        SlaPriorityTier.priority == key, SlaPriorityTier.service_group_id.is_(None))).scalar_one_or_none()
    if tier_id is None:
        if row:
            db.delete(row)
        return
    if db.get(SlaTier, tier_id) is None:
        raise HTTPException(422, "unknown sla_tier_id")
    if row:
        row.sla_tier_id = tier_id
    else:
        db.add(SlaPriorityTier(priority=key, sla_tier_id=tier_id, service_group_id=None))


@router.get("", response_model=list[PriorityOut])
def list_priorities(db: Session = Depends(get_db), _=Depends(get_current_user)):
    tiers = _global_tier_ids(db)
    rows = db.execute(select(Priority).order_by(Priority.rank.desc(), Priority.name)).scalars().all()
    return [_out(p, tiers) for p in rows]


@router.post("", response_model=PriorityOut, status_code=status.HTTP_201_CREATED)
def create_priority(body: PriorityCreate, db: Session = Depends(get_db), _=Depends(get_current_user)):
    base = slugify(body.name); key = base; n = 2
    while db.execute(select(Priority.id).where(Priority.key == key)).scalar_one_or_none():
        key = f"{base}-{n}"[:40]; n += 1
    p = Priority(key=key, name=body.name, rank=body.rank, icon=body.icon, color=body.color, pulse=body.pulse)
    db.add(p); db.flush()
    _set_global_tier(db, key, body.sla_tier_id)
    db.commit(); service.invalidate_priority_cache()
    return _out(p, _global_tier_ids(db))


@router.patch("/{key}", response_model=PriorityOut)
def patch_priority(key: str, body: PriorityPatch, db: Session = Depends(get_db), _=Depends(get_current_user)):
    p = _get(db, key)
    data = body.model_dump(exclude_unset=True)
    if "sla_tier_id" in data:
        _set_global_tier(db, key, data.pop("sla_tier_id"))
    if data.get("is_active") is False and p.is_default:
        raise HTTPException(409, "the default priority cannot be deactivated")
    for k, v in data.items():
        setattr(p, k, v)
    db.commit(); service.invalidate_priority_cache()
    return _out(p, _global_tier_ids(db))


@router.delete("/{key}")
def deactivate_priority(key: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    p = _get(db, key)
    if p.is_default:
        raise HTTPException(409, "the default priority cannot be deactivated")
    p.is_active = False
    db.commit(); service.invalidate_priority_cache()
    return {"key": key, "is_active": False}


@router.put("/default/{key}", response_model=PriorityOut)
def set_default(key: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    p = _get(db, key)
    if not p.is_active:
        raise HTTPException(409, "an inactive priority cannot be the default")
    for row in db.execute(select(Priority).where(Priority.is_default)).scalars():
        row.is_default = False
    db.flush(); p.is_default = True
    db.commit(); service.invalidate_priority_cache()
    return _out(p, _global_tier_ids(db))


@router.put("/assign", response_model=AssignOut)
def assign_one(body: AssignIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        res = service.assign(db, level=body.level, entity_id=body.id, priority_key=body.priority_key,
                             user_id=user.get("id"), source="ui", note=body.note)
    except ValueError as e:
        raise HTTPException(422, str(e))
    db.commit()
    return AssignOut(level=res.level, id=res.entity_id, old_key=res.old_key, new_key=res.new_key,
                     affected_sample_pks=res.affected_sample_pks)


@router.put("/assign/bulk", response_model=list[AssignOut])
def assign_bulk(body: BulkAssignIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    out = []
    try:
        for item in body.items:
            res = service.assign(db, level=item.level, entity_id=item.id, priority_key=item.priority_key,
                                 user_id=user.get("id"), source="bulk", note=item.note)
            out.append(AssignOut(level=res.level, id=res.entity_id, old_key=res.old_key, new_key=res.new_key,
                                 affected_sample_pks=res.affected_sample_pks))
    except ValueError as e:
        db.rollback(); raise HTTPException(422, str(e))
    db.commit()
    return out


@router.post("/resolve", response_model=ResolveOut)
def resolve(body: ResolveIn, db: Session = Depends(get_db), _=Depends(get_current_user)):
    by_s, by_v = service.load_effective(db, sample_pks=body.sample_pks, sub_sample_pks=body.sub_sample_pks)
    return ResolveOut(samples={str(k): EffectiveOut(**v.as_dict()) for k, v in by_s.items()},
                      sub_samples={str(k): EffectiveOut(**v.as_dict()) for k, v in by_v.items()})


@router.get("/customers", response_model=list[CustomerPriorityOut])
def list_customer_priorities(db: Session = Depends(get_db), _=Depends(get_current_user)):
    rows = db.execute(select(CustomerPriority)).scalars().all()
    ids = [r.wp_customer_user_id for r in rows]
    latest: dict[int, LimsOrder] = {}
    if ids:
        for o in db.execute(select(LimsOrder).where(LimsOrder.customer_user_id.in_(ids))
                            .order_by(LimsOrder.wp_created_at.desc().nullslast())).scalars():
            latest.setdefault(o.customer_user_id, o)
    return [CustomerPriorityOut(
        wp_customer_user_id=r.wp_customer_user_id, priority_key=r.priority_key, note=r.note,
        updated_at=r.updated_at.isoformat() if r.updated_at else None,
        customer_name=getattr(latest.get(r.wp_customer_user_id), "customer_name", None),
        customer_email=getattr(latest.get(r.wp_customer_user_id), "customer_email", None),
    ) for r in rows]


@router.get("/customers/seen", response_model=list[CustomerSeenOut])
def customers_seen(q: str = "", db: Session = Depends(get_db), _=Depends(get_current_user)):
    stmt = (select(LimsOrder.customer_user_id, func.max(LimsOrder.customer_name), func.max(LimsOrder.customer_email),
                   func.max(LimsOrder.wp_created_at))
            .where(LimsOrder.customer_user_id.is_not(None)))
    if q:
        like = f"%{q}%"
        stmt = stmt.where((LimsOrder.customer_name.ilike(like)) | (LimsOrder.customer_email.ilike(like)))
    stmt = stmt.group_by(LimsOrder.customer_user_id).order_by(func.max(LimsOrder.wp_created_at).desc().nullslast()).limit(25)
    return [CustomerSeenOut(wp_customer_user_id=cid, customer_name=n, customer_email=e,
                            last_order_at=t.isoformat() if t else None) for cid, n, e, t in db.execute(stmt)]
```

Mount it in `backend/main.py`: add `from priority.routes import router as priority_router` next to the other router imports, and `app.include_router(priority_router)` after `app.include_router(workflow_router)`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_priorities.py -q`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/priority/schemas.py backend/priority/routes.py backend/main.py backend/tests/test_api_priorities.py
git commit -m "feat(priority): /priorities API — list, create, patch, default, assign, resolve, customers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Validate SLA priority tiers against the table; drop the literal

**Files:**
- Modify: `backend/main.py` — `SlaPriority = Literal[...]` (line 2866) and its users `SamplePriorityResponseItem` (~2928), `PUT /sla-priority-tiers/{priority}` (19285), `DELETE /sla-priority-tiers/{priority}` (19339)
- Modify: `backend/sla_engine.py` — remove `PRIORITIES`
- Test: `backend/tests/test_api_sla_priority_tiers.py` (append one case)

**Interfaces:**
- `SlaPriority` becomes `str`; the two tier routes 422 on a key that is not in `priorities`.

- [ ] **Step 1: Append the failing test**

```python
def test_priority_tier_accepts_table_keys_and_rejects_unknown():
    tier = _default_tier_id()
    r = client.put("/sla-priority-tiers/expedited", json={"sla_tier_id": tier})
    assert r.status_code == 200
    r = client.put("/sla-priority-tiers/not-a-priority", json={"sla_tier_id": tier})
    assert r.status_code == 422
```

(Add the created row's id to the test file's existing cleanup snapshot mechanism as the other tests do.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_sla_priority_tiers.py -q -k table_keys`
Expected: FAIL — the unknown key currently returns 422 from the Literal AND `expedited` passes, so assert on a NEW key: temporarily create `rush-test` via `POST /priorities` in the test and PUT it; expected FAIL with 422 on the Literal.

- [ ] **Step 3: Implement**

In `backend/main.py`: change `SlaPriority = Literal["normal", "high", "expedited"]` to `SlaPriority = str`. In both `/sla-priority-tiers/{priority}` handlers add at the top:

```python
    from priority.service import priority_map
    if priority not in priority_map(db):
        raise HTTPException(status_code=422, detail=f"unknown priority {priority!r}")
```

In `backend/sla_engine.py` delete the `PRIORITIES = (...)` tuple and its comment; grep `PRIORITIES` across `backend/` and remove the import sites (they are only in tests: update those tests to use `("default", "high", "expedited")` literals).

- [ ] **Step 4: Run the SLA test files**

Run: `cd backend && python -m pytest tests/test_api_sla_priority_tiers.py tests/test_sla_engine.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/sla_engine.py backend/tests
git commit -m "feat(priority): SLA priority tiers validate against the priorities table; drop PRIORITIES literal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Embed `priority` in list rows and remove the inbox copy-from-order

**Files:**
- Modify: `backend/main.py` — `SenaiteSampleItem` (16433) + `GET /registry/samples` (23682); worksheets inbox item model (~20040) and its builder (~20216–20630); `GET /explorer/...` order rows that carry sample rows; `SampleActivity` endpoint (1036)
- Modify: `backend/sub_samples/schemas.py` — `SubSampleResponse` (18)
- Modify: `backend/sub_samples/routes.py` — list + detail builders
- Test: `backend/tests/test_priority_embed.py`

**Interfaces:**
- Every row type gains `priority: Optional[EffectiveOut]` (shape `{key, rank, source_level, source_id}`), populated once per response via `service.load_effective`. Inbox items keep their legacy `priority: str` field for one release, now filled from `effective.key` (`default` → `"normal"` for the old consumers) so the current frontend keeps working until the frontend plan lands.
- The activity endpoint gains lines from `priority_audit`.
- Page payloads the frontend set-controls need (frontend plan Tasks 8–9): the sample-details lookup result (`SenaiteLookupResult` builder in `main.py` and `sub_samples/registry_details.py`) gains `registry_pk: Optional[int]`, `explicit_priority_key: Optional[str]`, `priority: Optional[dict]`; `SubSampleResponse` gains `priority_key: Optional[str]`; order payloads (`OrderStatusPage` source endpoints under `/explorer/orders` and `/orders/{order_number}`) gain `priority_key: Optional[str]`, `priority_source: Optional[str]`, `effective_priority: Optional[dict]` (customer-inherited: resolve with `explicit={"order": order.priority_key, "customer": <customer row key>}`).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_priority_embed.py
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def test_registry_samples_rows_carry_priority_shape():
    r = client.get("/registry/samples", params={"limit": 5})
    assert r.status_code == 200
    for item in r.json()["items"]:
        assert "priority" in item and set(item["priority"]) >= {"key", "rank", "source_level"}


def test_sub_samples_list_rows_carry_priority_shape():
    with engine.connect() as c:
        sid = c.execute(text("SELECT sample_id FROM lims_samples ORDER BY id DESC LIMIT 1")).scalar()
    if not sid:
        return
    r = client.get(f"/api/sub-samples/{sid}")
    assert r.status_code == 200
    for v in r.json()["sub_samples"]:
        assert "priority" in v


def test_activity_log_includes_priority_audit_lines():
    with engine.connect() as c:
        row = c.execute(text("SELECT id, sample_id FROM lims_samples ORDER BY id DESC LIMIT 1")).first()
    if not row:
        return
    pk, sid = row
    client.put("/priorities/assign", json={"level": "sample", "id": str(pk), "priority_key": "high", "note": "t"})
    events = client.get(f"/samples/{sid}/activity").json()
    assert any(e.get("source") == "priority_audit" and "High" in (e.get("description") or "") for e in events)
    client.put("/priorities/assign", json={"level": "sample", "id": str(pk), "priority_key": None})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_priority_embed.py -q`
Expected: FAIL — `KeyError: 'priority'` / no `priority_audit` source.

- [ ] **Step 3: Implement the embedding**

Add to `SenaiteSampleItem` and to `sub_samples/schemas.py::SubSampleResponse`:

```python
    priority: Optional[dict] = None  # {key, rank, source_level, source_id}; spec §5 inline shape
```

In `GET /registry/samples` (after the items list is built and before the response is returned), where each item has the native pk available (the registry row `id`):

```python
    from priority.service import load_effective
    pk_by_index = {i: it._registry_pk for i, it in enumerate(items) if getattr(it, "_registry_pk", None)}
    by_s, _ = load_effective(db, sample_pks=pk_by_index.values())
    for i, pk in pk_by_index.items():
        items[i].priority = by_s[pk].as_dict()
```

(If the builder does not keep the pk on the item, capture it into a parallel list while building; do not change the item's public fields beyond `priority`.)

In `sub_samples/routes.py` list and detail handlers, after the sub-sample rows are serialized:

```python
    from priority.service import load_effective
    _, by_v = load_effective(db, sub_sample_pks=[v.id for v in rows])
    for out, v in zip(serialized, rows):
        out.priority = by_v[v.id].as_dict()
```

Worksheets inbox builder (~20216–20630): delete the two "apply order-level priority" blocks (the `SamplePriority(...)` adds at ~19897 and ~20247 and the `order_priority_map` plumbing that feeds them). Replace `priority_map` (uid → str) with a native lookup: collect the sub-sample pks the builder already has (`sub.id`), call `load_effective(db, sub_sample_pks=...)`, and set each item's legacy `priority` to `"normal" if eff.key == "default" else eff.key`, plus `item.priority_effective = eff.as_dict()`. Add `priority_effective: Optional[dict] = None` to the inbox item model (~20040). Keep `POST /sample-priorities/lookup` and the two inbox priority PUTs in place for this release; the PUTs now call `service.assign(level="sample", ...)` after mapping uid → `lims_samples.id` via `external_lims_uid`, and 404 if the uid has no native row.

Activity log (`get_sample_activity`, 1036): after the existing event collection, append:

```python
    from models import PriorityAudit, LimsSubSample, Priority
    names = {p.key: p.name for p in db.execute(select(Priority)).scalars()}
    sample_row = db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)).scalar_one_or_none()
    if sample_row:
        vial_ids = [str(v) for v in db.execute(
            select(LimsSubSample.id).where(LimsSubSample.parent_sample_pk == sample_row.id)).scalars()]
        ids = [str(sample_row.id)] + vial_ids
        for a in db.execute(select(PriorityAudit).where(
                ((PriorityAudit.level == "sample") & (PriorityAudit.entity_id == str(sample_row.id)))
                | ((PriorityAudit.level == "vial") & (PriorityAudit.entity_id.in_(vial_ids)))
                | ((PriorityAudit.level == "order") & (PriorityAudit.entity_id == (sample_row.client_order_number or "")))
        ).order_by(PriorityAudit.at)).scalars():
            old = names.get(a.old_key, "Inherit") if a.old_key else "Inherit"
            new = names.get(a.new_key, "Inherit") if a.new_key else "Inherit"
            where = {"sample": "", "vial": f" (vial {a.entity_id})", "order": f" via order {a.entity_id}"}[a.level]
            events.append({
                "timestamp": a.at.isoformat(), "type": "priority",
                "description": f"Priority: {old} → {new}{where}",
                "user_id": a.user_id, "source": "priority_audit", "note": a.note,
            })
```

(Match the exact dict keys the endpoint already uses for its other sources: read lines 1036–1090 and reuse the same key names for timestamp / description / source.)

- [ ] **Step 4: Run to verify they pass, then the inbox tests**

Run: `cd backend && python -m pytest tests/test_priority_embed.py tests/test_worksheets_inbox*.py -q`
Expected: pass. If an inbox test asserted the copy-from-order behaviour, update it to assert the effective priority comes from `lims_orders.priority_key` through the resolver instead.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/sub_samples backend/tests/test_priority_embed.py backend/tests
git commit -m "feat(priority): embed effective priority in list rows; activity log lines; drop inbox copy-from-order

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Order ingest mapping and clock-event snapshots

**Files:**
- Modify: `backend/main.py` — `POST /s2s/orders/upsert` (22878, the `LimsOrder(...)` create at 22891); the receive touchpoint call site (16939) and the publish touchpoint call site (17612)
- Test: `backend/tests/test_priority_ingest_and_clock.py`

**Interfaces:**
- Consumes: `service.assign`, `snapshot.refresh`.
- Produces: on order CREATE only, `payload.priority` (already in the upsert item model if present; otherwise add `priority: Optional[str] = None` to the item schema) maps to `lims_orders.priority_key` with `priority_source='order-payload'` and an audit row; unknown keys are logged at WARNING and ignored. After the receive touchpoint succeeds, `snapshot.refresh(db, [sample_pk])`; after the publish touchpoint succeeds, `snapshot.refresh(db, [sample_pk])` (no `only_in_flight`, so completion is recorded).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_priority_ingest_and_clock.py
import uuid
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _upsert(order_number, **extra):
    body = {"orders": [{"wp_order_id": abs(hash(order_number)) % 10**8, "order_number": order_number, **extra}]}
    return client.post("/s2s/orders/upsert", json=body, headers={"X-Service-Token": "test"})


def test_payload_priority_lands_on_create_only():
    on = f"WP-T{uuid.uuid4().hex[:6]}"
    r = _upsert(on, priority="expedited"); assert r.status_code in (200, 201), r.text
    with engine.connect() as c:
        row = c.execute(text("SELECT priority_key, priority_source FROM lims_orders WHERE order_number=:o"), {"o": on}).first()
    assert row == ("expedited", "order-payload")
    _upsert(on, priority="high")  # second push must not override
    with engine.connect() as c:
        assert c.execute(text("SELECT priority_key FROM lims_orders WHERE order_number=:o"), {"o": on}).scalar() == "expedited"
        c.execute(text("DELETE FROM priority_audit WHERE level='order' AND entity_id=:o"), {"o": on})
        c.execute(text("DELETE FROM lims_orders WHERE order_number=:o"), {"o": on}); c.commit()


def test_unknown_payload_priority_is_ignored():
    on = f"WP-T{uuid.uuid4().hex[:6]}"
    _upsert(on, priority="ludicrous")
    with engine.connect() as c:
        assert c.execute(text("SELECT priority_key FROM lims_orders WHERE order_number=:o"), {"o": on}).scalar() is None
        c.execute(text("DELETE FROM lims_orders WHERE order_number=:o"), {"o": on}); c.commit()
```

(The s2s auth dependency: reuse whatever override `backend/tests/test_s2s_*.py` already applies for the internal-service token; copy that fixture verbatim.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_priority_ingest_and_clock.py -q`
Expected: FAIL — `priority_key` is None after create.

- [ ] **Step 3: Implement**

In the upsert handler, immediately after `row = LimsOrder(wp_order_id=o.wp_order_id, order_number=o.order_number)` and its `db.add(row); db.flush()`:

```python
            if getattr(o, "priority", None):
                from priority.service import assign, priority_map
                if o.priority in priority_map(db):
                    assign(db, level="order", entity_id=row.order_number, priority_key=o.priority,
                           user_id=None, source="order-payload", note="from order payload")
                else:
                    logger.warning("s2s order %s: unknown payload priority %r ignored", o.order_number, o.priority)
```

At the receive touchpoint call site (16939) and the publish touchpoint call site (17612), after the call returns successfully and the sample pk is known:

```python
            from priority.snapshot import refresh as _sla_snapshot
            _sla_snapshot(db, [sample_row.id])
```

(Use the local variable name that holds the `LimsSample` at each site; both sites already have it for the touchpoint call.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && python -m pytest tests/test_priority_ingest_and_clock.py tests/test_priority_snapshot.py -q`
Expected: pass.

- [ ] **Step 5: Run the whole backend suite and record the baseline delta**

Run: `cd backend && python -m pytest -q 2>&1 | tail -5`
Expected: no new failures versus master (known pre-existing failures are listed in the vault session logs; compare counts).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_priority_ingest_and_clock.py
git commit -m "feat(priority): order-payload priority on create; SLA snapshots at receive and publish

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Run the GitNexus checks and hand off

- [ ] **Step 1:** `gitnexus_detect_changes()` — confirm affected flows are the inbox builder, sample activity, registry list, sub-sample list, s2s upsert, receive/publish touchpoints only.
- [ ] **Step 2:** `cd backend && python -m pytest -q` green versus baseline; `git log --oneline origin/master..HEAD` shows Tasks 1–9.
- [ ] **Step 3:** Push the branch; the frontend plan (`2026-09-09-sample-priority-frontend.md`) starts from this commit.
