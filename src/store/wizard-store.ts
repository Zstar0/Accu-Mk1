import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { WizardSessionResponse } from '@/lib/api'

// --- Types ---

export type StepId = 1 | 2 | 3 | 4 | 5
export type StepState = 'not-started' | 'in-progress' | 'complete' | 'locked'

export const WIZARD_STEPS: { id: StepId; label: string }[] = [
  { id: 1, label: 'Sample Info' },
  { id: 2, label: 'Stock Prep' },
  { id: 3, label: 'Dilution' },
  { id: 4, label: 'Results' },
  { id: 5, label: 'Summary' },
]

// --- Pure derivation function ---

/**
 * Derives the visual state for each wizard step based on session data and current position.
 * This is a pure function — no side effects, no store access.
 */
export function deriveStepStates(
  session: WizardSessionResponse | null,
  currentStep: StepId
): Record<StepId, StepState> {
  const calcs = session?.calculations ?? null

  // Step 1: in-progress if no session yet; complete if session exists
  const step1: StepState = (() => {
    if (currentStep === 1) return 'in-progress'
    if (session !== null) return 'complete'
    return 'not-started'
  })()

  // Step 2: locked if no session or target params missing; complete if stock_conc calculated
  const step2: StepState = (() => {
    if (
      session === null ||
      session.target_conc_ug_ml === null ||
      session.target_total_vol_ul === null
    ) {
      return currentStep === 2 ? 'in-progress' : 'locked'
    }
    if (currentStep === 2) return 'in-progress'
    if (calcs?.stock_conc_ug_ml != null) return 'complete'
    return 'locked'
  })()

  // Step 3: locked if no stock_conc calculation; complete if actual_conc calculated
  const step3: StepState = (() => {
    if (calcs?.stock_conc_ug_ml == null) {
      return currentStep === 3 ? 'in-progress' : 'locked'
    }
    if (currentStep === 3) return 'in-progress'
    if (calcs?.actual_conc_ug_ml != null) return 'complete'
    return 'locked'
  })()

  // Step 4: locked if no actual_conc calculation; complete if determined_conc calculated
  const step4: StepState = (() => {
    if (calcs?.actual_conc_ug_ml == null) {
      return currentStep === 4 ? 'in-progress' : 'locked'
    }
    if (currentStep === 4) return 'in-progress'
    if (calcs?.determined_conc_ug_ml != null) return 'complete'
    return 'locked'
  })()

  // Step 5: locked if no determined_conc; complete if session is 'completed'
  const step5: StepState = (() => {
    if (calcs?.determined_conc_ug_ml == null) {
      return currentStep === 5 ? 'in-progress' : 'locked'
    }
    if (currentStep === 5) return 'in-progress'
    if (session?.status === 'completed') return 'complete'
    return 'locked'
  })()

  return { 1: step1, 2: step2, 3: step3, 4: step4, 5: step5 }
}

// --- Store interface ---

interface WizardStoreState {
  // Session data
  session: WizardSessionResponse | null
  currentStep: StepId
  stepStates: Record<StepId, StepState>
  loading: boolean
  error: string | null

  // Actions
  startSession: (session: WizardSessionResponse) => void
  updateSession: (session: WizardSessionResponse) => void
  setCurrentStep: (step: StepId) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  resetWizard: () => void

  // Navigation helper
  canAdvance: () => boolean
}

// --- Store ---

export const useWizardStore = create<WizardStoreState>()(
  devtools(
    (set, get) => ({
      session: null,
      currentStep: 1,
      stepStates: deriveStepStates(null, 1),
      loading: false,
      error: null,

      startSession: session =>
        set(
          {
            session,
            stepStates: deriveStepStates(session, get().currentStep),
          },
          undefined,
          'startSession'
        ),

      updateSession: session =>
        set(
          {
            session,
            stepStates: deriveStepStates(session, get().currentStep),
          },
          undefined,
          'updateSession'
        ),

      setCurrentStep: step => {
        const states = deriveStepStates(get().session, step)
        // Allow navigation to any step that is not locked in the perspective of the
        // target step — but we check from the CURRENT states (before moving).
        // A step is navigable if it's not locked when viewed from the current position.
        const currentStates = get().stepStates
        if (currentStates[step] === 'locked') return
        set(
          {
            currentStep: step,
            stepStates: states,
          },
          undefined,
          'setCurrentStep'
        )
      },

      setLoading: loading =>
        set({ loading }, undefined, 'setLoading'),

      setError: error =>
        set({ error }, undefined, 'setError'),

      resetWizard: () =>
        set(
          {
            session: null,
            currentStep: 1,
            stepStates: deriveStepStates(null, 1),
            loading: false,
            error: null,
          },
          undefined,
          'resetWizard'
        ),

      canAdvance: () => {
        const { currentStep, stepStates } = get()
        if (currentStep === 5) return false
        const nextStep = (currentStep + 1) as StepId
        return stepStates[nextStep] !== 'locked'
      },
    }),
    {
      name: 'wizard-store',
    }
  )
)
