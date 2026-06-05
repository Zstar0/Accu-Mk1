# Retest-Aware Promote

**Date:** 2026-06-05 · **Status:** Approved in session · **Scope:** Mk1 backend (`lims_analyses`) + AnalysisTable FE gating. No IS/coabuilder changes.

## Problem

The retest path for promoted values is unfinished: (1) Retest on `mk1:` vial rows always 409s (`retest` not allowed on vial tier — no linked retest row, `retested` flag never set); (2) re-promoting after a retest is blocked by the active Mk1 parent-tier row (409) with no UI to retract it; (3) `find_parent_analysis_line` is order-dependent when the parent AR carries old=`verified` + new=`unassigned` lines after a parent-side SENAITE retest; (4) post-promote, Verify re-appears on vial rows (state divergence foot-gun) and retract/reject on promoted vials silently leave the parent carrying a value from a dead source.

## Design (user-approved)

1. **Vial-tier retest** — `kind="retest"` becomes legal on vial-tier rows from `to_be_verified` and `verified`: the old row keeps its state and gets `retested=True`; a new linked row is created (same host/service/keyword/title, empty result, initial state matching how Mk1 vial analyses start, `retest_of_id=old.id`); audit transition rows written. The senaite-shape/FE already render retest chains + RETESTED flag.
2. **Re-promote supersession** — when the promoted source row is a retest (`retest_of_id IS NOT NULL`) and an active (non-retracted/rejected) Mk1 parent-tier row exists for (parent, keyword): auto-retract that parent row in the same transaction (audit reason "superseded by retest promotion"), then insert the new parent row. Non-retest double-promotes keep the existing 409 protection.
3. **Write-back targeting** — `find_parent_analysis_line` prefers ACTIVE NON-VERIFIED lines (skip retracted/rejected as today, and skip `verified` when a non-verified match exists). If ONLY verified lines match: error "already verified in SENAITE — retest or retract there first" (no update calls). Kills the nondeterminism after a parent-side retest.
4. **FE guardrails** — Verify stays suppressed on vial rows that are promotable OR already promoted (`promoted_to_parent_id != null`), row menu + bulk. Bulk Retest now works for `mk1:` rows (via #1). Destructive bulk confirm dialog notes when the selection includes promoted rows ("parent keeps its promoted value").

## Out of scope

UI to retract Mk1 parent-tier rows directly (API works; promote supersession covers the main need); SENAITE-side retest automation; vial-tier `verified → retest`-style SENAITE parity beyond the two entry states above.

## Testing

State-machine + service tests for vial retest (new row link, retested flag, audit); promote supersession (retest source supersedes; non-retest still 409; rollback intact); write-back targeting (verified+unassigned pair → picks unassigned; only-verified → error, no updates); FE helper tests for the new verify suppression rule. Live E2E on P-0144.
