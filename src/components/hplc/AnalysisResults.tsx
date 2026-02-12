import { useState } from 'react'
import {
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Code2,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { HPLCAnalysisResult } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { CalculationVisuals } from './CalculationVisuals'
import { ChromatogramChart, type ChromatogramTrace } from './ChromatogramChart'

interface AnalysisResultsProps {
  result: HPLCAnalysisResult
  chromatograms?: ChromatogramTrace[]
}

export function AnalysisResults({ result, chromatograms }: AnalysisResultsProps) {
  const [traceOpen, setTraceOpen] = useState(true)
  const [traceView, setTraceView] = useState<'visual' | 'json'>('visual')
  const navigateToPeptide = useUIStore(state => state.navigateToPeptide)

  return (
    <div className="flex flex-col gap-4">
      {/* Result Cards Grid */}
      <div className="grid gap-4 sm:grid-cols-3">
        {/* Purity */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Purity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-bold tabular-nums">
                {result.purity_percent != null
                  ? result.purity_percent.toFixed(2)
                  : '—'}
              </span>
              <span className="text-lg text-muted-foreground">%</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Average main peak Area%
            </p>
          </CardContent>
        </Card>

        {/* Quantity */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Quantity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-bold tabular-nums">
                {result.quantity_mg != null
                  ? result.quantity_mg.toFixed(2)
                  : '—'}
              </span>
              <span className="text-lg text-muted-foreground">mg</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              DF: {result.dilution_factor?.toFixed(2)}× | Stock:{' '}
              {result.stock_volume_ml?.toFixed(4)} mL
            </p>
          </CardContent>
        </Card>

        {/* Identity */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Identity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              {result.identity_conforms === true ? (
                <>
                  <CheckCircle2 className="h-7 w-7 text-green-600" />
                  <Badge
                    variant="default"
                    className="bg-green-600 text-lg font-bold"
                  >
                    CONFORMS
                  </Badge>
                </>
              ) : result.identity_conforms === false ? (
                <>
                  <XCircle className="h-7 w-7 text-destructive" />
                  <Badge variant="destructive" className="text-lg font-bold">
                    DOES NOT CONFORM
                  </Badge>
                </>
              ) : (
                <span className="text-lg text-muted-foreground">—</span>
              )}
            </div>
            {result.identity_rt_delta != null ? (
              <p className="mt-1 text-xs text-muted-foreground">
                RT delta: {result.identity_rt_delta.toFixed(4)} min | Peptide:{' '}
                {result.peptide_abbreviation}
              </p>
            ) : result.identity_conforms == null && (
              <button
                type="button"
                className="mt-1 text-xs text-amber-500 underline-offset-2 hover:underline text-left"
                onClick={() => navigateToPeptide(result.peptide_id)}
              >
                {(() => {
                  const trace = result.calculation_trace as { identity?: { error?: string } } | undefined
                  return trace?.identity?.error ?? 'No reference RT configured'
                })()}
                {' \u2192 Configure'}
              </button>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Summary line */}
      <div className="flex items-center gap-2 rounded-md bg-muted/50 px-4 py-2 text-sm">
        <span className="font-medium">{result.sample_id_label}</span>
        <span className="text-muted-foreground">|</span>
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => navigateToPeptide(result.peptide_id)}
        >
          {result.peptide_abbreviation}
        </button>
        <span className="text-muted-foreground">|</span>
        <span className="font-mono text-xs">
          Area: {result.avg_main_peak_area?.toFixed(2)} → Conc:{' '}
          {result.concentration_ug_ml?.toFixed(2)} µg/mL
        </span>
      </div>

      {/* Chromatogram */}
      {chromatograms && chromatograms.length > 0 && (
        <ChromatogramChart traces={chromatograms} />
      )}

      {/* Calculation Trace */}
      {result.calculation_trace && (
        <Card>
          <CardHeader className="pb-0">
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="flex items-center gap-2 text-left"
                onClick={() => setTraceOpen(!traceOpen)}
              >
                {traceOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                <CardTitle className="text-sm">Calculation Trace</CardTitle>
              </button>

              {traceOpen && (
                <div className="flex gap-1">
                  <Button
                    variant={traceView === 'visual' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => setTraceView('visual')}
                  >
                    <BarChart3 className="h-3.5 w-3.5" />
                    Charts
                  </Button>
                  <Button
                    variant={traceView === 'json' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => setTraceView('json')}
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    JSON
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          {traceOpen && (
            <CardContent className="pt-4">
              {traceView === 'visual' ? (
                <CalculationVisuals trace={result.calculation_trace} />
              ) : (
                <pre className="max-h-[400px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(result.calculation_trace, null, 2)}
                </pre>
              )}
            </CardContent>
          )}
        </Card>
      )}
    </div>
  )
}
