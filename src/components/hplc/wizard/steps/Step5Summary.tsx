import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { completeWizardSession } from '@/lib/api'
import { useWizardStore } from '@/store/wizard-store'
import { useUIStore } from '@/store/ui-store'

const STEP_KEY_LABELS: Record<string, string> = {
  stock_vial_empty_mg: 'Empty Vial + Cap',
  stock_vial_loaded_mg: 'Vial + Cap + Diluent',
  dil_vial_empty_mg: 'Empty Dilution Vial + Cap',
  dil_vial_with_diluent_mg: 'Dilution Vial + Diluent',
  dil_vial_final_mg: 'Final Dilution Vial',
}

export function Step5Summary() {
  const session = useWizardStore(state => state.session)

  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)

  if (!session) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground">
            Complete previous steps to view the summary.
          </p>
        </CardContent>
      </Card>
    )
  }

  const calcs = session.calculations

  const stockMeasurements = session.measurements.filter(
    m => m.step_key.startsWith('stock_') && m.is_current
  )
  const dilMeasurements = session.measurements.filter(
    m => m.step_key.startsWith('dil_') && m.is_current
  )

  const sessionId = session.id

  async function handleComplete() {
    setCompleting(true)
    setCompleteError(null)
    try {
      await completeWizardSession(sessionId)
      useWizardStore.getState().resetWizard()
      useUIStore.getState().navigateTo('hplc-analysis', 'analysis-history')
    } catch (err) {
      setCompleteError(
        err instanceof Error ? err.message : 'Failed to complete session'
      )
      setCompleting(false)
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Session Summary</h2>
      <p className="text-sm text-muted-foreground">
        Review all measurements and results before completing the session.
      </p>

      {/* Section A: Sample Information */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sample Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Peptide ID</span>
              <p className="font-medium">{session.peptide_id}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Sample ID</span>
              <p className="font-medium">
                {session.sample_id_label ?? 'Not provided'}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Declared Weight</span>
              <p className="font-medium">
                {session.declared_weight_mg != null
                  ? `${session.declared_weight_mg.toFixed(2)} mg`
                  : 'Not provided'}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Target Concentration</span>
              <p className="font-medium font-mono">
                {session.target_conc_ug_ml != null
                  ? `${session.target_conc_ug_ml} ug/mL`
                  : '—'}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Target Total Volume</span>
              <p className="font-medium font-mono">
                {session.target_total_vol_ul != null
                  ? `${session.target_total_vol_ul} uL`
                  : '—'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section B: Stock Preparation Measurements */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stock Preparation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {stockMeasurements.length > 0 ? (
            <div className="space-y-2">
              {stockMeasurements.map(m => (
                <div
                  key={m.id}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-muted-foreground">
                    {STEP_KEY_LABELS[m.step_key] ?? m.step_key}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-medium font-mono">
                      {m.weight_mg.toFixed(2)} mg
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {m.source}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No stock measurements recorded.
            </p>
          )}
          {calcs?.stock_conc_ug_ml != null && (
            <div className="border-t pt-3 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Stock Concentration</span>
              <span className="font-medium font-mono">
                {calcs.stock_conc_ug_ml.toFixed(2)} ug/mL
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section C: Dilution Measurements */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dilution</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {dilMeasurements.length > 0 ? (
            <div className="space-y-2">
              {dilMeasurements.map(m => (
                <div
                  key={m.id}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-muted-foreground">
                    {STEP_KEY_LABELS[m.step_key] ?? m.step_key}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-medium font-mono">
                      {m.weight_mg.toFixed(2)} mg
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {m.source}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No dilution measurements recorded.
            </p>
          )}
          {(calcs?.actual_conc_ug_ml != null ||
            calcs?.actual_diluent_vol_ul != null ||
            calcs?.actual_stock_vol_ul != null) && (
            <div className="border-t pt-3 space-y-2">
              {calcs?.actual_conc_ug_ml != null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Actual Concentration
                  </span>
                  <span className="font-medium font-mono">
                    {calcs.actual_conc_ug_ml.toFixed(2)} ug/mL
                  </span>
                </div>
              )}
              {calcs?.actual_diluent_vol_ul != null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Actual Diluent Volume
                  </span>
                  <span className="font-medium font-mono">
                    {calcs.actual_diluent_vol_ul.toFixed(1)} uL
                  </span>
                </div>
              )}
              {calcs?.actual_stock_vol_ul != null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Actual Stock Volume
                  </span>
                  <span className="font-medium font-mono">
                    {calcs.actual_stock_vol_ul.toFixed(1)} uL
                  </span>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section D: HPLC Results */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">HPLC Results</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Peak Area</span>
              <p className="font-medium font-mono">
                {session.peak_area ?? '—'}
              </p>
            </div>
            {calcs?.determined_conc_ug_ml != null && (
              <div>
                <span className="text-muted-foreground">
                  Determined Concentration
                </span>
                <p className="font-medium font-mono">
                  {calcs.determined_conc_ug_ml.toFixed(2)} ug/mL
                </p>
              </div>
            )}
            {calcs?.dilution_factor != null && (
              <div>
                <span className="text-muted-foreground">Dilution Factor</span>
                <p className="font-medium font-mono">
                  {calcs.dilution_factor.toFixed(2)}
                </p>
              </div>
            )}
            {calcs?.peptide_mass_mg != null && (
              <div>
                <span className="text-muted-foreground">Peptide Mass</span>
                <p className="font-medium font-mono">
                  {calcs.peptide_mass_mg.toFixed(4)} mg
                </p>
              </div>
            )}
            {calcs?.purity_pct != null && (
              <div>
                <span className="text-muted-foreground">Purity</span>
                <p className="font-medium font-mono">
                  {calcs.purity_pct.toFixed(2)}%
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {completeError && (
        <Alert variant="destructive">
          <AlertDescription>{completeError}</AlertDescription>
        </Alert>
      )}

      {/* Complete Session button */}
      <Button
        onClick={handleComplete}
        disabled={completing}
        className="w-full"
        size="lg"
      >
        {completing ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Completing session...
          </>
        ) : (
          'Complete Session'
        )}
      </Button>
    </div>
  )
}
