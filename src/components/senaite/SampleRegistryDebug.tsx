/**
 * SampleRegistryDebug — admin diagnostic panel.
 * Terminal-styled Sheet (matches SampleActivityLog) showing the local
 * lims_samples registry record vs live SENAITE: existence, linkage, origin,
 * freshness, field-by-field agreement/drift, and vial-count sanity.
 */
import { useState, useEffect } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { X, RefreshCw, RotateCw } from 'lucide-react'
import {
  getSampleRegistryDebug, refreshSampleRegistry,
  type SampleRegistryDebug as DebugData, type RegistryFieldStatus,
  type AnalysisSyncStatus,
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
  useEffect(() => { if (open && sampleId) load() }, [open, sampleId])

  const line = 'font-mono text-[12px] leading-relaxed whitespace-pre-wrap'

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
              <button onClick={load} disabled={loading}
                className="text-zinc-600 hover:text-zinc-300 transition-colors disabled:opacity-30">
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              </button>
              <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                <X size={13} />
              </button>
            </div>
          </div>

          <div className="bg-[#0d0d0d] px-3 py-3 flex-1 min-h-0 flex flex-col overflow-hidden">
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

            {data && data.load.exists && (
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
                  <div className="font-mono text-[11px] text-zinc-700 pt-2 pb-1">{'─'.repeat(3)} recent transitions {'─'.repeat(18)}</div>
                  {data.transitions?.error && (
                    <div className={cn(line, 'text-amber-400')}>transitions_error: {data.transitions.error}</div>
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
