import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ClipboardList,
  Search,
  Plus,
  RefreshCw,
  ChevronRight,
  Loader2,
  Trash2,
  ScanLine,
  Microscope,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import {
  listSamplePreps,
  getWizardSession,
  updateSamplePrep,
  deleteSamplePrep,
  scanSamplePrepsHplc,
  type SamplePrep,
  type HplcScanMatch,
  type HplcScanLogLine,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { useWizardStore } from '@/store/wizard-store'
import { SamplePrepHplcFlyout } from './SamplePrepHplcFlyout'

// ─── Status definitions ───────────────────────────────────────────────────────

const STATUSES: { value: string; label: string; cls: string }[] = [
  { value: 'awaiting_hplc',  label: 'Awaiting HPLC',  cls: 'bg-blue-600 text-white' },
  { value: 'hplc_complete',  label: 'HPLC Complete',  cls: 'bg-teal-600 text-white' },
  { value: 'completed',      label: 'Completed',      cls: 'bg-green-600 text-white' },
  { value: 'on_hold',        label: 'On Hold',        cls: 'bg-amber-500 text-white' },
  { value: 'review',         label: 'Review',         cls: 'bg-purple-600 text-white' },
]

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtNum(val: number | null, decimals = 2, unit = '') {
  if (val == null) return '—'
  return `${val.toFixed(decimals)}${unit ? ' ' + unit : ''}`
}

// ─── Scan console component ───────────────────────────────────────────────────

type ScanPhase = 'idle' | 'running' | 'done' | 'error'

interface ScanConsoleProps {
  phase: ScanPhase
  logs: HplcScanLogLine[]
  progress: { current: number; total: number } | null
  matchCount: number
  onClose: () => void
}

function ScanConsole({ phase, logs, progress, matchCount, onClose }: ScanConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dotFrame, setDotFrame] = useState(0)

  useEffect(() => {
    if (phase !== 'running') return
    const id = setInterval(() => setDotFrame(f => (f + 1) % 5), 280)
    return () => clearInterval(id)
  }, [phase])

  useEffect(() => {
    // Auto-scroll to bottom
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  const dots = ['·', '··', '···', '····', '·····'][dotFrame]
  const colorForLevel = (level: HplcScanLogLine['level']) => ({
    info:    'text-zinc-300',
    dim:     'text-zinc-600',
    warn:    'text-amber-400',
    success: 'text-emerald-400',
    error:   'text-red-400',
  })[level]

  return (
    <div className="rounded-lg overflow-hidden border border-zinc-800/80 shadow-2xl shadow-black/90 select-none">
      {/* Title bar */}
      <div className="bg-zinc-900 border-b border-zinc-800/80 px-3 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex gap-1.5 shrink-0">
            <div className={cn('w-2.5 h-2.5 rounded-full transition-colors',
              phase === 'error' ? 'bg-red-500' : 'bg-zinc-700')} />
            <div className={cn('w-2.5 h-2.5 rounded-full transition-colors',
              phase === 'running' ? 'bg-amber-500/70 animate-pulse' : 'bg-zinc-700')} />
            <div className={cn('w-2.5 h-2.5 rounded-full transition-colors',
              phase === 'done' ? 'bg-emerald-500' : 'bg-zinc-700')} />
          </div>
          <span className="text-[11px] text-zinc-500 font-mono truncate">
            <span className="text-zinc-600">$</span> accumark scan-hplc
          </span>
        </div>
        {phase !== 'running' && (
          <button
            onClick={onClose}
            className="shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Progress bar */}
      {progress && progress.total > 0 && (
        <div className="bg-zinc-950 px-3 pt-2">
          <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            />
          </div>
          <p className="text-zinc-600 font-mono text-[10px] mt-1 mb-0">
            {progress.current}/{progress.total} preps scanned
          </p>
        </div>
      )}

      {/* Log lines */}
      <div
        ref={scrollRef}
        className="bg-[#0d0d0d] px-3 py-3 space-y-1 max-h-52 overflow-y-auto"
      >
        {logs.map((line, i) => (
          <div key={i} className={cn('font-mono text-[11px] leading-tight', colorForLevel(line.level))}>
            {line.msg}
          </div>
        ))}
        {logs.length === 0 && (
          <div className="text-zinc-700 font-mono text-[11px]">Initialising{dots}</div>
        )}
      </div>

      {/* Footer */}
      <div className="bg-[#0a0a0a] border-t border-zinc-900 px-3 py-2 font-mono text-[10px] flex items-center justify-between">
        {phase === 'running' && (
          <span className="text-amber-400/50">scanning{dots}</span>
        )}
        {phase === 'done' && (
          <span className="text-emerald-500/70">
            ✓ scan complete — {matchCount} match{matchCount !== 1 ? 'es' : ''} found
          </span>
        )}
        {phase === 'error' && (
          <span className="text-red-400/70">✗ scan failed</span>
        )}
        {phase === 'idle' && <span />}
        {progress && progress.total > 0 && (
          <span className="text-zinc-700">
            {Math.round((progress.current / progress.total) * 100)}%
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SamplePreps() {
  const navigateTo = useUIStore(state => state.navigateTo)

  const [preps, setPreps] = useState<SamplePrep[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [openingId, setOpeningId] = useState<number | null>(null)
  const [updatingStatusId, setUpdatingStatusId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SamplePrep | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [standardFilter, setStandardFilter] = useState<'all' | 'standard' | 'production'>('all')

  // Scan state
  const [scanPhase, setScanPhase] = useState<ScanPhase>('idle')
  const [scanLogs, setScanLogs] = useState<HplcScanLogLine[]>([])
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | null>(null)
  const [scanMatches, setScanMatches] = useState<Map<number, HplcScanMatch>>(new Map())
  const [showConsole, setShowConsole] = useState(false)
  const cancelScanRef = useRef<(() => void) | null>(null)

  // Flyout state
  const [flyoutPrep, setFlyoutPrep] = useState<SamplePrep | null>(null)
  const [flyoutMatch, setFlyoutMatch] = useState<HplcScanMatch | null>(null)

  const load = useCallback(async (q?: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await listSamplePreps({
        search: q || undefined,
        is_standard: standardFilter === 'all' ? undefined : standardFilter === 'standard',
        limit: 100,
      })
      setPreps(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sample preps')
    } finally {
      setLoading(false)
    }
  }, [standardFilter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const t = setTimeout(() => { load(searchInput || undefined) }, 400)
    return () => clearTimeout(t)
  }, [searchInput, load])

  // ── Wizard open ─────────────────────────────────────────────────────────────

  async function openInWizard(prep: SamplePrep) {
    if (openingId != null) return
    if (!prep.wizard_session_id) {
      alert(`Sample prep ${prep.sample_id} has no linked wizard session to edit.`)
      return
    }
    setOpeningId(prep.id)
    try {
      const session = await getWizardSession(prep.wizard_session_id)
      useWizardStore.getState().startSession(session, prep.components_json ?? [])
      useWizardStore.getState().setCurrentStep(1)
      navigateTo('hplc-analysis', 'new-analysis')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wizard session')
    } finally {
      setOpeningId(null)
    }
  }

  // ── Status change ────────────────────────────────────────────────────────────

  async function changeStatus(prep: SamplePrep, newStatus: string) {
    setUpdatingStatusId(prep.id)
    try {
      const updated = await updateSamplePrep(prep.id, { status: newStatus })
      setPreps(prev => prev.map(p => p.id === prep.id ? { ...p, status: updated.status } : p))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status')
    } finally {
      setUpdatingStatusId(null)
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteSamplePrep(deleteTarget.id)
      setPreps(prev => prev.filter(p => p.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete sample prep'
      if (msg.includes('404')) {
        setPreps(prev => prev.filter(p => p.id !== deleteTarget.id))
        setDeleteTarget(null)
      } else {
        setError(msg)
      }
    } finally {
      setDeleting(false)
    }
  }

  // ── Scan HPLC ────────────────────────────────────────────────────────────────

  function startScan() {
    // Cancel any running scan
    cancelScanRef.current?.()
    setScanLogs([])
    setScanProgress(null)
    setScanMatches(new Map())
    setScanPhase('running')
    setShowConsole(true)

    const cancel = scanSamplePrepsHplc({
      onLog: (line) => setScanLogs(prev => [...prev, line]),
      onMatch: (match) => setScanMatches(prev => new Map(prev).set(match.prep_id, match)),
      onProgress: (current, total) => setScanProgress({ current, total }),
      onDone: (_matches) => setScanPhase('done'),
      onError: (msg) => {
        setScanLogs(prev => [...prev, { msg: `Error: ${msg}`, level: 'error' }])
        setScanPhase('error')
      },
    })
    cancelScanRef.current = cancel
  }

  function openFlyout(prep: SamplePrep, match: HplcScanMatch) {
    setFlyoutPrep(prep)
    setFlyoutMatch(match)
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 p-6 h-full">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" />
            Sample Preps
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Completed HPLC sample preparation records saved to Integration-Services.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => load(searchInput || undefined)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={scanPhase === 'running' ? undefined : startScan}
            disabled={scanPhase === 'running'}
            className="gap-1.5"
          >
            {scanPhase === 'running' ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Scanning...</>
            ) : (
              <><ScanLine className="h-4 w-4" /> Scan HPLC</>
            )}
          </Button>
          <Button size="sm" onClick={() => navigateTo('hplc-analysis', 'new-analysis')}>
            <Plus className="h-4 w-4 mr-1.5" />
            New Prep
          </Button>
        </div>
      </div>

      {/* Scan console — stays open until user closes it */}
      {scanPhase !== 'idle' && showConsole && (
        <ScanConsole
          phase={scanPhase}
          logs={scanLogs}
          progress={scanProgress}
          matchCount={scanMatches.size}
          onClose={() => setShowConsole(false)}
        />
      )}

      {/* Search + filter */}
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="sample-preps-search"
            placeholder="Search by ID, SENAITE ID, peptide…"
            className="pl-9"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
        </div>
        <select
          value={standardFilter}
          onChange={e => setStandardFilter(e.target.value as 'all' | 'standard' | 'production')}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">All Preps</option>
          <option value="standard">Standards Only</option>
          <option value="production">Production Only</option>
        </select>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Table */}
      {!error && (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Sample ID</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Peptide</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Declared Wt.</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Target Conc.</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actual Conc.</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created By</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && preps.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">Loading…</td>
                </tr>
              ) : preps.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    No sample preps found.{' '}
                    <button
                      className="underline text-primary"
                      onClick={() => navigateTo('hplc-analysis', 'new-analysis')}
                    >
                      Start a new prep
                    </button>
                    .
                  </td>
                </tr>
              ) : (
                preps.map(prep => {
                  const match = scanMatches.get(prep.id)
                  return (
                    <tr
                      key={prep.id}
                      className="border-b hover:bg-muted/40 cursor-pointer transition-colors"
                      onClick={() => openInWizard(prep)}
                    >
                      <td className="px-4 py-3 font-mono font-medium">{prep.senaite_sample_id ?? '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          {prep.peptide_abbreviation
                            ? <span className="font-medium">{prep.peptide_abbreviation}</span>
                            : <span className="text-muted-foreground">—</span>}
                          {prep.is_standard && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                              STD
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">{fmtNum(prep.declared_weight_mg, 2, 'mg')}</td>
                      <td className="px-4 py-3 text-right font-mono">{fmtNum(prep.target_conc_ug_ml, 1, 'µg/mL')}</td>
                      <td className="px-4 py-3 text-right font-mono">{fmtNum(prep.actual_conc_ug_ml, 2, 'µg/mL')}</td>

                      {/* Status selector */}
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <div className="relative">
                          {updatingStatusId === prep.id && (
                            <Loader2 className="absolute right-1 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground" />
                          )}
                          <select
                            value={prep.status}
                            disabled={updatingStatusId === prep.id}
                            onChange={e => changeStatus(prep, e.target.value)}
                            className="appearance-none rounded-full px-2 py-0.5 text-xs font-medium border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                            style={{
                              backgroundColor:
                                prep.status === 'awaiting_hplc'  ? 'rgb(37 99 235)'
                                : prep.status === 'hplc_complete' ? 'rgb(13 148 136)'
                                : prep.status === 'completed'     ? 'rgb(22 163 74)'
                                : prep.status === 'on_hold'       ? 'rgb(245 158 11)'
                                : prep.status === 'review'        ? 'rgb(147 51 234)'
                                : 'transparent',
                              color: 'white',
                            }}
                          >
                            {STATUSES.map(s => (
                              <option key={s.value} value={s.value} style={{ background: '#1f2937', color: 'white' }}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>

                      <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(prep.created_at)}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{prep.created_by_email ?? '—'}</td>

                      {/* Actions */}
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Process HPLC — shown when scan found a match */}
                          {match && (
                            <button
                              title="Process HPLC data"
                              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                              onClick={() => openFlyout(prep, match)}
                            >
                              <Microscope size={12} />
                              Process HPLC
                            </button>
                          )}
                          {openingId === prep.id
                            ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                          <button
                            title="Delete sample prep"
                            className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                            onClick={e => { e.stopPropagation(); setDeleteTarget(prep) }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {!loading && `${preps.length} record${preps.length !== 1 ? 's' : ''} shown`}
        {scanMatches.size > 0 && ` · ${scanMatches.size} HPLC match${scanMatches.size !== 1 ? 'es' : ''} found`}
      </p>

      {/* HPLC Processing flyout */}
      {flyoutPrep && flyoutMatch && (
        <SamplePrepHplcFlyout
          open={true}
          onClose={() => { setFlyoutPrep(null); setFlyoutMatch(null) }}
          prep={flyoutPrep}
          match={flyoutMatch}
        />
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-background border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="shrink-0 w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center">
                <Trash2 className="h-5 w-5 text-red-500" />
              </div>
              <div>
                <h2 className="font-semibold text-base">Delete Sample Prep?</h2>
                <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm mb-6">
              You are about to permanently delete{' '}
              <span className="font-mono font-semibold">{deleteTarget.sample_id}</span>.
            </p>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
                {deleting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Deleting…</> : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
