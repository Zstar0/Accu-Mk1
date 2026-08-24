# S2 — Worksheets/Inbox off Service Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key worksheet items, the worksheet inbox, and the COA blocking gate from service
groups to departments — additively, with dual-read fallbacks — so service groups become a frozen
legacy display layer.

**Architecture:** `worksheet_items` gains a nullable `department_id` (backfilled from the group
bridge); one shared scope-filter helper replaces five copy-pasted `gid_filter` sites; stamping
(`worksheet_analyst.py`) gains department precedence with a vial-role fallback for
department-join misses; the inbox's group translation shim is deleted (lanes are already
department-keyed); the COA gate ports to a department-keyed exemption with a transition union.
Group admin freezes (guarded DELETE, POST 410, name-edit blocked) but group ROWS survive for S7/SLA.

**Tech Stack:** FastAPI + SQLAlchemy (raw-SQL boot migrations in `backend/database.py`, NO
Alembic), pytest (live local Postgres via `SessionLocal` for live-DB tests), React/TypeScript
frontend (npm ONLY), vitest.

## Global Constraints

- **Worktree:** `C:\tmp\Accu-Mk1-s2-worksheets`, branch `feat/s2-worksheets-off-groups`, based on `b30d9fc0`.
- **Backend python:** `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe` (shared venv — always use this absolute path).
- **Run backend tests from** `C:\tmp\Accu-Mk1-s2-worksheets\backend` as cwd.
- **Frontend:** npm only (NEVER pnpm). FE gates: `npm run typecheck && npm run lint && npm run ast:lint`.
- **Additive only.** No column drops, no route behavior changes beyond what a task states. Migrations are idempotent raw SQL appended to the END of the `migrations` list in `backend/database.py` (bare `IF NOT EXISTS`, never DROP+CREATE — last-boot-wins hazard with mixed-vintage images).
- **The local dev Postgres is schema-ahead-of-branch** (earlier slices ran their migrations against it). If a live-DB test fails with "column does not exist"/"unexpected column", it is the documented schema-ahead pattern, not your bug — but new columns YOU add must be created by YOUR migration.
- **Test gate = failure-SET diff, never zero-failures.** The full suite has a known baseline of 67 failed / 14 errors at `b30d9fc0`. Judge any full-suite run by diffing the sorted set of FAILED test ids against the baseline, and re-run any suspicious failure in isolation before calling it a regression. Never run two full suites concurrently (shared Postgres drifts under concurrent load).
- **RULED production behavior change (2026-08-12): Heavy Metals analytes do NOT block COA generation.** Today they block by omission. The port EXEMPTS them via the Heavy Metals department term in the union (Task 9). Do not "fix" this back — pin it with a test naming the ruling.
- **`service_group_id is None` / `department_id is None` mean WILDCARD** ("all live analyses on the vial") in stamping — never "rows whose department IS NULL". Preserving this is a hard requirement.
- **Group rows must survive.** SLA per-group overrides (`sla_priority_tiers.service_group_id`, CASCADE) and S7 depend on them. Nothing in this slice deletes or renames a group row.
- Commit messages: `feat(s2): …` / `test(s2): …` / `fix(s2): …`, ending with the standard `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. Write commit bodies with the Write tool to a temp file and use `git commit -F <file>` (multi-line -m heredocs get blocked by the permission classifier).

## File Structure

| File | Responsibility in this slice |
|---|---|
| `backend/database.py` | Migration: `worksheet_items.department_id` column + backfill (Task 1) |
| `backend/models.py` | `WorksheetItem.department_id` mapped column (Task 1) |
| `backend/catalog/departments.py` | New helpers `department_id_for_service`, `department_id_for_role` (Task 2) |
| `backend/main.py` | Group admin freeze (Task 3); `_item_scope_filter` + add/staging routes (Task 5); path-param route retirement (Task 6); inbox port (Task 7); display chain (Task 8); COA gate call sites (Task 9) |
| `backend/lims_analyses/worksheet_analyst.py` | Stamping port: department precedence + role fallback (Task 4) |
| `backend/lims_analyses/seeder.py` | `coa_exempt_keywords` union next to `_micro_group_keywords` (Task 9) |
| `src/lib/api.ts`, `src/components/hplc/*` | FE wave (Task 10) |
| `backend/tests/test_worksheet_department_schema.py` | New (Task 1) |
| `backend/tests/test_departments_catalog.py` | Extend (Task 2) |
| `backend/tests/test_service_groups_freeze.py` | New (Task 3) |
| `backend/tests/test_worksheet_analyst_stamp.py` | Extend with department twins + role fallback (Task 4) |
| `backend/tests/test_worksheet_item_scope.py` | New (Task 5) |
| `backend/tests/test_worksheets_inbox.py` | Extend (Task 7) |
| `backend/tests/test_coa_gate_departments.py` | New (Task 9) |

---

### Task 1: Schema — `worksheet_items.department_id` + backfill

**Files:**
- Modify: `backend/database.py` (append to the END of the `migrations` list, just before the list closes)
- Modify: `backend/models.py:892-916` (`WorksheetItem`)
- Test: `backend/tests/test_worksheet_department_schema.py` (new)

**Interfaces:**
- Produces: `WorksheetItem.department_id: Mapped[Optional[int]]` (nullable FK to `departments.id`, `ON DELETE SET NULL`) — every later task reads/writes it.

- [ ] **Step 1: Write the failing test**

```python
"""Live-PG schema test for worksheet_items.department_id (S2 Task 1)."""
from sqlalchemy import text
from database import SessionLocal


def _get_migration_sqls():
    """The two S2 Task-1 statements, read from database.py's migrations list
    so the test exercises the real strings (not a copy that can drift)."""
    import database, inspect
    src = inspect.getsource(database)
    assert "worksheet_items ADD COLUMN IF NOT EXISTS department_id" in src
    assert "UPDATE worksheet_items" in src and "service_groups" in src


def test_migration_statements_present():
    _get_migration_sqls()


def test_column_exists_and_backfill_idempotent():
    db = SessionLocal()
    try:
        # Column present (migration already ran on this DB, or we run it here idempotently)
        db.execute(text(
            "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS department_id "
            "INTEGER REFERENCES departments(id) ON DELETE SET NULL"
        ))
        db.commit()
        cols = {r[0] for r in db.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name='worksheet_items'"
        )).all()}
        assert "department_id" in cols
    finally:
        db.rollback()
        db.close()
```

- [ ] **Step 2: Run it — expect the `test_migration_statements_present` half to FAIL** (`database.py` has no such statement yet).

Run: `"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_worksheet_department_schema.py -v`

- [ ] **Step 3: Add the migration + model column**

Append to the END of the `migrations` list in `backend/database.py` (find the current last entry; keep list style consistent):

```python
        # S2 (worksheets off groups): department becomes the item-tier routing
        # key. Nullable + SET NULL — additive alongside the frozen legacy
        # service_group_id. Backfill via the group bridge only (analyses_json
        # display fallback is NOT used for backfill — write-path purity; NULL
        # rows read through the serializer's fallback chain instead).
        """
        ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS department_id
            INTEGER REFERENCES departments(id) ON DELETE SET NULL
        """,
        """
        UPDATE worksheet_items wi
           SET department_id = sg.department_id
          FROM service_groups sg
         WHERE wi.service_group_id = sg.id
           AND wi.department_id IS NULL
           AND sg.department_id IS NOT NULL
        """,
```

In `backend/models.py`, inside `WorksheetItem` directly under the `service_group_id` line (`models.py:904`):

```python
    department_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
```

- [ ] **Step 4: Run the test again — PASS.** Also run the existing worksheet test files to catch model regressions: `python -m pytest tests/test_worksheet_analyst_stamp.py tests/test_worksheets_list_sync.py tests/test_worksheet_item_by_id.py -q`

- [ ] **Step 5: Commit** — `feat(s2): worksheet_items.department_id column + group-bridge backfill`

---

### Task 2: `catalog/departments.py` helpers

**Files:**
- Modify: `backend/catalog/departments.py` (after `department_id_by_name`, `:76-85`)
- Test: `backend/tests/test_departments_catalog.py` (extend)

**Interfaces:**
- Produces:
  - `department_id_for_service(db: Session, analysis_service_id: int) -> Optional[int]` — the service's direct `department_id` column, no M2M.
  - `department_id_for_role(db: Session, role_code: str) -> Optional[int]` — `VialRole.department_id` for the given `assignment_role` code (e.g. `"hplc"`, `"ster"`).
- Consumed by Task 4 (stamping role fallback) and available to Task 5/7.

- [ ] **Step 1: Write failing tests** (append to `tests/test_departments_catalog.py`; follow that file's existing live-PG fixture style):

```python
def test_department_id_for_service_reads_direct_column(db):
    from catalog.departments import department_id_for_service
    from models import AnalysisService, Department
    dept = db.query(Department).filter_by(name="Analytical").one()
    svc = db.query(AnalysisService).filter(
        AnalysisService.department_id == dept.id
    ).first()
    assert svc is not None, "seeded Analytical services expected"
    assert department_id_for_service(db, svc.id) == dept.id


def test_department_id_for_service_unknown_id_is_none(db):
    from catalog.departments import department_id_for_service
    assert department_id_for_service(db, -1) is None


def test_department_id_for_role(db):
    from catalog.departments import department_id_for_role
    from models import Department
    micro = db.query(Department).filter_by(name="Microbiology").one()
    assert department_id_for_role(db, "ster") == micro.id
    assert department_id_for_role(db, "no_such_role") is None
```

- [ ] **Step 2: Run — FAIL (ImportError).**

- [ ] **Step 3: Implement** in `backend/catalog/departments.py`:

```python
def department_id_for_service(db: Session, analysis_service_id: int) -> Optional[int]:
    """The service's structural department (direct column — no M2M fan-out)."""
    from models import AnalysisService
    svc = db.get(AnalysisService, analysis_service_id)
    return svc.department_id if svc is not None else None


def department_id_for_role(db: Session, role_code: str) -> Optional[int]:
    """The department owning a vial assignment_role code (e.g. 'ster' → Microbiology)."""
    from models import VialRole
    row = db.query(VialRole).filter_by(code=role_code).one_or_none()
    return row.department_id if row is not None else None
```

(Check the actual `VialRole` column name for the role code in `backend/models.py` — it is the
column seeded by `backend/catalog/vial_roles_seed.py` (`hplc`/`endo`/`ster`/`hm`/`xtra`). If it is
named something other than `code`, use that name.)

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(s2): department_id_for_service / department_id_for_role catalog helpers`

---

### Task 3: Group admin freeze (guarded DELETE first)

**Files:**
- Modify: `backend/main.py:15628-15723` (`create_service_group`, `update_service_group`, `delete_service_group`)
- Test: `backend/tests/test_service_groups_freeze.py` (new)

**Interfaces:**
- Produces: `POST /service-groups` → 410; `PUT /service-groups/{id}` with a `name` change → 400; `DELETE /service-groups/{id}` → 409 while referenced. `PUT /service-groups/{id}/members` REMAINS OPEN (freezing membership before the Task-9 gate port lands can strand a new micro service outside the exemption set).

**Why DELETE guard is a prerequisite, not a courtesy:** DELETE currently has NO in-use guard; it
SET-NULLs every historical `worksheet_items.service_group_id` and CASCADE-deletes
`sla_priority_tiers` rows. "Historical rows keep their group ids" only holds if group rows survive.

- [ ] **Step 1: Write failing tests** (use FastAPI `TestClient` the way `backend/tests/test_departments_catalog.py` / other route tests in this repo do — copy the auth/client fixture idiom from an existing route test file):

```python
def test_create_service_group_is_gone(client):
    r = client.post("/service-groups", json={"name": "NewGroup"})
    assert r.status_code == 410
    assert "legacy" in r.json()["detail"].lower()


def test_rename_service_group_blocked(client, db):
    g = _mk_group(db, "FreezeRename")          # helper: insert a bare ServiceGroup row
    r = client.put(f"/service-groups/{g.id}", json={"name": "Renamed"})
    assert r.status_code == 400
    # non-name edits still pass (display metadata stays editable)
    r2 = client.put(f"/service-groups/{g.id}", json={"color": "purple"})
    assert r2.status_code == 200


def test_delete_blocked_while_worksheet_item_references(client, db):
    g = _mk_group(db, "FreezeDelItem")
    _mk_worksheet_item(db, service_group_id=g.id)   # helper: Worksheet + WorksheetItem
    r = client.delete(f"/service-groups/{g.id}")
    assert r.status_code == 409


def test_delete_blocked_while_sla_tier_references(client, db):
    g = _mk_group(db, "FreezeDelSla")
    _mk_sla_tier(db, service_group_id=g.id)         # helper: SlaPriorityTier row
    r = client.delete(f"/service-groups/{g.id}")
    assert r.status_code == 409


def test_delete_blocked_while_member_references(client, db):
    g = _mk_group(db, "FreezeDelMember")
    _add_member(db, g.id)                            # helper: service_group_members row
    r = client.delete(f"/service-groups/{g.id}")
    assert r.status_code == 409


def test_delete_succeeds_when_unreferenced(client, db):
    g = _mk_group(db, "FreezeDelFree")
    r = client.delete(f"/service-groups/{g.id}")
    assert r.status_code == 200
```

- [ ] **Step 2: Run — FAIL** (POST currently 201, rename currently 200, delete currently 200).

- [ ] **Step 3: Implement.** Model on the departments guard at `main.py:15837-15862`:

`create_service_group` body becomes:

```python
    """Service groups are legacy — departments own routing now (S2)."""
    raise HTTPException(410, "service groups are legacy; departments own routing now")
```

`update_service_group`: after `update_data = data.model_dump(exclude_unset=True)` add:

```python
    if "name" in update_data and update_data["name"] != group.name:
        raise HTTPException(
            400,
            "service group names are frozen (legacy); FE keyword maps and the COA "
            "gate's group half key on them",
        )
```

`delete_service_group`: before `db.delete(group)`:

```python
    in_use = db.execute(
        select(WorksheetItem.id).where(WorksheetItem.service_group_id == group_id).limit(1)
    ).scalars().first() or db.execute(
        select(SlaPriorityTier.id).where(SlaPriorityTier.service_group_id == group_id).limit(1)
    ).scalars().first() or db.execute(
        select(service_group_members.c.id).where(
            service_group_members.c.service_group_id == group_id
        ).limit(1)
    ).scalars().first()
    if in_use is not None:
        raise HTTPException(
            409,
            "service group is still referenced (worksheet items, SLA tiers, or members); "
            "groups are frozen legacy rows — do not delete while in use",
        )
```

(Import `SlaPriorityTier` and `service_group_members` from `models` at the top of the route if not already imported in scope.)

- [ ] **Step 4: Run — PASS.** Also run `python -m pytest tests/ -q -k "service_group"` and diff failures vs what those files did before your change (some existing tests may POST groups as setup — fix those setups to insert `ServiceGroup` rows directly via the db fixture instead of the dead POST route; that is a stale-test fix, not a behavior compromise).
- [ ] **Step 5: Commit** — `feat(s2): freeze service-group admin — guarded delete, POST 410, name-edit block`

---

### Task 4: Stamping port — department precedence + role fallback

**Files:**
- Modify: `backend/lims_analyses/worksheet_analyst.py` (whole module — it is 167 lines)
- Test: `backend/tests/test_worksheet_analyst_stamp.py` (extend — it has 12 group-keyed cases)

**Interfaces:**
- Consumes: `department_id_for_role` from Task 2.
- Produces: `stamp_for_item(db, *, sample_uid, service_group_id, analyst_user_id, acting_user_id, worksheet_id, worksheet_title=None, department_id=None)` — and the same additive `department_id: Optional[int] = None` kwarg on `clear_for_item`. `restamp_for_worksheet` reads `item.department_id` itself (no signature change). Task 5 passes `department_id=` at every call site.

**Resolution contract (`_resolve`):** precedence order —
1. `department_id` provided → `AnalysisService.department_id == department_id` (direct column, no M2M).
2. else `service_group_id` provided → existing group join, unchanged.
3. else → wildcard: ALL live analyses on the vial (`None` keeps its current meaning — every historical group-less item keeps its behavior).

**Role fallback (department path only):** when the department join yields ZERO rows but the vial's
`assignment_role` maps to a `VialRole` whose `department_id` equals the requested department,
return ALL live analyses on the vial (the vial was seeded role-scoped, so its rows already match
its role — see `main.py:17969-17974`). This closes the P-0146-S04 incident class
(`STERILITY_USP71` in no group → stamping no-ops).

- [ ] **Step 1: Write failing tests** (extend `tests/test_worksheet_analyst_stamp.py`; reuse its existing fixtures/helpers for creating vials + analyses — read the file first and mirror its setup idiom):

```python
def test_stamp_department_scoped(db, ...):
    """Department-keyed twin of the group-scoped stamp case: only analyses whose
    service belongs to the department get the analyst."""
    # vial with one Analytical-department analysis and one Microbiology-department analysis
    # stamp_for_item(..., department_id=<analytical dept id>, service_group_id=None)
    # → only the Analytical row's analyst_user_id changes


def test_stamp_department_wins_over_group(db, ...):
    """Both provided → department filter is used (group join not consulted)."""


def test_stamp_none_none_still_wildcard(db, ...):
    """department_id=None + service_group_id=None stamps ALL live analyses (historical
    group-less items keep their wildcard behavior)."""


def test_stamp_department_role_fallback_usp71(db, ...):
    """The incident regression: a 'ster' vial whose STERILITY_USP71 service has
    department_id=NULL (department join yields zero rows). Because the vial's
    assignment_role 'ster' maps to the Microbiology department, stamping with the
    Microbiology department stamps ALL live analyses instead of no-oping."""


def test_stamp_department_no_fallback_when_role_mismatch(db, ...):
    """Same zero-row department join, but the vial's role maps to a DIFFERENT
    department → no stamp (fallback must not fire cross-department)."""
```

Each test body follows the existing 12 cases' arrange/act/assert shape — write them fully by copying the file's established builders.

- [ ] **Step 2: Run — FAIL** (`stamp_for_item` has no `department_id` parameter).

- [ ] **Step 3: Implement.** `_resolve` becomes:

```python
def _resolve(
    db: Session, *, sample_uid: str,
    department_id: Optional[int] = None,
    service_group_id: Optional[int] = None,
) -> Tuple[Optional[LimsSubSample], List[LimsAnalysis]]:
    """Vial + its live analyses in the given DEPARTMENT (preferred), else the
    given legacy GROUP, else all live analyses (both None = wildcard — the
    historical contract; None never means 'department IS NULL').

    Department-miss role fallback: a department filter that matches zero rows
    on a vial whose assignment_role belongs to that same department returns
    ALL live rows — catalog-only services (hm, STERILITY_USP71) carry no
    department/group membership, but the vial was seeded role-scoped so its
    rows already match its role (main.py Phase-2 seeder contract).
    """
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.external_lims_uid == sample_uid)
    ).scalar_one_or_none()
    if sub is None:
        return None, []
    base = (
        select(LimsAnalysis)
        .where(LimsAnalysis.lims_sub_sample_pk == sub.id)
        .where(~LimsAnalysis.review_state.in_(_DEAD_STATES))
    )
    if department_id is not None:
        q = base.join(
            AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id
        ).where(AnalysisService.department_id == department_id)
        rows = list(db.execute(q).scalars().all())
        if not rows:
            from catalog.departments import department_id_for_role
            role = getattr(sub, "assignment_role", None)
            if role and department_id_for_role(db, role) == department_id:
                rows = list(db.execute(base).scalars().all())
        return sub, rows
    if service_group_id is not None:
        q = (
            base.join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .join(
                service_group_members,
                service_group_members.c.analysis_service_id == AnalysisService.id,
            )
            .where(service_group_members.c.service_group_id == service_group_id)
        )
        return sub, list(db.execute(q).scalars().all())
    return sub, list(db.execute(base).scalars().all())
```

`stamp_for_item` and `clear_for_item` each gain `department_id: Optional[int] = None` (keyword-only, after the existing params) and pass it through to `_resolve`. `restamp_for_worksheet`'s per-item call becomes `_resolve(db, sample_uid=item.sample_uid, department_id=item.department_id, service_group_id=item.service_group_id)`.

Check `LimsSubSample` actually carries `assignment_role` (the inbox reads it at `main.py:17722`); if the attribute lives elsewhere adjust the fallback read accordingly.

- [ ] **Step 4: Run the full stamp file — all 12 legacy cases + the 5 new must pass:**
`python -m pytest tests/test_worksheet_analyst_stamp.py -v`
- [ ] **Step 5: Commit** — `feat(s2): stamping resolves by department with vial-role fallback (P-0146-S04 class)`

---

### Task 5: `_item_scope_filter` + department on the add/staging wire

**Files:**
- Modify: `backend/main.py` — `AddToWorksheetRequest` (`:18695-18707`), `add_group_to_worksheet` (`:18709-18811`), `create_worksheet_from_drop` (`:18814-18915`), `BulkInboxUpdate` (`:17076-17085`) + its staging upsert (`:18221-18276`), worksheet-delete clear call (`:18941`), by-id remove/reassign stamp calls (`:19043`, `:19183/19188`)
- Test: `backend/tests/test_worksheet_item_scope.py` (new)

**Interfaces:**
- Consumes: Task 1's `WorksheetItem.department_id`, Task 4's `department_id=` kwargs.
- Produces: module-level helper in `main.py` (place it directly above `AddToWorksheetRequest`):

```python
def _item_scope_filter(department_id: int | None, service_group_id: int | None):
    """Locate a worksheet item by bench scope. Department wins when present;
    else the legacy group; both None → the legacy NULL-scope rows (a whole-
    sample claim). NOTE: the group→department collapse is many-to-one
    (Microbiology+Endotoxin→Microbiology), so a department match can hit two
    historical rows — callers use ordered .first() + the
    worksheet.item_scope_ambiguous warning, never scalar_one_or_none().
    """
    if department_id is not None:
        return WorksheetItem.department_id == department_id
    if service_group_id is not None:
        return WorksheetItem.service_group_id == service_group_id
    return and_(
        WorksheetItem.department_id.is_(None),
        WorksheetItem.service_group_id.is_(None),
    )
```

and a lookup helper used by every former `scalar_one_or_none()` site:

```python
def _first_item_in_scope(db, *, sample_uid: str, department_id: int | None,
                         service_group_id: int | None, status: str) -> "WorksheetItem | None":
    rows = db.execute(
        select(WorksheetItem)
        .join(Worksheet, WorksheetItem.worksheet_id == Worksheet.id)
        .where(
            WorksheetItem.sample_uid == sample_uid,
            _item_scope_filter(department_id, service_group_id),
            Worksheet.status == status,
        )
        .order_by(WorksheetItem.id)
    ).scalars().all()
    if len(rows) > 1:
        logging.getLogger(__name__).warning(
            "worksheet.item_scope_ambiguous sample_uid=%s department_id=%s "
            "service_group_id=%s status=%s n=%d — many-to-one group→department "
            "collapse matched multiple historical rows; using lowest id",
            sample_uid, department_id, service_group_id, status, len(rows),
        )
    return rows[0] if rows else None
```

**Wire contract (`AddToWorksheetRequest`):** gains `department_id: int | None = None` with the
same `zero_to_none` validator. Precedence: `department_id` wins. Both present AND the group's
`department_id` is set AND disagrees with the given `department_id` → 400. Only group present →
derive `department_id` from the group's bridge column so NEW rows always converge:

```python
    dept_id = data.department_id
    gid = data.service_group_id
    if gid is not None:
        _g = db.get(ServiceGroup, gid)
        _g_dept = _g.department_id if _g is not None else None
        if dept_id is not None and _g_dept is not None and _g_dept != dept_id:
            raise HTTPException(400, "department_id and service_group_id disagree")
        if dept_id is None:
            dept_id = _g_dept
```

- [ ] **Step 1: Write failing tests** (`tests/test_worksheet_item_scope.py`, TestClient idiom):

```python
def test_add_with_department_only(client, db):
    """POST add-group with department_id and no service_group_id creates an item
    carrying department_id; stamp path receives the department."""

def test_add_with_group_only_derives_department(client, db):
    """Legacy FE payload (group only) still works AND the stored item gets
    department_id derived from the group bridge (rollback compatibility)."""

def test_add_both_disagreeing_is_400(client, db):
    ...

def test_collision_guard_matches_across_key_shapes(client, db):
    """An item added by group (deriving dept D) collides with a second add for
    the same vial sent by department D → 409 (or already_exists in the same
    worksheet) — the scope filter bridges old and new key shapes."""

def test_ambiguous_scope_resolves_first_with_warning(client, db, caplog):
    """Two historical items (Microbiology group + Endotoxin group, same vial,
    both backfilled to the Microbiology department) — a department-keyed
    lookup takes the lowest id and logs worksheet.item_scope_ambiguous;
    no MultipleResultsFound."""
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
  1. Add the two helpers + the request field + the precedence block (code above).
  2. `add_group_to_worksheet`: replace the collision-guard query (`:18724-18734`) and staging pick-up (`:18746-18755`) with `_first_item_in_scope(db, sample_uid=data.sample_uid, department_id=dept_id, service_group_id=gid, status="open"/"staging")`. Construct the item with `department_id=dept_id, service_group_id=gid` (store BOTH). Pass `department_id=dept_id` to `stamp_for_item` (`:18787`).
  3. `create_worksheet_from_drop`: same three replacements (`:18822-18832`, `:18860-18870`, item construction `:18872-18882`, stamp `:18890`).
  4. `BulkInboxUpdate` (`:17076-17085`) gains `department_id: Optional[int]` with `zero_to_none`. The requirement check (`:18223-18227`) becomes "one of `service_group_id` / `department_id` is required". The staging-item find (`:18229-18238`) filters with `_item_scope_filter(dept_id, gid)` (after the same derive-from-group block); created staging items (`:18268-18275`) store both `department_id=dept_id, service_group_id=gid`.
  5. Worksheet-delete loop (`:18941`) and the by-id remove (`:19043`) / by-id reassign (`:19183/19188`) stamp calls: pass `department_id=item.department_id` (or `ws_item.department_id`) alongside the existing `service_group_id=`.
- [ ] **Step 4: Run** the new file + `tests/test_worksheet_analyst_stamp.py` + `tests/test_worksheets_list_sync.py` + `tests/test_worksheet_item_by_id.py` — PASS (diff any live-PG flake in isolation).
- [ ] **Step 5: Commit** — `feat(s2): department on the add/staging wire; one scope filter replaces five gid_filter copies`

---

### Task 6: Retire the path-param routes

**Files:**
- Modify: `backend/main.py` — DELETE `remove_worksheet_item` (`@app.delete("/worksheets/{worksheet_id}/items/{sample_uid}/{service_group_id}")`, `:18961-19005`) and `reassign_worksheet_item` (`@app.post("/worksheets/{worksheet_id}/items/{sample_uid}/{service_group_id}/reassign")`, `:19081-19138`) — remove both functions entirely.
- Modify: `src/lib/api.ts` — remove the wrappers that call those two URL shapes if any still exist (search for `` `/items/${`` patterns combined with a group id; the by-id wrappers at `api.ts:5232` area stay).
- Test: existing suites.

**Why retire, not port:** the by-id siblings already exist and are documented preferred
(`main.py:19017-19024` — `mk1://` uids can't ride in a path segment); the FE already uses them.
Minting `{department_id}` path twins would re-create the retired shape. No deprecation window
needed: nothing in-repo calls the path-param shapes (verify — Step 1).

- [ ] **Step 1: Verify nothing calls them.** `grep -rn "items/\${" src/ | grep -v item_id` and `grep -rn "service_group_id}/reassign\|/items/.*/[0-9]" src/ backend/tests/` — enumerate every hit; any test using the path shape gets rewritten to the by-id route (that is a stale-test port, allowed by default).
- [ ] **Step 2: Delete the two route functions.** Keep `ReassignRequest` (the by-id route uses it).
- [ ] **Step 3: Run** `python -m pytest tests/ -q -k "worksheet"` — failure set must match the pre-task set except tests you deliberately ported.
- [ ] **Step 4: Commit** — `feat(s2): retire path-param worksheet-item routes in favor of by-id siblings`

---

### Task 7: Inbox port — delete the group translation shim

**Files:**
- Modify: `backend/main.py`: `_inbox_allowed_group_ids` (`:17057-17069`, delete), its call (`:17395`), `keyword_to_group` (`:17564-17578`), `default_group` (`:17607-17614`), assigned-pairs build (`:17521-17538`), staging assignment_map (`:17728-17740` + its consumers later in the same function — grep `assignment_map` within `get_worksheets_inbox`), the consumption site (`:17945-17951`).
- Test: `backend/tests/test_worksheets_inbox.py` (extend), `backend/tests/test_inbox_lanes_endpoint.py` (must stay green).

**Interfaces:**
- Consumes: Task 1's `department_id` on items.
- Produces: inbox analyses' `group_id`/`group_name`/`group_color` wire fields now carry DEPARTMENT id/name/color (sanctioned re-meaning per sub-spec D4 — FE `itemBench()` is already department-name-based). Unresolved keyword → explicit `(0, "Other", "gray")` bucket, fail-visible.

- [ ] **Step 1: Write failing tests** (extend `tests/test_worksheets_inbox.py`, mirroring its existing setup):

```python
def test_inbox_analysis_carries_department_identity(client, db):
    """A keyword whose service has department Analytical serializes with the
    department's id/name/color in group_id/group_name/group_color."""

def test_inbox_unresolved_keyword_lands_in_other_bucket(client, db):
    """A keyword with no catalog service (or no department) gets (0, 'Other',
    'gray') — fail-visible, no is_default group fallback."""

def test_inbox_lane_filter_is_department_keyed(client, db):
    """role=<lane key> passes analyses of that department and drops others —
    without consulting service_group_members."""

def test_inbox_claimed_pair_is_department_keyed(client, db):
    """An open-worksheet item claiming (vial, Microbiology-dept) hides both a
    Microbiology-group AND an Endotoxin-group analysis of that vial (the
    many-to-one collapse is intentional here)."""
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** inside `get_worksheets_inbox`:

  1. Delete `_inbox_allowed_group_ids` (function + comment block `:17052-17069`) and replace `:17394-17395` with:
     ```python
     # Lane key IS the department (catalog.roles.inbox_lanes). None = no filter.
     allowed_department_id: Optional[int] = None if role is None else lanes[role].department_id
     ```
  2. Replace the Step-3 map (`:17564-17578`) with a department-keyed map (keep the variable name change honest — rename to `keyword_to_department`):
     ```python
     dept_rows = db.execute(
         select(AnalysisService.keyword, Department.id, Department.name, Department.color)
         .join(Department, Department.id == AnalysisService.department_id)
         .where(AnalysisService.keyword.isnot(None))
     ).all()
     keyword_to_department: dict[str, tuple[int, str, str]] = {
         row.keyword: (row[1], row[2], row[3]) for row in dept_rows
     }
     ```
     (Import `Department` the way the serializer fallback at `:18503` does.)
  3. Replace `default_group` (`:17606-17614`) with:
     ```python
     # Unresolved keyword → explicit legacy bucket. Fail-visible by design:
     # no Department.is_default analogue exists and none is added (S2 ruling).
     default_department = (0, "Other", "gray")
     ```
  4. Assigned pairs (`:17521-17538`): select `department_id` too, bridge NULLs through the group map:
     ```python
     open_worksheet_rows = db.execute(
         select(WorksheetItem.sample_uid, WorksheetItem.department_id,
                WorksheetItem.service_group_id)
         .join(Worksheet, WorksheetItem.worksheet_id == Worksheet.id)
         .where(Worksheet.status == "open")
     ).all()
     group_dept_bridge: dict[int, int | None] = {
         g.id: g.department_id for g in db.execute(select(ServiceGroup)).scalars().all()
     }
     def _row_department(dept_id: int | None, gid: int | None) -> int | None:
         if dept_id is not None:
             return dept_id
         if gid is not None:
             return group_dept_bridge.get(gid)
         return None
     assigned_pairs: set[tuple[str, int | None]] = {
         (r.sample_uid, _row_department(r.department_id, r.service_group_id))
         for r in open_worksheet_rows
     }
     assigned_uids_for_null_group: set[str] = {
         uid for uid, dept in assigned_pairs if dept is None
     }
     ```
     Keep the downstream uses of `assigned_uids_for_null_group` untouched (the NULL-scope
     "fully claimed" rule survives — grep its consumers in the same function).
  5. Staging `assignment_map` (`:17738-17740`): key by `(sample_uid, _row_department(row.department_id, row.service_group_id))`; port every `assignment_map.get((...))` consumer in the function to look up with the analysis's department id.
  6. Consumption (`:17945-17951`):
     ```python
     dept_id_, dept_name_, dept_color_ = keyword_to_department.get(keyword, default_department)

     # Lane filter (None == pass all lanes)
     if allowed_department_id is not None and dept_id_ != allowed_department_id:
         continue
     # Already on an open worksheet for this (vial, department) — drop it
     if (uid, dept_id_) in assigned_pairs:
         continue
     ```
     and the `InboxAnalysisItem(...)` fields become `group_id=dept_id_, group_name=dept_name_, group_color=dept_color_`.
  7. The Mk1-native branch (`:17968-17982`) needs NOTHING (role-filtering already happened in the seeder). `_INBOX_ROLE_COLOR_FALLBACK` and `_fetch_mk1_inbox_analyses_for_sub_sample` stay as-is.
- [ ] **Step 4: Run** `python -m pytest tests/test_worksheets_inbox.py tests/test_inbox_lanes_endpoint.py tests/test_inbox_native_vials.py -v` — PASS.
- [ ] **Step 5: Commit** — `feat(s2): inbox drops the group shim — lanes filter and claim by department`

---

### Task 8: Display chain — the four-state department render

**Files:**
- Modify: `backend/main.py:18429-18513` (worksheet serializer department resolution) + item dict (`:18607-18629`)
- Test: `backend/tests/test_worksheets_list_sync.py` (extend)

**Interfaces:**
- Produces (per item dict): additive `department_id` field; `department_name` resolution order:
  1. `item.department_id` set → that department's name (batched id→name map, one query);
  2. NULL dept + live legacy `service_group_id` → group's department via bridge (today's `group_department_name_map`, unchanged);
  3. NULL both but `analyses_json` resolves → the existing `:18471-18513` first-keyword fallback (unchanged);
  4. truly unresolvable → the literal string `"Legacy"` (was `None`).
- `service_group_id` / `group_name` / `group_color` item fields stay exactly as today (frozen legacy display).

- [ ] **Step 1: Write failing tests** — four cases in `tests/test_worksheets_list_sync.py` (one per state above; the file already builds worksheets+items — mirror it):
- [ ] **Step 2: Run — FAIL** (no `department_id` in the dict; unresolvable renders None).
- [ ] **Step 3: Implement.** Before the item loop: batch-load `{d.id: d.name for d in db.execute(select(Department)).scalars()}`. In the item dict: `"department_id": it.department_id,` and `department_name` per the chain, with `"Legacy"` as the final else.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(s2): worksheet items render department by the four-state chain ('Legacy' fail-visible)`

---

### Task 9: COA gate port — transition union (RULED 2026-08-12)

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (add `coa_exempt_keywords` next to `_micro_group_keywords`, `:238-272`)
- Modify: `backend/main.py:10299-10340` (both gate call sites)
- Test: `backend/tests/test_coa_gate_departments.py` (new)

**Interfaces:**
- Produces: `coa_exempt_keywords(db: Session) -> Set[str]` — the union
  `keywords(dept ∈ {Microbiology, Heavy Metals}) ∪ _micro_group_keywords(db)`.
- Both `main.py` call sites switch from `_micro_group_keywords` to `coa_exempt_keywords`.
  `_micro_group_keywords` itself is UNTOUCHED (still used by the union + `test_assign_role_fail_hard.py`).

**The two rulings this implements (2026-08-12):**
1. Port approved with the transition union — preserves today's behavior even if either source is
   empty or prod lacks the `Endotoxin` group; self-heals when department totality (S6a) lands;
   group half deleted at SENAITE decommission (not now).
2. **Heavy Metals does NOT block COA generation** — REVERSES today's behavior (HM blocked by
   omission from `_NON_HPLC_GROUPS`). Handler: "I'm not sure yet if HM is going to take longer
   for results, so for now it should not block." Revisitable when HM turnaround is known.

- [ ] **Step 1: Write failing tests** (`tests/test_coa_gate_departments.py`, live-PG):

```python
def test_micro_by_department_exempt(db):
    """A Microbiology-DEPARTMENT service with NO group membership is in the
    exempt set (the widening the ruling accepted)."""

def test_micro_by_group_only_still_exempt(db):
    """A service in the Microbiology GROUP whose department_id is NULL stays
    exempt during transition (the union's group half)."""

def test_heavy_metals_exempt_ruling_2026_08_12(db):
    """RULED 2026-08-12: HM analytes do NOT block COA generation. A Heavy
    Metals-department service (e.g. an hm catalog service) is in the exempt
    set. This test pins a deliberate production-behavior REVERSAL — do not
    'fix' it back without a new Handler ruling."""

def test_analytical_never_exempt(db):
    """An Analytical-department service is NOT in the set (still blocks)."""
```

Each test inserts its service rows (and group membership where needed) in a transaction and rolls back — mirror how `test_departments_catalog.py` builds catalog rows.

- [ ] **Step 2: Run — FAIL (ImportError).**

- [ ] **Step 3: Implement** in `seeder.py`, directly below `_micro_group_keywords`:

```python
def coa_exempt_keywords(db: Session) -> Set[str]:
    """Keywords exempt from COA-generation blocking (S2 port, RULED 2026-08-12).

    Department half: Microbiology (micro finishes after the analytical COA and
    re-generates) plus Heavy Metals (RULED: HM does not block until its
    turnaround reality is known — this REVERSES the pre-S2 behavior where HM
    blocked by omission). Group half: the legacy _micro_group_keywords set —
    kept as a transition union so the gate's fail posture cannot invert if
    either source is empty (prod may lack the Endotoxin group; department
    backfill may lag). Delete the group half at SENAITE decommission.
    """
    from catalog.departments import HEAVY_METALS_DEPARTMENT, MICROBIOLOGY_DEPARTMENT
    from models import Department

    dept_rows = db.execute(
        select(AnalysisService.keyword)
        .join(Department, Department.id == AnalysisService.department_id)
        .where(Department.name.in_((MICROBIOLOGY_DEPARTMENT, HEAVY_METALS_DEPARTMENT)))
    ).scalars().all()
    return {k for k in dept_rows if k} | _micro_group_keywords(db)
```

In `main.py`: `:10310` `from lims_analyses.seeder import _micro_group_keywords` → import
`coa_exempt_keywords`; `micro_kw = coa_exempt_keywords(db)`. Second site `:10326`
`from lims_analyses.seeder import _micro_group_keywords as _micro_kws` → same swap
(`coa_exempt_keywords as _micro_kws` keeps the local alias, or rename the local — implementer's
choice, keep it readable).

- [ ] **Step 4: Run — PASS**, plus `python -m pytest tests/ -q -k "coa or preflight or block"` and diff the failure set.
- [ ] **Step 5: Commit** — `feat(s2): COA gate keys on departments via transition union; HM exempt per 2026-08-12 ruling`

---

### Task 10: FE wave

**Files:**
- Modify: `src/lib/api.ts` (`:5264`, `:5337` add-to-worksheet payload types; worksheet-item type `:5144/:5188`; inbox types)
- Modify: `src/components/hplc/WorksheetsInboxPage.tsx` (`:291-354`), `src/hooks/use-worksheet-drawer.ts` (`:130`)
- Modify: `src/components/hplc/WorksheetDrawer.tsx` (`:290`), `src/components/hplc/WorksheetDrawerItems.tsx` (`:239-244`), `src/components/hplc/WorksheetDropPanel.tsx` (`:128, :250`), `src/components/hplc/AddSamplesModal.tsx` (`:95-97, :116`)
- Modify: `src/components/hplc/ServiceGroupsPage.tsx` (read-only + banner)
- Test: existing vitest suites + `npm run typecheck && npm run lint && npm run ast:lint`

**Interfaces:**
- Consumes: backend accepts `department_id` on add/staging payloads (Task 5); inbox `group_id` now carries the department id (Task 7); item dicts carry `department_id` (Task 8).

- [ ] **Step 1: Wire types.** In `api.ts`: add-to-worksheet payloads get `department_id?: number` and `service_group_id` becomes optional (`service_group_id?: number`); worksheet-item type gains `department_id: number | null`. Add a comment on the inbox analysis type noting `group_id/group_name/group_color` now carry the DEPARTMENT identity (S2).
- [ ] **Step 2: Flip senders.** `WorksheetsInboxPage.tsx` add calls send `department_id: dragData.groupId` (the inbox's `group_id` IS the department id after Task 7) and stop sending `service_group_id`. Same for the bulk staging update sender (find it via the `BulkInboxUpdate` endpoint usage) and `use-worksheet-drawer.ts:130` payload type.
- [ ] **Step 3: Storage keys (RULED: one-time cosmetic loss accepted).** `WorksheetDrawer.tsx:290`: write/read `prep_started:${item.sampleId}-d${item.departmentId}` when the item has a department, falling back on READ to the legacy `prep_started:${item.sampleId}-${item.serviceGroupId}` key when the new key is absent. React/SLA-map keys in `WorksheetDropPanel.tsx:128/:250` and `AddSamplesModal.tsx:95-97/:116`: prefer `${sample_uid}|d${department_id}` when `department_id` is present, else the legacy `${sample_uid}|${service_group_id}` shape (pure key-shape change; snapshot maps keep working for legacy items).
- [ ] **Step 4: ServiceGroupsPage read-only.** Remove/disable create, edit-name, and delete affordances (the backend now 410s/400s/409s them); keep the member list visible; add a banner at the top: `Legacy — departments own routing now. Groups remain for historical rows and SLA tiers.` Membership editing stays functional (backend keeps `PUT /members` open until the gate union has bedded in).
- [ ] **Step 5: Gates.** `npm run typecheck && npm run lint && npm run ast:lint`, then `npm run test:run` — diff vitest failures against a pre-change run (schema-ahead/live flakes excluded).
- [ ] **Step 6: Commit** — `feat(s2): FE sends department; dept-shaped storage keys with legacy fallback; groups page frozen`

---

### Task 11: Full-suite failure-set gate

- [ ] **Step 1:** `cd C:\tmp\Accu-Mk1-s2-worksheets\backend` then run the FULL suite once (NOT concurrently with any other worktree's suite): `python -m pytest tests/ -q 2>&1 | tail -40`.
- [ ] **Step 2:** Extract the sorted FAILED-test-id set and diff against the baseline set (`C:/Users/forre/AppData/Local/Temp/claude/C--Users-forre-OneDrive-Documents-GitHub-Accumark-Workspace/5469cda1-d3cd-413c-9736-0d8229e79f9e/scratchpad/baseline-failed-set.txt`). Investigate every NEW failure: isolated re-run first; if it persists, differential-run in an untouched worktree at `b30d9fc0` before treating it as an S2 regression.
- [ ] **Step 3:** `npm run check:all` in the worktree root; compare against the S1 session's precedent (FE baseline should be clean).
- [ ] **Step 4:** Fix regressions; commit as `fix(s2): …`.

## Non-goals (do not touch)

No group-row deletion; no SLA re-key (S7 owns `SlaPriorityTier`); no `worksheets.department_id`;
no healing of historical NULL-group items; no SENAITE mirror changes; no retirement of
`service_group_name` display fields on senaite analysis payloads; `vial-quicklook-helpers.tsx`'s
hardcoded `'Analytics'` stays (known-inert in prod, out of scope); `product-completion.ts`
group-name bucketing stays.
