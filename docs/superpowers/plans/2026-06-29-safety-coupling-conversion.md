# Safety-Coupling Conversion (Plan 1B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the four name-/id-pinned test-grouping couplings (HPLC-mirror exclude, sub-sample stale-row cleanup, worksheet inbox lane filter, and the FE bench badge) to key off the catalog **Department** added in Plan 1A — making the HPLC-mirror exclude **fail closed** — so the Sterility-PCR group (a new Microbiology-department group, created in Plan 1C) routes correctly and can never leak onto chromatography vials. Behavior is unchanged for the existing two-group (Analytics/Microbiology) world; the only new property is the fail-closed default.

**Architecture:** Each coupling currently answers an intake question with a literal group **name** (`_NON_HPLC_GROUPS`, `_ROLE_GROUP_NAMES`, `ROLE_TO_GROUP_NAMES`) or group **id** (`itemBench` `=== 1/2`). We repoint each to the service/group's single `department_id` (the deterministic structural routing key from 1A). The HPLC mirror flips from an exclude-Microbiology **deny-list** (default = leak onto HPLC vials) to an `== Analytical` **allow-list** (default = exclude). That allow-list would drop the 12 ungrouped `ANALYTE-N-*` generic per-analyte services (`department_id IS NULL`) — the mirror's safety-fallback rows — so Task 1 first tags them Analytical in the backfill, making `NULL` mean "unknown → exclude" without losing legitimate analyte data.

**Tech Stack:** Python 3 / FastAPI, SQLAlchemy 2.0 (`mapped_column` style), pytest against the **live Postgres catalog** for seeder/mirror tests (`SessionLocal`) and in-memory SQLite for catalog-unit tests. Frontend TypeScript + Vitest 4 (`src/lib/__tests__`). No Alembic in Accu-Mk1 (idempotent raw SQL in `backend/database.py::_run_migrations`; the backfill runs from `init_db`).

## Global Constraints

- **Additive / behavior-preserving for existing data.** For the current Analytics+Microbiology world every converted path MUST return the *same* bucket/demand/lane it returns today. The only intended new behavior is the HPLC mirror's fail-closed default. (spec: Locked decision 7; "Safe-cutover procedure" steps 4-5)
- **Department is the single structural routing key.** `Analytics → Analytical`; `Microbiology → Microbiology`; `Endotoxin → Microbiology`. `ENDO-LAL` is a Microbiology-department service regardless of its group. (spec: Invariants; `catalog/departments.py`)
- **Fail closed on the HPLC mirror.** A service is mirrored onto an HPLC vial **only if** its department is Analytical. NULL / mis-tagged / Microbiology → excluded. Lock with a regression test asserting no Microbiology-department service ever lands on an HPLC vial's seeded set. (spec: "Safety-coupling conversion")
- **Execute locally + test on the 3101 wave1 stack.** Edit `C:/tmp/accu-mk1-wave1/` (3101/8012 bind-mount it). The backend has **no `--reload`** — after any `backend/` edit, `docker restart accu-mk1-backend` (re-runs `init_db` → idempotent migrations + backfill). pytest is installed in the container (9.1.1). (handoff gotchas; user override of the devbox default)
- **Never `git add -A`/`git add .`** — the worktree carries pre-existing dirty files that are not ours (`scripts/deploy.sh`, `docker-compose.*.bak-*`, handoff docs). Stage explicit paths only. (handoff gotcha)
- **GitNexus impact analysis is mandated but the index is stale + points at the main checkout** (handoff gotcha). It would be inaccurate for this worktree, so impact analysis is **deferred** for this plan; the blast radius is small and enumerated per task (single predicate per coupling, all consumers grepped in this plan). Flag the deferral to the user; re-index if the branch settles and accurate impact is needed.
- **npm only** for frontend tooling (never pnpm). Backend deps unchanged.
- TDD, one assertion-focused test per behavior, frequent commits, explicit `git add` paths.

---

## File Structure

- **Modify** `backend/catalog/departments.py` — add `department_id_by_name(db, name)` helper; guard backfill step 2 (`if … is None`); add step 4 tagging ungrouped `ANALYTE-%` services → Analytical. (Task 1)
- **Modify** `backend/lims_analyses/seeder.py` — replace the `_micro_group_keywords` / `_NON_HPLC_GROUPS` exclude with an `== Analytical` department allow-list in `mirror_parent_hplc_analyses`; delete the now-dead deny-list helper. (Task 2)
- **Modify** `backend/sub_samples/service.py` — `_ROLE_GROUP_NAMES` → `_ROLE_DEPARTMENT_NAMES`; `_drop_stale_role_rows` selects stale services by `department_id`. (Task 3)
- **Modify** `backend/main.py` — `ROLE_TO_GROUP_NAMES` → `ROLE_TO_DEPARTMENT_NAME` + department-join in the inbox lane resolver (Task 4); emit `department_name` on worksheet items (Task 5).
- **Modify** `src/lib/inbox-filters.ts` — `itemBench` keys on department name; `itemRoleBadges` takes `department_name`. (Task 6)
- **Modify** `src/components/hplc/WorksheetDropPanel.tsx` — pass `item.department_name`; add `department_name` to `WorksheetSummaryItem`. (Task 6)
- **Modify/Create tests** — `backend/tests/test_departments_catalog.py` (Task 1), `backend/tests/test_seeder_mirror.py` (Task 2), `backend/tests/test_assign_role_fail_hard.py` or a new `test_drop_stale_role_rows.py` (Task 3), `backend/tests/test_worksheets_inbox.py` (Tasks 4-5), `src/lib/__tests__/inbox-filters.test.ts` (Task 6).

**Dependency order:** Task 1 → Task 2 (the allow-list needs `ANALYTE-%` tagged Analytical first, or `test_mirror_falls_back_to_generic_when_no_per_substance` regresses). Task 5 → Task 6 (the FE needs the `department_name` field). Tasks 3 and 4 are independent but assume Task 1's departments exist (they do — shipped in 1A).

---

## Task 1: Backfill hardening — ownership guard + ungrouped-analytical tagging

**Files:**
- Modify: `backend/catalog/departments.py` (add helper; guard step 2; add step 4)
- Test: `backend/tests/test_departments_catalog.py`

**Interfaces:**
- Produces: `department_id_by_name(db: Session, name: str) -> Optional[int]` — id of the named department, or `None`. Consumed by Tasks 2-4.
- Produces (behavior): after `backfill_departments(db)`, every `analysis_services` row whose `keyword LIKE 'ANALYTE-%'` has `department_id` = the Analytical department id; a `service_groups.department_id` that was already set is **never** overwritten.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_departments_catalog.py` (the `db_session` fixture + `Department`/`ServiceGroup`/`AnalysisService` imports already exist in this file from Plan 1A):

```python
def test_backfill_does_not_overwrite_existing_group_department(db_session):
    """Review follow-up #4a: a manually-reassigned group.department_id survives a
    re-run (backfill owns NULLs only, not a foot-gun once a UI can reassign)."""
    from models import Department, ServiceGroup
    from catalog.departments import backfill_departments
    # Seed a group whose name maps to Analytical, but pin it to Microbiology by hand.
    backfill_departments(db_session)  # creates Analytical + Microbiology
    analytical = db_session.query(Department).filter_by(name="Analytical").one()
    micro = db_session.query(Department).filter_by(name="Microbiology").one()
    g = ServiceGroup(name="Analytics", department_id=micro.id)  # deliberately "wrong"
    db_session.add(g)
    db_session.commit()
    backfill_departments(db_session)  # re-run must NOT clobber the manual choice
    assert db_session.get(ServiceGroup, g.id).department_id == micro.id


def test_backfill_tags_ungrouped_analyte_services_analytical(db_session):
    """The ungrouped ANALYTE-N-* generics (the HPLC-mirror fallback rows) get the
    Analytical department so the fail-closed allow-list (Task 2) keeps them."""
    from models import Department, AnalysisService
    from catalog.departments import backfill_departments
    svc = AnalysisService(keyword="ANALYTE-1-PUR", title="Analyte 1 (Purity)", category="Peptide Analysis")
    db_session.add(svc)
    db_session.commit()
    assert svc.department_id is None  # ungrouped → starts NULL
    backfill_departments(db_session)
    analytical = db_session.query(Department).filter_by(name="Analytical").one()
    assert db_session.get(AnalysisService, svc.id).department_id == analytical.id
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py::test_backfill_does_not_overwrite_existing_group_department tests/test_departments_catalog.py::test_backfill_tags_ungrouped_analyte_services_analytical -q'`
Expected: FAIL — the overwrite test fails (step 2 currently reassigns unconditionally → group flips back to Analytical); the ANALYTE test fails (`department_id` stays `None`).

- [ ] **Step 3: Add the helper + guard step 2 + add step 4**

In `backend/catalog/departments.py`, add the helper after `department_for_group_name`:

```python
def department_id_by_name(db: Session, name: str) -> Optional[int]:
    """Return the id of the department with this name, or None if absent."""
    from models import Department
    row = db.query(Department).filter_by(name=name).one_or_none()
    return row.id if row else None
```

In `backfill_departments`, replace step 2's loop body to guard on NULL, and add step 4 after step 3:

```python
    # 2. Assign each group's department_id from its name — ONLY when unset, so a
    #    later manual reassignment (admin/UI) is never clobbered by a restart.
    for group in db.query(ServiceGroup).all():
        if group.department_id is not None:
            continue
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

    # 4. Tag the ungrouped generic per-analyte services (ANALYTE-N-*) onto the
    #    Analytical bench. They carry no group (steps 2-3 leave them NULL) but are
    #    unambiguously analytical — the HPLC mirror seeds them. Tagging them lets
    #    the fail-closed HPLC allow-list (Plan 1B Task 2) treat NULL as
    #    "unknown → exclude" without dropping these legitimate analyte rows.
    analytical_id = by_name["Analytical"].id
    for svc in db.query(AnalysisService).filter(
        AnalysisService.department_id.is_(None),
        AnalysisService.keyword.like("ANALYTE-%"),
    ).all():
        svc.department_id = analytical_id

    db.commit()
```

(The existing `db.commit()` at the end of the function is replaced by the one above — do not leave two.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py -q'`
Expected: PASS (all departments-catalog tests, including the two new ones and the Plan 1A idempotency test).

- [ ] **Step 5: Apply to the live 3101 DB + verify the 12 ANALYTE-N are now Analytical**

Run: `docker restart accu-mk1-backend` (re-runs `init_db` → `backfill_departments`).
Then: `docker exec accu-mk1-backend sh -c 'cd /app && python -c "from database import engine; from sqlalchemy import text; c=engine.connect(); print(list(c.execute(text(\"SELECT count(*) FROM analysis_services WHERE department_id IS NULL\"))))"'`
Expected: `[(0,)]` — no NULL-department services remain (the 12 ANALYTE-N are now Analytical).

- [ ] **Step 6: Commit**

```bash
git add backend/catalog/departments.py backend/tests/test_departments_catalog.py
git commit -m "fix(catalog): guard backfill overwrite + tag ungrouped ANALYTE-* Analytical"
```

---

## Task 2: HPLC-mirror deny-list → fail-closed Department allow-list

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (`mirror_parent_hplc_analyses` predicate; delete `_NON_HPLC_GROUPS` + `_micro_group_keywords`)
- Test: `backend/tests/test_seeder_mirror.py`

**Interfaces:**
- Consumes: `department_id_by_name(db, "Analytical")` from Task 1.
- Produces (behavior): `mirror_parent_hplc_analyses` seeds a keyword onto an HPLC vial **only if** the resolving `AnalysisService.department_id` equals the Analytical department id. The pre-existing mirror tests (`test_mirror_translates_analyte_to_per_substance`, `test_mirror_falls_back_to_generic_when_no_per_substance`) stay green **because** Task 1 tagged `ANALYTE-%` Analytical.

- [ ] **Step 1: Write the failing tests**

Append BOTH tests to `backend/tests/test_seeder_mirror.py`. The first is **the discriminator** — it is the only test in this plan that distinguishes the correct fail-closed allow-list from a fail-open deny-list (or a deny-by-department mis-implementation). The second is the spec's broad safety lock.

```python
def test_mirror_fail_closed_excludes_ungrouped_null_department_service(db, monkeypatch):
    """THE fail-closed discriminator. An unknown service with NO group membership
    and department_id=None must NOT be mirrored onto an HPLC vial.

    Goes genuinely RED on BOTH wrong implementations:
      - old exclude-Micro DENY-list: ungrouped → not in micro_kw → leaks (RED)
      - deny-by-department mis-impl (`== micro_id: continue`): NULL ≠ micro → leaks (RED)
    GREEN only on the correct `== Analytical` allow-list: NULL → excluded.

    After Task 1 the live catalog has no NULL-department services left, so the test
    MINTS one — which is exactly the 'unknown service' case the fail-closed default
    exists to catch. The whole-catalog `svc_by_kw` select inside the mirror sees this
    flushed throwaway row in-session; commit=False + the fixture rollback discards it."""
    from models import AnalysisService
    vial = _throwaway_vial(db)
    rogue = AnalysisService(keyword="ZZTEST-ROGUE", title="Rogue (untagged)", department_id=None)
    db.add(rogue)
    db.flush()  # has an id + is visible to the mirror's catalog select within this session
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["HPLC-ID", "ZZTEST-ROGUE"])
    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False)
    seeded = {r.keyword for r in inserted}
    assert "ZZTEST-ROGUE" not in seeded   # fail-closed: unknown/NULL-department excluded
    assert "HPLC-ID" in seeded            # legitimate Analytical service still mirrored


def test_mirror_excludes_every_microbiology_department_service(db, monkeypatch):
    """Broad safety lock: NO Microbiology-department service is ever mirrored onto an
    HPLC vial, regardless of which group it sits in (spec: 'no Microbiology service
    ever appears on an HPLC vial's seeded set'). Passes on the old deny-list too (all
    5 Micro services are grouped) — it is a lock, not the discriminator above."""
    from models import AnalysisService, Department
    vial = _throwaway_vial(db)
    micro_kws = db.execute(
        select(AnalysisService.keyword)
        .join(Department, Department.id == AnalysisService.department_id)
        .where(Department.name == "Microbiology", AnalysisService.keyword.isnot(None))
    ).scalars().all()
    assert micro_kws, "live catalog should carry Microbiology-department services"
    parent_keywords = ["HPLC-ID", "BLEND-PUR", "PEPT-Total", *micro_kws]
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords", lambda pid: parent_keywords)
    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False)
    seeded = {r.keyword for r in inserted}
    assert seeded.isdisjoint(set(micro_kws))               # no Micro service leaked
    assert {"HPLC-ID", "BLEND-PUR", "PEPT-Total"} <= seeded  # analytical still mirrored
```

- [ ] **Step 2: Run the discriminator to verify it fails on the current (deny-list) code**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_seeder_mirror.py::test_mirror_fail_closed_excludes_ungrouped_null_department_service -q'`
Expected: **FAIL** — the current deny-list seeds `ZZTEST-ROGUE` (ungrouped → not excluded → leaks). This is the genuine RED that proves the conversion is doing real work. (The broad lock `test_mirror_excludes_every_microbiology_department_service` is a baseline-PASS on the old code — run it too and note the PASS in the progress log; it is not the discriminator.)

- [ ] **Step 3: Convert the predicate to an allow-list**

In `backend/lims_analyses/seeder.py`, inside `mirror_parent_hplc_analyses`, replace the micro-keyword resolution and the exclude check.

Replace (the `micro_kw` resolution near the top of the function body):

```python
    # Keywords to drop: the Microbiology group (ENDO-LAL/STER-PCR/KF).
    micro_kw = _micro_group_keywords(db)
```

with:

```python
    # Fail-closed allow-list: only Analytical-department services mirror onto HPLC
    # vials. A Microbiology / NULL / mis-tagged service is excluded by default, so
    # it can never leak onto a chromatography vial (was: exclude-known-Micro
    # deny-list, which defaulted to "contaminate the HPLC vial").
    analytical_dept_id = department_id_by_name(db, "Analytical")
```

Replace the exclude check:

```python
        if svc.keyword in micro_kw:   # Microbiology analysis (ENDO-LAL/STER-PCR/KF)
            continue
```

with:

```python
        if svc.department_id != analytical_dept_id:   # fail-closed: Analytical only
            continue
```

Add the import near the top of `seeder.py` (with the other imports):

```python
from catalog.departments import department_id_by_name
```

Delete the now-dead deny-list helper and constant (`_NON_HPLC_GROUPS` at ~line 109 and the whole `_micro_group_keywords` function at ~lines 112-132). If removing them leaves an unused `service_group_members` / `ServiceGroup` import in `seeder.py`, remove those names from the import too (verify with `ruff check`).

- [ ] **Step 4: Run the full mirror suite**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_seeder_mirror.py -q'`
Expected: PASS for all tests — including `test_mirror_falls_back_to_generic_when_no_per_substance` (the `ANALYTE-2-PUR` fallback row is Analytical after Task 1, so the allow-list keeps it) and the new exclusion test.

- [ ] **Step 5: Lint + live restart**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && ruff check lims_analyses/seeder.py'` (expect no errors / no unused-import warnings).
Run: `docker restart accu-mk1-backend` (the mirror is import-fresh in tests, but restart so the live `:8012` server runs the new predicate).

- [ ] **Step 6: Commit**

```bash
git add backend/lims_analyses/seeder.py backend/tests/test_seeder_mirror.py
git commit -m "feat(catalog): fail-closed Department allow-list for HPLC mirror"
```

---

## Task 3: Sub-sample stale-row cleanup → Department

**Files:**
- Modify: `backend/sub_samples/service.py` (`_ROLE_GROUP_NAMES` → `_ROLE_DEPARTMENT_NAMES`; `_drop_stale_role_rows`)
- Modify: `backend/tests/test_catalog_parity.py` (it imports the renamed symbol — update import + the role-map assertion)
- Modify: `backend/catalog/departments.py` (the module docstring names `_ROLE_GROUP_NAMES` — renamed by this task — so reword it to drop symbol-name coupling. Note: `_NON_HPLC_GROUPS` was RETAINED by Task 2's fix, kept for the COA gate, so it is not defunct; the reword simply stops naming specific literals for durability)
- Test: `backend/tests/test_drop_stale_role_rows.py` (new)

**Interfaces:**
- Consumes: `AnalysisService.department_id` (Task 1), `Department` model.
- Produces (behavior): `_drop_stale_role_rows` deletes a vial's unassigned/no-result rows whose service's **department** belongs to the old role's department set but not the new role's — same outcome as today for Analytics/Microbiology, but robust to new groups within a department.
- **Cross-task coupling:** `backend/tests/test_catalog_parity.py:4,19` imports and asserts on `_ROLE_GROUP_NAMES` (the symbol this task renames). It MUST be updated in this task or the suite breaks with `ImportError`. The renamed map now holds **department** names, so its parity assertion changes from "every group name resolves to a department" to "every department name in the map is a seeded department".

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_drop_stale_role_rows.py` (live-catalog pattern, mirrors `test_seeder_mirror.py`):

```python
"""Role-flip stale-row cleanup keys off Department, not group name.

Live Postgres session (real catalog); throwaway ZZTEST vial seeded with
commit=False, discarded by the fixture rollback. A hplc→ster flip must drop the
vial's unassigned Analytical-department rows; an Analytical row with a result is
never touched."""
import pytest
from sqlalchemy import select

from models import LimsAnalysis, LimsSample, LimsSubSample, AnalysisService, Department
from sub_samples.service import _drop_stale_role_rows
from database import SessionLocal


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _vial(db):
    parent = LimsSample(sample_id="ZZTEST-STALE", external_lims_uid="zz-stale")
    db.add(parent); db.flush()
    v = LimsSubSample(sample_id="ZZTEST-STALE-S01", vial_sequence=0,
                      parent_sample_pk=parent.id, external_lims_uid="zz-vstale")
    db.add(v); db.flush()
    return v


def test_hplc_to_ster_drops_unassigned_analytical_rows(db):
    v = _vial(db)
    analytical_svc = db.execute(
        select(AnalysisService).join(Department, Department.id == AnalysisService.department_id)
        .where(Department.name == "Analytical").limit(1)).scalars().one()
    row = LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=analytical_svc.id,
                       keyword=analytical_svc.keyword, title=analytical_svc.title or analytical_svc.keyword,
                       review_state="unassigned")
    db.add(row); db.flush()
    n = _drop_stale_role_rows(db, sub=v, old_role="hplc", new_role="ster")
    assert n == 1
    remaining = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().all()
    assert remaining == []


def test_cleanup_never_touches_rows_with_a_result(db):
    v = _vial(db)
    analytical_svc = db.execute(
        select(AnalysisService).join(Department, Department.id == AnalysisService.department_id)
        .where(Department.name == "Analytical").limit(1)).scalars().one()
    row = LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=analytical_svc.id,
                       keyword=analytical_svc.keyword, title=analytical_svc.title or analytical_svc.keyword,
                       review_state="unassigned", result_value="99.1")
    db.add(row); db.flush()
    n = _drop_stale_role_rows(db, sub=v, old_role="hplc", new_role="ster")
    assert n == 0  # has a result → never deleted
```

- [ ] **Step 2: Run to verify it passes against the CURRENT code (baseline)**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_drop_stale_role_rows.py -q'`
Expected: PASS under the current group-name implementation (this is a **characterization** baseline — it pins the behavior the conversion must preserve). Record the baseline PASS; the conversion must keep it green.

- [ ] **Step 3: Convert `_ROLE_GROUP_NAMES` → `_ROLE_DEPARTMENT_NAMES`**

In `backend/sub_samples/service.py`, replace the module constant (~line 31):

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

In `_drop_stale_role_rows`, replace the group-name resolution and the svc-id query:

```python
    old_depts = _ROLE_DEPARTMENT_NAMES.get(old_role, set())
    new_depts = _ROLE_DEPARTMENT_NAMES.get(new_role or "", set())
    clear_depts = old_depts - new_depts
    if not clear_depts:
        return 0
    from models import LimsAnalysis, LimsAnalysisTransition, AnalysisService, Department
    dept_ids = db.execute(
        select(Department.id).where(Department.name.in_(clear_depts))
    ).scalars().all()
    if not dept_ids:
        return 0
    # candidate analysis_service ids whose home department we're clearing
    svc_ids = db.execute(
        select(AnalysisService.id).where(AnalysisService.department_id.in_(dept_ids))
    ).scalars().all()
    if not svc_ids:
        return 0
```

(Everything below — the `stale` query filtering `review_state == "unassigned"`, `result_value.is_(None)`, `retest_of_id.is_(None)`, and the delete loop — stays unchanged. The old `from models import … ServiceGroup, service_group_members` line is replaced by the `… Department` import above.)

- [ ] **Step 3b: Update the dependent parity test (`test_catalog_parity.py`)**

`backend/tests/test_catalog_parity.py` imports `_ROLE_GROUP_NAMES` (line 4) and asserts on it (line 19) — the rename breaks it with `ImportError`, and the map now holds **department** names, so the assertion's premise changes. Update the import and that one test:

```python
from catalog.departments import department_for_group_name, DEPARTMENT_NAMES
from sub_samples.service import _ROLE_DEPARTMENT_NAMES
```

```python
def test_every_role_department_name_is_a_seeded_department():
    # Every department named in the role->department map must be a real seeded
    # department (post-conversion parity: the map holds department names now).
    for role, dept_names in _ROLE_DEPARTMENT_NAMES.items():
        for dname in dept_names:
            assert dname in DEPARTMENT_NAMES, f"role {role!r} dept {dname!r} not seeded"
```

(The other two parity tests — `test_known_group_names_map_to_expected_departments`, `test_unknown_group_name_returns_none` — are unchanged: `department_for_group_name` still maps the live **group** names.)

- [ ] **Step 3c: Drop the stale symbol reference from `catalog/departments.py`**

The module docstring (line ~5) names `sub_samples.service._ROLE_GROUP_NAMES` — renamed by this task to `_ROLE_DEPARTMENT_NAMES`, so the reference is stale. (`lims_analyses.seeder._NON_HPLC_GROUPS`, also named there, was RETAINED by Task 2's fix for the COA gate — it is NOT defunct.) Reword the docstring to describe the mapping without coupling to specific literal names, e.g.:

```python
"""Catalog department assignment.

Single source of truth for which top-level Department a service group belongs to.
Analytics is the Analytical bench; Microbiology and Endotoxin are both the
Microbiology bench. (Plan 1B repointed the former hardcoded routing literals at
this mapping.)
"""
```

- [ ] **Step 4: Run the tests to verify everything passes**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_drop_stale_role_rows.py tests/test_catalog_parity.py tests/test_assign_role_fail_hard.py -q'`
Expected: PASS (the conversion preserves behavior; the renamed parity test and the broader role tests stay green).

- [ ] **Step 5: Restart + commit**

```bash
docker restart accu-mk1-backend
git add backend/sub_samples/service.py backend/tests/test_drop_stale_role_rows.py backend/tests/test_catalog_parity.py backend/catalog/departments.py
git commit -m "feat(catalog): role-flip stale cleanup keys off Department"
```

---

## Task 4: Worksheet inbox lane filter → Department

**Files:**
- Modify: `backend/main.py` (`ROLE_TO_GROUP_NAMES` → `ROLE_TO_DEPARTMENT_NAME` at ~line 14264; lane resolver at ~line 14567)
- Test: `backend/tests/test_worksheets_inbox.py`

**Interfaces:**
- Consumes: `ServiceGroup.department_id` (Task 1), `Department` model.
- Produces (behavior): the inbox `role` query param resolves `allowed_group_ids` = every group whose **department** matches the role's department (`hplc → Analytical`, `microbiology → Microbiology`), so a new Microbiology-department group (Sterility PCR) is included in the micro lane automatically. `ROLE_TO_VIAL_ROLES` and `VALID_INBOX_ROLES` are unchanged.
- **Cross-task coupling:** `backend/tests/test_worksheets_inbox.py:18` imports `ROLE_TO_GROUP_NAMES` and asserts on it (lines 57-58: `"Analytics" in ROLE_TO_GROUP_NAMES["hplc"]`). The rename breaks both — update that import and those two assertions in this task (Step 3b) or the suite breaks with `ImportError`. `ROLE_TO_VIAL_ROLES` / `VALID_INBOX_ROLES` assertions in the same file are untouched.

- [ ] **Step 1: Write the failing discriminating test**

Task 4 extracts the inline resolver into a module-level helper `_inbox_allowed_group_ids(db, role)` so the behavior is unit-testable against **real code** (not a replicated query). Append to `backend/tests/test_worksheets_inbox.py` a test that mints a Microbiology-**department** group with a **non-"Microbiology" name** and asserts the helper includes it — RED on the old name-pinned `ROLE_TO_GROUP_NAMES`, GREEN on the department-keyed helper:

```python
def test_inbox_helper_includes_new_microbiology_department_group(monkeypatch):
    """A new Microbiology-DEPARTMENT group with a different NAME lands in the micro
    lane — the behavioral win. RED if the resolver ever name-pins again. Throwaway
    group is created + rolled back; never committed to the live catalog."""
    from sqlalchemy import select
    from database import SessionLocal
    from models import ServiceGroup, Department
    from main import _inbox_allowed_group_ids
    db = SessionLocal()
    try:
        micro = db.execute(select(Department).where(Department.name == "Microbiology")).scalars().one()
        g = ServiceGroup(name="ZZTEST Sterility PCR", department_id=micro.id)
        db.add(g)
        db.flush()  # visible in-session to the helper's query
        allowed = _inbox_allowed_group_ids(db, "microbiology")
        assert g.id in allowed                       # new same-department group is in the lane
        assert _inbox_allowed_group_ids(db, None) is None  # no role → no filter
    finally:
        db.rollback()
        db.close()
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_worksheets_inbox.py::test_inbox_helper_includes_new_microbiology_department_group -q'`
Expected: FAIL with `ImportError: cannot import name '_inbox_allowed_group_ids' from 'main'`.

- [ ] **Step 3: Convert the constant + extract the resolver helper**

In `backend/main.py`, replace `ROLE_TO_GROUP_NAMES` (~line 14264) and keep `VALID_INBOX_ROLES`, then add the helper:

```python
# Role → DEPARTMENT name. Department drives the lane: a new Microbiology-department
# group (e.g. Sterility PCR) lands in the micro lane automatically, no name-pinning.
ROLE_TO_DEPARTMENT_NAME: dict[str, str] = {
    "hplc": "Analytical",
    "microbiology": "Microbiology",
}
VALID_INBOX_ROLES = set(ROLE_TO_DEPARTMENT_NAME.keys())


def _inbox_allowed_group_ids(db, role: Optional[str]) -> Optional[set[int]]:
    """Resolve a worksheet-inbox role to the set of service-group ids in that
    role's DEPARTMENT. None role → None (no filter; pass all groups). Keying on
    Department (not group name) means every group in the department — including a
    newly-created Sterility-PCR group — is in the lane."""
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

Replace the inline lane resolver (~line 14564-14572) with a call to the helper:

```python
    # Resolve role → allowed service_group IDs. None means "no filter; pass all groups".
    allowed_group_ids: Optional[set[int]] = _inbox_allowed_group_ids(db, role)
```

(`ROLE_TO_VIAL_ROLES` immediately below is unchanged — it filters the vial `assignment_role` column, which is orthogonal to groups.)

- [ ] **Step 3b: Update the existing assertions in `test_worksheets_inbox.py`**

That file's import (line 18) and two assertions (lines 57-58) reference the renamed `ROLE_TO_GROUP_NAMES`. Update the import and rewrite those assertions to the new constant's semantics (a dict of role → single department **name**):

```python
from main import app, ROLE_TO_VIAL_ROLES, VALID_INBOX_ROLES, ROLE_TO_DEPARTMENT_NAME, _inbox_allowed_group_ids
```

Replace the two `ROLE_TO_GROUP_NAMES` assertions (lines ~57-58) with:

```python
    assert ROLE_TO_DEPARTMENT_NAME["hplc"] == "Analytical"
    assert ROLE_TO_DEPARTMENT_NAME["microbiology"] == "Microbiology"
```

(The `ROLE_TO_VIAL_ROLES` and `VALID_INBOX_ROLES` assertions in the same test are unchanged — those symbols keep their values.)

- [ ] **Step 4: Run to verify it passes**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_worksheets_inbox.py -q'`
Expected: PASS (the new helper test + the updated assertions + all existing inbox tests).

- [ ] **Step 5: Restart + live smoke (lane still returns the micro group)**

Run: `docker restart accu-mk1-backend`
Run: `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8012/worksheets/inbox?role=microbiology"`
Expected: `401` (registered + auth-gated; not `404`/`500`). The conversion is parity-preserving for the live two-group catalog.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_worksheets_inbox.py
git commit -m "feat(catalog): inbox lane filter resolves groups by Department"
```

---

## Task 5: Emit `department_name` on worksheet items (FE plumbing, backend half)

**Files:**
- Modify: `backend/main.py` (group resolution at ~line 15501; item serialization at ~line 15611)
- Test: `backend/tests/test_worksheets_inbox.py`

**Interfaces:**
- Produces: each serialized worksheet item gains `"department_name": str | None` — the name of the item's service-group's department (from the group's `department_id`), or `None` for ungrouped/unknown. Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_worksheets_inbox.py`. If the file already has a staging-worksheet fixture that exercises the items serializer, assert the new key on its output; otherwise add a serializer-shape assertion against a TestClient response that lists staging worksheets. Concretely, assert the contract that every serialized item carries the key:

```python
def test_worksheet_items_include_department_name(worksheets_inbox_client):
    """Every serialized worksheet item exposes department_name (None when the
    group has no department). worksheets_inbox_client is the module's existing
    TestClient fixture that seeds a staging worksheet with at least one item."""
    resp = worksheets_inbox_client.get("/worksheets?status=staging")
    assert resp.status_code == 200
    items = [it for ws in resp.json() for it in ws.get("items", [])]
    assert items, "fixture should seed at least one staging item"
    assert all("department_name" in it for it in items)
```

> If `test_worksheets_inbox.py` has no reusable client/fixture for the `/worksheets` list, add the field and instead assert via the live serializer: build the items dict through the same code path in a small DB-level test, or extend the nearest existing serialization test in the file. Do **not** invent a fixture that doesn't match the file's conventions — read the file first and follow its existing setup.

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_worksheets_inbox.py::test_worksheet_items_include_department_name -q'`
Expected: FAIL — `department_name` not present in the item dict.

- [ ] **Step 3: Resolve the department name per group + emit it**

In `backend/main.py`, extend the group-resolution block (~line 15500-15505) to also resolve the department name:

```python
        if group_ids:
            from models import Department
            groups = db.execute(
                select(ServiceGroup.id, ServiceGroup.name, ServiceGroup.color, Department.name)
                .outerjoin(Department, Department.id == ServiceGroup.department_id)
                .where(ServiceGroup.id.in_(group_ids))
            ).all()
            group_name_map = {g[0]: g[1] for g in groups}
            group_color_map: dict[int, str] = {g[0]: g[2] for g in groups}
            group_department_name_map: dict[int, str | None] = {g[0]: g[3] for g in groups}
```

In the item serialization (~line 15611), add the field next to `service_group_id`:

```python
                    "service_group_id": it.service_group_id,
                    "department_name": group_department_name_map.get(it.service_group_id) if it.service_group_id else None,
```

(If `group_department_name_map` is referenced in a scope where `group_ids` was empty, it is unbound — guard by initializing `group_department_name_map: dict[int, str | None] = {}` next to `group_name_map = {}` at ~line 15498, exactly as `group_name_map` is pre-initialized.)

- [ ] **Step 4: Run to verify it passes**

Run: `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_worksheets_inbox.py -q'`
Expected: PASS.

- [ ] **Step 5: Restart + commit**

```bash
docker restart accu-mk1-backend
git add backend/main.py backend/tests/test_worksheets_inbox.py
git commit -m "feat(catalog): emit department_name on worksheet items"
```

---

## Task 6: FE inbox bench badge → Department

**Files:**
- Modify: `src/lib/inbox-filters.ts` (`itemBench`, `itemRoleBadges`)
- Modify: `src/components/hplc/WorksheetDropPanel.tsx` (`WorksheetSummaryItem` type + the `itemRoleBadges` call at line 64)
- Test: `src/lib/__tests__/inbox-filters.test.ts`

**Interfaces:**
- Consumes: `department_name` on the worksheet item (Task 5).
- Produces: `itemBench(departmentName: string | null | undefined): 'hplc' | 'micro' | null` — `'Analytical' → 'hplc'`, `'Microbiology' → 'micro'`, else `null`. `itemRoleBadges({ department_name, analyses })` keys its bench off `department_name`.

- [ ] **Step 1: Rewrite the failing tests**

In `src/lib/__tests__/inbox-filters.test.ts`, replace the `itemBench` block and the `service_group_id` arguments in the `itemRoleBadges` block to key on department name:

```ts
describe('itemBench', () => {
  it('maps department names to benches', () => {
    expect(itemBench('Analytical')).toBe('hplc')
    expect(itemBench('Microbiology')).toBe('micro')
    expect(itemBench(null)).toBeNull()
    expect(itemBench('Nope')).toBeNull()
  })
})

describe('itemRoleBadges', () => {
  it('hplc (Analytical) item -> [hplc] regardless of analyses', () => {
    expect(itemRoleBadges({ department_name: 'Analytical', analyses: [{ keyword: 'X', title: 'Purity' }] })).toEqual(['hplc'])
  })
  it('endo-only micro item -> [endo]', () => {
    expect(itemRoleBadges({ department_name: 'Microbiology', analyses: [{ keyword: 'ENDO-LAL', title: 'Endotoxin' }] })).toEqual(['endo'])
  })
  it('ster-only micro item -> [ster]', () => {
    expect(itemRoleBadges({ department_name: 'Microbiology', analyses: [{ keyword: 'STER-PCR', title: 'Rapid Sterility Screening (PCR)' }] })).toEqual(['ster'])
  })
  it('mixed micro item -> [endo, ster] in stable order', () => {
    expect(itemRoleBadges({ department_name: 'Microbiology', analyses: [
      { keyword: 'STER-PCR', title: 'Rapid Sterility Screening (PCR)' },
      { keyword: 'ENDO-LAL', title: 'Endotoxin' },
    ] })).toEqual(['endo', 'ster'])
  })
  it('micro item with only moisture -> [] (no pill)', () => {
    expect(itemRoleBadges({ department_name: 'Microbiology', analyses: [{ keyword: 'KF', title: 'Moisture Content' }] })).toEqual([])
  })
  it('null department + no derivable role -> []', () => {
    expect(itemRoleBadges({ department_name: null, analyses: [] })).toEqual([])
  })
  it('unknown department with derivable hplc analysis -> [hplc]', () => {
    expect(itemRoleBadges({
      department_name: null,
      analyses: [{ keyword: 'BPC-157-PUR', title: 'Purity', peptide_name: 'BPC-157' }],
    })).toEqual(['hplc'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:run -- src/lib/__tests__/inbox-filters.test.ts`
Expected: FAIL — `itemBench('Analytical')` returns `null` (old signature expects a number); `itemRoleBadges` rejects `department_name`.

- [ ] **Step 3: Convert the helpers**

In `src/lib/inbox-filters.ts`, replace `itemBench` and the bench line in `itemRoleBadges`:

```ts
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

```ts
export function itemRoleBadges(item: {
  department_name: string | null | undefined
  analyses?: AnalysisLike[]
}): InboxRoleTag[] {
  const bench = itemBench(item.department_name)
  // …rest of the body unchanged…
```

Update the doc-comment on `MICRO_CATEGORIES` (line ~62) to drop the stale "Microbiology = group 2" wording — say "Microbiology department" instead. (The dropdown logic itself is keyword-based and needs no change.)

- [ ] **Step 4: Update the consumer + the type**

In `src/components/hplc/WorksheetDropPanel.tsx`, add `department_name` to `WorksheetSummaryItem` (keep `service_group_id` — other code still uses it):

```ts
  service_group_id: number | null
  department_name?: string | null
  group_name: string
```

Change the `itemRoleBadges` call (line 64):

```ts
  const roles = itemRoleBadges({ department_name: item.department_name, analyses: item.analyses })
```

- [ ] **Step 5: Run the FE tests + typecheck**

Run: `npm run test:run -- src/lib/__tests__/inbox-filters.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors (confirms the only two call sites — `WorksheetDropPanel.tsx:64` and the internal `inbox-filters.ts:47` — are consistent; `tsc` fails loudly on any missed consumer).

- [ ] **Step 6: Commit**

```bash
git add src/lib/inbox-filters.ts src/lib/__tests__/inbox-filters.test.ts src/components/hplc/WorksheetDropPanel.tsx
git commit -m "feat(catalog): inbox bench badge keys off Department"
```

---

## Final verification (after all six tasks)

- [ ] **Backend suite** — `docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_departments_catalog.py tests/test_catalog_parity.py tests/test_seeder_mirror.py tests/test_drop_stale_role_rows.py tests/test_worksheets_inbox.py tests/test_assign_role_fail_hard.py -q'` → all PASS.
- [ ] **Frontend** — `npm run test:run -- src/lib/__tests__/inbox-filters.test.ts` → PASS; `npm run typecheck` → clean. (Full `npm run check:all` is the user-run gate.)
- [ ] **Live DB invariant** — `docker exec accu-mk1-backend sh -c 'cd /app && python -c "from database import engine; from sqlalchemy import text; c=engine.connect(); print(list(c.execute(text(\"SELECT count(*) FROM analysis_services WHERE department_id IS NULL\"))))"'` → `[(0,)]`.
- [ ] **Live endpoints** — `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8012/worksheets/inbox?role=microbiology` → `401` (registered), backend `Up` after the final restart.
- [ ] **No stray staging** — `git status -sb` shows only the six intended file groups committed and the pre-existing non-ours dirty files untouched.

---

## Self-Review (completed during authoring)

**Spec coverage** — the spec's "Safety-coupling conversion" section names four sites + two folded-in helpers:
- HPLC-mirror exclude `_NON_HPLC_GROUPS` → **Task 2** (allow-list, fail-closed) ✓
- Inbox lane FE `inbox-filters.ts` `id===1/2` → **Task 6** (department badge) ✓ + its backend feed **Task 5** ✓
- `_ROLE_GROUP_NAMES` stale-row cleanup → **Task 3** ✓
- `ROLE_TO_GROUP_NAMES` worksheet inbox filter → **Task 4** ✓
- Precondition the spec's one-liner omitted (the ungrouped `ANALYTE-N-*` NULL-department rows the allow-list would drop) → **Task 1** ✓ (also resolves review follow-up #4a, the unconditional backfill overwrite).
- `main.py:12321` last-wins multi-group enrichment (sample-detail surface) is **out of scope** for this slice — site 2 per the spec is `inbox-filters.ts`, whose worksheet item carries a *single fixed* `service_group_id`, so its department is deterministic; the enrichment flip is a separate surface not in the named files.

**Discriminating coverage (advisor finding, fixed)** — the central safety property is now *verified*, not just asserted: Task 2's `test_mirror_fail_closed_excludes_ungrouped_null_department_service` mints an ungrouped NULL-department service and goes genuinely RED on both wrong implementations (the old exclude-Micro deny-list AND a deny-by-department mis-implementation), GREEN only on the correct `== Analytical` allow-list — the NULL-department case is the precise allow-vs-deny discriminator. Task 4 extracts `_inbox_allowed_group_ids` so its test exercises real code and a differently-named Microbiology-department group locks the behavioral win.

**Placeholder scan** — every code step carries the actual diff; the one remaining soft spot (Task 5's fixture) is an explicit executor instruction ("read the file first; if no `/worksheets?status=staging` client fixture exists, assert the `department_name` key via the serializer code path directly — do not invent a fixture"). No `TODO`/`handle edge cases`.

**Type consistency** — `department_id_by_name(db, name)` (Task 1) is the exact symbol imported in Tasks 2-4; `_ROLE_DEPARTMENT_NAMES` / `ROLE_TO_DEPARTMENT_NAME` are distinct names (module-scoped in different files); `itemBench(departmentName: string|null|undefined)` and `itemRoleBadges({ department_name, analyses })` match the Task 6 consumer call and the `WorksheetSummaryItem.department_name` field fed by Task 5's `"department_name"` JSON key.
