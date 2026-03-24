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

export function Step3Dilution({ vialNumber = 1 }: { vialNumber?: number }) {
  const session = useWizardStore(state => state.session)

  if (!session) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground">
            Complete previous steps to begin dilution.
          </p>
        </CardContent>
      </Card>
    )
  }

  return <DilutionVial session={session} vialNumber={vialNumber} />
}

/** Single-vial dilution flow */
function DilutionVial({ session, vialNumber }: {
  session: NonNullable<ReturnType<typeof useWizardStore.getState>['session']>
  vialNumber: number
}) {
  const [error3a, setError3a] = useState<string | null>(null)
  const [error3b, setError3b] = useState<string | null>(null)
  const [error3c, setError3c] = useState<string | null>(null)
  const [reweigh3a, setReweigh3a] = useState(false)
  const [reweigh3b, setReweigh3b] = useState(false)
  const [reweigh3c, setReweigh3c] = useState(false)

  const meas3a = session.measurements.find(
    m => m.step_key === 'dil_vial_empty_mg' && m.is_current && m.vial_number === vialNumber
  )
  const meas3b = session.measurements.find(
    m => m.step_key === 'dil_vial_with_diluent_mg' && m.is_current && m.vial_number === vialNumber
  )
  const meas3c = session.measurements.find(
    m => m.step_key === 'dil_vial_final_mg' && m.is_current && m.vial_number === vialNumber
  )

  const step3aDone = meas3a != null && !reweigh3a
  const step3bDone = meas3b != null && !reweigh3b
  const step3cDone = meas3c != null && !reweigh3c
  const step3bLocked = !step3aDone
  const step3cLocked = !step3bDone

  const sessionId = session.id
  const calcs = vialNumber === 1
    ? session.calculations
    : session.vial_calculations?.[String(vialNumber)] ?? null

  const requiredDiluentVol = calcs?.required_diluent_vol_ul
  const requiredStockVol = calcs?.required_stock_vol_ul

  // Serial dilution instructions for standards
  const isStandard = session.is_standard === true
  const vialParams = session.vial_params ?? {}

  // Get this vial's target concentration and the previous vial's concentration
  const thisVialConc = vialParams[String(vialNumber)]?.target_conc_ug_ml ?? null
  const thisVialVol = vialParams[String(vialNumber)]?.target_total_vol_ul ?? 1500

  // For serial dilution: source is the previous vial (or stock for vial 1)
  const isFirstDilution = vialNumber === 1
  const prevVialConc = isFirstDilution
    ? (calcs?.stock_conc_ug_ml ?? null) // First dilution pulls from stock
    : (vialParams[String(vialNumber - 1)]?.target_conc_ug_ml ?? null)

  // C1*V1 = C2*V2 → V1 = (C2 * V2) / C1
  const serialPullVol = (thisVialConc && prevVialConc && prevVialConc > 0)
    ? (thisVialConc * thisVialVol) / prevVialConc
    : null
  const serialDiluentVol = serialPullVol != null ? thisVialVol - serialPullVol : null

  async function handleAccept3a(value: number, source: 'scale' | 'manual') {
    setError3a(null)
    try {
      const response = await recordWizardMeasurement(sessionId, {
        step_key: 'dil_vial_empty_mg',
        weight_mg: value,
        source,
        vial_number: vialNumber,
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
        vial_number: vialNumber,
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
        vial_number: vialNumber,
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

      {/* Serial dilution instructions for standards */}
      {isStandard && thisVialConc != null && serialPullVol != null && serialDiluentVol != null && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-4 space-y-2">
            <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
              Serial Dilution — Target: {thisVialConc} µg/mL
            </p>
            <div className="text-sm space-y-1.5">
              <div className="flex items-start gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-bold shrink-0 mt-0.5">1</span>
                <p>
                  Pull <span className="font-mono font-semibold">{serialPullVol.toFixed(1)} µL</span> from{' '}
                  {isFirstDilution
                    ? <span className="font-medium">Stock Solution</span>
                    : <span className="font-medium">Vial {vialNumber - 1} ({prevVialConc} µg/mL)</span>
                  }
                </p>
              </div>
              {serialDiluentVol > 0 && (
                <div className="flex items-start gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-bold shrink-0 mt-0.5">2</span>
                  <p>
                    Add <span className="font-mono font-semibold">{serialDiluentVol.toFixed(1)} µL</span> diluent to reach{' '}
                    <span className="font-mono">{thisVialVol} µL</span> total volume
                  </p>
                </div>
              )}
              {serialDiluentVol <= 0 && (
                <div className="flex items-start gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/20 text-green-600 dark:text-green-400 text-xs font-bold shrink-0 mt-0.5">2</span>
                  <p className="text-green-600 dark:text-green-400">
                    No additional diluent needed — pull volume equals target volume
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Target volumes display (non-standard) */}
      {!isStandard && (requiredDiluentVol != null || requiredStockVol != null) && (
        <Card className="border-blue-500/30 bg-blue-50/30 dark:bg-blue-950/10">
          <CardContent className="pt-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              {requiredDiluentVol != null && (
                <div>
                  <span className="text-muted-foreground">
                    Required Diluent Volume
                  </span>
                  <p className="font-medium font-mono">
                    {requiredDiluentVol.toFixed(1)} µL
                  </p>
                </div>
              )}
              {requiredStockVol != null && (
                <div>
                  <span className="text-muted-foreground">
                    Required Stock Volume
                  </span>
                  <p className="font-medium font-mono">
                    {requiredStockVol.toFixed(1)} µL
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
            Empty Autosampler vial + cap Weight
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Weigh the empty Autosampler vial with cap.
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
                  {meas3a?.weight_mg.toFixed(2)} mg
                </span>
                <span className="text-xs text-muted-foreground">
                  (via {meas3a?.source})
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
              label="Empty Autosampler vial + cap weight (mg)"
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
                  {requiredDiluentVol.toFixed(1)} µL
                </span>{' '}
                of diluent, then re-weigh the vial.
              </>
            ) : (
              'Add the required diluent, then re-weigh the vial.'
            )}
          </p>
          {requiredDiluentVol != null && requiredDiluentVol > 1000 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-blue-500/5 border border-blue-500/20 text-xs">
              <span className="text-blue-600 dark:text-blue-400 font-medium">Pipette tip:</span>
              <span className="font-mono text-blue-600 dark:text-blue-400">
                2 &times; {(requiredDiluentVol / 2).toFixed(1)} µL
              </span>
              <span className="text-muted-foreground">(split into two additions)</span>
            </div>
          )}
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
                  {meas3b?.weight_mg.toFixed(2)} mg
                </span>
                <span className="text-xs text-muted-foreground">
                  (via {meas3b?.source})
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
                  {requiredStockVol.toFixed(1)} µL
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
                  {meas3c?.weight_mg.toFixed(2)} mg
                </span>
                <span className="text-xs text-muted-foreground">
                  (via {meas3c?.source})
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
                    {calcs.actual_diluent_vol_ul.toFixed(1)} µL
                  </p>
                  {meas3b && meas3a && (
                    <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                      = ({meas3b.weight_mg} − {meas3a.weight_mg}) / 997.1 × 1000
                    </p>
                  )}
                </div>
              )}
              {calcs.actual_stock_vol_ul != null && (
                <div>
                  <span className="text-muted-foreground">
                    Actual Stock Added
                  </span>
                  <p className="font-medium font-mono">
                    {calcs.actual_stock_vol_ul.toFixed(1)} µL
                  </p>
                  {meas3c && meas3b && (
                    <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                      = ({meas3c.weight_mg} − {meas3b.weight_mg}) / 997.1 × 1000
                    </p>
                  )}
                </div>
              )}
              {calcs.actual_conc_ug_ml != null && (
                <div>
                  <span className="text-muted-foreground">
                    Actual Concentration
                  </span>
                  <p className="font-medium font-mono">
                    {calcs.actual_conc_ug_ml.toFixed(2)} µg/mL
                  </p>
                  {calcs.stock_conc_ug_ml != null && calcs.actual_stock_vol_ul != null && calcs.actual_diluent_vol_ul != null && (
                    <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                      = {calcs.stock_conc_ug_ml.toFixed(2)} × {calcs.actual_stock_vol_ul.toFixed(1)} / ({calcs.actual_diluent_vol_ul.toFixed(1)} + {calcs.actual_stock_vol_ul.toFixed(1)})
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Per-analyte actual concentrations */}
            {calcs.analyte_calculations && (
              <div className="border-t border-green-500/20 pt-3 mt-4">
                <p className="text-xs font-medium text-muted-foreground mb-2">Per-Analyte Actual Concentrations</p>
                <div className="rounded-md border border-zinc-700 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-700 text-xs text-muted-foreground">
                        <th className="text-start p-2">Analyte</th>
                        <th className="text-end p-2">Actual Conc.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(calcs.analyte_calculations).map(([aKey, ac]) => (
                        <tr key={aKey} className="border-b border-zinc-700/50 last:border-0">
                          <td className="p-2 text-xs font-medium">{aKey}</td>
                          <td className="p-2 text-end font-mono text-xs">
                            {ac.actual_conc_ug_ml != null ? `${ac.actual_conc_ug_ml.toFixed(2)} µg/mL` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
