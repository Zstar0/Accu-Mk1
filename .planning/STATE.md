# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-01-15)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE
**Current focus:** Phase 2 - Data Pipeline (IN PROGRESS)

## Current Position

Phase: 2 of 4 (Data Pipeline)
Plan: 3 of 4 complete
Status: In progress
Last activity: 2026-01-16 - Completed 02-04-PLAN.md (Calculation Engine)

Progress: ██████░░░░ 60%

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: 3 min 54 sec
- Total execution time: ~23 min 21 sec

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. Foundation | 3 | 11 min 25 sec | 3 min 48 sec |
| 2. Data Pipeline | 3 | ~11 min 56 sec | ~4 min |

**Recent Trend:**
- Last 5 plans: 01-03 (3 min), 02-01 (3 min 56 sec), 02-02 (4 min), 02-03, 02-04 (~4 min)
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

### Pending Todos

None yet.

### Blockers/Concerns

- Updater signing not configured (TAURI_SIGNING_PRIVATE_KEY needed for release builds with updates)

## Session Continuity

Last session: 2026-01-16
Stopped at: Completed 02-04-PLAN.md (Calculation Engine)
Resume file: None
