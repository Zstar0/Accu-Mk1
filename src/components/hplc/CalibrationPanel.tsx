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
import { ChromatogramChart, downsampleLTTB, type ChromatogramTrace } from './ChromatogramChart'
import {
  getCalibrations,
  getInstruments,
  updateCalibration,
  deleteCalibration,
  type PeptideRecord,
  type CalibrationCurve,
  type AnalyteResponse,
  type Instrument,
} from '@/lib/api'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'
import { toast } from 'sonner'

interface CalibrationPanelProps {
  peptide: PeptideRecord
  onUpdated: () => void
  instrumentFilter: string
  onImport?: () => void
  /** Increment to force a re-fetch of calibrations (e.g. after creating a new curve). */
  refreshKey?: number
}

export function CalibrationPanel({
  peptide,
  onUpdated,
  instrumentFilter,
  onImport,
  refreshKey,
}: CalibrationPanelProps) {
  const [allCalibrations, setAllCalibrations] = useState<CalibrationCurve[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [instruments, setInstruments] = useState<Instrument[]>([])

  // Load instruments once
  useEffect(() => {
    getInstruments().then(setInstruments).catch(console.error)
  }, [])

  // Reset expanded state when switching to a different peptide
  useEffect(() => {
    setExpandedId(null)
  }, [peptide.id])

  // Load all calibrations for this peptide
  const loadCalibrations = useCallback(async () => {
    try {
      setLoading(true)
      const cals = await getCalibrations(peptide.id)
      setAllCalibrations(cals)
      // Auto-expand the active curve (or first if none active)
      const active = cals.find(c => c.is_active) ?? cals[0]
      if (active) {
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
  }, [loadCalibrations, refreshKey])

  const filteredCals = instrumentFilter === 'all'
    ? allCalibrations
    : instrumentFilter === 'unknown'
      ? allCalibrations.filter(c => c.instrument_id == null)
      : allCalibrations.filter(c => c.instrument_id === Number(instrumentFilter))

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
                instruments={instruments}
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
                    instruments={instruments}
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


// ─── Standard Chromatogram Viewer ────────────────────────────────────────────

function StandardChromatogramViewer({
  chromData,
  sampleId,
  referenceRt,
}: {
  chromData: Record<string, unknown>
  sampleId: string | null
  referenceRt: number | null
}) {
  // Detect format: old single-trace {times, signals} vs new multi-conc {"1": {times, signals}, ...}
  const isSingleTrace = Array.isArray((chromData as Record<string, unknown>).times)

  const concEntries: { label: string; sortKey: number; times: number[]; signals: number[] }[] = []

  if (isSingleTrace) {
    const d = chromData as { times: number[]; signals: number[] }
    concEntries.push({ label: 'Standard', sortKey: 0, times: d.times, signals: d.signals })
  } else {
    for (const [key, val] of Object.entries(chromData)) {
      const v = val as { times?: number[]; signals?: number[] }
      if (v?.times?.length) {
        const num = parseFloat(key)
        concEntries.push({
          label: `${key} µg/mL`,
          sortKey: isNaN(num) ? 0 : num,
          times: v.times,
          signals: v.signals ?? [],
        })
      }
    }
    concEntries.sort((a, b) => b.sortKey - a.sortKey) // highest conc first
  }

  const [selectedConc, setSelectedConc] = useState<string | 'all'>(
    concEntries.length > 1 ? 'all' : (concEntries[0]?.label ?? 'all')
  )

  if (concEntries.length === 0) return null

  // Build traces for current selection
  const traces: ChromatogramTrace[] = []
  if (selectedConc === 'all') {
    for (const entry of concEntries) {
      const raw: [number, number][] = entry.times.map((t, i) => [t, entry.signals[i] ?? 0])
      traces.push({ name: entry.label, points: downsampleLTTB(raw, 5000) })
    }
  } else {
    const entry = concEntries.find(e => e.label === selectedConc)
    if (entry) {
      const raw: [number, number][] = entry.times.map((t, i) => [t, entry.signals[i] ?? 0])
      traces.push({ name: entry.label, points: downsampleLTTB(raw, 5000) })
    }
  }

  const showTabs = concEntries.length > 1

  return (
    <div>
      <p className="mb-2 text-sm font-medium">
        Standard Chromatogram
        {sampleId && (
          <span className="text-muted-foreground font-normal ml-2">{sampleId}</span>
        )}
      </p>
      <div className={showTabs ? 'flex gap-3' : ''}>
        {/* Vertical concentration tabs */}
        {showTabs && (
          <div className="flex flex-col gap-0.5 shrink-0 pt-1">
            <button
              type="button"
              onClick={() => setSelectedConc('all')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors text-left ${
                selectedConc === 'all'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50'
              }`}
            >
              All
            </button>
            {concEntries.map(entry => (
              <button
                key={entry.label}
                type="button"
                onClick={() => setSelectedConc(entry.label)}
                className={`px-2.5 py-1 text-xs font-mono rounded-md border transition-colors text-left whitespace-nowrap ${
                  selectedConc === entry.label
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
        {/* Chart */}
        <div className="flex-1 min-w-0">
          <ChromatogramChart
            traces={traces}
            peakRTs={referenceRt != null ? [referenceRt] : undefined}
          />
        </div>
      </div>
    </div>
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
  instruments,
  onUpdated,
}: {
  calibration: CalibrationCurve
  isExpanded: boolean
  onToggle: () => void
  onSetActive: (() => void) | undefined
  peptideId: number
  analytes: AnalyteResponse[]
  instruments: Instrument[]
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
  const [editInstrumentId, setEditInstrumentId] = useState('')
  const [editAnalyteId, setEditAnalyteId] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editSourceSampleId, setEditSourceSampleId] = useState('')
  const [editVendor, setEditVendor] = useState('')
  const [editStdData, setEditStdData] = useState<{concs: string[], areas: string[], excluded: Set<number>} | null>(null)

  const linkedAnalyte = analytes.find(a => a.id === calibration.peptide_analyte_id)

  // Live regression from edit state (or fallback to saved values)
  const liveReg = (() => {
    if (!editing || !editStdData) return { slope: calibration.slope, intercept: calibration.intercept, r2: calibration.r_squared }
    const xs: number[] = [], ys: number[] = []
    const esd = editStdData
    esd.concs.forEach((c: string, i: number) => {
      if (esd.excluded.has(i)) return
      const x = parseFloat(c), y = parseFloat(esd.areas[i] ?? '0')
      if (!isNaN(x) && !isNaN(y)) { xs.push(x); ys.push(y) }
    })
    if (xs.length < 2) return { slope: calibration.slope, intercept: calibration.intercept, r2: calibration.r_squared }
    const n = xs.length
    const sx = xs.reduce((a, b) => a + b, 0)
    const sy = ys.reduce((a, b) => a + b, 0)
    const sxy = xs.reduce((a, x, i) => a + x * (ys[i] ?? 0), 0)
    const sxx = xs.reduce((a, x) => a + x * x, 0)
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    const intercept = (sy - slope * sx) / n
    // R² calculation
    const yMean = sy / n
    const ssTot = ys.reduce((a, y) => a + (y - yMean) ** 2, 0)
    const ssRes = ys.reduce((a, y, i) => a + (y - (slope * xs[i]! + intercept)) ** 2, 0)
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0
    return { slope, intercept, r2 }
  })()

  const startEditing = () => {
    setEditRt(calibration.reference_rt != null ? String(calibration.reference_rt) : '')
    setEditTolerance(String(calibration.rt_tolerance))
    setEditDensity(String(calibration.diluent_density))
    setEditInstrumentId(calibration.instrument_id != null ? String(calibration.instrument_id) : '')
    setEditAnalyteId(calibration.peptide_analyte_id != null ? String(calibration.peptide_analyte_id) : '')
    setEditNotes(calibration.notes ?? '')
    setEditSourceSampleId(calibration.source_sample_id ?? '')
    setEditVendor(calibration.vendor ?? '')
    if (data && data.concentrations.length > 0) {
      setEditStdData({
        concs: data.concentrations.map(c => String(c)),
        areas: data.areas.map(a => String(a)),
        excluded: new Set(data.excluded_indices ?? []),
      })
    } else {
      setEditStdData(null)
    }
    setEditing(true)
  }

  const cancelEditing = () => {
    setEditing(false)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const updatePayload: Parameters<typeof updateCalibration>[2] = {
        reference_rt: editRt ? parseFloat(editRt) : null,
        rt_tolerance: editTolerance ? parseFloat(editTolerance) : undefined,
        diluent_density: editDensity ? parseFloat(editDensity) : undefined,
        instrument_id: editInstrumentId ? parseInt(editInstrumentId, 10) : null,
        peptide_analyte_id: editAnalyteId ? parseInt(editAnalyteId, 10) : null,
        notes: editNotes.trim() || null,
        source_sample_id: editSourceSampleId.trim() || null,
        vendor: editVendor.trim() || null,
      }
      if (editStdData) {
        updatePayload.standard_data = {
          concentrations: editStdData.concs.map(c => parseFloat(c) || 0),
          areas: editStdData.areas.map(a => parseFloat(a) || 0),
          rts: data?.rts ?? [],
          excluded_indices: Array.from(editStdData.excluded),
        }
      }
      await updateCalibration(peptideId, calibration.id, updatePayload)
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
                y = {liveReg.slope.toFixed(4)}x + {liveReg.intercept.toFixed(4)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>R² = {liveReg.r2.toFixed(6)}</span>
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
                  <Select value={editInstrumentId} onValueChange={setEditInstrumentId}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      {instruments.map(inst => (
                        <SelectItem key={inst.id} value={String(inst.id)}>
                          {inst.name}
                        </SelectItem>
                      ))}
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Source Sample ID</Label>
                  <Input
                    value={editSourceSampleId}
                    onChange={e => setEditSourceSampleId(e.target.value)}
                    placeholder="e.g., P-0111"
                    className="h-8 text-sm font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Vendor</Label>
                  <Input
                    value={editVendor}
                    onChange={e => setEditVendor(e.target.value)}
                    placeholder="e.g., Cayman, Targetmol"
                    className="h-8 text-sm"
                  />
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
              {calibration.vendor && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <span className="text-muted-foreground text-xs">Vendor</span>
                  <p className="text-sm mt-0.5 font-medium">{calibration.vendor}</p>
                </div>
              )}
              {calibration.notes && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <span className="text-muted-foreground text-xs">Notes</span>
                  <p className="text-sm mt-0.5 whitespace-pre-wrap">{calibration.notes}</p>
                </div>
              )}
            </div>
          )}

          {/* Chart — uses liveReg for live regression during editing */}
          {data && data.concentrations.length > 0 && (
            <CalibrationChart
              concentrations={editing && editStdData ? editStdData.concs.map(c => parseFloat(c) || 0) : data.concentrations}
              areas={editing && editStdData ? editStdData.areas.map(a => parseFloat(a) || 0) : data.areas}
              slope={liveReg.slope}
              intercept={liveReg.intercept}
              excludedIndices={editing && editStdData ? Array.from(editStdData.excluded) : data.excluded_indices}
            />
          )}

          {/* Standard chromatogram (from linked sample or backfill) */}
          {calibration.chromatogram_data && <StandardChromatogramViewer
            chromData={calibration.chromatogram_data}
            sampleId={calibration.source_sample_id}
            referenceRt={calibration.reference_rt}
          />}

          {/* Standard data table */}
          {data && data.concentrations.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium">
                Standard Data ({data.concentrations.length} points{data.excluded_indices?.length ? `, ${data.excluded_indices.length} excluded` : ''})
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead className="text-right">Conc (µg/mL)</TableHead>
                    <TableHead className="text-right">Area</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(editing && editStdData ? editStdData.concs : data.concentrations.map(String)).map((_, i) => {
                    const isExcluded = editing
                      ? editStdData?.excluded.has(i) ?? false
                      : data.excluded_indices?.includes(i) ?? false
                    return (
                      <TableRow key={i} className={isExcluded ? 'opacity-40' : ''}>
                        <TableCell className="p-1">
                          {editing ? (
                            <button
                              type="button"
                              className={`w-5 h-5 rounded border text-xs flex items-center justify-center cursor-pointer transition-colors ${
                                isExcluded
                                  ? 'border-zinc-600 bg-zinc-800 text-zinc-500'
                                  : 'border-green-500/50 bg-green-950/30 text-green-400'
                              }`}
                              onClick={() => {
                                if (!editStdData) return
                                const next = new Set(editStdData.excluded)
                                if (next.has(i)) next.delete(i)
                                else next.add(i)
                                setEditStdData({ ...editStdData, excluded: next })
                              }}
                              title={isExcluded ? 'Include this point' : 'Exclude this point'}
                            >
                              {isExcluded ? '—' : '✓'}
                            </button>
                          ) : (
                            isExcluded ? <span className="text-xs text-zinc-600">—</span> : null
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{i + 1}</TableCell>
                        <TableCell className="text-right font-mono">
                          {editing && editStdData ? (
                            <input
                              className="w-24 bg-transparent border-b border-zinc-700 text-right font-mono text-sm px-1 focus:outline-none focus:border-blue-500"
                              value={editStdData.concs[i]}
                              onChange={e => {
                                const next = [...editStdData.concs]
                                next[i] = e.target.value
                                setEditStdData({ ...editStdData, concs: next })
                              }}
                            />
                          ) : (
                            data.concentrations[i]?.toFixed(4)
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {editing && editStdData ? (
                            <input
                              className="w-24 bg-transparent border-b border-zinc-700 text-right font-mono text-sm px-1 focus:outline-none focus:border-blue-500"
                              value={editStdData.areas[i]}
                              onChange={e => {
                                const next = [...editStdData.areas]
                                next[i] = e.target.value
                                setEditStdData({ ...editStdData, areas: next })
                              }}
                            />
                          ) : (
                            data.areas[i] != null ? data.areas[i].toFixed(4) : '—'
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
