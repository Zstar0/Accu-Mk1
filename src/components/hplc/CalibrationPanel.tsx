import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  ChevronDown,
  ChevronUp,
  Star,
  Clock,
  FileSpreadsheet,
  ExternalLink,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
  getCalibrations,
  type PeptideRecord,
  type CalibrationCurve,
} from '@/lib/api'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'

interface CalibrationPanelProps {
  peptide: PeptideRecord
  onUpdated: () => void
}

export function CalibrationPanel({
  peptide,
  onUpdated,
}: CalibrationPanelProps) {
  const [allCalibrations, setAllCalibrations] = useState<CalibrationCurve[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [instrumentFilter, setInstrumentFilter] = useState<string>('1290')

  // Load all calibrations for this peptide
  const loadCalibrations = useCallback(async () => {
    try {
      setLoading(true)
      const cals = await getCalibrations(peptide.id)
      setAllCalibrations(cals)
      // Auto-expand the active one
      const active = cals.find(c => c.is_active)
      if (active && expandedId === null) {
        setExpandedId(active.id)
      }
    } catch (err) {
      console.error('Failed to load calibrations:', err)
    } finally {
      setLoading(false)
    }
  }, [peptide.id])

  useEffect(() => {
    loadCalibrations()
  }, [loadCalibrations])

  // Instruments in preferred order: 1290, 1260, unknown
  const instrumentOrder = ['1290', '1260', 'unknown']
  const instruments = instrumentOrder.filter(inst =>
    allCalibrations.some(c => (c.instrument ?? 'unknown') === inst)
  )
  const showFilter = instruments.length > 1

  const filteredCals = instrumentFilter === 'all'
    ? allCalibrations
    : allCalibrations.filter(c => (c.instrument ?? 'unknown') === instrumentFilter)

  const activeCals = filteredCals.filter(c => c.is_active)
  const inactiveCals = filteredCals.filter(c => !c.is_active)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">
              {peptide.abbreviation} — Calibration Curves
            </CardTitle>
            <CardDescription>
              {allCalibrations.length} curve{allCalibrations.length !== 1 ? 's' : ''} •{' '}
              {peptide.name}
            </CardDescription>
          </div>
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

        {/* Instrument filter — only shown when multiple instruments exist */}
        {!loading && showFilter && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Instrument:</span>
            {instruments.map(inst => (
              <button
                key={inst}
                onClick={() => setInstrumentFilter(inst)}
                className={`px-2 py-0.5 rounded text-xs font-mono border transition-colors ${
                  instrumentFilter === inst
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
                }`}
              >
                {inst === 'all' ? 'All' : inst}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading calibrations...
          </div>
        ) : allCalibrations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
            <p className="text-sm">No calibration curves yet</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Active calibrations — always shown first */}
            {activeCals.map(cal => (
              <CalibrationRow
                key={cal.id}
                calibration={cal}
                isExpanded={expandedId === cal.id}
                onToggle={() =>
                  setExpandedId(expandedId === cal.id ? null : cal.id)
                }
                onSetActive={undefined}
                peptideId={peptide.id}
                onUpdated={() => {
                  loadCalibrations()
                  onUpdated()
                }}
              />
            ))}

            {/* Previous calibrations */}
            {inactiveCals.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mt-2">
                  Previous Calibrations ({inactiveCals.length})
                </p>
                {inactiveCals.map(cal => (
                  <CalibrationRow
                    key={cal.id}
                    calibration={cal}
                    isExpanded={expandedId === cal.id}
                    onToggle={() =>
                      setExpandedId(expandedId === cal.id ? null : cal.id)
                    }
                    onSetActive={async () => {
                      try {
                        const response = await fetch(
                          `${getApiBaseUrl()}/peptides/${peptide.id}/calibrations/${cal.id}/activate`,
                          {
                            method: 'POST',
                            headers: getBearerHeadersForCal(),
                          }
                        )
                        if (response.ok) {
                          loadCalibrations()
                          onUpdated()
                        }
                      } catch (err) {
                        console.error('Failed to set active:', err)
                      }
                    }}
                    peptideId={peptide.id}
                    onUpdated={() => {
                      loadCalibrations()
                      onUpdated()
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}


function getBearerHeadersForCal(): Record<string, string> {
  const token = getAuthToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}


function CalibrationRow({
  calibration,
  isExpanded,
  onToggle,
  onSetActive,
}: {
  calibration: CalibrationCurve
  isExpanded: boolean
  onToggle: () => void
  onSetActive: (() => void) | undefined
  peptideId: number
  onUpdated: () => void
}) {
  const data = calibration.standard_data
  const displayDate = calibration.source_date || calibration.created_at
  const dateStr = new Date(displayDate).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div className={`rounded-md border ${calibration.is_active ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'}`}>
      {/* Header row — always visible */}
      <button
        className="flex items-center w-full gap-3 px-4 py-3 text-left hover:bg-accent/50 transition-colors rounded-md"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {calibration.is_active ? (
            <Star className="h-4 w-4 text-amber-500 fill-amber-500 shrink-0" />
          ) : (
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              {calibration.is_active && (
                <Badge variant="default" className="text-[10px] px-1.5 py-0">
                  Active
                </Badge>
              )}
              {calibration.instrument && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                  {calibration.instrument}
                </Badge>
              )}
              <span className="font-mono text-sm truncate">
                y = {calibration.slope.toFixed(4)}x + {calibration.intercept.toFixed(4)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>R² = {calibration.r_squared.toFixed(6)}</span>
              <span>•</span>
              <span>{dateStr}</span>
            </div>
            {calibration.source_filename && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {calibration.sharepoint_url ? (
                  <a
                    href={calibration.sharepoint_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 hover:text-primary transition-colors"
                    onClick={e => e.stopPropagation()}
                    title="Open in SharePoint"
                  >
                    <FileSpreadsheet className="h-3 w-3 shrink-0" />
                    <span className="truncate">{calibration.source_filename}</span>
                    <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                  </a>
                ) : (
                  <span className="flex items-center gap-1">
                    <FileSpreadsheet className="h-3 w-3" />
                    {calibration.source_filename}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onSetActive && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7 px-2"
              onClick={e => {
                e.stopPropagation()
                onSetActive()
              }}
            >
              <Star className="h-3 w-3 mr-1" />
              Set Active
            </Button>
          )}
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="px-4 pb-4 flex flex-col gap-4 border-t pt-4">
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
              <p className="mb-2 text-sm font-medium">
                Standard Data ({data.concentrations.length} points)
              </p>
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
      )}
    </div>
  )
}
