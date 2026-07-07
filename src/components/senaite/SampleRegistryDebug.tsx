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
} from '@/lib/api'

const statusGlyph: Record<RegistryFieldStatus, string> = {
  agree: '✔', drift: '⚠', registry_null: '○', senaite_null: '—',
}
const statusColor: Record<RegistryFieldStatus, string> = {
  agree: 'text-emerald-400', drift: 'text-amber-400',
  registry_null: 'text-zinc-500', senaite_null: 'text-zinc-500',
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
      <SheetContent side="right" className="w-[600px] sm:max-w-[600px] p-0 border-l-0 bg-transparent [&>button]:hidden">
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

          <div className="bg-[#0d0d0d] px-3 py-3 flex-1 overflow-y-auto">
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
              <div className="space-y-2">
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
                    {data.fields.map(f => (
                      <div key={f.field} className={cn(line, statusColor[f.status])}>
                        <span className={statusColor[f.status]}>{statusGlyph[f.status]}</span>{'  '}
                        <span className="text-zinc-400">{f.field.padEnd(22)}</span>
                        <span className="text-zinc-500" title={val(f.registry)}>{val(f.registry).slice(0, 22).padEnd(24)}</span>
                        <span className="text-zinc-600" title={val(f.senaite)}>{val(f.senaite).slice(0, 22)}</span>
                      </div>
                    ))}
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
