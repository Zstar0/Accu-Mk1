# Roadmap: Accu-Mk1

## Overview

Build a lab desktop application for HPLC result processing in 4 phases: foundation (dual-mode architecture), data pipeline (import + calculations), review workflow (batch UI), and SENAITE integration (LIMS sync). Each phase delivers a complete, verifiable capability toward the morning workflow: import CSV → review batch → calculate purity → push to SENAITE.

## Phases

- [x] **Phase 1: Foundation** — Dual-mode app architecture (React + Tauri + FastAPI + SQLite)
- [x] **Phase 2: Data Pipeline** — File import, parsing, and calculations
- [ ] **Phase 3: Review Workflow** — Batch review UI with approve/reject
- [ ] **Phase 4: SENAITE Integration** — Push approved results to LIMS

## Phase Details

### Phase 1: Foundation
**Goal**: Working dual-mode app (browser + Tauri) with FastAPI backend and SQLite storage
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04
**Success Criteria** (what must be TRUE):
  1. App runs in browser at localhost:3000
  2. App packages and runs as Tauri desktop application
  3. FastAPI backend starts and responds to health check
  4. SQLite database initializes with schema
  5. Audit log table exists and can receive entries
**Research**: Likely (dannysmith/tauri-template, FastAPI sidecar pattern)
**Research topics**: Tauri template setup, React + FastAPI communication, SQLite with both modes
**Plans**: TBD

### Phase 2: Data Pipeline
**Goal**: System imports HPLC files, calculates purity/retention/compound ID, and stores results
**Depends on**: Phase 1
**Requirements**: IMPORT-01, IMPORT-02, IMPORT-03, IMPORT-04, CALC-01, CALC-02, CALC-03, CALC-04, SETTINGS-01, SETTINGS-02
**Success Criteria** (what must be TRUE):
  1. System detects new CSV files in watched directory
  2. User can manually select files when needed
  3. Raw files are cached for audit
  4. Purity % calculates correctly using linear equation
  5. Retention times display for each sample
  6. Compounds identified by retention time ranges
  7. Calculation inputs/outputs logged
  8. User can configure directory path and compound ranges in settings
**Research**: Unlikely (standard CSV parsing, linear math)
**Plans**: TBD

### Phase 3: Review Workflow
**Goal**: Operator can review batch, approve/reject samples, filter/sort results
**Depends on**: Phase 2
**Requirements**: REVIEW-01, REVIEW-02, REVIEW-03, REVIEW-04
**Success Criteria** (what must be TRUE):
  1. User sees all samples in batch with purity, retention time, compound ID
  2. User can approve individual samples
  3. User can reject individual samples with reason/comment
  4. User can filter samples by status, compound, etc.
  5. User can sort samples by any column
**Research**: Unlikely (standard UI patterns with shadcn/ui)
**Plans**: 4 plans
  - 03-01: Sample Review Backend (status + approve/reject API)
  - 03-02: Batch Review UI (table view)
  - 03-03: Approve/Reject Actions (UI + mutations)
  - 03-04: Filter and Sort (client-side)

### Phase 4: SENAITE Integration
**Goal**: Push approved results to SENAITE LIMS, show sync status
**Depends on**: Phase 3
**Requirements**: SENAITE-01, SENAITE-02, SENAITE-03
**Success Criteria** (what must be TRUE):
  1. User can push approved results to SENAITE
  2. System updates existing SENAITE samples (not create new)
  3. User sees sync status (success/failure) per sample
  4. Push operations logged in audit trail
**Research**: Likely (SENAITE API)
**Research topics**: SENAITE REST API, authentication, sample update endpoints
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Complete | 2026-01-16 |
| 2. Data Pipeline | 7/7 | Complete | 2026-01-16 |
| 3. Review Workflow | 0/4 | Planned | - |
| 4. SENAITE Integration | 0/TBD | Not started | - |
