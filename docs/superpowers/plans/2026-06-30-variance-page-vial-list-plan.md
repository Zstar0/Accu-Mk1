# Variance COA page 3 — list actual sub-vials — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The peptide Variance COA's per-vial page lists every sub-vial in the locked variance set by its real vial number, instead of synthesizing a parent row only when `vial_sequence` 1 is free (which loses a row when a variance vial sits at seq 1 — the P-1094 bug).

**Architecture:** Make the physical sub-vials the single source of truth. Mk1 sends **all in-set sub-vials** (core + variance, `promoted` state included) **only for variance samples**; COA Builder renders one row per sub-vial (no synthetic-parent prepend) and computes the page-1 mean from those same vials (no parent figure prepended, so the now-included core isn't double-counted). Because the parent figure equals a promoted sub-vial's value, every currently-correct cert renders byte-identical; only the inverted shape (P-1094) changes.

**Tech Stack:** Mk1 backend — Python 3.12, SQLAlchemy, pytest (in-memory SQLite fixtures). COA Builder — Python, pytest. Two repos, coordinated release.

## Global Constraints

- **Scope: HPLC peptide Variance COAs only.** BW per-vial listing is a separate spec (parked). Do not touch `generic_assay_engine.py` / `build_variance_analyte_series` in this plan.
- **Regression bar (non-negotiable):** byte-identical rendered output for every currently-correct variance cert (P-1096 and the existing fixtures). Only P-1094's shape changes.
- **Variance-sample gate:** the new Mk1 payload is emitted **only when the sample has ≥1 in-set `assignment_kind='variance'` sub-vial.** Non-variance samples send `{}` exactly as today — they must not enter any variance code path.
- **No SENAITE writes. No data edits to P-1094.** Fix renderer → regenerate.
- **Coordinated deploy:** COA Builder and Mk1 ship together. Old renderer + new payload double-counts the core; new renderer + old payload re-breaks P-1094.
- **Repos:** Mk1 worktree `Accu-Mk1/` (branch `feat/variance-vial-list-coa`); COA Builder `coabuilder/` (branch off `master`/2.28.1). Build + verify on an isolated accumark-stack dev stack.

## File Structure

| File | Repo | Responsibility | Change |
|---|---|---|---|
| `backend/coa/variance_series.py` | Mk1 | builds `variance_replicates` payload | `build_variance_replicates`: gate on variance-sample, include all in-set subs + `promoted` state |
| `backend/tests/test_variance_series.py` | Mk1 | unit tests for the builder | update old-contract tests; add gate + inverted-shape tests |
| `src/coabuilder_core/variance_matrix.py` | COA Builder | per-vial page-3 table | remove the synthetic-parent prepend |
| `tests/test_variance_matrix.py` | COA Builder | matrix unit tests | update prepend test; add seq-1-variance test |
| `src/coabuilder_core/conformance.py` | COA Builder | page-1 mean/values | drop parent-figure prepend in the 3 `_vals` builders (+ blend path) |
| `tests/test_variance_*` | COA Builder | conformance variance tests | update to no-parent-prepend expectations |
| `scripts/scan_parent_only_variance.py` | Mk1 (new) | pre-ship prod scan | enumerate parent-only-figure variance samples |

---

### Task 1: COA Builder — remove the synthetic-parent prepend in `build_vial_matrix`

**Files:**
- Modify: `coabuilder/src/coabuilder_core/variance_matrix.py:140-172` (delete the prepend block)
- Test: `coabuilder/tests/test_variance_matrix.py`

**Interfaces:**
- Consumes: `build_vial_matrix(variance_replicates: dict, variance_report: dict) -> dict` (unchanged signature). With the new payload, `variance_replicates[analyte]` records now include the **core** sub-vial too (so its `vial_sequence` is present).
- Produces: `{"analytes": [...], "rows": [{"vial": int, "cells": {...}}, ...], "analyte_labels": {...}}` — one row per distinct `vial_sequence` in the payload, **no synthesized Vial 1**.

- [ ] **Step 1: Write the failing test** — a variance vial at seq 1 + core at seq 2 must yield exactly two rows (1 and 2), no synthesized parent.

```python
# add to coabuilder/tests/test_variance_matrix.py
def test_no_synthetic_parent_row_when_seq1_present():
    # P-1094 shape: variance vial at seq 1, core at seq 2 — both real rows, no prepend.
    vr = {"GHK-Cu": [
        {"vial_sequence": 1, "IDENTITY": "GHK-Cu", "QUANTITY": "103.87 mg", "PURITY": "99.73%"},
        {"vial_sequence": 2, "IDENTITY": "GHK-Cu", "QUANTITY": "99.38 mg", "PURITY": "99.965%"},
    ]}
    report = {"tests": [{"key": "purity-GHK-Cu", "name": "GHK-Cu Purity",
                         "spec_min": 98.0, "spec_max": None, "values": ["99.73", "99.965"]}]}
    m = build_vial_matrix(vr, report)
    assert [r["vial"] for r in m["rows"]] == [1, 2]
    assert m["rows"][0]["cells"]["GHK-Cu"]["purity"] == "99.73%"
    assert m["rows"][1]["cells"]["GHK-Cu"]["purity"] == "99.965%"
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd coabuilder && python -m pytest tests/test_variance_matrix.py::test_no_synthetic_parent_row_when_seq1_present -v`
Expected: PASS for `[1, 2]` length (seqs already {1,2}) BUT the existing prepend is inert here (1 in seqs). To force a real RED, also assert the **count is unaffected by report values**; then run the existing-suite check in Step 4. (If it already passes, the prepend is simply dead code for this input — proceed; the meaningful RED is the test updated in Step 3.)

- [ ] **Step 3: Update the existing prepend test to the new contract, then delete the prepend block**

The existing `test_variance_matrix.py` has `test_vial1_prepended_from_parent_figure` (asserts a synthesized Vial 1 when seqs are {2,3}). Under the new contract the caller always supplies the core vial, so this synthesis is removed. Replace that test with:

```python
def test_seq2_3_only_renders_two_rows_no_parent_synthesis():
    # New contract: caller supplies every vial. Seqs {2,3} -> exactly rows 2 and 3.
    vr = {"BPC-157": [
        {"vial_sequence": 2, "IDENTITY": "BPC-157", "QUANTITY": "2 mg", "PURITY": "97%"},
        {"vial_sequence": 3, "IDENTITY": "BPC-157", "QUANTITY": "3 mg", "PURITY": "96%"},
    ]}
    report = {"tests": [{"key": "purity-BPC-157", "name": "BPC-157 Purity",
                         "spec_min": 98.0, "spec_max": None, "values": ["99", "97", "96"]}]}
    m = build_vial_matrix(vr, report)
    assert [r["vial"] for r in m["rows"]] == [2, 3]   # was [1, 2, 3] under old prepend
```

Then delete lines 140-172 of `variance_matrix.py` (the entire `if analytes and 1 not in seqs:` block) and the now-unused `_parent_value` helper (lines 60-79). Final `build_vial_matrix` ends:

```python
        rows.append({"vial": seq, "cells": cells})

    return {"analytes": analytes, "rows": rows, "analyte_labels": analyte_labels}
```

- [ ] **Step 4: Run the matrix suite**

Run: `cd coabuilder && python -m pytest tests/test_variance_matrix.py -v`
Expected: PASS (new tests green; the replaced prepend test gone).

- [ ] **Step 5: Commit**

```bash
git add src/coabuilder_core/variance_matrix.py tests/test_variance_matrix.py
git commit -m "fix(coa): page-3 lists supplied vials, drop synthetic-parent prepend"
```

---

### Task 2: COA Builder — compute page-1 variance mean/values from reps only (no parent prepend)

**Files:**
- Modify: `coabuilder/src/coabuilder_core/conformance.py` — purity builder (~593-602), quantity builder (~511-520), identity builder (~457-460), and the blend variance series (~329-341)
- Test: `coabuilder/tests/test_variance_report.py`, `tests/test_variance_series_render.py`, `tests/test_variance_blend_render.py`

**Interfaces:**
- Consumes: `reps = variance_replicates` where, with the new payload, the **core sub-vial is now an entry** (it was previously omitted).
- Produces: `variance_report.tests[].values` = the per-vial figures **with no parent figure prepended**; the certified mean (`_certified_purity` / `_certified_qty`) and the stat line are computed over those reps.

- [ ] **Step 1: Write the failing test** — the mean/values come from reps alone; the parent's primary figure is NOT added on top.

```python
# add to coabuilder/tests/test_variance_report.py (mirror its existing ConformanceEngine setup)
def test_variance_values_are_reps_only_no_parent_prepend():
    # reps already include the core vial; the engine must NOT also prepend the
    # parent primary figure (that would double-count the core).
    # Build the minimal ConformanceEngine inputs this module already uses, with:
    #   parent primary purity = 99.965 (== the core vial), reps = [99.73, 99.965]
    # Expect variance_report purity test: values == [99.73, 99.965] (len 2), mean 99.85.
    out = _run_engine_single_peptide(
        peptide="GHK-Cu", parent_purity="99.965",
        reps=[{"vial_sequence": 1, "IDENTITY": "GHK-Cu", "PURITY": "99.73%"},
              {"vial_sequence": 2, "IDENTITY": "GHK-Cu", "PURITY": "99.965%"}],
    )
    test = next(t for t in out["variance_report"]["tests"] if t["key"] == "purity-GHK-Cu")
    assert test["values"] == [99.73, 99.965]      # reps only — NOT [99.965, 99.73, 99.965]
    assert "mean 99.85" in out["results"]["purity"]["result"] if isinstance(out["results"], dict) else True
```

> If `test_variance_report.py` has no `_run_engine_single_peptide` helper, reuse the construction already present in that file's existing tests (same `ConformanceEngine().process(...)` call) — copy its setup inline rather than inventing a new harness.

- [ ] **Step 2: Run it — verify it fails**

Run: `cd coabuilder && python -m pytest tests/test_variance_report.py::test_variance_values_are_reps_only_no_parent_prepend -v`
Expected: FAIL — `values == [99.965, 99.73, 99.965]` (parent prepended + both reps → core double-counted).

- [ ] **Step 3: Remove the parent-figure prepend in the three single-peptide builders**

Purity (~593-602) — delete the `if is_match: _pp = _num(_pur_primary) ...` prepend so `_vals` starts empty:

```python
                    _vals = []
                    for r in reps[peptide_name]:
                        if _identity_matches(r.get("IDENTITY", ""), peptide_name):
                            _pv = _num(r.get("PURITY"))
                            if _pv is not None:
                                _vals.append(_pv)
```

Quantity (~511-520) — same, drop the `if is_match: _pq = _num(qty_res_str) ...`:

```python
                _q_vals = []
                for r in reps[peptide_name]:
                    if _identity_matches(r.get("IDENTITY", ""), peptide_name):
                        _qv = _num(r.get("QUANTITY"))
                        if _qv is not None:
                            _q_vals.append(_qv)
```

Identity (~457-460) — drop the `[id_val] +` / `[is_match] +` prepend:

```python
                _vr_id_recs = [r for r in reps[peptide_name] if "IDENTITY" in r]
                _vr_id_vals = [r.get("IDENTITY") for r in _vr_id_recs]
                _vr_id_verdicts = [_identity_matches(r.get("IDENTITY", ""), peptide_name) for r in _vr_id_recs]
                _match_count = sum(1 for v in _vr_id_verdicts if v)
                _total = len(_vr_id_verdicts)
```

Leave `_pur_primary`, `qty_res_str`, `id_val` computations intact (still used by the non-variance result row and the Core COA path) — only their prepend into the series is removed.

- [ ] **Step 4: Apply the same removal to the blend variance series (~329-341)**

The blend purity series (`_bp_series` / `_bt_series`) is built "over parent + per-vial values." Remove the parent term so it is reps-only, identical in spirit to the single-peptide change above. Use the blend regression fixture (Step 6 / Task 4) as the gate — a blend variance cert must render byte-identical. If after the edit `tests/test_variance_blend_render.py` diverges in value, the parent term was still present; remove it.

- [ ] **Step 5: Run the conformance variance suites**

Run: `cd coabuilder && python -m pytest tests/test_variance_report.py tests/test_variance_series_render.py tests/test_variance_blend_render.py tests/test_variance_stats_render.py -v`
Expected: the new test passes; existing tests that asserted a parent-prepended `values[0]` are updated to reps-only (update their expected `values` lists to drop the leading parent figure — the mean/verdict assertions stay identical because the value *set* is unchanged for those fixtures).

- [ ] **Step 6: Commit**

```bash
git add src/coabuilder_core/conformance.py tests/
git commit -m "fix(coa): variance mean/values from supplied reps, no parent prepend"
```

---

### Task 3: Mk1 — `build_variance_replicates` sends all in-set sub-vials for variance samples

**Files:**
- Modify: `Accu-Mk1/backend/coa/variance_series.py:91-155` (`build_variance_replicates`)
- Test: `Accu-Mk1/backend/tests/test_variance_series.py`

**Interfaces:**
- Consumes: `build_variance_replicates(db: Session, parent) -> dict`.
- Produces: `{peptide_name: [ {vial_sequence, PURITY?, QUANTITY?, IDENTITY?}, ... ]}` — now including the **core** sub-vial (and its `promoted`-state results), in `vial_sequence` order, **only when the sample has ≥1 in-set variance vial**; otherwise `{}`.

- [ ] **Step 1: Write the failing tests** — gate + core-inclusion + P-1094 inverted shape.

```python
# add to Accu-Mk1/backend/tests/test_variance_series.py
def test_core_vial_included_with_promoted_state(db):
    """New contract: a variance sample's CORE vial (promoted state) is included
    as a row, alongside the variance vials, in vial_sequence order."""
    pep = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True)
    db.add(pep); db.flush()
    pur = _svc(db, "HPLC-PUR"); idsvc = _svc(db, "ID_GHKCU", pep.id)
    parent = LimsSample(sample_id="P-1094", external_lims_uid="uid-p1094", container_mode=False)
    db.add(parent); db.flush()
    # P-1094 inverted: S01 = variance (seq1), S02 = core/promoted (seq2)
    s1 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://a",
                       sample_id="P-1094-S01", vial_sequence=1,
                       assignment_role="hplc", assignment_kind="variance")
    s2 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://b",
                       sample_id="P-1094-S02", vial_sequence=2,
                       assignment_role="hplc", assignment_kind="core")
    db.add_all([s1, s2]); db.flush()
    _row(db, s1, pur, "99.73", state="variance_verified"); _row(db, s1, idsvc, "GHK-Cu", state="variance_verified")
    _row(db, s2, pur, "99.965", state="promoted");          _row(db, s2, idsvc, "GHK-Cu", state="promoted")
    db.commit()
    recs = build_variance_replicates(db, parent)["GHK-Cu"]
    assert [r["vial_sequence"] for r in recs] == [1, 2]      # core (seq2) now included
    assert recs[0]["PURITY"] == "99.73%" and recs[1]["PURITY"] == "99.965%"

def test_non_variance_sample_sends_nothing(db):
    """A sample with only CORE vials (no variance) must still return {} — the
    variance path must never fire for non-variance certs."""
    pep = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True)
    db.add(pep); db.flush()
    pur = _svc(db, "HPLC-PUR")
    parent = LimsSample(sample_id="P-2000", external_lims_uid="uid-p2000", container_mode=True)
    db.add(parent); db.flush()
    s1 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://c",
                       sample_id="P-2000-S01", vial_sequence=1,
                       assignment_role="hplc", assignment_kind="core")
    db.add(s1); db.flush()
    _row(db, s1, pur, "99.0", state="promoted")
    db.commit()
    assert build_variance_replicates(db, parent) == {}
```

- [ ] **Step 2: Run them — verify they fail**

Run: `cd Accu-Mk1/backend && python -m pytest tests/test_variance_series.py::test_core_vial_included_with_promoted_state tests/test_variance_series.py::test_non_variance_sample_sends_nothing -v`
Expected: FAIL — core excluded (current filter is `assignment_kind=='variance'` and omits `promoted`).

- [ ] **Step 3: Implement the gate + include-all-in-set + promoted state**

Replace the sub-vial query and add `promoted` to the accepted states in `build_variance_replicates`:

```python
    # Variance sample = has >=1 in-set variance vial. Then list ALL in-set subs
    # (core + variance) so each physical vial is its own row; the parent record
    # is never a row (its figure is a promoted copy of one of these vials).
    subs = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.parent_sample_pk == parent.id,
            LimsSubSample.in_variance_set.is_(True),
        ).order_by(LimsSubSample.vial_sequence)
    ).scalars().all()
    if not any(s.assignment_kind == "variance" for s in subs):
        return {}
```

And widen the per-analysis review-state filter (the core's rows are `promoted`):

```python
                LimsAnalysis.review_state.in_(_VIAL_COA_STATES),  # _SERIES_STATES + 'promoted'
```

(`_VIAL_COA_STATES` already exists in the module = `_SERIES_STATES + ("promoted",)`.)

- [ ] **Step 4: Update the existing old-contract tests**

`test_variance_vials_only_in_sequence_order` (world fixture, core seq1 has a `variance_verified` purity row) now includes the core → expectation `[2, 3]` becomes `[1, 2, 3]`; update its docstring/comment ("core vial has a row — must be EXCLUDED" → "core vial included as Vial 1"). `test_per_vial_records_carry_their_analytes` indexes `recs[0], recs[1]` for vials 2,3 → shift to `recs[1], recs[2]`. `test_generic_services_attach_purity_quantity_to_vial_peptide` (prod_world: core seq1 has **no** rows) stays `[2, 3]` (empty core record is dropped). `test_deselected_vial_excluded`, `test_empty_when_no_variance_vials`, `test_retested_vial_uses_current_result_not_superseded_original` are unchanged.

- [ ] **Step 5: Run the full builder suite**

Run: `cd Accu-Mk1/backend && python -m pytest tests/test_variance_series.py -v`
Expected: PASS (new + updated tests green).

- [ ] **Step 6: Commit**

```bash
git add backend/coa/variance_series.py backend/tests/test_variance_series.py
git commit -m "fix(mk1): variance series includes core sub-vial, gated on variance sample"
```

---

### Task 4: Integration regression on a dev stack — byte-identical for correct certs, P-1094 fixed

**Files:** none (verification task). Uses an accumark-stack dev stack with both repos at the feature branches.

**Interfaces:** consumes the deployed dev-stack COA Builder + Mk1; produces a before/after PDF diff and the P-1094 render.

- [ ] **Step 1:** Spin up an isolated accumark-stack dev stack (see `accumark-stack-platform` skill), with COA Builder on the Task 1/2 branch and Mk1 on the Task 3 branch.
- [ ] **Step 2:** Regenerate a batch of existing **correct** variance certs (e.g. P-1096 + 5–10 BW-free peptide variance samples from the golden data). Capture each rendered PDF (or the `coa_data` `variance_report` + `results` + page-3 matrix).
- [ ] **Step 3:** Diff against the pre-change render of the same samples. **Expected: identical** value sets, means, verdicts, and row counts. Investigate ANY divergence before proceeding — a real divergence on a correct cert is a stop-ship.
- [ ] **Step 4:** Regenerate **P-1094**. Expected: page-3 shows **2 rows** (Vial 1 = 99.73, Vial 2 = 99.965), page-1 mean **99.85%**, headline still 99.965%.
- [ ] **Step 5:** Record results in the plan; no commit (verification only).

---

### Task 5: Pre-ship prod scan — find parent-only-figure variance samples

**Files:**
- Create: `Accu-Mk1/scripts/scan_parent_only_variance.py`

**Interfaces:** read-only DB scan; prints any variance sample whose parent carries an HPLC analyte figure (purity/quantity/identity) that **no in-set sub-vial covers** — the only shape that "ignore the parent" would drop.

- [ ] **Step 1: Write the scan** (read-only; runs in the prod backend container via the `MK1_DB_*` env, like the diagnostic probes used in this investigation).

```python
# Accu-Mk1/scripts/scan_parent_only_variance.py
import os, psycopg2
HPLC_KW = ("HPLC-PUR", "PEPT-Total")  # + ID_* identity, matched by prefix below
conn = psycopg2.connect(host=os.environ["MK1_DB_HOST"], port=os.environ.get("MK1_DB_PORT","5432"),
    dbname=os.environ.get("MK1_DB_NAME","accumark_mk1"), user=os.environ["MK1_DB_USER"],
    password=os.environ["MK1_DB_PASSWORD"])
cur = conn.cursor()
# variance samples = parents with >=1 in-set variance sub-vial
cur.execute("""
  SELECT DISTINCT p.id, p.sample_id FROM lims_samples p
  JOIN lims_sub_samples ss ON ss.parent_sample_pk = p.id
  WHERE ss.in_variance_set = TRUE AND ss.assignment_kind = 'variance'
""")
flagged = []
for pid, sid in cur.fetchall():
    # parent HPLC analyte categories with a current reportable figure
    cur.execute("""
      SELECT DISTINCT a.keyword FROM lims_analyses a
      WHERE a.lims_sample_pk=%s AND a.retested=FALSE AND a.reportable=TRUE
        AND a.result_value IS NOT NULL AND a.result_value <> ''
        AND a.review_state IN ('submitted','to_be_verified','verified','published','variance_verified','promoted')
        AND (a.keyword IN %s OR a.keyword LIKE 'ID\\_%%' OR a.keyword LIKE 'PUR\\_%%' OR a.keyword LIKE 'QTY\\_%%')
    """, (pid, HPLC_KW))
    parent_kw = {r[0] for r in cur.fetchall()}
    # in-set sub-vial HPLC categories with a current reportable figure
    cur.execute("""
      SELECT DISTINCT a.keyword FROM lims_analyses a
      JOIN lims_sub_samples ss ON ss.id = a.lims_sub_sample_pk
      WHERE ss.parent_sample_pk=%s AND ss.in_variance_set=TRUE
        AND a.retested=FALSE AND a.reportable=TRUE AND a.result_value IS NOT NULL AND a.result_value <> ''
        AND a.review_state IN ('submitted','to_be_verified','verified','published','variance_verified','promoted')
    """, (pid,))
    sub_kw = {r[0] for r in cur.fetchall()}
    uncovered = parent_kw - sub_kw
    if uncovered:
        flagged.append((sid, sorted(uncovered)))
print(f"variance samples scanned; {len(flagged)} with parent-only figures:")
for sid, kws in flagged:
    print(f"  {sid}: {kws}")
```

- [ ] **Step 2: Run it against prod** (read-only) and hand the list to the lab. Any flagged sample → manager adds + populates the missing sub-vial **before** that cert is regenerated. Expected: short or empty.
- [ ] **Step 3: Commit the script.**

```bash
git add scripts/scan_parent_only_variance.py
git commit -m "chore(mk1): scan for parent-only-figure variance samples"
```

---

### Task 6 (OPTIONAL — confirm with Handler): Mk1 fail-loud guard

Per the spec, a cheap backstop so a *future* missed legacy sample logs instead of silently dropping a value. **Location moved from COA Builder to Mk1** (deviation from spec §"safety net"): after the change, COA Builder no longer receives the parent figure separately, but Mk1 has both the parent analyses and the sub-vials. The pre-ship scan + workflow rule are the primary safety; this is belt-and-suspenders. Skip if the Handler declines.

**Files:** Modify `Accu-Mk1/backend/coa/variance_series.py` (`process_variance_fields`).

- [ ] **Step 1:** In `process_variance_fields`, after building the series, run the same parent-vs-sub-vial coverage check as the scan (in-process) and `log.warning("variance.parent_only_figure sample=%s keywords=%s", parent.sample_id, uncovered)` if any uncovered parent figure exists. No payload change, no raise.
- [ ] **Step 2:** Unit test: a fixture with a parent purity row but no sub-vial purity logs the warning (assert via `caplog`).
- [ ] **Step 3:** Commit.

---

## Self-Review

**Spec coverage:** model (Tasks 1+3) ✓; contract change Mk1 (Task 3) + COA Builder render (Task 1) + mean (Task 2) ✓; regression bar (Task 4) ✓; invariant + scan (Task 5) ✓; fail-loud guard (Task 6, location deviation noted) ✓; scope peptide-only (Global Constraints) ✓; coordinated deploy (Global Constraints) ✓; ISO 17025 alignment — satisfied operationally by Task 4 validation + regenerate-with-new-code (no code task needed). BW out of scope ✓.

**Placeholder scan:** Task 2 Step 1 references a helper that may not exist — explicitly instructs reusing the file's existing engine-construction inline rather than inventing one (acceptable: the harness is real, only the wrapper name is illustrative). Task 2 Step 4 (blend) is test-gated rather than line-complete because the blend series helper was not fully read — flagged as the intricate step; the blend regression fixture is the acceptance gate. No "TODO/TBD".

**Type consistency:** `build_variance_replicates(db, parent) -> dict` and `build_vial_matrix(variance_replicates, variance_report) -> dict` signatures unchanged across tasks; `_VIAL_COA_STATES` referenced in Task 3 exists in the module; `vial_sequence`/`PURITY`/`QUANTITY`/`IDENTITY` record keys consistent with `variance_series.py` and `variance_matrix.py`.

## Known risk / acceptance

Task 2 (conformance mean/values) is the high-risk change — it touches the customer-facing mean and spans single-peptide + blend paths. The single-peptide edits are line-complete; the blend edit is precise-but-test-gated. Task 4's byte-identical regression on real certs is the hard acceptance gate before any deploy.
