import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, XCircle } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import {
  getCustomerAtRisk,
  getCustomerChurnSignals,
  getCustomerCohorts,
  getCustomerSummary,
  type InsightsPeriod,
} from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  cohortTint,
  fmtDelta,
  fmtMoney,
  fmtPct,
  fmtPrice,
  fmtPoints,
} from './insights-utils'

const PERIODS: { key: InsightsPeriod; label: string }[] = [
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: '6m', label: '6M' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'All' },
]
const NEW = '#60a5fa'
const RETURNING = '#34d399'
const FIRST_ORDER_LABEL: Record<string, string> = {
  accutry50: 'accutry50 coupon',
  other_coupon: 'Other coupon',
  full_price: 'Full price',
  with_addon: 'With an add-on',
}
const CHURN_LABEL: Record<string, string> = {
  on_time: 'COA on time',
  late: 'COA late (SLA missed)',
  all_pass: 'All COAs conforming',
  any_fail: 'Got a non-conforming COA',
  no_retest: 'No retest',
  retest: 'Needed a retest',
}
const CARD = 'rounded-lg border border-border/50 bg-card/30 p-3'

function minutesAgo(iso: string | null): string {
  if (!iso) return 'orders not synced yet'
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  return `orders synced ${m < 1 ? 'just now' : `${m} min ago`}`
}

function Kpi({
  label,
  value,
  delta,
  suffix = ' vs prior',
}: {
  label: string
  value: string
  delta: ReturnType<typeof fmtDelta>
  suffix?: string
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
          delta.tone === 'up'
            ? 'text-emerald-600 dark:text-emerald-400'
            : delta.tone === 'down'
              ? 'text-red-600 dark:text-red-400'
              : 'text-muted-foreground'
        )}
      >
        {delta.text}
        {suffix}
      </div>
    </div>
  )
}

function SectionError({
  label,
  onRetry,
}: {
  label: string
  onRetry: () => void
}) {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-sm text-red-500">
      <XCircle className="h-4 w-4" /> Failed to load {label}
      <button type="button" className="underline" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

const rel = (v: number, p: number | null) => (p ? (v - p) / p : null)
const relStr = (v: string, p: string | null) =>
  rel(Number(v), p == null ? null : Number(p))

export function CustomerInsights({
  onOpenCustomer,
}: {
  onOpenCustomer: (key: string) => void
}) {
  const [period, setPeriod] = useState<InsightsPeriod>('90d')
  const [excludeLaunch, setExcludeLaunch] = useState(false)
  const summary = useQuery({
    queryKey: ['customers', 'summary', period, excludeLaunch],
    queryFn: () => getCustomerSummary(period, excludeLaunch),
    staleTime: 60_000,
  })
  const cohorts = useQuery({
    queryKey: ['customers', 'cohorts'],
    queryFn: () => getCustomerCohorts(true),
    staleTime: 60_000,
  })
  const risk = useQuery({
    queryKey: ['customers', 'at-risk'],
    queryFn: getCustomerAtRisk,
    staleTime: 60_000,
  })
  const churn = useQuery({
    queryKey: ['customers', 'churn-signals'],
    queryFn: getCustomerChurnSignals,
    staleTime: 60_000,
  })
  const s = summary.data

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Customer Insights</h1>
          <p className="text-xs text-muted-foreground">
            Paid WooCommerce orders, net of refunds · internal and test accounts
            excluded
            {s && ` · lab time (${s.tz}) · ${minutesAgo(s.synced_at)}`}
          </p>
        </div>
        <div className="flex overflow-hidden rounded-md border border-border/50">
          {PERIODS.map(p => (
            <button
              key={p.key}
              type="button"
              aria-pressed={period === p.key}
              onClick={() => setPeriod(p.key)}
              className={cn(
                'cursor-pointer px-3 py-1 text-xs font-medium',
                period === p.key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {summary.isLoading && (
        <div className="flex justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {summary.error && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-red-500">
          <XCircle className="h-4 w-4" /> Failed to load customer insights
          <button
            type="button"
            className="underline"
            onClick={() => summary.refetch()}
          >
            Retry
          </button>
        </div>
      )}
      {s && s.concentration.customers === 0 && (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No paid orders synced yet.
        </div>
      )}

      {s && s.concentration.customers > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi
              label="Active customers"
              value={String(s.kpis.active_customers.value)}
              delta={fmtDelta(
                rel(
                  s.kpis.active_customers.value,
                  s.kpis.active_customers.prior
                )
              )}
            />
            <Kpi
              label="Revenue"
              value={fmtMoney(s.kpis.revenue.value)}
              delta={fmtDelta(
                relStr(s.kpis.revenue.value, s.kpis.revenue.prior)
              )}
            />
            <Kpi
              label="Paid orders"
              value={s.kpis.paid_orders.value.toLocaleString('en-US')}
              delta={fmtDelta(
                rel(s.kpis.paid_orders.value, s.kpis.paid_orders.prior)
              )}
            />
            <Kpi
              label="Avg order value"
              value={fmtMoney(s.kpis.aov.value)}
              delta={fmtDelta(relStr(s.kpis.aov.value, s.kpis.aov.prior))}
            />
            <Kpi
              label="Repeat rate"
              value={fmtPct(s.kpis.repeat_rate.value)}
              delta={fmtPoints(
                s.kpis.repeat_rate.value,
                s.kpis.repeat_rate.prior
              )}
            />
            <Kpi
              label="Median to 2nd order"
              value={
                s.kpis.median_days_to_second.value == null
                  ? 'n/a'
                  : `${s.kpis.median_days_to_second.value} d`
              }
              delta={{ text: 'all time', tone: 'flat' }}
              suffix=""
            />
          </div>

          <div className="grid gap-3 xl:grid-cols-[1.45fr_1fr]">
            <section className={CARD}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">
                  Revenue by month: new vs returning customers
                </h2>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={excludeLaunch}
                    onCheckedChange={setExcludeLaunch}
                    aria-label="Exclude launch accounts"
                  />
                  Exclude launch accounts
                </label>
              </div>
              <div className="h-[230px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={s.revenue_by_month.map(m => ({
                      month: m.month,
                      new: Number(m.new),
                      returning: Number(m.returning),
                    }))}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="#374151"
                      opacity={0.5}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 10, fill: '#9ca3af' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tickFormatter={(v: number) => fmtMoney(String(v))}
                      tick={{ fontSize: 10, fill: '#9ca3af' }}
                      tickLine={false}
                      axisLine={false}
                      width={60}
                    />
                    <ChartTooltip
                      formatter={(v: number | undefined) =>
                        fmtMoney(String(v ?? 0))
                      }
                    />
                    <Bar
                      dataKey="returning"
                      stackId="r"
                      fill={RETURNING}
                      name="Returning customers"
                    />
                    <Bar
                      dataKey="new"
                      stackId="r"
                      fill={NEW}
                      name="New customers"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className={CARD}>
              <h2 className="text-sm font-medium">Re-order cohorts</h2>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Share of each first-order month&apos;s customers who ordered
                again N months later (launch accounts excluded)
              </p>
              {cohorts.error ? (
                <SectionError
                  label="cohorts"
                  onRetry={() => cohorts.refetch()}
                />
              ) : (
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="py-1 text-left font-medium">Cohort</th>
                      <th className="font-medium">n</th>
                      {cohorts.data?.months.slice(0, 6).map(m => (
                        <th key={m} className="font-medium">
                          {m}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cohorts.data?.rows.map(r => (
                      <tr key={r.cohort}>
                        <td className="py-0.5">{r.cohort}</td>
                        <td className="text-center">{r.size}</td>
                        {r.cells.slice(0, 6).map((c, i) => (
                          <td
                            key={i}
                            className={cn('rounded text-center', cohortTint(c))}
                          >
                            {c == null ? '' : fmtPct(c, c < 0.2 ? 1 : 0)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section className={CARD}>
            <h2 className="text-sm font-medium">
              At-risk customers
              {risk.data && (
                <span className="ml-2 rounded-full bg-red-500/15 px-2 text-xs text-red-700 dark:text-red-300">
                  {risk.data.rows.length} overdue
                </span>
              )}
            </h2>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Overdue against their own usual re-order gap, ranked by 12-month
              spend
            </p>
            {risk.error ? (
              <SectionError
                label="at-risk customers"
                onRetry={() => risk.refetch()}
              />
            ) : risk.data && risk.data.rows.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No customers are overdue right now
              </p>
            ) : (
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-1 text-left font-medium">Customer</th>
                    <th className="text-right font-medium">12-mo spend</th>
                    <th className="text-right font-medium">Orders</th>
                    <th className="text-right font-medium">Usual gap</th>
                    <th className="text-right font-medium">Last order</th>
                    <th className="text-right font-medium">Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {risk.data?.rows.map(r => {
                    // Every row opens: wc: keys get the full detail, guest
                    // email: keys the Dashboard-only detail.
                    return (
                      <Tooltip key={r.key}>
                        <TooltipTrigger asChild>
                          <tr
                            className="cursor-pointer border-t border-border/20 hover:bg-muted/30"
                            tabIndex={0}
                            onClick={() => onOpenCustomer(r.key)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') onOpenCustomer(r.key)
                            }}
                          >
                            <td className="py-1.5 font-medium">{r.name}</td>
                            <td className="text-right">
                              {fmtMoney(r.spend_12m)}
                            </td>
                            <td className="text-right">{r.orders}</td>
                            <td className="text-right">
                              {r.usual_gap_days == null
                                ? 'n/a'
                                : `${r.usual_gap_days} d`}
                            </td>
                            <td className="text-right">
                              {r.last_order_at
                                ? new Date(r.last_order_at).toLocaleDateString(
                                    'en-US',
                                    {
                                      month: 'short',
                                      day: 'numeric',
                                      timeZone: s.tz,
                                    }
                                  )
                                : ''}
                            </td>
                            <td className="text-right">
                              <span
                                className={cn(
                                  'rounded-full px-2 text-xs font-semibold',
                                  r.overdue >= 3
                                    ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                )}
                              >
                                {r.overdue}× gap
                              </span>
                            </td>
                          </tr>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs p-0">
                          <div className="flex flex-col gap-1.5 p-3 font-mono text-xs">
                            <div className="border-b border-primary-foreground/20 pb-1.5 font-semibold">
                              {r.name}
                            </div>
                            <div>{r.email ?? 'no email'}</div>
                            <div>
                              Usual gap{' '}
                              {r.usual_gap_days == null
                                ? 'n/a'
                                : `${r.usual_gap_days} d`}
                              {' · '}last order{' '}
                              {r.last_order_at
                                ? r.last_order_at.slice(0, 10)
                                : 'n/a'}
                            </div>
                            <div className="border-t border-primary-foreground/20 pt-1.5">
                              Lifetime {fmtMoney(r.lifetime)} · {r.samples}{' '}
                              samples
                            </div>
                            <div>
                              Top tests: {r.top_tests.join(', ') || 'n/a'}
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>

          <div className="grid gap-3 lg:grid-cols-3">
            <section className={CARD}>
              <h2 className="text-sm font-medium">
                First order → comes back? (all time)
              </h2>
              <table className="mt-2 w-full text-sm tabular-nums">
                <tbody>
                  {s.first_order.map(f => (
                    <tr key={f.kind}>
                      <td className="py-1">
                        {FIRST_ORDER_LABEL[f.kind] ?? f.kind}
                      </td>
                      <td className="text-right text-muted-foreground">
                        {f.customers}
                      </td>
                      <td className="text-right font-medium">
                        {fmtPct(f.repeat_rate, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className={CARD}>
              <h2 className="text-sm font-medium">
                Add-on attach rate (all time)
              </h2>
              <table className="mt-2 w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-[11px] text-muted-foreground">
                    <th className="text-left font-medium">Add-on</th>
                    <th className="text-right font-medium">New</th>
                    <th className="text-right font-medium">Returning</th>
                  </tr>
                </thead>
                <tbody>
                  {s.attach.map(a => (
                    <tr key={a.test}>
                      <td className="py-1">{a.test}</td>
                      <td className="text-right">{fmtPct(a.new, 0)}</td>
                      <td className="text-right">{fmtPct(a.returning, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className={cn(CARD, 'text-sm')}>
              <h2 className="font-medium">Revenue concentration (all time)</h2>
              <div className="mt-2 flex justify-between">
                <span>Top 10 customers</span>
                <b>{fmtPct(s.concentration.top10_share, 0)}</b>
              </div>
              <div className="flex justify-between">
                <span>Top 10%</span>
                <b>{fmtPct(s.concentration.top_decile_share)}</b>
              </div>
              <div className="flex justify-between">
                <span>Repeat customers&apos; share</span>
                <b>{fmtPct(s.concentration.repeat_share)}</b>
              </div>
              <div className="flex justify-between">
                <span>Median / average LTV</span>
                <b>
                  {fmtMoney(s.concentration.median_ltv)} /{' '}
                  {fmtMoney(s.concentration.mean_ltv)}
                </b>
              </div>
            </section>
          </div>
          <section className={CARD}>
            <h2 className="text-sm font-medium">Average price by product</h2>
            <p className="mb-2 text-[11px] text-muted-foreground">
              What customers actually paid per unit in this period, after
              coupons
            </p>
            {s.product_prices.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No paid line items in this period
              </p>
            ) : (
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-1 text-left font-medium">Product</th>
                    <th className="text-right font-medium">Avg price</th>
                    <th className="text-right font-medium">Units</th>
                    <th className="text-right font-medium">Revenue</th>
                    <th className="text-right font-medium">Customers</th>
                  </tr>
                </thead>
                <tbody>
                  {s.product_prices.map(p => (
                    <tr key={p.product} className="border-t border-border/20">
                      <td className="py-1.5">{p.product}</td>
                      <td className="text-right font-medium">
                        {fmtPrice(p.avg_price)}
                      </td>
                      <td className="text-right">{p.units}</td>
                      <td className="text-right">{fmtMoney(p.revenue)}</td>
                      <td className="text-right text-muted-foreground">
                        {p.customers}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className={CARD}>
            <h2 className="text-sm font-medium">Why do customers stop?</h2>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Correlation, not proof. Share who ordered again within 60 days.
            </p>
            {churn.error ? (
              <SectionError
                label="churn signals"
                onRetry={() => churn.refetch()}
              />
            ) : (
              <div className="flex flex-col gap-1.5 text-xs tabular-nums">
                {churn.data?.buckets.map(b => (
                  <div
                    key={`${b.signal}-${b.group}`}
                    className="flex items-center gap-2"
                  >
                    <span className="w-48 shrink-0">
                      {CHURN_LABEL[b.group] ?? b.group}
                    </span>
                    <div className="h-2 flex-1 rounded bg-muted">
                      <div
                        className="h-2 rounded bg-emerald-400"
                        style={{
                          width: `${Math.round((b.returned ?? 0) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="w-10 text-right font-medium">
                      {fmtPct(b.returned, 0)}
                    </span>
                    <span className="w-16 text-right text-muted-foreground">
                      n = {b.orders}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
