import { useState } from 'react'
import { Loader2, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useWizardStore, type StepId } from '@/store/wizard-store'
import { useUIStore } from '@/store/ui-store'
import { WizardStepList } from './wizard/WizardStepList'
import { WizardStepPanel } from './wizard/WizardStepPanel'
import { Step1SampleInfo } from './wizard/steps/Step1SampleInfo'
import { Step2StockPrep } from './wizard/steps/Step2StockPrep'
import { Step3Dilution } from './wizard/steps/Step3Dilution'
import { Step4Results } from './wizard/steps/Step4Results'
import { Step5Summary } from './wizard/steps/Step5Summary'
import { createSamplePrep } from '@/lib/api'

function renderCurrentStep(currentStep: StepId): React.ReactNode {
  switch (currentStep) {
    case 1: return <Step1SampleInfo />
    case 2: return <Step2StockPrep />
    case 3: return <Step3Dilution />
    case 4: return <Step4Results />
    case 5: return <Step5Summary />
  }
}

export function CreateAnalysis() {
  const currentStep = useWizardStore(state => state.currentStep)
  const session = useWizardStore(state => state.session)
  const navigateTo = useUIStore(state => state.navigateTo)
  const stepStates = useWizardStore(state => state.stepStates)
  const senaiteResult = useWizardStore(state => state.senaiteResult)

  // canAdvance drives the "Next Step" button on steps 1 & 2
  const canAdvance = useWizardStore(state => state.canAdvance())

  // Step 3 is saveable when all dilution measurements are recorded
  // (i.e. step 4 is no longer locked in the derived states)
  const step3Done = stepStates[4] !== 'locked'

  // Save state for step 3
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function handleBack() {
    useWizardStore.getState().setCurrentStep((currentStep - 1) as StepId)
  }

  function handleNext() {
    // Steps 1 & 2 — just advance
    useWizardStore.getState().setCurrentStep((currentStep + 1) as StepId)
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

  const isStep3 = currentStep === 3

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

        {/* Persistent SENAITE reference card — shown on all steps once a lookup was done */}
        {senaiteResult && (
          <div className="mx-6 mt-5 rounded-md border border-blue-500/30 bg-blue-50/50 dark:bg-blue-950/20 p-4 space-y-2">
            <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
              Sample found in SENAITE
            </p>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Sample ID</span>
                <p className="font-medium">{senaiteResult.sample_id}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Declared Weight</span>
                <p className="font-medium">
                  {senaiteResult.declared_weight_mg != null
                    ? `${senaiteResult.declared_weight_mg} mg`
                    : '—'}
                </p>
              </div>
            </div>
            {senaiteResult.analytes.length > 0 && (
              <div>
                <span className="text-sm text-muted-foreground">Analytes</span>
                <ul className="mt-1 space-y-0.5">
                  {senaiteResult.analytes.map((a, i) => (
                    <li key={i} className="text-sm flex items-center gap-2">
                      <span
                        className={
                          a.matched_peptide_id !== null
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-muted-foreground'
                        }
                      >
                        {a.matched_peptide_id !== null ? '✓' : '○'}
                      </span>
                      <span>{a.raw_name}</span>
                      {a.matched_peptide_name && (
                        <span className="text-muted-foreground text-xs">
                          → {a.matched_peptide_name}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex-1 p-6">
          <WizardStepPanel stepId={currentStep}>
            {renderCurrentStep(currentStep)}
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
        <div className="flex items-center justify-between border-t p-4">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 1 || saving}
          >
            Back
          </Button>

          {isStep3 ? (
            <Button
              onClick={handleSave}
              disabled={!step3Done || saving || saved}
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
  )
}
