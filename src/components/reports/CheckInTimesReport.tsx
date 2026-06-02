import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Loader2,
  XCircle,
  CalendarDays,
  Clock,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import { cn } from '@/lib/utils'
import { getCheckInTimes } from '@/lib/api'
import type { CheckInRecord } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  PERIOD_DAYS,
  WORK_START_HOUR,
  WORK_END_HOUR,
  filterByPeriod,
  bucketByDay,
  bucketByHour,
  computeSummary,
  formatHourLabel,
  type TimePeriod,
} from './checkin-utils'

// ─── Summary cards ─────────────────────────────────────────────────────────

function StatCard({
  value,
  label,
  accent,
}: {
  value: string | number
  label: string
  accent?: 'emerald' | 'blue' | 'amber' | 'violet'
}) {
  const colors = {
    emerald: 'text-emerald-400 border-emerald-500/30',
    blue: 'text-blue-400 border-blue-500/30',
    amber: 'text-amber-400 border-amber-500/30',
    violet: 'text-violet-400 border-violet-500/30',
  }
  const c = accent ? colors[accent] : 'text-foreground border-border/50'
  return (
    <div className={cn('rounded-lg border bg-card/50 px-4 py-3', c)}>
      <div
        className={cn(
          'text-2xl font-bold tabular-nums',
          accent ? c.split(' ')[0] : 'text-foreground'
        )}
      >
        {value}
      </div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
    </div>
  )
}

// ─── Charts ──────────────────────────────────────────────────────────────────

type ChartView = 'day' | 'hour'

function ChartTooltip({
  active,
  payload,
  label,
  hourLabel,
}: {
  active?: boolean
  payload?: { value: number }[]
  label?: string | number
  hourLabel?: boolean
}) {
  if (!active || !payload?.length || !payload[0]) return null
  const count = payload[0].value
  const title =
    hourLabel && typeof label === 'number'
      ? formatHourLabel(label)
      : String(label ?? '')
  return (
    <div className="rounded-md border border-border/50 bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-foreground mb-0.5">{title}</div>
      <div className="text-muted-foreground">
        {count} check-in{count === 1 ? '' : 's'}
      </div>
    </div>
  )
}

function ByDayChart({ records }: { records: CheckInRecord[] }) {
  const data = useMemo(() => bucketByDay(records), [records])
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="#374151"
          opacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: '#9ca3af' }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 10, fill: '#9ca3af' }}
          tickLine={false}
          axisLine={false}
          width={32}
        />
        <Tooltip
          cursor={{ fill: '#ffffff', fillOpacity: 0.04 }}
          content={<ChartTooltip />}
        />
        <Bar
          dataKey="count"
          fill="#60a5fa"
          radius={[3, 3, 0, 0]}
          maxBarSize={48}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

function ByHourChart({
  records,
  avgMinutes,
}: {
  records: CheckInRecord[]
  avgMinutes: number | null
}) {
  const data = useMemo(() => bucketByHour(records), [records])
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="#374151"
          opacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="hour"
          tick={{ fontSize: 9, fill: '#9ca3af' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(h: number) => (h % 3 === 0 ? formatHourLabel(h) : '')}
          interval={0}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 10, fill: '#9ca3af' }}
          tickLine={false}
          axisLine={false}
          width={32}
        />
        <Tooltip
          cursor={{ fill: '#ffffff', fillOpacity: 0.04 }}
          content={<ChartTooltip hourLabel />}
        />
        {/* Working-hours window markers */}
        <ReferenceLine
          x={WORK_START_HOUR}
          stroke="#34d399"
          strokeDasharray="3 3"
          strokeOpacity={0.4}
        />
        <ReferenceLine
          x={WORK_END_HOUR}
          stroke="#34d399"
          strokeDasharray="3 3"
          strokeOpacity={0.4}
        />
        {avgMinutes != null && (
          <ReferenceLine
            x={Math.round(avgMinutes / 60)}
            stroke="#f59e0b"
            strokeDasharray="6 4"
            strokeOpacity={0.8}
            label={{
              value: 'avg',
              position: 'top',
              fontSize: 9,
              fill: '#f59e0b',
            }}
          />
        )}
        <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={26}>
          {data.map(d => (
            <Cell
              key={d.hour}
              fill={d.offHours ? '#3b82f6' : '#60a5fa'}
              fillOpacity={d.offHours ? 0.35 : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ─── Raw list ──────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc'

function CheckInTable({ records }: { records: CheckInRecord[] }) {
  const [search, setSearch] = useState('')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    let rows = records
    if (q) {
      rows = rows.filter(
        r =>
          r.sample_id.toLowerCase().includes(q) ||
          (r.product_label ?? '').toLowerCase().includes(q)
      )
    }
    return [...rows].sort((a, b) => {
      const cmp = a.date_received.localeCompare(b.date_received)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [records, search, sortDir])

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-64">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Search samples or product..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8 h-8 text-sm"
        />
      </div>

      <div className="rounded-lg border border-border/60 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-muted/30 border-b border-border/40">
              <th
                className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none"
                onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
              >
                <span className="inline-flex items-center gap-1.5">
                  Checked In
                  {sortDir === 'desc' ? (
                    <ArrowDown className="h-3 w-3 text-foreground" />
                  ) : (
                    <ArrowUp className="h-3 w-3 text-foreground" />
                  )}
                </span>
              </th>
              <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Sample
              </th>
              <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Product
              </th>
              <th className="px-3 py-2 text-center text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                <ArrowUpDown className="h-3 w-3 text-muted-foreground/40 inline-block mr-1" />
                Priority
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => {
              const d = new Date(r.date_received)
              return (
                <tr
                  key={r.sample_uid}
                  className="border-b border-border/20 hover:bg-muted/30 transition-colors"
                >
                  <td className="px-3 py-2 text-sm tabular-nums whitespace-nowrap">
                    {d.toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: '2-digit',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-3 py-2 text-sm font-mono">{r.sample_id}</td>
                  <td className="px-3 py-2 text-sm">
                    {r.product_label ?? (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span
                      className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded font-medium',
                        r.priority === 'expedited'
                          ? 'bg-red-500/15 text-red-400'
                          : r.priority === 'high'
                            ? 'bg-amber-500/15 text-amber-400'
                            : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {r.priority}
                    </span>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  {search
                    ? 'No check-ins matching search'
                    : 'No check-ins in this range'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function CheckInTimesReport() {
  const [period, setPeriod] = useState<TimePeriod>('3M')
  const [chartView, setChartView] = useState<ChartView>('hour')
  const [hideTestOrders, setHideTestOrders] = useState(true)

  const { data, isLoading, error } = useQuery({
    queryKey: ['reports', 'checkin-times'],
    queryFn: () => getCheckInTimes(),
    staleTime: 60_000,
  })

  const records = useMemo(() => {
    if (!data) return []
    const base = hideTestOrders ? data.filter(r => !r.is_test_order) : data
    return filterByPeriod(base, period)
  }, [data, period, hideTestOrders])
  const summary = useMemo(() => computeSummary(records), [records])

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Check-In Times</h1>
          <p className="text-xs text-muted-foreground">
            When samples are received, by day and time of day
          </p>
        </div>
        <div className="flex items-center gap-4">
          {/* Hide test orders — parity with Order Status / inbox */}
          <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap cursor-pointer">
            <Checkbox
              checked={hideTestOrders}
              onCheckedChange={checked => setHideTestOrders(checked === true)}
            />
            Hide test orders
          </label>

          {/* Date-range period selector */}
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
          Failed to load check-in data
        </div>
      )}

      {data && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-4 gap-3">
            <StatCard value={summary.total} label="Check-Ins" accent="blue" />
            <StatCard
              value={summary.avgLabel}
              label="Avg Time of Day"
              accent="amber"
            />
            <StatCard
              value={
                summary.busiestHour != null
                  ? formatHourLabel(summary.busiestHour)
                  : '—'
              }
              label="Busiest Hour"
              accent="emerald"
            />
            <StatCard
              value={summary.busiestWeekday ?? '—'}
              label="Busiest Day"
              accent="violet"
            />
          </div>

          {/* Chart panel */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {chartView === 'day'
                  ? 'Check-ins per day'
                  : 'Check-ins by time of day'}
              </span>
              <div className="flex items-center gap-0.5 rounded-lg border border-border/60 p-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-7 w-7 cursor-pointer',
                    chartView === 'hour' && 'bg-accent'
                  )}
                  onClick={() => setChartView('hour')}
                  title="By time of day"
                >
                  <Clock className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-7 w-7 cursor-pointer',
                    chartView === 'day' && 'bg-accent'
                  )}
                  onClick={() => setChartView('day')}
                  title="By day"
                >
                  <CalendarDays className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="rounded-lg border border-border/50 bg-card/30 p-3 h-[300px]">
              {records.length === 0 ? (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  No check-ins in this range
                </div>
              ) : chartView === 'day' ? (
                <ByDayChart records={records} />
              ) : (
                <ByHourChart
                  records={records}
                  avgMinutes={summary.avgMinutes}
                />
              )}
            </div>
          </div>

          {/* Raw list */}
          <CheckInTable records={records} />
        </>
      )}
    </div>
  )
}
