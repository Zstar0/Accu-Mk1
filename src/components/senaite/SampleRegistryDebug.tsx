/**
 * SampleRegistryDebug — admin diagnostic panel.
 * Terminal-styled Sheet (matches SampleActivityLog) showing the local
 * lims_samples registry record vs live SENAITE: existence, linkage, origin,
 * freshness, field-by-field agreement/drift, and vial-count sanity.
 */
import { useState, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { X, RefreshCw, RotateCw } from 'lucide-react'
import {
  getSampleRegistryDebug, refreshSampleRegistry, getSampleRegistryLog, getSampleRegistryParity,
  type SampleRegistryDebug as DebugData, type RegistryFieldStatus,
  type AnalysisSyncStatus, type SampleRegistryLog, type SampleParityResult,
} from '@/lib/api'
import { useReadSourceOverride } from '@/lib/read-source'

const statusGlyph: Record<RegistryFieldStatus, string> = {
  agree: '✔', drift: '⚠', registry_null: '○', senaite_null: '—',
}
const statusColor: Record<RegistryFieldStatus, string> = {
  agree: 'text-emerald-400', drift: 'text-amber-400',
  registry_null: 'text-zinc-500', senaite_null: 'text-zinc-500',
}

// Analyses column (Task 10): same visual vocabulary as the field-diff glyphs
// above — ✔ in-sync / ⚠ drift & shadow-only (both "something's off") / ○ no
// current shadow yet (expected pre-backfill).
const analysisStatusGlyph: Record<AnalysisSyncStatus, string> = {
  in_sync: '✔', drift: '⚠', shadow_only: '⚠', no_shadow: '○',
}
const analysisStatusColor: Record<AnalysisSyncStatus, string> = {
  in_sync: 'text-emerald-400', drift: 'text-amber-400',
  shadow_only: 'text-amber-400', no_shadow: 'text-zinc-500',
}

// Log tab: transition source badges — same colored-span vocabulary as the
// status glyphs above, keyed by the transition's `source` field.
const sourceColor: Record<string, string> = {
  mk1: 'text-emerald-400', senaite: 'text-sky-400', reconcile: 'text-amber-400',
  is_seed: 'text-zinc-500',
}

function val(v: unknown): string {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

interface Props { open: boolean; onClose: () => void; sampleId: string }

export function SampleRegistryDebug({ open, onClose, sampleId }: Props) {
  const [data, setData] = useState<DebugData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const { override: source, setOverride: setSource } = useReadSourceOverride('sample_details')
  const [tab, setTab] = useState<'overview' | 'log' | 'parity'>('overview')
  const [logData, setLogData] = useState<SampleRegistryLog | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [expandedTrajectory, setExpandedTrajectory] = useState<Set<number>>(new Set())
  const [parityData, setParityData] = useState<SampleParityResult | null>(null)
  const [parityLoading, setParityLoading] = useState(false)
  const [parityError, setParityError] = useState<string | null>(null)
  const [showEqual, setShowEqual] = useState(false)

  async function load() {
    setLoading(true); setError(null)
    try { setData(await getSampleRegistryDebug(sampleId)) }
    catch (e) { setError(e instanceof Error ? e.message : 'failed') }
    finally { setLoading(false) }
  }
  async function reconcile() {
    setLoading(true); setError(null)
    try { setData(await refreshSampleRegistry(sampleId)) }
    catch (e) { setError(e instanceof Error ? e.message : 'failed') }
    finally { setLoading(false) }
  }
  async function loadLog() {
    setLogLoading(true); setLogError(null)
    try { setLogData(await getSampleRegistryLog(sampleId)) }
    catch (e) { setLogError(e instanceof Error ? e.message : 'failed') }
    finally { setLogLoading(false) }
  }
  async function runParity() {
    setParityLoading(true); setParityError(null)
    try { setParityData(await getSampleRegistryParity(sampleId)) }
    catch (e) { setParityError(e instanceof Error ? e.message : 'failed') }
    finally { setParityLoading(false) }
  }
  function selectTab(t: 'overview' | 'log' | 'parity') {
    // flushSync: raw DOM .click() (used by this panel's tests) isn't
    // act()-wrapped, so React 18+ automatic batching would otherwise defer
    // the tab-switch commit to a microtask — a synchronous query for the
    // newly-revealed pane right after the click would see stale DOM.
    flushSync(() => setTab(t))
    if (t === 'log' && !logData && !logLoading) loadLog()
  }
  function toggleTrajectory(i: number) {
    setExpandedTrajectory(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i); else next.add(i)
      return next
    })
  }
  useEffect(() => {
    if (open && sampleId) load()
    setTab('overview')
    setLogData(null)
    setLogError(null)
    setExpandedTrajectory(new Set())
    setParityData(null)
    setParityError(null)
  }, [open, sampleId])

  const line = 'font-mono text-[12px] leading-relaxed whitespace-pre-wrap'
  const parityBtn = 'px-2 py-1 text-[10px] font-mono rounded border border-zinc-800 text-amber-400 '
    + 'hover:bg-amber-600/20 hover:text-amber-300 transition-colors disabled:opacity-30'

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent side="right" className="w-[1180px] max-w-[92vw] p-0 border-l-0 bg-transparent [&>button]:hidden sm:max-w-[min(1180px,92vw)]">
        <SheetHeader className="sr-only"><SheetTitle>Registry Debug — {sampleId}</SheetTitle></SheetHeader>
        <div className="m-3 flex flex-1 h-[calc(100%-24px)] flex-col rounded-lg overflow-hidden border border-zinc-800/80 shadow-2xl shadow-black/90">
          <div className="bg-zinc-900 border-b border-zinc-800/80 px-3 py-2 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex gap-1.5 shrink-0">
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              </div>
              <span className="text-[11px] text-zinc-500 font-mono truncate">
                <span className="text-zinc-600">$</span> accumark registry-inspect --sample {sampleId}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="flex items-center gap-0.5 rounded border border-zinc-800 p-0.5 mr-1">
                {(['senaite', 'mk1'] as const).map((s) => (
                  <button key={s} onClick={() => setSource(s)}
                    className={cn('px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors',
                      source === s ? 'bg-emerald-600/30 text-emerald-300' : 'text-zinc-600 hover:text-zinc-300')}>
                    {s === 'senaite' ? 'SENAITE' : 'Accu-Mk1'}
                  </button>
                ))}
              </div>
              <button onClick={reconcile} disabled={loading} title="force reconcile"
                className="text-amber-600/70 hover:text-amber-400 transition-colors disabled:opacity-30">
                <RotateCw size={12} />
              </button>
              <button
                onClick={() => { if (tab === 'overview') load(); else if (tab === 'log') loadLog() }}
                disabled={tab === 'parity' || (tab === 'overview' ? loading : logLoading)}
                className="text-zinc-600 hover:text-zinc-300 transition-colors disabled:opacity-30">
                <RefreshCw size={12} className={(tab === 'overview' ? loading : tab === 'log' && logLoading) ? 'animate-spin' : ''} />
              </button>
              <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                <X size={13} />
              </button>
            </div>
          </div>

          <div className="bg-[#0d0d0d] px-3 py-3 flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex items-center gap-0.5 rounded border border-zinc-800 p-0.5 w-fit mb-2 shrink-0">
              {(['overview', 'log', 'parity'] as const).map(t => (
                <button key={t} onClick={() => selectTab(t)}
                  className={cn('px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors',
                    tab === t ? 'bg-emerald-600/30 text-emerald-300' : 'text-zinc-600 hover:text-zinc-300')}>
                  {t}
                </button>
              ))}
            </div>

            {loading && !data && (
              <div className="flex items-center gap-2 py-8 justify-center">
                <Spinner className="size-3" />
                <span className="font-mono text-[11px] text-zinc-600">inspecting {sampleId}...</span>
              </div>
            )}
            {error && <div className="font-mono text-[11px] text-red-400 py-2">error: {error}</div>}

            {data && !data.load.exists && (
              <div className="font-mono text-[12px] text-amber-400 py-4">
                no registry record for {sampleId} — lims_samples row not created yet
              </div>
            )}

            {tab === 'overview' && data && data.load.exists && (
              <div className="flex-1 min-h-0 flex gap-3">
                {/* LEFT column: analysis line items (SENAITE vs shadow vs canonical) */}
                <div className="flex-[3] min-w-0 h-full overflow-y-auto pr-2 border-r border-zinc-900/80 space-y-1.5">
                  <div className="font-mono text-[11px] text-zinc-700 pb-1">{'─'.repeat(3)} analyses {'─'.repeat(30)}</div>
                  {data.analyses?.summary && (
                    <div className={cn(line, 'text-zinc-400')}>
                      {`analyses senaite=${data.analyses.summary.senaite} shadow=${data.analyses.summary.shadow} `
                        + `in_sync=${data.analyses.summary.in_sync} drift=${data.analyses.summary.drift} `
                        + `missing=${data.analyses.summary.missing}`}
                    </div>
                  )}
                  {data.analyses?.error && (
                    <div className={cn(line, 'text-red-400')}>analyses_error: {data.analyses.error}</div>
                  )}
                  {data.analyses?.rows.map(r => (
                    <div key={r.keyword} data-status={r.status}
                      className={cn('font-mono text-[12px] leading-relaxed flex gap-1.5', analysisStatusColor[r.status])}>
                      <span className={cn('shrink-0', analysisStatusColor[r.status])}>{analysisStatusGlyph[r.status]}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-zinc-300">
                          <span className="text-zinc-300">{r.keyword}</span>{'  '}
                          <span className="text-zinc-600">{r.title}</span>
                        </div>
                        <div className="text-zinc-500">
                          <span className="text-zinc-700">sen </span>
                          {r.senaite ? `${r.senaite.review_state ?? '∅'} ${r.senaite.result ?? '∅'}` : '∅'}
                        </div>
                        <div className="text-zinc-500">
                          <span className="text-zinc-700">sh  </span>
                          {r.shadow ? `${r.shadow.mirror_review_state ?? '∅'} ${r.shadow.result ?? '∅'}` : '∅'}
                        </div>
                        {r.canonical && (
                          <div className="text-zinc-700">
                            {`canon: ${r.canonical.review_state ?? '∅'} ${r.canonical.result ?? '∅'}`}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {data.analyses && data.analyses.rows.length === 0 && !data.analyses.error && (
                    <div className="font-mono text-[11px] text-zinc-600">no analysis lines</div>
                  )}

                  {/* Recent transitions (Task 8): compact tail under the analyses summary. */}
                  <div className="font-mono text-[11px] text-zinc-700 pt-2 pb-1 flex items-center gap-2">
                    <span>{'─'.repeat(3)} recent transitions {'─'.repeat(18)}</span>
                    {/* UAT fast-follow: log-vs-status sync glyph — same ✔/⚠ vocabulary
                        as the field-diff and analyses columns above. Null log_in_sync
                        (no rows logged yet) renders nothing. */}
                    {data.transitions?.log_in_sync === true && (
                      <span className="text-emerald-400">✔ log matches status</span>
                    )}
                    {data.transitions?.log_in_sync === false && (
                      <span className="text-amber-400">
                        {`⚠ log behind: latest '${data.transitions.latest_to_status}' ≠ status '${data.transitions.current_status}'`}
                      </span>
                    )}
                  </div>
                  {data.transitions?.error && (
                    <div className={cn(line, 'text-red-400')}>transitions_error: {data.transitions.error}</div>
                  )}
                  {data.transitions && data.transitions.rows.length > 0 && (
                    <div className="space-y-0.5">
                      {data.transitions.rows.map((t, i) => (
                        <div key={i} className="font-mono text-[11px] text-zinc-500 leading-relaxed">
                          <span className="text-zinc-300">{t.verb ?? '—'}</span>{'  '}
                          <span className="text-zinc-600">{t.from_status ?? '∅'} → {t.to_status}</span>{'  '}
                          <span className="text-zinc-700">·</span>{'  '}
                          <span className="text-zinc-600">{t.source}</span>{'  '}
                          <span className="text-zinc-700">·</span>{'  '}
                          <span className="text-zinc-600">{new Date(t.occurred_at).toLocaleTimeString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {data.transitions && data.transitions.rows.length === 0 && !data.transitions.error && (
                    <div className="font-mono text-[11px] text-zinc-600">no transitions logged yet</div>
                  )}

                  {/* Side-by-side engine block (Task 8): native trajectory position vs
                      the SENAITE mirror, plus the latest engine attempt (if any). */}
                  <div className="font-mono text-[11px] text-zinc-700 pt-2 pb-1 flex items-center gap-2">
                    <span>{'─'.repeat(3)} side-by-side {'─'.repeat(21)}</span>
                    {data.shadow?.in_sync === true && (
                      <span className="text-emerald-400">✔ in sync</span>
                    )}
                    {data.shadow?.in_sync === false && (
                      <span className="text-amber-400">⚠ desync</span>
                    )}
                    {data.shadow?.in_sync === null && !data.shadow?.error && (
                      <span className="text-zinc-600">not seeded</span>
                    )}
                  </div>
                  {data.shadow?.error && (
                    <div className={cn(line, 'text-red-400')}>shadow_error: {data.shadow.error}</div>
                  )}
                  {data.shadow && !data.shadow.error && (
                    <div className={cn(line, 'text-zinc-400')}>
                      {`native=${data.shadow.native_status ?? '∅'}  current=${data.shadow.current_status ?? '∅'}`}
                    </div>
                  )}
                  {data.shadow?.latest && (
                    <div className="font-mono text-[11px] text-zinc-500 leading-relaxed">
                      <span className="text-zinc-300">{data.shadow.latest.verb ?? '—'}</span>{'  '}
                      <span className="text-zinc-600">{'→'} {data.shadow.latest.outcome}</span>{'  '}
                      <span className="text-zinc-700">·</span>{'  '}
                      <span className="text-zinc-600">
                        {new Date(data.shadow.latest.evaluated_at).toLocaleTimeString()}
                      </span>
                    </div>
                  )}
                  {data.shadow?.latest && data.shadow.latest.unmet.length > 0 && (
                    <div className="space-y-0.5 pl-3">
                      {data.shadow.latest.unmet.map((u, i) => (
                        <div key={i} className="font-mono text-[11px] text-zinc-600 leading-relaxed">
                          {u.kind}: {u.detail ?? '∅'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* RIGHT column: basic-info status block + field diff (unchanged) */}
                <div className="flex-[2] min-w-0 h-full overflow-y-auto space-y-2 pl-0.5">
                  {/* status block */}
                  <div className={cn(line, 'text-zinc-300')}>
                    <span className="text-zinc-600">load</span>   exists=<span className="text-emerald-400">true</span>{'  '}
                    native_id={data.load.native_id ?? '∅'}{'  '}system={data.load.external_lims_system}
                  </div>
                  {data.linkage && (
                    <div className={cn(line)}>
                      <span className="text-zinc-600">link</span>   uid {data.linkage.registry_uid ?? '∅'} vs {data.linkage.senaite_uid ?? '∅'}{'  '}
                      <span className={data.linkage.status === 'match' ? 'text-emerald-400' : 'text-red-400'}>{data.linkage.status}</span>
                    </div>
                  )}
                  <div className={cn(line, 'text-zinc-300')}>
                    <span className="text-zinc-600">orig</span>   <span>{data.origin}</span>{'   '}
                    <span className="text-zinc-600">sync</span> {data.load.last_synced_at ?? '∅'}
                    {data.load.reconcile_due ? <span className="text-amber-400">  (reconcile due)</span> : null}
                  </div>
                  {data.container && (
                    <div className={cn(line, 'text-zinc-400')}>
                      <span className="text-zinc-600">cont</span>   container_mode={String(data.container.container_mode)}{'  '}role={data.container.assignment_role}
                    </div>
                  )}

                  {data.senaite_error && (
                    <div className={cn(line, 'text-red-400')}>senaite_error: {data.senaite_error}</div>
                  )}

                  {/* field diff */}
                  {data.fields.length > 0 && (
                    <div className="pt-2">
                      <div className="font-mono text-[11px] text-zinc-700 pb-1">{'─'.repeat(3)} fields {'─'.repeat(40)}</div>
                      {data.fields.map(f => {
                        const rv = val(f.registry), sv = val(f.senaite)
                        const differ = rv !== sv
                        return (
                          <div key={f.field} className={cn('font-mono text-[12px] leading-relaxed flex gap-1.5', statusColor[f.status])}>
                            <span className={cn('shrink-0', statusColor[f.status])}>{statusGlyph[f.status]}</span>
                            <span className="text-zinc-400 shrink-0 w-48">{f.field}</span>
                            <div className="min-w-0 flex-1">
                              <div className="text-zinc-400 whitespace-pre-wrap break-all">
                                {differ && <span className="text-zinc-700">reg </span>}{rv}
                              </div>
                              {differ && (
                                <div className="text-zinc-600 whitespace-pre-wrap break-all">
                                  <span className="text-zinc-700">sen </span>{sv}
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {data.vials && (
                    <div className={cn(line, data.vials.status === 'in_sync' ? 'text-zinc-400' : 'text-amber-400')}>
                      <span className="text-zinc-600">vial</span>   local={data.vials.local} senaite={data.vials.senaite}{'  '}{data.vials.status}
                    </div>
                  )}

                  {/* raw toggle */}
                  <button onClick={() => setShowRaw(v => !v)} className="font-mono text-[11px] text-zinc-600 hover:text-zinc-400 pt-2">
                    {showRaw ? '▾' : '▸'} raw json
                  </button>
                  {showRaw && data.raw && (
                    <pre className="font-mono text-[10px] text-zinc-500 whitespace-pre-wrap bg-black/40 rounded p-2 overflow-x-auto">
                      {JSON.stringify(data.raw, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            )}

            {tab === 'log' && (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {logLoading && !logData && (
                  <div className="flex items-center gap-2 py-8 justify-center">
                    <Spinner className="size-3" />
                    <span className="font-mono text-[11px] text-zinc-600">loading log for {sampleId}...</span>
                  </div>
                )}
                {logError && <div className="font-mono text-[11px] text-red-400 py-2">error: {logError}</div>}

                {logData && (
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-2">
                    {/* full transition history */}
                    <div>
                      <div className="font-mono text-[11px] text-zinc-700 pb-1 flex items-center gap-2">
                        <span>{'─'.repeat(3)} transitions (all) {'─'.repeat(30)}</span>
                        {logData.transitions.log_in_sync === true && (
                          <span className="text-emerald-400">✔ log matches status</span>
                        )}
                        {logData.transitions.log_in_sync === false && (
                          <span className="text-amber-400">
                            {`⚠ log behind: latest '${logData.transitions.latest_to_status}' ≠ status '${logData.transitions.current_status}'`}
                          </span>
                        )}
                      </div>
                      {logData.transitions.error && (
                        <div className={cn(line, 'text-red-400')}>transitions_error: {logData.transitions.error}</div>
                      )}
                      {logData.transitions.rows.length > 0 && (
                        <div className="space-y-0.5">
                          {logData.transitions.rows.map((t, i) => (
                            <div key={i} className="font-mono text-[11px] text-zinc-500 leading-relaxed">
                              <span className="text-zinc-300">{t.verb ?? '—'}</span>{'  '}
                              <span className="text-zinc-600">{t.from_status ?? '∅'} → {t.to_status}</span>{'  '}
                              <span className="text-zinc-700">·</span>{'  '}
                              <span className={sourceColor[t.source] ?? 'text-zinc-500'}>{t.source}</span>{'  '}
                              <span className="text-zinc-700">·</span>{'  '}
                              <span className="text-zinc-600">{new Date(t.occurred_at).toLocaleString()}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {logData.transitions.rows.length === 0 && !logData.transitions.error && (
                        <div className="font-mono text-[11px] text-zinc-600">no transitions logged yet</div>
                      )}
                    </div>

                    {/* shadow trajectory */}
                    <div>
                      <div className="font-mono text-[11px] text-zinc-700 pb-1">{'─'.repeat(3)} shadow trajectory {'─'.repeat(25)}</div>
                      {logData.trajectory.error && (
                        <div className={cn(line, 'text-red-400')}>trajectory_error: {logData.trajectory.error}</div>
                      )}
                      {logData.trajectory.rows.length > 0 && (
                        <div className="space-y-0.5">
                          {logData.trajectory.rows.map((r, i) => {
                            const isExpanded = expandedTrajectory.has(i)
                            const outcomeColor = r.outcome === 'advanced' ? 'text-emerald-400'
                              : r.outcome === 'requirements_unmet' ? 'text-amber-400' : 'text-zinc-500'
                            return (
                              <div key={i} className="font-mono text-[11px] text-zinc-500 leading-relaxed">
                                <button onClick={() => toggleTrajectory(i)} className="text-zinc-600 hover:text-zinc-300 mr-1">
                                  {isExpanded ? '▾' : '▸'}
                                </button>
                                {`${r.trigger} · ${r.verb ?? '—'} · ${r.from_status ?? '∅'} → ${r.to_status ?? '∅'} · `}
                                <span className={outcomeColor}>{r.outcome}</span>
                                {` · reqs=${String(r.requirements_met)}`}{'  '}
                                <span className="text-zinc-700">·</span>{'  '}
                                <span className="text-zinc-600">{new Date(r.evaluated_at).toLocaleString()}</span>
                                {isExpanded && (
                                  <div className="pl-4 space-y-0.5">
                                    {r.outcomes.map((o, j) => (
                                      <div key={j} className="font-mono text-[11px] text-zinc-600 leading-relaxed">
                                        <span className={o.met ? 'text-emerald-400' : 'text-amber-400'}>{o.met ? '✔' : '✖'}</span>{' '}
                                        {o.kind}: {o.value ?? '∅'} {o.detail ?? ''}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {logData.trajectory.rows.length === 0 && !logData.trajectory.error && (
                        <div className="font-mono text-[11px] text-zinc-600">no trajectory evaluations yet</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'parity' && (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {!parityData && !parityLoading && (
                  <div className="space-y-2 py-2 shrink-0">
                    <div className="font-mono text-[11px] text-zinc-500 leading-relaxed">
                      compares the full mk1 vs senaite read-path payloads via the parity harness (16 known-expected rules)
                    </div>
                    <div className="font-mono text-[11px] text-zinc-600 leading-relaxed">
                      hits live SENAITE for this one sample · takes a few seconds
                    </div>
                    {parityError && <div className={cn(line, 'text-red-400')}>{parityError}</div>}
                    <button onClick={runParity} className={parityBtn}>run parity scan</button>
                  </div>
                )}

                {parityLoading && !parityData && (
                  <div className="flex items-center gap-2 py-8 justify-center">
                    <Spinner className="size-3" />
                    <span className="font-mono text-[11px] text-zinc-600">scanning {sampleId}...</span>
                  </div>
                )}

                {parityData?.error && (
                  <div className="space-y-2 shrink-0">
                    <div className={cn(line, 'text-red-400')}>{parityData.error}</div>
                    <button onClick={runParity} disabled={parityLoading} className={parityBtn}>re-run</button>
                  </div>
                )}

                {parityData && !parityData.error && parityData.summary && (
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-2">
                    <div className={cn(line, 'text-zinc-400')}>
                      {`total=${parityData.summary.total} equal=${parityData.summary.equal} `
                        + `known_expected=${parityData.summary.known_expected} real=${parityData.summary.real}`}
                      {'  '}
                      {parityData.verdict === true && (
                        <span className="text-emerald-400">✔ PASS — read paths agree</span>
                      )}
                      {parityData.verdict === false && (
                        <span className="text-red-400">⚠ REAL DIFFS</span>
                      )}
                    </div>

                    {parityData.fields.filter(f => f.is_real).map(f => (
                      <div key={f.path} className="font-mono text-[12px] leading-relaxed flex gap-1.5 text-red-400">
                        <span className="shrink-0 text-red-400">⚠</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-zinc-300">{f.path}</div>
                          <div className="text-zinc-400 whitespace-pre-wrap break-all">
                            <span className="text-zinc-700">reg </span>{val(f.mk1_value)}
                          </div>
                          <div className="text-zinc-600 whitespace-pre-wrap break-all">
                            <span className="text-zinc-700">sen </span>{val(f.senaite_value)}
                          </div>
                        </div>
                      </div>
                    ))}

                    {parityData.fields.filter(f => !f.is_real && f.classification === 'known_expected').map(f => (
                      <div key={f.path} className="font-mono text-[12px] leading-relaxed flex gap-1.5 text-zinc-500">
                        <span className="shrink-0 text-zinc-500">○</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-zinc-500">
                            {f.path}{'  '}
                            <span className="border border-zinc-800 rounded px-1 text-zinc-500">{f.rule_id}</span>
                          </div>
                          <div className="text-zinc-700 whitespace-pre-wrap break-all">
                            {val(f.mk1_value)} / {val(f.senaite_value)}
                          </div>
                        </div>
                      </div>
                    ))}

                    {parityData.fields.filter(f => !f.is_real && f.classification !== 'known_expected').length > 0 && (
                      <div>
                        <button onClick={() => setShowEqual(v => !v)}
                          className="font-mono text-[11px] text-zinc-600 hover:text-zinc-400 pt-1">
                          {showEqual ? '▾' : '▸'} {parityData.summary.equal} equal fields
                        </button>
                        {showEqual && (
                          <div className="space-y-0.5 pl-3">
                            {parityData.fields.filter(f => !f.is_real && f.classification !== 'known_expected').map(f => (
                              <div key={f.path} className="font-mono text-[11px] text-zinc-600">✔ {f.path}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <button onClick={runParity} disabled={parityLoading} className={cn(parityBtn, 'mt-1')}>
                      re-run
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* verdict footer */}
          <div className="bg-[#0a0a0a] border-t border-zinc-900 px-3 py-2 font-mono text-[10px] flex items-center justify-between shrink-0">
            <span className="text-emerald-500/70">
              {data?.summary ? `${data.summary.agree} agree · ${data.summary.drift} drift · ${data.summary.registry_null} null` : 'registry-inspect'}
            </span>
            <span className="text-zinc-700">{data?.verdict?.linkage_ok === false ? 'LINKAGE MISMATCH' : 'esc to close'}</span>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
