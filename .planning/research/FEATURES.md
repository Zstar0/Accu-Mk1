# Feature Landscape: Inline Result Editing and Workflow Transitions

**Domain:** LIMS analysis result management — inline editing, state-based workflow actions, bulk operations
**Milestone type:** Subsequent (adding to existing SENAITE desktop app)
**Researched:** 2026-02-24

---

## Context

The existing app has a read-only analyses table inside SampleDetails. Each analysis row shows its title, result value, unit, method, instrument, analyst, review state badge, and captured timestamp. The table already has per-state color tinting (left border accent) and status filter tabs (All / Verified / Pending).

The backend already has:
- `GET /explorer/samples/{id}/analyses` — returns analyses with uid, keyword, review_state, result, unit
- `POST /explorer/samples/{id}/results` — sets Result + calls `transition: submit` on each; only works on `unassigned` state

The SENAITE API transition mechanism: `POST /update/{uid}` with body `{"transition": "verify"}`, `{"transition": "retract"}`, etc. Transition only fires if the analysis is in a valid prior state and the caller has permission.

**SENAITE analysis state machine:**
```
unassigned → (set Result + submit) → to_be_verified → (verify) → verified → (published via sample)
                                      to_be_verified → (retract) → unassigned
                                      to_be_verified → (reject)  → rejected  [permanent]
verified   → (retract) → unassigned  [in some SENAITE configs]
```

---

## Table Stakes

Features that a result entry screen must have. Without any of these the UI is either broken or requires falling back to the native SENAITE web UI — defeating the purpose.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Click-to-edit result value on unassigned rows** | Core purpose of the milestone. Unassigned analyses have no result yet; lab tech must enter one. | Medium | Click table cell → inline input appears. Same pattern as existing `EditableField` used on sample-level fields. Only renders for `unassigned` state. |
| **Save on Enter / Cancel on Escape** | Keyboard conventions for inline editing. Every major data table (Airtable, Notion, Google Sheets) uses these bindings. | Low | Follows same `handleKeyDown` pattern already in `EditableField`. |
| **Optimistic update with rollback** | Prevents UI jank on network latency. Click save → cell immediately shows new value → rolls back if API returns error. | Low | Already established pattern in `EditableField.save()`. Apply same pattern to analyses. |
| **Per-row action menu (ellipsis or buttons) showing state-valid transitions** | After result is saved, analyst must be able to submit / verify / retract / reject. Actions must be contextual — only show what is valid for the current state. | Medium | Use a dropdown menu (shadcn `DropdownMenu`) per row. Compute available actions from `review_state`. Do not show a "verify" button on an unassigned row. |
| **State-aware action availability** | Each action is only valid from specific states. Showing disabled or invalid actions causes confusion and mistakes. | Low | Map `review_state` → `allowedTransitions[]`. Drive button/menu item availability from this map. |
| **Spinner / loading state during transition** | API calls to SENAITE take 200–800ms. Row must show a loading indicator while the transition is in-flight. | Low | Disable the row's action controls, show a spinner in place of the action menu. |
| **Toast feedback on success and failure** | Lab tech must know whether their action succeeded. Silent failure is unacceptable in a GMP environment. | Low | `toast.success()` and `toast.error()` — already used throughout SampleDetails. |
| **Row state refresh after transition** | After submit/verify/retract/reject, the row's `review_state` badge and available actions must reflect the new state. | Low | Local state update (`setData`) after confirmed API success. No full-page reload needed. |
| **Sample-level state refresh after transitions affect all analyses** | When the last analysis is submitted/verified, the sample transitions to a new state (e.g., `sample_received` → `to_be_verified`). Header badge must update. | Medium | Re-fetch sample detail (or just the review_state field) after any workflow transition. Alternatively: use the response from the transition call which returns the new state. |
| **Non-editable display for non-unassigned rows** | Verified, retracted, rejected rows must not be click-editable. Their result is locked by the LIMS. | Low | Conditional rendering: only unassigned rows render `EditableField`; others render plain text. |
| **Result value validation before submit** | Attempting to submit an empty result to SENAITE will fail. Prevent the API call entirely. | Low | Disable save button if draft is empty. Show inline "Enter a result before submitting" message if tech tries to submit an unassigned row with no result set. |
| **Checkbox column for bulk selection** | Required for batch operations (submit all, verify all). Users expect a checkbox column on actionable tables — established pattern from Gmail, Airtable, GitHub. | Medium | Indeterminate state for the header checkbox (some selected). Only selectable rows: those with valid transitions. |
| **Floating bulk action toolbar** | When rows are selected, a docked toolbar appears showing batch actions. This is the standard pattern (Gmail, GitHub PR review, PatternFly Bulk Selection). | Medium | Fixed-position bar at bottom of table or top of viewport. Shows "N selected", bulk action buttons, and an "X" to deselect all. |
| **Batch submit (all unassigned-with-results rows)** | Primary daily operation: analyst enters all results, then submits them all at once. Without batch submit, must click per-row N times. | Medium | Submit all selected unassigned rows that have result values. Skip rows without results with a per-row error. Return a summary toast: "5 submitted, 1 skipped (no result)". |
| **Progress indicator for bulk operations** | Batch submit of 8 analyses may take 3–6 seconds. Tech needs to see it's working. | Low | Show a loading overlay or progress count in the floating toolbar: "Submitting 3/8...". |
| **Error summary after bulk operation** | If 2 of 8 submit calls fail, the tech must know which ones and why. A single toast is insufficient. | Medium | After batch completes, show a summary toast or an expandable panel: "6 succeeded, 2 failed — [row names]". Rows with errors remain in their prior state. |

---

## Differentiators

Features that go beyond functional to make this substantially better than the native SENAITE web UI. SENAITE's built-in result entry requires navigating to each analysis individually; this app can provide a unified, faster workflow.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Keyboard navigation between editable cells** | Tab from one result field to the next without touching the mouse. A lab tech entering 8 results can complete entry in seconds. This is what Excel and Google Sheets feel like — SENAITE's native UI cannot do this. | Medium | On Tab key press inside an active result input, close current edit and open edit mode on the next editable row. Requires row refs or a focused-row state. |
| **"Enter all results, then submit all" fast path** | Decouple result entry from the submit transition. Tech can enter all results without submitting, then use "Submit All" from the bulk toolbar. SENAITE's default workflow ties enter+submit together. | Low | Split into two actions: "Save Result" (sets value only, no transition) and a separate "Submit" action. The existing backend endpoint conflates these; a new backend endpoint is needed for save-only. |
| **Transition confirmation for destructive actions** | Retract and reject are hard to undo. A confirmation dialog prevents accidental misclicks. | Low | shadcn `AlertDialog` before executing retract or reject. "This will retract [Analysis Name]. A new test will be required. Continue?" |
| **Inline state transition justification (optional)** | Some labs require a reason when retracting. Optional reason field in the confirmation dialog, sent as a remark or logged locally. | Low | Text input in the retract/reject confirmation dialog. If provided, append to SENAITE Remarks field on the sample. |
| **"Submit all with results" quick button** | A single prominent button: "Submit All With Results" — submits every unassigned row that already has a non-empty result value. No checkbox selection needed. | Low | Placed near the analysis section header. Disabled if no unassigned rows have results. Uses the existing POST /results endpoint. |
| **Result value diff indicator** | When an analysis has been retracted and re-entered, the row shows the original value (from the retested flag) alongside the new value. Makes re-test visible without opening SENAITE. | High | Depends on SENAITE returning prior result on retested analyses. May require additional API field. Defer if SENAITE doesn't expose it. |
| **Per-row status change animation** | When a transition completes, the row's state badge smoothly transitions to the new color (e.g., amber → cyan). Provides visual confirmation without reading text. | Low | CSS `transition` on badge background-color. The state badge color map already exists. |
| **"Pending entry" row highlight** | Unassigned rows with no result yet are visually differentiated from unassigned rows that have a result saved. "Needs result" vs "Ready to submit." | Low | Different left-border tint or a subtle bg tint on rows where `review_state === 'unassigned' && !result`. |
| **Bulk verify (for Lab Managers)** | Batch verify all to_be_verified analyses. Reduces the click count for verification from N clicks to 1. This is the workflow bottleneck in SENAITE. | Medium | Only available when user role has verify permission. Shown in bulk toolbar only when selected rows are all `to_be_verified`. |

---

## Anti-Features

Features to explicitly NOT build in this milestone.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Editable fields for verified or published analyses** | SENAITE enforces this at the API level — PUT to a verified analysis returns an error. Building a UI affordance that always fails misleads the tech. | Show verified result as plain, unclickable text. If a verified result needs correction, the workflow is retract → re-enter. Make retract available via the action menu. |
| **Free-form text justification required for every transition** | Requiring a justification on every submit/verify adds friction to the primary happy path. Most transitions don't need a reason. | Only prompt for justification on retract and reject, which are explicit exceptions. Submit and verify are routine. |
| **Editable method, instrument, or analyst from this UI** | These fields are managed in SENAITE by lab managers through configuration, not by analysts during result entry. Allowing edit from here bypasses the governance model. | Show method/instrument/analyst as read-only columns. They are informational context for the result, not editable from result entry. |
| **Automated publishing of samples** | Publishing is a sample-level transition with external consequences (triggers COA generation, notifies customer). It must never happen as a side-effect of result entry. | Keep the analysis workflow transitions scoped to the analysis level only. Sample publishing remains a separate, explicit action. |
| **Real-time multi-user sync / presence** | Multiple analysts editing results simultaneously on the same sample is not a scenario in this lab. Adding WebSocket-based presence tracking is significant infrastructure for no real benefit. | Rely on standard TanStack Query polling. If two analysts open the same sample, the second will see stale data until they refresh. This is acceptable for the team size. |
| **Undo history across transitions** | Once an analysis is submitted and transitions to `to_be_verified`, "undo" means calling retract — a deliberate action with traceability implications. Treating it like a text editor undo trivializes the audit trail. | Expose retract as an explicit menu action. Do not build an "undo" button. |
| **Inline result entry for analyses in assigned state** | `assigned` means a worksheet has been assigned. Editing from the sample details view while a worksheet is open in SENAITE would create conflicts. | Show assigned analyses as read-only. Direct tech to SENAITE for worksheet-based result entry when `review_state === 'assigned'`. |
| **Custom result validation rules (spec limits, reference ranges)** | SENAITE manages specification limits and out-of-spec flagging internally. Duplicating this logic in the frontend creates a divergence risk. | Show SENAITE's out-of-spec flags if they appear in the API response (e.g., `outofrange` field). Do not re-implement limit checking. |
| **Full SENAITE workflow replacement** | This is a convenience overlay on SENAITE, not a replacement. Reject, retract, complex QC workflows involving worksheets and instrument imports remain in SENAITE's native UI. | Build the 80% daily case: enter results, submit, verify. For edge cases, provide the "Open in SENAITE" link already on the page. |

---

## Feature Dependencies

```
Inline result editing (click-to-edit result cell)
  └── Existing: EditableField component (pattern to reuse or adapt)
  └── Existing: POST /explorer/samples/{id}/results endpoint (submit combined)
  └── NEW: POST or PATCH endpoint for save-result-only (no transition)
  └── SenaiteAnalysis type in api.ts needs uid field for per-analysis calls

Per-row action menu with workflow transitions
  └── Analysis uid in SenaiteAnalysis type (currently missing — needs backend + frontend)
  └── NEW: POST /explorer/analyses/{uid}/transition endpoint (backend)
  └── state → allowedTransitions map (frontend logic)
  └── shadcn DropdownMenu (already in codebase)

Checkbox bulk selection
  └── Local selection state (Set<string> of uids) in SampleDetails
  └── Checkbox column in AnalysisRow (shadcn Checkbox component)
  └── Indeterminate header checkbox (react ref control)

Floating bulk action toolbar
  └── Checkbox selection state (derives from above)
  └── Fixed-position DOM element, z-index above table
  └── Bulk transition logic: serial or parallel API calls per selected uid

Sample-level state refresh
  └── After any transition, re-fetch lookupSenaiteSample or just the review_state field
  └── setData to update header badge

Batch submit "Submit All With Results"
  └── Filter analyses where review_state === 'unassigned' && result !== null
  └── Existing POST /explorer/samples/{id}/results (already supports batch)

Keyboard navigation between editable cells
  └── rowRefs or ordered uid list
  └── Tab handler that closes current edit and opens next
```

---

## Backend Requirements (Integration Service)

The existing `POST /explorer/samples/{id}/results` endpoint combines set-result + submit in one operation. The new milestone requires splitting this:

| New Endpoint | Purpose | Notes |
|--------------|---------|-------|
| `PATCH /explorer/analyses/{uid}/result` | Set result value only, no transition | Calls SENAITE `POST /update/{uid}` with `{"Result": value}`. Returns new analysis state. |
| `POST /explorer/analyses/{uid}/transition` | Execute a named transition | Calls SENAITE `POST /update/{uid}` with `{"transition": name}`. Returns new state. Body: `{"transition": "verify" \| "retract" \| "reject" \| "submit"}`. |

The `SenaiteAnalysis` data model in the backend needs `uid` exposed to the desktop API response (currently `AnalysisResponse` in desktop.py has `uid` — it's just missing from the frontend `SenaiteAnalysis` interface in api.ts and from the `lookupSenaiteSample` lookup path).

---

## MVP Recommendation

### Must-Build (Table Stakes — Core Result Management)

1. Click-to-edit result value on `unassigned` rows (reuse EditableField pattern)
2. Save on Enter, Cancel on Escape, disabled save on empty value
3. Optimistic update with rollback on API error
4. Per-row action dropdown with state-valid transitions (submit, verify, retract, reject)
5. Spinner / loading state during transition; row controls disabled in-flight
6. Toast feedback on every action (success and error)
7. Row state badge update after successful transition
8. Sample-level state badge refresh after transitions
9. Non-editable display for non-unassigned rows
10. Checkbox selection column (only on actionable rows)
11. Floating bulk action toolbar with selection count
12. Batch submit via existing endpoint (all selected unassigned+result rows)
13. Progress indicator during batch operations
14. Error summary after batch completes

### Build If Time Allows (Differentiators)

1. Confirmation dialog for retract and reject
2. "Submit All With Results" single-click button above the table
3. Per-row status change transition animation
4. "Pending entry" highlight on unassigned rows with no result
5. Keyboard Tab navigation between editable result cells

### Defer to Later Milestone

- Save-result-only without submit (requires new backend endpoint and rethinking current UX)
- Inline justification on retract (needs remarks endpoint)
- Bulk verify (needs verify permission detection)
- Result diff indicator for retested analyses (needs SENAITE field research)
- Keyboard navigation between cells (higher complexity, lower urgency)

---

## Confidence Assessment

| Area | Confidence | Source |
|------|------------|--------|
| SENAITE transition mechanism (`POST /update/{uid}` with `transition` key) | HIGH | Confirmed in existing `submit_analysis_result` implementation in senaite.py (lines 956–960) |
| SENAITE analysis state machine (unassigned → to_be_verified → verified) | HIGH | Confirmed from senaite.py implementation and STATUS_COLORS map in SampleDetails.tsx |
| Retract and reject as valid transitions | MEDIUM | Confirmed by SENAITE GitHub issue tracker and Bika LIMS documentation; exact valid prior states not fully documented |
| Bulk action floating toolbar pattern | HIGH | Multiple authoritative UX sources: NN/g, PatternFly, eleken.co |
| Inline editing UX conventions (Enter/Escape/optimistic update) | HIGH | Existing codebase establishes this pattern in EditableField.tsx; no ambiguity |
| Backend uid field availability for analyses | HIGH | `AnalysisResponse` in desktop.py already returns `uid`; gap is frontend interface only |
| "assigned" state restriction | MEDIUM | Logical inference from SENAITE worksheet model; not verified against specific API behavior |
| Bulk verify permission scoping | LOW | Not researched; SENAITE permissions system not examined for this milestone |

---

## Sources

### SENAITE API and Workflow

- [SENAITE JSON API — CRUD and Transitions (ReadTheDocs)](https://senaitejsonapi.readthedocs.io/en/latest/crud.html) — confirms `transition` key in POST /update body
- [SENAITE Analysis States — Bika LIMS Manual](https://www.bikalims.org/manual/workflow) — workflow overview
- [Verify or Retract Analysis Results — Bika LIMS](https://www.bikalims.org/manual/workflow/images-ar-verification/verify-or-retract-analysis-results-in-bika-and-senaite/view)
- Existing codebase: `integration-service/app/adapters/senaite.py` lines 901–997 — authoritative reference for the two-step submit pattern
- Existing codebase: `integration-service/app/api/desktop.py` — `AnalysisResponse` schema, `submit_sample_results` endpoint

### Inline Editing UX

- Existing codebase: `src/components/dashboard/EditableField.tsx` — established pattern for this app

### Bulk Actions and Data Tables

- [Bulk Action UX — Eleken](https://www.eleken.co/blog-posts/bulk-actions-ux) — floating toolbar pattern, 8 design guidelines
- [PatternFly Bulk Selection Pattern](https://www.patternfly.org/patterns/bulk-selection/) — indeterminate checkbox, contextual toolbar
- [Data Table Design UX Patterns — Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables)
- [Best Practices for Actions in Data Tables — UX World](https://uxdworld.com/best-practices-for-providing-actions-in-data-tables/)
