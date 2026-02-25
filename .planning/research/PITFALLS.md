# Domain Pitfalls: Inline Result Editing + SENAITE Workflow Transitions

**Domain:** Adding inline table editing and workflow actions to an existing lab desktop app (React + FastAPI + SENAITE LIMS)
**Researched:** 2026-02-24
**Context:** Accu-Mk1 milestone — inline analysis result editing, optimistic updates, and "Submit / Verify / Retract" workflow transitions in the SENAITE-connected SampleDetails view
**Milestone scope:** Adding to an existing system, not greenfield

---

## Critical Pitfalls

Mistakes that cause data corruption, silent failures, or rewrites.

---

### Pitfall 1: Two-Step SENAITE Write — Partial Failure Leaves Analysis in Dirty State

**What goes wrong:** The SENAITE JSON API update endpoint accepts a `Result` field value and a `transition` keyword in the same POST body. If the request times out or the connection drops after SENAITE persists the result value but before it executes the transition, the analysis has a result stored but remains in `unassigned` state. From SENAITE's perspective the result is "saved but not submitted." From the UI's perspective the mutation failed. The optimistic update rolls back. Now the UI shows no result, but SENAITE has one stored. The next attempt to set the same result and submit will either succeed normally or fail with a conflict depending on whether SENAITE treats a second result write as idempotent.

**SENAITE API detail (MEDIUM confidence — from senaite.jsonapi docs):**
The update endpoint `/@@API/senaite/v1/update/<uid>` accepts both field updates and a `"transition": "submit"` in the same POST. The transition "will only take place if the sample is in a suitable status and the user has enough privileges." There is no documented two-phase commit or rollback: if the write succeeds but the transition fails, you receive a partial success response.

**Existing code context:** The integration service `desktop.py` already handles per-analysis outcomes with `success/error` fields in `SubmitResultsResponse`. The state guard `analysis.review_state != "unassigned"` exists. But there is no detection of "result stored, transition skipped" as a distinct error case.

**Why it happens:**
- Network timeout during a slow SENAITE transition
- SENAITE guard condition fails (analysis was moved to a different state by another user between the GET and the POST)
- Optimistic rollback on any error hides that SENAITE may have persisted partial data

**Consequences:**
- Analysis has a stored result in SENAITE but shows as blank in the app after rollback
- Re-submitting the same value works but creates confusion
- Bulk "Submit All" operations may report 0 submitted when 2 out of 5 actually wrote their result values before the transition guard rejected them

**Prevention:**
1. **After any failed mutation, invalidate and refetch rather than roll back to cached state.** Use TanStack Query `onError` + `queryClient.invalidateQueries` so the UI reflects SENAITE's actual post-failure state.
2. **Treat the `SubmitResultsResponse.outcomes` array as ground truth.** Each item has `success`, `new_state`, and `error`. On a bulk operation, display per-analysis outcomes — not a single "failed" toast.
3. **Add a "re-check state" step in the FastAPI adapter before each write.** Before setting a result, GET the analysis's current `review_state`. If it is not `unassigned`, skip the write and return a clear error rather than attempting a doomed transition.
4. **Do not conflate "mutation failed" with "state rolled back."** The optimistic update should revert, but a separate background query should refetch to confirm actual state.

**Warning signs:**
- `onError` handler calls `setQueryData` to restore cached state without also calling `invalidateQueries`
- Toast says "failed" but no refetch occurs — user sees the pre-edit value indefinitely even if SENAITE actually has a different value
- Bulk operation response parsed as binary success/fail rather than per-item outcomes

**Phase:** Phase 1 (result editing foundation) — must design the write path before any UI is built.

---

### Pitfall 2: SENAITE Rejects Invalid Transitions Silently or With 200 OK

**What goes wrong:** SENAITE's workflow guard conditions prevent invalid transitions (e.g., trying to `verify` an analysis that is still `unassigned`, or trying to `submit` an already-`submitted` analysis). However, the SENAITE JSON API does not always return a 4xx error for these cases. Community reports (including the "silent failure on programmatic form submission" thread) document cases where SENAITE returns `200 OK` with an empty `items` array, or where the `items` array contains the object but in its unchanged state. Code that checks only HTTP status codes will treat these as success.

**SENAITE workflow state machine:**
```
unassigned → (submit) → to_be_verified → (verify) → verified
                                        ↓
                                     (retract) → to_be_verified
verified → (retract) → to_be_verified
Any state → (reject) → rejected (with comment required)
```
Attempting `verify` from `unassigned` is an invalid transition. SENAITE will silently no-op.

**Why it happens:**
- Developer checks `response.status_code == 200` and assumes success
- The `items[0].review_state` in the response is not verified against the expected post-transition state
- Optimistic update has already applied the new state badge to the UI

**Consequences:**
- UI shows analysis as "verified" but SENAITE still has it as "unassigned"
- The state divergence is invisible until someone in SENAITE notices the analysis is still unprocessed
- Subsequent transitions from the app will attempt to transition from "verified" but SENAITE rejects because the analysis is still in its original state

**Prevention:**
1. **After every transition POST, read back `review_state` from the SENAITE response body and compare it to the expected post-transition state.** Do not trust HTTP status alone.
2. **In `submit_analysis_result`, the adapter should return the actual `new_state` from SENAITE's response item, and the caller should verify it matches the expected target state.** The existing `ResultOutcome.new_state` field already supports this — ensure it is populated and validated.
3. **Define expected post-transition states as constants in the adapter:**
   ```python
   EXPECTED_POST_STATES = {
       "submit": "to_be_verified",
       "verify": "verified",
       "retract": "to_be_verified",
       "reject": "rejected",
   }
   ```
4. **If `response_state != expected_state`, treat it as a failed transition**, not a success. Return an error from the adapter even when HTTP returned 200.

**Warning signs:**
- Adapter's `submit_analysis_result` returns `success=True` based only on HTTP status, not on verifying the resulting `review_state`
- No constants or enum for SENAITE analysis states anywhere in the codebase
- Transition action and expected state not paired anywhere

**Phase:** Phase 1 — must be part of the SENAITE adapter design. The `SubmitResultsResponse` model already exists; this is a behavioral gap in the adapter.

---

### Pitfall 3: Optimistic Update Race Condition — Concurrent Invalidations Revert the Second Edit

**What goes wrong:** The user edits analysis A, triggering Mutation 1 (optimistic update applied). Before Mutation 1 settles, the user edits analysis B, triggering Mutation 2 (optimistic update applied). Mutation 1 settles and calls `queryClient.invalidateQueries`. This triggers a refetch. If the refetch completes before Mutation 2 settles, the refetch overwrites the optimistic data for Mutation 2, reverting the UI to the pre-edit value for analysis B. When Mutation 2 finally settles, it invalidates again, which triggers another refetch that shows the correct final state — but the user saw a momentary revert.

This is documented in the TanStack Query ecosystem (tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query) as a real, non-hypothetical bug pattern.

**Why it happens:**
- `onSettled` always calls `invalidateQueries` regardless of other in-flight mutations
- `cancelQueries` in `onMutate` only cancels queries that were running at mutation start, not queries triggered by a sibling mutation's settlement

**Consequences:**
- Analysis cells flicker back to old values mid-edit, confusing the user
- User re-enters a value they already entered
- In a bulk operation, multiple flickering cells make the operation feel broken

**Prevention:**
1. **Conditional invalidation — only invalidate after the last in-flight mutation:**
   ```typescript
   onSettled: async () => {
     if (queryClient.isMutating({ mutationKey: ['analyses', sampleId] }) === 1) {
       await queryClient.invalidateQueries({ queryKey: ['analyses', sampleId] })
     }
   }
   ```
2. **Always call `queryClient.cancelQueries` in `onMutate`** to prevent any in-flight refetch from overwriting the optimistic state at mutation start.
3. **For bulk operations, issue a single invalidation after all mutations complete** rather than one invalidation per mutation.

**Warning signs:**
- `useMutation` for analysis edits calls `invalidateQueries` unconditionally in `onSettled`
- No `cancelQueries` call in `onMutate`
- Multiple mutations use the same query key without coordination

**Phase:** Phase 1 (result editing) — must be part of the mutation design, not retrofit.

---

### Pitfall 4: SampleDetails Component Grows to 2000+ Lines

**What goes wrong:** `SampleDetails.tsx` is already 1400+ lines. Adding inline editing requires: edit mode state per row, pending/saving state indicators, keyboard event handlers (Enter/Escape/Tab/blur), validation, workflow action buttons, confirmation dialogs, bulk selection state, and error display per row. Dumping all of this into the existing component will push it past 2000 lines and make it unreadable. More critically, editing state (which cell is active, what the draft value is) and server state (what SENAITE thinks the value is) will become tangled together.

**Why it happens:**
- The feature is "just adding a few inputs and buttons to the existing table"
- Edit state is added as local `useState` calls at the top of the existing component
- Keyboard handlers and mutation hooks are placed inline rather than extracted
- The "big component" pattern accumulates momentum as each addition feels small

**Consequences:**
- Every render of the full sample detail re-evaluates all editing state
- State bugs are hard to isolate because editing state, server state, and UI state are all in one place
- Testing becomes impractical
- Future changes (e.g., adding retract with comment modal) require reading 2000+ lines to understand context

**Prevention:**
1. **Extract `AnalysisTable` as a fully independent component before adding editing.** It receives read-only `analyses: AnalysisRow[]` and callbacks `onEdit`, `onTransition`. It owns zero server state.
2. **Create a custom hook `useAnalysisEditing(sampleId)` that encapsulates:** draft values, which row is in edit mode, mutation calls, optimistic state, and keyboard handler logic. The component only calls this hook and renders.
3. **Create `useWorkflowActions(sampleId)` that encapsulates:** allowed transitions per state, confirmation requirements, bulk selection, and mutation calls for transitions.
4. **The rule:** If `SampleDetails.tsx` grows past 200 lines after adding this feature, something was not extracted.

**Warning signs:**
- `useState` calls for `editingRow`, `draftValue`, `pendingRows`, `selectedRows` appear at the top of `SampleDetails.tsx`
- Keyboard event handlers defined inline in JSX: `onKeyDown={(e) => { if (e.key === 'Enter') { ... } }}`
- The component imports `useMutation` directly
- No `AnalysisTable` component exists as a separate file

**Phase:** Phase 1 (architecture) — extract before adding, not after. This is the one structural decision that cannot be undone cheaply.

---

## Moderate Pitfalls

Mistakes that cause incorrect UX, stale data, or confusing error states.

---

### Pitfall 5: Stale Analysis State When SENAITE Web UI Is Used Concurrently

**What goes wrong:** A lab manager opens the SENAITE web interface and verifies an analysis. Meanwhile, the desktop app is displaying that analysis as `to_be_verified`. The user tries to verify it from the app. The app sends a `verify` transition request. SENAITE rejects it because the analysis is already `verified`. The app shows an error. The user is confused — the UI shows `to_be_verified` but the action fails.

SENAITE has no push notification mechanism. The desktop app's TanStack Query cache has a stale copy.

**Why it happens:**
- TanStack Query `staleTime` is set long (or uses default 0 but low `refetchInterval`)
- The user opened SampleDetails 5 minutes ago and never refreshed
- No background polling or window-focus-based refetch configured

**Prevention:**
1. **Set `refetchOnWindowFocus: true` for analysis queries.** When the user switches back to the desktop app window, data refreshes automatically. This is the primary mitigation.
2. **Set a short `staleTime` (30–60 seconds) for analysis state.** Analysis state changes are lab-critical; stale caches for minutes are unacceptable.
3. **On any transition failure, trigger an immediate refetch before showing the error toast.** The error message should reflect the actual current state: "Could not verify: analysis is already verified by someone else."
4. **Show `modified` timestamp on each analysis row** (SENAITE returns this field). If the timestamp is old, the user has context.

**Warning signs:**
- Analysis queries have `staleTime: Infinity` or `refetchOnWindowFocus: false`
- Error handling for transition failures shows a generic "failed" message without re-fetching to show current state
- No `modified` or `last updated` timestamp visible in the UI

**Phase:** Phase 1 — data freshness strategy must be set when the query is first written.

---

### Pitfall 6: Bulk Operation Partial Failure Is Treated as Binary All-or-Nothing

**What goes wrong:** User selects 5 analyses and clicks "Submit All." 3 succeed, 2 fail (one because it was already submitted by SENAITE web UI, one due to a network timeout). The frontend has two bad options:
- **Roll back all 5** (incorrect — 3 analyses really were submitted and are now in `to_be_verified` state in SENAITE)
- **Show success** (incorrect — 2 analyses were not submitted)

The existing `SubmitResultsResponse` model correctly returns per-item outcomes. But the UI layer must use them rather than inspecting only `submitted == total`.

**Why it happens:**
- Frontend checks `response.failed > 0` and shows a single error toast, rolling back all optimistic updates
- Or frontend checks `response.submitted == total` for a green "done" indicator
- The per-item `outcomes` array is logged but not displayed

**Consequences:**
- User retries the whole bulk submit, hitting SENAITE with a second request for the 3 already-submitted analyses
- SENAITE rejects the re-submit (guard: state is `to_be_verified`, not `unassigned`) — now those 3 also show as errors
- The user cannot tell which of the 5 actually need attention

**Prevention:**
1. **Never roll back optimistic updates for items that succeeded.** After a bulk mutation, use the `outcomes` array to: keep the new state for `success: true` items, revert to original state for `success: false` items.
2. **Display a per-item result summary, not a single toast.** Show "3 submitted, 2 failed" with expandable detail.
3. **Failed items should show their specific error inline on the row**, not in a separate dialog.
4. **The FastAPI `SubmitResultsResponse.outcomes` already has the structure for this** — the gap is in how the frontend consumes it.

**Warning signs:**
- Frontend mutation's `onError` reverts the entire `analyses` cache array when only some items failed
- Bulk submit result displayed as a single success/fail toast
- No per-row error state in the analyses table

**Phase:** Phase 2 (bulk operations) — but the `onError` / `onSuccess` handling strategy must be established in Phase 1 for single edits, then extended.

---

### Pitfall 7: Keyboard Event Handler Conflicts and Stale Closure State

**What goes wrong:** An inline editor captures `onKeyDown` for Escape (cancel) and Enter (save). The `onBlur` event also saves. A user presses Enter to save: the Enter `keydown` handler fires, calls `save(draftValue)` and exits edit mode. Then `onBlur` fires (focus left the input), calls `save(draftValue)` again. Two save mutations fire for the same value. The second mutation may trigger a second `submit` transition on SENAITE, which fails (already `to_be_verified`).

Additionally: if the `save` function in the keydown handler captures `draftValue` from a closure at handler creation time, but `draftValue` has been updated by subsequent keystrokes not yet reflected in the closure, the user saves a stale value.

**Why it happens:**
- Both `onBlur` and `onKeyDown` trigger save without coordination
- No flag to track "save already initiated"
- React's synthetic event system: `keydown` fires before `blur`, but both events complete within the same tick depending on the implementation

**Prevention:**
1. **Use a single code path for saving.** One function `commitEdit()` that checks a `savePending` ref, sets it, fires the mutation, then clears it. Both `onBlur` and `onKeyDown` call `commitEdit()`. The ref prevents double-fire.
   ```typescript
   const savePending = useRef(false)
   const commitEdit = useCallback(() => {
     if (savePending.current) return
     savePending.current = true
     mutate(draftValue, { onSettled: () => { savePending.current = false } })
   }, [draftValue, mutate])
   ```
2. **For Escape (cancel), call `e.stopPropagation()` AND `e.preventDefault()`** before resetting draft state, to prevent blur from triggering save after cancel.
3. **Use `useCallback` or the `useEvent` pattern for event handlers** to avoid stale closure captures of `draftValue`. The mutation should read the latest draft value at call time.

**Warning signs:**
- Both `onBlur` and `onKeyDown Enter` call the same save function without a guard
- Event handlers defined inline in JSX with dependencies that could be stale
- No ref-based deduplication for mutation calls

**Phase:** Phase 1 — must be established in the inline editor component design.

---

### Pitfall 8: Workflow Action Buttons Show for Invalid States — SENAITE Rejects

**What goes wrong:** A "Submit" button is shown for all analyses regardless of current state. The user clicks Submit on an analysis that is already `to_be_verified`. The app sends the transition request. SENAITE silently no-ops (or returns 200 with unchanged state). The UI shows a spinner then removes it with no visible change. The user clicks again. The cycle repeats.

Less obviously: a "Verify" button is shown for an analysis in `unassigned` state (no result entered yet). The user clicks. SENAITE rejects. Error toast. User is confused because they see what looks like a valid action.

**Why it happens:**
- Button visibility determined by role/permission only, not by `review_state`
- `getAllowedTransitions` is not called per-analysis; instead, all buttons are rendered and errors are surfaced post-click
- The SENAITE state machine is not modeled on the frontend

**Prevention:**
1. **Model the SENAITE analysis state machine as a constant on the frontend:**
   ```typescript
   const ALLOWED_TRANSITIONS: Record<string, string[]> = {
     unassigned: ['submit'],
     to_be_verified: ['verify', 'retract'],
     verified: ['retract'],
     rejected: [],
   }
   ```
2. **Derive button visibility from `analysis.review_state`**, not from a flat list of possible actions.
3. **"Submit" should additionally require that a result value is set** (non-empty `result` field). If the result is empty, Submit is disabled with a tooltip explaining why.
4. **For bulk operations, filter the selection to only analyses in a state that allows the target transition.** "Submit All" should skip or warn about analyses that are already submitted.

**Warning signs:**
- Action buttons rendered identically regardless of `review_state`
- No `ALLOWED_TRANSITIONS` constant or enum in the codebase
- Transition buttons shown for verified analyses

**Phase:** Phase 1 (UI) — the state machine model must exist before buttons are rendered.

---

### Pitfall 9: Confirm-Before-Transition Dialogs Block Bulk Operations

**What goes wrong:** Adding a confirmation dialog for destructive transitions (Retract, Reject) is correct. But if the dialog is implemented as a modal that blocks all other interaction, then during a bulk "Submit All" with mixed states, the dialog fires multiple times — once for each item that needs confirmation. The user must click through N dialogs for N retracts.

Alternatively: the confirmation dialog is bypassed by enthusiastic users who have learned that "it always works," leading to accidental destructive transitions.

**Why it happens:**
- Confirmation logic is per-item, not per-batch
- Dialog is shown for `retract`/`reject` on each mutation individually
- No "confirm once for N operations" UX pattern implemented

**Prevention:**
1. **Confirmation should be per-batch, not per-item.** If the user selects 5 analyses and clicks "Retract All," show one confirmation: "Retract 5 analyses? This will require re-verification." Not 5 separate dialogs.
2. **Implement a single-confirm-then-proceed pattern** using a pending action queue: user triggers action → accumulate targets → one dialog → fire all mutations.
3. **Use `AlertDialog` (shadcn/ui) for destructive transitions**, not inline buttons that execute immediately.
4. **For non-destructive transitions (Submit)**, a confirmation dialog is not needed. Show undo capability instead (cancel the submit within N seconds before it is confirmed in SENAITE — though SENAITE may not support this).

**Warning signs:**
- `AlertDialog` opened inside a `.map()` of analyses
- Confirmation dialog fires per-item during bulk operations
- No distinction in confirmation behavior between Submit (non-destructive) and Retract/Reject (destructive)

**Phase:** Phase 2 (workflow actions) — design the confirmation UX pattern before implementing any destructive transitions.

---

### Pitfall 10: SENAITE Slow Response Creates Misleading Loading State

**What goes wrong:** SENAITE transitions can take 2–5 seconds on a loaded server, or longer during peak periods. If the loading state is not handled gracefully:
- User sees a spinner on the row indefinitely, clicks again (double-submit)
- Or: user navigates away while the request is in flight; the mutation completes but the component is unmounted; the update is lost (TanStack Query handles this, but the user does not see the result)
- Or: a 30-second timeout fires and the user receives a "network error" — but SENAITE had already executed the transition

**Why it happens:**
- Default `httpx` timeouts in FastAPI adapter are either too short (5s) or too long (infinity)
- No per-row `isPending` state shown to the user
- Action buttons remain clickable while mutation is in flight

**Prevention:**
1. **Set a reasonable timeout on the FastAPI SENAITE adapter** (15–20 seconds for transitions, shorter for reads). A 30-second timeout on a user-initiated action is too long; a 5-second timeout on a slow SENAITE server will cause false failures.
2. **Show per-row loading state.** The `isPending` state from the mutation must propagate to the individual row, not just a global spinner.
3. **Disable action buttons while `isPending` for that row.** Prevents double-submit.
4. **On `isError`, distinguish network timeout from SENAITE rejection.** A timeout error should suggest "SENAITE may be slow — check the result before retrying." A 4xx/5xx error should show what SENAITE said.

**Warning signs:**
- A single `isMutating` flag at the sample level rather than per-analysis
- Action buttons not disabled when their row's mutation is in flight
- No timeout configured on the `httpx.AsyncClient` used in the SENAITE adapter
- Error toast says "Something went wrong" for all error types

**Phase:** Phase 1 — timeout configuration and per-row loading state must be part of the initial implementation.

---

## Minor Pitfalls

Mistakes that cause annoyance or minor UX issues, fixable without architectural changes.

---

### Pitfall 11: Tab Key Navigates Out of Inline Editor Before Save

**What goes wrong:** User is editing a result value in a cell. They press Tab expecting to move to the next cell. Tab moves browser focus to an unrelated element (e.g., a sidebar link). The edited value may or may not save depending on whether `onBlur` is implemented.

**Prevention:**
- Intercept Tab in `onKeyDown`. If Tab is pressed, save the current value and explicitly focus the next editable cell by index.
- Explicitly set `tabIndex` on analysis result cells to control Tab order within the table.
- Tab out of the last cell should commit and exit edit mode, not cycle back to the first.

**Phase:** Phase 1 — part of keyboard handling specification.

---

### Pitfall 12: Input Value Flicker on Optimistic Update + React Controlled Input

**What goes wrong:** The analyses table uses server state (`result` from cache) as the input `value`. On optimistic update, the cache is patched to show the new value. But if React re-renders the input with the patched value while the user is still typing, the cursor jumps to the end of the input.

**Prevention:**
- Use separate local `draftValue` state for the input, initialized from the server value when edit mode is entered.
- Do not bind the input's `value` directly to the TanStack Query cache.
- Only write to the cache (optimistic or confirmed) after the edit is committed, not on each keystroke.

**Phase:** Phase 1 — input binding strategy.

---

### Pitfall 13: Retract Transition Requires a Reason/Comment in SENAITE

**What goes wrong:** The SENAITE Retract transition may require a `Remarks` field to be populated. The API call succeeds in setting the field value, but if the `Remarks` field is empty, the transition guard may reject the action with a validation error that is not a standard HTTP 4xx — it may be a 200 with an error in the response body. The UI shows no indication that a retract comment is required.

**Prevention:**
- Before implementing the Retract action, verify with a test SENAITE instance whether `Remarks` is required for the retract transition on your specific SENAITE configuration.
- If required, show a `<Textarea>` prompt before the mutation fires.
- Parse SENAITE's response body for validation errors that come with 200 OK.

**Phase:** Phase 2 (workflow actions) — test actual transition requirements against your SENAITE instance before implementing the UI.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| **SENAITE adapter** | Transition accepts 200 OK as success without checking `review_state` | Verify post-transition state in adapter; define `EXPECTED_POST_STATES` |
| **SENAITE adapter** | Network timeout after partial write (result stored, no transition) | `onError` → invalidate + refetch; never assume rollback = clean state |
| **Result editing** | Optimistic update race condition from concurrent edits | Conditional `invalidateQueries` using `isMutating === 1` |
| **Result editing** | Double-save from both `onBlur` and `onKeyDown Enter` | Single `commitEdit()` with `savePending` ref guard |
| **Result editing** | Input cursor jump from server state bound directly to `value` | Use `draftValue` local state; only write to cache on commit |
| **Component structure** | `SampleDetails.tsx` swells past 2000 lines | Extract `AnalysisTable`, `useAnalysisEditing`, `useWorkflowActions` before adding features |
| **Workflow actions** | Action buttons visible for invalid states | Model `ALLOWED_TRANSITIONS` constant; derive button visibility from `review_state` |
| **Workflow actions** | Multiple confirmation dialogs for bulk destructive transitions | Batch confirm pattern — one dialog for N items |
| **Workflow actions** | SENAITE slow → double-submit or false timeout error | Per-row `isPending`; buttons disabled while in flight; configured timeout on adapter |
| **Concurrent editing** | Stale state when SENAITE web UI used simultaneously | `refetchOnWindowFocus: true`; short `staleTime` (30–60s) |
| **Bulk operations** | Partial bulk failure causes full optimistic rollback | Per-item outcome handling; selectively revert only failed items |

---

## Confidence Assessment

| Area | Confidence | Source |
|------|------------|--------|
| SENAITE two-step write / partial failure risk | MEDIUM | senaite.jsonapi docs (transition keyword behavior); community silent-failure reports; actual `desktop.py` code |
| SENAITE 200 OK silent transition failure | MEDIUM | Community forum thread (unresolved silent failure report); inferred from "will only take place if suitable status" docs |
| SENAITE state machine transitions | HIGH | Official SENAITE docs (Sample Analyses, Sample Basics); Bika LIMS workflow docs |
| TanStack Query concurrent optimistic update race | HIGH | tkdodo.eu authoritative blog post; TanStack Query GitHub discussion #7932; official docs |
| TanStack Query `isMutating` conditional invalidation | HIGH | tkdodo.eu; verified against TanStack Query v5 docs |
| React inline editing double-save via blur+keydown | HIGH | Multiple authoritative sources; well-documented React event handling pattern |
| Stale closure in event handlers | HIGH | Official React docs; dmitripavlutin.com authoritative post |
| Component size / extraction strategy | HIGH | alexkondov.com; codescene engineering blog; React best practices consensus |
| Retract requiring a comments field | LOW | Inferred from SENAITE retract behavior docs (Bika LIMS); not verified against actual SENAITE instance configuration |

---

## Sources

### SENAITE API and Workflow
- [SENAITE JSON API CRUD Documentation — senaite.jsonapi 2.6.0](https://senaitejsonapi.readthedocs.io/en/latest/crud.html) — transition keyword in POST body (MEDIUM confidence)
- [SENAITE Silent Failure Community Report — community.senaite.org](https://community.senaite.org/t/senaite-lims-silent-failure-on-programmatic-form-submission-even-with-admin-user/1771) — 200 OK without state change (MEDIUM confidence)
- [SENAITE Sample Analyses Docs](https://www.senaite.com/docs/sample-analyses) — workflow state descriptions
- [Verifying Results — Bika LIMS](https://www.bikalims.org/manual/workflow/verifying-results) — verify/retract workflow
- [Retracting Calculated Analysis Inconsistent State — senaite/senaite.core #1283](https://github.com/senaite/senaite.core/issues/1283) — guard condition edge cases
- [Setting Results via API — community.senaite.org/t/senaite-json-api-update-sample-analyses](https://community.senaite.org/t/senaite-json-api-update-sample-analyses/1432) — POST body pattern, auth requirement

### TanStack Query Optimistic Updates
- [Concurrent Optimistic Updates in React Query — tkdodo.eu](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query) — race condition analysis, `isMutating` pattern (HIGH confidence)
- [TanStack Query Discussion #7932 — race condition with cancelQueries](https://github.com/TanStack/query/discussions/7932) — real-world race condition report
- [Optimistic Updates — TanStack Query v5 docs](https://tanstack.com/query/v5/docs/framework/react/guides/optimistic-updates) — official rollback pattern
- [React Query Autosave Race Conditions — pz.com.au](https://www.pz.com.au/avoiding-race-conditions-and-data-loss-when-autosaving-in-react-query) — autosave pattern and deduplication

### React Inline Editing and Keyboard Handling
- [Complete Guide to Inline Editable UI in React — DEV Community](https://dev.to/bnevilleoneill/the-complete-guide-to-building-inline-editable-ui-in-react-1po9) — blur/keydown event handling
- [Common Stale Closure Bugs in React — DEV Community](https://dev.to/cathylai/common-stale-closure-bugs-in-react-57l6) — stale closure patterns
- [Stale Closures in React Hooks — dmitripavlutin.com](https://dmitripavlutin.com/react-hooks-stale-closures/) — authoritative explanation
- [Editing Guide — Material React Table V3](https://www.material-react-table.com/docs/guides/editing) — blur/onChange wiring in cell editing

### Component Architecture
- [Common Sense Refactoring of a Messy React Component — alexkondov.com](https://alexkondov.com/refactoring-a-messy-react-component/) — extraction patterns
- [Refactoring Components with Custom Hooks — codescene](https://codescene.com/engineering-blog/refactoring-components-in-react-with-custom-hooks) — hook extraction strategy
