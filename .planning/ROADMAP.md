# Roadmap

## Completed Milestones

- **v0.11.0 — New Analysis Wizard** ✅ SHIPPED 2026-02-20 — 5 phases, 9 plans, guided sample prep wizard with Mettler Toledo scale integration and SENAITE sample lookup. [Archive →](milestones/v0.11.0-new-analysis-wizard.md)

## Current Milestone

### v0.12.0 — Analysis Results & Workflow Actions (In Progress)

**Milestone Goal:** Enable lab staff to manage SENAITE analysis results directly from the Sample Details page — inline editing of result values, and full workflow transitions (submit, verify, retract, reject) with both per-row actions and bulk operations via a modern UI.

- [x] **Phase 06: Data Foundation + Inline Editing** ✅ — uid/keyword model, backend endpoints, AnalysisTable extraction, and click-to-edit result cells
- [x] **Phase 07: Per-Row Workflow Transitions** ✅ — state-aware action menus for all four transitions with sample-level refresh after each action
- [ ] **Phase 08: Bulk Selection & Floating Toolbar** — checkbox selection, floating batch action toolbar, and sequential bulk processing

---

## Phase Details

### Phase 06: Data Foundation + Inline Editing

**Goal:** Lab staff can enter analysis result values inline from the Sample Details page, with the data model and component structure in place to support all subsequent workflow work.

**Depends on:** Phase 05 (v0.11.0 — SENAITE sample lookup delivered)

**Requirements:** DATA-01, DATA-02, DATA-03, DATA-04, COMP-01, COMP-02, EDIT-01, EDIT-02, EDIT-03, EDIT-04

**Success Criteria** (what must be TRUE when this phase completes):
1. Each analysis row in Sample Details exposes its UID; network tab shows uid present in the lookup response
2. Swagger UI can call the result and transition endpoints against a live SENAITE instance and get meaningful responses
3. The analyses table renders from a standalone AnalysisTable component — SampleDetails.tsx no longer contains analysis rendering logic inline
4. User can click a result cell on an unassigned analysis, type a value, press Enter to save, and see the cell update immediately with a success toast
5. User can press Escape to cancel an edit with no change persisted; a failed save rolls back the cell to its previous value with an error toast

**Plans:** 4 plans in 3 waves

Plans:
- [x] 06-01-PLAN.md — Data model: uid/keyword on SenaiteAnalysis (backend Pydantic + frontend TypeScript + lookup route mapping)
- [x] 06-02-PLAN.md — Backend endpoints: POST /wizard/senaite/analyses/{uid}/result and /transition with EXPECTED_POST_STATES validation
- [x] 06-03-PLAN.md — Component extraction: AnalysisTable standalone component from SampleDetails.tsx
- [x] 06-04-PLAN.md — Inline editing: click-to-edit cells, Enter/Escape/Tab, optimistic update, rollback, toast feedback

---

### Phase 07: Per-Row Workflow Transitions

**Goal:** Lab staff can execute any valid workflow transition (submit, verify, retract, reject) on individual analysis rows, with the sample-level status badge and progress bar reflecting the change immediately.

**Depends on:** Phase 06

**Requirements:** WKFL-01, WKFL-02, WKFL-03, WKFL-04, WKFL-05, WKFL-06, WKFL-07, REFR-01, REFR-02

**Success Criteria** (what must be TRUE when this phase completes):
1. Each analysis row shows a dropdown menu that only surfaces transitions valid for its current state — an unassigned row never shows "Verify", a verified row never shows "Submit"
2. User can submit an unassigned analysis with a result value and watch the row badge change to to_be_verified without a page reload
3. User can verify a to_be_verified analysis; the row badge updates and the sample-level progress bar and status badge reflect the change
4. Retract and reject show a confirmation dialog before executing; dismissing the dialog leaves the row unchanged
5. While a transition is in-flight, the row shows a loading spinner and all action controls on that row are disabled — preventing double-submit

**Plans:** 2 plans in 2 waves

Plans:
- [x] 07-01-PLAN.md — API function + transition hook + ALLOWED_TRANSITIONS constants + Actions column DropdownMenu + AlertDialog for destructive actions
- [x] 07-02-PLAN.md — Silent sample refresh after transitions: refreshSample wiring in SampleDetails for badge/progress/counter updates

---

### Phase 08: Bulk Selection & Floating Toolbar

**Goal:** Lab staff can select multiple analyses at once and apply batch actions, making the common "submit all results" morning workflow a single operation instead of N individual clicks.

**Depends on:** Phase 07

**Requirements:** BULK-01, BULK-02, BULK-03, BULK-04

**Success Criteria** (what must be TRUE when this phase completes):
1. User can check one or more analysis rows; a floating toolbar appears showing the selection count and available batch action buttons
2. Batch action buttons in the toolbar only show actions valid for ALL selected analyses — selecting a mix of unassigned and verified rows hides "Submit" from the toolbar
3. User can trigger "Submit selected" and watch a progress counter ("Submitting 2/5...") advance through each analysis sequentially, with a final summary toast ("3 submitted, 1 failed")
4. After bulk operations complete, the sample-level progress bar and status badge reflect the aggregate result with a single refresh

**Plans:** TBD

Plans:
- [ ] 08-01: Checkbox selection column, indeterminate header checkbox, selectedUids state in AnalysisTable
- [ ] 08-02: Floating bulk action toolbar — conditional render, selection count, state-aware batch buttons
- [ ] 08-03: Sequential bulk processing loop — for...await, progress counter, per-item outcome tracking, post-batch fetchSample refresh

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 06. Data Foundation + Inline Editing | v0.12.0 | 4/4 | ✓ Complete | 2026-02-25 |
| 07. Per-Row Workflow Transitions | v0.12.0 | 2/2 | ✓ Complete | 2026-02-25 |
| 08. Bulk Selection & Floating Toolbar | v0.12.0 | 0/3 | Not started | - |
