/**
 * StandardCurveReview
 *
 * Displays concentration/area data from a standard prep's HPLC scan,
 * computes a preview linear regression, and allows the user to create
 * a calibration curve via the from-standard endpoint.
 *
 * After creation, renders the full curve display (chart + settings + data)
 * matching the CalibrationPanel expanded-row layout on the peptide page.
 */

import { useState } from 'react'
import { useUIStore } from '@/store/ui-store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import { CheckCircle2, AlertTriangle, TrendingUp, Star } from 'lucide-react'
import { CalibrationChart } from './CalibrationChart'
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
  readOnly?: boolean
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

// ─── Created Curve Display ───────────────────────────────────────────────────────
// Matches the CalibrationPanel expanded-row layout from the peptide page

function CreatedCurveDisplay({
  curve,
  peptideId,
  samplePrepId,
  nPoints,
}: {
  curve: CalibrationCurve
  peptideId: number
  samplePrepId: string
  nPoints: number
}) {
  const navigateToPeptide = useUIStore(state => state.navigateToPeptide)
  const data = curve.standard_data
  const dateStr = curve.source_date
    ? new Date(curve.source_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : new Date(curve.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })

  return (
    <Card className="border-primary/40 bg-primary/5">
      {/* Success header */}
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-500" />
            <CardTitle className="text-sm font-semibold text-emerald-400">
              Calibration Curve Created
            </CardTitle>
          </div>
          <button
            className="text-xs underline font-medium hover:no-underline text-primary"
            onClick={() => navigateToPeptide(peptideId)}
          >
            View peptide →
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Equation header — matches CalibrationPanel row */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="default" className="text-[10px] px-1.5 py-0">
            <Star className="h-3 w-3 mr-0.5 fill-current" />
            Active
          </Badge>
          {curve.instrument && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
              {curve.instrument}
            </Badge>
          )}
          <span className="font-mono text-sm">
            y = {curve.slope.toFixed(4)}x + {curve.intercept.toFixed(4)}
          </span>
          <span className="text-xs text-muted-foreground ml-1">
            R² = {curve.r_squared.toFixed(6)} • {dateStr}
          </span>
        </div>

        {/* Curve settings — matches CalibrationPanel settings row */}
        <div className="rounded-md bg-muted/50 p-3">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Curve Settings
          </span>
          <div className="grid grid-cols-5 gap-4 text-sm mt-2">
            <div>
              <span className="text-muted-foreground text-xs">Reference RT</span>
              <p className="font-mono font-medium">
                {curve.reference_rt != null
                  ? `${curve.reference_rt.toFixed(3)} min`
                  : 'Not set'}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">RT Tolerance</span>
              <p className="font-mono font-medium">
                ±{curve.rt_tolerance.toFixed(2)} min
              </p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Diluent Density</span>
              <p className="font-mono font-medium">
                {curve.diluent_density.toFixed(1)} mg/mL
              </p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Instrument</span>
              <p className="font-mono font-medium">
                {curve.instrument ?? '—'}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Source Date</span>
              <p className="font-mono font-medium">{dateStr}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border/50 text-sm">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-xs">Sample</span>
              <span className="font-mono font-semibold">{samplePrepId}</span>
            </div>
            <span className="text-muted-foreground/40">|</span>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-xs">Points</span>
              <span className="font-mono font-semibold">{nPoints}</span>
            </div>
            {curve.vendor && (
              <>
                <span className="text-muted-foreground/40">|</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">Vendor</span>
                  <span className="font-medium">{curve.vendor}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Chart — same component as CalibrationPanel */}
        {data && data.concentrations.length > 0 && (
          <CalibrationChart
            concentrations={data.concentrations}
            areas={data.areas}
            slope={curve.slope}
            intercept={curve.intercept}
          />
        )}

        {/* Standard data table */}
        {data && data.concentrations.length > 0 && (
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground w-12">#</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    Conc (µg/mL)
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    Area
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.concentrations.map((conc, i) => (
                  <tr
                    key={i}
                    className={i < data.concentrations.length - 1 ? 'border-b border-border/50' : ''}
                  >
                    <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                      {i + 1}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-sm text-right">
                      {conc.toFixed(4)}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-sm text-right">
                      {data.areas[i] != null ? data.areas[i].toFixed(4) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {curve.notes && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Notes:</span> {curve.notes}
          </div>
        )}
      </CardContent>
    </Card>
  )
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
  readOnly = false,
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

  // ── Success state — full curve display ──

  if (created) {
    return (
      <CreatedCurveDisplay
        curve={created}
        peptideId={peptideId}
        samplePrepId={samplePrepId}
        nPoints={nPoints}
      />
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

  // ── Main review panel (pre-creation) ──

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
        {/* Equation + R² preview */}
        <div className="flex items-center gap-2 flex-wrap">
          {instrument && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
              {instrument}
            </Badge>
          )}
          <span className="font-mono text-sm">
            y = {reg.slope.toFixed(4)}x + {reg.intercept.toFixed(4)}
          </span>
          <span className="text-xs text-muted-foreground ml-1">
            R² = {reg.rSquared.toFixed(6)} • {nPoints} points • {samplePrepId}
          </span>
        </div>

        {/* Chart preview */}
        <CalibrationChart
          concentrations={validConcs}
          areas={validAreas}
          slope={reg.slope}
          intercept={reg.intercept}
        />

        {/* Data table */}
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground w-12">#</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                  Conc (µg/mL)
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
                  <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                    {row + 1}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-sm text-right">
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

        {lowR2 && (
          <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle size={12} className="shrink-0" />
            <span>
              R² is below 0.99 — review data quality before creating curve.
            </span>
          </div>
        )}

        {/* Error */}
        {error && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Create button — hidden in read-only */}
        {!readOnly && (
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
        )}
      </CardContent>
    </Card>
  )
}
