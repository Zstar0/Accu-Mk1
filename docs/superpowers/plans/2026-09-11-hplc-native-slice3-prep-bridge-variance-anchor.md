# HPLC Native-Born — Slice 3 (M5: prep bridge + variance series + spec anchor + FE classifiers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HPLC bench results land on native-born vials' generic trio rows (routed by `LimsAnalysis.peptide_id`), blend aggregates compute from per-slot rows, and every peptide-attribution read (variance series, variance-set UI verdict, spec tier anchor, FE classifiers) recognises native rows — all behaviour-neutral for SENAITE-born samples.

**Architecture:** Native-born vials (`lims_samples.external_lims_system == "mk1"`) carry `lims_analyses` rows on the five generic services `HPLC-IDENTITY / HPLC-PURITY / HPLC-QUANTITY` (per slot, with `peptide_id` + `slot`) and `HPLC-BLEND-PURITY / HPLC-BLEND-TOTAL` (aggregates, `peptide_id NULL`). Today every classifier (`_category` and its mirrors) returns `None` for those keywords and every peptide attribution joins `AnalysisService.peptide_id`, so native rows are invisible. This slice adds ONE shared classifier for the native keywords in `lims_analyses/hplc_native.py`, teaches the three `_category` mirrors + throughput to call it, adds a native routing tier to the prep bridge keyed on `(keyword in TRIO, LimsAnalysis.peptide_id == prep peptide)`, a native branch to `bridge_blend_aggregates` keyed on `slot`, and swaps the three `AnalysisService.peptide_id` joins for `COALESCE(LimsAnalysis.peptide_id, AnalysisService.peptide_id)`. Legacy tiers are never reached on a native vial (fail-closed, never guess).

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2.x (`select`, `func.coalesce`), pytest (in-memory SQLite fixtures), TypeScript + vitest for the two FE classifiers.

**Spec:** `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md` (main checkout, branch `docs/analysis-catalog-specs`; M5 line + "Addenda from slice-2 final review"). Plan-mode copy: `C:\Users\forre\.claude\plans\glistening-hopping-cupcake.md`.

**Branch / worktree:** `feat/hplc-native-slice3` at `C:\tmp\Accu-Mk1-hplc-slice3`, base `feat/hplc-native-slice2` @ `dfe6544f`. Python for tests: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe` run from the worktree `backend/` dir (bare `python` hangs). Test invocation: `<PY> -m pytest -q -p no:cacheprovider <paths>`.

## Global Constraints

- **Additive only.** Never flip `analysis_services.origin`; never change the SENAITE-born path's behaviour. Every new branch is reached only when the vial carries native keywords (`TRIO`/`AGGREGATES` from `lims_analyses/hplc_native.py`) or when a row's own `peptide_id` is set — both impossible on legacy data (all legacy rows have `peptide_id NULL`, `slot NULL`).
- **Never guess.** A native result category with 0 or 2+ matching rows is skipped with a WARN. A `peptide_id NULL` (unresolved) native row is NEVER matched by the bridge (spec addendum "Unresolved rows are NOT gated yet").
- **Identity result vocabulary on native rows:** literal `Conforms` / `Does Not Conform` (Handler ruling 2026-09-10). Legacy rows keep writing the peptide name.
- **Reuse constants:** `TRIO`, `AGGREGATES`, `KW_*` from `backend/lims_analyses/hplc_native.py`; never new keyword literals in the bridge, series, or verdict modules (the guard test `tests/test_identity_convergence_guard.py` inventories keyword comparisons — new comparisons on the native keywords must go through the shared helper added in Task 1, which is registered there).
- **Pathspec commits only:** `git add <paths> && git commit -- <paths>` (shared worktree doctrine). Never `git stash`.
- **Legacy keyword sets untouched:** `LEGACY_DEMAND_KEYS`, `_ANALYTE_PUR/_QTY` regexes, `HPLC-ID`/`HPLC-PUR`/`PEPT-TOTAL`/`BLEND-PUR` literals all stay exactly as they are.
- **Test gate = failure-set diff vs base** (`feat/hplc-native-slice2`), same window, never "zero failures" (shared dev Postgres drifts; `tests/test_variance_set.py` is live-DB and order-dependent). Known pre-existing failure: `tests/test_identity_convergence_guard.py::test_no_unclassified_keyword_identity_site`.

---

## File structure

| File | Responsibility in this slice |
|---|---|
| `backend/lims_analyses/hplc_native.py` | + `native_category(keyword) -> Optional[str]` — the ONE classifier for the five native keywords (trio → purity/quantity/identity; aggregates → `None`, matching how legacy `BLEND-PUR`/`PEPT-Total` are treated by the bridge/stamper) |
| `backend/lims_analyses/prep_bridge.py` | `_category` consults `native_category` first; `_pick_target` gains a native tier; `_result_for` gains `native` flag; `bridge_prep_result_to_vial` detects a native vial and routes by `peptide_id`; `bridge_blend_aggregates` gains a slot-paired native branch |
| `backend/coa/variance_series.py` | `_category` consults `native_category` first; two `Peptide` outerjoins use `COALESCE(LimsAnalysis.peptide_id, AnalysisService.peptide_id)` |
| `backend/coa/identity_verdict.py` | `is_identity_keyword` recognises `KW_IDENTITY` |
| `backend/coa/spec_rules.py` | `sample_peptide_id` selects the COALESCE |
| `backend/sub_samples/service.py` | `_fetch_mk1_results_for_host` outerjoin uses the COALESCE |
| `backend/throughput.py` | `HPLC_KEYWORDS` includes the five native keywords (report classification only) |
| `src/lib/hplc-analyte-services.ts`, `src/lib/vial-assignment.ts` | FE classifiers learn the native keywords |
| Tests | `backend/tests/test_prep_bridge_native.py` (new), extend `test_hplc_native_module.py`, `test_variance_series.py`, `test_spec_rules.py`, `test_identity_verdict.py`, `test_throughput.py`, new `test_variance_results_native.py`; FE `src/test/hplc-analyte-services.test.ts`, `src/lib/__tests__/vial-assignment.test.ts` |

Known limitations carried forward (NOT built here, ledger them in the spec addenda in Task 7): (a) `coa/variance_series.build_variance_analyte_series` and `sub_samples/service._fetch_mk1_results_for_host` are keyword-keyed dicts — on a native BLEND, N slots share keyword `HPLC-PURITY` and collide; single-peptide native samples are unaffected. Re-keying belongs to M7 (the COA shim maps native rows to `ANALYTE-{slot}-*` wire keywords, and the variance-set UI needs a slot-aware key). (b) `_series_keys` derives the series key from the identity row TITLE — native identity rows carry the stamped `"<name> - Identity (HPLC)"` title so this already works; an unresolved slot's identity title is the raw label and would key the series under it, which is acceptable because unresolved rows never receive a result in this slice.

---

### Task 1: Shared native keyword classifier + the three `_category` mirrors + throughput

**Files:**
- Modify: `backend/lims_analyses/hplc_native.py` (after `AGGREGATES`, line ~45)
- Modify: `backend/lims_analyses/prep_bridge.py:63-75` (`_category`)
- Modify: `backend/coa/variance_series.py:44-59` (`_category`)
- Modify: `backend/coa/identity_verdict.py:33-36` (`is_identity_keyword`)
- Modify: `backend/throughput.py:41` (`HPLC_KEYWORDS`)
- Modify: `backend/tests/test_identity_convergence_guard.py` (register the new helper as a PERMANENT keyword site — read the file's `SWEPT_FILES`/PERMANENT structure first; slice 2 added `native_hplc_services` there the same way)
- Test: `backend/tests/test_hplc_native_module.py`, `backend/tests/test_prep_bridge_native.py` (new), `backend/tests/test_variance_series.py`, `backend/tests/test_identity_verdict.py`, `backend/tests/test_throughput.py`

**Interfaces:**
- Produces: `lims_analyses.hplc_native.native_category(keyword: Optional[str]) -> Optional[str]` returning `"identity" | "purity" | "quantity"` for `KW_IDENTITY / KW_PURITY / KW_QUANTITY` (case-insensitive), `None` for everything else including `AGGREGATES`.
- Consumed by Tasks 2, 3, 4.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_hplc_native_module.py`:

```python
from lims_analyses.hplc_native import native_category, KW_IDENTITY, KW_PURITY, KW_QUANTITY, KW_BLEND_PURITY, KW_BLEND_TOTAL


def test_native_category_trio_and_aggregates():
    assert native_category(KW_IDENTITY) == "identity"
    assert native_category(KW_PURITY) == "purity"
    assert native_category(KW_QUANTITY) == "quantity"
    assert native_category("hplc-purity") == "purity"          # case-insensitive
    # Aggregates are not a bridged/stamped category (mirrors legacy BLEND-PUR /
    # PEPT-Total handling: owned by bridge_blend_aggregates, never a direct target).
    assert native_category(KW_BLEND_PURITY) is None
    assert native_category(KW_BLEND_TOTAL) is None
    # Legacy keywords are NOT this helper's business.
    assert native_category("HPLC-PUR") is None
    assert native_category("ID_BPC157") is None
    assert native_category(None) is None
```

Create `backend/tests/test_prep_bridge_native.py` with the shared fixtures every later task in this plan extends (write the whole file now; later tasks append tests):

```python
"""Prep bridge on NATIVE-BORN vials (spec 2026-09-10 M5).

Native vials carry the generic trio per slot with LimsAnalysis.peptide_id +
slot stamped by the native seeder; routing is by peptide_id, never by keyword
prefix. Fixtures mirror tests/test_prep_bridge.py (in-memory SQLite via the
conftest db_session) plus the native catalog from test_hplc_native_seeder.py.
"""
from typing import Optional

from models import AnalysisService, Department, HPLCAnalysis, LimsSample, LimsSubSample, Peptide
from lims_analyses.service import create_analysis
from lims_analyses.hplc_native import (
    KW_IDENTITY, KW_PURITY, KW_QUANTITY, KW_BLEND_PURITY, KW_BLEND_TOTAL,
    identity_title, purity_title, quantity_title,
)
from lims_analyses.prep_bridge import (
    _category, bridge_prep_result_to_vial, bridge_blend_aggregates, stamp_prep_assignment,
)


def _catalog(db) -> dict[str, AnalysisService]:
    from catalog.hplc_native_seed import HPLC_NATIVE_SERVICES
    dept = Department(name="Analytical")
    db.add(dept)
    db.flush()
    out = {}
    for kw, title, unit, rtype, vc in HPLC_NATIVE_SERVICES:
        svc = AnalysisService(title=title, keyword=kw, unit=unit, result_type=rtype,
                              origin="mk1", variance_capable=vc, department_id=dept.id)
        db.add(svc)
        db.flush()
        out[kw] = svc
    return out


def _peptide(db, name, abbr):
    p = Peptide(name=name, abbreviation=abbr, active=True)
    db.add(p)
    db.flush()
    return p


def _native_vial(db, sample_id="P-5001", sample_type="Peptide"):
    parent = LimsSample(sample_id=sample_id, external_lims_system="mk1",
                        external_lims_uid=None, sample_type_title=sample_type, analytes="[]")
    db.add(parent)
    db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=None,
                         sample_id=f"{sample_id}-S01", vial_sequence=1)
    db.add(vial)
    db.flush()
    return parent, vial


def _trio(db, vial, services, *, slot: int, peptide: Optional[Peptide], name: str):
    """Seed one slot's identity/purity/quantity rows the way seed_native_hplc_rows does."""
    pid = peptide.id if peptide else None
    idr = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=services[KW_IDENTITY].id, keyword=KW_IDENTITY,
                          title=identity_title(name) if peptide else name, peptide_id=pid, slot=slot,
                          reportable_reason=None if peptide else f"analyte_unresolved: {name}")
    pur = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=services[KW_PURITY].id, keyword=KW_PURITY,
                          title=purity_title(name), peptide_id=pid, slot=slot)
    qty = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=services[KW_QUANTITY].id, keyword=KW_QUANTITY,
                          title=quantity_title(name), peptide_id=pid, slot=slot)
    return idr, pur, qty


def _aggregates(db, vial, services):
    bp = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                         analysis_service_id=services[KW_BLEND_PURITY].id, keyword=KW_BLEND_PURITY,
                         title=services[KW_BLEND_PURITY].title)
    bt = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                         analysis_service_id=services[KW_BLEND_TOTAL].id, keyword=KW_BLEND_TOTAL,
                         title=services[KW_BLEND_TOTAL].title)
    return bp, bt


def _hplc(db, pep, *, purity=None, conforms=None, qty=None, instrument_id=None):
    a = HPLCAnalysis(peptide_id=pep.id, purity_percent=purity, identity_conforms=conforms,
                     quantity_mg=qty, instrument_id=instrument_id)
    db.add(a)
    db.flush()
    return a


def test_category_learns_the_native_trio():
    assert _category(KW_PURITY) == "purity"
    assert _category(KW_QUANTITY) == "quantity"
    assert _category(KW_IDENTITY) == "identity"
    assert _category(KW_BLEND_PURITY) is None
    assert _category(KW_BLEND_TOTAL) is None
    # legacy arms unchanged
    assert _category("HPLC-PUR") == "purity" and _category("ID_BPC157") == "identity"
    assert _category("PEPT-TOTAL") is None


def test_stamp_prep_assignment_reaches_native_trio_rows(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    changed = stamp_prep_assignment(db, lims_sub_sample_pk=vial.id, instrument_id=7, method_id=3, user_id=1)
    assert set(changed) == {idr.id, pur.id, qty.id}
    db.refresh(pur)
    assert pur.instrument_id == 7 and pur.method_id == 3
```

NOTE for the implementer: `HPLCAnalysis` may require more NOT NULL columns than the `_hplc` helper sets — copy the exact constructor from `tests/test_prep_bridge.py::_hplc` (lines 32-45) instead of the sketch above if it differs. Same for `create_analysis` kwargs: `peptide_id`, `slot`, `reportable_reason` were added in slice 1 (`lims_analyses/service.py::create_analysis`) — verify the names.

Append to `backend/tests/test_variance_series.py`:

```python
def test_category_learns_native_trio_and_ignores_aggregates():
    from coa.variance_series import _category
    assert _category("HPLC-PURITY") == "purity"
    assert _category("HPLC-QUANTITY") == "quantity"
    assert _category("HPLC-IDENTITY") == "identity"
    assert _category("HPLC-BLEND-PURITY") is None
    assert _category("HPLC-BLEND-TOTAL") is None
    assert _category("PEPT-Total") == "quantity"   # legacy single-peptide quantity unchanged
```

Append to `backend/tests/test_identity_verdict.py::test_identity_keyword_classifier` body:

```python
    assert is_identity_keyword("HPLC-IDENTITY")
    assert not is_identity_keyword("HPLC-PURITY")
```

Add to the `test_classify_keyword` parametrize table in `backend/tests/test_throughput.py`:

```python
        ("HPLC-IDENTITY", None, "hplc"),
        ("HPLC-PURITY", None, "hplc"),
        ("HPLC-BLEND-TOTAL", None, "hplc"),
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `<PY> -m pytest -q -p no:cacheprovider tests/test_hplc_native_module.py tests/test_prep_bridge_native.py tests/test_variance_series.py tests/test_identity_verdict.py tests/test_throughput.py`
Expected: FAIL — `ImportError: cannot import name 'native_category'`, then assertion failures on the mirrors.

- [ ] **Step 3: Implement**

`backend/lims_analyses/hplc_native.py`, directly after the `assert set(TRIO + AGGREGATES) == ...` line:

```python
_NATIVE_CATEGORY = {
    KW_IDENTITY: "identity",
    KW_PURITY: "purity",
    KW_QUANTITY: "quantity",
}


def native_category(keyword: Optional[str]) -> Optional[str]:
    """Result category of a NATIVE trio keyword; None for everything else.

    The single source every `_category` mirror (prep_bridge, coa.variance_series,
    coa.identity_verdict) consults first, so the three cannot drift on the
    native keywords. Aggregates (HPLC-BLEND-*) are deliberately None: like
    legacy BLEND-PUR / PEPT-Total they are owned by bridge_blend_aggregates
    and are never a direct bridge/stamp target nor a per-peptide series row.
    """
    return _NATIVE_CATEGORY.get((keyword or "").upper())
```

`backend/lims_analyses/prep_bridge.py::_category` — add as the first statement after the `kw = ...` line:

```python
    from lims_analyses.hplc_native import native_category
    native = native_category(kw)
    if native is not None:
        return native
```

(Import inside the function only if a module-level import creates a cycle — `hplc_native` imports `lims_analyses.service`, and `prep_bridge` already imports `lims_analyses.service`, so a module-level `from lims_analyses.hplc_native import native_category, TRIO, KW_BLEND_PURITY, KW_BLEND_TOTAL, KW_PURITY, KW_QUANTITY` next to the existing imports is expected to work; try module-level first and fall back to function-level if `pytest` reports a circular import.)

`backend/coa/variance_series.py::_category` — same three lines before the legacy branches, using a module-level `from lims_analyses.hplc_native import native_category` (coa already imports from lims_analyses elsewhere; if it cycles, import inside the function).

`backend/coa/identity_verdict.py::is_identity_keyword`:

```python
    kw = (keyword or "").upper()
    from lims_analyses.hplc_native import native_category
    return native_category(kw) == "identity" or kw == "HPLC-ID" or kw.startswith("ID_")
```

`backend/throughput.py:41`:

```python
HPLC_KEYWORDS = frozenset({
    "HPLC-PUR", "PEPT-Total", "HPLC-ID", "BLEND-PUR",
    # HPLC native-born trio + aggregates (spec 2026-09-10)
    "HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY", "HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL",
})
```

`backend/tests/test_identity_convergence_guard.py`: run it; if the new `native_category` comparison (`_NATIVE_CATEGORY.get(...)` is a dict lookup, not a comparison, so it should NOT register) or the `is_identity_keyword` change surfaces as an unclassified site, add the site as PERMANENT the same way slice 2 added `native_hplc_services` (grep `native_hplc_services` in that test for the exact entry shape). Do NOT change the ledger counts for legacy sites.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `<PY> -m pytest -q -p no:cacheprovider tests/test_hplc_native_module.py tests/test_prep_bridge_native.py tests/test_variance_series.py tests/test_identity_verdict.py tests/test_throughput.py tests/test_prep_bridge.py tests/test_prep_assignment_stamp.py tests/test_identity_convergence_guard.py`
Expected: all PASS except the known pre-existing `test_no_unclassified_keyword_identity_site` (must show the SAME failure text as on base — compare by checking out nothing: run the same file on base via `git stash`-free means, i.e. `git worktree` of slice 2 at `C:\tmp\Accu-Mk1-hplc-slice2` — `cd` there and run the single test).

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/hplc_native.py backend/lims_analyses/prep_bridge.py backend/coa/variance_series.py backend/coa/identity_verdict.py backend/throughput.py backend/tests/test_hplc_native_module.py backend/tests/test_prep_bridge_native.py backend/tests/test_variance_series.py backend/tests/test_identity_verdict.py backend/tests/test_throughput.py backend/tests/test_identity_convergence_guard.py
git commit -- <same paths> -m "feat(hplc-native): shared native_category; _category mirrors + throughput learn the trio

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Prep bridge routes results onto native trio rows by `peptide_id`

**Files:**
- Modify: `backend/lims_analyses/prep_bridge.py:112-125` (`_result_for`), `:128-203` (`_pick_target`), `:393-506` (`bridge_prep_result_to_vial`)
- Test: `backend/tests/test_prep_bridge_native.py`

**Interfaces:**
- Consumes: `native_category`, `TRIO` (Task 1 / hplc_native).
- Produces: `_pick_target(..., native_peptide_id: Optional[int] = None, native: bool = False)`; `_result_for(category, analysis, peptide, *, native: bool = False)`. Native identity value = `"Conforms"` / `"Does Not Conform"`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_prep_bridge_native.py`:

```python
def test_native_single_routes_trio_by_peptide_id(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=98.5, conforms=True, qty=4.2, instrument_id=9)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert set(ids) == {idr.id, pur.id, qty.id}
    for r in (idr, pur, qty):
        db.refresh(r)
    assert pur.result_value == "98.5" and pur.review_state == "to_be_verified"
    assert qty.result_value == "4.2"
    assert idr.result_value == "Conforms"          # literal token, NOT the peptide name (ruling 2026-09-10)
    assert pur.instrument_id == 9


def test_native_identity_fail_writes_does_not_conform(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, _, _ = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, conforms=False)
    bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    db.refresh(idr)
    assert idr.result_value == "Does Not Conform"


def test_native_identity_unknown_is_skipped(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, _ = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=97.0, conforms=None)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert ids == [pur.id]
    db.refresh(idr)
    assert idr.review_state == "unassigned" and idr.result_value is None


def test_native_blend_routes_only_the_matching_slot(db_session):
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    tb = _peptide(db, "TB-500", "TB500")
    _, vial = _native_vial(db, sample_id="PB-1001", sample_type="Peptide Blend")
    id1, pur1, qty1 = _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    id2, pur2, qty2 = _trio(db, vial, services, slot=2, peptide=tb, name="TB-500")
    _aggregates(db, vial, services)
    a = _hplc(db, tb, purity=96.1, conforms=True, qty=2.0)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=tb, user_id=1)
    assert set(ids) == {id2.id, pur2.id, qty2.id}
    db.refresh(pur1); db.refresh(id1)
    assert pur1.review_state == "unassigned" and id1.review_state == "unassigned"


def test_native_unresolved_slot_never_matches(db_session):
    """peptide_id NULL (analyte_unresolved) rows are never a bridge target — even
    when they are the only rows in the category (spec addendum: never guess)."""
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=None, name="Mystery Peptide")
    a = _hplc(db, pep, purity=99.0, conforms=True, qty=1.0)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert ids == []
    db.refresh(pur)
    assert pur.review_state == "unassigned"


def test_native_duplicate_slot_rows_are_ambiguous(db_session):
    """Two pending HPLC-PURITY rows for the same peptide (should be impossible
    under the widened unique index, but sqlite has no index here) → skip, never guess."""
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    _trio(db, vial, services, slot=2, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=99.0, conforms=True, qty=1.0)
    assert bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1) == []


def test_native_vial_never_falls_through_to_legacy_generic(db_session):
    """A stray legacy HPLC-PUR row on a native vial must not be written by a
    peptide whose native row is absent — native vials use the native tier only."""
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    other = _peptide(db, "GHK-Cu", "GHKCU")
    _, vial = _native_vial(db)
    _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    stray = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                            analysis_service_id=999, keyword="HPLC-PUR", title="Purity (HPLC)")
    a = _hplc(db, other, purity=90.0, conforms=True, qty=1.0)
    assert bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=other, user_id=1) == []
    db.refresh(stray)
    assert stray.review_state == "unassigned"


def test_native_rerun_does_not_touch_already_bridged_rows(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=98.5, conforms=True, qty=4.2)
    first = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert len(first) == 3
    b = _hplc(db, pep, purity=50.0, conforms=False, qty=9.9)
    assert bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=b, peptide=pep, user_id=1) == []
    db.refresh(pur)
    assert pur.result_value == "98.5"
```

- [ ] **Step 2: Run to verify they fail**

Run: `<PY> -m pytest -q -p no:cacheprovider tests/test_prep_bridge_native.py`
Expected: the eight new tests FAIL (rows stay `unassigned`; identity writes the peptide name).

- [ ] **Step 3: Implement**

`_result_for` (replace the identity arm):

```python
def _result_for(category: str, analysis: HPLCAnalysis, peptide: Optional[Peptide],
                *, native: bool = False) -> Optional[str]:
    if category == "purity":
        return _fmt_num(analysis.purity_percent)
    if category == "quantity":
        return _fmt_num(analysis.quantity_mg)
    if category == "identity":
        if analysis.identity_conforms is None:
            return None
        if native:
            # Native-born rows carry the literal verdict (Handler ruling
            # 2026-09-10); spec row is `equals "Conforms"` and COABuilder's
            # _identity_matches already accepts the token.
            return "Conforms" if analysis.identity_conforms else "Does Not Conform"
        if analysis.identity_conforms:
            # Conforming identity result_value is the peptide name (matches the
            # live ID_* convention, e.g. ID_BPC157 -> "BPC-157").
            return peptide.name if peptide else "Conforms"
        return "Non-conforming"
    return None
```

`_pick_target` — add the native tier as the FIRST statement of the body (before `if category == "identity":`), and two keyword-only params `native: bool = False, native_peptide_id: Optional[int] = None`:

```python
    if native:
        # Native-born vial: the ONLY tier is (keyword in TRIO, row.peptide_id ==
        # prep peptide). A NULL-peptide row (analyte_unresolved) never matches;
        # 0 or 2+ matches never guess; legacy tiers are never consulted.
        if native_peptide_id is None:
            return None
        m = [
            r for r in candidates
            if (r.keyword or "").upper() in TRIO and r.peptide_id == native_peptide_id
        ]
        return m[0] if len(m) == 1 else None
```

`bridge_prep_result_to_vial` — after `live_keywords` is computed, add:

```python
    # Native-born vial = any live native trio keyword on it. Routing is then
    # by LimsAnalysis.peptide_id only (spec 2026-09-10 M5); the per-substance
    # / ANALYTE-slot / generic legacy tiers are never consulted, and no SENAITE
    # slot lookup happens (native vials have no ANALYTE-N rows).
    native = bool(live_keywords & set(TRIO))
    native_peptide_id = peptide.id if (native and peptide is not None) else None
```

Then, in the per-category loop, skip the "already bridged per-substance" `peptide_kw` check when `native` (it is keyed on `PUR_`/`QTY_` which do not exist natively — leave the code, just guard: `if not native and peptide_kw and ...`), and replace the two calls:

```python
        row = _pick_target(category, candidates, slot=slot, peptide_kw=peptide_kw,
                           id_kw=id_kw, pep_token=pep_token,
                           native=native, native_peptide_id=native_peptide_id)
        ...
        value = _result_for(category, analysis, peptide, native=native)
```

Also guard the catalog lookups so a native vial does not do three pointless `_peptide_service_keyword` queries: wrap the `pur_kw/qty_kw/id_kw` block in `if native: pur_kw = qty_kw = id_kw = None else: <existing three lines>`.

The re-run guard for native: the candidate query already filters `review_state.in_(RESULT_PENDING_STATES)`, so already-bridged native rows (now `to_be_verified`) are not candidates → the second call finds 0 matches per category and returns `[]` (test 8). No extra code.

Single-peptide `PEPT-Total` tail (lines 507-539): unchanged — a native vial has no `PEPT-TOTAL` row so `total_row is None`. Add one comment line above `is_blend = ...`: `# Native-born vials carry no PEPT-Total (quantity is per-slot HPLC-QUANTITY); total_row is None there by construction.`

- [ ] **Step 4: Run to verify they pass, and that the legacy suite is untouched**

Run: `<PY> -m pytest -q -p no:cacheprovider tests/test_prep_bridge_native.py tests/test_prep_bridge.py tests/test_prep_assignment_stamp.py tests/test_result_pending_states.py tests/test_worksheet_assign_transition.py tests/test_methods_stamping.py`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/prep_bridge.py backend/tests/test_prep_bridge_native.py
git commit -- backend/lims_analyses/prep_bridge.py backend/tests/test_prep_bridge_native.py -m "feat(hplc-native): prep bridge routes native trio rows by peptide_id, identity writes Conforms token

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `bridge_blend_aggregates` pairs native components by `slot`

**Files:**
- Modify: `backend/lims_analyses/prep_bridge.py:225-299`
- Test: `backend/tests/test_prep_bridge_native.py`

**Interfaces:**
- Consumes: `KW_PURITY`, `KW_QUANTITY`, `KW_BLEND_PURITY`, `KW_BLEND_TOTAL` from hplc_native; `RESULT_PENDING_STATES`.
- Produces: same signature `bridge_blend_aggregates(db, *, lims_sub_sample_pk, user_id=None) -> list[int]`; on a native blend writes `HPLC-BLEND-TOTAL` (Σ qty) and `HPLC-BLEND-PURITY` (Σ(qty·pur)/Σqty).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_prep_bridge_native.py`:

```python
def _fill(db, row, value):
    row.result_value = value
    row.review_state = "to_be_verified"
    db.flush()


def test_native_blend_aggregates_wait_for_every_slot(db_session):
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    tb = _peptide(db, "TB-500", "TB500")
    _, vial = _native_vial(db, sample_id="PB-1002", sample_type="Peptide Blend")
    _, pur1, qty1 = _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    _, pur2, qty2 = _trio(db, vial, services, slot=2, peptide=tb, name="TB-500")
    bp, bt = _aggregates(db, vial, services)
    _fill(db, pur1, "98"); _fill(db, qty1, "4")
    assert bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1) == []   # slot 2 pending
    _fill(db, pur2, "96"); _fill(db, qty2, "1")
    written = bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1)
    assert set(written) == {bp.id, bt.id}
    db.refresh(bp); db.refresh(bt)
    assert bt.result_value == "5"                       # 4 + 1
    assert bp.result_value == "97.6"                    # (4*98 + 1*96) / 5
    assert bp.review_state == "to_be_verified"


def test_native_blend_aggregates_idempotent(db_session):
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    tb = _peptide(db, "TB-500", "TB500")
    _, vial = _native_vial(db, sample_id="PB-1003", sample_type="Peptide Blend")
    _, pur1, qty1 = _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    _, pur2, qty2 = _trio(db, vial, services, slot=2, peptide=tb, name="TB-500")
    _aggregates(db, vial, services)
    for r, v in ((pur1, "98"), (qty1, "4"), (pur2, "96"), (qty2, "1")):
        _fill(db, r, v)
    assert len(bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1)) == 2
    assert bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1) == []


def test_native_single_vial_has_no_aggregates(db_session):
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    _, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    _fill(db, pur, "98"); _fill(db, qty, "4")
    assert bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1) == []


def test_native_blend_end_to_end_via_process_hplc_order(db_session):
    """Two Process-HPLC runs (one per slot) then aggregates — the main.py
    /hplc/analyze call order: bridge_prep_result_to_vial, then bridge_blend_aggregates."""
    db = db_session
    services = _catalog(db)
    bpc = _peptide(db, "BPC-157", "BPC157")
    tb = _peptide(db, "TB-500", "TB500")
    _, vial = _native_vial(db, sample_id="PB-1004", sample_type="Peptide Blend")
    _trio(db, vial, services, slot=1, peptide=bpc, name="BPC-157")
    _trio(db, vial, services, slot=2, peptide=tb, name="TB-500")
    bp, bt = _aggregates(db, vial, services)
    a1 = _hplc(db, bpc, purity=98.0, conforms=True, qty=4.0)
    bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a1, peptide=bpc, user_id=1)
    assert bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1) == []
    a2 = _hplc(db, tb, purity=96.0, conforms=True, qty=1.0)
    bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a2, peptide=tb, user_id=1)
    assert set(bridge_blend_aggregates(db, lims_sub_sample_pk=vial.id, user_id=1)) == {bp.id, bt.id}
```

- [ ] **Step 2: Run to verify they fail**

Run: `<PY> -m pytest -q -p no:cacheprovider tests/test_prep_bridge_native.py -k aggregates`
Expected: FAIL — `bridge_blend_aggregates` returns `[]` on native blends (gated on `BLEND-PUR`).

- [ ] **Step 3: Implement**

In `bridge_blend_aggregates`, after `rows = ...` and before the `blend_pur = ...` line, insert the native branch (early return so the legacy body below is byte-identical):

```python
    # ---- Native-born blend (spec 2026-09-10 M5): aggregates keyed on the
    # HPLC-BLEND-PURITY row; components are the per-slot HPLC-PURITY /
    # HPLC-QUANTITY rows paired by `slot`. Same completeness + formulas as
    # the legacy branch below; only the pairing key differs.
    by_kw: dict[str, list[LimsAnalysis]] = {}
    for r in rows:
        by_kw.setdefault((r.keyword or "").upper(), []).append(r)
    native_bp = by_kw.get(KW_BLEND_PURITY, [])
    if native_bp:
        if len(native_bp) != 1:
            logger.warning("prep_bridge: %d %s rows on vial=%s — skipping aggregates",
                           len(native_bp), KW_BLEND_PURITY, lims_sub_sample_pk)
            return []
        blend_pur = native_bp[0]
        blend_total = next(iter(by_kw.get(KW_BLEND_TOTAL, [])), None)
        comps: dict[int, dict[str, Optional[float]]] = {}
        comp_rows: list[LimsAnalysis] = []
        for r in by_kw.get(KW_PURITY, []) + by_kw.get(KW_QUANTITY, []):
            if r.slot is None:
                continue
            comp_rows.append(r)
            key = "pur" if (r.keyword or "").upper() == KW_PURITY else "qty"
            comps.setdefault(r.slot, {})[key] = _parse_float(r.result_value)
        if not comp_rows or any(r.review_state in RESULT_PENDING_STATES for r in comp_rows):
            return []
        total_qty = sum(c["qty"] for c in comps.values() if c.get("qty") is not None)
        weighted = sum(
            c["qty"] * c["pur"]
            for c in comps.values()
            if c.get("qty") is not None and c.get("pur") is not None
        )
        written: list[int] = []
        if blend_total is not None and blend_total.review_state in RESULT_PENDING_STATES:
            val = _fmt_num(total_qty)
            if val is not None:
                apply_transition(db, analysis_id=blend_total.id, kind="submit", result_value=val,
                                 reason="auto: blend total quantity (Σ component quantity)",
                                 user_id=user_id, processed_by_user_id=user_id)
                written.append(blend_total.id)
        if blend_pur.review_state in RESULT_PENDING_STATES and total_qty > 0:
            val = _fmt_num(weighted / total_qty)
            if val is not None:
                apply_transition(db, analysis_id=blend_pur.id, kind="submit", result_value=val,
                                 reason="auto: blend purity (mass-weighted component mean)",
                                 user_id=user_id, processed_by_user_id=user_id)
                written.append(blend_pur.id)
        return written
    # ---- Legacy (SENAITE-born) blend below: unchanged.
```

Note `comp_rows` includes retested/superseded rows if any exist on the vial (the legacy branch has the same property); acceptable in this slice — a native retest is M6/M8 scope.

- [ ] **Step 4: Run to verify they pass + legacy blend tests untouched**

Run: `<PY> -m pytest -q -p no:cacheprovider tests/test_prep_bridge_native.py tests/test_prep_bridge.py`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/prep_bridge.py backend/tests/test_prep_bridge_native.py
git commit -- backend/lims_analyses/prep_bridge.py backend/tests/test_prep_bridge_native.py -m "feat(hplc-native): blend aggregates pair native components by slot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Peptide attribution reads `COALESCE(LimsAnalysis.peptide_id, AnalysisService.peptide_id)`

**Files:**
- Modify: `backend/coa/variance_series.py:182`, `:241` (two `outerjoin(Peptide, ...)`)
- Modify: `backend/coa/spec_rules.py:106-120` (`sample_peptide_id`)
- Modify: `backend/sub_samples/service.py:2507-2510` (`_fetch_mk1_results_for_host` base query)
- Test: `backend/tests/test_variance_series.py`, `backend/tests/test_spec_rules.py`, new `backend/tests/test_variance_results_native.py`

**Interfaces:**
- Consumes: nothing new. Produces: no signature change; native rows now attribute to their own peptide everywhere legacy rows attribute via the service.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_variance_series.py` (reuse its `db`, `_row` helpers; `_svc` there takes `peptide_id` — native services have none):

```python
def _native_row(db, sub, svc, value, *, peptide_id, slot, title, state="variance_verified"):
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=title, result_value=value,
        result_unit="mg" if svc.keyword == "HPLC-QUANTITY" else None,
        review_state=state, reportable=True, peptide_id=peptide_id, slot=slot,
    ))
    db.flush()


@pytest.fixture
def native_world(db):
    """Native-born single-peptide parent with core + 2 variance vials on the generic trio."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep); db.flush()
    pur = _svc(db, "HPLC-PURITY"); qty = _svc(db, "HPLC-QUANTITY"); idn = _svc(db, "HPLC-IDENTITY")
    pur.variance_capable = True; qty.variance_capable = True; db.flush()
    parent = LimsSample(sample_id="P-5100", external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide", container_mode=True)
    db.add(parent); db.flush()
    for seq, kind in ((1, "core"), (2, "variance"), (3, "variance")):
        sub = LimsSubSample(parent_sample_pk=parent.id, sample_id=f"P-5100-S0{seq}",
                            external_lims_uid=None, vial_sequence=seq,
                            assignment_kind=kind, in_variance_set=True)
        db.add(sub); db.flush()
        _native_row(db, sub, pur, f"9{seq}", peptide_id=pep.id, slot=1, title="BPC-157 - Purity (HPLC)")
        _native_row(db, sub, qty, f"{seq}.5", peptide_id=pep.id, slot=1, title="BPC-157 - Quantity (HPLC)")
        _native_row(db, sub, idn, "Conforms", peptide_id=pep.id, slot=1, title="BPC-157 - Identity (HPLC)")
    return parent


def test_native_rows_attribute_to_their_own_peptide(native_world, db):
    out = build_variance_replicates(db, native_world)
    assert list(out) == ["BPC-157"]                       # keyed by the stamped identity title
    recs = out["BPC-157"]
    assert [r["vial_sequence"] for r in recs] == [1, 2, 3]
    assert recs[1]["PURITY"].startswith("92") and "QUANTITY" in recs[1] and recs[1]["IDENTITY"]


def test_native_vial_figures_carry_peptide(native_world, db):
    sub = db.execute(select(LimsSubSample).where(LimsSubSample.vial_sequence == 2)).scalar_one()
    fig = build_vial_figures(db, sub)
    assert fig and "BPC-157" in fig
```

(Check `build_vial_figures`' return shape at `coa/variance_series.py:229-266` and adjust the last assertion to its real keys — the point is that a native vial yields a non-empty figure attributed to BPC-157. Copy the exact `LimsSample` / `LimsSubSample` constructor kwargs from the existing `world` fixture in that file; `container_mode`/`in_variance_set` names are taken from it.)

Append to `backend/tests/test_spec_rules.py`:

```python
def test_sample_peptide_id_anchors_on_native_row_peptide(db_session):
    """Native trio rows carry peptide_id on the ROW; the generic service has none."""
    peptide = _mk_peptide(db_session, "BPC157")
    generic = _mk_service(db_session, keyword="HPLC-IDENTITY")        # peptide_id=None
    parent = _mk_family(db_session, "P-ANCHOR-NATIVE", parent_analyses=[generic])
    row = db_session.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id)
    ).scalar_one()
    row.peptide_id = peptide.id
    row.slot = 1
    db_session.flush()
    assert sample_peptide_id(db_session, parent.id) == peptide.id


def test_sample_peptide_id_native_blend_returns_none(db_session):
    p1 = _mk_peptide(db_session, "BPC157")
    p2 = _mk_peptide(db_session, "TB500")
    generic = _mk_service(db_session, keyword="HPLC-IDENTITY")
    parent = _mk_family(db_session, "PB-ANCHOR-NATIVE", parent_analyses=[generic, generic])
    rows = db_session.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id)
    ).scalars().all()
    rows[0].peptide_id, rows[0].slot = p1.id, 1
    rows[1].peptide_id, rows[1].slot = p2.id, 2
    db_session.flush()
    assert sample_peptide_id(db_session, parent.id) is None
```

(`_mk_family` may dedupe repeated services or `_mk_service` may require a unique keyword — read `test_spec_rules.py:19-88` and adapt: the second test only needs two parent rows with distinct row-level `peptide_id`; creating two generic services `HPLC-IDENTITY` and `HPLC-PURITY` is equally valid.)

Create `backend/tests/test_variance_results_native.py`:

```python
"""_fetch_mk1_results_for_host attributes native identity rows to the row's
own peptide (COALESCE) so the variance-set verdict agrees with the COA."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample, Peptide
from sub_samples.service import _fetch_mk1_results_for_host


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_native_identity_conforms_via_row_peptide(db):
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    svc = AnalysisService(title="HPLC Identity", keyword="HPLC-IDENTITY", origin="mk1")
    parent = LimsSample(sample_id="P-5200", external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide")
    db.add_all([pep, svc, parent]); db.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-5200-S01",
                        external_lims_uid=None, vial_sequence=1)
    db.add(sub); db.flush()
    db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                        keyword="HPLC-IDENTITY", title="BPC-157 - Identity (HPLC)",
                        result_value="Conforms", review_state="to_be_verified",
                        peptide_id=pep.id, slot=1))
    db.flush()
    out = _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=sub.id)
    assert out["HPLC-IDENTITY"]["conforms"] is True
    assert out["HPLC-IDENTITY"]["kind"] == "categorical"


def test_native_identity_does_not_conform(db):
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    svc = AnalysisService(title="HPLC Identity", keyword="HPLC-IDENTITY", origin="mk1")
    parent = LimsSample(sample_id="P-5201", external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide")
    db.add_all([pep, svc, parent]); db.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-5201-S01",
                        external_lims_uid=None, vial_sequence=1)
    db.add(sub); db.flush()
    db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                        keyword="HPLC-IDENTITY", title="BPC-157 - Identity (HPLC)",
                        result_value="Does Not Conform", review_state="to_be_verified",
                        peptide_id=pep.id, slot=1))
    db.flush()
    out = _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=sub.id)
    assert out["HPLC-IDENTITY"]["conforms"] is False
```

- [ ] **Step 2: Run to verify they fail**

Run: `<PY> -m pytest -q -p no:cacheprovider tests/test_variance_series.py tests/test_spec_rules.py tests/test_variance_results_native.py`
Expected: the new variance_series/spec_rules tests FAIL (native rows dropped / anchor `None`). NOTE: the two `_fetch_mk1_results_for_host` tests may already PASS because `identity_conforms("Conforms")` is a token pass regardless of peptide — that is fine; they pin the contract and the `_category` change from Task 1 (which is what makes `conforms` appear at all). Record which failed.

- [ ] **Step 3: Implement**

`backend/coa/variance_series.py` lines 182 and 241 — replace both

```python
        .outerjoin(Peptide, Peptide.id == AnalysisService.peptide_id)
```
with
```python
        # Native-born rows carry peptide_id on the ROW (generic service has
        # none); legacy rows carry it on the per-substance service.
        .outerjoin(Peptide, Peptide.id == func.coalesce(LimsAnalysis.peptide_id, AnalysisService.peptide_id))
```
(add `from sqlalchemy import func` to the imports if absent). Update the attribution comment at lines 198-201 with one sentence: "Native-born rows are peptide-specific via `LimsAnalysis.peptide_id` (COALESCEd into `pep` above)."

`backend/coa/spec_rules.py::sample_peptide_id` — replace the select:

```python
    anchor = func.coalesce(LimsAnalysis.peptide_id, AnalysisService.peptide_id)
    ids = db.execute(
        select(anchor)
        .join(LimsAnalysis, LimsAnalysis.analysis_service_id == AnalysisService.id)
        .outerjoin(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            anchor.is_not(None),
            LimsAnalysis.review_state != "retracted",
            (LimsAnalysis.lims_sample_pk == parent_pk)
            | (LimsSubSample.parent_sample_pk == parent_pk),
        )
        .distinct()
    ).scalars().all()
```
and extend the docstring's "The join is always the `AnalysisService.peptide_id` FK" sentence to "…the `AnalysisService.peptide_id` FK, COALESCEd behind the row's own `LimsAnalysis.peptide_id` for native-born rows (spec 2026-09-10) — never a name string".

`backend/sub_samples/service.py::_fetch_mk1_results_for_host` — replace the `.outerjoin(Peptide, Peptide.id == AnalysisService.peptide_id)` with the same COALESCE form (`from sqlalchemy import func` is almost certainly already imported in that module; check).

- [ ] **Step 4: Run to verify they pass**

Run: `<PY> -m pytest -q -p no:cacheprovider tests/test_variance_series.py tests/test_spec_rules.py tests/test_variance_results_native.py tests/test_native_sections*.py tests/test_coa_*.py`
Expected: all PASS (any failure in `test_coa_*` must be shown to fail identically on base before being called stale).

- [ ] **Step 5: Commit**

```bash
git add backend/coa/variance_series.py backend/coa/spec_rules.py backend/sub_samples/service.py backend/tests/test_variance_series.py backend/tests/test_spec_rules.py backend/tests/test_variance_results_native.py
git commit -- <same paths> -m "feat(hplc-native): peptide attribution COALESCEs row peptide_id over service peptide_id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Frontend classifiers learn the native keywords

**Files:**
- Modify: `src/lib/hplc-analyte-services.ts:11-13`
- Modify: `src/lib/vial-assignment.ts:89-93`
- Test: `src/test/hplc-analyte-services.test.ts`, `src/lib/__tests__/vial-assignment.test.ts`

**Interfaces:** no signature change; `isHplcAnalyteService` true for the five native keywords; `isIdentityAnalysis` true for keyword `HPLC-IDENTITY`.

- [ ] **Step 1: Write the failing tests**

In `src/test/hplc-analyte-services.test.ts`, add to the first `it.each` list:

```ts
    'HPLC-IDENTITY', 'HPLC-PURITY', 'HPLC-QUANTITY', 'HPLC-BLEND-PURITY', 'HPLC-BLEND-TOTAL', // native trio + aggregates
```

In `src/lib/__tests__/vial-assignment.test.ts` inside `describe('isIdentityAnalysis')` add:

```ts
  it('recognises the native HPLC-IDENTITY keyword even with a bare (unresolved) title', () => {
    expect(isIdentityAnalysis(an({ keyword: 'HPLC-IDENTITY', title: 'Mystery Peptide' }))).toBe(true)
  })
  it('does not treat native purity as identity', () => {
    expect(isIdentityAnalysis(an({ keyword: 'HPLC-PURITY', title: 'BPC-157 - Purity (HPLC)' }))).toBe(false)
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -- src/test/hplc-analyte-services.test.ts src/lib/__tests__/vial-assignment.test.ts` (from the worktree root; use `npx vitest run <files>` if the script signature differs)
Expected: FAIL on the native keywords.

- [ ] **Step 3: Implement**

`src/lib/hplc-analyte-services.ts`:

```ts
const IDENTITY_EXACT = new Set(['HPLC-ID', 'BLEND-IDENT', 'HPLC-IDENTITY'])
const PURITY_EXACT = new Set(['HPLC-PUR', 'BLEND-PUR', 'HPLC-PURITY', 'HPLC-BLEND-PURITY'])
const QUANTITY_EXACT = new Set(['PEPT-TOTAL', 'HPLC-QUANTITY', 'HPLC-BLEND-TOTAL'])
```
and extend the doc comment with "native-born trio HPLC-IDENTITY/PURITY/QUANTITY + HPLC-BLEND-PURITY/TOTAL (spec 2026-09-10)".

`src/lib/vial-assignment.ts::isIdentityAnalysis`:

```ts
  if (kw === 'HPLC-ID' || kw === 'HPLC-IDENTITY' || kw.startsWith('ID_')) return true
```

- [ ] **Step 4: Run to verify they pass + typecheck**

Run: `npx vitest run src/test/hplc-analyte-services.test.ts src/lib/__tests__/vial-assignment.test.ts src/test/vial-assignment-bridge.test.ts src/test/vial-assignment-service-id.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, tsc clean. Do NOT run repo-wide prettier `--check` (CRLF checkout, unreliable); if you want a format check, pipe the two changed files through `npx prettier --check` individually.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hplc-analyte-services.ts src/lib/vial-assignment.ts src/test/hplc-analyte-services.test.ts src/lib/__tests__/vial-assignment.test.ts
git commit -- <same paths> -m "feat(hplc-native): FE HPLC analyte/identity classifiers learn the native keywords

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `rebridge_prep` + `/hplc/analyze` path on a native vial (integration pin)

**Files:**
- Test only: `backend/tests/test_prep_bridge_native.py`
- (Read: `backend/lims_analyses/prep_bridge.py:352-391` `rebridge_prep`, `backend/main.py:6232-6252`)

**Interfaces:** none new. Purpose: prove the flyout "Auto-fill" (`rebridge_prep`) works for native vials without code change, since it derives `peptide` from `HPLCAnalysis.peptide_id` and calls `bridge_prep_result_to_vial`.

- [ ] **Step 1: Write the test**

Read `rebridge_prep` first (it loads the prep via `mk1_db.get_sample_prep` and the latest `HPLCAnalysis` for the prep — copy the exact `unittest.mock.patch` target from `tests/test_prep_bridge.py` lines ~443-505 `_hplc_for_prep` / rebridge tests). Then append:

```python
def test_rebridge_prep_on_native_vial(db_session, monkeypatch):
    from unittest.mock import patch
    db = db_session
    services = _catalog(db)
    pep = _peptide(db, "BPC-157", "BPC157")
    _, vial = _native_vial(db)
    idr, pur, qty = _trio(db, vial, services, slot=1, peptide=pep, name="BPC-157")
    a = _hplc(db, pep, purity=98.5, conforms=True, qty=4.2)
    a.sample_prep_id = 77          # or however tests/test_prep_bridge.py links analysis→prep
    db.flush()
    from lims_analyses.prep_bridge import rebridge_prep
    with patch("mk1_db.get_sample_prep", return_value={"id": 77, "lims_sub_sample_pk": vial.id, "peptide_id": pep.id}):
        ids = rebridge_prep(db, prep_id=77, user_id=1)
    assert set(ids) == {idr.id, pur.id, qty.id}
```

Adapt the patch target and the prep→analysis link to what `rebridge_prep` really reads (do not guess; quote the lines in your report).

- [ ] **Step 2: Run** — Expected: PASS without production changes. If it FAILS, the failure is a real gap in `rebridge_prep` for native vials: fix minimally inside `rebridge_prep` (never in the legacy tiers) and report.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_prep_bridge_native.py
git commit -- backend/tests/test_prep_bridge_native.py -m "test(hplc-native): rebridge_prep on a native vial

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Gate, CHANGELOG, spec addenda (M7 requirements), ledger

**Files:**
- Modify: `CHANGELOG.md` (Unreleased section, follow the file's existing entry style)
- Modify (main checkout docs branch, NOT this worktree): `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md` — append two bullets under "Addenda from slice-2 final review" (rename that heading to "Addenda from slice reviews")
- No production code.

- [ ] **Step 1: Backend gate (failure-set diff, same window)**

From `C:\tmp\Accu-Mk1-hplc-slice2/backend` (base) and `C:\tmp\Accu-Mk1-hplc-slice3/backend` (branch), back-to-back:

```bash
<PY> -m pytest -q -p no:cacheprovider tests 2>&1 | grep -E "^(FAILED|ERROR)" | sort > C:/tmp/s3-base-failures.txt
<PY> -m pytest -q -p no:cacheprovider tests 2>&1 | grep -E "^(FAILED|ERROR)" | sort > C:/tmp/s3-branch-failures.txt
diff C:/tmp/s3-base-failures.txt C:/tmp/s3-branch-failures.txt
```
Expected: empty diff, or only lines you can reproduce as order-dependent flakes on BASE in isolation (`test_vial_retest`, `test_clickup_task_retry`, promote family are the known ones). Any branch-only failure that does not reproduce on base = a regression: fix it in a scoped fix commit, never by editing the failing legacy test.

- [ ] **Step 2: Frontend gate**

`npx vitest run` (whole suite) + `npx tsc --noEmit`. Expected: same pass count as base ± the new tests.

- [ ] **Step 3: Bindparam guard + migrations no-op check**

`<PY> -m pytest -q -p no:cacheprovider tests/test_workflow_engine.py::test_boot_migration_statements_have_no_bindparams` — PASS (no migrations in this slice, sanity only).

- [ ] **Step 4: CHANGELOG entry**

Under Unreleased, one block:

```
### HPLC native-born — slice 3 (M5)
- Prep bridge routes HPLC results onto native-born vials' generic trio rows by `LimsAnalysis.peptide_id` (never by keyword prefix); native identity rows receive the literal `Conforms` / `Does Not Conform`; unresolved (`peptide_id NULL`) rows are never written.
- Blend aggregates (`HPLC-BLEND-TOTAL`, `HPLC-BLEND-PURITY`) computed from per-slot native components.
- Variance replicate series, variance-set identity verdict, and spec peptide-tier anchor attribute native rows via `COALESCE(lims_analyses.peptide_id, analysis_services.peptide_id)`.
- Throughput report and FE HPLC/identity classifiers recognise the native keywords.
- Behaviour-neutral for SENAITE-born samples (all new branches keyed on native keywords / row-level peptide_id).
```

- [ ] **Step 5: Spec addenda (docs branch in the main checkout)**

In the main checkout `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` on branch `docs/analysis-catalog-specs`, append under the addenda heading:

```
- **Keyword-keyed result dicts collide on native BLENDS (M7).** `coa/variance_series.build_variance_analyte_series` (`{keyword: {values}}`) and `sub_samples/service._fetch_mk1_results_for_host` (`out[r.keyword]`) key by keyword; N native slots share `HPLC-PURITY`/`HPLC-QUANTITY`/`HPLC-IDENTITY`, so on a native blend the last slot wins. Single-peptide native samples are unaffected. M7's COA shim must emit the series under the wire keyword it assigns per slot (`ANALYTE-{slot}-PUR/QTY`), and the variance-set UI needs a `(keyword, slot)` key before native blends are benched.
- **Native aggregates are not a bridge/stamp category.** `native_category` returns None for `HPLC-BLEND-*` (like legacy BLEND-PUR/PEPT-Total); they are written only by `bridge_blend_aggregates` and get no method/instrument stamp from `stamp_prep_assignment` — same as legacy.
```
Commit there with a pathspec commit (`git commit -- docs/superpowers/specs/2026-09-10-hplc-native-born-design.md`).

- [ ] **Step 6: Commit CHANGELOG in the worktree**

```bash
git add CHANGELOG.md
git commit -- CHANGELOG.md -m "docs(changelog): HPLC native-born slice 3 (M5)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Push + PR are HELD for the finish step (controller runs them): `git push -u origin feat/hplc-native-slice3`, PR base `feat/hplc-native-slice2`.

---

## Self-review

**Spec coverage (M5 line):** `_category` learns the trio → Task 1; `_pick_target` native tier `(keyword in TRIO, peptide_id == prep.peptide_id)` exactly-one-else-None, NULL never matches → Task 2; `_result_for` Conforms/Does Not Conform → Task 2; skip single-peptide `PEPT-Total` tail on native → Task 2 (no-op by construction, commented, pinned by `test_native_single_vial_has_no_aggregates` + the single-vial bridge test asserting exactly three ids); `bridge_blend_aggregates` pairs by slot → Task 3; `variance_series._category` + COALESCE → Tasks 1 + 4; `spec_rules.sample_peptide_id` COALESCE → Task 4; FE classifiers → Task 5. Addendum "prep bridge must never match a NULL-peptide row" → Task 2 test 5. Extra sites found in research and covered: `stamp_prep_assignment` (Task 1 test), `identity_verdict.is_identity_keyword` (Task 1), `_fetch_mk1_results_for_host` (Task 4), `throughput.HPLC_KEYWORDS` (Task 1), `rebridge_prep` (Task 6). Deferred and ledgered: keyword-keyed dict collision on native blends (M7).

**Placeholder scan:** every code step has code; the two "adapt to the real fixture" notes point at exact line ranges to copy from, not "TBD".

**Type consistency:** `native_category(keyword) -> Optional[str]` used identically in Tasks 1/2; `_pick_target(..., native: bool, native_peptide_id: Optional[int])` defined and called with keyword args in Task 2 only; `_result_for(..., *, native: bool = False)` defined and called in Task 2; `_fill`, `_trio`, `_aggregates`, `_native_vial`, `_catalog`, `_peptide`, `_hplc` defined once in Task 1's test file and reused by Tasks 2/3/6.
