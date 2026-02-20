import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { WeightInput } from '@/components/hplc/WeightInput'
import { recordWizardMeasurement } from '@/lib/api'
import { useWizardStore } from '@/store/wizard-store'

export function Step3Dilution() {
  const session = useWizardStore(state => state.session)

  // Local error state per sub-step
  const [error3a, setError3a] = useState<string | null>(null)
  const [error3b, setError3b] = useState<string | null>(null)
  const [error3c, setError3c] = useState<string | null>(null)

  // Re-weigh reset flags (local UI state)
  const [reweigh3a, setReweigh3a] = useState(false)
  const [reweigh3b, setReweigh3b] = useState(false)
  const [reweigh3c, setReweigh3c] = useState(false)

  if (!session) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground">
            Complete Steps 1 and 2 to begin dilution.
          </p>
        </CardContent>
      </Card>
    )
  }

  const calcs = session.calculations
  const requiredDiluentVol = calcs?.required_diluent_vol_ul
  const requiredStockVol = calcs?.required_stock_vol_ul

  // Derive sub-step completion from session measurements (same pattern as Step 2)
  const meas3a = session.measurements.find(
    m => m.step_key === 'dil_vial_empty_mg' && m.is_current
  )
  const meas3b = session.measurements.find(
    m => m.step_key === 'dil_vial_with_diluent_mg' && m.is_current
  )
  const meas3c = session.measurements.find(
    m => m.step_key === 'dil_vial_final_mg' && m.is_current
  )

  // Sub-step states: done = measurement exists and not re-weighing
  const step3aDone = meas3a != null && !reweigh3a
  const step3bDone = meas3b != null && !reweigh3b
  const step3cDone = meas3c != null && !reweigh3c

  // Locking: each sub-step requires previous to be done
  const step3bLocked = !step3aDone
  const step3cLocked = !step3bDone

  const sessionId = session.id

  async function handleAccept3a(value: number, source: 'scale' | 'manual') {
    setError3a(null)
    try {
      const response = await recordWizardMeasurement(sessionId, {
        step_key: 'dil_vial_empty_mg',
        weight_mg: value,
        source,
      })
      useWizardStore.getState().updateSession(response)
      setReweigh3a(false)
    } catch (err) {
      setError3a(
        err instanceof Error ? err.message : 'Failed to record measurement'
      )
    }
  }

  async function handleAccept3b(value: number, source: 'scale' | 'manual') {
    setError3b(null)
    try {
      const response = await recordWizardMeasurement(sessionId, {
        step_key: 'dil_vial_with_diluent_mg',
        weight_mg: value,
        source,
      })
      useWizardStore.getState().updateSession(response)
      setReweigh3b(false)
    } catch (err) {
      setError3b(
        err instanceof Error ? err.message : 'Failed to record measurement'
      )
    }
  }

  async function handleAccept3c(value: number, source: 'scale' | 'manual') {
    setError3c(null)
    try {
      const response = await recordWizardMeasurement(sessionId, {
        step_key: 'dil_vial_final_mg',
        weight_mg: value,
        source,
      })
      useWizardStore.getState().updateSession(response)
      setReweigh3c(false)
    } catch (err) {
      setError3c(
        err instanceof Error ? err.message : 'Failed to record measurement'
      )
    }
  }

  const allComplete = step3aDone && step3bDone && step3cDone

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Dilution</h2>
      <p className="text-sm text-muted-foreground">
        Prepare the diluted sample solution. Each weighing step unlocks after
        the previous one is complete.
      </p>

      {/* Target volumes display */}
      {(requiredDiluentVol != null || requiredStockVol != null) && (
        <Card className="border-blue-500/30 bg-blue-50/30 dark:bg-blue-950/10">
          <CardContent className="pt-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              {requiredDiluentVol != null && (
                <div>
                  <span className="text-muted-foreground">
                    Required Diluent Volume
                  </span>
                  <p className="font-medium font-mono">
                    {requiredDiluentVol.toFixed(1)} uL
                  </p>
                </div>
              )}
              {requiredStockVol != null && (
                <div>
                  <span className="text-muted-foreground">
                    Required Stock Volume
                  </span>
                  <p className="font-medium font-mono">
                    {requiredStockVol.toFixed(1)} uL
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sub-step 3a: Empty dilution vial weight */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              1
            </span>
            Empty Dilution Vial Weight
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Weigh the empty dilution vial with cap.
          </p>
          {error3a && (
            <Alert variant="destructive">
              <AlertDescription>{error3a}</AlertDescription>
            </Alert>
          )}
          {step3aDone ? (
            <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium">
                  {meas3a!.weight_mg.toFixed(2)} mg
                </span>
                <span className="text-xs text-muted-foreground">
                  (via {meas3a!.source})
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReweigh3a(true)}
              >
                Re-weigh
              </Button>
            </div>
          ) : (
            <WeightInput
              stepKey="dil_vial_empty_mg"
              label="Empty dilution vial + cap weight (mg)"
              onAccept={handleAccept3a}
            />
          )}
        </CardContent>
      </Card>

      {/* Sub-step 3b: Vial + diluent weight */}
      <Card className={step3bLocked ? 'opacity-50' : undefined}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              2
            </span>
            Add Diluent and Weigh
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {requiredDiluentVol != null ? (
              <>
                Add{' '}
                <span className="font-semibold">
                  {requiredDiluentVol.toFixed(1)} uL
                </span>{' '}
                of diluent, then re-weigh the vial.
              </>
            ) : (
              'Add the required diluent, then re-weigh the vial.'
            )}
          </p>
          {error3b && (
            <Alert variant="destructive">
              <AlertDescription>{error3b}</AlertDescription>
            </Alert>
          )}
          {step3bDone ? (
            <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium">
                  {meas3b!.weight_mg.toFixed(2)} mg
                </span>
                <span className="text-xs text-muted-foreground">
                  (via {meas3b!.source})
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReweigh3b(true)}
                disabled={step3bLocked}
              >
                Re-weigh
              </Button>
            </div>
          ) : (
            <WeightInput
              stepKey="dil_vial_with_diluent_mg"
              label="Vial + cap + diluent weight (mg)"
              onAccept={handleAccept3b}
            />
          )}
        </CardContent>
      </Card>

      {/* Sub-step 3c: Final dilution vial weight */}
      <Card className={step3cLocked ? 'opacity-50' : undefined}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              3
            </span>
            Add Stock Solution and Weigh
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {requiredStockVol != null ? (
              <>
                Add{' '}
                <span className="font-semibold">
                  {requiredStockVol.toFixed(1)} uL
                </span>{' '}
                of stock solution, then weigh the final vial.
              </>
            ) : (
              'Add the required stock solution, then weigh the final vial.'
            )}
          </p>
          {error3c && (
            <Alert variant="destructive">
              <AlertDescription>{error3c}</AlertDescription>
            </Alert>
          )}
          {step3cDone ? (
            <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium">
                  {meas3c!.weight_mg.toFixed(2)} mg
                </span>
                <span className="text-xs text-muted-foreground">
                  (via {meas3c!.source})
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReweigh3c(true)}
                disabled={step3cLocked}
              >
                Re-weigh
              </Button>
            </div>
          ) : (
            <WeightInput
              stepKey="dil_vial_final_mg"
              label="Final dilution vial weight (mg)"
              onAccept={handleAccept3c}
            />
          )}
        </CardContent>
      </Card>

      {/* Summary card — shown after all sub-steps complete */}
      {allComplete && calcs && (
        <Card className="border-green-500/40 bg-green-50/30 dark:bg-green-950/10">
          <CardHeader>
            <CardTitle className="text-base text-green-700 dark:text-green-400">
              Dilution Complete
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-sm">
              {calcs.actual_diluent_vol_ul != null && (
                <div>
                  <span className="text-muted-foreground">
                    Actual Diluent Added
                  </span>
                  <p className="font-medium font-mono">
                    {calcs.actual_diluent_vol_ul.toFixed(1)} uL
                  </p>
                </div>
              )}
              {calcs.actual_stock_vol_ul != null && (
                <div>
                  <span className="text-muted-foreground">
                    Actual Stock Added
                  </span>
                  <p className="font-medium font-mono">
                    {calcs.actual_stock_vol_ul.toFixed(1)} uL
                  </p>
                </div>
              )}
              {calcs.actual_conc_ug_ml != null && (
                <div>
                  <span className="text-muted-foreground">
                    Actual Concentration
                  </span>
                  <p className="font-medium font-mono">
                    {calcs.actual_conc_ug_ml.toFixed(2)} ug/mL
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
