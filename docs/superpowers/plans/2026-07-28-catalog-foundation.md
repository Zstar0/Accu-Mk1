# Analysis Catalog Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Accu-Mk1 analysis catalog real, editable, and Mk1-owned — Departments, Mk1-native Analysis Services with full CRUD, and a new Analysis Profile entity — reproducing today's behavior exactly.

**Architecture:** Additive throughout. New tables and nullable columns live alongside the existing hardcoded literals. The only live behavior flip is `build_ordered_products`, which gains an optional DB-backed lookup and is parity-gated against the legacy `PRODUCT_REGISTRY` path. Two fail-open couplings (HPLC mirror, inbox lane) become fail-closed and Department-keyed. Nothing here creates, updates, or deletes any SENAITE object.

**Tech Stack:** Python 3.13 / FastAPI / SQLAlchemy 2.0 (`Mapped` / `mapped_column`) / PostgreSQL (SQLite in unit tests) / pytest — backend. React 19 / TypeScript / TanStack Query / Zustand / shadcn-ui / vitest — frontend.

**Spec:** `docs/superpowers/specs/2026-07-28-analysis-catalog-foundation-design.md`

## Global Constraints

- **Additive only.** A failing pre-existing test defaults to "the test is stale," not "the code is wrong." Production-behavior changes need Handler sign-off.
- **Never zero-failures.** Gate on a *failure-set diff* against master in the **same virtualenv**. The suite has a known non-empty baseline.
- **Backend tests:** run from `backend/` using its own venv — `.venv/Scripts/python.exe -m pytest ...`. Never `pip install` into system Python.
- **Frontend is npm only.** Never pnpm.
- **LIMS-workflow tables keep the `lims_` prefix.** Catalog tables are configuration and follow the existing `service_groups` / `analysis_services` naming — no prefix.
- **Migrations:** Accu-Mk1 uses `Base.metadata.create_all` plus a hand-rolled list of idempotent SQL strings in `backend/database.py::_run_migrations()`. Every statement must be re-runnable (`IF NOT EXISTS`). Statements are per-statement isolated — one failure must not skip the rest.
- **Stage explicit paths in every commit.** Never `git add -A` — the worktree carries unrelated dirty files (`AGENTS.md`, `CLAUDE.md`, CRLF-touched `scripts/*.sh`).
- **Nothing in this plan may create, update, or delete a SENAITE object.**
- Branch for this work: `feat/catalog-foundation`, cut from `origin/master`.

---

### Task 1: Department model, catalog columns, seed and backfill

Ports PR #31's Plan-1A backend. Creates the `departments` table, adds `department_id` to services and groups, and seeds/backfills it **derived from live rows** — never hardcoded membership.

**Files:**
- Create: `backend/catalog/__init__.py` (empty)
- Create: `backend/catalog/departments.py`
- Modify: `backend/models.py` (add `Department`; add `department_id` to `AnalysisService` and `ServiceGroup`)
- Modify: `backend/database.py` (migration statements + `init_db` hook)
- Test: `backend/tests/test_departments_catalog.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `models.Department` — columns `id`, `name`, `sort_order`, `color`, `is_system`, `created_at`, `updated_at`
  - `AnalysisService.department_id: Optional[int]`, `ServiceGroup.department_id: Optional[int]`
  - `catalog.departments.DEPARTMENT_NAMES: list[str]` = `["Analytical", "Microbiology"]`
  - `catalog.departments.department_for_group_name(group_name: str) -> Optional[str]`
  - `catalog.departments.department_id_by_name(db: Session, name: str) -> Optional[int]`
  - `catalog.departments.backfill_departments(db: Session) -> None`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_departments_catalog.py`:

```python
"""Catalog: departments table + department_id columns + idempotent backfill."""
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
    assert d.sort_order == 0
    assert d.color == "blue"
    assert d.is_system is False


def test_group_and_service_have_department_id(db_session):
    from models import Department, ServiceGroup, AnalysisService
    dept = Department(name="Analytical")
    db_session.add(dept)
    db_session.commit()
    g = ServiceGroup(name="Analytics", department_id=dept.id)
    s = AnalysisService(title="Purity X", keyword="PUR_X", department_id=dept.id)
    db_session.add_all([g, s])
    db_session.commit()
    assert g.department_id == dept.id
    assert s.department_id == dept.id


def _seed_groups_and_services(db_session):
    from models import ServiceGroup, AnalysisService, service_group_members
    analytics = ServiceGroup(name="Analytics")
    micro = ServiceGroup(name="Microbiology")
    db_session.add_all([analytics, micro])
    db_session.commit()
    pur = AnalysisService(title="Purity X", keyword="PUR_X")
    ster = AnalysisService(title="Sterility PCR", keyword="STER-PCR")
    analyte = AnalysisService(title="Analyte 1 Purity", keyword="ANALYTE-1-PUR")
    db_session.add_all([pur, ster, analyte])
    db_session.commit()
    for gid, sid in ((analytics.id, pur.id), (micro.id, ster.id)):
        db_session.execute(service_group_members.insert().values(
            service_group_id=gid, analysis_service_id=sid))
    db_session.commit()
    return analytics, micro, pur, ster, analyte


def test_backfill_seeds_departments_and_assigns_from_live_groups(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    analytics, micro, pur, ster, analyte = _seed_groups_and_services(db_session)

    backfill_departments(db_session)

    names = {d.name for d in db_session.query(Department).all()}
    assert names == {"Analytical", "Microbiology"}
    analytical_id = db_session.query(Department).filter_by(name="Analytical").one().id
    micro_id = db_session.query(Department).filter_by(name="Microbiology").one().id

    db_session.refresh(analytics); db_session.refresh(micro)
    db_session.refresh(pur); db_session.refresh(ster); db_session.refresh(analyte)
    assert analytics.department_id == analytical_id
    assert micro.department_id == micro_id
    assert pur.department_id == analytical_id
    assert ster.department_id == micro_id
    # Ungrouped ANALYTE-* services are tagged Analytical, or the fail-closed
    # HPLC allow-list in Task 2 would drop the very rows the mirror exists for.
    assert analyte.department_id == analytical_id


def test_backfill_is_idempotent(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    backfill_departments(db_session)
    assert db_session.query(Department).count() == 2


def test_backfill_never_clobbers_a_manual_reassignment(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    analytics, _micro, _pur, _ster, _a = _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    micro_id = db_session.query(Department).filter_by(name="Microbiology").one().id

    analytics.department_id = micro_id      # admin moves it by hand
    db_session.commit()
    backfill_departments(db_session)        # a restart must not undo that
    db_session.refresh(analytics)
    assert analytics.department_id == micro_id


def test_department_id_by_name(db_session):
    from catalog.departments import backfill_departments, department_id_by_name
    _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    assert department_id_by_name(db_session, "Analytical") is not None
    assert department_id_by_name(db_session, "Nope") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_departments_catalog.py -v`
Expected: FAIL — `ImportError: cannot import name 'Department' from 'models'`

- [ ] **Step 3: Add the model and columns**

In `backend/models.py`, add to `class AnalysisService` (after the `variance_capable` column):

```python
    department_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
```

Add to `class ServiceGroup` (after `sla_tier_id`):

```python
    department_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
```

Add a new class immediately after the `service_group_members` table definition:

```python
class Department(Base):
    """Top-level lab department (e.g. Analytical, Microbiology).

    A service's single structural home; drives the HPLC-mirror allow-list, the
    worksheet/inbox lane, and the assignment-page block. Catalog config table.
    """
    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    color: Mapped[str] = mapped_column(String(50), nullable=False, default="blue")
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    def __repr__(self) -> str:
        return f"<Department(id={self.id}, name='{self.name}')>"
```

- [ ] **Step 4: Create the catalog package**

Create `backend/catalog/__init__.py` as an empty file.

Create `backend/catalog/departments.py`:

```python
"""Catalog department assignment.

Single source of truth for which top-level Department a service group belongs
to. Analytics is the Analytical bench; Microbiology and Endotoxin are both the
Microbiology bench.

The seed is DERIVED FROM LIVE GROUP ROWS, never from a hardcoded membership
list: whether production carries a distinct 'Endotoxin' group is unconfirmed
(the seeder and the frontend disagree in comments), and seeding an assumption
would bury a defect in data instead of code. ENDO-LAL lands under the
Microbiology department either way.
"""
import logging
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

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


def department_id_by_name(db: Session, name: str) -> Optional[int]:
    """Return the id of the department with this name, or None if absent."""
    from models import Department
    row = db.query(Department).filter_by(name=name).one_or_none()
    return row.id if row else None


def backfill_departments(db: Session) -> None:
    """Idempotently seed departments and assign department_id from live groups.

    Safe to re-run on every start. Never clobbers a value that is already set,
    so an admin reassignment survives a restart.
    """
    from models import AnalysisService, Department, ServiceGroup

    # 1. Ensure department rows exist.
    by_name: dict[str, Department] = {}
    for i, name in enumerate(DEPARTMENT_NAMES):
        dept = db.query(Department).filter_by(name=name).one_or_none()
        if dept is None:
            dept = Department(name=name, sort_order=i)
            db.add(dept)
            db.flush()
        by_name[name] = dept

    # 2. Group -> department, ONLY when unset.
    for group in db.query(ServiceGroup).all():
        if group.department_id is not None:
            continue
        dept_name = department_for_group_name(group.name)
        if dept_name is not None:
            group.department_id = by_name[dept_name].id

    # 3. Service -> department, inherited from a group it belongs to.
    for group in db.query(ServiceGroup).all():
        if group.department_id is None:
            continue
        for svc in group.analysis_services:
            if svc.department_id is None:
                svc.department_id = group.department_id

    # 4. Ungrouped generic per-analyte services (ANALYTE-N-*) are unambiguously
    #    analytical — the HPLC mirror seeds them. Tag them so the fail-closed
    #    allow-list (Task 2) can treat NULL as "unknown -> exclude" without
    #    dropping legitimate analyte rows.
    analytical_id = by_name["Analytical"].id
    for svc in db.query(AnalysisService).filter(
        AnalysisService.department_id.is_(None),
        AnalysisService.keyword.like("ANALYTE-%"),
    ).all():
        svc.department_id = analytical_id

    db.commit()

    # Defense in depth: after this backfill nothing should be NULL. If a future
    # ungrouped analytical service slips through, make it LOUD — the allow-list
    # would otherwise silently drop it from HPLC-vial mirroring.
    null_count = db.query(func.count(AnalysisService.id)).filter(
        AnalysisService.department_id.is_(None)
    ).scalar()
    if null_count:
        samples = [
            kw for (kw,) in db.query(AnalysisService.keyword)
            .filter(AnalysisService.department_id.is_(None))
            .limit(10).all()
        ]
        log.warning(
            "catalog.backfill.null_department count=%s — these services have no "
            "department and will be EXCLUDED from HPLC-vial mirroring "
            "(fail-closed). Sample keywords: %s", null_count, samples,
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_departments_catalog.py -v`
Expected: PASS (6 tests)

- [ ] **Step 6: Wire the migrations and the startup hook**

In `backend/database.py`, append to the statement list inside `_run_migrations()`:

```python
        # --- Catalog foundation: departments + department_id ---
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
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL",
```

In `backend/database.py::init_db()`, after `_seed_federal_holidays_window()`:

```python
    # Catalog foundation: seed departments and backfill department_id.
    from catalog.departments import backfill_departments
    with SessionLocal() as _s:
        backfill_departments(_s)
```

- [ ] **Step 7: Verify the suite is additive**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | tail -20`
Expected: the pre-existing failure set is unchanged, plus 6 new passes. Record the failure list — later tasks compare against it. **Do not expect zero failures.**

- [ ] **Step 8: Commit**

```bash
git add backend/models.py backend/database.py backend/catalog/__init__.py backend/catalog/departments.py backend/tests/test_departments_catalog.py
git commit -m "feat(catalog): Department model + department_id + idempotent backfill"
```

---

### Task 2: Fail-closed Department allow-list for the HPLC mirror

Converts a deny-list whose default is "leak onto the HPLC vial" into an allow-list whose default is "exclude." This is a standing safety bug on master, independent of the rest of the plan — incident BW-0015-S01 was an Endotoxin row on an HPLC vial.

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (`mirror_parent_hplc_analyses`, module docstring, `_micro_group_keywords` docstring)
- Test: `backend/tests/test_seeder_mirror.py`

**Interfaces:**
- Consumes: `catalog.departments.department_id_by_name(db, name)` from Task 1.
- Produces: no signature change. `mirror_parent_hplc_analyses` keeps its existing signature and returns `[]` when the Analytical department is absent.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_seeder_mirror.py`:

```python
"""HPLC mirror is a fail-CLOSED Department allow-list, not a deny-list."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _mk_catalog(db):
    """Analytical + Microbiology departments, one service in each, plus one
    service with NO department at all (the mis-tagged case)."""
    from models import AnalysisService, Department
    analytical = Department(name="Analytical")
    micro = Department(name="Microbiology")
    db.add_all([analytical, micro])
    db.commit()
    db.add_all([
        AnalysisService(title="Purity X", keyword="PUR_X", department_id=analytical.id),
        AnalysisService(title="Sterility PCR", keyword="STER-PCR", department_id=micro.id),
        AnalysisService(title="Endotoxin", keyword="ENDO-LAL", department_id=micro.id),
        AnalysisService(title="Orphan", keyword="ORPHAN-1", department_id=None),
    ])
    db.commit()
    return analytical, micro


def test_micro_and_untagged_services_never_reach_an_hplc_vial(db_session, monkeypatch):
    from lims_analyses import seeder
    _mk_catalog(db_session)

    monkeypatch.setattr(
        seeder.senaite_mod, "fetch_parent_analysis_keywords",
        lambda _sid: ["PUR_X", "STER-PCR", "ENDO-LAL", "ORPHAN-1"],
    )
    created = seeder.mirror_parent_hplc_analyses(
        db_session, parent_sample_id="P-0001", sub_sample_pk=1,
    )
    kws = {row.keyword for row in created}
    assert "PUR_X" in kws
    assert "STER-PCR" not in kws      # Microbiology department
    assert "ENDO-LAL" not in kws      # Microbiology department
    assert "ORPHAN-1" not in kws      # NULL department -> fail closed


def test_mirror_aborts_when_the_analytical_department_is_missing(db_session, monkeypatch):
    """No Analytical department => seed nothing. Never fall back to open."""
    from lims_analyses import seeder
    from models import AnalysisService
    db_session.add(AnalysisService(title="Purity X", keyword="PUR_X"))
    db_session.commit()

    monkeypatch.setattr(
        seeder.senaite_mod, "fetch_parent_analysis_keywords",
        lambda _sid: ["PUR_X"],
    )
    created = seeder.mirror_parent_hplc_analyses(
        db_session, parent_sample_id="P-0001", sub_sample_pk=1,
    )
    assert created == []
```

> **Note for the implementer:** `mirror_parent_hplc_analyses` has more parameters than the two shown. Read its real signature at `backend/lims_analyses/seeder.py` and pass whatever else it requires (the existing tests in that file show the calling convention). Do not change the signature.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_seeder_mirror.py -v`
Expected: FAIL — untagged/micro keywords still appear, because the current predicate is a name-based deny-list.

- [ ] **Step 3: Convert the predicate**

In `backend/lims_analyses/seeder.py`, add the import near the other local imports:

```python
from catalog.departments import department_id_by_name
```

Inside `mirror_parent_hplc_analyses`, replace the `micro_kw = _micro_group_keywords(db)` lookup with:

```python
    # Fail-closed allow-list: only Analytical-department services mirror onto
    # HPLC vials. Microbiology / NULL / mis-tagged services are excluded by
    # default, so nothing can leak onto a chromatography vial. (Was: an
    # exclude-known-Micro deny-list, which defaulted to "contaminate".)
    analytical_dept_id = department_id_by_name(db, "Analytical")
    if analytical_dept_id is None:
        log.error("seeder.mirror.no_analytical_dept — aborting mirror (fail-closed)")
        return []
```

And replace the per-keyword skip:

```python
        if svc.department_id != analytical_dept_id:   # fail-closed: Analytical only
            continue
```

- [ ] **Step 4: Update the two docstrings that describe the old behavior**

Module docstring in `backend/lims_analyses/seeder.py` — replace the paragraph describing the deny-list with:

```
the parent AR's analysis keywords and creates one lims_analyses row per keyword
that exists in the Mk1 catalog ONLY IF that service's department_id equals the
Analytical department id (fail-closed allow-list). Per-analyte ANALYTE-N-*
services are tagged Analytical by the catalog backfill, so they are kept.
Microbiology-department keywords (STER-PCR, KF, ENDO-LAL, PCR-BACTERIA,
PCR-FUNGI) and any NULL/unknown-department service are excluded; those vials
get their own role seeding.
```

Append to the `_micro_group_keywords` docstring:

```
    The HPLC mirror no longer calls this function — it uses a fail-closed
    Department allow-list. This remains in use by the COA-generation blocking
    gate in main.py and by test_assign_role_fail_hard.py.
```

**Do not delete `_micro_group_keywords`.** The COA blocking gate (`backend/main.py:9779`) still imports it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_seeder_mirror.py tests/test_assign_role_fail_hard.py -v`
Expected: PASS — both new tests, and the pre-existing COA-gate tests still green.

- [ ] **Step 6: Verify the suite is additive**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | tail -20`
Expected: failure set identical to the Task 1 baseline, plus the new passes.

- [ ] **Step 7: Commit**

```bash
git add backend/lims_analyses/seeder.py backend/tests/test_seeder_mirror.py
git commit -m "feat(catalog): fail-closed Department allow-list for the HPLC mirror"
```

---

### Task 3: Department-keyed inbox lane and role-flip cleanup

Removes two more name/magic-id couplings: the inbox lane's `serviceGroupId === 1 / === 2`, and the role-change cleanup's group-name set.

**Files:**
- Modify: `backend/sub_samples/service.py` (`_ROLE_GROUP_NAMES` → `_ROLE_DEPARTMENT_NAMES`, `_drop_stale_role_rows`)
- Modify: `backend/main.py` (`ROLE_TO_GROUP_NAMES` → `ROLE_TO_DEPARTMENT_NAME`, new `_inbox_allowed_group_ids`, `department_id` on the service-group schemas, emit `department_name` on worksheet items)
- Modify: `src/lib/inbox-filters.ts` (`itemBench`, `itemRoleBadges`)
- Modify: `src/components/hplc/WorksheetDropPanel.tsx` (pass `department_name`)
- Modify: `src/lib/api.ts` (add `Department` interface, `department_id` on `ServiceGroup`)
- Test: `backend/tests/test_drop_stale_role_rows.py`, `src/lib/__tests__/inbox-filters.test.ts`

**Interfaces:**
- Consumes: `models.Department` (Task 1).
- Produces:
  - `main.ROLE_TO_DEPARTMENT_NAME: dict[str, str]` = `{"hplc": "Analytical", "microbiology": "Microbiology"}`
  - `main.VALID_INBOX_ROLES` — unchanged value, now derived from the above
  - `main._inbox_allowed_group_ids(db, role: Optional[str]) -> Optional[set[int]]`
  - Worksheet item dicts gain `department_name: str | None`
  - `inbox-filters.itemBench(departmentName: string | null | undefined) -> 'hplc' | 'micro' | null` — **signature change**
  - `inbox-filters.itemRoleBadges({ department_name, analyses })` — **field change**

- [ ] **Step 1: Write the failing backend test**

Create `backend/tests/test_drop_stale_role_rows.py`:

```python
"""Role-flip cleanup sheds the OLD role's unassigned rows, keyed on Department."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_flipping_ster_to_hplc_drops_only_unresulted_micro_rows(db_session):
    from models import (AnalysisService, Department, LimsAnalysis,
                        LimsSample, LimsSubSample)
    from sub_samples.service import _drop_stale_role_rows

    analytical = Department(name="Analytical")
    micro = Department(name="Microbiology")
    db_session.add_all([analytical, micro])
    db_session.commit()

    ster_svc = AnalysisService(title="Sterility PCR", keyword="STER-PCR",
                               department_id=micro.id)
    endo_svc = AnalysisService(title="Endotoxin", keyword="ENDO-LAL",
                               department_id=micro.id)
    db_session.add_all([ster_svc, endo_svc])
    db_session.commit()

    parent = LimsSample(sample_id="P-0001")
    db_session.add(parent)
    db_session.commit()
    sub = LimsSubSample(sample_id="P-0001-S01", parent_sample_pk=parent.id)
    db_session.add(sub)
    db_session.commit()

    bare = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=ster_svc.id,
                        keyword="STER-PCR", title="Sterility PCR",
                        review_state="unassigned")
    resulted = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=endo_svc.id,
                            keyword="ENDO-LAL", title="Endotoxin",
                            review_state="unassigned", result_value="0.1")
    db_session.add_all([bare, resulted])
    db_session.commit()

    dropped = _drop_stale_role_rows(db_session, sub=sub, old_role="ster", new_role="hplc")

    assert dropped == 1
    remaining = {r.keyword for r in db_session.query(LimsAnalysis).all()}
    assert remaining == {"ENDO-LAL"}   # a row carrying a result is NEVER touched


def test_ster_to_endo_drops_nothing_same_department(db_session):
    from models import Department, LimsSample, LimsSubSample
    from sub_samples.service import _drop_stale_role_rows
    db_session.add_all([Department(name="Analytical"), Department(name="Microbiology")])
    db_session.commit()
    parent = LimsSample(sample_id="P-0002")
    db_session.add(parent)
    db_session.commit()
    sub = LimsSubSample(sample_id="P-0002-S01", parent_sample_pk=parent.id)
    db_session.add(sub)
    db_session.commit()

    assert _drop_stale_role_rows(db_session, sub=sub, old_role="ster", new_role="endo") == 0
```

> **Note for the implementer:** `LimsSample` / `LimsSubSample` have required columns beyond those shown. Read the models and add whatever the constructors need; the assertions are what matter.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_drop_stale_role_rows.py -v`
Expected: FAIL — the current implementation resolves services via `service_group_members` joined on group *name*, and these services have no group.

- [ ] **Step 3: Convert the role-flip cleanup**

In `backend/sub_samples/service.py`, replace the `_ROLE_GROUP_NAMES` constant:

```python
# Sub-sample assignment role -> the DEPARTMENT name(s) whose analyses belong to
# that role. endo/ster are both Microbiology; hplc is Analytical; xtra has none.
# Keyed on Department (the single structural routing key) so a new Microbiology
# group's services are cleared correctly without name-pinning the group.
_ROLE_DEPARTMENT_NAMES: dict[str, set[str]] = {
    "hplc": {"Analytical"},
    "endo": {"Microbiology"},
    "ster": {"Microbiology"},
    "xtra": set(),
}
```

Replace the body of `_drop_stale_role_rows` up to the `svc_ids` lookup:

```python
    if not old_role:
        return 0
    old_depts = _ROLE_DEPARTMENT_NAMES.get(old_role, set())
    new_depts = _ROLE_DEPARTMENT_NAMES.get(new_role or "", set())
    clear_depts = old_depts - new_depts
    if not clear_depts:
        return 0
    from models import AnalysisService, Department, LimsAnalysis, LimsAnalysisTransition
    dept_ids = db.execute(
        select(Department.id).where(Department.name.in_(clear_depts))
    ).scalars().all()
    if not dept_ids:
        return 0
    # candidate analysis_service ids whose HOME DEPARTMENT we're clearing
    svc_ids = db.execute(
        select(AnalysisService.id).where(AnalysisService.department_id.in_(dept_ids))
    ).scalars().all()
    if not svc_ids:
        return 0
```

Add `db.flush()` immediately before the existing `log.info(...)` in the `if n:` block, so the deletions are visible to the caller's subsequent queries in the same transaction.

- [ ] **Step 4: Run the backend test to verify it passes**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_drop_stale_role_rows.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Convert the inbox lane resolution**

In `backend/main.py`, replace `ROLE_TO_GROUP_NAMES` and its `VALID_INBOX_ROLES` line:

```python
# Role -> DEPARTMENT name. Department drives the lane: a new Microbiology-department
# group lands in the micro lane automatically, with no name-pinning.
ROLE_TO_DEPARTMENT_NAME: dict[str, str] = {
    "hplc": "Analytical",
    "microbiology": "Microbiology",
}
VALID_INBOX_ROLES = set(ROLE_TO_DEPARTMENT_NAME.keys())


def _inbox_allowed_group_ids(db, role: Optional[str]) -> Optional[set[int]]:
    """Resolve a worksheet-inbox role to the set of service-group ids in that
    role's DEPARTMENT. None role -> None (no filter; pass all groups)."""
    if role is None:
        return None
    from models import Department
    dept_name = ROLE_TO_DEPARTMENT_NAME[role]
    return {
        r[0] for r in db.execute(
            select(ServiceGroup.id)
            .join(Department, Department.id == ServiceGroup.department_id)
            .where(Department.name == dept_name)
        ).all()
    }
```

In `get_worksheets_inbox`, replace the inline group-name resolution block with:

```python
    allowed_group_ids: Optional[set[int]] = _inbox_allowed_group_ids(db, role)
```

- [ ] **Step 6: Expose `department_id` on the service-group API, and emit `department_name` on worksheet items**

The frontend `ServiceGroup` interface gains `department_id` in Step 9, so the backend must return it
or the type lies. Add `department_id: Optional[int] = None` to **all three** service-group schemas —
`ServiceGroupCreate`, `ServiceGroupUpdate`, and `ServiceGroupResponse` — and add
`department_id=group.department_id` to each of the four places a `ServiceGroupResponse` is
constructed (the list, create, update, and members endpoints). Miss one and a group's department
silently reads back as `null` after an edit.

Then, for the worksheet items:

In `backend/main.py::list_worksheets`, extend the group lookup to carry the department name. Replace the `if group_ids:` query block with:

```python
        group_department_name_map: dict[int, str | None] = {}
        if group_ids:
            from models import Department
            groups = db.execute(
                select(ServiceGroup.id, ServiceGroup.name, ServiceGroup.color, Department.name)
                .outerjoin(Department, Department.id == ServiceGroup.department_id)
                .where(ServiceGroup.id.in_(group_ids))
            ).all()
            group_name_map = {g[0]: g[1] for g in groups}
            group_color_map: dict[int, str] = {g[0]: g[2] for g in groups}
            group_department_name_map = {g[0]: g[3] for g in groups}
```

and add to the per-item dict, next to `"service_group_id"`:

```python
                    "department_name": group_department_name_map.get(it.service_group_id) if it.service_group_id else None,
```

- [ ] **Step 7: Write the failing frontend test**

Replace the body of `src/lib/__tests__/inbox-filters.test.ts` tests that exercise `itemBench` / `itemRoleBadges` so they pass a department name:

```typescript
import { describe, it, expect } from 'vitest'
import { itemBench, itemRoleBadges } from '../inbox-filters'

describe('itemBench', () => {
  it('maps department names to lanes', () => {
    expect(itemBench('Analytical')).toBe('hplc')
    expect(itemBench('Microbiology')).toBe('micro')
  })

  it('returns null for unknown, null, or undefined departments', () => {
    expect(itemBench('Nope')).toBeNull()
    expect(itemBench(null)).toBeNull()
    expect(itemBench(undefined)).toBeNull()
  })
})

describe('itemRoleBadges', () => {
  it('an Analytical item is hplc regardless of analyses', () => {
    expect(itemRoleBadges({ department_name: 'Analytical', analyses: [] })).toEqual(['hplc'])
  })

  it('splits micro into endo/ster by analysis', () => {
    const badges = itemRoleBadges({
      department_name: 'Microbiology',
      analyses: [
        { keyword: 'ENDO-LAL', title: 'Endotoxin' },
        { keyword: 'STER-PCR', title: 'Rapid Sterility Screening (PCR)' },
      ],
    })
    expect(badges).toEqual(['endo', 'ster'])
  })
})
```

> **Note for the implementer:** keep every other existing test in this file. `AnalysisLike` may require more fields than `keyword`/`title` — read the interface and fill them in.

- [ ] **Step 8: Run the frontend test to verify it fails**

Run: `npm run test -- src/lib/__tests__/inbox-filters.test.ts`
Expected: FAIL — `itemBench` still takes a number.

- [ ] **Step 9: Convert the frontend**

In `src/lib/inbox-filters.ts`:

```typescript
/** Bench lane of a worksheet item, from its service DEPARTMENT (the single
 *  structural routing key from the catalog). Robust to new groups within a
 *  department — a new Microbiology group still lands in 'micro'. Replaces the
 *  old hardcoded service_group_id === 1/2. */
export function itemBench(departmentName: string | null | undefined): 'hplc' | 'micro' | null {
  if (departmentName === 'Analytical') return 'hplc'
  if (departmentName === 'Microbiology') return 'micro'
  return null
}
```

and change `itemRoleBadges` to accept `department_name` and call `itemBench(item.department_name)`:

```typescript
export function itemRoleBadges(item: {
  department_name: string | null | undefined
  analyses?: AnalysisLike[]
}): InboxRoleTag[] {
  const bench = itemBench(item.department_name)
  // ... rest of the existing body unchanged
}
```

In `src/components/hplc/WorksheetDropPanel.tsx`, add to `WorksheetSummaryItem`:

```typescript
  department_name?: string | null
```

and update the call site:

```typescript
  const roles = itemRoleBadges({ department_name: item.department_name, analyses: item.analyses })
```

In `src/lib/api.ts`, add above the `ServiceGroup` interface:

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

and add to `interface ServiceGroup`:

```typescript
  department_id: number | null
```

- [ ] **Step 10: Run frontend tests and typecheck**

Run: `npm run test -- src/lib/__tests__/inbox-filters.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: no errors. **tsc is the gate** — `npm run check:all` is red on master for pre-existing lint reasons.

- [ ] **Step 11: Verify the backend suite is additive**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | tail -20`
Expected: failure set identical to the Task 1 baseline.

- [ ] **Step 12: Commit**

```bash
git add backend/sub_samples/service.py backend/main.py backend/tests/test_drop_stale_role_rows.py src/lib/inbox-filters.ts src/lib/__tests__/inbox-filters.test.ts src/components/hplc/WorksheetDropPanel.tsx src/lib/api.ts
git commit -m "feat(catalog): Department-keyed inbox lane + role-flip cleanup"
```

---

### Task 4: Service origin, local overrides, and a non-destructive sync

Marks every service as SENAITE-born or Mk1-born, and makes `POST /analysis-services/sync` incapable of touching Mk1-owned data.

**There is a live hazard here.** The sync's orphan-adoption branch matches on `keyword` alone (a row whose `senaite_id` is absent from the current pull). Without a guard, a Mk1-native service whose keyword SENAITE later creates would be **adopted** — its title and `senaite_id` overwritten, converting it into a SENAITE row.

**Files:**
- Modify: `backend/models.py` (`origin`, `local_overrides` on `AnalysisService`)
- Modify: `backend/database.py` (migrations)
- Modify: `backend/main.py` (`sync_analysis_services`, `_apply_service_result_type`, `AnalysisServiceResponse`)
- Test: `backend/tests/test_service_origin_sync.py`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `AnalysisService.origin: str` — `'senaite'` | `'mk1'`, NOT NULL, server default `'senaite'`
  - `AnalysisService.local_overrides: Optional[list]` — JSON list of field names Mk1 owns
  - `AnalysisServiceResponse` gains `origin: str` and `local_overrides: Optional[list]`
  - `main.SYNC_OWNED_FIELDS: frozenset[str]` = `{"title", "keyword", "category", "unit", "methods"}`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_service_origin_sync.py`:

```python
"""origin + local_overrides: sync can never touch Mk1-owned data."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_origin_defaults_to_senaite(db_session):
    from models import AnalysisService
    s = AnalysisService(title="Purity X", keyword="PUR_X")
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)
    assert s.origin == "senaite"
    assert s.local_overrides is None


def test_mk1_origin_row_is_invisible_to_orphan_adoption(db_session):
    """The adoption branch matches on keyword alone. A native row must never be
    a candidate, or SENAITE would silently take ownership of it."""
    from main import _find_adoptable_orphan
    from models import AnalysisService
    native = AnalysisService(title="Lead (Pb)", keyword="HM-PB", origin="mk1")
    db_session.add(native)
    db_session.commit()

    assert _find_adoptable_orphan(db_session, keyword="HM-PB",
                                  current_ids={"AS-999"}) is None


def test_senaite_orphan_is_still_adoptable(db_session):
    from main import _find_adoptable_orphan
    from models import AnalysisService
    orphan = AnalysisService(title="Purity X", keyword="PUR_X",
                             origin="senaite", senaite_id="AS-001")
    db_session.add(orphan)
    db_session.commit()

    found = _find_adoptable_orphan(db_session, keyword="PUR_X",
                                   current_ids={"AS-002"})
    assert found is not None and found.id == orphan.id


def test_sync_skips_fields_named_in_local_overrides(db_session):
    from main import _apply_sync_fields
    from models import AnalysisService
    svc = AnalysisService(title="Old Title", keyword="PUR_X", unit="mg",
                          origin="senaite", local_overrides=["unit"])
    db_session.add(svc)
    db_session.commit()

    _apply_sync_fields(svc, {"title": "New Title", "unit": "ug"})

    assert svc.title == "New Title"   # not overridden -> sync wins
    assert svc.unit == "mg"           # overridden -> Mk1 wins


def test_sync_never_touches_an_mk1_row(db_session):
    from main import _apply_sync_fields
    from models import AnalysisService
    svc = AnalysisService(title="Lead (Pb)", keyword="HM-PB", origin="mk1")
    db_session.add(svc)
    db_session.commit()

    _apply_sync_fields(svc, {"title": "Clobbered"})

    assert svc.title == "Lead (Pb)"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_service_origin_sync.py -v`
Expected: FAIL — `AnalysisService` has no `origin`; `_find_adoptable_orphan` and `_apply_sync_fields` do not exist.

- [ ] **Step 3: Add the columns**

In `backend/models.py`, add to `class AnalysisService` after `department_id`:

```python
    # 'senaite' = born in SENAITE and synced in; 'mk1' = created in Accu-Mk1 and
    # never written to or overwritten by SENAITE.
    origin: Mapped[str] = mapped_column(
        String(20), nullable=False, default="senaite", server_default="senaite"
    )
    # Field names Mk1 owns for THIS row; the SENAITE sync skips them. Generalizes
    # the pre-existing local-wins rule for result_type.
    local_overrides: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
```

In `backend/database.py::_run_migrations()`:

```python
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'senaite'",
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS local_overrides JSON",
```

- [ ] **Step 4: Extract the two sync helpers**

In `backend/main.py`, add above `sync_analysis_services`:

```python
# Fields the SENAITE sync owns on a 'senaite'-origin service. Any of these named
# in a row's local_overrides is Mk1-owned from then on and the sync skips it.
SYNC_OWNED_FIELDS = frozenset({"title", "keyword", "category", "unit", "methods"})


def _find_adoptable_orphan(db, *, keyword: str, current_ids: set):
    """A SENAITE-origin row whose senaite_id is absent from this pull — SENAITE
    deleted and recreated the service under a new id. Adopting preserves its
    lims_analyses references.

    Mk1-origin rows are NEVER candidates: adoption would hand SENAITE ownership
    of a service Accu-Mk1 created.
    """
    if not keyword or not current_ids:
        return None
    return db.execute(
        select(AnalysisService)
        .where(
            AnalysisService.keyword == keyword,
            AnalysisService.origin == "senaite",
            AnalysisService.senaite_id.isnot(None),
            AnalysisService.senaite_id.not_in(current_ids),
        )
        .order_by(AnalysisService.id)
    ).scalars().first()


def _apply_sync_fields(svc, values: dict) -> None:
    """Apply SENAITE-sourced field values, honoring ownership.

    Mk1-origin rows are skipped entirely. On SENAITE-origin rows, any field
    listed in local_overrides is skipped. A None/empty incoming value never
    clears an existing one.
    """
    if svc.origin == "mk1":
        return
    overrides = set(svc.local_overrides or [])
    for field, value in values.items():
        if field not in SYNC_OWNED_FIELDS or field in overrides:
            continue
        if value in (None, "", []):
            continue
        setattr(svc, field, value)
```

- [ ] **Step 5: Use the helpers in the sync**

In `sync_analysis_services`, replace the inline orphan query with:

```python
        kw = item.get("getKeyword") or item.get("Keyword")
        orphan = _find_adoptable_orphan(db, keyword=kw, current_ids=current_ids)
```

Replace the orphan mutation block's field assignments with:

```python
        if orphan is not None:
            orphan.senaite_id = senaite_id
            orphan.senaite_uid = item.get("uid")
            _apply_sync_fields(orphan, {
                "title": title, "category": category, "methods": methods_list,
            })
            _apply_service_result_type(orphan, item)
            updated += 1
            continue
```

In the `if existing:` branch, replace the category back-fill with:

```python
        if existing:
            _apply_sync_fields(existing, {"category": category})
            _apply_service_result_type(existing, item)
            continue
```

Newly created rows keep `origin` at its `"senaite"` default — no change needed.

- [ ] **Step 6: Expose the fields on the response schema**

In `backend/main.py::AnalysisServiceResponse`, add after `variance_capable`:

```python
    origin: str = "senaite"
    local_overrides: Optional[list] = None
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_service_origin_sync.py -v`
Expected: PASS (5 tests)

- [ ] **Step 8: Verify the suite is additive**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | tail -20`
Expected: failure set identical to the Task 1 baseline.

- [ ] **Step 9: Commit**

```bash
git add backend/models.py backend/database.py backend/main.py backend/tests/test_service_origin_sync.py
git commit -m "feat(catalog): service origin + local_overrides; sync never touches Mk1-owned data"
```

---

### Task 5: Analysis Service CRUD and keyword rules

Adds create, delete, and full-field edit. Keyword becomes a real key: validated, unique among Mk1-origin rows, never colliding with a SENAITE keyword, and immutable once used.

**Files:**
- Modify: `backend/database.py` (partial unique index)
- Modify: `backend/main.py` (routes + schemas + validation helpers)
- Test: `backend/tests/test_analysis_service_crud.py`

**Interfaces:**
- Consumes: `AnalysisService.origin` / `local_overrides` (Task 4).
- Produces:
  - `POST /analysis-services` → 201 `AnalysisServiceResponse`
  - `PATCH /analysis-services/{service_id}` → 200 `AnalysisServiceResponse`
  - `DELETE /analysis-services/{service_id}` → 204
  - `main.KEYWORD_RE: re.Pattern` — `^[A-Z][A-Z0-9_-]*$`
  - `main.validate_new_keyword(db, keyword: str, *, exclude_id: int | None = None) -> None` — raises `HTTPException(400)`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_analysis_service_crud.py`:

```python
"""Mk1-native Analysis Service CRUD + keyword rules."""
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.mark.parametrize("kw", ["HM-PB", "KF", "MOISTURE_1"])
def test_valid_keywords_accepted(db_session, kw):
    from main import validate_new_keyword
    validate_new_keyword(db_session, kw)   # must not raise


@pytest.mark.parametrize("kw", ["", "hm-pb", "1HM", "HM PB", "HM.PB"])
def test_invalid_keyword_shapes_rejected(db_session, kw):
    from main import validate_new_keyword
    with pytest.raises(HTTPException) as e:
        validate_new_keyword(db_session, kw)
    assert e.value.status_code == 400


def test_duplicate_mk1_keyword_rejected(db_session):
    from main import validate_new_keyword
    from models import AnalysisService
    db_session.add(AnalysisService(title="Lead", keyword="HM-PB", origin="mk1"))
    db_session.commit()
    with pytest.raises(HTTPException) as e:
        validate_new_keyword(db_session, "HM-PB")
    assert e.value.status_code == 400


def test_collision_with_a_senaite_keyword_rejected(db_session):
    """Cross-origin collision. If a native service could claim ENDO-LAL,
    COABuilder would receive it from the SENAITE add-on block AND from a native
    section, and print it twice."""
    from main import validate_new_keyword
    from models import AnalysisService
    db_session.add(AnalysisService(title="Endotoxin", keyword="ENDO-LAL",
                                   origin="senaite", active=False))
    db_session.commit()
    with pytest.raises(HTTPException) as e:
        validate_new_keyword(db_session, "ENDO-LAL")
    assert e.value.status_code == 400


def test_keyword_is_immutable_once_referenced(db_session):
    from main import assert_keyword_editable
    from models import AnalysisService, LimsAnalysis, LimsSample
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1")
    parent = LimsSample(sample_id="P-0001")
    db_session.add_all([svc, parent])
    db_session.commit()
    db_session.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                                keyword="HM-PB", title="Lead",
                                review_state="unassigned"))
    db_session.commit()

    with pytest.raises(HTTPException) as e:
        assert_keyword_editable(db_session, svc)
    assert e.value.status_code == 409


def test_unreferenced_keyword_is_editable(db_session):
    from main import assert_keyword_editable
    from models import AnalysisService
    svc = AnalysisService(title="Lead", keyword="HM-PB", origin="mk1")
    db_session.add(svc)
    db_session.commit()
    assert_keyword_editable(db_session, svc)   # must not raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_analysis_service_crud.py -v`
Expected: FAIL — `validate_new_keyword` and `assert_keyword_editable` do not exist.

- [ ] **Step 3: Add the validation helpers**

In `backend/main.py`, add near the other analysis-service helpers:

```python
KEYWORD_RE = re.compile(r"^[A-Z][A-Z0-9_-]*$")


def validate_new_keyword(db, keyword: str, *, exclude_id: int | None = None) -> None:
    """Validate a keyword for an Mk1-native service.

    Keyword is the cross-repo join key — COABuilder indexes every result by it
    and the baked spec limits are keyed on it. It must be well-formed and unique
    across BOTH origins: a native service claiming a SENAITE keyword would be
    rendered twice on a certificate.
    """
    if not keyword or not KEYWORD_RE.match(keyword):
        raise HTTPException(
            400,
            "keyword must start with a letter and contain only A-Z, 0-9, '-' and '_' "
            "(uppercase)",
        )
    q = select(AnalysisService).where(AnalysisService.keyword == keyword)
    if exclude_id is not None:
        q = q.where(AnalysisService.id != exclude_id)
    if db.execute(q).scalars().first() is not None:
        raise HTTPException(400, f"keyword '{keyword}' is already in use")


def assert_keyword_editable(db, svc) -> None:
    """A keyword becomes immutable once any lims_analyses row references the
    service — renaming it would orphan results from their spec limits."""
    from models import LimsAnalysis
    referenced = db.execute(
        select(LimsAnalysis.id).where(LimsAnalysis.analysis_service_id == svc.id).limit(1)
    ).scalars().first()
    if referenced is not None:
        raise HTTPException(
            409,
            f"keyword '{svc.keyword}' is referenced by existing analyses and cannot "
            "be changed",
        )
```

Ensure `import re` is present at the top of `main.py` (it may already be).

- [ ] **Step 4: Add the schemas and routes**

In `backend/main.py`, add near `AnalysisServiceResponse`:

```python
class AnalysisServiceCreate(BaseModel):
    title: str
    keyword: str
    category: Optional[str] = None
    unit: Optional[str] = None
    department_id: Optional[int] = None
    result_type: Optional[str] = None
    result_options: Optional[list] = None
    variance_capable: bool = False
    peptide_id: Optional[int] = None


class AnalysisServiceUpdate(BaseModel):
    title: Optional[str] = None
    keyword: Optional[str] = None
    category: Optional[str] = None
    unit: Optional[str] = None
    department_id: Optional[int] = None
    result_type: Optional[str] = None
    result_options: Optional[list] = None
    variance_capable: Optional[bool] = None
    peptide_id: Optional[int] = None
    active: Optional[bool] = None
```

Add the routes after the existing `GET /analysis-services`:

```python
@app.post("/analysis-services", response_model=AnalysisServiceResponse, status_code=201)
async def create_analysis_service(
    data: AnalysisServiceCreate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Create an Mk1-native analysis service. NEVER creates anything in SENAITE."""
    validate_new_keyword(db, data.keyword)
    svc = AnalysisService(**data.model_dump(), origin="mk1")
    db.add(svc)
    db.commit()
    db.refresh(svc)
    return AnalysisServiceResponse.model_validate(svc)


@app.patch("/analysis-services/{service_id}", response_model=AnalysisServiceResponse)
async def update_analysis_service(
    service_id: int,
    data: AnalysisServiceUpdate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Full-field edit. On a SENAITE-origin row, every sync-owned field touched
    here is recorded in local_overrides so the next sync leaves it alone."""
    svc = db.get(AnalysisService, service_id)
    if svc is None:
        raise HTTPException(404, "analysis service not found")

    fields = data.model_dump(exclude_unset=True)

    if "keyword" in fields and fields["keyword"] != svc.keyword:
        assert_keyword_editable(db, svc)
        validate_new_keyword(db, fields["keyword"], exclude_id=svc.id)

    overrides = set(svc.local_overrides or [])
    for field, value in fields.items():
        setattr(svc, field, value)
        if svc.origin == "senaite" and field in SYNC_OWNED_FIELDS:
            overrides.add(field)
    if svc.origin == "senaite":
        svc.local_overrides = sorted(overrides)

    db.commit()
    db.refresh(svc)
    return AnalysisServiceResponse.model_validate(svc)


@app.delete("/analysis-services/{service_id}", status_code=204)
async def delete_analysis_service(
    service_id: int,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Delete an Mk1-native service. Refused if any analysis references it —
    deactivate instead. SENAITE-origin rows are never deletable here."""
    from models import LimsAnalysis
    svc = db.get(AnalysisService, service_id)
    if svc is None:
        raise HTTPException(404, "analysis service not found")
    if svc.origin != "mk1":
        raise HTTPException(400, "only Mk1-native services can be deleted; deactivate instead")
    referenced = db.execute(
        select(LimsAnalysis.id).where(LimsAnalysis.analysis_service_id == svc.id).limit(1)
    ).scalars().first()
    if referenced is not None:
        raise HTTPException(409, "service is referenced by existing analyses; deactivate instead")
    db.delete(svc)
    db.commit()
```

- [ ] **Step 5: Add the partial unique index**

In `backend/database.py::_run_migrations()`:

```python
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_services_mk1_keyword ON analysis_services (keyword) WHERE origin = 'mk1'",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_analysis_service_crud.py -v`
Expected: PASS (11 tests, counting the parametrized cases)

- [ ] **Step 7: Verify the suite is additive**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | tail -20`
Expected: failure set identical to the Task 1 baseline.

- [ ] **Step 8: Commit**

```bash
git add backend/main.py backend/database.py backend/tests/test_analysis_service_crud.py
git commit -m "feat(catalog): Mk1-native analysis service CRUD + keyword rules"
```

---

### Task 6: Analysis Profile model and CRUD

The sellable test: parent of one or more Analysis Services, and the future carrier of COA section identity.

**Files:**
- Modify: `backend/models.py` (`AnalysisProfile`, `analysis_profile_members`)
- Modify: `backend/database.py` (migrations)
- Modify: `backend/main.py` (schemas + routes)
- Test: `backend/tests/test_analysis_profiles.py`

**Interfaces:**
- Consumes: `AnalysisService` (Task 5).
- Produces:
  - `models.AnalysisProfile` — `id`, `key`, `name`, `description`, `is_addon`, `vials_required`, `fulfillment_role`, `fulfillment_dim`, `sort_order`, `active`, `updated_by_id`, `created_at`, `updated_at`
  - `models.analysis_profile_members` — `analysis_profile_id`, `analysis_service_id`, `sort_order`
  - `AnalysisProfile.analysis_services` relationship
  - `GET/POST /analysis-profiles`, `PATCH/DELETE /analysis-profiles/{id}`, `GET/PUT /analysis-profiles/{id}/members`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_analysis_profiles.py`:

```python
"""Analysis Profile: the sellable test. Many-to-many over services."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_profile_persists_with_defaults(db_session):
    from models import AnalysisProfile
    p = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True)
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    assert p.id is not None
    assert p.vials_required == 0
    assert p.fulfillment_dim == "role"
    assert p.active is True


def test_profile_key_is_unique(db_session):
    from models import AnalysisProfile
    db_session.add(AnalysisProfile(key="heavy_metals", name="A", is_addon=True))
    db_session.commit()
    db_session.add(AnalysisProfile(key="heavy_metals", name="B", is_addon=True))
    with pytest.raises(Exception):
        db_session.commit()
    db_session.rollback()


def test_a_service_can_belong_to_several_profiles(db_session):
    """pH is sold a la carte AND is a member of a panel."""
    from models import AnalysisProfile, AnalysisService, analysis_profile_members
    ph = AnalysisService(title="pH", keyword="PH-DETERM", origin="mk1")
    db_session.add(ph)
    db_session.commit()
    solo = AnalysisProfile(key="ph_testing", name="pH Testing", is_addon=True)
    panel = AnalysisProfile(key="bac_water_panel", name="Bac Water", is_addon=False)
    db_session.add_all([solo, panel])
    db_session.commit()
    for pid in (solo.id, panel.id):
        db_session.execute(analysis_profile_members.insert().values(
            analysis_profile_id=pid, analysis_service_id=ph.id, sort_order=0))
    db_session.commit()

    db_session.refresh(solo); db_session.refresh(panel)
    assert [s.keyword for s in solo.analysis_services] == ["PH-DETERM"]
    assert [s.keyword for s in panel.analysis_services] == ["PH-DETERM"]


def test_membership_is_unique_per_pair(db_session):
    from models import AnalysisProfile, AnalysisService, analysis_profile_members
    svc = AnalysisService(title="pH", keyword="PH-DETERM", origin="mk1")
    prof = AnalysisProfile(key="ph_testing", name="pH Testing", is_addon=True)
    db_session.add_all([svc, prof])
    db_session.commit()
    ins = analysis_profile_members.insert().values(
        analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=0)
    db_session.execute(ins)
    db_session.commit()
    db_session.execute(ins)
    with pytest.raises(Exception):
        db_session.commit()
    db_session.rollback()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_analysis_profiles.py -v`
Expected: FAIL — `cannot import name 'AnalysisProfile' from 'models'`

- [ ] **Step 3: Add the model and junction**

In `backend/models.py`, after the `Department` class:

```python
analysis_profile_members = Table(
    "analysis_profile_members",
    Base.metadata,
    Column("analysis_profile_id", Integer,
           ForeignKey("analysis_profiles.id", ondelete="CASCADE"), nullable=False),
    Column("analysis_service_id", Integer,
           ForeignKey("analysis_services.id", ondelete="CASCADE"), nullable=False),
    Column("sort_order", Integer, nullable=False, default=0),
    UniqueConstraint("analysis_profile_id", "analysis_service_id",
                     name="uq_analysis_profile_member"),
)


class AnalysisProfile(Base):
    """A sellable test — the parent of one or more Analysis Services.

    This is the unit of SALE and of REPORTING (COA section), distinct from a
    ServiceGroup, which is the unit of BENCH WORK. A profile may span
    departments (a Bacteriostatic Water panel spans Analytical and
    Microbiology); a service group may not. There is deliberately NO
    department_id here — each member service declares its own.
    """
    __tablename__ = "analysis_profiles"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # The order key WordPress sends. Immutable once an order references it.
    key: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # No default on purpose: two seeded profiles are primaries, and a default
    # would silently demote a mis-seeded primary to an add-on.
    is_addon: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # Base dedicated aliquots. 0 = rides an existing vial. Variance composes on
    # top of this — never fold variance into the base.
    vials_required: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    fulfillment_role: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    fulfillment_dim: Mapped[str] = mapped_column(
        String(20), nullable=False, default="role", server_default="role"
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    updated_by_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    analysis_services: Mapped[list["AnalysisService"]] = relationship(
        "AnalysisService", secondary=analysis_profile_members, lazy="selectin"
    )

    def __repr__(self) -> str:
        return f"<AnalysisProfile(id={self.id}, key='{self.key}')>"
```

Ensure `Table`, `Column`, `UniqueConstraint`, and `Text` are imported at the top of `models.py` (most already are — check before adding).

- [ ] **Step 4: Add the migrations**

In `backend/database.py::_run_migrations()`:

```python
        """
        CREATE TABLE IF NOT EXISTS analysis_profiles (
            id SERIAL PRIMARY KEY,
            key VARCHAR(100) NOT NULL UNIQUE,
            name VARCHAR(200) NOT NULL,
            description TEXT,
            is_addon BOOLEAN NOT NULL,
            vials_required INTEGER NOT NULL DEFAULT 0,
            fulfillment_role VARCHAR(50),
            fulfillment_dim VARCHAR(20) NOT NULL DEFAULT 'role',
            sort_order INTEGER NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS analysis_profile_members (
            analysis_profile_id INTEGER NOT NULL REFERENCES analysis_profiles(id) ON DELETE CASCADE,
            analysis_service_id INTEGER NOT NULL REFERENCES analysis_services(id) ON DELETE CASCADE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            CONSTRAINT uq_analysis_profile_member UNIQUE (analysis_profile_id, analysis_service_id)
        )
        """,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_analysis_profiles.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Add the CRUD routes**

In `backend/main.py`, add schemas near the service-group schemas:

```python
class AnalysisProfileCreate(BaseModel):
    key: str
    name: str
    description: Optional[str] = None
    is_addon: bool
    vials_required: int = 0
    fulfillment_role: Optional[str] = None
    fulfillment_dim: str = "role"
    sort_order: int = 0
    active: bool = True


class AnalysisProfileUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_addon: Optional[bool] = None
    vials_required: Optional[int] = None
    fulfillment_role: Optional[str] = None
    fulfillment_dim: Optional[str] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None


class AnalysisProfileResponse(BaseModel):
    id: int
    key: str
    name: str
    description: Optional[str] = None
    is_addon: bool
    vials_required: int
    fulfillment_role: Optional[str] = None
    fulfillment_dim: str
    sort_order: int
    active: bool
    member_ids: list[int] = []
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AnalysisProfileMembersRequest(BaseModel):
    analysis_service_ids: list[int]
```

Add the routes after the departments routes:

```python
def _profile_to_response(p) -> AnalysisProfileResponse:
    return AnalysisProfileResponse(
        id=p.id, key=p.key, name=p.name, description=p.description,
        is_addon=p.is_addon, vials_required=p.vials_required,
        fulfillment_role=p.fulfillment_role, fulfillment_dim=p.fulfillment_dim,
        sort_order=p.sort_order, active=p.active,
        member_ids=[s.id for s in p.analysis_services],
        created_at=p.created_at, updated_at=p.updated_at,
    )


@app.get("/analysis-profiles", response_model=list[AnalysisProfileResponse])
async def get_analysis_profiles(db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    from models import AnalysisProfile
    rows = db.execute(
        select(AnalysisProfile).order_by(AnalysisProfile.sort_order, AnalysisProfile.name)
    ).scalars().all()
    return [_profile_to_response(p) for p in rows]


@app.post("/analysis-profiles", response_model=AnalysisProfileResponse, status_code=201)
async def create_analysis_profile(
    data: AnalysisProfileCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    from models import AnalysisProfile
    existing = db.execute(
        select(AnalysisProfile).where(AnalysisProfile.key == data.key)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(400, f"profile key '{data.key}' already exists")
    p = AnalysisProfile(**data.model_dump(), updated_by_id=getattr(current_user, "id", None))
    db.add(p)
    db.commit()
    db.refresh(p)
    return _profile_to_response(p)


@app.patch("/analysis-profiles/{profile_id}", response_model=AnalysisProfileResponse)
async def update_analysis_profile(
    profile_id: int,
    data: AnalysisProfileUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    from models import AnalysisProfile
    p = db.get(AnalysisProfile, profile_id)
    if p is None:
        raise HTTPException(404, "analysis profile not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(p, field, value)
    p.updated_by_id = getattr(current_user, "id", None)
    db.commit()
    db.refresh(p)
    return _profile_to_response(p)


@app.delete("/analysis-profiles/{profile_id}", status_code=204)
async def delete_analysis_profile(
    profile_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)
):
    from models import AnalysisProfile
    p = db.get(AnalysisProfile, profile_id)
    if p is None:
        raise HTTPException(404, "analysis profile not found")
    db.delete(p)
    db.commit()


@app.put("/analysis-profiles/{profile_id}/members")
async def set_analysis_profile_members(
    profile_id: int,
    data: AnalysisProfileMembersRequest,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Replace membership. Position in the list becomes sort_order — the row
    order within the profile's COA section."""
    from models import AnalysisProfile, analysis_profile_members
    p = db.get(AnalysisProfile, profile_id)
    if p is None:
        raise HTTPException(404, "analysis profile not found")
    db.execute(
        analysis_profile_members.delete().where(
            analysis_profile_members.c.analysis_profile_id == profile_id
        )
    )
    for i, svc_id in enumerate(data.analysis_service_ids):
        db.execute(analysis_profile_members.insert().values(
            analysis_profile_id=profile_id, analysis_service_id=svc_id, sort_order=i))
    db.commit()
    return {"count": len(data.analysis_service_ids)}
```

- [ ] **Step 7: Verify the suite is additive**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | tail -20`
Expected: failure set identical to the Task 1 baseline.

- [ ] **Step 8: Commit**

```bash
git add backend/models.py backend/database.py backend/main.py backend/tests/test_analysis_profiles.py
git commit -m "feat(catalog): AnalysisProfile model + membership + CRUD"
```

---

### Task 7: Seed profiles from PRODUCT_REGISTRY, parity-gated

The only live behavior change in this plan. `build_ordered_products` gains an optional DB session; with one it reads profiles, without one it behaves exactly as today. That makes parity trivially provable — the test calls it both ways on the same input.

**Files:**
- Modify: `backend/sub_samples/product_registry.py` (DB-backed lookup, unchanged logic)
- Modify: `backend/sub_samples/routes.py` (`get_ordered_products` passes a session)
- Create: `backend/catalog/profile_seed.py`
- Modify: `backend/database.py` (call the seed in `init_db`)
- Test: `backend/tests/test_profile_parity.py`

**Interfaces:**
- Consumes: `models.AnalysisProfile` (Task 6), `product_registry.ProductDef`, `product_registry.PRODUCT_REGISTRY`.
- Produces:
  - `product_registry.build_ordered_products(services: dict, package: str | None, db=None) -> list[dict]` — **third parameter added, defaulted**
  - `product_registry.lookup_product_def(key: str, db=None) -> ProductDef | None`
  - `catalog.profile_seed.seed_profiles_from_registry(db) -> None`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_profile_parity.py`:

```python
"""The profiles-backed product lookup must reproduce PRODUCT_REGISTRY exactly,
including its deliberate fail-open behavior for unregistered keys."""
import itertools

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def seeded(db_session):
    from catalog.profile_seed import seed_profiles_from_registry
    seed_profiles_from_registry(db_session)
    return db_session


SERVICE_KEYS = ["hplcpurity_identity", "bac_water_panel", "endotoxin",
                "sterility_pcr", "samplevariance"]
PACKAGES = [None, "core", "accushield"]


def test_seed_creates_one_profile_per_registry_entry(seeded):
    from models import AnalysisProfile
    from sub_samples.product_registry import PRODUCT_REGISTRY
    keys = {p.key for p in seeded.query(AnalysisProfile).all()}
    assert keys == set(PRODUCT_REGISTRY.keys())


def test_seed_is_idempotent(seeded):
    from catalog.profile_seed import seed_profiles_from_registry
    from models import AnalysisProfile
    before = seeded.query(AnalysisProfile).count()
    seed_profiles_from_registry(seeded)
    assert seeded.query(AnalysisProfile).count() == before


def test_seed_preserves_is_addon_for_primaries(seeded):
    from models import AnalysisProfile
    for key in ("hplcpurity_identity", "bac_water_panel"):
        p = seeded.query(AnalysisProfile).filter_by(key=key).one()
        assert p.is_addon is False


@pytest.mark.parametrize("package", PACKAGES)
def test_parity_across_every_service_combination(seeded, package):
    """Legacy path vs profiles path must be byte-identical."""
    from sub_samples.product_registry import build_ordered_products
    for r in range(len(SERVICE_KEYS) + 1):
        for combo in itertools.combinations(SERVICE_KEYS, r):
            services = {k: True for k in combo}
            legacy = build_ordered_products(services, package)
            catalog = build_ordered_products(services, package, db=seeded)
            assert catalog == legacy, f"drift for {combo} / package={package}"


def test_unregistered_service_key_still_renders_fail_open(seeded):
    """An unknown key must be SYNTHESISED, not dropped and not raised. This
    feeds the sample page's PRODUCTS section; a miss must never 500."""
    from sub_samples.product_registry import build_ordered_products
    out = build_ordered_products({"brand_new_thing": True}, None, db=seeded)
    keys = [p["key"] for p in out]
    assert "brand_new_thing" in keys


def test_unregistered_package_still_renders_fail_open(seeded):
    from sub_samples.product_registry import build_ordered_products
    out = build_ordered_products({}, "mystery_bundle", db=seeded)
    keys = [p["key"] for p in out]
    assert "mystery_bundle" in keys
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_profile_parity.py -v`
Expected: FAIL — `catalog.profile_seed` does not exist and `build_ordered_products` takes no `db`.

- [ ] **Step 3: Write the seed**

Create `backend/catalog/profile_seed.py`:

```python
"""Seed analysis_profiles from the hardcoded PRODUCT_REGISTRY.

The registry in sub_samples/product_registry.py IS the profile concept, written
in Python instead of rows — its own docstring says "Adding a product = add one
ProductDef". This promotes it to data with no behavior change, proven by
test_profile_parity.py.

Idempotent: only inserts profiles whose key is absent, so a later admin edit
survives a restart.
"""
import logging

from sqlalchemy.orm import Session

log = logging.getLogger(__name__)


def seed_profiles_from_registry(db: Session) -> None:
    from models import AnalysisProfile
    from sub_samples.product_registry import PRODUCT_REGISTRY

    existing = {k for (k,) in db.query(AnalysisProfile.key).all()}
    created = 0
    for i, (key, pdef) in enumerate(PRODUCT_REGISTRY.items()):
        if key in existing:
            continue
        db.add(AnalysisProfile(
            key=pdef.key,
            name=pdef.label,
            is_addon=pdef.is_addon,
            vials_required=0,          # wired to real demand in spec 3
            fulfillment_role=pdef.fulfillment_role,
            fulfillment_dim=pdef.fulfillment_dim,
            sort_order=i,
        ))
        created += 1
    db.commit()
    if created:
        log.info("catalog.profile_seed created=%s", created)
```

- [ ] **Step 4: Add the DB-backed lookup**

In `backend/sub_samples/product_registry.py`, add after `PRODUCT_REGISTRY`:

```python
def lookup_product_def(key: str, db=None) -> ProductDef | None:
    """Resolve a service key to its ProductDef.

    With a session, the analysis_profiles table is authoritative and
    PRODUCT_REGISTRY is the fallback for any key not yet seeded. Without one,
    behavior is exactly as before — which is what makes the parity test a
    same-input comparison.
    """
    if db is not None:
        from models import AnalysisProfile
        row = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if row is not None:
            return ProductDef(
                row.key, row.name, row.is_addon,
                row.fulfillment_role, row.fulfillment_dim,
            )
    return PRODUCT_REGISTRY.get(key)
```

Change the signature and the two lookup sites in `build_ordered_products`:

```python
def build_ordered_products(services: dict, package: str | None, db=None) -> list[dict]:
```

Replace `pdef = _PACKAGE_PRODUCTS.get(package)` with:

```python
        pdef = lookup_product_def(package, db) or _PACKAGE_PRODUCTS.get(package)
```

Replace `pdef = PRODUCT_REGISTRY.get(key)` with:

```python
        pdef = lookup_product_def(key, db)
```

**Change nothing else.** The fail-open synthesis branches, the `samplevariance` skip, the `variance` handling, and the `has_package` suppression all stay exactly as they are — that is what keeps parity honest.

- [ ] **Step 5: Pass a session from the route**

In `backend/sub_samples/routes.py::get_ordered_products`, add the dependency and pass it through:

```python
def get_ordered_products(
    sample_id: str,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
```

```python
    products = build_ordered_products(raw.get("services") or {}, raw.get("package"), db=db)
```

- [ ] **Step 6: Wire the seed into startup**

In `backend/database.py::init_db()`, immediately after the `backfill_departments` call:

```python
    from catalog.profile_seed import seed_profiles_from_registry
    with SessionLocal() as _s:
        seed_profiles_from_registry(_s)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_profile_parity.py -v`
Expected: PASS (3 packages × 32 combinations plus the 5 unit tests)

- [ ] **Step 8: Verify the suite is additive**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | tail -20`
Expected: failure set identical to the Task 1 baseline.

- [ ] **Step 9: Commit**

```bash
git add backend/catalog/profile_seed.py backend/sub_samples/product_registry.py backend/sub_samples/routes.py backend/database.py backend/tests/test_profile_parity.py
git commit -m "feat(catalog): seed profiles from PRODUCT_REGISTRY, parity-gated"
```

---

### Task 8: Departments and Analysis Profiles admin pages

**Files:**
- Modify: `backend/main.py` (all four `/departments` routes + schemas)
- Modify: `src/lib/api.ts` (department + profile client functions)
- Create: `src/services/analysis-profiles.ts`
- Create: `src/components/hplc/DepartmentsPage.tsx`
- Create: `src/components/hplc/AnalysisProfilesPage.tsx`
- Modify: `src/components/layout/MainWindowContent.tsx` (mount both subsections)

**Interfaces:**
- Consumes: `/departments`, `/analysis-profiles`, `/analysis-profiles/{id}/members` (Tasks 1, 6).
- Produces: `activeSubSection` values `'departments'` and `'analysis-profiles'`.

- [ ] **Step 1: Add the department schemas and all four routes**

In `backend/main.py`, add the schemas near `ServiceGroupResponse`:

```python
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

Add the list and create routes after the service-group routes:

```python
@app.get("/departments", response_model=list[DepartmentResponse])
async def get_departments(db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """All departments ordered by sort_order, then name."""
    from models import Department
    return db.execute(
        select(Department).order_by(Department.sort_order, Department.name)
    ).scalars().all()


@app.post("/departments", response_model=DepartmentResponse, status_code=201)
async def create_department(
    data: DepartmentCreate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
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

Then the update and delete routes:

```python
class DepartmentUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None
    color: Optional[str] = None


@app.patch("/departments/{department_id}", response_model=DepartmentResponse)
async def update_department(
    department_id: int,
    data: DepartmentUpdate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    from models import Department
    dept = db.get(Department, department_id)
    if dept is None:
        raise HTTPException(404, "department not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(dept, field, value)
    db.commit()
    db.refresh(dept)
    return dept


@app.delete("/departments/{department_id}", status_code=204)
async def delete_department(
    department_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)
):
    """Refused while any service or group still points at it — reassign first.
    A silently orphaned service would be excluded from HPLC mirroring."""
    from models import Department
    dept = db.get(Department, department_id)
    if dept is None:
        raise HTTPException(404, "department not found")
    if dept.is_system:
        raise HTTPException(400, "system departments cannot be deleted")
    in_use = db.execute(
        select(AnalysisService.id).where(AnalysisService.department_id == department_id).limit(1)
    ).scalars().first() or db.execute(
        select(ServiceGroup.id).where(ServiceGroup.department_id == department_id).limit(1)
    ).scalars().first()
    if in_use is not None:
        raise HTTPException(409, "department still has services or groups; reassign them first")
    db.delete(dept)
    db.commit()
```

- [ ] **Step 2: Add the API client functions**

In `src/lib/api.ts`, add alongside the service-group functions (follow the exact fetch/auth wrapper the neighbouring `getServiceGroups` uses — read it first):

This file uses raw `fetch` with `API_BASE_URL()` and `getBearerHeaders()` — there are no generic
`apiGet`/`apiPost` wrappers. Match `getServiceGroups` / `createServiceGroup` (`src/lib/api.ts:4334-4350`)
exactly:

```typescript
export interface AnalysisProfile {
  id: number
  key: string
  name: string
  description: string | null
  is_addon: boolean
  vials_required: number
  fulfillment_role: string | null
  fulfillment_dim: string
  sort_order: number
  active: boolean
  member_ids: number[]
  created_at: string
  updated_at: string
}

export interface DepartmentCreate {
  name: string
  sort_order?: number
  color?: string
}

export async function getDepartments(): Promise<Department[]> {
  const response = await fetch(`${API_BASE_URL()}/departments`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to load departments: ${response.status}`)
  return response.json()
}

export async function createDepartment(data: DepartmentCreate): Promise<Department> {
  const response = await fetch(`${API_BASE_URL()}/departments`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await extractErrorMessage(response, 'Failed to create department'))
  return response.json()
}

export async function updateDepartment(
  id: number, data: Partial<DepartmentCreate>
): Promise<Department> {
  const response = await fetch(`${API_BASE_URL()}/departments/${id}`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await extractErrorMessage(response, 'Failed to update department'))
  return response.json()
}

export async function deleteDepartment(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/departments/${id}`, {
    method: 'DELETE',
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(await extractErrorMessage(response, 'Failed to delete department'))
}

export async function getAnalysisProfiles(): Promise<AnalysisProfile[]> {
  const response = await fetch(`${API_BASE_URL()}/analysis-profiles`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to load analysis profiles: ${response.status}`)
  return response.json()
}

export async function createAnalysisProfile(data: {
  key: string
  name: string
  is_addon: boolean
  description?: string | null
  vials_required?: number
  sort_order?: number
}): Promise<AnalysisProfile> {
  const response = await fetch(`${API_BASE_URL()}/analysis-profiles`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await extractErrorMessage(response, 'Failed to create profile'))
  return response.json()
}

export async function updateAnalysisProfile(
  id: number, data: Partial<AnalysisProfile>
): Promise<AnalysisProfile> {
  const response = await fetch(`${API_BASE_URL()}/analysis-profiles/${id}`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await extractErrorMessage(response, 'Failed to update profile'))
  return response.json()
}

export async function deleteAnalysisProfile(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/analysis-profiles/${id}`, {
    method: 'DELETE',
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(await extractErrorMessage(response, 'Failed to delete profile'))
}

export async function setAnalysisProfileMembers(
  id: number, analysisServiceIds: number[]
): Promise<{ count: number }> {
  const response = await fetch(`${API_BASE_URL()}/analysis-profiles/${id}/members`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ analysis_service_ids: analysisServiceIds }),
  })
  if (!response.ok) throw new Error(await extractErrorMessage(response, 'Failed to set members'))
  return response.json()
}
```

`extractErrorMessage(response, fallback)` already exists at `src/lib/api.ts:1869` — use it wherever
the backend returns an actionable message (the keyword rules, the 409 "deactivate instead", the
department-in-use 409), so those reach the user verbatim instead of as a bare status code.

- [ ] **Step 3: Build the two pages**

Create `src/components/hplc/DepartmentsPage.tsx` and `src/components/hplc/AnalysisProfilesPage.tsx`.

**Model both on `src/components/hplc/ServiceGroupsPage.tsx`** — it already implements exactly this shape: a list, a create/edit dialog, delete confirmation, and (for profiles) a multi-select membership editor. Read it fully first and mirror its structure, its TanStack Query usage, and its shadcn component choices.

Requirements specific to these pages:
- **Departments:** name, sort order, colour (the 8-value enum in `src/lib/service-group-colors.ts`). A department in use cannot be deleted — surface the 409 message rather than a generic error.
- **Profiles:** key, name, description, `is_addon` (a required choice, **not** a defaulted checkbox — the schema deliberately has no default), vials required, sort order, active. Membership is an ordered multi-select of analysis services; list order becomes `sort_order`, which is the row order in the profile's future COA section.
- Follow the repo's Zustand rule: selector syntax (`useUIStore(state => state.x)`), never destructuring.
- Rich hover tooltips are the house default — use the shadcn `Tooltip` sectioned font-mono card, not native `title=`.

- [ ] **Step 4: Mount both pages**

In `src/components/layout/MainWindowContent.tsx`, add two branches next to the existing `'analysis-services'` and `'service-groups'` cases:

```typescript
  if (activeSection === 'lims' && activeSubSection === 'departments') {
    return <DepartmentsPage />
  }
  if (activeSection === 'lims' && activeSubSection === 'analysis-profiles') {
    return <AnalysisProfilesPage />
  }
```

Add the navigation entries wherever the existing `'service-groups'` entry is registered.

- [ ] **Step 5: Typecheck and run the frontend suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run test`
Expected: no new failures versus the Task 3 baseline.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py src/lib/api.ts src/services/analysis-profiles.ts src/components/hplc/DepartmentsPage.tsx src/components/hplc/AnalysisProfilesPage.tsx src/components/layout/MainWindowContent.tsx
git commit -m "feat(catalog): Departments + Analysis Profiles admin pages"
```

---

### Task 9: Analysis Services create, full edit, and delete in the UI

**Files:**
- Modify: `src/services/analysis-services.ts` (create/update/delete mutations)
- Modify: `src/components/hplc/AnalysisServicesPage.tsx`
- Modify: `src/lib/api.ts` (`AnalysisService` interface gains `origin`, `local_overrides`)

**Interfaces:**
- Consumes: `POST`/`PATCH`/`DELETE /analysis-services` (Task 5).
- Produces: no new exports beyond the mutation hooks.

- [ ] **Step 1: Extend the API types and client**

In `src/lib/api.ts`, add to the `AnalysisService` interface:

```typescript
  origin: 'senaite' | 'mk1'
  local_overrides: string[] | null
```

Add client functions mirroring the existing ones in this file:

```typescript
export async function createAnalysisService(data: {
  title: string
  keyword: string
  category?: string | null
  unit?: string | null
  department_id?: number | null
  result_type?: string | null
  result_options?: Array<{ value: string; label: string }> | null
  variance_capable?: boolean
  peptide_id?: number | null
}): Promise<AnalysisService> {
  return apiPost<AnalysisService>('/analysis-services', data)
}

export async function updateAnalysisService(
  id: number, data: Partial<AnalysisService>
): Promise<AnalysisService> {
  return apiPatch<AnalysisService>(`/analysis-services/${id}`, data)
}

export async function deleteAnalysisService(id: number): Promise<void> {
  return apiDelete(`/analysis-services/${id}`)
}
```

- [ ] **Step 2: Add the mutations**

In `src/services/analysis-services.ts`, add `useMutation` hooks for create, update, and delete, each invalidating the existing analysis-services query key. Match the mutation pattern already used in `src/services/` for service groups.

- [ ] **Step 3: Extend the page**

In `src/components/hplc/AnalysisServicesPage.tsx`:

- Add a **New Service** button opening a create dialog: title, keyword, category, unit, department, result type, result options, variance-capable, peptide.
- Make the detail flyout edit **all** fields, not just the current three (`peptide_id`, `result_type`/`result_options`, `variance_capable`).
- **Distinguish origins visually.** A badge on each row: `SENAITE` versus `Mk1`. Their edit semantics differ, and a user editing a SENAITE-origin field needs to know it becomes a local override from then on.
- On a SENAITE-origin row, show which fields are already locally overridden (`local_overrides`), so an operator can see what sync no longer controls.
- **Delete** appears only for `origin === 'mk1'` rows. Surface the backend's 409 message verbatim when the service is referenced — "deactivate instead" is the actionable instruction.
- Surface the 400 from `validate_new_keyword` verbatim; the keyword rules are not guessable from a generic error.
- Disable the keyword field when editing a service that already has analyses — the backend returns 409, and the UI should not offer an action that cannot succeed.

- [ ] **Step 4: Typecheck and test**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run test`
Expected: no new failures versus the Task 3 baseline.

- [ ] **Step 5: Full backend suite — final additive proof**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | tail -20`
Expected: failure set identical to the Task 1 baseline, plus every new test passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/services/analysis-services.ts src/components/hplc/AnalysisServicesPage.tsx
git commit -m "feat(catalog): analysis service create / full edit / delete in the admin UI"
```

---

## Rehearsal before any deploy

Not a task — a gate. Before this branch goes anywhere near production:

1. Spin up an isolated, production-shaped devbox stack via the `accumark-stack-platform` skill. Never rehearse on the live host.
2. Confirm the migrations apply cleanly on a restored golden, and that `backfill_departments` reports **zero** NULL-department services. Any warning it logs is a real finding — investigate before proceeding.
3. Confirm `seed_profiles_from_registry` creates exactly five profiles and that `GET /sub-samples/{id}/ordered-products` renders identically to master on the same sample.
4. Verify against production whether a distinct `Endotoxin` service group exists. The seeder and the frontend contradict each other in comments, and this has been an open question since the prior program. The seed derives from live rows either way, so this is a confirmation, not a dependency.
