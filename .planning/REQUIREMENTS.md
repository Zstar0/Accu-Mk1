# Requirements: Accu-Mk1 v0.12.0

**Defined:** 2026-02-24
**Core Value:** Streamlined morning workflow: import CSV, review batch, calculate purity, push to SENAITE. One operator, one workstation, no friction.

## v0.12.0 Requirements

Requirements for Analysis Results & Workflow Actions milestone. Each maps to roadmap phases.

### Data Foundation

- [x] **DATA-01**: Analysis UID and keyword exposed in SenaiteAnalysis type (backend Pydantic model + frontend TypeScript interface)
- [x] **DATA-02**: Backend endpoint to set an analysis result value via SENAITE REST API (`POST /update/{uid}` with `{"Result": value}`)
- [x] **DATA-03**: Backend endpoint to trigger a workflow transition on an analysis via SENAITE REST API (`POST /update/{uid}` with `{"transition": name}`)
- [x] **DATA-04**: Backend verifies post-transition `review_state` in SENAITE response (not just HTTP status) to detect silent rejections

### Component Extraction

- [x] **COMP-01**: AnalysisTable extracted from SampleDetails.tsx as a standalone component with its own file
- [x] **COMP-02**: AnalysisTable receives analyses data and callbacks as props (clean interface, no direct SENAITE fetching inside)

### Inline Editing

- [x] **EDIT-01**: User can click a result cell on an unassigned analysis to enter/edit the value inline
- [x] **EDIT-02**: Enter saves the value, Escape cancels edit, Tab moves to next editable cell
- [x] **EDIT-03**: Saving shows optimistic update immediately in the cell with rollback on SENAITE error
- [x] **EDIT-04**: Toast notification confirms successful save or shows error message on failure

### Workflow Transitions

- [ ] **WKFL-01**: Each analysis row shows a state-aware action menu with only valid transitions for that analysis's current state
- [ ] **WKFL-02**: User can submit an unassigned analysis (sets result value + triggers submit transition in one action)
- [ ] **WKFL-03**: User can verify a to_be_verified analysis (triggers verify transition)
- [ ] **WKFL-04**: User can retract a to_be_verified or verified analysis (triggers retract transition)
- [ ] **WKFL-05**: User can reject a to_be_verified analysis (triggers reject transition)
- [ ] **WKFL-06**: Retract and reject display a confirmation dialog before executing the transition
- [ ] **WKFL-07**: Per-row loading spinner during transition execution (disables other actions on that row)

### Bulk Operations

- [ ] **BULK-01**: Checkbox column for selecting multiple analyses in the table
- [ ] **BULK-02**: Floating toolbar appears when rows are selected, showing selection count + batch action buttons
- [ ] **BULK-03**: Batch actions are state-aware (only show actions valid for ALL selected analyses)
- [ ] **BULK-04**: Bulk operations process analyses sequentially with per-item success/failure reporting via toast

### Sample State Refresh

- [ ] **REFR-01**: After any analysis transition, re-fetch the parent sample to reflect updated progress bar and status badge
- [ ] **REFR-02**: Sample-level auto-transitions (e.g. all analyses submitted -> sample moves to to_be_verified) are visible immediately after refresh

## Future Requirements

Deferred to later milestones.

### Result Entry Enhancements

- **EDIT-05**: Save result value without submitting (draft mode for entering results over time)
- **EDIT-06**: Interim/partial result fields support
- **EDIT-07**: Remarks/comments per analysis result

### Advanced Workflow

- **WKFL-08**: Retest transition (creates new analysis, marks old as retested)
- **WKFL-09**: Role-based transition visibility (only show "Verify" to users with verify permission)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Direct SENAITE UI embedding (iframe) | Defeats purpose of building native UX |
| Real-time multi-user sync | Single-operator workflow; refresh-on-action sufficient |
| Analysis creation/deletion | SENAITE manages analysis lifecycle; we only edit results and transition states |
| Instrument result auto-import | Separate workflow (HPLC import wizard); this milestone is manual entry + transitions |
| Email notifications on transitions | No email infrastructure in v1 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DATA-01 | Phase 06 | Complete |
| DATA-02 | Phase 06 | Complete |
| DATA-03 | Phase 06 | Complete |
| DATA-04 | Phase 06 | Complete |
| COMP-01 | Phase 06 | Complete |
| COMP-02 | Phase 06 | Complete |
| EDIT-01 | Phase 06 | Complete |
| EDIT-02 | Phase 06 | Complete |
| EDIT-03 | Phase 06 | Complete |
| EDIT-04 | Phase 06 | Complete |
| WKFL-01 | Phase 07 | Pending |
| WKFL-02 | Phase 07 | Pending |
| WKFL-03 | Phase 07 | Pending |
| WKFL-04 | Phase 07 | Pending |
| WKFL-05 | Phase 07 | Pending |
| WKFL-06 | Phase 07 | Pending |
| WKFL-07 | Phase 07 | Pending |
| REFR-01 | Phase 07 | Pending |
| REFR-02 | Phase 07 | Pending |
| BULK-01 | Phase 08 | Pending |
| BULK-02 | Phase 08 | Pending |
| BULK-03 | Phase 08 | Pending |
| BULK-04 | Phase 08 | Pending |

**Coverage:**
- v0.12.0 requirements: 23 total
- Mapped to phases: 23
- Unmapped: 0

---
*Requirements defined: 2026-02-24*
*Last updated: 2026-02-25 — Phase 06 requirements marked Complete*
