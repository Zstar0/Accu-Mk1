# Variance COA page 3 — list the actual sub-vials

*Design spec. Created 2026-06-30. Status: approved, pre-implementation.*

## Summary

The peptide Variance COA's per-vial page ("page 3") sometimes renders **one row
when two should appear**. The fix: page 3 lists **every sub-vial in the locked
variance set, in vial-number order**, sourced directly from the physical
sub-samples — dropping the fragile "synthesize a parent row when vial_sequence 1
is free" heuristic that produced the bug. Display/contract change only; no
SENAITE writes, no change to which result is the headline.

**Scope: HPLC peptide variance COAs only.** Bacteriostatic Water per-vial listing
is a separate effort (Spec 2, parked). The Core/Variance COA split is peptide-only
and unchanged. The variance-override count-field bug is out of scope.

## Background — the bug, reproduced on live data

P-1094 (GHK-Cu, a pre-variance retest upgraded to variance) renders a Variance
COA whose page 3 shows **one** vial row; the customer-visible mean (page 1) reads
`n=2`. P-1096 (Tirzepatide), a structurally similar variance sample, renders
**two** rows correctly. The two differ only in which vial is the variance vial:

| | P-1096 (works → 2 rows) | P-1094 (broken → 1 row) |
|---|---|---|
| seq-1 vial | S01 = **core** (promoted → parent) | S01 = **variance** |
| seq-2 vial | S02 = **variance** | S02 = **core** (promoted → parent) |
| variance vial sits at | `vial_sequence = 2` | `vial_sequence = 1` |

The COA generation payload confirms it: P-1094's variance series carried only the
single variance vial (vial_sequence = 1).

## Root cause

The COA Builder builds page-3 rows from the distinct `vial_sequence` values it
receives, then **prepends a synthetic "Vial 1" parent row only when sequence 1 is
absent** (`coabuilder_core/variance_matrix.py:143` — `if analytes and 1 not in
seqs`). That condition conflates two unrelated things:

- "Is there a core/parent figure to show?" (legacy sample: yes; container sample
  with no parent result: no), with
- "Is `vial_sequence` 1 occupied by a variance vial?"

For P-1094 the variance vial legitimately sits at sequence 1, so the prepend is
skipped and the parent/core figure is lost — one row instead of two.

Upstream, Mk1's `coa/variance_series.py::build_variance_replicates` sends **only
`assignment_kind='variance'` sub-vials** and deliberately omits the `promoted`
core (the comment: "the promoted core is represented by the parent figure"). So
COA Builder never receives the core sub-vial — it can only reconstruct it via the
prepend heuristic.

## The model — one source of truth

Define the variance series as **every sub-vial in the locked variance set
(`in_variance_set = True`) that carries a current, reportable result** — core
*and* variance — ordered by `vial_sequence`. The parent record is **never a row**;
its headline value is a promoted copy of one of these sub-vials. Both the page-3
rows and the page-1 mean derive from this single set.

- P-1094 → {S01 = 99.73, S02 = 99.965} → 2 rows (Vial 1, Vial 2); mean 99.85%.
- P-1096 → {S01 = 99.91, S02 = 99.91} → 2 rows; mean 99.91% — identical to today.

### Why this is safe (the regression key)

For any well-formed sample, **the parent figure equals the promoted core sub-vial's
value** (promotion copies a sub-vial's result onto the parent). So replacing
"parent figure + variance vials" with "all in-set sub-vials" yields the *same set
of numbers* — identical rows and identical mean — on every currently-correct
certificate. Only the broken shape (a variance vial stuck at sequence 1) changes
output. The container-mode path is equally covered: the core sub-vial's promoted
value is exactly what the synthetic parent row showed.

The only configuration where the two diverge is a parent figure that **no sub-vial
covers** (a legacy value typed straight onto the parent). That is handled by the
invariant + safety net below, not by a render fallback.

## Changes (two repos, coordinated)

### Mk1 — `backend/coa/variance_series.py`

`build_variance_replicates` changes its vial filter from
`assignment_kind == 'variance'` to **all `in_variance_set == True` sub-vials**, and
its per-analysis review-state set widens to **include `promoted`** (the core's
state). Result selection is otherwise unchanged: current row (`retested == False`),
`reportable == True`, non-empty result, in `vial_sequence` order. Deselected vials
(`in_variance_set == False`) stay excluded so the certified series matches the
locked selection.

This is the one Mk1-side change, and it is the piece BW (Spec 2) reuses.

### COA Builder — `coabuilder_core/variance_matrix.py` + `conformance.py`

- `build_vial_matrix`: **remove the synthetic-parent prepend** (`if analytes and 1
  not in seqs`). Render exactly one row per sub-vial received, by `vial_sequence`.
- `conformance.py`: compute the page-1 variance mean/stat from the **same sub-vial
  set**, with **no parent figure prepended** — so the core is counted once (it is
  now a real row), not twice.

## Invariant + safety net

**Invariant:** every variance measurement lives on a sub-vial, never directly on
the parent. The check-in workflow already enforces this going forward (managers
do not enter results on the parent).

- **Pre-ship prod scan:** enumerate every variance sample whose parent carries an
  analyte figure that no sub-vial covers (a legacy parent-only value). Hand the
  list to the lab; the manager **adds + populates the missing sub-vial** (data fix)
  before that certificate is regenerated. Expected: short or empty.
- **Fail-loud guard (additive):** if COA Builder ever renders a variance page where
  a parent figure is not covered by any sub-vial, it **logs a warning and flags the
  COA** rather than silently dropping the value. Invisible in the normal case; it
  exists so a missed legacy sample is caught at regeneration time, not shipped with
  a missing result.

## Edge cases

- **Container-mode samples** (parent is a pure depository): all physical vials are
  sub-samples; the core's promoted value matches the parent figure, so output is
  unchanged.
- **Deselected core** (`in_variance_set == False` on the core vial): the core is
  omitted from the variance page, consistent with "the certified series matches the
  locked selection." The Core COA / page-1 headline is a separate surface and
  unaffected. (Flagged; not expected in practice.)
- **Single in-set vial:** one row. (No spread, but honest.)

## Out of scope

- BW (Bacteriostatic Water) per-vial panel listing — Spec 2, parked. BW uses a
  different engine (`GenericAssayEngine`), has no per-vial page, no `vial_sequence`
  in its variance series, and a single COA (no Core/Variance split).
- The Core/Variance COA split (peptide-only) — unchanged.
- The "Variance Testing" count field (`variance_override`) revert-to-0 / read-back
  bugs — separate issue.

## ISO 17025 alignment

- **Traceable amendments (7.5.2 / 8.4):** the fix corrects a certificate via
  regeneration, which mints a new verification code and supersedes the prior
  generation — the amendment is traceable, the superseded copy retained.
- **LIMS change validation (7.11.2):** the renderer change is validated by a
  byte-identical regression diff against existing certificates plus the P-1094
  before/after, on an isolated dev stack, before production deploy.
- **Identification/traceability (7.4.2):** each rendered row maps to a physical
  sub-vial (`vial_sequence`), strengthening per-replicate traceability over the
  synthesized parent row.

## Testing / regression plan

Non-negotiable bar: **byte-identical output for every currently-correct variance
certificate**; only P-1094's shape changes.

1. On a throwaway dev stack (accumark-stack), load P-1094 (broken) + P-1096
   (working) + a batch of existing variance fixtures.
2. TDD the Mk1 builder change and the COA Builder matrix/mean change.
3. Render PDFs; diff before/after — P-1096 and the fixtures unchanged, P-1094 → 2
   rows, mean 99.85%, headline 99.965% intact.
4. Run the pre-ship prod scan; remediate any parent-only samples (data fix).
5. Deploy COA Builder + Mk1 (with sign-off), regenerate P-1094, verify 2 rows.

**No data edits to P-1094** at any point — the renderer is fixed and the
certificate regenerated.

## Rollout

COA Builder + Mk1 both ship (coordinated — the Mk1 payload and the COA Builder
renderer must land together):

- **Old renderer + new payload:** the renderer still prepends the parent figure
  *and* now receives the core sub-vial, so the page-1 mean **double-counts the
  core** (e.g. P-1094 mean would read 99.89% instead of 99.85%).
- **New renderer + old payload:** the renderer no longer prepends the parent and
  the payload still omits the core, so P-1094 renders **only the single variance
  vial** with no core row — the bug persists.

Deploy order and mechanics per the `accumark-deploy` skill. Regenerate affected
variance certificates after deploy, with sign-off.
