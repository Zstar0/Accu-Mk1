import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { WizardSessionResponse, SenaiteLookupResult, ComponentBrief, PeptideRecord } from '@/lib/api'

// --- Types ---

export type StepId = number
export type StepState = 'not-started' | 'in-progress' | 'complete' | 'locked'
export type StepType = 'sample-info' | 'stock-prep' | 'dilution'

export interface WizardStep {
  id: StepId
  type: StepType
  label: string
  vialNumber: number
}

// --- Dynamic step builder ---

/**
 * Builds the wizard step list based on vial count.
 * Single-vial: [Sample Info, Stock Prep, Dilution]
 * Multi-vial:  [Sample Info, Stock Prep V1, Dilution V1, Stock Prep V2, Dilution V2, ...]
 */
export function buildWizardSteps(vialCount: number): WizardStep[] {
  const steps: WizardStep[] = [
    { id: 1, type: 'sample-info', label: 'Sample Info', vialNumber: 1 },
  ]
  let id = 2
  for (let v = 1; v <= vialCount; v++) {
    const suffix = vialCount > 1 ? ` — Vial ${v}` : ''
    steps.push({ id: id++, type: 'stock-prep', label: `Stock Prep${suffix}`, vialNumber: v })
    steps.push({ id: id++, type: 'dilution', label: `Dilution${suffix}`, vialNumber: v })
  }
  return steps
}

// --- Pure derivation function ---

/** Check if a vial has a current measurement for the given step_key */
function vialHasMeasurement(
  session: WizardSessionResponse,
  key: string,
  vialNumber: number,
): boolean {
  return session.measurements?.some(
    m => m.step_key === key && m.is_current && m.vial_number === vialNumber
  ) ?? false
}

/**
 * Check if a step's data prerequisites are met, independent of display state.
 * This avoids the bug where currentStep='in-progress' breaks the prevComplete chain.
 */
function isStepDataComplete(
  session: WizardSessionResponse | null,
  step: WizardStep,
): boolean {
  if (!session) return false
  const v = step.vialNumber
  const calcs = v === 1
    ? session.calculations
    : session.vial_calculations?.[String(v)] ?? null

  switch (step.type) {
    case 'sample-info':
      return session !== null
    case 'stock-prep':
      return calcs?.stock_conc_ug_ml != null
    case 'dilution':
      return calcs?.actual_conc_ug_ml != null
  }
}

/**
 * Check if a step is unlocked — its prerequisites from session data are satisfied.
 */
function isStepUnlocked(
  session: WizardSessionResponse | null,
  step: WizardStep,
  steps: WizardStep[],
): boolean {
  const idx = steps.indexOf(step)
  if (idx === 0) return true // first step always unlocked

  const prevStep = steps[idx - 1] as WizardStep

  switch (step.type) {
    case 'stock-prep': {
      // Need session with target params
      if (
        !session ||
        session.target_conc_ug_ml === null ||
        session.target_total_vol_ul === null
      ) return false
      // For vial 1: just need session (sample-info done)
      // For vial N>1: previous vial's dilution must be complete
      if (step.vialNumber === 1) return session !== null
      return isStepDataComplete(session, prevStep)
    }

    case 'dilution': {
      if (!session) return false
      // Need this vial's stock prep measurements
      const v = step.vialNumber
      return (
        vialHasMeasurement(session, 'stock_vial_empty_mg', v) &&
        vialHasMeasurement(session, 'stock_vial_loaded_mg', v)
      )
    }

    default:
      return true
  }
}

/**
 * Derives the visual state for each wizard step based on session data and current position.
 * Steps are dynamic — their count depends on vial_params.
 */
export function deriveStepStates(
  session: WizardSessionResponse | null,
  currentStep: StepId,
  steps: WizardStep[],
): Record<StepId, StepState> {
  const result: Record<StepId, StepState> = {}

  for (const step of steps) {
    const unlocked = isStepUnlocked(session, step, steps)
    const dataComplete = isStepDataComplete(session, step)

    if (currentStep === step.id) {
      result[step.id] = 'in-progress'
    } else if (!unlocked) {
      result[step.id] = 'locked'
    } else if (dataComplete) {
      result[step.id] = 'complete'
    } else {
      result[step.id] = 'not-started'
    }
  }

  return result
}

// --- Store interface ---

interface WizardStoreState {
  // Session data
  session: WizardSessionResponse | null
  currentStep: StepId
  wizardSteps: WizardStep[]
  stepStates: Record<StepId, StepState>
  loading: boolean
  error: string | null

  // SENAITE lookup result — persisted so it can be shown on all steps
  senaiteResult: SenaiteLookupResult | null

  // Blend component → vial mapping (for display in step list)
  blendComponents: ComponentBrief[]

  // Selected peptide record — for displaying method info in the info panel
  selectedPeptide: PeptideRecord | null

  // Actions
  startSession: (session: WizardSessionResponse, components?: ComponentBrief[], peptide?: PeptideRecord) => void
  updateSession: (session: WizardSessionResponse) => void
  setCurrentStep: (step: StepId) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setSenaiteResult: (result: SenaiteLookupResult | null) => void
  setBlendComponents: (components: ComponentBrief[]) => void
  setSelectedPeptide: (peptide: PeptideRecord | null) => void
  resetWizard: () => void
  /** Rebuild step list when vial count is known (called from Step1 on session create) */
  setVialCount: (count: number) => void

  // Navigation helper
  canAdvance: () => boolean
}

const DEFAULT_STEPS = buildWizardSteps(1)

// --- Store ---

export const useWizardStore = create<WizardStoreState>()(
  devtools(
    (set, get) => ({
      session: null,
      currentStep: 1 as StepId,
      wizardSteps: DEFAULT_STEPS,
      stepStates: deriveStepStates(null, 1, DEFAULT_STEPS),
      loading: false,
      error: null,
      senaiteResult: null,
      blendComponents: [],
      selectedPeptide: null,

      startSession: (session, components, peptide) => {
        const vialCount = session.vial_params
          ? Object.keys(session.vial_params).length
          : 1
        const steps = buildWizardSteps(vialCount)
        set(
          {
            session,
            wizardSteps: steps,
            stepStates: deriveStepStates(session, get().currentStep, steps),
            blendComponents: components ?? [],
            selectedPeptide: peptide ?? null,
          },
          undefined,
          'startSession'
        )
      },

      updateSession: session => {
        const steps = get().wizardSteps
        set(
          {
            session,
            stepStates: deriveStepStates(session, get().currentStep, steps),
          },
          undefined,
          'updateSession'
        )
      },

      setCurrentStep: step => {
        const steps = get().wizardSteps
        const states = deriveStepStates(get().session, step, steps)
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

      setSenaiteResult: result =>
        set({ senaiteResult: result }, undefined, 'setSenaiteResult'),

      setBlendComponents: components =>
        set({ blendComponents: components }, undefined, 'setBlendComponents'),

      setSelectedPeptide: peptide =>
        set({ selectedPeptide: peptide }, undefined, 'setSelectedPeptide'),

      resetWizard: () =>
        set(
          {
            session: null,
            currentStep: 1 as StepId,
            wizardSteps: DEFAULT_STEPS,
            stepStates: deriveStepStates(null, 1, DEFAULT_STEPS),
            loading: false,
            error: null,
            senaiteResult: null,
            blendComponents: [],
            selectedPeptide: null,
          },
          undefined,
          'resetWizard'
        ),

      setVialCount: (count: number) => {
        const steps = buildWizardSteps(count)
        const { session, currentStep } = get()
        set(
          {
            wizardSteps: steps,
            stepStates: deriveStepStates(session, currentStep, steps),
          },
          undefined,
          'setVialCount'
        )
      },

      canAdvance: () => {
        const { currentStep, stepStates, wizardSteps } = get()
        const currentIdx = wizardSteps.findIndex(s => s.id === currentStep)
        const lastStep = wizardSteps[wizardSteps.length - 1]
        if (!lastStep || currentStep === lastStep.id) return false
        const nextStep = wizardSteps[currentIdx + 1]
        if (!nextStep) return false
        return stepStates[nextStep.id] !== 'locked'
      },
    }),
    {
      name: 'wizard-store',
    }
  )
)
