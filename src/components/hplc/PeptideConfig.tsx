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
import { ScrollArea } from '@/components/ui/scroll-area'
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
  type PeptideRecord,
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

  const handleResyncPeptide = useCallback(async (peptideId: number) => {
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
      const response = await fetch(`${getApiBaseUrl()}/hplc/peptides/${peptideId}/resync/stream`, {
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
              Peptide Standards
            </h1>
            <p className="text-muted-foreground">
              Manage peptide standard curves — vendor, lot, instrument, and calibration data.
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
              Add Peptide
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

        {/* Add peptide form */}
        {showAddForm && (
          <PeptideForm
            onSaved={() => {
              setShowAddForm(false)
              loadPeptides()
            }}
            onCancel={() => setShowAddForm(false)}
          />
        )}

        <div>
          {/* Peptide List - Full Width */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Peptide Standards</CardTitle>
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
                          <TableCell className="text-right font-mono text-sm">
                            {p.reference_rt != null
                              ? `${p.reference_rt.toFixed(3)} min`
                              : '—'}
                          </TableCell>
                          <TableCell>
                            {p.active_calibration ? (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Badge variant="default" className="text-xs">Active</Badge>
                                {p.active_calibration.instrument && (
                                  <Badge variant="outline" className="text-xs font-mono border-blue-600/50 text-blue-400">
                                    {p.active_calibration.instrument}
                                  </Badge>
                                )}
                                {p.active_calibration.vendor && (
                                  <span className="text-xs text-muted-foreground">{p.active_calibration.vendor}</span>
                                )}
                                {p.active_calibration.lot_number && (
                                  <span className="text-xs text-zinc-500">#{p.active_calibration.lot_number.replace(/^#/, '')}</span>
                                )}
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
                                  handleResyncPeptide(p.id)
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
              className="fixed top-0 right-0 h-full w-full max-w-3xl z-50 bg-zinc-950 border-l border-zinc-800 shadow-2xl overflow-y-auto"
              style={{
                animation: 'slideInRight 0.25s ease-out',
              }}
            >
              {/* Sticky header */}
              <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-zinc-950/95 border-b border-zinc-800 backdrop-blur">
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
              {/* Panel content */}
              <div className="p-5">
                <CalibrationPanel
                  peptide={selectedPeptide}
                  onUpdated={loadPeptides}
                />
              </div>
            </div>
          </>
        )}

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
