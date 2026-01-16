# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-01-15)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE
**Current focus:** Phase 2 - Data Pipeline (COMPLETE)

## Current Position

Phase: 2 of 4 (Data Pipeline)
Plan: 4 of 4 complete
Status: Phase complete
Last activity: 2026-01-16 - Completed 02-03-PLAN.md (Manual File Selection UI)

Progress: ███████░░░ 70%

## Performance Metrics

**Velocity:**
- Total plans completed: 7
- Average duration: 3 min 56 sec
- Total execution time: ~27 min 26 sec

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. Foundation | 3 | 11 min 25 sec | 3 min 48 sec |
| 2. Data Pipeline | 4 | ~16 min 1 sec | ~4 min |

**Recent Trend:**
- Last 5 plans: 02-01 (3 min 56 sec), 02-02 (4 min), 02-03 (4 min 5 sec), 02-04 (~4 min)
- Trend: Consistent ~4 min per plan

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Used dannysmith/tauri-template as base (provides shadcn/ui, Zustand, TanStack Query, i18n)
- App identifier: com.accumark.accu-mk1
- Dev server runs on port 1420 (Tauri default)
- SQLite database stored at ./data/accu-mk1.db
- Backend CORS allows localhost:1420, localhost:5173, tauri://localhost
- SQLAlchemy 2.0 style with mapped_column for type-safe models
- CSP connect-src extended for backend URL (not HTTP plugin)
- BackendStatus discriminated union pattern for connection states
- Key-value pattern for settings (flexible, simple)
- Column mappings stored as JSON string in value field
- Settings seeded on startup with defaults
- TXT parser first, CSV/Excel later
- Sample.input_data stores raw parsed rows as JSON
- CalculationResult dataclass in formulas.py (single source of truth)
- Formula registry pattern for type-based lookup
- calculate_all runs applicable calculations based on settings
- Local file parsing for preview (tab-delimited format in browser)
- Toast notifications via sonner for import feedback

### Pending Todos

None yet.

### Blockers/Concerns

- Updater signing not configured (TAURI_SIGNING_PRIVATE_KEY needed for release builds with updates)

## Session Continuity

Last session: 2026-01-16T06:46:05Z
Stopped at: Completed 02-03-PLAN.md (Manual File Selection UI) - Phase 2 complete
Resume file: None
