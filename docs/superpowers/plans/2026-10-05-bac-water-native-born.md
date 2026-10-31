# Bac Water Native-Born Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new Bacteriostatic Water order is minted, benched, promoted and COA'd in Accu-Mk1 with no SENAITE AR. After a T0 evidence gate, IS also stops minting SENAITE ARs for any sample whose services are all native.

**Architecture:** This copies the HPLC native-born program.
- New `origin='mk1'` BW services and an inactive profile `bacteriostatic-water-panel` (archetype `legacy_bw`), seeded at boot.
- A `BW` customer-id counter at 1000.
- A key alias set, so demand and seeding treat the new key as the BW primary.
- The hplc-role vial seeds the panel (bench on the vial, promote to parent, the same as every native family).
- A Mk1 COA shim re-keys native rows to the legacy SENAITE keywords for COABuilder's `GenericAssayEngine`, which learns to honour Mk1 wire specs.
- IS routes the native BW key to mk1 with the exact `"Bacteriostatic Water"` sample type.
- The switch is a WP data change: `profile_key` on the "Bac Water Panel" row.

**Tech Stack:**
- Accu-Mk1: FastAPI / SQLAlchemy / Postgres, React 19 + vitest, npm only.
- integration-service: FastAPI, pydantic, pytest, ruff, mypy.
- coabuilder: Python, pytest.

**Spec:** `Accu-Mk1/docs/superpowers/specs/2026-10-05-bac-water-native-born-design.md` (Handler-approved 2026-10-05 with defaults R1-R6; corrections below).

## Global Constraints

- **Profile / WP key** `bacteriostatic-water-panel`.
- **Native keywords** `PH-BW`, `BENZYL-ALCOHOL-BW`, `FILL-VOLUME-BW`. These map on the COA wire to `PH-DETERM`, `Benzyl_Alcohol_Assay`, `FILL-NET-CONTENT`.
- **Customer ids** `BW-NNNN`, counter seeded at 1000 (guarded, never reset).
- **Titles and units mirror prod exactly:** "pH Determination" / `pH`, "Benzyl Alcohol Assay (HPLC)" / `% (v/v)`, "Fill volume / Net content" / `mL`.
- **Specs mirror LIVE coabuilder** (`baked_specs.py:39-49`, BA ±20% signed off 2026-07-17):
  - pH range 4.5-7.0, display "4.5 – 7.0"
  - BA range 0.72-1.08, display "0.9% (v/v) ±20%"
  - fill volume informational with display override U+2014 (the glyph legacy BW prints in the Specification cell for FILL-NET-CONTENT, which has no baked spec; the status pill reads MEASURED on both). Corrected in the final review 2026-10-05; the earlier "prints Measured" text described the pill, not the cell
  - Mk1's vendored `conformance_vendored/baked_specs.py` (0.81-0.99) is STALE and is not a source.
- **Native BW `SampleTypeTitle` is exactly `"Bacteriostatic Water"`.** The endotoxin 0-0.25 EU/mL matrix tier, the customer prefix and the COA engine all key on it.
- **Profile stays INACTIVE at flip** (same as prod `hplc-purity-identity`). IS learns the key via the catalog sync, which ships every key regardless of `active` (`main.py:25421`).
- **Additive only:**
  - SENAITE-born BW and peptide paths are byte-identical.
  - A failing pre-existing test is stale until proven otherwise. The stale tests updated here are listed per task and need Handler sign-off in the PR.
- **BW variance is out of scope.** Nothing sells or renders it.
- **Never flip `origin` on existing rows.**
- **No em dashes** in code, comments, docs or commit messages.
- **Mk1:**
  - Backend pytest hits the host dev Postgres: ONE suite at a time.
  - Gate on the failure-set diff against master, never on zero failures.
  - Use `git -c core.autocrlf=true` for diffs.
  - Commits pathspec-limited.
- **IS:** `ruff check . && mypy app` before each commit.
- **Ship units:**
  - Mk1 M1-M5 + W1-W5 in ONE PR. Never deploy a state between M2 and M5: the hplc fork would misroute a native BW vial into the peptide trio.
  - coabuilder C1-C3 is one PR. IS I1-I3 is one PR. IS I4 (Part B) is its own PR, merged only after T0 passes.
- **Deploy order:** Mk1 → coabuilder → IS → WP flip, after lab hours.

## Corrections to the spec, found while planning (all verified; the plan follows these)

1. **The panel is vial-tier, not parent-tier.**
   - Parent-tier rows cannot `submit` (`lims_analyses/state_machine.py:167-175`), and the COA certifies only promoted `canonical` rows (`coa/native_sections.py:169-172`).
   - So M5 seeds the BW panel on the hplc vial, the same as heavy metals and the native endo/PCR already on BW orders. Parent placeholders still mint at registration.
   - **Lab-facing change:** BW results are entered on S01 and promoted, instead of on the parent row.
2. **BA unit / range.** It is `% (v/v)` at 0.72-1.08, not mg/mL at 0.81-0.99 (see Global Constraints).
3. **SLA:** `sla_tier_id=None`.
   - Inactive profiles are ignored by every SLA resolver (`src/lib/sla-resolution.ts:152`, `backend/main.py:11021`), and the legacy `bac_water_panel` has no tier.
   - So native BW resolves exactly as legacy BW does.
4. **MB6 (BA peptide binding) is dropped.** Nothing reads the binding to route a result (`prep_bridge._category` classifies neither keyword). BA is entered by hand for legacy and native alike.
5. **The slot gate skips BW** (`is_bw_sample`) rather than allowing only Peptide/Blend. Native retest rows with no title rely on slot resolution (`tests/test_apply_retest_spec.py:84-90`).
6. **IB2 fill volume.** `DeclaredTotalQuantity` is already formatted `.2f` on both paths, so there is no change. IB4 (transfers) is verify-only (`tests/unit/test_transfer_native_409.py`).
7. **IB3.** A BW retest routes to mk1 only when the legacy `bac_water_panel` field is absent. Legacy BW orders already carry `endotoxin-usp85-lal`, so a straight port of `native_retest` would reject legacy BW retests.
8. **The native IS key is NOT in the `NATIVE_SERVICE_KEYS` floor** (same as `hplc-purity-identity`). An unsynced key fails closed, so F1 confirms the sync before the flip.
9. **Pre-flip facts checked on prod 2026-10-05:**
   - `coa_generation_source == "mk1"`, which native COAs require.
   - The active BW endotoxin tier is 0-0.25 EU/mL.
   - Legacy service titles and units are as listed in Global Constraints.
10. **The chromatogram + sample-image COA gate applies to native BW exactly as to SENAITE-born BW today.** The lab attaches the BA chromatogram on the parent; there is no code change. The rehearsal (R1) exercises it.

## Review Focus

1. **A WP order sending BOTH `bac_water_panel` and `bacteriostatic-water-panel`** (stale cart, admin edit). Expected: IS rejects it loudly. Test owned by I1.
2. **A native BW sample whose IS meta title is anything but `"Bacteriostatic Water"`.** Expected: Mk1 registration raises (no prefix) instead of minting a peptide-shaped sample, and the endotoxin never silently prints the ≤5 limit. Tests owned by I3 (exact title) and M4 (refuse unknown type).
3. **A SENAITE-born BW sample created while the valve is off but carrying the native key.** Expected: demand still counts 1 hplc vial, and no native placeholders are minted. Tests owned by M2 (`BW_PRIMARY_KEYS` covers both keys) and M4.
4. **An out-of-range native result (pH 8.0).** Expected: "Does Not Conform" on page 1 and the badge FAILED, never PASSED. Tests owned by W4 (`conforms=False` on the wire) and C1 (wire `conforms=False` flips the rollup).
5. **A pending (unverified) native BW row at COA time.** Expected: the COA is blocked by the existing resolver pre-flight exactly as for SENAITE-born BW, never printed as blank. Covered by the existing pre-flight; W4 includes a pending-row case asserting `conforms is None` and `Result is None`.

---


# Part 1: Accu-Mk1, catalog, intake, check-in (Tasks M1-M5)

# Section: Accu-Mk1, catalog + intake + check-in (MB1, MB2, MB3, MB4, MB6, MB7)

Read at `origin/master` = `e5852180` (release v1.31.2). All line numbers below are from that commit. Quoted "current" lines that contain an em dash at origin/master are shown with `--` in its place (house rule: no em dashes in plans); match the engineer's Edit on the rest of the line.

## Files map

**Create:**
- `backend/catalog/bw_keys.py`: BW primary key set (`bac_water_panel` + `bacteriostatic-water-panel`), selected/count helpers, `BW_NATIVE_KEYWORDS`, the native-to-legacy keyword map, `is_bw_sample`. Zero imports, so seeder, throughput and the COA shim can all import it without cycles.
- `backend/coa/bw_shim.py` (minimal; the COA section extends it): `LEGACY_BW_ARCHETYPE = "legacy_bw"`, plus re-exports of `BW_NATIVE_KEYWORDS` and `NATIVE_TO_LEGACY_KEYWORD` from `catalog.bw_keys`.
- `backend/catalog/bw_native_seed.py`: idempotent boot seed. Creates services `PH-BW` / `BENZYL-ALCOHOL-BW` / `FILL-VOLUME-BW`, the INACTIVE profile `bacteriostatic-water-panel`, and wildcard specs.

**Modify:**
- `backend/database.py`:
  - `init_db` gets the seed call after the HPLC upgrade, and the counter headroom check after demand verify.
  - `_run_migrations` gets the guarded `BW` counter insert at 1000.
- `backend/sub_samples/service.py`: `derive_variance_demand` and `derive_base_demand` read `BW_PRIMARY_KEYS`.
- `backend/lims_analyses/seeder.py`:
  - `ROLE_TO_WP_KEYS["hplc"]` includes the BW key set.
  - `_PARENT_BENCH_ONLY_KEYWORDS` adds the native trio.
  - The hplc-role fork seeds the native BW panel on the vial.
- `backend/throughput.py`: `BACW_KEYWORDS` adds the native trio.
- `src/lib/product-completion.ts`: `HPLC_PACKAGE_KEYS` adds `bacteriostatic-water-panel`.
- `backend/sub_samples/native_id.py`:
  - `CUSTOMER_PREFIXES` gains `BW`, and the stale comment is rewritten.
  - New `customer_id_headroom_violations`.
- `backend/lims_analyses/parent_placeholders.py`: a native-born BW parent skips slot resolution and the unresolved-slot flag.

**Tests:**
- Create `backend/tests/test_bw_native_catalog_seed.py`: seed contract, key constants, `init_db` order, legacy trio/profile pin.
- Create `backend/tests/test_bw_native_alias.py`: demand/seeder/throughput/product parity for the native key, legacy pins.
- Create `backend/tests/test_bw_native_intake.py`: BW placeholders without slots or flags, counter headroom check.
- Create `backend/tests/test_bw_native_seeder.py`: native BW vial seeds the panel; SENAITE-born BW and native peptide paths unchanged.
- Modify `backend/tests/test_hplc_native_schema.py`: stale counter pin (2 statements become 3).
- Modify `backend/tests/test_native_id.py`: stale prefix pins, plus BW mint and skip-forward.
- Modify `src/test/product-completion.test.ts`: native BW key completes like the legacy key.

## Task ID mapping

Mapping to the brief's suggested breakdown:
- M1 = MB1 catalog seed + counter + key constants.
- M2 = MB2 backend alias.
- M3 = MB2 frontend alias (split out: own test runner, own reviewer).
- M4 = MB3 intake: BW customer prefix, counter headroom check, slot gate.
- M5 = MB4 check-in: native BW vial seeds the panel. **This deviates from the spec and the brief. See Notes item 1.**
- MB6 (Benzyl Alcohol binding): **no task**. Evidence says the binding is never read for routing. See Notes item 4.
- MB7 (frontend grep): **no task**. Findings are in Notes item 9.

## Global constraints (apply to every task)

- **Worktree:** work in a fresh one off `origin/master` (for example `C:\tmp\Accu-Mk1-bw-native`, branch `feat/bw-native-intake`). Never use the workspace checkout.
- **Running pytest:** bare `python` can hang here. If it does, run pytest through the backend venv: `backend/.venv/Scripts/python -m pytest`.
- **Live dev Postgres:**
  - Backend tests hit the live dev Postgres. Run ONE pytest process at a time.
  - Gate on the failure-set diff against master, never on zero failures.
  - `test_lims_analyses_seeder.py` is a live-DB suite and skips if no sub-sample exists.
- **Commits:** pathspec only, `git commit -m ... -- <paths>`.
- **Line endings:** the Accu-Mk1 checkout has `core.autocrlf=false`. Diff CRLF files with `git -c core.autocrlf=true diff`.
- **`test_identity_convergence_guard.py`:**
  - It sweeps `lims_analyses/seeder.py`, `lims_analyses/hplc_native.py`, `lims_analyses/service.py` and `main.py` for `.keyword` comparisons.
  - No task below adds one. Profile lookup is by `AnalysisProfile.key`, and the sample test is on `sample_type_title`.
  - Keep it that way, or the guard fails.
- **Legacy BW must stay byte-identical.** That means `bac_water_panel`, the SENAITE trio `PH-DETERM` / `Benzyl_Alcohol_Assay` / `FILL-NET-CONTENT`, and the profile `bac_water_panel`. Every task that touches a shared path carries a legacy pin.

---

### Task M1: BW key constants, native catalog seed, BW counter

**Repo:** Accu-Mk1
**Files:**
- Create: `backend/catalog/bw_keys.py`
- Create: `backend/coa/bw_shim.py`
- Create: `backend/catalog/bw_native_seed.py`
- Modify: `backend/database.py:183-190`. This is the end of the HPLC upgrade try-block in `init_db`; insert the BW seed after it, before the `seed_service_specs` try at `:191`.
- Modify: `backend/database.py:2492-2496`. Insert the BW counter after the `'PB', 1000` insert.
- Test: `backend/tests/test_bw_native_catalog_seed.py` (create)
- Test: `backend/tests/test_hplc_native_schema.py:291-296` (stale pin: `len(seed) == 2` becomes 3)

**Interfaces:**
- Consumes: `catalog.change_log.log_create` / `log_members`, `catalog.departments.department_id_by_name`, `catalog.service_spec_audit.record_spec_change` (all exist at origin/master, used by `hplc_native_seed.py:105-107`).
- Produces:
  - **`catalog.bw_keys`:**
    - `LEGACY_BW_KEY = "bac_water_panel"`
    - `NATIVE_BW_KEY = "bacteriostatic-water-panel"`
    - `BW_PRIMARY_KEYS: frozenset[str]`
    - `bw_primary_selected(services: dict | None) -> bool`
    - `bw_primary_count(entitlement: dict | None) -> int`
    - `BW_SAMPLE_TYPE_TITLE = "Bacteriostatic Water"`
    - `is_bw_sample(sample) -> bool`
    - `NATIVE_TO_LEGACY_KEYWORD: dict[str, str]` = `{"PH-BW": "PH-DETERM", "BENZYL-ALCOHOL-BW": "Benzyl_Alcohol_Assay", "FILL-VOLUME-BW": "FILL-NET-CONTENT"}`
    - `BW_NATIVE_KEYWORDS: frozenset[str]` (its keys)
  - **`coa.bw_shim`:** `LEGACY_BW_ARCHETYPE = "legacy_bw"`, plus re-exported `BW_NATIVE_KEYWORDS` and `NATIVE_TO_LEGACY_KEYWORD`.
  - **`catalog.bw_native_seed`:**
    - `BW_NATIVE_PROFILE_KEY` (= `NATIVE_BW_KEY`)
    - `BW_NATIVE_PROFILE_NAME = "Bac Water Panel"`
    - `BW_NATIVE_SERVICES` (keyword, title, unit, result_type, variance_capable)
    - `BW_NATIVE_SPECS`
    - `seed_bw_native_catalog(db) -> {"services","profile","members","specs"}`
  - **Counter:** boot statement `INSERT ... SELECT 'BW', 1000 WHERE NOT EXISTS (...)`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_bw_native_catalog_seed.py
"""Boot seed for the native Bac Water family (spec 2026-10-05, MB1): three
origin=mk1 Analytical services, ONE inactive profile
`bacteriostatic-water-panel` (role hplc, 1 vial, archetype legacy_bw, no SLA
tier), wildcard specs, and the guarded BW-1000 counter. Idempotent; admin
edits survive; the legacy SENAITE trio and `bac_water_panel` are untouched."""
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import Base

KEYWORDS = ("PH-BW", "BENZYL-ALCOHOL-BW", "FILL-VOLUME-BW")


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _dept(db):
    from models import Department
    d = Department(name="Analytical")
    db.add(d)
    db.commit()
    return d


def test_keys_module_contract():
    from catalog.bw_keys import (BW_NATIVE_KEYWORDS, BW_PRIMARY_KEYS, LEGACY_BW_KEY,
                                 NATIVE_BW_KEY, NATIVE_TO_LEGACY_KEYWORD, bw_primary_count,
                                 bw_primary_selected, is_bw_sample)
    from models import LimsSample
    assert LEGACY_BW_KEY == "bac_water_panel" and NATIVE_BW_KEY == "bacteriostatic-water-panel"
    assert BW_PRIMARY_KEYS == frozenset({"bac_water_panel", "bacteriostatic-water-panel"})
    assert NATIVE_TO_LEGACY_KEYWORD == {"PH-BW": "PH-DETERM",
                                        "BENZYL-ALCOHOL-BW": "Benzyl_Alcohol_Assay",
                                        "FILL-VOLUME-BW": "FILL-NET-CONTENT"}
    assert BW_NATIVE_KEYWORDS == frozenset(KEYWORDS)
    assert bw_primary_selected({"bacteriostatic-water-panel": True}) is True
    assert bw_primary_selected({"bac_water_panel": True}) is True
    assert bw_primary_selected({"hplcpurity_identity": True}) is False
    assert bw_primary_count({"bacteriostatic-water-panel": 3}) == 3
    assert is_bw_sample(LimsSample(sample_type_title="Bacteriostatic Water")) is True
    assert is_bw_sample(LimsSample(sample_type_title=" bacteriostatic water ")) is True
    assert is_bw_sample(LimsSample(sample_type_title="Peptide")) is False
    assert is_bw_sample(LimsSample(sample_type_title=None)) is False


def test_shim_reexports_one_source_of_truth():
    from catalog import bw_keys
    from coa import bw_shim
    assert bw_shim.LEGACY_BW_ARCHETYPE == "legacy_bw"
    assert bw_shim.BW_NATIVE_KEYWORDS is bw_keys.BW_NATIVE_KEYWORDS
    assert bw_shim.NATIVE_TO_LEGACY_KEYWORD is bw_keys.NATIVE_TO_LEGACY_KEYWORD


def test_seed_creates_three_mk1_services_in_analytical(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisService
    dept = _dept(db_session)
    report = seed_bw_native_catalog(db_session)
    assert report["services"] == 3
    rows = {s.keyword: s for s in db_session.query(AnalysisService).all()}
    assert set(rows) == set(KEYWORDS)
    for kw in KEYWORDS:
        assert rows[kw].origin == "mk1"
        assert rows[kw].department_id == dept.id
        assert rows[kw].result_type == "numeric"
        # NOT "HPLC": throughput.classify_keyword checks category BEFORE
        # BACW_KEYWORDS, so an HPLC category would file BA under hplc.
        assert rows[kw].category == "Bacteriostatic Water"
    assert (rows["PH-BW"].unit, rows["PH-BW"].variance_capable) == ("pH", True)
    assert (rows["BENZYL-ALCOHOL-BW"].unit, rows["BENZYL-ALCOHOL-BW"].variance_capable) == ("% (v/v)", True)
    # Titles and units mirror the prod SENAITE rows exactly (verified 2026-10-05).
    assert [rows[k].title for k in KEYWORDS] == [
        "pH Determination", "Benzyl Alcohol Assay (HPLC)", "Fill volume / Net content"]
    assert (rows["FILL-VOLUME-BW"].unit, rows["FILL-VOLUME-BW"].variance_capable) == ("mL", False)


def test_seed_creates_inactive_profile_with_ordered_members_and_no_sla_tier(db_session):
    from catalog.bw_native_seed import BW_NATIVE_PROFILE_KEY, seed_bw_native_catalog
    from models import AnalysisProfile
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key=BW_NATIVE_PROFILE_KEY).one()
    assert BW_NATIVE_PROFILE_KEY == "bacteriostatic-water-panel"
    assert (prof.name, prof.is_addon, prof.vials_required, prof.fulfillment_role,
            prof.fulfillment_dim, prof.coa_archetype, prof.active, prof.sla_tier_id) == (
        "Bac Water Panel", False, 1, "hplc", "role", "legacy_bw", False, None)
    assert [s.keyword for s in prof.analysis_services] == list(KEYWORDS)


def test_seed_writes_wildcard_specs(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisService, AnalysisServiceSpec
    _dept(db_session)
    assert seed_bw_native_catalog(db_session)["specs"] == 3

    def spec(kw):
        svc = db_session.query(AnalysisService).filter_by(keyword=kw).one()
        return (db_session.query(AnalysisServiceSpec)
                .filter(AnalysisServiceSpec.analysis_service_id == svc.id,
                        AnalysisServiceSpec.matrix.is_(None),
                        AnalysisServiceSpec.peptide_id.is_(None)).one())

    ph, ba, fill = spec("PH-BW"), spec("BENZYL-ALCOHOL-BW"), spec("FILL-VOLUME-BW")
    assert (ph.rule_kind, ph.min_value, ph.max_value, ph.display_override) == (
        "range", Decimal("4.5"), Decimal("7.0"), "4.5 – 7.0")
    assert (ba.rule_kind, ba.min_value, ba.max_value, ba.unit, ba.display_override) == (
        "range", Decimal("0.72"), Decimal("1.08"), "% (v/v)", "0.9% (v/v) ±20%")
    assert (fill.rule_kind, fill.unit, fill.display_override) == ("informational", "mL", None)


def test_seed_is_idempotent_and_keeps_admin_edits(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisProfile, AnalysisService, CatalogChangeLog
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key="bacteriostatic-water-panel").one()
    prof.vials_required = 2
    svc = db_session.query(AnalysisService).filter_by(keyword="PH-BW").one()
    svc.title = "pH (edited)"
    db_session.commit()
    before = db_session.query(CatalogChangeLog).count()
    assert seed_bw_native_catalog(db_session) == {"services": 0, "profile": 0, "members": 0, "specs": 0}
    assert db_session.query(AnalysisService).count() == 3
    assert prof.vials_required == 2 and svc.title == "pH (edited)" and prof.active is False
    assert db_session.query(CatalogChangeLog).count() == before


def test_change_log_rows_written(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import CatalogChangeLog
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    actions = [(r.entity_type, r.action) for r in db_session.query(CatalogChangeLog).all()]
    assert actions.count(("service", "create")) == 3
    assert actions.count(("profile", "create")) == 1
    assert actions.count(("profile_members", "update")) == 1


def test_seed_refuses_without_analytical_department(db_session, caplog):
    """Unlike HPLC-%, nothing rescues PH-BW / BENZYL-ALCOHOL-BW / FILL-VOLUME-BW
    into a department later (catalog/departments.py
    _UNGROUPED_ANALYTICAL_LIKE_PATTERNS has no BW pattern), and a NULL
    department hid every BW card from the worksheet inbox on 09-01. So: seed
    nothing, ERROR, retry next boot (backfill_departments seeds the
    department before this seed in init_db)."""
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisService
    with caplog.at_level("ERROR"):
        report = seed_bw_native_catalog(db_session)
    assert report == {"services": 0, "profile": 0, "members": 0, "specs": 0}
    assert db_session.query(AnalysisService).count() == 0
    assert any("bw_native_seed.no_analytical_department" in r.message for r in caplog.records)


def test_keyword_collision_skips_service_and_aborts_profile(db_session, caplog):
    from catalog.bw_native_seed import BW_NATIVE_PROFILE_KEY, seed_bw_native_catalog
    from models import AnalysisProfile, AnalysisService
    _dept(db_session)
    db_session.add(AnalysisService(title="pH (SENAITE)", keyword="PH-BW", origin="senaite"))
    db_session.commit()
    with caplog.at_level("ERROR"):
        report = seed_bw_native_catalog(db_session)
    assert db_session.query(AnalysisService).filter_by(keyword="PH-BW", origin="mk1").all() == []
    assert report["profile"] == 0 and report["services"] == 2
    assert db_session.query(AnalysisProfile).filter_by(key=BW_NATIVE_PROFILE_KEY).one_or_none() is None
    assert any("bw_native_seed.keyword_collision" in r.message for r in caplog.records)
    assert any("bw_native_seed.profile_creation_aborted" in r.message for r in caplog.records)


def test_legacy_senaite_trio_and_legacy_profile_untouched(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from catalog.profile_seed import seed_profiles_from_registry
    from models import AnalysisProfile, AnalysisService
    _dept(db_session)
    for kw in ("PH-DETERM", "Benzyl_Alcohol_Assay", "FILL-NET-CONTENT"):
        db_session.add(AnalysisService(title=kw, keyword=kw, origin="senaite",
                                       variance_capable=True))
    db_session.commit()
    seed_profiles_from_registry(db_session)
    legacy = db_session.query(AnalysisProfile).filter_by(key="bac_water_panel").one()
    snap = (legacy.name, legacy.active, legacy.vials_required, legacy.fulfillment_role,
            legacy.coa_archetype, legacy.sla_tier_id, list(legacy.analysis_services))
    seed_bw_native_catalog(db_session)
    db_session.refresh(legacy)
    assert (legacy.name, legacy.active, legacy.vials_required, legacy.fulfillment_role,
            legacy.coa_archetype, legacy.sla_tier_id, list(legacy.analysis_services)) == snap
    senaite = db_session.query(AnalysisService).filter_by(origin="senaite").all()
    assert sorted(s.keyword for s in senaite) == ["Benzyl_Alcohol_Assay", "FILL-NET-CONTENT", "PH-DETERM"]
    assert all(s.department_id is None and s.variance_capable for s in senaite)


def test_keywords_pass_native_keyword_rules(db_session):
    from main import validate_new_keyword
    for kw in KEYWORDS:
        validate_new_keyword(db_session, kw)


def test_profile_key_not_in_product_registry():
    from sub_samples.product_registry import PRODUCT_REGISTRY
    assert "bacteriostatic-water-panel" not in PRODUCT_REGISTRY


def test_inactive_profile_hidden_from_manage_analyses_picker(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from lims_analyses.manage_native import native_profiles_for_parent
    from models import LimsSample
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    parent = LimsSample(sample_id="TEST-BW-PICKER-1", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    assert "bacteriostatic-water-panel" not in {
        p["key"] for p in native_profiles_for_parent(db_session, parent=parent)}


def test_verify_demand_catalog_no_violation_for_seeded_profile(db_session, caplog):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from catalog.demand_verify import LEGACY_DEMAND_KEYS, verify_demand_catalog
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    with caplog.at_level("ERROR"):
        violations = verify_demand_catalog(db_session)
    assert not any("bacteriostatic-water-panel" in v for v in violations)
    assert "bacteriostatic-water-panel" not in LEGACY_DEMAND_KEYS


def test_init_db_calls_bw_seed_after_hplc_and_before_specs(monkeypatch):
    import database
    calls = []

    def _rec(name):
        def _f(*a, **k):
            calls.append(name)
        return _f

    class _FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def commit(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(database, "_run_migrations", _rec("migrations"))
    monkeypatch.setattr(database.Base.metadata, "create_all", _rec("create_all"))
    monkeypatch.setattr(database, "_seed_federal_holidays_window", _rec("holidays"))
    monkeypatch.setattr(database, "SessionLocal", lambda: _FakeSession())

    import catalog.bw_native_seed as bn
    import catalog.demand_verify as dv
    import catalog.departments as dep
    import catalog.hplc_native_seed as hn
    import catalog.per_substance_reconciler as psr
    import catalog.profile_seed as ps
    import catalog.service_spec_seed as ss
    import catalog.vial_roles_seed as vr
    import workflow.seeds as wfs

    monkeypatch.setattr(psr, "reconcile_per_substance_services", _rec("reconcile_per_substance"))
    monkeypatch.setattr(wfs, "seed_workflow_catalog", _rec("workflow_catalog"))
    monkeypatch.setattr(dep, "backfill_departments", _rec("backfill_departments"))
    monkeypatch.setattr(ps, "seed_profiles_from_registry", _rec("profiles_from_registry"))
    monkeypatch.setattr(vr, "seed_vial_roles", _rec("vial_roles"))
    monkeypatch.setattr(hn, "seed_hplc_native_catalog", _rec("hplc_native"))
    monkeypatch.setattr(hn, "upgrade_hplc_native_catalog", _rec("hplc_upgrade"))
    monkeypatch.setattr(bn, "seed_bw_native_catalog", _rec("bw_native"))
    monkeypatch.setattr(ss, "seed_service_specs", _rec("service_specs"))
    monkeypatch.setattr(dv, "verify_demand_catalog", _rec("demand_verify"))

    database.init_db()

    assert (calls.index("backfill_departments") < calls.index("hplc_upgrade")
            < calls.index("bw_native") < calls.index("service_specs"))
```

Append to `backend/tests/test_hplc_native_schema.py`, replacing the stale pin at `:291-296`. The old pin's `len(seed) == 2` breaks by design: a third counter is added. Today's text is:

```python
def test_boot_migration_seeds_customer_counters():
    stmts = _captured()
    seed = [s for s in stmts if "lims_native_id_sequences" in s and "NOT EXISTS" in s]
    assert len(seed) == 2, [s[:80] for s in seed]
    assert any("'P', 5000" in s for s in seed)
    assert any("'PB', 1000" in s for s in seed)
```

New text:

```python
def test_boot_migration_seeds_customer_counters():
    stmts = _captured()
    seed = [s for s in stmts if "lims_native_id_sequences" in s and "NOT EXISTS" in s]
    # Bac Water native-born (spec 2026-10-05, R3) adds the guarded BW-1000 row.
    assert len(seed) == 3, [s[:80] for s in seed]
    assert any("'P', 5000" in s for s in seed)
    assert any("'PB', 1000" in s for s in seed)
    assert any("'BW', 1000" in s and "prefix = 'BW'" in s for s in seed)
```

- [ ] **Step 2: Run it, expect FAIL**
Run: `cd backend && python -m pytest tests/test_bw_native_catalog_seed.py tests/test_hplc_native_schema.py::test_boot_migration_seeds_customer_counters -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'catalog.bw_keys'` (and `catalog.bw_native_seed`), and `assert 2 == 3` on the counter pin.

- [ ] **Step 3: Implement**

```python
# backend/catalog/bw_keys.py
"""The Bac Water primary's order key(s), native keywords, and sample-type test.

`bac_water_panel` is the legacy WordPress wire key (SENAITE-routed by the
Integration Service). `bacteriostatic-water-panel` is the native profile key
(spec 2026-10-05, R1) that WordPress emits once `profile_key` is set on the
"Bac Water Panel" test-service row. Both mean "the customer bought the Bac
Water panel"; every place that keys demand, chips, or seeding on the BW
primary reads THIS set, never the literal. Mirrors catalog/hplc_keys.py.

Deliberately import-free: seeder, throughput (a pure, DB-free module) and
coa/bw_shim all import from here, so it must never pull in models or coa.
"""
LEGACY_BW_KEY = "bac_water_panel"
NATIVE_BW_KEY = "bacteriostatic-water-panel"
BW_PRIMARY_KEYS: frozenset[str] = frozenset({LEGACY_BW_KEY, NATIVE_BW_KEY})

# lims_samples.sample_type_title of a Bac Water sample. Load-bearing: the
# endotoxin matrix tier and COABuilder's GenericAssayEngine key on it.
BW_SAMPLE_TYPE_TITLE = "Bacteriostatic Water"

# Native (origin=mk1) panel keyword -> the SENAITE keyword COABuilder's
# GenericAssayEngine and baked_specs read (spec R2). coa/bw_shim re-exports.
NATIVE_TO_LEGACY_KEYWORD: dict[str, str] = {
    "PH-BW": "PH-DETERM",
    "BENZYL-ALCOHOL-BW": "Benzyl_Alcohol_Assay",
    "FILL-VOLUME-BW": "FILL-NET-CONTENT",
}
BW_NATIVE_KEYWORDS: frozenset[str] = frozenset(NATIVE_TO_LEGACY_KEYWORD)


def bw_primary_selected(services: dict | None) -> bool:
    """True when any BW primary key is truthy in an order's services dict."""
    services = services or {}
    return any(bool(services.get(k)) for k in BW_PRIMARY_KEYS)


def bw_primary_count(entitlement: dict | None) -> int:
    """Max entitlement across the BW primary keys (variance replicate count).

    Precondition: values are ints, as produced by normalize_variance_entitlement.
    """
    entitlement = entitlement or {}
    return max((int(entitlement.get(k, 0) or 0) for k in BW_PRIMARY_KEYS), default=0)


def is_bw_sample(sample) -> bool:
    """True when the sample's type title is Bacteriostatic Water."""
    title = (getattr(sample, "sample_type_title", None) or "").strip().lower()
    return title == BW_SAMPLE_TYPE_TITLE.lower()
```

```python
# backend/coa/bw_shim.py
"""COA wire vocabulary for NATIVE-BORN Bac Water rows (spec 2026-10-05 MB5).

Created minimal by the intake section (task M1) because the catalog seed
needs LEGACY_BW_ARCHETYPE before the COA section lands. The COA section
extends THIS file (is_native_bw_row, wire mapping); the keyword constants
live in catalog/bw_keys.py and are only re-exported here, never redefined.
"""
from catalog.bw_keys import BW_NATIVE_KEYWORDS, NATIVE_TO_LEGACY_KEYWORD  # noqa: F401

# The ONLY coa_archetype value that routes native BW rows onto page 1 via
# this shim. Imported by catalog/bw_native_seed.py.
LEGACY_BW_ARCHETYPE = "legacy_bw"
```

```python
# backend/catalog/bw_native_seed.py
"""Boot seed for the native Bac Water family (spec 2026-10-05, MB1).

Three origin=mk1 Analytical services (PH-BW / BENZYL-ALCOHOL-BW /
FILL-VOLUME-BW) and ONE profile `bacteriostatic-water-panel` mirroring the
legacy `bac_water_panel` demand (role hplc, 1 vial), plus wildcard specs.
Same idempotency, collision-abort and change-log rules as
catalog/hplc_native_seed.py (read its docstring; not repeated here):
  * a service is keyed on (keyword, origin='mk1'); present => untouched;
  * the profile is keyed on key; present => untouched, members only on
    first creation;
  * spec rows use the wildcard slot and skip when any row occupies it;
  * a same-keyword row of another origin skips that service and aborts the
    profile (three members or none).

Seeded INACTIVE and it STAYS inactive at flip (spec MB1, like prod
hplc-purity-identity). catalog_demand still fulfils an inactive profile for a
paid order, IS still learns the key (/s2s/catalog/service-keys ships every
profile key), and the Manage Analyses picker hides it.

sla_tier_id is deliberately NOT set (None). Evidence, origin/master e5852180:
the legacy bac_water_panel profile carries no tier, and both SLA resolvers
skip INACTIVE profiles anyway (src/lib/sla-resolution.ts
buildServiceToProfileTierMap `if (!p.active) continue`; main.py:11021
`AnalysisProfile.active.is_(True)` for sla_perf / ready-to-publish). Native
and legacy BW therefore resolve the same tier: group tier, else default.

Departments: unlike HPLC-%, nothing rescues these keywords into a department
on a later boot (catalog/departments.py _UNGROUPED_ANALYTICAL_LIKE_PATTERNS),
and a NULL department hid BW from the worksheet inbox on 09-01. With no
Analytical department the seed creates NOTHING and logs ERROR; init_db runs
backfill_departments (which seeds departments) first, so prod never hits it.

NOT added to sub_samples.product_registry.PRODUCT_REGISTRY: that map is the
legacy profile set pinned by test_profile_parity.py.
"""
import logging
from decimal import Decimal

from sqlalchemy.orm import Session

from catalog.bw_keys import NATIVE_BW_KEY

log = logging.getLogger(__name__)

BW_NATIVE_PROFILE_KEY = NATIVE_BW_KEY
BW_NATIVE_PROFILE_NAME = "Bac Water Panel"
_CATEGORY = "Bacteriostatic Water"   # never "HPLC": throughput classifies category first

# keyword, title, unit, result_type, variance_capable; ORDER = member sort_order.
# Titles + units mirror the prod SENAITE services exactly (prod read 2026-10-05:
# "pH Determination"/pH, "Benzyl Alcohol Assay (HPLC)"/% (v/v),
# "Fill volume / Net content"/mL). Spec bounds + display strings mirror LIVE
# coabuilder baked_specs.py:39-49 (BA widened to +/-20% in 2.28.3, Handler
# sign-off 2026-07-17); Mk1's vendored copy (0.81-0.99) is stale, not the source.
BW_NATIVE_SERVICES: tuple[tuple[str, str, str | None, str, bool], ...] = (
    ("PH-BW", "pH Determination", "pH", "numeric", True),
    ("BENZYL-ALCOHOL-BW", "Benzyl Alcohol Assay (HPLC)", "% (v/v)", "numeric", True),
    ("FILL-VOLUME-BW", "Fill volume / Net content", "mL", "numeric", False),
)

# keyword -> (rule_kind, min, max, equals, unit, display_override); spec R4.
BW_NATIVE_SPECS = {
    "PH-BW": ("range", Decimal("4.5"), Decimal("7.0"), None, "pH", "4.5 – 7.0"),
    "BENZYL-ALCOHOL-BW": ("range", Decimal("0.72"), Decimal("1.08"), None, "% (v/v)",
                          "0.9% (v/v) ±20%"),
    "FILL-VOLUME-BW": ("informational", None, None, None, "mL", None),  # prints "Measured"
}

_SERVICE_LOG_FIELDS = ("title", "keyword", "unit", "result_type", "result_options",
                       "origin", "department_id", "variance_capable", "category")
_PROFILE_LOG_FIELDS = ("key", "name", "is_addon", "vials_required",
                       "fulfillment_role", "fulfillment_dim", "active", "coa_archetype")


def seed_bw_native_catalog(db: Session) -> dict[str, int]:
    from catalog.change_log import log_create, log_members
    from catalog.departments import department_id_by_name
    from catalog.service_spec_audit import record_spec_change
    from coa.bw_shim import LEGACY_BW_ARCHETYPE
    from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec,
                        analysis_profile_members)

    report = {"services": 0, "profile": 0, "members": 0, "specs": 0}

    dept_id = department_id_by_name(db, "Analytical")
    if dept_id is None:
        log.error("bw_native_seed.no_analytical_department: nothing seeded; "
                  "retried on the next boot")
        return report

    services: dict[str, AnalysisService] = {}
    collisions: list[str] = []
    for keyword, title, unit, result_type, variance_capable in BW_NATIVE_SERVICES:
        svc = (db.query(AnalysisService)
               .filter(AnalysisService.keyword == keyword, AnalysisService.origin == "mk1")
               .one_or_none())
        if svc is None:
            other = (db.query(AnalysisService)
                     .filter(AnalysisService.keyword == keyword, AnalysisService.origin != "mk1")
                     .one_or_none())
            if other is not None:
                log.error("bw_native_seed.keyword_collision keyword=%s origin=%s id=%s: "
                          "skipping; resolve in the catalog admin",
                          keyword, other.origin, other.id)
                collisions.append(keyword)
                continue
            svc = AnalysisService(
                title=title, keyword=keyword, unit=unit, result_type=result_type,
                category=_CATEGORY, origin="mk1", department_id=dept_id,
                variance_capable=variance_capable, active=True,
            )
            db.add(svc)
            db.flush()
            log_create(db, svc, _SERVICE_LOG_FIELDS, entity_type="service",
                       entity_pk=svc.id, user_id=None)
            report["services"] += 1
        services[keyword] = svc

    if collisions:
        log.error("bw_native_seed.profile_creation_aborted collided_keywords=%s: %s "
                  "cannot seed with all three members", collisions, BW_NATIVE_PROFILE_KEY)
        db.commit()
        return report

    prof = db.query(AnalysisProfile).filter_by(key=BW_NATIVE_PROFILE_KEY).one_or_none()
    if prof is None:
        prof = AnalysisProfile(
            key=BW_NATIVE_PROFILE_KEY, name=BW_NATIVE_PROFILE_NAME,
            is_addon=False, vials_required=1, fulfillment_role="hplc",
            fulfillment_dim="role", sort_order=0, active=False,
            coa_archetype=LEGACY_BW_ARCHETYPE,
        )
        db.add(prof)
        db.flush()
        log_create(db, prof, _PROFILE_LOG_FIELDS, entity_type="profile",
                   entity_pk=prof.id, user_id=None)
        report["profile"] = 1
        member_ids = [services[kw].id for kw, *_ in BW_NATIVE_SERVICES]
        for i, sid in enumerate(member_ids):
            db.execute(analysis_profile_members.insert().values(
                analysis_profile_id=prof.id, analysis_service_id=sid, sort_order=i))
        log_members(db, entity_type="profile_members", entity_pk=prof.id, user_id=None,
                    field="member_ids", before_ids=[], after_ids=member_ids)
        report["members"] = len(member_ids)

    for keyword, (kind, lo, hi, eq, unit, display) in BW_NATIVE_SPECS.items():
        svc = services[keyword]
        existing = (db.query(AnalysisServiceSpec)
                    .filter(AnalysisServiceSpec.analysis_service_id == svc.id,
                            AnalysisServiceSpec.matrix.is_(None),
                            AnalysisServiceSpec.peptide_id.is_(None))
                    .first())
        if existing is not None:
            continue
        spec = AnalysisServiceSpec(
            analysis_service_id=svc.id, matrix=None, rule_kind=kind,
            min_value=lo, max_value=hi, equals_value=eq, unit=unit,
            display_override=display,
        )
        db.add(spec)
        db.flush()
        record_spec_change(db, spec, before=None, actor_user_id=None)
        report["specs"] += 1

    db.commit()
    if any(report.values()):
        log.info("catalog.bw_native_seed %s", report)
    return report
```

`backend/database.py` `init_db`. Current `:185-191`:

```python
    try:
        from catalog.hplc_native_seed import upgrade_hplc_native_catalog
        with SessionLocal() as _db:
            upgrade_hplc_native_catalog(_db)
    except Exception as e:  # never block startup
        log.warning("catalog_hplc_native_catalog_upgrade_skipped err=%s", e)
    try:
        from catalog.service_spec_seed import seed_service_specs
```

Insert between the upgrade's `except` and the `seed_service_specs` try:

```python
    # Bac Water native family (spec 2026-10-05, MB1): three services + the
    # INACTIVE bacteriostatic-water-panel profile + wildcard specs. After
    # backfill_departments (it needs the Analytical department), before
    # service_spec_seed for symmetry with the HPLC seed.
    try:
        from catalog.bw_native_seed import seed_bw_native_catalog
        with SessionLocal() as _db:
            seed_bw_native_catalog(_db)
    except Exception as e:  # never block startup
        log.warning("catalog_bw_native_seed_skipped err=%s", e)
```

`backend/database.py` `_run_migrations`. Current `:2492-2496`:

```python
        """
        INSERT INTO lims_native_id_sequences (prefix, next_value)
        SELECT 'PB', 1000
        WHERE NOT EXISTS (SELECT 1 FROM lims_native_id_sequences WHERE prefix = 'PB')
        """,
```

Insert immediately after it:

```python
        # Bac Water native-born (spec 2026-10-05, R3): customer-facing BW-NNNN
        # counter seeded ONCE at 1000, above SENAITE's prod max (BW-0135 on
        # 2026-10-05). Guarded: never resets an existing counter.
        """
        INSERT INTO lims_native_id_sequences (prefix, next_value)
        SELECT 'BW', 1000
        WHERE NOT EXISTS (SELECT 1 FROM lims_native_id_sequences WHERE prefix = 'BW')
        """,
```

- [ ] **Step 4: Run, expect PASS**
Run: `cd backend && python -m pytest tests/test_bw_native_catalog_seed.py tests/test_hplc_native_schema.py tests/test_hplc_native_catalog_seed.py -q`
Expected: PASS. The HPLC seed suite still passes, including its own `init_db` order pin: the BW seed is wrapped in try/except, and with `_FakeSession` it raises inside the guard.

- [ ] **Step 5: Commit**
```bash
git add -- backend/catalog/bw_keys.py backend/coa/bw_shim.py backend/catalog/bw_native_seed.py backend/database.py backend/tests/test_bw_native_catalog_seed.py backend/tests/test_hplc_native_schema.py
git commit -m "feat(catalog): seed native Bac Water panel (inactive) + BW-1000 counter (MB1)" -- backend/catalog/bw_keys.py backend/coa/bw_shim.py backend/catalog/bw_native_seed.py backend/database.py backend/tests/test_bw_native_catalog_seed.py backend/tests/test_hplc_native_schema.py
```

---

### Task M2: BW key alias, backend consumers

**Repo:** Accu-Mk1
**Files:**
- Modify: `backend/sub_samples/service.py:1545-1548` (`derive_variance_demand`) and `:1588-1590` (`derive_base_demand`)
- Modify: `backend/lims_analyses/seeder.py:45` (import), `:63-70` (`_PARENT_BENCH_ONLY_KEYWORDS`), `:80-86` (`ROLE_TO_WP_KEYS`)
- Modify: `backend/throughput.py:47` (`BACW_KEYWORDS`)
- Test: `backend/tests/test_bw_native_alias.py` (create)

**Interfaces:**
- Consumes (M1):
  - `catalog.bw_keys.BW_PRIMARY_KEYS`, `bw_primary_selected`, `bw_primary_count`, `BW_NATIVE_KEYWORDS`
  - `catalog.bw_native_seed.seed_bw_native_catalog`
- Produces:
  - `ROLE_TO_WP_KEYS["hplc"] == set(HPLC_PRIMARY_KEYS) | set(BW_PRIMARY_KEYS)`. M5 depends on this: without it, `role_implies_seeding("hplc", {"bacteriostatic-water-panel": True})` is False, and the native BW vial never reaches the hplc branch.
  - `throughput.BACW_KEYWORDS ⊇ BW_NATIVE_KEYWORDS`.

**`bac_water_panel` grep at origin/master, `backend/` and `src/`, non-test:**

| Site | Decision | Why |
|---|---|---|
| `backend/sub_samples/service.py:1548` (`derive_variance_demand`) | CHANGE | Native key must give the same hplc variance bucket (parity; BW variance itself stays out of scope, R5) |
| `backend/sub_samples/service.py:1590` (`derive_base_demand`) | CHANGE | Otherwise the legacy shadow says hplc=0 while the catalog says 1, and `demand_divergence` logs ERROR on every native BW order |
| `backend/sub_samples/service.py:1544`, `:1637` | LEAVE | Docstrings. `derive_demand` (`:1632-1649`) only calls `derive_base_demand`, so it is covered |
| `backend/lims_analyses/seeder.py:82` (`ROLE_TO_WP_KEYS`) | CHANGE | Gate for `role_implies_seeding` on the hplc vial |
| `backend/catalog/demand_verify.py:37` (`LEGACY_DEMAND_KEYS`) | LEAVE | Deploy-gate precedent. `test_hplc_native_alias.py:80-104` pins that a native key must NOT join (the precheck runs on prod before the boot seed creates the row). The seeded profile is still checked by checks #2-4 (M1 test) |
| `backend/sub_samples/product_registry.py:39` | LEAVE | `PRODUCT_REGISTRY` is the legacy set pinned by `test_profile_parity.py`. The only production caller, `sub_samples/routes.py:962`, passes `db=`, so `lookup_product_def` resolves the native key from the `analysis_profiles` row (label "Bac Water Panel", `is_addon=False`); M2 test pins it |
| `backend/catalog/profile_seed.py:53` | LEAVE | Legacy registry demand backfill. The native profile is created by its own seed with `vials_required=1` |
| `backend/catalog/hplc_keys.py:8` | LEAVE | Docstring |
| `backend/sub_samples/catalog_demand.py:5`, `:37` | LEAVE | Docstrings. The resolver is key-agnostic |
| `backend/lims_analyses/service.py:1344` (`_LEGACY_SECTION_RULES`) | LEAVE | Display classifier for SENAITE-era rows. Native rows take their section from their profile (spec R2), and `PH-`/`BENZYL`/`FILL-` would match anyway |
| `src/lib/product-completion.ts:125` | CHANGE | Task M3 |

**Legacy-keyword grep (`PH-DETERM|Benzyl_Alcohol_Assay|FILL-NET-CONTENT`):**
- `seeder.py:69`: CHANGE (add the native trio).
- `throughput.py:47`: CHANGE.
- `database.py:1101`: LEAVE. The seed sets `variance_capable`.
- `database.py:417`: LEAVE. See Notes item 4.
- `conformance_vendored/baked_specs.py:30-61`: LEAVE. The shim emits legacy keywords.
- `main.py:20230` and `lims_analyses/service.py:1335`: comments.

- [ ] **Step 1: Write the failing test**
```python
# backend/tests/test_bw_native_alias.py
"""Alias set (spec 2026-10-05, MB2): `bacteriostatic-water-panel` counts as
THE Bac Water primary everywhere `bac_water_panel` is hardcoded, so a native
BW order plans the same hplc vial, never logs demand_divergence, and seeds
its hplc vial. Legacy behaviour is pinned alongside each site."""
import logging

import models  # noqa: F401


def _seed(db):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from catalog.profile_seed import seed_profiles_from_registry
    from models import Department
    db.add(Department(name="Analytical"))
    db.commit()
    seed_profiles_from_registry(db)
    seed_bw_native_catalog(db)
    db.commit()


def test_variance_demand_counts_native_key_like_legacy():
    from sub_samples.service import derive_variance_demand
    legacy = derive_variance_demand({"bac_water_panel": True, "variance": {"bac_water_panel": 3}})
    native = derive_variance_demand({"bacteriostatic-water-panel": True,
                                     "variance": {"bacteriostatic-water-panel": 3}})
    assert legacy == native
    assert native["hplc"] == 2


def test_base_demand_legacy_only_signature_counts_native_key():
    from sub_samples.service import derive_base_demand
    native = derive_base_demand({"bacteriostatic-water-panel": True})
    legacy = derive_base_demand({"bac_water_panel": True})
    assert native == legacy == {"hplc": 1, "endo": 0, "ster": 0}


def test_base_demand_catalog_path_no_divergence(db_session, caplog):
    from sub_samples.service import derive_base_demand
    _seed(db_session)
    with caplog.at_level(logging.ERROR):
        native = derive_base_demand({"bacteriostatic-water-panel": True}, db=db_session)
        legacy = derive_base_demand({"bac_water_panel": True}, db=db_session)
    assert native["hplc"] == legacy["hplc"] == 1
    assert not any("demand_divergence" in r.message for r in caplog.records)


def test_seeder_role_map_and_gate_include_native_key():
    from lims_analyses.seeder import ROLE_TO_WP_KEYS, role_implies_seeding
    assert {"bac_water_panel", "bacteriostatic-water-panel",
            "hplcpurity_identity", "hplc-purity-identity"} <= ROLE_TO_WP_KEYS["hplc"]
    assert role_implies_seeding("hplc", {"bacteriostatic-water-panel": True})
    assert role_implies_seeding("hplc", {"bac_water_panel": True})


def test_parent_bench_only_keeps_legacy_trio_and_adds_native():
    from lims_analyses.seeder import _PARENT_BENCH_ONLY_KEYWORDS
    assert {"Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT",
            "PH-BW", "BENZYL-ALCOHOL-BW", "FILL-VOLUME-BW"} == set(_PARENT_BENCH_ONLY_KEYWORDS)


def test_throughput_files_native_trio_under_bac_water():
    from throughput import classify_keyword
    for kw in ("PH-BW", "BENZYL-ALCOHOL-BW", "FILL-VOLUME-BW"):
        assert classify_keyword(kw, None) == "bacw"
        assert classify_keyword(kw, "Bacteriostatic Water") == "bacw"
    for kw in ("Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT"):
        assert classify_keyword(kw, None) == "bacw"


def test_ordered_products_resolve_native_key_from_catalog_row(db_session):
    from sub_samples.product_registry import build_ordered_products
    _seed(db_session)
    native = build_ordered_products({"bacteriostatic-water-panel": True}, None, db=db_session)
    legacy = build_ordered_products({"bac_water_panel": True}, None, db=db_session)
    assert [(p["key"], p["label"], p["is_addon"]) for p in native] == [
        ("bacteriostatic-water-panel", "Bac Water Panel", False)]
    assert [(p["key"], p["label"]) for p in legacy] == [("bac_water_panel", "Bac Water")]


def test_demand_verify_legacy_keys_unchanged():
    from catalog.demand_verify import LEGACY_DEMAND_KEYS
    assert LEGACY_DEMAND_KEYS == (
        "hplcpurity_identity", "bac_water_panel", "endotoxin", "sterility_pcr",
    )
```

- [ ] **Step 2: Run it, expect FAIL**
Run: `cd backend && python -m pytest tests/test_bw_native_alias.py -q`
Expected: FAIL in:
- `test_variance_demand_counts_native_key_like_legacy` (native `hplc == 0`)
- `test_base_demand_*` (native `hplc == 0`, plus a `demand_divergence` ERROR)
- `test_seeder_role_map_and_gate_include_native_key`
- `test_parent_bench_only_keeps_legacy_trio_and_adds_native`
- `test_throughput_files_native_trio_under_bac_water` (`'other' != 'bacw'`)

The products and demand_verify tests pass already. They are legacy pins.

- [ ] **Step 3: Implement**

`backend/sub_samples/service.py`. Current `:1545-1548`:
```python
    from catalog.hplc_keys import hplc_primary_count
    entitlement = normalize_variance_entitlement({"variance": (services or {}).get("variance")})
    hplc_total = max(hplc_primary_count(entitlement), entitlement.get("bac_water_panel", 0))
```
New:
```python
    from catalog.bw_keys import bw_primary_count
    from catalog.hplc_keys import hplc_primary_count
    entitlement = normalize_variance_entitlement({"variance": (services or {}).get("variance")})
    hplc_total = max(hplc_primary_count(entitlement), bw_primary_count(entitlement))
```

Current `:1588-1590`:
```python
    from catalog.hplc_keys import hplc_primary_selected
    hplc = hplc_primary_selected(services) or bool(services.get("bac_water_panel"))
```
New:
```python
    from catalog.bw_keys import bw_primary_selected
    from catalog.hplc_keys import hplc_primary_selected
    hplc = hplc_primary_selected(services) or bw_primary_selected(services)
```

`backend/lims_analyses/seeder.py`. Current `:45`, `from catalog.hplc_keys import HPLC_PRIMARY_KEYS`, becomes:
```python
from catalog.bw_keys import BW_NATIVE_KEYWORDS, BW_PRIMARY_KEYS
from catalog.hplc_keys import HPLC_PRIMARY_KEYS
```
Current `:68-70`:
```python
_PARENT_BENCH_ONLY_KEYWORDS = frozenset({
    "Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT",
})
```
New (the comment block above at `:63-67` stays as is):
```python
# Native BW keywords are listed too (spec 2026-10-05 MB2) as a guard only:
# this set is read solely by the SENAITE mirror below, so a native keyword
# can never be mirrored onto a vial from a SENAITE AR. Native BW vials seed
# their panel on the vial through seed_analyses_for_vial (task M5); they are
# NOT parent-bench rows.
_PARENT_BENCH_ONLY_KEYWORDS = frozenset({
    "Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT",
}) | BW_NATIVE_KEYWORDS
```
Current `:80-82`:
```python
# hplc: both primary keys (legacy + native profile key) -- see catalog/hplc_keys.py
ROLE_TO_WP_KEYS: Dict[str, Set[str]] = {
    "hplc": set(HPLC_PRIMARY_KEYS) | {"bac_water_panel"},
```
New:
```python
# hplc: both HPLC primary keys and both Bac Water primary keys (legacy +
# native profile key each), see catalog/hplc_keys.py and catalog/bw_keys.py
ROLE_TO_WP_KEYS: Dict[str, Set[str]] = {
    "hplc": set(HPLC_PRIMARY_KEYS) | set(BW_PRIMARY_KEYS),
```

`backend/throughput.py`. Current `:47`:
```python
BACW_KEYWORDS = frozenset({"Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT"})
```
New (add `from catalog.bw_keys import BW_NATIVE_KEYWORDS` to the import block; `catalog/bw_keys.py` is import-free, so the module stays DB-free):
```python
# Legacy SENAITE trio + the native-born trio (spec 2026-10-05, MB2).
BACW_KEYWORDS = frozenset({"Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT"}) | BW_NATIVE_KEYWORDS
```

- [ ] **Step 4: Run, expect PASS**
Run these one after another, never in parallel. The second suite includes live-DB tests:
- `cd backend && python -m pytest tests/test_bw_native_alias.py tests/test_hplc_native_alias.py tests/test_catalog_demand.py tests/test_variance_demand.py tests/test_product_registry.py tests/test_profile_parity.py tests/test_throughput.py tests/test_catalog_seeding.py -q`
- `cd backend && python -m pytest tests/test_lims_analyses_seeder.py tests/test_identity_convergence_guard.py -q`

Expected: PASS, apart from failures already on the master baseline. `test_identity_convergence_guard.py::test_no_unclassified_keyword_identity_site` is a known pre-existing failure per the slice-3 plan; diff the failure set against master.

- [ ] **Step 5: Commit**
```bash
git add -- backend/sub_samples/service.py backend/lims_analyses/seeder.py backend/throughput.py backend/tests/test_bw_native_alias.py
git commit -m "feat(catalog): bacteriostatic-water-panel aliases the Bac Water primary in demand/seeder/throughput (MB2)" -- backend/sub_samples/service.py backend/lims_analyses/seeder.py backend/throughput.py backend/tests/test_bw_native_alias.py
```

---

### Task M3: BW key alias, frontend product completion

**Repo:** Accu-Mk1
**Files:**
- Modify: `src/lib/product-completion.ts:117-126` (`HPLC_PACKAGE_KEYS`)
- Test: `src/test/product-completion.test.ts:256-275`. Add a sibling `describe` after the `native HPLC profile key` block, inside the top-level `computeProductCompletion` describe.

**Interfaces:**
- Consumes: none (frontend literal; mirrors `catalog.bw_keys.NATIVE_BW_KEY`).
- Produces: `familyMatchesProduct` / `hasCompletionRule` treat `'bacteriostatic-water-panel'` exactly like `'bac_water_panel'`.

**Why this site needs the key:**
- `buildKeywordFamilyMap` (`product-completion.ts:65-80`) skips inactive profiles, and the native profile stays inactive. So `keywordFamilies` never maps `PH-BW` and friends.
- Without the key, `hasCompletionRule('bacteriostatic-water-panel')` is false, and the chip renders with no check at all. The legacy key renders one.

- [ ] **Step 1: Write the failing test**
```ts
  describe('native Bac Water profile key', () => {
    it('treats bacteriostatic-water-panel exactly like bac_water_panel', () => {
      const cases = [
        ctx({}),
        ctx({
          analyses: [ana('HPLC-PUR', 'Analytics')],
          promos: [promo('HPLC-PUR', ['BW-1000-S01'])],
        }),
        ctx({
          analyses: [ana('PH-BW', null), ana('PH-DETERM', null)],
          promos: [promo('PH-BW', ['BW-1000-S01'])],
        }),
      ]
      for (const c of cases) {
        const legacy = computeProductCompletion(prod('bac_water_panel'), c)
        const native = computeProductCompletion(
          prod('bacteriostatic-water-panel'),
          c
        )
        expect(native).not.toBeNull()
        expect(native).toEqual(legacy)
      }
    })
  })
```

- [ ] **Step 2: Run it, expect FAIL**
Run: `npm run test -- src/test/product-completion.test.ts`
Expected: FAIL with `expected null not to be null` (no completion rule for the native key).

- [ ] **Step 3: Implement**
Current `:117-126`:
```ts
/** HPLC single-component package keys -- each one's category is the hplc
 *  family (plus any keywords a dev-seeded catalog maps to them directly).
 *  'hplc-purity-identity' is the native profile key (spec 2026-09-10); it
 *  and the legacy 'hplcpurity_identity' both mean the HPLC primary. */
const HPLC_PACKAGE_KEYS = new Set([
  'core',
  'hplcpurity_identity',
  'hplc-purity-identity',
  'bac_water_panel',
])
```
New: keep the existing doc comment, append one line to it, and add one entry:
```ts
 *  'bacteriostatic-water-panel' is the native Bac Water profile key (spec
 *  2026-10-05); it behaves exactly like the legacy 'bac_water_panel'. */
const HPLC_PACKAGE_KEYS = new Set([
  'core',
  'hplcpurity_identity',
  'hplc-purity-identity',
  'bac_water_panel',
  'bacteriostatic-water-panel',
])
```

- [ ] **Step 4: Run, expect PASS**
Run: `npm run test -- src/test/product-completion.test.ts src/test/product-chip.test.tsx`, then `npx eslint src/lib/product-completion.ts src/test/product-completion.test.ts && npx prettier --check src/lib/product-completion.ts src/test/product-completion.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**
```bash
git add -- src/lib/product-completion.ts src/test/product-completion.test.ts
git commit -m "feat(ui): bacteriostatic-water-panel completes like bac_water_panel (MB2)" -- src/lib/product-completion.ts src/test/product-completion.test.ts
```

---

### Task M4: Native-born BW intake (customer prefix, counter headroom, slot gate)

**Repo:** Accu-Mk1
**Files:**
- Modify: `backend/sub_samples/native_id.py`:
  - `:61-70`: comment and `CUSTOMER_PREFIXES`.
  - `:79-81` and `:89-91`: error messages.
  - Append `customer_id_headroom_violations` after `mint_customer_sample_id`.
- Modify: `backend/lims_analyses/parent_placeholders.py:65-80`: import and slot gate.
- Modify: `backend/database.py`, the end of `init_db` after the `verify_demand_catalog` try (origin/master `:200-205`): add the headroom check call.
- Test: `backend/tests/test_native_id.py`. Stale pins:
  - `:55-58`: the helper gains a `bw` arg.
  - `:61-62`: the prefix map now has BW.
  - `:88-93`: BW no longer refused.
- Test: `backend/tests/test_bw_native_intake.py` (create)

**Interfaces:**
- Consumes (M1): `catalog.bw_keys.is_bw_sample`, `catalog.bw_native_seed.seed_bw_native_catalog` / `BW_NATIVE_PROFILE_KEY`, the boot `BW` counter row.
- Produces:
  - `CUSTOMER_PREFIXES == {"peptide": "P", "peptide blend": "PB", "bacteriostatic water": "BW"}`.
  - `customer_id_headroom_violations(db) -> list[str]`. It logs ERROR `native_id.counter_headroom ...` per violating prefix and never raises.
  - `seed_parent_placeholders` on a native-born BW parent mints the panel members with `slot=None`, and never resolves slots or flags.

**Why the gate is by exclusion (`not is_bw_sample`), not "Peptide / Peptide Blend only" as the spec says:**
- `test_apply_retest_spec.py:84-90` (`_retest`) mints a native-born row with NO `sample_type_title` and depends on slot resolution to mint the HPLC trio.
- Native retest rows in prod may carry a NULL title as well.
- A positive peptide-only gate would silently mint slot-less HPLC placeholders for them. The exclusion gate changes only BW.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_native_id.py`. Current `:55-62`:
```python
def _seed_customer_counters(db, p=5000, pb=1000):
    db.add(LimsNativeIdSequence(prefix="P", next_value=p))
    db.add(LimsNativeIdSequence(prefix="PB", next_value=pb))
    db.commit()


def test_customer_prefix_map_is_peptide_and_blend_only():
    assert CUSTOMER_PREFIXES == {"peptide": "P", "peptide blend": "PB"}
```
New:
```python
def _seed_customer_counters(db, p=5000, pb=1000, bw=1000):
    db.add(LimsNativeIdSequence(prefix="P", next_value=p))
    db.add(LimsNativeIdSequence(prefix="PB", next_value=pb))
    db.add(LimsNativeIdSequence(prefix="BW", next_value=bw))
    db.commit()


def test_customer_prefix_map_is_peptide_blend_and_bac_water():
    # Bac Water became native-born in spec 2026-10-05 (R3: BW-1000).
    assert CUSTOMER_PREFIXES == {"peptide": "P", "peptide blend": "PB",
                                 "bacteriostatic water": "BW"}
```
Current `:88-93`:
```python
def test_customer_id_refuses_bac_water_and_unknown(db):
    _seed_customer_counters(db)
    with pytest.raises(ValueError):
        mint_customer_sample_id(db, "Bacteriostatic Water")
    with pytest.raises(ValueError):
        mint_customer_sample_id(db, "Mystery Goo")
```
New:
```python
def test_customer_id_refuses_unknown_type(db):
    _seed_customer_counters(db)
    with pytest.raises(ValueError):
        mint_customer_sample_id(db, "Mystery Goo")


def test_customer_id_mints_bac_water_from_1000_and_skips_taken(db):
    from models import LimsSample
    _seed_customer_counters(db)
    assert mint_customer_sample_id(db, "Bacteriostatic Water") == "BW-1000"
    db.add(LimsSample(sample_id="BW-1001"))
    db.commit()
    assert mint_customer_sample_id(db, "Bacteriostatic Water") == "BW-1002"
    # P / PB untouched by the BW counter.
    assert mint_customer_sample_id(db, "Peptide") == "P-5000"
    assert mint_customer_sample_id(db, "Peptide Blend") == "PB-1000"


def test_customer_id_refuses_unseeded_bw_prefix(db):
    with pytest.raises(ValueError, match="not seeded"):
        mint_customer_sample_id(db, "Bacteriostatic Water")
```

```python
# backend/tests/test_bw_native_intake.py
"""Native-born Bac Water intake (spec 2026-10-05, MB3): placeholders for the
panel mint WITHOUT the peptide slot machinery (no slot resolution, no
unresolved-analyte flag, which would block the COA); the customer-id counter
headroom check is loud and never blocks boot."""
import inspect
import json
import logging

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from flags import seams as flag_seams
from flags.models import FlagFlag
from flags.types_service import seed_builtins
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders
from models import Department, LimsAnalysis, LimsNativeIdSequence, LimsSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _catalog(db):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from catalog.profile_seed import seed_profiles_from_registry
    seed_builtins(db)
    flag_seams.register_mk1_entities()
    db.add(Department(name="Analytical"))
    db.commit()
    seed_profiles_from_registry(db)
    seed_bw_native_catalog(db)


def _bw_parent(db, *, system, sample_id):
    p = LimsSample(sample_id=sample_id, external_lims_system=system,
                   sample_type_title="Bacteriostatic Water",
                   analytes=json.dumps([{"name": "Benzyl Alcohol", "declared_quantity": "30"}]))
    db.add(p)
    db.commit()
    return p


def _ordered(db, parent):
    return db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id,
                                            provenance=PROVENANCE_ORDERED).all()


def test_native_bw_parent_gets_three_placeholders_and_zero_flags(db, caplog):
    _catalog(db)
    p = _bw_parent(db, system="mk1", sample_id="BW-1000")
    with caplog.at_level(logging.ERROR):
        stats = seed_parent_placeholders(db, parent=p,
                                         services={"bacteriostatic-water-panel": True})
    rows = _ordered(db, p)
    assert stats["created"] == 3
    assert sorted((r.keyword, r.slot, r.peptide_id) for r in rows) == [
        ("BENZYL-ALCOHOL-BW", None, None), ("FILL-VOLUME-BW", None, None), ("PH-BW", None, None)]
    flags = db.execute(select(FlagFlag).where(FlagFlag.entity_type == "sample",
                                              FlagFlag.entity_id == str(p.id))).scalars().all()
    assert flags == []
    assert not any("native_placeholder_no_analyte_slots" in r.message for r in caplog.records)


def test_senaite_born_bw_parent_legacy_key_unchanged(db):
    """Legacy bac_water_panel has no members, so no 'ordered' rows: today's behaviour."""
    _catalog(db)
    p = _bw_parent(db, system="senaite", sample_id="BW-0135")
    stats = seed_parent_placeholders(db, parent=p, services={"bac_water_panel": True})
    assert stats["created"] == 0 and _ordered(db, p) == []


def test_senaite_born_bw_parent_with_native_key_gets_no_native_placeholders(db):
    """Review Focus 3: IS valve OFF maps the native key to the legacy SENAITE
    panel but does NOT rewrite the stored payload, so a SENAITE-born BW sample
    can arrive carrying bacteriostatic-water-panel. Its SENAITE trio already
    shadows onto the parent; minting the native trio too would put two
    entry surfaces on the bench."""
    _catalog(db)
    p = _bw_parent(db, system="senaite", sample_id="BW-0136")
    stats = seed_parent_placeholders(db, parent=p,
                                     services={"bacteriostatic-water-panel": True})
    assert stats["created"] == 0 and _ordered(db, p) == []


def test_native_peptide_without_title_still_resolves_slots(db):
    """The gate is BW-exclusion, not peptide-only: a native row with a NULL
    sample_type_title (test_apply_retest_spec._retest shape) still gets the
    slot-aware trio."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisProfile, Peptide
    seed_hplc_native_catalog(db)
    db.query(AnalysisProfile).filter_by(key="hplc-purity-identity").one().active = True
    db.add(Peptide(name="BPC-157", abbreviation="BPC157"))
    p = LimsSample(sample_id="P-5003", external_lims_system="mk1",
                   analytes=json.dumps([{"name": "BPC-157 - Identity (HPLC)"}]))
    db.add(p)
    db.commit()
    seed_parent_placeholders(db, parent=p, services={"hplc-purity-identity": True})
    assert sorted((r.keyword, r.slot) for r in _ordered(db, p)) == [
        ("HPLC-IDENTITY", 1), ("HPLC-PURITY", 1), ("HPLC-QUANTITY", 1)]


def test_headroom_silent_when_counters_above_senaite_max(db, caplog):
    from sub_samples.native_id import customer_id_headroom_violations
    db.add_all([LimsNativeIdSequence(prefix="BW", next_value=1000),
                LimsNativeIdSequence(prefix="P", next_value=5000),
                LimsNativeIdSequence(prefix="PB", next_value=1000),
                LimsSample(sample_id="BW-0135", external_lims_system="senaite"),
                LimsSample(sample_id="P-4999", external_lims_system="senaite"),
                LimsSample(sample_id="BW-1000", external_lims_system="mk1")])
    db.commit()
    with caplog.at_level(logging.ERROR):
        assert customer_id_headroom_violations(db) == []
    assert not caplog.records


def test_headroom_errors_when_senaite_reaches_counter(db, caplog):
    from sub_samples.native_id import customer_id_headroom_violations
    db.add_all([LimsNativeIdSequence(prefix="BW", next_value=1000),
                LimsSample(sample_id="BW-1000", external_lims_system="senaite"),
                LimsSample(sample_id="BW-1000-X", external_lims_system="senaite")])
    db.commit()
    with caplog.at_level(logging.ERROR):
        out = customer_id_headroom_violations(db)
    assert len(out) == 1 and "BW" in out[0] and "BW-1000" in out[0]
    assert any("native_id.counter_headroom" in r.message for r in caplog.records)


def test_init_db_runs_headroom_check():
    import database
    assert "customer_id_headroom_violations" in inspect.getsource(database.init_db)
```

- [ ] **Step 2: Run it, expect FAIL**
Run: `cd backend && python -m pytest tests/test_native_id.py tests/test_bw_native_intake.py -q`
Expected: FAIL in:
- the BW mint tests (`ValueError: no native customer-facing prefix ... 'Bacteriostatic Water'`)
- the prefix-map pin
- `test_native_bw_parent_gets_three_placeholders_and_zero_flags`: one open `question` flag ("analyte unresolved: Benzyl Alcohol (slot 1)"), because the sqlite catalog has no Benzyl Alcohol peptide
- `test_senaite_born_bw_parent_with_native_key_gets_no_native_placeholders` (`created == 3`)
- the headroom tests (`ImportError: customer_id_headroom_violations`)
- `test_init_db_runs_headroom_check`

- [ ] **Step 3: Implement**

`backend/sub_samples/native_id.py`. Current `:61-70`:
```python
# ── Customer-facing native ids (spec 2026-09-10, M3) ────────────────────────
# A native-born sample (no SENAITE AR) must still LOOK like every other
# sample to the customer: P-NNNN / PB-NNNN. These counters are seeded by a
# guarded boot migration ABOVE SENAITE's prod maximum (P at 5000, PB at 1000,
# Handler ruling 2026-09-10) so the two authorities cannot collide while the
# legacy drain runs. Bacteriostatic Water is deliberately absent: BW stays
# SENAITE-born in this program. A prefix row that does not exist is an
# operator error (the seed never ran), never auto-created at 1 -- that would
# mint P-0001 on prod.
CUSTOMER_PREFIXES = {"peptide": "P", "peptide blend": "PB"}
```
New:
```python
# Customer-facing native ids (spec 2026-09-10, M3; Bac Water spec 2026-10-05, R3).
# A native-born sample (no SENAITE AR) must still LOOK like every other
# sample to the customer: P-NNNN / PB-NNNN / BW-NNNN. These counters are
# seeded by a guarded boot migration ABOVE SENAITE's prod maximum (P at 5000,
# PB at 1000 per Handler ruling 2026-09-10; BW at 1000 per spec 2026-10-05)
# so the two authorities cannot collide while the legacy drain runs, and
# customer_id_headroom_violations re-checks that at every boot. A prefix row
# that does not exist is an operator error (the seed never ran), never
# auto-created at 1, which would mint P-0001 on prod.
CUSTOMER_PREFIXES = {"peptide": "P", "peptide blend": "PB", "bacteriostatic water": "BW"}
```
Current `:79-81`:
```python
        raise ValueError(
            f"no native customer-facing prefix for sample type {sample_type_title!r} "
            "(only Peptide / Peptide Blend are native-born)"
```
New, last line only:
```python
            "(only Peptide / Peptide Blend / Bacteriostatic Water are native-born)"
```
Current `:89-91`:
```python
        raise ValueError(
            f"customer id counter for prefix {prefix!r} is not seeded "
            "(boot migration lims_native_id_sequences P/PB missing)"
```
New, last line only:
```python
            "(boot migration lims_native_id_sequences P/PB/BW missing)"
```
Append at end of file:
```python
def customer_id_headroom_violations(db: Session) -> list[str]:
    """Boot check (spec 2026-10-05 MB1): for each customer prefix, the seeded
    counter must sit ABOVE the highest SENAITE-born id already registered.
    If SENAITE ever reaches the counter, the two authorities interleave and
    the next SENAITE AR under an id Mk1 already minted parks on a quarantine
    row (registry adoption guard). mint_customer_sample_id still skips taken
    ids, so this is an ERROR for ops, never a boot blocker. A prefix with no
    counter row is skipped: minting already fails loud for it.

    ponytail: Python-side max over that prefix's sample_ids (low thousands of
    rows, once per boot); move to SQL if lims_samples grows past ~100k."""
    import re
    from sqlalchemy import or_
    from models import LimsSample

    out: list[str] = []
    for prefix in sorted(set(CUSTOMER_PREFIXES.values())):
        seq = db.execute(
            select(LimsNativeIdSequence).where(LimsNativeIdSequence.prefix == prefix)
        ).scalar_one_or_none()
        if seq is None:
            continue
        pattern = re.compile(rf"^{re.escape(prefix)}-(\d+)$")
        ids = db.execute(
            select(LimsSample.sample_id).where(
                LimsSample.sample_id.like(f"{prefix}-%"),
                or_(LimsSample.external_lims_system.is_(None),
                    LimsSample.external_lims_system != "mk1"),
            )
        ).scalars()
        top = max((int(m.group(1)) for s in ids if (m := pattern.match(s or ""))), default=0)
        if top >= seq.next_value:
            msg = (f"{prefix} counter next_value={seq.next_value} is at or below the "
                   f"highest SENAITE-born id {prefix}-{top:0{_PAD}d}")
            log.error("native_id.counter_headroom %s", msg)
            out.append(msg)
    return out
```
And add, after the existing imports at the top of `native_id.py` (`:15-18`):
```python
import logging

log = logging.getLogger(__name__)
```

`backend/database.py` `init_db`. Append after the `verify_demand_catalog` try/except (origin/master `:200-205`):
```python
    # Customer-id counters (P/PB/BW) must stay above SENAITE's max while the
    # legacy drain runs. ERROR per violation inside; never blocks startup.
    try:
        from sub_samples.native_id import customer_id_headroom_violations
        with SessionLocal() as _s:
            customer_id_headroom_violations(_s)
    except Exception as e:  # never block startup
        log.warning("customer_id_headroom_check_skipped err=%s", e)
```

`backend/lims_analyses/parent_placeholders.py`. Current `:63-80`:
```python
    from models import LimsAnalysis
    from coa.native_sections import _ordered_native_profiles
    from lims_analyses.hplc_native import (AGGREGATES, TRIO, flag_unresolved_slots,
                                           is_native_born, resolve_slot_peptides,
                                           title_for_slot)
    from lims_analyses.service import record_placeholder_created
    ...
    native_slots = None
    if is_native_born(parent):
        native_slots = resolve_slot_peptides(db, parent)
```
New (add the import, and change the one condition):
```python
    from catalog.bw_keys import is_bw_sample
    from models import LimsAnalysis
    ...
    # Slots are the PEPTIDE model (one HPLC trio per analyte). A native-born
    # Bac Water parent (spec 2026-10-05 MB3) carries "Benzyl Alcohol" as its
    # analyte but its panel is slot-less, so it never resolves slots and never
    # raises the unresolved-analyte flag (which would block its COA). Gated by
    # BW exclusion, not a peptide allow-list: native rows with a NULL
    # sample_type_title (retest rows) must keep resolving slots.
    native_slots = None
    if is_native_born(parent) and not is_bw_sample(parent):
        native_slots = resolve_slot_peptides(db, parent)
```
In the same file, the profile loop (current `:105-110`, `for prof in profiles:`) gains one guard as its first statement. The native BW panel is placeheld ONLY on a native-born parent; a SENAITE-born BW sample keeps its SENAITE shadow trio as the single entry surface:
```python
    from coa.bw_shim import LEGACY_BW_ARCHETYPE
    ...
    for prof in profiles:
        if prof.coa_archetype == LEGACY_BW_ARCHETYPE and not is_native_born(parent):
            stats["skipped"] += len(prof.analysis_services)
            continue
```

- [ ] **Step 4: Run, expect PASS**
Run, one after another:
- `cd backend && python -m pytest tests/test_native_id.py tests/test_bw_native_intake.py tests/test_hplc_native_placeholders.py tests/test_hplc_native_unresolved_flag.py tests/test_parent_placeholders.py -q`
- `cd backend && python -m pytest tests/test_apply_retest_spec.py tests/test_registry_signal.py tests/test_bw_native_catalog_seed.py -q`

Expected: PASS. The registry-signal suite proves a P/PB native-born upsert is unchanged.

- [ ] **Step 5: Commit**
```bash
git add -- backend/sub_samples/native_id.py backend/lims_analyses/parent_placeholders.py backend/database.py backend/tests/test_native_id.py backend/tests/test_bw_native_intake.py
git commit -m "feat(intake): native-born Bac Water mints BW-NNNN, skips peptide slots; boot counter headroom check (MB3)" -- backend/sub_samples/native_id.py backend/lims_analyses/parent_placeholders.py backend/database.py backend/tests/test_native_id.py backend/tests/test_bw_native_intake.py
```

---

### Task M5: Check-in, native-born BW hplc vial seeds the panel

**Repo:** Accu-Mk1
**Files:**
- Modify: `backend/lims_analyses/seeder.py`:
  - `:736-747`: the hplc-role fork in `seed_analyses_for_vial`.
  - New helper `_seed_native_bw_rows` placed after `_seed_rows_from_services` (ends `:609`).
- Test: `backend/tests/test_bw_native_seeder.py` (create)

**Interfaces:**
- Consumes:
  - M1: `catalog.bw_keys.is_bw_sample`, `catalog.bw_native_seed.BW_NATIVE_PROFILE_KEY` / `seed_bw_native_catalog`.
  - M2: `ROLE_TO_WP_KEYS["hplc"]` containing `bacteriostatic-water-panel`.
- Produces:
  - `_seed_native_bw_rows(db, *, sub_sample, existing_kw, existing_service_ids, created_by_user_id, commit) -> list[LimsAnalysis]`.
  - A native-born BW hplc vial carries vial-tier rows `PH-BW` / `BENZYL-ALCOHOL-BW` / `FILL-VOLUME-BW` with `slot=None` and `peptide_id=None`, ready for bench entry, then `promote_to_parent`, then canonical parent rows.

**Design ruling taken here (Handler sign-off needed, see Notes item 1):**
- The spec says the vial "seeds nothing" and the panel is parent-tier.
- origin/master cannot take a result on a parent-tier `ordered` row and certify it.
- So the native panel follows the heavy-metals / native endo-PCR model: rows on the vial, promoted to the parent.
- If none are found, fail loud means log ERROR and return []. Do not raise. This is the house style of `seeder.native_hplc.no_analyte_slots` (`hplc_native.py:288`) and `seeder.mirror.no_analytical_dept` (`seeder.py:474`).
- A raise inside `set_assignment_role(commit=False)` would roll back a physical vial's check-in.

- [ ] **Step 1: Write the failing test**
```python
# backend/tests/test_bw_native_seeder.py
"""seed_analyses_for_vial on a native-born Bac Water parent's hplc vial seeds
the bacteriostatic-water-panel members on the VIAL (spec 2026-10-05 MB4, as
ruled in the plan: parent-tier 'ordered' rows cannot carry a result). The
SENAITE-born BW mirror and the native peptide trio paths are unchanged."""
import json
import logging

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import AnalysisProfile, Base, Department, LimsSample, LimsSubSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _catalog(db):
    from catalog.bw_native_seed import seed_bw_native_catalog
    db.add(Department(name="Analytical"))
    db.commit()
    seed_bw_native_catalog(db)


def _parent(db, *, system, sample_id, title="Bacteriostatic Water"):
    p = LimsSample(sample_id=sample_id, external_lims_system=system, sample_type_title=title,
                   external_lims_uid=None if system == "mk1" else f"uid-{sample_id}",
                   analytes=json.dumps([{"name": "Benzyl Alcohol", "declared_quantity": "30"}]))
    db.add(p)
    db.flush()
    return p


def _vial(db, parent, seq=1):
    v = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                      parent_sample_pk=parent.id, external_lims_uid=f"zz-{parent.sample_id}-{seq}",
                      assignment_role="hplc")
    db.add(v)
    db.flush()
    return v


NATIVE_WP = {"bacteriostatic-water-panel": True, "endotoxin-usp85-lal": True}


def test_native_bw_vial_seeds_panel_not_mirror_not_peptide_trio(db, monkeypatch):
    from lims_analyses import hplc_native, seeder
    _catalog(db)
    called = []
    monkeypatch.setattr(seeder, "mirror_parent_hplc_analyses", lambda *a, **k: called.append("mirror") or [])
    monkeypatch.setattr(hplc_native, "seed_native_hplc_rows", lambda *a, **k: called.append("trio") or [])
    p = _parent(db, system="mk1", sample_id="BW-1000")
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP,
                                         commit=False)
    assert called == []
    assert sorted((r.keyword, r.slot, r.peptide_id, r.lims_sub_sample_pk) for r in rows) == [
        ("BENZYL-ALCOHOL-BW", None, None, v.id), ("FILL-VOLUME-BW", None, None, v.id),
        ("PH-BW", None, None, v.id)]


def test_native_bw_vial_seed_is_idempotent(db):
    from lims_analyses import seeder
    _catalog(db)
    p = _parent(db, system="mk1", sample_id="BW-1001")
    v = _vial(db, p)
    first = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP, commit=False)
    second = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP, commit=False)
    assert len(first) == 3 and second == []


def test_native_bw_vial_without_panel_logs_error_and_does_not_raise(db, caplog):
    from lims_analyses import seeder
    db.add(Department(name="Analytical"))
    db.commit()   # no BW seed: profile absent
    p = _parent(db, system="mk1", sample_id="BW-1002")
    v = _vial(db, p)
    with caplog.at_level(logging.ERROR):
        rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP,
                                             commit=False)
    assert rows == []
    assert any("seeder.native_bw.no_panel_members" in r.message for r in caplog.records)


def test_native_bw_vial_with_non_mk1_member_seeds_nothing(db, caplog):
    """Origin gate (same as every catalog family): a mixed-origin panel is not native."""
    from lims_analyses import seeder
    from models import AnalysisService
    _catalog(db)
    prof = db.query(AnalysisProfile).filter_by(key="bacteriostatic-water-panel").one()
    prof.analysis_services.append(AnalysisService(title="x", keyword="PH-DETERM", origin="senaite"))
    db.commit()
    p = _parent(db, system="mk1", sample_id="BW-1003")
    v = _vial(db, p)
    with caplog.at_level(logging.ERROR):
        rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP,
                                             commit=False)
    assert rows == []
    assert any("seeder.native_bw.no_panel_members" in r.message for r in caplog.records)


def test_senaite_born_bw_vial_still_uses_the_mirror(db, monkeypatch):
    from lims_analyses import seeder
    _catalog(db)
    seen = {}

    def fake_mirror(db_, *, sub_sample, parent_sample_id, **k):
        seen["parent"] = parent_sample_id
        return []
    monkeypatch.setattr(seeder, "mirror_parent_hplc_analyses", fake_mirror)
    p = _parent(db, system="senaite", sample_id="BW-0135")
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc",
                                         wp_services={"bac_water_panel": True},
                                         parent_sample_id=p.sample_id, commit=False)
    assert seen == {"parent": "BW-0135"} and rows == []


def test_native_peptide_vial_still_uses_the_trio_path(db, monkeypatch):
    from lims_analyses import hplc_native, seeder
    _catalog(db)
    called = []
    monkeypatch.setattr(hplc_native, "seed_native_hplc_rows", lambda *a, **k: called.append("trio") or [])
    p = _parent(db, system="mk1", sample_id="P-5004", title="Peptide")
    v = _vial(db, p)
    seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc",
                                  wp_services={"hplc-purity-identity": True}, commit=False)
    assert called == ["trio"]
```

- [ ] **Step 2: Run it, expect FAIL**
Run: `cd backend && python -m pytest tests/test_bw_native_seeder.py -q`
Expected: FAIL in:
- `test_native_bw_vial_seeds_panel_not_mirror_not_peptide_trio`: `called == ["trio"]`. Today the native fork sends BW into `seed_native_hplc_rows`.
- `test_native_bw_vial_seed_is_idempotent`
- both `no_panel_members` tests

The senaite-born and native-peptide pins pass already, since they are legacy pins.

- [ ] **Step 3: Implement**

`backend/lims_analyses/seeder.py`. Current `:736-747`:
```python
    if role == "hplc":
        from lims_analyses.hplc_native import is_native_born, seed_native_hplc_rows
        parent = sub_sample.parent_sample if sub_sample.parent_sample_pk else None
        if parent is not None and is_native_born(parent):
            # Native-born (spec 2026-09-10 M4): no SENAITE AR to mirror -- the
            # trio per analyte slot comes from lims_samples.analytes.
            inserted = seed_native_hplc_rows(
                db, sub_sample=sub_sample, parent=parent,
                existing_keys=existing_kw, existing_service_ids=existing_service_ids,
                created_by_user_id=created_by_user_id, commit=commit,
            )
        else:
```
New:
```python
    if role == "hplc":
        from catalog.bw_keys import is_bw_sample
        from lims_analyses import hplc_native
        parent = sub_sample.parent_sample if sub_sample.parent_sample_pk else None
        if parent is not None and hplc_native.is_native_born(parent) and is_bw_sample(parent):
            # Native-born Bac Water (spec 2026-10-05 MB4, as ruled in the
            # plan): the panel is seeded HERE on the vial and promoted like
            # every other native family. A parent-tier 'ordered' placeholder
            # cannot take a result (state_machine TIER_PARENT has no submit)
            # and native_sections certifies only promoted canonical rows.
            inserted = _seed_native_bw_rows(
                db, sub_sample=sub_sample,
                existing_kw=existing_kw, existing_service_ids=existing_service_ids,
                created_by_user_id=created_by_user_id, commit=commit,
            )
        elif parent is not None and hplc_native.is_native_born(parent):
            # Native-born (spec 2026-09-10 M4): no SENAITE AR to mirror; the
            # trio per analyte slot comes from lims_samples.analytes.
            inserted = hplc_native.seed_native_hplc_rows(
                db, sub_sample=sub_sample, parent=parent,
                existing_keys=existing_kw, existing_service_ids=existing_service_ids,
                created_by_user_id=created_by_user_id, commit=commit,
            )
        else:
```
The `else:` mirror branch and the `_seed_rider_members` tail (`:747-772`) are unchanged.

Module-attribute access (`hplc_native.seed_native_hplc_rows`) replaces the `from ... import` so the test's monkeypatch reaches the call. The existing `test_hplc_native_seeder.py` tests do not patch it, and behave identically.

New helper, inserted after `_seed_rows_from_services` (`:567-609`):
```python
def _seed_native_bw_rows(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    existing_kw: set,
    existing_service_ids: set,
    created_by_user_id: Optional[int],
    commit: bool,
) -> List[LimsAnalysis]:
    """Seed the bacteriostatic-water-panel members on a native-born BW hplc
    vial, through the same per-profile origin gate as every catalog family.
    Live profile membership, like seed_native_hplc_rows' native_hplc_services
    read. No members (profile missing, empty, or mixed-origin) is logged as an
    ERROR and seeds nothing: never raised, because set_assignment_role runs
    this inside the vial check-in transaction."""
    from catalog.bw_native_seed import BW_NATIVE_PROFILE_KEY

    prof = db.query(AnalysisProfile).filter_by(key=BW_NATIVE_PROFILE_KEY).one_or_none()
    services = (
        _members_through_origin_gate([(prof, prof.key, prof.analysis_services)])
        if prof is not None else []
    )
    if not services:
        log.error(
            "seeder.native_bw.no_panel_members sub=%s profile=%s: native-born "
            "Bac Water vial seeded nothing; check the catalog seed",
            sub_sample.sample_id, BW_NATIVE_PROFILE_KEY,
        )
        return []
    return _seed_rows_from_services(
        db,
        sub_sample=sub_sample,
        services=services,
        existing_kw=existing_kw,
        existing_service_ids=existing_service_ids,
        created_by_user_id=created_by_user_id,
        commit=commit,
        log_event="native_bw_seeded",
    )
```

- [ ] **Step 4: Run, expect PASS**
Run, one after another:
- `cd backend && python -m pytest tests/test_bw_native_seeder.py tests/test_hplc_native_seeder.py tests/test_catalog_seeding.py tests/test_custody_edges.py -q`
- `cd backend && python -m pytest tests/test_identity_convergence_guard.py tests/test_lims_analyses_seeder.py -q`

Expected: PASS. The guard failure set is unchanged against master, since no new `.keyword` comparison was added.

Then run the full backend suite once, and diff its failure set against a master run made in the same window.

- [ ] **Step 5: Commit**
```bash
git add -- backend/lims_analyses/seeder.py backend/tests/test_bw_native_seeder.py
git commit -m "feat(seeder): native-born Bac Water hplc vial seeds the panel for promote (MB4)" -- backend/lims_analyses/seeder.py backend/tests/test_bw_native_seeder.py
```

---


# Part 2: Accu-Mk1, COA wire (Tasks W1-W5; same PR as Part 1)

# Section: Accu-Mk1, COA wire (spec item MB5)

Code read at Accu-Mk1 `origin/master` = `e5852180` (release v1.31.2). COABuilder and IS were read at their `origin/master`.

## Files map

- `backend/coa/bw_shim.py` (Modify; M1 creates it): adds `is_native_bw_row`, `bw_wire_keyword` and `bw_wire_title`. These map a native BW row to the SENAITE keyword and title that COABuilder's `GenericAssayEngine` reads.
- `backend/main.py:3152-3154` (Modify): `COA_ARCHETYPES` accepts `legacy_bw`, so a profile PATCH no longer 400s.
- `backend/coa/native_sections.py:135-137` (Modify): `_ordered_native_profiles` skips `legacy_bw` the same way it skips `legacy_hplc`, so the BW profile is never a page-2 section.
- `backend/coa/legacy_rows.py:33-40, 116-136, 199-201, 224-225` (Modify): generalizes the page-1 admission gate to "native page-1 rows keyed by archetype", re-keys native BW rows to legacy vocabulary, and ships `specification`/`conforms` on them.
- `backend/coa/variance_series.py:24, 382-385` (Modify): variance series key native BW rows by the legacy keyword. This path is dormant today.
- `src/components/hplc/coa-archetype-options.ts:7` (Modify): adds the "Legacy (Bac Water page 1)" option.
- `backend/tests/test_bw_shim_wire.py` (Create): unit tests for the shim helpers.
- `backend/tests/test_bw_native_coa_archetype.py` (Create): the BW profile is never a page-2 section, and native endotoxin on a BW sample resolves the 0.25 EU/mL matrix tier.
- `backend/tests/test_bw_native_legacy_rows.py` (Create): the gate, re-keying, specs, real-DB end to end, and SENAITE-born BW byte-identical.
- `backend/tests/test_hplc_native_catalog_upgrade.py:188-192` (Modify): stale equality pin on `COA_ARCHETYPES`.
- `backend/tests/test_profile_coa_columns.py` (Modify): route test proving PATCH accepts `legacy_bw`.
- `backend/tests/test_variance_analyte_series.py` (Modify): native BW series keyed by the legacy keyword.
- `src/components/hplc/__tests__/coa-archetype-options.test.ts` (Modify): pins the new option.

**Design decision: generalize, do not twin.** `native_hplc_service_archetypes` (`coa/hplc_shim.py:66-119`) is HPLC only in name. It already returns `{service_id: coa_archetype}` for every ordered all-mk1 profile, so it maps the BW services to `legacy_bw` with no change.

- A BW twin would duplicate about 55 lines: the IS lookup, the lab-added union, the disagreement log and the "can't tell" contract.
- The smaller correct diff is one module-level helper, `_page_one_archetype(row)`. It returns `legacy_hplc` for a native HPLC row, `legacy_bw` for a native BW row, and `None` otherwise. `_rides_page_one` then compares the resolved mapping against that row-specific archetype.
- The resolver keeps its current name, because existing tests monkeypatch `lr.native_hplc_service_archetypes` (`tests/test_hplc_native_coa_archetype_routing.py:69-127`). Renaming it would churn those tests for no behaviour change.
- A native BW row whose service is ABSENT from the mapping is admitted, the same "can't tell" rule as HPLC slice 7. Without that, a native BW sample whose IS lookup 404s would hit the zero-legacy-rows abort with no BW rows at all. The primary-COA path already fail-closes on that same IS lookup in `native_sections` Rule 1.
- `admitted_native` and the `slot_wires`/`empty_slots` block stay HPLC only.

---

### Task W1: bw_shim wire helpers

**Repo:** Accu-Mk1
**Files:**
- Modify: `backend/coa/bw_shim.py` (append below M1's constants)
- Test: `backend/tests/test_bw_shim_wire.py`

**Interfaces:**
- Consumes: from M1, in `coa.bw_shim`: `BW_NATIVE_KEYWORDS: frozenset[str]` = {"PH-BW","BENZYL-ALCOHOL-BW","FILL-VOLUME-BW"}, and `NATIVE_TO_LEGACY_KEYWORD: dict[str, str]` = {"PH-BW":"PH-DETERM","BENZYL-ALCOHOL-BW":"Benzyl_Alcohol_Assay","FILL-VOLUME-BW":"FILL-NET-CONTENT"}.
- Produces:
  - `is_native_bw_row(row) -> bool`
  - `bw_wire_keyword(keyword: str) -> str`, which raises `ValueError` on a non-BW keyword
  - `bw_wire_title(db, keyword: str, row_title: str) -> str`
- Constraint: `coa.bw_shim` must not import `coa.native_sections`, `coa.hplc_shim` or `coa.legacy_rows` at module level. `main.py` and `native_sections` import it, and a module-level import back would cycle (the same reason `native_sections.py:135` imports `hplc_shim` locally).

- [ ] **Step 1: Write the failing test**
```python
"""MB5: coa/bw_shim.py wire helpers. A native-born Bac Water row rides the
legacy-rows wire under the SENAITE keyword/title COABuilder's
GenericAssayEngine already reads (spec 2026-10-05 MB5)."""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from coa.bw_shim import (
    BW_NATIVE_KEYWORDS, bw_wire_keyword, bw_wire_title, is_native_bw_row,
)
from database import Base


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.mark.parametrize("kw,expected", [
    ("PH-BW", "PH-DETERM"),
    ("BENZYL-ALCOHOL-BW", "Benzyl_Alcohol_Assay"),
    ("FILL-VOLUME-BW", "FILL-NET-CONTENT"),
    ("ph-bw", "PH-DETERM"),
])
def test_bw_wire_keyword_table(kw, expected):
    assert bw_wire_keyword(kw) == expected


def test_every_native_keyword_has_a_wire_keyword():
    assert {bw_wire_keyword(k) for k in BW_NATIVE_KEYWORDS} == {
        "PH-DETERM", "Benzyl_Alcohol_Assay", "FILL-NET-CONTENT"}


@pytest.mark.parametrize("kw", ["PH-DETERM", "HPLC-PURITY", "", None])
def test_bw_wire_keyword_rejects_non_bw(kw):
    with pytest.raises(ValueError):
        bw_wire_keyword(kw)


@pytest.mark.parametrize("origin,kw,expected", [
    ("mk1", "PH-BW", True),
    ("mk1", "benzyl-alcohol-bw", True),
    ("mk1", "FILL-VOLUME-BW", True),
    ("senaite", "PH-BW", False),
    ("mk1", "PH-DETERM", False),
    ("mk1", "HPLC-PURITY", False),
    (None, "PH-BW", False),
    ("mk1", None, False),
])
def test_is_native_bw_row(origin, kw, expected):
    assert is_native_bw_row(SimpleNamespace(service_origin=origin, keyword=kw)) is expected


def test_bw_wire_title_reads_the_legacy_senaite_service_title(db):
    from models import AnalysisService
    db.add_all([
        AnalysisService(title="pH Determination", keyword="PH-DETERM", origin="senaite"),
        AnalysisService(title="pH (native)", keyword="PH-BW", origin="mk1"),
    ])
    db.flush()
    assert bw_wire_title(db, "PH-BW", "pH (native)") == "pH Determination"


def test_bw_wire_title_ignores_a_same_keyword_mk1_service(db):
    # uq_analysis_services_mk1_keyword is partial on origin='mk1', so an mk1
    # row may share the legacy keyword string; only origin='senaite' counts.
    from models import AnalysisService
    db.add(AnalysisService(title="decoy", keyword="PH-DETERM", origin="mk1"))
    db.flush()
    assert bw_wire_title(db, "PH-BW", "pH (native)") == "pH (native)"


def test_bw_wire_title_is_deterministic_lowest_id_wins(db):
    from models import AnalysisService
    db.add(AnalysisService(title="Fill volume / Net content",
                           keyword="FILL-NET-CONTENT", origin="senaite"))
    db.flush()
    db.add(AnalysisService(title="Fill / Net Content",
                           keyword="FILL-NET-CONTENT", origin="senaite"))
    db.flush()
    assert bw_wire_title(db, "FILL-VOLUME-BW", "x") == "Fill volume / Net content"


def test_bw_wire_title_falls_back_without_a_catalog():
    assert bw_wire_title(None, "PH-BW", "pH (native)") == "pH (native)"
```
- [ ] **Step 2: Run it, expect FAIL**
Run: `cd backend && python -m pytest tests/test_bw_shim_wire.py -q`  Expected: FAIL with `ImportError: cannot import name 'bw_wire_keyword' from 'coa.bw_shim'`.
- [ ] **Step 3: Implement** (append to `backend/coa/bw_shim.py`, below M1's `NATIVE_TO_LEGACY_KEYWORD`)
```python
# --- COA wire (MB5) ---------------------------------------------------------
# A native BW row rides coa/legacy_rows.py's page-1 wire under the SENAITE
# keyword/title COABuilder's GenericAssayEngine already reads (baked-spec
# fallback, technique column, variance keying). This module is the ONE place
# that mapping lives. Keep it import-light: main.py and native_sections import
# it, so it must never import coa.native_sections / coa.hplc_shim /
# coa.legacy_rows at module level.


def is_native_bw_row(row) -> bool:
    """A native-born Bac Water panel row: an mk1-origin service carrying one
    of the native BW keywords. Twin of coa.hplc_shim.is_native_hplc_row."""
    return (getattr(row, "service_origin", None) == "mk1"
            and (getattr(row, "keyword", "") or "").upper() in BW_NATIVE_KEYWORDS)


def bw_wire_keyword(keyword: str) -> str:
    """Native BW keyword -> the legacy SENAITE keyword on the wire."""
    try:
        return NATIVE_TO_LEGACY_KEYWORD[(keyword or "").upper()]
    except KeyError:
        raise ValueError(f"not a native BW keyword: {keyword!r}") from None


def bw_wire_title(db, keyword: str, row_title: str) -> str:
    """The title the legacy SENAITE service carries for this row's wire
    keyword, read from the Mk1 catalog (origin='senaite' only; lowest id wins
    for determinism), so a native row prints the same test name a SENAITE-born
    BW certificate prints. Falls back to the native row's own title when there
    is no catalog to consult (db=None, the unit-test seam legacy_rows already
    tolerates) or no legacy service row exists."""
    if db is None:
        return row_title
    from sqlalchemy import select

    from models import AnalysisService
    title = db.execute(
        select(AnalysisService.title).where(
            AnalysisService.keyword == bw_wire_keyword(keyword),
            AnalysisService.origin == "senaite",
        ).order_by(AnalysisService.id)
    ).scalars().first()
    return title or row_title
```
- [ ] **Step 4: Run, expect PASS**
Run: `cd backend && python -m pytest tests/test_bw_shim_wire.py -q`
- [ ] **Step 5: Commit**
```bash
git add -- backend/coa/bw_shim.py backend/tests/test_bw_shim_wire.py
git commit -m "feat(coa): bw_shim wire keyword/title helpers for native Bac Water rows" -- backend/coa/bw_shim.py backend/tests/test_bw_shim_wire.py
```

---

### Task W2: legacy_bw is a legal archetype and never a page-2 section

**Repo:** Accu-Mk1
**Files:**
- Modify: `backend/main.py:3152-3154`
- Modify: `backend/coa/native_sections.py:135-137`
- Modify: `backend/tests/test_hplc_native_catalog_upgrade.py:188-192`. This is a stale pin: it asserts strict equality of `COA_ARCHETYPES`.
- Modify: `backend/tests/test_profile_coa_columns.py` (append one test)
- Test: `backend/tests/test_bw_native_coa_archetype.py`

**Interfaces:**
- Consumes:
  - `coa.bw_shim.LEGACY_BW_ARCHETYPE == "legacy_bw"` (from M1)
  - `catalog.bw_native_seed.seed_bw_native_catalog(db)`, from M1. It seeds the three native BW services, the R4 wildcard specs, and the profile `bacteriostatic-water-panel` (inactive, `coa_archetype="legacy_bw"`, members = the three services).
- Produces: `main.COA_ARCHETYPES == {"limit_table", "legacy_hplc", "legacy_bw"}`. `_ordered_native_profiles(require_archetype=True)` excludes `legacy_bw` profiles.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_bw_native_coa_archetype.py`:
```python
"""MB5: the bacteriostatic-water-panel profile (coa_archetype legacy_bw)
rides page 1 via coa/bw_shim.py and must never surface as a native_sections
page-2 section (COABuilder aborts on an unknown archetype). A native
endotoxin row on the same BW sample still resolves the 'Bacteriostatic
Water' matrix tier (0-0.25 EU/mL), not the 0-5 wildcard. Real sqlite
catalog; fetch_sample_services monkeypatched (live IS pass-through)."""
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from coa.bw_shim import BW_NATIVE_KEYWORDS, LEGACY_BW_ARCHETYPE
from coa.native_sections import _ordered_native_profiles, build_native_sections
from database import Base

BW_PROFILE_KEY = "bacteriostatic-water-panel"
ENDO_PROFILE_KEY = "endotoxin-usp85-lal"


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _endotoxin(db):
    from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec,
                        analysis_profile_members)
    prof = AnalysisProfile(key=ENDO_PROFILE_KEY, name="Endotoxin", is_addon=True,
                           coa_archetype="limit_table", coa_sort_order=10)
    svc = AnalysisService(title="Endotoxin (USP<85> LAL)", keyword="ENDOTOXIN-USP85LAL",
                          origin="mk1", unit="EU/mL")
    db.add_all([prof, svc])
    db.flush()
    db.execute(analysis_profile_members.insert().values(
        analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=0))
    # Prod shape (verified 2026-10-05): wildcard 0-5 plus ONE matrix tier.
    db.add_all([
        AnalysisServiceSpec(analysis_service_id=svc.id, matrix=None,
                            rule_kind="range", max_value=Decimal("5"), unit="EU/mL"),
        AnalysisServiceSpec(analysis_service_id=svc.id, matrix="Bacteriostatic Water",
                            rule_kind="range", max_value=Decimal("0.25"), unit="EU/mL"),
    ])
    db.flush()
    return svc


def _verified(db, parent, svc, value):
    from models import LimsAnalysis
    db.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title, result_value=value,
        result_unit=svc.unit, review_state="verified", provenance="canonical",
    ))
    db.flush()


def _native_bw_sample(db, monkeypatch, *, endo_result):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisService, LimsSample
    seed_bw_native_catalog(db)
    endo = _endotoxin(db)
    parent = LimsSample(sample_id="BW-1001", external_lims_system="mk1",
                        sample_type_title="Bacteriostatic Water")
    db.add(parent)
    db.flush()
    for kw, value in (("PH-BW", "5.5"), ("BENZYL-ALCOHOL-BW", "0.90"),
                      ("FILL-VOLUME-BW", "10.1")):
        svc = db.query(AnalysisService).filter_by(keyword=kw, origin="mk1").one()
        _verified(db, parent, svc, value)
    _verified(db, parent, endo, endo_result)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {BW_PROFILE_KEY: True, ENDO_PROFILE_KEY: True},
                           "package": None},
    )
    return parent


def test_seeded_bw_profile_carries_legacy_bw(db):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisProfile
    seed_bw_native_catalog(db)
    prof = db.query(AnalysisProfile).filter_by(key=BW_PROFILE_KEY).one()
    assert prof.coa_archetype == LEGACY_BW_ARCHETYPE == "legacy_bw"
    assert {s.keyword for s in prof.analysis_services} == set(BW_NATIVE_KEYWORDS)


def test_legacy_bw_profile_excluded_from_reportable_profiles(db):
    from catalog.bw_native_seed import seed_bw_native_catalog
    seed_bw_native_catalog(db)
    assert _ordered_native_profiles(db, {BW_PROFILE_KEY: True}, None) == []
    # Placeholder path (require_archetype=False) still sees it: archetype is
    # a rendering concern, never a visibility one.
    assert [p.key for p in _ordered_native_profiles(
        db, {BW_PROFILE_KEY: True}, None, require_archetype=False)] == [BW_PROFILE_KEY]


def test_bw_panel_never_a_page_two_section_endotoxin_uses_bw_tier(db, monkeypatch):
    parent = _native_bw_sample(db, monkeypatch, endo_result="0.2")
    doc = build_native_sections(db, parent)
    assert doc["ordered_profiles"] == [ENDO_PROFILE_KEY]
    [section] = doc["sections"]
    assert section["profile_key"] == ENDO_PROFILE_KEY
    [row] = section["rows"]
    assert row["keyword"] == "ENDOTOXIN-USP85LAL"
    assert row["specification"]["max"] == 0.25
    assert row["conforms"] is True


def test_endotoxin_above_bw_tier_fails_even_though_under_wildcard(db, monkeypatch):
    # 0.3 passes the 5 EU/mL wildcard; failing here proves the matrix tier won.
    parent = _native_bw_sample(db, monkeypatch, endo_result="0.3")
    [section] = build_native_sections(db, parent)["sections"]
    [row] = section["rows"]
    assert row["specification"]["max"] == 0.25
    assert row["conforms"] is False
```

Append to `backend/tests/test_profile_coa_columns.py`:
```python
def test_profile_coa_archetype_accepts_legacy_bw():
    r = client.post("/analysis-profiles", json={
        "key": "bw_legacy_arch_test", "name": "BW Arch", "is_addon": True,
    })
    assert r.status_code == 201, r.text
    r = client.patch(f"/analysis-profiles/{r.json()['id']}",
                     json={"coa_archetype": "legacy_bw"})
    assert r.status_code == 200, r.text
    assert r.json()["coa_archetype"] == "legacy_bw"
```

Replace `backend/tests/test_hplc_native_catalog_upgrade.py:188-192`. Current lines:
```python
def test_coa_archetypes_accepts_legacy_hplc_and_rejects_bogus():
    from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
    from main import COA_ARCHETYPES
    assert COA_ARCHETYPES == {"limit_table", LEGACY_HPLC_ARCHETYPE}
    assert "bogus" not in COA_ARCHETYPES
```
New lines:
```python
def test_coa_archetypes_accepts_legacy_hplc_and_rejects_bogus():
    from coa.bw_shim import LEGACY_BW_ARCHETYPE
    from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
    from main import COA_ARCHETYPES
    assert COA_ARCHETYPES == {"limit_table", LEGACY_HPLC_ARCHETYPE, LEGACY_BW_ARCHETYPE}
    assert "bogus" not in COA_ARCHETYPES
```
- [ ] **Step 2: Run them, expect FAIL** (one pytest process at a time)
  - Run: `cd backend && python -m pytest tests/test_bw_native_coa_archetype.py -q`. Expected: FAIL in `test_legacy_bw_profile_excluded_from_reportable_profiles` and in both `build_native_sections` tests. `ordered_profiles` contains `bacteriostatic-water-panel`, because the profile renders as a `legacy_bw` section.
  - Run: `cd backend && python -m pytest tests/test_hplc_native_catalog_upgrade.py -q`. Expected: FAIL on the set equality, because `legacy_bw` is missing.
  - Run: `cd backend && python -m pytest tests/test_profile_coa_columns.py -q`. Expected: FAIL with `400 unknown coa_archetype 'legacy_bw'`. This hits the host dev Postgres.
- [ ] **Step 3: Implement**

`backend/main.py`, current lines 3152-3154:
```python
from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE

COA_ARCHETYPES = {"limit_table", LEGACY_HPLC_ARCHETYPE}
```
New lines:
```python
from coa.bw_shim import LEGACY_BW_ARCHETYPE
from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE

# legacy_bw (MB5) is owned by coa/bw_shim.py on the same terms as legacy_hplc.
COA_ARCHETYPES = {"limit_table", LEGACY_HPLC_ARCHETYPE, LEGACY_BW_ARCHETYPE}
```

`backend/coa/native_sections.py`, current lines 135-137:
```python
            from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
            if prof.coa_archetype is None or prof.coa_archetype == LEGACY_HPLC_ARCHETYPE:
                continue
```
New lines:
```python
            # MB5: legacy_bw rides page 1 via coa/bw_shim.py on the same terms.
            from coa.bw_shim import LEGACY_BW_ARCHETYPE
            from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
            if prof.coa_archetype in (None, LEGACY_HPLC_ARCHETYPE, LEGACY_BW_ARCHETYPE):
                continue
```
- [ ] **Step 4: Run, expect PASS** (sequentially, never two pytest processes at once)
  - `cd backend && python -m pytest tests/test_bw_native_coa_archetype.py -q`
  - `cd backend && python -m pytest tests/test_hplc_native_catalog_upgrade.py tests/test_hplc_native_coa_archetype_routing.py tests/test_native_sections.py tests/test_native_sections_lab_added.py -q`. This is the legacy and HPLC routing regression set.
  - `cd backend && python -m pytest tests/test_profile_coa_columns.py -q`
- [ ] **Step 4b: Line-ending check.** `backend/tests/test_hplc_native_catalog_upgrade.py` is CRLF at origin/master; every other file this section touches is LF. Keep CRLF on that file. Run: `git -c core.autocrlf=true diff --stat -- backend/tests/test_hplc_native_catalog_upgrade.py`. Expected: about 3 changed lines. A whole-file count means the line endings flipped.
- [ ] **Step 5: Commit**
```bash
git add -- backend/main.py backend/coa/native_sections.py backend/tests/test_bw_native_coa_archetype.py backend/tests/test_hplc_native_catalog_upgrade.py backend/tests/test_profile_coa_columns.py
git commit -m "feat(coa): legacy_bw COA archetype, accepted by profile PATCH and never a page-2 section" -- backend/main.py backend/coa/native_sections.py backend/tests/test_bw_native_coa_archetype.py backend/tests/test_hplc_native_catalog_upgrade.py backend/tests/test_profile_coa_columns.py
```

---

### Task W3: Profile editor offers "Legacy (Bac Water page 1)"

**Repo:** Accu-Mk1
**Files:**
- Modify: `src/components/hplc/coa-archetype-options.ts:7`
- Test: `src/components/hplc/__tests__/coa-archetype-options.test.ts`

**Interfaces:**
- Consumes: `legacy_bw` accepted by the PATCH route (W2).
- Produces: `COA_ARCHETYPE_OPTIONS` gains `{ value: 'legacy_bw', label: 'Legacy (Bac Water page 1)' }`. `AnalysisProfilesPage.tsx:1058` maps the array, so no page change is needed.

- [ ] **Step 1: Write the failing test** (replace the file body)
```ts
import { describe, it, expect } from 'vitest'
import { COA_ARCHETYPE_OPTIONS } from '../coa-archetype-options'

describe('COA_ARCHETYPE_OPTIONS', () => {
  it('offers not-reported, limit_table, legacy_hplc and legacy_bw in that select order', () => {
    expect(COA_ARCHETYPE_OPTIONS).toEqual([
      { value: 'none', label: 'Not reported' },
      { value: 'limit_table', label: 'Limit table' },
      { value: 'legacy_hplc', label: 'Legacy (HPLC page 1)' },
      { value: 'legacy_bw', label: 'Legacy (Bac Water page 1)' },
    ])
  })
})
```
- [ ] **Step 2: Run it, expect FAIL**
Run: `npm run test:run -- src/components/hplc/__tests__/coa-archetype-options.test.ts`  Expected: FAIL, because the `legacy_bw` entry is missing from the received array.
- [ ] **Step 3: Implement.** In `src/components/hplc/coa-archetype-options.ts`, after line 7 (`  { value: 'legacy_hplc', label: 'Legacy (HPLC page 1)' },`), add:
```ts
  { value: 'legacy_bw', label: 'Legacy (Bac Water page 1)' },
```
- [ ] **Step 4: Run, expect PASS**
  - `npm run test:run -- src/components/hplc/__tests__/coa-archetype-options.test.ts`
  - Then run `npm run typecheck && npm run lint && npm run format:check`.
- [ ] **Step 5: Commit**
```bash
git add -- src/components/hplc/coa-archetype-options.ts src/components/hplc/__tests__/coa-archetype-options.test.ts
git commit -m "feat(catalog): offer the legacy_bw COA archetype in the profile editor" -- src/components/hplc/coa-archetype-options.ts src/components/hplc/__tests__/coa-archetype-options.test.ts
```

---

### Task W4: legacy_rows admits native BW rows on page 1, re-keyed, with specs

**Repo:** Accu-Mk1
**Files:**
- Modify: `backend/coa/legacy_rows.py:29` (docstring), `:33-36` (imports), `:116-127` (gate), `:136` (`admitted_native`), `:199-201` (re-key), `:224-225` (spec fields)
- Test: `backend/tests/test_bw_native_legacy_rows.py`

**Interfaces:**
- Consumes:
  - From W1: `is_native_bw_row`, `bw_wire_keyword`, `bw_wire_title`.
  - From M1: `LEGACY_BW_ARCHETYPE` and `seed_bw_native_catalog`. The R4 wildcard specs must exist on the native services: `PH-BW` range 4.5-7.0, `BENZYL-ALCOHOL-BW` range 0.72-1.08 (% (v/v), display "0.9% (v/v) ±20%"), `FILL-VOLUME-BW` informational.
  - Existing: `native_hplc_service_archetypes` (unchanged) and `_native_spec_fields` (unchanged).
- Produces: `build_legacy_rows(db, parent)` emits native BW rows under `Keyword` in {`PH-DETERM`, `Benzyl_Alcohol_Assay`, `FILL-NET-CONTENT`}. It does so when the owning profile's archetype is `legacy_bw`, or when the mapping cannot tell. Each such row carries `specification`/`conforms`. SENAITE-born output is unchanged.

- [ ] **Step 1: Write the failing test**
```python
"""MB5: native-born Bac Water rows ride the page-1 legacy-rows wire under
the SENAITE keyword/title GenericAssayEngine reads, gated by the owning
profile's coa_archetype (legacy_bw), carrying Mk1-owned specification +
conforms. SENAITE-born BW stays byte-identical.

Note: before this task no legacy_rows test exercised the BW keywords at
all; the SENAITE-born byte-identical pin below is new."""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import coa.legacy_rows as lr
from coa.bw_shim import LEGACY_BW_ARCHETYPE
from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
from coa.legacy_rows import build_legacy_rows
from coa.native_sections import NativeSectionsError
from database import Base

BW_PROFILE_KEY = "bacteriostatic-water-panel"
LEGACY_TITLES = {
    "PH-DETERM": "pH Determination",
    "Benzyl_Alcohol_Assay": "Benzyl Alcohol Assay (HPLC)",
    "FILL-NET-CONTENT": "Fill volume / Net content",
}


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


# ---------------- gate (unit, no DB; same idiom as the HPLC slice-8 tests) --

def _bw(**over):
    base = dict(
        uid="mk1:11", keyword="PH-BW", title="pH Determination", result="5.5", unit="pH",
        review_state="verified", captured="2026-10-05T00:00:00+00:00",
        service_origin="mk1", peptide_id=None, slot=None, analysis_service_id=951,
    )
    base.update(over)
    return SimpleNamespace(**base)


def _senaite(**over):
    base = dict(
        uid="a" * 32, keyword="PH-DETERM", title="pH Determination", result="5.5",
        unit="", review_state="published", captured="2026-10-05T00:00:00+00:00",
        service_origin="senaite", peptide_id=None, slot=None, analysis_service_id=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


_PARENT = SimpleNamespace(sample_id="BW-1001", external_lims_system="mk1",
                          sample_type_title="Bacteriostatic Water")


def _no_slot_wires(db, parent):
    raise AssertionError("slot_wires must not run for a BW-only sample")


def test_legacy_bw_archetype_admits_and_rekeys(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_bw()])
    monkeypatch.setattr(lr, "slot_wires", _no_slot_wires)
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {951: LEGACY_BW_ARCHETYPE})
    [row] = build_legacy_rows(None, _PARENT)
    assert (row["Keyword"], row["Title"], row["ServiceTitle"]) == ("PH-DETERM", "pH Determination", "pH Determination")


def test_limit_table_archetype_excludes_bw_rows(monkeypatch):
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {951: "limit_table"})
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_bw(), _senaite(keyword="ENDO-LAL")])
    assert [r["Keyword"] for r in build_legacy_rows(None, _PARENT)] == ["ENDO-LAL"]


def test_legacy_hplc_archetype_does_not_admit_a_bw_row(monkeypatch):
    # Archetype must match the ROW's family, not merely be "a legacy one".
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {951: LEGACY_HPLC_ARCHETYPE})
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_bw(), _senaite(keyword="ENDO-LAL")])
    assert [r["Keyword"] for r in build_legacy_rows(None, _PARENT)] == ["ENDO-LAL"]


def test_unresolvable_lookup_admits_bw_rows(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_bw()])
    monkeypatch.setattr(lr, "slot_wires", _no_slot_wires)
    monkeypatch.setattr(lr, "native_hplc_service_archetypes", lambda db, parent: None)
    assert [r["Keyword"] for r in build_legacy_rows(None, _PARENT)] == ["PH-DETERM"]


def test_senaite_born_bw_is_byte_identical_and_never_calls_resolver(monkeypatch):
    def _boom(db, parent):
        raise AssertionError("resolver must not run when no native row is present")
    monkeypatch.setattr(lr, "native_hplc_service_archetypes", _boom)
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _senaite(uid="u1", keyword="PH-DETERM", title="pH Determination",
                 result="5.5", unit=""),
        _senaite(uid="u2", keyword="Benzyl_Alcohol_Assay", title="Benzyl Alcohol Assay",
                 result="0.90", unit="v/v"),
        _senaite(uid="u3", keyword="FILL-NET-CONTENT", title="Fill volume / Net content",
                 result="10.1", unit="mL"),
    ])
    parent = SimpleNamespace(sample_id="BW-0130", sample_type_title="Bacteriostatic Water")
    assert build_legacy_rows(None, parent) == [
        {"uid": "u1", "Keyword": "PH-DETERM", "Title": "pH Determination",
         "ServiceTitle": "pH Determination", "Result": "5.5", "Unit": "",
         "review_state": "published", "ResultCaptureDate": "2026-10-05T00:00:00+00:00"},
        {"uid": "u2", "Keyword": "Benzyl_Alcohol_Assay", "Title": "Benzyl Alcohol Assay",
         "ServiceTitle": "Benzyl Alcohol Assay", "Result": "0.90", "Unit": "v/v",
         "review_state": "published", "ResultCaptureDate": "2026-10-05T00:00:00+00:00"},
        {"uid": "u3", "Keyword": "FILL-NET-CONTENT", "Title": "Fill volume / Net content",
         "ServiceTitle": "Fill volume / Net content", "Result": "10.1", "Unit": "mL",
         "review_state": "published", "ResultCaptureDate": "2026-10-05T00:00:00+00:00"},
    ]


# ---------------- real catalog + real row selection (end to end) ------------

def _native_bw_sample(db, monkeypatch, values=None):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisService, LimsAnalysis, LimsSample
    seed_bw_native_catalog(db)
    for kw, title in LEGACY_TITLES.items():
        db.add(AnalysisService(title=title, keyword=kw, origin="senaite"))
    parent = LimsSample(sample_id="BW-1001", external_lims_system="mk1",
                        sample_type_title="Bacteriostatic Water")
    db.add(parent)
    db.flush()
    values = values or {"PH-BW": "5.5", "BENZYL-ALCOHOL-BW": "0.9",
                        "FILL-VOLUME-BW": "10.1"}
    for kw, value in values.items():
        svc = db.query(AnalysisService).filter_by(keyword=kw, origin="mk1").one()
        db.add(LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title, result_value=value,
            result_unit=svc.unit, review_state="verified", provenance="canonical",
        ))
    db.flush()
    # native_hplc_service_archetypes imports this lazily from sub_samples.service.
    monkeypatch.setattr(
        "sub_samples.service.fetch_sample_services",
        lambda sample_id: {"services": {BW_PROFILE_KEY: True}, "package": None},
    )
    return parent


def test_native_bw_parent_yields_three_legacy_rows_with_specs(db, monkeypatch):
    parent = _native_bw_sample(db, monkeypatch)
    rows = {r["Keyword"]: r for r in build_legacy_rows(db, parent)}
    assert set(rows) == {"PH-DETERM", "Benzyl_Alcohol_Assay", "FILL-NET-CONTENT"}
    for kw, title in LEGACY_TITLES.items():
        assert rows[kw]["Title"] == rows[kw]["ServiceTitle"] == title

    ph, ba, fill = rows["PH-DETERM"], rows["Benzyl_Alcohol_Assay"], rows["FILL-NET-CONTENT"]
    assert (ph["Result"], ph["specification"]["rule_kind"], ph["specification"]["min"],
            ph["specification"]["max"], ph["conforms"]) == ("5.5", "range", 4.5, 7.0, True)
    assert (ba["Result"], ba["specification"]["rule_kind"], ba["specification"]["min"],
            ba["specification"]["max"], ba["conforms"]) == ("0.9", "range", 0.72, 1.08, True)
    # The printed spec cell must match legacy BW certificates exactly; COABuilder
    # prints wire `display` verbatim (native_sections._format_spec_display).
    assert ba["specification"]["display"] == "0.9% (v/v) ±20%"
    assert ph["specification"]["display"] == "4.5 – 7.0"
    assert fill["specification"]["display"] is None
    assert (fill["Result"], fill["specification"]["rule_kind"], fill["conforms"]) == (
        "10.1", "informational", None)


def test_out_of_range_ph_ships_conforms_false(db, monkeypatch):
    parent = _native_bw_sample(db, monkeypatch, values={"PH-BW": "7.5"})
    [ph] = build_legacy_rows(db, parent)
    assert (ph["Keyword"], ph["conforms"]) == ("PH-DETERM", False)


def test_pending_native_row_rides_with_no_result_and_unjudged(db, monkeypatch):
    # Review Focus 5: before promote, the parent holds only the registration
    # placeholder ('ordered', no result). It rides page 1 with Result None /
    # conforms None (COABuilder prints NOT TESTED / IN REVIEW); the unchanged
    # resolver pre-flight is what blocks generation.
    from models import LimsAnalysis
    parent = _native_bw_sample(db, monkeypatch, values={"PH-BW": "5.5"})
    row = db.query(LimsAnalysis).filter_by(keyword="PH-BW").one()
    row.result_value, row.review_state, row.provenance = None, "unassigned", "ordered"
    db.flush()
    [ph] = build_legacy_rows(db, parent)
    assert (ph["Keyword"], ph["Result"], ph["conforms"]) == ("PH-DETERM", None, None)
    assert ph["specification"]["rule_kind"] == "range"


def test_profile_rearchetyped_off_legacy_bw_removes_page_one_rows(db, monkeypatch):
    # The gate reads the REAL mapping: re-archetyping the profile away from
    # legacy_bw leaves zero page-1 rows, which hits the fail-closed empty abort.
    from models import AnalysisProfile
    parent = _native_bw_sample(db, monkeypatch)
    db.query(AnalysisProfile).filter_by(key=BW_PROFILE_KEY).one().coa_archetype = "limit_table"
    db.flush()
    with pytest.raises(NativeSectionsError, match="no legacy-family analyses"):
        build_legacy_rows(db, parent)
```
- [ ] **Step 2: Run it, expect FAIL**
Run: `cd backend && python -m pytest tests/test_bw_native_legacy_rows.py -q`  Expected: every native test FAILs. Before this task `_rides_page_one` admits only `is_native_hplc_row` rows, so BW-only samples raise `NativeSectionsError: ... no legacy-family analyses found`, and the mixed tests yield `['ENDO-LAL']` where `['PH-DETERM', ...]` is expected. The SENAITE-born pin and the two exclusion tests PASS already. They are regression pins.
- [ ] **Step 3: Implement** in `backend/coa/legacy_rows.py`.

Docstring: after line 29 (`(no catalog peptide) aborts generation rather than shipping a blank title.`), add:
```python

Native-born Bac Water rows (service_origin == 'mk1', keyword in
coa.bw_shim.BW_NATIVE_KEYWORDS) ride the same wire when their owning
profile's archetype is legacy_bw: coa/bw_shim.py maps them to the SENAITE
keyword/title GenericAssayEngine reads (PH-DETERM, Benzyl_Alcohol_Assay,
FILL-NET-CONTENT). They are parent-tier with no analyte slots, so the
slot_wires/empty_slots machinery below stays HPLC-only.
```

Imports. Current lines 33-36:
```python
from coa.hplc_shim import (
    LEGACY_HPLC_ARCHETYPE, UnresolvedNativeSlotError, is_native_hplc_row,
    native_hplc_service_archetypes, slot_wires, wire_keyword, wire_title,
)
```
New lines:
```python
from coa.bw_shim import (
    LEGACY_BW_ARCHETYPE, bw_wire_keyword, bw_wire_title, is_native_bw_row,
)
from coa.hplc_shim import (
    LEGACY_HPLC_ARCHETYPE, UnresolvedNativeSlotError, is_native_hplc_row,
    native_hplc_service_archetypes, slot_wires, wire_keyword, wire_title,
)
```

New module-level helper, inserted directly above `def build_legacy_rows(db, parent) -> list[dict]:` (line 95):
```python
def _page_one_archetype(r):
    """The coa_archetype that admits this native row onto page 1, or None
    for a row that never rides page 1 (SENAITE-origin, or a native service
    outside the HPLC and Bac Water shims, e.g. endotoxin/PCR/heavy metals,
    which belong to native_sections)."""
    if is_native_hplc_row(r):
        return LEGACY_HPLC_ARCHETYPE
    if is_native_bw_row(r):
        return LEGACY_BW_ARCHETYPE
    return None


```

Gate. Current lines 116-127:
```python
    archetype_by_service = (
        native_hplc_service_archetypes(db, parent)
        if any(is_native_hplc_row(r) for r in shaped) else {}
    ) or {}

    def _rides_page_one(r) -> bool:
        if not is_native_hplc_row(r):
            return False
        service_id = getattr(r, "analysis_service_id", None)
        if service_id is None or service_id not in archetype_by_service:
            return True
        return archetype_by_service[service_id] == LEGACY_HPLC_ARCHETYPE
```
New lines:
```python
    # MB5: generalized from HPLC-only to "native page-1 rows keyed by
    # archetype". native_hplc_service_archetypes already maps EVERY ordered
    # all-mk1 profile, so one lookup serves both families; each row must
    # match its OWN family's archetype (a legacy_hplc owner never admits a
    # BW row). Same "absent = can't tell = admit" rule for both.
    archetype_by_service = (
        native_hplc_service_archetypes(db, parent)
        if any(_page_one_archetype(r) for r in shaped) else {}
    ) or {}

    def _rides_page_one(r) -> bool:
        archetype = _page_one_archetype(r)
        if archetype is None:
            return False
        service_id = getattr(r, "analysis_service_id", None)
        if service_id is None or service_id not in archetype_by_service:
            return True
        return archetype_by_service[service_id] == archetype
```

`admitted_native` stays HPLC only. Current line 136:
```python
    admitted_native = any(_rides_page_one(r) for r in shaped)
```
New line:
```python
    admitted_native = any(is_native_hplc_row(r) and _rides_page_one(r) for r in shaped)
```

Re-key. Current lines 199-201:
```python
            else:
                keyword = wire_keyword(r.keyword, None, n_slots)
        if not (keyword or "").strip():
```
New lines:
```python
            else:
                keyword = wire_keyword(r.keyword, None, n_slots)
        elif is_native_bw_row(r):
            keyword = bw_wire_keyword(r.keyword)
            title = bw_wire_title(db, r.keyword, r.title)
        if not (keyword or "").strip():
```

Spec fields. Current lines 224-225:
```python
            **(_native_spec_fields(db, parent, r, wire_result)
               if is_native_hplc_row(r) else {}),
```
New lines:
```python
            **(_native_spec_fields(db, parent, r, wire_result)
               if _page_one_archetype(r) else {}),
```
`_native_spec_fields` already resolves against the ROW's native `analysis_service_id` and `normalize_matrix(parent.sample_type_title)`, which is "Bacteriostatic Water". It finds no matrix tier and falls through to the R4 wildcard row. `peptide_id` is None on BW rows, so the peptide tier is skipped. No change is needed there.
- [ ] **Step 4: Run, expect PASS** (sequentially)
  - `cd backend && python -m pytest tests/test_bw_native_legacy_rows.py -q`
  - `cd backend && python -m pytest tests/test_legacy_rows_contract.py tests/test_legacy_rows_native_specs.py tests/test_hplc_native_coa_archetype_routing.py tests/test_hplc_native_coa_parity.py tests/test_hplc_shim.py tests/test_coa_wire_document.py -q`. These are the HPLC and SENAITE regression pins, and must be unchanged.
- [ ] **Step 5: Commit**
```bash
git add -- backend/coa/legacy_rows.py backend/tests/test_bw_native_legacy_rows.py
git commit -m "feat(coa): native Bac Water rows ride page 1 under legacy keywords with Mk1 specs" -- backend/coa/legacy_rows.py backend/tests/test_bw_native_legacy_rows.py
```

---

### Task W5: Variance series key native BW rows by the legacy keyword

**Repo:** Accu-Mk1
**Files:**
- Modify: `backend/coa/variance_series.py:24` (import), `:382-385` (keying)
- Test: `backend/tests/test_variance_analyte_series.py` (append)

**Interfaces:**
- Consumes: `bw_wire_keyword` (W1), `BW_NATIVE_KEYWORDS` (M1).
- Produces: `build_variance_analyte_series` keys a native BW vial row (`origin='mk1'`, keyword in `BW_NATIVE_KEYWORDS`) by `PH-DETERM` / `Benzyl_Alcohol_Assay` / `FILL-NET-CONTENT`. That is the key `GenericAssayEngine._apply_variance` looks up (`reps.get(analysis["Keyword"])`). The path is dormant while BW variance is out of scope (R5). Legacy keying is unchanged.

- [ ] **Step 1: Write the failing test** (append to `backend/tests/test_variance_analyte_series.py`)
```python
def test_native_bw_rows_key_by_legacy_keyword(db):
    """MB5: a native BW vial row (PH-BW, origin mk1) keys the series by the
    legacy SENAITE keyword the generic engine pairs on (PH-DETERM), so a
    later BW-variance re-enable lands on the right results_table row."""
    from coa.variance_series import build_variance_analyte_series

    ph = AnalysisService(title="pH", keyword="PH-BW", origin="mk1",
                         variance_capable=True, unit="pH")
    db.add(ph)
    db.flush()
    parent = LimsSample(sample_id="BW-1003", external_lims_system="mk1",
                        sample_type_title="Bacteriostatic Water")
    db.add(parent)
    db.flush()
    for seq, value in ((1, "5.4"), (2, "5.6")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://bw1003-{seq}",
            sample_id=f"BW-1003-S{seq:02d}", vial_sequence=seq,
            assignment_role="hplc", assignment_kind="variance",
        )
        db.add(sub)
        db.flush()
        _row(db, sub, ph, value, unit="pH")
    db.commit()

    assert build_variance_analyte_series(db, parent) == {
        "PH-DETERM": {"unit": "pH", "values": ["5.4", "5.6"]}}
```
- [ ] **Step 2: Run it, expect FAIL**
Run: `cd backend && python -m pytest tests/test_variance_analyte_series.py -q`  Expected: FAIL on the new test, because the series is keyed `PH-BW`, not `PH-DETERM`.
- [ ] **Step 3: Implement** in `backend/coa/variance_series.py`.

Current line 24:
```python
from coa.hplc_shim import slot_wires, wire_keyword
```
New lines:
```python
from coa.bw_shim import BW_NATIVE_KEYWORDS, bw_wire_keyword
from coa.hplc_shim import slot_wires, wire_keyword
```

Current lines 382-385:
```python
            if svc.origin == "mk1" and raw_kw.upper() in _NATIVE_KWS:
                kw = wire_keyword(raw_kw, la.slot, n_slots)
            else:
                kw = raw_kw or (svc.keyword or "").strip()
```
New lines:
```python
            if svc.origin == "mk1" and raw_kw.upper() in _NATIVE_KWS:
                kw = wire_keyword(raw_kw, la.slot, n_slots)
            elif svc.origin == "mk1" and raw_kw.upper() in BW_NATIVE_KEYWORDS:
                # MB5: same legacy vocabulary legacy_rows puts on the wire.
                kw = bw_wire_keyword(raw_kw)
            else:
                kw = raw_kw or (svc.keyword or "").strip()
```
- [ ] **Step 4: Run, expect PASS**
  - `cd backend && python -m pytest tests/test_variance_analyte_series.py tests/test_variance_series.py tests/test_process_variance_fields.py -q`
- [ ] **Step 5: Commit**
```bash
git add -- backend/coa/variance_series.py backend/tests/test_variance_analyte_series.py
git commit -m "feat(coa): key native Bac Water variance series by the legacy keyword" -- backend/coa/variance_series.py backend/tests/test_variance_analyte_series.py
```

---


# Part 3: COABuilder (Tasks C1-C3)

## COABuilder (CB1)

**Repo:** `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\coabuilder` (base: `origin/master` @ `3d92d3e`, release 2.35.0)

**Interpreter:** a bare `python` hangs on this box (Store alias). Every command below uses the repo venv: `.venv/Scripts/python.exe`, run from the coabuilder repo root.

**Line endings:** `src/coabuilder_core/generic_assay_engine.py` is `w/crlf` (`git ls-files --eol`). The Edit tool preserves CRLF. Diff it with `git -c core.autocrlf=true diff`.

**Prototype status:** The C1 and C2 diffs below and their tests were run against an `origin/master` export (scratchpad `coabsrc/`):
- Before C1, 7 of the 9 tests fail.
- With only C1 applied, 1 test fails (the C2 wire-range test).
- With C1 and C2 applied, all 9 pass.
- These neighbouring suites stay green (59 passed): `test_generic_engine_variance.py`, `test_generic_status_fallback.py`, `test_generic_result_precision.py`, `test_page1_wire_specs.py`, `test_fetch_sample_meta.py`, `test_published_date_override.py`.

### Files map

- Modify `src/coabuilder_core/generic_assay_engine.py`:
  - add `_wire_spec()`, the gate that wraps a dict `specification` in 2.35.0's `_Page1Spec`;
  - add `GenericAssayEngine._resolve_wire_status()`;
  - route `_row_from_analysis` (:341-344) and `_apply_variance` (:269) through the wire spec when present.
  - `_resolve_status` itself stays byte-identical.
- Create `tests/test_generic_wire_specs.py`. It holds the CB1 tests:
  - a legacy BW snapshot;
  - wire override, wire `conforms` trust, informational and pending rows;
  - the wire variance range;
  - an end-to-end `fetch_sample_data` hand-off.
- Modify `src/coabuilder_core/__init__.py:1` to bump the version to 2.36.0.
- Modify `CHANGELOG.md` to add the 2.36.0 entry.

### How 2.35.0 did it (the precedent this mirrors)

- **Field names:** `specification` (dict) and `conforms` (bool or None).
  - They are optional on `legacy_rows` rows: `legacy_rows.py:27` `OPTIONAL_FIELDS = ("specification", "conforms")`.
  - They are validated fail-closed in `extract_legacy_rows` (`legacy_rows.py:77-89`), using `native_sections._validate_wire_spec` (`native_sections.py:80`):
    - a `range` or `equals` row with a result must carry a bool `conforms`;
    - an `informational` row must carry `conforms=None` and no bounds;
    - a row with no result must carry `conforms=None`.
- **Precedence:** see `conformance.py:180-225` `_Page1Spec`.
  - `_Page1Spec.status(own_row=True)` trusts the wire `conforms` when it is a bool, and only otherwise judges the value against the wire `min`/`max` (`judge()` returns None for anything that is not `range`).
  - Figures the engine derives itself (variance means, the recalculated blend purity) are judged locally against the wire limit with `judge()`. Mk1's verdict is not used for those.
- **Display:** `native_sections._format_spec_display` (`native_sections.py:53-77`):
  - `display` wins;
  - `informational` gives `"Measured"`;
  - `equals` gives the equals text;
  - otherwise it uses `:g` bounds plus the unit.
- **Gate:** `isinstance(row.get("specification"), dict)`. A row without one keeps the engine's old default.
- **Reaching the engine:** `senaite_client.py:430-434` (mk1 mode, `sample_meta` present) and `:486-487` (SENAITE AR plus `legacy_rows`) assign the validated rows wholesale: `sample_json["_Analyses_Detailed"] = legacy_rows`.
  - The BW route (`senaite_client.py:654-662`) passes that `sample_json` to `GenericAssayEngine.process`, which iterates `_Analyses_Detailed` (`generic_assay_engine.py:121,147-153`).
  - So `analysis["specification"]` and `analysis["conforms"]` arrive verbatim. Task C1's end-to-end test pins this.

CB1 reuses `_Page1Spec` directly (`generic_assay_engine.py:23` already imports from `.conformance`), so precedence and formatting cannot drift between the two engines. One difference is deliberate:
- On failure the generic engine keeps its own `DOES NOT CONFORM` status, never page 1's `-x.xx%` delta.
- The reason is that the rollup at `generic_assay_engine.py:155-167` keys on `status == "DOES NOT CONFORM"`.

---

### Task C1: GenericAssayEngine honours wire `specification`/`conforms` on page-1 rows

**Repo:** coabuilder
**Files:**
- Modify: `src/coabuilder_core/generic_assay_engine.py:23` (import), `:57` (new helper before `_format_total_qty`), `:341-344` (`_row_from_analysis`), `:402` (new static method before `_format_spec_range`)
- Test: `tests/test_generic_wire_specs.py` (create)

**Interfaces:**
- Consumes:
  - `coabuilder_core.conformance._Page1Spec(row, default_text, default_min)`, with attributes `.text`, `.kind`, `.lo`, `.hi`, `.mk1_conforms` and the method `.judge(value) -> Optional[bool]` (`conformance.py:180-225` at origin/master);
  - `coabuilder_core.legacy_rows.extract_legacy_rows(doc)`.
- Produces:
  - `generic_assay_engine._wire_spec(analysis: dict) -> Optional[_Page1Spec]`;
  - `GenericAssayEngine._resolve_wire_status(wire, raw_result) -> tuple[str, str, str, Optional[bool]]`.
  - C2 consumes `_wire_spec`.
  - On the wire: a BW `legacy_rows` row under a SENAITE keyword (`PH-DETERM`, `Benzyl_Alcohol_Assay`, `FILL-NET-CONTENT`) that carries a dict `specification` now renders Mk1's spec text and verdict.

- [ ] **Step 1: Write the failing test**

Create `tests/test_generic_wire_specs.py`:
```python
"""GenericAssayEngine honours Mk1-filed specs on native BW rows (CB1).

A native-born Bacteriostatic Water row rides the legacy_rows wire under the
SENAITE keyword and may carry `specification` + `conforms`, the same pair
page 1 has honoured on native HPLC rows since 2.35.0 (_Page1Spec). Mk1
resolves the analysis_service_specs row and owns the verdict; this engine
formats it. A row without the pair is SENAITE-era and keeps the baked
lookup_spec path byte-identical.
"""
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from coabuilder_core.generic_assay_engine import GenericAssayEngine
from coabuilder_core.legacy_rows import extract_legacy_rows
from coabuilder_core.senaite_client import SenaiteClient

BW = "Bacteriostatic Water"


def _spec(kind="range", lo=None, hi=None, display=None, unit=""):
    return {"rule_kind": kind, "equals": None, "min": lo, "max": hi,
            "unit": unit, "display": display, "loq": None}


def _r(keyword, title, result, unit="", spec=None, conforms=None):
    row = {"uid": f"mk1:{keyword}", "Keyword": keyword, "Title": title,
           "ServiceTitle": title, "Result": result, "Unit": unit,
           "review_state": "verified", "ResultCaptureDate": "2026-10-01T00:00:00"}
    if spec is not None:
        row.update(specification=spec, conforms=conforms)
    return row


def _process(rows, **kw):
    return GenericAssayEngine().process(
        {"SampleTypeTitle": BW, "SampleID": "BW-1000", "ClientLot": "L1",
         "DeclaredTotalQuantity": "10", "DateReceived": "2026-08-28T12:00:00",
         "_Analyses_Detailed": rows},
        published_date_override="09/30/2026", **kw)


def _find(out, title):
    return next(r for r in out["results_table"] if r["test_name"] == title)


# Legacy BW rows (no wire spec): pinned from origin/master 2.35.0 output.
LEGACY_ROWS = [
    _r("PH-DETERM", "pH Determination", "5.5"),
    _r("Benzyl_Alcohol_Assay", "Benzyl Alcohol Assay", "0.9", "v/v"),
    _r("FILL-NET-CONTENT", "Fill volume / Net content", "9.710267415", "mL"),
]

LEGACY_TABLE = [
    {"test_name": "pH Determination", "analyte_name": "pH Determination",
     "test_type": "pH", "specification": "4.5 \u2013 7.0", "result": "5.50",
     "status": "CONFORMS", "status_color": "", "conforms": True, "unit": ""},
    {"test_name": "Benzyl Alcohol Assay", "analyte_name": "Benzyl Alcohol Assay",
     "test_type": "HPLC", "specification": "0.9% (v/v) \u00b120%",
     "result": "0.90 v/v", "status": "CONFORMS", "status_color": "",
     "conforms": True, "unit": "v/v"},
    {"test_name": "Fill volume / Net content",
     "analyte_name": "Fill volume / Net content", "test_type": "Gravimetric",
     "specification": "\u2014", "result": "9.71 mL", "status": "MEASURED",
     "status_color": "", "conforms": None, "unit": "mL"},
]


def test_legacy_bw_rows_render_byte_identical():
    out = _process(LEGACY_ROWS)
    assert out["results_table"] == LEGACY_TABLE
    assert out["canonical"]["overall_status_badge"] == "PASSED"
    assert out["canonical"]["nonconformance_reasons"] == []
    assert out["variance_report"] == {}


@pytest.mark.parametrize("result, lo, hi, conforms, text, status", [
    # 6.5 passes the baked 4.5-7.0 but fails Mk1's tighter 5.0-6.0.
    ("6.5", 5.0, 6.0, False, "5 \u2013 6", "DOES NOT CONFORM"),
    # 7.2 fails the baked 4.5-7.0 but passes Mk1's wider 4.5-7.5.
    ("7.2", 4.5, 7.5, True, "4.5 \u2013 7.5", "CONFORMS"),
])
def test_wire_range_overrides_the_baked_spec(result, lo, hi, conforms, text, status):
    out = _process([_r("PH-DETERM", "pH Determination", result,
                       spec=_spec(lo=lo, hi=hi), conforms=conforms)])
    ph = _find(out, "pH Determination")
    assert (ph["specification"], ph["status"], ph["conforms"]) == (text, status, conforms)
    assert out["canonical"]["overall_pass"] is conforms


def test_wire_display_is_printed_verbatim():
    # Mk1 ships display_override as wire `display`; it must win over the
    # formatted bounds so native BW cells match legacy ("0.9% (v/v) ±20%").
    out = _process([_r("Benzyl_Alcohol_Assay", "Benzyl Alcohol Assay", "0.9", "v/v",
                       spec={"rule_kind": "range", "min": 0.72, "max": 1.08,
                                      "unit": "% (v/v)", "display": "0.9% (v/v) ±20%",
                                      "equals": None, "loq": None},
                       conforms=True)])
    ba = _find(out, "Benzyl Alcohol Assay")
    assert ba["specification"] == "0.9% (v/v) ±20%"


def test_wire_conforms_false_is_trusted_and_fails_the_rollup():
    # 0.9 sits inside both the baked and the wire range: only Mk1's verdict
    # can make it fail, which proves the engine trusts it over a recompute.
    out = _process([_r("Benzyl_Alcohol_Assay", "Benzyl Alcohol Assay", "0.9", "v/v",
                       spec=_spec(lo=0.72, hi=1.08, display="0.9% (v/v) \u00b120%",
                                  unit="v/v"),
                       conforms=False)])
    ba = _find(out, "Benzyl Alcohol Assay")
    assert (ba["specification"], ba["status"], ba["status_color"], ba["conforms"]) == (
        "0.9% (v/v) \u00b120%", "DOES NOT CONFORM", "#444F5B", False)
    assert out["canonical"]["overall_status_badge"] == "FAILED"
    assert out["canonical"]["nonconformance_reasons"] == [
        "Benzyl Alcohol Assay: 0.90 v/v outside 0.9% (v/v) \u00b120%"]


def test_informational_wire_spec_renders_report_only():
    out = _process([
        _r("PH-DETERM", "pH Determination", "5.5", spec=_spec(lo=4.5, hi=7.0), conforms=True),
        _r("FILL-NET-CONTENT", "Fill volume / Net content", "9.710267415", "mL",
           spec=_spec("informational", unit="mL"), conforms=None),
    ])
    fill = _find(out, "Fill volume / Net content")
    assert (fill["specification"], fill["result"], fill["status"], fill["conforms"]) == (
        "Measured", "9.71 mL", "MEASURED", None)
    assert out["canonical"]["overall_status_badge"] == "PASSED"


def test_pending_wire_row_is_not_tested_and_keeps_the_sample_in_review():
    out = _process([_r("PH-DETERM", "pH Determination", None,
                       spec=_spec(lo=4.5, hi=7.0), conforms=None)])
    ph = _find(out, "pH Determination")
    assert (ph["specification"], ph["status"], ph["conforms"]) == (
        "4.5 \u2013 7", "NOT TESTED", None)
    assert out["canonical"]["overall_status_badge"] == "IN REVIEW"


def test_wire_spec_reaches_the_engine_through_fetch_sample_data(monkeypatch, tmp_path):
    """mk1 mode end to end: extract_legacy_rows validates the pair, and
    fetch_sample_data hands the rows verbatim to GenericAssayEngine."""
    monkeypatch.setenv("ACCUMK1_BASE_URL", "https://mk1.test")
    monkeypatch.setenv("ACCUMK1_SERVICE_TOKEN", "tok")
    rows = extract_legacy_rows({"legacy_rows": {"rows": [
        _r("PH-DETERM", "pH Determination", "6.5", spec=_spec(lo=5.0, hi=6.0), conforms=False),
    ]}})
    meta = {"source": "mk1", "SampleID": "BW-1000", "SampleTypeTitle": BW,
            "ClientSampleID": "CS", "DateReceived": "2026-08-28T12:00:00",
            "DeclaredTotalQuantity": "10", "ClientLot": "L1", "BatchID": "L1",
            "CoaCompanyName": "", "CoaEmail": "", "CoaWebsite": "", "CoaAddress": "",
            "CompanyLogoUrl": "", "ChromatographBackgroundUrl": None, "attachments": []}
    seen = {}
    orig = GenericAssayEngine.process

    def spy(self, sample_json, **kw):
        seen["out"] = orig(self, sample_json, **kw)
        return seen["out"]

    monkeypatch.setattr(GenericAssayEngine, "process", spy)
    client = SenaiteClient()
    client.results_dir = str(tmp_path)
    with patch.object(client, "_get", side_effect=AssertionError("SENAITE _get called")), \
         patch("coabuilder_core.senaite_client.requests.get",
               side_effect=AssertionError("requests.get called")):
        data = client.fetch_sample_data("BW-1000", legacy_rows=rows, sample_meta=meta)
    assert data is not None
    ph = _find(seen["out"], "pH Determination")
    assert (ph["specification"], ph["conforms"]) == ("5 \u2013 6", False)
    assert seen["out"]["canonical"]["overall_pass"] is False
```

Notes on the expected strings:
- `\u2013` is the en dash that `_format_spec_display` and the baked display emit.
- `\u2014` is the legacy no-spec glyph from `_extract_specification`; keep it escaped.
- The pending pH row prints `4.5 \u2013 7`, not `7.0`, because `_format_spec_display` uses `:g`. See the Notes for assembler.

- [ ] **Step 2: Run it, expect FAIL**

Run: `.venv/Scripts/python.exe -m pytest tests/test_generic_wire_specs.py -q`
Expected: 6 failed, 1 passed.
- The guard `test_legacy_bw_rows_render_byte_identical` passes on the unchanged engine.
- Every wire test fails because the engine ignores `specification` and verdicts on the baked spec. For example, the parametrized pH case asserts `"5 \u2013 6"` but gets `"4.5 \u2013 7.0"`, and the BA `conforms=False` case gets `CONFORMS`.

- [ ] **Step 3: Implement**

In `src/coabuilder_core/generic_assay_engine.py`:

(a) Line 23. The current line:
```python
from .conformance import format_received_date
```
becomes:
```python
from .conformance import _Page1Spec, format_received_date
```

(b) Insert immediately above line 57 (`def _format_total_qty(dtq: Any) -> str:`):
```python
def _wire_spec(analysis: Dict[str, Any]) -> Optional[_Page1Spec]:
    """The Mk1-filed spec on a native legacy row, else None.

    Same gate and same helper page 1 uses since 2.35.0: a dict
    `specification` (validated with its `conforms` in
    legacy_rows.extract_legacy_rows) wins; a row without one is a
    SENAITE-era row and keeps the baked lookup_spec path, unchanged."""
    if not isinstance(analysis.get("specification"), dict):
        return None
    return _Page1Spec(analysis, "", None)


```

(c) `_row_from_analysis`, lines 341-344. The current lines:
```python
        spec = lookup_spec(matrix, keyword)
        specification, status, status_color, conforms = self._resolve_status(
            spec, raw_result
        )
```
become:
```python
        wire = _wire_spec(analysis)
        if wire is not None:
            specification, status, status_color, conforms = self._resolve_wire_status(
                wire, raw_result
            )
        else:
            spec = lookup_spec(matrix, keyword)
            specification, status, status_color, conforms = self._resolve_status(
                spec, raw_result
            )
```

(d) Insert immediately above line 402 (the `@staticmethod` that decorates `def _format_spec_range(spec: Dict[str, Any]) -> str:` at :403), after the end of `_resolve_status` (:400):
```python
    @staticmethod
    def _resolve_wire_status(
        wire: _Page1Spec,
        raw_result: Any,
    ) -> tuple[str, str, str, Optional[bool]]:
        """(specification_display, status, status_color, conforms) for a row
        carrying a Mk1-filed spec. Mk1 owns the verdict (its bool `conforms`
        wins, as on page 1); a missing one is judged against Mk1's limit.
        Statuses stay in this engine's vocabulary (DOES NOT CONFORM, never
        page 1's delta) because the rollup in process() keys on them."""
        if raw_result is None or not str(raw_result).strip():
            return wire.text, _STATUS_NOT_TESTED, _COLOR_DEFAULT, None
        ok = wire.mk1_conforms if isinstance(wire.mk1_conforms, bool) else None
        if ok is None:
            try:
                ok = wire.judge(float(str(raw_result).strip()))
            except (TypeError, ValueError):
                ok = None
        if ok is None:
            return wire.text, _STATUS_MEASURED, _COLOR_DEFAULT, None
        if ok:
            return wire.text, _STATUS_CONFORMS, _COLOR_DEFAULT, True
        return wire.text, _STATUS_NONCONFORMS, _COLOR_NONCONFORM, False

```

`_resolve_status` (:358-400) is not touched, so the SENAITE-era path is the same code.

- [ ] **Step 4: Run, expect PASS**

Run: `.venv/Scripts/python.exe -m pytest tests/test_generic_wire_specs.py -q`. Expected: 7 passed.

Then run the legacy neighbours: `.venv/Scripts/python.exe -m pytest tests/test_generic_engine_variance.py tests/test_generic_status_fallback.py tests/test_generic_result_precision.py tests/test_page1_wire_specs.py tests/test_fetch_sample_meta.py tests/test_published_date_override.py tests/test_addon_parsing.py -q`. Expected: all pass.

Then run the full suite as a failure-set diff: `.venv/Scripts/python.exe -m pytest tests -q`.
- Expected: the only failure is the pre-existing `test_variance_page_4_analytes_vial1_from_parent` (named in the 2f1415b commit message as failing with and without that change).
- Confirm with a pre-change run on `origin/master` if the set differs.

- [ ] **Step 5: Commit**
```bash
git add -- src/coabuilder_core/generic_assay_engine.py tests/test_generic_wire_specs.py
git commit -m "feat(generic): honour Mk1-filed specs on native BW rows" -- src/coabuilder_core/generic_assay_engine.py tests/test_generic_wire_specs.py
```

---

### Task C2: BW variance uses the wire range when present

This is dormant under spec R5, because BW variance is not sold. It ships so a later variance re-enable keys on Mk1's limit and does not silently fall back to the baked one. The assembler or the Handler may drop this task without touching C1.

**Repo:** coabuilder
**Files:**
- Modify: `src/coabuilder_core/generic_assay_engine.py:269` (`_apply_variance`; line number is pre-C1, about :281 after C1's insertions)
- Test: `tests/test_generic_wire_specs.py` (append)

**Interfaces:**
- Consumes: `_wire_spec(analysis) -> Optional[_Page1Spec]` (Task C1).
- Produces: `variance_report.tests[*]` entries for wire rows, with `spec_min`/`spec_max`/`spec_text` from the wire spec. The all-replicates verdict is still computed in coab.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_generic_wire_specs.py`:
```python
def test_variance_uses_the_wire_range():
    # Parent 5.5 + vials 5.4 / 6.5 all pass the baked 4.5-7.0; 6.5 fails
    # Mk1's 5.0-6.0, and the all-replicates verdict follows the wire.
    rows = [_r("PH-DETERM", "pH Determination", "5.5",
               spec=_spec(lo=5.0, hi=6.0), conforms=True)]
    out = _process(rows, variance_analytes={
        "PH-DETERM": {"unit": "", "values": ["5.4", "6.5"]}})
    ph = _find(out, "pH Determination")
    assert ph["conforms"] is False and ph["status"] == "DOES NOT CONFORM"
    vr = {t["key"]: t for t in out["variance_report"]["tests"]}["bw-PH-DETERM"]
    assert (vr["spec_text"], vr["spec_min"], vr["spec_max"], vr["conforms"]) == (
        "5 \u2013 6", 5.0, 6.0, False)
    assert out["canonical"]["nonconformance_reasons"] == [
        "pH Determination: replicate(s) 6.5 outside 5 \u2013 6"]


def test_variance_on_an_informational_wire_row_is_measured():
    rows = [_r("FILL-NET-CONTENT", "Fill volume / Net content", "5.0", "mL",
               spec=_spec("informational", unit="mL"), conforms=None)]
    out = _process(rows, variance_analytes={
        "FILL-NET-CONTENT": {"unit": "mL", "values": ["5.0", "5.1"]}})
    vr = {t["key"]: t for t in out["variance_report"]["tests"]}["bw-FILL-NET-CONTENT"]
    assert (vr["spec_text"], vr["spec_min"], vr["spec_max"], vr["conforms"]) == (
        "Measured", None, None, None)
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `.venv/Scripts/python.exe -m pytest tests/test_generic_wire_specs.py -q`. Expected: 1 failed, 8 passed.
- `test_variance_uses_the_wire_range` fails: the variance path still reads the baked 4.5-7.0, so `ph["conforms"]` is True.
- `test_variance_on_an_informational_wire_row_is_measured` already passes, because FILL-NET-CONTENT has no baked spec. It stays as a guard that the wire branch does not invent bounds for `informational`.
- Verified on the prototype.

- [ ] **Step 3: Implement**

In `_apply_variance`, origin/master line 269. The current lines (269-271):
```python
        spec = lookup_spec(matrix, keyword)
        lo = spec.get("min") if spec else None
        hi = spec.get("max") if spec else None
```
become:
```python
        wire = _wire_spec(analysis)
        if wire is not None:
            # Mk1's limit; the all-replicates verdict stays computed here,
            # because Mk1's `conforms` covers the parent figure only.
            spec = ({"min": wire.lo, "max": wire.hi, "display": wire.text}
                    if wire.kind == "range" else None)
        else:
            spec = lookup_spec(matrix, keyword)
        lo = spec.get("min") if spec else None
        hi = spec.get("max") if spec else None
```

The rest of `_apply_variance` (:272-315) is unchanged. With a range spec, `spec.get("display")` is `wire.text`, so `spec_text`, the fail note and `variance_report` all print Mk1's formatted limit. `informational` and `equals` wire specs map to `None`, so they take the existing "Measured" branch at :299-302.

- [ ] **Step 4: Run, expect PASS**

Run: `.venv/Scripts/python.exe -m pytest tests/test_generic_wire_specs.py tests/test_generic_engine_variance.py tests/test_generic_result_precision.py -q`. Expected: all pass. `test_generic_engine_variance.py` is the legacy variance guard: its baked `spec_min`/`spec_max` assertions (4.5/7.0, 0.72/1.08) must still hold.

- [ ] **Step 5: Commit**
```bash
git add -- src/coabuilder_core/generic_assay_engine.py tests/test_generic_wire_specs.py
git commit -m "feat(generic): BW variance keys on the Mk1-filed range when present" -- src/coabuilder_core/generic_assay_engine.py tests/test_generic_wire_specs.py
```

---

### Task C3: Release 2.36.0

The repo convention, from 2.35.0:
- `c5463df chore(release): 2.35.0 - ...` touched only `CHANGELOG.md` and `src/coabuilder_core/__init__.py`.
- The date was corrected on release day in a separate `bd0c92a chore(changelog): 2.35.0 release date`.
- No other file carries the version (`git grep 2.35.0 origin/master` outside CHANGELOG hits only `__init__.py:1`).
- This is a minor bump, because the change is an additive wire feature.

**Repo:** coabuilder
**Files:**
- Modify: `src/coabuilder_core/__init__.py:1`
- Modify: `CHANGELOG.md:1-3`

**Interfaces:**
- Consumes: Tasks C1 and C2 merged.
- Produces: `__version__ == "2.36.0"`. The `accumark-deploy` skill releases from it, and the cross-repo order is Mk1, then coab (CB1), then IS.

- [ ] **Step 1: Write the failing test**

There is no new test; the version string is not unit-tested in this repo. The gate is the full suite in Step 4.

- [ ] **Step 2: Run it, expect FAIL**

Not applicable: no behaviour change. Skip to Step 3.

- [ ] **Step 3: Implement**

`src/coabuilder_core/__init__.py` line 1. The current line:
```python
__version__ = "2.35.0"
```
becomes:
```python
__version__ = "2.36.0"
```

`CHANGELOG.md`: insert between line 1 (`# COA Builder - Changelog`, followed by a blank line) and line 3 (`## [2.35.0] - 2026-09-21`). Correct the date on release day, as `bd0c92a` did:
```markdown
## [2.36.0] - 2026-10-05

Native-born Bacteriostatic Water wire support (mk1 mode). Pairs with
Accu-Mk1's BW native-born program (MB5 shim); deploy after Mk1, before IS.
SENAITE-mode requests and SENAITE-born BW certificates are unaffected.

### Added

- **GenericAssayEngine honours Mk1-filed specs on native BW rows.** A
  `legacy_rows` row carrying `specification` + `conforms` (the pair page 1
  has honoured on native HPLC rows since 2.35.0) now renders Mk1's spec text
  and verdict on the BW page-1 table, through the same `_Page1Spec` helper
  and `_format_spec_display`. Mk1's bool `conforms` wins; an `informational`
  spec prints "Measured" and no verdict; a pending row prints NOT TESTED. A
  failed wire verdict prints DOES NOT CONFORM and flips the sample to FAILED.
  A row without the pair (every SENAITE-born BW sample) keeps the baked
  `lookup_spec` path, byte-identical (pinned by
  `tests/test_generic_wire_specs.py`).
- **BW variance keys on the wire range when present.** Dormant while BW
  variance is not sold; the all-replicates verdict is still computed here,
  against Mk1's limit instead of the baked one.

```

- [ ] **Step 4: Run, expect PASS**

Run: `.venv/Scripts/python.exe -m pytest tests -q`. Expected: the same failure set as the C1 Step 4 baseline (only `test_variance_page_4_analytes_vial1_from_parent`). Then run `.venv/Scripts/python.exe -c "import sys; sys.path.insert(0, 'src'); import coabuilder_core; print(coabuilder_core.__version__)"`. Expected: `2.36.0`.

- [ ] **Step 5: Commit**
```bash
git add -- CHANGELOG.md src/coabuilder_core/__init__.py
git commit -m "chore(release): 2.36.0 - native-born BW wire specs (mk1 mode)" -- CHANGELOG.md src/coabuilder_core/__init__.py
```

---

### Notes for assembler

**Spec claims found wrong, or needing a correction:**

- **No golden PDF exists.** Spec "Testing" says "a legacy BW sample is unchanged (golden PDF)". COABuilder has no golden-PDF harness at origin/master: `git ls-tree origin/master tests` shows render tests only, and `tests/test_native_sections_render.py` is a native-sections layout test, not a BW golden.
  - CB1 substitutes an engine-output snapshot, `LEGACY_TABLE` in `tests/test_generic_wire_specs.py`. It was captured by running origin/master's `GenericAssayEngine` on a legacy BW sample.
  - The snapshot covers the pH, BA and fill rows. The PDF is built from that dict, so it is the right seam.
- **Line numbers for CB1.** The spec cites `generic_assay_engine.py:269,341`. Both are correct at origin/master: `_apply_variance`'s `lookup_spec` is at :269 and `_row_from_analysis`'s is at :341.
  - Precedence check: the spec says "prefer the row's wire specification/conforms". 2.35.0 TRUSTS a bool wire `conforms` for the row's own figure. It recomputes only for derived figures (variance means), against the wire limit.
  - CB1 mirrors this exactly by reusing `_Page1Spec`.

**Interfaces other sections must provide (Mk1 MB5):**

- **Spec fields only ride on native HPLC rows today.** Mk1 attaches `specification`/`conforms` only `if is_native_hplc_row(r)` (`backend/coa/legacy_rows.py:224-225` at origin/master). MB5 must extend that conditional to native BW rows (`is_native_bw_row`), or CB1 never sees a wire spec and silently uses baked specs.
- **The shape is already correct.** `_spec_wire_dict` (`backend/coa/native_sections.py:209-225`) emits `rule_kind/equals/min/max/unit/display/loq`. `_native_spec_fields` (`legacy_rows.py:68-93`) emits `conforms=None` on pending rows, and `evaluate()` returns None for `informational`. Both satisfy coab's `_validate_wire_spec`.
- **A malformed pair 422s the whole certificate.** A range row with a result but `conforms=None` is malformed, and `extract_legacy_rows` aborts on it.
- **Keywords on the wire must be the SENAITE ones:** `PH-DETERM`, `Benzyl_Alcohol_Assay`, `FILL-NET-CONTENT`. coab keys `lookup_technique` (the Test column: pH / HPLC / Gravimetric), the baked fallback and the variance `reps` on them. A native keyword (`PH-BW`) arriving unmapped would print a blank Test column and lose the baked fallback.
- **Display divergence (Mk1 seed section must decide).** Without a `display` override, wire text differs from today's legacy certificate. The tests prove the formatter output:
  - pH `4.5-7.0` prints `4.5 \u2013 7` (`:g` drops the `.0`). Legacy prints `4.5 \u2013 7.0`.
  - BA `0.72-1.08` prints `0.72 \u2013 1.08 <unit>`. Legacy prints `0.9% (v/v) \u00b120%`.
  - A fill volume filed as `informational` prints `Measured` in the Specification column, where legacy prints the em-dash glyph. The status is `MEASURED` in both.
  - To match legacy side by side, the R4 seed rows should set `display_override` ("4.5 \u2013 7.0", "0.9% (v/v) \u00b120%"). Otherwise the Handler accepts the new text. The choice does not block CB1.
- **`sample_meta.SampleTypeTitle` must be exactly `"Bacteriostatic Water"`.** That string routes to `GenericAssayEngine` (`senaite_client.py:644-662`) and keys the baked fallback, including the ENDO-LAL 0.25 limit.

**Behaviour notes (not blocking):**

- **The addon path ignores wire specs.** `addon_parsing.parse_endotoxin` (`addon_parsing.py:25-35`) still verdicts ENDO-LAL on BW against the baked 0.25 (`baked_specs.py:53-57`). Today that agrees with the Mk1 matrix tier (0.25, verified in the spec), but nothing pins the two together. If the Mk1 tier changes, the certificate keeps 0.25. This is out of CB1 scope; flag it for a later slice.
- **C2 can overrule Mk1's verdict on the parent figure.** C2's all-replicates recompute ignores Mk1's `conforms` on the parent figure. If Mk1 says the parent fails but every figure is in range against the same limit, the row conforms.
  - This mirrors 2.35.0, where the variance mean is judged locally with `judge()`, and Mk1 and coab evaluate the same inclusive bounds, so they cannot disagree.
  - It is dormant under R5. A fail-closed variant would be `conforms = all_in_range and wire.mk1_conforms is not False`. Adopt it only on a Handler ruling, since it departs from the 2.35.0 precedent.
- **SENAITE-path safety of the gate.** `_wire_spec` fires on any dict `specification`. None of the checked-in SENAITE dumps carry a lowercase `"specification"` key (`sample_dump.json`, `debug_pb0011_dump.json`, `senaite_dump_PB-0010.json`, `debug_children.json`, `debug_attachment_detail.json`: 0 hits each at origin/master). SENAITE uses `ResultsRange`/`Specification`, which `_extract_specification` reads. ConformanceEngine accepted the same gate in 2.35.0.

**Could not verify:**

- **The full coab suite was not run in the real checkout** (the brief says not to touch repos). In the scratch export the full suite cannot collect `tests/test_native_sections_server.py` (no `scripts/`) and lacks `Templates/`. The engine-level suites listed in C1 Step 4 were run and pass with the patch. The pre-existing failure name comes from the 2f1415b commit message, not from a run.
- **The CHANGELOG date is set to 2026-10-05** and must be corrected on release day, per the `bd0c92a` precedent.


# Part 4: integration-service (Tasks I1-I4)

# Section: integration-service (IB1-IB4, Part B)

All line numbers are from `origin/master` at `57dd456` (integration-service). Run every command from `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\integration-service`.

## Files map

- `app/services/catalog_registry.py`: add the `NATIVE_BW_KEY` constant next to `NATIVE_HPLC_KEY` (I1).
- `app/services/order_validator.py`:
  - `_validate_bac_water_sample`: native BW routing, the valve-off fallback and the legacy add-on rejection (I1), and BW retest routing (I2).
  - `_service_extras_errors`: rejects a sample that carries both BW keys (I1).
  - `_validate_sample`: rejects a peptide sample that carries the native BW key (I1), and the Part B all-native rule (I4).
- `app/services/native_sample.py`: the `native_sample_type_title()` helper, plus BW analyte slots in `build_native_sample_meta` (I3).
- `app/services/order_processor.py`: the native-mint branch takes its enrichment title from `native_sample_type_title()` (I3).
- `tests/unit/test_native_routing.py`: tests for BW routing (I1), BW retest (I2) and the Part B rule matrix (I4).
- `tests/unit/test_native_sample_meta.py`: BW meta title, slots and parity tests (I3).
- `tests/unit/test_order_processor_native.py`: an end-to-end exact-title test (I3) and an all-native non-HPLC order test (I4).
- `tests/unit/test_native_service_keys.py`: one deliberate Part B inversion (I4).

Task order: I1, then I2, then I3; I4 (Part B) is separate and gated. I3 depends on I1, because a native BW sample must route to mk1 before the processor test can reach the mint branch.

---

### Task I1: Native BW key routes to mk1 (IB1)

**Repo:** integration-service
**Files:**
- Modify: `app/services/catalog_registry.py:49-53`
- Modify: `app/services/order_validator.py:370-374` (function-local import), `:424-430` (peptide-side BW rejection), `:545-549` and `:570-575` (`_service_extras_errors`), `:615-709` (`_validate_bac_water_sample`)
- Test: `tests/unit/test_native_routing.py`

**Interfaces:**
- Consumes: none
- Produces:
  - `app.services.catalog_registry.NATIVE_BW_KEY = "bacteriostatic-water-panel"`
  - `NormalizedSample.lims == "mk1"` with `profiles == []` and `product_type == PRODUCT_TYPE_BAC_WATER` for a native BW sample when the valve is on
  - Test helpers in `test_native_routing.py` that I2 and I4 reuse: `NATIVE_ENDO`, `BW_SYNCED`, the `bw_validator` fixture, `_bw_order()` and `_expected_legacy_bw()`

**Floor decision: `NATIVE_BW_KEY` does NOT go into `NATIVE_SERVICE_KEYS`.**
- Precedent: `hplc-purity-identity` is not in the floor. `order_validator.py:165` holds only `heavy_metals`.
- `test_native_routing.py:7-8` and `:44-48` explicitly pin "no accidental floor entry" for the HPLC key.
- `_service_extras_errors` runs at `:321`, before the BW early return at `:325-329`. That means a registry that has not yet synced the key rejects a native BW order as "Unknown service key". This is fail-closed.
- A floor entry would accept the key before Mk1 has the `bacteriostatic-water-panel` profile, and the mint would then carry demand that Mk1 cannot fulfil.
- The flip runbook (spec "Deploy and activation", step 1) already requires the sync to be confirmed first.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/test_native_routing.py`, and extend its imports at `:22-23`:

```python
from app.services.catalog_registry import NATIVE_BW_KEY, NATIVE_HPLC_KEY
from app.services.order_validator import (
    NATIVE_SERVICE_KEYS,
    PRODUCT_TYPE_BAC_WATER,
    DefaultOrderValidator,
    NormalizedSample,
)
```

```python
# --- Bac Water native-born (spec 2026-10-05, IB1) ---------------------------

NATIVE_ENDO = "endotoxin-usp85-lal"  # Mk1 profile key (retest_routes.py:43)
BW_SYNCED = {NATIVE_HPLC_KEY, NATIVE_BW_KEY, NATIVE_ENDO}


@pytest.fixture
def bw_validator() -> DefaultOrderValidator:
    from app.services import catalog_registry
    catalog_registry._set_synced(BW_SYNCED, datetime.now(UTC))
    return DefaultOrderValidator()


def _bw_order(
    services: SampleServices, retest_spec: dict | None = None
) -> OrderSubmission:
    order = _order_with(services=services, analytical_test="Bacteriostatic Water")
    sample = order.samples[0]
    sample.sample_identity = "30mL Bacteriostatic Water"
    sample.sample_weight = "30"
    sample.retest_spec = retest_spec
    return order


def _expected_legacy_bw(profiles: list[str]) -> NormalizedSample:
    """The exact NormalizedSample today's (pre-change) BW path builds for
    _bw_order(): lims/native_hplc at their defaults."""
    return NormalizedSample(
        number=1,
        original_identity="30mL Bacteriostatic Water",
        normalized_identity="30mL Bacteriostatic Water",
        peptides=[],
        is_blend=False,
        analytical_test="Bacteriostatic Water",
        sample_weight="30",
        sample_name=None,
        lot_code=None,
        notes=None,
        vendor_name=None,
        profiles=profiles,
        variance_count=None,
        package=None,
        analyte_quantities=None,
        product_type=PRODUCT_TYPE_BAC_WATER,
    )


def test_native_bw_key_with_native_endo_routes_to_mk1(
    bw_validator: DefaultOrderValidator,
) -> None:
    result = bw_validator.validate(
        _bw_order(SampleServices(**{NATIVE_BW_KEY: True, NATIVE_ENDO: True}))
    )
    assert result.valid, result.errors
    s = result.normalized_samples[0]
    assert s.lims == "mk1" and s.profiles == []
    assert s.product_type == PRODUCT_TYPE_BAC_WATER and s.native_hplc is False


def test_native_bw_key_alone_routes_to_mk1(bw_validator: DefaultOrderValidator) -> None:
    result = bw_validator.validate(_bw_order(SampleServices(**{NATIVE_BW_KEY: True})))
    assert result.valid, result.errors
    assert result.normalized_samples[0].lims == "mk1"


def test_legacy_bw_with_native_endo_is_byte_identical(
    bw_validator: DefaultOrderValidator,
) -> None:
    """Prod BW orders today: legacy panel + native endo key. Unchanged."""
    result = bw_validator.validate(
        _bw_order(SampleServices(bac_water_panel=True, **{NATIVE_ENDO: True}))
    )
    assert result.valid, result.errors
    assert result.normalized_samples[0] == _expected_legacy_bw(["bac_water"])


def test_legacy_bw_with_legacy_addons_is_byte_identical(
    bw_validator: DefaultOrderValidator,
) -> None:
    result = bw_validator.validate(
        _bw_order(SampleServices(bac_water_panel=True, endotoxin=True, sterility_pcr=True))
    )
    assert result.valid, result.errors
    assert result.normalized_samples[0] == _expected_legacy_bw(
        ["bac_water", "endotoxin", "sterility_pcr"]
    )


@pytest.mark.parametrize(
    ("legacy_field", "profile"),
    [("endotoxin", "endotoxin"), ("sterility_pcr", "sterility_pcr")],
)
def test_native_bw_plus_legacy_addon_rejected(
    bw_validator: DefaultOrderValidator, legacy_field: str, profile: str
) -> None:
    result = bw_validator.validate(
        _bw_order(SampleServices(**{NATIVE_BW_KEY: True, legacy_field: True}))
    )
    assert not result.valid
    assert any(
        f"bacteriostatic-water-panel cannot be combined with SENAITE-only service(s): {profile}"
        in e.message
        for e in result.errors
    )


def test_both_bw_keys_rejected(bw_validator: DefaultOrderValidator) -> None:
    result = bw_validator.validate(
        _bw_order(SampleServices(bac_water_panel=True, **{NATIVE_BW_KEY: True}))
    )
    assert not result.valid
    assert any(
        "native Bac Water panel, not both" in e.message for e in result.errors
    )


def test_native_bw_still_rejects_hplc(bw_validator: DefaultOrderValidator) -> None:
    result = bw_validator.validate(
        _bw_order(SampleServices(**{NATIVE_BW_KEY: True, NATIVE_HPLC_KEY: True}))
    )
    assert not result.valid
    assert any("cannot include HPLC" in e.message for e in result.errors)


def test_bw_valve_off_maps_native_key_to_legacy_panel(
    bw_validator: DefaultOrderValidator, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LIMS_NATIVE_ROUTING_DISABLED", "1")
    result = bw_validator.validate(
        _bw_order(SampleServices(**{NATIVE_BW_KEY: True, NATIVE_ENDO: True}))
    )
    assert result.valid, result.errors
    assert result.normalized_samples[0] == _expected_legacy_bw(["bac_water"])


def test_unsynced_native_bw_key_rejected_as_unknown(
    validator_without_native_key: DefaultOrderValidator,
) -> None:
    """No floor entry (same as hplc-purity-identity): an unsynced registry
    fails closed at _service_extras_errors, ahead of the BW early return."""
    assert NATIVE_BW_KEY not in NATIVE_SERVICE_KEYS
    result = validator_without_native_key.validate(
        _bw_order(SampleServices(**{NATIVE_BW_KEY: True}))
    )
    assert not result.valid
    assert any("Unknown service key" in e.message for e in result.errors)


def test_peptide_sample_with_native_bw_key_rejected(
    bw_validator: DefaultOrderValidator,
) -> None:
    result = bw_validator.validate(
        _order_with(services=SampleServices(**{NATIVE_HPLC_KEY: True, NATIVE_BW_KEY: True}))
    )
    assert not result.valid
    assert any(
        "Bacteriostatic Water panel cannot be combined with peptide tests" in e.message
        for e in result.errors
    )
```

Note: the existing `test_bw_rejects_native_key_too` at `:200` stays unchanged and must still pass. The HPLC key on a BW sample is still rejected.

- [ ] **Step 2: Run it, expect FAIL**

Run: `pytest tests/unit/test_native_routing.py -q`. Expected: the module fails to collect with `ImportError: cannot import name 'NATIVE_BW_KEY' from 'app.services.catalog_registry'`.

- [ ] **Step 3: Implement**

`app/services/catalog_registry.py`, directly after `:53` (`HPLC_PRIMARY_KEYS: frozenset[str] = frozenset({LEGACY_HPLC_KEY, NATIVE_HPLC_KEY})`):

```python

# Bac Water panel primary key, native (Mk1) spelling (spec 2026-10-05 R1).
# The legacy spelling is the bac_water_panel field / "bacwaterpanel" alias.
# Deliberately NOT in the NATIVE_SERVICE_KEYS floor, same as NATIVE_HPLC_KEY:
# an unsynced registry must reject it (fail closed) until Mk1's
# `bacteriostatic-water-panel` profile exists and the sync has run.
NATIVE_BW_KEY = "bacteriostatic-water-panel"
```

In `app/services/order_validator.py`, `_validate_sample`, replace the function-local import at `:370-374`:

```python
        from app.services.catalog_registry import (
            NATIVE_HPLC_KEY,
            known_service_keys,
            native_routing_disabled,
        )
```

with:

```python
        from app.services.catalog_registry import (
            NATIVE_BW_KEY,
            NATIVE_HPLC_KEY,
            known_service_keys,
            native_routing_disabled,
        )
```

Then replace `:424-430`:

```python
        # Reject peptide-only profiles attached to a bac water sample (defense-in-depth)
        if "bac_water" in profiles:
```

with:

```python
        # Reject peptide-only profiles attached to a bac water sample (defense-in-depth).
        # The native BW key is the same panel under its Mk1 spelling.
        if "bac_water" in profiles or (
            (sample.services.model_extra or {}).get(NATIVE_BW_KEY) is True
        ):
```

The body (the `errors.append(...)` with "Bacteriostatic Water panel cannot be combined with peptide tests") is unchanged.

In `_service_extras_errors`, replace the import at `:545-549`:

```python
        from app.services.catalog_registry import (
            NATIVE_HPLC_KEY,
            is_floor_only,
            known_service_keys,
        )
```

with:

```python
        from app.services.catalog_registry import (
            NATIVE_BW_KEY,
            NATIVE_HPLC_KEY,
            is_floor_only,
            known_service_keys,
        )
```

Then, after the existing HPLC both-keys check at `:570-574`, and before `return errors` at `:575`, insert:

```python
        if sample.services.bac_water_panel and extras.get(NATIVE_BW_KEY) is True:
            errors.append(ValidationError(
                field="services",
                message="Select either the legacy or the native Bac Water panel, not both",
                sample_number=sample.number))
```

Replace `_validate_bac_water_sample` (`:615-709`) in full with the version below. The legacy statements and messages are kept verbatim; only the marked lines are new.

```python
    def _validate_bac_water_sample(
        self,
        sample: Sample,
    ) -> tuple[list[ValidationError], list[str], NormalizedSample | None]:
        """Validate a Bacteriostatic Water sample.

        BW orders skip peptide normalization, blend logic, and analyte slots.
        sample_identity is treated as a free-form product description (e.g.
        "30mL Bacteriostatic Water"), not a peptide list.

        sample_weight is repurposed as fill volume (mL); we still require it to
        be numeric and positive so the SENAITE adapter can pass it through.

        Native-born BW (spec 2026-10-05): the native key
        `bacteriostatic-water-panel` is an alternative entry ticket. Valve on:
        lims="mk1", zero SENAITE profiles, and a legacy endotoxin /
        sterility_pcr field is rejected (the native endo/PCR keys ride as
        extras, as prod BW orders already send them). Valve off: the native
        key is read as the legacy panel and the sample is SENAITE-born as
        today. The legacy key path is unchanged.
        """
        errors: list[ValidationError] = []
        warnings: list[str] = []

        # Reject peptide-only services on a bac water sample (legacy field or
        # the native key; same circularity reason as _service_extras_errors).
        from app.services.catalog_registry import (
            NATIVE_BW_KEY,
            NATIVE_HPLC_KEY,
            native_routing_disabled,
        )

        extras = sample.services.model_extra or {}
        native_bw_key = extras.get(NATIVE_BW_KEY) is True
        native_bw = native_bw_key and not native_routing_disabled()

        if (
            sample.services.hplcpurity_identity
            or extras.get(NATIVE_HPLC_KEY) is True
        ):
            errors.append(ValidationError(
                field="services",
                message="Bacteriostatic Water samples cannot include HPLC purity/identity",
                sample_number=sample.number,
            ))
        # Sample variance IS supported for Bac Water (2026-06-18): the count
        # rides services.variance keyed by bac_water_panel, lands on the Mk1
        # hplc vial bucket (derive_variance_demand), and renders on the COA via
        # GenericAssayEngine. No peptide-style variance profile is required.
        if sample.services.residualsolvents:
            errors.append(ValidationError(
                field="services",
                message="Bacteriostatic Water samples cannot include residual solvents",
                sample_number=sample.number,
            ))

        # The bac water panel (legacy field or native key) is the entry
        # ticket; STER/ENDO are optional add-ons.
        if not (sample.services.bac_water_panel or native_bw_key):
            errors.append(ValidationError(
                field="services",
                message="Bacteriostatic Water orders require the bac_water_panel service",
                sample_number=sample.number,
            ))

        # Build profile list: bac_water + optional STER/ENDO add-ons. Valve
        # off: the native key falls back to the legacy SENAITE panel.
        profiles: list[str] = []
        if sample.services.bac_water_panel or (native_bw_key and not native_bw):
            profiles.append(SERVICE_TO_PROFILE["bac_water_panel"])
        if sample.services.endotoxin:
            profiles.append(SERVICE_TO_PROFILE["endotoxin"])
        if sample.services.sterility_pcr:
            profiles.append(SERVICE_TO_PROFILE["sterility_pcr"])

        lims: Literal["senaite", "mk1"] = "senaite"
        if native_bw:
            # Same rule as native HPLC (_validate_sample): the native primary
            # takes the sample to Mk1, and any SENAITE-only profile left is an
            # unsupported mix that must reject loudly.
            lims = "mk1"
            if profiles:
                errors.append(ValidationError(
                    field="services",
                    message=f"{NATIVE_BW_KEY} cannot be combined with "
                            f"SENAITE-only service(s): {', '.join(profiles)}",
                    sample_number=sample.number,
                ))

        # Fill volume validation (sample_weight repurposed as mL).
        try:
            weight_value = float(sample.sample_weight)
            if weight_value <= 0:
                errors.append(ValidationError(
                    field="sample_weight",
                    message="Fill volume must be positive",
                    sample_number=sample.number,
                ))
        except (ValueError, TypeError):
            warnings.append(
                f"Sample {sample.number}: Fill volume '{sample.sample_weight}' "
                f"is not purely numeric"
            )

        if errors:
            return errors, warnings, None

        normalized = NormalizedSample(
            number=sample.number,
            original_identity=sample.sample_identity,
            normalized_identity=sample.sample_identity,
            peptides=[],
            is_blend=False,
            analytical_test=sample.analytical_test,
            sample_weight=sample.sample_weight,
            sample_name=sample.sample_name,
            lot_code=sample.lot_code,
            notes=sample.notes,
            vendor_name=sample.vendor_name,
            profiles=profiles,
            variance_count=None,
            package=sample.package,
            analyte_quantities=None,
            product_type=PRODUCT_TYPE_BAC_WATER,
            lims=lims,
        )

        return errors, warnings, normalized
```

Also update the `NormalizedSample.lims` comment at `:227-229`, which today says mk1 is for "the HPLC purity/identity service" only:

```python
    # Which LIMS owns this sample. "mk1" = native-born (zero SENAITE
    # profiles: the native HPLC or Bac Water primary, or a Mk1 retest spec);
    # "senaite" = legacy flow, unchanged. Defaulted so existing call sites
    # keep working.
```

- [ ] **Step 4: Run, expect PASS**

Run: `pytest tests/unit/test_native_routing.py tests/unit/test_native_service_keys.py tests/unit/test_order.py -q && ruff check . && mypy app`

- [ ] **Step 5: Commit**

```bash
git add -- app/services/catalog_registry.py app/services/order_validator.py tests/unit/test_native_routing.py
git commit -m "feat(validator): route native Bac Water key to Mk1 (IB1)" -- app/services/catalog_registry.py app/services/order_validator.py tests/unit/test_native_routing.py
```

---

### Task I2: BW retest routes to mk1 (IB3)

**Repo:** integration-service
**Files:**
- Modify: `app/services/order_validator.py`, inside `_validate_bac_water_sample` as rewritten by I1
- Test: `tests/unit/test_native_routing.py`

**Interfaces:**
- Consumes: `NATIVE_BW_KEY`, plus the I1 test helpers `NATIVE_ENDO`, `bw_validator`, `_bw_order` and `_expected_legacy_bw`
- Produces: a BW sample with a `retest_spec`, at least one selected native key, no legacy `bac_water_panel` field, and the valve on, routes to `lims="mk1"`

**Why the rule differs from the peptide `native_retest` at `:390-394`:**
- Prod legacy BW orders already carry `endotoxin-usp85-lal`, so `native_selected` is true on them.
- A straight port would push a legacy BW retest (with `bac_water_panel` plus `retest_spec`) into the "cannot be combined" rejection, because `bac_water` stays in profiles.
- So any sample that carries the legacy panel field keeps today's SENAITE path.
- Native-born BW retests that carry the native key already route to mk1 through I1's `native_bw`. This task adds the add-on-only case: a retest spec with native keys and no panel, which today is rejected for "require the bac_water_panel service".

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/test_native_routing.py`:

```python
# --- Bac Water retest (IB3) -------------------------------------------------


def _bw_spec(**over) -> dict:
    return _spec(
        retest_of_sample_id="BW-1001",
        carry=[NATIVE_BW_KEY],
        add={"profiles": [NATIVE_ENDO], "variance_points": 0, "additional_vials": 0},
        **over,
    )


def test_bw_addon_only_retest_spec_routes_to_mk1(bw_validator: DefaultOrderValidator) -> None:
    result = bw_validator.validate(
        _bw_order(SampleServices(**{NATIVE_ENDO: True}), retest_spec=_bw_spec())
    )
    assert result.valid, result.errors
    s = result.normalized_samples[0]
    assert s.lims == "mk1" and s.profiles == [] and s.product_type == PRODUCT_TYPE_BAC_WATER


def test_bw_retest_with_native_key_routes_to_mk1(bw_validator: DefaultOrderValidator) -> None:
    result = bw_validator.validate(
        _bw_order(
            SampleServices(**{NATIVE_BW_KEY: True, NATIVE_ENDO: True}), retest_spec=_bw_spec()
        )
    )
    assert result.valid, result.errors
    assert result.normalized_samples[0].lims == "mk1"


def test_legacy_bw_retest_spec_with_legacy_panel_is_byte_identical(
    bw_validator: DefaultOrderValidator,
) -> None:
    """Legacy panel + native endo + retest_spec: today's SENAITE path, unchanged."""
    result = bw_validator.validate(
        _bw_order(
            SampleServices(bac_water_panel=True, **{NATIVE_ENDO: True}), retest_spec=_bw_spec()
        )
    )
    assert result.valid, result.errors
    assert result.normalized_samples[0] == _expected_legacy_bw(["bac_water"])


def test_bw_addon_only_without_retest_spec_still_requires_panel(
    bw_validator: DefaultOrderValidator,
) -> None:
    result = bw_validator.validate(_bw_order(SampleServices(**{NATIVE_ENDO: True})))
    assert not result.valid
    assert any("require the bac_water_panel service" in e.message for e in result.errors)


def test_bw_native_retest_plus_legacy_endotoxin_rejected(
    bw_validator: DefaultOrderValidator,
) -> None:
    result = bw_validator.validate(
        _bw_order(
            SampleServices(endotoxin=True, **{NATIVE_ENDO: True}), retest_spec=_bw_spec()
        )
    )
    assert not result.valid
    assert any(
        "a Mk1 retest spec cannot be combined with SENAITE-only service(s): endotoxin"
        in e.message
        for e in result.errors
    )


def test_bw_addon_only_retest_valve_off_unchanged(
    bw_validator: DefaultOrderValidator, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Valve off: no Mk1 routing, so today's entry-ticket rejection stands."""
    monkeypatch.setenv("LIMS_NATIVE_ROUTING_DISABLED", "1")
    result = bw_validator.validate(
        _bw_order(SampleServices(**{NATIVE_ENDO: True}), retest_spec=_bw_spec())
    )
    assert not result.valid
    assert any("require the bac_water_panel service" in e.message for e in result.errors)
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `pytest tests/unit/test_native_routing.py -q`. Expected:
- `test_bw_addon_only_retest_spec_routes_to_mk1` fails because `result.valid` is False ("require the bac_water_panel service").
- `test_bw_native_retest_plus_legacy_endotoxin_rejected` fails because the expected message is absent.
- The other four pass already. They pin today's behaviour.

- [ ] **Step 3: Implement**

In `_validate_bac_water_sample` (the I1 version), change the import block:

```python
        from app.services.catalog_registry import (
            NATIVE_BW_KEY,
            NATIVE_HPLC_KEY,
            native_routing_disabled,
        )

        extras = sample.services.model_extra or {}
        native_bw_key = extras.get(NATIVE_BW_KEY) is True
        native_bw = native_bw_key and not native_routing_disabled()
```

to:

```python
        from app.services.catalog_registry import (
            NATIVE_BW_KEY,
            NATIVE_HPLC_KEY,
            known_service_keys,
            native_routing_disabled,
        )

        extras = sample.services.model_extra or {}
        native_bw_key = extras.get(NATIVE_BW_KEY) is True
        native_bw = native_bw_key and not native_routing_disabled()
        # A Mk1 retest / add-on spec on a BW sample belongs to Mk1 (same idea
        # as native_retest in _validate_sample), EXCEPT when the legacy panel
        # field is set: legacy BW orders already carry native endo/PCR keys,
        # so a legacy BW retest must keep today's SENAITE path.
        working = known_service_keys()
        native_retest = (
            sample.retest_spec is not None
            and not sample.services.bac_water_panel
            and not native_routing_disabled()
            and any(isinstance(v, bool) and v and k in working for k, v in extras.items())
        )
```

Change the entry-ticket check:

```python
        if not (sample.services.bac_water_panel or native_bw_key):
```

to:

```python
        if not (sample.services.bac_water_panel or native_bw_key or native_retest):
```

Change the lims block:

```python
        if native_bw:
            # Same rule as native HPLC (_validate_sample): the native primary
            # takes the sample to Mk1, and any SENAITE-only profile left is an
            # unsupported mix that must reject loudly.
            lims = "mk1"
            if profiles:
                errors.append(ValidationError(
                    field="services",
                    message=f"{NATIVE_BW_KEY} cannot be combined with "
                            f"SENAITE-only service(s): {', '.join(profiles)}",
                    sample_number=sample.number,
                ))
```

to:

```python
        if native_bw or native_retest:
            # Same rule as native HPLC (_validate_sample): the native primary
            # (or a Mk1 retest spec) takes the sample to Mk1, and any
            # SENAITE-only profile left is an unsupported mix that must
            # reject loudly.
            lims = "mk1"
            if profiles:
                errors.append(ValidationError(
                    field="services",
                    message=(NATIVE_BW_KEY if native_bw else "a Mk1 retest spec")
                            + " cannot be combined with "
                            f"SENAITE-only service(s): {', '.join(profiles)}",
                    sample_number=sample.number,
                ))
```

- [ ] **Step 4: Run, expect PASS**

Run: `pytest tests/unit/test_native_routing.py -q && ruff check . && mypy app`

- [ ] **Step 5: Commit**

```bash
git add -- app/services/order_validator.py tests/unit/test_native_routing.py
git commit -m "feat(validator): route Mk1 Bac Water retest specs to Mk1 (IB3)" -- app/services/order_validator.py tests/unit/test_native_routing.py
```

---

### Task I3: Native BW registry meta carries the exact BW title and slots (IB2)

**Repo:** integration-service
**Files:**
- Modify: `app/services/native_sample.py:16-26` (imports), `:63-70` (analyte slots), `:87` (title)
- Modify: `app/services/order_processor.py:32` (import), `:611-617` (`_registry_enrichment` call)
- Test: `tests/unit/test_native_sample_meta.py`, `tests/unit/test_order_processor_native.py`

**Interfaces:**
- Consumes: `NATIVE_BW_KEY` (I1). A native BW sample must reach the mint branch with `lims == "mk1"`.
- Produces:
  - `app.services.native_sample.native_sample_type_title(normalized: NormalizedSample) -> str`
  - `BAC_WATER_SAMPLE_TYPE_TITLE = "Bacteriostatic Water"`
  - `BAC_WATER_ANALYTE = "Benzyl Alcohol"`
  - Native BW registry meta that reaches Mk1 with `SampleTypeTitle == "Bacteriostatic Water"`, `Analyte1Peptide == "Benzyl Alcohol"` and `DeclaredTotalQuantity` set to the fill volume formatted `.2f`

**Why the title must change at both sites:**
- `build_native_sample_meta` sets `SampleTypeTitle` at `native_sample.py:87`, but then applies the enrichment at `:95` (`meta.update({k: v for k, v in enrichment.items() if v})`).
- `order_processor.py:615` passes a hard-coded `"Peptide Blend" if normalized.is_blend else "Peptide"` into `_registry_enrichment`, so that truthy value wins.
- Fixing only the builder would still ship "Peptide", and the endotoxin spec would silently fall back to the wildcard 0-5 EU/mL tier.
- So the processor-level test below is the load-bearing one.

**DeclaredTotalQuantity needs no change.**
- `build_native_sample_meta:55-59` already formats `.2f`.
- The SENAITE-born registry signal is also reformatted to `.2f` at `order_processor.py:798-805`.
- So a native BW sample shows Mk1 the same value a SENAITE-born BW sample does, for example "30.00".
- The raw passthrough at `adapters/senaite.py:2200` is only what SENAITE itself receives.

- [ ] **Step 1: Write the failing test**

In `tests/unit/test_native_sample_meta.py`, extend the imports:

```python
from app.services.native_sample import build_native_sample_meta, native_sample_type_title
from app.services.order_validator import PRODUCT_TYPE_BAC_WATER, NormalizedSample
```

Then append:

```python
def _bw_sample() -> NormalizedSample:
    return NormalizedSample(
        number=1,
        original_identity="30mL Bacteriostatic Water",
        normalized_identity="30mL Bacteriostatic Water",
        peptides=[],
        is_blend=False,
        analytical_test="Bacteriostatic Water",
        sample_weight="30",
        sample_name="S1",
        lot_code="LOT1",
        notes=None,
        profiles=[],
        variance_count=None,
        product_type=PRODUCT_TYPE_BAC_WATER,
        lims="mk1",
    )


def _bw_senaite_config() -> SenaiteConfig:
    cfg = _senaite_config()
    cfg.bac_water_type_uid = "t_bw"
    cfg.bac_water_profile_uid = "prof_bw"
    return cfg


def test_sample_type_title_helper():
    # Load-bearing exact string: Mk1 resolves the BW endotoxin matrix tier
    # (0-0.25 EU/mL) by this title; anything else falls back to 0-5.
    assert native_sample_type_title(_bw_sample()) == "Bacteriostatic Water"
    assert native_sample_type_title(_single_sample()) == "Peptide"
    assert native_sample_type_title(_blend_sample()) == "Peptide Blend"


def test_bw_meta_title_and_analyte_slots_match_senaite_bw_payload(monkeypatch):
    # A resolvable id must still NOT appear: the SENAITE BW path never emits one.
    monkeypatch.setattr(peptide_registry, "resolve_peptide_id", lambda name: 7)
    ar_data = build_analysis_request_from_sample(
        sample=_bw_sample(), client_uid="c1", contact_uid="ct1",
        config=_bw_senaite_config(), order_id=1, order_number="4242", coa_info=None,
    )
    payload = ar_data.to_senaite_payload()
    meta = build_native_sample_meta(
        _bw_sample(), order=_order(), coa_info=None, enrichment={},
        logo_url=None, chromatograph_url=None,
    )
    assert meta["SampleTypeTitle"] == ar_data.sample_type_title == "Bacteriostatic Water"
    assert meta["Analyte1Peptide"] == "Benzyl Alcohol"
    for i in range(1, 9):
        assert meta[f"Analyte{i}Peptide"] == payload[f"Analyte{i}Peptide"]
        assert meta[f"Analyte{i}DeclaredQuantity"] == payload[f"Analyte{i}DeclaredQuantity"]
    assert not any(k.endswith("PeptideId") for k in meta)


def test_bw_declared_total_quantity_matches_senaite_born_registry_signal():
    # order_processor.py:798-805 formats the SENAITE-born signal to .2f too.
    meta = build_native_sample_meta(
        _bw_sample(), order=_order(), coa_info=None, enrichment={},
        logo_url=None, chromatograph_url=None,
    )
    assert meta["DeclaredTotalQuantity"] == "30.00"


def test_bw_parity_with_senaite_payload_keys():
    sample = _bw_sample()
    order = _order()
    enrichment = {"Priority": "high", "ClientUID": "c1"}
    ar_data = build_analysis_request_from_sample(
        sample=sample, client_uid="c1", contact_uid="ct1",
        config=_bw_senaite_config(), order_id=order.order_id,
        order_number=order.order_number, coa_info=order.coa_info,
    )
    senaite_keys = set(ar_data.to_senaite_payload().keys())
    native_meta = build_native_sample_meta(
        sample, order=order, coa_info=order.coa_info, enrichment=enrichment,
        logo_url=None, chromatograph_url=None,
    )
    expected = (senaite_keys - SENAITE_ONLY_KEYS) | {"SampleTypeTitle"} | set(enrichment)
    assert set(native_meta.keys()) - {"Lims"} == expected
```

In `tests/unit/test_order_processor_native.py`, change the import at `:24` to `from app.services.catalog_registry import NATIVE_BW_KEY, NATIVE_HPLC_KEY`, then append:

```python
NATIVE_ENDO = "endotoxin-usp85-lal"


def _native_bw_sample(number: int = 1) -> Sample:
    return Sample(
        number=number,
        analytical_test="Bacteriostatic Water",
        sample_identity="30mL Bacteriostatic Water",
        sample_weight="30",
        services=SampleServices(**{NATIVE_BW_KEY: True, NATIVE_ENDO: True}),
    )


@pytest.mark.asyncio
async def test_native_bw_mints_in_mk1_with_exact_bw_title():
    """End to end through process(): the enrichment overlay must not clobber
    the BW title with "Peptide" (native_sample.py applies enrichment last)."""
    from app.services import catalog_registry
    catalog_registry._set_synced(
        {NATIVE_HPLC_KEY, NATIVE_BW_KEY, NATIVE_ENDO}, datetime.now(timezone.utc)
    )
    senaite = _make_senaite_mock()
    accumk1 = MagicMock(spec=AccuMk1Adapter)
    accumk1.notify_sample_created = AsyncMock(
        return_value={"sample_id": "BW-1000", "native_id": "aBW-0001"}
    )
    processor = OrderProcessor(
        validator=DefaultOrderValidator(),
        senaite=senaite,
        senaite_config=_make_senaite_config(),
        accumk1=accumk1,
    )

    resp = await processor.process(
        _order(samples=[_native_bw_sample(1)]), db=_FakeAsyncSession()
    )

    assert resp.status == "accepted", resp.errors
    r = resp.sample_results[0]
    assert r.lims == "mk1" and r.lims_sample_id == "BW-1000"
    meta = accumk1.notify_sample_created.call_args.kwargs["meta"]
    assert meta["SampleTypeTitle"] == "Bacteriostatic Water"
    assert meta["Analyte1Peptide"] == "Benzyl Alcohol"
    assert meta["DeclaredTotalQuantity"] == "30.00"
    assert meta["Lims"] == "mk1"
    senaite.create_analysis_request.assert_not_called()
    senaite.lookup_or_create_client.assert_not_called()


@pytest.mark.asyncio
async def test_legacy_bw_registry_signal_unchanged_and_agrees_with_native():
    """Legacy (SENAITE-born) BW: the registry signal Mk1 sees is untouched by
    I3 and carries the same three load-bearing fields as the native meta."""
    from app.services import catalog_registry
    catalog_registry._set_synced(
        {NATIVE_HPLC_KEY, NATIVE_BW_KEY, NATIVE_ENDO}, datetime.now(timezone.utc)
    )
    config = _make_senaite_config()
    # Without these the SENAITE BW builder raises and the sample silently fails.
    config.bac_water_type_uid = "t_bw"
    config.bac_water_profile_uid = "prof_bw"
    senaite = _make_senaite_mock()
    accumk1 = MagicMock(spec=AccuMk1Adapter)
    accumk1.notify_sample_created = AsyncMock(return_value={"sample_id": "P-001"})
    processor = OrderProcessor(
        validator=DefaultOrderValidator(),
        senaite=senaite,
        senaite_config=config,
        accumk1=accumk1,
    )
    legacy_bw = Sample(
        number=1,
        analytical_test="Bacteriostatic Water",
        sample_identity="30mL Bacteriostatic Water",
        sample_weight="30",
        services=SampleServices(bac_water_panel=True, **{NATIVE_ENDO: True}),
    )

    resp = await processor.process(_order(samples=[legacy_bw]), db=_FakeAsyncSession())

    assert resp.status == "accepted", resp.errors
    assert resp.sample_results[0].lims == "senaite"
    senaite.create_analysis_request.assert_awaited_once()
    kw = accumk1.notify_sample_created.call_args.kwargs
    assert kw["sample_id"] == "P-001"
    meta = kw["meta"]
    assert meta["SampleTypeTitle"] == "Bacteriostatic Water"
    assert meta["Analyte1Peptide"] == "Benzyl Alcohol"
    assert meta["DeclaredTotalQuantity"] == "30.00"
    assert "Lims" not in meta
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `pytest tests/unit/test_native_sample_meta.py tests/unit/test_order_processor_native.py -q`. `test_legacy_bw_registry_signal_unchanged_and_agrees_with_native` passes both before and after the change; it is the legacy pin. Expected:
- `test_native_sample_meta.py` fails to collect with `ImportError: cannot import name 'native_sample_type_title'`.
- Once that is fixed, the processor test fails with `'Peptide' == 'Bacteriostatic Water'`.

- [ ] **Step 3: Implement**

`app/services/native_sample.py`: replace the import at `:26`:

```python
from app.services.order_validator import NormalizedSample
```

with:

```python
from app.services.order_validator import PRODUCT_TYPE_BAC_WATER, NormalizedSample

# Load-bearing exact string (spec 2026-10-05 IB2): Mk1 resolves the native
# endotoxin spec through the matrix tier keyed on this title (BW = 0-0.25
# EU/mL); a wrong title silently falls back to the 0-5 wildcard. Same value
# build_analysis_request_from_sample sends for SENAITE-born BW.
BAC_WATER_SAMPLE_TYPE_TITLE = "Bacteriostatic Water"
# Slot 1 on a BW sample, mirroring adapters/senaite.py:2178-2186.
BAC_WATER_ANALYTE = "Benzyl Alcohol"


def native_sample_type_title(normalized: NormalizedSample) -> str:
    """SampleTypeTitle for a native-born sample. Used by BOTH the meta
    builder and the order processor's enrichment overlay (which is applied
    last and would otherwise win)."""
    if normalized.product_type == PRODUCT_TYPE_BAC_WATER:
        return BAC_WATER_SAMPLE_TYPE_TITLE
    return "Peptide Blend" if normalized.is_blend else "Peptide"
```

Amend the module docstring at `:10-13` by appending one sentence. The BW slot literals below are local, and that is deliberate:

```python
Bacteriostatic Water slots/title are the one local exception (the SENAITE BW
branch hard-codes them inline); test_native_sample_meta's BW parity tests
pin the two builders together instead.
```

Replace the analyte-slot block at `:63-70`:

```python
    analyte_slots = format_analyte_slots(normalized.peptides, normalized.analyte_quantities)
    for i in range(1, 9):
        meta[f"Analyte{i}Peptide"] = analyte_slots[f"analyte{i}_peptide"]
        meta[f"Analyte{i}DeclaredQuantity"] = analyte_slots[f"analyte{i}_quantity"]
        if i <= len(normalized.peptides):
            peptide_id = peptide_registry.resolve_peptide_id(normalized.peptides[i - 1])
            if peptide_id is not None:
                meta[f"Analyte{i}PeptideId"] = peptide_id
```

with:

```python
    if normalized.product_type == PRODUCT_TYPE_BAC_WATER:
        # Same slots the SENAITE BW payload carries: Benzyl Alcohol in slot 1,
        # no quantities, no peptide id (the SENAITE path never sends one).
        for i in range(1, 9):
            meta[f"Analyte{i}Peptide"] = BAC_WATER_ANALYTE if i == 1 else ""
            meta[f"Analyte{i}DeclaredQuantity"] = ""
    else:
        analyte_slots = format_analyte_slots(
            normalized.peptides, normalized.analyte_quantities
        )
        for i in range(1, 9):
            meta[f"Analyte{i}Peptide"] = analyte_slots[f"analyte{i}_peptide"]
            meta[f"Analyte{i}DeclaredQuantity"] = analyte_slots[f"analyte{i}_quantity"]
            if i <= len(normalized.peptides):
                peptide_id = peptide_registry.resolve_peptide_id(normalized.peptides[i - 1])
                if peptide_id is not None:
                    meta[f"Analyte{i}PeptideId"] = peptide_id
```

Replace `:87`:

```python
    meta["SampleTypeTitle"] = "Peptide Blend" if normalized.is_blend else "Peptide"
```

with:

```python
    meta["SampleTypeTitle"] = native_sample_type_title(normalized)
```

`app/services/order_processor.py:32`: change

```python
from app.services.native_sample import build_native_sample_meta
```

to

```python
from app.services.native_sample import build_native_sample_meta, native_sample_type_title
```

and at `:611-617` change

```python
                    registry_enrichment = _registry_enrichment(
                        order,
                        client_uid,
                        contact_uid,
                        "Peptide Blend" if normalized.is_blend else "Peptide",
                        original.vendor_name if original else None,
                    )
```

to

```python
                    registry_enrichment = _registry_enrichment(
                        order,
                        client_uid,
                        contact_uid,
                        native_sample_type_title(normalized),
                        original.vendor_name if original else None,
                    )
```

The SENAITE-born call at `:787-793` (`ar_data.sample_type_title`) is untouched, so the legacy BW registry signal is byte-identical.

- [ ] **Step 4: Run, expect PASS**

Run: `pytest tests/unit/test_native_sample_meta.py tests/unit/test_order_processor_native.py tests/unit/test_senaite.py -q && ruff check . && mypy app`

- [ ] **Step 5: Commit**

```bash
git add -- app/services/native_sample.py app/services/order_processor.py tests/unit/test_native_sample_meta.py tests/unit/test_order_processor_native.py
git commit -m "feat(native-meta): Bacteriostatic Water title and Benzyl Alcohol slot for native BW (IB2)" -- app/services/native_sample.py app/services/order_processor.py tests/unit/test_native_sample_meta.py tests/unit/test_order_processor_native.py
```

---

### Task I4: Part B, ships only after T0 passes. All-native samples mint no SENAITE AR

**Gate.** Do not start this task until the spec's Part B T0 evidence is recorded:
- the prod order counts by service combination
- a proof that the Mk1 COA renders a native-born sample with no page-1 family

If T0 names combinations that cannot render, add the exclusion clause given in the Notes before Step 3.

**Repo:** integration-service
**Files:**
- Modify: `app/services/order_validator.py:376-396` (`_validate_sample` lims decision)
- Test: `tests/unit/test_native_routing.py`, `tests/unit/test_order_processor_native.py`, `tests/unit/test_native_service_keys.py:443-460`

**Interfaces:**
- Consumes: `NATIVE_BW_KEY` (I1, for the synced set in the matrix test)
- Produces: in `_validate_sample`, `lims="mk1"` whenever:
  - at least one non-legacy native key is selected, AND
  - the mapped SENAITE profiles are empty **before** the variance drop, AND
  - the valve is on.

  `native_hplc` and `native_retest` keep their semantics. Mixed samples and valve-off samples stay on senaite.

**Deliberate test inversions.** These were approved by spec Part B ("Who it changes"); they are not stale-test cleanups:
1. `tests/unit/test_native_routing.py:73-79`, `test_same_services_without_retest_spec_still_route_to_senaite`: fentanyl-only now routes to mk1.
2. `tests/unit/test_native_service_keys.py:443-460`, `test_identity_lookup_skipped_when_not_mapped`: the heavy_metals-only order now mints in Mk1.
   - `_new_processor()` injects no Accu-Mk1 adapter.
   - `get_accumk1_adapter()` raises when it is not configured, so the sample would fail and `status == "accepted"` would break.
   - The test gets an injected adapter.

**Already safe, verified at origin/master:**
- `order_processor.py:477` (`needs_senaite`) and `:518` (client/contact resolution) already skip SENAITE for an all-mk1 order.
- `_registry_enrichment` (`:177-182`) degrades every customer-derived key to None.
- The Identity(HPLC) lookup is gated on `"peptide_identity" in normalized.profiles` (`:701`).
- The native branch builds Peptide/Peptide Blend meta with the same `format_analyte_slots` the SENAITE path uses for these samples today.
- `test_native_service_keys.py:388-403` (validator-only, profiles == []) and `test_catalog_registry_wiring.py:89-108` (validator-only) still pass unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/test_native_routing.py`:

```python
# --- Part B: all-native samples are Mk1-born (spec 2026-10-05) --------------

PART_B_SYNCED = {
    NATIVE_HPLC_KEY, NATIVE_BW_KEY, NATIVE_ENDO, "rapid-sterility-pcr", "fentanyl",
    "heavy_metals",
}


@pytest.mark.parametrize(
    ("services", "valve_off", "expected_lims", "expected_profiles"),
    [
        pytest.param({"heavy_metals": True}, False, "mk1", [], id="native-only-floor-key"),
        pytest.param({"fentanyl": True}, False, "mk1", [], id="native-only-synced-key"),
        pytest.param(
            {NATIVE_ENDO: True, "rapid-sterility-pcr": True}, False, "mk1", [],
            id="native-endo-pcr-only",
        ),
        pytest.param(
            {"heavy_metals": True, "endotoxin": True}, False, "senaite", ["endotoxin"],
            id="mixed-legacy-endotoxin",
        ),
        pytest.param(
            {"heavy_metals": True, "samplevariance": True}, False, "senaite",
            ["sample_variance"], id="native-plus-variance-stays-senaite",
        ),
        pytest.param(
            {"heavy_metals": True, "hplcpurity_identity": True}, False, "senaite",
            ["peptide_identity"], id="mixed-legacy-hplc",
        ),
        pytest.param({"heavy_metals": True}, True, "senaite", [], id="valve-off"),
        pytest.param(
            {NATIVE_HPLC_KEY: True, "heavy_metals": True}, False, "mk1", [],
            id="native-hplc-unchanged",
        ),
        pytest.param(
            {"hplcpurity_identity": True}, False, "senaite", ["peptide_identity"],
            id="legacy-hplc-unchanged",
        ),
    ],
)
def test_part_b_rule_matrix(
    services: dict,
    valve_off: bool,
    expected_lims: str,
    expected_profiles: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import catalog_registry
    catalog_registry._set_synced(PART_B_SYNCED, datetime.now(UTC))
    if valve_off:
        monkeypatch.setenv("LIMS_NATIVE_ROUTING_DISABLED", "1")
    result = DefaultOrderValidator().validate(
        _order_with(services=SampleServices(**services))
    )
    assert result.valid, result.errors
    s = result.normalized_samples[0]
    assert (s.lims, s.profiles) == (expected_lims, expected_profiles)
    assert s.native_hplc is (NATIVE_HPLC_KEY in services and not valve_off)


def test_part_b_ignores_shadowed_legacy_field_name_extra(
    validator: DefaultOrderValidator,
) -> None:
    """A legacy field name left in model_extra by an alias collision
    (order.py:182-190) is in the working set but is not a native key."""
    services = SampleServices.model_validate(
        {"rapidsterilityscreening(pcr)": False, "sterility_pcr": True}
    )
    assert services.model_extra == {"sterility_pcr": True}  # precondition
    result = validator.validate(_order_with(services=services))
    assert result.normalized_samples[0].lims == "senaite"
```

Invert `test_same_services_without_retest_spec_still_route_to_senaite` at `:73-79`, replacing it with:

```python
def test_same_services_without_retest_spec_route_to_mk1_via_part_b():
    """Part B (spec 2026-10-05): an all-native sample is Mk1-born with or
    without a retest spec. Was ..._still_route_to_senaite before Part B."""
    from app.services import catalog_registry
    catalog_registry._set_synced({NATIVE_HPLC_KEY, "fentanyl"}, datetime.now(UTC))
    v = DefaultOrderValidator()
    order = _order_with(services=SampleServices(**{"fentanyl": True}))
    result = v.validate(order)
    assert result.normalized_samples[0].lims == "mk1"
```

Append to `tests/unit/test_order_processor_native.py`:

```python
@pytest.mark.asyncio
async def test_part_b_all_native_non_hplc_order_mints_without_senaite():
    """heavy_metals-only, and no SENAITE config at all: minted in Mk1, no
    SENAITE client/contact/AR calls (needs_senaite is False)."""
    senaite = _make_senaite_mock()
    accumk1 = MagicMock(spec=AccuMk1Adapter)
    accumk1.notify_sample_created = AsyncMock(
        return_value={"sample_id": "P-5002", "native_id": "aP-0002"}
    )
    processor = OrderProcessor(
        validator=DefaultOrderValidator(),
        senaite=senaite,
        senaite_config=None,
        accumk1=accumk1,
    )
    sample = Sample(
        number=1,
        analytical_test="Single Peptide",
        sample_identity="BPC-157",
        sample_weight="10",
        services=SampleServices(heavy_metals=True),
    )

    resp = await processor.process(_order(samples=[sample]), db=_FakeAsyncSession())

    assert resp.status == "accepted", resp.errors
    assert resp.sample_results[0].lims == "mk1"
    senaite.lookup_or_create_client.assert_not_called()
    senaite.lookup_or_create_contact.assert_not_called()
    senaite.create_analysis_request.assert_not_called()
    meta = accumk1.notify_sample_created.call_args.kwargs["meta"]
    assert meta["SampleTypeTitle"] == "Peptide"
    assert meta["Analyte1Peptide"] == "BPC-157 - Identity (HPLC)"
```

In `tests/unit/test_native_service_keys.py`, add `from app.adapters.accumk1 import AccuMk1Adapter` to the imports at `:35`. Then replace `test_identity_lookup_skipped_when_not_mapped` (`:443-460`) with:

```python
    @pytest.mark.asyncio
    async def test_identity_lookup_skipped_when_not_mapped(self) -> None:
        """native-only peptide order: lookup_analysis_uid never called.
        Part B (spec 2026-10-05): the sample is now Mk1-born, so the
        processor needs an Accu-Mk1 adapter and no SENAITE AR is created."""
        sample = Sample(
            number=1,
            analytical_test="Single Peptide",
            sample_identity="BPC-157",
            sample_weight="10",
            services=SampleServices(heavy_metals=True),
        )
        order = _order(sample)
        db = _FakeAsyncSession()
        senaite = _senaite_mock()
        accumk1 = MagicMock(spec=AccuMk1Adapter)
        accumk1.notify_sample_created = AsyncMock(return_value={"sample_id": "P-5001"})
        processor = OrderProcessor(
            validator=DefaultOrderValidator(),
            senaite=senaite,
            senaite_config=_senaite_config(),
            wc_adapter=MagicMock(),
            accumk1=accumk1,
        )

        response = await processor.process(order, db=db)

        senaite.lookup_analysis_uid.assert_not_called()
        senaite.create_analysis_request.assert_not_called()
        assert response.status == "accepted"
        assert response.sample_results[0].lims == "mk1"
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `pytest tests/unit/test_native_routing.py tests/unit/test_order_processor_native.py tests/unit/test_native_service_keys.py -q`. Expected failures:
- the `native-only-floor-key`, `native-only-synced-key` and `native-endo-pcr-only` matrix rows (`('senaite', []) != ('mk1', [])`)
- `test_same_services_without_retest_spec_route_to_mk1_via_part_b`
- `test_part_b_all_native_non_hplc_order_mints_without_senaite`, which returns the validation-only "PENDING" response because `needs_senaite` is True
- `test_identity_lookup_skipped_when_not_mapped`, on the `lims == "mk1"` assert

All other rows pass.

- [ ] **Step 3: Implement**

In `_validate_sample`, `app/services/order_validator.py`, after the `native_retest` assignment (`:390-394`) and before `lims: Literal["senaite", "mk1"]` (`:395`), insert:

```python
        # Part B (spec 2026-10-05): a sample whose selected services are ALL
        # native (a real catalog key, not a legacy field name left in
        # model_extra by an alias collision) maps to zero SENAITE profiles and
        # is Mk1-born, whatever its matrix. `profiles` here is BEFORE the
        # variance drop below, so native + samplevariance stays mixed
        # (senaite). Same valve as native_hplc / native_retest.
        native_only = (
            not profiles
            and not native_routing_disabled()
            and any(
                isinstance(v, bool)
                and v
                and k in working
                and k not in _LEGACY_FIELD_NAMES
                and k not in _LEGACY_ALIASES
                for k, v in (sample.services.model_extra or {}).items()
            )
        )
```

Then change `:396`:

```python
        if native_hplc or native_retest:
```

to:

```python
        if native_hplc or native_retest or native_only:
```

The error label at `:411` (`"hplc-purity-identity" if native_hplc else "a Mk1 retest spec"`) cannot fire for `native_only` alone, because its profiles are empty by definition. Leave it unchanged.

- [ ] **Step 4: Run, expect PASS**

Run: `pytest tests/unit -q && ruff check . && mypy app`

Gate on the failure-set diff against a pre-change `pytest tests/unit -q` baseline: the only change allowed is that the I4 tests now pass. `test_order_services_updated.py` has env-dependent baseline failures, per `test_catalog_registry_wiring.py:155-158`.

- [ ] **Step 5: Commit**

```bash
git add -- app/services/order_validator.py tests/unit/test_native_routing.py tests/unit/test_order_processor_native.py tests/unit/test_native_service_keys.py
git commit -m "feat(validator): all-native samples are Mk1-born, no SENAITE AR (Part B)" -- app/services/order_validator.py tests/unit/test_native_routing.py tests/unit/test_order_processor_native.py tests/unit/test_native_service_keys.py
```

---


# Part 5: Part B gate, rehearsal, flip

### Task T0: Part B evidence gate

**Repo:** none (prod read-only, plus an accumark-stack)

**Step 1 result, already run 2026-10-05 against prod Mk1 (read-only, Handler-approved):**
- Of the 1,833 SENAITE-born parents created since 2026-08-01, **zero** had no SENAITE-origin analysis.
- No all-native, non-HPLC order has reached prod. Part B changes routing for zero historical orders; it is forward protection only.

Query used, re-runnable:

```sql
with per as (
  select ls.id, ls.sample_id, ls.sample_type_title,
    count(*) filter (where svc.origin='senaite') n_senaite,
    count(*) filter (where svc.origin='mk1') n_mk1
  from lims_samples ls
  left join lims_analyses la on la.lims_sample_pk = ls.id
       and la.review_state not in ('rejected','retracted')
  left join analysis_services svc on svc.id = la.analysis_service_id
  where ls.created_at > '2026-08-01' and ls.external_lims_system = 'senaite'
  group by 1,2,3)
select sample_type_title, count(*) from per where n_senaite = 0 group by 1;
```

Run it through `ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python' < script.py`. Wrap the SQL in a `SessionLocal().execute(text(...))` script; never use psql on the host.

- [ ] **Step 2: Prove the COA path for a native-born sample with no page-1 family, on the rehearsal stack (Task R1)**
  1. Place one order per combination: peptide + `endotoxin-usp85-lal` only, peptide + `rapid-sterility-pcr` only, peptide + `heavy_metals` only.
  2. Run it with the Part B IS build: mint, check-in, bench, verify, Generate COA.
  3. Record per combination: COA generated (PDF + verification code) **or** the exact 4xx and its message.
- [ ] **Step 3: Decide, and record the outcome in the plan ledger**
  - Every combination renders: Part B ships as written.
  - A combination fails: add it to an explicit exclusion set in IS Task I-PartB (`_NATIVE_ONLY_EXCLUDED` keyed by the frozenset of native keys) with a test, so those orders keep today's bare-AR path.
  - Do NOT change COA rendering in this plan; that is a follow-up spec.

### Task R1: Four-repo rehearsal on an accumark-stack

**Repo:** accumark-stack. Invoke the `accumark-stack-platform` skill first; it owns the recreate and mount traps.

- [ ] **Step 1: Bring up a stack**
  - Mount the Mk1 branch, the IS branch, the coabuilder branch, and the wpstar checkout (no code change).
  - Pass BOTH compose `-f` files on any recreate, or the mount override is dropped (memory: stack recreate trap).
- [ ] **Step 2: Confirm the boot seed and counter**
  - Mk1 admin shows services `PH-BW`, `BENZYL-ALCOHOL-BW`, `FILL-VOLUME-BW` (Analytical).
  - Profile `bacteriostatic-water-panel` exists and is inactive, with archetype `legacy_bw`.
  - `lims_native_id_sequences` has a `BW` row with next_value 1000.
- [ ] **Step 3: Sync the IS catalog and confirm the key**
  - Trigger the IS catalog sync (admin route or wait for the job).
  - Confirm `bacteriostatic-water-panel` is in the synced keys.
- [ ] **Step 4: Flip the stack WP**
  - Set `profile_key=bacteriostatic-water-panel` on the "Bac Water Panel" test-service row, keeping vials 0 and the name unchanged.
- [ ] **Step 5: Native order end to end**
  - Order: BW + `endotoxin-usp85-lal` + `rapid-sterility-pcr`.
  - Expect a `BW-1000` minted by Mk1 with no SENAITE AR (stack SENAITE shows no new AR).
  - 3 parent placeholders, 0 flags.
  - Check-in seeds the 3-row panel on the BW S01 vial.
  - Enter pH 5.5, BA 0.90, fill 30 on S01, submit, promote to parent, and verify on the parent.
  - Attach the sample image and BA chromatogram to the parent, as today, then Generate COA. On the PDF, page 1 shows the BW panel with pH and BA "Conforms" and fill volume reported.
  - Endotoxin spec cell reads ≤ 0.25 EU/mL (NOT ≤ 5).
  - The AccuVerify page and the portal render.
- [ ] **Step 6: Legacy regression**
  - Clear the WP `profile_key`. Place a BW order: it must mint a SENAITE AR exactly as before.
  - Generate its COA, and diff against a pre-branch COA of the same data. It must be identical apart from codes and dates.
- [ ] **Step 7: Out-of-range check**
  - On a second native BW sample enter pH 8.0. The COA shows "Does Not Conform" and the badge FAILED.
- [ ] **Step 8: Part B (only if the Part B IS task is on the branch)**
  - Run T0 Step 2 here.

### Task F1: Production deploy and flip (Handler-run; each step needs Handler go)

- [ ] **Step 1: Deploy order**, each via the `accumark-deploy` skill, after lab hours (09-21 pg_dump incident rule):
  1. Mk1
  2. COABuilder
  3. IS (Part A, plus Part B if T0 passed)

  The deploys are behaviour-neutral: nothing sends the new key yet, and the profile is inactive.
- [ ] **Step 2: Post-deploy smoke, prod read-only**
  - The BW services, profile and `BW` counter exist (the Task R1 Step 2 checks, run as a prod script).
  - The IS synced keys contain `bacteriostatic-water-panel`.
  - `coa.source_setting.coa_generation_source(db) == "mk1"` (it was mk1 on 2026-10-05; native COAs require it).
- [ ] **Step 3: Flip.** Handler sets WP `profile_key=bacteriostatic-water-panel` on the "Bac Water Panel" row (vials 0). Do NOT activate the Mk1 profile.
- [ ] **Step 4: Test order**
  - The Handler places a BW + endo + PCR test order and walks it through. This repeats the WP-7133 pattern: check-in, bench, promote, COA PDF, AccuVerify, portal.
  - Confirm the endotoxin spec reads ≤ 0.25 EU/mL.
- [ ] **Step 5: Rollback (if needed)**
  - Clear the WP `profile_key`. New BW orders return to SENAITE.
  - IS `LIMS_NATIVE_ROUTING_DISABLED=1` is the global valve.
  - Already-minted native BW samples finish on the Mk1 path.
- [ ] **Step 6: Lab release note (before Step 3)**
  - Draft a short lab note, in the warm "we" team-doc voice, for Handler approval: from the flip, NEW BW samples (BW-1000 and up) take results on the S01 vial and are promoted, the same as HPLC/endo/PCR. In-flight BW-0xxx samples keep entering on the parent row until they drain.
  - The flip waits until the Handler has sent it to the lab.
- [ ] **Step 7: Record** the deploy state in memory (`project_prod_deploy_state`) and the vault session log.
