# Accu-Mk1: Lab Desktop Application

## What This Is

A lab application for operators to import instrument exports, calculate metrics (purity, quantity, endotoxin levels, sterility), review and validate results in a batch workflow, and push approved results to SENAITE LIMS. Supports multiple instrument types (HPLC, LAL/endotoxin, sterility, with LCMS/GCMS/heavy metals planned). Runs as both a browser app (shared web server) and a Tauri-packaged desktop app, with user authentication protecting access.

## Core Value

Streamlined lab workflow: import instrument data → review batch → calculate results → push to SENAITE. One operator, one workstation, any instrument type, no friction.

## Requirements

### Validated

- ✓ Dual-mode operation: browser (localhost) and Tauri desktop shell — v0.4.x
- ✓ CSV/Excel HPLC file import from watched local directory — v0.5.0
- ✓ Purity % calculation in Python backend — v0.5.0
- ✓ Batch review UI: see all results, approve/reject individual samples — v0.12.0
- ✓ SENAITE integration: update existing samples with calculated results — v0.5.0
- ✓ Modern, polished UI aesthetic (ClickUp/Figma-inspired visual design) — v0.8.0
- ✓ Local SQLite database for job state, results, audit logs — v0.4.x
- ✓ File cache for raw HPLC exports — v0.5.0
- ✓ User authentication (login, registration, password reset) — v0.6.0
- ✓ Role-based access control (standard + admin roles) — v0.6.0
- ✓ Protected routes and API endpoints — v0.6.0
- ✓ Service groups with M2M membership and admin UI — v0.28.0
- ✓ Received samples inbox with priority, aging, bulk actions — v0.28.0
- ✓ Worksheet creation, detail management, and completion — v0.28.0
- ✓ Worksheets list with KPI stats and filters — v0.28.0
- ✓ SENAITE analyst assignment (local, read-only in SENAITE) — v0.28.0

### Active

- [ ] Generalized instrument automation framework (method model, result storage, ingest pipeline)
- [ ] Pluggable parser/calculator registry per instrument type
- [ ] Endotoxin (LAL) automation with numeric EU/mL results
- [ ] Sterility automation with pass/fail results
- [ ] Mixed ingest support (file import + manual entry paths)
- [ ] HPLC refactored to use generalized framework
- [ ] Schema designed for cross-sample analytics (deferred UI)

### Out of Scope

- Direct instrument control — this app processes exports, doesn't talk to instruments
- ~~Multi-user authentication — single-operator workstation model~~ → Now active (v0.6.0)
- Complex calculation UI — backend owns all scientific logic, UI just displays results
- Email-based password reset — v1 uses console/log-based reset tokens, email added later
- OAuth/social login — email+password sufficient for lab environment

## Context

**Operator workflow:** Morning shift arrives, overnight HPLC runs have completed. Instrument software exports results as CSV/Excel to a local directory. Operator opens Accu-Mk1, reviews the imported batch, approves or rejects individual samples, and pushes validated results to SENAITE where samples already exist.

**SENAITE integration:** Results update existing sample records in SENAITE LIMS. This is an "add results" operation, not creating new samples.

**Calculation extensibility:** Purity % is the initial calculation. Additional calculations will be added as requirements are defined — the architecture should support pluggable calculation modules.

## Constraints

- **Template**: dannysmith/tauri-template as starting point
- **Frontend stack**: React + TypeScript + Tailwind + shadcn/ui
- **Backend stack**: Python + FastAPI
- **Storage**: SQLite (local-first, no external database)
- **UI principle**: Web-first development — UI must work fully in Chrome without Tauri APIs
- **Logic principle**: Backend owns all scientific calculations — UI never parses files or calculates metrics
- **Audit principle**: All imports and pushes must be idempotent, traceable, repeatable

## Current Milestone: v0.30.0 — Multi-Instrument Architecture

**Goal:** Generalize the HPLC-only automation pipeline into an instrument-agnostic framework, prove it with endotoxin (numeric) and sterility (pass/fail), and design the schema for future analytics.

**Target features:**
- Generalized Method model replacing HPLC-specific HplcMethod, with instrument-type config and analysis service relationships
- Generalized results storage supporting multiple result shapes (numeric, pass/fail, multi-point) with full provenance/audit trail
- Instrument automation registry: pluggable parsers, calculators, and ingest flows per instrument type
- Refactor existing HPLC automation to use the new framework (backwards compatibility)
- Endotoxin (LAL) automation: file or manual ingest → EU/mL result with provenance
- Sterility automation: manual entry → pass/fail result with provenance
- Mixed ingest support: CSV/file import and manual entry paths
- Schema designed to support cross-sample analytics (trending, averages by peptide/blend) — reporting UI deferred

## Current State (after v0.28.0)

The application now supports the full worksheet workflow: service group admin, received samples inbox with priority/SLA tracking, worksheet creation from inbox, worksheet detail management, and a worksheets list with KPI stats. 74 files changed, +16,290 lines across 4 phases and 12 plans.

## Previous Milestone: v0.28.0 — Worksheet Feature (COMPLETE)

**Delivered:** Custom worksheet workflow replacing SENAITE worksheets — service groups admin, received samples inbox with priority queue and aging timers, worksheet detail drawer with item management, worksheets list with KPI stats and filters. 32 requirements, all complete.

## Previous Milestone: v0.26.0 — Standard Sample Preps & Calibration Curve Chromatograms (COMPLETE)

**Delivered:** Standard sample preps, auto-create calibration curves from standard HPLC results, chromatogram overlay in HPLC flyout, standard injection detection, debug audit trail.

## Previous Milestone: v0.12.0 — Analysis Results & Workflow Actions (COMPLETE)

**Delivered:** Inline result editing, per-row workflow transitions (submit/verify/retract/reject), bulk selection with floating toolbar, sample-level state refresh. All 23 requirements complete.

## Previous State: v0.11.0 SHIPPED 2026-02-20

The New Analysis Wizard is fully delivered. Lab techs can now run a complete sample prep workflow — SENAITE lookup → weighing steps → stock prep → dilution → HPLC results entry — all with scale integration and a full audit-trail session record in SQLite.

## Previous Milestone: v0.11.0 — New Analysis Wizard (COMPLETE)

**Goal:** Guide lab techs step-by-step through HPLC sample prep — stock preparation, dilution, and weighing — with Mettler Toledo scale integration for automatic weight capture, producing a complete session record ready for HPLC injection.

## Previous Milestone: v0.6.0 — User Authentication (COMPLETE)

**Goal:** Add a fully functional user account system to protect the application for production deployment. Users log in with email + password, with standard and admin roles. Replaces the current API key system with proper JWT-based authentication.

**Delivered features:**
- User login with email + password (JWT access tokens, 1-hour expiry)
- Password hashing with bcrypt (direct library, not passlib)
- Password reset via admin UI (temporary password shown once)
- Two roles: standard and admin with backend enforcement
- Auth gate at App.tsx level (login page for unauthenticated users)
- All API endpoints protected with JWT Bearer auth
- Admin user management page (create, deactivate, reset password)
- Change password form (requires current password)
- Auto-seeded admin on first startup
- Works in both browser and Tauri desktop modes

**Stack additions:** bcrypt, python-jose[cryptography], python-multipart

## Previous Milestones

- **v0.11.0** — New Analysis Wizard (scale integration, sample prep, SENAITE lookup) — [Archive →](.planning/milestones/v0.11.0-new-analysis-wizard.md)
- **v0.10.0** — COA Explorer, In Progress tab, explorer improvements
- **v0.9.0** — Calibration accuracy fixes, SharePoint reliability, analysis UX
- **v0.8.0** — Dashboard, Peptide Config UI overhaul, SharePoint improvements
- **v0.7.0** — Docker deployment + production hosting
- **v0.6.0** — User authentication (JWT, roles, admin UI)
- **v0.5.0** — HPLC Peptide Analysis Pipeline (purity, quantity, identity)
- **v0.4.x** — Chromatograph viewer, AccuMark Tools, settings/API profiles

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Dual-mode (browser + Tauri) | Enables agent testing in Chrome while shipping as desktop app | Working |
| Folder-watch ingestion | Minimizes UI platform differences, simpler than manual upload | Working |
| FastAPI backend | Python ecosystem for scientific calculations, familiar for lab tooling | Working |
| SQLite local storage | Local-first requirement, no external dependencies | Working |
| Manual JWT (not FastAPI Users) | Avoids async SQLAlchemy migration, simpler to debug | v0.6.0 |
| Direct bcrypt (not passlib) | passlib incompatible with bcrypt>=4.1 | v0.6.0 |
| JWT Bearer tokens | Works for both web browser and Tauri desktop modes | v0.6.0 |
| Console password reset | Skip email infra for v1, log reset tokens to console/UI | v0.6.0 |
| Backend port 8012 | Avoid conflicts with Docker services on 8008-8009 | v0.6.0 |
| Local analyst assignment | SENAITE Analyst field is read-only; assignment stays in AccuMark | v0.28.0 |
| Staging worksheet pattern | __inbox_staging__ as parking lot for bulk pre-assignments | v0.28.0 |
| Stale data guard on worksheet creation | Verify sample state before committing worksheet | v0.28.0 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-06 — v0.30.0 Multi-Instrument Architecture milestone started*
