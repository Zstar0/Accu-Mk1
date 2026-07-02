# Catalog 1D — integration-service native order→analysis (seam 3) + per-product sterility demand/seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sterility vial demand and analysis-seeding **per-product and catalog-driven** (PCR → 1 vial, USP<71> → 1 vial, both → 2 — reproducing the legacy `sterility_pcr` "always both" = 2), add per-product order flags to the integration-service with back-compat for in-flight orders, and cut **seam 3** — route sterility natively into Accu-Mk1 so a mixed order creates a SENAITE AR for the HPLC part **only** and a sterility-only order creates **no** SENAITE AR (`mk1://`). Nothing that changes a physical or reported outcome ships without a Handler-gated checkpoint.

**Architecture:** Five tasks across two repos, all additive with old paths retained as fallback (spec locked decision #7).
1. **Accu-Mk1 (SAFE — executes tonight):** a NEW `backend/catalog/demand.py::catalog_base_demand(db, ordered_units)` that sums the seeded catalog's `vials_required` per ordered assignable unit, bucketed by home Department, plus a **demand-parity harness** proving it reproduces `derive_base_demand({"sterility_pcr": True})["ster"] == 2` for the legacy flag and yields 1 vial for a single product (new, outside the §247 parity set). Dead-until-wired — no order-flow caller yet. Verifiable in isolation on the devbox `catalog` stack.
2. **integration-service (additive):** add the per-product `sterility_usp71` flag alongside `sterility_pcr` (tri-state `bool | None` so a legacy payload's *absence* is distinguishable from an explicit "false"), plus a pure `ordered_sterility_products()` derivation with a back-compat rule. Dormant — no routing change yet.
3. **Accu-Mk1 (additive):** make `select_services_for_role(db, "ster", ...)` **addon-aware** within the `ster` bucket — a PCR-only order seeds `PCR-FUNGI`+`PCR-BACTERIA`, a USP<71>-only order seeds `STER-USP71` — sourced from the seeded catalog groups, alongside the legacy `ROLE_TO_KEYWORDS` path.
4. **integration-service + Accu-Mk1 contract (HANDLER-GATED CUT — seam 3):** behind a `STERILITY_NATIVE_ROUTING` flag (default off = byte-identical legacy behavior), **drop the sterility→SENAITE-profile attach** and route sterility natively — mixed order → SENAITE AR minus sterility + native sterility created in Mk1; sterility-only order → skip SENAITE AR, native `mk1://` sample. Requires a **new Mk1 S2S ingest endpoint + new `AccuMk1Adapter` method** (Mk1 handler is a dependent deliverable + design gate). Enabling the flag in prod is the Handler-gated checkpoint.
5. **Cross-repo parity gate (§247):** the consolidated demand+seeding shadow-diff run in a fresh isolated stack against production-shaped data — the ISO 17025 7.11.2 validation evidence the Handler signs before the seam-3 cut.

**Tech Stack:** Python 3, FastAPI, SQLAlchemy, PostgreSQL (Accu-Mk1); Python 3, FastAPI, Pydantic v2, `httpx` (integration-service); pytest (`asyncio_mode = "auto"` in IS). No frontend changes. No coabuilder change (that is 1E). JWT unchanged.

## Global Constraints

- **Obey the seam-cut order (coherence note §12-16, spec §199-206).** 1D owns **seam 3**. Seam 1 (coabuilder READ) shipped in 1E-a; seam 4 (coabuilder native-sample anchor) and seam 2 (cut the promote write-back) are 1E and land **after** this. Seam 3 is independent of the COA-source flip, but the native analysis it creates is what seam 2 later relies on — so it must exist and be proven before the flip.
- **Additive cutover, not rip-and-replace (spec locked #7).** Legacy `derive_base_demand` (`ster:2`), `ROLE_TO_KEYWORDS["ster"]=["STER-PCR"]`, and the `sterility_pcr`→SENAITE-profile attach STAY LIVE. New paths live alongside; each production-behavior cut is behind a parity gate + a feature flag; old maps retire in **Phase 2**, not here.
- **Demand-parity scope (coherence note §20-24, spec §247).** Parity is asserted ONLY against the legacy `sterility_pcr` flag → **2 vials**. New per-product single-product orders legitimately demand **1 vial** (PCR-only → 1, USP<71>-only → 1, both → 2) — NEW behavior, EXPLICITLY OUTSIDE the parity set. No plan step may flag the 1-vial case as a regression. Catalog demand = Σ(`vials_required` of each ordered assignable unit); variance composes on top (never fold variance into base — `derive_variance_demand` stays separate, `service.py:870`).
- **Back-compat for in-flight orders is load-bearing.** Every already-submitted sterility sample was ordered under the "always both" regime and must keep resolving to 2 vials + both assays. The tri-state `sterility_usp71: bool | None` (Task 2) is the mechanism: legacy payloads omit the field (→ `None` → "both"), new per-product payloads send it explicitly.
- **Full B — SENAITE-free sterility (spec decision #8).** The new sterility routing creates **no** SENAITE analysis for sterility. `STER-USP71` never gets a SENAITE profile (it is SENAITE-free by 1C seed: `senaite_id`/`senaite_uid` NULL). The seam-3 cut removes the `sterility_pcr`→profile attach entirely (flag-gated).
- **JWT_SECRET unchanged.** The IS→Mk1 native call uses the existing `X-Service-Token` shared secret (`ACCUMK1_INTERNAL_SERVICE_TOKEN`, `config.py:207`), NOT JWT. No COA-verification-code path is touched.
- **Two IS gates per the repo's CLAUDE.md (GitNexus) + the workspace CLAUDE.md (lint):**
  - Before editing ANY existing IS symbol: `gitnexus_impact({target, direction:"upstream"})` and report blast radius; before committing: `gitnexus_detect_changes()`. New files/flags don't need it; the edits to `_map_services_to_profiles`, `build_analysis_request_from_sample`, and `OrderProcessor.process` DO.
  - Lint gate on every IS commit: `ruff check . && mypy app` (must be clean).
- **Stage EXPLICIT paths; never `git add -A`** (both worktrees carry unrelated dirty files, e.g. `package-lock.json`, `integration_service_prod.tar`).
- **Every production-behavior change is a Handler-gated checkpoint, not an autonomous step.** In 1D that is: enabling `STERILITY_NATIVE_ROUTING` (the seam-3 cut). It is planned in full below but its execution requires Handler sign-off + a rehearsal in a fresh isolated stack.

## Execution environment (READ FIRST)

**Task 1 (SAFE — tonight)** runs Accu-Mk1-only on the shared devbox `catalog` stack (already mounts `feat/catalog-departments-admin`). There is **no Python on the laptop.** Per-step loop:

```bash
# edit + commit locally (worktree: C:/tmp/Accu-Mk1-departments @ feat/catalog-departments-admin, HEAD 277542c)
git -C C:/tmp/Accu-Mk1-departments add <explicit paths>   # NEVER git add -A
git -C C:/tmp/Accu-Mk1-departments commit -m "<msg>"
git -C C:/tmp/Accu-Mk1-departments push

# pull on devbox + run pytest in the backend container
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-departments pull -q && \
  docker exec accumark-catalog-accu-mk1-backend sh -c "cd /app && python -m pytest tests/<file> -q"'
```

Gotchas (from the 1C/1E-a runbooks):
- Task 1 is code-only (new module + test) — **no backend restart needed** (pytest reads disk; `_run_migrations` already seeded the tenant, verified below).
- After any `accumark-stack mount`/recreate, pytest is wiped: `docker exec accumark-catalog-accu-mk1-backend pip install -q pytest`.
- Live-PG tests use rollback-only teardown; the resolver test is **read-only** (queries the seeded tenant), so no `ZZTEST` rows needed.
- If the SSH docker context is empty, prefix docker with `DOCKER_HOST=unix:///var/run/docker.sock`.
- Test admin on the stack: `tester@accumark.local` / `AccuTest!2026`.

**Verified seed state on the `catalog` stack (2026-07-02), the two assignable-with-demand units:**
```
$ docker exec accumark-catalog-postgres psql -U postgres -d accumark_mk1 -c \
  "SELECT sg.name, d.name AS dept, sg.vials_required, sg.is_assignable
   FROM service_groups sg LEFT JOIN departments d ON d.id=sg.department_id
   ORDER BY sg.is_assignable DESC, d.name;"
       name        |     dept     | vials_required | is_assignable
-------------------+--------------+----------------+---------------
 Sterility USP<71> | Microbiology |              1 | t
 Sterility PCR     | Microbiology |              1 | t
 Analytics         | Analytical   |                | f     <- NULL vials, not assignable
 Microbiology      | Microbiology |                | f     <- NULL vials, not assignable
(4 rows)
```
This is why Task 1 buckets by **Department** (spec invariant "Department — not group — drives routing"): the only two assignable-with-demand units are both Microbiology sterility groups. See the Phase-2 caveat in Task 1.

**Tasks 2–5 are PLAN-ONLY tonight (Handler-gated / cross-repo).** When sign-off'd, they run in a **fresh isolated `accumark-stack`** with production-shaped data (per the 1E-a plan and spec §249-251), NOT the shared `catalog` stack. At execution start, invoke the **`accumark-stack-platform`** skill and create worktrees:
- **integration-service** off its 1D base — suggested branch `feat/1d-native-sterility`. **GATE G-BASE (confirm before branching):** the IS worktree is currently on `subsample-features` (HEAD `df13cde`), which may be unmerged feature work; confirm with the Handler whether 1D should branch from `subsample-features`, IS `master`, or the deployed 1.0.5 line — do NOT silently couple 1D to an unmerged branch. (`git -C <is> log --oneline -5 subsample-features` and compare to `origin/master`.) IS pytest: `docker exec <stack>-integration-service sh -c "cd /app && python -m pytest tests/unit/<file> -q"` (confirm the container name with `docker ps`; IS ships pytest in its image).
- **Accu-Mk1** off `feat/catalog-departments-admin` (HEAD `277542c`) so the catalog tenant + `catalog_base_demand` are present — branch `feat/1d-native-sterility`.
- Mount both to the isolated stack; set matching `ACCUMK1_BASE_URL`/`ACCUMK1_INTERNAL_SERVICE_TOKEN` on the IS container and the same token on the Mk1 backend.

Commit convention (both repos): conventional-commit subject + footer
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQSWZ3crh9dMhKwU2YHeq7
```

---

## File Structure

| Repo | File | Responsibility | Change |
|---|---|---|---|
| Accu-Mk1 | `backend/catalog/demand.py` | `catalog_base_demand(db, ordered_units)` — Σ `vials_required` per ordered assignable unit, bucketed by Department | **Create** |
| Accu-Mk1 | `backend/tests/test_catalog_demand.py` | demand-parity harness (legacy flag ≡ both units → 2; single → 1) | **Create** |
| IS | `app/models/order.py` | add `sterility_usp71: bool \| None` to `SampleServices` (`:134` region) | **Modify** |
| IS | `app/services/order_validator.py` | `ordered_sterility_products()` helper (new) + drop sterility profile when native routing on (`_map_services_to_profiles` `:454-455`, `:510-511`) | **Modify** |
| IS | `app/adapters/senaite.py` | native-routing no-op for the sterility profile branches (`:1768-1769`, `:1820-1821`) — legacy fallback retained | **Modify** |
| IS | `app/services/order_processor.py` | seam-3 routing in `process()` loop (`:437-523`): skip-AR for sterility-only, native-sterility create call | **Modify** |
| IS | `app/adapters/accumk1.py` | `create_native_sterility()` S2S method | **Modify** (add method) |
| IS | `app/core/config.py` | `sterility_native_routing: bool` flag (`:205-215` region) | **Modify** |
| IS | `tests/unit/test_order_models.py` | per-product flag round-trip + back-compat tri-state | **Modify/extend** |
| IS | `tests/unit/test_sterility_native_routing.py` | profile-drop + skip-AR + native-create routing (flag on/off) | **Create** |
| Accu-Mk1 | `backend/lims_analyses/seeder.py` | addon-aware `select_services_for_role` within `ster` (`:66`, `:77`, `:92`) | **Modify** |
| Accu-Mk1 | `backend/tests/test_sterility_addon_seeding.py` | PCR-only seeds Fungi+Bacteria; USP<71>-only seeds USP71; legacy STER-PCR unchanged | **Create** |
| Accu-Mk1 | `backend/main.py` | `POST /samples/native-sterility` S2S ingest endpoint (near `variance-payload` / `sterility-results`, ~`:16704`) | **Modify** (Task 4, dependent deliverable + gate) |

**Consumers to be aware of (contracts preserved unless flagged):**
- `app/api/webhook.py:506` forwards `sterility_pcr` into the processor payload — extend to forward `sterility_usp71` (Task 2) so per-product routing has the signal.
- `backend/sub_samples/service.py:863` `VARIANCE_BUCKET_KEYS` maps `ster→sterility_pcr`. Variance stays keyed to `sterility_pcr` (USP<71> is a compendial pass/fail with no numeric variance figure) — Task 2 does NOT add a USP<71> variance key.
- `backend/sub_samples/native.py:22-48` — the `mk1://` UID precedent (`native_create_enabled`, `is_native_vial`, `generate_native_uid`). This is **vial-level** native create; the seam-3 **parent-at-order-time** native path (Task 4) is net-new and reuses this prefix convention.

---

## Task 1: Accu-Mk1 catalog-driven demand shadow-resolver + parity harness (SAFE — EXECUTE TONIGHT)

**Files:**
- Create: `backend/catalog/demand.py`
- Test: `backend/tests/test_catalog_demand.py` (create)

**Interfaces:**
- Consumes: `models.ServiceGroup` (`.name`, `.vials_required`, `.is_assignable`, `.department_id`, `.analysis_services`), `models.AnalysisService` (`.keyword`, `.vials_required`, `.is_assignable`, `.department_id`), `models.Department` (`.name`); `sub_samples.service.derive_base_demand` (for the parity assertion only).
- Produces: `catalog_base_demand(db: Session, ordered_units: Iterable[str]) -> dict[str, int]` → a bucket dict `{"hplc": int, "endo": int, "ster": int}` (same bucket keys / == vial `assignment_role` as `derive_base_demand`), summing `vials_required` of each ordered assignable unit into the bucket for its home Department.

**What this proves — and what it does NOT (match the 1E-a honesty bar).** The parity assertion is effectively `1 + 1 == 2`, where the two `1`s were seeded in 1C **specifically** to reproduce the legacy `ster:2`. So a green parity test does **not** independently prove "the model is right" — the 1C seed makes it right by construction. What Task 1 genuinely validates is the **read/sum plumbing**: that `catalog_base_demand` looks up the correct units, sums `vials_required` (NULL-safe), buckets by the correct Department, and — crucially — that the seed hasn't drifted (a units-renamed / vials-nulled / re-departmented regression fails loudly). It also **locks the §247 boundary in code**: the "both → 2" case is the parity set; the "single → 1" case is asserted as intended new behavior so nobody later reads a 1-vial single-product order as a regression. This is dead-until-wired: no order-flow code calls it in 1D. It becomes live when Phase 3 inverts the order flow to derive demand from the catalog.

**Bucketing decision (empirically grounded).** Per the seed query above, the only two assignable-with-demand units are both Microbiology sterility groups, so `_DEPARTMENT_TO_BUCKET = {"Analytical": "hplc", "Microbiology": "ster"}` is correct AND spec-faithful ("Department drives routing"). **Phase-2 caveat (documented in-code):** when Endotoxin becomes a catalog-assignable unit (Phase 2), Microbiology alone will no longer disambiguate `endo` vs `ster` and this map needs a finer key (e.g. a per-unit bucket/role, or endo demand summed into an `endo` bucket via the unit's own signal). In Phase 1, endo is NOT catalog-assignable (its group carries no `vials_required` and `is_assignable=FALSE`), so it never reaches this resolver and Microbiology→`ster` is exact.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_catalog_demand.py`. Read-only against the live catalog stack (the 1C tenant is already seeded — no writes, no `ZZTEST` rows). It FAILS RED because `backend/catalog/demand.py` does not exist yet (`ModuleNotFoundError`).

```python
"""Catalog 1D Task 1: the catalog-driven base-demand shadow-resolver.

Live Postgres (1C sterility tenant seeded at boot). Read-only — the two
sterility groups ("Sterility PCR", "Sterility USP<71>") each carry
vials_required=1 in the Microbiology department (verified 2026-07-02).

This is a SHADOW resolver: dead-until-wired (no order-flow caller in 1D).
The parity contract below scopes the §247 gate — legacy 'always both' == 2,
new single-product == 1 (NOT a regression).
"""
import pytest

from database import SessionLocal
from catalog.demand import catalog_base_demand
from sub_samples.service import derive_base_demand

# The two catalog assignable units that make up the sterility family (1C seed).
_PCR = "Sterility PCR"
_USP71 = "Sterility USP<71>"


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


# ── PARITY SET (§247): legacy sterility_pcr flag ≡ BOTH units ordered ──────────
# Every in-flight/existing sample was ordered under the "always both" regime.
# The catalog reproduces the legacy ster:2 as an additive 1+1 sum.
def test_parity_both_units_reproduce_legacy_two_vials(db):
    catalog = catalog_base_demand(db, [_PCR, _USP71])
    legacy = derive_base_demand({"sterility_pcr": True})
    assert catalog["ster"] == 2
    assert catalog["ster"] == legacy["ster"], (
        "catalog demand for both sterility units must reproduce the legacy "
        "sterility_pcr flag's ster:2 (the §247 parity contract)"
    )


def test_parity_no_sterility_is_zero(db):
    assert catalog_base_demand(db, [])["ster"] == 0
    assert derive_base_demand({"sterility_pcr": False})["ster"] == 0


# ── NEW-BEHAVIOR SET (§247): single-product orders demand 1 vial — NOT a ───────
# regression. These are OUTSIDE the parity set on purpose (arrives with 1D/1F).
def test_new_pcr_only_demands_one_vial(db):
    assert catalog_base_demand(db, [_PCR])["ster"] == 1


def test_new_usp71_only_demands_one_vial(db):
    assert catalog_base_demand(db, [_USP71])["ster"] == 1


# ── Plumbing guards ────────────────────────────────────────────────────────────
def test_returns_full_bucket_dict_shape(db):
    d = catalog_base_demand(db, [_PCR, _USP71])
    assert set(d.keys()) == {"hplc", "endo", "ster"}
    # Phase-1: sterility is the only catalog-driven family, so hplc/endo stay 0.
    assert d["hplc"] == 0 and d["endo"] == 0


def test_unknown_unit_name_is_skipped_not_raised(db):
    # A bogus/non-assignable unit contributes 0 and never raises (robustness).
    assert catalog_base_demand(db, ["Nonexistent Group ZZ"])["ster"] == 0
    # Non-assignable seeded groups (Analytics/Microbiology have NULL vials) → 0.
    assert catalog_base_demand(db, ["Microbiology", _PCR])["ster"] == 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run (via the devbox loop): `python -m pytest tests/test_catalog_demand.py -q`
Expected: collection error / `ModuleNotFoundError: catalog.demand` — the module doesn't exist yet.

- [ ] **Step 3: Create the resolver**

Create `backend/catalog/demand.py`:

```python
"""Catalog-driven base vial demand (Catalog 1D, shadow resolver).

Σ(vials_required) over the ordered assignable catalog units, bucketed by each
unit's home Department. This is the additive, catalog-sourced counterpart to
sub_samples.service.derive_base_demand's hardcoded ster:2. DEAD-UNTIL-WIRED:
no order-flow code calls it in 1D — it exists to be shadow-diffed against the
legacy demand (§247 parity gate) ahead of the Phase-3 order-flow inversion.

Bucketing keys on Department (spec invariant: "Department — not group — drives
routing"). Phase-1 caveat: sterility is the only catalog-migrated family, so
Microbiology maps cleanly to the "ster" bucket. When Endotoxin is migrated
onto the catalog (Phase 2) it becomes a second assignable Microbiology family
and this map needs a finer key (endo vs ster) — until then endo is NOT
catalog-assignable and never reaches this resolver.
"""
from __future__ import annotations

import logging
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import AnalysisService, Department, ServiceGroup

log = logging.getLogger(__name__)

# Home Department -> legacy demand bucket (== vial assignment_role). Phase-1
# scope: only sterility (Microbiology) is catalog-driven. See module docstring.
_DEPARTMENT_TO_BUCKET = {"Analytical": "hplc", "Microbiology": "ster"}


def _empty_demand() -> dict[str, int]:
    return {"hplc": 0, "endo": 0, "ster": 0}


def _bucket_for_department_id(db: Session, department_id: int | None) -> str | None:
    if department_id is None:
        return None
    name = db.execute(
        select(Department.name).where(Department.id == department_id)
    ).scalar_one_or_none()
    return _DEPARTMENT_TO_BUCKET.get(name) if name else None


def catalog_base_demand(db: Session, ordered_units: Iterable[str]) -> dict[str, int]:
    """Base (pre-variance) vial demand per bucket, summed from the catalog.

    ordered_units: names of the ordered ASSIGNABLE units. v1 sterility units are
    service groups ("Sterility PCR", "Sterility USP<71>"); a standalone
    assignable service is matched by keyword as a fallback (none in v1). Each
    unit contributes (vials_required or 0) to the bucket of its home Department.
    Unknown / non-assignable / department-less names contribute 0 (logged),
    never raise. Variance is NOT included here (see derive_variance_demand).
    """
    demand = _empty_demand()
    for name in ordered_units:
        group = db.execute(
            select(ServiceGroup).where(ServiceGroup.name == name)
        ).scalar_one_or_none()

        if group is not None:
            bucket = _bucket_for_department_id(db, group.department_id)
            vials = group.vials_required or 0
        else:
            # Fallback: a standalone assignable service, matched by keyword.
            svc = db.execute(
                select(AnalysisService).where(
                    AnalysisService.keyword == name,
                    AnalysisService.is_assignable.is_(True),
                )
            ).scalar_one_or_none()
            if svc is None:
                log.debug("catalog_base_demand.unknown_unit name=%s", name)
                continue
            bucket = _bucket_for_department_id(db, svc.department_id)
            vials = svc.vials_required or 0

        if bucket is None:
            log.debug("catalog_base_demand.no_bucket name=%s", name)
            continue
        demand[bucket] += vials
    return demand
```

Note: `derive_base_demand` (`sub_samples/service.py:903-912`) returns exactly `{"hplc","endo","ster"}` with `ster: 2 if ster else 0` — the resolver returns the same shape so the parity assertion compares like-for-like.

**Import heads-up:** the sibling `catalog/departments.py` deliberately uses *function-local* `from models import ...` (a circular-import guard). `demand.py` is dead-until-wired so a module-top `from models import ...` is likely fine, but if Step 4 collection errors on import, move the `models` import inside `catalog_base_demand` / `_bucket_for_department_id` to mirror `departments.py`. Step 4's run surfaces this immediately.

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_catalog_demand.py -q`
Expected: all 6 tests PASS (the 1C tenant is seeded on the `catalog` stack, so `Sterility PCR`/`Sterility USP<71>` resolve to `vials_required=1` each).

- [ ] **Step 5: Regression — the 1C catalog suite still passes**

Run: `python -m pytest tests/test_catalog_demand.py tests/test_sterility_tenant_seed.py tests/test_sterility_intake_parity.py -q`
Expected: all PASS. (Task 1 adds a module + test only; it does not touch `derive_base_demand` or the seeder, so the 1C parity harness is undisturbed.)

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-departments add backend/catalog/demand.py backend/tests/test_catalog_demand.py
git -C C:/tmp/Accu-Mk1-departments commit -m "feat(catalog): catalog-driven base-demand shadow-resolver + §247 parity harness (1D Task 1)"
git -C C:/tmp/Accu-Mk1-departments push
```

**This is the only 1D task that executes tonight.** Everything below is PLAN-ONLY — Handler-gated and/or cross-repo, to be run in a fresh isolated stack after sign-off.

---

## Task 2: integration-service — per-product sterility flags + back-compat derivation (additive, dormant)

**Files:**
- Modify: `app/models/order.py` (`SampleServices`, `:111-154`)
- Modify: `app/services/order_validator.py` (add `ordered_sterility_products()` near `SERVICE_TO_PROFILE`, `:142`)
- Modify: `app/api/webhook.py:501-507` (forward the new flag into the processor payload)
- Test: `tests/unit/test_order_models.py` (extend), `tests/unit/test_sterility_native_routing.py` (create — the derivation half)

**Interfaces:**
- Produces: `SampleServices.sterility_usp71: bool | None` (tri-state — see below); `ordered_sterility_products(services: SampleServices) -> set[str]` → subset of `{"sterility_pcr", "sterility_usp71"}`.

**The tri-state back-compat mechanism (the crux).** A legacy WP payload sends `sterility_pcr` but has **no** `sterility_usp71` key; a new per-product payload sends `sterility_usp71` explicitly (true or false). If the new field defaulted to `False`, we could not distinguish "legacy PCR order (= lab runs both = 2 vials)" from "new PCR-only order (= 1 vial)" — collapsing the §247 boundary. So the field is `bool | None` defaulting to `None`:
- `sterility_usp71 is None` → **legacy payload**: `sterility_pcr=True` means the "always both" regime → both products ordered (reproduces `ster:2`).
- `sterility_usp71 is not None` → **new per-product payload**: each product ordered iff its own flag is `True`.

This keeps every in-flight/replayed order resolving to 2 vials + both assays, while new 1F products send explicit per-product signals. **Gate G-WP-USP71 (WordPress form key):** the exact WP alias for the USP<71> product's cart key is a 1F/WordPress deliverable — do NOT invent it. Confirm before wiring by grepping the storefront:
```bash
grep -rniE "usp.?71|sterilityusp" \
  "//wsl.localhost/docker-desktop-data/data/docker/volumes/DevKinsta/public/accumarklabs/wp-content/themes" \
  "//wsl.localhost/.../plugins/accuverify-woocommerce"
```
Until confirmed, use the provisional alias below with the loud gate comment.

- [ ] **Step 1: Write the failing test (model round-trip + derivation)**

Extend `tests/unit/test_order_models.py`:

```python
class TestSterilityPerProduct:
    def test_legacy_payload_has_none_usp71(self):
        """A legacy WP payload (no usp71 key) leaves the tri-state None."""
        svc = SampleServices.model_validate({"rapidsterilityscreening(pcr)": True})
        assert svc.sterility_pcr is True
        assert svc.sterility_usp71 is None            # absent → None, not False

    def test_per_product_payload_sets_both_flags(self):
        svc = SampleServices.model_validate({
            "rapidsterilityscreening(pcr)": True,
            "sterilityusp71": False,                  # GATE G-WP-USP71 alias
        })
        assert svc.sterility_pcr is True
        assert svc.sterility_usp71 is False
```

Create `tests/unit/test_sterility_native_routing.py` (the derivation half — the routing half lands in Task 4):

```python
"""Catalog 1D: per-product sterility derivation + native routing."""
from app.models.order import SampleServices
from app.services.order_validator import ordered_sterility_products


class TestOrderedSterilityProducts:
    def test_legacy_pcr_flag_means_both_products(self):
        """Back-compat: legacy sterility_pcr=True (usp71 absent) → BOTH
        products, reproducing the 'always both' 2-vial regime (§247 parity)."""
        svc = SampleServices.model_validate({"rapidsterilityscreening(pcr)": True})
        assert ordered_sterility_products(svc) == {"sterility_pcr", "sterility_usp71"}

    def test_legacy_no_sterility_is_empty(self):
        svc = SampleServices.model_validate({"endotoxin": True})
        assert ordered_sterility_products(svc) == set()

    def test_per_product_pcr_only(self):
        svc = SampleServices.model_validate({
            "rapidsterilityscreening(pcr)": True, "sterilityusp71": False})
        assert ordered_sterility_products(svc) == {"sterility_pcr"}

    def test_per_product_usp71_only(self):
        svc = SampleServices.model_validate({
            "rapidsterilityscreening(pcr)": False, "sterilityusp71": True})
        assert ordered_sterility_products(svc) == {"sterility_usp71"}

    def test_per_product_both_explicit(self):
        svc = SampleServices.model_validate({
            "rapidsterilityscreening(pcr)": True, "sterilityusp71": True})
        assert ordered_sterility_products(svc) == {"sterility_pcr", "sterility_usp71"}
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tests/unit/test_order_models.py tests/unit/test_sterility_native_routing.py -q`
Expected: FAIL — `sterility_usp71` field / `ordered_sterility_products` import missing.

- [ ] **Step 3: Add the field (GitNexus impact first)**

`gitnexus_impact({target: "SampleServices", direction: "upstream"})` — expect this dataclass to feed the validator + webhook payload; the change is purely additive (a new optional field), so risk is LOW. Then in `app/models/order.py`, add after the `sterility_pcr` field (`:134-138`):

```python
    sterility_usp71: bool | None = Field(
        default=None,
        # GATE G-WP-USP71: confirm the real WooCommerce cart key for the
        # "Sterility USP<71>" product (1F) before publishing; this alias is
        # provisional. populate_by_name=True (Config below) lets tests/back-
        # compat set it by field name too.
        alias="sterilityusp71",
        description=(
            "Per-product USP<71> sterility flag. TRI-STATE: None means a legacy "
            "payload with no per-product signal (sterility_pcr=True then implies "
            "BOTH products, the 'always both' regime → 2 vials). An explicit "
            "True/False means a new per-product order."
        ),
    )
```

(`SampleServices.Config` already sets `populate_by_name = True`, `:153-154`.)

- [ ] **Step 4: Add the derivation helper**

In `app/services/order_validator.py`, after `SERVICE_TO_PROFILE` (`:142-151`):

```python
# Catalog 1D: which sterility PRODUCTS a sample ordered. Back-compat tri-state:
# a legacy payload omits sterility_usp71 (-> None), and sterility_pcr=True then
# means the lab's "always both" regime (PCR + USP<71> => 2 vials, reproducing
# derive_base_demand's ster:2). A new per-product payload sends usp71 explicitly.
def ordered_sterility_products(services: "SampleServices") -> set[str]:
    """Return the subset of {'sterility_pcr','sterility_usp71'} ordered."""
    if services.sterility_usp71 is None:
        # Legacy: no per-product signal. sterility_pcr => both products.
        return {"sterility_pcr", "sterility_usp71"} if services.sterility_pcr else set()
    out: set[str] = set()
    if services.sterility_pcr:
        out.add("sterility_pcr")
    if services.sterility_usp71:
        out.add("sterility_usp71")
    return out
```

Add `from app.models.order import OrderSubmission, Sample, SampleServices` (extend the existing import at `:11`). Note: `SERVICE_TO_PROFILE` deliberately gains **no** `sterility_usp71` entry — USP<71> is SENAITE-free (Full B) and never maps to a SENAITE profile.

- [ ] **Step 5: Forward the new flag from the webhook**

In `app/api/webhook.py`, in the processor-payload `services` dict (`:501-507`), add:

```python
                    "sterility_pcr": s.services.sterility_pcr,
                    "sterility_usp71": s.services.sterility_usp71,
```

- [ ] **Step 6: Run tests + IS gates**

```bash
python -m pytest tests/unit/test_order_models.py tests/unit/test_sterility_native_routing.py -q
ruff check . && mypy app
```
Expected: all PASS; ruff + mypy clean (the `bool | None` and `set[str]` annotations are mypy-clean). Then `gitnexus_detect_changes()` — confirm only `SampleServices`, `ordered_sterility_products`, and the webhook payload builder changed.

- [ ] **Step 7: Commit**

```bash
git add app/models/order.py app/services/order_validator.py app/api/webhook.py \
  tests/unit/test_order_models.py tests/unit/test_sterility_native_routing.py
git commit -m "feat(order): per-product sterility flags + back-compat tri-state derivation (1D Task 2)"
```

---

## Task 3: Accu-Mk1 — addon-aware sterility seeding within the `ster` bucket (additive)

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (`ROLE_TO_WP_KEYS` `:66`, `ROLE_TO_KEYWORDS` `:77`, `select_services_for_role` `:92`)
- Test: `backend/tests/test_sterility_addon_seeding.py` (create)

**Interfaces:**
- Consumes: the seeded catalog groups `Sterility PCR` (members `PCR-FUNGI`,`PCR-BACTERIA`) and `Sterility USP<71>` (member `STER-USP71`); `models.ServiceGroup.analysis_services`.
- Produces: `select_services_for_role(db, "ster", *, ordered_products: set[str] | None = None) -> list[AnalysisService]` — **additive optional kwarg**. When `ordered_products` is provided, resolve the ster-bucket analyses from the ordered catalog groups; when omitted (legacy callers), fall back to the existing `ROLE_TO_KEYWORDS["ster"]=["STER-PCR"]` path unchanged.

**Why additive, not a replacement.** The spec (§169) says addon-aware seeding "replaces the role→all-keywords seeding in `ROLE_TO_KEYWORDS`." But per locked decision #7 we do NOT delete the legacy map in this phase — we add the addon-aware branch alongside it and gate it on the caller passing `ordered_products`. Legacy callers (every current call site that omits the kwarg) get byte-identical behavior. The map retires in Phase 2.

**Catalog-sourced mapping (product → group → member services).** A product identifier maps to its catalog group by name: `"sterility_pcr" → "Sterility PCR"`, `"sterility_usp71" → "Sterility USP<71>"`. The group's `analysis_services` relationship yields the exact member services (`PCR-FUNGI`+`PCR-BACTERIA`, or `STER-USP71`). This is the "addon-aware within the `ster` bucket" behavior: PCR-only seeds Fungi+Bacteria, USP<71>-only seeds USP71, both seed all three — no cross-contamination.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_sterility_addon_seeding.py` (live-PG, read-only against the seeded tenant):

```python
"""Catalog 1D Task 3: addon-aware sterility seeding within the ster bucket.

Live Postgres (1C tenant seeded). Read-only. The legacy path (no
ordered_products kwarg) stays byte-identical; the new path resolves member
services from the ordered catalog groups.
"""
import pytest

from database import SessionLocal
from lims_analyses.seeder import select_services_for_role


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _kw(services):
    return {s.keyword for s in services}


# ── Legacy path unchanged (no kwarg) ───────────────────────────────────────────
def test_legacy_ster_role_still_selects_ster_pcr(db):
    assert _kw(select_services_for_role(db, "ster")) == {"STER-PCR"}


# ── Addon-aware: PCR-only seeds Fungi + Bacteria (not USP71) ────────────────────
def test_pcr_only_seeds_fungi_bacteria(db):
    services = select_services_for_role(db, "ster", ordered_products={"sterility_pcr"})
    assert _kw(services) == {"PCR-FUNGI", "PCR-BACTERIA"}


# ── Addon-aware: USP71-only seeds USP71 (not Fungi/Bacteria) ────────────────────
def test_usp71_only_seeds_usp71(db):
    services = select_services_for_role(db, "ster", ordered_products={"sterility_usp71"})
    assert _kw(services) == {"STER-USP71"}


# ── Addon-aware: both products seed all three member services ───────────────────
def test_both_products_seed_all_three(db):
    services = select_services_for_role(
        db, "ster", ordered_products={"sterility_pcr", "sterility_usp71"})
    assert _kw(services) == {"PCR-FUNGI", "PCR-BACTERIA", "STER-USP71"}


# ── Empty ordered set seeds nothing (no cross-contamination) ────────────────────
def test_empty_products_seeds_nothing(db):
    assert select_services_for_role(db, "ster", ordered_products=set()) == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tests/test_sterility_addon_seeding.py -q`
Expected: the `ordered_products=...` tests FAIL (unexpected kwarg / wrong result); the legacy test passes.

- [ ] **Step 3: Make `select_services_for_role` addon-aware (additive kwarg)**

In `backend/lims_analyses/seeder.py`, replace `select_services_for_role` (`:92-102`) and add the product→group map beside `ROLE_TO_KEYWORDS` (`:77`):

```python
# Catalog 1D: sterility PRODUCT identifier -> catalog ServiceGroup name. The
# group's member services (via service_group_members) are the analyses seeded
# for that product. Catalog-sourced so a PCR-only order seeds Fungi+Bacteria and
# a USP<71>-only order seeds USP71 — addon-aware within the legacy ster bucket.
STERILITY_PRODUCT_TO_GROUP: Dict[str, str] = {
    "sterility_pcr": "Sterility PCR",
    "sterility_usp71": "Sterility USP<71>",
}


def _services_for_sterility_products(
    db: Session, ordered_products: Set[str]
) -> List[AnalysisService]:
    """Member analysis_services of the ordered sterility groups (catalog-sourced)."""
    out: dict[int, AnalysisService] = {}
    for product in ordered_products:
        group_name = STERILITY_PRODUCT_TO_GROUP.get(product)
        if not group_name:
            continue
        group = db.execute(
            select(ServiceGroup).where(ServiceGroup.name == group_name)
        ).scalar_one_or_none()
        if group is None:
            log.warning("sterility_seed.group_missing product=%s group=%s",
                        product, group_name)
            continue
        for svc in group.analysis_services:
            out[svc.id] = svc
    return list(out.values())


def select_services_for_role(
    db: Session, role: str, *, ordered_products: Optional[Set[str]] = None
) -> List[AnalysisService]:
    """Return the analysis_services rows to seed for a vial role.

    Catalog 1D — addon-aware sterility (additive, opt-in): when `role == "ster"`
    and `ordered_products` is provided, resolve members from the ordered catalog
    groups (PCR-only -> Fungi+Bacteria; USP<71>-only -> USP71). Legacy callers
    that omit `ordered_products` get the unchanged ROLE_TO_KEYWORDS whitelist.
    """
    if role == "ster" and ordered_products is not None:
        return _services_for_sterility_products(db, ordered_products)
    keywords = ROLE_TO_KEYWORDS.get(role, [])
    if not keywords:
        return []
    rows = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.in_(keywords))
    ).scalars().all()
    return list(rows)
```

`ServiceGroup` is already imported (`seeder.py:51`); `Optional`/`Set`/`Dict`/`List` are in the top-level typing import (`:40`).

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest tests/test_sterility_addon_seeding.py -q`
Expected: all 5 PASS.

- [ ] **Step 5: Regression — the seeder + intake suites**

Run: `python -m pytest tests/test_sterility_addon_seeding.py tests/test_seeder_mirror.py tests/test_sterility_intake_parity.py tests/test_assign_role_fail_hard.py -q`
Expected: all PASS (legacy `select_services_for_role(db, "ster")` unchanged — `test_sterility_intake_parity.py::test_seeding_ster_role_still_selects_ster_pcr` still green).

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-departments add backend/lims_analyses/seeder.py backend/tests/test_sterility_addon_seeding.py
git -C C:/tmp/Accu-Mk1-departments commit -m "feat(catalog): addon-aware sterility seeding within ster bucket (1D Task 3, additive)"
```

---

## Task 4: seam 3 — native sterility routing (HANDLER-GATED CUT + Mk1 contract gate)

**This task changes production behavior — routing sterility off SENAITE. It is planned in full, but its execution and especially enabling `STERILITY_NATIVE_ROUTING` in prod is a Handler-gated checkpoint. Do not present the flag-enable as an autonomous step.** The cut is atomic: dropping the SENAITE sterility profile and creating the native sterility analysis MUST land together — dropping the profile without native creation silently loses sterility results (the spec's #1 failure).

**Files:**
- Modify: `app/core/config.py` (`:205-215` region) — add the flag.
- Modify: `app/services/order_validator.py` (`_map_services_to_profiles` `:454-455`, `:510-511`) — drop the sterility profile when native routing on.
- Modify: `app/adapters/senaite.py` (`:1768-1769`, `:1820-1821`) — legacy fallback branches become no-ops when native routing on (defense-in-depth; the profile is already absent from `sample.profiles`).
- Modify: `app/services/order_processor.py` (`process()` loop `:437-523`) — skip-AR for sterility-only, native-sterility create.
- Modify: `app/adapters/accumk1.py` — `create_native_sterility()` S2S method.
- **Dependent deliverable (Mk1, DESIGN GATE):** `backend/main.py` `POST /samples/native-sterility` S2S ingest endpoint.
- Test: `tests/unit/test_sterility_native_routing.py` (extend — the routing half).

**Interfaces:**
- Produces (IS): `Settings.sterility_native_routing: bool` (default `False`); `AccuMk1Adapter.create_native_sterility(*, idempotency_key: str, body: dict) -> dict`.
- Contract (IS→Mk1, NEW endpoint — shape specified here; Mk1 handler is the design gate below):
  - `POST /samples/native-sterility` (auth `X-Service-Token`, header `Idempotency-Key`)
  - request: `{"order_id": int, "order_number": str, "sample_number": int, "senaite_id": str | None, "products": ["sterility_pcr"|"sterility_usp71", ...], "sample_identity": str, "sample_name": str | None, "lot_code": str | None, "coa_info": {...} | None}`
  - `senaite_id` present → **mixed** order (anchor the native sterility analysis to the existing SENAITE-backed parent). `senaite_id` null → **sterility-only** → Mk1 mints an `mk1://` parent sample.
  - response: `{"sample_id": str, "created": bool, "analyses": ["PCR-FUNGI", ...]}`

**Operational definition of "mixed" vs "sterility-only" (the routing decision).** Compute the SENAITE profile list as today, then remove the sterility profile:
- **remaining profiles non-empty** (HPLC / residual / variance / endotoxin / bac_water) → **mixed**: create the SENAITE AR from the remaining profiles (sterility already dropped), THEN create native sterility (`senaite_id` = the new AR id).
- **remaining profiles empty** (sterility was the only ordered service) → **sterility-only**: create NO SENAITE AR; call native sterility with `senaite_id=None` (Mk1 mints `mk1://`).

Endotoxin stays SENAITE-sourced (1E-a scope boundary), so a sterility+endo sample is **mixed** (endo keeps its SENAITE profile), correctly routing sterility native while endo stays on SENAITE.

**GATE G-ORD (sterility-only orderability — confirm, do not assume).** In the current IS model, `sterility_pcr` is a service flag on a Single-Peptide / Blend / Bacteriostatic-Water sample, and `order_processor.py:468-494` looks up `{peptide} - Identity (HPLC)` analysis UIDs **unconditionally** for every peptide. So whether a "sterility-only" sample is orderable **today** determines the back-compat surface:
- If sterility-only is NOT orderable in the current storefront, the **skip-AR branch is net-new** (arrives only with 1F sterility-only products) and no in-flight order exercises it — only the **mixed** branch is back-compat-critical.
- If it IS orderable today, in-flight sterility-only samples exist and their AR behavior would change on replay — the isolated-stack rehearsal (Task 5) must include one.

Confirm before the cut (both surfaces):
```bash
# IS side: any order whose only sterility signal is sterility_pcr and no HPLC?
grep -rniE "sterilit|rapidsterility" \
  "//wsl.localhost/docker-desktop-data/data/docker/volumes/DevKinsta/public/accumarklabs/wp-content/themes"
# and check prod order history in the isolated stack DB for samples with
# sterility_pcr=True AND hplcpurity_identity=False AND endotoxin=False.
```
Record the answer in the plan before enabling the flag.

- [ ] **Step 1: Add the feature flag (config)**

In `app/core/config.py`, in the Accu-Mk1 integration block (`:205-215`), add:

```python
    sterility_native_routing: bool = Field(
        False,
        alias="STERILITY_NATIVE_ROUTING",
        description=(
            "Seam 3 (Catalog 1D). When True, sterility is routed natively into "
            "Accu-Mk1: the sterility SENAITE profile is dropped, sterility-only "
            "orders skip SENAITE AR creation, and native sterility is created via "
            "AccuMk1Adapter.create_native_sterility. Default False = byte-identical "
            "legacy behavior. Enabling in prod is a Handler-gated checkpoint."
        ),
    )
```

- [ ] **Step 2: Write the failing routing test**

Extend `tests/unit/test_sterility_native_routing.py` with the profile-drop behavior (unit-level, no live services — clone the mock style from `tests/unit/test_order_processor_flow.py:29-87`):

```python
from app.models.order import Sample, SampleServices
from app.services.order_validator import DefaultOrderValidator


def _peptide_sample(**services):
    return Sample.model_validate({
        "number": 1, "analytical_test": "Single Peptide",
        "sample_identity": "BPC-157", "sample_weight": "5",
        "services": services,
    })


class TestSterilityProfileDrop:
    def test_flag_off_keeps_legacy_sterility_profile(self, monkeypatch):
        """Default (flag off): sterility_pcr still attaches the SENAITE profile
        — byte-identical legacy behavior."""
        monkeypatch.setenv("STERILITY_NATIVE_ROUTING", "0")
        v = DefaultOrderValidator()
        s = _peptide_sample(**{"hplcpurity&identity": True,
                               "rapidsterilityscreening(pcr)": True})
        profiles = v._map_services_to_profiles(s)
        assert "sterility_pcr" in profiles
        assert "peptide_identity" in profiles

    def test_flag_on_drops_sterility_profile_keeps_hplc(self, monkeypatch):
        """Native routing on: sterility profile dropped, HPLC retained (mixed)."""
        monkeypatch.setenv("STERILITY_NATIVE_ROUTING", "1")
        v = DefaultOrderValidator()
        s = _peptide_sample(**{"hplcpurity&identity": True,
                               "rapidsterilityscreening(pcr)": True})
        profiles = v._map_services_to_profiles(s)
        assert "sterility_pcr" not in profiles
        assert "peptide_identity" in profiles

    def test_flag_on_sterility_only_yields_empty_profiles(self, monkeypatch):
        """Sterility-only + native routing on → no SENAITE profiles at all
        (the skip-AR branch trigger)."""
        monkeypatch.setenv("STERILITY_NATIVE_ROUTING", "1")
        v = DefaultOrderValidator()
        s = _peptide_sample(**{"rapidsterilityscreening(pcr)": True})
        assert v._map_services_to_profiles(s) == []
```

Run: `python -m pytest tests/unit/test_sterility_native_routing.py -q` → the flag-on tests FAIL (sterility still attached).

- [ ] **Step 3: Drop the sterility profile in the validator (GitNexus impact first)**

`gitnexus_impact({target: "_map_services_to_profiles", direction: "upstream"})` — it feeds `_validate_sample` → `validate` → the order pipeline; the change is guarded by a default-off flag so risk is LOW but report it. Then in `app/services/order_validator.py`, gate the two sterility appends (`:454-455` peptide path, `:510-511` bac-water path). Add a module-level helper and use it in both:

```python
from app.core.config import get_settings

def _native_sterility_routing() -> bool:
    return get_settings().sterility_native_routing
```

Peptide path (`:454-455`):
```python
        # Seam 3 (1D): when native sterility routing is on, sterility never gets
        # a SENAITE profile — it is created natively in Accu-Mk1. Flag off =
        # legacy attach retained.
        if sample.services.sterility_pcr and not _native_sterility_routing():
            profiles.append(SERVICE_TO_PROFILE["sterility_pcr"])
```
Bac-water path (`:510-511`): apply the identical guard.

- [ ] **Step 4: Defense-in-depth in the senaite adapter**

In `app/adapters/senaite.py`, the `sterility_pcr` profile-UID branches (`:1768-1769` bac-water, `:1820-1821` peptide) are naturally no-ops once the validator drops the profile from `sample.profiles`. Leave them intact as the legacy fallback (flag off), and add a one-line comment at each noting they only fire when native routing is off. No behavior change needed here (the profile string is simply absent when the flag is on).

- [ ] **Step 5: Add the native-create adapter method**

In `app/adapters/accumk1.py`, add (mirrors `submit_peptide_request` `:76-131`):

```python
    async def create_native_sterility(self, *, idempotency_key: str, body: dict) -> dict:
        """Create the native (SENAITE-free) sterility analysis in Accu-Mk1.

        POST /samples/native-sterility with X-Service-Token + Idempotency-Key.
        body carries {order_id, order_number, sample_number, senaite_id|None,
        products, sample_identity, ...}. senaite_id=None => Mk1 mints an mk1://
        parent (sterility-only); a value => anchor onto the mixed sample.
        """
        url = f"{self.base_url}/samples/native-sterility"
        logger.info("accumk1_native_sterility_start", url=url,
                    idempotency_key=idempotency_key)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    url, headers=self._headers(idempotency_key), json=body)
        except (httpx.TimeoutException, httpx.RequestError) as e:
            logger.error("accumk1_native_sterility_error", url=url, error=str(e))
            raise
        response.raise_for_status()
        return response.json()
```

- [ ] **Step 6: Wire the routing branch in the processor (GitNexus impact first)**

`gitnexus_impact({target: "process", direction: "upstream"})` on `OrderProcessor.process` — HIGH usage (the order entrypoint); the change is flag-guarded and additive within the per-sample loop. In `app/services/order_processor.py`, inside the per-sample `try` (`:466`), compute the routing decision FIRST, then gate the existing SENAITE work on it and add the native create.

**(a)** At the top of the per-sample `try` (before the unconditional peptide-identity lookup at `:468`), add:

```python
                from app.services.order_validator import ordered_sterility_products
                from app.core.config import get_settings

                native = bool(self._senaite_config and get_settings().sterility_native_routing)
                ster_products = ordered_sterility_products(original.services) if original else set()
                # profiles already have sterility DROPPED by the validator when native on.
                remaining_profiles = list(normalized.profiles)
                # sterility-only + native → NO SENAITE AR (mk1://). This must also
                # skip the unconditional {peptide} - Identity (HPLC) lookup below
                # (:468-494), which would otherwise mark a peptide-typed
                # sterility-only sample `failed` before native routing is reached.
                # (GATE G-ORD governs whether such orders exist today.)
                sterility_only_native = native and bool(ster_products) and not remaining_profiles
                senaite_id: str | None = None
```

**(b)** Wrap the EXISTING SENAITE block — the peptide-identity lookup (`:468-494`), the AR build (`:508-520`), the create (`:522-523`), the success `SampleResult` + retest auto-checkin (`:525-630`), and the failure `else` (`:631-637`) — in `if not sterility_only_native:`. The block is preserved verbatim with exactly ONE edit: capture `senaite_id` in the success branch (beside the `:526-530` append):

```python
                if not sterility_only_native:
                    # <<< the existing :468-630 lookup+build+create+success/auto-checkin
                    #     block runs UNCHANGED here, except the success branch also does: >>>
                    #     senaite_id = result.sample_id
                    #
                    # ...and the existing failure else (:631-637) is unchanged:
                    #     else:
                    #         sample_results.append(SampleResult(
                    #             sample_number=normalized.number, senaite_id=None,
                    #             status="failed", error=result.error))
                    #         continue          # (add: skip native create on AR failure)
                    pass
                else:
                    logger.info("sterility_only_native_skip_ar", extra={
                        "sample_number": normalized.number, "products": sorted(ster_products)})
```
(The `build_analysis_request_from_sample(...)` call inside that block is the exact existing call at `:509-520` — `sample=normalized, client_uid=..., contact_uid=..., config=self._senaite_config, order_id=..., order_number=..., analyses=analysis_uids, logo_path=..., chromatograph_background_path=..., coa_info=sample_coa`; unchanged. Sterility is absent from `normalized.profiles` when the flag is on, so the adapter's sterility branches naturally don't fire.)

**(c)** After that block, add the native sterility create (mixed anchors on `senaite_id`; sterility-only mints `mk1://`):

```python
                if native and ster_products:
                    try:
                        await self.accumk1.create_native_sterility(
                            idempotency_key=f"{order.order_id}:{normalized.number}:native-sterility",
                            body={
                                "order_id": order.order_id,
                                "order_number": order.order_number,
                                "sample_number": normalized.number,
                                "senaite_id": senaite_id,          # None => sterility-only mk1://
                                "products": sorted(ster_products),
                                "sample_identity": normalized.original_identity,
                                "sample_name": normalized.sample_name,
                                "lot_code": normalized.lot_code,
                            },
                        )
                    except Exception as e:
                        logger.error("native_sterility_failed", extra={
                            "sample_number": normalized.number,
                            "senaite_id": senaite_id, "error": str(e)})
                        # Mixed: the HPLC AR already stands + its SampleResult was
                        # appended — log for retry, don't double-append. Sterility-only:
                        # no AR was created, so this is a hard failure for the sample.
                        if sterility_only_native:
                            senaite_errors.append(
                                f"Sample {normalized.number}: native sterility create failed: {e}")
                            sample_results.append(SampleResult(
                                sample_number=normalized.number, senaite_id=None,
                                status="failed", error=str(e)))
                        continue

                if sterility_only_native:
                    # No SENAITE AR was created; record the native result here.
                    sample_results.append(SampleResult(
                        sample_number=normalized.number, senaite_id=None, status="created"))
```

`OrderProcessor` must hold an `AccuMk1Adapter` (`self.accumk1`) — inject it via the constructor + `dependencies.py` (mirror `get_peptide_request_service` `:386-403`, which already injects `AccuMk1AdapterDep`). When the flag is off, `sterility_only_native` is always `False` and `native and ster_products` is `False`, so the `if not sterility_only_native:` block runs the full legacy sequence and neither native branch fires — flag-off is byte-identical.

- [ ] **Step 7: Mk1 ingest endpoint — DEPENDENT DELIVERABLE + DESIGN GATE**

**Do NOT fabricate the Mk1 handler internals.** The `POST /samples/native-sterility` endpoint does not exist yet, and — unlike vial-level native create (`sub_samples/native.py`, which mints `mk1://` **sub-samples**) — creating a **parent** native sterility analysis at order time is net-new. It must reuse the `mk1://` prefix convention (`native.py:22`, `generate_native_uid`) and the native `LimsAnalysis` write path (`lims_analyses/routes.py`, `service.py`), and it must be idempotent on `Idempotency-Key`. Open design questions to resolve WITH the Handler before building:
- **DG-1: parent identity for sterility-only.** What `sample_id` does an `mk1://` sterility-only parent get (customer-visible id scheme; does it collide with SENAITE's `P-XXXX`)? The vial helper `next_native_sample_id` (`native.py:51`) formats `{parent}-S{NN}` but there is no parent-id minter yet.
- **DG-2: which native analyses.** The endpoint seeds the ordered products' member services — reuse Task 3's `select_services_for_role(db, "ster", ordered_products=...)` server-side so IS and Mk1 agree on the analyte set from one source.
- **DG-3: mixed-anchor semantics.** For a mixed order, does native sterility attach to the SENAITE-backed parent row Mk1 already ingests from the AR, or a parallel native parent-tier row? (Ties into seam 2 / the promote write-back, 1E.)

Specify the contract (above) in the IS plan; build the Mk1 handler as a paired change in the same isolated stack **after** DG-1..3 are answered. This is the seam-3 design gate.

- [ ] **Step 8: Run tests + IS gates (flag off AND on)**

```bash
python -m pytest tests/unit/test_sterility_native_routing.py tests/unit/test_order_processor_flow.py -q
ruff check . && mypy app
```
Expected: flag-off tests confirm byte-identical legacy behavior; flag-on tests confirm profile-drop + skip-AR trigger; existing `test_order_processor_flow.py` unchanged (flag defaults off). `gitnexus_detect_changes()` — confirm the changed symbols are exactly `_map_services_to_profiles`, `build_analysis_request_from_sample` (comment-only), `OrderProcessor.process`/`__init__`, `AccuMk1Adapter.create_native_sterility`, and `Settings`.

- [ ] **Step 9: Commit (IS side) — the cut stays behind the default-off flag**

```bash
git add app/core/config.py app/services/order_validator.py app/adapters/senaite.py \
  app/services/order_processor.py app/adapters/accumk1.py app/dependencies.py \
  tests/unit/test_sterility_native_routing.py
git commit -m "feat(seam3): native sterility routing behind STERILITY_NATIVE_ROUTING (default off) (1D Task 4)"
```

- [ ] **Step 10: HANDLER-GATED CHECKPOINT — enabling the cut**

Enabling `STERILITY_NATIVE_ROUTING=1` in prod is **not** an autonomous step. Preconditions (all required):
1. Task 5 cross-repo parity gate green in a fresh isolated stack (below).
2. GATE G-ORD answered (sterility-only orderability) and, if orderable today, an in-flight sterility-only sample rehearsed.
3. DG-1..3 resolved and the Mk1 ingest endpoint built + tested in the same stack.
4. Seam order intact: this cut is independent of the COA-source flip, but the native analysis it creates is what seam 2 (1E) relies on — do NOT enable in prod ahead of coabuilder being able to READ native sterility (1E-a, already shipped) and the 1E flip plan being ready.
5. Handler sign-off on the rehearsal evidence, in the deploy window (per accumark-deploy skill; JWT unchanged, so no rotation).

---

## Task 5: cross-repo demand + seeding parity gate (§247 validation evidence)

**Files:**
- Test: `backend/tests/test_catalog_demand_crossrepo_parity.py` (create, Accu-Mk1 side) + a runbook capture of the IS derivation.

**Interfaces:**
- Consumes: `catalog.demand.catalog_base_demand`, `sub_samples.service.derive_base_demand`, `lims_analyses.seeder.select_services_for_role`; and (documented, run in the IS container) `order_validator.ordered_sterility_products`.
- Produces: no source — the retained ISO 17025 7.11.2 validation evidence that the catalog path reproduces the legacy path for legacy-flag orders, and that new single-product orders are correctly OUTSIDE the parity set.

**Why a distinct task from Task 1.** Task 1 proves the Mk1 demand resolver in isolation on the shared `catalog` stack. Task 5 is the **cross-repo, production-shaped** gate run in the isolated stack before the Handler-gated cut: it ties IS's per-product derivation (`ordered_sterility_products`) to Mk1's demand (`catalog_base_demand`) and seeding (`select_services_for_role`), on real order data, and captures the diff as the sign-off artifact. This is the spec's safe-cutover step 2/3 (parity + shadow-read) for the intake half of seam 3.

- [ ] **Step 1: Write the end-to-end parity test**

Create `backend/tests/test_catalog_demand_crossrepo_parity.py` (Accu-Mk1 side; the IS half is asserted in the IS container per Step 2):

```python
"""Catalog 1D Task 5: cross-repo §247 parity gate.

Ties the IS per-product derivation to Mk1's catalog demand + seeding. Run in
the isolated stack with production-shaped data before the seam-3 cut. Legacy
'always both' orders MUST reproduce derive_base_demand; new single-product
orders are OUTSIDE the parity set (must NOT be flagged as regressions).
"""
import pytest

from database import SessionLocal
from catalog.demand import catalog_base_demand
from sub_samples.service import derive_base_demand
from lims_analyses.seeder import select_services_for_role

_PCR, _USP71 = "Sterility PCR", "Sterility USP<71>"
# IS ordered_sterility_products maps a legacy sterility_pcr=True -> BOTH product
# ids; the Mk1 unit names are those products' catalog groups.
_PRODUCT_TO_UNIT = {"sterility_pcr": _PCR, "sterility_usp71": _USP71}


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback(); s.close()


def _units(products):
    return [_PRODUCT_TO_UNIT[p] for p in products]


# ── PARITY: legacy flag (=> both products) reproduces derive_base_demand ────────
def test_legacy_flag_demand_matches_legacy(db):
    legacy_products = {"sterility_pcr", "sterility_usp71"}   # ordered_sterility_products(legacy)
    catalog = catalog_base_demand(db, _units(legacy_products))
    assert catalog["ster"] == derive_base_demand({"sterility_pcr": True})["ster"] == 2


# ── PARITY: legacy seeding still resolves the same analyte set (both products) ──
def test_legacy_flag_seeding_covers_ster_pcr_equivalent(db):
    # Legacy STER-PCR maps, in the catalog world, to the PCR group's members.
    legacy = {s.keyword for s in select_services_for_role(db, "ster")}
    catalog = {s.keyword for s in select_services_for_role(
        db, "ster", ordered_products={"sterility_pcr", "sterility_usp71"})}
    assert legacy == {"STER-PCR"}                                    # unchanged legacy path
    assert catalog == {"PCR-FUNGI", "PCR-BACTERIA", "STER-USP71"}    # catalog addon-aware


# ── NEW BEHAVIOR (OUTSIDE parity set): single-product == 1 vial, not a regression ─
@pytest.mark.parametrize("product,expected_kw", [
    ("sterility_pcr", {"PCR-FUNGI", "PCR-BACTERIA"}),
    ("sterility_usp71", {"STER-USP71"}),
])
def test_single_product_is_new_behavior_not_regression(db, product, expected_kw):
    assert catalog_base_demand(db, _units({product}))["ster"] == 1
    assert {s.keyword for s in select_services_for_role(
        db, "ster", ordered_products={product})} == expected_kw
```

- [ ] **Step 2: Assert the IS derivation half (in the IS container)**

Run the Task-2 derivation tests in the isolated stack's IS container as the cross-repo evidence that IS produces the product ids Mk1 consumes:
```bash
docker exec <stack>-integration-service sh -c "cd /app && python -m pytest tests/unit/test_sterility_native_routing.py -q"
```
Expected: `ordered_sterility_products` maps legacy `sterility_pcr=True` → `{sterility_pcr, sterility_usp71}` (→ both units → 2 vials in Mk1) and per-product payloads → the single product. This is the IS→Mk1 contract seam of the §247 gate.

- [ ] **Step 3: Run the Mk1 gate + capture evidence**

```bash
docker exec <stack>-accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_catalog_demand_crossrepo_parity.py -q"
```
Expected: all PASS. Capture the run output (and the seed query from the "Execution environment" section) into a durable artifact under the Mk1 `docs/superpowers/plans/` evidence area — this is the retained ISO 17025 7.11.2 validation record for the intake half of the cut. (The **COA-output** shadow-diff is a separate 1E control, not this one.)

- [ ] **Step 4: Commit (Accu-Mk1 side)**

```bash
git -C <mk1 worktree> add backend/tests/test_catalog_demand_crossrepo_parity.py
git -C <mk1 worktree> commit -m "test(catalog): cross-repo §247 demand+seeding parity gate for seam 3 (1D Task 5)"
```

---

## Self-Review (completed against the spec + coherence note)

**Spec / coherence-note coverage:**
- **Seam 3 (coherence §15, spec §185, §255):** Task 4 drops the `sterility_pcr`→SENAITE-profile attach (`order_validator.py:454-455`/`:510-511`, adapter `:1768-1769`/`:1820-1821`) and routes sterility natively — mixed → AR minus sterility + native; sterility-only → no SENAITE AR (`mk1://`). Behind a default-off flag; enable = Handler-gated checkpoint.
- **Per-product demand (coherence §20-24, spec §247, §129):** Task 1 (Mk1 `catalog_base_demand`, Σ `vials_required`, both units → 2 = legacy parity; single → 1 = new, outside parity set) + Task 5 (cross-repo gate). Variance stays separate (`derive_variance_demand`, `service.py:870`) — not folded into base.
- **Per-product flags + back-compat (spec §166, §255):** Task 2 — `sterility_usp71: bool | None` tri-state so legacy payloads (`None`) reproduce "always both" while new payloads route per-product; `ordered_sterility_products` derivation; USP<71> gets NO SENAITE profile (Full B).
- **Addon-aware seeding (spec §169):** Task 3 — `select_services_for_role(db, "ster", ordered_products=...)` sources members from the catalog groups (PCR-only → Fungi+Bacteria, USP<71>-only → USP71), additive alongside the legacy `ROLE_TO_KEYWORDS` path (locked #7 — old map retires in Phase 2, not here).
- **Additive discipline / seam order:** every cut is flag-gated + parity-gated; seam 3 is planned as independent of the COA-source flip but explicitly sequenced so its native analysis exists before seam 2 (1E) relies on it.

**Handler-gated checkpoints marked (not autonomous):** enabling `STERILITY_NATIVE_ROUTING` (Task 4 Step 10) with its 5 preconditions; the Mk1 native-ingest endpoint build (Task 4 Step 7, DG-1..3). Task 1 is the only step that executes tonight.

**Gates flagged inline (no invented answers):**
- **G-WP-USP71** — the WooCommerce cart key for the USP<71> product (1F); exact grep command given, provisional alias marked.
- **G-ORD** — whether a sterility-only order is orderable today (affects back-compat surface of the skip-AR branch); confirmation commands given. Task 4 Step 6(b) also gates the unconditional peptide-identity lookup (`order_processor.py:468-494`) on `not sterility_only_native`, since for a peptide-typed sterility-only sample that lookup would otherwise mark it `failed` before native routing is reached (a BW sterility-only sample has `peptides=[]` and is unaffected).
- **G-BASE** — the IS branch base for 1D (`subsample-features` vs master vs 1.0.5); confirm before branching, do not couple to unmerged feature work.
- **DG-1..3** — Mk1 native parent identity / analyte source / mixed-anchor semantics (seam-3 design gate, resolve with Handler before building).
- Carried from upstream: **G1** (USP<71> `result_options` wording, 1C) — the seeded `STER-USP71` analyte set is used here but its reported terminology is a lab confirm; does not block seeding.

**Placeholder scan:** Task 1–3 and Task 5 ship complete real code + exact commands. Task 4 Step 6 contains no elided-but-known code: the new pieces (routing guard, native-create call + body, native failure handling) are shown in full; the existing `:468-630` SENAITE block is referenced by exact line range as "preserved verbatim" with its single edit (`senaite_id = result.sample_id`) and the real failure `else` (`:631-637`) spelled out — a precise reference to real code that stays put, not a stub. The one genuinely unbuildable-yet piece (the Mk1 `POST /samples/native-sterility` handler internals) is explicitly deferred with its full contract shape + open design questions (DG-1..3), per the "state the command / don't invent" rule.

**Type / name consistency:** `catalog_base_demand(db, ordered_units) -> dict[str,int]` returns `{"hplc","endo","ster"}` matching `derive_base_demand`'s shape; product ids `{"sterility_pcr","sterility_usp71"}` are identical across IS (`ordered_sterility_products`, `SampleServices` fields), the Mk1 seeder map (`STERILITY_PRODUCT_TO_GROUP`), and the cross-repo test (`_PRODUCT_TO_UNIT`); catalog unit names (`"Sterility PCR"`, `"Sterility USP<71>"`) and keywords (`PCR-FUNGI`, `PCR-BACTERIA`, `STER-USP71`, `STER-PCR`) match the 1C seed (`database.py:857-916`) and the live stack query; the tri-state `bool | None` and `set[str]` annotations are mypy-clean.

**IS gate compliance:** each IS symbol edit (`_map_services_to_profiles`, `build_analysis_request_from_sample`, `OrderProcessor.process`) is preceded by `gitnexus_impact` and followed by `gitnexus_detect_changes`; every IS commit runs `ruff check . && mypy app`.
