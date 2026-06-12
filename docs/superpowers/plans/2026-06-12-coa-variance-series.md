# COA Variance Results Series — Implementation Plan (Spec 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show every replicate of a variance analyte in its COA cell, comma-delimited — parent figure first, then `assignment_kind='variance'` vials by vial number — for purity, quantity, and identity, on both the PDF and digital COA. Reuses Spec 1's identity→N/A per figure.

**Architecture:** Mk1 ships raw per-vial replicate values in the `/process` body; COABuilder prepends its own parent figure (style 2), joins the series, and gates each figure by its own identity.

**Spec:** `docs/superpowers/specs/2026-06-12-coa-variance-series-design.md`

**Plan-time refinement of the spec's data shape:** the spec sketched three parallel lists (`{PURITY:[...], QUANTITY:[...], IDENTITY:[...]}`). That can misalign when a vial has one analyte but not another, breaking per-figure identity gating. This plan uses **per-vial records** instead — each list element is one variance vial carrying its own analyte values + identity, so gating is always self-consistent:

```json
{ "BPC-157": [
    {"vial_sequence": 2, "PURITY": "99.1%", "QUANTITY": "10.1 mg", "IDENTITY": "BPC-157"},
    {"vial_sequence": 3, "PURITY": "97.21%", "IDENTITY": "Out of Spec"}
] }
```

A row's series = parent figure, then each vial record that has that analyte, gated by the record's own IDENTITY.

**Worktrees:**
- Mk1: `C:/tmp/Accu-Mk1-subvial` (branch `subvial/continue`). Venv python: `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`.
- COABuilder: `C:/tmp/coabuilder-variance` (branch `feat/coa-identity-na-variance`, already has Spec 1). Test: `python tests/<file>`.

**Reuse:** `_category()` from `backend/lims_analyses/prep_bridge.py` maps keyword → purity/quantity/identity. `_LIVE_RESULT_STATES` in `backend/coa/source_resolver.py`.

---

### Task 1: Mk1 — variance replicate builder (TDD)

**Files:**
- Create: `backend/coa/variance_series.py`
- Test: `backend/tests/test_variance_series.py` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_variance_series.py`:

```python
"""build_variance_replicates: per-vial replicate records for the COA series.
Variance vials only (assignment_kind='variance'), vial_sequence order, each
record carrying its own PURITY/QUANTITY/IDENTITY (whatever it measured).
Parent NOT included (COABuilder prepends its own figure)."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from coa.variance_series import build_variance_replicates
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    Peptide,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _svc(db, keyword, peptide_id=None):
    svc = AnalysisService(title=keyword, keyword=keyword, peptide_id=peptide_id)
    db.add(svc)
    db.flush()
    return svc


def _row(db, sub, svc, value, state="variance_verified"):
    db.add(LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.keyword, result_value=value,
        result_unit="mg" if svc.keyword.startswith("QTY") else None,
        review_state=state, reportable=True,
    ))
    db.flush()


@pytest.fixture
def world(db):
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    pur = _svc(db, "PUR_BPC157", pep.id)
    qty = _svc(db, "QTY_BPC157", pep.id)
    idsvc = _svc(db, "ID_BPC157", pep.id)
    parent = LimsSample(sample_id="P-0500", external_lims_uid="uid-p0500", container_mode=True)
    db.add(parent)
    db.flush()
    # vial 1 = core (excluded); vials 2,3 = variance
    subs = {}
    for seq, kind in ((1, "core"), (2, "variance"), (3, "variance")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://v{seq}",
            sample_id=f"P-0500-S{seq:02d}", vial_sequence=seq,
            assignment_role="hplc", assignment_kind=kind,
        )
        db.add(sub); db.flush()
        subs[seq] = sub
    # vial 2: full set; vial 3: purity + identity only (no quantity)
    _row(db, subs[2], pur, "99.1"); _row(db, subs[2], qty, "10.1"); _row(db, subs[2], idsvc, "BPC-157")
    _row(db, subs[3], pur, "97.21"); _row(db, subs[3], idsvc, "Out of Spec")
    # core vial has a row — must be EXCLUDED
    _row(db, subs[1], pur, "50.0")
    db.commit()
    return parent


def test_variance_vials_only_in_sequence_order(world, db):
    out = build_variance_replicates(db, world)
    recs = out["BPC-157"]
    assert [r["vial_sequence"] for r in recs] == [2, 3]  # core vial 1 excluded


def test_per_vial_records_carry_their_analytes(world, db):
    recs = build_variance_replicates(db, world)["BPC-157"]
    v2, v3 = recs[0], recs[1]
    assert v2["PURITY"] == "99.1%" and v2["QUANTITY"] == "10.1 mg" and v2["IDENTITY"] == "BPC-157"
    assert v3["PURITY"] == "97.21%" and v3["IDENTITY"] == "Out of Spec"
    assert "QUANTITY" not in v3  # vial 3 had no quantity row


def test_empty_when_no_variance_vials(db):
    parent = LimsSample(sample_id="P-0600", external_lims_uid="uid-p0600")
    db.add(parent); db.commit()
    assert build_variance_replicates(db, parent) == {}
```

- [ ] **Step 2: Run — expect ImportError**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_variance_series.py -q
```
Expected: ImportError on `build_variance_replicates`.

- [ ] **Step 3: Implement the builder**

Create `backend/coa/variance_series.py`:

```python
"""Per-vial variance replicate records for the COA results series.

A variance order buys extra physical replicates. Each assignment_kind='variance'
sub-sample of the parent measures the same analytes; this returns one record per
variance vial (in vial_sequence order) carrying whatever it measured, keyed by
canonical peptide name. COABuilder prepends its own parent figure (style 2) and
renders the comma-delimited series, gating each figure by its own identity.

Shape: { peptide_name: [ {vial_sequence, PURITY?, QUANTITY?, IDENTITY?}, ... ] }
Values carry their unit (purity '%', quantity ' mg'); identity is the raw result.
A peptide with no variance figures is omitted.

See docs/superpowers/specs/2026-06-12-coa-variance-series-design.md.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.prep_bridge import _category
from models import AnalysisService, LimsAnalysis, LimsSubSample, Peptide

# Live result states + variance sign-off (mirrors source_resolver, plus the
# variance_verified terminal state replicates land in).
_SERIES_STATES = ("submitted", "to_be_verified", "verified", "published", "variance_verified")

_CATEGORY_TO_KEY = {"purity": "PURITY", "quantity": "QUANTITY", "identity": "IDENTITY"}


def _fmt(category: str, value: str, unit: Optional[str]) -> str:
    """Format a replicate value to match the single-cell COA convention."""
    v = (value or "").strip()
    if category == "purity":
        return v if v.endswith("%") else f"{v}%"
    if category == "quantity":
        u = (unit or "mg").strip()
        return f"{v} {u}" if u and not v.endswith(u) else v
    return v  # identity: raw


def build_variance_replicates(db: Session, parent) -> dict:
    """{peptide_name: [per-vial record, ...]} for the parent's variance vials."""
    subs = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.assignment_kind == "variance",
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    if not subs:
        return {}

    out: dict[str, list] = {}
    for sub in subs:
        rows = db.execute(
            select(LimsAnalysis, AnalysisService, Peptide)
            .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .outerjoin(Peptide, Peptide.id == AnalysisService.peptide_id)
            .where(
                LimsAnalysis.lims_sub_sample_pk == sub.id,
                LimsAnalysis.review_state.in_(_SERIES_STATES),
                LimsAnalysis.reportable == True,  # noqa: E712
                LimsAnalysis.retest_of_id.is_(None),
                LimsAnalysis.result_value.isnot(None),
                LimsAnalysis.result_value != "",
            )
        ).all()
        # Group this vial's rows by peptide → record.
        per_peptide: dict[str, dict] = {}
        for la, svc, pep in rows:
            category = _category(la.keyword)
            key = _CATEGORY_TO_KEY.get(category or "")
            if not key or pep is None:
                continue
            rec = per_peptide.setdefault(pep.name, {"vial_sequence": sub.vial_sequence})
            rec[key] = _fmt(category, la.result_value, la.result_unit)
        for pname, rec in per_peptide.items():
            # Only records that carry at least one analyte value.
            if len(rec) > 1:
                out.setdefault(pname, []).append(rec)
    # Drop peptides whose vials contributed nothing.
    return {k: v for k, v in out.items() if v}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_variance_series.py -q
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial && git add backend/coa/variance_series.py backend/tests/test_variance_series.py && git commit -m "feat(coa): per-vial variance replicate builder for the COA series"
```

---

### Task 2: Mk1 — wire replicates into generate-coa

**Files:**
- Modify: `backend/main.py` (alias_body assembly, ~L8906)

- [ ] **Step 1: Add the replicate enrichment**

In `generate_sample_coa`, replace the alias_body block (the `alias_body: dict = {}` through the `analyte_display_names` assignment, ~L8908-8911) with:

```python
    alias_body: dict = {}
    alias_map = _load_sample_aliases(db, sample_id)
    if alias_map:
        alias_body["analyte_display_names"] = {str(k): v for k, v in alias_map.items()}

    # Variance replicate series (parent's assignment_kind='variance' vials).
    # Raw per-vial values; COABuilder prepends its own parent figure and renders
    # the comma-delimited series. Best-effort — a builder error must not block
    # generation. Parents only (sub-sample COAs have no variance children).
    if not is_sub:
        try:
            from coa.variance_series import build_variance_replicates
            _parent_row = db.execute(
                select(LimsSample).where(LimsSample.sample_id == sample_id)
            ).scalar_one_or_none()
            if _parent_row is not None:
                _reps = build_variance_replicates(db, _parent_row)
                if _reps:
                    alias_body["variance_replicates"] = _reps
        except Exception:
            _logger.warning("variance replicate build failed for %s", sample_id, exc_info=True)
```

(`is_sub`, `_logger`, `select`, and `LimsSample` are already in scope in this function.)

- [ ] **Step 2: Syntax check**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -c "import ast; ast.parse(open('main.py',encoding='utf-8').read()); print('ok')"
```
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial && git add backend/main.py && git commit -m "feat(coa): pass variance replicates to COABuilder in the process body"
```

---

### Task 3: COABuilder — factor out identity matcher + accept the body field

**Files:**
- Modify: `src/coabuilder_core/conformance.py`, `src/coabuilder_core/senaite_client.py`, `scripts/server.py`
- Test: `tests/test_variance_series_render.py` (create, fails until Task 4)

- [ ] **Step 1: Factor the identity matcher to a module function**

In `src/coabuilder_core/conformance.py`, add near `_na_if_identity_fails`:

```python
def _identity_matches(id_result: str, peptide_name: str) -> bool:
    """True if an identity result conforms to the declared peptide. Mirrors the
    inline B.1 rule: explicit pass keywords, or a name-prefix match on a word
    boundary."""
    clean_res = (id_result or "").strip()
    clean_name = (peptide_name or "").strip()
    if clean_res.lower() in ["pass", "conforms", "positive", "compliant"]:
        return True
    if clean_name and clean_res.startswith(clean_name):
        suffix = clean_res[len(clean_name):]
        if not suffix or not suffix[0].isalnum():
            return True
    return False
```

Then in B.1, replace the inline `is_match` computation (the block from `is_match = False` through the boundary check, lines ~256-271) with:

```python
            id_res = id_analysis.get("Result") or "" if id_analysis else "NOT TESTED"
            is_match = _identity_matches(id_res, peptide_name)
```

Keep the existing `if id_analysis is None: is_match = False; id_res = "Not Tested"` guard immediately after. Run the Spec 1 test to confirm no behavior change:

```bash
cd C:/tmp/coabuilder-variance && python tests/test_identity_fail_na.py
```
Expected: 3 PASS (refactor is behavior-preserving).

- [ ] **Step 2: Thread `variance_replicates` through the server + client + engine signatures**

`scripts/server.py` — extend `ProcessSampleRequest` (after `analyte_display_names`):

```python
    variance_replicates: Optional[Dict[str, list]] = None
```

In `process_sample`, after building `display_name_overrides`, pass the raw dict straight through (no slot normalization needed):

```python
    variance_replicates = body.variance_replicates if body else None
```

and forward it:

```python
        data = client.fetch_sample_data(
            sample_id,
            display_name_overrides=display_name_overrides,
            variance_replicates=variance_replicates,
        )
```

`src/coabuilder_core/senaite_client.py` — `fetch_sample_data` signature gains
`variance_replicates: Optional[Dict[str, list]] = None`, forwarded only on the
peptide (ConformanceEngine) branch:

```python
            processed_data = engine.process(
                sample_json,
                display_name_overrides=display_name_overrides,
                variance_replicates=variance_replicates,
            )
```

(Leave the GenericAssayEngine branch unchanged — non-peptide matrices have no variance vials.)

`src/coabuilder_core/conformance.py` — `process(...)` signature gains
`variance_replicates: Optional[Dict[str, list]] = None`; store on a local for the
per-analyte loop: `reps = variance_replicates or {}`.

- [ ] **Step 3: Write the failing render test**

Create `tests/test_variance_series_render.py`:

```python
"""Variance series rendering: COABuilder prepends its own parent figure and
joins the per-vial replicates, gating each figure by its own identity."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from coabuilder_core.conformance import ConformanceEngine  # noqa: E402


def _json(identity="BPC-157", purity="98.25", qty="10.0"):
    return {
        "ClientSampleID": "CS-9", "id": "P-0500",
        "Analyte1Peptide": "BPC-157 - Identity (HPLC)",
        "_Analyses_Detailed": [
            {"Title": "BPC-157 - Identity (HPLC)", "getKeyword": "ANALYTE-1-ID",
             "Result": identity, "review_state": "verified"},
            {"getKeyword": "ANALYTE-1-PUR", "Result": purity, "review_state": "verified"},
            {"getKeyword": "PEPT-Total", "Result": qty, "Unit": "mg", "review_state": "verified"},
        ],
        "Analyses": [],
    }


def _reps(v3_identity="BPC-157"):
    return {"BPC-157": [
        {"vial_sequence": 2, "PURITY": "99.1%", "QUANTITY": "10.1 mg", "IDENTITY": "BPC-157"},
        {"vial_sequence": 3, "PURITY": "97.21%", "QUANTITY": "9.9 mg", "IDENTITY": v3_identity},
    ]}


def _row(table, tt):
    return next(r for r in table if r["test_type"] == tt and r.get("peptide_name") == "BPC-157")


class TestVarianceSeries(unittest.TestCase):
    def test_purity_series_parent_first(self):
        out = ConformanceEngine().process(_json(), variance_replicates=_reps())
        self.assertEqual(_row(out["results_table"], "PURITY")["result"], "98.25%, 99.1%, 97.21%")

    def test_quantity_series(self):
        out = ConformanceEngine().process(_json(), variance_replicates=_reps())
        self.assertEqual(_row(out["results_table"], "QUANTITY")["result"], "10.0 mg, 10.1 mg, 9.9 mg")

    def test_identity_series_shows_out_of_spec(self):
        out = ConformanceEngine().process(_json(), variance_replicates=_reps(v3_identity="Out of Spec"))
        self.assertEqual(_row(out["results_table"], "IDENTITY")["result"], "BPC-157, BPC-157, Out of Spec")

    def test_failing_vial_identity_na_for_its_purity_and_qty(self):
        out = ConformanceEngine().process(_json(), variance_replicates=_reps(v3_identity="Out of Spec"))
        self.assertEqual(_row(out["results_table"], "PURITY")["result"], "98.25%, 99.1%, N/A")
        self.assertEqual(_row(out["results_table"], "QUANTITY")["result"], "10.0 mg, 10.1 mg, N/A")

    def test_no_replicates_unchanged(self):
        out = ConformanceEngine().process(_json())
        self.assertEqual(_row(out["results_table"], "PURITY")["result"], "98.25%")

    def test_status_is_parent_driven(self):
        out = ConformanceEngine().process(_json(purity="99.0"), variance_replicates=_reps())
        # parent purity 99.0 conforms → status CONFORMS regardless of vial values
        self.assertEqual(_row(out["results_table"], "PURITY")["status"], "CONFORMS")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 4: Run — expect render tests to fail (series not applied yet)**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_variance_series_render.py
```
Expected: failures (purity shows "98.25%" not the joined series). The refactor test (`test_identity_fail_na.py`) still passes.

- [ ] **Step 5: Commit the plumbing (red render test allowed — series logic lands next task)**

```bash
cd C:/tmp/coabuilder-variance && git add src/coabuilder_core/conformance.py src/coabuilder_core/senaite_client.py scripts/server.py tests/test_variance_series_render.py && git commit -m "refactor(coa): extract identity matcher; thread variance_replicates through"
```

---

### Task 4: COABuilder — render the series with per-figure N/A

**Files:**
- Modify: `src/coabuilder_core/conformance.py`

- [ ] **Step 1: Add the series helper**

In `conformance.py`, after `_identity_matches`, add:

```python
def _variance_series(primary_value, primary_is_match, peptide_name, test_type, reps):
    """Build the comma-joined cell for a variance analyte, or None when there are
    no replicates. test_type in {'PURITY','QUANTITY','IDENTITY'}. The parent
    figure (already computed by the engine) is index 0; each variance vial record
    follows. For purity/quantity, a figure whose identity fails renders 'N/A'
    (parent via primary_is_match, vial via its own IDENTITY). Identity series
    shows each figure's display value verbatim."""
    records = (reps or {}).get(peptide_name)
    if not records:
        return None
    figs = []
    # Parent figure (index 0)
    if test_type == "IDENTITY":
        figs.append(primary_value)
    else:
        figs.append("N/A" if not primary_is_match else primary_value)
    # Vial figures
    for rec in records:
        val = rec.get(test_type)
        if val is None:
            continue
        if test_type == "IDENTITY":
            figs.append(val)
        else:
            vial_ok = _identity_matches(rec.get("IDENTITY", ""), peptide_name)
            figs.append("N/A" if not vial_ok else val)
    return ", ".join(str(f) for f in figs)
```

- [ ] **Step 2: Apply to identity, quantity, purity rows**

`reps = variance_replicates or {}` is set at the top of `process` (Task 3). In the per-analyte loop, after each row dict is built but before/at append, override `result` when a series exists.

Identity (B.1) — after the identity row is appended, the displayed primary value is `id_val`. Replace the identity `results_table.append({... "result": id_val ...})` so the result becomes the series when present:

```python
            _id_series = _variance_series(id_val, is_match, peptide_name, "IDENTITY", reps)
            results_table.append({
                "test_name": f"{display_name} - Identity",
                "analyte_name": display_name,
                "peptide_name": peptide_name,
                "test_type": "IDENTITY",
                "specification": display_name,
                "result": _id_series if _id_series is not None else id_val,
                "status": id_status,
                "conforms": is_match,
                "status_color": status_color,
                "unit": ""
            })
```

Quantity (B.2) — the primary value is `qty_res_str` (already N/A-gated by Spec 1's `_na_if_identity_fails`, but the series needs the *un-gated* primary so index 0 follows the series' own gating). Compute the series from the raw `qty_res_str` and `is_match`, and override `result` after the Spec-1 wrapper:

```python
            _qty_row = _na_if_identity_fails({
                "test_name": f"{display_name} - Quantity",
                "analyte_name": display_name,
                "peptide_name": peptide_name,
                "test_type": "QUANTITY",
                "specification": "MEASURE",
                "result": qty_res_str,
                "status": "MEASURED",
                "conforms": None,
                "status_color": "",
                "unit": meas_qty_data["unit"] if meas_qty_data else "",
                "delta_pct": ""
            }, is_match)
            _qty_series = _variance_series(qty_res_str, is_match, peptide_name, "QUANTITY", reps)
            if _qty_series is not None:
                _qty_row["result"] = _qty_series
            results_table.append(_qty_row)
```

Purity (B.3) — same pattern, primary value is `f"{p_val}%" if p_val is not None else ""`:

```python
                _pur_primary = f"{p_val}%" if p_val is not None else ""
                _pur_row = _na_if_identity_fails({
                    "test_name": f"{display_name} - Purity",
                    "analyte_name": display_name,
                    "peptide_name": peptide_name,
                    "test_type": "PURITY",
                    "specification": p_spec_str,
                    "result": _pur_primary,
                    "status": p_status,
                    "conforms": p_conforms,
                    "status_color": p_status_color,
                    "unit": "%"
                }, is_match)
                _pur_series = _variance_series(_pur_primary, is_match, peptide_name, "PURITY", reps)
                if _pur_series is not None:
                    _pur_row["result"] = _pur_series
                results_table.append(_pur_row)
```

(Replace the existing quantity/purity `results_table.append(_na_if_identity_fails({...}, is_match))` calls from Spec 1 with these expanded forms. Status/conforms/color stay parent-driven — only `result` changes.)

- [ ] **Step 3: Run the render tests — expect pass**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_variance_series_render.py
```
Expected: 6 PASS.

- [ ] **Step 4: Full regression**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_identity_fail_na.py && python tests/test_variance_series_render.py && python tests/test_addon_parsing.py
```
Expected: all OK (identity-fail 3, variance 6, addon 5).

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/coabuilder-variance && git add src/coabuilder_core/conformance.py && git commit -m "feat(coa): render variance result series with per-figure identity N/A"
```

---

### Task 5: COABuilder — version bump + changelog

**Files:**
- Modify: `src/coabuilder_core/__init__.py`, `CHANGELOG.md`

- [ ] **Step 1: Bump** `2.15.0` → `2.16.0` in `src/coabuilder_core/__init__.py`.

- [ ] **Step 2: Changelog** — prepend under the title:

```markdown
## [2.16.0] - 2026-06-12

### Added

- **Variance results series.** Purity, quantity, and identity cells now show every
  replicate of a variance analyte, comma-delimited — the parent figure first, then
  each `assignment_kind='variance'` vial by vial number (e.g. `98.25%, 99.1%,
  97.21%`). Mk1 supplies raw per-vial values in the `/process` body
  (`variance_replicates`); COABuilder prepends its own parent figure and gates each
  figure by its own identity (a vial whose identity fails shows `N/A` for its
  purity/quantity). Status/conformance stay parent-driven. Both PDF and digital COA
  inherit it. Test-first via `tests/test_variance_series_render.py`.

---
```

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/coabuilder-variance && git add src/coabuilder_core/__init__.py CHANGELOG.md && git commit -m "chore(coa): bump 2.16.0 — variance results series"
```

---

### Task 6: Verification + UAT handoff

- [ ] **Step 1: Confirm both backends import clean** (Mk1 syntax already checked; COABuilder engine imported by tests).

- [ ] **Step 2: Cross-surface note.** Series lands in `AnalysisResult.result` → `_build_coa_data_json` serializes verbatim → wpstar renders `value`. No new wpstar work (Spec 1's N/A badge already covers the `N/A` positions). Confirm by reading `scripts/server.py:_result_to_dict` (result copied as-is).

- [ ] **Step 3: Hand the Handler a live UAT (post-deploy of Mk1 + COABuilder 2.16.0):**
  1. A parent with ≥1 `variance` vial that has verified replicate results.
  2. Generate its COA. Purity/quantity/identity cells show `parent, vial2, vial3…` joined, parent first.
  3. A variance vial whose identity failed → its purity/quantity position reads `N/A`; identity series shows `… , Out of Spec`.
  4. The status badge still reflects the parent figure only.
  5. Verify page shows the same joined strings (+ grey N/A badge where applicable).
  6. A non-variance sample is unchanged.

---

## Self-review

- Spec coverage: builder (T1), generate-coa wiring (T2), body plumbing + matcher refactor (T3), series render + per-figure N/A (T4), version (T5), verification (T6).
- Plan-time refinement (per-vial records) documented in header; resolves the parallel-list alignment flaw.
- Types: `build_variance_replicates(db, parent) -> dict`; `_variance_series(primary_value, primary_is_match, peptide_name, test_type, reps)`; `_identity_matches(id_result, peptide_name) -> bool`. Consistent across tasks.
- Reuses Spec 1's `_na_if_identity_fails` + `_NA_COLOR`; status/conforms stay parent-driven (decision 4).
