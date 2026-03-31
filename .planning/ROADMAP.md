# Roadmap

## Completed Milestones

- **v0.11.0 — New Analysis Wizard** SHIPPED 2026-02-20 — 5 phases, 9 plans, guided sample prep wizard with Mettler Toledo scale integration and SENAITE sample lookup. [Archive -->](milestones/v0.11.0-new-analysis-wizard.md)

<details>
<summary>v0.12.0 — Analysis Results & Workflow Actions — SHIPPED 2026-02-25</summary>

- [x] **Phase 06: Data Foundation + Inline Editing** — uid/keyword model, backend endpoints, AnalysisTable extraction, and click-to-edit result cells
- [x] **Phase 07: Per-Row Workflow Transitions** — state-aware action menus for all four transitions with sample-level refresh after each action
- [x] **Phase 08: Bulk Selection & Floating Toolbar** — checkbox selection, floating batch action toolbar, and sequential bulk processing

</details>

<details>
<summary>v0.26.0 — Standard Sample Preps & Calibration Curve Chromatograms — SHIPPED</summary>

- [x] **Phase 09: Data Model + Standard Prep Flag** — schema additions for CalibrationCurve, standard toggle + metadata in wizard, standard badge + filter in list
- [x] **Phase 10: Auto-Create Curve from Standard** — HPLC completion on a standard triggers automatic calibration curve creation with full provenance
- [x] **Phase 10.5: HPLC Results Persistence** — full provenance enrichment of hplc_analyses rows, chromatogram storage, DB reload
- [x] **Phase 11: Backfill Existing Curves** — edit existing curves to link Sample ID, fetch chromatogram from SharePoint, edit manufacturer/notes
- [x] **Phase 12: Chromatogram Overlay** — render standard reference trace alongside sample trace in HPLC flyout
- [x] **Phase 13: Same-Method Identity Check** — detect standard injection files, extract RTs, use as identity reference
- [x] **Phase 13.5: HPLC Audit Trail & Debug Persistence** — persist full debug log, source file checksums, visible warnings
- [x] **Phase 14: RT Check Chromatogram Comparison** — side-by-side chromatogram comparison in HPLC flyout for identity verification

</details>

## Current Milestone

### v0.28.0 — Worksheet Feature (Custom Sample Assignment)

**Milestone Goal:** Replace SENAITE worksheet creation with a custom workflow supporting priority-based assignment, analysis-level tech routing via service groups, and 24hr SLA tracking.

## Phases

- [ ] **Phase 15: Foundation** — Service groups data model + admin UI, analyst assignment to SENAITE, and navigation wiring
- [ ] **Phase 16: Received Samples Inbox** — Full inbox queue with priority, aging timers, inline assignment, bulk actions, and worksheet creation
- [ ] **Phase 17: Worksheet Detail** — Worksheet header, items table, add/remove/reassign items, and completion
- [ ] **Phase 18: Worksheets List** — All-worksheets view with KPI stats row, filters, and drill-through navigation

---

## Phase Details

### Phase 15: Foundation

**Goal:** Admins can define service groups that classify analysis services by discipline, users can view and assign SENAITE analysts, and the Worksheets section is accessible in the sidebar under HPLC Automation.

**Depends on:** Phase 14 (v0.26.0 complete)

**Requirements:** SGRP-01, SGRP-02, SGRP-03, SGRP-04, ANLY-01, ANLY-02, ANLY-03, NAVG-01, NAVG-02

**Success Criteria** (what must be TRUE when this phase completes):
1. Admin can create a service group with name, description, color, and sort order — and edit or delete it from the admin UI
2. Admin can open a service group's membership editor and toggle analysis services on/off via checkboxes; membership changes persist and the group card shows the correct member count
3. The application sidebar shows a Worksheets section under HPLC Automation; hash navigation routes correctly to worksheets sub-sections (inbox, list, detail)
4. A user can see the list of available SENAITE analysts (lab contacts) from within the application
5. Assigning an analyst to a SENAITE analysis pushes the correct field value to SENAITE and the assignment is confirmed as accepted (field format verified: username vs UID)

**Plans:** 4 plans

Plans:
- [ ] 15-01-PLAN.md — Backend data model (ServiceGroup + M2M), CRUD endpoints, SENAITE analyst proxy
- [ ] 15-02-PLAN.md — Navigation wiring (type unions, sidebar items, placeholder pages)
- [ ] 15-03-PLAN.md — Service Groups admin UI (table + slide-out + membership editor)
- [ ] 15-04-PLAN.md — SENAITE Analyst field format verification

**UI hint**: yes

---

### Phase 16: Received Samples Inbox

**Goal:** Users see all SENAITE received samples in a live queue with aging timers and SLA color coding, can set priority and assign tech/instrument inline or in bulk, and can create a worksheet from selected samples in one action.

**Depends on:** Phase 15

**Requirements:** INBX-01, INBX-02, INBX-03, INBX-04, INBX-05, INBX-06, INBX-07, INBX-08, INBX-09, INBX-10, INBX-11

**Success Criteria** (what must be TRUE when this phase completes):
1. Opening the Inbox page shows a table of all SENAITE samples in `sample_received` state; the table auto-refreshes every 30 seconds without user action
2. Expanding a sample row reveals its analyses grouped by service group with the group's color badge visible on each analysis row
3. Each sample shows a live aging timer with SLA color coding: green under 12h, yellow 12–20h, orange 20–24h, red over 24h
4. User can set priority (normal / high / expedited) on a single sample inline; the priority badge updates immediately and persists across page reloads
5. User can select multiple samples with checkboxes and apply bulk actions (set priority, assign tech, set instrument) to all selected rows in one step
6. Selecting one or more samples and clicking "Create Worksheet" produces a new worksheet; if any selected sample has left `sample_received` state, creation is blocked with a clear error identifying the stale item(s)

**Plans:** TBD

**UI hint**: yes

---

### Phase 17: Worksheet Detail

**Goal:** Users can open any worksheet, view and edit its header and notes, manage its items (add, remove, reassign), and mark the worksheet complete when all work is done.

**Depends on:** Phase 16

**Requirements:** WSHT-01, WSHT-02, WSHT-03, WSHT-04, WSHT-05, WSHT-06, WSHT-07, WSHT-08

**Success Criteria** (what must be TRUE when this phase completes):
1. The worksheet detail page displays a header with title, assigned analyst, status, created date, and item count; user can edit the title and notes fields and save inline
2. The items table shows each item's sample ID, analysis, service group (with color badge), priority, assigned tech, instrument, and current status
3. User can open a mini inbox modal from the detail view and add additional samples to the worksheet; added items appear in the items table immediately
4. User can remove an item from a worksheet — the item disappears from the worksheet and becomes available again in the inbox
5. User can reassign one or more items to a different worksheet from the detail view
6. User can click "Complete Worksheet" to transition the worksheet to completed status; the action is reflected in both the detail header and the worksheets list

**Plans:** TBD

**UI hint**: yes

---

### Phase 18: Worksheets List

**Goal:** Users can see all worksheets at a glance with KPI totals and per-worksheet summary stats, filter by status or analyst, and navigate directly to any worksheet detail view.

**Depends on:** Phase 17

**Requirements:** WLST-01, WLST-02, WLST-03, WLST-04

**Success Criteria** (what must be TRUE when this phase completes):
1. The Worksheets List page shows every worksheet as a row with title, analyst, status badge, item count, priority breakdown, and age of oldest item
2. A KPI row at the top of the page displays: total open worksheets, total items pending, high-priority item count, and average item age — all derived live from current data
3. User can filter the list by status (open / completed / all) and by analyst; the list updates without a page reload
4. Clicking any worksheet row navigates to that worksheet's detail view

**Plans:** TBD

**UI hint**: yes

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 06. Data Foundation + Inline Editing | v0.12.0 | 4/4 | Complete | 2026-02-25 |
| 07. Per-Row Workflow Transitions | v0.12.0 | 2/2 | Complete | 2026-02-25 |
| 08. Bulk Selection & Floating Toolbar | v0.12.0 | 2/2 | Complete | 2026-02-25 |
| 09. Data Model + Standard Prep Flag | v0.26.0 | 2/2 | Complete | 2026-03-16 |
| 10. Auto-Create Curve from Standard | v0.26.0 | 3/3 | Complete | — |
| 10.5 HPLC Results Persistence | v0.26.0 | 2/2 | Complete | 2026-03-18 |
| 11. Backfill Existing Curves | v0.26.0 | 2/2 | Complete | 2026-03-18 |
| 12. Chromatogram Overlay | v0.26.0 | 2/2 | Complete | 2026-03-18 |
| 13. Same-Method Identity Check | v0.26.0 | 3/3 | Complete | 2026-03-19 |
| 13.5 HPLC Audit Trail & Debug | v0.26.0 | 3/3 | Complete | 2026-03-19 |
| 14. RT Check Chromatogram Comparison | v0.26.0 | 0/? | Not started | - |
| 15. Foundation | v0.28.0 | 0/4 | Not started | - |
| 16. Received Samples Inbox | v0.28.0 | 0/? | Not started | - |
| 17. Worksheet Detail | v0.28.0 | 0/? | Not started | - |
| 18. Worksheets List | v0.28.0 | 0/? | Not started | - |
