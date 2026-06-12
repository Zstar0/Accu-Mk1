# COA Identity-Gated N/A — Design (Spec 1 of 2)

*2026-06-12. Foundational half of the variance-COA arc. Spec 2
(`2026-06-12-coa-variance-series-design.md`) builds the per-vial series on top
of the per-figure N/A primitive this spec establishes.*

## Problem

On a Certificate of Analysis, an analyte's **identity** test gates the meaning of
its purity and quantity. If a sample's identity is non-conforming ("this isn't
the peptide you ordered"), the measured purity and quantity are meaningless — but
today the COA still prints them, e.g. a confident "82.4%" purity for a sample that
isn't even the right compound. The lab wants those cells to read **N/A** instead,
on both the PDF and the digital (verify-page) COA.

## Decision (Handler-approved)

- **Global scope.** The rule applies to every analyte's primary figure on every
  newly-generated COA — not just variance samples. If identity does not conform,
  purity and quantity render `N/A`.
- Per-figure semantics matter for Spec 2 (each variance vial figure is gated by
  *its own* identity); this spec establishes it for the single primary figure.

## Architecture

Both COA surfaces render from one source: COABuilder's `ConformanceEngine`
produces `CoAData.results` (a list of `AnalysisResult`). The PDF renders that list
directly; `scripts/server.py:_build_coa_data_json` serializes it into the
`coa_data` dict stored per generation; the wpstar theme
(`IntegrationService.php`) maps each result's `result→value` and
`status/conforms→badge` for the verify page. So the gating logic lives in **one
place** — the engine — and both surfaces inherit it. The only surface-specific
work is a neutral "N/A" badge style on the verify page.

## Changes

### COABuilder — `src/coabuilder_core/conformance.py`

In the per-analyte loop (`for slot in slots:`), identity (B.1) is computed before
quantity (B.2) and purity (B.3), so the boolean `is_match` is already in scope
when those rows are built. When `is_match` is `False`:

- **Quantity (B.2)** row: `result = "N/A"`, `status = "N/A"`, `conforms = None`,
  `status_color = _NA_COLOR`, `unit = ""`, `delta_pct = ""`.
- **Purity (B.3)** row: `result = "N/A"`, `status = "N/A"`, `conforms = None`,
  `status_color = _NA_COLOR`, `unit = ""`.

`_NA_COLOR = "#6B7280"` (neutral grey — distinct from the `#444F5B` out-of-spec
slate and the default green CONFORMS). Identity row itself is unchanged (it
already shows "Out of Spec" + DOES NOT CONFORM when `is_match` is False).

Covers single-peptide (`len(slots) == 1`) and blend per-analyte rows — both run
through the same loop. **Out of scope:** blend-level total purity/quantity rows
(the `Blend Total Quantity` / `Blend Purity` rows keyed on `matrix_type`) keep
current behavior; gating those on composite identity is a separate follow-up.

A factored helper keeps the two call sites DRY:

```python
def _na_if_identity_fails(row: dict, is_match: bool) -> dict:
    """When identity doesn't conform, blank the dependent numeric result to N/A
    (neutral). Returns the row for inline use."""
    if not is_match:
        row["result"] = "N/A"
        row["status"] = "N/A"
        row["conforms"] = None
        row["status_color"] = _NA_COLOR
        row["delta_pct"] = ""
    return row
```

Applied to the quantity and purity row dicts before they are appended.

### wpstar theme — `templates/accuverify-content.php`

Three identical badge-selection blocks (blend-overall ~L149, individual-analyte
~L204, single-peptide ~L262) currently branch pending → measured →
`conforms === false` → else-Conforms. A row with `status="N/A"` has
`conforms=None`, so it would fall through to the **else → "Conforms"** branch —
wrong. Add an N/A branch **before** the `conforms === false` check in all three:

```php
} elseif (strpos($status_text, 'n/a') !== false) {
    $badge_class = 'na'; $badge_label = 'N/A';
```

The result cell already prints `$test['value']` verbatim, so it shows "N/A"
with no change.

### wpstar theme — `css/accuverify.css`

Add a neutral `.na` badge mirroring `.measured`/`.out-of-spec` shape, grey:

```css
.accuverify-page .status-badge.na {
    background: #f3f4f6;
    color: #6B7280;
    font-weight: 400;
}
.accuverify-page .status-badge.na svg { stroke: #6B7280; }
```

(The badge SVG is a checkmark; acceptable for a neutral chip. A dedicated glyph
is a cosmetic follow-up, not required.)

## Data flow check (no code, verification only)

A regenerated COA for an identity-failing sample must show `N/A` purity/quantity
on (a) the PDF, (b) the stored `coa_data` JSON, and (c) the verify page with a
grey N/A badge — confirming the single-source design holds end to end.

## Testing

COABuilder (standalone `unittest`, `tests/` pattern — `sys.path` adds `src/`):
- `test_identity_fail_na.py`:
  - identity non-conforming → purity & quantity rows have `result="N/A"`,
    `status="N/A"`, `conforms is None`.
  - identity conforming → purity/quantity unchanged (regression).
  - blend per-analyte: one component's identity fails → only that component's
    purity/quantity go N/A; siblings unaffected.

wpstar: no automated test harness in the theme; manual verify-page check via the
data-flow step above (documented in the plan's verification task).

## Risks / notes

- **Blast radius: every newly-generated COA.** Already-published COAs are
  immutable (regenerate to apply). This is why it ships as its own spec ahead of
  the variance series.
- Quantity rows normally carry `status="MEASURED"`; overriding to `"N/A"` on
  identity failure is intentional and reads correctly.
- The verify-page `is_pending_test` / status normalization in
  `COAEndpoint.php` keys on substrings; `"N/A"` does not collide with
  pending/measured, so no false routing.
