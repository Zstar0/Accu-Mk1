import { useState } from 'react'
import { Loader2, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useWizardStore, type WizardStep } from '@/store/wizard-store'
import { useUIStore } from '@/store/ui-store'
import { WizardStepList } from './wizard/WizardStepList'
import { WizardStepPanel } from './wizard/WizardStepPanel'
import { WizardInfoPanel } from './wizard/WizardInfoPanel'
import { Step1SampleInfo } from './wizard/steps/Step1SampleInfo'
import { Step2StockPrep } from './wizard/steps/Step2StockPrep'
import { Step3Dilution } from './wizard/steps/Step3Dilution'
import { createSamplePrep } from '@/lib/api'

function renderStep(step: WizardStep | undefined): React.ReactNode {
  if (!step) return null
  switch (step.type) {
    case 'sample-info': return <Step1SampleInfo />
    case 'stock-prep': return <Step2StockPrep vialNumber={step.vialNumber} />
    case 'dilution': return <Step3Dilution vialNumber={step.vialNumber} />
  }
}

export function CreateAnalysis() {
  const currentStep = useWizardStore(state => state.currentStep)
  const session = useWizardStore(state => state.session)
  const navigateTo = useUIStore(state => state.navigateTo)
  const stepStates = useWizardStore(state => state.stepStates)
  const wizardSteps = useWizardStore(state => state.wizardSteps)

  // canAdvance drives the "Next Step" button
  const canAdvance = useWizardStore(state => state.canAdvance())

  // Current step metadata
  const currentStepDef = wizardSteps.find(s => s.id === currentStep)
  const lastStep = wizardSteps[wizardSteps.length - 1]
  const isLastStep = lastStep ? currentStep === lastStep.id : false

  // Last step is saveable when it's complete (dilution done)
  const lastStepDone = isLastStep && stepStates[currentStep] === 'in-progress' &&
    (lastStep?.type === 'dilution' || lastStep?.type === 'standard-dilution') &&
    session?.measurements?.some(m => m.step_key === 'dil_vial_final_mg' && m.is_current && m.vial_number === lastStep.vialNumber)

  // Save state
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function handleBack() {
    const idx = wizardSteps.findIndex(s => s.id === currentStep)
    if (idx > 0) {
      useWizardStore.getState().setCurrentStep(wizardSteps[idx - 1]?.id ?? 1)
    }
  }

  function handleNext() {
    const idx = wizardSteps.findIndex(s => s.id === currentStep)
    const next = wizardSteps[idx + 1]
    if (next) {
      useWizardStore.getState().setCurrentStep(next.id)
    }
  }

  async function handleSave() {
    if (!session) return
    setSaving(true)
    setSaveError(null)
    try {
      await createSamplePrep(session.id)
      setSaved(true)
      // Brief success flash then navigate to the sample preps list
      setTimeout(() => {
        navigateTo('hplc-analysis', 'sample-preps')
      }, 1200)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save sample prep')
    } finally {
      setSaving(false)
    }
  }

  // Info panel is shown once a session is created (past Step 1)
  const showInfoPanel = session !== null

  return (
    <div className="flex h-full flex-col">
      {/* Top bar — horizontal step navigation */}
      <div className="shrink-0 border-b bg-background">
        <div className="flex items-center justify-between px-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider shrink-0">
            New Analysis
          </h2>
          <WizardStepList />
        </div>
      </div>

      {/* Main content: left info panel + right step content */}
      <div className="flex flex-1 min-h-0">
        {/* Left info panel — 30% width, shown after session created */}
        {showInfoPanel && (
          <div className="w-[30%] shrink-0 border-r overflow-y-auto bg-muted/20">
            <WizardInfoPanel />
          </div>
        )}

        {/* Right content — step panel */}
        <div className="flex flex-1 flex-col min-w-0 overflow-y-auto">
          <div className="flex-1 p-6">
            <WizardStepPanel stepId={currentStep}>
              {renderStep(currentStepDef)}
            </WizardStepPanel>
          </div>

          {/* Save error */}
          {saveError && (
            <div className="px-6 pb-2">
              <Alert variant="destructive">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            </div>
          )}

          {/* Navigation footer */}
          <div className="flex items-center justify-between border-t p-4 shrink-0">
            <Button
              variant="outline"
              onClick={handleBack}
              disabled={currentStep === 1 || saving}
            >
              Back
            </Button>

            {isLastStep ? (
              <Button
                onClick={handleSave}
                disabled={!lastStepDone || saving || saved}
              >
                {saving ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
                ) : saved ? (
                  <><CheckCircle2 className="h-4 w-4 mr-2 text-green-400" />Saved!</>
                ) : (
                  'Save Sample Prep'
                )}
              </Button>
            ) : (
              <Button
                onClick={handleNext}
                disabled={!canAdvance}
              >
                Next Step
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
