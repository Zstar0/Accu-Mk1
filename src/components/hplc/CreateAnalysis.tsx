import { Button } from '@/components/ui/button'
import { useWizardStore, type StepId } from '@/store/wizard-store'
import { WizardStepList } from './wizard/WizardStepList'
import { WizardStepPanel } from './wizard/WizardStepPanel'
import { Step1SampleInfo } from './wizard/steps/Step1SampleInfo'
import { Step2StockPrep } from './wizard/steps/Step2StockPrep'
import { Step3Dilution } from './wizard/steps/Step3Dilution'
import { Step4Results } from './wizard/steps/Step4Results'
import { Step5Summary } from './wizard/steps/Step5Summary'

function renderCurrentStep(currentStep: StepId): React.ReactNode {
  switch (currentStep) {
    case 1:
      return <Step1SampleInfo />
    case 2:
      return <Step2StockPrep />
    case 3:
      return <Step3Dilution />
    case 4:
      return <Step4Results />
    case 5:
      return <Step5Summary />
  }
}

export function CreateAnalysis() {
  const currentStep = useWizardStore(state => state.currentStep)
  const canAdvance = useWizardStore(state => state.canAdvance)

  function handleBack() {
    useWizardStore.getState().setCurrentStep((currentStep - 1) as StepId)
  }

  function handleNext() {
    useWizardStore.getState().setCurrentStep((currentStep + 1) as StepId)
  }

  return (
    <div className="flex h-full">
      {/* Left sidebar — step list */}
      <div className="w-64 shrink-0 border-r p-4">
        <h2 className="mb-4 text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          New Analysis
        </h2>
        <WizardStepList />
      </div>

      {/* Right content — step panel */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="flex-1 p-6">
          <WizardStepPanel stepId={currentStep}>
            {renderCurrentStep(currentStep)}
          </WizardStepPanel>
        </div>

        {/* Navigation footer */}
        <div className="flex items-center justify-between border-t p-4">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 1}
          >
            Back
          </Button>
          <Button
            onClick={handleNext}
            disabled={currentStep === 5 || !canAdvance()}
          >
            Next Step
          </Button>
        </div>
      </div>
    </div>
  )
}
