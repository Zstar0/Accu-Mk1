# Phase 07: Per-Row Workflow Transitions - Research

**Researched:** 2026-02-25
**Domain:** SENAITE analysis workflow transitions, React state per-row loading, shadcn/ui DropdownMenu + AlertDialog
**Confidence:** HIGH — all findings verified against live codebase and existing Phase 06 artifacts

## Summary

Phase 07 adds the ability for lab staff to execute SENAITE analysis workflow transitions (submit, verify, retract, reject) from per-row action menus in the AnalysisTable component. The backend transition endpoint is already built and fully functional from Phase 06. The frontend work is entirely additive: a new action column in AnalysisTable, a `useAnalysisTransition` hook managing per-row pending state, an AlertDialog for destructive actions (retract/reject), and a post-transition sample refresh in SampleDetails.

The Phase 06 architecture is clean: AnalysisTable is a standalone component with its own hook (`useAnalysisEditing`), and SampleDetails owns `fetchSample` and the `data` state. Phase 07 extends this pattern — a new `useAnalysisTransition` hook parallels `useAnalysisEditing`, and the `onTransitionComplete` callback from AnalysisTable back to SampleDetails triggers the full re-fetch.

Both UI primitives needed (DropdownMenu, AlertDialog) are already installed and present in `/src/components/ui/`. An existing usage pattern for AlertDialog exists in `AdvancedPane.tsx`.

**Primary recommendation:** Mirror the `useAnalysisEditing` hook pattern for transitions. One new hook, one new API function, one new action column in AnalysisTable. AlertDialog driven by a `pendingConfirm` state value (not a boolean) so the dialog knows which analysis and which action to confirm.

## Standard Stack

### Core (all already installed, zero new dependencies)

| Component | Location | Purpose | Note |
|-----------|----------|---------|------|
| `DropdownMenu` | `@/components/ui/dropdown-menu` | Per-row action menu trigger | shadcn/ui wrapping Radix |
| `AlertDialog` | `@/components/ui/alert-dialog` | Confirm destructive transitions | shadcn/ui wrapping Radix |
| `Spinner` | `@/components/ui/spinner` | Per-row loading indicator | Already used in EditableResultCell |
| `toast` (sonner) | `sonner` | Success/error feedback | Pattern established in Phase 06 |

### API Functions (to add)

| Function | Location | Purpose |
|----------|----------|---------|
| `transitionAnalysis(uid, transition)` | `src/lib/api.ts` | Call backend transition endpoint |

The backend endpoint is at `POST /wizard/senaite/analyses/{uid}/transition` and already returns `AnalysisResultResponse` (`success`, `message`, `new_review_state`, `keyword`). The `AnalysisResultResponse` interface already exists in `api.ts`. No new backend work or new types required.

### No New Dependencies

```bash
# Nothing to install — all packages already present
```

## Architecture Patterns

### State Machine Constant (ALLOWED_TRANSITIONS)

Define a constant (not a function) mapping each `review_state` to its valid transition names. This is the single source of truth for which menu items appear per row.

```typescript
// Source: phase requirements + SENAITE workflow documented in STATE.md
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  unassigned: ['submit'],
  to_be_verified: ['verify', 'retract', 'reject'],
  verified: ['retract'],
  // rejected, retracted, published: [] — no transitions
}
```

### Recommended Component Structure

```
src/
├── hooks/
│   ├── use-analysis-editing.ts   (Phase 06 — unchanged)
│   └── use-analysis-transition.ts  (NEW — Phase 07)
├── components/senaite/
│   ├── AnalysisTable.tsx         (MODIFIED — add Actions column)
│   └── SampleDetails.tsx         (MODIFIED — pass onTransitionComplete, call fetchSample)
└── lib/
    └── api.ts                    (MODIFIED — add transitionAnalysis function)
```

### Pattern 1: useAnalysisTransition Hook

Mirrors `useAnalysisEditing`. Manages per-row pending state with a `Map<uid, boolean>` rather than a single `isSaving` boolean, because multiple rows could theoretically be in different states (and to avoid a single shared flag blocking unrelated rows).

```typescript
// Source: mirrors use-analysis-editing.ts pattern (verified codebase)
export interface UseAnalysisTransitionReturn {
  pendingUids: Set<string>          // which rows have in-flight transitions
  pendingConfirm: { uid: string; transition: string; analysisTitle: string } | null
  executeTransition: (uid: string, transition: string) => Promise<void>
  requestConfirm: (uid: string, transition: string, analysisTitle: string) => void
  cancelConfirm: () => void
  confirmAndExecute: () => Promise<void>
}
```

Key design decisions:
- `pendingUids: Set<string>` instead of `pendingUid: string | null` — a row being pending should not block other rows
- `pendingConfirm` holds the full confirmation context (uid + transition + title) rather than separate pieces of state — avoids state mismatch when dialog closes
- Hook receives `onTransitionComplete` callback (same pattern as `onResultSaved`)

### Pattern 2: AlertDialog Driven by pendingConfirm State

The alert dialog is controlled (open when `pendingConfirm !== null`). This avoids the "Trigger inside table row" nesting complexity. The dialog lives at the AnalysisTable level, not inside AnalysisRow.

```typescript
// Source: AdvancedPane.tsx pattern + AlertDialog controlled mode
// Controlled AlertDialog — do NOT nest inside <tr>/<td>
<AlertDialog open={pendingConfirm !== null} onOpenChange={(open) => {
  if (!open) cancelConfirm()
}}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>
        {pendingConfirm?.transition === 'retract' ? 'Retract analysis?' : 'Reject analysis?'}
      </AlertDialogTitle>
      <AlertDialogDescription>
        {pendingConfirm?.analysisTitle} will be {pendingConfirm?.transition === 'retract' ? 'retracted back to unassigned' : 'rejected'}.
        This cannot be undone without manual SENAITE access.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel onClick={cancelConfirm}>Cancel</AlertDialogCancel>
      <AlertDialogAction
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        onClick={confirmAndExecute}
      >
        Confirm {pendingConfirm?.transition}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

### Pattern 3: DropdownMenu in Table Row

DropdownMenu trigger must be in the table row but the content uses a Portal, so it escapes `<tr>` overflow constraints automatically (Radix handles this). The trigger is an icon button (ChevronDown or MoreHorizontal from lucide-react).

```typescript
// Source: shadcn DropdownMenu API (verified in dropdown-menu.tsx)
// GOOD: DropdownMenuContent uses Portal internally — safe inside <td>
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <button
      disabled={isPending}
      className="..."
      aria-label={`Actions for ${analysis.title}`}
    >
      {isPending ? <Spinner className="size-3.5" /> : <MoreHorizontal size={14} />}
    </button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    {transitions.map(t => (
      <DropdownMenuItem
        key={t}
        variant={t === 'retract' || t === 'reject' ? 'destructive' : 'default'}
        onClick={() => handleTransition(t)}
      >
        {TRANSITION_LABELS[t]}
      </DropdownMenuItem>
    ))}
  </DropdownMenuContent>
</DropdownMenu>
```

### Pattern 4: Two-Step Submit (Result + Transition)

For `submit`, the user already enters the result via the inline edit (Phase 06). The submit transition is a separate action: the user must have a result saved first, then trigger submit from the action menu. This matches the documented decision: "Result-set and transition are separate atomic endpoints — frontend controls the two-step workflow."

The action menu for `unassigned` rows shows `submit`. The UX implication: if a row has no result, submitting will silently succeed at the HTTP level but SENAITE may reject it. The backend EXPECTED_POST_STATES check handles this — if SENAITE does not advance to `to_be_verified`, the backend returns `success: false`.

### Pattern 5: Post-Transition Sample Refresh (REFR-01/REFR-02)

SampleDetails owns `fetchSample`. After any analysis transition, AnalysisTable calls `onTransitionComplete()`, which SampleDetails wires to call `fetchSample(sampleId)`. This re-fetches the full sample including updated analyses, new `review_state` for each row, updated sample-level `review_state`, and updated verified/pending counts.

```typescript
// Source: SampleDetails.tsx fetchSample (existing, line 430)
// SampleDetails passes:
<AnalysisTable
  analyses={analyses}
  analyteNameMap={analyteNameMap}
  onResultSaved={...}
  onTransitionComplete={() => fetchSample(data.sample_id)}  // NEW
/>
```

This means verifiedCount, pendingCount, sample-level StatusBadge, and progress bar all update automatically — they are computed from `data` which is replaced by the fresh fetch result.

### Anti-Patterns to Avoid

- **Nesting AlertDialog inside `<tr>`/`<td>`**: Radix Dialog breaks when nested inside table elements. Keep the AlertDialog at AnalysisTable level, outside the `<table>` tag entirely.
- **Using `Promise.all` for transitions**: STATE.md explicitly prohibits this. If any future bulk path executes multiple transitions, use `for...await` sequentially.
- **Optimistic state update for transitions**: Unlike result saves (which have clear rollback), transitions that fail should re-fetch to ensure consistent state. Do not attempt optimistic updates for review_state changes.
- **Single shared `isPending` boolean**: Blocks the entire table. Use `Set<string>` keyed by uid so each row manages its own pending state independently.
- **Destructuring Zustand store**: Project architecture rule — use selector syntax only (`useUIStore(state => state.x)`). Not relevant here since transitions use local hook state, but important if any new store reads are needed.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Transition validation | Custom state machine logic | `ALLOWED_TRANSITIONS` constant lookup | Simple object lookup is sufficient; no runtime machinery needed |
| Confirmation dialog | Custom modal/overlay | `AlertDialog` from `@/components/ui/alert-dialog` | Already installed, accessible, Radix-based |
| Action menu | Custom dropdown with positioning | `DropdownMenu` from `@/components/ui/dropdown-menu` | Portal-based, handles overflow/z-index |
| Loading indicator | Custom spinner | `Spinner` from `@/components/ui/spinner` | Already used in EditableResultCell |

**Key insight:** Every UI primitive for this phase is already installed. Zero new packages.

## Common Pitfalls

### Pitfall 1: SENAITE Silent Transition Rejection (DATA-04)

**What goes wrong:** SENAITE returns 200 OK when a transition is invalid for the current state (e.g., trying to submit an already-verified analysis). The HTTP response gives no indication of failure.

**Why it happens:** SENAITE's workflow engine silently skips invalid transitions rather than returning 4xx.

**How to avoid:** The backend `transition_analysis` endpoint already handles this with `EXPECTED_POST_STATES` validation (lines 5929-6000 in `main.py`). The frontend reads `response.success` — do not assume `!response.ok` is the only failure case. A 200 OK from the backend can still have `success: false`.

**Warning signs:** User sees no error, badge doesn't change, but no error toast either. Always check `response.success`, not just HTTP status.

### Pitfall 2: AlertDialog DOM Nesting in Table

**What goes wrong:** Placing `<AlertDialog>` inside a `<tr>` causes invalid HTML nesting (dialog portals still render at body level, but the trigger element inside `<tr>` can cause React hydration/event propagation issues in some environments).

**Why it happens:** Developers co-locate the trigger with the data row for convenience.

**How to avoid:** Keep `<AlertDialog>` outside the `<table>` element. Use `pendingConfirm` controlled state to open it from an action inside the row. The dialog renders at body level via the Portal regardless.

### Pitfall 3: Stale Closure in pendingConfirm

**What goes wrong:** `confirmAndExecute` captures a stale `pendingConfirm` if the state update is async.

**Why it happens:** React state updates are batched; a closure formed before the update fires sees old values.

**How to avoid:** In `confirmAndExecute`, read `pendingConfirm` at call time from the hook's state (it's captured in the closure at the time the dialog's Confirm button renders). Since `pendingConfirm` is set before the dialog opens and only cleared after `confirmAndExecute` completes or `cancelConfirm` is called, the closure is always fresh. Pattern is stable.

### Pitfall 4: Double-Trigger on Dropdown Item Click + Keyboard

**What goes wrong:** Radix DropdownMenuItem fires `onClick` on both pointer and keyboard (Enter/Space). No additional debounce is needed, but `disabled` must be propagated to the trigger and items to prevent re-clicks during an in-flight transition.

**How to avoid:** Disable the entire DropdownMenuTrigger when `pendingUids.has(analysis.uid)`. This prevents both click and keyboard activation.

### Pitfall 5: Remarks Field on Retract/Reject

**What goes wrong:** SENAITE's retract or reject transition may require a Remarks field in some configurations. If so, submitting without it causes a silent failure (Pitfall 1).

**How to avoid:** The STATE.md blocker notes this must be manually tested against live SENAITE before building the AlertDialog. The blocker is: "Before implementing retract/reject AlertDialog, manually test the retract transition against live SENAITE via Swagger UI. Confirm whether Remarks field is required. If yes, add Textarea to dialog before building UI." This test should happen as part of plan 07-02 before the dialog is built, or as a pre-task in 07-02.

### Pitfall 6: fetchSample Re-fetch Causes Full Loading State

**What goes wrong:** Calling `fetchSample` after a transition sets `loading = true` in SampleDetails, causing the entire page to flash a full-page loading spinner.

**Why it happens:** The existing `fetchSample` function sets `setLoading(true)` unconditionally (line 431 of SampleDetails.tsx).

**How to avoid:** For the post-transition refresh, consider a "silent refresh" variant that does not set `loading = true`, only updates `data` when the fetch resolves. This keeps the page content visible during the re-fetch. A `silentRefresh` boolean parameter or a separate `refreshSample` function that skips `setLoading(true)` is the pattern to use.

## Code Examples

### transitionAnalysis API function (to add to api.ts)

```typescript
// Source: mirrors setAnalysisResult pattern (api.ts lines 2112-2129)
// AnalysisResultResponse interface already exists at line 2105

export async function transitionAnalysis(
  uid: string,
  transition: 'submit' | 'verify' | 'retract' | 'reject'
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

### ALLOWED_TRANSITIONS constant

```typescript
// Source: SENAITE workflow documented in STATE.md
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  unassigned: ['submit'],
  to_be_verified: ['verify', 'retract', 'reject'],
  verified: ['retract'],
} as const

const TRANSITION_LABELS: Record<string, string> = {
  submit: 'Submit',
  verify: 'Verify',
  retract: 'Retract',
  reject: 'Reject',
}

const DESTRUCTIVE_TRANSITIONS = new Set(['retract', 'reject'])
```

### useAnalysisTransition hook skeleton

```typescript
// Source: mirrors use-analysis-editing.ts structure (verified codebase)
import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { transitionAnalysis } from '@/lib/api'

interface PendingConfirm {
  uid: string
  transition: string
  analysisTitle: string
}

interface UseAnalysisTransitionOptions {
  onTransitionComplete?: () => void
}

export function useAnalysisTransition({ onTransitionComplete }: UseAnalysisTransitionOptions) {
  const [pendingUids, setPendingUids] = useState<Set<string>>(new Set())
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)

  const setUidPending = useCallback((uid: string, pending: boolean) => {
    setPendingUids(prev => {
      const next = new Set(prev)
      if (pending) next.add(uid)
      else next.delete(uid)
      return next
    })
  }, [])

  const executeTransition = useCallback(async (uid: string, transition: string) => {
    setUidPending(uid, true)
    try {
      const response = await transitionAnalysis(uid, transition as 'submit' | 'verify' | 'retract' | 'reject')
      if (response.success) {
        toast.success(`${TRANSITION_LABELS[transition]} complete`)
        onTransitionComplete?.()
      } else {
        toast.error(`${TRANSITION_LABELS[transition]} failed`, { description: response.message })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      toast.error(`${TRANSITION_LABELS[transition]} failed`, { description: msg })
    } finally {
      setUidPending(uid, false)
    }
  }, [onTransitionComplete, setUidPending])

  const requestConfirm = useCallback((uid: string, transition: string, analysisTitle: string) => {
    setPendingConfirm({ uid, transition, analysisTitle })
  }, [])

  const cancelConfirm = useCallback(() => {
    setPendingConfirm(null)
  }, [])

  const confirmAndExecute = useCallback(async () => {
    if (!pendingConfirm) return
    const { uid, transition } = pendingConfirm
    setPendingConfirm(null)
    await executeTransition(uid, transition)
  }, [pendingConfirm, executeTransition])

  return { pendingUids, pendingConfirm, executeTransition, requestConfirm, cancelConfirm, confirmAndExecute }
}
```

### AnalysisRow action column (additions to AnalysisRow)

```typescript
// Source: DropdownMenu pattern from dropdown-menu.tsx (verified)
// Add to AnalysisRow props:
// transition: UseAnalysisTransitionReturn
// Add new <td> as last column:

const uid = analysis.uid ?? ''
const state = analysis.review_state ?? ''
const transitions = ALLOWED_TRANSITIONS[state] ?? []
const isPending = !!uid && transition.pendingUids.has(uid)

{/* Actions column */}
<td className="py-2.5 px-3">
  {transitions.length > 0 && uid ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          disabled={isPending}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label={`Actions for ${analysis.title}`}
        >
          {isPending
            ? <Spinner className="size-3.5" />
            : <MoreHorizontal size={14} className="text-muted-foreground" />
          }
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {transitions.map(t => (
          <DropdownMenuItem
            key={t}
            variant={DESTRUCTIVE_TRANSITIONS.has(t) ? 'destructive' : 'default'}
            disabled={isPending}
            onClick={() => {
              if (DESTRUCTIVE_TRANSITIONS.has(t)) {
                transition.requestConfirm(uid, t, analysis.title)
              } else {
                transition.executeTransition(uid, t)
              }
            }}
          >
            {TRANSITION_LABELS[t]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null}
</td>
```

### SampleDetails onTransitionComplete wiring

```typescript
// Source: SampleDetails.tsx onResultSaved pattern (lines 1052-1066)
// Add silentRefresh variant to avoid full-page loading flash:
const refreshSample = (id: string) => {
  // Does NOT set loading=true — keeps page visible during refresh
  lookupSenaiteSample(id)
    .then(result => setData(result))
    .catch(e => toast.error('Refresh failed', { description: e instanceof Error ? e.message : String(e) }))
}

// In AnalysisTable render:
<AnalysisTable
  analyses={analyses}
  analyteNameMap={analyteNameMap}
  onResultSaved={...}
  onTransitionComplete={() => refreshSample(data.sample_id)}
/>
```

## State of the Art

| Old Approach | Current Approach | Note |
|--------------|------------------|------|
| Inline transition trigger inside editing hook | Separate hook (useAnalysisTransition) | Separation of concerns — editing != transitioning |
| Global pending boolean | Per-row `Set<string>` | Each row independently lockable |
| Optimistic state update on transition | Full re-fetch post-transition | Transitions have sample-level side effects; re-fetch is safer |

## Open Questions

1. **Remarks Field Required for Retract/Reject**
   - What we know: STATE.md documents this as an explicit blocker: "manually test the retract transition against live SENAITE via Swagger UI. Confirm whether Remarks field is required."
   - What's unclear: Whether SENAITE silently skips the transition without Remarks, or returns an error. The EXPECTED_POST_STATES check in the backend would catch a silent skip.
   - Recommendation: The planner should make the Remarks investigation the first task of plan 07-02 (the transition execution plan). If Remarks are required, the AlertDialog needs a Textarea. Add a note to this effect in 07-02's plan before any dialog UI work begins.

2. **Header Column Width for Actions**
   - What we know: AnalysisTable currently has 8 columns (Analysis, Result, Retested, Method, Instrument, Analyst, Status, Captured). Adding an Actions column makes 9.
   - What's unclear: Whether the Actions column should be fixed-width and where in column order it belongs. Typically actions go last or first (leftmost).
   - Recommendation: Add as the rightmost column with a fixed narrow width (e.g., `w-10`). Consistent with most table action patterns.

3. **Submit Requires Result Check**
   - What we know: The submit transition is only available on `unassigned` analyses, and users set results via inline edit first. The backend EXPECTED_POST_STATES check will catch if SENAITE rejects a submit due to missing result.
   - What's unclear: Whether the frontend should validate that a result exists before showing the Submit menu item (to give earlier, friendlier feedback).
   - Recommendation: Show Submit in the menu regardless; the backend DATA-04 check provides the safety net. Avoids over-engineering the frontend guard logic. A toast with the backend error message is sufficient user feedback.

## Sources

### Primary (HIGH confidence)

- `backend/main.py` lines 5844-6020 — Verified: `AnalysisTransitionRequest`, `EXPECTED_POST_STATES`, `transition_analysis` endpoint, full request/response flow
- `src/components/senaite/AnalysisTable.tsx` — Verified: complete component structure, all props, `EDITABLE_STATES`, `AnalysisRow`, table column layout
- `src/hooks/use-analysis-editing.ts` — Verified: hook structure, `savePendingRef` pattern, `UseAnalysisEditingReturn` interface
- `src/lib/api.ts` — Verified: `setAnalysisResult`, `AnalysisResultResponse`, `lookupSenaiteSample`, `SenaiteLookupResult`
- `src/components/senaite/SampleDetails.tsx` — Verified: `fetchSample`, `onResultSaved` wiring, how `data` state drives counters and badges
- `src/components/ui/dropdown-menu.tsx` — Verified: all exports, `variant="destructive"` on `DropdownMenuItem`, Portal usage
- `src/components/ui/alert-dialog.tsx` — Verified: all exports, controlled mode via `open` prop
- `src/components/preferences/panes/AdvancedPane.tsx` — Verified: real usage pattern of AlertDialog with async action handler
- `.planning/STATE.md` — Verified: all project decisions, Remarks blocker, sequential transition requirement

### Secondary (MEDIUM confidence)

- Phase 06 VERIFICATION.md — Confirmed all Phase 06 artifacts exist and are wired correctly; line numbers match

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all components verified as installed and exported
- Architecture: HIGH — based on existing Phase 06 hook/component patterns directly
- API function shape: HIGH — backend endpoint and response type fully verified
- ALLOWED_TRANSITIONS values: HIGH — documented in STATE.md and verified against EXPECTED_POST_STATES in backend
- Pitfalls: HIGH — DOM nesting, silent rejection, stale closures are well-understood patterns; Remarks field is documented as an open blocker
- Remarks field requirement: LOW — must be manually tested; cannot be determined from code alone

**Research date:** 2026-02-25
**Valid until:** 2026-04-25 (stable — no external dependencies changing)
