/**
 * StandardCurveReview
 *
 * Displays concentration/area data from a standard prep's HPLC scan,
 * computes a preview linear regression, and allows the user to create
 * a calibration curve via the from-standard endpoint.
 */

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import { CheckCircle2, AlertTriangle, TrendingUp } from 'lucide-react'
import {
  createCalibrationFromStandard,
  type CalibrationCurve,
} from '@/lib/api'

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface StandardCurveReviewProps {
  peptideId: number
  samplePrepId: string
  concentrations: number[]
  areas: number[]
  rts: number[]
  chromatogramData?: { times: number[]; signals: number[] }
  sharepointFolder?: string
  vendor?: string
  notes?: string
  instrument?: string
  onCurveCreated: (curve: CalibrationCurve) => void
}

// ─── Linear regression (preview only) ───────────────────────────────────────────

function linearRegression(xs: number[], ys: number[]) {
  const n = xs.length
  if (n < 2) return { slope: 0, intercept: 0, rSquared: 0 }

  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n

  let ssXY = 0
  let ssXX = 0
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx
    ssXY += dx * ((ys[i] ?? 0) - my)
    ssXX += dx * dx
  }

  const slope = ssXX !== 0 ? ssXY / ssXX : 0
  const intercept = my - slope * mx

  // R-squared
  let ssTot = 0
  let ssRes = 0
  for (let i = 0; i < n; i++) {
    const predicted = slope * (xs[i] ?? 0) + intercept
    ssRes += ((ys[i] ?? 0) - predicted) ** 2
    ssTot += ((ys[i] ?? 0) - my) ** 2
  }
  const rSquared = ssTot !== 0 ? 1 - ssRes / ssTot : 0

  return { slope, intercept, rSquared }
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function StandardCurveReview({
  peptideId,
  samplePrepId,
  concentrations,
  areas,
  rts,
  chromatogramData,
  sharepointFolder,
  vendor,
  notes,
  instrument,
  onCurveCreated,
}: StandardCurveReviewProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CalibrationCurve | null>(null)

  // Filter to valid data points (both concentration and area must be > 0)
  const validIndices: number[] = []
  for (let i = 0; i < concentrations.length; i++) {
    if ((concentrations[i] ?? 0) > 0 && (areas[i] ?? 0) > 0) {
      validIndices.push(i)
    }
  }

  const validConcs: number[] = validIndices.map(i => concentrations[i] ?? 0)
  const validAreas: number[] = validIndices.map(i => areas[i] ?? 0)
  const validRts: number[] = validIndices.map(i => rts[i] ?? 0)
  const nPoints = validConcs.length

  const tooFewPoints = nPoints < 3
  const reg = linearRegression(validConcs, validAreas)
  const lowR2 = reg.rSquared < 0.99

  const handleCreate = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const curve = await createCalibrationFromStandard(peptideId, {
        sample_prep_id: samplePrepId,
        concentrations: validConcs,
        areas: validAreas,
        rts: validRts,
        chromatogram_data: chromatogramData,
        source_sharepoint_folder: sharepointFolder,
        vendor,
        notes,
        instrument,
      })
      setCreated(curve)
      onCurveCreated(curve)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create calibration curve')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Success state ──

  if (created) {
    return (
      <Alert className="border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-950/20">
        <CheckCircle2 className="text-emerald-500" />
        <AlertTitle className="text-emerald-700 dark:text-emerald-400">
          Calibration Curve Created
        </AlertTitle>
        <AlertDescription>
          R-squared = {created.r_squared.toFixed(4)} with {nPoints} data points.
          Curve #{created.id} is now available for analysis.
        </AlertDescription>
      </Alert>
    )
  }

  // ── Error: too few data points ──

  if (tooFewPoints) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Insufficient Data</AlertTitle>
        <AlertDescription>
          Need at least 3 valid data points to create a calibration curve.
          Found {nPoints} valid point{nPoints !== 1 ? 's' : ''} from {concentrations.length} concentration level{concentrations.length !== 1 ? 's' : ''}.
        </AlertDescription>
      </Alert>
    )
  }

  // ── Main review panel ──

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <TrendingUp size={16} className="text-primary" />
            <CardTitle className="text-sm font-semibold">
              Calibration Curve Preview
            </CardTitle>
          </div>
          <Badge variant="outline" className="text-xs">
            {nPoints} data point{nPoints !== 1 ? 's' : ''}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Data table */}
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                  Concentration (ug/mL)
                </th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                  Peak Area
                </th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                  RT (min)
                </th>
              </tr>
            </thead>
            <tbody>
              {validIndices.map((idx, row) => (
                <tr
                  key={idx}
                  className={row < validIndices.length - 1 ? 'border-b border-border/50' : ''}
                >
                  <td className="px-3 py-1.5 font-mono text-sm">
                    {(concentrations[idx] ?? 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-sm text-right">
                    {(areas[idx] ?? 0).toFixed(1)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-sm text-right">
                    {(rts[idx] ?? 0).toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Regression stats */}
        <div className="rounded-md border border-border p-3 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Linear Regression (preview)
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">Slope</span>
            <span className="font-mono text-right">{reg.slope.toFixed(4)}</span>
            <span className="text-muted-foreground">Intercept</span>
            <span className="font-mono text-right">{reg.intercept.toFixed(4)}</span>
            <span className="text-muted-foreground">R-squared</span>
            <span className="font-mono text-right">{reg.rSquared.toFixed(4)}</span>
            <span className="text-muted-foreground">Points</span>
            <span className="font-mono text-right">{nPoints}</span>
          </div>

          {lowR2 && (
            <div className="flex items-center gap-2 mt-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle size={12} className="shrink-0" />
              <span>
                R-squared is below 0.99 — review data quality before creating curve.
              </span>
            </div>
          )}
        </div>

        {/* Provenance */}
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>Source: {samplePrepId}</p>
          {vendor && <p>Vendor: {vendor}</p>}
          {instrument && <p>Instrument: {instrument}</p>}
        </div>

        {/* Error */}
        {error && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Create button */}
        <Button
          onClick={handleCreate}
          disabled={submitting}
          className="w-full gap-2"
        >
          {submitting ? (
            <>
              <Spinner className="size-4" />
              Creating Curve...
            </>
          ) : (
            <>
              <TrendingUp size={15} />
              Create Calibration Curve
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  )
}
