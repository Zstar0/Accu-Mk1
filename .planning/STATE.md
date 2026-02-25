# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-24)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE. One operator, one workstation, no friction.
**Current focus:** v0.12.0 — Analysis Results & Workflow Actions — Phase 08

## Current Position

Phase: 08 of 08 (Bulk Selection & Floating Toolbar)
Plan: 1 of 3 in current phase
Status: In progress
Last activity: 2026-02-25 — Completed 08-01-PLAN.md

Progress: [████████░░] 75%

## Performance Metrics

**Velocity:**
- Total plans completed: 7 (this milestone)
- Average duration: 3 min
- Total execution time: 19 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 06 | 4/4 | 11 min | 3 min |
| 07 | 2/2 | 7 min | 4 min |
| 08 | 1/3 | 1 min | 1 min |

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
- ALLOWED_TRANSITIONS constant gates per-row action menus (unassigned->submit, to_be_verified->verify/retract/reject, verified->retract)
- DESTRUCTIVE_TRANSITIONS (retract, reject) gate through AlertDialog confirmation; non-destructive execute immediately
- TRANSITION_LABELS defined locally in both hook and AnalysisTable.tsx (hook must not import from component)
- pendingUids uses Set<string> not boolean -- independent per-row loading state for concurrent transitions
- pendingConfirm object drives controlled AlertDialog (outside <table> for valid DOM nesting)
- refreshSample is a silent re-fetch (no setLoading(true)) to avoid full-page spinner flash after transitions
- refreshSample replaces entire data object via setData(result) -- full replacement ensures all derived state reflects server truth
- TRANSITION_PAST_TENSE map defined locally in bulk hook (hook must not import from component)
- Checkbox indeterminate state uses data-[state=indeterminate] Tailwind variants on Indicator's child icons
- clearSelection called inside executeBulk after onTransitionComplete — hook cleans its own selection state

### Key Source Files

- `backend/main.py` -- FastAPI app, all endpoints, SENAITE integration
- `src/components/senaite/SampleDetails.tsx` -- Sample Details page with refreshSample() silent re-fetch, onTransitionComplete wired to AnalysisTable
- `src/components/senaite/AnalysisTable.tsx` -- Analysis table with inline editing, filter tabs, progress bar, Actions column with DropdownMenu + AlertDialog, onTransitionComplete prop
- `src/hooks/use-analysis-editing.ts` -- Hook for inline result editing (edit state, save, cancel, Tab nav)
- `src/hooks/use-analysis-transition.ts` -- Hook for per-row workflow transitions (pendingUids Set, pendingConfirm, confirmAndExecute)
- `src/lib/api.ts` -- All API functions including setAnalysisResult, transitionAnalysis
- `src/components/ui/data-table.tsx` -- TanStack Table pattern with 'use no memo' directive (required for any new useReactTable call)
- `src/components/ui/checkbox.tsx` -- Shared Checkbox with indeterminate visual (MinusIcon)
- `src/hooks/use-bulk-analysis-transition.ts` -- Bulk selection state + sequential processing hook
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

None.

### Pending Todos

None.

## Session Continuity

Last session: 2026-02-25
Stopped at: Completed 08-01-PLAN.md — Checkbox indeterminate visual + useBulkAnalysisTransition hook
Resume file: None
