import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Plus,
  Trash2,
  ChevronRight,
  FlaskConical,
  Loader2,
  AlertCircle,
  Cloud,
  X,
  Terminal,
  CheckCircle2,
  XCircle,
  Copy,
  Filter,
  RefreshCw,
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
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { PeptideForm } from './PeptideForm'
import { CalibrationPanel } from './CalibrationPanel'
import {
  getPeptides,
  deletePeptide,
  getMethods,
  getInstruments,
  updatePeptide,
  lookupSenaiteSample,
  type PeptideRecord,
  type HplcMethod,
  type Instrument,
  type AnalyteResponse,
} from '@/lib/api'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'  // getState() for peptide target navigation

interface LogLine {
  message: string
  level: 'info' | 'dim' | 'heading' | 'success' | 'warn' | 'error'
  timestamp: number
}

interface SeedProgress {
  current: number
  total: number
  phase: string
}

interface SeedDonePayload {
  success: boolean
  // Legacy seeder fields
  created?: number
  calibrations?: number
  skipped?: number
  total?: number
  // Import fields
  new_peptides?: number
  new_curves?: number
  skipped_cached?: number
  skipped_no_data?: number
  skipped_dup?: number
  error?: string
}

export function PeptideConfig() {
  const [peptides, setPeptides] = useState<PeptideRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [filterMode, setFilterMode] = useState<'all' | 'has_cal' | 'no_cal'>('all')

  // Methods + instruments for the method selector in slide-out
  const [allMethods, setAllMethods] = useState<HplcMethod[]>([])
  const [allInstruments, setAllInstruments] = useState<Instrument[]>([])
  const [savingMethodId, setSavingMethodId] = useState(false)

  // Flyout instrument tab — controls which instrument's curves + methods are shown
  const [flyoutInstrument, setFlyoutInstrument] = useState<string>('1290')

  // Resync dialog state
  const [resyncTarget, setResyncTarget] = useState<PeptideRecord | null>(null)
  const [resyncAnalyteId, setResyncAnalyteId] = useState<string>('')
  const [resyncSampleId, setResyncSampleId] = useState('')
  const [resyncSampleValidating, setResyncSampleValidating] = useState(false)
  const [resyncSampleValid, setResyncSampleValid] = useState<boolean | null>(null)
  const [resyncInstrument, setResyncInstrument] = useState<string>('1290')
  const resyncDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Streaming seed state
  const [seeding, setSeeding] = useState(false)
  const [seedLogs, setSeedLogs] = useState<LogLine[]>([])
  const [seedProgress, setSeedProgress] = useState<SeedProgress | null>(null)
  const [seedDone, setSeedDone] = useState<SeedDonePayload | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const loadPeptides = useCallback(async () => {
    try {
      setLoading(true)
      const data = await getPeptides()
      setPeptides(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load peptides')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPeptides()
    getMethods().then(setAllMethods).catch(console.error)
    getInstruments().then(setAllInstruments).catch(console.error)
  }, [loadPeptides])

  // Open flyout if navigated here with a target peptide ID
  useEffect(() => {
    const targetId = useUIStore.getState().peptideConfigTargetId
    if (targetId && peptides.length > 0) {
      const match = peptides.find(p => p.id === targetId)
      if (match) {
        setSelectedId(targetId)
      }
      // Clear the target so it doesn't re-trigger
      useUIStore.setState({ peptideConfigTargetId: null })
    }
  }, [peptides])

  // Smart auto-scroll: only scroll if user was already at/near the bottom
  useEffect(() => {
    const container = logContainerRef.current
    if (container) {
      // Threshold: 100px from bottom
      const isAtBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < 100
      
      // Also force scroll if it's the very first few logs
      const isStart = seedLogs.length < 5
      
      if (isAtBottom || isStart) {
        container.scrollTop = container.scrollHeight
      }
    }
  }, [seedLogs])

  const copyLogs = useCallback(() => {
    const text = seedLogs.map(l => l.message).join('\n')
    navigator.clipboard.writeText(text).catch(console.error)
  }, [seedLogs])

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await deletePeptide(id)
        if (selectedId === id) setSelectedId(null)
        await loadPeptides()
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to delete peptide'
        )
      }
    },
    [selectedId, loadPeptides]
  )

  const handleSeedStream = useCallback(async () => {
    setSeeding(true)
    setSeedLogs([])
    setSeedProgress(null)
    setSeedDone(null)
    setShowLogs(true)
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const token = getAuthToken()
      const response = await fetch(`${getApiBaseUrl()}/hplc/import-standards/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE events from buffer
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        let eventType = ''
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            eventData = line.slice(6)
          } else if (line === '' && eventType && eventData) {
            // Complete event
            try {
              const payload = JSON.parse(eventData)

              if (eventType === 'log') {
                setSeedLogs(prev => [...prev, {
                  message: payload.message,
                  level: payload.level || 'info',
                  timestamp: Date.now(),
                }])
              } else if (eventType === 'progress') {
                setSeedProgress({
                  current: payload.current,
                  total: payload.total,
                  phase: payload.phase,
                })
              } else if (eventType === 'done') {
                setSeedDone(payload)
              } else if (eventType === 'refresh') {
                loadPeptides()
              }
            } catch {
              // Skip malformed events
            }
            eventType = ''
            eventData = ''
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Seed stream failed')
        setSeedDone({ success: false, error: String(err) })
      }
    } finally {
      setSeeding(false)
      abortRef.current = null
      await loadPeptides()
    }
  }, [loadPeptides])

  const handleCancelSeed = useCallback(() => {
    abortRef.current?.abort()
    setSeeding(false)
  }, [])

  const openResyncDialog = useCallback((peptide: PeptideRecord, clearSampleId = false) => {
    setResyncTarget(peptide)
    // Pre-select first analyte if available
    const firstAnalyte = peptide.analytes?.[0]
    setResyncAnalyteId(firstAnalyte ? String(firstAnalyte.id) : '')
    setResyncSampleId(clearSampleId ? '' : (firstAnalyte?.sample_id || ''))
    setResyncSampleValid(null)
    setResyncSampleValidating(false)
    setResyncInstrument('1290')
  }, [])

  const closeResyncDialog = useCallback(() => {
    setResyncTarget(null)
    setResyncAnalyteId('')
    setResyncSampleId('')
    setResyncSampleValid(null)
    setResyncSampleValidating(false)
    setResyncInstrument('1290')
    if (resyncDebounceRef.current) clearTimeout(resyncDebounceRef.current)
  }, [])

  const handleResyncSampleIdChange = useCallback((value: string) => {
    setResyncSampleId(value)
    setResyncSampleValid(null)
    setResyncSampleValidating(false)
    if (resyncDebounceRef.current) clearTimeout(resyncDebounceRef.current)
    if (!value.trim()) return
    resyncDebounceRef.current = setTimeout(async () => {
      setResyncSampleValidating(true)
      try {
        await lookupSenaiteSample(value.trim())
        setResyncSampleValid(true)
      } catch {
        setResyncSampleValid(false)
      } finally {
        setResyncSampleValidating(false)
      }
    }, 600)
  }, [])

  const handleResyncPeptide = useCallback(async (peptideId: number, analyteId?: number, sampleId?: string, instrument?: string) => {
    setSeeding(true)
    setSeedLogs([])
    setSeedProgress(null)
    setSeedDone(null)
    setShowLogs(true)
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const token = getAuthToken()
      const params = new URLSearchParams()
      if (analyteId) params.set('analyte_id', String(analyteId))
      if (sampleId) params.set('sample_id', sampleId)
      if (instrument) params.set('instrument', instrument)
      const qs = params.toString()
      const url = `${getApiBaseUrl()}/hplc/peptides/${peptideId}/resync/stream${qs ? `?${qs}` : ''}`
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        let eventType = ''
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            eventData = line.slice(6)
          } else if (line === '' && eventType && eventData) {
            try {
              const payload = JSON.parse(eventData)
              if (eventType === 'log') {
                setSeedLogs(prev => [...prev, {
                  message: payload.message,
                  level: payload.level || 'info',
                  timestamp: Date.now(),
                }])
              } else if (eventType === 'progress') {
                setSeedProgress({
                  current: payload.current,
                  total: payload.total,
                  phase: payload.phase,
                })
              } else if (eventType === 'done') {
                setSeedDone(payload)
              } else if (eventType === 'refresh') {
                loadPeptides()
              }
            } catch {
              // Skip malformed events
            }
            eventType = ''
            eventData = ''
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Resync failed')
        setSeedDone({ success: false, error: String(err) })
      }
    } finally {
      setSeeding(false)
      abortRef.current = null
      await loadPeptides()
    }
  }, [loadPeptides])

  const handleResyncSubmit = useCallback(() => {
    if (!resyncTarget) return
    const analyteId = resyncAnalyteId ? parseInt(resyncAnalyteId, 10) : undefined
    const sampleId = resyncSampleId.trim() || undefined
    const instrument = resyncInstrument || undefined
    closeResyncDialog()
    handleResyncPeptide(resyncTarget.id, analyteId, sampleId, instrument)
  }, [resyncTarget, resyncAnalyteId, resyncSampleId, resyncInstrument, closeResyncDialog, handleResyncPeptide])

  const selectedPeptide = peptides.find(p => p.id === selectedId) ?? null

  const filteredPeptides = peptides.filter(p => {
    if (filterMode === 'has_cal') return !!p.active_calibration
    if (filterMode === 'no_cal') return !p.active_calibration
    return true
  })

  const noCalsCount = peptides.filter(p => !p.active_calibration).length

  const logLevelClass = (level: string) => {
    switch (level) {
      case 'success': return 'text-green-400'
      case 'error': return 'text-red-400'
      case 'warn': return 'text-yellow-400'
      case 'heading': return 'text-blue-400 font-semibold'
      case 'dim': return 'text-zinc-500'
      default: return 'text-zinc-300'
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Peptides
            </h1>
            <p className="text-muted-foreground">
              Manage peptides — analytes, methods, and calibration curves.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleSeedStream}
              disabled={seeding}
              className="gap-2"
            >
              {seeding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Cloud className="h-4 w-4" />
              )}
              {seeding ? 'Importing...' : 'Import Standards'}
            </Button>
            <Button onClick={() => setShowAddForm(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Add New Peptide
            </Button>
          </div>
        </div>

        {error && (
          <Card className="border-destructive">
            <CardContent className="flex items-center gap-2 pt-6">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <span className="text-sm text-destructive">{error}</span>
            </CardContent>
          </Card>
        )}

        {/* Live import log panel */}
        {showLogs && (
          <Card className="border-blue-500/50 bg-zinc-950">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-blue-400" />
                  <CardTitle className="text-sm text-zinc-200">
                    SharePoint Import
                    {seeding && (
                      <span className="ml-2 text-xs text-zinc-500 font-normal">
                        streaming...
                      </span>
                    )}
                  </CardTitle>
                </div>
                <div className="flex items-center gap-2">
                  {seedDone && (
                    seedDone.success ? (
                      <Badge variant="default" className="bg-green-600 gap-1 text-xs">
                        <CheckCircle2 className="h-3 w-3" />
                        Complete
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="gap-1 text-xs">
                        <XCircle className="h-3 w-3" />
                        Failed
                      </Badge>
                    )
                  )}
                  {seeding && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCancelSeed}
                      className="h-7 text-xs text-zinc-400 hover:text-white"
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={copyLogs}
                    className="h-7 text-xs text-zinc-400 hover:text-white"
                    title="Copy log to clipboard"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>

                  {!seeding && (
                    <button
                      type="button"
                      onClick={() => setShowLogs(false)}
                      className="rounded p-1 text-zinc-500 hover:text-zinc-300"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              {/* Progress bar */}
              {seedProgress && seedProgress.total > 0 && (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
                    <span>{seedProgress.phase}</span>
                    <span>{seedProgress.current}/{seedProgress.total}</span>
                  </div>
                  <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-300"
                      style={{ width: `${(seedProgress.current / seedProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </CardHeader>
            <CardContent>
              <div ref={logContainerRef} className="bg-zinc-900 rounded border border-zinc-800 max-h-72 overflow-auto overflow-x-hidden font-mono text-xs p-3 space-y-0.5">
                {seedLogs.map((log, i) => (
                  <div key={i} className={`${logLevelClass(log.level)} break-all`}>
                    {log.message}
                  </div>
                ))}
                {seeding && seedLogs.length === 0 && (
                  <div className="text-zinc-600 animate-pulse">Connecting to SharePoint...</div>
                )}
                <div ref={logEndRef} />
              </div>
              {/* Summary stats */}
              {seedDone?.success && (
                <div className="flex gap-4 mt-3 text-xs text-zinc-400">
                  <span>Created: <strong className="text-green-400">{seedDone.created}</strong></span>
                  <span>Calibrations: <strong className="text-green-400">{seedDone.calibrations}</strong></span>
                  <span>Skipped: <strong className="text-zinc-500">{seedDone.skipped}</strong></span>
                  <span>Total: <strong className="text-zinc-300">{seedDone.total}</strong></span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Add peptide form (Sheet overlay) */}
        <PeptideForm
          open={showAddForm}
          onSaved={() => {
            setShowAddForm(false)
            loadPeptides()
          }}
          onClose={() => setShowAddForm(false)}
        />

        <div>
          {/* Peptide List - Full Width */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Peptides</CardTitle>
                  <CardDescription>
                    {filteredPeptides.length} of {peptides.length} peptide{peptides.length !== 1 ? 's' : ''}
                    {filterMode !== 'all' && ' (filtered)'}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-1.5">
                  <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                  <select
                    value={filterMode}
                    onChange={e => setFilterMode(e.target.value as typeof filterMode)}
                    className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="all">All</option>
                    <option value="has_cal">Has Calibration</option>
                    <option value="no_cal">No Calibration{noCalsCount > 0 ? ` (${noCalsCount})` : ''}</option>
                  </select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : peptides.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
                  <FlaskConical className="h-8 w-8" />
                  <p className="text-sm">No peptides configured yet</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowAddForm(true)}
                  >
                    Add your first peptide
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Peptide</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Ref RT</TableHead>
                      <TableHead>Active Standard</TableHead>
                      <TableHead className="text-right">Run Date</TableHead>
                      <TableHead className="w-16"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPeptides.map(p => {
                      const calDate = p.active_calibration?.source_date || p.active_calibration?.created_at
                      return (
                        <TableRow
                          key={p.id}
                          className={
                            selectedId === p.id
                              ? 'bg-muted/50 cursor-pointer'
                              : 'cursor-pointer hover:bg-muted/30'
                          }
                          onClick={() => setSelectedId(p.id)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">
                                {p.abbreviation}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {p.name}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {p.methods.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {p.methods.map(m => (
                                  <Badge key={m.id} variant="outline" className="text-xs">
                                    {m.name}{m.instrument ? ` (${m.instrument.name})` : ''}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {p.active_calibration?.reference_rt != null
                              ? `${p.active_calibration.reference_rt.toFixed(3)} min`
                              : '—'}
                          </TableCell>
                          <TableCell>
                            {p.calibration_summary.length > 0 ? (
                              <div className="flex items-center gap-2 flex-wrap">
                                {p.calibration_summary.map(s => (
                                  <span key={s.instrument} className="flex items-center gap-1">
                                    <Badge variant="outline" className="text-xs font-mono border-blue-600/50 text-blue-400">
                                      {s.instrument}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground">
                                      {s.curve_count} curve{s.curve_count !== 1 ? 's' : ''}
                                    </span>
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <Badge variant="outline" className="text-xs border-yellow-600/50 text-yellow-500">
                                No Curve
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {calDate
                              ? new Date(calDate).toLocaleDateString('en-US', {
                                  month: 'short',
                                  day: 'numeric',
                                  year: 'numeric',
                                })
                              : '—'}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                title="Re-sync from SharePoint"
                                onClick={e => {
                                  e.stopPropagation()
                                  openResyncDialog(p)
                                }}
                                disabled={seeding}
                                className="rounded p-1 text-muted-foreground hover:text-blue-400 disabled:opacity-30"
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation()
                                  handleDelete(p.id)
                                }}
                                className="rounded p-1 text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Slide-out Sidebar Overlay */}
        {selectedPeptide && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 bg-black/40 z-40"
              onClick={() => setSelectedId(null)}
              style={{
                backdropFilter: 'blur(2px)',
                animation: 'fadeIn 0.2s ease-out',
              }}
            />
            {/* Sidebar Panel */}
            <div
              className="fixed top-0 right-0 h-full w-full max-w-7xl z-50 bg-zinc-950 border-l border-zinc-800 shadow-2xl overflow-y-auto"
              style={{
                animation: 'slideInRight 0.25s ease-out',
              }}
            >
              {/* Sticky header */}
              <div className="sticky top-0 z-10 bg-zinc-950/95 border-b border-zinc-800 backdrop-blur">
                <div className="flex items-center justify-between px-5 pt-4 pb-3">
                  <div>
                    <h3 className="text-base font-semibold">{selectedPeptide.abbreviation}</h3>
                    <p className="text-xs text-muted-foreground">{selectedPeptide.name}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-zinc-800 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {/* Instrument tabs */}
                <div className="flex items-center gap-0 px-5 pb-0">
                  <span className="text-xs font-medium text-muted-foreground mr-3 uppercase tracking-wider">Instrument</span>
                  {allInstruments.map(inst => {
                    const isActive = flyoutInstrument === inst.model
                    return (
                      <button
                        key={inst.id}
                        type="button"
                        onClick={() => setFlyoutInstrument(inst.model ?? '')}
                        className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                          isActive
                            ? 'text-foreground'
                            : 'text-muted-foreground hover:text-foreground/80'
                        }`}
                      >
                        {inst.name}
                        {isActive && (
                          <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
                        )}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => setFlyoutInstrument('unknown')}
                    className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                      flyoutInstrument === 'unknown'
                        ? 'text-amber-400'
                        : 'text-muted-foreground hover:text-foreground/80'
                    }`}
                  >
                    Unknown
                    {flyoutInstrument === 'unknown' && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-400 rounded-t" />
                    )}
                  </button>
                </div>
              </div>
              {/* Panel content — two-column layout */}
              <div className="p-5 flex gap-6">
                {/* Left column: Methods */}
                <div className="w-96 shrink-0">
                  <div className="rounded-lg border border-zinc-800 p-4 space-y-3 sticky top-18.25">
                    <h4 className="text-sm font-semibold text-muted-foreground">Method</h4>
                    {flyoutInstrument === 'unknown' && (
                      <div className="text-xs text-muted-foreground py-3 space-y-2">
                        <p>Curves with no instrument assigned.</p>
                        <p>Use the <span className="font-medium text-foreground">Edit</span> button on each curve to assign an instrument.</p>
                      </div>
                    )}
                    {allInstruments.filter(inst => inst.model === flyoutInstrument).map(inst => {
                      const methodsForInst = allMethods.filter(m => m.instrument_id === inst.id)
                      const assigned = selectedPeptide.methods.find(m => m.instrument_id === inst.id)
                      return (
                        <div key={inst.id} className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-muted-foreground">{inst.name}</label>
                            {assigned && (
                              <button
                                type="button"
                                className="text-xs text-primary hover:underline"
                                onClick={() => useUIStore.getState().navigateToMethod(assigned.id)}
                              >
                                View Method
                              </button>
                            )}
                          </div>
                          <select
                            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            value={assigned?.id ?? ''}
                            disabled={savingMethodId}
                            onChange={async (e) => {
                              const newMethodId = e.target.value ? parseInt(e.target.value, 10) : null
                              const otherMethodIds = selectedPeptide.methods
                                .filter(m => m.instrument_id !== inst.id)
                                .map(m => m.id)
                              const methodIds = newMethodId
                                ? [...otherMethodIds, newMethodId]
                                : otherMethodIds
                              setSavingMethodId(true)
                              try {
                                await updatePeptide(selectedPeptide.id, { method_ids: methodIds })
                                await loadPeptides()
                                getMethods().then(setAllMethods).catch(console.error)
                              } catch {
                                setError('Failed to update method')
                              } finally {
                                setSavingMethodId(false)
                              }
                            }}
                          >
                            <option value="">No method assigned</option>
                            {methodsForInst.map(m => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                          </select>
                          {assigned && (() => {
                            const m = allMethods.find(x => x.id === assigned.id)
                            if (!m) return null
                            return (
                              <div className="mt-3 space-y-3">
                                <div className="text-sm font-medium">{m.name}</div>
                                {m.senaite_id && (
                                  <div className="text-xs text-muted-foreground font-mono">{m.senaite_id}</div>
                                )}
                                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
                                  <div>
                                    <span className="text-muted-foreground">Instrument</span>
                                    <p className="font-medium mt-0.5">{inst.name}</p>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Size Peptide</span>
                                    <p className="font-medium mt-0.5">{m.size_peptide ?? '—'}</p>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Starting Organic</span>
                                    <p className="font-medium mt-0.5">{m.starting_organic_pct != null ? `${m.starting_organic_pct}%` : '—'}</p>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">MCT Temp</span>
                                    <p className="font-medium mt-0.5">{m.temperature_mct_c != null ? `${m.temperature_mct_c}°C` : '—'}</p>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Dissolution</span>
                                    <p className="font-medium mt-0.5">{m.dissolution ?? '—'}</p>
                                  </div>
                                </div>
                                {m.notes && (
                                  <div className="text-xs">
                                    <span className="text-muted-foreground">Notes:</span>
                                    <p className="mt-0.5 text-muted-foreground/80 italic">{m.notes}</p>
                                  </div>
                                )}
                                {m.common_peptides.length > 0 && (
                                  <div className="text-xs border-t border-zinc-800 pt-2">
                                    <span className="text-muted-foreground">Common Peptides ({m.common_peptides.length})</span>
                                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                                      {m.common_peptides.map(cp => (
                                        <Badge key={cp.id} variant="outline" className="text-[10px] font-normal">
                                          {cp.abbreviation}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          })()}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Right column: Calibration Curves */}
                <div className="flex-1 min-w-0">
                  <CalibrationPanel
                    peptide={selectedPeptide}
                    onUpdated={loadPeptides}
                    instrumentFilter={flyoutInstrument}
                    onImport={() => openResyncDialog(selectedPeptide, true)}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {/* Resync dialog — pick analyte + sample ID before importing */}
        <Dialog open={!!resyncTarget} onOpenChange={v => { if (!v) closeResyncDialog() }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Import Curves — {resyncTarget?.abbreviation}</DialogTitle>
              <DialogDescription>
                Select the analyte and enter the Senaite sample ID for this import.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4 py-2">
              <div className="space-y-2">
                <Label>Analyte</Label>
                <Select value={resyncAnalyteId} onValueChange={setResyncAnalyteId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select analyte..." />
                  </SelectTrigger>
                  <SelectContent>
                    {resyncTarget?.analytes?.map((a: AnalyteResponse) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        Slot {a.slot}: {a.peptide_name || a.service_title || `Service #${a.analysis_service_id}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Sample ID</Label>
                <div className="relative">
                  <Input
                    placeholder="e.g., P-0203"
                    value={resyncSampleId}
                    onChange={e => handleResyncSampleIdChange(e.target.value)}
                    className="pr-8"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2">
                    {resyncSampleValidating && (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                    {!resyncSampleValidating && resyncSampleValid === true && (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    )}
                    {!resyncSampleValidating && resyncSampleValid === false && (
                      <XCircle className="h-4 w-4 text-red-500" />
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  The Senaite sample ID for the standard reference vial.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Instrument</Label>
                <Select value={resyncInstrument} onValueChange={setResyncInstrument}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select instrument..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1290">Agilent 1290</SelectItem>
                    <SelectItem value="1260">Agilent 1260</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Which HPLC instrument produced this data.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={closeResyncDialog}>Cancel</Button>
              <Button onClick={handleResyncSubmit} disabled={!resyncAnalyteId}>
                <Cloud className="mr-2 h-4 w-4" />
                Import
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Keyframe animations */}
        <style>{`
          @keyframes slideInRight {
            from { transform: translateX(100%); }
            to { transform: translateX(0); }
          }
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `}</style>
      </div>
    </ScrollArea>
  )
}
