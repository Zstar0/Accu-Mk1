# Container-Mode Parent — Design

**Date:** 2026-06-10
**Status:** Approved (brainstormed with Handler; forks settled in conversation)
**Arc:** First step of the "parent-as-grouping-master" north star — stop treating the parent AR as a vial-with-results; make it a depository for cumulated vial reports. Promote survives; SENAITE untouched.

## Problem

Today the parent sample *is* Vial 1:

- `compute_vial_plan._current_vials()` injects a synthetic parent entry (`vial_sequence 0`, `assignment_role` defaulting `'hplc'`, "it IS the canonical") that consumes the core HPLC demand slot.
- Sub-sample labels render `Vial {vial_sequence + 1}` because the parent holds the "Vial 1" identity.
- Parent-hosted `lims_analyses` rows are both deposit targets (promote) AND bench objects (`tier_of` classifies a parent-hosted `to_be_verified` row as "parent acting as a vial"; techs can submit/verify directly on parent rows).

This ambiguity is the root of repeated workflow confusion (the variance arc removed one instance of it). The end-state vision: the parent is a pure grouping/COA container; every physical vial is a sub-sample.

## Decisions (settled with Handler)

1. **Promote survives — option (a).** Parent keeps its analysis rows as the deposit target. Promote, retest cascade, COA pins, SENAITE shape: all unchanged. The parent just stops being a bench vial. (Option (b) — parent with no rows, COA aggregating vials at read time — is a later arc, after SENAITE elimination.)
2. **New families only — mode flag, no backfill.** Existing families keep legacy behavior bit-for-bit. No prod data migration.
3. **Soft lock on parent-row bench actions.** UI hides editors/transitions on container-mode parent rows; the server still accepts them (SENAITE sync paths still write parent rows). The hard fail-closed gate ships with the SENAITE-elimination arc.
4. **Flag is automatic.** Every parent created after this ships is container-mode. No UI toggle.

## Design

### 1. The flag

- `lims_samples.container_mode BOOLEAN NOT NULL DEFAULT FALSE`.
- Idempotent ALTER in `backend/database.py` (existing hand-rolled migration list). Existing rows default FALSE = legacy.
- Set TRUE at every parent-creation path (order-sync ingest, manual create). Audit which paths create `LimsSample` parents during planning; each sets the flag explicitly.
- Serialized wherever the parent is returned (parent payloads, `ParentSampleSummary`, vial-plan response) so the FE can branch.

### 2. Vial plan & auto-assign

- `_current_vials()`: in container mode, return sub-samples only — no synthetic parent entry. Legacy keeps parent-first.
- `auto_assign`: no parent input in container mode, so core demand is filled entirely by physical vials (the first checked-in vial becomes the core HPLC vial, kind='core'). The parent-counts-against-core behavior remains for legacy families. No change to the additive variance contract.
- Received counts: parent stops counting as a received vial in container mode. Expected totals already read demand + variance (additive) — unchanged.

### 3. Numbering

- Container mode: S01 = "Vial 1" (`label = vial_sequence`). Legacy: `vial_sequence + 1` (unchanged).
- One mode-aware labeling helper shared by every surface that renders vial labels (AssignStep chips, sub-samples table, quicklook headers, parent-AR overlay `vialLabel`) so the off-by-one cannot scatter.

### 4. Promote & results — explicitly unchanged

- Parent-tier rows still seeded from the order's analytical set at sync.
- `promote_to_parent`, retest cascade, `coa_result_pins`, `coa_generation_sources`, SENAITE-shape surfaces: untouched.
- The variance model (assignment_kind, kind gates) composes as-is: container mode changes who fills the core slot, not how kinds work.

### 5. UI

- **AssignStep:** no parent chip in any bucket for container families (parent no longer drags, no longer renders in HPLC core zone).
- **Parent sample page:** ~~cumulative report view with hidden bench affordances~~ **AMENDED 2026-06-10 after live use on PB-0077:** the parent page keeps its FULL SENAITE bench surface (result entry, submit/verify, bulk toolbar, retest/retract/reject). The lab still drives the parent AR's SENAITE workflow from this page (COA publish needs parent lines verified; parent-line retest cascades to promoted source vials and is the only correction entry point once a line is verified). The bench-hiding idea was tried, walked back in three steps, and removed; the hard lock on parent-row writes ships with the SENAITE-elimination arc as originally planned for the server side.
- **Sub-vial pages:** unchanged.

### 6. Out of scope (later arcs)

- Backfill/migration of legacy families.
- Hard server-side gate on parent-row bench writes (ships with SENAITE elimination).
- COA reading vials directly / parent without rows (option (b)).
- Any SENAITE changes.

## Risks / planning notes

- **Parent-creation path audit** is the main unknown: every code path that creates a parent `LimsSample` must set the flag (order sync in Mk1, any integration-service-driven create, manual/dev creates). Missing one silently produces a legacy family.
- **`tier_of` / transition surfaces:** soft lock means `tier_of` and `apply_transition` are NOT changed; only the UI branches. Tests must pin that container-mode parent rows still accept transitions server-side (so SENAITE sync keeps working) while the UI hides the affordances.
- **Two-mode complexity is deliberate and contained:** `_current_vials()`, `auto_assign` parent handling, the label helper, and the FE branches. Anything needing a third mode-branch should be flagged during implementation as a design smell.
- Existing tests that assume parent-consumes-core (e.g. `test_auto_assign_parent_counts_against_core`) stay valid for legacy mode; container mode gets parallel coverage.
