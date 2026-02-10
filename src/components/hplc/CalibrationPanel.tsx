import { useState, useCallback } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CalibrationChart } from './CalibrationChart'
import {
  createCalibration,
  type PeptideRecord,
  type CalibrationCurve,
} from '@/lib/api'

interface CalibrationPanelProps {
  peptide: PeptideRecord
  onUpdated: () => void
}

export function CalibrationPanel({
  peptide,
  onUpdated,
}: CalibrationPanelProps) {
  const cal = peptide.active_calibration
  const [showAddForm, setShowAddForm] = useState(false)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">
              {peptide.abbreviation} — Calibration
            </CardTitle>
            <CardDescription>{peptide.name}</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddForm(!showAddForm)}
            className="gap-1"
          >
            <Plus className="h-3.5 w-3.5" />
            {showAddForm ? 'Cancel' : 'New Calibration'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Peptide details */}
        <div className="grid grid-cols-3 gap-4 rounded-md bg-muted/50 p-3 text-sm">
          <div>
            <span className="text-muted-foreground">Reference RT</span>
            <p className="font-mono font-medium">
              {peptide.reference_rt != null
                ? `${peptide.reference_rt.toFixed(3)} min`
                : 'Not set'}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">RT Tolerance</span>
            <p className="font-mono font-medium">
              ±{peptide.rt_tolerance.toFixed(2)} min
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Diluent Density</span>
            <p className="font-mono font-medium">
              {peptide.diluent_density.toFixed(1)} mg/mL
            </p>
          </div>
        </div>

        {/* Add calibration form */}
        {showAddForm && (
          <CalibrationDataForm
            peptideId={peptide.id}
            onSaved={() => {
              setShowAddForm(false)
              onUpdated()
            }}
          />
        )}

        {/* Active calibration display */}
        {cal ? (
          <CalibrationDisplay calibration={cal} />
        ) : (
          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
            <p className="text-sm">No calibration curve yet</p>
            {!showAddForm && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddForm(true)}
              >
                Add calibration data
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CalibrationDisplay({
  calibration,
}: {
  calibration: CalibrationCurve
}) {
  const data = calibration.standard_data

  return (
    <div className="flex flex-col gap-4">
      {/* Equation display */}
      <div className="rounded-md border bg-card p-4">
        <div className="flex items-center gap-2">
          <Badge variant="default" className="text-xs">
            Active
          </Badge>
          {calibration.source_filename && (
            <span className="text-xs text-muted-foreground">
              from {calibration.source_filename}
            </span>
          )}
        </div>
        <p className="mt-2 font-mono text-lg">
          Area = {calibration.slope.toFixed(4)} × Conc +{' '}
          {calibration.intercept.toFixed(4)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          R² = {calibration.r_squared.toFixed(6)}
        </p>
      </div>

      {/* Chart */}
      {data && data.concentrations.length > 0 && (
        <CalibrationChart
          concentrations={data.concentrations}
          areas={data.areas}
          slope={calibration.slope}
          intercept={calibration.intercept}
        />
      )}

      {/* Standard data table */}
      {data && data.concentrations.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">Standard Data</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead className="text-right">Conc (µg/mL)</TableHead>
                <TableHead className="text-right">Area</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.concentrations.map((conc, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{i + 1}</TableCell>
                  <TableCell className="text-right font-mono">
                    {conc.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {data.areas[i] != null ? data.areas[i].toFixed(3) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function CalibrationDataForm({
  peptideId,
  onSaved,
}: {
  peptideId: number
  onSaved: () => void
}) {
  const [rows, setRows] = useState<{ conc: string; area: string }[]>([
    { conc: '', area: '' },
    { conc: '', area: '' },
    { conc: '', area: '' },
    { conc: '', area: '' },
    { conc: '', area: '' },
  ])
  const [sourceFilename, setSourceFilename] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateRow = useCallback(
    (index: number, field: 'conc' | 'area', value: string) => {
      setRows(prev => {
        const next = [...prev]
        const row = next[index]!
        next[index] = { conc: row.conc, area: row.area, [field]: value }
        return next
      })
    },
    []
  )

  const addRow = useCallback(() => {
    setRows(prev => [...prev, { conc: '', area: '' }])
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Filter to rows with both values
    const validRows = rows.filter(
      r => r.conc.trim() !== '' && r.area.trim() !== ''
    )
    if (validRows.length < 2) {
      setError('Need at least 2 data points')
      return
    }

    const concentrations = validRows.map(r => parseFloat(r.conc))
    const areas = validRows.map(r => parseFloat(r.area))

    if (concentrations.some(isNaN) || areas.some(isNaN)) {
      setError('All values must be valid numbers')
      return
    }

    setSaving(true)
    try {
      await createCalibration(peptideId, {
        concentrations,
        areas,
        source_filename: sourceFilename.trim() || undefined,
      })
      onSaved()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create calibration'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Enter Calibration Data</CardTitle>
        <CardDescription className="text-xs">
          Enter concentration (µg/mL) and peak area for each standard level
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="space-y-2">
            <Label className="text-xs">Source filename (optional)</Label>
            <Input
              placeholder="e.g., KPV_Calibration_Curve_1290.xlsx"
              value={sourceFilename}
              onChange={e => setSourceFilename(e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-xs">#</TableHead>
                <TableHead className="text-xs">Conc (µg/mL)</TableHead>
                <TableHead className="text-xs">Area</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{i + 1}</TableCell>
                  <TableCell className="p-1">
                    <Input
                      type="number"
                      step="any"
                      placeholder="998.83"
                      value={row.conc}
                      onChange={e => updateRow(i, 'conc', e.target.value)}
                      className="h-7 font-mono text-xs"
                    />
                  </TableCell>
                  <TableCell className="p-1">
                    <Input
                      type="number"
                      step="any"
                      placeholder="6060.778"
                      value={row.area}
                      onChange={e => updateRow(i, 'area', e.target.value)}
                      className="h-7 font-mono text-xs"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={addRow}
            className="self-start text-xs"
          >
            + Add row
          </Button>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button type="submit" size="sm" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {saving ? 'Calculating...' : 'Calculate & Save'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
