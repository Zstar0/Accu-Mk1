import { useEffect, useState } from 'react'
import { getVialDemand, type VialDemandResponse } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  parentSampleId: string
  receivedCount: number
}

function totalDemand(d: VialDemandResponse['demand'] | null): number {
  if (!d) return 0
  return d.hplc + d.endo + d.ster
}

function demandBreakdown(d: VialDemandResponse['demand']): string {
  const parts: string[] = []
  if (d.hplc) parts.push(`${d.hplc} HPLC`)
  if (d.endo) parts.push(`${d.endo} ENDO`)
  if (d.ster) parts.push(`${d.ster} STERYL`)
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

  const total = totalDemand(demand?.demand ?? null)
  const breakdown = demand ? demandBreakdown(demand.demand) : ''
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
