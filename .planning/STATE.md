# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-01-15)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE
**Current focus:** Phase 3 - Review Workflow (IN PROGRESS)

## Current Position

Phase: 3 of 4 (Review Workflow)
Plan: 1 of 4 complete
Status: In progress
Last activity: 2026-01-16 - Completed 03-01-PLAN.md (Sample Review Backend)

Progress: ███████████░░░░░░░░░ 55%

## Performance Metrics

**Velocity:**
- Total plans completed: 11
- Average duration: 3 min 51 sec
- Total execution time: ~42 min 52 sec

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. Foundation | 3 | 11 min 25 sec | 3 min 48 sec |
| 2. Data Pipeline | 7 | ~27 min 27 sec | ~3 min 55 sec |
| 3. Review Workflow | 1 | 4 min | 4 min |

**Recent Trend:**
- Last 5 plans: 02-04 (~4 min), 02-06 (3 min), 02-07 (4 min 13 sec), 03-01 (4 min)
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
- RT matching uses inclusive bounds (rt_min <= rt <= rt_max)
- compound_ranges stored as JSON string with format {name: {rt_min, rt_max}}
- watchdog library for cross-platform file system monitoring
- get_detected_files clears list after retrieval (consume-once pattern)
- Purity formula uses linear equation: (area - intercept) / slope
- Calibration settings seeded with placeholder defaults (1.0, 0.0)
- Approving clears rejection_reason (allows re-approval after rejection)
- Both approve/reject create audit log entries with old/new status

### Pending Todos

None yet.

### Blockers/Concerns

- Updater signing not configured (TAURI_SIGNING_PRIVATE_KEY needed for release builds with updates)

## Session Continuity

Last session: 2026-01-16T16:19:00Z
Stopped at: Completed 03-01-PLAN.md (Sample Review Backend)
Resume file: None
