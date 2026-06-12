# COA Identity-Gated N/A — Implementation Plan (Spec 1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When an analyte's identity does not conform, its purity and quantity render `N/A` (neutral) on both the PDF and the digital/verify COA.

**Architecture:** All gating lives in COABuilder's `ConformanceEngine` (single source for both surfaces); the wpstar verify template gains a neutral N/A badge.

**Spec:** `docs/superpowers/specs/2026-06-12-coa-identity-gated-na-design.md`

**Worktrees:**
- COABuilder: `C:/tmp/coabuilder-variance` (branch `feat/coa-identity-na-variance`).
- wpstar theme: `//wsl.localhost/docker-desktop-data/data/docker/volumes/DevKinsta/public/accumarklabs/wp-content/themes/wpstar` (live plugin tree; tracked per the accumarklabs custom-code memory — commit via that repo's normal flow, not here).

**Test runner (COABuilder):** `python -m pytest tests/<file> -v` or standalone `python tests/<file>`; `tests/` add `src/` to `sys.path` (no install). Use the system python on PATH.

---

### Task 1: COABuilder — identity-gated N/A in the engine (TDD)

**Files:**
- Modify: `src/coabuilder_core/conformance.py`
- Test: `tests/test_identity_fail_na.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_identity_fail_na.py`:

```python
"""Identity-gated N/A: when an analyte's identity does not conform, its purity
and quantity cells render N/A (neutral), not a measured/variance value.
Standalone — adds src/ to sys.path, no install."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from coabuilder_core.conformance import ConformanceEngine  # noqa: E402


def _single_peptide_json(identity_result, purity_val="82.4", qty="9.8"):
    """Minimal SENAITE-shaped json: one declared peptide (BPC-157) with an
    identity, purity, and quantity analysis. identity_result drives conformance."""
    return {
        "ClientSampleID": "CS-1",
        "id": "P-9001",
        "Analyte1Peptide": "BPC-157 - Identity (HPLC)",
        "_Analyses_Detailed": [
            {"Title": "BPC-157 - Identity (HPLC)", "Keyword": "ANALYTE-1-ID",
             "getKeyword": "ANALYTE-1-ID", "Result": identity_result,
             "review_state": "verified"},
            {"Title": "Purity", "Keyword": "ANALYTE-1-PUR",
             "getKeyword": "ANALYTE-1-PUR", "Result": purity_val,
             "review_state": "verified"},
            {"Title": "Quantity", "Keyword": "PEPT-Total",
             "getKeyword": "PEPT-Total", "Result": qty, "Unit": "mg",
             "review_state": "verified"},
        ],
        "Analyses": [],
    }


def _row(table, test_type):
    return next((r for r in table if r["test_type"] == test_type), None)


class TestIdentityGatedNA(unittest.TestCase):
    def test_identity_fail_blanks_purity_and_quantity(self):
        out = ConformanceEngine().process(_single_peptide_json("Out of Spec"))
        table = out["results_table"]
        pur = _row(table, "PURITY")
        qty = _row(table, "QUANTITY")
        self.assertEqual(pur["result"], "N/A")
        self.assertEqual(pur["status"], "N/A")
        self.assertIsNone(pur["conforms"])
        self.assertEqual(qty["result"], "N/A")
        self.assertEqual(qty["status"], "N/A")
        self.assertIsNone(qty["conforms"])

    def test_identity_pass_leaves_values(self):
        out = ConformanceEngine().process(_single_peptide_json("BPC-157"))
        table = out["results_table"]
        pur = _row(table, "PURITY")
        qty = _row(table, "QUANTITY")
        self.assertNotEqual(pur["result"], "N/A")
        self.assertIn("82.4", pur["result"])
        self.assertNotEqual(qty["result"], "N/A")
        self.assertIn("9.8", qty["result"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test — expect the fail test to fail**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_identity_fail_na.py
```
Expected: `test_identity_fail_blanks_purity_and_quantity` FAILS (purity/qty still show values); `test_identity_pass_leaves_values` passes.

- [ ] **Step 3: Add the helper + constant**

In `src/coabuilder_core/conformance.py`, just below the `logger = ...` line near the top, add:

```python
_NA_COLOR = "#6B7280"  # neutral grey — distinct from #444F5B out-of-spec slate


def _na_if_identity_fails(row: dict, is_match: bool) -> dict:
    """When identity doesn't conform, blank the dependent numeric result to N/A
    (neutral). Purity/quantity are meaningless if the sample isn't the declared
    peptide. Returns the row for inline use."""
    if not is_match:
        row["result"] = "N/A"
        row["status"] = "N/A"
        row["conforms"] = None
        row["status_color"] = _NA_COLOR
        row["delta_pct"] = ""
    return row
```

- [ ] **Step 4: Apply to the quantity row**

Replace the B.2 quantity `results_table.append({...})` (the dict with
`"test_type": "QUANTITY"`, `"specification": "MEASURE"`) with the same dict wrapped:

```python
            results_table.append(_na_if_identity_fails({
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
            }, is_match))
```

- [ ] **Step 5: Apply to the purity row**

Replace the B.3 purity `results_table.append({...})` (dict with
`"test_type": "PURITY"`) with:

```python
                results_table.append(_na_if_identity_fails({
                    "test_name": f"{display_name} - Purity",
                    "analyte_name": display_name,
                    "peptide_name": peptide_name,
                    "test_type": "PURITY",
                    "specification": p_spec_str,
                    "result": f"{p_val}%" if p_val is not None else "",
                    "status": p_status,
                    "conforms": p_conforms,
                    "status_color": p_status_color,
                    "unit": "%"
                }, is_match))
```

- [ ] **Step 6: Run the test — expect pass**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_identity_fail_na.py
```
Expected: both tests PASS.

- [ ] **Step 7: Regression — existing engine tests still pass**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_addon_parsing.py && python tests/test_generic_page2_layout.py
```
Expected: OK for both.

- [ ] **Step 8: Commit**

```bash
cd C:/tmp/coabuilder-variance && git add src/coabuilder_core/conformance.py tests/test_identity_fail_na.py && git commit -m "feat(coa): identity-gated N/A for purity & quantity"
```

---

### Task 2: COABuilder — blend per-analyte coverage test

**Files:**
- Test: `tests/test_identity_fail_na.py` (extend)

- [ ] **Step 1: Add a blend test**

Append to `TestIdentityGatedNA` in `tests/test_identity_fail_na.py`:

```python
    def test_blend_one_component_identity_fail_isolated(self):
        j = {
            "ClientSampleID": "CS-2",
            "id": "PB-9002",
            "Analyte1Peptide": "BPC-157 - Identity (HPLC)",
            "Analyte2Peptide": "TB-500 - Identity (HPLC)",
            "_Analyses_Detailed": [
                {"Title": "BPC-157 - Identity (HPLC)", "getKeyword": "ANALYTE-1-ID",
                 "Result": "BPC-157", "review_state": "verified"},
                {"getKeyword": "ANALYTE-1-PUR", "Result": "99.0", "review_state": "verified"},
                {"getKeyword": "ANALYTE-1-QTY", "Result": "5.0", "Unit": "mg", "review_state": "verified"},
                {"Title": "TB-500 - Identity (HPLC)", "getKeyword": "ANALYTE-2-ID",
                 "Result": "Out of Spec", "review_state": "verified"},
                {"getKeyword": "ANALYTE-2-PUR", "Result": "70.0", "review_state": "verified"},
                {"getKeyword": "ANALYTE-2-QTY", "Result": "4.0", "Unit": "mg", "review_state": "verified"},
            ],
            "Analyses": [],
        }
        table = ConformanceEngine().process(j)["results_table"]
        # BPC-157 (passing identity) keeps its purity; TB-500 (failing) is N/A.
        bpc_pur = next(r for r in table if r["test_type"] == "PURITY" and r["peptide_name"] == "BPC-157")
        tb_pur = next(r for r in table if r["test_type"] == "PURITY" and r["peptide_name"] == "TB-500")
        self.assertNotEqual(bpc_pur["result"], "N/A")
        self.assertEqual(tb_pur["result"], "N/A")
```

- [ ] **Step 2: Run it**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_identity_fail_na.py
```
Expected: all PASS. (If the blend fixture's slot/keyword shape doesn't resolve as expected, adjust the fixture keywords to match `_extract_accumark_fields` expectations — the production shape uses `AnalyteNPeptide` titles, already provided.)

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/coabuilder-variance && git add tests/test_identity_fail_na.py && git commit -m "test(coa): blend per-analyte identity-N/A isolation"
```

---

### Task 3: COABuilder — version bump + changelog

**Files:**
- Modify: `src/coabuilder_core/__init__.py`, `CHANGELOG.md`

- [ ] **Step 1: Bump version**

In `src/coabuilder_core/__init__.py` change `__version__ = "2.14.8"` → `__version__ = "2.15.0"`.

- [ ] **Step 2: Changelog entry**

Prepend under the title in `CHANGELOG.md`:

```markdown
## [2.15.0] - 2026-06-12

### Added

- **Identity-gated N/A.** When an analyte's identity does not conform, its purity
  and quantity now render `N/A` (neutral grey badge) instead of a measured/variance
  value — the measurements are meaningless when the sample isn't the declared
  peptide. Applies on both the PDF and the digital/verify COA (single-source via
  `ConformanceEngine` → `CoAData.results`). Covers single-peptide and blend
  per-analyte rows; blend-level totals unchanged. ([conformance.py](src/coabuilder_core/conformance.py)) Test-first via `tests/test_identity_fail_na.py`.

---
```

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/coabuilder-variance && git add src/coabuilder_core/__init__.py CHANGELOG.md && git commit -m "chore(coa): bump 2.15.0 — identity-gated N/A"
```

---

### Task 4: wpstar theme — neutral N/A badge

**Files (live theme tree):**
- Modify: `templates/accuverify-content.php` (3 badge blocks)
- Modify: `css/accuverify.css`

Base dir: `//wsl.localhost/docker-desktop-data/data/docker/volumes/DevKinsta/public/accumarklabs/wp-content/themes/wpstar`

- [ ] **Step 1: Add the N/A badge branch in all three blocks**

In `templates/accuverify-content.php`, each of the three badge selections has:

```php
                                            } elseif (strpos($status_text, 'measured') !== false) {
                                                $badge_class = 'measured'; $badge_label = 'Measured';
                                            } elseif ($conforms === false) {
```

Insert an N/A branch between the `measured` and `conforms === false` branches (all three sites — the third uses `$result` not `$test`, keep its variable):

```php
                                            } elseif (strpos($status_text, 'n/a') !== false) {
                                                $badge_class = 'na'; $badge_label = 'N/A';
```

(The third block at ~L262 reads `$status_text = strtolower($result['status'] ?? 'pass');` — `$status_text` is local, so the same `strpos($status_text, 'n/a')` line works unchanged.)

- [ ] **Step 2: Add the `.na` CSS**

In `css/accuverify.css`, after the `.status-badge.out-of-spec svg { ... }` rule, add:

```css
.accuverify-page .status-badge.na {
    background: #f3f4f6;
    color: #6B7280;
    font-weight: 400;
}

.accuverify-page .status-badge.na svg {
    stroke: #6B7280;
}
```

- [ ] **Step 3: Verify edits in place**

Grep both files to confirm the `na` branch appears 3× and the CSS class once:

```bash
grep -c "badge_class = 'na'" "<base>/templates/accuverify-content.php"   # expect 3
grep -c "status-badge.na" "<base>/css/accuverify.css"                    # expect 2
```

- [ ] **Step 4: Commit (accumarklabs repo flow)**

The accumarklabs theme is version-controlled separately (custom code tracked per the WP memory). Stage and commit `templates/accuverify-content.php` and `css/accuverify.css` there with message:
`feat(verify): neutral N/A badge for identity-gated purity/quantity`. If that tree is not a git repo in this environment, leave the edits in place and note them for the deploy step (the file edits ARE the deliverable for the live theme).

---

### Task 5: Cross-surface verification

- [ ] **Step 1: Engine emits N/A end to end (unit-level proof already covers PDF data).** Confirm the digital `coa_data` serialization carries it: `_build_coa_data_json` copies `result`/`status`/`conforms` verbatim, so an N/A engine row → `coa_data` N/A. No code change; note as verified by reading `scripts/server.py:_result_to_dict`.

- [ ] **Step 2: Hand the Handler a live UAT (post-deploy):**
  1. Pick/seed a sample whose identity does not conform.
  2. Generate its COA. PDF purity & quantity cells read `N/A`, not a value/variance.
  3. Open the verify page for its code — same rows show `N/A` with a grey neutral badge (not red out-of-spec, not green conforms).
  4. A conforming sample is unchanged on both surfaces.

---

## Self-review

- Spec coverage: engine gating (T1), blend isolation (T2), version/changelog (T3), verify-page badge + CSS (T4), cross-surface (T5). All spec sections mapped.
- Types: `_na_if_identity_fails(row: dict, is_match: bool) -> dict` used at both call sites with the in-scope `is_match`. `_NA_COLOR` defined once.
- No placeholders. wpstar commit step is conditional on repo availability (documented), not a gap — the file edits are the deliverable regardless.
