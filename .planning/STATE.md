# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-31)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE. One operator, one workstation, no friction.
**Current focus:** v0.28.0 — Worksheet Feature (Custom Sample Assignment)

## Current Position

Phase: 15 — Foundation
Plan: —
Status: Not started
Last activity: 2026-03-31 — Roadmap created for v0.28.0

Progress: [░░░░░░░░░░░░░░░░░░░░] 0% (0/4 phases complete)

## Performance Metrics

| Metric | Value |
|--------|-------|
| Current milestone | v0.28.0 |
| Total phases this milestone | 4 |
| Phases complete | 0 |
| Requirements mapped | 32/32 |

## Accumulated Context

### Decisions

- SENAITE Analyst field format (username vs UID) is a Phase 15 risk — test early before building bulk flows (ANLY-03)
- SenaiteAnalysis.keyword → AnalysisService.keyword is the join key for service group membership display
- Stale data guard on worksheet creation: validate all selected samples are still in `sample_received` state (INBX-10)
- main.py monolith pattern continues (~200 new lines expected)
- 30s poll interval acceptable for inbox freshness — TanStack Query refetchInterval
- Worksheet pages live under HPLC Automation nav section
- UI/UX designed with /ui-ux-pro-max skill
- New SQLite tables needed: service_groups, service_group_members, sample_priorities, worksheets, worksheet_items

### Key Source Files

- backend/models.py — All SQLAlchemy models
- backend/main.py — All endpoints, SENAITE integration
- src/store/ui-store.ts — Navigation sections
- src/lib/hash-navigation.ts — Hash routing
- src/components/layout/AppSidebar.tsx — Sidebar nav
- src/components/layout/MainWindowContent.tsx — Section switch
- src/lib/api.ts — All TypeScript types and API functions

### Blockers/Concerns

None.

### Pending Todos

None.

## Session Continuity

Last session: 2026-03-31
Stopped at: Roadmap written for v0.28.0 — ready for Phase 15 planning
Resume file: None
