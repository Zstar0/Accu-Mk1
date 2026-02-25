# Architecture: Inline Result Editing + SENAITE Workflow Transitions

**Milestone:** Subsequent — Inline analysis result editing and workflow actions
**Domain:** Tauri + React + FastAPI (Accu-Mk1 local backend) + Integration-Service + SENAITE REST API
**Researched:** 2026-02-24
**Overall Confidence:** HIGH (all claims verified against actual codebase)

---

## Executive Summary

This milestone adds two closely related capabilities to `SampleDetails.tsx`:

1. **Inline result editing** — click a result cell in the analyses table, type a value, save.
2. **Workflow transitions** — buttons to submit, verify, or reject individual analyses (or in bulk).

Both capabilities are "thin wires" through the existing stack. The backend pattern (proxy to SENAITE's two-step update+transition) already exists in the integration-service. The frontend pattern (click-to-edit with optimistic update + rollback) already exists in `EditableField.tsx`. The gap is connecting them: new Accu-Mk1 backend endpoints that call SENAITE's `POST /update/{uid}`, and a revamped `AnalysisRow` component that exercises those endpoints.

The most significant structural decision is **where to add the backend endpoints**: they belong in the Accu-Mk1 local backend (`backend/main.py`), following the same pattern as `update_senaite_sample_fields`, not in the integration-service. The integration-service's desktop.py `submit_sample_results` endpoint is the reference implementation but serves a different auth context (API key for desktop) and targets a different workflow path (batch result submission by keyword, not per-analysis editing).

**Recommended build order:**

1. Extend `SenaiteAnalysis` type to include `uid` (one-line Python + TypeScript change)
2. Add two Accu-Mk1 backend endpoints: `POST /wizard/senaite/analyses/{uid}/result` and `POST /wizard/senaite/analyses/{uid}/transition`
3. Upgrade `AnalysisRow` to support inline result editing
4. Add per-row transition action buttons (submit, verify, reject)
5. Add bulk action toolbar to the analyses table header

---

## Current Architecture Audit

### The Missing `uid` Field

**This is the single most critical prerequisite.** The existing `SenaiteAnalysis` model on both the backend and frontend is missing `uid`.

**Backend model (`backend/main.py`, line 5005):**
```python
class SenaiteAnalysis(BaseModel):
    title: str
    result: Optional[str] = None
    unit: Optional[str] = None
    method: Optional[str] = None
    instrument: Optional[str] = None
    analyst: Optional[str] = None
    due_date: Optional[str] = None
    review_state: Optional[str] = None
    sort_key: Optional[float] = None
    captured: Optional[str] = None
    retested: bool = False
    # uid is NOT here — must be added
```

**Frontend type (`src/lib/api.ts`, line 2016):**
```typescript
export interface SenaiteAnalysis {
  title: string
  result: string | null
  unit: string | null
  method: string | null
  instrument: string | null
  analyst: string | null
  due_date: string | null
  review_state: string | null
  sort_key: number | null
  captured: string | null
  retested: boolean
  // uid is NOT here — must be added
}
```

**Where the uid is fetched but dropped:** In the lookup endpoint (`backend/main.py` around line 5304), the analysis items from SENAITE already include `uid` in the response JSON. The field is just never mapped into `SenaiteAnalysis`. Adding it is a one-field addition in both files with no schema migration required.

### Existing SENAITE Proxy Pattern (HIGH confidence — code verified)

The `update_senaite_sample_fields` endpoint at `POST /wizard/senaite/samples/{uid}/update` (line 5760) is the direct model for new analysis endpoints:

```python
# Current pattern — used for sample field updates:
POST /wizard/senaite/samples/{uid}/update
Body: {"fields": {"Remarks": "some text"}}
→ backend proxies to: POST {SENAITE_URL}/senaite/@@API/senaite/v1/update/{uid}
→ returns SenaiteFieldUpdateResponse(success, message, updated_fields)
```

The new analysis endpoints follow the same HTTP proxy pattern, same auth (`Depends(get_current_user)`), same httpx client configuration (JSON body first, form-encoded fallback on 400), same error handling.

### Existing Two-Step Pattern (HIGH confidence — code verified)

The integration-service adapter's `submit_analysis_result` (line 901 in `senaite.py`) documents the SENAITE two-step workflow as observed, working code:

```python
# Step 1: Set result value
POST {SENAITE_URL}/senaite/@@API/senaite/v1/update/{analysis_uid}
Body: {"Result": "95.4"}

# Step 2: Submit (transition state)
POST {SENAITE_URL}/senaite/@@API/senaite/v1/update/{analysis_uid}
Body: {"transition": "submit"}
```

The transition name `"submit"` moves the analysis from `unassigned` to `to_be_verified`. Other transitions: `"verify"` (`to_be_verified` → `verified`), `"retract"` (reverts), `"reject"`. The exact available transitions per state are SENAITE workflow-dependent and should be verified against the live instance during implementation.

### Existing EditableField Pattern (HIGH confidence — code verified)

`EditableField.tsx` already implements the exact UX pattern needed for result cells:
- Click to enter edit mode
- Optimistic update via `onSaved` callback (immediate UI update before server confirms)
- Save via custom `onSave` async function or default `updateSenaiteSampleFields`
- Rollback on failure with error toast
- Keyboard: Enter to save, Escape to cancel

The `AnalysisRow` component needs the same behavior. The cleanest implementation passes an `onSave` callback that calls a new `updateAnalysisResult(uid, value)` API function. No new UI primitives are needed.

### Current SampleDetails Data Loading Pattern (HIGH confidence — code verified)

`SampleDetails.tsx` uses manual `useState` + `useEffect` with the `lookupSenaiteSample()` call — it does **not** use TanStack Query. The `fetchSample` function is already factored out and callable imperatively:

```typescript
const fetchSample = (id: string) => {
  setLoading(true)
  setError(null)
  lookupSenaiteSample(id)
    .then(result => setData(result))
    .catch(e => setError(...))
    .finally(() => setLoading(false))
}
```

This `fetchSample` function is passed down as a refresh callback after mutations complete. After a result is saved or a transition fires, call `fetchSample(sampleId)` to re-fetch the full sample including updated analysis states. This is the existing pattern for `onAdded={() => fetchSample(data.sample_id)}` on the COA section.

**Decision: Do not convert to TanStack Query for this milestone.** The existing useState+useEffect pattern is functional, and converting a 1400-line component mid-milestone introduces risk. Use the existing `fetchSample` as the post-mutation refresh mechanism.

---

## New Components Required

### Backend: Two New Endpoints in `backend/main.py`

Both endpoints follow the established `update_senaite_sample_fields` pattern exactly.

#### Endpoint 1: Set Analysis Result

```
POST /wizard/senaite/analyses/{uid}/result
Body: {"value": "95.4"}
Response: {"success": true, "message": "Result updated", "new_review_state": "unassigned"}
```

This endpoint:
1. POSTs `{"Result": value}` to SENAITE `update/{uid}`
2. Returns success/failure + the updated `review_state` from SENAITE's response
3. Does NOT auto-submit — submit is a separate explicit action

Separating set-result from submit-transition is important: a lab tech may want to enter a result value and review it before formally submitting. Forcing auto-submit on save removes that review window.

#### Endpoint 2: Apply Transition

```
POST /wizard/senaite/analyses/{uid}/transition
Body: {"transition": "submit"}  -- or "verify", "retract", "reject"
Response: {"success": true, "message": "Transitioned to to_be_verified", "new_review_state": "to_be_verified"}
```

This endpoint:
1. POSTs `{"transition": transitionName}` to SENAITE `update/{uid}`
2. Returns success/failure + new `review_state` from SENAITE's response
3. Is intentionally separate from the result endpoint — supports verify/retract/reject which don't involve result values

**Why two endpoints instead of combining:** The two-step pattern in SENAITE is sequential but the UI actions are conceptually distinct. A tech entering a result mid-session should not trigger workflow state changes. Transitions are explicit lab decisions (submit for review, verify, reject). Keeping them separate also supports transitions on already-submitted analyses (e.g., verify) where no result change is involved.

#### Pydantic Models

```python
class AnalysisResultRequest(BaseModel):
    value: str

class AnalysisResultResponse(BaseModel):
    success: bool
    message: str
    new_review_state: Optional[str] = None

class AnalysisTransitionRequest(BaseModel):
    transition: str  # "submit" | "verify" | "retract" | "reject"

class AnalysisTransitionResponse(BaseModel):
    success: bool
    message: str
    new_review_state: Optional[str] = None
```

### Frontend: Two New API Functions in `src/lib/api.ts`

```typescript
export interface AnalysisResultResponse {
  success: boolean
  message: string
  new_review_state: string | null
}

export async function updateAnalysisResult(
  uid: string,
  value: string
): Promise<AnalysisResultResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/analyses/${encodeURIComponent(uid)}/result`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ value }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Result update failed: ${response.status}`)
  }
  return response.json()
}

export async function transitionAnalysis(
  uid: string,
  transition: string
): Promise<AnalysisResultResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/analyses/${encodeURIComponent(uid)}/transition`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ transition }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Transition failed: ${response.status}`)
  }
  return response.json()
}
```

### Frontend: Upgraded `AnalysisRow` Component

The `AnalysisRow` function (line 1305) changes from a pure display row to an interactive row. It needs:

1. **Editable result cell** — replace static text with an inline input when the analysis is in `unassigned` or `assigned` state (states where result entry is permitted). Use the `EditableField` pattern: click → input → Enter/save button → confirm, with optimistic update.

2. **Transition action buttons** — a small action button or dropdown per row, showing only the transitions valid for the current `review_state`. SENAITE workflow rules:
   - `unassigned` / `assigned` → "Submit" (requires result first)
   - `to_be_verified` → "Verify", "Reject"
   - `verified` → no actions (locked)
   - `published` → no actions (locked)

3. **Row-level loading state** — while a save or transition is pending, show a spinner in the row and disable its controls. Since analyses are independent, other rows remain interactive.

4. **Post-action refresh** — after any mutation succeeds, call the `fetchSample` refresh callback to reload the full sample. This updates the sample-level `review_state` if SENAITE auto-transitioned the parent (e.g., sample moves to `to_be_verified` when all analyses are submitted).

**Component signature change:**

```typescript
// Before:
function AnalysisRow({ analysis, analyteNameMap }: {
  analysis: SenaiteAnalysis
  analyteNameMap: Map<number, string>
})

// After:
function AnalysisRow({ analysis, analyteNameMap, onMutated }: {
  analysis: SenaiteAnalysis
  analyteNameMap: Map<number, string>
  onMutated: () => void  // calls fetchSample after any mutation succeeds
})
```

### Frontend: Bulk Action Toolbar

For bulk operations (e.g., select all unassigned analyses, submit all), a toolbar sits between the filter tabs and the progress bar in the analyses card. It appears only when one or more rows are selected.

**State required (local to SampleDetails, not Zustand):**
```typescript
const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set())
```

**Bulk actions:**
- "Submit selected" — calls `transitionAnalysis(uid, 'submit')` for each selected uid sequentially (not in parallel — SENAITE can struggle with concurrent writes to the same sample)
- "Verify selected" — same pattern with `'verify'`

The bulk action progress is shown inline ("Submitting 3 of 5...") using a local counter state. A single `fetchSample` refresh happens after all batch operations complete.

**Sequential constraint:** SENAITE's analysis workflow may update sample-level state after each analysis transitions. Firing concurrent requests risks race conditions in SENAITE's state machine. Process bulk actions one at a time with await between each call.

---

## Data Flow: Edit → Save → Refresh

### Single Analysis Result Save

```
1. Tech clicks result cell on an "unassigned" analysis row
   └→ AnalysisRow enters edit mode (local useState)
   └→ Optimistic: UI shows new value immediately (pre-confirm)

2. Tech types value, presses Enter or clicks save button
   └→ POST /wizard/senaite/analyses/{uid}/result {"value": "95.4"}

3. Backend receives request
   └→ httpx POST to SENAITE: /update/{uid} {"Result": "95.4"}
   └→ Returns AnalysisResultResponse(success=true, new_review_state="unassigned")

4. Frontend receives success
   └→ toast.success("Result saved")
   └→ onMutated() called → fetchSample(sampleId) → full refresh

5. On failure:
   └→ toast.error("Failed to save result", description: err.message)
   └→ Optimistic rollback: revert displayed value to original
```

### Single Analysis Transition (Submit)

```
1. Tech clicks "Submit" button on a row with result entered
   └→ Row enters loading state (spinner, controls disabled)

2. POST /wizard/senaite/analyses/{uid}/transition {"transition": "submit"}

3. Backend proxies to SENAITE:
   └→ POST /update/{uid} {"transition": "submit"}
   └→ SENAITE moves analysis from "unassigned" → "to_be_verified"
   └→ SENAITE may auto-transition sample to "to_be_verified" if all analyses submitted

4. Returns AnalysisTransitionResponse(success=true, new_review_state="to_be_verified")

5. Frontend:
   └→ toast.success("Analysis submitted for verification")
   └→ onMutated() → fetchSample(sampleId) → full refresh
   └→ Full refresh picks up: updated analysis review_state AND updated sample review_state
```

### Bulk Submit Flow

```
1. Tech checks 3 analyses, clicks "Submit selected"
   └→ BulkActionState: { pending: 3, completed: 0, failed: 0 }

2. For each uid in selectedUids (sequentially, not parallel):
   a. POST /wizard/senaite/analyses/{uid}/transition {"transition": "submit"}
   b. await response
   c. Update counter: completed++
   d. If error: failed++, continue to next (don't abort batch)

3. After all complete:
   └→ fetchSample(sampleId) — single refresh for all changes
   └→ toast.success("3 submitted, 0 failed") or toast.warning("2 submitted, 1 failed")
   └→ Clear selectedUids
```

---

## Component Boundaries and Dependency Graph

```
SampleDetails.tsx
│
├── State: data (SenaiteLookupResult), loading, error
├── State: analysisFilter, selectedUids
├── fetchSample() ─────────────────────────── calls lookupSenaiteSample()
│
├── AnalysesTable (inline, not extracted)
│   ├── BulkActionToolbar
│   │   ├── State: bulkPending (local)
│   │   └── Calls: transitionAnalysis() [sequential loop] → onAllComplete → fetchSample()
│   │
│   └── AnalysisRow (one per filteredAnalysis)
│       ├── Props: analysis (now includes uid), analyteNameMap, onMutated
│       ├── State: editing (bool), draft (string), saving (bool) [all local]
│       │
│       ├── EditableResultCell (inline or extracted)
│       │   └── Calls: updateAnalysisResult(uid, value) → onMutated → fetchSample()
│       │
│       └── TransitionButtons
│           └── Calls: transitionAnalysis(uid, transition) → onMutated → fetchSample()
│
└── api.ts
    ├── lookupSenaiteSample() — GET /wizard/senaite/lookup
    ├── updateAnalysisResult() — POST /wizard/senaite/analyses/{uid}/result  [NEW]
    └── transitionAnalysis() — POST /wizard/senaite/analyses/{uid}/transition [NEW]
```

```
backend/main.py
│
├── POST /wizard/senaite/analyses/{uid}/result  [NEW]
│   └── httpx POST → SENAITE /@@API/senaite/v1/update/{uid}  {"Result": value}
│
└── POST /wizard/senaite/analyses/{uid}/transition  [NEW]
    └── httpx POST → SENAITE /@@API/senaite/v1/update/{uid}  {"transition": name}
```

No changes required to:
- Zustand `ui-store.ts` — no new global UI state needed
- Integration-service — new endpoints are in Accu-Mk1 backend only
- Any other component outside `SampleDetails.tsx` and `EditableField.tsx`

---

## Modified vs. New: Explicit Inventory

### Files That Change

| File | Change Type | What Changes |
|------|-------------|--------------|
| `backend/main.py` | Addition | 2 new endpoints + 4 new Pydantic models; no existing code modified |
| `src/lib/api.ts` | Addition | `uid` added to `SenaiteAnalysis` interface; 2 new API functions; 1 new response type |
| `src/components/senaite/SampleDetails.tsx` | Modification | `AnalysisRow` gains `uid` prop, inline edit, transition buttons; analyses table gains checkbox column and bulk toolbar; `onMutated` prop threading |

### Files That Do Not Change

| File | Why Untouched |
|------|---------------|
| `src/components/dashboard/EditableField.tsx` | Used as-is; or its pattern replicated inline in AnalysisRow |
| `src/store/ui-store.ts` | No new global state needed |
| `integration-service/app/api/desktop.py` | Reference only; not modified |
| `integration-service/app/adapters/senaite.py` | Reference only; not modified |
| Any other component | Edits are fully contained |

---

## Suggested Build Order

This order minimizes risk by making each step independently verifiable before proceeding.

### Step 1: Add `uid` to the Data Model (Prerequisite, ~30 min)

1. In `backend/main.py` `SenaiteAnalysis` model: add `uid: Optional[str] = None`
2. In the lookup endpoint where analyses are built (line ~5304): map `an_item.get("uid", "")` into the model
3. In `src/lib/api.ts` `SenaiteAnalysis` interface: add `uid: string | null`

**Verify:** Reload a sample in the UI. Open browser devtools, check the network response for `/wizard/senaite/lookup` — analysis items should now include `uid` populated with SENAITE UIDs (not empty strings).

### Step 2: Backend Endpoints (No Frontend Yet, ~1 hour)

1. Add `AnalysisResultRequest`, `AnalysisResultResponse`, `AnalysisTransitionRequest`, `AnalysisTransitionResponse` Pydantic models to `backend/main.py`
2. Add `POST /wizard/senaite/analyses/{uid}/result` endpoint
3. Add `POST /wizard/senaite/analyses/{uid}/transition` endpoint
4. Follow the `update_senaite_sample_fields` error handling pattern exactly (JSON body first, form-encoded fallback, timeout handling)

**Verify:** Use curl or the FastAPI `/docs` swagger UI to manually call the endpoints with a real SENAITE analysis UID. Confirm result values set and transitions fire in SENAITE.

### Step 3: Inline Result Editing in `AnalysisRow` (~2 hours)

1. Add `uid` and `onMutated` to `AnalysisRow` props
2. Add local state: `editing`, `draft`, `saving`
3. Replace the static result `<td>` with an interactive cell:
   - Non-editable states (verified, published): static display as before
   - Editable states (unassigned, assigned, to_be_verified): click-to-edit using the EditableField pattern
4. Wire the save handler to `updateAnalysisResult(uid, draft)` → on success call `onMutated()`
5. Thread `onMutated={() => fetchSample(sampleId)}` from `SampleDetails` into each `AnalysisRow`

**Verify:** Click a result cell on an unassigned analysis. Edit the value. Save. Confirm SENAITE shows the updated result. Confirm the UI refreshes.

### Step 4: Per-Row Transition Buttons (~1.5 hours)

1. Add a narrow "Actions" column to the analyses table header
2. In `AnalysisRow`, render action buttons conditional on `review_state`:
   - `unassigned` / `assigned`: "Submit" button (only if `result` is non-null)
   - `to_be_verified`: "Verify" and "Reject" buttons
   - `verified` / `published`: no buttons (or empty cell)
3. Each button calls `transitionAnalysis(uid, transitionName)` → on success call `onMutated()`
4. Disable all row controls when `saving` is true

**Verify:** Submit an analysis with a result. Verify an analysis in to_be_verified state. Confirm sample-level state updates if all analyses transition (SENAITE auto-transition).

### Step 5: Bulk Actions (~2 hours)

1. Add checkbox column to table (leftmost column)
2. Add `selectedUids` state to `SampleDetails` (`useState<Set<string>>`)
3. Wire checkboxes: only show on rows in actionable states; "select all" checkbox in header
4. Add bulk toolbar above progress bar (appears when `selectedUids.size > 0`)
5. Implement sequential bulk submit and verify with progress counter
6. Single `fetchSample` refresh after all operations complete

**Verify:** Select multiple analyses, bulk submit, observe sequential processing and single refresh.

---

## Key Integration Constraints

### SENAITE State Machine Constraints

These are observed behaviors from the existing integration-service implementation — not SENAITE documentation. Treat as HIGH confidence for the specific SENAITE instance but verify during Step 2 testing:

- `submit` transition only works when analysis is in `unassigned` state (the integration-service validates this explicitly at line 1084 in desktop.py)
- Setting a `Result` value does not auto-submit — the transition must be fired explicitly
- Verifying all analyses may auto-transition the parent sample to `to_be_verified` or higher (SENAITE workflow automation). This is why `fetchSample` after transitions is essential — it captures sample-level state changes the UI didn't initiate.
- `to_be_verified` analyses can have their results changed (the result set step works on any non-locked state), but whether `submit` is re-triggerable from `to_be_verified` needs verification against the live instance.

### No Parallel Writes to Same Sample

As noted in the bulk flow: do not fire concurrent `transitionAnalysis` calls for analyses on the same sample. SENAITE's workflow automation (auto-transitions on the parent sample) can produce race conditions if multiple analysis transitions arrive simultaneously. Use sequential await chains in the bulk action loop.

### Refresh After Transition Captures Sample-Level State

After any analysis transition, the sample's own `review_state` may change (SENAITE auto-transitions). The full `fetchSample` refresh is the correct mechanism — it pulls the updated sample state and all updated analysis states in one call. Do not attempt to patch the local `data` object directly after transitions.

### Result Editing Permissions by State

Only allow result editing on analyses in states where SENAITE will accept a `Result` update. Safe states based on the integration-service implementation: `unassigned`, `assigned`. Analyses in `to_be_verified`, `verified`, or `published` should display results as read-only. If SENAITE does accept result updates in `to_be_verified` (retesting scenario), this can be unlocked in a follow-on task.

---

## Anti-Patterns to Avoid

### Parallel Bulk Writes

**What goes wrong:** `Promise.all(selectedUids.map(uid => transitionAnalysis(uid, 'submit')))` — concurrent writes race in SENAITE's workflow engine, producing inconsistent parent sample state.

**Instead:** `for (const uid of selectedUids) { await transitionAnalysis(uid, transition) }`

### Patching Local State Instead of Refreshing

**What goes wrong:** After a transition, manually updating `data.analyses[i].review_state = 'to_be_verified'` in local state. This misses sample-level state changes that SENAITE may have fired automatically.

**Instead:** Always call `fetchSample(sampleId)` after any mutation. The full refresh is fast (sub-second for the lookup endpoint) and guarantees consistency with SENAITE's actual state.

### Converting SampleDetails to TanStack Query Mid-Milestone

**What goes wrong:** The component is 1400+ lines. Refactoring state management mid-milestone dramatically increases scope and risk of regressions in unrelated features (COA editing, remarks, additional COAs).

**Instead:** Use the existing `fetchSample` imperative refresh as the post-mutation mechanism. A TanStack Query migration is a valid future cleanup task, scoped separately.

### Combining Result Set and Transition in One Endpoint

**What goes wrong:** A single "submit result" endpoint that sets value and fires `submit` transition in one call. This removes the lab tech's opportunity to set a value and review it before formally submitting for verification.

**Instead:** Two explicit endpoints. The UI can offer a "Set & Submit" convenience button that calls them sequentially, but the backend stays intentionally decomposed.

### Using Integration-Service Endpoints from Accu-Mk1 Frontend

**What goes wrong:** Calling the integration-service's `POST /samples/{id}/results` from the Accu-Mk1 frontend. The integration-service uses API key auth (X-API-Key header), a different auth model than Accu-Mk1's JWT Bearer tokens. Additionally, that endpoint takes keywords (not UIDs) and does a keyword→UID lookup, adding an unnecessary round trip.

**Instead:** Add new endpoints directly in `backend/main.py` that take UIDs and proxy to SENAITE. The integration-service is a reference implementation, not a dependency.

---

## Scalability Considerations

This is a lab desktop application. Scalability concerns are about correctness, not load.

| Concern | Approach |
|---------|----------|
| SENAITE rate limiting | Not an observed issue at lab scale; sequential bulk operations naturally limit request rate |
| Stale display after transition | Full `fetchSample` refresh after every mutation guarantees consistency |
| Many analyses per sample | The analyses table already handles filtering; bulk actions apply only to selected rows |
| Sample-level state divergence | `fetchSample` refresh is the single source of truth; no client-side state prediction |

---

## Sources

All claims verified directly against the codebase on 2026-02-24.

| Claim | Source | Confidence |
|-------|--------|------------|
| `SenaiteAnalysis` missing `uid` field | `backend/main.py` line 5005 + `src/lib/api.ts` line 2016 | HIGH |
| SENAITE two-step pattern: set Result then transition | `integration-service/app/adapters/senaite.py` lines 901-997 | HIGH |
| Same httpx proxy pattern in `update_senaite_sample_fields` | `backend/main.py` lines 5760-5837 | HIGH |
| `EditableField` optimistic update pattern with rollback | `src/components/dashboard/EditableField.tsx` lines 70-107 | HIGH |
| `fetchSample` imperative refresh already used post-mutation | `SampleDetails.tsx` line 1167: `onAdded={() => fetchSample(data.sample_id)}` | HIGH |
| `submit` transition validates `unassigned` state | `integration-service/app/api/desktop.py` lines 1084-1090 | HIGH |
| Analysis UIDs available in SENAITE API response | `integration-service/app/adapters/senaite.py` line 882: `uid=item.get("uid", "")` | HIGH |
| Accu-Mk1 backend uses JWT Bearer, not API key | `backend/main.py` + `backend/auth.py` pattern | HIGH |
| Integration-service uses X-API-Key header | `integration-service/app/api/desktop.py` lines 45-71 | HIGH |
