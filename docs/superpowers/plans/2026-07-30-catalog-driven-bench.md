# Catalog-Driven Bench (Spec 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bench catalog-driven: vial roles become DB rows auto-minted with analysis profiles, conditional vial sharing becomes ride-list data, vial↔profile custody edges persist at assignment time (ISO 17025 backbone), the assignment page renders department sections from the catalog, and every hardcoded role site converts to a fail-closed read of `vial_roles`.

**Architecture:** Accu-Mk1 only (no IS/COABuilder/WP — wire contract untouched). Branch `feat/catalog-driven-bench` from `feat/catalog-order-routing` @ `ef1eddb`, worktree `C:\tmp\Accu-Mk1-bench`. New tables `vial_roles`, `profile_ride_hosts`, `vial_profile_assignments`, `bench_stations` land via the raw-SQL migration list + `create_all` idiom; seeds follow `profile_seed.py`. Demand v2 (anchors→riders resolution) extends `catalog_demand.py`; custody edges join `set_assignment_role`'s existing single-commit transaction; the AssignStep keeps its generic components (`Bucket`/`SubDropZone`/`VarianceDropZone`) and replaces only the hardcoded layout core with a sections map.

**Tech Stack:** FastAPI + SQLAlchemy + Postgres (raw idempotent migration list), React 19 + TanStack Query + dnd-kit, pytest + vitest.

**Spec:** `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-07-31-catalog-driven-bench-design.md`

## Deliberate deviations from the spec (recon-driven, cite this section when questioned)

1. **`sla_days` does not exist anywhere in the repo.** Group SLA is `service_groups.sla_tier_id` FK → `sla_tiers.target_minutes` (minutes). Spec says "matching the group column's semantics" — so the profile column is **`sla_tier_id` FK**, not a days integer (Task 11).
2. **`vial_roles.department_id` is NULLABLE**, not NOT NULL as the spec table says: `xtra` is the reserved unassigned bucket with NO department (`_ROLE_DEPARTMENT_NAMES["xtra"] = set()`). Rule: `xtra` is the only NULL-department row; the API refuses NULL department for any other role.
3. **Seed flags are parity-exact with live code, not the spec's parenthetical.** Live `_VARIANCE_INELIGIBLE_ROLES = {"hm"}` means hplc/endo/ster/xtra are ALL variance-eligible today (endo/ster have live variance drop zones); live `BOXABLE_ROLES = {"hplc","endo","ster","xtra"}` includes xtra. Seeds mirror the code. The spec's "(hplc variance-eligible)" and "(hplc/endo/ster boxable)" are stale vs code — code wins.
4. **hm stays `boxable=false` at seed.** Making hm boxable reverses a recorded spec-3 ruling and owes a rehearsal proof spec 3 never produced (ledger task-9-report.md:923-928, 985-993). The conversion makes boxability data-driven, so the Handler flips the flag in the admin UI after the rehearsal proof — no code change, ruling not reversed in code. Tests exercise the boxable=true path with a test role.
5. **"Custody edges written in the same transaction as the plan" = per-vial atomicity.** Whole-plan atomicity does not exist (`compute_vial_plan` :1346-1366 commits per vial by accepted spec-3 decision). Edges are written inside `set_assignment_role`'s single-commit transaction — both the drag path and the auto-assign path converge there, so one insertion point covers both.
6. **Seeder falls back when no custody edges exist.** Three seed callers bypass `set_assignment_role` (`sub_samples/service.py:668` create path, `lims_analyses/service.py:1599` family reseed, `:1996` peptide-swap reseed). Seeding reads edges first; if a catalog-role vial has none, it falls back to the current fulfilling-profiles predicate and logs `catalog_seed_no_custody_fallback` (additive safety, never a silent drop).
7. **Handler open questions answered provisionally, both catalog-editable so a ruling flips them without code:** (Q1) auto-minted roles default `boxable=false` until G-STATION; (Q2) bench scan-in is SOFT custody — records the event, never gates result entry.

## Global Constraints

- **Additive only.** Failing tests default to "test is stale"; production-behavior changes need sign-off. Display changes mandated by the spec (section header "Analyses Dept." → real department name) are called out per-task for UAT.
- **Zero-clamp rider (ledger constraint 1, verbatim):** while the shadow-compare lives, a new profile mapped onto a legacy role (`hplc`/`endo`/`ster`) with `vials_required > 0` is zero-clamped whenever its key is absent from an order's legacy flags. POST/PATCH 400 on legacy roles for non-legacy keys and on `fulfillment_role == "xtra"` for every profile — these riders CARRY OVER unchanged. Any seeding path writes via ORM and is UNGUARDED — seeds must never assign legacy roles to non-legacy profiles.
- **Ride-list demand must never change a legacy bucket count.** `derive_base_demand` :1223-1229 overwrites divergent `hplc`/`endo`/`ster` with legacy values (legacy WINS) and ERROR-logs `demand_divergence`. Riders attaching to legacy hosts contribute ZERO to the host bucket; self-mint only ever lands on catalog-only roles (admin guard blocks legacy roles on new profiles). A property test pins this (Task 4).
- **`endo`/`ster` appear on no ride list** (sensitive tests never share by construction) — enforced at the ride-hosts API edge.
- **Migrations run BEFORE `create_all`** (`database.py:121-123`). Every new table needs a raw `CREATE TABLE IF NOT EXISTS` in the migrations list (append immediately before the closing `]` at `database.py:1465`), or first-boot FK-ALTERs/indexes fail. No `:token` sequences inside SQL string literals (the bind-param trap, `database.py:1290-1307`; guard test `test_boot_migration_statements_have_no_bindparams` covers the whole list).
- **Seed discipline:** copy `backend/catalog/profile_seed.py:18-64` — existing-keys set → insert-only-if-absent → `db.flush()` before any read-back (production `autoflush=False`) → guarded backfill (never clobber admin edits) → single commit → `log.info`. New seed tests must build their own `sessionmaker(autoflush=False)` session (conftest's `autoflush=True` masks the bug class). Fresh-DB proofs run at `RestartCount=0` — a second boot heals a broken backfill invisibly.
- **Test fixtures never key on real catalog rows** (ledger constraint 8: a fixture keyed to the real `heavy_metals` key silently wiped the seeded row). Use test-only keys/codes (`zz_test`, `t_role`, etc.).
- **`assignment_role` is VARCHAR(8)** (`models.py:851`, `database.py:347`). `vial_roles.code` is `String(8)`, format `^[a-z][a-z0-9_]{0,7}$` (the existing regex at `main.py:15662`).
- **Fail-closed conversion discipline:** an unknown role code REFUSES loudly at every backend site (ValueError/400/ERROR log), never silently drops. FE label sites degrade with explicit fallbacks (`?? role.toUpperCase()` / `?? ROLE_*_CLASS.xtra`), the spec-3 pattern.
- **Gates per task:** backend `pytest tests/ -q` failure-set diff vs the Task-0 baseline (NEVER zero-failures; known flake `test_peptide_request_update_fields`); FE `npx tsc --noEmit` (NEVER `npm run check:all`) + `npm run test:run` for touched suites. npm only.
- **Interpreter:** run pytest FROM the worktree with the MAIN checkout's venv: `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest`.
- **Deploy-window facts (verbatim from the spec-3 ledger, this plan must not violate):** IS-before-WP with the unknown-key 422 as tripwire; **seed-catalog-LAST**; the demand-fields backfill rides the Mk1 deploy (verify the five profiles' `vials_required` post-deploy); `NATIVE_SERVICE_KEYS` extension is a per-family IS deploy; G-PUB (wc_test_services entry flip) is the point of no return, after IS + Mk1 are live, and requires the card slice + price. Spec 4 adds no deploy coupling to IS/COABuilder/WP.
- **Handler/lab gates:** G-RIDE (ride-list contents for vacuum/fent are lab-protocol calls — profiles ship with EMPTY ride lists); G-STATION (bench/station inventory before scan-in goes live — `bench_stations` ships EMPTY).
- Commit style: `feat(catalog-bench): ...` / `fix(catalog-bench): ...` / `test(catalog-bench): ...`, one commit per task minimum.

## File Structure (what gets created/modified where)

```
backend/models.py                      MODIFY  VialRole + profile_ride_hosts + VialProfileAssignment + BenchStation models; AnalysisProfile.sla_tier_id
backend/database.py                    MODIFY  migration DDL block (before :1465) + seed wiring (after :144)
backend/catalog/vial_roles_seed.py     CREATE  five legacy role rows, profile_seed idiom
backend/catalog/roles.py               CREATE  role_registry(db), suggest helpers, lane derivation
backend/sub_samples/catalog_demand.py  MODIFY  demand v2: resolve_catalog_fulfillment (anchors→riders)
backend/sub_samples/service.py         MODIFY  custody writes in set_assignment_role; conversions (_VALID_ROLES, buckets, depts, variance eligibility)
backend/sub_samples/custody.py         CREATE  write_custody_edges / current_custody_profile_ids
backend/lims_analyses/seeder.py        MODIFY  edge-driven rider-union seeding
backend/boxes/service.py               MODIFY  BOXABLE_ROLES → vial_roles.boxable read
backend/main.py                        MODIFY  vial-roles + ride-hosts + bench-stations + lanes APIs; profile auto-mint; inbox lane conversion; activity labels
backend/sub_samples/schemas.py, routes.py  MODIFY  vial-plan sections metadata
backend/sla_engine.py                  (untouched — FE-side resolver gains the profile step)
src/lib/api.ts                         MODIFY  types widen (AssignmentRole→string, Record demand), new endpoints
src/services/vial-roles.ts             CREATE  hook (idiom A)
src/services/departments.ts            CREATE  hook (idiom A — DepartmentsPage's raw-state idiom is NOT the template)
src/components/hplc/VialRolesPage.tsx  CREATE  admin page
src/components/hplc/AnalysisProfilesPage.tsx  MODIFY  auto-mint confirm UI + SLA tier select + ride-hosts editor
src/components/intake/ReceiveWizard/AssignStep.tsx  MODIFY  sections map (keep Bucket/SubDropZone/VarianceDropZone verbatim)
src/components/intake/ReceiveWizard/{BoxStep,BoxLabelTemplate,LabelTemplate,OrderLabelTemplate,PrintStep}.tsx  MODIFY  dynamic/fallback sweep
src/components/hplc/WorksheetsInboxPage.tsx  MODIFY  dynamic lane chips
src/components/senaite/{VialsQuickLookDialog,SampleDetails,SenaiteDashboard,AnalysisTable}.tsx  MODIFY  reassign options, labels, glyph, colors
src/lib/sla-resolution.ts + src/services/analysis-sla.ts  MODIFY  profile-tier step
public/m/bench.html + bench.js         CREATE  scan-in phone page (API base '/api/api')
```

---

### Task 0: Worktree, branch, baselines

**Files:** none in-repo (worktree + baseline artifacts only)

- [ ] **Step 1: Create the worktree** (from the MAIN checkout so `.git` links resolve; `feat/catalog-order-routing` is checked out at `C:\tmp\Accu-Mk1-order-routing`, so branch from the commit):

```bash
git -C "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1" worktree add -b feat/catalog-driven-bench /c/tmp/Accu-Mk1-bench ef1eddb
```

- [ ] **Step 2: Capture the pytest failure baseline** (expect ~64 failures matching spec-3's; the diff-not-zero discipline):

```bash
mkdir -p /c/tmp/Accu-Mk1-bench/.superpowers/sdd/2026-07-30-catalog-driven-bench
cd /c/tmp/Accu-Mk1-bench/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > /c/tmp/Accu-Mk1-bench/.superpowers/sdd/2026-07-30-catalog-driven-bench/baseline-failures.txt
wc -l /c/tmp/Accu-Mk1-bench/.superpowers/sdd/2026-07-30-catalog-driven-bench/baseline-failures.txt
```

- [ ] **Step 3: Verify FE gates run clean at baseline:** `cd /c/tmp/Accu-Mk1-bench && npm install && npx tsc --noEmit` (expect clean — spec-3 left tsc green) and `npm run test:run` (record any baseline failures to the same sdd dir as `fe-baseline.txt`).

---

### Task 1: `vial_roles` table — model, migration, seed, registry

**Files:**
- Modify: `backend/models.py` (insert at :275, between `analysis_profile_members` and `AnalysisProfile`)
- Modify: `backend/database.py` (DDL before the closing `]` at :1465; seed wiring after :144)
- Create: `backend/catalog/vial_roles_seed.py`
- Create: `backend/catalog/roles.py`
- Test: `backend/tests/test_vial_roles_catalog.py`

**Interfaces:**
- Produces: `models.VialRole` (columns below); `catalog.vial_roles_seed.seed_vial_roles(db)`; `catalog.roles.role_registry(db) -> dict[str, VialRole]` (all rows keyed by code); `catalog.roles.real_bucket_codes(db) -> list[str]` (codes with non-NULL department, ordered by `sort_order, code`); `catalog.roles.suggest_role_code(key: str, existing: set[str]) -> str`.

- [ ] **Step 1: Write failing tests** in `backend/tests/test_vial_roles_catalog.py`:

```python
"""vial_roles catalog table: seed + registry (spec 4 Task 1)."""
from catalog.vial_roles_seed import seed_vial_roles
from catalog.roles import role_registry, real_bucket_codes, suggest_role_code
from models import VialRole


def test_seed_creates_five_legacy_roles_with_parity_flags(db_session):
    seed_vial_roles(db_session)
    reg = role_registry(db_session)
    assert set(reg) >= {"hplc", "endo", "ster", "xtra", "hm"}
    # parity with live code, NOT the spec parenthetical (deviation 3)
    assert reg["hplc"].boxable and reg["endo"].boxable and reg["ster"].boxable and reg["xtra"].boxable
    assert not reg["hm"].boxable  # deviation 4: dark until Handler flips post-rehearsal
    for code in ("hplc", "endo", "ster", "xtra"):
        assert reg[code].variance_eligible
    assert not reg["hm"].variance_eligible
    assert all(reg[c].is_system and reg[c].frozen for c in ("hplc", "endo", "ster", "xtra", "hm"))
    assert reg["xtra"].department_id is None  # deviation 2


def test_seed_departments_match_role_department_names(db_session):
    from catalog.departments import backfill_departments
    backfill_departments(db_session)
    seed_vial_roles(db_session)
    reg = role_registry(db_session)
    assert reg["hplc"].department.name == "Analytical"
    assert reg["endo"].department.name == "Microbiology"
    assert reg["ster"].department.name == "Microbiology"
    assert reg["hm"].department.name == "Heavy Metals"


def test_seed_is_idempotent_and_never_clobbers_admin_edits(db_session):
    from catalog.departments import backfill_departments
    backfill_departments(db_session)
    seed_vial_roles(db_session)
    row = db_session.query(VialRole).filter_by(code="hm").one()
    row.label = "Heavy Metals (edited)"
    db_session.commit()
    seed_vial_roles(db_session)
    assert db_session.query(VialRole).filter_by(code="hm").one().label == "Heavy Metals (edited)"
    assert db_session.query(VialRole).filter_by(code="hplc").count() == 1


def test_seed_on_fresh_db_under_production_autoflush_config(tmp_path):
    # own sessionmaker(autoflush=False) — conftest's autoflush=True masks the bug class
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from models import Base
    eng = create_engine(f"sqlite:///{tmp_path}/fresh.db")
    Base.metadata.create_all(eng)
    S = sessionmaker(bind=eng, autoflush=False)
    with S() as s:
        from catalog.departments import backfill_departments
        backfill_departments(s)
        seed_vial_roles(s)
        assert {r.code for r in s.query(VialRole).all()} == {"hplc", "endo", "ster", "xtra", "hm"}


def test_real_bucket_codes_excludes_xtra_and_orders_by_sort(db_session):
    from catalog.departments import backfill_departments
    backfill_departments(db_session)
    seed_vial_roles(db_session)
    codes = real_bucket_codes(db_session)
    assert codes == ["hplc", "endo", "ster", "hm"]  # legacy _BUCKET_PRIORITY order via sort_order
    assert "xtra" not in codes


def test_suggest_role_code_sanitizes_truncates_uniquifies():
    assert suggest_role_code("heavy_metals", set()) == "heavy_me"
    assert suggest_role_code("heavy_metals", {"heavy_me"}) == "heavy_m2"
    assert suggest_role_code("PCR-Panel 2!", set()) == "pcr_pane"
    assert suggest_role_code("x", set()) == "x"
```

- [ ] **Step 2: Run to verify failure:** `pytest tests/test_vial_roles_catalog.py -q` → ImportError (module doesn't exist).

- [ ] **Step 3: Add the model** in `backend/models.py` at :275 (after the `analysis_profile_members` Table, before `class AnalysisProfile`):

```python
class VialRole(Base):
    """A vial role as a catalog row (spec 4). The role stays the DB join key on vials
    (lims_sub_samples.assignment_role, VARCHAR(8) — NOT widened); the profile is its face.

    xtra is the ONLY row allowed a NULL department (the reserved unassigned bucket).
    frozen: set once any vial references the code; retire-don't-delete.
    """

    __tablename__ = "vial_roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(8), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    department_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    boxable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    variance_eligible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    frozen: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    department = relationship("Department", lazy="selectin")
```

(Match the import style already at the top of models.py — `Mapped`/`mapped_column` are in use for newer models like `LimsSubSampleEvent`.)

- [ ] **Step 4: Add the migration DDL** in `backend/database.py` immediately before the closing `]` at :1465:

```python
    # --- Catalog-driven bench (spec 4): vial_roles ---
    # Full CREATE here (not just create_all): migrations run BEFORE create_all
    # (lims_capture_tokens precedent, see :1324-1329).
    """CREATE TABLE IF NOT EXISTS vial_roles (
        id SERIAL PRIMARY KEY,
        code VARCHAR(8) NOT NULL UNIQUE,
        label VARCHAR(100) NOT NULL,
        department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        boxable BOOLEAN NOT NULL DEFAULT FALSE,
        variance_eligible BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        frozen BOOLEAN NOT NULL DEFAULT FALSE,
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )""",
```

- [ ] **Step 5: Write the seed** `backend/catalog/vial_roles_seed.py` (copy the `profile_seed.py` idiom exactly):

```python
"""Seed the five legacy vial-role rows (spec 4). Idempotent; never clobbers admin edits."""
import logging

from catalog.departments import (
    ANALYTICAL_DEPARTMENT,
    HEAVY_METALS_DEPARTMENT,
    MICROBIOLOGY_DEPARTMENT,
    department_id_by_name,
)
from models import VialRole

log = logging.getLogger("accumark.catalog")

# (code, label, department name or None, boxable, variance_eligible, sort_order)
# Flags are PARITY-EXACT with the live constants (BOXABLE_ROLES, _VARIANCE_INELIGIBLE_ROLES)
# — see plan deviation 3. hm stays boxable=False (deviation 4: Handler flips post-rehearsal).
_LEGACY_ROLES = [
    ("hplc", "HPLC", ANALYTICAL_DEPARTMENT, True, True, 0),
    ("endo", "Endotoxin", MICROBIOLOGY_DEPARTMENT, True, True, 1),
    ("ster", "Sterility", MICROBIOLOGY_DEPARTMENT, True, True, 2),
    ("hm", "Heavy Metals", HEAVY_METALS_DEPARTMENT, False, False, 3),
    ("xtra", "Extras", None, True, True, 9),
]


def seed_vial_roles(db) -> int:
    existing = {code for (code,) in db.query(VialRole.code).all()}
    created = 0
    for code, label, dept_name, boxable, var_ok, sort in _LEGACY_ROLES:
        if code in existing:
            continue
        dept_id = department_id_by_name(db, dept_name) if dept_name else None
        db.add(
            VialRole(
                code=code, label=label, department_id=dept_id, boxable=boxable,
                variance_eligible=var_ok, sort_order=sort, frozen=True, is_system=True,
            )
        )
        created += 1
    # flush before any read-back: production SessionLocal is autoflush=False
    db.flush()
    db.commit()
    log.info("catalog.vial_roles_seed created=%s", created)
    return created
```

- [ ] **Step 6: Write the registry helpers** `backend/catalog/roles.py`:

```python
"""Read helpers for the vial_roles catalog (spec 4). Fail-closed: callers treat a
registry miss as an error, never a silent drop."""
import re

from models import VialRole

_CODE_RE = re.compile(r"[a-z][a-z0-9_]{0,7}")


def role_registry(db) -> dict:
    """All roles keyed by code. One query; call once per request path."""
    return {r.code: r for r in db.query(VialRole).all()}


def real_bucket_codes(db) -> list[str]:
    """Assignable demand buckets: every role with a department, ordered. xtra (NULL
    department) is the reserved unassigned bucket and is deliberately excluded."""
    rows = (
        db.query(VialRole)
        .filter(VialRole.department_id.isnot(None))
        .order_by(VialRole.sort_order, VialRole.code)
        .all()
    )
    return [r.code for r in rows]


def suggest_role_code(key: str, existing: set) -> str:
    """Derive a role code from a profile key: lowercase, strip invalid chars,
    truncate to 8, uniquify with a numeric suffix."""
    base = re.sub(r"[^a-z0-9_]", "_", key.lower()).strip("_") or "role"
    if not base[0].isalpha():
        base = "r" + base
    code = base[:8]
    n = 2
    while code in existing:
        suffix = str(n)
        code = base[: 8 - len(suffix)] + suffix
        n += 1
    return code
```

- [ ] **Step 7: Wire the seed into startup** in `backend/database.py` after the `seed_profiles_from_registry` block (:139-144), same shape:

```python
    try:
        from catalog.vial_roles_seed import seed_vial_roles
        with SessionLocal() as _db:
            seed_vial_roles(_db)
    except Exception as e:  # never block startup
        log.warning("catalog_vial_roles_seed_skipped err=%s", e)
```

- [ ] **Step 8: Run tests:** `pytest tests/test_vial_roles_catalog.py -q` → all pass. Then the migration-guard: `pytest tests/ -q -k "bindparams"` → pass.
- [ ] **Step 9: Full-gate diff vs baseline; commit** `feat(catalog-bench): vial_roles table + legacy seed + registry helpers`.

---

### Task 2: vial_roles admin API + FE admin page

**Files:**
- Modify: `backend/main.py` (new section after :15804, before the SLA-tiers banner; schemas near :2320)
- Test: `backend/tests/test_api_vial_roles.py`
- Create: `src/services/vial-roles.ts`, `src/services/departments.ts`, `src/components/hplc/VialRolesPage.tsx`
- Modify: `src/lib/api.ts` (after the profiles block at :4616), `src/store/ui-store.ts:31-32`, `src/components/layout/AppSidebar.tsx:92-93`, `src/components/layout/MainWindowContent.tsx:11,:68`
- Test: `src/test/vial-roles-page.test.tsx`

**Interfaces:**
- Produces: `GET/POST /vial-roles`, `PATCH/DELETE /vial-roles/{id}`. Response shape `{id, code, label, department_id, boxable, variance_eligible, sort_order, frozen, is_system}`. FE `useVialRoles()` + `vialRolesQueryKeys.all = ['vial-roles']`; `useDepartments()` + `departmentsQueryKeys.all = ['departments']`; FE type `VialRoleRow`.

- [ ] **Step 1: Failing backend tests** `backend/tests/test_api_vial_roles.py` (client fixture idiom from `test_api_analysis_profiles.py`):

```python
def test_post_creates_role_with_department(client, db_session):
    dep = client.post("/departments", json={"name": "Tox Dept"}).json()
    r = client.post("/vial-roles", json={"code": "tox", "label": "Toxicology", "department_id": dep["id"]})
    assert r.status_code == 201
    assert r.json()["code"] == "tox" and r.json()["boxable"] is False

def test_post_rejects_bad_code_format(client):
    assert client.post("/vial-roles", json={"code": "Bad-Code", "label": "x"}).status_code == 400
    assert client.post("/vial-roles", json={"code": "toolongcode", "label": "x"}).status_code == 400

def test_post_rejects_null_department_for_non_xtra(client):
    r = client.post("/vial-roles", json={"code": "orphan", "label": "No Dept"})
    assert r.status_code == 400  # deviation 2: only xtra may be department-less

def test_post_rejects_duplicate_code(client, db_session): ...  # 400 on second create of same code

def test_delete_refuses_system_and_referenced_roles(client, db_session):
    # is_system → 400; role referenced by a profile fulfillment_role or any
    # lims_sub_samples.assignment_role → 409 (department DELETE guard pattern, main.py:15594-15612)
    ...

def test_patch_updates_flags_but_never_code_on_frozen(client, db_session):
    # frozen row: label/boxable/variance_eligible/sort_order editable, code immutable → 400 on code change
    ...
```

(Write the elided bodies out fully in the test file — each is 5-10 lines of the same client idiom as the first two.)

- [ ] **Step 2: Run → fail (404s).**
- [ ] **Step 3: Implement the API** in `backend/main.py`. Schemas near :2343 (`VialRoleCreate{code,label,department_id:int|None=None,boxable:bool=False,variance_eligible:bool=False,sort_order:int=0}`, `VialRoleUpdate` all-Optional, `VialRoleResponse`). Endpoints after :15804 following the profiles idiom (`Depends(get_db)`, `Depends(get_current_user)`, 201/204, inline `HTTPException(400/409)`): code validated with the existing regex `re.fullmatch(r"[a-z][a-z0-9_]{0,7}", code)`; non-xtra NULL department → 400; DELETE: `is_system` → 400, referenced by `AnalysisProfile.fulfillment_role` or `LimsSubSample.assignment_role`/`LimsSample.assignment_role` → 409; PATCH refuses `code` change when `frozen`.
- [ ] **Step 4: Backend tests pass; failure-set diff clean.**
- [ ] **Step 5: FE plumbing.** `src/lib/api.ts` (use `extractErrorMessage` — validation messages are the point): `VialRoleRow` type + `getVialRoles`/`createVialRole`/`updateVialRole`/`deleteVialRole`. `src/services/vial-roles.ts` + `src/services/departments.ts` copy `analysis-profiles.ts` byte-for-byte structurally (`staleTime: 1000*60*5`). Registration triple: `ui-store.ts` union member `'vial-roles'`, `AppSidebar.tsx` `{ id: 'vial-roles', label: 'Vial Roles', adminOnly: true }`, `MainWindowContent.tsx` import + branch.
- [ ] **Step 6: `VialRolesPage.tsx`** — table of roles (code, label, department select from `useDepartments()`, boxable/variance_eligible switches, sort_order, frozen/system badges), create dialog, edit dialog; model the page structure on `AnalysisProfilesPage.tsx` (dialog + `handleSave` + invalidate `vialRolesQueryKeys.all`). Disable delete for `is_system`; surface backend 409 text via toast. shadcn components as used there; rich hover tooltip (sectioned font-mono card) on the boxable/variance flags explaining bench effect.
- [ ] **Step 7: FE test** `src/test/vial-roles-page.test.tsx`: renders rows from a mocked `getVialRoles`, create dialog POSTs expected payload, system row's delete disabled (mock idiom from `src/test/analysis-profiles-fulfillment.test.tsx`).
- [ ] **Step 8: Gates (`tsc`, `npm run test:run`, pytest diff); commit** `feat(catalog-bench): vial_roles admin API + page`.

---

### Task 3: Profile auto-mint + role validation + member-department backfill

**Files:**
- Modify: `backend/main.py` (`create_analysis_profile` :15644, `update_analysis_profile` :15683, `replace_profile_members` :15769; `_profile_to_response` :15622)
- Test: `backend/tests/test_profile_role_automint.py`
- Modify: `src/components/hplc/AnalysisProfilesPage.tsx` (fulfillment block :582-648), `src/lib/api.ts` (profile type + payloads)
- Test: `src/test/analysis-profiles-fulfillment.test.tsx` (extend)

**Interfaces:**
- Consumes: `role_registry`, `suggest_role_code` (Task 1).
- Produces: POST/PATCH `/analysis-profiles` accept optional `role_department_id: int | null`; when `fulfillment_dim=='role'` and `fulfillment_role` names a code not in `vial_roles`, the route MINTS the row (label=profile name, department=`role_department_id` or NULL, boxable=False, variance_eligible=False, frozen=False, sort_order=max+1) AFTER the spec-3 guards run. `PUT /{id}/members` backfills a NULL department on the profile's minted role when members share exactly one distinct department. Response gains `fulfillment_role_exists: bool` is NOT added — FE checks against `useVialRoles()` instead.

**Ordering note:** the spec-3 guards (`xtra` 400, legacy-role 400) run FIRST and are untouched — mint can therefore never create a legacy or xtra code, which is what keeps route-hook minting compatible with the zero-clamp rider (recon flagged this interaction; this is the resolution).

- [ ] **Step 1: Failing tests** `backend/tests/test_profile_role_automint.py`:

```python
def test_post_with_unknown_role_mints_vial_role(client, db_session):
    dep = client.post("/departments", json={"name": "Mint Dept"}).json()
    r = client.post("/analysis-profiles", json={
        "key": "zz_test_family", "name": "ZZ Test", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "zz_test",
        "role_department_id": dep["id"], "vials_required": 1})
    assert r.status_code == 201
    role = db_session.query(VialRole).filter_by(code="zz_test").one()
    assert role.label == "ZZ Test" and role.department_id == dep["id"]
    assert role.boxable is False and role.variance_eligible is False and role.frozen is False

def test_post_with_existing_role_reuses_it(client, db_session):
    # create role via /vial-roles first; profile POST with that code mints nothing (count==1)
    ...

def test_mint_never_bypasses_spec3_guards(client):
    # legacy role for new key still 400s; xtra still 400s — BEFORE any mint
    r = client.post("/analysis-profiles", json={"key": "zz_new", "name": "x", "is_addon": True,
                                                "fulfillment_dim": "role", "fulfillment_role": "hplc"})
    assert r.status_code == 400

def test_members_put_backfills_null_department_once(client, db_session):
    # profile minted with NULL dept; PUT members whose services share one department
    # → role.department_id set; a second PUT with mixed departments does NOT clobber it
    ...

def test_members_put_leaves_department_null_when_mixed(client, db_session): ...
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** In `create_analysis_profile`, after the existing guard chain (:15658-15673), add:

```python
    if data.fulfillment_dim == "role" and data.fulfillment_role:
        from catalog.roles import role_registry
        reg = role_registry(db)
        if data.fulfillment_role not in reg:
            max_sort = db.query(func.coalesce(func.max(VialRole.sort_order), 0)).scalar()
            db.add(VialRole(
                code=data.fulfillment_role, label=data.name,
                department_id=data.role_department_id,
                boxable=False, variance_eligible=False,
                sort_order=max_sort + 1, frozen=False, is_system=False,
            ))
            log.info("vial_role_minted code=%s for_profile=%s", data.fulfillment_role, data.key)
```

Mirror in PATCH (mint on role change to an unknown code, `effective_*` semantics as the existing guards). In `replace_profile_members` (:15769), after the replacement commit path: load the profile's role row; if it exists, `department_id IS NULL`, and not `is_system`, compute `SELECT DISTINCT analysis_services.department_id` over the new member set; exactly one non-NULL value → set it + `log.info("vial_role_department_backfilled ...")` (never clobber a set value — the `backfill_departments` idiom).
- [ ] **Step 4: Tests pass; diff clean.**
- [ ] **Step 5: FE.** `AnalysisProfilesPage.tsx` fulfillment block: pull `useVialRoles()`; below the role input (:631-641) render (a) when the typed code matches an existing role: "Uses existing role '<code>' — <label>"; (b) when it doesn't: "Will create role '<code>'" + a department `Select` (from `useDepartments()`) bound to a new `role_department_id` form field; (c) when the field is EMPTY and dim=='role': helper text "Leave blank to auto-create '<suggestion>'" using an FE port of `suggest_role_code` (`export function suggestRoleCode(key: string, existing: Set<string>): string` in `src/lib/role-code.ts`, same algorithm, unit-tested), and `handleSave` fills the suggestion into the payload. Keep `FULFILLMENT_ROLE_PATTERN` validation. Invalidate BOTH `analysisProfilesQueryKeys.all` and `vialRolesQueryKeys.all` on save.
- [ ] **Step 6: FE tests** (extend `analysis-profiles-fulfillment.test.tsx`): suggestion helper unit tests; save-with-empty-role sends the suggested code + `role_department_id`.
- [ ] **Step 7: Gates; commit** `feat(catalog-bench): auto-mint vial roles on profile create/patch + member-dept backfill`.

---

### Task 4: Ride lists — junction, API, demand v2

**Files:**
- Modify: `backend/models.py` (junction above `VialRole`), `backend/database.py` (DDL), `backend/main.py` (ride-hosts endpoints after the members endpoints :15804)
- Modify: `backend/sub_samples/catalog_demand.py`
- Test: `backend/tests/test_ride_lists.py`, extend `backend/tests/test_catalog_demand.py`
- Modify: `src/components/hplc/AnalysisProfilesPage.tsx` (ride-hosts editor, edit-dialog only), `src/lib/api.ts`

**Interfaces:**
- Consumes: `VialRole`, `role_registry` (Task 1).
- Produces: table `profile_ride_hosts(id, analysis_profile_id FK CASCADE, host_role_code VARCHAR(8), priority INT, UNIQUE(analysis_profile_id, host_role_code))`; `GET/PUT /analysis-profiles/{id}/ride-hosts` (`{host_role_codes: ["hplc", "fent"]}` — position = priority, replace-all like members); **`catalog_demand.resolve_catalog_fulfillment(db, services) -> dict[str, RoleFulfillment]`** where `RoleFulfillment = dataclass(demand: int, host_profile_ids: list[int], rider_profile_ids: list[int])` — Tasks 5, 6, 8 consume this.

- [ ] **Step 1: Failing tests.** In `test_ride_lists.py` — build profiles with TEST-ONLY keys/roles (`zz_fent`→role `zfent` riding `[zhplc]`, etc.; never real rows):

```python
def _mk(db, key, role, vials=1, rides=None):  # helper: profile + minted role + ride rows
    ...

def test_standalone_rider_self_mints_own_role(db_session):
    # fent alone (rides [thplc], thplc NOT ordered) → demand {tfent: 1}
def test_rider_attaches_to_ordered_host(db_session):
    # fent + thplc-family ordered → demand {thplc: 1}; fulfillment[thplc].rider_profile_ids == [fent.id]
def test_rider_chain_attaches_to_earlier_self_mint(db_session):
    # vacuum rides [thplc, tfent]; thplc absent, fent ordered standalone (self-minted tfent)
    # → vacuum attaches to tfent; ONE tfent vial hosting vacuum
def test_priority_order_respected(db_session):
    # rider rides [a, b], both ordered → attaches to a (first hit)
def test_rider_resolution_is_permutation_invariant(db_session):
    # same service set in every dict insertion order → identical fulfillment map (property test
    # over itertools.permutations of 4 keys)
def test_rides_never_change_legacy_buckets(db_session, caplog):
    # legacy keys + a test rider on a catalog host: demand['hplc'/'endo'/'ster'] byte-identical
    # to derive_base_demand(services, db=None) legacy reference; no demand_divergence in caplog
def test_put_ride_hosts_rejects_endo_ster_xtra_self(client, db_session):
    # endo → 400, ster → 400, xtra → 400, own role → 400, unknown code → 400
def test_put_ride_hosts_rejects_kind_dim_profile(client, db_session): ...
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Junction + DDL.** `models.py` above `VialRole`:

```python
profile_ride_hosts = Table(
    "profile_ride_hosts",
    Base.metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("analysis_profile_id", Integer, ForeignKey("analysis_profiles.id", ondelete="CASCADE"), nullable=False),
    Column("host_role_code", String(8), nullable=False),
    Column("priority", Integer, nullable=False, default=0),
    UniqueConstraint("analysis_profile_id", "host_role_code", name="uq_profile_ride_host"),
)
```

DDL string in `database.py` (same block as Task 1's, `CREATE TABLE IF NOT EXISTS profile_ride_hosts (...)` mirroring the columns; `host_role_code` deliberately NOT an FK — route-edge validation, the additive idiom used for `fulfillment_role`).
- [ ] **Step 4: Ride-hosts API.** GET returns codes ordered by priority. PUT (replace-all, members idiom :15769-15804): each code must exist in `role_registry`; 400 on `endo`/`ster` ("sensitive tests never share"), `xtra`, the profile's own `fulfillment_role`, unknown codes, or `fulfillment_dim != 'role'`.
- [ ] **Step 5: Demand v2** in `catalog_demand.py`. Keep `derive_base_demand_catalog(db, services)` as a thin wrapper so the shadow-compare caller is untouched:

```python
@dataclass
class RoleFulfillment:
    demand: int = 0
    host_profile_ids: list = field(default_factory=list)
    rider_profile_ids: list = field(default_factory=list)


def resolve_catalog_fulfillment(db, services):
    """Anchors mint MAX-per-role demand; riders attach to the first ordered host on
    their priority list, else self-mint their own role (Handler-locked 2026-07-31).
    Deterministic: riders iterate by (role sort_order, profile key)."""
    result = {b: RoleFulfillment() for b in _LEGACY_BUCKETS}
    ordered = []
    for key, val in services.items():
        if key in _QUIET_KEYS or not val:
            continue
        prof = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if prof is None:
            log.warning("catalog_demand_unknown_key key=%s", key)
            continue
        if not prof.active:
            log.warning("catalog_demand_inactive_profile key=%s (still fulfilling: paid order)", key)
        if prof.fulfillment_dim != "role" or not prof.fulfillment_role:
            continue
        ordered.append(prof)

    ride_rows = db.execute(
        select(profile_ride_hosts.c.analysis_profile_id,
               profile_ride_hosts.c.host_role_code,
               profile_ride_hosts.c.priority)
        .where(profile_ride_hosts.c.analysis_profile_id.in_([p.id for p in ordered]))
    ).all() if ordered else []
    ride_map = {}
    for pid, host, prio in sorted(ride_rows, key=lambda r: r[2]):
        ride_map.setdefault(pid, []).append(host)

    anchors = [p for p in ordered if not ride_map.get(p.id)]
    riders = [p for p in ordered if ride_map.get(p.id)]

    for p in anchors:
        rf = result.setdefault(p.fulfillment_role, RoleFulfillment())
        rf.demand = max(rf.demand, p.vials_required)
        rf.host_profile_ids.append(p.id)

    sort_of = {r.code: r.sort_order for r in db.query(VialRole).all()}
    riders.sort(key=lambda p: (sort_of.get(p.fulfillment_role, 999), p.key))
    for p in riders:
        host = next((h for h in ride_map[p.id] if result.get(h) and result[h].demand > 0), None)
        if host is not None:
            result[host].rider_profile_ids.append(p.id)
        else:
            rf = result.setdefault(p.fulfillment_role, RoleFulfillment())
            rf.demand = max(rf.demand, p.vials_required or 1)  # standalone rider mints its own vial
            rf.host_profile_ids.append(p.id)
    return result


def derive_base_demand_catalog(db, services):
    return {role: rf.demand for role, rf in resolve_catalog_fulfillment(db, services).items()}
```

- [ ] **Step 6: All demand tests pass** including the untouched spec-3 suite (`test_catalog_demand.py` — the 32-combo parity test must not change) and the new ride tests. Failure-set diff clean.
- [ ] **Step 7: FE ride-hosts editor** in the profile edit dialog (edit-only, like the COA block): ordered chip list of host codes + add-from-`useVialRoles()` select (excluding endo/ster/xtra/own) + remove/reorder buttons; PUT on save. Surface 400 text via toast.
- [ ] **Step 8: Gates; commit** `feat(catalog-bench): ride lists — junction + API + demand v2 anchors/riders`.

---

### Task 5: Custody edges — `vial_profile_assignments`

**Files:**
- Modify: `backend/models.py`, `backend/database.py` (DDL)
- Create: `backend/sub_samples/custody.py`
- Modify: `backend/sub_samples/service.py` (`set_assignment_role` :1607-1649)
- Modify: `backend/main.py` (read endpoint)
- Test: `backend/tests/test_custody_edges.py`

**Interfaces:**
- Consumes: `resolve_catalog_fulfillment` (Task 4).
- Produces: model `VialProfileAssignment(id, lims_sub_sample_pk FK CASCADE, analysis_profile_id FK, relation 'host'|'rider', assigned_at, assigned_by_id FK users SET NULL, superseded_at NULL)`; `custody.write_custody_edges(db, sub, role, wp_services, user_id) -> int` (supersedes current rows, inserts new; no commit — joins the caller's transaction); `custody.current_custody(db, sub_pk) -> list[VialProfileAssignment]` (rows where `superseded_at IS NULL`); `GET /sub-samples/{sample_id}/custody` returning `[{profile_id, profile_key, profile_name, relation, assigned_at, assigned_by, superseded_at}]` (full history, current first — the display and the audit trail are the same record).

**Immutability discipline:** rows are never UPDATEd except stamping `superseded_at` once (append-style supersession — the row still records "profile X was on vial Y from T1 to T2"). No DELETE path exists.

- [ ] **Step 1: Failing tests** `backend/tests/test_custody_edges.py`:

```python
def test_role_assign_writes_host_and_rider_edges(db_session):
    # order: test anchor family (role tanchor) + test rider attached to it;
    # set_assignment_role(vial, 'tanchor', wp_services=services)
    # → edges: (anchor_profile, 'host'), (rider_profile, 'rider'), superseded_at NULL
def test_role_flip_supersedes_and_reinserts(db_session):
    # flip tanchor→xtra: old edges get superseded_at NOT NULL; xtra writes no new edges
    # flip back: fresh rows inserted; history rows untouched (3 generations queryable)
def test_edges_commit_atomically_with_role(db_session, monkeypatch):
    # force seed_analyses_for_vial to raise → rollback → NO edge rows persisted
def test_no_services_skips_edges_with_warning(db_session, caplog):
    # wp_services=None → no edges, 'custody_edge_skipped' warning, role write still succeeds
def test_legacy_hplc_vial_gets_host_edge(db_session):
    # legacy keys exist as profiles: hplc assign with hplcpurity_identity ordered
    # → host edge to the hplcpurity_identity profile row
def test_custody_endpoint_returns_history_current_first(client, db_session): ...
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Model + DDL** (same block; `relation VARCHAR(8) NOT NULL`, `CHECK (relation IN ('host','rider'))` in the raw DDL only — no ORM-level CHECK to keep SQLite tests happy; plus `CREATE INDEX IF NOT EXISTS ix_vpa_sub_current ON vial_profile_assignments (lims_sub_sample_pk) WHERE superseded_at IS NULL`).
- [ ] **Step 4: `custody.py`:**

```python
"""Vial↔profile custody edges (spec 4, ISO 17025 backbone). Append-only:
supersede + insert, never rewrite. No commits here — callers own the transaction."""
from datetime import datetime

from models import VialProfileAssignment
from sub_samples.catalog_demand import resolve_catalog_fulfillment


def write_custody_edges(db, sub, role, wp_services, user_id):
    now = datetime.utcnow()
    current = (
        db.query(VialProfileAssignment)
        .filter_by(lims_sub_sample_pk=sub.id, superseded_at=None)
        .all()
    )
    for row in current:
        row.superseded_at = now
    if not role or role == "xtra":
        return 0
    if not wp_services:
        log.warning("custody_edge_skipped sub=%s role=%s reason=no_services", sub.sample_id, role)
        return 0
    fulfillment = resolve_catalog_fulfillment(db, wp_services).get(role)
    if fulfillment is None:
        return 0
    written = 0
    for pid in fulfillment.host_profile_ids:
        db.add(VialProfileAssignment(lims_sub_sample_pk=sub.id, analysis_profile_id=pid,
                                     relation="host", assigned_at=now, assigned_by_id=user_id))
        written += 1
    for pid in fulfillment.rider_profile_ids:
        db.add(VialProfileAssignment(lims_sub_sample_pk=sub.id, analysis_profile_id=pid,
                                     relation="rider", assigned_at=now, assigned_by_id=user_id))
        written += 1
    return written
```

- [ ] **Step 5: Wire into `set_assignment_role`** between the `LimsSubSampleEvent` add (:1607-1613) and `_drop_stale_role_rows` (:1618) — BEFORE the seeding hook so Task 6's seeder can read the fresh edges in the same session (`autoflush` note: call `db.flush()` after `write_custody_edges` so the seeder's query sees the rows under production `autoflush=False`). `wp_services` acquisition: use exactly what the seeding hook at :1632-1648 receives — when the hook's services are unavailable, edges are skipped with the warning (fail-soft, matches the hook's own behavior). Do NOT touch the parent-AR branch (:1652-1660).
- [ ] **Step 6: Read endpoint** in `main.py` next to the sub-sample activity endpoint idiom: join profiles for key/name, `ORDER BY (superseded_at IS NOT NULL), assigned_at DESC`.
- [ ] **Step 7: Tests pass; diff clean; commit** `feat(catalog-bench): vial-profile custody edges in the assignment transaction`.

---

### Task 6: Seeding v2 — edge-driven rider-union seeding

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (`_catalog_members_for_role` :90-113, `seed_analyses_for_vial` catalog branch :445-461)
- Test: extend `backend/tests/test_catalog_seeding.py`

**Interfaces:**
- Consumes: `custody.current_custody` (Task 5).
- Produces: `_catalog_members_for_role(db, role, wp_services, sub_sample=None) -> List[AnalysisService]` — when `sub_sample` is given and has current custody edges, membership = union of member services of the edge profiles (host + rider, fail-closed per-profile on `origin != 'mk1'` exactly as today); when no edges exist → existing fulfilling-profiles predicate + `log.warning("catalog_seed_no_custody_fallback ...")` (deviation 6). Existing callers without `sub_sample` are unchanged.

- [ ] **Step 1: Failing tests** (test-only keys/roles):

```python
def test_host_vial_seeds_union_of_host_and_rider_members(db_session):
    # anchor profile (member svc A) + rider profile (member svc B) attached via edges
    # → vial seeds {A, B}; log_event catalog_seeded for both
def test_seeding_reads_edges_not_rederivation(db_session):
    # edges pinned to rider set X even though wp_services would now resolve differently
    # → seeds follow the EDGES (the display and audit trail cannot disagree)
def test_no_edges_falls_back_with_warning(db_session, caplog):
    # catalog-role vial, zero edges → fulfilling-profiles predicate result + fallback warning
def test_rider_members_fail_closed_on_non_native(db_session):
    # rider profile with a senaite-origin member: that PROFILE skipped (catalog_seed_skipped_non_native),
    # host still seeds — per-profile fail-closed exactly as today
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** Widen `_catalog_members_for_role` with the optional `sub_sample` param; inside, when edges exist, iterate edge profiles (host first, then riders, each in profile-member `sort_order`) through the SAME per-profile origin gate and dedup (:106-112). Pass `sub_sample=sub_sample` at the catalog branch call site (:447). Legacy branches (hplc mirror, endo/ster whitelist) untouched.
- [ ] **Step 4: Tests pass (including the untouched spec-3 seeding suite); diff clean; commit** `feat(catalog-bench): seeding follows custody edges (host+rider union)`.

---

### Task 7: Backend role-site conversions (fail-closed)

**Files:**
- Modify: `backend/sub_samples/service.py` (:37-54, :1248-1249, :1453, :1456-1500, :1569, :1598-1606), `backend/boxes/service.py` (:11, :69), `backend/main.py` (:16234-16265, :16302-16307, :16517, :16591-16593), `backend/sub_samples/catalog_demand.py` (`_LEGACY_BUCKETS` floor stays)
- Test: `backend/tests/test_role_site_conversions.py`, extend `backend/tests/test_hm_role_sites.py`

**Interfaces:**
- Consumes: `role_registry`, `real_bucket_codes` (Task 1).
- Produces: every site below reads `vial_roles`; a role code missing from the registry raises/400s loudly. `catalog.roles.inbox_lanes(db) -> dict[str, InboxLane]` with `InboxLane = dataclass(key, department_id, department_name, role_codes: set[str], sort_order)` — Task 10's lanes endpoint consumes this.

**Conversion map (each is one before→after edit + a test):**

| Site | Conversion |
|---|---|
| `_VALID_ROLES` (service.py:1453, used :1569, :1657) | `set_assignment_role` validates `role in role_registry(db)`; parent branch keeps its silent hplc coercion (production behavior, untouched). Constant deleted. |
| `_BUCKET_PRIORITY`/`_REAL_BUCKETS` (:1248-1249) | `compute_vial_plan` computes `priority = tuple(real_bucket_codes(db))` and passes it into `auto_assign(vials, demand, variance, priority)` (new 4th param, default `("hplc","endo","ster","hm")` so the pure function stays test-callable). `_take_slot` takes it as a param too. |
| `_ROLE_DEPARTMENT_NAMES` (:37-51) | `_drop_stale_role_rows` resolves departments via `VialRole.department_id` directly (no name hop): `old_dept_ids - new_dept_ids` from the registry. Unknown old code → keep empty set (vial predates a retired role — log INFO, drop nothing). |
| `_VARIANCE_INELIGIBLE_ROLES` (:53-54, used :1598-1606) | `in_variance_set` recompute reads `not registry[role].variance_eligible` → excluded + reason `f"auto: role {role} is not variance-eligible"`. **Legacy hm rows keep the old byte-matched string via the database.py backfill (untouched, spec: stays as-is)** — the runtime writes the NEW generic string for new flips; extend `test_hm_exclusion_reason_clears_on_role_flip_away` accordingly. |
| `BOXABLE_ROLES` (boxes/service.py:11, :69) | `next_box` checks `registry[role].boxable` (missing code → same ValueError, fail-closed). Constant deleted; the :109 vial↔box role-match invariant unchanged. |
| `ROLE_TO_DEPARTMENT_NAME`/`VALID_INBOX_ROLES` (main.py:16235-16240) + `ROLE_TO_VIAL_ROLES` (:16261-16265) | `inbox_lanes(db)`: one lane per department that has ≥1 role; `key` = legacy alias for the three seeded names (`Analytical→'hplc'`, `Microbiology→'microbiology'`, `Heavy Metals→'hm'` — stored-pref compat) else `re.sub(r'[^a-z0-9]+','_',name.lower())`; `role_codes` = that department's role codes. `?role=` validated against lane keys → 400 unknown (fail-closed, as today). |
| Hand-duplicated union (:16591-16593) **[N1]** | `allowed_vial_roles = set().union(*(l.role_codes for l in lanes.values()))` + `{'xtra'}` when `show_xtra` — actually computed now, comment fixed. |
| :16517 comment-vs-code **[F6]** | Same computed union replaces the literal. |
| `_INBOX_ROLE_COLOR_FALLBACK` (:16302-16307) | Add `.get(role, "zinc")` fallback + an `hm` entry ("emerald" — matches FE assignment-colors hm family). |
| `frozen` maintenance | In `set_assignment_role` after validation: `if not registry[role].frozen: <set frozen=True>` (idempotent one-liner in the same transaction). |

- [ ] **Step 1: Failing tests** — `test_role_site_conversions.py`: unknown role → `set_assignment_role` ValueError; boxable flag drives `next_box` (test role boxable=True works end-to-end, boxable=False raises — the hm-boxing rehearsal proof surrogate); variance_eligible=False test role gets excluded with the new reason; a NEW department + role appears as a new lane with a slugified key and the computed union contains its code; legacy lane keys unchanged (`hplc`/`microbiology`/`hm`); frozen flips on first assignment.
- [ ] **Step 2: Run → fail. Step 3: Convert site-by-site (table order), running `test_hm_role_sites.py` + `test_boxes_service.py` + `test_assignment_kind.py` + `test_catalog_demand.py` after each.**
- [ ] **Step 4: Full failure-set diff — MUST be identical to baseline (this task is behavior-preserving for the five legacy roles by construction).**
- [ ] **Step 5: Commit** `feat(catalog-bench): convert role sites to vial_roles reads (fail-closed)`.

---

### Task 8: Vial-plan contract — sections metadata + FE type widening

**Files:**
- Modify: `backend/sub_samples/schemas.py` (:108-124), `backend/sub_samples/service.py` (`compute_vial_plan` return), `backend/sub_samples/routes.py` (docstring)
- Modify: `src/lib/api.ts` (:5568, :5580-5596)
- Test: extend `backend/tests/test_sub_samples_routes.py`; `npx tsc --noEmit`

**Interfaces:**
- Consumes: `role_registry`, `inbox_lanes` idiom (Task 7), `resolve_catalog_fulfillment` (Task 4).
- Produces (consumed by Task 9): `VialPlanResponse` gains

```python
sections: list = [  # ordered by department sort_order; xtra NEVER appears (FE renders it always)
    {"department_id": 1, "department_name": "Analytical", "sort_order": 0,
     "roles": [
         {"code": "hplc", "label": "HPLC", "sort_order": 0, "variance_eligible": True,
          "profiles": [{"id": 3, "key": "hplcpurity_identity", "name": "HPLC Purity & Identity", "relation": "host"}]}
     ]}
]
```

`demand`/`base_demand` stay dicts (already role-keyed). A role enters `sections` iff `demand.get(code, 0) > 0` OR a non-parent vial currently carries it. `profiles[].relation` comes from `resolve_catalog_fulfillment` (riders → `"rider"` — Task 9's chips). FE: `AssignmentRole` widens to `string` (keep the named literals in a comment), `demand`/`base_demand` widen to `Record<string, number>` (copy the `VialDemandResponse` comment at api.ts:5898-5904 — `variance` stays `{hplc,endo,ster}` BY CONTRACT), new `VialPlanSection`/`VialPlanRoleSpot` types mirroring the shape above.

- [ ] **Step 1: Failing backend test:** HM-order plan response carries a "Heavy Metals" section with the hm role spot and host profile; legacy order carries Analytical + Microbiology sections with today's role spots; unreachable-IS early return carries `sections: []`.
- [ ] **Step 2: Implement in `compute_vial_plan`** (build sections after the persist loop, from `role_registry` + demand + current vials + fulfillment; IS-unreachable and empty-plan paths return `sections: []`). Widen the six `{"hplc": 0, ...}` default copies (schemas.py:117-118,:153, routes.py:428-430, service.py:1301-1303,:1745) — the literals stay as legacy floors (the `_LEGACY_BUCKETS` zero-floor contract), just documented.
- [ ] **Step 3: FE types; `npx tsc --noEmit`** — expect NEW errors in AssignStep consumers where `AssignmentRole` was load-bearing; fix by widening the local types ONLY (`BucketId` → `string` happens in Task 9; here fix only what tsc forces, minimally).
- [ ] **Step 4: Gates; commit** `feat(catalog-bench): vial-plan sections metadata + FE type widening`.

---

### Task 9: Dynamic AssignStep — department sections + role spots + rider chips

**Files:**
- Modify: `src/components/intake/ReceiveWizard/AssignStep.tsx`
- Test: `src/test/assign-step.test.tsx` (update the 4 string-coupled tests + add section tests)

**Interfaces:**
- Consumes: `plan.sections` (Task 8), `bucketToAssignment` (existing, already generic).
- Produces: the layout below. `Bucket` (:497-574), `SubDropZone` (:709-756), `VarianceDropZone` (:670-707) are kept VERBATIM except: `Bucket` gains a `shortLabel: string` prop replacing the `:569` `label === 'Analyses Dept.'` ternary (variance header reads `{shortLabel} Variance`).

**Deliberate display changes (call out for UAT):** section headers become real department names — "Analyses Dept." → "Analytical", the Microbiology header stays "Microbiology" (data-driven now). Test assertions updated accordingly.

- [ ] **Step 1: Update/extend tests FIRST** (RED): `:194`/`:295` `'Analyses Dept.'` → `'Analytical'` (fixtures gain `sections`); `/HPLC Variance/i` stays (now via `shortLabel="HPLC"` from `ROLE_SHORT_DEFAULTS`); NEW tests: an hm fixture plan renders a "Heavy Metals" section with an HM spot and the vial visible + labeled `HM` (the invisibility regression test); a rider profile renders a chip on its host spot (`{rider.name}` rendered inside the host `SubDropZone` header zone, the VarianceDropZone visual pattern: `text-[10px] uppercase` + `· rider` marker); a novel role (`t_role`) round-trips: appears in its section, drag targets exist, label falls back to `T_ROLE`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Rebuild the layout core** (:167-238 replaced; everything else kept):

```tsx
const ROLE_SHORT_DEFAULTS: Record<string, string> = { hplc: 'HPLC', endo: 'ENDO', ster: 'PCR', xtra: 'XTRA', hm: 'HM' }
const roleShort = (code: string) => ROLE_SHORT_DEFAULTS[code] ?? code.toUpperCase()

const sections = plan.sections ?? []
const vialsForRole = (code: string) => ({
  core: plan.vials.filter(v => v.assignment_role === code && v.assignment_kind !== 'variance'),
  variance: plan.vials.filter(v => v.assignment_role === code && v.assignment_kind === 'variance'),
})
const xtraVials = plan.vials.filter(v => v.assignment_role === 'xtra' || v.assignment_role == null)
// grid: one column per section + the always-on Xtra column
// section with ONE role: Bucket with direct drop (id = role code) — today's Analytical look
// section with >1 role: Bucket shell + one SubDropZone per role — today's Microbiology look
// variance zone: rendered per role when (plan.variance?.[code] ?? 0) > 0 || varianceVials.length > 0
//   (variance is legacy-only by contract — the dict only ever has hplc/endo/ster keys)
// rider chips: spot.profiles.filter(p => p.relation === 'rider') rendered under the spot label
//   using the VarianceDropZone header visual (text-[10px] uppercase muted) — NOT drop targets
```

Keep: `showXtra = true` always; `VARIANCE_OVERRIDE_FIELDS` + its ternaries UNCHANGED (legacy-only by backend contract — add the comment); `handleDragEnd`/`handleResetBucket`/`refresh` untouched; `BucketId` type → `string`; `ROLE_SHORT[role]` at :784 → `roleShort(role)`. MicroBucket is deleted (a 2-role section reproduces it); its BW-0015 comment (:616-622) MOVES to the section renderer — the constraint (nested variance zone must not swallow core drops) survives.
- [ ] **Step 4: Tests green; `npx tsc --noEmit`; `npm run test:run`.**
- [ ] **Step 5: Commit** `feat(catalog-bench): assignment page renders department sections from the catalog`.

---

### Task 10: FE surfaces sweep — boxing, labels, lanes, reassign

**Files:**
- Modify: `backend/main.py` (lanes endpoint), `src/lib/api.ts`, `src/components/intake/ReceiveWizard/{BoxStep,BoxLabelTemplate,LabelTemplate,OrderLabelTemplate,PrintStep}.tsx`, `src/components/hplc/WorksheetsInboxPage.tsx`, `src/components/senaite/{VialsQuickLookDialog,SampleDetails,SenaiteDashboard,AnalysisTable}.tsx`, `src/components/intake/ActiveBoxesPage.tsx`
- Test: extend `src/components/intake/ReceiveWizard/__tests__/BoxStep.test.tsx`, `src/test/box-step.test.tsx`, new `src/test/worksheets-inbox-lanes.test.tsx`

**Interfaces:**
- Consumes: `inbox_lanes` (Task 7), `useVialRoles()` (Task 2).
- Produces: `GET /worksheet-inbox/lanes` → `[{key, label, role_codes, sort_order}]`; FE `useInboxLanes()` hook in `src/services/inbox-lanes.ts` (queryKey `['worksheet-inbox-lanes']`).

**Site-by-site (each gets a test or is covered by tsc):**

| Site | Change |
|---|---|
| `BoxStep.tsx:79,:96` | `BoxRole`→`string`; `ROLES` becomes `useVialRoles()` filtered `boxable`, ordered `sort_order` (grid columns follow data — flipping hm's flag in admin lights the column with zero code change). Auto-create effect keyed the same way. |
| `BoxLabelTemplate.tsx:4,:25` + `BoxStep.tsx:109` **[F2]** | `ROLE_SHORT[role] ?? role.toUpperCase()` at both read sites (kills the printed `undefined`). |
| `LabelTemplate.tsx:3-8,:40` | Same fallback; `role?: string`. |
| `OrderLabelTemplate.tsx:1-9` **[N24]** | `DEPT_LABEL`→`Record<string,string>` + fallback; prop renamed `role` (it types a role as "department" — fix the naming collision). |
| `PrintStep.tsx:40,:109-113,:215` **[N23]** | Counts become `Record<string, number>` accumulated from actual vial roles (the WizardHeader shape-driven pattern); print loop maps `Object.keys(counts)`. |
| `WorksheetsInboxPage.tsx:427-451,:529,:532,:54-57` **[F3,N18,N19]** | Chips map over `useInboxLanes()`; `loadStoredRole` validates against fetched keys (fallback first lane); empty-state copy uses the lane LABEL (`No {lane.label} vials waiting` / switch-hint lists the other lanes' labels); `InboxRole` type → `string`. |
| `api.ts:4872,:5568,:6082,:6102,:5988` **[N16,N17]** | Unions → `string` with the named literals preserved in comments; `createBox` role param `string`. |
| `VialsQuickLookDialog.tsx:60-66` **[site 40]** | `REASSIGN_OPTIONS` built from `useVialRoles()`: label = `${department?.name ?? 'Extra'} — ${label}`, ordered by sort; keep the `null` "Unassigned" entry. |
| `SampleDetails.tsx:3875-3888` **[N25]** | switch → lookup over `useVialRoles()` rows (`{dept} — {label}`), fallback `role.toUpperCase()` — hm's "Assigned to" line appears. |
| `SenaiteDashboard.tsx:168-176` **[F5]** | hm badge label `'HM'` → `'M'` (single-glyph convention — the "HM HM" fix). |
| `AnalysisTable.tsx:107-112` **[F16]** | Add `hm` entry + `?? fallback` at read sites. |
| `ActiveBoxesPage.tsx:19` | Add `hm: 'Heavy Metals'` (fallbacks already exist). |

- [ ] **Step 1: Backend lanes endpoint + test** (new department+role appears as a lane; legacy keys stable).
- [ ] **Step 2: FE tests RED first** for: BoxStep columns follow a mocked boxable set (hm off by default, on when flag true); box-label fallback prints `T_ROLE` not `undefined`; lane chips render from mocked lanes incl. an `hm` chip (the lane was UNREACHABLE before — regression test); REASSIGN_OPTIONS contains Heavy Metals.
- [ ] **Step 3: Implement site-by-site; run the FE suites + tsc after each file.**
- [ ] **Step 4: Gates; commit** `feat(catalog-bench): dynamic boxing/labels/lanes/reassign surfaces`.

---

### Task 11: Profile SLA tier

**Files:**
- Modify: `backend/models.py` (AnalysisProfile), `backend/database.py` (ALTER), `backend/main.py` (:15622 serializer, POST/PATCH), `src/lib/api.ts`, `src/lib/sla-resolution.ts`, `src/services/analysis-sla.ts`, `src/components/explorer/SlaBreakdownTooltip.tsx`, `src/components/hplc/AnalysisProfilesPage.tsx`
- Test: `src/lib/__tests__/sla-resolution.test.ts` (extend), `backend/tests/test_analysis_profiles.py` (extend)

**Interfaces:**
- Produces: `analysis_profiles.sla_tier_id INT NULL REFERENCES sla_tiers(id)` (deviation 1 — NOT sla_days); profile response + payloads carry it; `GET /analysis-profiles` response gains `member_service_ids: list[int]` (free — the relationship is `lazy="selectin"`); FE precedence step **2.5** in `resolveSampleTiersByGroup` (`sla-resolution.ts:439-523`, inserted at :498): profile tier beats the group's own tier, loses to priority overrides; `TierSource` gains `'profile'`; tooltip renders "Profile SLA — {profile name}".

- [ ] **Step 1: Backend:** ALTER `ADD COLUMN IF NOT EXISTS sla_tier_id INTEGER REFERENCES sla_tiers(id)` in the spec-4 DDL block; model column; serializer + create/update pass-through (validate the tier exists → 400). Test: POST with tier echoes it; bad id 400s.
- [ ] **Step 2: FE resolution:** build `serviceIdToProfileTier` from `useAnalysisProfiles()` (`member_service_ids` × `sla_tier_id`); in the per-bucket walk insert step 2.5 between the per-group priority step (:483-497) and the group's-own-tier step (:499-508): if any service in the bucket belongs to a profile with a tier, tightest profile tier wins with `source: 'profile'`. Keep `resolveSampleTierWithReason` in lockstep (:168-169 contract). Extend the resolution unit tests: profile tier beats group tier; priority override still beats profile; legacy rows (no profile tier) fall through unchanged.
- [ ] **Step 3: Admin UI:** SLA tier `Select` (from `useSlaTiers()`) in the profile edit dialog; tooltip variant in `SlaBreakdownTooltip.tsx`.
- [ ] **Step 4: Gates; commit** `feat(catalog-bench): profile-level SLA tier with group fallback`.

---

### Task 12: Bench stations + QR scan-in (soft custody)

**Files:**
- Modify: `backend/models.py` (BenchStation), `backend/database.py` (DDL), `backend/main.py` (stations CRUD + scan endpoints + activity label elif near :1358)
- Create: `public/m/bench.html`, `public/m/bench.js`
- Test: `backend/tests/test_bench_scan.py`
- Modify: `nginx.conf` — NO (already serves `/m/` via try_files; no SSE needed)

**Interfaces:**
- Produces: `bench_stations(id, name UNIQUE NOT NULL, department_id FK NOT NULL, active BOOL DEFAULT TRUE, sort_order, created_at, updated_at)`; `GET/POST/PATCH /bench-stations` (no DELETE — deactivate; ships EMPTY pending G-STATION); event kind **`bench_scanned`** on `LimsSubSampleEvent` (`details={"station_id", "station_name"}`, written in the same transaction as nothing else — it IS the action); `POST /bench-scans {station_id, sample_id}` (JWT, desktop scanner-gun path) and `POST /api/bench/{token}/scan {sample_id}` (capture-token path: mint via the existing `POST /api/capture-tokens` idiom with `context_json={"station_id": N}`); activity feed labels it "Scanned in at {station_name}". SOFT custody (deviation 7): never gates result entry.

- [ ] **Step 1: Failing tests:** station CRUD; JWT scan writes the event with station details + actor; token scan writes with `user_id=None`; scan against an inactive station → 400; unknown sample → 404; the event appears in `GET /samples/{id}/activity` with the human label.
- [ ] **Step 2: Implement** (model + DDL in the spec-4 block; endpoints; the `elif` in the activity label chain next to the `box_*` branches; token flow copies `capture_tokens/routes.py:79-121` shape minus photos — 404 expired/revoked, station resolved from frozen `context_json`).
- [ ] **Step 3: Phone page.** `public/m/bench.html` + `bench.js` with `const API = '/api/api'` (the nginx double-prefix contract — `public/m/capture.js:1` precedent): station name header (from `GET /api/bench/{token}` returning `{station_name}`), a text input autofocused for scanner-gun/manual entry of the vial `sample_id`, submit → POST → success flash + input clear (rapid sequential scans). No camera dependency.
- [ ] **Step 4: Gates; commit** `feat(catalog-bench): bench stations + QR scan-in events (soft custody)`.

---

### Task 13: Acceptance — "manager authors, lab follows" + role-coverage + parity

**Files:**
- Test: `backend/tests/test_catalog_bench_acceptance.py`, `src/test/assign-step-acceptance.test.tsx` (fixture-level)

**Interfaces:** consumes everything above; produces the spec's headline proofs.

- [ ] **Step 1: The acceptance test (spec verbatim: "new department + new profile via API only → assignment page shows the new section and spot with zero code changes"):**

```python
def test_manager_authors_lab_follows(client, db_session):
    dep = client.post("/departments", json={"name": "ZZ Bench"}).json()
    prof = client.post("/analysis-profiles", json={
        "key": "zz_accept", "name": "ZZ Acceptance", "is_addon": True,
        "fulfillment_dim": "role", "fulfillment_role": "zz_acc",
        "role_department_id": dep["id"], "vials_required": 1}).json()
    # + one mk1-origin member service via PUT members
    # simulate order services {"zz_accept": 1} through resolve_catalog_fulfillment
    # → demand {'zz_acc': 1}; vial-plan sections contain ZZ Bench + zz_acc spot with the profile as host;
    # lane map contains a 'zz_bench' lane with the code; box-label summary counts the vial;
    # set_assignment_role writes the custody edge; seeding seeds the member service.
```

- [ ] **Step 2: Role-coverage test** (spec's Layer-5 mitigation): a novel role traverses demand→assign→lane→box-label without a silent drop — assert loud failure modes: unknown code to `set_assignment_role` raises; unboxable code to `next_box` raises; unknown lane key 400s.
- [ ] **Step 3: Ride headline cases** (spec Testing section, test-only keys): fent-alone / fent+HPLC-analog / fent+endo-analog / vacuum-chain — demand counts + edge relations + seeding unions per the spec's four bullets.
- [ ] **Step 4: Legacy parity sweep:** full backend suite failure-set diff vs baseline == EMPTY; `npm run test:run` green; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `test(catalog-bench): acceptance + role-coverage + parity proofs`.

---

## Self-review notes (already applied)

- Spec §Layer 1-5 → Tasks 1-4 (L1), 4 (L2), 5-6 (L3), 8-9 (L4), 7+10-11 (L5 + SLA); scan-in → 12; acceptance → 13. Spec's "ordered_keys dedup / PUR_/QTY_ prefixes" riders are spec-3 shipped code — untouched here.
- The worksheet re-key + COA blocking gate (group consumers) are DELIBERATELY not converted (spec: SENAITE phase-out territory). `_NON_HPLC_GROUPS` (seeder.py:158) and `computePrimaryAnalysisUids`'s `'Analytics'` literal (N27) stay — ledgered, not spec-4 scope.
- Variance stays legacy-only end to end: `derive_variance_demand` untouched; riders can't carry variance (`auto_assign` gates variance on `demand[bucket] > 0`; a ridden profile contributes no bucket).
- `wp_services` dict-order dependence (ledger F10) is NARROWED by deterministic rider sort but the anchor MAX path keeps dict-order for member unions — unchanged behavior, G-V ratifies.
- Deferred ledger items NOT absorbed here (stay ledgered): F7 (bench short-circuit observation bundle), F9 (seeder loudness gap — partially improved by the fallback warning), F17 (N+1 IN-query), F22 (demand_divergence dedup — deploy-window alerting decision), F23 (mk1 inbox status desync — orthogonal), F24 (inactive-profile display filtering).
