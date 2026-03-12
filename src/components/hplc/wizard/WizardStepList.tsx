import { Check, Lock } from 'lucide-react'
import { useWizardStore, type StepId, type StepState } from '@/store/wizard-store'
import { cn } from '@/lib/utils'

function StepDot({ state, number }: { state: StepState; number: number }) {
  const base = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors'

  if (state === 'complete') {
    return (
      <span className={cn(base, 'bg-green-500 text-white')}>
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    )
  }
  if (state === 'in-progress') {
    return (
      <span className={cn(base, 'bg-primary text-primary-foreground ring-2 ring-primary/25 ring-offset-1 ring-offset-background')}>
        {number}
      </span>
    )
  }
  if (state === 'locked') {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground/50')}>
        <Lock className="h-2.5 w-2.5" />
      </span>
    )
  }
  // not-started
  return (
    <span className={cn(base, 'bg-muted text-muted-foreground')}>
      {number}
    </span>
  )
}

function Connector({ done }: { done: boolean }) {
  return (
    <div className={cn('h-px flex-1 min-w-3', done ? 'bg-green-500' : 'bg-border')} />
  )
}

export function WizardStepList() {
  const stepStates = useWizardStore(state => state.stepStates)
  const currentStep = useWizardStore(state => state.currentStep)
  const wizardSteps = useWizardStore(state => state.wizardSteps)

  function handleStepClick(stepId: StepId) {
    useWizardStore.getState().setCurrentStep(stepId)
  }

  return (
    <nav className="flex items-center gap-0 px-2 py-3" aria-label="Wizard steps">
      {wizardSteps.map((step, index) => {
        const state = stepStates[step.id] ?? 'locked'
        const isActive = step.id === currentStep
        const isLocked = state === 'locked'
        const prevDone = index > 0 && (stepStates[wizardSteps[index - 1]?.id ?? 0] ?? 'locked') === 'complete'

        return (
          <div key={step.id} className="contents">
            {/* Connector line between steps */}
            {index > 0 && <Connector done={prevDone} />}

            {/* Step button */}
            <button
              type="button"
              onClick={() => handleStepClick(step.id)}
              disabled={isLocked}
              className={cn(
                'flex items-center gap-1.5 shrink-0 rounded-md px-2 py-1 transition-colors',
                isActive && 'bg-accent',
                isLocked ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-accent/60',
              )}
              title={step.label}
            >
              <StepDot state={state} number={index + 1} />
              <span
                className={cn(
                  'text-xs whitespace-nowrap hidden sm:inline',
                  isActive && 'font-semibold text-foreground',
                  state === 'complete' && !isActive && 'text-muted-foreground',
                  (state === 'not-started' || state === 'locked') && 'text-muted-foreground',
                )}
              >
                {step.label}
              </span>
            </button>
          </div>
        )
      })}
    </nav>
  )
}
