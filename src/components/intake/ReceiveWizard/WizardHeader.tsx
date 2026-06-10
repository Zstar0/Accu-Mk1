import { useEffect, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { getVialDemand, type VialDemandResponse } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  parentSampleId: string
  receivedCount: number
}

// Path is served by Vite from `public/guides/` — the build script
// (docs/guides/_build_html.py) mirrors the rendered HTML there.
const CHECKIN_SOP_PATH = '/guides/front-desk-sample-check-in.html'

function totalDemand(d: VialDemandResponse | null): number {
  if (!d) return 0
  // Expected total = base demand + extra variance vials physically expected.
  // variance.hplc = total replicates purchased (canonical included), so
  // extra beyond base = max(0, variance - base_demand).
  const base = d.demand.hplc + d.demand.endo + d.demand.ster
  const extraHplc = Math.max(0, (d.variance?.hplc ?? 0) - d.demand.hplc)
  const extraEndo = Math.max(0, (d.variance?.endo ?? 0) - d.demand.endo)
  const extraSter = Math.max(0, (d.variance?.ster ?? 0) - d.demand.ster)
  return base + extraHplc + extraEndo + extraSter
}

function demandBreakdown(d: VialDemandResponse): string {
  // Show effective count (base + variance extras) per role so the breakdown
  // matches the total shown in the header.
  const parts: string[] = []
  const hplcTotal = d.demand.hplc + Math.max(0, (d.variance?.hplc ?? 0) - d.demand.hplc)
  const endoTotal = d.demand.endo + Math.max(0, (d.variance?.endo ?? 0) - d.demand.endo)
  const sterTotal = d.demand.ster + Math.max(0, (d.variance?.ster ?? 0) - d.demand.ster)
  if (hplcTotal) parts.push(`${hplcTotal} HPLC`)
  if (endoTotal) parts.push(`${endoTotal} ENDO`)
  if (sterTotal) parts.push(`${sterTotal} STERYL`)
  return parts.join(' · ')
}

export function WizardHeader({ parentSampleId, receivedCount }: Props) {
  const [demand, setDemand] = useState<VialDemandResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getVialDemand(parentSampleId)
      .then(d => {
        if (!cancelled) setDemand(d)
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [parentSampleId])

  const total = totalDemand(demand ?? null)
  const breakdown = demand ? demandBreakdown(demand) : ''
  const isShort = demand && receivedCount < total
  const isComplete = demand && total > 0 && receivedCount >= total

  return (
    <header className="flex items-center justify-between gap-4 px-6 py-3 border-b bg-muted/10">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Expected vials
        </span>
        {demand?.is_unreachable ? (
          <span className="text-xs text-amber-500">
            Order data unavailable — proceed manually
          </span>
        ) : demand ? (
          total > 0 ? (
            <span className="text-sm font-medium">
              {total} vial{total === 1 ? '' : 's'}{' '}
              <span className="text-xs text-muted-foreground">({breakdown})</span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              No vial requirements detected
            </span>
          )
        ) : error ? (
          <span className="text-xs text-destructive" title={error}>
            Couldn't load demand
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Loading…</span>
        )}
      </div>
      <a
        href={CHECKIN_SOP_PATH}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
        title="Open the front-desk check-in SOP in a new tab"
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
        Check-In SOP
      </a>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Received
        </span>
        <span
          className={cn(
            'text-sm font-mono font-semibold tabular-nums',
            isComplete && 'text-emerald-500',
            isShort && 'text-amber-500'
          )}
        >
          {receivedCount}
          {demand && total > 0 && (
            <span className="text-muted-foreground"> / {total}</span>
          )}
        </span>
      </div>
    </header>
  )
}
