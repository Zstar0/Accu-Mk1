# HPLC Native-Born — Slice 4 (M6: slot-aware promote / retest / read surfaces / removal + native slot relabel + peptide_id invalidation + native publish gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native-born blend with N slots of the same generic service (`HPLC-PURITY` etc.) promotes, retests, lists, removes and relabels per slot — never conflating slot 1 with slot 2 — and a relabel can never re-seed a stale peptide.

**Architecture:** Slice 1 widened every unique index to `(…, COALESCE(slot,0))` and slice 2 minted per-slot vial rows and per-slot `ordered` parent placeholders, but every parent-tier operation still keys on `analysis_service_id` or `keyword` alone: promote never copies `slot`, so a second slot's promote violates `uq_lims_analyses_parent_service_id_root`; supersession, retest lookup, list collapse, vial-state overlay, removal classification and reject cascades all pick "the" row for a service. This slice threads one key everywhere — `(analysis_service_id, slot or 0)` (or `(keyword, slot or 0)` where the existing key is keyword) — via two tiny helpers in `lims_analyses/hplc_native.py`, copies `peptide_id/slot/title` onto promoted parent rows, adds an optional `slot` to the parent-retest wire, adds `relabel_native_slot` + route (the only sanctioned way to change a native-born slot; legacy Replace/Clear 409 on native-born), nulls a slot's `peptide_id` whenever its name is rewritten (root-cause invalidation), restamps placeholders after an S2S customer edit on a native-born sample, and skips the SENAITE AR lookup on publish for native-born samples. FE: retest sends `slot`, the Analytes card shows Relabel (not Replace/Clear) on native-born samples.

**Tech Stack:** Python 3.11 / FastAPI / SQLAlchemy 2 (`func.coalesce`), pytest (sqlite in-memory + StaticPool TestClient), React + TypeScript + vitest (npm only).

**Spec:** `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md` (main checkout, branch `docs/analysis-catalog-specs`) — M6 line + addenda "Slot-keyed parent read surfaces (M6)" and "`peptide_id` invalidation contract (M6 relabel)". Plan-mode copy `C:\Users\forre\.claude\plans\glistening-hopping-cupcake.md`.

**Branch / worktree:** `feat/hplc-native-slice4` at `C:\tmp\Accu-Mk1-hplc-slice4`, base `feat/hplc-native-slice3` (after its Task 7 CHANGELOG commit). Python: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe` from the worktree `backend/` (bare `python` hangs). Tests: `<PY> -m pytest -q -p no:cacheprovider <paths>`.

## Global Constraints

- **Additive only.** SENAITE-born behaviour byte-identical: every new key term is `COALESCE(slot, 0)` / `slot or 0`, which is `0` on every legacy row, so legacy collapses/lookups resolve exactly as today. New parameters default to `None` = old behaviour.
- **Never flip `analysis_services.origin`; never edit legacy keyword literals/regexes.** Reuse `TRIO`, `AGGREGATES`, `KW_*`, `is_native_born`, `title_for_slot`, `resolve_slot_peptides`, `SlotResolution` from `lims_analyses/hplc_native.py`.
- **Never guess:** a lookup that finds 2+ candidate rows raises/returns None; never `.first()` a multi-slot set without the slot term.
- **Relabel only on pristine slots.** A slot is relabel-able only while every row for that slot (parent placeholders + all vial rows across the family) is pristine: `review_state in ("unassigned","assigned")`, `result_value IS NULL`, `retested IS false`, `retest_of_id IS NULL`, no promotion link. Otherwise 409. (Spec: "409 past `unassigned`".)
- **`peptide_id` invalidation:** any writer that changes a slot's `name` sets that slot's `peptide_id` to `None` unless the new name equals the old name (case/whitespace-insensitive).
- **Route placement (Ruling):** the relabel route lives on the `lims_analyses` router as `POST /api/lims-analyses/parent/{sample_id}/native-slots/{slot}/relabel` (next to `parent_retest`), not the spec's `/api/samples/...` path — there is no `/api/samples` router; the spec path is a sketch.
- **Legacy Replace/Clear on native-born → 409** with code `native_born_use_relabel`.
- Pathspec commits only (`git add <paths>`; `git commit -m "<msg>" -- <paths>`); trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; never `git stash`; check `git diff --stat` for CRLF whole-file rewrites (blobs stay LF).
- Test gate = failure-set diff vs base (`feat/hplc-native-slice3`), same window, never zero-failures. Known pre-existing: `tests/test_identity_convergence_guard.py::test_no_unclassified_keyword_identity_site`; live-DB order flakes (`test_vial_retest`, `test_promote_sets_source_promoted`, `test_variance_set`, `test_clickup_task_retry`).
- No DB migrations in this slice.

---

## File structure

| File | Responsibility in this slice |
|---|---|
| `backend/lims_analyses/hplc_native.py` | + `slot_key(row) -> tuple[int|None,int]`, `slot_clause(slot) -> ColumnElement` (COALESCE term), `relabel_native_slot(...)`, `restamp_native_slot_rows(...)`, `NativeSlotLockedError`, `NativeSlotNotFoundError` |
| `backend/lims_analyses/service.py` | promote copies peptide_id/slot/title + slot-aware `_ident_clause`; `_find_active_parent_row(slot=)`; `cascade_parent_retest_to_sources(slot=)`; `parent_retest(slot=)`; four list/collapse/overlay sites keyed by `slot_key`; `delete_pristine_analysis(slot=)`; `cascade_parent_reject_to_vials(slot=)` |
| `backend/lims_analyses/manage_native.py` | `_classify_vial_rows(slot=)`; `remove_parent_native_analysis` passes `row.slot` |
| `backend/lims_analyses/schemas.py` | `ParentRetestRequest.slot`, `RelabelNativeSlotRequest/Response` |
| `backend/lims_analyses/routes.py` | `parent_retest` passes slot; new relabel route + error mapping |
| `backend/sub_samples/service.py` | `_apply_senaite_fields_to_row` nulls `peptide_id` on rename |
| `backend/sub_samples/lookup_models.py` | `RegistrySampleReadResult.external_lims_system` |
| `backend/sub_samples/registry_details.py` | populates it |
| `backend/main.py` | Replace/Clear 409 on native-born; S2S field mirror restamps native placeholders; publish skips SENAITE search on native-born |
| `src/lib/api.ts`, `src/hooks/use-parent-retest-flow.ts`, `src/components/senaite/SampleDetails.tsx`, new `src/components/senaite/RelabelNativeSlotDialog.tsx` | retest sends slot; Analytes card native mode |
| Tests | new `backend/tests/test_hplc_native_promote_slots.py`, `test_hplc_native_read_surfaces.py`, `test_hplc_native_relabel.py`, `test_hplc_native_publish_gate.py`; extend `test_registry_analyte_slots_positional.py`, `test_manage_native.py`; FE `src/test/relabel-native-slot-dialog.test.tsx`, extend `src/lib/__tests__/` retest flow test |

Shared test scaffold for the new backend files (define once in Task 1's test file as `backend/tests/_hplc_native_fixtures.py`? — NO: pytest conftest discovery is cleaner. **Task 1 creates `backend/tests/hplc_native_family.py`** (plain module, not `test_*`) with `native_family(db, *, sample_id, slots: list[tuple[str, str]], vials: int)` that seeds the 5-service catalog (`origin="mk1"`), peptides, a native-born parent with `analytes` JSON carrying `peptide_id`, per-slot `ordered` placeholders via `parent_placeholders.seed_parent_placeholders`, and N vials seeded via `hplc_native.seed_native_hplc_rows`. Copy constructor kwargs from `tests/test_hplc_native_placeholders.py` and `tests/test_hplc_native_seeder.py` — they already build exactly this.)

---

### Task 1: Slot key helpers + slot-aware promote / supersession / parent-retest lookup

**Files:**
- Modify: `backend/lims_analyses/hplc_native.py` (append helpers)
- Modify: `backend/lims_analyses/service.py:937-946` (effective identity), `:983-1013` (`_ident_clause`), `:1038-1051` (parent row insert), `:1935-2025` (`_find_active_parent_row`), `:2028-2037` (`cascade_parent_retest_to_sources`), `parent_retest` (grep `def parent_retest` in service.py)
- Modify: `backend/lims_analyses/schemas.py:321-327` (`ParentRetestRequest`), `backend/lims_analyses/routes.py:297-322` (`parent_retest`)
- Create: `backend/tests/hplc_native_family.py`, `backend/tests/test_hplc_native_promote_slots.py`

**Interfaces:**
- Produces: `hplc_native.slot_key(row) -> tuple[Optional[int], int]` = `(row.analysis_service_id, row.slot or 0)`; `hplc_native.kw_slot_key(row) -> tuple[str, int]` = `((row.keyword or ""), row.slot or 0)`; `hplc_native.slot_clause(slot: Optional[int])` = `func.coalesce(LimsAnalysis.slot, 0) == (slot or 0)`.
- `_find_active_parent_row(..., slot: Optional[int] = None)`; `cascade_parent_retest_to_sources(..., slot: Optional[int] = None)`; `service.parent_retest(..., slot: Optional[int] = None)`; `ParentRetestRequest.slot: Optional[int] = None`.
- Promoted parent rows for native sources carry `peptide_id`, `slot`, and the first source's stamped `title`.

- [ ] **Step 1: Scaffold + failing tests**

`backend/tests/hplc_native_family.py`:

```python
"""Shared builder for native-born HPLC family fixtures (slice 4 tests).

Not a test module (no test_ prefix). Seeds: Analytical dept, the five native
services (origin='mk1'), peptides, a native-born parent whose `analytes` JSON
carries peptide_id per slot, per-slot ordered parent placeholders, and N vials
seeded through the real native seeder — the same objects prod creates.
"""
import json
from models import AnalysisService, AnalysisProfile, Department, LimsSample, LimsSubSample, Peptide
from lims_analyses.hplc_native import seed_native_hplc_rows, TRIO, AGGREGATES
from lims_analyses.parent_placeholders import seed_parent_placeholders


def native_catalog(db) -> dict[str, AnalysisService]:
    from catalog.hplc_native_seed import HPLC_NATIVE_SERVICES, HPLC_NATIVE_PROFILE_KEY, HPLC_NATIVE_PROFILE_NAME
    dept = Department(name="Analytical"); db.add(dept); db.flush()
    out = {}
    for kw, title, unit, rtype, vc in HPLC_NATIVE_SERVICES:
        svc = AnalysisService(title=title, keyword=kw, unit=unit, result_type=rtype,
                              origin="mk1", variance_capable=vc, department_id=dept.id)
        db.add(svc); db.flush(); out[kw] = svc
    return out


def native_family(db, *, sample_id: str, slots: list[tuple[str, str]], vials: int = 1,
                  services: dict | None = None):
    """slots = [(peptide_name, abbreviation), ...] in slot order. Returns
    (parent, services, peptides_by_slot, vial_rows_by_vial)."""
    services = services or native_catalog(db)
    peps = []
    for name, abbr in slots:
        p = Peptide(name=name, abbreviation=abbr, active=True); db.add(p); db.flush(); peps.append(p)
    analytes = [{"name": p.name, "declared_quantity": None, "peptide_id": p.id} for p in peps]
    parent = LimsSample(sample_id=sample_id, external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide Blend" if len(peps) > 1 else "Peptide",
                        analytes=json.dumps(analytes))
    db.add(parent); db.flush()
    # parent placeholders: copy the `services` dict shape seed_parent_placeholders
    # expects from tests/test_hplc_native_placeholders.py (profile -> members).
    ...
    vial_rows = {}
    for seq in range(1, vials + 1):
        v = LimsSubSample(parent_sample_pk=parent.id, sample_id=f"{sample_id}-S{seq:02d}",
                          external_lims_uid=f"uid-{sample_id}-S{seq:02d}", vial_sequence=seq)
        db.add(v); db.flush()
        rows = seed_native_hplc_rows(db, sub_sample=v, parent=parent, existing_keys=set(),
                                     existing_service_ids=set(), created_by_user_id=None, commit=False)
        vial_rows[v.id] = rows
    db.flush()
    return parent, services, {i + 1: p for i, p in enumerate(peps)}, vial_rows
```

(The `...` for placeholders is the ONE place the implementer must copy from `tests/test_hplc_native_placeholders.py::test_native_blend_parent_gets_one_placeholder_per_slot_plus_aggregates` — the exact `services=`/`package=` argument shape `seed_parent_placeholders` takes. Do not invent it.)

`backend/tests/test_hplc_native_promote_slots.py`:

```python
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsAnalysis
from lims_analyses.hplc_native import KW_PURITY, slot_key, kw_slot_key
from lims_analyses.service import apply_transition, promote_to_parent, _find_active_parent_row, parent_retest
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _submit_verify(db, row, value):
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=value, user_id=1, commit=False)
    apply_transition(db, analysis_id=row.id, kind="verify", user_id=1, commit=False)


def _purity_rows(rows):
    return sorted((r for r in rows if r.keyword == KW_PURITY), key=lambda r: r.slot)


def test_slot_key_helpers():
    class R:  # duck rows
        analysis_service_id = 7; slot = None; keyword = "HPLC-PURITY"
    assert slot_key(R()) == (7, 0) and kw_slot_key(R()) == ("HPLC-PURITY", 0)
    R.slot = 3
    assert slot_key(R()) == (7, 3) and kw_slot_key(R()) == ("HPLC-PURITY", 3)


def test_promote_two_slots_of_same_service_mints_two_parent_rows(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1101",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _purity_rows(rows)
    _submit_verify(db, pur1, "98.1"); _submit_verify(db, pur2, "96.2")
    p1, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="98.1", result_unit="%",
                              method_id=None, instrument_id=None,
                              sources=[{"analysis_id": pur1.id, "contribution_kind": "chosen"}],
                              user_id=1, commit=False)
    p2, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="96.2", result_unit="%",
                              method_id=None, instrument_id=None,
                              sources=[{"analysis_id": pur2.id, "contribution_kind": "chosen"}],
                              user_id=1, commit=False)
    assert (p1.slot, p1.peptide_id, p1.title) == (1, peps[1].id, pur1.title)
    assert (p2.slot, p2.peptide_id, p2.title) == (2, peps[2].id, pur2.title)
    assert p1.id != p2.id and p1.analysis_service_id == p2.analysis_service_id


def test_repromote_supersedes_only_its_own_slot(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1102",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _purity_rows(rows)
    _submit_verify(db, pur1, "98.1"); _submit_verify(db, pur2, "96.2")
    p1, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="98.1", result_unit="%", method_id=None,
                              instrument_id=None, sources=[{"analysis_id": pur1.id, "contribution_kind": "chosen"}],
                              user_id=1, commit=False)
    p2, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="96.2", result_unit="%", method_id=None,
                              instrument_id=None, sources=[{"analysis_id": pur2.id, "contribution_kind": "chosen"}],
                              user_id=1, commit=False)
    apply_transition(db, analysis_id=p2.id, kind="verify", user_id=1, commit=False)
    # retest slot 2's vial row, re-promote it
    from lims_analyses.service import retest_analysis  # read service.py:~470 for the real name
    child = retest_analysis(db, analysis_id=pur2.id, user_id=1, commit=False)
    _submit_verify(db, child, "95.0")
    p2b, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="95.0", result_unit="%", method_id=None,
                               instrument_id=None, sources=[{"analysis_id": child.id, "contribution_kind": "chosen"}],
                               user_id=1, commit=False)
    db.refresh(p1); db.refresh(p2)
    assert p1.review_state == "parent_to_verify"          # slot 1 untouched
    assert p2.review_state == "retracted" and p2b.slot == 2


def test_find_active_parent_row_is_slot_scoped(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1103",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _purity_rows(rows)
    _submit_verify(db, pur1, "98.1"); _submit_verify(db, pur2, "96.2")
    for r in (pur1, pur2):
        promote_to_parent(db, keyword=KW_PURITY, result_value=r.result_value, result_unit="%", method_id=None,
                          instrument_id=None, sources=[{"analysis_id": r.id, "contribution_kind": "chosen"}],
                          user_id=1, commit=False)
    svc_id = services[KW_PURITY].id
    a = _find_active_parent_row(db, parent_sample_pk=parent.id, keyword=KW_PURITY, analysis_service_id=svc_id, slot=1)
    b = _find_active_parent_row(db, parent_sample_pk=parent.id, keyword=KW_PURITY, analysis_service_id=svc_id, slot=2)
    assert a is not None and b is not None and a.id != b.id and (a.slot, b.slot) == (1, 2)
    # No slot on a multi-slot native parent → refuse to guess
    assert _find_active_parent_row(db, parent_sample_pk=parent.id, keyword=KW_PURITY, analysis_service_id=svc_id) is None


def test_parent_retest_with_slot_unpromotes_only_that_slot(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1104",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _purity_rows(rows)
    _submit_verify(db, pur1, "98.1"); _submit_verify(db, pur2, "96.2")
    parents = []
    for r in (pur1, pur2):
        p, _ = promote_to_parent(db, keyword=KW_PURITY, result_value=r.result_value, result_unit="%", method_id=None,
                                 instrument_id=None, sources=[{"analysis_id": r.id, "contribution_kind": "chosen"}],
                                 user_id=1, commit=False)
        apply_transition(db, analysis_id=p.id, kind="verify", user_id=1, commit=False)
        parents.append(p)
    db.commit()
    new_ids, state = parent_retest(db, sample_id="PB-1104", keyword=KW_PURITY, user_id=1, reason="t",
                                   analysis_service_id=services[KW_PURITY].id, slot=2)
    db.refresh(parents[0]); db.refresh(parents[1])
    assert parents[0].review_state == "verified"
    assert parents[1].review_state == "retracted"
    assert len(new_ids) == 1 and db.get(LimsAnalysis, new_ids[0]).retest_of_id == pur2.id
```

(Names to confirm by reading, never guess: the retest entry point around `service.py:470-500` that builds the `new_row` copying `peptide_id/slot` — use its real name and signature; `apply_transition`'s `commit` kwarg; the exact `sources` dict keys `promote_to_parent` validates at `service.py:889-899`.)

- [ ] **Step 2: Run** `<PY> -m pytest -q -p no:cacheprovider tests/test_hplc_native_promote_slots.py` — Expected: FAIL (`slot_key` import error; then IntegrityError/None on the second promote).

- [ ] **Step 3: Implement**

`hplc_native.py` (append):

```python
def slot_key(row) -> tuple:
    """(analysis_service_id, slot or 0) — the ONE identity key for parent-tier
    collapse/overlay/lookup. Legacy rows have slot NULL → (sid, 0): identical
    to keying on service id alone (spec 2026-09-10 M6 addendum)."""
    return (row.analysis_service_id, row.slot or 0)


def kw_slot_key(row) -> tuple:
    return ((row.keyword or ""), row.slot or 0)


def slot_clause(slot: Optional[int]):
    """SQL twin of slot_key's second element."""
    from sqlalchemy import func
    return func.coalesce(LimsAnalysis.slot, 0) == (slot or 0)
```

`service.py::promote_to_parent`:
- after `eff_title = ...` (line ~939): when `is_native`, keep the vial row's stamped title if it has a slot: 
  ```python
  if is_native and parent_keyword is None:
      eff_parent_keyword = first_source_svc.keyword
      # Native-born per-slot rows carry a STAMPED title ("BPC-157 - Purity (HPLC)");
      # slot-less native rows (endo, PCR, aggregates) keep the service title.
      eff_title = first_source.title if first_source.slot is not None else first_source_svc.title
  ```
- `_ident_clause` becomes:
  ```python
  from lims_analyses.hplc_native import slot_clause
  _ident_clause = (
      and_(LimsAnalysis.analysis_service_id == eff_service_id, slot_clause(first_source.slot))
      if is_native
      else LimsAnalysis.keyword == eff_parent_keyword
  )
  ```
  (`and_` from sqlalchemy; for legacy `first_source.slot` is None → `COALESCE(slot,0)==0` — but the legacy branch does not use it at all, unchanged.)
- parent row insert gains `peptide_id=first_source.peptide_id, slot=first_source.slot,`.
- Source validation loop (889-899): for native sources additionally require every source to share `slot or 0` with the first source; raise the same error class the loop uses for a service mismatch, message "sources span multiple slots".

`_find_active_parent_row(..., slot: Optional[int] = None)`:
```python
    if analysis_service_id is not None:
        ident = LimsAnalysis.analysis_service_id == analysis_service_id
        if slot is not None:
            return _first(and_(ident, slot_clause(slot)))
        rows = db.execute(select(LimsAnalysis).where(*base, ident)).scalars().all()
        if len({r.slot or 0 for r in rows}) > 1:
            return None   # multi-slot native parent without a slot: never guess
        return rows[0] if rows else None
```
(keyword branch + native rescue unchanged, but the rescue's final `_first(...)` gets the same multi-slot guard.)

`cascade_parent_retest_to_sources(..., slot=None)` → passes `slot=slot` to `_find_active_parent_row`. `service.parent_retest(..., slot=None)` → passes through. `ParentRetestRequest.slot: Optional[int] = None` with comment "native-born per-slot rows: identifies which slot's parent row (spec 2026-09-10 M6)". Route passes `slot=req.slot`.

- [ ] **Step 4: Run** the new file + `tests/test_native_promote.py tests/test_parent_retest_route.py tests/test_source_retest_route.py tests/test_parent_retest_cascade.py tests/test_retest_current_row.py tests/test_hplc_native_schema.py` — Expected: all PASS.

- [ ] **Step 5: Commit** (pathspec: hplc_native.py, service.py, schemas.py, routes.py, tests/hplc_native_family.py, tests/test_hplc_native_promote_slots.py) — `feat(hplc-native): slot-aware promote, supersession and parent-retest lookup`.

---

### Task 2: Slot-keyed parent read surfaces (list dedupe, placeholder suppression, keyword collapse, vial-state overlay)

**Files:**
- Modify: `backend/lims_analyses/service.py:1167-1173` (`seen_service_ids`), `:1199-1230` (`_overlay_live_vial_state`), `:1380-1386` (`services_with_live_canonical`), `:1709-1716` (`delivered_service_ids`), `:1737-1754` (`live_canonical_keywords`/`canonical_ever`)
- Create: `backend/tests/test_hplc_native_read_surfaces.py`

**Interfaces:** consumes `slot_key`, `kw_slot_key` (Task 1). No signature changes.

- [ ] **Step 1: Failing tests**

```python
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.hplc_native import KW_PURITY
from lims_analyses.service import (apply_transition, promote_to_parent, list_native_parent_analyses,
                                   list_native_parent_analyses_senaite_shape, list_parent_analyses_senaite_shape)
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:"); Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try: yield s
    finally: s.close()


def _two_slot_family(db, sid):
    parent, services, peps, vial_rows = native_family(db, sample_id=sid,
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = sorted((r for r in rows if r.keyword == KW_PURITY), key=lambda r: r.slot)
    return parent, services, pur1, pur2


def test_native_list_keeps_both_slots(db):
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1201")
    out = list_native_parent_analyses(db, "PB-1201")
    purity = [r for r in out if r.keyword == KW_PURITY]
    assert sorted(r.slot for r in purity) == [1, 2]


def test_canonical_slot1_does_not_suppress_slot2_placeholder(db):
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1202")
    apply_transition(db, analysis_id=pur1.id, kind="submit", result_value="98", user_id=1, commit=False)
    apply_transition(db, analysis_id=pur1.id, kind="verify", user_id=1, commit=False)
    promote_to_parent(db, keyword=KW_PURITY, result_value="98", result_unit="%", method_id=None, instrument_id=None,
                      sources=[{"analysis_id": pur1.id, "contribution_kind": "chosen"}], user_id=1, commit=False)
    db.commit()
    for fn in (list_native_parent_analyses_senaite_shape, list_parent_analyses_senaite_shape):
        shaped = fn(db, "PB-1202")            # read each fn's real signature; adapt the call
        purity = [r for r in shaped if r.keyword == KW_PURITY]
        assert {(r.slot, r.provenance) for r in purity} == {(1, "canonical"), (2, "ordered")}


def test_overlay_is_slot_scoped(db):
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1203")
    apply_transition(db, analysis_id=pur1.id, kind="submit", result_value="98", user_id=1, commit=False)
    db.commit()
    shaped = list_native_parent_analyses_senaite_shape(db, "PB-1203")
    by_slot = {r.slot: r.review_state for r in shaped if r.keyword == KW_PURITY}
    assert by_slot[1] == "to_be_verified" and by_slot[2] == "unassigned"
```

- [ ] **Step 2: Run** — Expected: FAIL (slot 2 collapsed / overlaid).

- [ ] **Step 3: Implement** — replace each key expression:

```python
# 1167-1173
seen: set[tuple] = set()
for analysis in rows:
    k = slot_key(analysis)
    if k in seen: continue
    seen.add(k); deduped.append(analysis)
deduped.sort(key=lambda a: (a.keyword, a.slot or 0))

# 1380-1386
live_canonical_keys = {slot_key(r) for r in fetched
                       if r.provenance == "canonical" and r.review_state not in ("retracted", "rejected")}
rows = [r for r in fetched if r.provenance == "canonical" or slot_key(r) not in live_canonical_keys]

# 1709-1716
delivered_keys = {slot_key(r) for r in rows if r.provenance == "canonical"}
rows = [r for r in rows if r.provenance != PROVENANCE_ORDERED or slot_key(r) not in delivered_keys]

# 1737-1754 — keyword collapse becomes (keyword, slot or 0); canonical_ever query selects keyword + slot
live_canonical_kw_keys = {kw_slot_key(r) for r in rows if r.provenance == "canonical"}
canonical_ever = {(kw, slot or 0) for kw, slot in db.execute(
    select(LimsAnalysis.keyword, LimsAnalysis.slot).where(
        LimsAnalysis.lims_sample_pk == parent.id,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.provenance == "canonical",
    ).distinct()).all()} | live_canonical_kw_keys
rows = [r for r in rows
        if r.provenance == "canonical"
        or (r.provenance == "shadow" and kw_slot_key(r) not in canonical_ever)
        or (r.provenance != "shadow" and kw_slot_key(r) not in live_canonical_kw_keys)]

# _overlay_live_vial_state: ordered_keys = {slot_key(r) ...}; vial query keeps service-id IN filter;
# live_state_by_key: dict[tuple, str] keyed slot_key(vr); overlay matches slot_key(shaped_row)
```
Keep every existing comment; append one sentence to each explaining the slot term.

- [ ] **Step 4: Run** new file + `tests/test_parent_placeholders.py tests/test_hplc_native_placeholders.py tests/test_native_manage_analyses.py tests/test_manage_native.py tests/test_manage_native_routes.py tests/test_native_parent_line_states*.py tests/test_legacy_rows*.py tests/test_coa_*.py` — Expected: PASS (any failure must be proven identical on base).

- [ ] **Step 5: Commit** — `feat(hplc-native): parent read surfaces key on (service, slot)`.

---

### Task 3: Slot-aware removal / pristine delete / reject cascade

**Files:**
- Modify: `backend/lims_analyses/manage_native.py:309` (`_classify_vial_rows(db, parent, service_id, slot=None)`), `:437` (pass `row.slot`), `:448` (pass `slot=`)
- Modify: `backend/lims_analyses/service.py:3334` (`delete_pristine_analysis(..., slot=None)`), `:2555` (`cascade_parent_reject_to_vials(..., slot=None)`)
- Test: `backend/tests/test_manage_native.py` (append), `backend/tests/test_hplc_native_read_surfaces.py` (append)

**Interfaces:** `_classify_vial_rows(db, parent, service_id, slot: Optional[int] = None)`; `delete_pristine_analysis(db, *, sub_sample_pk, keyword=None, user_id, analysis_service_id=None, slot: Optional[int] = None)`; `cascade_parent_reject_to_vials(db, *, parent_sample_id, keyword, user_id, slot: Optional[int] = None)`.

- [ ] **Step 1: Failing tests** (append to `test_hplc_native_read_surfaces.py`):

```python
def test_remove_slot2_placeholder_leaves_slot1_vial_rows(db):
    from lims_analyses.manage_native import remove_parent_native_analysis
    from models import LimsAnalysis
    from sqlalchemy import select
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1301")
    ph2 = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id,
                                                LimsAnalysis.keyword == KW_PURITY, LimsAnalysis.slot == 2)).scalar_one()
    remove_parent_native_analysis(db, parent=parent, analysis_id=ph2.id, user_id=1, confirm=False)  # read the real kwargs
    db.refresh(pur1); db.refresh(pur2)
    assert pur1.review_state == "unassigned"                       # slot 1 untouched
    assert db.get(LimsAnalysis, pur2.id) is None                   # slot 2 pristine row deleted


def test_delete_pristine_requires_slot_on_multislot_vial(db):
    from lims_analyses.service import delete_pristine_analysis
    from lims_analyses.errors import BadRequestError   # read the real module for the exception
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1302")
    with pytest.raises(BadRequestError):
        delete_pristine_analysis(db, sub_sample_pk=pur1.lims_sub_sample_pk, keyword=KW_PURITY, user_id=1)
    delete_pristine_analysis(db, sub_sample_pk=pur1.lims_sub_sample_pk, keyword=KW_PURITY, user_id=1, slot=1)
    db.refresh(pur2)
    assert pur2.review_state == "unassigned"
```

- [ ] **Step 2: Run** — FAIL (MultipleResultsFound / both slots removed).

- [ ] **Step 3: Implement**
- `_classify_vial_rows`: add `slot` param; when not None add `slot_clause(slot)` to the row query.
- `remove_parent_native_analysis`: `impact = _classify_vial_rows(db, parent, service_id, slot=row.slot)`; the pristine delete loop passes `slot=row.slot`. Check `_supersede_orphan_edges(db, parent=parent, service_id=service_id)` — read it; if it touches rows by service id alone, add the same optional `slot` and pass `row.slot` (ledger what you found).
- `delete_pristine_analysis`: build `_ident` as before; if `slot is not None` add `slot_clause(slot)`; replace `.scalar_one_or_none()` with `.scalars().all()`; if 2+ rows with distinct `slot or 0` → `raise BadRequestError("multiple slots match — pass slot")`; else proceed with the single row (or None → existing not-found handling).
- `cascade_parent_reject_to_vials`: add `slot`; when not None add `slot_clause(slot)` to the targets query. (Callers in main.py stay unchanged — SENAITE-driven path.)

- [ ] **Step 4: Run** new tests + `tests/test_manage_native.py tests/test_manage_native_routes.py tests/test_native_manage_analyses.py tests/test_delete_pristine*.py tests/test_parent_reject*.py` (glob whatever exists).

- [ ] **Step 5: Commit** — `feat(hplc-native): slot-aware removal classification, pristine delete and reject cascade`.

---

### Task 4: `relabel_native_slot` + route; peptide_id invalidation at the slot writer; native placeholder restamp after S2S customer edit; Replace/Clear 409 on native-born

**Files:**
- Modify: `backend/lims_analyses/hplc_native.py` (append `NativeSlotLockedError`, `NativeSlotNotFoundError`, `restamp_native_slot_rows`, `relabel_native_slot`)
- Modify: `backend/lims_analyses/schemas.py` (`RelabelNativeSlotRequest {new_peptide_id: int, reason: Optional[str]}`, `RelabelNativeSlotResponse {slot, old_peptide_id, new_peptide_id, restamped: int}`)
- Modify: `backend/lims_analyses/routes.py` (new route after `parent_retest`; map `NativeSlotLockedError`→409 `{"code": "native_slot_locked"}`, `NativeSlotNotFoundError`→404)
- Modify: `backend/sub_samples/service.py:606-625` (`_apply_senaite_fields_to_row` nulls `peptide_id` on rename)
- Modify: `backend/main.py:23733-23780` (`s2s_mirror_lims_sample_fields`: after `_apply_senaite_fields_to_row`, if `is_native_born(row)` → `restamp_native_slot_rows` for every slot whose name changed), `:12119` and `:12381` (Replace/Clear: 409 `native_born_use_relabel` when `is_native_born`)
- Create: `backend/tests/test_hplc_native_relabel.py`; extend `backend/tests/test_registry_analyte_slots_positional.py`

**Interfaces:**
```python
class NativeSlotLockedError(Exception): code = "native_slot_locked"
class NativeSlotNotFoundError(Exception): code = "native_slot_not_found"

def slot_rows(db, parent, slot) -> list[LimsAnalysis]:
    """Every live row for (parent, slot): parent-tier + all family vials, any keyword in TRIO."""

def is_slot_pristine(rows) -> bool

def restamp_native_slot_rows(db, *, parent, slot, res: SlotResolution) -> int:
    """Restamp peptide_id/title/reportable_reason on every PRISTINE row of the slot. Returns count."""

def relabel_native_slot(db, *, parent, slot: int, new_peptide_id: int, user_id, reason=None, commit=True) -> dict
```

- [ ] **Step 1: Failing tests** — `backend/tests/test_hplc_native_relabel.py`:

```python
import json, pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from database import Base
from models import LimsAnalysis, LimsSubSampleEvent, Peptide
from lims_analyses.hplc_native import (KW_IDENTITY, KW_PURITY, relabel_native_slot, NativeSlotLockedError,
                                       identity_title, purity_title)
from lims_analyses.service import apply_transition
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:"); Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try: yield s
    finally: s.close()


def _rows(db, parent, slot):
    from models import LimsSubSample
    return db.execute(select(LimsAnalysis).outerjoin(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
                      .where((LimsAnalysis.lims_sample_pk == parent.id) | (LimsSubSample.parent_sample_pk == parent.id),
                             LimsAnalysis.slot == slot)).scalars().all()


def test_relabel_pristine_slot_restamps_everything(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1401", vials=2,
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    ghk = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True); db.add(ghk); db.flush()
    out = relabel_native_slot(db, parent=parent, slot=2, new_peptide_id=ghk.id, user_id=1, commit=False)
    assert out["old_peptide_id"] == peps[2].id and out["new_peptide_id"] == ghk.id
    slots = json.loads(parent.analytes)
    assert slots[1] == {"name": "GHK-Cu", "declared_quantity": None, "peptide_id": ghk.id}
    rows = _rows(db, parent, 2)
    assert rows and all(r.peptide_id == ghk.id for r in rows)
    assert {r.title for r in rows if r.keyword == KW_IDENTITY} == {identity_title("GHK-Cu")}
    assert {r.title for r in rows if r.keyword == KW_PURITY} == {purity_title("GHK-Cu")}
    assert all(r.reportable_reason is None for r in rows)
    ev = db.execute(select(LimsSubSampleEvent).where(LimsSubSampleEvent.event == "native_slot_relabeled")).scalar_one()
    assert ev.details["slot"] == 2 and ev.details["new_peptide_id"] == ghk.id
    # slot 1 untouched
    assert all(r.peptide_id == peps[1].id for r in _rows(db, parent, 1))


def test_relabel_resolves_an_unresolved_slot(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="P-1402", slots=[("BPC-157", "BPC157")])
    # simulate an unresolved slot: null the peptide on the stored slot + rows
    slots = json.loads(parent.analytes); slots[0] = {"name": "Mystery", "declared_quantity": None, "peptide_id": None}
    parent.analytes = json.dumps(slots)
    for r in _rows(db, parent, 1):
        r.peptide_id = None; r.reportable_reason = "analyte_unresolved: Mystery"
    db.flush()
    relabel_native_slot(db, parent=parent, slot=1, new_peptide_id=peps[1].id, user_id=1, commit=False)
    assert all(r.peptide_id == peps[1].id and r.reportable_reason is None for r in _rows(db, parent, 1))


def test_relabel_409_once_any_row_has_a_result(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1403",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    pur2 = next(r for r in next(iter(vial_rows.values())) if r.keyword == KW_PURITY and r.slot == 2)
    apply_transition(db, analysis_id=pur2.id, kind="submit", result_value="97", user_id=1, commit=False)
    ghk = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True); db.add(ghk); db.flush()
    with pytest.raises(NativeSlotLockedError):
        relabel_native_slot(db, parent=parent, slot=2, new_peptide_id=ghk.id, user_id=1, commit=False)
    # slot 1 is still relabel-able
    relabel_native_slot(db, parent=parent, slot=1, new_peptide_id=ghk.id, user_id=1, commit=False)


def test_relabel_rejects_duplicate_peptide_across_slots(db):
    from lims_analyses.hplc_native import NativeSlotLockedError
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1404",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    with pytest.raises(NativeSlotLockedError):   # same error class, code duplicate_peptide
        relabel_native_slot(db, parent=parent, slot=2, new_peptide_id=peps[1].id, user_id=1, commit=False)


def test_relabel_route(db):
    """StaticPool TestClient — copy the client fixture from tests/test_native_promote.py:27-67."""
    ...
    # POST /api/lims-analyses/parent/PB-1405/native-slots/2/relabel {"new_peptide_id": ghk.id} → 200 body slot=2
    # second POST after a submitted result → 409 detail.code == "native_slot_locked"
    # POST on a SENAITE-born parent → 409 detail.code == "native_slot_locked" (not native-born)
```

(The route test's client fixture is a verbatim copy from `test_native_promote.py`; the `...` is that copy.)

Append to `backend/tests/test_registry_analyte_slots_positional.py`:

```python
def test_mirror_rename_nulls_stale_peptide_id(db_session):
    from sub_samples.service import apply_senaite_fields_to_row
    row = LimsSample(sample_id="PB-SLOTS-PID", external_lims_uid="U-SLOTS-PID",
                     analytes=json.dumps([{"name": "BPC-157", "declared_quantity": "1", "peptide_id": 11},
                                          {"name": "TB-500", "declared_quantity": "2", "peptide_id": 22}]))
    db_session.add(row); db_session.flush()
    apply_senaite_fields_to_row(db_session, "U-SLOTS-PID", {"Analyte2Peptide": "GHK-Cu"})
    assert json.loads(row.analytes)[1] == {"name": "GHK-Cu", "declared_quantity": "2", "peptide_id": None}
    assert json.loads(row.analytes)[0]["peptide_id"] == 11
    # same name (case/space-insensitive) keeps the id
    apply_senaite_fields_to_row(db_session, "U-SLOTS-PID", {"Analyte1Peptide": " bpc-157 "})
    assert json.loads(row.analytes)[0]["peptide_id"] == 11
```

Add a Replace/Clear guard test to `backend/tests/test_replace_analyte.py` (or a new small route test using its `client`-style fixture if one exists — else `test_hplc_native_relabel.py::test_legacy_replace_and_clear_409_on_native_born` with the StaticPool client): POST `/explorer/samples/PB-1406/analytes/1/replace` and `/clear` on a native-born parent → 409 `detail.code == "native_born_use_relabel"`, and no SENAITE call attempted (patch `fetch_parent_analyte_slots` with `side_effect=AssertionError`).

- [ ] **Step 2: Run** — FAIL (imports / 200s / stale id kept).

- [ ] **Step 3: Implement**

`hplc_native.py`:

```python
class NativeSlotLockedError(Exception):
    def __init__(self, msg, code="native_slot_locked"):
        super().__init__(msg); self.code = code


class NativeSlotNotFoundError(Exception):
    code = "native_slot_not_found"


_PRISTINE_STATES = ("unassigned", "assigned")


def slot_rows(db: Session, parent: LimsSample, slot: int) -> list[LimsAnalysis]:
    from models import LimsSubSample
    return db.execute(
        select(LimsAnalysis)
        .outerjoin(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            (LimsAnalysis.lims_sample_pk == parent.id) | (LimsSubSample.parent_sample_pk == parent.id),
            LimsAnalysis.slot == slot,
            LimsAnalysis.review_state.notin_(("retracted", "rejected")),
        )
    ).scalars().all()


def is_slot_pristine(db: Session, rows: list[LimsAnalysis]) -> bool:
    from models import LimsAnalysisPromotion
    if any(r.review_state not in _PRISTINE_STATES or r.result_value is not None
           or r.retested or r.retest_of_id is not None for r in rows):
        return False
    ids = [r.id for r in rows]
    if not ids:
        return True
    linked = db.execute(select(LimsAnalysisPromotion.id).where(
        LimsAnalysisPromotion.source_analysis_id.in_(ids))).first()
    return linked is None


def restamp_native_slot_rows(db: Session, *, parent: LimsSample, slot: int, res: SlotResolution) -> int:
    n = 0
    for r in slot_rows(db, parent, slot):
        if r.review_state not in _PRISTINE_STATES or r.result_value is not None:
            continue
        r.peptide_id = res.peptide_id
        r.title = title_for_slot(r.keyword, res)
        r.reportable_reason = f"analyte_{res.reason}: {res.raw_name}" if res.reason else None
        n += 1
    db.flush()
    return n


def relabel_native_slot(db: Session, *, parent: LimsSample, slot: int, new_peptide_id: int,
                        user_id: Optional[int], reason: Optional[str] = None, commit: bool = True) -> dict:
    """The ONLY sanctioned way to change a native-born slot's peptide (spec M6).
    409 unless native-born, slot exists, every row of the slot is pristine,
    the peptide is active and not already on another slot."""
    from models import LimsSubSampleEvent
    if not is_native_born(parent):
        raise NativeSlotLockedError("not a native-born sample", code="native_slot_locked")
    slots = _parse_slots(parent)
    if slot < 1 or slot > len(slots) or not (slots[slot - 1] or {}).get("name"):
        raise NativeSlotNotFoundError(f"slot {slot} is empty on {parent.sample_id}")
    pep = db.get(Peptide, new_peptide_id)
    if pep is None or not pep.active:
        raise NativeSlotLockedError("peptide not found or inactive", code="peptide_not_found")
    for i, s in enumerate(slots, start=1):
        if i != slot and isinstance(s, dict) and s.get("peptide_id") == new_peptide_id:
            raise NativeSlotLockedError(f"{pep.name} already occupies slot {i}", code="duplicate_peptide")
    rows = slot_rows(db, parent, slot)
    if not is_slot_pristine(db, rows):
        raise NativeSlotLockedError(f"slot {slot} has bench activity — retest/retract first")
    old = slots[slot - 1]
    old_pid = old.get("peptide_id")
    slots[slot - 1] = {"name": pep.name, "declared_quantity": old.get("declared_quantity"), "peptide_id": pep.id}
    parent.analytes = json.dumps(slots)
    if slot == 1:
        parent.peptide_name = pep.name
    res = SlotResolution(slot, pep.name, pep.name, pep.id, None)
    n = restamp_native_slot_rows(db, parent=parent, slot=slot, res=res)
    db.add(LimsSubSampleEvent(lims_sample_pk=parent.id, event="native_slot_relabeled",
                              details={"slot": slot, "old_peptide_id": old_pid, "new_peptide_id": pep.id,
                                       "old_name": old.get("name"), "new_name": pep.name,
                                       "restamped": n, "reason": reason}, user_id=user_id))
    if commit:
        db.commit()
    return {"slot": slot, "old_peptide_id": old_pid, "new_peptide_id": pep.id, "restamped": n}
```

`sub_samples/service.py::_apply_senaite_fields_to_row` — in the `kind == "Peptide"` branch:

```python
            if kind == "Peptide":
                new_name = str(value).strip() if value else None
                old_name = (slots[idx].get("name") or "").strip()
                if (new_name or "").casefold() != old_name.casefold():
                    # Rename invalidates the stored peptide link (spec 2026-09-10
                    # M6 addendum): resolve_slot_peptides trusts a stored id first,
                    # so a stale id would re-seed the previous peptide.
                    slots[idx]["peptide_id"] = None
                slots[idx]["name"] = new_name
```

`main.py::s2s_mirror_lims_sample_fields` — after the `_apply_senaite_fields_to_row(...)` call, before the alias delete:

```python
    if row.external_lims_system == "mk1" and any(_ANALYTE_KEY_RE.match(k) for k in req.fields):
        # Native-born: the only rows that exist pre-receipt are per-slot ordered
        # placeholders — restamp them from the re-resolved slots so a customer
        # rename never leaves a stale peptide/title behind (spec M6 addendum).
        from lims_analyses.hplc_native import resolve_slot_peptides, restamp_native_slot_rows
        for res in resolve_slot_peptides(db, row):
            restamp_native_slot_rows(db, parent=row, slot=res.slot, res=res)
```
(`_ANALYTE_KEY_RE` lives in sub_samples/service.py — import it or re-declare with the identical pattern; prefer import.)

`main.py::replace_analyte` and `::clear_analyte` — first statement after loading the parent row (read where each resolves `sample_id` → `LimsSample`; if it only holds `senaite_uid`, look the row up by `sample_id` from the path):

```python
    if _row is not None and is_native_born(_row):
        raise HTTPException(409, detail={"code": "native_born_use_relabel",
                                         "message": "Native-born sample: use Relabel on the Analytes card"})
```

`schemas.py` + `routes.py`: request/response models; route:

```python
@router.post("/parent/{sample_id}/native-slots/{slot}/relabel", response_model=RelabelNativeSlotResponse)
def relabel_native_slot_route(sample_id: str, slot: int, req: RelabelNativeSlotRequest,
                              db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    from lims_analyses.hplc_native import relabel_native_slot, NativeSlotLockedError, NativeSlotNotFoundError
    parent = _load_parent_or_404(db, sample_id)
    try:
        out = relabel_native_slot(db, parent=parent, slot=slot, new_peptide_id=req.new_peptide_id,
                                  user_id=getattr(current_user, "id", None), reason=req.reason)
    except NativeSlotNotFoundError as e:
        raise HTTPException(404, detail={"code": e.code, "message": str(e)})
    except NativeSlotLockedError as e:
        raise HTTPException(409, detail={"code": e.code, "message": str(e)})
    return RelabelNativeSlotResponse(**out)
```

- [ ] **Step 4: Run** the new/extended tests + `tests/test_replace_analyte.py tests/test_clear_analyte.py tests/test_s2s_field_mirror.py tests/test_registry_signal.py tests/test_hplc_native_placeholders.py tests/test_hplc_native_module.py tests/test_analyte_slot_guards.py`.

- [ ] **Step 5: Commit** — `feat(hplc-native): relabel_native_slot + route; rename nulls peptide_id; native placeholders restamp on S2S edit; Replace/Clear 409 on native-born`.

---

### Task 5: Publish path skips the SENAITE AR lookup for native-born samples + `external_lims_system` on the registry read model

**Files:**
- Modify: `backend/main.py:13743-13760` (`publish_sample_coa` step 2)
- Modify: `backend/sub_samples/lookup_models.py:141` (`RegistrySampleReadResult.external_lims_system: Optional[str] = None`), `backend/sub_samples/registry_details.py:36-46` (populate `external_lims_system=row.external_lims_system`)
- Create: `backend/tests/test_hplc_native_publish_gate.py`; extend `backend/tests/test_registry_details*.py` (one assertion)

- [ ] **Step 1: Failing tests**

```python
# test_hplc_native_publish_gate.py — StaticPool TestClient copied from tests/test_native_promote.py
def test_publish_native_born_never_searches_senaite(client, db_session, monkeypatch):
    monkeypatch.setattr("main.SENAITE_URL", "http://senaite.invalid")
    # any SENAITE HTTP in this path must not happen:
    monkeypatch.setattr("main.requests.get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("SENAITE called")))
    ...  # native-born parent in a publishable state per publish_sample_coa's own preconditions (read 13718-13760)
    resp = client.post("/wizard/senaite/samples/P-1501/publish-coa")
    assert resp.status_code != 502
```
(Read the route: identify the smallest publishable fixture — the goal is only that the SENAITE search block is skipped; if the route's later steps need COABuilder, patch those the way the existing publish tests do — grep `publish-coa` in tests/.)

Registry details: assert `RegistrySampleReadResult(...).external_lims_system == "mk1"` for a native-born row through `read_registry_sample_details` (or whatever `registry_details.py:296-345` is named).

- [ ] **Step 3: Implement**

```python
    senaite_uid: str | None = None
    _native_born = (_registry_row.external_lims_system == "mk1") if _registry_row is not None else False
    if SENAITE_URL and not _native_born:
        ...existing search block unchanged...
```
(`_registry_row`: the route already loads the `LimsSample` somewhere before/after — reuse it; if it loads after this block, hoist a minimal `db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)).scalar_one_or_none()` above.)

- [ ] **Step 4: Run** new tests + `tests/test_publish*.py tests/test_after_publish*.py tests/test_registry_details*.py`.
- [ ] **Step 5: Commit** — `feat(hplc-native): publish skips SENAITE AR lookup on native-born; registry read exposes external_lims_system`.

---

### Task 6: Frontend — parent retest sends slot; Analytes card native mode with Relabel dialog

**Files:**
- Modify: `src/lib/api.ts:7193-7215` (`parentRetestAnalysis(sampleId, keyword, reason?, opts?: {analysis_service_id?: number; slot?: number | null})` → body includes them when present); add `relabelNativeSlot(sampleId, slot, newPeptideId, reason?)` POSTing `/api/lims-analyses/parent/${sampleId}/native-slots/${slot}/relabel`; add `external_lims_system?: string | null` to the sample-details type at `api.ts:~4179` (the interface holding `sample_uid`)
- Modify: `src/hooks/use-parent-retest-flow.ts:36-56` — keep per-target `{keyword, analysis_service_id, slot}` instead of keyword strings; `executeRetest` loops targets and passes the opts
- Modify: `src/components/senaite/SampleDetails.tsx:6172-6347` — when `data.external_lims_system === 'mk1'`: hide Replace/Clear buttons and the inline `EditableDataRow`s for `Analyte{slot}Peptide`; show a **Relabel** button per occupied slot → `RelabelNativeSlotDialog`
- Create: `src/components/senaite/RelabelNativeSlotDialog.tsx` — peptide select (reuse the peptide list hook/API the ReplaceAnalyteDialog uses — read `ReplaceAnalyteDialog.tsx:40-120` and reuse its data source), optional reason, confirm → `relabelNativeSlot`, toast, `onDone` to invalidate the sample-details query
- Tests: `src/test/relabel-native-slot-dialog.test.tsx` (renders peptides, posts the chosen id, surfaces 409 message), extend the retest-flow test (grep `use-parent-retest-flow` in `src/**/__tests__` / `src/test`) to assert the body carries `slot` when the target has one and omits it otherwise

- [ ] Steps: TDD as above; `npx vitest run <files>` + `npx tsc --noEmit -p tsconfig.json`; commit `feat(hplc-native): FE retest sends slot; Analytes card relabel for native-born`.

---

### Task 7: Gate, CHANGELOG, spec addenda, ledger

- Backend failure-set diff base (`C:\tmp\Accu-Mk1-hplc-slice3`) vs branch, same window; classify deltas with isolation runs; FE `npx vitest run` + tsc; bindparam guard.
- CHANGELOG (Unreleased): "HPLC native-born — slice 4 (M6)" block: slot-aware promote/supersession/retest/list/overlay/removal; relabel route; rename invalidates peptide_id; native placeholders restamp on customer edit; Replace/Clear 409 on native-born; publish skips SENAITE lookup on native-born; FE retest carries slot, Relabel dialog.
- Spec addenda (docs branch, pathspec commit): (1) relabel route path ruling; (2) "reject cascade from the SENAITE path (`main.py:19060`) stays keyword-only — it is legacy-only by construction"; (3) `_supersede_orphan_edges` finding from Task 3.
- Push/PR held for the controller (stacked on `feat/hplc-native-slice3`).

---

## Self-review

**Spec coverage (M6 line + addenda):** native identity rule `(analysis_service_id, COALESCE(slot,0))` → Task 1 (`_ident_clause`, `_find_active_parent_row`); parent row inherits `peptide_id/slot/title` → Task 1; list collapses / `manage_native._classify_vial_rows` / `delete_pristine_analysis` keyed `(service, slot)` → Tasks 2 + 3; slot-keyed placeholder suppression + vial-state overlay (addendum) → Task 2; `relabel_native_slot` + route + event + legacy Replace/Clear 409 → Task 4; `peptide_id` invalidation contract (addendum) → Task 4 (writer nulls on rename; restamp on S2S edit); publish path branch on `external_lims_system` → Task 5; FE → Task 6. Not in this slice (ledger): `_candidate_vial_keywords` legacy chain (dead for native by construction), `cancel_pending_rows` (whole-sample, already slot-agnostic), `force_retract_analysis` (row-id keyed).

**Placeholder scan:** the `...` sites are each an explicit "copy from file:lines" instruction (placeholder seeding shape, StaticPool client fixture, publish preconditions), never "TBD".

**Type consistency:** `slot_key/kw_slot_key/slot_clause` defined in Task 1, used in Tasks 2-3; `NativeSlotLockedError(msg, code=)` / `NativeSlotNotFoundError` defined and mapped in Task 4; `restamp_native_slot_rows(db, *, parent, slot, res)` used by relabel and by the S2S mirror; `ParentRetestRequest.slot` consumed by route → service → cascade → `_find_active_parent_row`; FE `parentRetestAnalysis` opts shape matches the request model.
