import { useEffect, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Loader2, XCircle } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import { getSlaPerformance } from '@/lib/api'
import type { SlaPerfQuery, SlaPerfReport as Report } from '@/lib/api'
import { Input } from '@/components/ui/input'
import {
  FAMILY_COLORS,
  FAMILY_LABELS,
  GATING_FAMILIES,
  bestAndWorst,
  chartableFamilies,
  deltaPoints,
  gateShare,
  hasGatingSignal,
  leadingFamily,
  readableMonth,
  staleOpen,
  trendMedian,
  type GatingFamilyKey,
} from './sla-perf-utils'

// ─── Palette (shared with the Lab Throughput report) ─────────────────────────

const ON_TIME = '#1FA3BE'
const LATE = '#e4674a'
const OPEN = '#d9a441'
const BENCH = '#1FA3BE'
const LAG = '#9085e9'
const GRID = '#374151'
const TICK = '#9ca3af'
const TARGET_LINE = '#9ca3af'

const fmt = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US')
const f1 = (n: number | null | undefined) =>
  n == null || Number.isNaN(n)
    ? '–'
    : (Math.round(n * 10) / 10).toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })

const TH =
  'px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-1.5 text-sm tabular-nums text-right'

// ─── Summary cards ───────────────────────────────────────────────────────────

function StatCard({
  value,
  unit,
  label,
  sub,
  delta,
  higherIsBetter = true,
  warn,
}: {
  value: string
  unit?: string
  label: string
  sub?: string
  delta?: number | null
  higherIsBetter?: boolean
  warn?: boolean
}) {
  const good = delta == null ? null : higherIsBetter ? delta >= 0 : delta <= 0
  return (
    <div
      className={cn(
        'rounded-lg border bg-card/50 px-4 py-3',
        warn ? 'border-red-500/40' : 'border-border/50'
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums text-foreground">
        {value}
        {unit && (
          <span className="text-sm font-medium text-muted-foreground ml-0.5">
            {unit}
          </span>
        )}
      </div>
      {sub && (
        <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
      )}
      {delta != null && (
        <div
          className={cn(
            'text-[11px] tabular-nums mt-1',
            good ? 'text-emerald-400' : 'text-red-400'
          )}
        >
          {delta > 0 ? '+' : ''}
          {f1(delta)} vs prior 30 days
        </div>
      )}
    </div>
  )
}

// ─── Layout helpers ──────────────────────────────────────────────────────────

function Section({
  title,
  sub,
  right,
  children,
  className,
}: {
  title: string
  sub?: string
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border/50 bg-card/30 p-3',
        className
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      {items.map(i => (
        <span key={i.name} className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: i.color }}
          />
          {i.name}
        </span>
      ))}
    </div>
  )
}

const CHART = 'h-[300px]'
const CHART_SM = 'h-[240px]'

const CHIP_ON =
  'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300'
const CHIP_OFF =
  'bg-transparent text-muted-foreground border-border hover:bg-muted/40'

/** Debounce the Order # box so it doesn't refetch per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function SlaPerformanceReport() {
  const [hideTestOrders, setHideTestOrders] = useState(true)
  const [department, setDepartment] = useState('')
  const [family, setFamily] = useState('')
  const [client, setClient] = useState('')
  const [orderInput, setOrderInput] = useState('')
  const order = useDebounced(orderInput.trim(), 400)

  const query: SlaPerfQuery = {
    includeTestOrders: !hideTestOrders,
    client,
    order,
    departments: department ? [department] : [],
    families: family ? [family] : [],
  }
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['reports', 'sla-performance', query],
    queryFn: () => getSlaPerformance(query),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })

  const facets = data?.facets
  const subChips =
    department && facets
      ? facets.families.filter(f => f.department === department)
      : []
  const scoped = Boolean(client || order || department || family)

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">SLA Performance</h1>
          <p className="text-xs text-muted-foreground">
            Receipt to first COA against target
            {data &&
              ` · target ${f1(data.target_bh)} business hours · lab time (${data.tz})`}
            {isFetching && data && ' · updating…'}
          </p>
        </div>
      </div>

      {/* Filter block — same shape as the Lab Throughput board. */}
      <div className="flex flex-col gap-2">
        {facets && (
          <div className="flex flex-wrap items-center gap-2">
            {[
              { key: '', name: 'All departments', samples: 0 },
              ...facets.departments,
            ].map(d => (
              <button
                key={d.key || 'all'}
                type="button"
                aria-pressed={department === d.key}
                onClick={() => {
                  setDepartment(d.key)
                  setFamily('')
                }}
                className={cn(
                  'inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                  department === d.key ? CHIP_ON : CHIP_OFF
                )}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}
        {subChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pl-4">
            <span
              className="text-muted-foreground/40 select-none"
              aria-hidden="true"
            >
              &#8627;
            </span>
            {[
              {
                key: '',
                name: 'All',
                samples: subChips.reduce((n, f) => n + f.samples, 0),
              },
              ...subChips,
            ].map(f => (
              <button
                key={f.key || 'all'}
                type="button"
                aria-pressed={family === f.key}
                onClick={() => setFamily(f.key)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                  family === f.key ? CHIP_ON : CHIP_OFF
                )}
              >
                {f.name}
                <span className="tabular-nums text-[10px] opacity-60">
                  {f.samples}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Customer"
            value={client}
            onChange={e => setClient(e.target.value)}
            className="h-8 max-w-64 rounded-md border border-border bg-transparent px-2 text-sm text-muted-foreground"
          >
            <option value="">All customers</option>
            {(facets?.clients ?? []).map(c => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.samples})
              </option>
            ))}
          </select>
          <Input
            placeholder="Order #"
            value={orderInput}
            onChange={e => setOrderInput(e.target.value)}
            className="h-8 w-32 text-sm"
          />
          <button
            type="button"
            aria-pressed={hideTestOrders}
            onClick={() => setHideTestOrders(v => !v)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
              hideTestOrders
                ? 'bg-foreground text-background border-foreground'
                : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
            )}
          >
            Hide test orders
          </button>
          {scoped && (
            <button
              type="button"
              onClick={() => {
                setDepartment('')
                setFamily('')
                setClient('')
                setOrderInput('')
              }}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {data?.cache.stale && (
        <p className="text-xs text-amber-400">
          Integration Service unreachable — showing rows cached{' '}
          {data.cache.age_seconds}s ago.
        </p>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && !data && (
        <div className="flex items-center gap-2 text-red-400 py-8 justify-center text-sm">
          <XCircle className="h-4 w-4" />
          Failed to load SLA performance data
        </div>
      )}

      {data && <ReportBody data={data} />}
    </div>
  )
}

function ReportBody({ data }: { data: Report }) {
  const { kpi, months, curve, stages, gating, at_risk: atRisk } = data
  const target = data.target_bh
  const rateDelta = deltaPoints(kpi.last30, kpi.prev30)
  const medDelta =
    kpi.prev30.n > 0
      ? Math.round((kpi.last30.med - kpi.prev30.med) * 10) / 10
      : null
  const { best, worst } = bestAndWorst(months, data.today)
  const stale = staleOpen(months)
  const readable = readableMonth(gating.trend, gating.min_late_for_trend)
  const leader = leadingFamily(readable)
  const first = gating.trend[0] ?? null
  const chartFamilies = chartableFamilies(gating.trend)
  const showGating = hasGatingSignal(gating)

  const cohortData = months.map(m => ({
    label: m.label.replace(' 20', " '"),
    ontime: m.ontime,
    late: m.late,
    open: m.open,
    rate: m.rate_received,
  }))

  const curveData = curve.recent.map(p => ({
    bh: p.bh,
    recent: p.cum_pct,
    all: curve.all.find(a => a.bh === p.bh)?.cum_pct ?? 0,
  }))

  const gateData = gating.trend.map(t => {
    const row: Record<string, string | number> = {
      label: t.label.replace(' 20', " '"),
      late_total: t.late_total,
    }
    for (const f of GATING_FAMILIES) row[f] = gateShare(t, f)
    return row
  })

  const famTrendData = gating.trend.map(t => {
    const row: Record<string, string | number | null> = {
      label: t.label.replace(' 20', " '"),
    }
    for (const f of chartFamilies) row[f] = trendMedian(t, f)
    return row
  })

  const stageData = stages.by_month.map(s => ({
    label: s.label.replace(' 20', " '"),
    bench: s.bench,
    lag: s.lag,
  }))

  return (
    <div className="flex flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <StatCard
          label="On time, last 30 days"
          value={f1(kpi.last30.rate)}
          unit="%"
          sub={`${fmt(kpi.last30.ontime)} of ${fmt(kpi.last30.n)} delivered`}
          delta={rateDelta}
          warn={kpi.last30.rate < 60}
        />
        <StatCard
          label="Median turnaround"
          value={f1(kpi.last30.med)}
          unit="bh"
          sub={`against a ${f1(target)} bh target`}
          delta={medDelta}
          higherIsBetter={false}
        />
        <StatCard
          label="90th percentile"
          value={f1(kpi.last30.p90)}
          unit="bh"
          sub="1 in 10 takes longer"
        />
        <StatCard
          label="Delivered, last 30 days"
          value={fmt(kpi.last30.n)}
          sub="first primary COA published"
        />
        <StatCard
          label="Open past target"
          value={fmt(atRisk.late)}
          sub={`of ${fmt(atRisk.total)} open now`}
          warn={atRisk.late > 0}
        />
      </div>

      {/* Cohorts */}
      <Section
        title="Every sample received, by month"
        sub="Grouped by the month a sample was received, not delivered. Still-open work counts against the rate, so the number cannot flatter itself by ignoring what never finished."
        right={
          <Legend
            items={[
              { name: 'delivered on time', color: ON_TIME },
              { name: 'delivered late', color: LATE },
              { name: 'still open', color: OPEN },
            ]}
          />
        }
      >
        <div className={CHART}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={cohortData}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                stroke={GRID}
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                stroke={TICK}
                fontSize={11}
                tickLine={false}
              />
              <YAxis
                stroke={TICK}
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={{
                  background: '#111827',
                  border: '1px solid #374151',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Bar dataKey="ontime" stackId="a" name="On time" fill={ON_TIME} />
              <Bar dataKey="late" stackId="a" name="Late" fill={LATE} />
              <Bar dataKey="open" stackId="a" name="Still open" fill={OPEN} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-lg border border-border/60 overflow-x-auto">
          <table className="w-full" aria-label="Cohorts by receipt month">
            <thead>
              <tr className="bg-muted/30 border-b border-border/40">
                {[
                  'Received',
                  'Samples',
                  'Delivered',
                  'On time',
                  'Late',
                  'Still open',
                  'Of those, past target',
                  'On time of delivered',
                  'On time of received',
                  'Median',
                  'p90',
                ].map(c => (
                  <th key={c} className={cn(TH, 'whitespace-nowrap')}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.map(m => (
                <tr
                  key={m.m}
                  className="border-b border-border/20 hover:bg-muted/30"
                >
                  <td className={cn(TD, 'text-left whitespace-nowrap')}>
                    {m.label}
                    {m.m === data.today.slice(0, 7) && (
                      <span className="text-muted-foreground ml-1">
                        (to date)
                      </span>
                    )}
                  </td>
                  <td className={TD}>{fmt(m.received)}</td>
                  <td className={TD}>{fmt(m.delivered)}</td>
                  <td className={TD}>{fmt(m.ontime)}</td>
                  <td className={TD}>{fmt(m.late)}</td>
                  <td className={TD}>{fmt(m.open)}</td>
                  <td className={TD}>{fmt(m.open_late)}</td>
                  <td className={TD}>{f1(m.rate_delivered)}%</td>
                  <td
                    className={cn(
                      TD,
                      m.rate_received < 60 ? 'text-red-400' : 'text-emerald-400'
                    )}
                  >
                    {f1(m.rate_received)}%
                  </td>
                  <td className={TD}>{f1(m.med)}</td>
                  <td className={TD}>{f1(m.p90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {best && worst && (
          <p className="text-xs text-muted-foreground">
            {best.label} is the strongest complete month at{' '}
            {f1(best.rate_received)}% of everything received delivered on time;{' '}
            {worst.label} is the weakest at {f1(worst.rate_received)}%.
            {stale > 0 &&
              ` ${fmt(stale)} open samples were received before the last two months — that is stale work, not work in progress.`}
          </p>
        )}
      </Section>

      {/* Delivery curve */}
      <Section
        title="How much is delivered by when"
        sub={`Share of delivered samples finished within a given number of business hours. Everything left of the target line met the SLA. Over the last 90 days ${f1(curve.within_target)}% of ${fmt(curve.recent_n)} samples were inside target.`}
        right={
          <Legend
            items={[
              { name: 'last 90 days', color: ON_TIME },
              { name: 'all time', color: TICK },
            ]}
          />
        }
      >
        <div className={CHART}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={curveData}
              margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
            >
              <CartesianGrid
                stroke={GRID}
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="bh"
                stroke={TICK}
                fontSize={11}
                tickLine={false}
                label={{
                  value: 'business hours from receipt',
                  position: 'insideBottom',
                  offset: -2,
                  fill: TICK,
                  fontSize: 11,
                }}
              />
              <YAxis
                stroke={TICK}
                fontSize={11}
                tickLine={false}
                axisLine={false}
                domain={[0, 100]}
                unit="%"
              />
              <Tooltip
                contentStyle={{
                  background: '#111827',
                  border: '1px solid #374151',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <ReferenceLine
                x={target}
                stroke={TARGET_LINE}
                strokeDasharray="5 4"
                label={{
                  value: `${f1(target)} bh target`,
                  fill: TICK,
                  fontSize: 11,
                  position: 'top',
                }}
              />
              <Line
                type="monotone"
                dataKey="all"
                name="All time"
                stroke={TICK}
                strokeDasharray="4 3"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="recent"
                name="Last 90 days"
                stroke={ON_TIME}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* Department gating — the reason this report exists */}
      <Section
        title="Which department holds the COA"
        sub="A sample cannot be published until every department on it has verified its result, so whichever finishes last held the COA. Counted over samples carrying two or more departments; timing comes from verified results, recorded from June 2026."
        right={
          <Legend
            items={chartFamilies.map(f => ({
              name: FAMILY_LABELS[f],
              color: FAMILY_COLORS[f],
            }))}
          />
        }
      >
        {showGating ? (
          <>
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  Share of late samples each department finished last on
                </p>
                <div className={CHART_SM}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={gateData}
                      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid
                        stroke={GRID}
                        strokeDasharray="3 3"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="label"
                        stroke={TICK}
                        fontSize={11}
                        tickLine={false}
                      />
                      <YAxis
                        stroke={TICK}
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        domain={[0, 100]}
                        unit="%"
                      />
                      <Tooltip
                        contentStyle={{
                          background: '#111827',
                          border: '1px solid #374151',
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      />
                      {GATING_FAMILIES.map(f => (
                        <Bar
                          key={f}
                          dataKey={f}
                          stackId="g"
                          name={FAMILY_LABELS[f]}
                          fill={FAMILY_COLORS[f]}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  Receipt to each department finishing, median business hours
                </p>
                <div className={CHART_SM}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={famTrendData}
                      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid
                        stroke={GRID}
                        strokeDasharray="3 3"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="label"
                        stroke={TICK}
                        fontSize={11}
                        tickLine={false}
                      />
                      <YAxis
                        stroke={TICK}
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          background: '#111827',
                          border: '1px solid #374151',
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      />
                      <ReferenceLine
                        y={target}
                        stroke={TARGET_LINE}
                        strokeDasharray="5 4"
                        label={{
                          value: `${f1(target)} bh`,
                          fill: TICK,
                          fontSize: 11,
                          position: 'right',
                        }}
                      />
                      {chartFamilies.map(f => (
                        <Line
                          key={f}
                          type="monotone"
                          dataKey={f}
                          name={FAMILY_LABELS[f]}
                          stroke={FAMILY_COLORS[f]}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {leader && readable && first && (
              <p className="text-xs text-muted-foreground">
                <span className="text-foreground font-medium">
                  {FAMILY_LABELS[leader]} finished last on{' '}
                  {f1(gateShare(readable, leader))}% of late samples in{' '}
                  {readable.label}
                </span>
                , against {f1(gateShare(first, leader))}% in {first.label}. Its
                own median from receipt to verified is{' '}
                {f1(trendMedian(readable, leader) ?? 0)} bh.
                {gating.wait_n > 0 &&
                  ` Samples waited a median ${f1(gating.wait_med)} bh on microbiology after the HPLC panel was done; ${fmt(gating.wait_over_day)} of ${fmt(gating.wait_n)} waited more than a working day.`}
              </p>
            )}

            <div className="rounded-lg border border-border/60 overflow-x-auto">
              <table className="w-full" aria-label="Departments">
                <thead>
                  <tr className="bg-muted/30 border-b border-border/40">
                    {[
                      'Department',
                      'Samples timed',
                      'Receipt to done, median',
                      'p90',
                      'Past target on its own',
                      'Finished last',
                      'Finished last on late',
                      'Share of late',
                    ].map(c => (
                      <th key={c} className={cn(TH, 'whitespace-nowrap')}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {gating.families.map(f => (
                    <tr
                      key={f.k}
                      className={cn(
                        'border-b border-border/20 hover:bg-muted/30',
                        // A department with a handful of timed samples still
                        // gets a row -- hiding it would be its own lie -- but
                        // its percentages are dimmed and never flagged red.
                        f.thin && 'text-muted-foreground'
                      )}
                    >
                      <td className={cn(TD, 'text-left whitespace-nowrap')}>
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-sm mr-1.5 align-middle"
                          style={{
                            backgroundColor:
                              FAMILY_COLORS[f.k as GatingFamilyKey] ?? TICK,
                          }}
                        />
                        {f.name}
                        {f.thin && (
                          <span
                            className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                            title={`Fewer than ${gating.min_timed_for_family} timed samples`}
                          >
                            too few
                          </span>
                        )}
                      </td>
                      <td className={TD}>{fmt(f.n)}</td>
                      <td className={TD}>{f1(f.med)}</td>
                      <td className={TD}>{f1(f.p90)}</td>
                      <td
                        className={cn(
                          TD,
                          !f.thin && f.over_pct > 25
                            ? 'text-red-400'
                            : undefined
                        )}
                      >
                        {f1(f.over_pct)}%
                      </td>
                      <td className={TD}>{fmt(f.gated)}</td>
                      <td className={TD}>{fmt(f.gated_late)}</td>
                      <td
                        className={cn(
                          TD,
                          !f.thin && f.gated_late_pct > 33
                            ? 'text-red-400'
                            : undefined
                        )}
                      >
                        {f1(f.gated_late_pct)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Counted over {fmt(gating.mixed)} delivered samples carrying two or
              more departments, {fmt(gating.late_mixed)} of them late. A
              department finishing last on fewer late samples does not by itself
              mean it sped up — another department may now finish after it. Rows
              marked <span className="uppercase tracking-wide">too few</span>{' '}
              have under {fmt(gating.min_timed_for_family)} timed samples: their
              percentages swing on a single result and are not a trend. Read it
              with the median column.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No late samples carrying two or more departments in this selection,
            so there is nothing to attribute.
          </p>
        )}
      </Section>

      {/* Stage split + at-risk */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="Where the time goes"
          sub={`Median business hours by publication month, over the ${f1(stages.coverage)}% of delivered samples with a verified timestamp.`}
          right={
            <Legend
              items={[
                { name: 'receipt to verified', color: BENCH },
                { name: 'verified to published', color: LAG },
              ]}
            />
          }
        >
          {stageData.length > 0 ? (
            <>
              <div className={CHART_SM}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={stageData}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid
                      stroke={GRID}
                      strokeDasharray="3 3"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="label"
                      stroke={TICK}
                      fontSize={11}
                      tickLine={false}
                    />
                    <YAxis
                      stroke={TICK}
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#111827',
                        border: '1px solid #374151',
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    />
                    <ReferenceLine
                      y={target}
                      stroke={TARGET_LINE}
                      strokeDasharray="5 4"
                      label={{
                        value: `${f1(target)} bh`,
                        fill: TICK,
                        fontSize: 11,
                        position: 'right',
                      }}
                    />
                    <Bar
                      dataKey="bench"
                      stackId="s"
                      name="Receipt to verified"
                      fill={BENCH}
                    />
                    <Bar
                      dataKey="lag"
                      stackId="s"
                      name="Verified to published"
                      fill={LAG}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground">
                The publishing handoff takes a median {f1(stages.lag_med)} bh,{' '}
                {f1(stages.lag_share)}% of total elapsed time;{' '}
                {fmt(stages.lag_over_day)} of {fmt(stages.n)} samples took more
                than a working day to publish after verification. Turnaround is
                set by analysis time.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              No verified-result timing for this selection yet.
            </p>
          )}
        </Section>

        <Section
          title="Open work right now"
          sub="Business hours left before each open sample passes target."
        >
          <div className={CHART_SM}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={atRisk.buckets}
                layout="vertical"
                margin={{ top: 8, right: 16, left: 96, bottom: 0 }}
              >
                <CartesianGrid
                  stroke={GRID}
                  strokeDasharray="3 3"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  stroke={TICK}
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  stroke={TICK}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={96}
                />
                <Tooltip
                  contentStyle={{
                    background: '#111827',
                    border: '1px solid #374151',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="n" name="Samples">
                  {atRisk.buckets.map(b => (
                    <Cell
                      key={b.label}
                      fill={b.label.startsWith('Already') ? LATE : OPEN}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="rounded-lg border border-border/60 overflow-x-auto">
            <table className="w-full" aria-label="Oldest open samples">
              <thead>
                <tr className="bg-muted/30 border-b border-border/40">
                  {[
                    'Sample',
                    'Customer',
                    'Status',
                    'Received',
                    'Elapsed',
                    'Against target',
                  ].map(c => (
                    <th key={c} className={cn(TH, 'whitespace-nowrap')}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {atRisk.rows.slice(0, 12).map(r => (
                  <tr
                    key={r.sid}
                    className="border-b border-border/20 hover:bg-muted/30"
                  >
                    <td className={cn(TD, 'text-left whitespace-nowrap')}>
                      {r.sid}
                    </td>
                    <td
                      className={cn(TD, 'text-left max-w-[14rem] truncate')}
                      title={r.client ?? undefined}
                    >
                      {r.client ?? '–'}
                    </td>
                    <td className={cn(TD, 'text-left whitespace-nowrap')}>
                      {r.status.replace(/_/g, ' ')}
                    </td>
                    <td className={cn(TD, 'whitespace-nowrap')}>
                      {r.received}
                    </td>
                    <td className={TD}>{f1(r.bh)}</td>
                    <td
                      className={cn(
                        TD,
                        r.over > 0 ? 'text-red-400' : 'text-emerald-400'
                      )}
                    >
                      {r.over > 0
                        ? `+${f1(r.over)} over`
                        : `${f1(-r.over)} left`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      {/* Definitions */}
      <Section
        title="Definitions & data notes"
        sub="What the numbers above mean, and where they stop being reliable."
      >
        <ul className="text-xs text-muted-foreground grid gap-1.5 md:grid-cols-2">
          <li>
            <span className="text-foreground">Clock</span> — receipt to the
            sample&apos;s first primary COA. Re-issues are included and the
            earliest wins; an unpublished sample&apos;s clock runs to now.
          </li>
          <li>
            <span className="text-foreground">Business hours</span> — the
            configured lab window in {data.tz}, minus lab holidays, computed by
            the same engine the SLA column uses.
          </li>
          <li>
            <span className="text-foreground">Target</span> — resolved per
            sample from the SLA tier on any service group it touches, else the
            default.{' '}
            {data.targets
              .map(t => `${t.name} ${f1(t.bh)} bh (${fmt(t.samples)})`)
              .join(', ')}
            . A breach is strictly over target.
          </li>
          <li>
            <span className="text-foreground">On time of received</span> — the
            honest rate: still-open samples count against it. The of-delivered
            rate ignores unfinished work.
          </li>
          <li>
            <span className="text-foreground">Verified timing</span> —
            receipt-to-verified and the department cut need a verified result,
            which the registry records from June 2026. Earlier months are volume
            only.
          </li>
          <li>
            <span className="text-foreground">Excluded</span> — January 2026 is
            a migration artifact so the series starts {data.start}; test orders
            are hidden unless the toggle is off; cancelled samples are not
            scored.
          </li>
          <li>
            <span className="text-foreground">Nothing stops the clock</span> — a
            sample waiting on the customer or on an add-on result accrues
            business hours exactly like work on a bench, so a raw breach rate
            overstates lab fault.
          </li>
          <li>
            <span className="text-foreground">Partial period</span> — the
            current month is still receiving and still delivering, so both its
            volume and its rate will move.
          </li>
        </ul>
      </Section>
    </div>
  )
}
