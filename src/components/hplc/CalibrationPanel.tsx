import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  ChevronDown,
  ChevronUp,
  Star,
  Clock,
  FileSpreadsheet,
  ExternalLink,
  Pencil,
  Check,
  X,
  Trash2,
  Cloud,
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  updateCalibration,
  deleteCalibration,
  type PeptideRecord,
  type CalibrationCurve,
  type AnalyteResponse,
} from '@/lib/api'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'
import { toast } from 'sonner'

interface CalibrationPanelProps {
  peptide: PeptideRecord
  onUpdated: () => void
  instrumentFilter: string
  onImport?: () => void
}

export function CalibrationPanel({
  peptide,
  onUpdated,
  instrumentFilter,
  onImport,
}: CalibrationPanelProps) {
  const [allCalibrations, setAllCalibrations] = useState<CalibrationCurve[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)

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
          {onImport && (
            <Button variant="outline" size="sm" onClick={onImport} className="gap-1.5">
              <Cloud className="h-3.5 w-3.5" />
              Add Curve
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
                analytes={peptide.analytes}
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
                    analytes={peptide.analytes}
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
  peptideId,
  analytes,
  onUpdated,
}: {
  calibration: CalibrationCurve
  isExpanded: boolean
  onToggle: () => void
  onSetActive: (() => void) | undefined
  peptideId: number
  analytes: AnalyteResponse[]
  onUpdated: () => void
}) {
  const data = calibration.standard_data
  const displayDate = calibration.source_date || calibration.created_at
  const dateStr = new Date(displayDate).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  // Edit state
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editRt, setEditRt] = useState('')
  const [editTolerance, setEditTolerance] = useState('')
  const [editDensity, setEditDensity] = useState('')
  const [editInstrument, setEditInstrument] = useState('')
  const [editAnalyteId, setEditAnalyteId] = useState('')
  const [editNotes, setEditNotes] = useState('')

  const linkedAnalyte = analytes.find(a => a.id === calibration.peptide_analyte_id)

  const startEditing = () => {
    setEditRt(calibration.reference_rt != null ? String(calibration.reference_rt) : '')
    setEditTolerance(String(calibration.rt_tolerance))
    setEditDensity(String(calibration.diluent_density))
    setEditInstrument(calibration.instrument ?? '')
    setEditAnalyteId(calibration.peptide_analyte_id != null ? String(calibration.peptide_analyte_id) : '')
    setEditNotes(calibration.notes ?? '')
    setEditing(true)
  }

  const cancelEditing = () => {
    setEditing(false)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateCalibration(peptideId, calibration.id, {
        reference_rt: editRt ? parseFloat(editRt) : null,
        rt_tolerance: editTolerance ? parseFloat(editTolerance) : undefined,
        diluent_density: editDensity ? parseFloat(editDensity) : undefined,
        instrument: editInstrument || null,
        peptide_analyte_id: editAnalyteId ? parseInt(editAnalyteId, 10) : null,
        notes: editNotes.trim() || null,
      })
      setEditing(false)
      toast.success('Calibration updated')
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteCalibration(peptideId, calibration.id)
      toast.success('Calibration deleted')
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

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
              {linkedAnalyte && (
                <>
                  <span>•</span>
                  <span>{linkedAnalyte.peptide_name || linkedAnalyte.service_title}</span>
                </>
              )}
              {(calibration.source_sample_id || linkedAnalyte?.sample_id) && (() => {
                const sampleId = calibration.source_sample_id || linkedAnalyte?.sample_id
                return (
                  <>
                    <span>•</span>
                    <a
                      href={`/#senaite/sample-details?id=${sampleId}`}
                      className="font-mono hover:text-primary transition-colors"
                      onClick={e => e.stopPropagation()}
                    >
                      {sampleId}
                    </a>
                  </>
                )
              })()}
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
        <div className="flex items-center gap-1 shrink-0">
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
          {confirmDelete ? (
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <Button
                variant="destructive"
                size="sm"
                className="text-xs h-7 px-2"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Delete'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-1.5"
                onClick={() => setConfirmDelete(false)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={e => {
                e.stopPropagation()
                setConfirmDelete(true)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
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
          {/* Curve metadata — view or edit */}
          {editing ? (
            <div className="rounded-md bg-muted/50 p-4 space-y-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium">Edit Curve Settings</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-7 px-2" onClick={cancelEditing} disabled={saving}>
                    <X className="h-3.5 w-3.5 mr-1" />
                    Cancel
                  </Button>
                  <Button size="sm" className="h-7 px-2" onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                    Save
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Reference RT (min)</Label>
                  <Input
                    value={editRt}
                    onChange={e => setEditRt(e.target.value)}
                    placeholder="e.g., 3.520"
                    className="h-8 text-sm font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">RT Tolerance (min)</Label>
                  <Input
                    value={editTolerance}
                    onChange={e => setEditTolerance(e.target.value)}
                    placeholder="e.g., 0.50"
                    className="h-8 text-sm font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Diluent Density (mg/mL)</Label>
                  <Input
                    value={editDensity}
                    onChange={e => setEditDensity(e.target.value)}
                    placeholder="e.g., 997.1"
                    className="h-8 text-sm font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Instrument</Label>
                  <Select value={editInstrument} onValueChange={setEditInstrument}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1290">Agilent 1290</SelectItem>
                      <SelectItem value="1260">Agilent 1260</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Analyte</Label>
                  <Select value={editAnalyteId} onValueChange={setEditAnalyteId}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      {analytes.map(a => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          Slot {a.slot}: {a.peptide_name || a.service_title}
                          {a.sample_id ? ` (${a.sample_id})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Notes</Label>
                <textarea
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  placeholder="Optional notes about this curve..."
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-15 resize-y"
                  rows={2}
                />
              </div>
            </div>
          ) : (
            <div className="rounded-md bg-muted/50 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Curve Settings</span>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="text-muted-foreground text-xs">Analyte</span>
                    <span className="font-semibold text-base">
                      {linkedAnalyte
                        ? (linkedAnalyte.peptide_name || linkedAnalyte.service_title || `#${linkedAnalyte.analysis_service_id}`)
                        : '—'}
                    </span>
                  </div>
                  <span className="text-muted-foreground/40">|</span>
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="text-muted-foreground text-xs">Sample</span>
                    {(calibration.source_sample_id || linkedAnalyte?.sample_id) ? (
                      <a
                        href={`/#senaite/sample-details?id=${calibration.source_sample_id || linkedAnalyte?.sample_id}`}
                        className="font-mono font-semibold text-base hover:text-primary transition-colors"
                      >
                        {calibration.source_sample_id || linkedAnalyte?.sample_id}
                      </a>
                    ) : (
                      <span className="font-mono font-semibold text-base">—</span>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={startEditing}>
                    <Pencil className="h-3 w-3 mr-1" />
                    Edit
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-5 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground text-xs">Reference RT</span>
                  <p className="font-mono font-medium">
                    {calibration.reference_rt != null
                      ? `${calibration.reference_rt.toFixed(3)} min`
                      : 'Not set'}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">RT Tolerance</span>
                  <p className="font-mono font-medium">
                    ±{calibration.rt_tolerance.toFixed(2)} min
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Diluent Density</span>
                  <p className="font-mono font-medium">
                    {calibration.diluent_density.toFixed(1)} mg/mL
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Instrument</span>
                  <p className="font-mono font-medium">
                    {calibration.instrument ?? '—'}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Source Date</span>
                  <p className="font-mono font-medium">
                    {calibration.source_date
                      ? new Date(calibration.source_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      : '—'}
                  </p>
                </div>
              </div>
              {calibration.notes && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <span className="text-muted-foreground text-xs">Notes</span>
                  <p className="text-sm mt-0.5 whitespace-pre-wrap">{calibration.notes}</p>
                </div>
              )}
            </div>
          )}

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
