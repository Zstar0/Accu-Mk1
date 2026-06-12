# Findings: vial analyte sync — orphan cleanup, mirror-prune gap, TB500 swap verification

*2026-06-11. Branch `subvial/continue`. Investigation triggered by a phantom
"1 Pending" (ACE-031 identity) on a BPC-157 vial in the Process HPLC flow.*

## 1. Orphan cleanup (data fix, test stack only)

Vial `P-0144-S01` (lims_sub_sample_pk=82) carried a stale
`ID_ACE031 / ACE-031 - Identity (HPLC)` row (lims_analyses id 2911,
`review_state='unassigned'`, no result) even though the **current** parent AR
P-0144 in SENAITE has no ACE-031 analyte (`fetch_parent_analysis_keywords`
returns `HPLC-PUR, ID_BPC157, PEPT-Total, ENDO-LAL, STER-PCR`).

History showed only `initial insert` for 2911, and it was created **before**
`ID_BPC157` (2994) — i.e. the vial was seeded against an earlier P-0144 config
(ACE-031), the parent was later re-pointed to BPC-157, and the stale row
lingered. A re-point/re-seed at creation **bypasses the remove cascade** (see
§3), so nothing pruned it.

Deleted on the subvial Postgres (test data, not a migration):

```sql
DELETE FROM lims_analysis_transitions WHERE analysis_id = 2911;
DELETE FROM lims_analyses
 WHERE id = 2911 AND keyword = 'ID_ACE031'
   AND lims_sub_sample_pk = 82 AND review_state = 'unassigned';
```

## 2. Mirror-prune gap (latent, LOW severity — no code change made)

**Root cause.** The HPLC seed/mirror path
(`lims_analyses/seeder.py::seed_analyses_for_vial` →
`mirror_parent_hplc_analyses`) is **purely additive**. The only prune,
`sub_samples/service.py::_drop_stale_role_rows`, fires **only on a role change**
and **only at service-group granularity** (Microbiology ↔ Analytics). So a vial
that stays HPLC while the parent's *analyte* set shrinks has no prune path via
the mirror itself.

**Why it's not a real-world bug for the normal flow.** Analyte swaps in
production go through **Manage Analyses**, which has explicit add/remove
cascades (§3). The gap only manifests on cascade-bypassing paths: re-seeding at
creation against a since-changed parent config (what hit P-0144 here), or direct
SENAITE analyte edits outside Manage Analyses.

**Blast radius — both downstream consumers checked, both safe:**
- **Results: safe.** The prep bridge (`lims_analyses/prep_bridge.py`) refuses to
  write a result onto an identity row whose analyte ≠ the prep peptide — that
  guard is exactly why ACE-031 stayed unfilled. Purity/quantity route by the
  prep peptide's own `PUR_<X>/QTY_<X>` keyword, so a foreign analyte's row is
  never written.
- **COA: safe.** `coa/source_resolver.py` emits one decision **per analyte the
  parent's order requires** — it iterates the parent set, not vial rows. A vial
  row for a parent-absent analyte is invisible to the COA gate; it can't block
  or taint a COA.
- **Only impact: cosmetic** — inflates the vial's "Pending" count and shows a
  non-fillable phantom row in the prep view / vial AnalysisTable.

**Recommendation:** leave as-is unless it recurs in production. A fix would add a
prune to the additive mirror (delete unassigned/no-result/no-retest HPLC analyte
rows whose keyword left the parent's current set), which touches the sensitive
parent↔vial sync logic and needs guards against micro rows, worked rows,
promotions, retests, and the ANALYTE-N→PUR_X translation. Additive-only ethos +
low severity ⇒ not worth the risk reactively.

## 3. TB500 variant swap — VERIFIED working with Process HPLC

Common real workflow: a customer orders the wrong TB500 variant; a tech removes
the wrong analysis service on the parent and adds the correct one.

The three variants are distinct peptides/keywords in the catalog:

| Peptide | Identity | Purity | Quantity |
|---|---|---|---|
| TB-500 (61) | `ID_TB500` | `PUR_TB500` | `QTY_TB500` |
| TB500 17-23 Fragment (62) | `ID_TB500-17-23` | `PUR_TB500-17-23` | `QTY_TB500-17-23` |
| TB500 Thymosin Beta 4 (63) | `ID_TB500BETA4` | `PUR_TB500BETA4` | `QTY_TB500BETA4` |

**Both halves cascade from Manage Analyses → vials automatically:**
- Remove wrong → `DELETE /explorer/samples/{parent}/analyses/{keyword}` →
  `cascade_parent_remove_from_vials` hard-deletes the **pristine** vial mirror
  rows of that service across the family.
- Add correct → `POST /explorer/samples/{parent}/analyses` →
  `cascade_parent_add_to_vials` re-runs the idempotent mirror; the new variant's
  rows land on every non-xtra vial as `unassigned`.

Process HPLC then resolves the corrected rows: the prep bridge routes
purity/quantity by the prep peptide's own keyword, so a Beta-4 prep writes to
`*TB500BETA4` exactly. Step1 lookup auto-selects the corrected peptide from the
parent's current analytes.

**Edge behaviors confirmed safe:**
- If a vial carried *both* variant rows, purity/quantity still route to the
  correct one by peptide; identity flags ambiguous and skips rather than writing
  a wrong value (never guesses).
- The remove cascade only deletes **pristine** rows. If a result was already
  entered on the wrong variant, that worked row is preserved and the audited
  path is **reject**, not silent delete. The order-entry-time swap (before HPLC
  results) is the pristine case, so it just works.

**Conclusion:** the swap workflow is a first-class supported path; no change
needed. The §2 gap only bites on cascade-bypassing paths, not on the tech swap.
