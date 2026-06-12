# Customer Variance Report Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A customer-facing Variance Report page (C-then-B layout) reached from an order-page button, rendering each variance analyte's replicate spread from data pushed down the COA-publish rail.

**Architecture:** COABuilder assembles a compact `variance_report` block in `coa_data` → IS forwards it on the notify payload → WP stores it in `_accumark_coas[sample_id]` → a new WP page (shortcode) renders C-then-B as server-side SVG. Push rail, same as Lab Remarks.

**Spec:** `docs/superpowers/specs/2026-06-12-variance-report-page-design.md`

**Design source (visual truth):** `C:/tmp/variance-design/accumark-labs-design-system/project/templates/variance-report/` — `comps.jsx` (CompC ~L138, CompB ~L97) and `varicharts.jsx` (stats L21, RangeStrip L50, RadialGauge L95, Sparkline L118). Match SVG output, not JS structure.

**Repos / worktrees:**
| Repo | Path | Branch |
|---|---|---|
| COABuilder | `C:/tmp/coabuilder-variance` | `feat/coa-identity-na-variance` (at 2.17.0) |
| Integration Service | `…/Accumark-Workspace/integration-service` | `feat/variance-services-map` |
| wpstar theme | `//wsl.localhost/.../accumarklabs/wp-content/themes/wpstar` | accumarklabs repo |

**Test runners:** COABuilder `python tests/<f>` (src/ on sys.path). IS `.venv/Scripts/python.exe -m pytest`. WP `php -l` via `docker exec accumark-subvial-wordpress sh -c 'cd /var/www/html/wp-content/themes/wpstar && php -l <f>'`.

**Brand tokens:** `#2ABFC4` primary, `#1B4B8C` navy, `#FF6B5B` coral, `#10B981` success, `#F5F8FA` bg, `#2D3748` text, `#8896A6` muted, `#E2E8F0` border. Fonts Poppins / Open Sans / JetBrains Mono.

---

### Task 1: COABuilder — build_variance_report (TDD)

**Files:** Modify `src/coabuilder_core/conformance.py`; Test `tests/test_variance_report.py` (create)

- [ ] **Step 1: Failing test**

```python
"""build_variance_report: customer-tone per-test replicate block for the
Variance Report page. Numeric values (primary first, then variance vials),
spec/domain/status server-authored, identity as match-count. {} when no test
has replicates."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from coabuilder_core.conformance import ConformanceEngine

def _json(identity="BPC-157", purity="98.25"):
    return {"ClientSampleID": "CS-1", "id": "P-0500",
        "Analyte1Peptide": "BPC-157 - Identity (HPLC)",
        "_Analyses_Detailed": [
            {"Title": "BPC-157 - Identity (HPLC)", "getKeyword": "ANALYTE-1-ID", "Result": identity, "review_state": "verified"},
            {"getKeyword": "ANALYTE-1-PUR", "Result": purity, "review_state": "verified"},
            {"getKeyword": "PEPT-Total", "Result": "10.0", "Unit": "mg", "review_state": "verified"}],
        "Analyses": []}

def _reps(v3id="BPC-157"):
    return {"BPC-157": [
        {"vial_sequence": 2, "PURITY": "99.1%", "QUANTITY": "10.1 mg", "IDENTITY": "BPC-157"},
        {"vial_sequence": 3, "PURITY": "97.21%", "QUANTITY": "9.9 mg", "IDENTITY": v3id}]}

class TestVarianceReport(unittest.TestCase):
    def _report(self, **kw):
        return ConformanceEngine().process(_json(**{k: v for k, v in kw.items() if k in ("identity", "purity")}),
                                           variance_replicates=_reps(kw.get("v3id", "BPC-157")))["variance_report"]

    def test_empty_without_replicates(self):
        out = ConformanceEngine().process(_json())["variance_report"]
        self.assertEqual(out, {})

    def test_purity_test_values_primary_first(self):
        rep = self._report()
        pur = next(t for t in rep["tests"] if t["key"].startswith("purity"))
        self.assertEqual(pur["values"], [98.25, 99.1, 97.21])  # primary, vial2, vial3
        self.assertEqual(pur["spec_min"], 98.0)
        self.assertFalse(pur["qualitative"])

    def test_status_is_customer_tone(self):
        rep = self._report()
        pur = next(t for t in rep["tests"] if t["key"].startswith("purity"))
        self.assertIn(pur["status"], ("Conforms", "Does Not Conform"))
        self.assertNotIn("Investigate", [t["status"] for t in rep["tests"]])

    def test_out_of_spec_value_marks_not_conform(self):
        # vial3 purity 97.21 < 98 spec_min → test does not conform
        rep = self._report()
        pur = next(t for t in rep["tests"] if t["key"].startswith("purity"))
        self.assertFalse(pur["conforms"])
        self.assertEqual(pur["status"], "Does Not Conform")

    def test_identity_is_qualitative_match_count(self):
        rep = self._report(v3id="Out of Spec")
        idt = next(t for t in rep["tests"] if t["qualitative"])
        self.assertEqual(idt["match_count"], 2)
        self.assertEqual(idt["total"], 3)

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run — expect KeyError (`variance_report` absent)**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_variance_report.py
```

- [ ] **Step 3: Implement the builder + numeric parse helper**

In `conformance.py`, near the other variance helpers, add:

```python
import re as _re

def _num(s):
    """Parse a numeric value out of a formatted replicate string ('99.1%',
    '10.1 mg', '98.25'). Returns float or None."""
    if s is None:
        return None
    m = _re.search(r"-?\d+(?:\.\d+)?", str(s))
    return float(m.group()) if m else None
```

The engine collects report entries during the per-analyte loop. At the top of
`process` (next to `reps = variance_replicates or {}`), add
`variance_report_tests = []`. In the per-analyte loop, when `reps.get(peptide_name)`
exists, append one entry per test type:

- **Purity** (in the B.3 branch, when `_pur_series is not None`):
```python
                _vals = [v for v in [_num(_pur_primary)] + [_num(r.get("PURITY")) for r in reps[peptide_name]] if v is not None]
                if len(_vals) >= 2:
                    _ok = all((v >= spec_limit) for v in _vals)
                    variance_report_tests.append({
                        "key": f"purity-{peptide_name}", "name": f"{display_name} Purity",
                        "method": "HPLC", "unit": "%", "qualitative": False,
                        "spec_text": p_spec_str, "spec_min": spec_limit, "spec_max": None,
                        "domain": _domain(_vals, spec_limit, None),
                        "values": _vals, "conforms": _ok,
                        "status": "Conforms" if _ok else "Does Not Conform"})
```
- **Quantity** (in B.2, when `_qty_series is not None`): informational (no spec
  conformance — quantity is MEASURED). `spec_min/max=None`, `conforms=True`,
  `status="Measured"`, parse `_num(qty_res_str)` + vials' `QUANTITY`. unit from
  `meas_qty_data["unit"]`.
- **Identity** (in B.1, when `_id_summary is not None`): `qualitative=True`,
  `values` = `[id_val] + [r.get("IDENTITY") for r in reps[peptide_name] if "IDENTITY" in r]`,
  `match_count` = count where `_identity_matches(v, peptide_name)`, `total` = len,
  `conforms` = match_count==total, status Conforms/Does Not Conform.

Add the domain helper:
```python
def _domain(vals, spec_min, spec_max):
    """Axis range padded ~15% beyond the data and any spec edge."""
    pts = [v for v in vals if v is not None] + [s for s in (spec_min, spec_max) if s is not None]
    lo, hi = min(pts), max(pts)
    pad = (hi - lo) * 0.15 or (abs(hi) * 0.02 or 1)
    return [round(lo - pad, 3), round(hi + pad, 3)]
```

After the loop, in the return dict's assembly path, expose:
```python
        "variance_report": ({"sample": {"name": ..., "lot": meta.get("lot_code", "")}, "tests": variance_report_tests}
                            if variance_report_tests else {}),
```
(Use the same sample name source as elsewhere in `process`; if not readily in
scope, `{}`-safe defaults are fine — WP re-derives the header from order data.)

- [ ] **Step 4: Run — expect pass**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_variance_report.py
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/coabuilder-variance && git add src/coabuilder_core/conformance.py tests/test_variance_report.py && git commit -m "feat(coa): build_variance_report — customer-tone replicate block"
```

---

### Task 2: COABuilder — emit into coa_data + version bump

**Files:** `src/coabuilder_core/data_model.py`, `src/coabuilder_core/senaite_client.py`, `scripts/server.py`, `__init__.py`, `CHANGELOG.md`

- [ ] **Step 1:** `CoAData` gains `variance_report: dict = field(default_factory=dict)` (next to `lab_remarks`).
- [ ] **Step 2:** In `conformance.py` `process`, the returned `processed_data` already has `variance_report` (Task 1). In `senaite_client.py`, after mapping results, set `coa.variance_report = processed_data.get("variance_report", {})`.
- [ ] **Step 3:** In `scripts/server.py` `_build_coa_data_json`, add to the return dict: `"variance_report": getattr(data, "variance_report", {}) or {},`.
- [ ] **Step 4:** Bump `__version__` to `2.18.0`; CHANGELOG entry:

```markdown
## [2.18.0] - 2026-06-12

### Added

- **Variance report data in coa_data.** When variance replicates are present,
  COABuilder emits a customer-tone `variance_report` block (per analyte: numeric
  replicate values primary-first, spec/domain, conformance status as
  "Conforms"/"Does Not Conform"; identity as match-count). Powers the new
  customer Variance Report page. Not rendered on the PDF. Test:
  `tests/test_variance_report.py`.

---
```

- [ ] **Step 5: Run full COABuilder regression + commit**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_variance_report.py && python tests/test_lab_remarks_gate.py && python tests/test_variance_series_render.py && python tests/test_identity_fail_na.py && python tests/test_addon_parsing.py
```
Expected: all OK.

```bash
git add src/coabuilder_core/data_model.py src/coabuilder_core/senaite_client.py scripts/server.py src/coabuilder_core/__init__.py CHANGELOG.md && git commit -m "feat(coa): expose variance_report in coa_data (2.18.0)"
```

---

### Task 3: Integration Service — payload passthrough (TDD)

**Files:** `app/adapters/wordpress.py`, `app/services/ingestion.py`, `app/api/desktop.py`, `app/api/webhook.py`; Test `tests/test_variance_report_payload.py`

> **Per the IS repo's CLAUDE.md:** run `gitnexus_impact({target:"COANotificationPayload", direction:"upstream"})` before editing and `gitnexus_detect_changes()` before committing. (Known HIGH risk — payload is a hub; scope is the same 4 files as the lab_remarks passthrough.)

- [ ] **Step 1: Test**

```python
from app.adapters.wordpress import COANotificationPayload
def test_variance_report_in_to_dict_when_set():
    p = COANotificationPayload(sample_id="P-0500", coa_version=1, s3_key="k",
        variance_report={"tests": [{"key": "purity-BPC-157"}]})
    assert p.to_dict()["variance_report"]["tests"][0]["key"] == "purity-BPC-157"
def test_variance_report_absent_when_unset():
    assert "variance_report" not in COANotificationPayload(sample_id="P", coa_version=1, s3_key="k").to_dict()
```

- [ ] **Step 2:** `COANotificationPayload.variance_report: dict | None = None`; in `to_dict()` `if self.variance_report: payload["variance_report"] = self.variance_report`.
- [ ] **Step 3:** In all three publish paths, alongside the `lab_remarks` extraction, add `variance_report = (coa_data.get("variance_report") or None)` and pass `variance_report=variance_report` to the constructor. (ingestion.py: in the generation-lookup block; desktop.py + webhook.py: in the `published`/`child` coa_data blocks.)
- [ ] **Step 4: Run + detect_changes + commit**

```bash
cd …/integration-service && .venv/Scripts/python.exe -m pytest tests/test_variance_report_payload.py -q
```

```bash
git add app/adapters/wordpress.py app/services/ingestion.py app/api/desktop.py app/api/webhook.py tests/test_variance_report_payload.py && git commit -m "feat(coa): variance_report passthrough on COA notify payload"
```

---

### Task 4: WordPress — store + order-page button

**Files:** `src/Api/COAEndpoint.php`, `templates/portal-view-order.php`

- [ ] **Step 1:** In the `/coa/notify` callback, extract `$variance_report = is_array($data['variance_report'] ?? null) ? $data['variance_report'] : [];` and thread it into `handle_primary_coa_notification(...)` (new trailing param), storing `'variance_report' => $variance_report` in the `_accumark_coas[$sample_id]` entry (alongside `lab_remarks`).
- [ ] **Step 2:** In `portal-view-order.php`, in the first COA row loop, after the Lab Remarks cell, add a Variance Report button (primary rows only, when non-empty):

```php
                                                    <?php
                                                    $dl_variance = $coa_dl['variance_report'] ?? [];
                                                    if (!$dl_is_additional && !empty($dl_variance['tests'])):
                                                        $dl_vr_url = add_query_arg([
                                                            'order'  => $order->get_id(),
                                                            'sample' => ($coa_dl['sample_id'] ?? ''),
                                                            'nonce'  => wp_create_nonce('variance_report_' . $order->get_id() . '_' . ($coa_dl['sample_id'] ?? '')),
                                                        ], home_url('/variance-report/')); ?>
                                                    <div class="coa-popup-cell">
                                                        <a href="<?php echo esc_url($dl_vr_url); ?>" class="coa-variance-btn" target="_blank" rel="noopener">
                                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>
                                                            <?php esc_html_e('Variance Report', 'wpstar'); ?>
                                                        </a>
                                                    </div>
                                                    <?php endif; ?>
```

CSS for `.coa-variance-btn` in `css/portal.css` — mirror `.coa-remarks-btn`.

- [ ] **Step 3:** `php -l` both files; commit in accumarklabs repo:
`feat(coa): store variance_report from notify + order-page button`

---

### Task 5: WordPress — the Variance Report page

**Files (create):** `src/Front/VarianceReport.php`, `templates/variance-report-content.php`, `css/variance-report.css`. **Modify:** `src/Theme.php` (register), and create a WP page holding the shortcode (or render via the front controller).

- [ ] **Step 1: Front controller (shortcode pattern, mirrors VerifyCOA).**
Create `src/Front/VarianceReport.php`: a class with `init()` that registers a
`[accumarkVarianceReport]` shortcode. The shortcode handler:
  1. Reads `$_GET['order']`, `$_GET['sample']`, `$_GET['nonce']`.
  2. `wp_verify_nonce($nonce, 'variance_report_' . $order_id . '_' . $sample_id)` → else "Invalid link."
  3. `$order = wc_get_order($order_id)`; verify `$order->get_customer_id() === get_current_user_id() || current_user_can('manage_woocommerce')` → else "Access denied." (mirrors the COA download check in COAEndpoint.)
  4. `$coas = $order->get_meta('_accumark_coas'); $vr = $coas[$sample_id]['variance_report'] ?? [];` → empty-state if no tests.
  5. `ob_start();` include `templates/variance-report-content.php` with `$vr`, `$sample_id`, `$order`; return buffer.
Register in `Theme.php`: `(new Front\VarianceReport($this))->init();`. Create a
WP page at slug `variance-report` containing `[accumarkVarianceReport]` (document
in the plan output for the Handler to create in wp-admin, or auto-create on
`after_switch_theme` like other pages if the theme does that — check Theme.php).

- [ ] **Step 2: PHP chart helpers** (in the template or a `variance-charts.php`
partial). Port from `varicharts.jsx` — pure functions returning SVG strings:
  - `vr_stats($vals)` → `['n','mean','min','max','sd','rsd','range','rangePct']` (varicharts.jsx L21-32 exactly).
  - `vr_radial_gauge($value, $max, $size, $label, $good)` → SVG (L95-113): ring + arc `strokeDasharray`, color by `$good` (success when true, coral when false) — **customer-tone: drive by `$good`=conformance, not %RSD magnitude**.
  - `vr_sparkline($vals, $w, $h)` → SVG polyline + dots + mean dash (L118-136).
  - `vr_range_strip($test, $w, $h)` → SVG (L50-89): good band (success @ .13), base track, min→max connector (primary if all conform else coral), replicate dots, mean diamond, end labels. Uses `$test['domain']`, `spec_min/max`, `values`.
  Match geometry/colors from the JSX; emit `<svg>…</svg>` strings, `esc` numeric attrs.

- [ ] **Step 3: Template `variance-report-content.php`** — C-then-B:
  - **Header:** brand wordmark, `$vr['sample']['name']` (fallback to order item name), Lot, "Variance Report" eyebrow.
  - **Section 1 — Replicate Summary (CompC, comps.jsx L138-193):** 2-col grid of
    cards. Each numeric test: `vr_radial_gauge(rsd, 2, 84, '%RSD', $t['conforms'])`
    + big mean + `vr_sparkline` + Min/Max/Range tiles. Status pill
    "Conforms"/"Does Not Conform". Identity test: checkmark card with
    "`match_count` / `total` match reference".
  - **Section 2 — Spread & Conformance (CompB, comps.jsx L97-134):** per numeric
    test a row: name/method/spec | `vr_range_strip` | mean + `%RSD · Δ%` + pill.
    Legend: Replicate dot / Mean diamond / In-spec band.
  - **Footer:** "%RSD measures how tightly the replicate results agree — lower is
    tighter." + "Authenticated by Accumark Labs."
  - Enqueue/inline `variance-report.css`. Brand tokens above. Print-friendly
    (`@media print`). Run-labels "Result 1 … N".

- [ ] **Step 4: `css/variance-report.css`** — card grid, gauge/tile layout, pill
colors, range-strip row grid, print rules. Brand tokens.

- [ ] **Step 5: Lint + commit**

```bash
docker exec accumark-subvial-wordpress sh -c 'cd /var/www/html/wp-content/themes/wpstar && php -l src/Front/VarianceReport.php && php -l templates/variance-report-content.php && php -l src/Theme.php'
```
Commit in accumarklabs: `feat(coa): customer Variance Report page (C-then-B)`.

---

### Task 6: Verification + UAT handoff

- [ ] **Step 1:** COABuilder + IS unit suites green (run commands above).
- [ ] **Step 2:** Confirm the data shape end-to-end with a `python -c` that builds a `CoAData`, runs `_build_coa_data_json`, asserts `variance_report.tests` present; and that `_result_to_dict`-style passthrough is unaffected.
- [ ] **Step 3: Handler UAT (post-deploy):**
  1. A sample with variance vials → publish → order page shows the "Variance Report" button on its row (and none on non-variance samples).
  2. Click → page renders: C cards on top (gauge teal when passing, mean, sparkline, tiles), B range strips below with the in-spec band; "Result 1…N" labels.
  3. An out-of-spec replicate → that test's pill reads "Does Not Conform", its dot + connector coral; a tight-but-passing test stays teal (no false alarm).
  4. Another customer's account → "Access denied."
  5. Print preview is clean.

---

## Self-review

- Spec coverage: builder + customer tone (T1), coa_data emit (T2), IS passthrough (T3), WP store+button (T4), page+charts+template (T5), verify (T6). Pull-fallback noted in spec, not built.
- Types: `build_variance_report` via `process` → `variance_report` dict; `_num`/`_domain` helpers; `CoAData.variance_report`; payload `variance_report: dict|None`; WP `$vr` array. Consistent.
- Quantity is informational (status "Measured", no spec band) — matches engine semantics; RangeStrip handles absent spec (band = domain).
- PHP chart port references exact varicharts.jsx line ranges as geometry source; customer-tone gauge coloring (drive by conformance) is the one deliberate deviation, called out in T5.
