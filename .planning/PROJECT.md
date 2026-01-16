# Accu-Mk1: Lab Desktop Application

## What This Is

A desktop application for lab operators to import overnight HPLC exports, calculate purity metrics, review and validate results in a batch workflow, and push approved results to SENAITE LIMS. Runs as both a browser app (for development/agent testing) and a Tauri-packaged desktop app.

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

### Out of Scope

- Direct instrument control — this app processes exports, doesn't talk to instruments
- Multi-user authentication — single-operator workstation model
- Cloud hosting — local-first architecture only
- Complex calculation UI — backend owns all scientific logic, UI just displays results

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

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Dual-mode (browser + Tauri) | Enables agent testing in Chrome while shipping as desktop app | — Pending |
| Folder-watch ingestion | Minimizes UI platform differences, simpler than manual upload | — Pending |
| FastAPI backend | Python ecosystem for scientific calculations, familiar for lab tooling | — Pending |
| SQLite local storage | Local-first requirement, no external dependencies | — Pending |

---
*Last updated: 2026-01-15 after initialization*
