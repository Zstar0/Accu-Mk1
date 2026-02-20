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

export function Step2StockPrep() {
  const session = useWizardStore(state => state.session)

  // Local state: peptide transfer confirmation (transient UI state)
  const [transferConfirmed, setTransferConfirmed] = useState(false)

  // Local error state per sub-step
  const [error2a, setError2a] = useState<string | null>(null)
  const [error2d, setError2d] = useState<string | null>(null)

  // Re-weigh reset flags (local UI state)
  const [reweigh2a, setReweigh2a] = useState(false)
  const [reweigh2d, setReweigh2d] = useState(false)

  if (!session) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground">
            Complete Step 1 to begin stock preparation.
          </p>
        </CardContent>
      </Card>
    )
  }

  // Derive sub-step completion from session measurements
  const meas2a = session.measurements.find(
    m => m.step_key === 'stock_vial_empty_mg' && m.is_current
  )
  const meas2d = session.measurements.find(
    m => m.step_key === 'stock_vial_loaded_mg' && m.is_current
  )

  // Transfer confirmed = either local state OR loaded vial already measured (implies transfer happened)
  const transferDone = transferConfirmed || meas2d != null

  // Sub-step 2a: done if measurement exists and not re-weighing
  const step2aDone = meas2a != null && !reweigh2a
  // Sub-step 2b: locked until 2a done; confirmed/done if transferDone
  const step2bLocked = !step2aDone
  // Sub-step 2c + 2d: locked until transfer confirmed
  const step2cdLocked = !transferDone

  // Step 2d done if measurement exists and not re-weighing
  const step2dDone = meas2d != null && !reweigh2d

  const sessionId = session.id
  const calcs = session.calculations
  const requiredDiluentVol = calcs?.required_diluent_vol_ul

  async function handleAccept2a(value: number, source: 'scale' | 'manual') {
    setError2a(null)
    try {
      const response = await recordWizardMeasurement(sessionId, {
        step_key: 'stock_vial_empty_mg',
        weight_mg: value,
        source,
      })
      useWizardStore.getState().updateSession(response)
      setReweigh2a(false)
    } catch (err) {
      setError2a(
        err instanceof Error ? err.message : 'Failed to record measurement'
      )
    }
  }

  async function handleAccept2d(value: number, source: 'scale' | 'manual') {
    setError2d(null)
    try {
      const response = await recordWizardMeasurement(sessionId, {
        step_key: 'stock_vial_loaded_mg',
        weight_mg: value,
        source,
      })
      useWizardStore.getState().updateSession(response)
      setReweigh2d(false)
    } catch (err) {
      setError2d(
        err instanceof Error ? err.message : 'Failed to record measurement'
      )
    }
  }

  const allComplete = step2aDone && transferDone && step2dDone

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Stock Preparation</h2>
      <p className="text-sm text-muted-foreground">
        Follow the steps below to prepare the stock solution. Each step unlocks
        after the previous one is complete.
      </p>

      {/* Sub-step 2a: Empty vial weight */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              1
            </span>
            Empty Vial Weight
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Weigh the empty sample vial with cap.
          </p>
          {error2a && (
            <Alert variant="destructive">
              <AlertDescription>{error2a}</AlertDescription>
            </Alert>
          )}
          {step2aDone ? (
            <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium">
                  {meas2a!.weight_mg.toFixed(2)} mg
                </span>
                <span className="text-xs text-muted-foreground">
                  (via {meas2a!.source})
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReweigh2a(true)}
              >
                Re-weigh
              </Button>
            </div>
          ) : (
            <WeightInput
              stepKey="stock_vial_empty_mg"
              label="Empty vial + cap weight (mg)"
              onAccept={handleAccept2a}
            />
          )}
        </CardContent>
      </Card>

      {/* Sub-step 2b: Peptide transfer confirmation */}
      <Card className={step2bLocked ? 'opacity-50' : undefined}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              2
            </span>
            Peptide Transfer
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Transfer the peptide sample to the vial.
          </p>
          {transferDone ? (
            <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-3">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-sm font-medium">Peptide transferred</span>
            </div>
          ) : (
            <Button
              onClick={() => setTransferConfirmed(true)}
              disabled={step2bLocked}
            >
              I have transferred the peptide
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Sub-step 2c: Display required diluent volume */}
      <Card className={step2cdLocked ? 'opacity-50' : undefined}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              3
            </span>
            Add Diluent
          </CardTitle>
        </CardHeader>
        <CardContent>
          {requiredDiluentVol != null ? (
            <p className="text-sm font-medium">
              Add{' '}
              <span className="font-bold text-primary">
                {requiredDiluentVol.toFixed(1)} uL
              </span>{' '}
              of diluent to the vial.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Diluent volume will be calculated after vial weights are recorded.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Sub-step 2d: Loaded vial weight */}
      <Card className={step2cdLocked ? 'opacity-50' : undefined}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              4
            </span>
            Loaded Vial Weight
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Add the diluent, then weigh the vial + cap + diluent.
          </p>
          {error2d && (
            <Alert variant="destructive">
              <AlertDescription>{error2d}</AlertDescription>
            </Alert>
          )}
          {step2dDone ? (
            <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium">
                  {meas2d!.weight_mg.toFixed(2)} mg
                </span>
                <span className="text-xs text-muted-foreground">
                  (via {meas2d!.source})
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReweigh2d(true)}
                disabled={step2cdLocked}
              >
                Re-weigh
              </Button>
            </div>
          ) : (
            <WeightInput
              stepKey="stock_vial_loaded_mg"
              label="Vial + cap + diluent weight (mg)"
              onAccept={handleAccept2d}
            />
          )}
        </CardContent>
      </Card>

      {/* Summary card — shown after all sub-steps complete */}
      {allComplete && calcs && (
        <Card className="border-green-500/40 bg-green-50/30 dark:bg-green-950/10">
          <CardHeader>
            <CardTitle className="text-base text-green-700 dark:text-green-400">
              Stock Preparation Complete
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-sm">
              {calcs.stock_conc_ug_ml != null && (
                <div>
                  <span className="text-muted-foreground">
                    Stock Concentration
                  </span>
                  <p className="font-medium font-mono">
                    {calcs.stock_conc_ug_ml.toFixed(2)} ug/mL
                  </p>
                </div>
              )}
              {calcs.required_stock_vol_ul != null && (
                <div>
                  <span className="text-muted-foreground">
                    Required Stock Volume
                  </span>
                  <p className="font-medium font-mono">
                    {calcs.required_stock_vol_ul.toFixed(1)} uL
                  </p>
                </div>
              )}
              {calcs.required_diluent_vol_ul != null && (
                <div>
                  <span className="text-muted-foreground">
                    Required Diluent Volume
                  </span>
                  <p className="font-medium font-mono">
                    {calcs.required_diluent_vol_ul.toFixed(1)} uL
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
