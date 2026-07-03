# Unlock (un-promote / un-verify) vial results

*Design spec — 2026-07-03*

## Problem

Once a vial (sub-sample) result is signed off, it locks: a core vial promoted to
the parent lands in `promoted`, a variance replicate lands in
`variance_verified`, and neither offers a direct correction path. Today a
data-entry error caught after sign-off is fixed either by retesting (which
leaves the stale parent value in place until re-promotion) or by a guarded
manual prod DB edit (the P-1077-S02/S03 purity↔quantity swap). This is the
"admin un-promote" item deferred from the sub-vial backlog (PR #9 follow-ups).

## Concept

One **Unlock** affordance that returns locked vial rows to `to_be_verified` and
pulls the promoted value out of the parent. Everything after the unlock is
existing behavior: edit via retest, re-verify, re-promote. Re-promotion already
supersedes/inserts the parent-tier row and overwrites the parent SENAITE line
via `writeback_promotion`, so no new "update the parent" machinery is needed.

## Backend

### 1. Un-promote — `POST /api/lims-analyses/unpromote`

Request: `{ "parent_analysis_id": int, "reason": str }` (reason required,
non-empty). The FE resolves the group from any source vial via the existing
promotions read (`GET /api/lims-analyses/promotions`).

Effects, one transaction:

- Parent-tier `lims_analyses` row: `verified` → `retracted`, `updated_at`
  stamped, audit `LimsAnalysisTransition` (`transition_kind="unpromote"`,
  `reason=f"un-promoted: {reason}"`, acting `user_id`).
- **Every** source vial row in the promotion group (all
  `LimsAnalysisPromotion` links of that parent row): `promoted` →
  `to_be_verified`, audit row each with the same reason. Group semantics:
  pick-one-with-references and aggregate promotions revert all their sources
  together — never a partial group. Sources revert regardless of their
  `retested` flag; a source that was already retested post-promotion stays
  `retested=True`, and the current-row idiom (consumers read
  `retested=False`) keeps it out of every live view.
- `LimsAnalysisPromotion` link rows are kept untouched (audit history). The
  codebase already ignores links whose parent row is `retracted`/`rejected`
  (service.py "senaite-writeback: ignore links whose parent row was
  retracted…" idiom), so consumers stop citing the value with no further work,
  and the partial-unique parent slot is vacated for the next promotion.
- SENAITE parent analysis line: **deliberately left as-is.** After the
  original promotion it sits at `to_be_verified` in SENAITE carrying the
  written result — unverified, therefore not citable. The next re-promotion
  overwrites it (`writeback_promotion` updates Result/Remarks and submits only
  if needed). Native (`mk1://`) parents have no SENAITE line; nothing to do.

Guards (all → 409 with a clear message):

- **SENAITE restriction (the load-bearing one):** for SENAITE-backed parents,
  read the parent analysis line state (`find_parent_analysis_line`); if it is
  `verified` or `published`, block with "retract in SENAITE first" — the same
  idiom `writeback_promotion` raises on the way in. SENAITE lookup failure =
  fail closed (409, "could not confirm SENAITE state").
- **Published Mk1 parent row:** if the parent-tier row's `review_state` is
  `published` (COA cited it), block — a published parent is a citable COA
  source (same principle as promote's supersession guard, which only
  supersedes `verified`).
- Parent row must be parent-tier (`lims_sub_sample_pk IS NULL`) and in
  `verified`; source rows must be in `promoted`. Anything else → 409.
- Reason missing/blank → 400.

### 2. Un-verify (variance) — new transition kind `unverify`

Extends the existing state machine + `/transitions` endpoint:

- `variance_verified` → `to_be_verified`, vial-tier only.
- Requires a non-empty `reason` (unlike other kinds — enforce in
  `apply_transition`'s semantic guards).
- No parent involvement (variance replicates never promote), no SENAITE
  interaction, no group semantics — single row.

### Permissions

Any authenticated staff user (same as verify/promote today). Attribution comes
from the audit rows, not a role gate.

## Frontend

- An **Unlock** action on vial-result rows in the Sample Details vial results
  table when the row state is `promoted` or `variance_verified` (live rows
  only, `retested=False`).
- Confirm dialog: states what will happen ("returns N vial result(s) to
  To Be Verified and retracts the parent value" / variance wording), with a
  **required reason** field; disabled confirm until non-empty.
- `promoted` rows call `/unpromote` with the resolved `parent_analysis_id`;
  `variance_verified` rows call `/transitions` with `kind="unverify"`.
- On success: invalidate the analyses/promotions queries — rows visibly drop
  to `to_be_verified`, the parent's promoted value disappears from the parent
  analyses view.
- On the SENAITE-locked 409: toast surfacing the backend message (retract in
  SENAITE first).

## Testing (TDD)

Service level (SQLite, SENAITE reader mocked):

1. Un-promote happy path: parent row → `retracted`, all group sources →
   `to_be_verified`, audit rows carry the reason, promotion links intact.
2. Multi-source groups: aggregate (N sources) and pick-one+reference — all
   sources revert together.
3. Guards: SENAITE line verified → 409; SENAITE lookup failure → 409 (fail
   closed); Mk1 parent `published` → 409; wrong states → 409; blank reason →
   400.
4. Round-trip: unlock → retest → re-promote succeeds (vacated slot, fresh
   parent row verified; old links dead).
5. Variance `unverify`: happy path + reason required + wrong-tier/state
   rejections.
6. Native parent (no SENAITE): un-promote succeeds with no SENAITE call.

Frontend (vitest): dialog renders per state, confirm disabled until reason,
correct endpoint per row state, invalidation on success.

## Scope / non-goals

- Additive only: no schema change, no migration; reuses `retracted`,
  the transitions audit table, and the dead-link idiom.
- No un-publish of parent rows or COAs (published stays immutable; the
  existing invalidate/retest paths own that).
- No SENAITE-side retraction — the guard ensures the SENAITE line is at most
  `to_be_verified`, which is not citable.
- Ships as a normal Mk1 release (backend + FE, no coordination with IS/COA).

## ISO 17025 alignment

- **Traceable amendments (7.5.2 / 8.4):** every unlock writes transition audit
  rows with actor, timestamp, and a required reason; the retracted parent row
  and promotion links preserve the full prior history — nothing is deleted.
- **Attribution (7.5.1):** acting user recorded on every transition row.
- **Identification/traceability (7.4.2):** promotion group semantics keep the
  parent value's provenance (which vials produced it) intact across the
  unlock/re-promote cycle.
