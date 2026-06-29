# Catalog Foundation (Plan 1A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `departments` table and extend `service_groups` + `analysis_services` with `department_id` / `vials_required` / `is_assignable` (+ per-service `sla_tier_id`), seeded from the live group rows so the catalog faithfully mirrors *current* grouping — with parity tests proving it. No behavior is rerouted yet (that is Plan 1B+).

**Architecture:** Additive only. New catalog columns live alongside the existing hardcoded routing maps; nothing reads the new columns for routing in this plan. Department is a single, direct property of a service (its home bench). The seed is **derived from existing `service_group` rows**, not hardcoded, so it reproduces whatever prod actually has (this side-steps the unresolved Endotoxin-group question — `ENDO-LAL` maps to the Microbiology department whether or not a distinct `Endotoxin` *group* exists).

**Tech Stack:** Python 3 / FastAPI, SQLAlchemy 2.0 (`mapped_column` style), raw-SQL idempotent migrations in `database._run_migrations`, pytest (in-memory SQLite unit fixtures + `TestClient` API tests). Frontend types in TypeScript (`src/lib/api.ts`). No Alembic in Accu-Mk1.

## Global Constraints

- **Additive only.** New columns/tables extend existing systems; do not re-architect or change routing behavior in this plan. (spec: Locked decision 7)
- **No Alembic.** Schema changes go in `backend/database.py::_run_migrations` as idempotent raw SQL (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`), plus the SQLAlchemy model for `create_all` on fresh DBs.
- **GitNexus impact analysis before editing any existing symbol.** Before modifying `ServiceGroup`, `AnalysisService`, `_run_migrations`, `init_db`, `ServiceGroupResponse`/`ServiceGroupCreate`/`ServiceGroupUpdate`, the `GET/POST/PUT /service-groups` handlers, or the `ServiceGroup` TS interface, run `gitnexus_impact({target, direction:"upstream"})`, report the blast radius, and warn on HIGH/CRITICAL. Run `gitnexus_detect_changes()` before each commit. (Accu-Mk1 AGENTS.md/CLAUDE.md)
- **Seed is derived from live data, never hardcoded.** The Endotoxin-group question is unconfirmed (spec open #5); the backfill reads `service_groups` rows as-is.
- **Department mapping invariant:** `Analytics → Analytical`; `Microbiology → Microbiology`; `Endotoxin → Microbiology`. `ENDO-LAL` is a Microbiology-department service regardless of its group.
- **Catalog tables are config** (no `lims_` prefix), mirroring the existing `service_groups` naming.
- **npm only** for any frontend tooling (not pnpm). Backend deps unchanged.
- TDD, one assertion-focused test per behavior, frequent commits.

---

## File Structure

- **Modify** `backend/models.py` — add `class Department`; add columns to `ServiceGroup` (`department_id`, `vials_required`, `is_assignable`) and `AnalysisService` (`department_id`, `vials_required`, `is_assignable`, `sla_tier_id`).
- **Modify** `backend/database.py` — in `_run_migrations`: `CREATE TABLE IF NOT EXISTS departments` (before the ALTERs), the idempotent ADD COLUMN ALTERs, the department seed, and the department backfill; call the backfill from `init_db`.
- **Create** `backend/catalog/__init__.py`, `backend/catalog/departments.py` — `department_for_group_name()` mapping + `backfill_departments(db)` logic (one focused responsibility: catalog department assignment).
- **Modify** `backend/main.py` — `Department*` Pydantic schemas + `GET/POST /departments`; extend `ServiceGroupCreate/Update/Response` with `department_id` / `vials_required` / `is_assignable`.
- **Modify** `src/lib/api.ts` — add `department_id` / `vials_required` / `is_assignable` to the `ServiceGroup` interface; add a `Department` interface.
- **Create** `backend/tests/test_departments_catalog.py` — model + API tests for departments and the new columns.
- **Create** `backend/tests/test_catalog_parity.py` — parity tests asserting the department mapping reproduces the hardcoded literals.

---

## Task 1: `Department` model

**Files:**
- Modify: `backend/models.py` (add `class Department` after `ServiceGroup`/junction, ~after line 218)
- Test: `backend/tests/test_departments_catalog.py`

**Interfaces:**
- Produces: `Department` ORM model — `Department(id: int, name: str, sort_order: int=0, color: str="blue", is_system: bool=False, created_at, updated_at)`; `__tablename__ = "departments"`; `name` unique.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_departments_catalog.py`:

```python
"""Catalog: departments table + extended group/service columns. Self-restoring."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401  (register all models on Base)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_department_persists_with_defaults(db_session):
    from models import Department
    d = Department(name="Microbiology")
    db_session.add(d)
    db_session.commit()
    db_session.refresh(d)
    assert d.id is not None
    assert d.name == "Microbiology"
    assert d.sort_order == 0
    assert d.color == "blue"
    assert d.is_system is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py::test_department_persists_with_defaults -q'`
Expected: FAIL with `ImportError: cannot import name 'Department' from 'models'`.

- [ ] **Step 3: Write minimal implementation**

In `backend/models.py`, immediately after the `service_group_members` table definition (after line 218), add:

```python
class Department(Base):
    """Top-level lab department (e.g. Analytical, Microbiology).

    A service's single structural home; drives the assignment-page block, the
    HPLC-mirror allow-list, and the worksheet/inbox lane. Catalog config table.
    """
    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    color: Mapped[str] = mapped_column(String(50), nullable=False, default="blue")
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<Department(id={self.id}, name='{self.name}')>"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py::test_department_persists_with_defaults -q'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/models.py backend/tests/test_departments_catalog.py
git commit -m "feat(catalog): add Department model"
```

---

## Task 2: Extend `ServiceGroup` + `AnalysisService` with catalog columns

**Files:**
- Modify: `backend/models.py` (`ServiceGroup` ~182-207; `AnalysisService` ~147-179)
- Test: `backend/tests/test_departments_catalog.py`

**Interfaces:**
- Produces: `ServiceGroup.department_id: int|None`, `ServiceGroup.vials_required: int|None`, `ServiceGroup.is_assignable: bool` (default False). `AnalysisService.department_id: int|None`, `AnalysisService.vials_required: int|None`, `AnalysisService.is_assignable: bool` (default False), `AnalysisService.sla_tier_id: int|None`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_departments_catalog.py`:

```python
def test_service_group_and_service_have_catalog_columns(db_session):
    from models import Department, ServiceGroup, AnalysisService
    dept = Department(name="Analytical")
    db_session.add(dept)
    db_session.commit()

    g = ServiceGroup(name="Analytics", department_id=dept.id, vials_required=1, is_assignable=True)
    s = AnalysisService(
        title="HPLC Purity", keyword="PUR_X",
        department_id=dept.id, vials_required=1, is_assignable=False, sla_tier_id=None,
    )
    db_session.add_all([g, s])
    db_session.commit()
    db_session.refresh(g)
    db_session.refresh(s)

    assert g.department_id == dept.id
    assert g.vials_required == 1
    assert g.is_assignable is True
    assert s.department_id == dept.id
    assert s.vials_required == 1
    assert s.is_assignable is False
    assert s.sla_tier_id is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py::test_service_group_and_service_have_catalog_columns -q'`
Expected: FAIL with `TypeError: 'department_id' is an invalid keyword argument for ServiceGroup`.

- [ ] **Step 3: Write minimal implementation**

In `backend/models.py`, in `class ServiceGroup`, after the `sla_tier_id` column (line ~199) add:

```python
    department_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    vials_required: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    is_assignable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
```

In `class AnalysisService`, after the `active` column (line ~169) add:

```python
    department_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    vials_required: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    is_assignable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sla_tier_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("sla_tiers.id", ondelete="SET NULL"), nullable=True
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py::test_service_group_and_service_have_catalog_columns -q'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/models.py backend/tests/test_departments_catalog.py
git commit -m "feat(catalog): add department_id/vials_required/is_assignable to groups + services"
```

---

## Task 3: Department mapping module (`department_for_group_name`)

**Files:**
- Create: `backend/catalog/__init__.py` (empty), `backend/catalog/departments.py`
- Test: `backend/tests/test_catalog_parity.py`

**Interfaces:**
- Produces: `department_for_group_name(group_name: str) -> Optional[str]` — returns the department name a service group belongs to, or `None` if unknown. `Analytics → "Analytical"`; `Microbiology → "Microbiology"`; `Endotoxin → "Microbiology"`.
- Produces: `DEPARTMENT_NAMES: list[str]` — the seed set `["Analytical", "Microbiology"]`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_catalog_parity.py`:

```python
"""Parity: the catalog department mapping must reproduce the hardcoded routing
literals. If these fail, the catalog would disagree with current behavior."""
from catalog.departments import department_for_group_name, DEPARTMENT_NAMES
from sub_samples.service import _ROLE_GROUP_NAMES


def test_known_group_names_map_to_expected_departments():
    assert department_for_group_name("Analytics") == "Analytical"
    assert department_for_group_name("Microbiology") == "Microbiology"
    assert department_for_group_name("Endotoxin") == "Microbiology"


def test_unknown_group_name_returns_none():
    assert department_for_group_name("Nonsense") is None


def test_every_role_group_name_resolves_to_a_seeded_department():
    # Every group named in the hardcoded role->group map must land in a real department.
    for role, group_names in _ROLE_GROUP_NAMES.items():
        for gname in group_names:
            dept = department_for_group_name(gname)
            assert dept in DEPARTMENT_NAMES, f"role {role!r} group {gname!r} -> {dept!r} not seeded"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_catalog_parity.py -q'`
Expected: FAIL with `ModuleNotFoundError: No module named 'catalog'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/catalog/__init__.py` (empty file).

Create `backend/catalog/departments.py`:

```python
"""Catalog department assignment.

Single source of truth for which top-level Department a service group belongs to.
Derived to match the existing hardcoded routing literals (sub_samples.service
._ROLE_GROUP_NAMES, lims_analyses.seeder._NON_HPLC_GROUPS): Analytics is the
Analytical bench; Microbiology and Endotoxin are both the Microbiology bench.
"""
from typing import Optional

DEPARTMENT_NAMES = ["Analytical", "Microbiology"]

# Group name -> department name. Endotoxin nests under Microbiology (the
# assignment UI already shows Endo + Sterility inside the Microbiology block).
_GROUP_NAME_TO_DEPARTMENT = {
    "Analytics": "Analytical",
    "Microbiology": "Microbiology",
    "Endotoxin": "Microbiology",
}


def department_for_group_name(group_name: str) -> Optional[str]:
    """Return the department name for a service group, or None if unknown."""
    return _GROUP_NAME_TO_DEPARTMENT.get(group_name)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_catalog_parity.py -q'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/catalog/__init__.py backend/catalog/departments.py backend/tests/test_catalog_parity.py
git commit -m "feat(catalog): department-for-group-name mapping + parity tests"
```

---

## Task 4: Backfill function (seed departments + assign `department_id` from live groups)

**Files:**
- Modify: `backend/catalog/departments.py`
- Test: `backend/tests/test_departments_catalog.py`

**Interfaces:**
- Consumes: `Department`, `ServiceGroup`, `AnalysisService` models; `department_for_group_name`, `DEPARTMENT_NAMES`.
- Produces: `backfill_departments(db: Session) -> None` — idempotent: ensures a `Department` row exists for each name in `DEPARTMENT_NAMES`; sets `ServiceGroup.department_id` from `department_for_group_name(group.name)`; sets each `AnalysisService.department_id` from the (first) group it belongs to. Services in no recognized group are left `None` (handled later by Plan 1C). Never deletes or hardcodes membership — reads live `service_groups` rows.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_departments_catalog.py`:

```python
def _seed_groups_and_services(db_session):
    from models import ServiceGroup, AnalysisService
    from models import service_group_members
    analytics = ServiceGroup(name="Analytics")
    micro = ServiceGroup(name="Microbiology")
    db_session.add_all([analytics, micro])
    db_session.commit()
    pur = AnalysisService(title="Purity X", keyword="PUR_X")
    ster = AnalysisService(title="Sterility PCR", keyword="STER-PCR")
    db_session.add_all([pur, ster])
    db_session.commit()
    db_session.execute(service_group_members.insert().values(
        service_group_id=analytics.id, analysis_service_id=pur.id))
    db_session.execute(service_group_members.insert().values(
        service_group_id=micro.id, analysis_service_id=ster.id))
    db_session.commit()
    return analytics, micro, pur, ster


def test_backfill_seeds_departments_and_assigns_ids(db_session):
    from catalog.departments import backfill_departments
    from models import Department, ServiceGroup, AnalysisService
    analytics, micro, pur, ster = _seed_groups_and_services(db_session)

    backfill_departments(db_session)

    dept_names = {d.name for d in db_session.query(Department).all()}
    assert {"Analytical", "Microbiology"} <= dept_names

    analytical = db_session.query(Department).filter_by(name="Analytical").one()
    microbiology = db_session.query(Department).filter_by(name="Microbiology").one()
    assert db_session.get(ServiceGroup, analytics.id).department_id == analytical.id
    assert db_session.get(ServiceGroup, micro.id).department_id == microbiology.id
    assert db_session.get(AnalysisService, pur.id).department_id == analytical.id
    assert db_session.get(AnalysisService, ster.id).department_id == microbiology.id


def test_backfill_is_idempotent(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    backfill_departments(db_session)
    assert db_session.query(Department).filter_by(name="Microbiology").count() == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py -k backfill -q'`
Expected: FAIL with `ImportError: cannot import name 'backfill_departments'`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/catalog/departments.py`:

```python
from sqlalchemy.orm import Session


def backfill_departments(db: Session) -> None:
    """Idempotently seed departments and assign department_id from live groups.

    Derived from current data: a service's department = the department of (one of)
    its service groups. Never hardcodes membership; safe to re-run on every start.
    """
    from models import Department, ServiceGroup, AnalysisService

    # 1. Ensure department rows exist.
    by_name: dict[str, Department] = {}
    for i, name in enumerate(DEPARTMENT_NAMES):
        dept = db.query(Department).filter_by(name=name).one_or_none()
        if dept is None:
            dept = Department(name=name, sort_order=i)
            db.add(dept)
            db.flush()
        by_name[name] = dept

    # 2. Assign each group's department_id from its name.
    for group in db.query(ServiceGroup).all():
        dept_name = department_for_group_name(group.name)
        if dept_name is not None:
            group.department_id = by_name[dept_name].id

    # 3. Assign each service's department_id from a group it belongs to.
    for group in db.query(ServiceGroup).all():
        if group.department_id is None:
            continue
        for svc in group.analysis_services:
            if svc.department_id is None:
                svc.department_id = group.department_id

    db.commit()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py -k backfill -q'`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/catalog/departments.py backend/tests/test_departments_catalog.py
git commit -m "feat(catalog): idempotent department seed + backfill from live groups"
```

---

## Task 5: Wire migrations + backfill into startup

**Files:**
- Modify: `backend/database.py` (`_run_migrations` list ~line 392 area; `init_db` ~116-123)

**Interfaces:**
- Consumes: `catalog.departments.backfill_departments`.
- Produces: on startup, the `departments` table exists, the new columns exist on `service_groups`/`analysis_services` (existing DBs), and `backfill_departments` has run.

- [ ] **Step 1: Add the raw-SQL migrations**

In `backend/database.py`, inside the `migrations` list in `_run_migrations` (add near the other `service_groups`/`analysis_services` ALTERs, ~line 392). The `CREATE TABLE` MUST precede the FK ALTERs so the FK target exists in one startup:

```python
        # --- Catalog v1 (Plan 1A): departments + group/service catalog columns ---
        """
        CREATE TABLE IF NOT EXISTS departments (
            id SERIAL PRIMARY KEY,
            name VARCHAR(200) NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            color VARCHAR(50) NOT NULL DEFAULT 'blue',
            is_system BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now()
        )
        """,
        "ALTER TABLE service_groups ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL",
        "ALTER TABLE service_groups ADD COLUMN IF NOT EXISTS vials_required INTEGER",
        "ALTER TABLE service_groups ADD COLUMN IF NOT EXISTS is_assignable BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL",
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS vials_required INTEGER",
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS is_assignable BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS sla_tier_id INTEGER REFERENCES sla_tiers(id) ON DELETE SET NULL",
```

- [ ] **Step 2: Call the backfill from `init_db`**

In `backend/database.py`, in `init_db` (after `Base.metadata.create_all(bind=engine)` at line ~122, before/after `_seed_federal_holidays_window()`), add:

```python
    # Plan 1A: seed departments and backfill department_id from live groups.
    from catalog.departments import backfill_departments
    with SessionLocal() as _s:
        backfill_departments(_s)
```

> Note: `SessionLocal` is the module-level sessionmaker in `database.py`. If it is named differently, use the existing session factory.

- [ ] **Step 3: Restart the backend and verify migrations applied**

Run: `docker restart accu-mk1-backend && sleep 5 && docker exec accu-mk1-backend sh -c "cd /app && python -c \"from database import engine; from sqlalchemy import text; c=engine.connect(); print(c.execute(text('SELECT count(*) FROM departments')).scalar()); print([r[0] for r in c.execute(text(\\\"SELECT name FROM departments ORDER BY name\\\"))])\""`
Expected: prints `2` and `['Analytical', 'Microbiology']` (or more if extra departments seeded), with no traceback. Check logs for `migration_skipped` only on first-run benign cases.

- [ ] **Step 4: Verify groups got a department_id**

Run: `docker exec accu-mk1-backend sh -c "cd /app && python -c \"from database import engine; from sqlalchemy import text; c=engine.connect(); print([(r[0], r[1]) for r in c.execute(text('SELECT sg.name, d.name FROM service_groups sg LEFT JOIN departments d ON sg.department_id=d.id ORDER BY sg.name'))])\""`
Expected: each known group (`Analytics`, `Microbiology`, and `Endotoxin` if it exists) is paired with its department; `Analytics→Analytical`, `Microbiology→Microbiology`, `Endotoxin→Microbiology`. **This output is the live answer to spec open #5 — record which groups actually exist in this DB.**

- [ ] **Step 5: Commit**

```bash
git add backend/database.py
git commit -m "feat(catalog): wire department migrations + backfill into init_db"
```

---

## Task 6: Departments CRUD API + expose catalog fields on service-groups

**Files:**
- Modify: `backend/main.py` (Service Group schemas ~1995-2037; add Department schemas + endpoints; extend service-group handlers ~13377-13441)
- Modify: `src/lib/api.ts` (`ServiceGroup` interface ~4159-4171; add `Department` interface)
- Test: `backend/tests/test_departments_catalog.py`

**Interfaces:**
- Consumes: `Department` model; existing `get_db`, `get_current_user`, `ServiceGroupResponse`.
- Produces: `GET /departments` → `list[DepartmentResponse]`; `POST /departments` → `DepartmentResponse` (201, duplicate-name 400). `ServiceGroupResponse` now includes `department_id: int|None`, `vials_required: int|None`, `is_assignable: bool`. `ServiceGroupCreate`/`Update` accept the same three fields.
- Produces (TS): `Department { id, name, sort_order, color, is_system }`; `ServiceGroup` gains `department_id: number | null`, `vials_required: number | null`, `is_assignable: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_departments_catalog.py`:

```python
import auth
from fastapi.testclient import TestClient
from sqlalchemy import text as _text


def _client():
    from main import app
    app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup_departments():
    from database import engine
    with engine.connect() as c:
        before = {r[0] for r in c.execute(_text("SELECT id FROM departments")).fetchall()}
    yield
    with engine.begin() as c:
        after = {r[0] for r in c.execute(_text("SELECT id FROM departments")).fetchall()}
        new = list(after - before)
        if new:
            c.execute(_text("DELETE FROM departments WHERE id = ANY(:i)"), {"i": new})


def test_create_and_list_department():
    client = _client()
    resp = client.post("/departments", json={"name": "ZZ Test Dept", "sort_order": 9})
    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "ZZ Test Dept"
    listed = client.get("/departments").json()
    assert any(d["name"] == "ZZ Test Dept" for d in listed)


def test_duplicate_department_name_rejected():
    client = _client()
    client.post("/departments", json={"name": "ZZ Dup Dept"})
    resp = client.post("/departments", json={"name": "ZZ Dup Dept"})
    assert resp.status_code == 400


def test_service_groups_response_includes_department_fields():
    client = _client()
    groups = client.get("/service-groups").json()
    assert isinstance(groups, list)
    if groups:
        assert "department_id" in groups[0]
        assert "is_assignable" in groups[0]
        assert "vials_required" in groups[0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py -k "department and (create or duplicate or includes)" -q'`
Expected: FAIL — `POST /departments` returns 404/405 (route missing) and `department_id` absent from the service-groups payload.

- [ ] **Step 3a: Add Department schemas + endpoints**

In `backend/main.py`, after the Service Group schemas block (after line ~2037), add:

```python
# ─── Department schemas (Catalog v1) ───

class DepartmentCreate(BaseModel):
    name: str
    sort_order: int = 0
    color: str = "blue"
    is_system: bool = False


class DepartmentResponse(BaseModel):
    id: int
    name: str
    sort_order: int
    color: str
    is_system: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
```

Near the service-group route block (after `GET /service-groups`, ~line 13405), add:

```python
@app.get("/departments", response_model=list[DepartmentResponse])
async def get_departments(
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Return all departments ordered by sort_order, name."""
    from models import Department
    rows = db.execute(
        select(Department).order_by(Department.sort_order, Department.name)
    ).scalars().all()
    return rows


@app.post("/departments", response_model=DepartmentResponse, status_code=201)
async def create_department(
    data: DepartmentCreate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Create a new department."""
    from models import Department
    existing = db.execute(
        select(Department).where(Department.name == data.name)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(400, f"Department '{data.name}' already exists")
    dept = Department(**data.model_dump())
    db.add(dept)
    db.commit()
    db.refresh(dept)
    return dept
```

- [ ] **Step 3b: Extend the service-group schemas + GET handler**

In `backend/main.py`, add the three fields to `ServiceGroupCreate` and `ServiceGroupUpdate` (after `sla_tier_id`, ~line 2003 and ~2015):

```python
    department_id: Optional[int] = None
    vials_required: Optional[int] = None
    is_assignable: bool = False
```

(For `ServiceGroupUpdate`, make `is_assignable` `Optional[bool] = None` to keep partial-update semantics.)

Add to `ServiceGroupResponse` (after `sla_tier_id`, ~line 2025):

```python
    department_id: Optional[int] = None
    vials_required: Optional[int] = None
    is_assignable: bool = False
```

In the `GET /service-groups` handler (`build` of `ServiceGroupResponse`, ~line 13390), add the three fields to the constructed response:

```python
            department_id=group.department_id,
            vials_required=group.vials_required,
            is_assignable=group.is_assignable,
```

> The `POST /service-groups` and `PUT /service-groups/{id}` handlers already build the model via `ServiceGroup(**data.model_dump())` / `setattr` loops, so the new create/update fields flow through without further change. Add the same three kwargs to the `ServiceGroupResponse(...)` returned by `POST` (~line 13430) for consistency.

- [ ] **Step 3c: Add the frontend types**

In `src/lib/api.ts`, extend the `ServiceGroup` interface (~4159-4171) by adding:

```typescript
  department_id: number | null
  vials_required: number | null
  is_assignable: boolean
```

And add a `Department` interface nearby:

```typescript
export interface Department {
  id: number
  name: string
  sort_order: number
  color: string
  is_system: boolean
  created_at: string
  updated_at: string
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py -q'`
Expected: PASS (all tests).

Run frontend typecheck: ask the Handler to run `npm run check:all` in `Accu-Mk1` and report back (per AGENTS.md — no dev server / typecheck run by Claude).
Expected: typecheck passes with the new fields.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py src/lib/api.ts backend/tests/test_departments_catalog.py
git commit -m "feat(catalog): departments CRUD + expose catalog fields on service-groups"
```

---

## Self-Review

**1. Spec coverage (Plan 1A scope only):**
- Catalog data model (Department + group/service extensions) → Tasks 1, 2. ✓
- Seed/reconcile to reproduce current behavior, derived from live data → Tasks 3, 4, 5 (Task 5 Step 4 dumps the live grouping = the spec open-#5 answer). ✓
- Parity tests (catalog mapping == literals) → Tasks 3 & 6. ✓
- API exposure of `department_id` (so 1B/1C and the SLA resolver can read it) → Task 6; `sla-resolution.ts` only reads `sla_tier_id`/`member_ids`, undisturbed. ✓
- Out of 1A scope (correctly deferred): routing/demand/seeder rerouting (1B/1C), safety-coupling conversion (1B), sterility tenant (1C), SENAITE/COA (1D/1E), WP products (1F), admin UI for catalog editing.

**2. Placeholder scan:** No TODO/TBD; every code step shows complete code; commands have expected output. ✓

**3. Type consistency:** `department_for_group_name`/`backfill_departments`/`DEPARTMENT_NAMES` names match across Tasks 3–5; `Department` fields identical across model (Task 1), migration (Task 5), schema + TS interface (Task 6); the three new group/service columns named identically everywhere. ✓

**Open dependency for 1B (carried forward):** Task 5 Step 4's live dump tells us whether a distinct `Endotoxin` group exists in this DB — feed that into Plan 1B's allow-list conversion and the spec open-#5 resolution before cutting `_NON_HPLC_GROUPS`.
