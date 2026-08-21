# Native Spec Ownership (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the pass/fail rule for native COA sections from COABuilder's hardcoded `BAKED_SPECS` onto a new lab-owned Mk1 table (`analysis_service_specs`); Mk1 fills the `specification`/`conforms` wire fields it currently sends as `null`, and COABuilder trusts the wire when present, falling back to baked specs when absent.

**Architecture:** Three moving parts across two repos. (1) Mk1 gains a spec table + a pure resolver/evaluator module (`backend/coa/spec_rules.py`); `build_native_sections` fills the two wire fields and gains one new fail-closed abort (rule 5, relocated from COABuilder). (2) COABuilder's `attach_native_sections` gains a prefer-wire branch: a dict `specification` is trusted verbatim (format display, use wire `conforms`, evaluate nothing); `None` keeps today's baked path — that fallback is the rollback path and makes deploy order safe. (3) A parity gate: one literal table of verdict cases duplicated byte-identically in both repos' tests, pinning old-engine and new-engine agreement, with the deliberate fail-closed divergences (NaN/±inf) asserted explicitly.

**Tech Stack:** Python 3.11, SQLAlchemy 2.0 mapped_column, FastAPI (Mk1), pytest, raw-DDL boot migrations (Mk1 has NO alembic).

**Source spec:** `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-08-03-native-spec-ownership-design.md`

## Global Constraints

- **Additive only.** No re-architecture. `conformance.py`, `generic_assay_engine.py`, `addon_parsing.py`, the non-native `BAKED_SPECS` rows (`Benzyl_Alcohol_Assay`, `PH-DETERM`, BW `ENDO-LAL`), `TEST_TECHNIQUES`, and the five native `BAKED_SPECS` rows themselves are ALL untouched — the baked rows are the fallback/rollback path and are deleted only in slice 3, later.
- **TDD is enforced:** write the failing test, run it, watch it fail for the right reason, implement, watch it pass, commit.
- **Mk1 test gate is a failure-set diff vs baseline, NEVER zero-failures** (the suite has ~64 pre-existing failures).
- **COABuilder pre-existing failures:** `tests/test_native_sections_server.py` errors at collection (missing env) — always run with `--ignore=tests/test_native_sections_server.py`; `test_variance_page_4_analytes_vial1_from_parent` fails pre-existing. Expected clean-tree result: `1 failed, 140 passed`.
- **`logs/coabuilder.log` is tracked and every pytest run dirties it. NEVER commit it.** Before every COABuilder commit: `git checkout -- logs/coabuilder.log`.
- **No deploy.** Everything attaches to the ONE combined deploy window. Deploy order within that window is COABuilder → Mk1 (old COABuilder would render a dict `specification` as garbage prose).
- **No Integration Service change.** IS passes the native-sections doc verbatim (additional-COA path); the wire change rides through untouched.
- **No frontend change in this slice.** The admin spec editor is slice 2.
- **Mk1 has no alembic.** Schema = `Base.metadata.create_all` + idempotent raw-DDL strings in `backend/database.py` `_run_migrations()`. New tables get a FULL `CREATE TABLE IF NOT EXISTS` in the migrations list (migrations run BEFORE `create_all` — `vial_roles` precedent at `backend/database.py:1476-1479`). Never write a DROP/re-ADD CHECK pair (LAST-BOOT-WINS hazard, `backend/database.py:1399-1413`).
- **Worktrees:** Mk1 work in `C:\tmp\Accu-Mk1-spec-ownership` (branch `feat/native-spec-ownership`, based on `feat/catalog-driven-bench` @ `a1841c5`). COABuilder work in `C:\tmp\coabuilder-spec-wire` (branch `feat/native-spec-wire`, based on `feat/catalog-order-routing` @ `64e5981`).
- **Venvs (shared with the main checkouts):**
  - Mk1 backend: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe`
  - COABuilder: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\coabuilder\.venv\Scripts\python.exe`
- **Commit footer** (every commit): `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Wire-dict unit for `STERILITY_USP71` is `null`, not `Pos/Neg`.** The spec's wire example shows `"unit": "Pos/Neg"` but the Seeding section explicitly seeds the spec's unit as NULL (parity with `BAKED_SPECS`, which carries no unit key for it; a non-NULL unit would newly arm the divergence warning against the row unit `Pos/Neg`). The Seeding section wins — the wire dict carries the spec row's unit, which is NULL here.

## File Structure

**COABuilder** (`C:\tmp\coabuilder-spec-wire`):
- Modify: `src/coabuilder_core/native_sections.py` — add `_format_spec_display`, `_validate_wire_spec`, and the prefer-wire branch inside `attach_native_sections`. ONLY file touched; pagination/geometry untouched.
- Test: `tests/test_native_sections_wire.py` (new) — wire-path behavior.
- Test: `tests/test_verdict_parity.py` (new) — old-engine half of the cross-repo parity gate.

**Mk1** (`C:\tmp\Accu-Mk1-spec-ownership`):
- Modify: `backend/models.py` — new `AnalysisServiceSpec` model (place directly after `AnalysisService`, which ends at `models.py:196`).
- Modify: `backend/database.py` — DDL strings appended to the `migrations` list; seed call appended to `init_db()`.
- Create: `backend/coa/spec_rules.py` — `normalize_matrix`, `resolve_spec`, `evaluate`, `SpecRuleError`. Pure/DB-read-only; no side effects.
- Create: `backend/catalog/service_spec_audit.py` — `snapshot_spec`, `record_spec_change` (the single audited write path; slice 2's editor reuses it).
- Create: `backend/catalog/service_spec_seed.py` — `seed_service_specs`, parity seed of the five native rows.
- Modify: `backend/coa/native_sections.py` — `build_native_sections` fills `specification`/`conforms`; new rule-5 abort.
- Test: `backend/tests/test_analysis_service_spec_model.py` (new) — table constraints.
- Test: `backend/tests/test_spec_rules.py` (new) — resolver + evaluator + new-engine half of the parity gate.
- Test: `backend/tests/test_service_spec_seed.py` (new) — seed idempotency + audit rows.
- Modify: `backend/tests/test_native_sections.py` — helper grows spec creation; 2 stale assertions updated; new rule-5/verdict tests appended.

---

### Task 1: Worktrees + baselines

**Files:** none modified — setup only.

**Interfaces:**
- Consumes: existing branches `feat/catalog-driven-bench` (Mk1, local @ `a1841c5`) and `feat/catalog-order-routing` (COABuilder, local @ `64e5981`).
- Produces: worktrees `C:\tmp\Accu-Mk1-spec-ownership` and `C:\tmp\coabuilder-spec-wire`; Mk1 baseline failure set at `C:\tmp\Accu-Mk1-spec-ownership\.superpowers\sdd\2026-08-03-native-spec-ownership\baseline-failures.txt`. Every later Mk1 verify step diffs against this file.

- [ ] **Step 1: Create both worktrees**

```bash
git -C "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1" worktree add /c/tmp/Accu-Mk1-spec-ownership -b feat/native-spec-ownership feat/catalog-driven-bench
git -C /c/tmp/coabuilder-order-routing worktree add /c/tmp/coabuilder-spec-wire -b feat/native-spec-wire feat/catalog-order-routing
git -C /c/tmp/Accu-Mk1-spec-ownership log --oneline -1     # expect a1841c5
git -C /c/tmp/coabuilder-spec-wire log --oneline -1        # expect 64e5981
```

- [ ] **Step 2: Record the Mk1 baseline failure set (clean tree)**

```bash
mkdir -p /c/tmp/Accu-Mk1-spec-ownership/.superpowers/sdd/2026-08-03-native-spec-ownership
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > /c/tmp/Accu-Mk1-spec-ownership/.superpowers/sdd/2026-08-03-native-spec-ownership/baseline-failures.txt
wc -l /c/tmp/Accu-Mk1-spec-ownership/.superpowers/sdd/2026-08-03-native-spec-ownership/baseline-failures.txt   # expect ~64
```

- [ ] **Step 3: Confirm the COABuilder clean-tree baseline**

```bash
cd /c/tmp/coabuilder-spec-wire && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe" -m pytest tests/ -q --ignore=tests/test_native_sections_server.py
```

Expected: `1 failed, 140 passed` (the pre-existing `test_variance_page_4_analytes_vial1_from_parent` failure). If anything else fails, STOP — the tree is not the expected baseline.

```bash
git -C /c/tmp/coabuilder-spec-wire checkout -- logs/coabuilder.log
```

---

### Task 2: COABuilder — `_format_spec_display` (pure formatter)

**Files:**
- Modify: `src/coabuilder_core/native_sections.py` (add module-level function, below `_verdict` at line 33-48)
- Test: `tests/test_native_sections_wire.py` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `_format_spec_display(spec: dict) -> str` — Task 3 calls it with the validated wire dict. Keys read: `display`, `rule_kind`, `equals`, `min`, `max`, `unit`. Returns the human display string for the PDF's Specification column.

Display formatting is presentation and stays in COABuilder on purpose (spec: "specification display string — Stays COABuilder-formatted from structured bounds Mk1 sends"). Parity targets for the five seeded rows: `{"rule_kind":"range","max":0.5,"unit":"ppm"}` → `≤ 0.5 ppm` (byte-identical to today's baked `display`), and the equals rule → `Not Detected`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_native_sections_wire.py`:

```python
"""Wire-path native sections: Mk1-filled specification/conforms (spec-ownership slice 1).

A dict `specification` is the new Mk1-filled wire shape: trust it, format the
display string, evaluate nothing. `specification: None` keeps the legacy
baked-spec path (covered by test_native_sections_validation.py) — that
fallback is the rollback path and the reason deploy order is safe.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest

from coabuilder_core.data_model import CoAData
from coabuilder_core.native_sections import (
    NativeSectionsValidationError,
    _format_spec_display,
    attach_native_sections,
)


def _wire_spec(**over):
    base = {"rule_kind": "range", "equals": None, "min": None, "max": 0.5,
            "unit": "ppm", "display": None}
    base.update(over)
    return base


def _row(**over):
    base = {"keyword": "HM-PB", "name": "Lead (Pb)", "result": "0.12",
            "unit": "ppm", "method": "ICP-MS",
            "specification": _wire_spec(), "conforms": True}
    base.update(over)
    return base


def _doc(rows, *, profiles=None):
    return {
        "sample_id": "P-7001",
        "ordered_profiles": profiles if profiles is not None else ["heavy_metals"],
        "sections": [{
            "profile_key": "heavy_metals", "title": "Heavy Metals",
            "archetype": "limit_table", "sort_order": 10, "rows": rows,
        }],
    }


def _coa(matrix="Peptide", badge="PASSED"):
    d = CoAData()
    d.matrix_type = matrix
    d.overall_status_badge = badge
    return d


# ── _format_spec_display ─────────────────────────────────────────────────────

def test_format_max_only_matches_baked_display():
    # Byte-identical to today's baked "≤ 0.5 ppm" — seed-parity requirement.
    assert _format_spec_display(_wire_spec()) == "≤ 0.5 ppm"


def test_format_min_only():
    assert _format_spec_display(
        _wire_spec(min=0.5, max=None)) == "≥ 0.5 ppm"


def test_format_two_sided_range():
    assert _format_spec_display(
        _wire_spec(min=0.72, max=1.08, unit="v/v")) == "0.72 – 1.08 v/v"


def test_format_no_unit_has_no_trailing_space():
    assert _format_spec_display(_wire_spec(unit=None)) == "≤ 0.5"


def test_format_equals_uses_equals_value():
    spec = _wire_spec(rule_kind="equals", equals="Not Detected",
                      max=None, unit=None)
    assert _format_spec_display(spec) == "Not Detected"


def test_format_display_override_wins():
    spec = _wire_spec(min=0.72, max=1.08, unit="v/v",
                      display="0.9% (v/v) ±20%")
    assert _format_spec_display(spec) == "0.9% (v/v) ±20%"
```

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
cd /c/tmp/coabuilder-spec-wire && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe" -m pytest tests/test_native_sections_wire.py -q
```

Expected: ImportError — `cannot import name '_format_spec_display'`.

- [ ] **Step 3: Implement the formatter**

In `src/coabuilder_core/native_sections.py`, directly below `_verdict` (after line 48):

```python
def _format_spec_display(spec: dict) -> str:
    """Display string for a Mk1-filled wire spec. Presentation stays here on
    purpose (spec-ownership slice 1): Mk1 sends structured bounds, COABuilder
    owns the glyphs. `display` is the lab's escape hatch for anything the
    formatter cannot express (e.g. "0.9% (v/v) ±20%")."""
    if spec.get("display"):
        return str(spec["display"])
    if spec.get("rule_kind") == "equals":
        return str(spec.get("equals") or "")
    unit = spec.get("unit") or ""
    suffix = f" {unit}" if unit else ""
    lo, hi = spec.get("min"), spec.get("max")
    if lo is not None and hi is not None:
        return f"{lo:g} – {hi:g}{suffix}"
    if hi is not None:
        return f"≤ {hi:g}{suffix}"
    return f"≥ {lo:g}{suffix}"
```

(The `lo is None and hi is None` case cannot reach the formatter — `_validate_wire_spec` in Task 3 aborts a boundless range first; until Task 3 lands nothing calls this function in production.)

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /c/tmp/coabuilder-spec-wire && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe" -m pytest tests/test_native_sections_wire.py -q
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/coabuilder-spec-wire && git checkout -- logs/coabuilder.log && git add src/coabuilder_core/native_sections.py tests/test_native_sections_wire.py && git commit -m "feat(native-coa): format display string from a structured wire spec

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: COABuilder — prefer-wire branch in `attach_native_sections`

**Files:**
- Modify: `src/coabuilder_core/native_sections.py:104-137` (the per-row loop inside `attach_native_sections`)
- Test: `tests/test_native_sections_wire.py` (extend)

**Interfaces:**
- Consumes: `_format_spec_display` (Task 2).
- Produces: the only behavioral change to this file in the slice — per row, `specification` as a **dict** → validate shape, trust wire `conforms` (must be a bool), format display, skip `lookup_spec`/`_verdict` entirely; `specification` as **None** → today's baked path, byte-for-byte unchanged. Wire path emits the same enriched row shape the renderer already reads (`specification` string, `conforms` bool, `status` string) and participates in the badge downgrade.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_native_sections_wire.py`:

```python
# ── attach_native_sections wire path ─────────────────────────────────────────

def test_wire_spec_is_trusted_not_reevaluated():
    # result "9.99" would FAIL the 0.5 range if COABuilder evaluated it; wire
    # conforms=True must win — proof the wire is trusted, nothing re-verdicts.
    d = _coa()
    attach_native_sections(d, _doc([_row(result="9.99", conforms=True)]))
    row = d.native_sections[0]["rows"][0]
    assert row["conforms"] is True
    assert row["status"] == "Conforms"
    assert row["specification"] == "≤ 0.5 ppm"
    assert d.overall_status_badge == "PASSED"


def test_wire_nonconforming_downgrades_badge():
    d = _coa()
    attach_native_sections(d, _doc([_row(conforms=False)]))
    row = d.native_sections[0]["rows"][0]
    assert row["conforms"] is False
    assert row["status"] == "Does Not Conform"
    assert d.overall_status_badge == "FAILED"


def test_wire_equals_spec_renders():
    d = _coa()
    spec = _wire_spec(rule_kind="equals", equals="Not Detected",
                      max=None, unit=None)
    doc = _doc([_row(keyword="STERILITY_USP71", name="Sterility USP<71>",
                     result="Not Detected", unit="Pos/Neg",
                     specification=spec, conforms=True)])
    attach_native_sections(d, doc)
    row = d.native_sections[0]["rows"][0]
    assert row["specification"] == "Not Detected"
    assert row["conforms"] is True


def test_wire_dict_with_null_conforms_aborts():
    # A dict spec with conforms=None is a malformed producer — the exact
    # "silently prints the wrong thing" class this migration exists to kill.
    d = _coa()
    with pytest.raises(NativeSectionsValidationError, match="malformed"):
        attach_native_sections(d, _doc([_row(conforms=None)]))


def test_wire_dict_with_unknown_rule_kind_aborts():
    d = _coa()
    with pytest.raises(NativeSectionsValidationError, match="malformed"):
        attach_native_sections(
            d, _doc([_row(specification=_wire_spec(rule_kind="fancy"))]))


def test_wire_range_without_bounds_aborts():
    d = _coa()
    with pytest.raises(NativeSectionsValidationError, match="malformed"):
        attach_native_sections(
            d, _doc([_row(specification=_wire_spec(max=None))]))


def test_wire_equals_without_value_aborts():
    d = _coa()
    spec = _wire_spec(rule_kind="equals", equals="", max=None)
    with pytest.raises(NativeSectionsValidationError, match="malformed"):
        attach_native_sections(d, _doc([_row(specification=spec)]))


def test_wire_unit_divergence_warns_and_renders(caplog):
    d = _coa()
    doc = _doc([_row(unit="mg")])   # wire spec says ppm
    with caplog.at_level("WARNING"):
        attach_native_sections(d, doc)
    assert d.native_sections[0]["rows"][0]["conforms"] is True
    assert "native_section_unit_divergence" in caplog.text
    assert "spec=ppm" in caplog.text and "wire=mg" in caplog.text


def test_wire_null_spec_unit_emits_no_divergence_warning(caplog):
    # STERILITY_USP71's seeded spec unit is NULL on purpose; the row unit
    # Pos/Neg must not trip the warning against it.
    d = _coa()
    spec = _wire_spec(rule_kind="equals", equals="Not Detected",
                      max=None, unit=None)
    doc = _doc([_row(keyword="STERILITY_USP71", result="Not Detected",
                     unit="Pos/Neg", specification=spec, conforms=True)])
    with caplog.at_level("WARNING"):
        attach_native_sections(d, doc)
    assert "native_section_unit_divergence" not in caplog.text


def test_mixed_wire_and_legacy_rows_coexist():
    # Rollback reality: during the deploy window a doc may mix Mk1-filled rows
    # with legacy null-spec rows. Wire rows trust the wire; null rows still
    # resolve from BAKED_SPECS (HM-PB @ 0.12 ppm conforms).
    d = _coa()
    legacy = _row(keyword="HM-AS", name="Arsenic (As)",
                  specification=None, conforms=None)
    attach_native_sections(d, _doc([_row(), legacy]))
    rows = d.native_sections[0]["rows"]
    assert rows[0]["conforms"] is True          # wire
    assert rows[1]["conforms"] is True          # baked (0.12 <= 1.5)
    assert rows[1]["specification"] == "≤ 1.5 ppm"
```

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
cd /c/tmp/coabuilder-spec-wire && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe" -m pytest tests/test_native_sections_wire.py -q
```

Expected: the 10 new tests fail. Failure mode: with a dict `specification`, the current code falls through to `lookup_spec`, so `test_wire_spec_is_trusted_not_reevaluated` fails with `conforms is False` (it re-evaluated 9.99) and the abort tests fail with "DID NOT RAISE". The 6 Task-2 tests still pass.

- [ ] **Step 3: Implement the wire branch**

In `src/coabuilder_core/native_sections.py`:

**3a.** Add the validator directly below `_format_spec_display`:

```python
def _validate_wire_spec(keyword: str, spec: dict, conforms) -> None:
    """Fail-closed shape check for a Mk1-filled wire spec. A malformed spec
    or a non-bool conforms is a producer bug — abort, never guess (the
    silent-wrong-certificate class this slice exists to kill)."""
    kind = spec.get("rule_kind")
    if kind == "equals":
        shape_ok = bool(str(spec.get("equals") or "").strip())
    elif kind == "range":
        shape_ok = spec.get("min") is not None or spec.get("max") is not None
    else:
        shape_ok = False
    if not shape_ok or not isinstance(conforms, bool):
        raise NativeSectionsValidationError(
            f"native sections: row {keyword!r} carries a malformed wire "
            f"specification ({spec!r}, conforms={conforms!r}) — aborting"
        )
```

**3b.** In the per-row loop of `attach_native_sections`, directly after the empty-result abort (current lines 109-113) and BEFORE the `INFORMATIONAL_KEYWORDS` check, insert:

```python
            wire_spec = row.get("specification")
            if isinstance(wire_spec, dict):
                # Mk1-filled row (spec-ownership slice 1): trust the wire,
                # format the display, evaluate nothing. specification=None
                # falls through to the baked path below — that fallback is
                # the rollback path (deleted in slice 3, never earlier).
                conforms = row.get("conforms")
                _validate_wire_spec(keyword, wire_spec, conforms)
                wire_unit = row.get("unit") or ""
                spec_unit = wire_spec.get("unit") or ""
                if wire_unit and spec_unit and wire_unit != spec_unit:
                    logger.warning(
                        "native_section_unit_divergence keyword=%s wire=%s spec=%s",
                        keyword, wire_unit, spec_unit)
                any_nonconforming = any_nonconforming or not conforms
                out_rows.append({
                    **row,
                    "specification": _format_spec_display(wire_spec),
                    "conforms": conforms,
                    "status": "Conforms" if conforms else "Does Not Conform",
                })
                continue
```

Nothing after this insertion changes: the informational check, `lookup_spec`, the baked unit-divergence warning (its log line keeps `baked=`), `_verdict`, and the badge downgrade all stay byte-identical.

**3c.** Update the module docstring's second sentence (lines 4-8) to reflect the new reality:

```python
The wire document arrives from Mk1 (primary path) or Integration Service
(additional path) as `native_sections` in the request body. Mk1 now fills
specification (a structured dict) + conforms per row (spec-ownership slice
1); rows carrying specification=None are legacy producers and fall back to
baked_specs. The baked fallback is the rollback path and is deleted in
slice 3; the renderer never changes.
```

- [ ] **Step 4: Run the wire tests, then the full suite**

```bash
cd /c/tmp/coabuilder-spec-wire && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe" -m pytest tests/test_native_sections_wire.py -q
cd /c/tmp/coabuilder-spec-wire && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe" -m pytest tests/ -q --ignore=tests/test_native_sections_server.py
```

Expected: 16 passed in the wire file; full suite `1 failed, 156 passed` (the same pre-existing variance failure, nothing else).

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/coabuilder-spec-wire && git checkout -- logs/coabuilder.log && git add src/coabuilder_core/native_sections.py tests/test_native_sections_wire.py && git commit -m "feat(native-coa): trust Mk1-filled specification/conforms on the wire

A dict specification is validated fail-closed and trusted verbatim; None
keeps the baked-spec fallback as the rollback path (slice 3 deletes it).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: COABuilder — old-engine half of the parity gate

**Files:**
- Test: `tests/test_verdict_parity.py` (new; test-only task)

**Interfaces:**
- Consumes: `_verdict` (existing, `src/coabuilder_core/native_sections.py:33-48`).
- Produces: the literal `PARITY_CASES` table. Task 6 duplicates it **byte-identically** in Mk1's `backend/tests/test_spec_rules.py`. Row shape: `(rule, result, old_verdict, new_verdict)` where `rule` is `("range", min, max)` or `("equals", value)` and a verdict is `True`, `False`, or `"abort"`.

This pins the OLD engine's behavior — including its NaN/−inf false-pass bugs — so that any drift on either side of the migration breaks a test in the repo that drifted.

- [ ] **Step 1: Write the test file**

Create `tests/test_verdict_parity.py`:

```python
"""Old-engine half of the cross-repo parity gate (spec-ownership slice 1).

PARITY_CASES must stay BYTE-IDENTICAL to the table in
Accu-Mk1 backend/tests/test_spec_rules.py. Each row pins what COABuilder's
_verdict does today; the Mk1 file pins what spec_rules.evaluate does. The
non-finite rows are the DELIBERATE divergence: the old engine false-passes
NaN and -inf and prints a failure for +inf; the new evaluator refuses all
three fail-closed. Asserting the old behavior here keeps that divergence
visible forever — it can never be mistaken for a regression.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest

from coabuilder_core.native_sections import (
    NativeSectionsValidationError,
    _verdict,
)

# ── Cross-repo parity table — DO NOT EDIT without editing the twin ──────────
# (rule, result, old_verdict, new_verdict); rule = ("range", min, max) or
# ("equals", value); verdict = True | False | "abort".
PARITY_CASES = [
    # HM-shaped: max-only range, inclusive upper bound
    (("range", None, 0.5), "0.12",  True,    True),
    (("range", None, 0.5), "0.5",   True,    True),     # ON the bound: inclusive
    (("range", None, 0.5), "0.50",  True,    True),
    (("range", None, 0.5), "9.99",  False,   False),
    (("range", None, 0.5), "-1",    True,    True),     # no lower bound
    (("range", None, 0.5), "N/A",   "abort", "abort"),
    # pH-shaped: two-sided range, both bounds inclusive
    (("range", 4.5, 7.0),  "4.5",   True,    True),
    (("range", 4.5, 7.0),  "7.0",   True,    True),
    (("range", 4.5, 7.0),  "4.49",  False,   False),
    (("range", 4.5, 7.0),  "7.01",  False,   False),
    # USP<71>-shaped equals: case-insensitive, whitespace-trimmed
    (("equals", "Not Detected"), "Not Detected",     True,  True),
    (("equals", "Not Detected"), "not detected",     True,  True),
    (("equals", "Not Detected"), "  Not Detected  ", True,  True),
    (("equals", "Not Detected"), "Detected",         False, False),
    (("equals", "Not Detected"), "No Growth",        False, False),
    # DELIBERATE DIVERGENCES — non-finite results
    (("range", None, 0.5), "nan",  True,    "abort"),   # old BUG: NaN conforms
    (("range", None, 0.5), "-inf", True,    "abort"),   # old BUG: -inf conforms
    (("range", None, 0.5), "inf",  False,   "abort"),   # old: prints a failure
]


def _baked_spec(rule):
    if rule[0] == "equals":
        return {"equals": rule[1]}
    spec = {}
    if rule[1] is not None:
        spec["min"] = rule[1]
    if rule[2] is not None:
        spec["max"] = rule[2]
    return spec


@pytest.mark.parametrize("rule,result,old_verdict,new_verdict", PARITY_CASES)
def test_old_engine_column_is_accurate(rule, result, old_verdict, new_verdict):
    spec = _baked_spec(rule)
    if old_verdict == "abort":
        with pytest.raises(NativeSectionsValidationError):
            _verdict("PARITY", result, spec)
    else:
        assert _verdict("PARITY", result, spec) is old_verdict
```

- [ ] **Step 2: Run it — every case must pass first try**

```bash
cd /c/tmp/coabuilder-spec-wire && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe" -m pytest tests/test_verdict_parity.py -q
```

Expected: 18 passed. This is a characterization test of existing behavior — if ANY case fails, the table's old-verdict column is wrong: fix the TABLE to match observed behavior (never touch `_verdict`), and carry the corrected value into Task 6's twin.

- [ ] **Step 3: Commit**

```bash
cd /c/tmp/coabuilder-spec-wire && git checkout -- logs/coabuilder.log && git add tests/test_verdict_parity.py && git commit -m "test(native-coa): pin _verdict behavior — old-engine half of the parity gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Mk1 — `AnalysisServiceSpec` model + boot DDL

**Files:**
- Modify: `backend/models.py` (insert after `AnalysisService.__repr__`, line 196; extend the sqlalchemy import at line 9)
- Modify: `backend/database.py` (append to the `migrations` list — after the spec-4 catalog block, keeping catalog DDL together)
- Test: `backend/tests/test_analysis_service_spec_model.py` (new)

**Interfaces:**
- Consumes: existing `Base`, `AnalysisService`, `users` table.
- Produces: `models.AnalysisServiceSpec` with columns `id, analysis_service_id, matrix, rule_kind, min_value, max_value, equals_value, unit, display_override, active, created_at, updated_at, updated_by_id`. Tasks 6-8 import it. Tests get the constraints too: the fixture DB is in-memory SQLite built by `Base.metadata.create_all` (`backend/tests/conftest.py:24-36`), so constraints must live in `__table_args__`, not only in the raw DDL.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_analysis_service_spec_model.py`:

```python
"""analysis_service_specs constraints: one active spec per (service, matrix),
NULL-matrix uniqueness, and the rule-shape CHECK. Enforced via __table_args__
so SQLite test DBs carry them (prod gets the same shapes via raw boot DDL)."""
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError


def _mk_service(db, keyword="HM-XX"):
    from models import AnalysisService
    svc = AnalysisService(title=keyword, keyword=keyword, origin="mk1")
    db.add(svc)
    db.flush()
    return svc


def _mk_spec(db, svc, **over):
    from models import AnalysisServiceSpec
    kw = dict(analysis_service_id=svc.id, matrix=None, rule_kind="range",
              max_value=Decimal("0.5"), unit="ppm")
    kw.update(over)
    spec = AnalysisServiceSpec(**kw)
    db.add(spec)
    db.flush()
    return spec


def test_valid_range_and_equals_rows_insert(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc)
    svc2 = _mk_service(db_session, keyword="STER-XX")
    _mk_spec(db_session, svc2, rule_kind="equals", max_value=None,
             equals_value="Not Detected", unit=None)


def test_second_active_null_matrix_spec_rejected(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc)
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc)


def test_second_active_same_matrix_spec_rejected(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc, matrix="Peptide")
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc, matrix="Peptide")


def test_deactivated_row_frees_the_slot(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc, active=False)
    _mk_spec(db_session, svc)   # active row alongside the dead one: fine


def test_null_and_named_matrix_coexist(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc)
    _mk_spec(db_session, svc, matrix="Bacteriostatic Water",
             max_value=Decimal("0.25"))


def test_range_with_equals_value_rejected(db_session):
    svc = _mk_service(db_session)
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc, equals_value="nope")


def test_range_without_bounds_rejected(db_session):
    svc = _mk_service(db_session)
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc, max_value=None)


def test_equals_with_bounds_rejected(db_session):
    svc = _mk_service(db_session)
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc, rule_kind="equals",
                 equals_value="Not Detected")   # max_value 0.5 still set
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_analysis_service_spec_model.py -q
```

Expected: ImportError — `cannot import name 'AnalysisServiceSpec'`.

- [ ] **Step 3: Add the model**

In `backend/models.py` line 9, extend the sqlalchemy import with `Index`, `Numeric`, and `text` (keep the existing names):

```python
from sqlalchemy import String, Text, Float, Integer, BigInteger, Boolean, DateTime, Time, Date, ForeignKey, JSON, Column, Table, UniqueConstraint, CheckConstraint, Index, Numeric, text
```

Add below the datetime import block:

```python
from decimal import Decimal
```

Insert after `AnalysisService.__repr__` (line 196):

```python
class AnalysisServiceSpec(Base):
    """Lab-owned pass/fail rule for a native COA row (spec-ownership slice 1).

    One active spec per (service, matrix); matrix NULL = applies to every
    matrix — NULL-first is the practical default. The identity join is the
    FK, never the keyword. Rows are deactivated, never deleted; every write
    goes through catalog/service_spec_audit.record_spec_change.
    """
    __tablename__ = "analysis_service_specs"
    __table_args__ = (
        CheckConstraint(
            "(rule_kind = 'range' AND equals_value IS NULL "
            "AND (min_value IS NOT NULL OR max_value IS NOT NULL)) OR "
            "(rule_kind = 'equals' AND equals_value IS NOT NULL "
            "AND min_value IS NULL AND max_value IS NULL)",
            name="ck_analysis_service_specs_rule_shape",
        ),
        # Postgres treats NULLs as distinct in unique indexes, so the
        # NULL-matrix default row needs its own partial index.
        Index(
            "uq_analysis_service_specs_matrix",
            "analysis_service_id", "matrix",
            unique=True,
            postgresql_where=text("active AND matrix IS NOT NULL"),
            sqlite_where=text("active AND matrix IS NOT NULL"),
        ),
        Index(
            "uq_analysis_service_specs_null_matrix",
            "analysis_service_id",
            unique=True,
            postgresql_where=text("active AND matrix IS NULL"),
            sqlite_where=text("active AND matrix IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    analysis_service_id: Mapped[int] = mapped_column(
        ForeignKey("analysis_services.id", ondelete="CASCADE"), nullable=False
    )
    matrix: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    rule_kind: Mapped[str] = mapped_column(String(16), nullable=False)  # range | equals
    min_value: Mapped[Optional[Decimal]] = mapped_column(Numeric, nullable=True)
    max_value: Mapped[Optional[Decimal]] = mapped_column(Numeric, nullable=True)
    equals_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # The spec's own unit; COABuilder warns when it diverges from the row's.
    unit: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    # NULL = COABuilder formats the display string from the bounds.
    display_override: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    updated_by_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    def __repr__(self) -> str:
        return (f"<AnalysisServiceSpec(id={self.id}, "
                f"service={self.analysis_service_id}, matrix={self.matrix!r}, "
                f"rule={self.rule_kind})>")
```

- [ ] **Step 4: Add the boot DDL**

In `backend/database.py`, append to the `migrations` list, after the last spec-4 catalog entry (search for the final `vial_roles`-related string; keep catalog DDL contiguous):

```python
        # --- Native spec ownership (slice 1): lab-owned pass/fail rules ---
        # Full CREATE (not just create_all): migrations run BEFORE create_all
        # (vial_roles precedent above). CHECK ships inline in the CREATE and
        # is never DROP/re-ADDed (LAST-BOOT-WINS hazard, see :1399-1413).
        """
        CREATE TABLE IF NOT EXISTS analysis_service_specs (
            id SERIAL PRIMARY KEY,
            analysis_service_id INTEGER NOT NULL REFERENCES analysis_services(id) ON DELETE CASCADE,
            matrix VARCHAR(100),
            rule_kind VARCHAR(16) NOT NULL,
            min_value NUMERIC,
            max_value NUMERIC,
            equals_value TEXT,
            unit VARCHAR(50),
            display_override TEXT,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now(),
            updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            CONSTRAINT ck_analysis_service_specs_rule_shape CHECK (
                (rule_kind = 'range' AND equals_value IS NULL
                 AND (min_value IS NOT NULL OR max_value IS NOT NULL)) OR
                (rule_kind = 'equals' AND equals_value IS NOT NULL
                 AND min_value IS NULL AND max_value IS NULL)
            )
        )
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_service_specs_matrix "
        "ON analysis_service_specs (analysis_service_id, matrix) "
        "WHERE active AND matrix IS NOT NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_service_specs_null_matrix "
        "ON analysis_service_specs (analysis_service_id) "
        "WHERE active AND matrix IS NULL",
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_analysis_service_spec_model.py -q
```

Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership && git add backend/models.py backend/database.py backend/tests/test_analysis_service_spec_model.py && git commit -m "feat(spec-ownership): analysis_service_specs table — lab-owned native COA rules

One active spec per (service, matrix), NULL matrix = all matrices, rule
shape enforced by CHECK. Constraints live in __table_args__ AND the boot
DDL so SQLite test DBs enforce them too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Mk1 — `spec_rules.py` resolver + evaluator + parity gate

**Files:**
- Create: `backend/coa/spec_rules.py`
- Test: `backend/tests/test_spec_rules.py` (new)

**Interfaces:**
- Consumes: `models.AnalysisServiceSpec` (Task 5).
- Produces (Task 8 consumes all four):
  - `normalize_matrix(raw: str | None) -> str | None` — trims; `""`/`None` → `None`; `"Peptide Blend"` → `"Peptide"`; anything else passes through.
  - `resolve_spec(db: Session, service_id: int, matrix: str | None) -> AnalysisServiceSpec | None` — exact `(service_id, matrix)` active row, else `(service_id, NULL)` active row, else `None`.
  - `evaluate(spec, result: str) -> bool` — pure; `spec` is any object with `rule_kind`, `min_value`, `max_value`, `equals_value` attributes; raises `SpecRuleError` when the rule cannot be applied (unparseable/non-finite numerics, unknown rule_kind).
  - `SpecRuleError(detail)` — carries `.detail`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_spec_rules.py`:

```python
"""spec_rules: resolver precedence, matrix normalization parity, and the
new-engine half of the cross-repo parity gate.

PARITY_CASES must stay BYTE-IDENTICAL to the table in
coabuilder tests/test_verdict_parity.py. That file pins the OLD engine
(_verdict); this one pins the NEW (evaluate). The non-finite rows are the
deliberate fail-closed divergence — asserted on both sides so it can never
be mistaken for a regression."""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from coa.spec_rules import SpecRuleError, evaluate, normalize_matrix, resolve_spec


def _mk_service(db, keyword="HM-XX"):
    from models import AnalysisService
    svc = AnalysisService(title=keyword, keyword=keyword, origin="mk1")
    db.add(svc)
    db.flush()
    return svc


def _mk_spec(db, svc, **over):
    from models import AnalysisServiceSpec
    kw = dict(analysis_service_id=svc.id, matrix=None, rule_kind="range",
              max_value=Decimal("0.5"), unit="ppm")
    kw.update(over)
    spec = AnalysisServiceSpec(**kw)
    db.add(spec)
    db.flush()
    return spec


def _rule_ns(rule):
    if rule[0] == "equals":
        return SimpleNamespace(rule_kind="equals", equals_value=rule[1],
                               min_value=None, max_value=None)
    return SimpleNamespace(rule_kind="range", equals_value=None,
                           min_value=rule[1], max_value=rule[2])


# ── normalize_matrix: parity with coabuilder logic.py:5 ─────────────────────

def test_peptide_matrices_parity_with_coabuilder():
    # MUST mirror coabuilder src/coabuilder_core/logic.py:5
    # (_PEPTIDE_MATRICES = {"Peptide", "Peptide Blend"}). A divergence here
    # silently changes which spec resolves.
    from coa.spec_rules import _PEPTIDE_MATRICES
    assert _PEPTIDE_MATRICES == {"Peptide", "Peptide Blend"}


def test_normalize_blend_to_peptide():
    assert normalize_matrix("Peptide Blend") == "Peptide"
    assert normalize_matrix("Peptide") == "Peptide"


def test_normalize_passthrough_and_null():
    assert normalize_matrix("Bacteriostatic Water") == "Bacteriostatic Water"
    assert normalize_matrix(None) is None
    assert normalize_matrix("") is None
    assert normalize_matrix("  ") is None


# ── resolve_spec precedence ─────────────────────────────────────────────────

def test_exact_matrix_beats_null(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc, matrix=None, max_value=Decimal("5.0"))
    bw = _mk_spec(db_session, svc, matrix="Bacteriostatic Water",
                  max_value=Decimal("0.25"))
    got = resolve_spec(db_session, svc.id, "Bacteriostatic Water")
    assert got.id == bw.id


def test_null_matrix_is_the_fallback(db_session):
    svc = _mk_service(db_session)
    base = _mk_spec(db_session, svc, matrix=None)
    got = resolve_spec(db_session, svc.id, "Bacteriostatic Water")
    assert got.id == base.id


def test_null_matrix_input_resolves_null_row(db_session):
    svc = _mk_service(db_session)
    base = _mk_spec(db_session, svc, matrix=None)
    assert resolve_spec(db_session, svc.id, None).id == base.id


def test_inactive_rows_never_resolve(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc, active=False)
    assert resolve_spec(db_session, svc.id, None) is None


def test_no_rows_resolves_none(db_session):
    svc = _mk_service(db_session)
    assert resolve_spec(db_session, svc.id, "Peptide") is None


# ── Cross-repo parity table — DO NOT EDIT without editing the twin ──────────
# (rule, result, old_verdict, new_verdict); rule = ("range", min, max) or
# ("equals", value); verdict = True | False | "abort".
PARITY_CASES = [
    # HM-shaped: max-only range, inclusive upper bound
    (("range", None, 0.5), "0.12",  True,    True),
    (("range", None, 0.5), "0.5",   True,    True),     # ON the bound: inclusive
    (("range", None, 0.5), "0.50",  True,    True),
    (("range", None, 0.5), "9.99",  False,   False),
    (("range", None, 0.5), "-1",    True,    True),     # no lower bound
    (("range", None, 0.5), "N/A",   "abort", "abort"),
    # pH-shaped: two-sided range, both bounds inclusive
    (("range", 4.5, 7.0),  "4.5",   True,    True),
    (("range", 4.5, 7.0),  "7.0",   True,    True),
    (("range", 4.5, 7.0),  "4.49",  False,   False),
    (("range", 4.5, 7.0),  "7.01",  False,   False),
    # USP<71>-shaped equals: case-insensitive, whitespace-trimmed
    (("equals", "Not Detected"), "Not Detected",     True,  True),
    (("equals", "Not Detected"), "not detected",     True,  True),
    (("equals", "Not Detected"), "  Not Detected  ", True,  True),
    (("equals", "Not Detected"), "Detected",         False, False),
    (("equals", "Not Detected"), "No Growth",        False, False),
    # DELIBERATE DIVERGENCES — non-finite results
    (("range", None, 0.5), "nan",  True,    "abort"),   # old BUG: NaN conforms
    (("range", None, 0.5), "-inf", True,    "abort"),   # old BUG: -inf conforms
    (("range", None, 0.5), "inf",  False,   "abort"),   # old: prints a failure
]


@pytest.mark.parametrize("rule,result,old_verdict,new_verdict", PARITY_CASES)
def test_new_engine_column_is_accurate(rule, result, old_verdict, new_verdict):
    spec = _rule_ns(rule)
    if new_verdict == "abort":
        with pytest.raises(SpecRuleError):
            evaluate(spec, result)
    else:
        assert evaluate(spec, result) is new_verdict


def test_decimal_bounds_from_orm_rows_evaluate(db_session):
    # ORM rows carry Decimal bounds; evaluate must handle them, on-bound
    # inclusively, same as the float table above.
    svc = _mk_service(db_session)
    spec = _mk_spec(db_session, svc)     # range, max 0.5 ppm
    assert evaluate(spec, "0.5") is True
    assert evaluate(spec, "0.51") is False


def test_unknown_rule_kind_aborts():
    with pytest.raises(SpecRuleError):
        evaluate(SimpleNamespace(rule_kind="fancy", equals_value=None,
                                 min_value=None, max_value=None), "1")
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_spec_rules.py -q
```

Expected: ImportError — `No module named 'coa.spec_rules'`.

- [ ] **Step 3: Implement `backend/coa/spec_rules.py`**

```python
"""Native-section spec resolution + verdict (spec-ownership slice 1).

The verdict semantics mirror COABuilder's _verdict — inclusive bounds,
case-insensitive whitespace-trimmed equals — with two DELIBERATE fail-closed
divergences (non-finite false-pass, equals/range abort asymmetry). The
cross-repo parity table in tests/test_spec_rules.py is the contract; its
byte-identical twin lives in coabuilder tests/test_verdict_parity.py.
"""
from __future__ import annotations

import math
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

# MUST stay identical to coabuilder src/coabuilder_core/logic.py:5
# (_PEPTIDE_MATRICES) — a divergence silently changes which spec resolves.
# Pinned by test_peptide_matrices_parity_with_coabuilder.
_PEPTIDE_MATRICES = {"Peptide", "Peptide Blend"}


class SpecRuleError(Exception):
    """A spec rule that cannot be applied to a result (fail-closed)."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def normalize_matrix(raw: Optional[str]) -> Optional[str]:
    """Sample-type title -> spec-resolution matrix. Mirrors COABuilder's
    Peptide Blend -> Peptide fold. None/blank -> None (resolver then goes
    straight to the NULL-matrix default row)."""
    m = (raw or "").strip()
    if not m:
        return None
    return "Peptide" if m in _PEPTIDE_MATRICES else m


def resolve_spec(db: Session, service_id: int, matrix: Optional[str]):
    """Active spec for (service, matrix): exact row, else the NULL-matrix
    default, else None. scalar_one_or_none on purpose — the partial unique
    indexes guarantee at most one active row per slot, and if that invariant
    ever breaks, failing loud (which aborts COA generation) beats silently
    picking a limit."""
    from models import AnalysisServiceSpec

    if matrix is not None:
        row = db.execute(
            select(AnalysisServiceSpec).where(
                AnalysisServiceSpec.analysis_service_id == service_id,
                AnalysisServiceSpec.matrix == matrix,
                AnalysisServiceSpec.active.is_(True),
            )
        ).scalar_one_or_none()
        if row is not None:
            return row
    return db.execute(
        select(AnalysisServiceSpec).where(
            AnalysisServiceSpec.analysis_service_id == service_id,
            AnalysisServiceSpec.matrix.is_(None),
            AnalysisServiceSpec.active.is_(True),
        )
    ).scalar_one_or_none()


def evaluate(spec, result: str) -> bool:
    """Verdict of a result string against a spec (any object with rule_kind,
    equals_value, min_value, max_value). Pure. Raises SpecRuleError whenever
    the rule cannot actually be applied — a verdict is only ever emitted from
    a rule that ran; anything else fails closed. Bounds are INCLUSIVE."""
    text = str(result or "").strip()
    if spec.rule_kind == "equals":
        return text.lower() == str(spec.equals_value or "").strip().lower()
    if spec.rule_kind != "range":
        raise SpecRuleError(f"unknown rule_kind {spec.rule_kind!r}")
    try:
        value = float(text)
    except ValueError as e:
        raise SpecRuleError(
            f"result {result!r} is not numeric but the spec is a numeric range"
        ) from e
    if not math.isfinite(value):
        # The old engine false-passed NaN and -inf here. Deliberate divergence.
        raise SpecRuleError(f"result {result!r} is non-finite — cannot verdict")
    if spec.min_value is not None and value < float(spec.min_value):
        return False
    if spec.max_value is not None and value > float(spec.max_value):
        return False
    return True
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_spec_rules.py -q
```

Expected: 28 passed (3 normalize + 5 resolver + 18 parity + 2 extra evaluator).

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership && git add backend/coa/spec_rules.py backend/tests/test_spec_rules.py && git commit -m "feat(spec-ownership): spec resolver + fail-closed evaluator with parity gate

evaluate() mirrors COABuilder _verdict (inclusive bounds, case-insensitive
equals) except non-finite results now abort instead of false-passing, and
equals/range share the same fail-closed shape. The cross-repo parity table
is byte-identical to coabuilder tests/test_verdict_parity.py.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Mk1 — audited write helper + parity seed

**Files:**
- Create: `backend/catalog/service_spec_audit.py`
- Create: `backend/catalog/service_spec_seed.py`
- Modify: `backend/database.py` `init_db()` (append seed call after the `seed_vial_roles` block, `database.py:145-150`)
- Test: `backend/tests/test_service_spec_seed.py` (new)

**Interfaces:**
- Consumes: `models.AnalysisServiceSpec`, `models.AnalysisService`, `models.AuditLog` (`models.py:37-53`: `operation`, `entity_type`, `entity_id`, `details` JSON).
- Produces:
  - `service_spec_audit.snapshot_spec(spec) -> dict` — JSON-safe field snapshot.
  - `service_spec_audit.record_spec_change(db, spec, *, before: dict | None, actor_user_id: int | None) -> None` — appends the `AuditLog` row. **Slice 2's admin editor MUST reuse this** — it is the single write path that keeps "every write is audited" true.
  - `service_spec_seed.seed_service_specs(db) -> int` — idempotent parity seed; called from `init_db()`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_service_spec_seed.py`:

```python
"""Parity seed of the five native specs + the audited write path.

Values are frozen at the 2026-08-03 BAKED_SPECS state; STERILITY_USP71's
spec unit is NULL on purpose (BAKED_SPECS carries no unit key for it — a
non-NULL unit would newly arm the divergence warning against Pos/Neg)."""
from decimal import Decimal

from catalog.service_spec_seed import seed_service_specs


def _mk_native_services(db, keywords=("HM-PB", "HM-AS", "HM-CD", "HM-HG",
                                      "STERILITY_USP71")):
    from models import AnalysisService
    out = {}
    for kw in keywords:
        svc = AnalysisService(title=kw, keyword=kw, origin="mk1")
        db.add(svc)
        db.flush()
        out[kw] = svc
    return out


def test_seed_creates_five_parity_rows(db_session):
    from models import AnalysisServiceSpec
    svcs = _mk_native_services(db_session)
    assert seed_service_specs(db_session) == 5
    rows = {r.analysis_service_id: r
            for r in db_session.query(AnalysisServiceSpec).all()}
    pb = rows[svcs["HM-PB"].id]
    assert (pb.rule_kind, pb.max_value, pb.min_value, pb.unit, pb.matrix,
            pb.display_override) == ("range", Decimal("0.5"), None, "ppm",
                                     None, None)
    assert rows[svcs["HM-AS"].id].max_value == Decimal("1.5")
    assert rows[svcs["HM-CD"].id].max_value == Decimal("0.5")
    assert rows[svcs["HM-HG"].id].max_value == Decimal("1.5")
    ster = rows[svcs["STERILITY_USP71"].id]
    assert (ster.rule_kind, ster.equals_value, ster.unit,
            ster.min_value, ster.max_value) == ("equals", "Not Detected",
                                                None, None, None)


def test_seed_is_idempotent(db_session):
    from models import AnalysisServiceSpec
    _mk_native_services(db_session)
    seed_service_specs(db_session)
    assert seed_service_specs(db_session) == 0
    assert db_session.query(AnalysisServiceSpec).count() == 5


def test_seed_skips_missing_services_silently(db_session):
    # Fresh DB without the native services: seed is a quiet no-op.
    assert seed_service_specs(db_session) == 0


def test_seed_leaves_edited_rows_alone(db_session):
    from models import AnalysisServiceSpec
    svcs = _mk_native_services(db_session, keywords=("HM-PB",))
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs["HM-PB"].id, matrix=None,
        rule_kind="range", max_value=Decimal("9.9"), unit="ppm"))
    db_session.flush()
    seed_service_specs(db_session)
    row = db_session.query(AnalysisServiceSpec).one()
    assert row.max_value == Decimal("9.9")   # the lab's edit survives


def test_seed_writes_audit_rows(db_session):
    from models import AuditLog
    _mk_native_services(db_session)
    seed_service_specs(db_session)
    logs = (db_session.query(AuditLog)
            .filter(AuditLog.operation == "analysis_service_spec_changed")
            .all())
    assert len(logs) == 5
    entry = logs[0]
    assert entry.entity_type == "analysis_service_spec"
    assert entry.details["before"] is None
    assert entry.details["actor_user_id"] is None
    assert entry.details["after"]["rule_kind"] in ("range", "equals")
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_service_spec_seed.py -q
```

Expected: ImportError — `No module named 'catalog.service_spec_seed'`.

- [ ] **Step 3: Implement the audit helper**

Create `backend/catalog/service_spec_audit.py`:

```python
"""Audit trail for analysis_service_specs writes (ISO 17025 alignment).

Moving specs from a git-versioned literal into admin-editable rows is, on
its own, an auditability regression — this module is the mitigation. EVERY
write path (the seed today, the slice-2 admin editor tomorrow) must call
record_spec_change; rows are deactivated, never deleted.
"""
from typing import Optional

from sqlalchemy.orm import Session


def snapshot_spec(spec) -> dict:
    """JSON-safe snapshot of the rule-bearing fields (Decimal -> str)."""
    return {
        "analysis_service_id": spec.analysis_service_id,
        "matrix": spec.matrix,
        "rule_kind": spec.rule_kind,
        "min_value": str(spec.min_value) if spec.min_value is not None else None,
        "max_value": str(spec.max_value) if spec.max_value is not None else None,
        "equals_value": spec.equals_value,
        "unit": spec.unit,
        "display_override": spec.display_override,
        "active": spec.active,
    }


def record_spec_change(db: Session, spec, *, before: Optional[dict],
                       actor_user_id: Optional[int]) -> None:
    """Append the audit row for a spec write. `before` is a snapshot_spec()
    taken BEFORE mutation (None for creation); `actor_user_id` None means a
    system write (seed)."""
    from models import AuditLog

    db.add(AuditLog(
        operation="analysis_service_spec_changed",
        entity_type="analysis_service_spec",
        entity_id=str(spec.id),
        details={
            "before": before,
            "after": snapshot_spec(spec),
            "actor_user_id": actor_user_id,
        },
    ))
```

- [ ] **Step 4: Implement the seed**

Create `backend/catalog/service_spec_seed.py`:

```python
"""Seed analysis_service_specs to parity with COABuilder's BAKED_SPECS.

The five native rows, all matrix=NULL (NULL = every matrix — this is what
fixes the Bacteriostatic Water 422 for free). Values frozen at the
2026-08-03 BAKED_SPECS state; G-A gate: the lab confirms or replaces the
numbers before the combined deploy.

Idempotent: keyed on (service, matrix IS NULL, active); an existing active
row — including one the lab has edited — is never touched. The service is
resolved by keyword AT SEED TIME ONLY; the stored row holds the FK. Missing
services skip silently (a fresh DB may not carry the native services).
"""
import logging
from decimal import Decimal

from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

# keyword -> (rule_kind, min, max, equals, unit)
# STERILITY_USP71's unit is None ON PURPOSE: BAKED_SPECS carries no unit key
# for it; seeding one would newly arm the unit-divergence warning against
# the row unit "Pos/Neg".
_PARITY_SPECS = {
    "HM-PB": ("range", None, Decimal("0.5"), None, "ppm"),
    "HM-AS": ("range", None, Decimal("1.5"), None, "ppm"),
    "HM-CD": ("range", None, Decimal("0.5"), None, "ppm"),
    "HM-HG": ("range", None, Decimal("1.5"), None, "ppm"),
    "STERILITY_USP71": ("equals", None, None, "Not Detected", None),
}


def seed_service_specs(db: Session) -> int:
    from catalog.service_spec_audit import record_spec_change
    from models import AnalysisService, AnalysisServiceSpec

    created = 0
    for keyword, (kind, lo, hi, eq, unit) in _PARITY_SPECS.items():
        svc = (
            db.query(AnalysisService)
            .filter(AnalysisService.keyword == keyword,
                    AnalysisService.origin == "mk1")
            .one_or_none()
        )
        if svc is None:
            continue
        existing = (
            db.query(AnalysisServiceSpec)
            .filter(AnalysisServiceSpec.analysis_service_id == svc.id,
                    AnalysisServiceSpec.matrix.is_(None),
                    AnalysisServiceSpec.active.is_(True))
            .one_or_none()
        )
        if existing is not None:
            continue
        spec = AnalysisServiceSpec(
            analysis_service_id=svc.id, matrix=None, rule_kind=kind,
            min_value=lo, max_value=hi, equals_value=eq, unit=unit,
        )
        db.add(spec)
        db.flush()   # assign spec.id before the audit row references it
        record_spec_change(db, spec, before=None, actor_user_id=None)
        created += 1
    db.commit()
    if created:
        log.info("catalog.service_spec_seed created=%s", created)
    return created
```

- [ ] **Step 5: Wire the seed into boot**

In `backend/database.py` `init_db()`, directly after the `seed_vial_roles` try-block (line 150), matching the never-block-startup idiom:

```python
    try:
        from catalog.service_spec_seed import seed_service_specs
        with SessionLocal() as _db:
            seed_service_specs(_db)
    except Exception as e:  # never block startup
        log.warning("catalog_service_spec_seed_skipped err=%s", e)
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_service_spec_seed.py -q
```

Expected: 5 passed.

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership && git add backend/catalog/service_spec_audit.py backend/catalog/service_spec_seed.py backend/database.py backend/tests/test_service_spec_seed.py && git commit -m "feat(spec-ownership): parity seed + audited write path for service specs

Five native rows seeded matrix=NULL at BAKED_SPECS parity; every write
lands an analysis_service_spec_changed audit row with before/after/actor.
Slice 2's editor must reuse record_spec_change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Mk1 — `build_native_sections` fills the wire + rule-5 abort

**Files:**
- Modify: `backend/coa/native_sections.py` (rows assembly, lines 143-167; module docstring; new `_spec_wire_dict` helper)
- Modify: `backend/tests/test_native_sections.py` (helper + 2 stale assertions + new tests)

**Interfaces:**
- Consumes: `normalize_matrix`, `resolve_spec`, `evaluate`, `SpecRuleError` (Task 6); `parent.sample_type_title` (`models.py:981`, nullable — `None` normalizes to `None` and the NULL-matrix row resolves).
- Produces: each wire row's `specification` becomes `{"rule_kind", "equals", "min", "max", "unit", "display"}` (floats, `None`s preserved) and `conforms` becomes a bool — exactly the shape Task 3's `_validate_wire_spec` accepts. New rule 5: **a member service with no resolvable active spec aborts** via `NativeSectionsError`; an unappliable rule (unparseable numeric) also aborts. All four `main.py` call paths (`main.py:10154`, `10360`, `10929`, `19249`) already wrap `NativeSectionsError` → 502 / `success:false` — no endpoint change.

**Existing-test impact (deliberate, spec-sanctioned):** every current test in `test_native_sections.py` builds services without spec rows, so the new rule 5 would abort them. The helper gains default spec creation; `test_happy_path_document_shape`'s two `specification is None` / `conforms is None` assertions are updated to the filled shape. This is the one place the plan changes existing test expectations — the behavior change is the entire point of the spec and carries the user's sign-off via spec approval.

- [ ] **Step 1: Update the test helper and stale assertions, add the new failing tests**

In `backend/tests/test_native_sections.py`:

**1a.** Replace the `_mk_native_profile` helper (lines 11-29) with:

```python
def _mk_native_profile(db, *, key, services, archetype="limit_table",
                       title=None, sort=10, specs=True):
    """Profile with the given member services (list of (keyword, origin)).
    specs=True files a loose NULL-matrix range spec (max 100 ppm) per mk1
    member so rule 5 resolves; specs=False leaves services spec-less for
    the rule-5 abort tests."""
    from decimal import Decimal
    from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec,
                        analysis_profile_members)
    prof = AnalysisProfile(
        key=key, name=key.replace("_", " ").title(), is_addon=True,
        coa_archetype=archetype, coa_section_title=title, coa_sort_order=sort,
    )
    db.add(prof); db.flush()
    svcs = []
    for i, (kw, origin) in enumerate(services):
        svc = AnalysisService(title=kw.title(), keyword=kw, origin=origin, unit="ppm")
        db.add(svc); db.flush()
        db.execute(analysis_profile_members.insert().values(
            analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=i,
        ))
        if specs and origin == "mk1":
            db.add(AnalysisServiceSpec(
                analysis_service_id=svc.id, matrix=None, rule_kind="range",
                max_value=Decimal("100"), unit="ppm",
            ))
        svcs.append(svc)
    db.flush()
    return prof, svcs
```

**1b.** In `test_happy_path_document_shape`, replace the final assertion line (`assert row["specification"] is None and row["conforms"] is None`) with:

```python
    assert row["specification"] == {"rule_kind": "range", "equals": None,
                                    "min": None, "max": 100.0, "unit": "ppm",
                                    "display": None}
    assert row["conforms"] is True
```

**1c.** Append the new tests at the end of the file:

```python
# ── Spec-ownership slice 1: Mk1 fills the wire + rule 5 ─────────────────────

def _order_lookup(monkeypatch, key="heavy_metals"):
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {key: True}, "package": None},
    )


def test_out_of_range_result_conforms_false_but_builds(db_session, monkeypatch):
    """Non-conforming is a VERDICT, not an abort — the certificate prints
    Does Not Conform; only an unappliable rule aborts."""
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, result="999")
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    row = doc["sections"][0]["rows"][0]
    assert row["conforms"] is False
    assert row["specification"]["max"] == 100.0


def test_equals_spec_fills_and_verdicts(db_session, monkeypatch):
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="sterility_usp71",
                                    services=[("STERILITY_USP71", "mk1")],
                                    specs=False)
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix=None, rule_kind="equals",
        equals_value="Not Detected"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="Not Detected")
    _order_lookup(monkeypatch, key="sterility_usp71")
    doc = build_native_sections(db_session, parent)
    row = doc["sections"][0]["rows"][0]
    assert row["conforms"] is True
    assert row["specification"] == {"rule_kind": "equals",
                                    "equals": "Not Detected", "min": None,
                                    "max": None, "unit": None, "display": None}


def test_rule5_no_spec_aborts_naming_service_and_matrix(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    parent = _mk_parent_with_rows(db_session, svcs)
    _order_lookup(monkeypatch)
    with pytest.raises(NativeSectionsError, match="HM-PB.*no active spec"):
        build_native_sections(db_session, parent)


def test_rule5_inactive_spec_aborts(db_session, monkeypatch):
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    from decimal import Decimal
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix=None, rule_kind="range",
        max_value=Decimal("0.5"), active=False))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs)
    _order_lookup(monkeypatch)
    with pytest.raises(NativeSectionsError, match="no active spec"):
        build_native_sections(db_session, parent)


def test_unappliable_rule_aborts(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, result="N/A")
    _order_lookup(monkeypatch)
    with pytest.raises(NativeSectionsError, match="not numeric"):
        build_native_sections(db_session, parent)


def test_nan_result_aborts_fail_closed(db_session, monkeypatch):
    # The old COABuilder engine false-passed NaN; the producer now refuses.
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, result="nan")
    _order_lookup(monkeypatch)
    with pytest.raises(NativeSectionsError, match="non-finite"):
        build_native_sections(db_session, parent)


def test_matrix_specific_spec_beats_null(db_session, monkeypatch):
    from decimal import Decimal
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])  # NULL @ 100
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix="Bacteriostatic Water",
        rule_kind="range", max_value=Decimal("0.05"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.12")
    parent.sample_type_title = "Bacteriostatic Water"
    db_session.flush()
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    row = doc["sections"][0]["rows"][0]
    assert row["conforms"] is False          # judged by the BW row (0.05)
    assert row["specification"]["max"] == 0.05


def test_blend_matrix_resolves_peptide_spec(db_session, monkeypatch):
    from decimal import Decimal
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix="Peptide", rule_kind="range",
        max_value=Decimal("0.5"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.12")
    parent.sample_type_title = "Peptide Blend"
    db_session.flush()
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    assert doc["sections"][0]["rows"][0]["conforms"] is True


def test_null_sample_type_title_uses_null_matrix_spec(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs)   # sample_type_title None
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    assert doc["sections"][0]["rows"][0]["conforms"] is True
```

- [ ] **Step 2: Run the file to verify the expected failures**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_native_sections.py -q
```

Expected: the new tests fail (`specification` still `None`, rule-5 aborts DID NOT RAISE), and `test_happy_path_document_shape` fails on its updated assertion. The untouched rule-1/3/4 tests still pass.

- [ ] **Step 3: Implement the fill + abort**

In `backend/coa/native_sections.py`:

**3a.** Module docstring: change `(fail-closed rules 1-4)` wording in the class docstring at line 32 to `(fail-closed rules 1-5)` and append one sentence to the module docstring:

```python
Slice 1 of spec ownership (2026-08-03): Mk1 resolves the analysis_service_specs
rule per member row, fills specification (structured dict) + conforms, and
rule 5 — no resolvable active spec — aborts here at the producer.
```

**3b.** Add the import at the top with the other module imports:

```python
from coa.spec_rules import SpecRuleError, evaluate, normalize_matrix, resolve_spec
```

**3c.** Add the wire-dict helper below `_method_label`:

```python
def _spec_wire_dict(spec) -> dict:
    """The structured `specification` wire field. Floats (not Decimal) so the
    JSON is stable; display stays None unless the lab filed an override —
    COABuilder owns the formatting."""
    return {
        "rule_kind": spec.rule_kind,
        "equals": spec.equals_value,
        "min": float(spec.min_value) if spec.min_value is not None else None,
        "max": float(spec.max_value) if spec.max_value is not None else None,
        "unit": spec.unit,
        "display": spec.display_override,
    }
```

**3d.** In `build_native_sections`, after the `profiles = _ordered_native_profiles(...)` line (line 128), compute the matrix once:

```python
    matrix = normalize_matrix(parent.sample_type_title)
```

**3e.** Replace the row append block (lines 159-167, the `rows.append({...})` with `"specification": None`) with:

```python
            spec = resolve_spec(db, svc.id, matrix)
            if spec is None:
                # Rule 5 (relocated from COABuilder): a result must not print
                # without a verdict. Names the service AND matrix so the lab
                # knows exactly which analysis_service_specs row to file.
                raise NativeSectionsError(
                    f"native sections: profile '{prof.key}' member service "
                    f"'{svc.keyword}' (id={svc.id}) has no active spec for "
                    f"matrix {matrix!r} on {sample_id} — file one in "
                    f"analysis_service_specs"
                )
            try:
                conforms = evaluate(spec, row.result_value)
            except SpecRuleError as e:
                raise NativeSectionsError(
                    f"native sections: profile '{prof.key}' row "
                    f"'{svc.keyword}' on {sample_id}: {e.detail}"
                ) from e
            rows.append({
                "keyword": svc.keyword,
                "name": svc.title,
                "result": row.result_value,
                "unit": unit,
                "method": _method_label(db, row.method_id),
                "specification": _spec_wire_dict(spec),
                "conforms": conforms,
            })
```

- [ ] **Step 4: Run the file, then the full backend gate**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/test_native_sections.py tests/test_coa_sections_endpoint.py -q
```

Expected: all pass (`test_coa_sections_endpoint.py` mocks `build_native_sections` and proves the 502 paths are untouched).

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > /tmp/spec-own-now.txt; diff /c/tmp/Accu-Mk1-spec-ownership/.superpowers/sdd/2026-08-03-native-spec-ownership/baseline-failures.txt /tmp/spec-own-now.txt
```

Expected: empty diff (same pre-existing failure set as the Task-1 baseline; NEVER expect zero failures).

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership && git add backend/coa/native_sections.py backend/tests/test_native_sections.py && git commit -m "feat(spec-ownership): Mk1 fills specification/conforms; rule 5 aborts at the producer

build_native_sections resolves the analysis_service_specs rule per member
row (matrix from sample_type_title, Peptide Blend folds to Peptide, NULL
row is the fallback), evaluates fail-closed, and ships the structured spec
dict COABuilder now trusts. No endpoint change: all four call paths already
map NativeSectionsError to 502.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification, both repos

**Files:** none — gates only.

- [ ] **Step 1: COABuilder suite**

```bash
cd /c/tmp/coabuilder-spec-wire && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe" -m pytest tests/ -q --ignore=tests/test_native_sections_server.py
```

Expected: `1 failed, 174 passed` — exactly the one pre-existing `test_variance_page_4_analytes_vial1_from_parent` failure. (140 baseline + 16 wire + 18 parity = 174.) Any other failure = a regression this branch introduced; fix before proceeding.

- [ ] **Step 2: Mk1 backend gate (failure-set diff)**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership/backend && "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest tests/ -q 2>&1 | grep -E "^FAILED" | sed 's/ - .*//' | sort > /tmp/spec-own-final.txt; diff /c/tmp/Accu-Mk1-spec-ownership/.superpowers/sdd/2026-08-03-native-spec-ownership/baseline-failures.txt /tmp/spec-own-final.txt && echo GATE-GREEN
```

Expected: `GATE-GREEN` (empty diff).

- [ ] **Step 3: Working-tree hygiene**

```bash
git -C /c/tmp/coabuilder-spec-wire status --porcelain    # ONLY logs/coabuilder.log may show; restore it
git -C /c/tmp/coabuilder-spec-wire checkout -- logs/coabuilder.log
git -C /c/tmp/Accu-Mk1-spec-ownership status --porcelain # expect clean (baseline .txt files are inside .superpowers — if untracked, leave them)
```

---

### Task 10: Push + PRs

**Files:** none.

Both PRs stack on the open program PRs and attach to the ONE combined deploy window — say so in each body. Deploy order within the window: COABuilder → Mk1.

- [ ] **Step 1: Push both branches**

```bash
git -C /c/tmp/Accu-Mk1-spec-ownership push -u origin feat/native-spec-ownership
git -C /c/tmp/coabuilder-spec-wire push -u origin feat/native-spec-wire
```

- [ ] **Step 2: Open the PRs**

```bash
cd /c/tmp/Accu-Mk1-spec-ownership && gh pr create --base feat/catalog-driven-bench --title "Native spec ownership (slice 1): lab-owned specs + producer-side verdicts" --body "Implements docs/superpowers/specs/2026-08-03-native-spec-ownership-design.md, slice 1 (Mk1 half).

- analysis_service_specs table (one active spec per service+matrix, NULL matrix = all, CHECK-enforced rule shape) via boot DDL + model
- coa/spec_rules.py: resolver (exact matrix -> NULL fallback) + fail-closed evaluator (inclusive bounds, case-insensitive equals; NaN/inf now abort instead of false-passing)
- build_native_sections fills specification (structured dict) + conforms; rule 5 (no resolvable spec) aborts at the producer
- Parity seed of the five native rows at BAKED_SPECS values; every spec write lands an audit row (before/after/actor)
- Cross-repo parity table byte-identical to coabuilder tests/test_verdict_parity.py

Stacks on #91. Companion: coabuilder feat/native-spec-wire (must DEPLOY first — old COABuilder renders a dict specification as garbage). Attaches to the ONE combined deploy window; no independent deploy. Rollback = revert the Mk1 image (COABuilder's baked fallback stays until slice 3).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

```bash
cd /c/tmp/coabuilder-spec-wire && gh pr create --base feat/catalog-order-routing --title "Native spec wire (slice 1): trust Mk1-filled specification/conforms" --body "Implements docs/superpowers/specs/2026-08-03-native-spec-ownership-design.md, slice 1 (COABuilder half).

- attach_native_sections: a dict specification is validated fail-closed and trusted verbatim (display formatted here, nothing re-evaluated); specification=None keeps the baked path byte-identical — the rollback path, deleted only in slice 3
- _format_spec_display: structured bounds -> display string (parity with today's baked displays); lab display override wins
- tests/test_verdict_parity.py pins the OLD engine including its NaN/-inf false-pass — the cross-repo parity table's twin lives in Mk1 backend/tests/test_spec_rules.py

Stacks on #6. Companion: Accu-Mk1 feat/native-spec-ownership. This half DEPLOYS FIRST in the combined window (tolerance before producer). No renderer, template, or pagination change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 11: s3rehe rehearsal (agent-run UAT — the spec's load-bearing rollout check)

**Files:** none local — devbox stack `s3rehe` only (all state reversible test data).

Rehearses the migration end-to-end: regenerate P-0141's certificate on the new code and diff the verdicts against the known-good `AH5F-2QSD` generation. Stack facts: `forrestparker@100.73.137.3`, Mk1 backend :5770 (login `forrest@valenceanalytical.com` / `s3rehe-uat`), postgres container `accumark-s3rehe-postgres` (dbs `accumark_mk1`, `accumark_integration`), both repos bind-mounted from `~/worktrees/*-s3rehe` (no file-watch — restart containers after git ops).

- [ ] **Step 1: Check out the new branches on the devbox worktrees and restart**

```bash
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/coabuilder-s3rehe fetch && git -C ~/worktrees/coabuilder-s3rehe checkout feat/native-spec-wire && git -C ~/worktrees/Accu-Mk1-s3rehe fetch && git -C ~/worktrees/Accu-Mk1-s3rehe checkout feat/native-spec-ownership && docker restart accumark-s3rehe-coabuilder accumark-s3rehe-accu-mk1-backend'
```

(COABuilder first mirrors the deploy order; a single stack restart covers both here.)

- [ ] **Step 2: Verify the boot seed landed**

Mk1 suppresses `logger.info` — verify via DB, never logs:

```bash
ssh forrestparker@100.73.137.3 "docker exec -i accumark-s3rehe-postgres psql -U postgres -d accumark_mk1" <<'SQL'
select s.keyword, p.rule_kind, p.min_value, p.max_value, p.equals_value, p.unit, p.matrix, p.active
from analysis_service_specs p join analysis_services s on s.id = p.analysis_service_id
order by s.keyword;
select count(*) from audit_logs where operation = 'analysis_service_spec_changed';
SQL
```

Expected: 5 rows (4 range HM rows @ 0.5/1.5/0.5/1.5 ppm, matrix NULL; STERILITY_USP71 equals `Not Detected`, unit NULL) and audit count 5.

- [ ] **Step 3: Regenerate P-0141's COA and compare**

P-0141's variance set is deliberately UNLOCKED (spec-4 UAT state). Lock → generate → **unlock, always, even on failure** (the Handler's in-flight UAT state must be restored). The Mk1 backend has MIXED route prefixes — confirm real paths against `curl -s http://localhost:5770/openapi.json` before calling (the variance-set routes were `POST /api/sub-samples/P-0141/variance-set/lock` and `.../unlock` last session; the primary-COA generation route is the one the FE calls — find it under `/api` in openapi.json, authenticated with the login above).

Compare the fresh certificate against generation `AH5F-2QSD` (the known-good post-fix cert from 2026-08-03): page 4 must show all four heavy metals `Conforms`, Sterility USP<71> `Not Detected` → `Conforms`, badge `PASSED` — identical verdicts, now produced by Mk1 instead of baked specs.

- [ ] **Step 4: Verify the applied-rule audit record rode into coa_data**

```bash
ssh forrestparker@100.73.137.3 "docker exec -i accumark-s3rehe-postgres psql -U postgres -d accumark_integration" <<'SQL'
select verification_code,
       jsonb_path_query_first(coa_data::jsonb, '$.native_sections.sections[0].rows[0].specification') as first_spec
from coa_generations
where coa_data::text like '%rule_kind%'
order by id desc limit 3;
SQL
```

Expected: the newest generation's `specification` is the structured dict (`{"rule_kind": "range", ...}`) — the machine-readable applied rule now persists per certificate. (If the JSON path differs, inspect `coa_data` keys first; the point is: structured dict present in the persisted payload.)

- [ ] **Step 5: Restore stack state + report**

Confirm `variance_locked_at` is NULL again on P-0141 (unlock in Step 3):

```bash
ssh forrestparker@100.73.137.3 "docker exec -i accumark-s3rehe-postgres psql -U postgres -d accumark_mk1" <<'SQL'
select sample_id, variance_locked_at from lims_samples where sample_id = 'P-0141';
SQL
```

Report the before/after verdict comparison in the final summary. Leave the devbox worktrees on the new branches (they're strict supersets of the PR-#91/#6 branches) and note that in the report.

---

## Explicitly NOT in this plan (spec-scoped exclusions)

- **Slice 2** — admin spec editor UI (must surface `result_options` beside `equals_value`; reuses `record_spec_change`).
- **Slice 3** — deleting the five native `BAKED_SPECS` rows + the fallback branch (only after slice 1 lives in production).
- **Slice 4** — publish-time snapshot (own spec).
- Unit-divergence fail-closed tightening (open question 2 — production-behavior change, needs sign-off; warn-and-render preserved).
- Customer-facing matrix field (deferred to the commercial-layer program; must reach the resolver via a lab-owned mapping only).
- `TEST_TECHNIQUES` migration (display concern; follow-up candidate for `analysis_services.category`).
- The `main.py:9734` `verify=False` WooCommerce TLS finding (independent; fix on its own merits).
