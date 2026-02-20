import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { updateWizardSession } from '@/lib/api'
import { useWizardStore } from '@/store/wizard-store'

export function Step4Results() {
  const session = useWizardStore(state => state.session)

  const [peakAreaInput, setPeakAreaInput] = useState<string>(
    session?.peak_area != null ? String(session.peak_area) : ''
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  if (!session) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground">
            Complete previous steps to enter results.
          </p>
        </CardContent>
      </Card>
    )
  }

  const calcs = session.calculations
  const hasResults =
    session.peak_area != null && calcs?.determined_conc_ug_ml != null
  const hasPeakAreaSaved = session.peak_area != null

  // Missing calibration edge case: peak_area saved but no determined_conc
  const calcsMissing = hasPeakAreaSaved && calcs?.determined_conc_ug_ml == null

  const sessionId = session.id

  async function handleSave() {
    const parsed = parseFloat(peakAreaInput)
    if (isNaN(parsed) || parsed <= 0) {
      setSaveError('Please enter a valid peak area value.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const response = await updateWizardSession(sessionId, { peak_area: parsed })
      useWizardStore.getState().updateSession(response)
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Failed to save peak area'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Results Entry</h2>
      <p className="text-sm text-muted-foreground">
        Enter the peak area from the HPLC run.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Peak Area</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="peak-area">Peak Area</Label>
            <Input
              id="peak-area"
              type="number"
              step="0.01"
              placeholder="e.g. 150000"
              value={peakAreaInput}
              onChange={e => setPeakAreaInput(e.target.value)}
            />
          </div>

          {saveError && (
            <Alert variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}

          <Button onClick={handleSave} disabled={saving} className="w-full">
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : hasPeakAreaSaved ? (
              'Update Results'
            ) : (
              'Save Results'
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Missing calibration warning */}
      {calcsMissing && (
        <Alert variant="destructive">
          <AlertDescription>
            Results could not be calculated. Check calibration curve.
          </AlertDescription>
        </Alert>
      )}

      {/* Calculated results */}
      {hasResults && calcs && (
        <Card className="border-green-500/40 bg-green-50/30 dark:bg-green-950/10">
          <CardHeader>
            <CardTitle className="text-base text-green-700 dark:text-green-400">
              Calculated Results
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
              {calcs.determined_conc_ug_ml != null && (
                <div>
                  <span className="text-muted-foreground">
                    Determined Concentration
                  </span>
                  <p className="font-medium font-mono">
                    {calcs.determined_conc_ug_ml.toFixed(2)} ug/mL
                  </p>
                </div>
              )}
              {calcs.dilution_factor != null && (
                <div>
                  <span className="text-muted-foreground">Dilution Factor</span>
                  <p className="font-medium font-mono">
                    {calcs.dilution_factor.toFixed(2)}
                  </p>
                </div>
              )}
              {calcs.peptide_mass_mg != null && (
                <div>
                  <span className="text-muted-foreground">Peptide Mass</span>
                  <p className="font-medium font-mono">
                    {calcs.peptide_mass_mg.toFixed(4)} mg
                  </p>
                </div>
              )}
              {calcs.purity_pct != null && (
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
      )}
    </div>
  )
}
