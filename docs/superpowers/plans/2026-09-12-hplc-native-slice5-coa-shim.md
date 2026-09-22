# HPLC Native-Born — Slice 5 (M7: COA shim — native HPLC rows ride the legacy wire in SENAITE vocabulary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native-born HPLC sample (single or blend) generates a COA whose page 1 is byte-for-byte what COABuilder renders for a SENAITE-born sample — with COABuilder untouched — and an unresolved analyte slot blocks generation loudly.

**Architecture:** COABuilder's vendored conformance ladder indexes the wire by bare `Keyword` (last writer wins), matches identity primarily by `Title == Analyte{N}Peptide`, then `ANALYTE-{n}-ID`, reads purity from `ANALYTE-{n}-PUR` (blend) / `HPLC-PUR` (single), quantity from `ANALYTE-{n}-QTY` (blend) / `PEPT-Total` (single), blend aggregates from `BLEND-PUR` / `PEPT-Total`, and accepts the literal `Conforms`. Native rows carry generic keywords (`HPLC-PURITY` shared across slots) and stamped titles, so today `build_legacy_rows` drops them (`service_origin == "senaite"` filter) and aborts with "no legacy-family analyses". This slice adds ONE helper module, `coa/hplc_shim.py`, that maps a native parent-tier row to its wire keyword + title per slot, and makes every wire producer derive from it: `legacy_rows` (admits native HPLC rows, emits shim vocabulary, blocks on unresolved slots), `sample_meta` (`Analyte{N}Peptide` = the same identity title the shim stamps, so the engine's primary identity leg matches), the COA variance analyte series and the variance-set result fetch (re-keyed per slot so N slots never collapse), and the mk1 source resolver decisions. A parity test runs the vendored engine over a synthetic native single and blend wire document. No COABuilder change; `FIELD_CONTRACT` unchanged.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2, pytest (sqlite in-memory via `tests/hplc_native_family.py`), vendored `conformance_vendored/conformance.py` (mirror-only, never edited).

**Spec:** `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md` — M7 line ("Shim vocabulary must satisfy coab's ladder exactly"), the "Unresolved rows are NOT gated yet" addendum, and the slice-3 addendum "Keyword-keyed result dicts collide on native BLENDS (M7)".

**Branch / worktree:** `feat/hplc-native-slice5` at `C:\tmp\Accu-Mk1-hplc-slice5`, base `feat/hplc-native-slice4` (after its gate commit). Python: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe` from the worktree `backend/` (bare `python` hangs). Tests: `<PY> -m pytest -q -p no:cacheprovider <paths>`.

## Global Constraints

- **COABuilder untouched; `conformance_vendored/conformance.py` untouched** (MIRROR-ONLY). `coa/legacy_rows.FIELD_CONTRACT` stays exactly `("uid","Keyword","Title","ServiceTitle","Result","Unit","review_state","ResultCaptureDate")` (twin-pinned with coabuilder).
- **Additive / behaviour-neutral for SENAITE-born:** every new branch is keyed on `service_origin == "mk1"` AND keyword ∈ `TRIO + AGGREGATES` (the `is_native_hplc_row` predicate). Other mk1-origin families (endo, PCR, USP71, HM) stay filtered OUT of the legacy block exactly as today (`test_native_family_rows_filtered_out` keeps passing).
- **Wire vocabulary (exact):** identity → `ANALYTE-{slot}-ID`; purity → `HPLC-PUR` when the sample has exactly one occupied slot, else `ANALYTE-{slot}-PUR`; quantity → `PEPT-Total` when one slot, else `ANALYTE-{slot}-QTY`; `HPLC-BLEND-PURITY` → `BLEND-PUR`; `HPLC-BLEND-TOTAL` → `PEPT-Total`. Title/ServiceTitle for identity = `identity_title(display_name)` = `"<display_name> - Identity (HPLC)"`; purity/quantity titles = `purity_title`/`quantity_title`; aggregates keep the service title.
- **One source for names:** `sample_meta.Analyte{N}Peptide` for native-born and the identity row `Title` MUST come from the same `hplc_shim.slot_wires()` call shape (they cannot drift — this is the P-1611/P-1986 class).
- **Unresolved slot gating (Ruling, Handler default):** a native parent-tier trio row with `peptide_id IS NULL` on the wire path raises `NativeSectionsError` naming the sample and slot ("relabel before COA"). Rows keep `reportable=True` (no seeding change).
- Reuse `TRIO`, `AGGREGATES`, `KW_*`, `is_native_born`, `resolve_slot_peptides`, `SlotResolution`, `identity_title/purity_title/quantity_title`, `native_category` from `lims_analyses/hplc_native.py`; no new keyword literals outside `coa/hplc_shim.py`.
- Pathspec commits only; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; never `git stash`; LF blobs (check `git diff --stat`).
- Gate = failure-set diff vs base (`feat/hplc-native-slice4`), same window. Known pre-existing: `test_identity_convergence_guard::test_no_unclassified_keyword_identity_site`, pytest-asyncio marks in `test_coa_deferred_sections_warning.py`, live-DB order flakes.

---

## File structure

| File | Responsibility |
|---|---|
| `backend/coa/hplc_shim.py` (new) | `SlotWire`, `slot_wires(db, parent)`, `is_native_hplc_row(row)`, `wire_keyword(keyword, slot, n_slots)`, `wire_title(keyword, row_title, wire)`, `UnresolvedNativeSlotError(NativeSectionsError)` |
| `backend/coa/legacy_rows.py` | admits native HPLC rows; emits shim Keyword/Title; unresolved → abort |
| `backend/coa/sample_meta.py` | `_analyte_slots` for native-born parents uses `slot_wires` identity titles |
| `backend/coa/variance_series.py` | `build_variance_analyte_series` keys native rows by wire keyword |
| `backend/sub_samples/service.py` | `_fetch_mk1_results_for_host` keys native rows by wire keyword |
| `backend/coa/source_resolver.py` | `_resolve_mk1_parent_tier` keys native rows by wire keyword; `_pin_row_identity_matches` accepts the shim keyword (only if the resolver is on the mk1 path — Task 5 verifies) |
| Tests | new `backend/tests/test_hplc_shim.py`, `test_hplc_native_coa_parity.py`; extend `test_legacy_rows_contract.py`, `test_sample_meta_producer.py` (or new `test_sample_meta_native.py`), `test_variance_series.py`, `test_variance_results_native.py`, `test_coa_source_resolver.py` |

Ledger-only (not built here): `Analyte{N}DeclaredQuantity` is read by the engine but never emitted by `build_sample_meta` in mk1 mode for ANY sample (pre-existing gap since the seam-4 flip; declared quantity is informational on page 1) — spec addendum, separate ticket.

---

### Task 1: `coa/hplc_shim.py`

**Files:** Create `backend/coa/hplc_shim.py`, `backend/tests/test_hplc_shim.py`.

**Interfaces (Produces):**
```python
@dataclass(frozen=True)
class SlotWire:
    slot: int
    display_name: str          # peptide.name when resolved, else suffix-stripped raw label
    peptide_id: Optional[int]
    reason: Optional[str]      # None | "unresolved" | "ambiguous"
    @property
    def identity_title(self) -> str: ...   # identity_title(display_name)

class UnresolvedNativeSlotError(NativeSectionsError): ...   # detail names sample_id + slot + raw label

def slot_wires(db, parent) -> list[SlotWire]                 # from resolve_slot_peptides; [] for SENAITE-born
def is_native_hplc_row(row) -> bool                          # service_origin == "mk1" and keyword.upper() in TRIO+AGGREGATES
def wire_keyword(keyword: str, slot: Optional[int], n_slots: int) -> str
def wire_title(keyword: str, row_title: str, wire: Optional[SlotWire]) -> str
```

- [ ] **Step 1: Failing tests** — `backend/tests/test_hplc_shim.py`:

```python
import json, pytest
from types import SimpleNamespace
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from coa.hplc_shim import (SlotWire, UnresolvedNativeSlotError, slot_wires, is_native_hplc_row,
                           wire_keyword, wire_title)
from coa.native_sections import NativeSectionsError
from lims_analyses.hplc_native import (KW_IDENTITY, KW_PURITY, KW_QUANTITY, KW_BLEND_PURITY, KW_BLEND_TOTAL,
                                       identity_title, purity_title, quantity_title)
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:"); Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try: yield s
    finally: s.close()


@pytest.mark.parametrize("kw,slot,n,expected", [
    (KW_IDENTITY, 1, 1, "ANALYTE-1-ID"),
    (KW_IDENTITY, 2, 3, "ANALYTE-2-ID"),
    (KW_PURITY, 1, 1, "HPLC-PUR"),
    (KW_PURITY, 1, 2, "ANALYTE-1-PUR"),
    (KW_QUANTITY, 1, 1, "PEPT-Total"),
    (KW_QUANTITY, 3, 3, "ANALYTE-3-QTY"),
    (KW_BLEND_PURITY, None, 2, "BLEND-PUR"),
    (KW_BLEND_TOTAL, None, 2, "PEPT-Total"),
])
def test_wire_keyword_table(kw, slot, n, expected):
    assert wire_keyword(kw, slot, n) == expected


def test_wire_keyword_rejects_non_native():
    with pytest.raises(ValueError):
        wire_keyword("HPLC-PUR", 1, 1)


def test_is_native_hplc_row_predicate():
    assert is_native_hplc_row(SimpleNamespace(keyword=KW_PURITY, service_origin="mk1"))
    assert is_native_hplc_row(SimpleNamespace(keyword="hplc-identity", service_origin="mk1"))
    assert not is_native_hplc_row(SimpleNamespace(keyword="STERILITY-USP71", service_origin="mk1"))
    assert not is_native_hplc_row(SimpleNamespace(keyword="HPLC-PUR", service_origin="senaite"))
    assert not is_native_hplc_row(SimpleNamespace(keyword=KW_PURITY, service_origin="senaite"))


def test_slot_wires_from_native_family(db):
    parent, services, peps, _ = native_family(db, sample_id="PB-1501",
                                              slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    wires = slot_wires(db, parent)
    assert [(w.slot, w.display_name, w.peptide_id, w.reason) for w in wires] == [
        (1, "BPC-157", peps[1].id, None), (2, "TB-500", peps[2].id, None)]
    assert wires[0].identity_title == identity_title("BPC-157")


def test_slot_wires_empty_for_senaite_born(db):
    from models import LimsSample
    p = LimsSample(sample_id="P-0001", external_lims_uid="uid-1", external_lims_system="senaite",
                   sample_type_title="Peptide", analytes=json.dumps([{"name": "BPC-157 - Identity (HPLC)"}]))
    db.add(p); db.flush()
    assert slot_wires(db, p) == []


def test_wire_title_per_category():
    w = SlotWire(slot=1, display_name="BPC-157", peptide_id=5, reason=None)
    assert wire_title(KW_IDENTITY, "ignored", w) == identity_title("BPC-157")
    assert wire_title(KW_PURITY, "ignored", w) == purity_title("BPC-157")
    assert wire_title(KW_QUANTITY, "ignored", w) == quantity_title("BPC-157")
    assert wire_title(KW_BLEND_PURITY, "HPLC Blend Purity (mass-weighted)", None) == "HPLC Blend Purity (mass-weighted)"


def test_unresolved_error_is_a_native_sections_error():
    e = UnresolvedNativeSlotError(sample_id="P-5001", slot=2, raw_name="Mystery")
    assert isinstance(e, NativeSectionsError)
    assert "P-5001" in e.detail and "slot 2" in e.detail and "Mystery" in e.detail
```

(Read `coa/native_sections.py::NativeSectionsError` for its constructor — it carries `.detail`; subclass accordingly.)

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** `backend/coa/hplc_shim.py`:

```python
"""COA wire vocabulary for NATIVE-BORN HPLC rows (spec 2026-09-10 M7).

COABuilder page 1 is untouched: its vendored ladder indexes by bare Keyword
(last writer wins), matches identity by Title == Analyte{N}Peptide, then
ANALYTE-{n}-ID, and reads ANALYTE-{n}-PUR/QTY (blend) or HPLC-PUR/PEPT-Total
(single), BLEND-PUR/PEPT-Total (aggregates). Native rows carry generic
keywords shared across slots, so this module is the ONE place that maps a
native parent-tier row to the legacy keyword + title the engine expects.
Both legacy_rows (row Title) and sample_meta (Analyte{N}Peptide) derive from
slot_wires() so the two strings the engine compares cannot drift.
"""
from dataclasses import dataclass
from typing import Optional

from coa.native_sections import NativeSectionsError
from lims_analyses.hplc_native import (
    AGGREGATES, KW_BLEND_PURITY, KW_BLEND_TOTAL, KW_IDENTITY, KW_PURITY, KW_QUANTITY, TRIO,
    identity_title, is_native_born, purity_title, quantity_title, resolve_slot_peptides,
)

_NATIVE_KWS = frozenset(TRIO + AGGREGATES)


@dataclass(frozen=True)
class SlotWire:
    slot: int
    display_name: str
    peptide_id: Optional[int]
    reason: Optional[str]

    @property
    def identity_title(self) -> str:
        return identity_title(self.display_name)


class UnresolvedNativeSlotError(NativeSectionsError):
    def __init__(self, *, sample_id: str, slot: int, raw_name: str):
        super().__init__(
            f"{sample_id}: analyte slot {slot} ({raw_name!r}) is unresolved — "
            f"relabel it to a catalog peptide before generating the COA")


def slot_wires(db, parent) -> list[SlotWire]:
    if not is_native_born(parent):
        return []
    return [SlotWire(r.slot, r.display_name, r.peptide_id, r.reason) for r in resolve_slot_peptides(db, parent)]


def is_native_hplc_row(row) -> bool:
    return (getattr(row, "service_origin", None) == "mk1"
            and (getattr(row, "keyword", "") or "").upper() in _NATIVE_KWS)


def wire_keyword(keyword: str, slot: Optional[int], n_slots: int) -> str:
    kw = (keyword or "").upper()
    if kw == KW_IDENTITY:
        return f"ANALYTE-{slot}-ID"
    if kw == KW_PURITY:
        return "HPLC-PUR" if n_slots == 1 else f"ANALYTE-{slot}-PUR"
    if kw == KW_QUANTITY:
        return "PEPT-Total" if n_slots == 1 else f"ANALYTE-{slot}-QTY"
    if kw == KW_BLEND_PURITY:
        return "BLEND-PUR"
    if kw == KW_BLEND_TOTAL:
        return "PEPT-Total"
    raise ValueError(f"not a native HPLC keyword: {keyword!r}")


def wire_title(keyword: str, row_title: str, wire: Optional[SlotWire]) -> str:
    kw = (keyword or "").upper()
    if kw in AGGREGATES or wire is None:
        return row_title
    if kw == KW_IDENTITY:
        return wire.identity_title
    if kw == KW_PURITY:
        return purity_title(wire.display_name)
    if kw == KW_QUANTITY:
        return quantity_title(wire.display_name)
    return row_title
```
(If `NativeSectionsError.__init__` takes `detail` differently, adapt the subclass; the test pins `.detail` content.)

- [ ] **Step 4: Run** → PASS. Also run `tests/test_identity_convergence_guard.py` — the module's comparisons are on `kw` locals not `.keyword` attributes except `is_native_hplc_row`; if the guard flags a new site, register it PERMANENT like `native_hplc_services` (never loosen).
- [ ] **Step 5: Commit** — `feat(coa): hplc_shim — native HPLC wire vocabulary`.

---

### Task 2: `legacy_rows` admits native HPLC rows in shim vocabulary; unresolved slot aborts

**Files:** Modify `backend/coa/legacy_rows.py:49-100`; extend `backend/tests/test_legacy_rows_contract.py`.

- [ ] **Step 1: Failing tests** (append; keep the `_shaped`/`_PARENT` helpers):

```python
def _native_parent(**over):
    base = dict(sample_id="P-5001", external_lims_system="mk1")
    base.update(over)
    return SimpleNamespace(**base)


def _wires(*names):
    from coa.hplc_shim import SlotWire
    return [SlotWire(i, n, 100 + i, None) for i, n in enumerate(names, start=1)]


def test_native_single_rows_ride_in_legacy_vocabulary(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-IDENTITY", title="BPC-157 - Identity (HPLC)", result="Conforms",
                unit=None, service_origin="mk1", peptide_id=101, slot=1, analysis_service_id=901),
        _shaped(uid="mk1:2", keyword="HPLC-PURITY", title="BPC-157 - Purity (HPLC)", result="98.5",
                unit="%", service_origin="mk1", peptide_id=101, slot=1, analysis_service_id=902),
        _shaped(uid="mk1:3", keyword="HPLC-QUANTITY", title="BPC-157 - Quantity (HPLC)", result="4.9",
                unit="mg", service_origin="mk1", peptide_id=101, slot=1, analysis_service_id=903),
    ])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    rows = build_legacy_rows(None, _native_parent())
    assert [(r["Keyword"], r["Title"], r["Result"], r["Unit"]) for r in rows] == [
        ("ANALYTE-1-ID", "BPC-157 - Identity (HPLC)", "Conforms", None),
        ("HPLC-PUR", "BPC-157 - Purity (HPLC)", "98.5", "%"),
        ("PEPT-Total", "BPC-157 - Quantity (HPLC)", "4.9", "mg"),
    ]
    assert all(set(r.keys()) == set(FIELD_CONTRACT) for r in rows)
    assert all(r["Title"] == r["ServiceTitle"] for r in rows)


def test_native_blend_rows_are_per_slot_and_aggregates_map(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-PURITY", title="x", result="98", unit="%", service_origin="mk1",
                peptide_id=101, slot=1, analysis_service_id=902),
        _shaped(uid="mk1:2", keyword="HPLC-PURITY", title="x", result="96", unit="%", service_origin="mk1",
                peptide_id=102, slot=2, analysis_service_id=902),
        _shaped(uid="mk1:3", keyword="HPLC-BLEND-PURITY", title="HPLC Blend Purity (mass-weighted)", result="97.6",
                unit="%", service_origin="mk1", peptide_id=None, slot=None, analysis_service_id=904),
        _shaped(uid="mk1:4", keyword="HPLC-BLEND-TOTAL", title="HPLC Blend Total Quantity", result="5",
                unit="mg", service_origin="mk1", peptide_id=None, slot=None, analysis_service_id=905),
    ])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157", "TB-500"))
    rows = build_legacy_rows(None, _native_parent(sample_id="PB-1001"))
    assert [(r["Keyword"], r["Title"]) for r in rows] == [
        ("ANALYTE-1-PUR", "BPC-157 - Purity (HPLC)"),
        ("ANALYTE-2-PUR", "TB-500 - Purity (HPLC)"),
        ("BLEND-PUR", "HPLC Blend Purity (mass-weighted)"),
        ("PEPT-Total", "HPLC Blend Total Quantity"),
    ]
    assert len({r["Keyword"] for r in rows}) == 4     # no keyword collision on the wire


def test_native_title_comes_from_slot_wires_not_row_title(monkeypatch):
    """The engine compares Title to Analyte{N}Peptide; both must come from slot_wires."""
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-IDENTITY", title="bpc157 - Identity (HPLC)", result="Conforms",
                unit=None, service_origin="mk1", peptide_id=101, slot=1, analysis_service_id=901)])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    assert build_legacy_rows(None, _native_parent())[0]["Title"] == "BPC-157 - Identity (HPLC)"


def test_native_unresolved_slot_aborts(monkeypatch):
    from coa.hplc_shim import SlotWire, UnresolvedNativeSlotError
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-PURITY", title="Mystery - Purity (HPLC)", result="98", unit="%",
                service_origin="mk1", peptide_id=None, slot=1, analysis_service_id=902)])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: [SlotWire(1, "Mystery", None, "unresolved")])
    with pytest.raises(UnresolvedNativeSlotError) as ei:
        build_legacy_rows(None, _native_parent())
    assert "slot 1" in ei.value.detail


def test_native_row_without_wire_slot_aborts(monkeypatch):
    """A trio row whose slot has no entry in slot_wires (registry/rows drift) aborts loudly."""
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-PURITY", title="x", result="98", unit="%", service_origin="mk1",
                peptide_id=101, slot=3, analysis_service_id=902)])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _native_parent())


def test_other_mk1_families_still_filtered_on_native_parent(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-PURITY", title="x", result="98", unit="%", service_origin="mk1",
                peptide_id=101, slot=1, analysis_service_id=902),
        _shaped(uid="mk1:200", keyword="STERILITY-USP71", service_origin="mk1"),
    ])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    assert [r["Keyword"] for r in build_legacy_rows(None, _native_parent())] == ["HPLC-PUR"]
```
(`_shaped` must accept the new keys `peptide_id`, `slot`, `analysis_service_id` — extend its `base` with `peptide_id=None, slot=None, analysis_service_id=None`. `NativeSectionsError` import as the file already does. The existing `test_native_family_rows_filtered_out` and `test_zero_legacy_rows_aborts` keep passing because `_PARENT` has no `external_lims_system`.)

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** in `build_legacy_rows`:

```python
    from coa.hplc_shim import (UnresolvedNativeSlotError, is_native_hplc_row, slot_wires,
                               wire_keyword, wire_title)
    shaped = _shaped_rows(db, parent.sample_id)
    ...
    wires = {w.slot: w for w in slot_wires(db, parent)}      # {} for SENAITE-born
    n_slots = len(wires)
    legacy = [r for r in shaped if r.service_origin == "senaite" or is_native_hplc_row(r)]
    ...
    for r in legacy:
        keyword, title = r.keyword, r.title
        if is_native_hplc_row(r):
            if (r.keyword or "").upper() in TRIO:
                wire = wires.get(r.slot)
                if wire is None:
                    raise NativeSectionsError(f"legacy rows: {parent.sample_id} row {r.uid} (slot {r.slot}) "
                                              f"has no registry analyte slot — registry/rows drift")
                if r.peptide_id is None or wire.peptide_id is None:
                    raise UnresolvedNativeSlotError(sample_id=parent.sample_id, slot=r.slot,
                                                    raw_name=wire.display_name)
                keyword = wire_keyword(r.keyword, r.slot, n_slots)
                title = wire_title(r.keyword, r.title, wire)
            else:
                keyword = wire_keyword(r.keyword, None, n_slots)
        wire_result = identity_wire_result(db, keyword=r.keyword, result=r.result,
                                           analysis_service_id=getattr(r, "analysis_service_id", None))
        rows.append({"uid": r.uid, "Keyword": keyword, "Title": title, "ServiceTitle": title,
                     "Result": wire_result, "Unit": r.unit, "review_state": r.review_state,
                     "ResultCaptureDate": r.captured})
```
Keep the existing fail-closed aborts in their order (service_origin None, review_state None, skip states, zero rows, blank keyword) — the blank-keyword check runs on `keyword` (the wire one). `identity_wire_result` keeps receiving the ROW keyword (`HPLC-IDENTITY`) so `is_identity_keyword` recognises it. Update the module docstring with two sentences on the shim.

- [ ] **Step 4: Run** `tests/test_legacy_rows_contract.py tests/test_coa_wire_document.py tests/test_wire_document_sample_meta.py tests/test_regular_coa_child.py tests/test_coa_sections_endpoint.py`.
- [ ] **Step 5: Commit** — `feat(coa): legacy_rows admits native HPLC rows in shim vocabulary; unresolved slot aborts`.

---

### Task 3: `sample_meta.Analyte{N}Peptide` for native-born comes from `slot_wires`

**Files:** Modify `backend/coa/sample_meta.py:41-60` (`_analyte_slots`) and its call at ~190; test in `backend/tests/test_sample_meta_native.py` (new, sqlite) — read `tests/test_sample_meta_producer.py` for the env-var patch and attachment fixture `build_sample_meta` needs, and copy them.

- [ ] **Step 1: Failing test**

```python
def test_native_born_analyte_titles_match_shim(db, monkeypatch, tmp_path):
    parent, services, peps, _ = native_family(db, sample_id="PB-1502",
                                              slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    # make the stored registry label deliberately NOT the peptide name
    slots = json.loads(parent.analytes); slots[0]["name"] = "bpc157"; parent.analytes = json.dumps(slots); db.flush()
    ...  # env + sample image fixture per test_sample_meta_producer.py
    meta = build_sample_meta(db, parent)
    assert meta["Analyte1Peptide"] == "BPC-157 - Identity (HPLC)"
    assert meta["Analyte2Peptide"] == "TB-500 - Identity (HPLC)"
    assert "Analyte3Peptide" not in meta


def test_senaite_born_analyte_titles_unchanged(...):
    # LimsSample external_lims_system absent, analytes [{"name": "BPC-157 - Identity (HPLC)"}]
    # → meta["Analyte1Peptide"] == "BPC-157 - Identity (HPLC)" verbatim (raw label passthrough as today)
```
(Because slot 1's stored `peptide_id` is set, `resolve_slot_peptides` returns display_name "BPC-157" regardless of the label — that is the point.)

- [ ] **Step 3: Implement** — `_analyte_slots(parent)` becomes `_analyte_slots(db, parent)`:

```python
    from coa.hplc_shim import slot_wires
    wires = slot_wires(db, parent)
    if wires:
        # Native-born: the SAME identity title the legacy rows carry, so the
        # engine's Title == Analyte{N}Peptide leg matches (spec M7).
        return {f"Analyte{w.slot}Peptide": w.identity_title for w in wires if w.slot <= 4}
    ...existing raw-label body unchanged...
```
Update the single call site. Note an unresolved slot still emits its (suffix-stripped) label here; the abort happens in `legacy_rows` (Task 2), which runs in the same `build_coa_wire_document` call, so the wire never leaves with an unresolved slot.

- [ ] **Step 4: Run** `tests/test_sample_meta_native.py tests/test_sample_meta_producer.py tests/test_sample_meta_contract.py tests/test_wire_document_sample_meta.py`.
- [ ] **Step 5: Commit** — `feat(coa): sample_meta analyte titles for native-born derive from hplc_shim`.

---

### Task 4: Per-slot keys for the COA variance analyte series and the variance-set result fetch

**Files:** Modify `backend/coa/variance_series.py::build_variance_analyte_series` (~316-371), `backend/sub_samples/service.py::_fetch_mk1_results_for_host` (~2486-2590); extend `backend/tests/test_variance_series.py`, `backend/tests/test_variance_results_native.py`.

- [ ] **Step 1: Failing tests**

```python
# test_variance_series.py — native BLEND world (extend `native_world` idea: two peptides, slots 1/2, 2 variance vials)
def test_native_blend_analyte_series_keyed_per_slot(native_blend_world, db):
    out = build_variance_analyte_series(db, native_blend_world)
    assert set(out) >= {"ANALYTE-1-PUR", "ANALYTE-2-PUR", "ANALYTE-1-QTY", "ANALYTE-2-QTY"}
    assert len(out["ANALYTE-1-PUR"]["values"]) == 2 and len(out["ANALYTE-2-PUR"]["values"]) == 2

def test_native_single_analyte_series_uses_single_keys(native_world, db):
    out = build_variance_analyte_series(db, native_world)
    assert set(out) == {"HPLC-PUR", "PEPT-Total"}

# test_variance_results_native.py
def test_native_blend_results_do_not_collide(db):
    # vial with HPLC-PURITY slot 1 = "98" and slot 2 = "96" on a native blend parent (2 slots in analytes)
    out = _fetch_mk1_results_for_host(db, host_kind="sub_sample", host_pk=sub.id)
    assert out["ANALYTE-1-PUR"]["value"] == "98" and out["ANALYTE-2-PUR"]["value"] == "96"
    assert "HPLC-PURITY" not in out
```
(For the single-peptide native case the existing `test_native_identity_conforms_via_row_peptide` asserts `out["HPLC-IDENTITY"]` — under the shim it becomes `out["ANALYTE-1-ID"]`: update that assertion and the sibling; ledger it as a ruled contract change: the variance-set UI already understands `ANALYTE-N-*` keywords from legacy blends.)

- [ ] **Step 3: Implement**
- `build_variance_analyte_series`: compute `wires = {w.slot: w for w in slot_wires(db, parent)}`, `n = len(wires)` once; in the row loop `kw = wire_keyword(la.keyword, la.slot, n) if is_native_hplc_row(SimpleNamespace(keyword=la.keyword, service_origin=svc.origin)) else (la.keyword or svc.keyword or "").strip()`. (Prefer a tiny local predicate `svc.origin == "mk1" and la.keyword.upper() in TRIO+AGGREGATES` over building a namespace — reuse `is_native_hplc_row` by passing an object with `.keyword`/`.service_origin`; pick the cleaner of the two and keep one.)
- `_fetch_mk1_results_for_host`: same re-key at `out[r.keyword] = entry` → `out[key] = entry` where `key` is the wire keyword for native rows (needs the parent: resolve via `host_pk` → `LimsSubSample.parent_sample_pk` for `sub_sample`, or the parent itself for `sample`; compute `wires` once per call). Legacy rows keep `r.keyword`.
- Remove the slice-3 addendum's "collision" caveat from the docstrings and note the shim.

- [ ] **Step 4: Run** `tests/test_variance_series.py tests/test_variance_results_native.py tests/test_variance_set.py` (live DB; report flakes).
- [ ] **Step 5: Commit** — `feat(coa): variance analyte series + variance-set results keyed per slot via hplc_shim`.

---

### Task 5: Source resolver on the mk1 path keys native rows by wire keyword

**Files:** `backend/coa/source_resolver.py::_resolve_mk1_parent_tier` (~266-330) and `_pin_row_identity_matches` (~332-395); tests `backend/tests/test_coa_source_resolver.py` (extend).

- [ ] **Step 0: Verify reach.** Grep `main.py` and `coa/*.py` for the callers of `resolve_sources` / `_resolve_mk1_parent_tier` on the generate path when `coa_generation == "mk1"`. If the resolver output is consumed on that path (e.g. the COA Sources panel, `_apply_reportable`, the existence gate), implement below. If it is provably NOT consulted for mk1-mode generation, write that finding (file:line) in the report, add no code, and skip to Task 6 — ledger it.
- [ ] **Step 1: Failing test** — a native blend parent with two verified `HPLC-PURITY` rows (slots 1/2) yields two decisions keyed `ANALYTE-1-PUR` / `ANALYTE-2-PUR` (not one `HPLC-PURITY`); a single-peptide native parent yields `HPLC-PUR`, `PEPT-Total`, `ANALYTE-1-ID`.
- [ ] **Step 3: Implement** — `decisions[key]` with `key = wire_keyword(...)` for native rows (parent known; `wires` computed once), `analyte_keyword=key`; `_pin_row_identity_matches(row, analyte_keyword)` gains a third leg: if `row.slot is not None` and `wire_keyword(row.keyword, row.slot, n_slots) == analyte_keyword` (n_slots from the parent — thread it or recompute).
- [ ] **Step 5: Commit** — `feat(coa): mk1 source resolver keys native HPLC rows per slot`.

---

### Task 6: Parity — vendored engine over native single + blend wire documents

**Files:** Create `backend/tests/test_hplc_native_coa_parity.py`. Read `backend/tests/test_conformance_coabuilder_parity.py` and `backend/scripts/regen_conformance_goldens.py` for how `ConformanceEngine` is constructed and fed (`senaite_json` with `_Analyses_Detailed` + the `Analyte{N}Peptide` fields), and `backend/tests/fixtures/conformance/expected_PB-0010.json` for the output shape to assert on.

- [ ] **Step 1: Tests** (sqlite; `native_family` + promote verified parent rows the way `test_hplc_native_promote_slots.py` does, then `coa_generation` patched to "mk1" via `coa.source_setting.coa_generation_source` monkeypatch; patch `build_native_sections` to return `{"sample_id":..., "ordered_profiles": [], "sections": []}` and `build_sample_meta`'s env/attachment prerequisites as in `test_sample_meta_producer.py`):

```python
def _engine_input(doc):
    meta = dict(doc["sample_meta"]); meta["_Analyses_Detailed"] = doc["legacy_rows"]["rows"]
    return meta

def test_native_single_page1_parity(db, ...):
    # verified parent rows: identity "Conforms", purity "98.5" %, quantity "4.9" mg (slot 1)
    doc = build_coa_wire_document(db, parent)
    out = ConformanceEngine(...).evaluate(_engine_input(doc))     # real entry-point name from the parity test
    ident = next(r for r in out["results_table"] if r["type"] == "IDENTITY")   # real keys from expected_PB-0010.json
    assert ident["conforms"] is True and ident["display_name"] == "BPC-157"
    pur = ...; assert pur["value"] == 98.5 and pur["conforms"] is True
    qty = ...; assert qty["value"] == 4.9 and qty["conforms"] is None

def test_native_blend_page1_parity(db, ...):
    # slots BPC-157 (98, 4 mg) and TB-500 (96, 1 mg), aggregates BLEND 97.6 / 5
    # assert two identity rows conform, two per-analyte purity rows, blend purity 97.6 conforms, total 5 mg

def test_native_identity_fail_cascades(db, ...):
    # slot identity "Does Not Conform" → identity row conforms False, purity/quantity for that slot N/A per engine rules
    # (assert exactly what expected_PB-0010.json-style output shows for a failed identity; read the engine 239-330)

def test_native_unresolved_slot_blocks_generation(db, ...):
    # slot peptide_id NULL → build_coa_wire_document raises NativeSectionsError (UnresolvedNativeSlotError)
```
- [ ] **Step 2/3:** these are characterisation tests over unchanged engine code — write them to pass against the real output; if an assertion cannot be met without changing the engine, STOP and report (that is a shim vocabulary bug, fix in Tasks 1-3, never in the engine).
- [ ] **Step 5: Commit** — `test(coa): native single + blend page-1 parity through the vendored engine`.

---

### Task 7: Gate, CHANGELOG, spec addenda

- Failure-set diff vs base `C:\tmp\Accu-Mk1-hplc-slice4` (same window), FE untouched (skip vitest unless src changed), bindparam guard.
- CHANGELOG "HPLC native-born — slice 5 (M7)": legacy rows carry native HPLC rows in SENAITE vocabulary via `coa/hplc_shim`; sample_meta analyte titles from the same helper; unresolved slot blocks COA; variance series / variance-set results / source resolver keyed per slot; parity tests.
- Spec addenda (docs branch, pathspec): (1) `Analyte{N}DeclaredQuantity` never emitted by `build_sample_meta` in mk1 mode — pre-existing for all samples, separate ticket; (2) variance-set result keys for native rows are now the shim keywords (`ANALYTE-N-*` / `HPLC-PUR` / `PEPT-Total`) — FE already handles them from legacy blends; (3) Task 5's reach finding.
- Push/PR held for the controller (stacked on `feat/hplc-native-slice4`).

---

## Self-review

**Spec coverage (M7):** `backend/coa/hplc_shim.py` (`is_native_hplc`≈`is_native_hplc_row`, `wire_keyword(row, n_slots)`) → Task 1; `legacy_rows.build_legacy_rows` admits native rows, emits shim Keyword, Title/ServiceTitle = stamped title (from the shared helper), FIELD_CONTRACT unchanged → Task 2; `sample_meta._analyte_slots` emits `identity_title(display_name)` for native-born via the same helper → Task 3; `source_resolver.py:317` + `_pin_row_identity_matches` keyed by wire keyword → Task 5; vial COA rides the same path (it calls `build_legacy_rows` with the parent) → covered by Task 2; parity test on single + blend → Task 6; slice-3 addendum (keyword collision on native blends) → Task 4; "COA shim (M7) must exclude/block on unresolved rows" addendum → Task 2 abort.

**Placeholder scan:** the `...` in Tasks 3 and 6 are explicit "copy from named file" fixture instructions; engine entry-point/key names are to be read from the named parity test and golden, never guessed.

**Type consistency:** `SlotWire(slot, display_name, peptide_id, reason)` + `.identity_title` used identically in Tasks 2/3/4/5; `wire_keyword(keyword, slot, n_slots)` and `wire_title(keyword, row_title, wire)` signatures match across tasks; `slot_wires(db, parent)` returns `[]` for SENAITE-born so every consumer's legacy path is the unchanged code.
