# Bulk-Overlay Redesign: Promote Selected, Remove the Verify Trap

**Date:** 2026-06-05
**Status:** Approved (user-reviewed design, this doc pending review)
**Scope:** `src/components/senaite/AnalysisTable.tsx` + tests. No backend changes.

## Problem

On native vial rows, "Verify" (per-row `⋯` menu and bulk "Verify selected") moves an analysis to `verified` and dead-ends — a verified vial row has no path to load its result to the parent. "Promote" is the correct action, and it only exists per-row. Lab users keep hitting Verify and stranding vials.

## Decisions (user-confirmed)

1. **Remove Verify only where Promote applies.** SENAITE-backed rows (parents, legacy vials) keep Verify — it's their normal `submit → verify` workflow step. Promotable native vial rows lose it entirely.
2. **Bulk promote uses each row's result as-is.** Read-only confirm dialog; rows with no result block the action. The per-row `⋯` Promote dialog remains the path for editing a value before promoting.
3. **Approach: row-level gating** reusing the existing `canPromote` discriminator (Phase 4b) — no new props, no host-context threading.

## Design

### Gating rules

A row is **promotable** = the existing `canPromote` predicate: `uid` starts with `mk1:`, `review_state === 'to_be_verified'`, `promoted_to_parent_id == null`.

- **Per-row `⋯` menu:** promotable rows show **Promote** + their allowed transitions **minus `verify`**. Retract / reject / retest survive (legitimate escape hatches). Non-promotable rows are unchanged.
- **Bulk toolbar:**
  - `verify` is excluded from `bulkAvailableActions` when **any** selected row is promotable (prevents the trap re-entering via mixed selections, where intersection logic would otherwise still offer it).
  - A **"Promote selected"** button appears when **all** selected rows are promotable (and ≥1 selected).

### Bulk promote flow

1. Click "Promote selected" → confirm dialog:
   - Table of `keyword → result value` for each selected row (read-only).
   - Explanation text mirroring the single-row PromoteDialog (parent-tier verified row is created; vial row stays `to_be_verified`; audit row records it; undo = retract the parent row).
   - **Blockers** (shown in-dialog, Confirm disabled):
     - any selected row has no result value
     - duplicate keywords in the selection (one parent row per keyword; multi-source merges go through per-row Promote)
2. Confirm → sequential `promoteAnalyses` calls, one per row: `{keyword, result_value: row.result, result_unit, method_id, instrument_id, sources: [{analysis_id, contribution_kind: 'chosen'}], reason: 'Bulk promote from AnalysisTable'}`.
3. Progress text in the toolbar like existing bulk transitions ("Promoting 2/4…").
4. Per-row failures: toast the error, continue with remaining rows.
5. One refresh at the end via `onTransitionComplete`.

### Components

- `BulkPromoteDialog` (new, colocated in AnalysisTable.tsx beside `PromoteDialog`): props `{analyses: SenaiteAnalysis[], open, onOpenChange, onPromoted}`. Owns blocker derivation, sequential execution, progress state.
- `AnalysisTable`: derives `selectedPromotable` / `allPromotable` from `selectedAnalyses` using an extracted `isPromotable(analysis)` helper (the `canPromote` logic lifted to module level so the row component and bulk logic share it). Bulk toolbar renders the Promote button + dialog.
- `AnalysisRow`: uses `isPromotable(analysis)` for `canPromote`; filters `'verify'` out of `allowedTransitions` when promotable.

### Testing

Vitest unit tests (`src/test/bulk-promote-overlay.test.tsx` or extend existing AnalysisTable tests):
- `isPromotable`: true for `mk1:` + `to_be_verified` + unpromoted; false for SENAITE uid, wrong state, already promoted.
- Bulk action derivation: any-promotable selection hides `verify`; all-promotable shows Promote selected; mixed (promotable + SENAITE) shows neither verify nor Promote.
- Per-row menu: promotable row renders Promote, no Verify; SENAITE `to_be_verified` row still renders Verify.
- Dialog blockers: missing result disables Confirm with message; duplicate keywords disable Confirm with message.

### Out of scope

- Multi-source (multi-vial → one parent row) promote UI.
- Backend changes — `promoteAnalyses` API is used as-is.
- Any redesign of the verify workflow for SENAITE/parent rows.
