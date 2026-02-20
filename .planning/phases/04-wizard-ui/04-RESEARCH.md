# Phase 4: Wizard UI - Research

**Researched:** 2026-02-19
**Domain:** React wizard UI, Zustand state management, Tailwind CSS animation, shadcn/ui components, REST API integration
**Confidence:** HIGH — all findings verified directly against the live codebase

## Summary

Phase 4 replaces the `CreateAnalysis.tsx` placeholder ("Coming Soon") with a fully functional 5-step sample prep wizard. The backend REST API is complete from Phase 1, the WeightInput component is complete from Phase 3, and the navigation infrastructure (sidebar, section routing via ui-store) is already wired. The wizard needs a dedicated Zustand store (`PrepWizardStore`), a layout component (`WizardPage`) that implements the Stripe-style split-panel design, a step state machine, animated transitions, and 5 step components that call the existing API.

No new npm packages are required. The project already has `tw-animate-css` imported globally (for Tailwind v4 animation utilities), Zustand v5 (for the wizard store), shadcn/ui components including `Card`, `Button`, `Badge`, `Separator`, `ScrollArea`, and `Skeleton`, and `lucide-react` for step status icons. Animations are CSS transitions only — no external animation library needed.

The critical integration points are: (1) the wizard store holds `sessionId` and delegates step advancement to the backend (POST measurements, then fetch recalculated session), (2) `WeightInput` is dropped in as-is for every weighing sub-step, (3) `AnalysisHistory.tsx` already lists HPLC analyses but is a separate component — completed wizard sessions need their own list view or the existing history needs to surface wizard sessions too (SESS-04 requires this).

**Primary recommendation:** Implement `PrepWizardStore` in `src/store/wizard-store.ts` (separate from ui-store to keep concerns isolated), replace `CreateAnalysis.tsx` with the full wizard, and extend `AnalysisHistory` or add a wizard sessions list to surface SESS-04.

---

## Standard Stack

No new dependencies required. All libraries already installed.

### Core (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `zustand` | ^5.0.9 | Wizard step state store | Project standard; Zustand v5 already used for ui-store |
| `tailwindcss` | ^4.1.18 | Layout, step indicator styles, colors | Project standard |
| `tw-animate-css` | ^1.4.0 | `animate-in`, `fade-in`, `slide-in-from-left` CSS animation utilities | Already imported in App.css — no install needed |
| `lucide-react` | ^0.561.0 | Step state icons (Check, Lock, Circle, etc.) | Already used throughout codebase |
| `sonner` | ^2.0.7 | Toast notifications on success/error | Already installed; used for existing feedback |

### Supporting shadcn/ui Components (already available at `@/components/ui/`)
| Component | File | Purpose |
|-----------|------|---------|
| `Card`, `CardContent`, `CardHeader`, `CardTitle` | `card.tsx` | Step content panels |
| `Button` | `button.tsx` | Navigation controls (Next, Back, Accept) |
| `Badge` | `badge.tsx` | Step state labels, measurement source indicators |
| `Separator` | `separator.tsx` | Visual dividers in step content |
| `ScrollArea` | `scroll-area.tsx` | Step content scrolling |
| `Skeleton` | `skeleton.tsx` | Loading states during API calls |
| `Input`, `Label` | `input.tsx`, `label.tsx` | Manual entry fields (SMP-04 inputs) |
| `Alert`, `AlertDescription` | `alert.tsx` | Error feedback within steps |

### No New Packages Needed
```bash
# Nothing to install — all animation, UI, and state libraries already present
```

---

## Architecture Patterns

### Recommended File Structure
```
src/
├── store/
│   └── wizard-store.ts          # NEW: PrepWizardStore (Zustand)
├── components/hplc/
│   ├── CreateAnalysis.tsx        # REPLACE: full WizardPage layout
│   ├── wizard/
│   │   ├── WizardStepList.tsx    # NEW: vertical step sidebar
│   │   ├── WizardStepPanel.tsx   # NEW: animated content area wrapper
│   │   ├── steps/
│   │   │   ├── Step1SampleInfo.tsx   # NEW: sample ID, peptide, target params
│   │   │   ├── Step2StockPrep.tsx    # NEW: 4 weighing sub-steps + calcs
│   │   │   ├── Step3Dilution.tsx     # NEW: 3 weighing sub-steps
│   │   │   ├── Step4Results.tsx      # NEW: peak area entry
│   │   │   └── Step5Summary.tsx      # NEW: read-only summary
│   │   └── WizardSessionHistory.tsx  # NEW or extend AnalysisHistory for SESS-04
```

### Pattern 1: PrepWizardStore (Zustand v5, selector syntax)

**What:** Centralized store for wizard session state. Separate from `ui-store` because wizard state has many interdependent fields and should reset independently.
**When to use:** All wizard components read from this store. Navigation, step locking, sessionId, and measurement results live here.

```typescript
// src/store/wizard-store.ts
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type WizardStepId = 1 | 2 | 3 | 4 | 5

export type StepState = 'not-started' | 'in-progress' | 'complete' | 'locked'

export interface WizardSession {
  id: number
  status: string
  peptide_id: number
  sample_id_label: string | null
  declared_weight_mg: number | null
  target_conc_ug_ml: number | null
  target_total_vol_ul: number | null
  peak_area: number | null
  calculations: Record<string, number | null> | null
}

interface WizardState {
  sessionId: number | null
  session: WizardSession | null
  currentStep: WizardStepId
  loading: boolean
  error: string | null

  // Step state machine — derived from session.calculations and sessionId presence
  stepStates: Record<WizardStepId, StepState>

  // Actions
  startSession: (session: WizardSession) => void
  setCurrentStep: (step: WizardStepId) => void
  updateSession: (session: WizardSession) => void
  resetWizard: () => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

export const useWizardStore = create<WizardState>()(
  devtools(
    set => ({
      sessionId: null,
      session: null,
      currentStep: 1,
      loading: false,
      error: null,
      stepStates: {
        1: 'in-progress',
        2: 'locked',
        3: 'locked',
        4: 'locked',
        5: 'locked',
      },

      startSession: session =>
        set(
          {
            sessionId: session.id,
            session,
            currentStep: 1,
            stepStates: { 1: 'in-progress', 2: 'locked', 3: 'locked', 4: 'locked', 5: 'locked' },
          },
          undefined,
          'startSession'
        ),

      setCurrentStep: step =>
        set({ currentStep: step }, undefined, 'setCurrentStep'),

      updateSession: session =>
        set({ session, sessionId: session.id }, undefined, 'updateSession'),

      resetWizard: () =>
        set(
          {
            sessionId: null,
            session: null,
            currentStep: 1,
            loading: false,
            error: null,
            stepStates: { 1: 'in-progress', 2: 'locked', 3: 'locked', 4: 'locked', 5: 'locked' },
          },
          undefined,
          'resetWizard'
        ),

      setLoading: loading => set({ loading }, undefined, 'setLoading'),
      setError: error => set({ error }, undefined, 'setError'),
    }),
    { name: 'wizard-store' }
  )
)
```

**CRITICAL — Zustand v5 selector syntax required (ast-grep enforced):**
```typescript
// ✅ CORRECT
const sessionId = useWizardStore(state => state.sessionId)
const currentStep = useWizardStore(state => state.currentStep)

// ❌ WRONG — caught by ast-grep, causes render cascades
const { sessionId, currentStep } = useWizardStore()
```

### Pattern 2: Step State Machine

**What:** Step states are derived from what measurements exist in the session. The store computes `stepStates` whenever `session` updates.

**Step unlock conditions:**
| Step | Unlocks When |
|------|-------------|
| Step 1 (Sample Info) | Always `in-progress` at start |
| Step 2 (Stock Prep) | Step 1 complete: `session.target_conc_ug_ml != null` AND `session.target_total_vol_ul != null` AND `session.peptide_id` set |
| Step 3 (Dilution) | Step 2 complete: `calculations.stock_conc_ug_ml != null` (all 2 stock weighings done) |
| Step 4 (Results Entry) | Step 3 complete: `calculations.actual_conc_ug_ml != null` (all 3 dilution weighings done) |
| Step 5 (Summary) | Step 4 complete: `session.peak_area != null` AND `calculations.determined_conc_ug_ml != null` |

**Implementation:** Derive step states in a pure function called whenever `updateSession()` is called:

```typescript
function deriveStepStates(
  session: WizardSession | null,
  currentStep: WizardStepId
): Record<WizardStepId, StepState> {
  if (!session) {
    return { 1: 'in-progress', 2: 'locked', 3: 'locked', 4: 'locked', 5: 'locked' }
  }

  const calcs = session.calculations ?? {}
  const step1Done = session.target_conc_ug_ml != null && session.target_total_vol_ul != null
  const step2Done = calcs.stock_conc_ug_ml != null
  const step3Done = calcs.actual_conc_ug_ml != null
  const step4Done = calcs.determined_conc_ug_ml != null

  const stateFor = (stepDone: boolean, prevDone: boolean, stepId: WizardStepId): StepState => {
    if (stepDone) return 'complete'
    if (prevDone && currentStep === stepId) return 'in-progress'
    if (prevDone) return 'not-started'
    return 'locked'
  }

  return {
    1: step1Done ? 'complete' : 'in-progress',
    2: stateFor(step2Done, step1Done, 2),
    3: stateFor(step3Done, step2Done, 3),
    4: stateFor(step4Done, step3Done, 4),
    5: stateFor(session.status === 'completed', step4Done, 5),
  }
}
```

### Pattern 3: WizardPage Layout (Stripe-style split panel)

**What:** Left sidebar (step list ~250px wide) + right content panel (flex-1). Both regions use `ScrollArea` to handle overflow independently.

```typescript
// src/components/hplc/CreateAnalysis.tsx
export function CreateAnalysis() {
  const sessionId = useWizardStore(state => state.sessionId)

  // Before session started: show session-start form
  if (!sessionId) return <WizardStartForm />

  return (
    <div className="flex h-full">
      {/* Left: Step list sidebar */}
      <div className="w-64 shrink-0 border-r border-border">
        <WizardStepList />
      </div>

      {/* Right: Animated step content */}
      <div className="flex-1 overflow-hidden">
        <WizardStepPanel />
      </div>
    </div>
  )
}
```

### Pattern 4: Animated Step Transitions (tw-animate-css)

**What:** Step content slides in from the right when advancing, from the left when going back. Uses CSS classes from `tw-animate-css` which is already imported in `App.css`.

**Available tw-animate-css classes (HIGH confidence — library already imported):**
- `animate-in` — base class that enables entry animations
- `fade-in` — opacity 0 → 1
- `slide-in-from-right-4` — slides in from the right 1rem
- `slide-in-from-left-4` — slides in from the left 1rem
- `duration-200` / `duration-300` — Tailwind transition timing

```typescript
// WizardStepPanel.tsx — key prop forces remount on step change, triggering animation
function WizardStepPanel() {
  const currentStep = useWizardStore(state => state.currentStep)
  const direction = useRef<'forward' | 'back'>('forward')

  const animationClass = direction.current === 'forward'
    ? 'animate-in slide-in-from-right-4 fade-in duration-200'
    : 'animate-in slide-in-from-left-4 fade-in duration-200'

  return (
    <ScrollArea className="h-full">
      <div key={currentStep} className={`p-6 ${animationClass}`}>
        {currentStep === 1 && <Step1SampleInfo />}
        {currentStep === 2 && <Step2StockPrep />}
        {currentStep === 3 && <Step3Dilution />}
        {currentStep === 4 && <Step4Results />}
        {currentStep === 5 && <Step5Summary />}
      </div>
    </ScrollArea>
  )
}
```

**Key insight:** `key={currentStep}` on the wrapper div causes React to unmount/remount the content on step change, which restarts the CSS animation. This is the simplest correct approach — no external animation library needed.

### Pattern 5: API Calls (fetch, not TanStack Query)

**What:** The existing codebase uses raw `fetch` with `getBearerHeaders()` via `getApiBaseUrl()` for all API calls. TanStack Query is installed but not used in the hplc components. Follow the existing pattern for wizard API calls.

```typescript
// src/lib/api.ts — ADD these wizard API helpers (follows existing pattern)
import { getApiBaseUrl } from './config'
import { getAuthToken } from '@/store/auth-store'

function getBearerHeaders(contentType?: string): HeadersInit {
  // already in api.ts — reuse existing function
}

export interface WizardSessionCreate {
  peptide_id: number
  sample_id_label: string | null
  declared_weight_mg: number | null
  target_conc_ug_ml: number
  target_total_vol_ul: number
}

export interface WizardSessionResponse {
  id: number
  status: string
  peptide_id: number
  sample_id_label: string | null
  declared_weight_mg: number | null
  target_conc_ug_ml: number | null
  target_total_vol_ul: number | null
  peak_area: number | null
  calculations: Record<string, number | null> | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export async function createWizardSession(
  data: WizardSessionCreate
): Promise<WizardSessionResponse> {
  const response = await fetch(`${getApiBaseUrl()}/wizard/sessions`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail ?? `Create session failed: ${response.status}`)
  }
  return response.json()
}

export async function getWizardSession(id: number): Promise<WizardSessionResponse> {
  const response = await fetch(`${getApiBaseUrl()}/wizard/sessions/${id}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Get session failed: ${response.status}`)
  return response.json()
}

export async function recordWizardMeasurement(
  sessionId: number,
  stepKey: string,
  weightMg: number,
  source: 'scale' | 'manual'
): Promise<WizardSessionResponse> {
  const response = await fetch(`${getApiBaseUrl()}/wizard/sessions/${sessionId}/measurements`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ step_key: stepKey, weight_mg: weightMg, source }),
  })
  if (!response.ok) throw new Error(`Record measurement failed: ${response.status}`)
  return response.json()
}

export async function updateWizardSession(
  id: number,
  data: Partial<WizardSessionCreate>
): Promise<WizardSessionResponse> {
  const response = await fetch(`${getApiBaseUrl()}/wizard/sessions/${id}`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Update session failed: ${response.status}`)
  return response.json()
}

export async function completeWizardSession(id: number): Promise<WizardSessionResponse> {
  const response = await fetch(`${getApiBaseUrl()}/wizard/sessions/${id}/complete`, {
    method: 'POST',
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Complete session failed: ${response.status}`)
  return response.json()
}

export async function listWizardSessions(
  limit = 20,
  offset = 0
): Promise<{ items: WizardSessionResponse[]; total: number }> {
  const response = await fetch(
    `${getApiBaseUrl()}/wizard/sessions?limit=${limit}&offset=${offset}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`List sessions failed: ${response.status}`)
  return response.json()
}
```

### Pattern 6: WeightInput Integration

**What:** `WeightInput` is already complete. Drop it in for every weighing sub-step. The `onAccept` callback posts the measurement to the backend, then refreshes the session.

```typescript
// Inside Step2StockPrep.tsx — one WeightInput per weighing sub-step
import { WeightInput } from '@/components/hplc/WeightInput'

function Step2StockPrep() {
  const sessionId = useWizardStore(state => state.sessionId)
  const updateSession = useWizardStore(state => state.updateSession)
  const session = useWizardStore(state => state.session)

  const calcs = session?.calculations ?? {}
  const stockConc = calcs.stock_conc_ug_ml  // null until both stock weights recorded

  async function handleWeightAccepted(
    stepKey: string,
    value: number,
    source: 'scale' | 'manual'
  ) {
    if (!sessionId) return
    const updated = await recordWizardMeasurement(sessionId, stepKey, value, source)
    updateSession(updated)  // triggers step state recalculation
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Sub-step STK-01: Weigh empty stock vial */}
      <WeightInput
        stepKey="stock_vial_empty_mg"
        label="Empty vial + cap weight"
        onAccept={(value, source) =>
          handleWeightAccepted('stock_vial_empty_mg', value, source)
        }
      />

      {/* STK-02: Tech transfers peptide (confirmation only — no weight) */}
      <PeptideTransferConfirmation />

      {/* STK-03: Calculated diluent volume displayed inline */}
      {calcs.required_diluent_vol_ul != null && (
        <Card className="border-blue-500/50 bg-blue-500/5">
          <CardContent className="pt-4">
            <p className="text-sm font-medium">Add diluent volume:</p>
            <p className="font-mono text-2xl">
              {calcs.required_diluent_vol_ul.toFixed(1)} µL
            </p>
          </CardContent>
        </Card>
      )}

      {/* STK-04: Weigh loaded stock vial */}
      <WeightInput
        stepKey="stock_vial_loaded_mg"
        label="Vial + cap + diluent weight (after adding diluent)"
        onAccept={(value, source) =>
          handleWeightAccepted('stock_vial_loaded_mg', value, source)
        }
      />

      {/* Stock concentration result, shown inline */}
      {stockConc != null && (
        <div className="rounded-md bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">Stock concentration</p>
          <p className="font-mono text-lg">{stockConc.toFixed(2)} µg/mL</p>
        </div>
      )}
    </div>
  )
}
```

### Pattern 7: WizardStepList (vertical sidebar)

**What:** Renders 5 step entries, each with an icon showing its state and a label. Clicking a completed step navigates back (WIZ-04). Locked steps are not clickable.

```typescript
const STEP_LABELS: Record<WizardStepId, string> = {
  1: 'Sample Info',
  2: 'Stock Prep',
  3: 'Dilution',
  4: 'Results Entry',
  5: 'Summary',
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'complete') return <CheckCircle2 className="h-5 w-5 text-green-500" />
  if (state === 'in-progress') return <Circle className="h-5 w-5 text-primary fill-primary/20" />
  if (state === 'locked') return <Lock className="h-5 w-5 text-muted-foreground/40" />
  return <Circle className="h-5 w-5 text-muted-foreground" />  // not-started
}

function WizardStepList() {
  const currentStep = useWizardStore(state => state.currentStep)
  const stepStates = useWizardStore(state => state.stepStates)
  const setCurrentStep = useWizardStore(state => state.setCurrentStep)

  return (
    <div className="flex flex-col gap-1 p-4">
      {([1, 2, 3, 4, 5] as WizardStepId[]).map(stepId => {
        const state = stepStates[stepId]
        const isClickable = state === 'complete' || state === 'in-progress' || state === 'not-started'
        const isActive = currentStep === stepId

        return (
          <button
            key={stepId}
            type="button"
            disabled={state === 'locked'}
            onClick={() => isClickable && setCurrentStep(stepId)}
            className={[
              'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
              isActive
                ? 'bg-primary/10 text-primary font-medium'
                : state === 'locked'
                ? 'text-muted-foreground/40 cursor-not-allowed'
                : 'hover:bg-muted/50 cursor-pointer',
            ].join(' ')}
          >
            <StepIcon state={state} />
            <span>{STEP_LABELS[stepId]}</span>
          </button>
        )
      })}
    </div>
  )
}
```

### Pattern 8: SESS-04 — Wizard Sessions in Analysis History

**What:** Completed wizard sessions must appear in Analysis History. The existing `AnalysisHistory.tsx` uses `getHPLCAnalyses()` which is separate from wizard sessions. Two implementation options:

**Option A (recommended):** Add a `WizardSessionHistory` tab within the `analysis-history` subsection. The existing `AnalysisHistory` stays for HPLC import analyses; a new tab surfaces wizard sessions.

**Option B:** Extend `AnalysisHistory.tsx` with a toggled view for wizard sessions.

**Research finding:** The `HPLCAnalysis.tsx` switch already handles subsection routing. Adding a tab to the `AnalysisHistory` component (with `Tabs`/`TabsList` shadcn components) is cleaner than adding another subsection to ui-store. This avoids adding a new `ActiveSubSection` type.

### Anti-Patterns to Avoid

- **Zustand destructuring:** `const { sessionId } = useWizardStore()` — caught by ast-grep linter. Always use selector syntax.
- **Manual useMemo/useCallback:** React Compiler handles memoization automatically. Do not add manual memo.
- **Storing derived step states in multiple places:** Derive step states in a single `deriveStepStates()` pure function called from `updateSession`. Never compute step states in components.
- **Step state in ui-store:** Wizard step state is local to the wizard feature and resets when the wizard is closed. It does not belong in `ui-store.ts`.
- **Fetching session in every child component:** Fetch in the parent (`WizardStepPanel`) and pass down via store. Children read from `useWizardStore`.
- **React Router or URL-based routing for wizard steps:** This app uses section/subsection routing via `ui-store`. The wizard step state lives in `wizard-store`, not the URL.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Step transition animation | Custom `framer-motion` or `react-spring` setup | `tw-animate-css` classes (`animate-in`, `slide-in-from-*`) | Already imported in App.css; zero setup |
| Weight input UI | Custom scale stream consumer | `WeightInput` from `src/components/hplc/WeightInput.tsx` | Already built in Phase 3 with dual-mode, SSE, stability detection |
| Step indicator icons | Custom SVG icons | `lucide-react` (`CheckCircle2`, `Circle`, `Lock`, `ArrowRight`) | Already installed |
| Form validation feedback | Custom error component | `Alert` / `AlertDescription` from shadcn | Already in `@/components/ui/alert` |
| Loading states | Custom spinner | `Skeleton` or `Loader2` with `animate-spin` | Both used throughout codebase |
| Scrollable content | `overflow-auto` div | `ScrollArea` from `@/components/ui/scroll-area` | Matches existing patterns, provides consistent scrollbar styling |
| Notification on complete | Custom modal/toast | `sonner` via `toast()` | Already installed and configured |
| Auth headers | Custom header construction | `getBearerHeaders()` in `src/lib/api.ts` | Reuse existing helper — do not duplicate |

**Key insight:** Every UI primitive needed by the wizard already exists in this codebase. The work is wiring them together correctly with proper state management, not building new primitives.

---

## Common Pitfalls

### Pitfall 1: Zustand Destructuring (ast-grep enforced)

**What goes wrong:** `const { sessionId, currentStep } = useWizardStore()` causes the component to re-render on ANY store change, not just the values it cares about. The project's ast-grep rules catch this and fail `npm run check:all`.

**Why it happens:** Zustand v5 with selector syntax is required project-wide. Destructuring is an easy habit from other patterns.

**How to avoid:** Always write individual selectors: `const sessionId = useWizardStore(state => state.sessionId)`.

**Warning signs:** `npm run ast:lint` fails with "Zustand destructuring detected".

### Pitfall 2: Step State Racing — Stale Calculations After Measurement Post

**What goes wrong:** Tech accepts a weight. Component posts the measurement. The response comes back with updated session including new `calculations`. But the component reads stale state from the store because `updateSession()` wasn't called.

**Why it happens:** Forgetting to call `updateSession(response)` after a POST to `/wizard/sessions/{id}/measurements`. The endpoint returns the full updated session with recalculated values.

**How to avoid:** Always call `updateSession(response)` immediately after any successful API call that modifies the session. The POST measurements endpoint returns the full updated session — use it.

**Warning signs:** Calculated values (stock concentration, required volumes) don't update after tech accepts a weight.

### Pitfall 3: Step Advancement Without All Required Data

**What goes wrong:** Tech advances to Step 2 before peptide is selected. The Step 2 UI calls `POST /wizard/sessions` which returns 400 if no active calibration curve.

**Why it happens:** The "Next" button enables before all required fields are filled.

**How to avoid:** "Next" button is disabled until all required fields for the current step are filled. For Step 1: `peptide_id` selected, `target_conc_ug_ml > 0`, `target_total_vol_ul > 0`, `declared_weight_mg > 0`. Validate in the component before creating/advancing the session.

**Warning signs:** HTTP 400 from backend with "No active calibration curve for this peptide".

### Pitfall 4: WeightInput Remount on Step Transition

**What goes wrong:** Using `key={currentStep}` on the step panel wrapper causes ALL children to remount, including `WeightInput`. If the tech has already started reading a weight and navigates away and back, the scale stream is reset.

**Why it happens:** The `key` prop forces React to unmount and remount the entire subtree.

**How to avoid:** `WeightInput` unmounting when navigating away is actually correct behavior — it stops the SSE stream and clears the reading. The tech should re-initiate the scale read when they return to a step. This is the expected UX. Document this in the Summary step to prevent confusion.

**Warning signs:** Tech complains that scale readings are lost when navigating between steps.

### Pitfall 5: SESS-04 — Wizard Sessions Not Appearing in History

**What goes wrong:** The existing `AnalysisHistory` component uses `getHPLCAnalyses()` which fetches from `/hplc/analyses` — a completely separate table from `wizard_sessions`. Completed wizard sessions have no path to the history view.

**Why it happens:** Two separate backend tables, two separate list endpoints (`GET /wizard/sessions` vs `GET /hplc/analyses`).

**How to avoid:** Add a `WizardSessionHistory` view that calls `GET /wizard/sessions?status=completed`. Wire it to be visible in the `analysis-history` subsection (as a tab or secondary list).

**Warning signs:** SESS-04 acceptance criterion "Completed sessions appear in Analysis History" fails during verification.

### Pitfall 6: `getBearerHeaders` Not Exported from api.ts

**What goes wrong:** The `getBearerHeaders()` function in `src/lib/api.ts` is currently a module-private function (not exported). New wizard API functions added to `api.ts` can use it directly, but if wizard API is in a separate file, it won't be accessible.

**How to avoid:** Add all wizard API functions to `src/lib/api.ts` alongside the existing HPLC API functions. Do not create a separate `wizard-api.ts` file — follow the existing single-file pattern.

**Warning signs:** TypeScript error "getBearerHeaders is not exported" if wizard API is extracted to its own module.

### Pitfall 7: STK-02 (Peptide Transfer) Has No Weight

**What goes wrong:** STK-02 says "tech transfers peptide; confirms when done." There is no weight measurement for this sub-step — it's a confirmation checkbox/button. Building a `WeightInput` for it would be wrong.

**How to avoid:** STK-02 is a simple confirmation UI element (checkbox or button: "I have transferred the peptide"). No WeightInput, no API call. The presence of the next WeightInput (STK-03/04) implicitly confirms this step.

**Warning signs:** Attempting to POST a measurement for a nonexistent `step_key` like `peptide_transfer_confirmed`.

---

## Code Examples

### WizardPage Layout (full structure)

```typescript
// src/components/hplc/CreateAnalysis.tsx
import { useWizardStore } from '@/store/wizard-store'
import { WizardStepList } from './wizard/WizardStepList'
import { WizardStepPanel } from './wizard/WizardStepPanel'
import { WizardStartForm } from './wizard/WizardStartForm'

export function CreateAnalysis() {
  const sessionId = useWizardStore(state => state.sessionId)

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col gap-6 p-6">
        <WizardStartForm />
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-60 shrink-0 border-r border-border overflow-y-auto">
        <WizardStepList />
      </div>
      <div className="flex-1 overflow-hidden">
        <WizardStepPanel />
      </div>
    </div>
  )
}
```

### Step 1: WizardStartForm — creates session on form submit

```typescript
// src/components/hplc/wizard/WizardStartForm.tsx
// Collects: peptide_id, sample_id_label, declared_weight_mg,
//           target_conc_ug_ml, target_total_vol_ul
// On submit: POST /wizard/sessions → startSession(response)
```

### Step 5: Summary — read-only with all measurements and results

```typescript
// src/components/hplc/wizard/steps/Step5Summary.tsx
// Reads session + calculations from wizard-store
// Displays: all 5 weights, all calculated values, HPLC result
// Complete button: POST /wizard/sessions/{id}/complete
// After complete: navigate to analysis-history, resetWizard()
```

---

## Navigation Integration

### AppSidebar Changes Needed

The `AppSidebar.tsx` currently has `{ id: 'new-analysis', label: 'New Analysis' }` in the HPLC Analysis sub-items. This already routes to `CreateAnalysis.tsx` via `HPLCAnalysis.tsx`. **No AppSidebar changes are required** — the routing is already wired.

### HPLCAnalysis.tsx — No Changes Required

The switch statement already handles `case 'new-analysis': return <CreateAnalysis />`. Phase 4 replaces only the contents of `CreateAnalysis.tsx`, not the routing infrastructure.

### ui-store.ts — Minimal Changes

No new `ActiveSubSection` types needed unless the wizard sessions history needs its own subsection. The recommended approach (tabs within `analysis-history`) avoids any ui-store changes.

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `framer-motion` for animations | `tw-animate-css` + CSS `key` remount trick | Zero new dependency; already imported |
| React Router for wizard step routing | Zustand store for step state | Consistent with project's section/subsection pattern |
| Manual `useMemo`/`useCallback` | React Compiler (babel-plugin-react-compiler) | No manual memoization needed |
| Separate animation state | `key` prop on step wrapper forces CSS animation restart | Simpler, no animation state to manage |

**Available but not needed:**
- `framer-motion` — not installed; don't add it when `tw-animate-css` suffices
- `react-spring` — not installed; same reasoning
- React Router — not installed and project doesn't use URL routing

---

## Open Questions

1. **SESS-04: Wizard history placement**
   - What we know: Completed wizard sessions need to appear in Analysis History (SESS-04). The existing `AnalysisHistory` shows HPLC import analyses.
   - What's unclear: Should wizard sessions show as a tab within `analysis-history` view, or should a new `ActiveSubSection` ('wizard-history') be added to ui-store?
   - Recommendation: Add a `Tabs` component to the `AnalysisHistory` page with "HPLC Import" and "Sample Prep Wizard" tabs. Avoids ui-store changes. Clean separation.

2. **Step 1 session creation timing**
   - What we know: `POST /wizard/sessions` returns 400 if no active calibration curve exists for the peptide.
   - What's unclear: Should the wizard create the session when the form is submitted (one API call on "Start"), or when navigating from Step 1 to Step 2?
   - Recommendation: Create session on Step 1 form submission (the "Start" action). This gives the tech immediate feedback if their peptide has no active calibration. The wizard then loads with the created session ID.

3. **Back-navigation and re-weighing**
   - What we know: Tech can navigate back to review completed steps (WIZ-04). Re-weighing inserts a new measurement record and sets old as `is_current=False`.
   - What's unclear: Should completed step content be read-only when navigated back to, or should the tech be able to re-initiate a WeightInput?
   - Recommendation: Allow re-weighing on completed steps. The re-weigh POST to measurements endpoint handles the audit trail correctly. Show the accepted weight with an "Re-weigh" button that shows the WeightInput again.

---

## Sources

### Primary (HIGH confidence)
- `src/store/ui-store.ts` — Zustand v5 store pattern with devtools middleware; selector syntax; action naming
- `src/components/hplc/WeightInput.tsx` — Complete WeightInput component; props interface; onAccept signature
- `src/components/hplc/AnalysisHistory.tsx` — History list pattern with pagination, detail view, fetch pattern
- `src/components/hplc/NewAnalysis.tsx` — Multi-step wizard pattern (StepDot component, step state via useState)
- `src/components/hplc/CreateAnalysis.tsx` — Current placeholder to be replaced
- `src/components/layout/AppSidebar.tsx` — Navigation wiring; 'new-analysis' already routes to CreateAnalysis
- `src/components/hplc/HPLCAnalysis.tsx` — Switch-based subsection routing
- `src/lib/api.ts` — API client pattern; getBearerHeaders; fetch pattern
- `src/lib/scale-stream.ts` — SSE hook pattern (used by WeightInput)
- `src/App.css` — `tw-animate-css` already imported globally
- `package.json` — Confirms: zustand ^5.0.9, tw-animate-css ^1.4.0, lucide-react ^0.561.0, sonner ^2.0.7
- `.planning/phases/01-wizard-db/01-01-SUMMARY.md` — Confirmed: all 6 wizard REST endpoints implemented and live
- `.planning/phases/01-wizard-db/01-02-SUMMARY.md` — Confirmed: calculation engine in backend/calculations/wizard.py

### Secondary (MEDIUM confidence)
- `.planning/phases/01-wizard-db/01-RESEARCH.md` — step_key values confirmed: stock_vial_empty_mg, stock_vial_loaded_mg, dil_vial_empty_mg, dil_vial_with_diluent_mg, dil_vial_final_mg

### Tertiary (LOW confidence)
- None — all claims are codebase-verified

---

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — all packages confirmed in package.json
- Architecture Patterns: HIGH — directly derived from existing component patterns in codebase
- Step State Machine: HIGH — step_key values and calculation outputs confirmed from Phase 1 summaries
- Animation approach: HIGH — tw-animate-css confirmed in App.css import, key-based remount is React fundamental
- API integration: HIGH — endpoint signatures confirmed from Phase 1 implementation summaries
- SESS-04 (History): MEDIUM — approach recommended; exact tab structure is a design decision

**Research date:** 2026-02-19
**Valid until:** 2026-04-19 (stable stack — 60 days)
