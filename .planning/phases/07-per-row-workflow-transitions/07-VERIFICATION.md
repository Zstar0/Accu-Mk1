---
phase: 07-per-row-workflow-transitions
verified: 2026-02-25T00:00:00Z
status: passed
score: 9/9 must-haves verified
---

# Phase 07: Per-Row Workflow Transitions Verification Report

**Phase Goal:** Lab staff can execute any valid workflow transition (submit, verify, retract, reject) on individual analysis rows, with the sample-level status badge and progress bar reflecting the change immediately.
**Verified:** 2026-02-25
**Status:** passed
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Each analysis row shows an action menu with only valid transitions for its current review_state | VERIFIED | ALLOWED_TRANSITIONS map (AnalysisTable.tsx lines 98-102) gates which transitions render; menu only appears when allowedTransitions.length > 0 (line 338) |
| 2 | Unassigned shows Submit; to_be_verified shows Verify/Retract/Reject; verified shows Retract | VERIFIED | Lines 99-101: unassigned:[submit], to_be_verified:[verify,retract,reject], verified:[retract] |
| 3 | Non-destructive transitions execute immediately with a loading spinner on the row | VERIFIED | Line 363: void transition.executeTransition called directly; isPending via pendingUids.has(uid) (line 306); Spinner shown when isPending (lines 346-349) |
| 4 | Destructive transitions open a confirmation AlertDialog before executing | VERIFIED | DESTRUCTIVE_TRANSITIONS = new Set([retract, reject]) (line 111); line 361: transition.requestConfirm called; AlertDialog at lines 526-557 gated on pendingConfirm \!== null |
| 5 | While a transition is in-flight the row action trigger shows a spinner and is disabled | VERIFIED | Button disabled={isPending} (line 342); renders Spinner when isPending else MoreHorizontal (lines 346-350); disabled:opacity-50 CSS |
| 6 | Successful transitions show a success toast; failed transitions show an error toast with the backend message | VERIFIED | Lines 51-55: toast.success on response.success; toast.error with response.message on failure; toast.error with err.message in catch |
| 7 | After any analysis transition the sample-level status badge and progress bar update | VERIFIED | onTransitionComplete={() => refreshSample(data.sample_id)} (SampleDetails.tsx line 1073); refreshSample calls setData(result) (lines 441-445); data.review_state feeds StatusBadge at line 599 |
| 8 | The page does NOT flash a full-page loading spinner during post-transition refresh | VERIFIED | refreshSample (lines 441-445) calls only setData(result) with no setLoading(true); setLoading only called in fetchSample and the initial useEffect |
| 9 | Sample-level auto-transitions are visible immediately after refresh | VERIFIED | Full lookupSenaiteSample re-fetch in refreshSample returns fresh SENAITE data; result fed directly to setData which re-renders header badge and counters |

**Score:** 9/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| src/lib/api.ts - transitionAnalysis | POST to backend transition endpoint | VERIFIED | Lines 2131-2148: typed, POST to /wizard/senaite/analyses/{uid}/transition, JSON error unwrapping |
| src/hooks/use-analysis-transition.ts | Hook with pendingUids Set + pendingConfirm | VERIFIED | 97 lines, exports UseAnalysisTransitionReturn, all 5 methods fully implemented |
| src/components/senaite/AnalysisTable.tsx - Actions column | ALLOWED_TRANSITIONS map, DropdownMenu per row | VERIFIED | 562 lines; ALLOWED_TRANSITIONS at line 98, DropdownMenu at lines 339-371 |
| src/components/senaite/AnalysisTable.tsx - AlertDialog | Confirmation dialog outside table element | VERIFIED | AlertDialog at lines 526-557, placed after closing table tag (line 524) inside wrapping div |
| src/components/senaite/SampleDetails.tsx - refreshSample | Silent re-fetch without setLoading | VERIFIED | Lines 441-445; no setLoading call; only setData and toast.error on failure |
| src/components/senaite/SampleDetails.tsx - onTransitionComplete wiring | Prop passed to AnalysisTable calling refreshSample | VERIFIED | Line 1073: onTransitionComplete={() => refreshSample(data.sample_id)} |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| AnalysisRow click | useAnalysisTransition | transition.requestConfirm / transition.executeTransition | WIRED | Lines 358-364: destructive goes to requestConfirm, non-destructive to executeTransition |
| useAnalysisTransition | transitionAnalysis (api.ts) | import + direct call | WIRED | use-analysis-transition.ts line 3 import, line 46 call inside executeTransition |
| transitionAnalysis | Backend API | fetch POST /wizard/senaite/analyses/{uid}/transition | WIRED | api.ts lines 2135-2142 |
| AnalysisTable | SampleDetails refreshSample | onTransitionComplete prop callback | WIRED | SampleDetails.tsx line 1073 passes the callback |
| refreshSample | data state (StatusBadge / counters) | setData(result) | WIRED | Lines 441-445; setData triggers re-render of StatusBadge (line 599) and counters (lines 530-533) |
| AlertDialog confirm button | confirmAndExecute | onClick calls transition.confirmAndExecute() | WIRED | Line 551; confirmAndExecute calls executeTransition (hook line 86) |

### Requirements Coverage

| Requirement | Status | Notes |
|-------------|--------|-------|
| WKFL-01 | SATISFIED | Valid transitions per review_state via ALLOWED_TRANSITIONS |
| WKFL-02 | SATISFIED | Submit available for unassigned rows |
| WKFL-03 | SATISFIED | Verify/Retract/Reject available for to_be_verified rows |
| WKFL-04 | SATISFIED | Retract available for verified rows |
| WKFL-05 | SATISFIED | In-flight spinner and disabled trigger button via pendingUids Set |
| WKFL-06 | SATISFIED | Confirmation AlertDialog for destructive transitions |
| WKFL-07 | SATISFIED | Success/error toasts with backend message on failure |
| REFR-01 | SATISFIED | refreshSample is silent (no setLoading call) |
| REFR-02 | SATISFIED | Sample status badge and counters updated from fresh server data |

### Anti-Patterns Found

None. No TODOs, FIXMEs, placeholder text, empty handlers, or console.log-only implementations detected in any key file.

### Human Verification Required

#### 1. Spinner Visible During Transition

**Test:** Trigger a Submit transition on an unassigned analysis row with network throttling enabled (Slow 3G in DevTools). Observe the action trigger button during the in-flight period.
**Expected:** The MoreHorizontal icon is replaced by an animated spinner and the button is visually disabled (muted, not clickable).
**Why human:** Spinner and disabled state are structurally wired in code but actual visual rendering and timing require runtime observation.

#### 2. AlertDialog Content Correctness

**Test:** Click Retract on a to_be_verified analysis, then click Reject on another to_be_verified analysis.
**Expected:** Dialog title reads "Retract analysis?" or "Reject analysis?" correctly per action; analysis title appears bold in description; confirm button reads "Confirm retract" or "Confirm reject".
**Why human:** Conditional text logic is code-correct but requires runtime observation to confirm the dialog renders as expected.

#### 3. Progress Bar Immediate Update

**Test:** Submit one unassigned analysis, then Verify it.
**Expected:** After each transition, the progress bar in the Analyses card updates its percentage without any full-page loading spinner appearing.
**Why human:** Progress bar value derives from analyses prop (data.analyses from setData). Requires runtime observation to confirm smooth, spinner-free update.

#### 4. Sample-Level Status Badge Auto-Transition

**Test:** Verify the last unverified analysis on a sample and observe the sample header status badge.
**Expected:** The sample status badge updates to reflect the new SENAITE-computed sample state without a full-page reload.
**Why human:** SENAITE server-side auto-transitions depend on live backend state. Requires integration test against a real SENAITE instance.

## Gaps Summary

No gaps. All 9 observable truths are verified by the actual codebase implementation.

- transitionAnalysis in src/lib/api.ts is a complete typed implementation making a real HTTP POST to the backend with proper JSON error handling.
- useAnalysisTransition hook correctly manages a pendingUids Set for per-row loading state and a pendingConfirm object for the destructive confirmation flow, with toast notifications on both success and failure.
- AnalysisTable renders the Actions column with ALLOWED_TRANSITIONS gating, shows a spinner and disabled state when a transition is in-flight, and places the AlertDialog outside the table element (after the closing table tag, before the wrapping div close), which is the correct DOM position to avoid invalid HTML nesting.
- SampleDetails.refreshSample is a clean silent re-fetch with no setLoading call, wired as the onTransitionComplete callback passed to AnalysisTable.
- The sample-level StatusBadge and verified/pending counters derive from data.review_state and data.analyses respectively, so both update immediately when refreshSample resolves and calls setData.

4 items are flagged for human verification covering visual and runtime behavior that cannot be confirmed by static code analysis alone.

---

_Verified: 2026-02-25_
_Verifier: Claude (gsd-verifier)_
