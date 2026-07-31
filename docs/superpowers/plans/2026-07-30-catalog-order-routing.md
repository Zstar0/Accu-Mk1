# Catalog Order Routing Implementation Plan (spec 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer buy a new test family and have that purchase drive vial demand and analysis seeding from the Mk1 catalog — unknown service keys rejected loudly at Integration Service ingest, the WordPress wire key made explicit and rename-proof, and the `hm` vial role landed at every site the role checklist names.

**Architecture:** WordPress gains a `profile_key` field on the `wc_test_services` admin repeater whose value both JS order paths send verbatim as the `_sample_data['services']` key (legacy name-derived keys unchanged for the five existing services). Integration Service migrates `SampleServices` to `extra="allow"`, validates every key against a declared registry inside `DefaultOrderValidator` (so rejections are recorded 422s, not unrecorded parse failures), and lets declared native keys ride the stored payload through to Mk1's existing `GET /explorer/orders/sample-services` pull. Mk1's `derive_base_demand` becomes catalog-backed (MAX of `vials_required` per fulfillment role over the ordered profiles) with the legacy hardcoded map retained as a shadow-compare fallback for the three legacy buckets, and `seed_analyses_for_vial` gains a catalog branch that seeds an `hm` vial from Analysis Profile membership.

**Tech Stack:** FastAPI + SQLAlchemy + pytest (Mk1 backend, IS), React/TS + vitest (Mk1 frontend), PHP 8.1 + vanilla JS (wpstar theme, no test framework), ReportLab (COABuilder, one warning).

## Global Constraints

- **Four repos, one branch name:** `feat/catalog-order-routing` everywhere.
  - Accu-Mk1: cut from `feat/native-coa-sections` (`a9338a2`), worktree `C:\tmp\Accu-Mk1-order-routing`.
  - Integration Service: cut from `feat/native-coa-sections` (`ee3746c`), worktree `C:\tmp\is-order-routing`.
  - COABuilder: cut from `feat/native-coa-sections` (`03507d4`), worktree `C:\tmp\coabuilder-order-routing` — NEVER from the parked detached-HEAD main checkout (64 commits stale).
  - accumarklabs (WP): repo root is the **WordPress install root** `\\wsl.localhost\docker-desktop-data\data\docker\volumes\DevKinsta\public\accumarklabs` (NOT the theme dir — `git show master:./relative/path` needs the `./` prefix from inside the theme). The live tree is checked out on `feat/prepaid-balance` — **do not touch it**; create worktree `C:\tmp\accumarklabs-order-routing` cut from `master` (`a3d2e59`). Theme paths below are relative to `wp-content/themes/wpstar/`.
- **Additive only.** A failing pre-existing test defaults to "the test is stale"; production-behavior changes need Handler sign-off. The five legacy service keys must behave byte-identically at every layer (WP wire key, IS validation, Mk1 demand and seeding).
- **Gates:**
  - Mk1 backend: failure-set DIFF vs the 64-failure baseline (never zero-failures); interpreter `/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`, run from the worktree's `backend/`. Copy `C:\tmp\Accu-Mk1-coa-sections\.superpowers\sdd\2026-07-30-native-coa-sections\baseline-failures.txt` as the starting baseline (re-derive on first run — spec-3 sits on the same base).
  - Mk1 frontend: `npx tsc --noEmit` only (NEVER `npm run check:all`); npm only; Zustand selector syntax.
  - IS: `pytest` failure-set diff vs a baseline captured at Task 5 start, plus `ruff check . && mypy app` net-zero-new (capture the starting counts first — the handoff's 2467/241 are unverified; there is no venv in the worktree, use the IS main checkout's `.venv\Scripts\python.exe`).
  - COABuilder: `pytest -q --ignore=scripts/test_ui_mock.py` with `SENAITE_URL/SENAITE_USERNAME/SENAITE_PASSWORD` dummies and `app_settings.json` copied to the worktree root (has creds — NEVER commit); baseline 5 failures; `git checkout -- logs/coabuilder.log` before staging.
  - WP: **no automated gate exists** (no phpunit; phpcs config exists but its cache is from the original author's machine). Verify with `php -l` per touched file (via `docker exec devkinsta_fpm php -l ...` or any php8.1) + the Task 8 stack rehearsal.
- **Explicit-path staging always; never `git add -A`.** Commit per task.
- **Wire-key identity:** a new family's WordPress `profile_key` === its Mk1 `analysis_profiles.key` === the key IS declares. First tenant `heavy_metals` (E2E-proven name on stack s2e2e). Role code `hm` (≤ 8 chars — `assignment_role` is `VARCHAR(8)`; the column is not widened).
- **Never weaken:** `build_ordered_products` fail-open synthesis (`product_registry.py:79-84,105-108`); the variance-payload fail-soft fetch; the AccuShield coupon/bundle math (endotoxin+sterility only — new families do NOT join the bundle); spec-2's fail-closed COA rules; the `origin='mk1'` all-native section rule.
- **Deploy order is load-bearing and unchanged:** IS → Mk1 → (spec 2 already on the train) → WP `wc_test_services` entry flipped to purchasable. Everything rides the one combined deploy window; activation for sale = creating/flipping the WP entry, which is the G-PUB Handler gate.
- **GitNexus:** index is stale for Accu-Mk1 (advisory); impact analysis best-effort, behavior tests are the authority.

## Decisions and spec corrections (documented, Handler can veto any)

1. **SPEC CORRECTION — the explicit key lives on `wc_test_services`, not WC product meta.** The spec's Layer 1 assumed the PHP normalizer at `Cart_Order.php:1407/:1627` mints the wire key. Recon (master `a3d2e59`) proved the wire key is minted in **JS** from the `wc_test_services[].name` (`name.toLowerCase().replace(/\s+/g,'')` — whitespace-only alphabet, keeps `&()`), stored into `_sample_data['services']`, and passed through PHP verbatim; the PHP normalizer (different alphabet, strips `&()`) only resolves WC products for line items. The theme has zero product-meta plumbing. So the stable key is a new `profile_key` column on the `wc_test_services` repeater — the object the wire key actually derives from. Renaming the *service entry* (the real rename hazard) no longer changes the wire key. The WC product link (`product_id`) stays what it is: the price source.
2. **`hm` gets its own Department ("Heavy Metals") and its own inbox lane.** The branch refactored role maps to department-keyed (`_ROLE_DEPARTMENT_NAMES`, `ROLE_TO_DEPARTMENT_NAME`). Folding `hm` into Analytical would make role-flip cleanup unable to distinguish HM analyses from HPLC ones (both dept-matched) and would dump ICP-MS bench work into the HPLC lane. Department = bench is spec-1's model; the dept-keyed lane refactor exists precisely so a new lane is cheap. NOTE: the s2e2e E2E seed used `department_id: 1` (Analytical) — harmless for the COA path it proved, but the Task 8 rehearsal re-seeds HM services into the new department.
3. **Demand semantics = MAX of `vials_required` per fulfillment role, not SUM.** Legacy `hplc = 1 if (hplcpurity_identity OR bac_water_panel)` is reproduced exactly by MAX over profiles sharing the role. Two future families sharing one role therefore share the vial — flag to the lab at G-V.
4. **Native-only orders: IS and Mk1 support lands now; the WP wizard keeps its primary-always-included invariant.** IS stops requiring a SENAITE profile to exist (the gate becomes "at least one *recognized* service selected") and skips the per-peptide Identity lookup unless `peptide_identity` is among the mapped profiles; a native-only order still creates a bare SENAITE AR (empty `Profiles`) to anchor `sample_id` — the AR-less case stays deferred to the identity-seam spec. Whether WP can *emit* a primary-less order is a later WP slice (blocked on G-V/G-P anyway).
5. **`is_addon` re-semantics (`standalone`/`requires_base`) is DEFERRED to that WP à-la-carte slice**, where it first becomes functional. What lands now from that agenda item: the IS validator generalization in (4). Registry fact preserved for the future: `is_addon` ⇔ `fulfillment_role IS NOT NULL` held for all 5 profiles pre-spec-3; Task 1's backfill breaks that equivalence deliberately (primaries gain `fulfillment_role='hplc'` while staying `is_addon=False`) — the FE completion check keys on `is_addon && fulfillment_role` and is unaffected.
6. **`active` consumption = warn-on-fulfill + honest admin copy + runbook gate.** Fulfillment of a paid order NEVER blocks on `active` (that would strand paid work); the demand resolver logs a warning when it fulfills an inactive profile; the admin helper text "Inactive profiles are hidden from new orders" (which nothing implements) is corrected; actual sale-gating is the G-PUB runbook step (the `wc_test_services` entry).
7. **IS declares native keys in a registry set, not sentinel values inside `SERVICE_TO_PROFILE`.** The spec's sentinel would be dead weight — recon proved both SENAITE profile-attach chains are `if/elif` with no `else` (unknown tokens already no-op), and `SERVICE_TO_PROFILE` already carries never-looked-up alias entries. A separate `NATIVE_SERVICE_KEYS` frozenset + a derived `KNOWN_SERVICE_KEYS` is the declared set the spec intended.
8. **New WP families launch as `type=addon` entries; beta = `addon-coming-soon`.** The Variance_Tester publish-status gate is variance-substring-specific and does not generalize; the existing `addon-coming-soon` type (visible teaser, not purchasable) is the pre-launch state, flipped to `addon` at G-PUB. No new gating code.

---

### Task 1: Catalog-backed vial demand with legacy shadow-compare (Accu-Mk1)

**Files:**
- Create: `backend/sub_samples/catalog_demand.py`
- Modify: `backend/catalog/profile_seed.py` (demand-field backfill for the five seeded profiles)
- Modify: `backend/sub_samples/service.py` (`derive_base_demand` ~:1189, `derive_demand` ~:1201, `compute_vial_plan` ~:1281; thread `db`)
- Modify: `backend/main.py:8874`, `backend/main.py:9010` (pass `db`)
- Modify: `backend/sub_samples/routes.py:438` (pass `db`)
- Test: `backend/tests/test_catalog_demand.py` (new)

**Interfaces:**
- Consumes: `AnalysisProfile` (`models.py:276-331` — `key`, `vials_required`, `fulfillment_role`, `fulfillment_dim`, `active`), `seed_profiles_from_registry` (`catalog/profile_seed.py:18-38`).
- Produces: `derive_base_demand_catalog(db, services) -> dict[str, int]` in `catalog_demand.py`; `derive_base_demand(services, db=None)` and `derive_demand(services, db=None)` (db=None ⇒ pure legacy, so every existing caller/test is untouched); `backfill_profile_demand_fields(db)` idempotent, called from `seed_profiles_from_registry`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_catalog_demand.py`. Fixtures: `db_session` from conftest; a local `_seed(db)` helper that runs the real `seed_profiles_from_registry` (pattern: `test_profile_parity.py:23-26`).

```python
"""Catalog-backed demand: MAX(vials_required) per fulfillment role.

Parity contract: for every combination of the five legacy keys the catalog
resolver returns byte-identical demand to the legacy hardcoded map. New
profile keys are new behavior outside the parity set.
"""
import itertools
import pytest

LEGACY_KEYS = ["hplcpurity_identity", "bac_water_panel", "endotoxin",
               "sterility_pcr", "samplevariance"]


def _seed(db):
    from catalog.profile_seed import seed_profiles_from_registry
    seed_profiles_from_registry(db)
    db.commit()


def _mk_hm_profile(db, *, vials=1, role="hm", active=True):
    from models import AnalysisProfile
    p = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True,
                        vials_required=vials, fulfillment_role=role,
                        fulfillment_dim="role", active=active)
    db.add(p)
    db.commit()
    return p


def test_parity_all_32_legacy_combos(db_session):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    from sub_samples.service import derive_base_demand
    _seed(db_session)
    for bits in itertools.product([True, False], repeat=5):
        services = dict(zip(LEGACY_KEYS, bits))
        legacy = derive_base_demand(services)          # db=None -> pure legacy
        catalog = derive_base_demand_catalog(db_session, services)
        assert {k: catalog.get(k, 0) for k in ("hplc", "endo", "ster")} == legacy, services


def test_hm_alone_provisions_one_hm_vial(db_session):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    _mk_hm_profile(db_session)
    d = derive_base_demand_catalog(db_session, {"heavy_metals": True})
    assert d["hm"] == 1
    assert d["hplc"] == 0 and d["endo"] == 0 and d["ster"] == 0


def test_hm_plus_legacy_composes(db_session):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    _mk_hm_profile(db_session)
    d = derive_base_demand_catalog(
        db_session, {"hplcpurity_identity": True, "heavy_metals": True})
    assert d == {"hplc": 1, "endo": 0, "ster": 0, "hm": 1}


def test_unknown_key_contributes_nothing_and_warns(db_session, caplog):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    with caplog.at_level("WARNING"):
        d = derive_base_demand_catalog(db_session, {"mystery_key": True})
    assert d == {"hplc": 0, "endo": 0, "ster": 0}
    assert any("mystery_key" in r.message for r in caplog.records)


def test_variance_keys_are_quiet_skips(db_session, caplog):
    """samplevariance/variance never hit the warning path (every variance
    order would otherwise log noise) and never add base demand."""
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    with caplog.at_level("WARNING"):
        d = derive_base_demand_catalog(
            db_session, {"samplevariance": True, "variance": {"endotoxin": 3}})
    assert d == {"hplc": 0, "endo": 0, "ster": 0}
    assert not caplog.records


def test_inactive_profile_still_fulfills_but_warns(db_session, caplog):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    _mk_hm_profile(db_session, active=False)
    with caplog.at_level("WARNING"):
        d = derive_base_demand_catalog(db_session, {"heavy_metals": True})
    assert d["hm"] == 1  # paid orders always fulfil
    assert any("inactive" in r.message for r in caplog.records)


def test_flip_shadow_compare_prefers_legacy_on_divergence(db_session, caplog):
    """If an admin edit makes the catalog disagree with legacy on a legacy
    bucket, derive_base_demand(db=...) keeps the LEGACY value for that bucket
    (and logs an error), while catalog-only buckets pass through."""
    from models import AnalysisProfile
    from sub_samples.service import derive_base_demand
    _seed(db_session)
    _mk_hm_profile(db_session)
    row = db_session.query(AnalysisProfile).filter_by(key="endotoxin").one()
    row.vials_required = 5  # bad admin edit
    db_session.commit()
    with caplog.at_level("ERROR"):
        d = derive_base_demand({"endotoxin": True, "heavy_metals": True},
                               db=db_session)
    assert d["endo"] == 1     # legacy wins the legacy bucket
    assert d["hm"] == 1       # catalog-only bucket unaffected
    assert any("demand_divergence" in r.message for r in caplog.records)


def test_seed_backfills_demand_fields(db_session):
    from models import AnalysisProfile
    _seed(db_session)
    rows = {p.key: p for p in db_session.query(AnalysisProfile).all()}
    assert (rows["hplcpurity_identity"].vials_required,
            rows["hplcpurity_identity"].fulfillment_role) == (1, "hplc")
    assert (rows["bac_water_panel"].vials_required,
            rows["bac_water_panel"].fulfillment_role) == (1, "hplc")
    assert (rows["endotoxin"].vials_required,
            rows["endotoxin"].fulfillment_role) == (1, "endo")
    assert (rows["sterility_pcr"].vials_required,
            rows["sterility_pcr"].fulfillment_role) == (2, "ster")
    assert rows["variance"].vials_required == 0  # variance NEVER folds into base
```

- [ ] **Step 2: Run tests, confirm they fail** (`ModuleNotFoundError: sub_samples.catalog_demand`, backfill assertions fail).

Run: `cd /c/tmp/Accu-Mk1-order-routing/backend && <venv-python> -m pytest tests/test_catalog_demand.py -q`

- [ ] **Step 3: Implement**

`backend/sub_samples/catalog_demand.py`:

```python
"""Catalog-backed base vial demand (spec 3).

Demand for a fulfillment role is MAX(vials_required) over the ordered
profiles that fulfil it — MAX, not SUM, because legacy semantics are
boolean-OR per bucket (hplcpurity_identity OR bac_water_panel -> 1 hplc
vial) and two families sharing a role share the aliquot.
"""
import logging
from typing import Optional

log = logging.getLogger(__name__)

# Legacy bucket floor: always present in the returned dict, zeros included,
# so callers keyed on the historical 3-bucket shape keep working.
_LEGACY_BUCKETS = ("hplc", "endo", "ster")
# Keys that are demand-inert by design; skipping them must not warn.
_QUIET_KEYS = {"samplevariance", "variance"}


def derive_base_demand_catalog(db, services: dict) -> dict:
    from models import AnalysisProfile

    demand = {b: 0 for b in _LEGACY_BUCKETS}
    for key, selected in (services or {}).items():
        if key in _QUIET_KEYS or not selected:
            continue
        prof = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if prof is None:
            # Same class as build_ordered_products' fail-open: an unknown key
            # must never break fulfilment of the rest of the order.
            log.warning("catalog_demand_unknown_key key=%s", key)
            continue
        if not prof.active:
            log.warning("catalog_demand_inactive_profile key=%s", key)
        if prof.fulfillment_dim != "role" or not prof.fulfillment_role:
            continue  # kind-dim (variance) composes elsewhere, never here
        role = prof.fulfillment_role
        demand[role] = max(demand.get(role, 0), prof.vials_required)
    return demand
```

`backend/sub_samples/service.py` — `derive_base_demand` becomes the flip point with the shadow-compare:

```python
def derive_base_demand(services: dict, db=None) -> dict:
    """Pre-variance vial demand per bucket (the lab-protocol baseline).

    db=None -> pure legacy map (unchanged behavior, used by legacy callers
    and as the shadow reference). With a db, the catalog is authoritative;
    on any divergence in a LEGACY bucket the legacy value wins and an error
    is logged (fail-open to known-good, never to under-provisioning).
    """
    hplc = bool(services.get("hplcpurity_identity") or services.get("bac_water_panel"))
    endo = bool(services.get("endotoxin"))
    ster = bool(services.get("sterility_pcr"))
    legacy = {
        "hplc": 1 if hplc else 0,
        "endo": 1 if endo else 0,
        "ster": 2 if ster else 0,
    }
    if db is None:
        return legacy
    from sub_samples.catalog_demand import derive_base_demand_catalog
    catalog = derive_base_demand_catalog(db, services)
    for bucket, legacy_n in legacy.items():
        if catalog.get(bucket, 0) != legacy_n:
            log.error(
                "demand_divergence bucket=%s legacy=%s catalog=%s services=%s",
                bucket, legacy_n, catalog.get(bucket, 0), sorted(services or {}),
            )
            catalog[bucket] = legacy_n
    return catalog
```

`derive_demand(services, db=None)` passes `db` through. Update the four production call sites to pass their session (`main.py:8874`, `main.py:9010`, `sub_samples/routes.py:438`, `compute_vial_plan` at `service.py:1279-1281` — pass `db` to `derive_demand` and `derive_base_demand`; `derive_variance_demand` is untouched).

`backend/catalog/profile_seed.py` — append after the insert loop, inside `seed_profiles_from_registry`:

```python
    # Spec-3 demand backfill: the spec-1 seed shipped vials_required=0
    # ("wired to real demand in spec 3" — that is this). Idempotent: only
    # rows still at the inert defaults are touched, admin edits survive.
    _DEMAND_DEFAULTS = {
        "hplcpurity_identity": (1, "hplc"),
        "bac_water_panel": (1, "hplc"),
        "endotoxin": (1, "endo"),
        "sterility_pcr": (2, "ster"),
    }
    for key, (vials, role) in _DEMAND_DEFAULTS.items():
        row = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if row is not None and row.vials_required == 0:
            row.vials_required = vials
            if not row.fulfillment_role:
                row.fulfillment_role = role
```

(`endotoxin`/`sterility_pcr` already carry `fulfillment_role` from the registry; the guard keeps this idempotent. `variance` is deliberately absent.)

- [ ] **Step 4: Run the new tests (pass) + the demand neighbors**

Run: `<venv-python> -m pytest tests/test_catalog_demand.py tests/test_sub_samples_service.py tests/test_variance_demand.py tests/test_profile_parity.py -q`
Expected: new tests PASS; `test_sub_samples_service.py:340-373`'s seven `derive_demand` cases still PASS untouched (they call with `db=None`).

- [ ] **Step 5: Full backend gate (failure-set diff vs baseline), commit**

```bash
git add backend/sub_samples/catalog_demand.py backend/sub_samples/service.py backend/catalog/profile_seed.py backend/main.py backend/sub_samples/routes.py backend/tests/test_catalog_demand.py
git commit -m "feat(catalog): catalog-backed vial demand, MAX-per-role, legacy shadow-compare"
```

---

### Task 2: Catalog-driven seeding for catalog roles (Accu-Mk1)

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (`role_implies_seeding` :81-86, `seed_analyses_for_vial` :318+, `select_services_for_role` :89-99, map comments :59-78)
- Test: `backend/tests/test_catalog_seeding.py` (new); Modify: `backend/tests/test_lims_analyses_seeder.py` (only if signatures force it — default expectation: untouched)

**Interfaces:**
- Consumes: `AnalysisProfile` + `analysis_profile_members` (ordered relationship, `models.py:322-328`), `ROLE_TO_WP_KEYS`/`ROLE_TO_KEYWORDS` (legacy fallback), `seed_analyses_for_vial(db, sub_sample, role, wp_services, parent_sample_id, commit)` existing signature.
- Produces: `role_implies_seeding(role, wp_services, db=None)` — catalog-aware, legacy behavior when `db=None`; `_catalog_members_for_role(db, role, wp_services)` returning ordered `AnalysisService` rows; `seed_analyses_for_vial` seeds catalog roles (any role not in `ROLE_TO_WP_KEYS`, plus catalog-first for legacy micro roles is NOT attempted — endo/ster stay on the keyword whitelist) from profile membership.

- [ ] **Step 1: Failing tests** — `backend/tests/test_catalog_seeding.py`; fixtures mirror `test_lims_analyses_seeder.py` (build parent + sub-sample + `AnalysisService(origin='mk1')` rows + an `AnalysisProfile` with members; `monkeypatch` nothing — pass `wp_services` explicitly).

```python
def _mk_catalog(db):
    """Heavy Metals profile: 4 mk1-origin member services, ordered."""
    from models import AnalysisProfile, AnalysisService
    svcs = []
    for i, kw in enumerate(["HM-PB", "HM-AS", "HM-CD", "HM-HG"]):
        s = AnalysisService(title=kw, keyword=kw, origin="mk1", unit="ppm")
        db.add(s); db.flush(); svcs.append(s)
    p = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True,
                        vials_required=1, fulfillment_role="hm",
                        fulfillment_dim="role", active=True)
    db.add(p); db.flush()
    # Junction rows with sort_order (models.py:263-273). Adapt to the actual
    # construct (Table vs mapped class) — spec-2's test_native_sections.py
    # already builds ordered memberships; copy its idiom verbatim.
    _add_profile_members(db, p, svcs)
    db.commit()
    return p, svcs


def test_role_implies_seeding_catalog_role(db_session):
    from lims_analyses.seeder import role_implies_seeding
    _mk_catalog(db_session)
    assert role_implies_seeding("hm", {"heavy_metals": True}, db=db_session)
    assert not role_implies_seeding("hm", {"heavy_metals": False}, db=db_session)
    assert not role_implies_seeding("hm", {"endotoxin": True}, db=db_session)


def test_role_implies_seeding_legacy_unchanged_without_db():
    from lims_analyses.seeder import role_implies_seeding
    assert role_implies_seeding("endo", {"endotoxin": True})
    assert not role_implies_seeding("xtra", {"endotoxin": True})


def test_hm_vial_seeds_exactly_profile_members(db_session):
    from lims_analyses.seeder import seed_analyses_for_vial
    from models import LimsAnalysis
    p, svcs = _mk_catalog(db_session)
    sub = _mk_parent_and_vial(db_session, role="hm")  # local helper, same shape as test_lims_analyses_seeder
    created = seed_analyses_for_vial(
        db_session, sub_sample=sub, role="hm",
        wp_services={"heavy_metals": True}, commit=True)
    rows = db_session.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    assert sorted(r.keyword for r in rows) == ["HM-AS", "HM-CD", "HM-HG", "HM-PB"]


def test_hm_vial_seeding_idempotent(db_session):
    from lims_analyses.seeder import seed_analyses_for_vial
    p, svcs = _mk_catalog(db_session)
    sub = _mk_parent_and_vial(db_session, role="hm")
    seed_analyses_for_vial(db_session, sub_sample=sub, role="hm",
                           wp_services={"heavy_metals": True}, commit=True)
    again = seed_analyses_for_vial(db_session, sub_sample=sub, role="hm",
                                   wp_services={"heavy_metals": True}, commit=True)
    assert again == []  # existing_kw skip, mirrors the endo/ster idiom


def test_hm_never_seeds_on_hplc_vial(db_session):
    """Spec-1 allow-list regression re-asserted: the HPLC mirror path is
    untouched by catalog seeding; an hplc-role vial never gets HM members."""
    from lims_analyses.seeder import ROLE_TO_KEYWORDS
    assert "hm" not in ROLE_TO_KEYWORDS  # catalog roles never enter the legacy maps
```

- [ ] **Step 2: Run to fail.** `pytest tests/test_catalog_seeding.py -q`

- [ ] **Step 3: Implement** in `seeder.py`:

```python
def _catalog_members_for_role(db, role, wp_services):
    """Ordered mk1-origin member services of the ordered profiles fulfilling
    `role`. Fail-closed on origin: a profile with any non-mk1 member seeds
    nothing (mirrors spec-2's all-native section rule)."""
    from models import AnalysisProfile
    out, seen = [], set()
    ordered = [k for k, v in (wp_services or {}).items() if v]
    for key in ordered:
        prof = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if prof is None or prof.fulfillment_dim != "role" or prof.fulfillment_role != role:
            continue
        members = prof.analysis_services
        if not members or any(s.origin != "mk1" for s in members):
            log.warning("catalog_seed_skipped_non_native profile=%s", key)
            continue
        for s in members:
            if s.id not in seen:
                seen.add(s.id)
                out.append(s)
    return out


def role_implies_seeding(role, wp_services, db=None):
    """True iff this role's analyses are requested by the WP profile.

    Legacy roles resolve from ROLE_TO_WP_KEYS (hand-synced map, retained as
    the fallback for the five existing keys). Catalog roles resolve from
    Analysis Profiles — THE CATALOG IS AUTHORITATIVE for any role the map
    does not know."""
    if not role or role == "xtra":
        return False
    if role in ROLE_TO_WP_KEYS:
        role_keys = ROLE_TO_WP_KEYS.get(role, set())
        return any(wp_services.get(k) for k in role_keys)
    if db is None:
        return False
    return bool(_catalog_members_for_role(db, role, wp_services))
```

In `seed_analyses_for_vial`: the first-statement gate becomes `role_implies_seeding(role, wp_services, db=db)`; after the `role == "hplc"` mirror branch and before the legacy keyword-whitelist branch, add:

```python
    if role not in ROLE_TO_KEYWORDS:
        # Catalog role (spec 3): seed from profile membership. endo/ster stay
        # on the keyword whitelist above — never re-route legacy roles.
        services = _catalog_members_for_role(db, role, wp_services)
        ...  # create LimsAnalysis rows with the same fields, existing_kw
             # idempotency, and commit=False semantics as the whitelist branch
```

(Prefer extracting the whitelist branch's row-construction block into a shared helper both branches call — same fields, same `existing_kw` skip built at :330-336, same commit handling; do not duplicate the block. Update the hand-sync comments at :59-62 and :74-78: "the catalog is authoritative; this map is the legacy fallback for the five existing keys".)

Update BOTH `role_implies_seeding` call sites' argument lists if needed — production caller is `seeder.py:318` (internal, gets `db` trivially).

- [ ] **Step 4: Run** `pytest tests/test_catalog_seeding.py tests/test_lims_analyses_seeder.py tests/test_seeder_mirror.py tests/test_seed_peptide_identity.py -q` — new pass, legacy untouched.

- [ ] **Step 5: Gate + commit**

```bash
git add backend/lims_analyses/seeder.py backend/tests/test_catalog_seeding.py
git commit -m "feat(catalog): seed catalog-role vials from Analysis Profile membership"
```

---

### Task 3: The `hm` role lands at every checklist site (Accu-Mk1, backend + frontend)

**Files:**
- Modify: `backend/catalog/departments.py:44` (+ a `HEAVY_METALS_DEPARTMENT` constant)
- Modify: `backend/sub_samples/service.py` (`_ROLE_DEPARTMENT_NAMES` :35-40, `_BUCKET_PRIORITY`/`_REAL_BUCKETS` :1216-1217, `_VALID_ROLES` :1421)
- Modify: `backend/main.py` (`ROLE_TO_DEPARTMENT_NAME` :16155-16158, `ROLE_TO_VIAL_ROLES` :16177-16182)
- Modify: `backend/database.py` (variance-exclusion backfill :377-383; `assignment_kind` backfill :355-359)
- Modify: `backend/sub_samples/schemas.py:127-129` (role comment)
- Modify: `src/lib/inbox-filters.ts` (`InboxRoleTag` :5, `itemBench` :22-26, `itemRoleBadges` :44-61) + every consumer `npx tsc --noEmit` surfaces
- Test: `backend/tests/test_hm_role_sites.py` (new); Modify: `src/lib/__tests__/` sibling of inbox-filters tests if one exists (check `src/test/` too)

**Interfaces:**
- Consumes: Tasks 1-2 (`hm` demand + seeding), `backfill_departments` (creates a row per `DEPARTMENT_NAMES` entry).
- Produces: department "Heavy Metals"; inbox lane key `hm` (`ROLE_TO_DEPARTMENT_NAME["hm"] = "Heavy Metals"`, `ROLE_TO_VIAL_ROLES["hm"] = {"hm"}`); `hm` in `_VALID_ROLES`, `_BUCKET_PRIORITY`, `_REAL_BUCKETS`; hm vials variance-excluded; FE lane type `'hm'`.

- [ ] **Step 1: Failing tests** — `backend/tests/test_hm_role_sites.py`:

```python
def test_hm_is_a_valid_role():
    from sub_samples.service import _VALID_ROLES, _BUCKET_PRIORITY, _REAL_BUCKETS
    assert "hm" in _VALID_ROLES and "hm" in _REAL_BUCKETS and "hm" in _BUCKET_PRIORITY


def test_hm_department_exists_after_backfill(db_session):
    from catalog.departments import backfill_departments, HEAVY_METALS_DEPARTMENT
    from models import Department
    backfill_departments(db_session); db_session.commit()
    assert db_session.query(Department).filter_by(name=HEAVY_METALS_DEPARTMENT).one()


def test_hm_maps_to_exactly_one_inbox_lane():
    from main import ROLE_TO_DEPARTMENT_NAME, ROLE_TO_VIAL_ROLES
    lanes = [k for k, roles in ROLE_TO_VIAL_ROLES.items() if "hm" in roles]
    assert lanes == ["hm"]
    assert ROLE_TO_DEPARTMENT_NAME["hm"] == "Heavy Metals"


def test_role_flip_cleanup_keys_hm_on_its_own_department():
    from sub_samples.service import _ROLE_DEPARTMENT_NAMES
    assert _ROLE_DEPARTMENT_NAMES["hm"] == {"Heavy Metals"}
    # the ambiguity this department exists to prevent:
    assert "Heavy Metals" not in _ROLE_DEPARTMENT_NAMES["hplc"]


def test_hm_vial_is_variance_excluded(db_session):
    """Site 7 — the physical-outcome site. An hm vial must never be
    variance-eligible. Exercise the real recompute path, not the backfill."""
    sub = _mk_parent_and_vial(db_session, role="hm")   # same helper family as Task 2
    from sub_samples.service import set_assignment_role
    set_assignment_role(db_session, sub, "hm")
    db_session.refresh(sub)
    assert sub.in_variance_set is False
```

Frontend: extend the inbox-filters test file (locate via `Glob src/**/inbox-filters*.test.*`; if none exists, create `src/lib/__tests__/inbox-filters-hm.test.ts`):

```ts
import { itemBench, itemRoleBadges } from '@/lib/inbox-filters'

test('Heavy Metals department resolves to the hm bench', () => {
  expect(itemBench('Heavy Metals')).toBe('hm')
})

test('hm bench badges as hm', () => {
  // match itemRoleBadges' real signature (inbox-filters.ts:44-61)
  expect(itemRoleBadges('hm', [])).toEqual(['hm'])
})
```

- [ ] **Step 2: Run to fail** (backend + `npx vitest run src/lib/__tests__/inbox-filters-hm.test.ts`).

- [ ] **Step 3: Implement, site by site** (this IS the spec's checklist — tick each):

1. `catalog/departments.py`: `HEAVY_METALS_DEPARTMENT = "Heavy Metals"`; append to `DEPARTMENT_NAMES`. Confirm `backfill_departments` iterates `DEPARTMENT_NAMES` (it does — spec-1); the Analytical-pinned HPLC-mirror allow-list (`seeder.py:196`) is untouched by a new department row.
2. `sub_samples/service.py:1216-1217`: `_BUCKET_PRIORITY = ("hplc", "endo", "ster", "hm")`, add `"hm"` to `_REAL_BUCKETS`; `:1421` add to `_VALID_ROLES`.
3. `sub_samples/service.py:35-40`: `_ROLE_DEPARTMENT_NAMES["hm"] = {"Heavy Metals"}`.
4. `main.py:16155-16158`: `ROLE_TO_DEPARTMENT_NAME["hm"] = "Heavy Metals"`; `:16177-16182`: `ROLE_TO_VIAL_ROLES["hm"] = {"hm"}` (VALID_INBOX_ROLES derives).
5. `database.py:377-383`: extend the exclusion backfill's role list to `('endo', 'ster', 'xtra', 'hm')`; `:355-359` `assignment_kind` backfill needs no change (`hm` is not `'xtra'`, gets kind like any real bucket). **Also locate the RUNTIME exclusion recompute** (grep `variance_exclusion_reason` and `in_variance_set` under `backend/sub_samples/`) — if the runtime rule is `role != 'hplc'`, hm is already excluded and the Step-1 test proves it; if it enumerates roles, add `hm`. The test is the authority.
6. `sub_samples/schemas.py:127-129`: extend the legal-values comment with `hm`.
7. `src/lib/inbox-filters.ts`: `InboxRoleTag` gains `'hm'`; `itemBench` returns `'hm'` for `departmentName === 'Heavy Metals'` (return type gains `'hm'`); `itemRoleBadges` short-circuits `['hm']` for the hm bench. Then run `npx tsc --noEmit` and fix EVERY consumer the compiler surfaces (lane chip lists, filters, switch statements) — the union-type extension makes the compiler enumerate the fan-out; that is the intended discovery mechanism, not a shortcut.

- [ ] **Step 4: Run** backend file + neighbors (`test_assignment_kind.py`, `test_assign_role_fail_hard.py`, `test_variance_demand.py`), vitest file, `npx tsc --noEmit`.

- [ ] **Step 5: Full gates + commit**

```bash
git add backend/catalog/departments.py backend/sub_samples/service.py backend/main.py backend/database.py backend/sub_samples/schemas.py backend/tests/test_hm_role_sites.py src/lib/inbox-filters.ts <every-tsc-surfaced-file> src/lib/__tests__/inbox-filters-hm.test.ts
git commit -m "feat(catalog): hm vial role — department, lanes, buckets, variance exclusion"
```

---

### Task 4: Catalog hygiene riders (Accu-Mk1 backend)

**Files:**
- Modify: `backend/coa/native_sections.py:48-51` (ordered_keys dedup)
- Modify: `backend/main.py:3192-3213` (`validate_new_keyword` reserved-prefix), `backend/main.py:15635+` (PATCH fulfillment validation)
- Test: extend `backend/tests/test_native_sections.py`, `backend/tests/test_analysis_service_crud.py`, `backend/tests/test_api_analysis_profiles.py`

**Interfaces:**
- Consumes: existing `KEYWORD_RE` + `validate_new_keyword` (called from service create :3043 / update :3068); `_ordered_native_profiles`.
- Produces: duplicate order keys yield one section; new `origin='mk1'` keywords may not start `PUR_`/`QTY_`; `fulfillment_dim` validated ∈ {`role`,`kind`} and `fulfillment_role` ≤ 8 chars/lowercase when dim is `role`.

- [ ] **Step 1: Failing tests**

`test_native_sections.py` addition:

```python
def test_duplicate_order_key_emits_one_section(db_session):
    """package == a truthy services key must not duplicate the section
    (ledger final-review minor: ordered_keys has no dedup)."""
    # arrange a reportable native profile 'heavy_metals' (reuse the file's
    # existing profile fixture), then:
    doc = build_native_sections(db_session, sample_id,
                                services={"heavy_metals": True},
                                package="heavy_metals")
    assert [s["profile_key"] for s in doc["sections"]].count("heavy_metals") == 1
    assert doc["ordered_profiles"].count("heavy_metals") == 1
```

`test_analysis_service_crud.py` additions:

```python
@pytest.mark.parametrize("kw", ["PUR_XYZ", "QTY_XYZ"])
def test_reserved_prefix_rejected_for_new_mk1_keywords(client, kw):
    resp = client.post("/api/analysis-services", json={
        "title": "X", "keyword": kw, "result_type": "numeric",
        "department_id": 1})
    assert resp.status_code == 400
    assert "reserved" in resp.json()["detail"].lower()
```

`test_api_analysis_profiles.py` additions: PATCH `fulfillment_dim="banana"` → 400; PATCH `fulfillment_role="ALLCAPS-TOO-LONG"` with `fulfillment_dim="role"` → 400; PATCH `fulfillment_role="hm", fulfillment_dim="role"` → 200.

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

`native_sections.py:48-51`:

```python
    ordered_keys = [k for k, v in (services or {}).items() if v]
    if package:
        ordered_keys.append(package)
    ordered_keys = list(dict.fromkeys(ordered_keys))  # order-preserving dedup
```

`validate_new_keyword`, inserted between the regex check and the uniqueness query (i.e. at `main.py:3208`):

```python
    # PUR_/QTY_ are the per-substance rescue namespaces the HPLC mirror mints
    # (seeder.py generic-analyte translation). A native service claiming one
    # would route promotes through a live SENAITE slot read (spec-2 deferred
    # minor). Reserved outright for new mk1 keywords.
    if keyword.startswith(("PUR_", "QTY_")):
        raise HTTPException(
            400, f"keyword prefix '{keyword.split('_', 1)[0]}_' is reserved "
                 "for per-substance HPLC services")
```

Profile PATCH (beside the existing `coa_archetype` validation at `main.py:15647-15653`):

```python
    if payload.fulfillment_dim is not None and payload.fulfillment_dim not in ("role", "kind"):
        raise HTTPException(400, "fulfillment_dim must be 'role' or 'kind'")
    if payload.fulfillment_role is not None:
        effective_dim = payload.fulfillment_dim or profile.fulfillment_dim
        if effective_dim == "role" and not re.fullmatch(r"[a-z][a-z0-9_]{0,7}", payload.fulfillment_role):
            raise HTTPException(
                400, "fulfillment_role must be lowercase, <= 8 chars "
                     "(assignment_role is VARCHAR(8))")
```

Apply the same two checks on POST (`AnalysisProfileCreate` accepts both fields).

- [ ] **Step 4: Run the three test files; Step 5: gate + commit**

```bash
git add backend/coa/native_sections.py backend/main.py backend/tests/test_native_sections.py backend/tests/test_analysis_service_crud.py backend/tests/test_api_analysis_profiles.py
git commit -m "feat(catalog): ordered_keys dedup, PUR_/QTY_ reserved prefixes, fulfillment validation"
```

---

### Task 5: Profiles admin UI — fulfillment fields + honest `active` copy (Accu-Mk1 frontend)

**Files:**
- Modify: `src/components/hplc/AnalysisProfilesPage.tsx` (form state :59-80, create/edit panels around :530-574, helper text :570)
- Modify: `src/lib/api.ts:4523-4614` (`createAnalysisProfile`/`updateAnalysisProfile` types)
- Test: extend the page's existing test file if present (Glob `src/**/*rofiles*.test.*`), else `src/test/analysis-profiles-fulfillment.test.tsx`

**Interfaces:**
- Consumes: backend POST/PATCH already accept `fulfillment_role`/`fulfillment_dim` (recon: only the FE client type omits them); Task 4's validation.
- Produces: admin can set `fulfillment_role` + `fulfillment_dim` on create and edit (a new family becomes UI-manageable end-to-end); `active` helper text tells the truth.

- [ ] **Step 1: Failing test** — render the edit panel, assert a `fulfillment_role` input exists and PATCH payload carries it (mirror the page's existing test idiom; shadcn `Tooltip` sectioned font-mono for the field's help card per FE house style).
- [ ] **Step 2: Run to fail (vitest).**
- [ ] **Step 3: Implement.** `api.ts`: add `fulfillment_role?: string | null; fulfillment_dim?: 'role' | 'kind'` to both payload types. Page: two fields in the create AND edit panels — `fulfillment_dim` as a two-option select defaulting `role`, `fulfillment_role` as a text input (helper: "vial role code, ≤ 8 chars, e.g. hm — leave empty for profiles that ride an existing vial"). Replace the `:570` helper text with: `"Inactive marks the profile retired — fulfilment of already-sold orders continues. Removing it from sale is the WordPress Test-Services entry."`
- [ ] **Step 4: `npx vitest run <file>` + `npx tsc --noEmit`.**
- [ ] **Step 5: Commit**

```bash
git add src/components/hplc/AnalysisProfilesPage.tsx src/lib/api.ts src/test/analysis-profiles-fulfillment.test.tsx
git commit -m "feat(catalog): fulfillment fields in profiles admin, honest active copy"
```

---

### Task 5b: Native parent analyses section on the sample-details page (Accu-Mk1)

*(Handler-requested 2026-07-30: the P-0120 showcase prints Heavy Metals on the COA while the parent Analysis list — SENAITE-sourced by design, `SampleDetails.tsx:4058-4062` — shows nothing. Ruling: a SEPARATE read-only section, not a merge into the SENAITE table — merging needs dual transition dispatch and muddies the "X of N verified" counters, and phase-out slice 2 replaces the parent read anyway; the separate renderer is the piece that survives.)*

**Files:**
- Modify: `backend/lims_analyses/routes.py` (new GET endpoint, match the router's existing path idiom)
- Modify: `src/components/senaite/SampleDetails.tsx` (parent-page card below the Analyses table)
- Modify: `src/lib/api.ts` (client fn + type)
- Test: `backend/tests/test_native_parent_analyses_endpoint.py` (new); `src/test/native-parent-analyses.test.tsx` (new)

**Interfaces:**
- Consumes: parent-tier `LimsAnalysis` rows (`lims_sample_pk` set) joined to `AnalysisService`; the current-row idiom from `_eligible_parent_row` (`retest_of_id.is_(None)`, `order_by(id.desc())`, latest per service).
- Produces: `GET .../parent/{sample_id}/native-analyses` → `[{keyword, title, result_value, result_unit, review_state, updated_at}]` — **`origin='mk1'` services ONLY** (the dormant dual-write SENAITE shadow rows must NOT double-render the SENAITE table); FE card "Accu-Mk1 Analyses" rendered on parent pages only when the list is non-empty, read-only (parent-row lifecycle stays with promote/un-promote flows), review-state badge per row, house-style sectioned font-mono tooltip for provenance help.

- [ ] **Step 1: Failing backend test** — seed a parent with (a) a native service parent row, (b) a SENAITE-origin shadow parent row, (c) a superseded native row (`retest_of_id` set): endpoint returns exactly the one current native row; unknown sample → 404.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement endpoint** (query parent sample by `sample_id` → parent-tier rows joined to `AnalysisService` filtered `origin == 'mk1'` and `retest_of_id.is_(None)`, latest-per-service via `order_by(id.desc())` + first-seen dedup on `analysis_service_id` — mirrors `_eligible_parent_row`).
- [ ] **Step 4: Failing FE test** — parent page with data renders the card + rows; empty list renders nothing; sub-sample page never fetches it.
- [ ] **Step 5: Implement FE** — `useQuery` gated `parentSampleId === null` (same guard family as the overlay at `SampleDetails.tsx:3549-3559`), card below the Analyses table.
- [ ] **Step 6: Gates (`pytest` diff, vitest, `npx tsc --noEmit`) + commit**

```bash
git add backend/lims_analyses/routes.py backend/tests/test_native_parent_analyses_endpoint.py src/components/senaite/SampleDetails.tsx src/lib/api.ts src/test/native-parent-analyses.test.tsx
git commit -m "feat(catalog): read-only native parent analyses section on sample details"
```

---

### Task 6: IS — declared-key registry, recorded 422 rejection, native-only orders (Integration Service)

**Files:**
- Modify: `app/models/order.py:111-154` (`SampleServices` → `ConfigDict`, `extra="allow"`)
- Modify: `app/services/order_validator.py` (registry :142-151 area; `_map_services_to_profiles` :438-460; empty-profiles gate :324-329; new unknown-key + native validation)
- Modify: `app/services/order_processor.py` (peptide-identity gate :482-505)
- Modify: `app/api/webhook.py` (order-services-updated rejection :1176-1187; debug log :551-557)
- Test: `tests/unit/test_native_service_keys.py` (new); Modify: `tests/unit/test_order_services_updated.py:388-421` (the pinned silent-drop test INVERTS); extend `tests/unit/test_order.py`

**Interfaces:**
- Consumes: `SampleServices` (10 accepted legacy keys = 7 field names + 3 aliases), `DefaultOrderValidator`, `OrderSubmissionResponse` 422 Shape 2 (recorded via `db_record.status = "validation_failed"`).
- Produces: `NATIVE_SERVICE_KEYS: frozenset[str]` (`{"heavy_metals"}` at launch) and `KNOWN_SERVICE_KEYS` (field names ∪ aliases ∪ native) in `order_validator.py`; unknown keys → recorded 422 naming the key; native keys ride `model_dump()` into the stored payload (and therefore out of `GET /explorer/orders/sample-services` to Mk1 — the E2E-proven read path); native-only orders pass validation with zero SENAITE profiles.

**Design constraints this task must honor (from recon):**
- `extra="forbid"` is the WRONG mechanism — a parse-time `ValidationError` raises before `OrderProcessor.process` creates the `order_submissions` row (`webhook.py:445-459` vs `order_processor.py:305-316`), so the rejection would be unrecorded Shape-1. The check lives in `DefaultOrderValidator`, producing recorded Shape-2 422s.
- `extra="allow"` + `model_dump()` keeps declared native extras in the persisted payload — that is the feature, not a side effect.
- Alias whitelist is 10 keys; never reject a legitimate alias.
- mypy is `strict = true`; `ruff check . && mypy app` must be net-zero-new vs counts captured at task start.

- [ ] **Step 1: Failing tests** — `tests/unit/test_native_service_keys.py` (style: the file-local `_post_signed` HMAC helpers from `test_order_services_updated.py`):

```python
class TestUnknownServiceKeyRejection:
    def test_unknown_key_is_recorded_422_naming_the_key(self, client, mock_db, ...):
        """heavy_metalz (typo) -> 422 Shape 2, status validation_failed,
        error string contains the offending key; db_record.status written."""
        ...
        resp = _post_signed(client, _order_payload(services={
            "hplcpurity&identity": True, "heavy_metalz": True}), ...)
        assert resp.status_code == 422
        body = resp.json()
        assert body["status"] == "validation_failed"
        assert any("heavy_metalz" in e for e in body["errors"])

    def test_all_ten_legacy_keys_still_accepted(self, ...):
        """field names AND aliases pass — the whitelist is 10 keys."""

    def test_declared_native_key_passes_and_persists(self, ...):
        """heavy_metals: true -> 202; the persisted payload's services dict
        carries heavy_metals=True (model_dump keeps declared extras)."""

    def test_native_only_order_passes_with_zero_senaite_profiles(self, ...):
        """services = {heavy_metals: true} only -> validation passes (no
        'at least one analytical service' error), profiles == []."""

    def test_native_extra_must_be_bool(self, ...):
        """heavy_metals: 'yes please' -> recorded 422."""


class TestPeptideIdentityGate:
    def test_identity_lookup_skipped_when_not_mapped(self, ...):
        """native-only peptide order: lookup_analysis_uid never called."""
    def test_identity_lookup_still_runs_for_hplc_orders(self, ...):
        """hplcpurity_identity=true -> unchanged behavior."""
```

Invert `test_order_services_updated.py:388-421`: rename to `test_unknown_services_key_is_rejected`, assert 400 (Shape 3) and the key named. Docstring: "spec 3 closed the silent-drop hole; SampleServices allows extras but the update path validates against KNOWN_SERVICE_KEYS."

- [ ] **Step 2: Run to fail.** `cd /c/tmp/is-order-routing && <is-venv-python> -m pytest tests/unit/test_native_service_keys.py tests/unit/test_order_services_updated.py -q`

- [ ] **Step 3: Implement**

`order.py` — replace the v1-shim Config:

```python
    model_config = ConfigDict(populate_by_name=True, extra="allow")
```

(Drop `class Config`; import `ConfigDict` from pydantic. This is the only v1-shim model in `app/models/` — the migration is local.)

`order_validator.py`:

```python
# Native (Mk1-catalog) service keys: no SENAITE profile exists or is attached;
# the key rides the stored payload to Mk1, which derives demand and seeding
# from its Analysis Profile of the same key. Adding a family = one entry here
# (deploy IS before the WordPress entry exists — ordering is load-bearing).
NATIVE_SERVICE_KEYS: frozenset[str] = frozenset({"heavy_metals"})

_LEGACY_FIELD_NAMES = frozenset(SampleServices.model_fields.keys())
_LEGACY_ALIASES = frozenset(
    f.alias for f in SampleServices.model_fields.values() if f.alias
)
KNOWN_SERVICE_KEYS: frozenset[str] = _LEGACY_FIELD_NAMES | _LEGACY_ALIASES | NATIVE_SERVICE_KEYS
```

New validation step inside the per-sample loop (same `ValidationError(field="services", message=..., sample_number=...)` shape the 422 Shape-2 formatter consumes):

```python
        extras = sample.services.model_extra or {}
        for key, value in extras.items():
            if key not in KNOWN_SERVICE_KEYS:
                errors.append(ValidationError(
                    field="services",
                    message=f"Unknown service key '{key}' — order rejected "
                            "(deploy Integration Service with the key declared "
                            "before publishing the product)",
                    sample_number=sample.number))
            elif not isinstance(value, bool):
                errors.append(ValidationError(
                    field="services",
                    message=f"Service key '{key}' must be boolean, got {type(value).__name__}",
                    sample_number=sample.number))
```

Empty-profiles gate (:324-329) becomes:

```python
        native_selected = any(
            isinstance(v, bool) and v and k in NATIVE_SERVICE_KEYS
            for k, v in (sample.services.model_extra or {}).items())
        if not profiles and not native_selected:
            errors.append(ValidationError(
                field="services",
                message="At least one analytical service must be selected",
                sample_number=sample.number))
```

`_map_services_to_profiles` is UNTOUCHED (native keys are extras; they never enter the profile list, so both SENAITE profile-attach chains and the BW add-on chain are untouched).

`order_processor.py:482-505` — wrap the per-peptide Identity block:

```python
                if "peptide_identity" in normalized.profiles:
                    ...existing lookup block, unchanged...
```

`webhook.py:551-557` debug log — replace the hand-enumerated 5-key dict with `"services": s.services.model_dump()` (now complete by construction, including future native keys).

`webhook.py` order-services-updated (:1176-1187) — after `model_validate`, run the same extras check against `KNOWN_SERVICE_KEYS`; violations raise the path's existing 400 Shape 3 naming the key. Update the :1165-1175 comment (it documents the silent drop this task removes).

- [ ] **Step 4: Run the full IS suite + lint.** `pytest -q` failure-set diff vs the Task-start baseline; `ruff check . && mypy app` net-zero-new vs Task-start counts.

- [ ] **Step 5: Commit**

```bash
git add app/models/order.py app/services/order_validator.py app/services/order_processor.py app/api/webhook.py tests/unit/test_native_service_keys.py tests/unit/test_order_services_updated.py tests/unit/test_order.py
git commit -m "feat(order-routing): declared service-key registry, recorded 422 on unknown keys, native-only orders"
```

---

### Task 7: WP — `profile_key` on wc_test_services + explicit wire keys in both JS paths (accumarklabs)

**Files (theme-relative):**
- Modify: `src/Admin/MyAccount/Sample_Submission.php` (save handler :598-619, repeater render :624-703)
- Modify: `js/create-order.js` (:1037-1058 services build; :1050 addon classification)
- Modify: `js/sample-submission.js` (:1185-1242 initial services build; the parallel selection sites its grep of `replace(/\s+/g` surfaces: :2667-2673, :3288-3289, :3764, :5499-5511, :7227-7240 — audit each)
- Test: none possible (no framework) — verification is `php -l`, manual wizard smoke on DevKinsta, and Task 8.

**Interfaces:**
- Consumes: `wc_test_services` option shape (`{name, price, tooltip, product_id, type, coming_soon_label}`), `wp_localize_script` feed (`testServices`, `Sample_Submission.php:454-461`), `build_services_with_variance` passthrough (keys untouched).
- Produces: each service entry gains optional `profile_key`; JS mints the wire key as `svc.profile_key || svc.name.toLowerCase().replace(/\s+/g, '')` — one shared helper per file; a `profile_key`-bearing addon is selectable and lands in `_sample_data['services']` under its explicit key. Legacy entries (empty `profile_key`) are byte-identical on the wire.

**Constraints:** the AccuShield bundle math, the endotoxin/sterility `currentAddons` binary, the `Variance_Tester` gate, and BOTH PHP product-map normalizers are all name-matched and stay untouched — new families don't join the bundle and don't have PHP special cases. The PHP product-map lookup (`Cart_Order.php:1407`) works for new families exactly as for old (both sides of that map derive from `name`, unaffected by `profile_key`).

- [ ] **Step 1: PHP — admin field.** In `handle_save_services` add to the entry array:

```php
					'profile_key' => sanitize_key($_POST['service_profile_key'][$i] ?? ''),
```

(`sanitize_key` lowercases and strips to `[a-z0-9_-]` — exactly the Mk1 profile-key alphabet.) In the render table add a "Profile Key" column between Type and Linked Product: text input named `service_profile_key[]`, value `esc_attr($svc['profile_key'] ?? '')`, description under the table: *"LIMS Analysis Profile key, sent verbatim as the order wire key. Leave empty for the five legacy services — their wire key derives from the name. Never change a key after the service has sold."*

- [ ] **Step 2: JS — one mint helper per file, used everywhere a wire key is minted.** Top of `create-order.js` and `sample-submission.js`:

```js
// Wire-key mint: an explicit LIMS profile_key wins; legacy entries fall back
// to the name-derived key (lowercase, whitespace stripped — keeps & and ()).
// The wire key is the _sample_data['services'] key integration-service
// validates against its declared set, so this is load-bearing: never mangle
// profile_key.
function serviceWireKey(svc) {
    return (svc && svc.profile_key) ? svc.profile_key
        : svc.name.toLowerCase().replace(/\s+/g, '');
}
```

Replace the mint at `create-order.js:1042` and `:1049` with `serviceWireKey(PRIMARY_TEST)` / `serviceWireKey(svc)`. Generalize the `:1050` binary WITHOUT touching endotoxin/sterility behavior:

```js
            var key = serviceWireKey(svc);
            var isSelected;
            if (key.indexOf('endotoxin') !== -1) {
                isSelected = !!currentAddons.endotoxin;
            } else if (svc.profile_key) {
                isSelected = !!currentAddons[key];       // catalog addons keyed by wire key
            } else {
                isSelected = !!currentAddons.sterility;  // legacy fallback binary
            }
            services[key] = isSelected;
```

Mirror the same treatment in `sample-submission.js` (`initialServices` build :1185-1242 and each selection-state site listed above): every `name.toLowerCase().replace(/\s+/g,'')` that produces a **wire/services key** goes through `serviceWireKey(...)`; occurrences that build *display/product lookups* are left alone. Audit all listed line sites plus a fresh grep — the closing check is `grep -n "replace(/\\\\s+/g" js/create-order.js js/sample-submission.js` and every hit is either converted or has a one-line comment saying why not.

Where addon checkbox/card state is initialized (the `currentAddons` object), extend it to carry a key per `profile_key`-bearing addon (default false) so the generic branch above reads real state — locate via the existing `currentAddons` declaration and mirror the endotoxin/sterility initialization.

- [ ] **Step 3: Lint + smoke.** `php -l` on `Sample_Submission.php` (via `docker exec devkinsta_fpm php -l /www/kinsta/public/accumarklabs/...` against the DevKinsta copy only if deployed there — otherwise any php8.1 on the worktree file). `node --check js/create-order.js js/sample-submission.js`. Manual: on the Task 8 stack (or DevKinsta after deploying the branch there), add a `profile_key='heavy_metals'` addon entry in wc-test-services, run the wizard, verify `_sample_data['services']` carries `heavy_metals: true` and the five legacy keys are byte-identical to a pre-change order.

- [ ] **Step 4: Commit (in the worktree, branch `feat/catalog-order-routing`)**

```bash
git add wp-content/themes/wpstar/src/Admin/MyAccount/Sample_Submission.php wp-content/themes/wpstar/js/create-order.js wp-content/themes/wpstar/js/sample-submission.js
git commit -m "feat(order-routing): explicit profile_key wire keys on wc_test_services, both order paths"
```

(If the theme's build pipeline minifies js — check `package.json` `build:js` inputs — run `npm run build:js` and commit the built artifacts only if the repo tracks them; the repo state is the authority.)

---

### Task 8: COABuilder — catalog-vs-baked-spec unit cross-check warning (COABuilder)

**Files:**
- Modify: the spec-fill site inside `attach_native_sections` (locate in the worktree: `grep -n "baked" src/` — spec-2 landed it; the fill point is where `specification`/`conforms` are populated from baked specs)
- Test: extend the spec-2 native-sections test file (grep `attach_native_sections` under `tests/`)

**Interfaces:**
- Consumes: spec-2's wire section rows (`unit` populated by Mk1), baked specs keyed `(SampleTypeTitle, Keyword)` carrying `unit`.
- Produces: when a baked spec's unit and the wire row's unit are both non-empty and differ → `log.warning("native_section_unit_divergence keyword=%s wire=%s baked=%s", ...)`; rendering proceeds (warn-and-continue — same ruling as spec-2 Task 3's blank-unit case). This makes the ENDO-LAL failure class (catalog `EU/mg` vs baked `EU/mL`) visible on sight instead of silently printing the catalog's word against the spec's.

- [ ] **Step 1: Failing caplog test** — a section row with `unit="ppm"` against a baked spec declaring `unit="mg"` renders successfully AND emits the warning; a matching-unit row emits nothing.
- [ ] **Step 2: Run to fail** (COABuilder gate invocation from Global Constraints).
- [ ] **Step 3: Implement** — three lines at the fill site.
- [ ] **Step 4: Full COABuilder suite, failure-set diff vs 5-failure baseline; `git checkout -- logs/coabuilder.log`.**
- [ ] **Step 5: Commit** `git add <spec-fill file> <test file> && git commit -m "feat(native-coa): warn on catalog-vs-baked-spec unit divergence"`

---

### Task 9: Stack rehearsal — the whole loop on a fresh devbox stack (all repos)

**Files:** none on laptops beyond a rehearsal log appended to the SDD ledger. Invoke the `accumark-stack-platform` skill at execution time.

**Interfaces:** consumes every prior task at branch heads; produces the recorded proof list below.

- [ ] **Step 1: Provision.** Fresh stack (e.g. `s3rehe`) mounting all four worktrees at the spec-3 branch heads. Known platform traps (all in memory/handoff): minio-init false-fail on create → manual `restore.sh` + state fix; IS needs `ACCUMK1_BASE_URL`/`ACCUMK1_INTERNAL_SERVICE_TOKEN`/`COA_BUILDER_URL` via `docker-compose.override.yml` (re-applied if `mount` reruns); WP reachable via SSH local-forward.
- [ ] **Step 2: Seed the catalog correctly this time.** Department "Heavy Metals" (exists from backfill); HM services created with that `department_id` (NOT `1`/Analytical — the s2e2e seed predates the department decision); profile `heavy_metals` (members, `vials_required=1`, `fulfillment_role='hm'`, `fulfillment_dim='role'`, `coa_*` fields per spec-2 showcase); wc-test-services entry with `profile_key=heavy_metals`, `type=addon`, linked to a draft product with a placeholder price.
- [ ] **Step 3: Prove, in order (each item recorded in the ledger with the verbatim evidence):**
  1. WP wizard order with HM addon → `_sample_data['services']` carries `heavy_metals: true`; legacy keys byte-identical.
  2. IS ingest 202; stored payload carries the key; SENAITE AR has NO extra profile.
  3. Unknown-key order (hand-POST `heavy_metalz`) → 422 naming the key, `order_submissions.status = 'validation_failed'`.
  4. Native-only hand-POST (`heavy_metals` alone) → 202, bare AR (empty Profiles), no peptide-identity lookup failure.
  5. Mk1 check-in: vial plan shows 1 `hm` vial (+ legacy demand for the combined order); `hm` vial seeded with exactly the profile members; appears in the `hm` inbox lane and no other; `in_variance_set = FALSE`.
  6. Bench → promote → COA renders the HM section (spec-2 pipeline unchanged on the stacked branch).
  7. `derive_base_demand` divergence drill: PATCH `endotoxin` profile `vials_required=5` via admin API → order still provisions 1 endo vial, `demand_divergence` in logs → PATCH back.
- [ ] **Step 4: Leave the stack up for Handler UAT (established pattern), record ports + creds in the ledger.**

---

## Deferred / follow-ups (recorded, not tasks)

- WP à-la-carte (primary-less) wizard slice + `is_addon`→`standalone`/`requires_base` re-semantics (Decision 5); post-order add-on upgrades for new families (`Addon_Upgrades.ADDON_TYPES` untouched this slice); `deploy.sh` in the theme repo contains a plaintext SSH password for the DEAD host — history-compromised, rotate/remove independently of spec 3 (surfaced to Handler); Mk1 `GET /analysis-profiles` still returns inactive rows (display-filtering is a UI choice, not made here); Moisture/pH profiles await G-V answers before any seeding.

## Handler / lab gates attached to the combined deploy window

Unchanged from the spec: **G-P** (pricing), **G-V** (Moisture/pH vial rulings; also ratify MAX-per-role sharing semantics), **G-PUB** (wc_test_services entry flip = point of no return, after IS+Mk1 are live), **G-ENDO** (ENDO-LAL catalog unit before any profile containing it is sold). Plus spec-2's G-A/G-B/G-C/G-D. Runbook additions (for the `accumark-deploy` skill): IS-before-WP ordering with the unknown-key 422 as the tripwire; seed-catalog-LAST; the demand-fields backfill rides the Mk1 deploy (idempotent, but verify the five profiles' `vials_required` post-deploy); `NATIVE_SERVICE_KEYS` extension is a per-family IS deploy.
