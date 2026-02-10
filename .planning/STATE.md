# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-10)

**Core value:** Streamlined morning workflow with secure access control for production deployment
**Current focus:** Between milestones — ready for next milestone planning

## Last Completed Milestone: v0.6.0

Status: Complete (2026-02-09)
Delivered: JWT user authentication, role-based access, admin management

## Previous Milestones

- v0.6.0 — User Authentication (JWT, roles, admin UI)
- v0.5.0 — HPLC Peptide Analysis Pipeline (purity, quantity, identity)
- v0.4.x — Chromatograph viewer, AccuMark Tools, settings/API profiles

## Milestone Documents

- v0.6.0 Requirements: `.planning/REQUIREMENTS-v0.6.0.md`
- v0.6.0 Roadmap: `.planning/ROADMAP-v0.6.0.md`
- Original roadmap (phases 1-2 complete, 3-4 superseded): `.planning/ROADMAP-v0.4-archived.md`
- Research: `.planning/research/`

## Accumulated Context

### Decisions

- Manual JWT implementation (not FastAPI Users) — avoids async SQLAlchemy migration
- Direct bcrypt library (not passlib) — passlib incompatible with bcrypt>=4.1
- python-jose for JWT — sub claim must be string per spec
- JWT Bearer tokens stored in localStorage (works for both browser and Tauri)
- Zustand auth store (consistent with existing pattern)
- Two roles: standard + admin
- Console/log-based password reset (no email infra for v1)
- First admin auto-seeded on startup
- Backend moved to port 8012 (avoid conflicts with other services)
- Original Phase 3 (BatchReview) and Phase 4 (SENAITE) superseded by v0.5.0 HPLC pipeline

### Blockers/Concerns

- None

### Key Bug Fixes During Implementation

- passlib + bcrypt>=4.1 incompatibility → replaced with direct bcrypt
- JWT sub claim must be string → changed to str(user.id)
- uvicorn --reload broken on OneDrive paths → manual restarts needed
- Port conflicts (8009 occupied, 8011 ghost process) → moved to 8012
- Dark mode autofill unreadable → CSS overrides outside @layer base

## Session Continuity

Last session: 2026-02-10
Stopped at: Closed out stale phases 3-4, ready for new milestone
Resume file: None
