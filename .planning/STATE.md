# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-24)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE. One operator, one workstation, no friction.
**Current focus:** v0.12.0 — Analysis Results & Workflow Actions — Phase 07

## Current Position

Phase: 07 of 08 (Per-Row Workflow Transitions)
Plan: 2 of 3 in current phase (07-02 complete)
Status: In progress
Last activity: 2026-02-25 — Completed 07-02-PLAN.md

Progress: [██████░░░░] 50%

## Performance Metrics

**Velocity:**
- Total plans completed: 6 (this milestone)
- Average duration: ~3 min
- Total execution time: ~18 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 06 | 4/4 | 11 min | 3 min |
| 07 | 2/3 | ~7 min | ~3.5 min |
| 08 | 0/3 | -- | -- |

*Updated after each plan completion*

## Accumulated Context

### Decisions

- Analysis transitions go through Accu-Mk1 backend -> SENAITE REST API (same as existing sample field updates)
- UX: Both per-row action menus AND checkbox bulk selection with floating toolbar
- Sample-level state refreshes after analysis transitions
- Component extraction (AnalysisTable) is mandatory before adding any new state -- SampleDetails.tsx is 1400+ lines
- Bulk operations must be sequential for...await (never Promise.all) to avoid SENAITE workflow race conditions
- REFR-01/REFR-02 assigned to Phase 07 -- sample refresh is triggered by per-row transitions, not just bulk
- uid and keyword placed before title field as primary identifiers in SenaiteAnalysis model
- Both uid/keyword nullable for backward compatibility with older cached responses
- uid mapping uses dual fallback (uid/UID) and keyword mapping uses (Keyword/getKeyword) for SENAITE API casing
- Result-set and transition are separate atomic endpoints -- frontend controls the two-step workflow
- EXPECTED_POST_STATES mapping validates post-transition review_state to catch SENAITE silent rejections (DATA-04)
- StatusBadge and status constants exported from AnalysisTable.tsx for reuse (not a separate shared file)
- verifiedCount/pendingCount independently computed in SampleDetails for header counters
- EditableResultCell is separate from EditableField -- cell-level editing needs different layout than DataRow
- savePendingRef guard pattern prevents onBlur + onKeyDown Enter double-save race condition
- Tab advances forward only through editable (unassigned/null) analyses; does not wrap
- Failed saves keep cell in edit mode for user retry
- TRANSITION_LABELS defined locally in both hook and AnalysisTable.tsx (hook must not import from component)
- AlertDialog placed outside table element — Radix Portal renders to document.body regardless of JSX position
- pendingUids uses Set<string> not boolean — independent per-row loading state for concurrent transitions
- refreshSample() does not call setError(null) — keeps current error state; background refresh failure shows toast not page replacement
- refreshSample() replaces entire data object via setData(result) — full replacement ensures all derived state reflects server truth

### Key Source Files

- `backend/main.py` -- FastAPI app, all endpoints, SENAITE integration
- `src/components/senaite/SampleDetails.tsx` -- Sample Details page with refreshSample() silent re-fetch, onTransitionComplete wired to AnalysisTable
- `src/components/senaite/AnalysisTable.tsx` -- Analysis table with inline editing, filter tabs, progress bar, Actions column, onTransitionComplete prop
- `src/hooks/use-analysis-editing.ts` -- Hook for inline result editing (edit state, save, cancel, Tab nav)
- `src/hooks/use-analysis-transition.ts` -- Hook for per-row workflow transitions (pendingUids Set, confirmAndExecute)
- `src/lib/api.ts` -- All API functions including setAnalysisResult and transitionAnalysis
- `src/components/ui/data-table.tsx` -- TanStack Table pattern with 'use no memo' directive (required for any new useReactTable call)
- `integration-service/app/adapters/senaite.py` -- SENAITE adapter (reference for API patterns)

### SENAITE Analysis Workflow (Reference)

**State machine:**
- unassigned -> submit -> to_be_verified
- to_be_verified -> verify -> verified
- to_be_verified -> retract -> unassigned (re-enter)
- to_be_verified -> reject -> rejected
- verified -> retract -> retracted

**Critical pitfall:** SENAITE returns 200 OK for silently-skipped transitions. Backend must check post-transition review_state, not just HTTP status (DATA-04).

### Blockers/Concerns

- Phase 07: Before implementing retract/reject AlertDialog, manually test the retract transition against live SENAITE via Swagger UI. Confirm whether Remarks field is required. If yes, add Textarea to dialog before building UI.
  (Note: Plan 01 UI built without Remarks field — if backend requires it, Plan 03 or a follow-up plan adds Textarea to AlertDialog)

### Pending Todos

None.

## Session Continuity

Last session: 2026-02-25
Stopped at: Completed 07-02-PLAN.md — silent refreshSample + onTransitionComplete wiring
Resume file: None
