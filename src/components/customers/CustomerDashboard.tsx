import { useQuery } from '@tanstack/react-query'
import { Loader2, XCircle } from 'lucide-react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import type { CustomerDossier } from '@/lib/api'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  dossierQuery,
  fmtMoney,
  fmtPct,
  STATUS_CLASS,
  STATUS_LABEL,
} from './insights-utils'

const CARD = 'rounded-lg border border-border/50 bg-card/30 p-3'
const SPEND = '#60a5fa'
const SAMPLES = '#f59e0b'
const CHIP = 'rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap'
const RED = 'bg-red-500/15 text-red-700 dark:text-red-300'
const GREEN = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'

function Tile({
  label,
  value,
  sub,
  worse = false,
}: {
  label: string
  value: string
  sub: string
  worse?: boolean
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-4 py-3">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 text-xs tabular-nums',
          worse ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'
        )}
      >
        {sub}
      </div>
    </div>
  )
}

/** Lab-average comparison line; "worse" decides the red tone. */
function labSub(lab: number | null, dp: number): string {
  return lab == null ? 'lab avg n/a' : `lab avg ${fmtPct(lab, dp)}`
}

function Rhythm({ d }: { d: CustomerDossier }) {
  const times = d.order_dates.map(t => Date.parse(t))
  const last = times[times.length - 1]
  // "Today" = the backend's as-of (last order + days since), so render stays pure.
  const now = (last ?? 0) + (d.days_since_last ?? 0) * 86_400_000
  const start = times[0] ?? now
  const span = Math.max(now - start, 1)
  const x = (t: number) => 5 + ((t - start) / span) * 350
  const atRisk = d.status === 'at_risk' && last != null
  return (
    <svg
      viewBox="0 0 360 70"
      width="100%"
      role="img"
      aria-label={`${times.length} testing orders`}
    >
      <line x1="5" y1="40" x2="355" y2="40" className="stroke-border" />
      {atRisk && (
        <>
          <rect
            x={x(last)}
            y="28"
            width={Math.max(355 - x(last), 1)}
            height="24"
            className="fill-red-500/15"
          />
          <text
            x={(x(last) + 355) / 2}
            y="22"
            fontSize="10"
            textAnchor="middle"
            className="fill-red-600 dark:fill-red-400"
          >
            {Math.round(d.days_since_last ?? 0)} d silent
          </text>
        </>
      )}
      {times.map((t, i) => (
        <line
          key={i}
          x1={x(t)}
          y1="30"
          x2={x(t)}
          y2="50"
          strokeWidth="2"
          className="stroke-sky-500"
        />
      ))}
      <text x="5" y="66" fontSize="9" className="fill-muted-foreground">
        {d.order_dates[0]?.slice(0, 7) ?? ''}
      </text>
      <text
        x="355"
        y="66"
        fontSize="9"
        textAnchor="end"
        className="fill-muted-foreground"
      >
        today
      </text>
    </svg>
  )
}

export function CustomerDashboard({
  customerKey,
  onOpenAnalyte,
}: {
  customerKey: string
  onOpenAnalyte: (product: string) => void
}) {
  const q = useQuery(dossierQuery(customerKey))

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading customer dashboard
      </div>
    )
  }
  if (q.error) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-red-600 dark:text-red-400">
        <XCircle className="h-4 w-4" /> Failed to load customer dashboard
        <button type="button" className="underline" onClick={() => q.refetch()}>
          Retry
        </button>
      </div>
    )
  }
  const d = q.data
  if (!d) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        No paid orders for this customer yet
      </div>
    )
  }

  const k = d.kpis
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: d.tz,
    })
  const banner = [
    `No testing order in ${Math.round(d.days_since_last ?? 0)} days`,
    k.usual_gap_days != null && `usually orders every ${k.usual_gap_days} days`,
    `${d.overdue}× overdue`,
    d.spend_delta_pct != null &&
      d.spend_delta_pct < 0 &&
      `90-day spend down ${Math.round(-d.spend_delta_pct * 100)}% vs the prior 90 days`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex flex-col gap-3">
      {d.status === 'at_risk' && (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-2.5 text-sm">
          <span className={cn(CHIP, STATUS_CLASS.at_risk)}>
            {STATUS_LABEL.at_risk}
          </span>
          <span>{banner}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Lifetime spend"
          value={fmtMoney(k.lifetime)}
          sub={`#${k.rank} of ${k.customers} customers`}
        />
        <Tile
          label="Paid orders"
          value={String(k.orders)}
          sub={`avg ${fmtMoney(k.avg_order)}`}
        />
        <Tile
          label="Samples"
          value={String(k.samples)}
          sub={`${k.samples_per_order} per order`}
        />
        <Tile
          label="Usual re-order gap"
          value={k.usual_gap_days == null ? 'n/a' : `${k.usual_gap_days} d`}
          sub={
            k.gap_iqr
              ? `IQR ${k.gap_iqr[0]} to ${k.gap_iqr[1]} d`
              : 'needs 3+ testing orders'
          }
        />
        <Tile
          label="Non-conforming COAs"
          value={fmtPct(k.nonconforming_rate)}
          sub={labSub(k.lab_nonconforming_rate, 1)}
          worse={
            k.nonconforming_rate != null &&
            k.lab_nonconforming_rate != null &&
            k.nonconforming_rate > k.lab_nonconforming_rate
          }
        />
        <Tile
          label="COAs on time"
          value={fmtPct(k.on_time_rate, 0)}
          sub={labSub(k.lab_on_time_rate, 0)}
          worse={
            k.on_time_rate != null &&
            k.lab_on_time_rate != null &&
            k.on_time_rate < k.lab_on_time_rate
          }
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.5fr_1fr]">
        <section className={CARD}>
          <h2 className="text-sm font-medium">Spend and samples by month</h2>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Bars = spend, line = samples submitted
          </p>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={d.monthly.map(m => ({
                  month: m.month,
                  spend: Number(m.spend),
                  samples: m.samples,
                }))}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#9ca3af"
                  opacity={0.3}
                  vertical={false}
                />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  yAxisId="spend"
                  tickFormatter={(v: number) => fmtMoney(String(v))}
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={false}
                  width={60}
                />
                <YAxis
                  yAxisId="samples"
                  orientation="right"
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={false}
                  width={30}
                />
                <ChartTooltip
                  formatter={(
                    v: number | undefined,
                    name: string | undefined
                  ) => (name === 'Spend' ? fmtMoney(String(v ?? 0)) : (v ?? 0))}
                />
                <Bar
                  yAxisId="spend"
                  dataKey="spend"
                  fill={SPEND}
                  name="Spend"
                />
                <Line
                  yAxisId="samples"
                  dataKey="samples"
                  stroke={SAMPLES}
                  strokeWidth={2}
                  name="Samples"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className={CARD}>
          <h2 className="text-sm font-medium">Order rhythm</h2>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Each tick = one testing order; the current silence is shaded when
            overdue
          </p>
          <Rhythm d={d} />
          <div className="mt-2 flex flex-col gap-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Customer since</span>
              <b>{day(d.identity.since)}</b>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Days since last testing order
              </span>
              <b>
                {d.days_since_last == null
                  ? 'n/a'
                  : Math.round(d.days_since_last)}
              </b>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <span className={cn(CHIP, STATUS_CLASS[d.status])}>
                {STATUS_LABEL[d.status] ?? d.status}
              </span>
            </div>
          </div>
        </section>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <section className={CARD}>
          <h2 className="text-sm font-medium">What they test</h2>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Share of their samples · vs all customers
          </p>
          {d.test_mix.length === 0 && (
            <p className="text-sm text-muted-foreground">No testing orders</p>
          )}
          {d.test_mix.map(t => (
            <div key={t.test} className="mb-2">
              <div className="flex justify-between text-sm">
                <span>{t.test}</span>
                <b className="tabular-nums">
                  {fmtPct(t.share, 0)}{' '}
                  <span className="font-normal text-muted-foreground">
                    (all {fmtPct(t.all_share, 0)})
                  </span>
                </b>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-sky-500"
                  style={{ width: `${Math.min(100, t.share * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </section>

        <section className={CARD}>
          <h2 className="text-sm font-medium">Top analytes</h2>
          <p className="mb-2 text-[11px] text-muted-foreground">
            COAs · their pass rate · click for Analyte Trends
          </p>
          {d.analytes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No published COAs</p>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-1 text-left font-medium">Analyte</th>
                  <th className="text-right font-medium">COAs</th>
                  <th className="text-right font-medium">Pass</th>
                </tr>
              </thead>
              <tbody>
                {d.analytes.map(a => (
                  <tr key={a.product} className="border-t border-border/20">
                    <td className="py-1">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() => onOpenAnalyte(a.product)}
                      >
                        {a.product}
                      </button>
                    </td>
                    <td className="text-right">{a.coas}</td>
                    <td className="text-right">
                      <span className={cn(a.pass_rate < 0.9 && cn(CHIP, RED))}>
                        {fmtPct(a.pass_rate, 0)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className={CARD}>
          <h2 className="text-sm font-medium">Their experience with us</h2>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Recent orders: COA verdicts and turnaround
          </p>
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1 text-left font-medium">Recent order</th>
                <th className="text-right font-medium">COA</th>
                <th className="text-right font-medium">On time</th>
              </tr>
            </thead>
            <tbody>
              {d.recent.map(r => (
                <Tooltip key={r.order_number}>
                  <TooltipTrigger asChild>
                    <tr className="border-t border-border/20 hover:bg-muted/30">
                      <td className="py-1">
                        #{r.order_number} {day(r.paid_at)}
                      </td>
                      <td className="text-right">
                        {r.coas > 0 && (
                          <span
                            className={cn(CHIP, r.failed > 0 ? RED : GREEN)}
                          >
                            {r.failed > 0 ? `${r.failed} fail` : 'Pass'}
                          </span>
                        )}
                      </td>
                      <td className="text-right">
                        {r.sla && (
                          <span
                            className={cn(CHIP, r.sla === 'late' ? RED : GREEN)}
                          >
                            {r.sla === 'late' ? 'late' : 'on time'}
                          </span>
                        )}
                      </td>
                    </tr>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs p-0">
                    <div className="flex flex-col gap-1.5 p-3 font-mono text-xs">
                      <div className="border-b border-primary-foreground/20 pb-1.5 font-semibold">
                        Order #{r.order_number}
                      </div>
                      <div>Paid {r.paid_at.slice(0, 10)}</div>
                      <div>
                        {r.coas} COAs published · {r.failed} non-conforming
                      </div>
                      <div>
                        Turnaround:{' '}
                        {r.sla === 'late'
                          ? 'delivered late'
                          : r.sla === 'on_time'
                            ? 'delivered on time'
                            : 'no SLA record'}
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}
