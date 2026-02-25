# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-24)

**Core value:** Streamlined morning workflow: import CSV → review batch → calculate purity → push to SENAITE. One operator, one workstation, no friction.
**Current focus:** v0.12.0 — Analysis Results & Workflow Actions — Phase 06

## Current Position

Phase: 06 of 08 (Data Foundation + Inline Editing)
Plan: 2 of 4 in current phase
Status: In progress
Last activity: 2026-02-25 — Completed 06-02-PLAN.md

Progress: [██░░░░░░░░] 20%

## Performance Metrics

**Velocity:**
- Total plans completed: 2 (this milestone)
- Average duration: 2 min
- Total execution time: 3 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 06 | 2/4 | 3 min | 2 min |
| 07 | 0/3 | — | — |
| 08 | 0/3 | — | — |

*Updated after each plan completion*

## Accumulated Context

### Decisions

- Analysis transitions go through Accu-Mk1 backend → SENAITE REST API (same as existing sample field updates)
- UX: Both per-row action menus AND checkbox bulk selection with floating toolbar
- Sample-level state refreshes after analysis transitions
- Component extraction (AnalysisTable) is mandatory before adding any new state — SampleDetails.tsx is 1400+ lines
- Bulk operations must be sequential for...await (never Promise.all) to avoid SENAITE workflow race conditions
- REFR-01/REFR-02 assigned to Phase 07 — sample refresh is triggered by per-row transitions, not just bulk
- uid and keyword placed before title field as primary identifiers in SenaiteAnalysis model
- Both uid/keyword nullable for backward compatibility with older cached responses
- uid mapping uses dual fallback (uid/UID) and keyword mapping uses (Keyword/getKeyword) for SENAITE API casing
- Result-set and transition are separate atomic endpoints — frontend controls the two-step workflow
- EXPECTED_POST_STATES mapping validates post-transition review_state to catch SENAITE silent rejections (DATA-04)

### Key Source Files

- `backend/main.py` — FastAPI app, all endpoints, SENAITE integration
- `src/components/senaite/SampleDetails.tsx` — Sample Details page (analyses table lives here)
- `src/lib/api.ts` — All API functions including SENAITE endpoints
- `src/components/ui/data-table.tsx` — TanStack Table pattern with 'use no memo' directive (required for any new useReactTable call)
- `integration-service/app/adapters/senaite.py` — SENAITE adapter (reference for API patterns)

### SENAITE Analysis Workflow (Reference)

**State machine:**
- unassigned → submit → to_be_verified
- to_be_verified → verify → verified
- to_be_verified → retract → unassigned (re-enter)
- to_be_verified → reject → rejected
- verified → retract → retracted

**Critical pitfall:** SENAITE returns 200 OK for silently-skipped transitions. Backend must check post-transition review_state, not just HTTP status (DATA-04).

### Blockers/Concerns

- Phase 07: Before implementing retract/reject AlertDialog, manually test the retract transition against live SENAITE via Swagger UI. Confirm whether Remarks field is required. If yes, add Textarea to dialog before building UI.

### Pending Todos

None.

## Session Continuity

Last session: 2026-02-25
Stopped at: Completed 06-02-PLAN.md
Resume file: None
