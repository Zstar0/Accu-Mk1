# Variance COA Certification Model — Mean-Based — Design

*2026-06-15. How a variance lot (multiple vials from the same LOT — a uniformity /
multi-unit assessment) is certified on the COA. Supersedes the worst-case roll-up
in COABuilder 2.20.0/2.21.0. Decided over Slack this session (Levi Fried, Josh
Cosgrove, Dennis Nguyen) + Handler. Implementation lives in COABuilder
`conformance.py`.*

## Decision summary

The COA **certifies the mean** and shows the spread. Page 1 (unchanged structure)
reports the mean for each test; the full per-vial list moves to dedicated Variance
detail pages (separate effort). The conformance verdict is **mixed**:

| Test | Verdict rule | Rationale (lab) |
|---|---|---|
| **Identity** | **STRICT** — any vial that fails identity fails the WHOLE COA. No exclude-to-salvage. | "Identity is a lot more stringent — if one fails the whole lot should fail." (Dennis) |
| **Purity** | **MEAN-BASED** — conforms iff `mean(identity-passing figures) ≥ spec`. | "Base it off the average purity — you're testing the batch's purity." (Dennis) |
| **Quantity** | **Informational** — no spec gate; stat line shown. | Quantity has never gated conformance. |
| Overall lot | Conforms ⇔ identity all-confirmed **AND** purity mean in spec (per analyte / blend). | |

### Display

- **Result cell** (page 1, per-analyte + blend rows): a compact stat line
  `mean X · SD Y · %RSD Z% · n=N` replacing the comma series (which didn't fit
  4+ vials). Reuses COABuilder's auto-wrap / font-fit.
- **Statistics:** mean, **sample SD** (the uncertainty), **%RSD** (the precision /
  true representation of variance — preferred over SD per Dennis). The verdict
  compares the **EXACT (unrounded) mean** to spec — "don't round before or after
  the mean" (lab 2026-06-15) — so rounding can never flip a fail to a pass. The
  printed figures use **2-decimal precision** (cosmetic only); at a razor-edge
  boundary the printed mean may round to the spec value while the exact mean
  fails. %RSD is derived from the unrounded SD/mean.
- **Per-vial spread** is preserved in `coa_data['variance_report']` and rendered
  on the dedicated Variance detail pages (Handler designing in Claude Design).
- **Identity-failed vial:** its (wrong-molecule) purity/quantity is excluded from
  the mean and shown as N/A on the detail pages. The lot still fails on identity.

## Option #1 — Blend aggregation (this doc's focus)

A blend variance vial carries per-component figures
(`variance_replicates = {peptide_name: [{vial_sequence, PURITY, QUANTITY, IDENTITY}]}`).
The blend-level rows aggregate **per vial, then across vials**:

- **Blend total quantity (per vial)** = Σ component quantities for that vial.
- **Blend purity (per vial)** = mass-weighted average = `Σ(qtyᵢ · purᵢ) / Σ(qtyᵢ)`
  over the vial's components.
- The stat line then runs over `[parent blend value] + [per-vial blend values]`.

**Vial inclusion rule:** a vial contributes to the blend stat **only if all
declared components are present in that vial AND all pass identity**. Otherwise the
vial is excluded from the blend stat — and the lot fails anyway via the strict
identity rule (or is flagged incomplete). The **parent** blend figure is always
included. This avoids the two silent-corruption traps: a vial missing a component
(partial sum) and a wrong-molecule component polluting the weighted average.

**Blend verdicts:** blend purity is **mean-based** (`mean(per-vial blend purity) ≥
spec`, spec default `> 98%`); blend total quantity is **informational** (stat line,
no gate). Identity remains strict across all components/vials.

## Implementation status

- **Shipped** (COABuilder `feat/coa-identity-na-variance`, `dad6917`, pushed):
  per-analyte + single-peptide mean-based purity + the page-1 stat line. Helpers
  `_variance_stats` / `_stat_line` in `conformance.py`. 52 tests pass.
- **This change:** the blend-total + blend-purity rows (built before the per-slot
  loop in `process()`, ~`conformance.py:215` and `:302`). New per-vial blend
  aggregation reusing `_variance_stats` / `_stat_line`.

## Testing

- TDD with a **synthetic blend fixture** (2 components, ≥2 vials) first:
  mean-based blend purity pass, one-component-below-spec-but-mean-passes,
  identity-strict vial exclusion, vial-missing-a-component exclusion, stat-line
  format for both blend rows.
- **Final validation against a real blend variance sample** (Handler providing) —
  the synthetic fixture proves the math, the real sample proves the Mk1→COABuilder
  data shape.

## Out of scope

- Variance detail pages (Handler / Claude Design); per-vial data already in
  `variance_report`.
- Verify-page badge / Core-Panel reconciliation (still deferred).
- USP <905> uniformity compliance statement (≥10 samples; build only if a client
  requires it).
- Confidence interval (95%, outlier determination) — add only when a customer
  requests outlier flagging.
