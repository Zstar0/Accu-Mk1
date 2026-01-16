# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-01-15)

**Core value:** Streamlined morning workflow: import CSV -> review batch -> calculate purity -> push to SENAITE
**Current focus:** Phase 2 - Data Pipeline (VERIFIED COMPLETE)

## Current Position

Phase: 2 of 4 (Data Pipeline)
Plan: 7 of 7 complete
Status: Phase verified complete
Last activity: 2026-01-16 - Phase 2 verification passed (8/8 must-haves)

Progress: ██████████ 50%

## Performance Metrics

**Velocity:**
- Total plans completed: 10
- Average duration: 3 min 51 sec
- Total execution time: ~38 min 52 sec

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. Foundation | 3 | 11 min 25 sec | 3 min 48 sec |
| 2. Data Pipeline | 7 | ~27 min 27 sec | ~3 min 55 sec |

**Recent Trend:**
- Last 5 plans: 02-03 (4 min 5 sec), 02-04 (~4 min), 02-06 (3 min), 02-07 (4 min 13 sec)
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

### Pending Todos

None yet.

### Blockers/Concerns

- Updater signing not configured (TAURI_SIGNING_PRIVATE_KEY needed for release builds with updates)

## Session Continuity

Last session: 2026-01-16T15:00:00Z
Stopped at: Phase 2 verification passed - ready for Phase 3
Resume file: None
