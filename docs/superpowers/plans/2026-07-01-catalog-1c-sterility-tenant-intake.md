# Catalog 1C — Sterility Tenant + Intake (Accu-Mk1 slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Sterility test family as the first tenant of the Accu-Mk1 test catalog and make its home-Department the single routing key, without changing any current physical or reported outcome.

**Architecture:** Three additive backend changes on the existing catalog (Department/ServiceGroup/AnalysisService from Plan 1A, safety-couplings from Plan 1B). (1) Convert the last name-pinned coupling — the COA-generation micro classifier — from `ServiceGroup.name` to `Department.name == "Microbiology"`, matching the mirror/inbox lanes already converted in 1B. (2) Seed the Sterility tenant rows (a "Sterility PCR" assignable group over the existing `PCR-FUNGI`/`PCR-BACTERIA` services, a **native** `STER-USP71` service with no SENAITE link, and a single-member "Sterility USP<71>" group carrying a ~14-day SLA tier) via idempotent SQL in `database._run_migrations()`. (3) A parity/regression harness proving existing intake (demand, seeding, HPLC-mirror exclusion, inbox lane) is byte-identical and the new tenant routes correctly.

**Tech Stack:** Python 3, FastAPI, SQLAlchemy, PostgreSQL (prod/dev); pytest. No frontend changes. No integration-service/coabuilder/WordPress changes (those are Plans 1D/1E/1F).

## Global Constraints

- **Additive cutover, not rip-and-replace** (spec locked decision #7). The legacy demand/seeding literals (`derive_base_demand` `ster:2`, `ROLE_TO_KEYWORDS["ster"]=["STER-PCR"]`) STAY LIVE and unchanged in 1C. They are the still-current intake path; they retire in a later phase when per-product orders exist. 1C only *adds* the tenant, converts the COA gate, and proves parity.
- **Convert the coupling BEFORE creating the group** (spec decisions #5/#137). Task 1 (COA-gate → Department) lands before Task 2 (seed the "Sterility PCR" group). Deploying Task 2 without Task 1 arms the landmine.
- **Department — not group — drives routing** (spec invariant). Every routing decision keys on `AnalysisService.department_id` / `Department.name`, never on a group name.
- **USP-71 is SENAITE-free** (spec decision #8, "Full B"): the `STER-USP71` `analysis_services` row has `senaite_id = NULL` and `senaite_uid = NULL`. `senaite_id` is `unique` but nullable — Postgres permits many NULLs.
- **USP-71's SLA comes from a single-member group.** The FE resolver honors *group* tiers only (`sla-resolution.ts`), and there is no backend writer for `analysis_services.sla_tier_id`. So USP-71 gets its ~14-day tier via a one-member "Sterility USP<71>" group. (Handler decision 2026-07-01.)
- **~14-day SLA tier = `target_minutes = 20160`** (14 × 24 × 60). Not the default tier (`is_default = FALSE`). (Handler-confirmed ~14-day, 2026-07-01.)
- **Demand-parity scope** (spec §247): parity is asserted against the legacy `sterility_pcr` order flag (→ 2 vials). Per-product single-product demand (→ 1 vial) is new behavior that arrives with 1D/1F and is explicitly *outside* the 1C parity set.
- **ISO 17025 alignment:** the catalog seed is a change-control surface — the seeded rows are the versioned definition of the test (7.4.2). The COA-gate parity test is validation evidence for the classifier change (7.11.2); retain it.
- **JWT_SECRET unchanged.** No schema-breaking change; migrations are idempotent and forward-only.

## Execution environment (READ FIRST)

There is **no Python on the laptop.** Backend pytest runs on the devbox `catalog` stack. The per-step loop is:

```bash
# 1. edit + commit locally (worktree: C:/tmp/Accu-Mk1-departments)
git -C C:/tmp/Accu-Mk1-departments add <explicit paths>   # NEVER git add -A (worktree carries unrelated dirty files)
git -C C:/tmp/Accu-Mk1-departments commit -m "<msg>"
git -C C:/tmp/Accu-Mk1-departments push

# 2. pull on the devbox worktree, then run the test
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-departments pull -q && \
  docker exec accumark-catalog-accu-mk1-backend sh -c "cd /app && python -m pytest tests/<file> -q"'
```

**Migration changes (Task 2) require a backend restart** — `_run_migrations()` runs at `init_db()` on boot, not per-request:

```bash
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-departments pull -q && \
  docker restart accumark-catalog-accu-mk1-backend'
# wait for healthy, then run pytest as above
```

Gotchas:
- After any `accumark-stack mount`/recreate, pytest is wiped: `docker exec accumark-catalog-accu-mk1-backend pip install -q pytest`.
- Live-PG tests use rollback-only teardown + `ZZTEST` throwaway rows + `commit=False`; nothing persists. Never commit test rows.
- Benign `migration_skipped (lims_analyses_review_state_check)` on every boot is known-stale; ignore.
- Test admin on the stack: `tester@accumark.local` / `AccuTest!2026`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/lims_analyses/seeder.py` | `_micro_group_keywords` — the COA-gate micro classifier | **Modify** `:111-133` (repoint the query to Department). Leave `_NON_HPLC_GROUPS` `:108` defined as a documented legacy constant. |
| `backend/catalog/departments.py` | `_GROUP_NAME_TO_DEPARTMENT` map | **Modify** `:19-23` (add the two new group names → Microbiology). |
| `backend/database.py` | `_run_migrations()` idempotent SQL list | **Modify** — append the 6 tenant-seed statements to the `migrations` list (before the closing `]` at `:863`). |
| `backend/tests/test_coa_gate_micro_department.py` | COA-gate classifier is Department-based + parity | **Create** |
| `backend/tests/test_sterility_tenant_seed.py` | tenant rows seeded correctly | **Create** |
| `backend/tests/test_sterility_intake_parity.py` | existing intake unchanged + new tenant routes right | **Create** |

Consumers to be aware of (NOT modified — the function contract is preserved):
- `backend/main.py:9430-9463` — COA gate calls `_micro_group_keywords(db)` twice. Unchanged; it keeps working because Task 1 preserves the name/signature/return type (`Set[str]` of keywords).
- `backend/coa/block_summary.py:98-133` — treats any keyword NOT in `micro_keywords` as COA-blocking. Unchanged; benefits from the corrected micro set.
- `backend/tests/test_assign_role_fail_hard.py:8,49-65` — imports `_micro_group_keywords` as a micro-exclusion oracle. Unchanged; still valid.

---

## Task 1: Convert the COA-gate micro classifier to Department basis

**Files:**
- Modify: `backend/lims_analyses/seeder.py:105-133`
- Test: `backend/tests/test_coa_gate_micro_department.py` (create)

**Interfaces:**
- Consumes: `catalog.departments.department_id_by_name(db, name) -> Optional[int]` (existing, `:31`); `models.AnalysisService`, `models.Department`.
- Produces: `_micro_group_keywords(db: Session) -> Set[str]` — SAME name/signature/return type as today (a set of keywords). Two live consumers (`main.py` COA gate, `test_assign_role_fail_hard.py`) rely on this contract; do not rename or change the return type.

**Background:** Post-1B the HPLC mirror (`seeder.py:187,256`) and inbox lane (`main.py:14592-14607`) route by Department, but this one classifier still selects micro keywords via `ServiceGroup.name.in_(("Microbiology","Endotoxin"))`. A Microbiology-department service whose only group is *not* named `Microbiology`/`Endotoxin` — exactly the incoming "Sterility PCR" group and the native `STER-USP71` in "Sterility USP<71>" — is missed, so an unfinished sterility result would be mis-flagged as a COA-blocking analyte and demand a bogus chromatogram. This is the "1C landmine."

**Both-directions safety (why this is safe now).** Membership in the micro set is not neutral: a keyword IN it is *exempted* from COA-blocking and the chromatogram requirement (`coa/block_summary.py`: non-micro ⇒ blocking). The Department query *expands* the exempt set to every `department_id=Microbiology` service, so the dangerous direction is a service wrongly departmented Microbiology silently skipping a chromatogram it should require — on a customer certificate. **Verified empirically 2026-07-01:** on the devbox `catalog` stack, `(Department-micro − group-name-micro) = ∅` today, so the conversion is a proven no-op on current data. Task 1's test locks BOTH directions (subset guard for drops, allowlist guard for additions) so this stays true.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_coa_gate_micro_department.py`. It uses the live-Postgres `db` fixture pattern from `test_seeder_mirror.py` (rollback teardown, `ZZTEST` throwaway rows). The discriminating test mints a Microbiology-department service whose only group is NOT named Microbiology/Endotoxin — the exact shape Task 2 introduces — and asserts it is classified micro. This FAILS today (the group-name query misses it).

```python
"""Plan 1C Task 1: the COA-gate micro classifier is Department-based.

Live Postgres (catalog seeded at boot). Rollback-only teardown; ZZTEST rows.
"""
import pytest
from sqlalchemy import select

from database import SessionLocal
from models import AnalysisService, Department, ServiceGroup, service_group_members
from catalog.departments import department_id_by_name
from lims_analyses.seeder import _micro_group_keywords, _NON_HPLC_GROUPS


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _old_group_name_micro_keywords(db) -> set[str]:
    """The pre-1C group-NAME classifier, inlined, to assert parity against."""
    rows = db.execute(
        select(AnalysisService.keyword)
        .join(service_group_members,
              service_group_members.c.analysis_service_id == AnalysisService.id)
        .join(ServiceGroup, ServiceGroup.id == service_group_members.c.service_group_id)
        .where(ServiceGroup.name.in_(_NON_HPLC_GROUPS))
    ).scalars().all()
    return {k for k in rows if k}


def test_catches_microbiology_service_in_a_nonmicro_named_group(db):
    """A Microbiology-dept service whose only group is NOT named
    Microbiology/Endotoxin must still be micro — the landmine case."""
    micro_id = department_id_by_name(db, "Microbiology")
    assert micro_id is not None, "Microbiology department must be seeded"

    svc = AnalysisService(
        title="ZZ Sterility Probe", keyword="ZZTEST-STER-PROBE", department_id=micro_id
    )
    db.add(svc)
    db.flush()
    grp = ServiceGroup(name="ZZTEST Sterility PCR", department_id=micro_id, is_assignable=True)
    db.add(grp)
    db.flush()
    db.execute(service_group_members.insert().values(
        service_group_id=grp.id, analysis_service_id=svc.id))
    db.flush()

    assert "ZZTEST-STER-PROBE" in _micro_group_keywords(db)


def test_parity_no_existing_micro_keyword_is_dropped(db):
    """SAFE direction: Department set must be a superset of the legacy
    group-name set — no COA-gate regression for HPLC/existing micro."""
    old = _old_group_name_micro_keywords(db)
    new = _micro_group_keywords(db)
    assert old <= new, f"dropped micro keywords: {sorted(old - new)}"


# The only intended NEW additions to the micro-exempt set (native sterility
# services that live in a non-"Microbiology"-named group). Verified empirically
# 2026-07-01: the delta is empty pre-seed and exactly this set post-Task-2.
_EXPECTED_NEW_MICRO = {"STER-USP71"}


def test_no_unexpected_keyword_added_to_micro_exempt_set(db):
    """DANGEROUS direction: a keyword IN the micro set is EXEMPTED from the COA
    chromatogram requirement. The Department conversion must not silently exempt
    an analytical service that was mis-departmented Microbiology. Any addition
    beyond the known native sterility services fails loudly."""
    old = _old_group_name_micro_keywords(db)
    new = _micro_group_keywords(db)
    added = new - old
    assert added <= _EXPECTED_NEW_MICRO, (
        f"UNEXPECTED keywords newly exempted from COA-blocking: "
        f"{sorted(added - _EXPECTED_NEW_MICRO)} — check for a mis-departmented "
        f"analytical service (would skip a required chromatogram on a certificate)"
    )


def test_returns_exactly_microbiology_department_keywords(db):
    """The new set == every Microbiology-department service keyword."""
    micro_id = department_id_by_name(db, "Microbiology")
    expected = set(db.execute(
        select(AnalysisService.keyword).where(
            AnalysisService.department_id == micro_id,
            AnalysisService.keyword.isnot(None),
        )
    ).scalars().all())
    assert _micro_group_keywords(db) == expected
```

- [ ] **Step 2: Run the test to verify it fails**

Run (via the devbox loop): `python -m pytest tests/test_coa_gate_micro_department.py -q`
Expected: `test_catches_microbiology_service_in_a_nonmicro_named_group` FAILS (`ZZTEST-STER-PROBE` not in the group-name-based set); `test_returns_exactly_microbiology_department_keywords` FAILS too. The two direction-guards (`test_parity_no_existing_micro_keyword_is_dropped`, `test_no_unexpected_keyword_added_to_micro_exempt_set`) PASS even pre-fix (new==old ⇒ delta ∅), which is correct — they guard, they don't drive.

- [ ] **Step 3: Repoint `_micro_group_keywords` to Department**

In `backend/lims_analyses/seeder.py`, replace the body of `_micro_group_keywords` (`:111-133`) with the Department query. Keep `_NON_HPLC_GROUPS` (`:108`) defined, annotated as legacy.

```python
# Legacy group-name list — retained for reference/parity tests only. The COA
# gate no longer keys on it (Plan 1C repointed the classifier to Department,
# matching the HPLC mirror and inbox lane). Do not add new consumers.
_NON_HPLC_GROUPS = ("Microbiology", "Endotoxin")


def _micro_group_keywords(db: Session) -> Set[str]:
    """Keywords of every Microbiology-department service.

    The COA gate's "micro never blocks / never needs a chromatogram" oracle.
    Department-based (Plan 1C) so it matches the HPLC-mirror allow-list
    (seeder.py mirror uses department_id_by_name(db, "Analytical")) and the
    inbox lane. The prior ServiceGroup.name.in_(("Microbiology","Endotoxin"))
    query missed a Microbiology service living only in a differently-named
    group (the "Sterility PCR" group, or the native STER-USP71 in
    "Sterility USP<71>"), which would mis-flag an unfinished sterility result
    as a COA-blocking analyte. Keying on the single home Department removes it.
    Fails closed: if the Microbiology department is somehow absent, returns an
    empty set (COA gate then treats all analytes as blocking — loud, not wrong).
    """
    from catalog.departments import department_id_by_name
    micro_dept_id = department_id_by_name(db, "Microbiology")
    if micro_dept_id is None:
        return set()
    rows = db.execute(
        select(AnalysisService.keyword).where(
            AnalysisService.department_id == micro_dept_id
        )
    ).scalars().all()
    return {k for k in rows if k}
```

Verify imports already present at the top of `seeder.py`: `select` (SQLAlchemy), `Session`, `Set`, and `AnalysisService`. All are used by the current implementation, so no new top-level import is needed except the function-local `department_id_by_name` shown above.

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_coa_gate_micro_department.py -q`
Expected: all 4 tests PASS.

- [ ] **Step 5: Regression — the existing COA-gate + seeder suites still pass**

Run: `python -m pytest tests/test_assign_role_fail_hard.py tests/test_seeder_mirror.py -q`
Expected: PASS (the `_micro_group_keywords` contract is unchanged; `test_assign_role_fail_hard.py` imports it as an oracle).

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-departments add backend/lims_analyses/seeder.py backend/tests/test_coa_gate_micro_department.py
git -C C:/tmp/Accu-Mk1-departments commit -m "fix(catalog): COA-gate micro classifier keys on Department, not group name (1C landmine)"
```

---

## Task 2: Seed the Sterility tenant

**Files:**
- Modify: `backend/database.py` (append to the `migrations` list inside `_run_migrations`, before the closing `]` at `:863`)
- Modify: `backend/catalog/departments.py:19-23` (`_GROUP_NAME_TO_DEPARTMENT`)
- Test: `backend/tests/test_sterility_tenant_seed.py` (create)

**Interfaces:**
- Consumes: existing `analysis_services` rows `PCR-FUNGI`, `PCR-BACTERIA` (Microbiology, SENAITE-mirrored); the `departments` row `Microbiology` (seeded by `backfill_departments`, which runs *after* `_run_migrations`); `sla_tiers`.
- Produces (in the catalog): SLA tier `Sterility USP<71>` (20160 min); `service_groups` rows `Sterility PCR` and `Sterility USP<71>`; native `analysis_services` row `STER-USP71`; the four `service_group_members` links.

**Ordering note:** `_run_migrations()` (`database.py:122`) runs BEFORE `backfill_departments()` (`:128`). On a **fresh** DB the `departments` rows do not exist yet, so the `(SELECT id FROM departments WHERE name='Microbiology')` subquery yields NULL for the new groups' `department_id`; `backfill_departments` then fills it from `_GROUP_NAME_TO_DEPARTMENT` — which is why extending that map (below) is REQUIRED, not cosmetic. On an existing DB (prod/devbox) the departments already exist and the subquery sets `department_id` immediately. The native `STER-USP71` service's `department_id` is filled by `backfill_departments` step 3 (cascade from its group). Both paths converge on Microbiology.

**Silent-partial-seed note:** `_run_migrations()` executes each statement in its own `try/except` (`database.py:868-875`), so a failure in one statement (e.g. the tier insert) does NOT abort boot — the USP-71 group's `sla_tier_id` subquery would then quietly resolve to NULL. The boot log won't flag it. The Step-1 tests are the net: they assert the tier id matches and members exist, so a half-seed fails the suite. Trust the tests, not a clean boot.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_sterility_tenant_seed.py` (live-PG; asserts the boot-time migration produced the tenant). Also assert the map extension via `department_for_group_name`.

```python
"""Plan 1C Task 2: the Sterility tenant is seeded into the catalog.

Live Postgres — the rows are produced by database._run_migrations() +
backfill_departments() at boot. Read-only assertions; no writes.
"""
import pytest
from sqlalchemy import select

from database import SessionLocal
from models import AnalysisService, Department, ServiceGroup, SlaTier, service_group_members
from catalog.departments import department_for_group_name


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _group(db, name):
    return db.execute(select(ServiceGroup).where(ServiceGroup.name == name)).scalar_one_or_none()


def _members(db, group):
    return set(db.execute(
        select(AnalysisService.keyword)
        .join(service_group_members, service_group_members.c.analysis_service_id == AnalysisService.id)
        .where(service_group_members.c.service_group_id == group.id)
    ).scalars().all())


def test_usp71_sla_tier_seeded():
    with SessionLocal() as db:
        tier = db.execute(select(SlaTier).where(SlaTier.name == "Sterility USP<71>")).scalar_one_or_none()
        assert tier is not None
        assert tier.target_minutes == 20160
        assert tier.is_default is False


def test_native_usp71_service(db):
    svc = db.execute(select(AnalysisService).where(AnalysisService.keyword == "STER-USP71")).scalar_one_or_none()
    assert svc is not None
    assert svc.senaite_id is None and svc.senaite_uid is None      # SENAITE-free
    micro = db.execute(select(Department).where(Department.name == "Microbiology")).scalar_one()
    assert svc.department_id == micro.id                           # backfill cascaded the dept


def test_sterility_pcr_group(db):
    g = _group(db, "Sterility PCR")
    assert g is not None
    micro = db.execute(select(Department).where(Department.name == "Microbiology")).scalar_one()
    assert g.department_id == micro.id
    assert g.vials_required == 1
    assert g.is_assignable is True
    assert _members(db, g) == {"PCR-FUNGI", "PCR-BACTERIA"}


def test_usp71_group_is_single_member_with_14day_tier(db):
    g = _group(db, "Sterility USP<71>")
    assert g is not None
    assert g.vials_required == 1
    assert g.is_assignable is True
    tier = db.execute(select(SlaTier).where(SlaTier.name == "Sterility USP<71>")).scalar_one()
    assert g.sla_tier_id == tier.id
    assert _members(db, g) == {"STER-USP71"}


def test_group_name_department_map_extended():
    assert department_for_group_name("Sterility PCR") == "Microbiology"
    assert department_for_group_name("Sterility USP<71>") == "Microbiology"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_sterility_tenant_seed.py -q`
Expected: FAIL (rows/map entries do not exist yet).

- [ ] **Step 3: Extend the department map**

In `backend/catalog/departments.py`, extend `_GROUP_NAME_TO_DEPARTMENT` (`:19-23`):

```python
_GROUP_NAME_TO_DEPARTMENT = {
    "Analytics": "Analytical",
    "Microbiology": "Microbiology",
    "Endotoxin": "Microbiology",
    # Plan 1C sterility tenant — both nest under the Microbiology bench.
    "Sterility PCR": "Microbiology",
    "Sterility USP<71>": "Microbiology",
}
```

- [ ] **Step 4: Append the tenant-seed SQL to `_run_migrations`**

In `backend/database.py`, append these six statements to the `migrations` list, in this order (each is idempotent; they follow the existing precedents at `:401-404` (tier seed), `:688-695` (membership `ON CONFLICT DO NOTHING`), `:719-728` (native service `WHERE NOT EXISTS`)). Insert them just before the list's closing `]` (`:863`).

```python
        # ── Plan 1C: Sterility tenant ────────────────────────────────────────
        # USP<71> gets its own ~14-day SLA via a single-member group (the FE
        # resolver honors group tiers, not per-service ones). 14d = 20160 min.
        """
        INSERT INTO sla_tiers (name, target_minutes, business_hours_only, is_default, amber_threshold_percent, created_at, updated_at)
        SELECT 'Sterility USP<71>', 20160, FALSE, FALSE, 20, NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM sla_tiers WHERE name = 'Sterility USP<71>')
        """,
        # Native USP<71> sterility service — SENAITE-free (senaite_id/uid NULL).
        # result_options mirror the PCR 0/1 shape; CONFIRM lab terminology before
        # the per-product split ships (dormant until then). department_id is left
        # to backfill_departments (cascades Microbiology from its group).
        # Idempotent (analysis_services.keyword is not unique -> guard on NOT EXISTS).
        """
        INSERT INTO analysis_services (title, keyword, category, result_options, active, is_assignable, created_at, updated_at)
        SELECT 'USP<71> Sterility', 'STER-USP71', 'Additional Testing',
               '[{"value":"0","label":"No Growth"},{"value":"1","label":"Growth"}]'::jsonb,
               TRUE, FALSE, NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM analysis_services WHERE keyword = 'STER-USP71')
        """,
        # "Sterility PCR" assignable group (Microbiology). department_id set from
        # the dept row when present; NULL on a fresh DB -> backfill fills it from
        # _GROUP_NAME_TO_DEPARTMENT. sla_tier_id left NULL (dormant until the
        # per-product split seeds vials via this group in a later phase).
        """
        INSERT INTO service_groups (name, description, color, sort_order, is_default, department_id, vials_required, is_assignable, created_at, updated_at)
        SELECT 'Sterility PCR', 'Rapid Sterility Screening (PCR) - Fungi + Bacteria qPCR', 'purple', 0, FALSE,
               (SELECT id FROM departments WHERE name = 'Microbiology'), 1, TRUE, NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM service_groups WHERE name = 'Sterility PCR')
        """,
        # Members of Sterility PCR: the existing PCR-FUNGI + PCR-BACTERIA services.
        """
        INSERT INTO service_group_members (service_group_id, analysis_service_id)
        SELECT g.id, s.id
        FROM service_groups g
        JOIN analysis_services s ON s.keyword IN ('PCR-FUNGI', 'PCR-BACTERIA')
        WHERE g.name = 'Sterility PCR'
        ON CONFLICT (service_group_id, analysis_service_id) DO NOTHING
        """,
        # "Sterility USP<71>" single-member group carrying the ~14-day tier.
        """
        INSERT INTO service_groups (name, description, color, sort_order, is_default, department_id, vials_required, is_assignable, sla_tier_id, created_at, updated_at)
        SELECT 'Sterility USP<71>', 'Compendial USP<71> sterility (~14-day)', 'purple', 0, FALSE,
               (SELECT id FROM departments WHERE name = 'Microbiology'), 1, TRUE,
               (SELECT id FROM sla_tiers WHERE name = 'Sterility USP<71>'), NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM service_groups WHERE name = 'Sterility USP<71>')
        """,
        # Member of Sterility USP<71>: the native STER-USP71 service.
        """
        INSERT INTO service_group_members (service_group_id, analysis_service_id)
        SELECT g.id, s.id
        FROM service_groups g
        JOIN analysis_services s ON s.keyword = 'STER-USP71'
        WHERE g.name = 'Sterility USP<71>'
        ON CONFLICT (service_group_id, analysis_service_id) DO NOTHING
        """,
```

- [ ] **Step 5: Push, restart the backend (re-runs migrations), and verify the test passes**

```bash
git -C C:/tmp/Accu-Mk1-departments add backend/database.py backend/catalog/departments.py backend/tests/test_sterility_tenant_seed.py
git -C C:/tmp/Accu-Mk1-departments commit -m "feat(catalog): seed Sterility tenant (PCR group + native USP-71 + 14-day tier)"
git -C C:/tmp/Accu-Mk1-departments push
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-departments pull -q && docker restart accumark-catalog-accu-mk1-backend'
# wait ~10s for healthy
ssh forrestparker@100.73.137.3 'docker exec accumark-catalog-accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_sterility_tenant_seed.py -q"'
```
Expected: all 5 tests PASS. (Commit already made above so the deliverable is durable before the restart.)

- [ ] **Step 6: Idempotency check — restart again, re-run**

Run: `ssh forrestparker@100.73.137.3 'docker restart accumark-catalog-accu-mk1-backend'` then re-run the tenant-seed test.
Expected: still 5 PASS, and no duplicate rows (the `WHERE NOT EXISTS` / `ON CONFLICT` guards make a second boot a no-op). Optionally confirm single rows:
`docker exec accumark-catalog-postgres psql -U postgres -d accumark_mk1 -c "SELECT name, count(*) FROM service_groups WHERE name LIKE 'Sterility%' GROUP BY name;"` → each count = 1.

---

## Task 3: Parity/regression harness — existing intake unchanged, new tenant routes correctly

**Files:**
- Test: `backend/tests/test_sterility_intake_parity.py` (create)

**Interfaces:**
- Consumes: `sub_samples.service.derive_base_demand`; `lims_analyses.seeder.select_services_for_role`, `seed_analyses_for_vial`, `_micro_group_keywords`; `main._inbox_allowed_group_ids`; the seeded tenant from Task 2.
- Produces: no code — assertions that lock 1C's "reproduce exactly + new tenant safe" contract.

**Why no source change:** per Global Constraints, the legacy demand/seeding literals stay live in 1C. This task proves (a) they still yield today's outcomes after Tasks 1-2, and (b) the new tenant is correctly Department-routed. It is the spec's "parity test" gate (spec safe-cutover step 2) that a later phase's actual cutover will run against.

- [ ] **Step 1: Write the regression tests**

Create `backend/tests/test_sterility_intake_parity.py`. Mixes a pure-unit demand check with live-PG routing checks (mirroring the `test_seeder_mirror.py` / `test_worksheets_inbox.py` patterns).

```python
"""Plan 1C Task 3: the Sterility tenant is additive — existing intake is
byte-identical, and the new tenant routes by Department.

Live Postgres for the routing checks (catalog seeded at boot, incl. Task 2's
tenant). Rollback teardown; ZZTEST throwaway vial.
"""
import pytest
from sqlalchemy import select

from database import SessionLocal
from models import AnalysisService, Department, LimsSample, LimsSubSample
from catalog.departments import department_id_by_name
from sub_samples.service import derive_base_demand
from lims_analyses.seeder import select_services_for_role, _micro_group_keywords


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


# ── Demand parity: sterility_pcr order still provisions 2 vials ────────────────
def test_demand_sterility_pcr_still_two_vials():
    assert derive_base_demand({"sterility_pcr": True})["ster"] == 2
    assert derive_base_demand({"sterility_pcr": False})["ster"] == 0


# ── Seeding parity: a `ster` vial still resolves to STER-PCR (legacy path) ─────
def test_seeding_ster_role_still_selects_ster_pcr(db):
    services = select_services_for_role(db, "ster")
    assert {s.keyword for s in services} == {"STER-PCR"}


# ── New tenant is micro-classified (the landmine positive assertion) ──────────
def test_native_usp71_is_micro_classified(db):
    micro_kw = _micro_group_keywords(db)
    assert "STER-USP71" in micro_kw
    assert {"PCR-FUNGI", "PCR-BACTERIA", "STER-PCR", "ENDO-LAL"} <= micro_kw


# ── New micro services never leak onto an HPLC vial (Department exclusion) ─────
def test_new_micro_services_excluded_from_hplc_mirror(db, monkeypatch):
    from lims_analyses.seeder import seed_analyses_for_vial
    parent = LimsSample(sample_id="ZZTEST-PARITY")
    db.add(parent)
    db.flush()
    vial = LimsSubSample(sample_id="ZZTEST-PARITY-S01", vial_sequence=0, parent_sample_pk=parent.id)
    db.add(vial)
    db.flush()
    # Force the parent's analyte set to include the new sterility keywords.
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["HPLC-ID", "STER-USP71", "PCR-FUNGI", "PCR-BACTERIA"],
    )
    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False,
    )
    seeded = {r.keyword for r in inserted}
    assert seeded.isdisjoint({"STER-USP71", "PCR-FUNGI", "PCR-BACTERIA"})


# ── New micro groups land in the micro inbox lane (Department-keyed) ──────────
def test_new_sterility_groups_in_micro_inbox_lane(db):
    from main import _inbox_allowed_group_ids
    from models import ServiceGroup
    allowed = _inbox_allowed_group_ids(db, "microbiology")
    for name in ("Sterility PCR", "Sterility USP<71>"):
        gid = db.execute(select(ServiceGroup.id).where(ServiceGroup.name == name)).scalar_one()
        assert gid in allowed, f"{name} not in the micro lane"
```

Confirm the model import names against `models.py` before running: `LimsSample` / `LimsSubSample` field names (`sample_id`, `vial_sequence`, `parent_sample_pk`) match the `_throwaway_vial` helper in `test_seeder_mirror.py:38-53` — copy that helper's exact constructor kwargs if these drift.

- [ ] **Step 2: Run the tests**

Run: `python -m pytest tests/test_sterility_intake_parity.py -q`
Expected: all PASS. (`test_native_usp71_is_micro_classified` and `test_new_sterility_groups_in_micro_inbox_lane` depend on Task 2's seed being present — the backend was restarted in Task 2.)

- [ ] **Step 3: Full 1C + prior-catalog regression sweep**

Run the whole catalog suite to confirm nothing regressed:
```bash
python -m pytest tests/test_coa_gate_micro_department.py tests/test_sterility_tenant_seed.py \
  tests/test_sterility_intake_parity.py tests/test_departments_catalog.py \
  tests/test_catalog_parity.py tests/test_seeder_mirror.py tests/test_drop_stale_role_rows.py \
  tests/test_assign_role_fail_hard.py tests/test_departments_admin.py -q
```
Expected: all PASS (the 1B baseline suite + the three new 1C files).

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-departments add backend/tests/test_sterility_intake_parity.py
git -C C:/tmp/Accu-Mk1-departments commit -m "test(catalog): 1C parity harness — sterility tenant is additive, Department-routed"
```

---

## Self-Review (completed against the spec)

**Spec coverage (scope of the Accu-Mk1 1C slice):**
- Catalog Sterility tenant (spec "Sterility as first tenant") → Task 2 (PCR group + native USP-71 + single-member USP-71 group + 14-day tier).
- Safety-coupling conversion of the last name-pinned decision (COA gate) → Task 1. (The mirror/inbox/stale-row conversions were 1B.)
- "Additive cutover, reproduce exactly, parity-gated" (locked decision #7, safe-cutover steps 2/6) → Task 3 leaves the demand/seeding literals live and proves parity.
- USP-71 SLA via single-member group (Handler 2026-07-01) → Task 2.
- **Deliberately deferred (other plans, per spec Decomposition + Handler scope decision 2026-07-01):** per-product demand/seeding split (needs the order signal — 1D/1F); integration-service native order→analysis (1D); coabuilder native COA + preliminary/amend flow + cutting the promote write-back (1E, the top risk, mandatory seam-cut order); WordPress products (1F). The USP-71 preliminary→amend COA decision (spec #8) is recorded and belongs to 1E.

**Placeholder scan:** none — every step ships real SQL/Python/test code and an exact command.

**Type consistency:** `_micro_group_keywords(db) -> Set[str]` unchanged across Task 1 (impl) and its consumers/tests; group/service field names (`vials_required`, `is_assignable`, `department_id`, `sla_tier_id`, `senaite_id`) match `models.py`; keyword strings (`STER-USP71`, `PCR-FUNGI`, `PCR-BACTERIA`, `STER-PCR`, `ENDO-LAL`) and group names (`Sterility PCR`, `Sterility USP<71>`) are used identically in the migration, the map, and the tests.

**Open item to confirm before the split ships (non-blocking for 1C):** USP-71 `result_options` terminology (`No Growth`/`Growth` placeholder) — confirm the lab's wording. Dormant until 1D/1F wire seeding through the USP-71 group, so it can be refined via `PATCH /analysis-services/{id}/result-type` without a migration.

**Deploy-time note (not an execution concern — you're on the devbox):** shipping 1C to prod seeds new catalog rows that surface in the admin ServiceGroups/Departments lists *before* the two products launch (a dormant tenant). That is a production **data** change, which under the "production changes need sign-off" rule warrants a heads-up in the deploy window. It is behavior-inert (the tenant isn't wired into demand/seeding until 1D/1F), but don't let it ride to prod silently.
