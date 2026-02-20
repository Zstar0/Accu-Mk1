# Accu-Mk1: Lab Desktop Application

## What This Is

A lab application for operators to import overnight HPLC exports, calculate purity metrics, review and validate results in a batch workflow, and push approved results to SENAITE LIMS. Runs as both a browser app (shared web server) and a Tauri-packaged desktop app, with user authentication protecting access.

## Core Value

Streamlined morning workflow: import CSV → review batch → calculate purity → push to SENAITE. One operator, one workstation, no friction.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Dual-mode operation: browser (localhost) and Tauri desktop shell
- [ ] CSV/Excel HPLC file import from watched local directory
- [ ] Purity % calculation in Python backend
- [ ] Batch review UI: see all results, approve/reject individual samples
- [ ] SENAITE integration: update existing samples with calculated results
- [ ] Modern, polished UI aesthetic (ClickUp/Figma-inspired visual design)
- [ ] Local SQLite database for job state, results, audit logs
- [ ] File cache for raw HPLC exports
- [ ] User authentication (login, registration, password reset)
- [ ] Role-based access control (standard + admin roles)
- [ ] Protected routes and API endpoints

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

## Current Milestone: v0.11.0 — New Analysis Wizard

**Goal:** Guide lab techs step-by-step through HPLC sample prep — stock preparation, dilution, and weighing — with Mettler Toledo scale integration for automatic weight capture, producing a complete session record ready for HPLC injection.

**Target features:**
- SENAITE sample lookup (pull sample ID, peptide, declared weight)
- Stripe-style step wizard UI with vertical progress navigation
- Mettler Toledo XSR105DU scale integration via network (auto-pull stable weight readings)
- Stock preparation workflow (5 weighing steps + stock concentration calculation)
- Dilution calculation (compute diluent volume + stock volume to hit target conc/volume)
- Tech-entered target concentration and total volume
- Session record persisted to DB (all measurements, calculations, timestamps)
- Results entry after HPLC run (peak area → purity %, peptide mass)

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

---
*Last updated: 2026-02-19 after v0.11.0 milestone started*
