import { Check, Lock } from 'lucide-react'
import { useWizardStore, WIZARD_STEPS, type StepId, type StepState } from '@/store/wizard-store'
import { cn } from '@/lib/utils'

function StepIndicator({ stepId, state }: { stepId: StepId; state: StepState }) {
  const base =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium transition-colors'

  if (state === 'complete') {
    return (
      <span className={cn(base, 'bg-green-500 text-white')}>
        <Check className="h-4 w-4" />
      </span>
    )
  }

  if (state === 'in-progress') {
    return (
      <span className={cn(base, 'bg-primary text-primary-foreground')}>
        {stepId}
      </span>
    )
  }

  if (state === 'locked') {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground')}>
        <Lock className="h-4 w-4" />
      </span>
    )
  }

  // not-started
  return (
    <span className={cn(base, 'bg-muted text-muted-foreground')}>
      {stepId}
    </span>
  )
}

export function WizardStepList() {
  const stepStates = useWizardStore(state => state.stepStates)
  const currentStep = useWizardStore(state => state.currentStep)

  function handleStepClick(stepId: StepId) {
    useWizardStore.getState().setCurrentStep(stepId)
  }

  return (
    <nav className="flex flex-col gap-1">
      {WIZARD_STEPS.map(step => {
        const state = stepStates[step.id]
        const isActive = step.id === currentStep
        const isLocked = state === 'locked'

        return (
          <button
            key={step.id}
            type="button"
            onClick={() => handleStepClick(step.id)}
            disabled={isLocked}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-start text-sm transition-colors',
              isActive && 'bg-accent',
              isLocked
                ? 'cursor-not-allowed opacity-50'
                : 'cursor-pointer hover:bg-accent/60',
              isActive && 'border-l-2 border-primary pl-[10px]'
            )}
          >
            <StepIndicator stepId={step.id} state={state} />
            <span
              className={cn(
                'truncate',
                state === 'in-progress' && 'font-semibold',
                state === 'complete' && 'text-foreground',
                (state === 'not-started' || state === 'locked') &&
                  'text-muted-foreground'
              )}
            >
              {step.label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
