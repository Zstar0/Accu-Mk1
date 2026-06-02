import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getTurnaround } from '@/lib/api'
import { Checkbox } from '@/components/ui/checkbox'
import {
  PERIOD_DAYS,
  filterByPeriod,
  aggregate,
  humanizeDuration,
  type TimePeriod,
  type PhaseStat,
} from './turnaround-utils'

const LOW_N = 3 // bars below this sample count are dimmed (not a trend)

function StatCard({
  value,
  label,
  accent,
}: {
  value: string | number
  label: string
  accent?: 'amber' | 'red' | 'blue'
}) {
  const colors = {
    amber: 'text-amber-400 border-amber-500/30',
    red: 'text-red-400 border-red-500/30',
    blue: 'text-blue-400 border-blue-500/30',
  }
  const c = accent ? colors[accent] : 'text-foreground border-border/50'
  return (
    <div className={cn('rounded-lg border bg-card/50 px-4 py-3', c)}>
      <div className={cn('text-2xl font-bold tabular-nums', accent ? c.split(' ')[0] : 'text-foreground')}>
        {value}
      </div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  )
}

function RankedBars({ phases }: { phases: PhaseStat[] }) {
  // Slowest-first; phases with no data sink to the bottom.
  const ranked = useMemo(
    () =>
      [...phases].sort((a, b) => {
        if (a.median == null) return 1
        if (b.median == null) return -1
        return b.median - a.median
      }),
    [phases]
  )
  const scale = useMemo(
    () => Math.max(1, ...phases.map(p => p.p90 ?? p.median ?? 0)),
    [phases]
  )

  return (
    <div className="flex flex-col gap-2.5">
      {ranked.map(p => {
        const medianPct = p.median != null ? (p.median / scale) * 100 : 0
        const p90Pct = p.p90 != null ? (p.p90 / scale) * 100 : medianPct
        const dim = p.n < LOW_N
        return (
          <div key={p.key} className={cn('flex items-center gap-3', dim && 'opacity-45')}>
            <div className="w-40 shrink-0 text-xs text-muted-foreground text-right">{p.label}</div>
            <div className="relative h-6 flex-1 rounded bg-muted/20 overflow-hidden">
              {/* p90 tail (lighter) */}
              <div
                className="absolute inset-y-0 left-0 rounded bg-primary/25"
                style={{ width: `${p90Pct}%` }}
              />
              {/* median (solid) */}
              <div
                className="absolute inset-y-0 left-0 rounded bg-primary"
                style={{ width: `${medianPct}%` }}
              />
            </div>
            <div className="w-32 shrink-0 text-right text-xs tabular-nums">
              <span className="font-semibold text-foreground">{humanizeDuration(p.median)}</span>
              <span className="ml-1.5 text-muted-foreground">p90 {humanizeDuration(p.p90)}</span>
            </div>
            <div className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
              n={p.n}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PhaseTable({ phases }: { phases: PhaseStat[] }) {
  const medianSum = phases.reduce((s, p) => s + (p.median ?? 0), 0)
  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="bg-muted/30 border-b border-border/40 text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Phase</th>
            <th className="px-3 py-2 text-right font-medium">Median</th>
            <th className="px-3 py-2 text-right font-medium">p90</th>
            <th className="px-3 py-2 text-right font-medium">n</th>
            <th className="px-3 py-2 text-right font-medium">% of total</th>
          </tr>
        </thead>
        <tbody>
          {phases.map(p => {
            const pct = medianSum > 0 && p.median != null ? Math.round((p.median / medianSum) * 100) : null
            return (
              <tr key={p.key} className="border-b border-border/20 hover:bg-muted/30">
                <td className="px-3 py-2 text-sm">{p.label}</td>
                <td className="px-3 py-2 text-right text-sm font-medium tabular-nums">
                  {humanizeDuration(p.median)}
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-muted-foreground">
                  {humanizeDuration(p.p90)}
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-muted-foreground">{p.n}</td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-muted-foreground">
                  {pct != null ? `${pct}%` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function TurnaroundReport() {
  const [period, setPeriod] = useState<TimePeriod>('6M')
  const [hideTestOrders, setHideTestOrders] = useState(true)

  const { data, isLoading, error } = useQuery({
    queryKey: ['reports', 'turnaround'],
    queryFn: getTurnaround,
    staleTime: 60_000,
  })

  const samples = useMemo(() => {
    if (!data) return []
    const base = hideTestOrders ? data.filter(s => !s.is_test_order) : data
    return filterByPeriod(base, period)
  }, [data, period, hideTestOrders])

  const summary = useMemo(() => aggregate(samples), [samples])
  const slowest = summary.phases.find(p => p.key === summary.slowestPhaseKey)
  const hasData = summary.phases.some(p => p.n > 0)

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Bottlenecks</h1>
          <p className="text-xs text-muted-foreground">Median time per phase — where samples spend time</p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap cursor-pointer">
            <Checkbox
              checked={hideTestOrders}
              onCheckedChange={checked => setHideTestOrders(checked === true)}
            />
            Hide test orders
          </label>
          <div className="flex rounded-md border border-border/50 overflow-hidden">
            {(Object.keys(PERIOD_DAYS) as TimePeriod[]).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={cn(
                  'px-3 py-1 text-xs font-medium transition-colors cursor-pointer',
                  period === p
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-400 py-8 justify-center text-sm">
          <XCircle className="h-4 w-4" />
          Failed to load turnaround data
        </div>
      )}

      {data && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <StatCard value={humanizeDuration(summary.totalMedianMs)} label="Median Turnaround" accent="blue" />
            <StatCard value={slowest ? slowest.label : '—'} label="Slowest Phase" accent="red" />
            <StatCard value={summary.cohort} label="Samples (received)" accent="amber" />
          </div>

          {/* Ranked bars */}
          <div className="rounded-lg border border-border/50 bg-card/30 p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Median time in phase (slowest first)
            </div>
            {hasData ? (
              <RankedBars phases={summary.phases} />
            ) : (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No completed phases in this range
              </div>
            )}
          </div>

          {/* Table */}
          {hasData && <PhaseTable phases={summary.phases} />}

          {/* Footnote */}
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            Calendar (wall-clock) time. partial_submit / partial_verify are counted as Submitted / Verified.
            Each phase is measured only for samples that have both its boundaries, so n varies by phase.
            {summary.anomalies > 0 && ` ${summary.anomalies} out-of-order anomalies excluded.`}
          </p>
        </>
      )}
    </div>
  )
}
