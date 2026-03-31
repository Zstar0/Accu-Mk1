# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-31)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE. One operator, one workstation, no friction.
**Current focus:** v0.28.0 — Worksheet Feature (Custom Sample Assignment)

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-03-31 — Milestone v0.28.0 started

## Accumulated Context

### Decisions

- SENAITE Analyst field format (username vs UID) is a Phase 1 risk — test early before building bulk flows
- SenaiteAnalysis.keyword → AnalysisService.keyword is the join key for service groups
- Stale data guard needed on worksheet creation (validate sample_received state)
- main.py monolith pattern continues (~200 new lines)
- 30s poll interval acceptable for inbox freshness
- Worksheet pages live under HPLC Automation nav section
- UI/UX designed with /ui-ux-pro-max skill

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
Stopped at: Milestone v0.28.0 initialization
Resume file: None
