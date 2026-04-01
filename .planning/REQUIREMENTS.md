# Requirements: Accu-Mk1 v0.28.0

**Defined:** 2026-03-31
**Core Value:** Streamlined morning workflow: import CSV → review batch → calculate purity → push to SENAITE. One operator, one workstation, no friction.

## v0.28.0 Requirements

Requirements for worksheet feature milestone. Each maps to roadmap phases.

### Service Groups

- [x] **SGRP-01**: Admin can create, edit, and delete service groups (name, description, color, sort order)
- [x] **SGRP-02**: Admin can assign analysis services to service groups via checkbox-based membership editor
- [x] **SGRP-03**: Service groups display in admin UI with member service count and color badge
- [x] **SGRP-04**: Service group data persists in local SQLite (service_groups + service_group_members tables)

### Analyst Assignment

- [x] **ANLY-01**: User can view available analysts from the application (sourced from AccuMark user list)
- [x] **ANLY-02**: User can assign an analyst to a sample locally (stored in AccuMark worksheet_items table, not pushed to SENAITE — Analyst field is read-only in SENAITE)
- [x] **ANLY-03**: Analyst assignment approach verified — SENAITE Analyst field is read-only, assignment stays local in AccuMark

### Received Samples Queue (Inbox)

- [ ] **INBX-01**: User can view all received samples from SENAITE in a queue/inbox table
- [ ] **INBX-02**: Each sample row expands to show analyses grouped by service group with color badges
- [x] **INBX-03**: User can set sample priority (normal/high/expedited) with color-coded badge display
- [ ] **INBX-04**: User can assign a tech (analyst) to a sample inline via dropdown
- [x] **INBX-05**: User can assign an instrument to a sample inline via dropdown
- [x] **INBX-06**: Inbox shows aging timer per sample with SLA color coding (green <12h, yellow 12-20h, orange 20-24h, red >24h)
- [ ] **INBX-07**: User can select multiple samples via checkboxes and apply bulk actions (set priority, assign tech, set instrument)
- [ ] **INBX-08**: User can create a worksheet from selected inbox items (primary action)
- [x] **INBX-09**: Inbox auto-refreshes via 30-second polling with TanStack Query
- [ ] **INBX-10**: Worksheet creation validates each sample is still in sample_received state (stale data guard)
- [ ] **INBX-11**: Priority data persists locally in sample_priorities table

### Worksheet Management

- [ ] **WSHT-01**: User can view worksheet detail with header (title, analyst, status, created date, item count)
- [ ] **WSHT-02**: User can edit worksheet title and notes
- [ ] **WSHT-03**: Worksheet items table shows sample ID, analysis, service group, priority, tech, instrument, status
- [ ] **WSHT-04**: User can add samples to an existing worksheet (mini inbox modal)
- [ ] **WSHT-05**: User can remove items from a worksheet (items return to inbox)
- [ ] **WSHT-06**: User can reassign items to a different worksheet
- [ ] **WSHT-07**: User can mark a worksheet as completed
- [ ] **WSHT-08**: Worksheet data persists locally (worksheets + worksheet_items tables)

### Worksheets List

- [ ] **WLST-01**: User can view all worksheets with summary stats (title, analyst, status, item count, priority breakdown, oldest item age)
- [ ] **WLST-02**: KPI row displays total open worksheets, items pending, high-priority count, average age
- [ ] **WLST-03**: User can filter worksheets by status and analyst
- [ ] **WLST-04**: User can navigate from worksheet list to worksheet detail view

### Navigation

- [x] **NAVG-01**: Worksheets section accessible under HPLC Automation in sidebar navigation
- [x] **NAVG-02**: Hash navigation supports worksheets section and sub-sections (inbox, list, detail)

## Future Requirements

### Worksheet Automation

- **WAUT-01**: Auto-suggest tech assignments based on service group → analyst mapping
- **WAUT-02**: Auto-prioritize samples nearing SLA breach
- **WAUT-03**: Notification when worksheet items change state in SENAITE

## Out of Scope

| Feature | Reason |
|---------|--------|
| SENAITE worksheet sync | We're replacing SENAITE worksheets, not syncing with them |
| Real-time WebSocket updates | 30s polling is acceptable for this workflow |
| Multi-instrument per sample | One instrument assignment per sample in v1 |
| Worksheet templates | Defer to future — manual creation sufficient for v1 |
| Print/export worksheets | Defer to future milestone |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SGRP-01 | Phase 15 | Complete |
| SGRP-02 | Phase 15 | Complete |
| SGRP-03 | Phase 15 | Complete |
| SGRP-04 | Phase 15 | Complete |
| ANLY-01 | Phase 15 | Complete |
| ANLY-02 | Phase 15 | Complete |
| ANLY-03 | Phase 15 | Complete |
| INBX-01 | Phase 16 | Pending |
| INBX-02 | Phase 16 | Pending |
| INBX-03 | Phase 16 | Complete |
| INBX-04 | Phase 16 | Pending |
| INBX-05 | Phase 16 | Complete |
| INBX-06 | Phase 16 | Complete |
| INBX-07 | Phase 16 | Pending |
| INBX-08 | Phase 16 | Pending |
| INBX-09 | Phase 16 | Complete |
| INBX-10 | Phase 16 | Pending |
| INBX-11 | Phase 16 | Pending |
| WSHT-01 | Phase 17 | Pending |
| WSHT-02 | Phase 17 | Pending |
| WSHT-03 | Phase 17 | Pending |
| WSHT-04 | Phase 17 | Pending |
| WSHT-05 | Phase 17 | Pending |
| WSHT-06 | Phase 17 | Pending |
| WSHT-07 | Phase 17 | Pending |
| WSHT-08 | Phase 17 | Pending |
| WLST-01 | Phase 18 | Pending |
| WLST-02 | Phase 18 | Pending |
| WLST-03 | Phase 18 | Pending |
| WLST-04 | Phase 18 | Pending |
| NAVG-01 | Phase 15 | Complete |
| NAVG-02 | Phase 15 | Complete |

**Coverage:**
- v0.28.0 requirements: 32 total
- Mapped to phases: 32
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-31*
*Last updated: 2026-03-31 — traceability mapped after roadmap creation*
