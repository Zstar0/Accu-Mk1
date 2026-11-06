import { useEffect, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Loader2, XCircle } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import { getThroughput } from '@/lib/api'
import type {
  ThroughputDay,
  ThroughputQuery,
  ThroughputReport as Report,
} from '@/lib/api'
import { Input } from '@/components/ui/input'
import { CustomerCombobox } from './CustomerCombobox'
import {
  AGE_ORDER,
  RANGE_KEYS,
  aggregateMonths,
  aggregateWeeks,
  businessDays,
  dowProfile,
  flowWeeks,
  kpiWindows,
  longDay,
  pct,
  pctChange,
  perBusinessDay,
  shortDay,
  sliceRange,
  staleSplit,
  sumKey,
  type MonthAgg,
  type RangeKey,
} from './throughput-utils'

// ─── Palette (CVD-validated for the dark surface, same as the offline report) ─

const FAMILY_COLORS: Record<FamilyKey, string> = {
  hplc: '#1FA3BE',
  ster: '#d95926',
  endo: '#9085e9',
  bacw: '#c98500',
  hm: '#f472b6', // not in the CVD-validated set; distinct hue + luminance from the four above
  other: '#6b7280',
}
const INSTRUMENT_RAMP = ['#1FA3BE', '#125E70', '#79BFCF', '#0b3a45']
const UNASSIGNED_COLOR = '#6b7280'
const GRID = '#374151'
const TICK = '#9ca3af'
const INTAKE = '#9ca3af'
const ACCENT = '#1FA3BE'

type FamilyKey = 'hplc' | 'ster' | 'endo' | 'bacw' | 'hm' | 'other'
const CORE_FAMILIES: FamilyKey[] = ['hplc', 'ster', 'endo', 'bacw']
const FAMILIES: { k: FamilyKey; name: string }[] = [
  { k: 'hplc', name: 'HPLC panel' },
  { k: 'ster', name: 'Sterility' },
  { k: 'endo', name: 'Endotoxin' },
  { k: 'bacw', name: 'Bac Water panel' },
  { k: 'hm', name: 'Heavy metals' },
  { k: 'other', name: 'Other' },
]

const fmt = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US')
const f1 = (n: number | null | undefined) =>
  n == null || Number.isNaN(n)
    ? '–'
    : (Math.round(n * 10) / 10).toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })

function instrumentColor(name: string, index: number) {
  if (/unassigned/i.test(name)) return UNASSIGNED_COLOR
  return INSTRUMENT_RAMP[index % INSTRUMENT_RAMP.length] ?? ACCENT
}

// ─── Summary cards ─────────────────────────────────────────────────────────

function StatCard({
  value,
  unit,
  label,
  sub,
  delta,
  neutral,
}: {
  value: string
  unit?: string
  label: string
  sub?: string
  delta?: number | null
  neutral?: boolean
}) {
  const up = delta != null && delta >= 0
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-4 py-3">
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
            neutral
              ? 'text-muted-foreground'
              : up
                ? 'text-emerald-400'
                : 'text-red-400'
          )}
        >
          {up ? '▲' : '▼'} {f1(Math.abs(delta))}% vs prior 30 days
        </div>
      )}
    </div>
  )
}

// ─── Charts ──────────────────────────────────────────────────────────────────

interface TooltipRow {
  name: string
  value: string
  strong?: boolean
}

function ChartTooltip({
  active,
  payload,
  rows,
}: {
  active?: boolean
  payload?: { payload: Record<string, unknown> }[]
  rows: (datum: Record<string, unknown>) => {
    title: string
    rows: TooltipRow[]
  }
}) {
  const datum = payload?.[0]?.payload
  if (!active || !datum) return null
  const { title, rows: list } = rows(datum)
  return (
    <div className="rounded-md border border-border/50 bg-popover px-3 py-2 text-xs shadow-lg min-w-44">
      <div className="font-medium text-foreground mb-1">{title}</div>
      {list.map(r => (
        <div
          key={r.name}
          className={cn(
            'flex justify-between gap-4 tabular-nums',
            r.strong
              ? 'text-foreground border-t border-border/40 mt-1 pt-1'
              : 'text-muted-foreground'
          )}
        >
          <span>{r.name}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

function Legend({
  items,
}: {
  items: { name: string; color: string; line?: boolean }[]
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {items.map(i => (
        <span key={i.name} className="inline-flex items-center gap-1.5">
          <i
            className={cn(
              'inline-block',
              i.line ? 'w-4 h-0.5' : 'w-2.5 h-2.5 rounded-sm'
            )}
            style={{ background: i.color }}
          />
          {i.name}
        </span>
      ))}
    </div>
  )
}

const axisProps = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 10, fill: TICK },
}

function familyRows(
  d: Record<string, unknown>,
  present: FamilyKey[]
): TooltipRow[] {
  const rows: TooltipRow[] = present.map(k => ({
    name: FAMILIES.find(f => f.k === k)?.name ?? k,
    value: fmt(Number(d[k] ?? 0)),
  }))
  rows.push({ name: 'Tests', value: fmt(Number(d.tests ?? 0)), strong: true })
  return rows
}

function DailyChart({
  days,
  present,
}: {
  days: ThroughputDay[]
  present: FamilyKey[]
}) {
  const many = days.length > 40
  const data = days.map(d => ({ ...d, label: shortDay(d.d) }))
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={GRID}
          opacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="label"
          {...axisProps}
          interval={many ? 'preserveStartEnd' : 0}
          minTickGap={24}
        />
        <YAxis allowDecimals={false} {...axisProps} width={32} />
        {/* Weekend wash + holiday ticks (spec §Frontend item 2) */}
        {data
          .filter(d => !d.biz && !d.hol && d.dow >= 5)
          .map(d => (
            <ReferenceArea
              key={`wk-${d.d}`}
              x1={d.label}
              x2={d.label}
              fill="#ffffff"
              fillOpacity={0.04}
              stroke="none"
            />
          ))}
        {data
          .filter(d => d.hol)
          .map(d => (
            <ReferenceLine
              key={`hol-${d.d}`}
              x={d.label}
              stroke={TICK}
              strokeDasharray="2 3"
              strokeOpacity={0.6}
            />
          ))}
        <Tooltip
          cursor={{ fill: '#ffffff', fillOpacity: 0.04 }}
          content={
            <ChartTooltip
              rows={d => ({
                title: longDay(String(d.d)) + (d.hol ? ' · holiday' : ''),
                rows: [
                  ...familyRows(d, present),
                  { name: 'Samples', value: fmt(Number(d.samples)) },
                  { name: 'Vials received', value: fmt(Number(d.vials)) },
                  { name: 'Distinct clients', value: fmt(Number(d.clients)) },
                  { name: 'Primary COAs out', value: fmt(Number(d.coa)) },
                ],
              })}
            />
          }
        />
        {present.map(k => (
          <Bar
            key={k}
            dataKey={k}
            stackId="tests"
            fill={FAMILY_COLORS[k]}
            maxBarSize={24}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

function WeeklyChart({
  days,
  present,
}: {
  days: ThroughputDay[]
  present: FamilyKey[]
}) {
  const weeks = aggregateWeeks(days)
  const data = weeks.map(w => ({ ...w, label: shortDay(w.start) }))
  const last = present[present.length - 1]
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 16, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={GRID}
          opacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="label"
          {...axisProps}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis allowDecimals={false} {...axisProps} width={36} />
        <Tooltip
          cursor={{ fill: '#ffffff', fillOpacity: 0.04 }}
          content={
            <ChartTooltip
              rows={d => ({
                title: `${String(d.w)} · ${shortDay(String(d.start))} – ${shortDay(String(d.end))}`,
                rows: [
                  ...familyRows(d, present),
                  { name: 'Samples', value: fmt(Number(d.samples)) },
                  { name: 'Business days', value: fmt(Number(d.biz)) },
                  { name: 'Samples completed', value: fmt(Number(d.fp)) },
                ],
              })}
            />
          }
        />
        {present.map(k => (
          <Bar
            key={k}
            dataKey={k}
            stackId="tests"
            fill={FAMILY_COLORS[k]}
            maxBarSize={28}
          >
            {k === last && (
              <LabelList
                dataKey="tests"
                position="top"
                fontSize={10}
                fill={TICK}
              />
            )}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

function FlowChart({ days, today }: { days: ThroughputDay[]; today: string }) {
  const weeks = flowWeeks(aggregateWeeks(days), today)
  const data = weeks.map(w => ({
    ...w,
    label: shortDay(w.start),
    net: w.fp - w.samples,
  }))
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={GRID}
          opacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="label"
          {...axisProps}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis allowDecimals={false} {...axisProps} width={36} />
        <Tooltip
          content={
            <ChartTooltip
              rows={d => ({
                title: `${String(d.w)} · ${shortDay(String(d.start))} – ${shortDay(String(d.end))}`,
                rows: [
                  { name: 'Samples received', value: fmt(Number(d.samples)) },
                  {
                    name: 'Samples completed (first COA)',
                    value: fmt(Number(d.fp)),
                  },
                  {
                    name: 'Primary COAs (incl. re-issues)',
                    value: fmt(Number(d.coa)),
                  },
                  { name: 'Additional COAs', value: fmt(Number(d.acoa)) },
                  {
                    name: 'Net (completed − received)',
                    value: `${Number(d.net) > 0 ? '+' : ''}${fmt(Number(d.net))}`,
                    strong: true,
                  },
                ],
              })}
            />
          }
        />
        <Line
          type="monotone"
          dataKey="samples"
          stroke={INTAKE}
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="fp"
          stroke={ACCENT}
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

function BacklogChart({ days }: { days: ThroughputDay[] }) {
  const step = Math.max(1, Math.ceil(days.length / 90))
  const data = days
    .filter((_, i) => i % step === 0 || i === days.length - 1)
    .map(d => ({ ...d, label: shortDay(d.d) }))
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={GRID}
          opacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="label"
          {...axisProps}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis allowDecimals={false} {...axisProps} width={36} />
        <Tooltip
          content={
            <ChartTooltip
              rows={d => ({
                title: longDay(String(d.d)),
                rows: [{ name: 'Open samples', value: fmt(Number(d.backlog)) }],
              })}
            />
          }
        />
        <Line
          type="monotone"
          dataKey="backlog"
          stroke={ACCENT}
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

function BenchChart({
  days,
  instruments,
}: {
  days: ThroughputDay[]
  instruments: string[]
}) {
  const data = days.map(d => {
    const row: Record<string, unknown> = { ...d, label: shortDay(d.d) }
    for (const n of instruments) row[`i:${n}`] = d.bench_inst[n] ?? 0
    return row
  })
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={GRID}
          opacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="label"
          {...axisProps}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis allowDecimals={false} {...axisProps} width={32} />
        <Tooltip
          cursor={{ fill: '#ffffff', fillOpacity: 0.04 }}
          content={
            <ChartTooltip
              rows={d => ({
                title: longDay(String(d.d)),
                rows: [
                  ...instruments.map(n => ({
                    name: n,
                    value: fmt(Number(d[`i:${n}`] ?? 0)),
                  })),
                  {
                    name: 'Vials processed',
                    value: fmt(Number(d.bench_vials)),
                    strong: true,
                  },
                  { name: 'Processing runs', value: fmt(Number(d.bench_rows)) },
                ],
              })}
            />
          }
        />
        {instruments.map((n, i) => (
          <Bar
            key={n}
            dataKey={`i:${n}`}
            stackId="bench"
            fill={instrumentColor(n, i)}
            maxBarSize={24}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

function DowChart({ days }: { days: ThroughputDay[] }) {
  const data = dowProfile(days).map(r => ({
    ...r,
    avg: Math.round(r.avgTests * 10) / 10,
  }))
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 16, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={GRID}
          opacity={0.5}
          vertical={false}
        />
        <XAxis dataKey="dow" {...axisProps} interval={0} />
        <YAxis {...axisProps} width={32} />
        <Tooltip
          cursor={{ fill: '#ffffff', fillOpacity: 0.04 }}
          content={
            <ChartTooltip
              rows={d => ({
                title: `${String(d.dow)} · ${fmt(Number(d.n))} days`,
                rows: [
                  { name: 'Avg tests received', value: f1(Number(d.avgTests)) },
                  {
                    name: 'Avg samples received',
                    value: f1(Number(d.avgSamples)),
                  },
                  {
                    name: 'Avg primary COAs published',
                    value: f1(Number(d.avgCoa)),
                  },
                ],
              })}
            />
          }
        />
        <Bar dataKey="avg" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={40}>
          <LabelList dataKey="avg" position="top" fontSize={10} fill={TICK} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function AttachChart({ months }: { months: MonthAgg[] }) {
  const data = months.map(m => ({ ...m, short: m.label.slice(0, 3) }))
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={GRID}
          opacity={0.5}
          vertical={false}
        />
        <XAxis dataKey="short" {...axisProps} interval={0} />
        <YAxis {...axisProps} width={36} unit="%" />
        <Tooltip
          content={
            <ChartTooltip
              rows={d => ({
                title: `${String(d.label)}${d.full ? '' : ' (to date)'}`,
                rows: [
                  {
                    name: 'Sterility',
                    value: `${f1(Number(d.ster_pct))}%`,
                  },
                  {
                    name: 'Endotoxin',
                    value: `${f1(Number(d.endo_pct))}%`,
                  },
                  {
                    name: 'Bac Water panel',
                    value: `${f1(Number(d.bacw_pct))}%`,
                  },
                  {
                    name: 'Samples',
                    value: fmt(Number(d.samples)),
                    strong: true,
                  },
                ],
              })}
            />
          }
        />
        <Line
          type="monotone"
          dataKey="ster_pct"
          stroke={FAMILY_COLORS.ster}
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="endo_pct"
          stroke={FAMILY_COLORS.endo}
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="bacw_pct"
          stroke={FAMILY_COLORS.bacw}
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ─── Tables ──────────────────────────────────────────────────────────────────

const TH =
  'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-3 py-2 text-sm tabular-nums'
const NA = <span className="text-muted-foreground/40">n/a</span>

function MonthlyTable({
  months,
  notes,
}: {
  months: MonthAgg[]
  notes: Report['notes']
}) {
  const tot = months.reduce(
    (a, m) => ({
      biz: a.biz + m.biz,
      samples: a.samples + m.samples,
      tests: a.tests + m.tests,
      hplc: a.hplc + m.hplc,
      ster: a.ster + m.ster,
      endo: a.endo + m.endo,
      bacw: a.bacw + m.bacw,
      hm: a.hm + m.hm,
      vials: a.vials + (m.m >= notes.vials_from ? m.vials : 0),
      bench_vials: a.bench_vials + m.bench_vials,
      fp: a.fp + m.fp,
      coa: a.coa + m.coa,
      acoa: a.acoa + m.acoa,
    }),
    {
      biz: 0,
      samples: 0,
      tests: 0,
      hplc: 0,
      ster: 0,
      endo: 0,
      bacw: 0,
      hm: 0,
      vials: 0,
      bench_vials: 0,
      fp: 0,
      coa: 0,
      acoa: 0,
    }
  )
  const cols = [
    'Month',
    'Biz days',
    'Samples',
    'Tests',
    'Tests / biz day',
    'HPLC',
    'Sterility',
    'Endotoxin',
    'Bac Water',
    'Heavy metals',
    'Ster attach',
    'Vials in',
    'HPLC vials run',
    'Samples completed',
    'Primary COAs',
    'COAs / biz day',
    'Addl COAs',
  ]
  return (
    <div className="rounded-lg border border-border/60 overflow-x-auto">
      <table className="w-full" aria-label="Month by month">
        <thead>
          <tr className="bg-muted/30 border-b border-border/40">
            {cols.map(c => (
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
              className="border-b border-border/20 hover:bg-muted/30 transition-colors"
            >
              <td className={cn(TD, 'whitespace-nowrap')}>
                {m.label}
                {!m.full && (
                  <span className="text-muted-foreground ml-1">(to date)</span>
                )}
              </td>
              <td className={TD}>{fmt(m.biz)}</td>
              <td className={TD}>{fmt(m.samples)}</td>
              <td className={TD}>{fmt(m.tests)}</td>
              <td className={TD}>{f1(m.tpb)}</td>
              <td className={TD}>{fmt(m.hplc)}</td>
              <td className={TD}>{fmt(m.ster)}</td>
              <td className={TD}>{fmt(m.endo)}</td>
              <td className={TD}>{fmt(m.bacw)}</td>
              <td className={TD}>{fmt(m.hm)}</td>
              <td className={TD}>{f1(m.ster_pct)}%</td>
              <td className={TD}>
                {m.m < notes.vials_from ? NA : fmt(m.vials)}
              </td>
              <td className={TD}>
                {m.m < notes.bench_from ? NA : fmt(m.bench_vials)}
              </td>
              <td className={TD}>{fmt(m.fp)}</td>
              <td className={TD}>{fmt(m.coa)}</td>
              <td className={TD}>{f1(m.cpb)}</td>
              <td className={TD}>{fmt(m.acoa)}</td>
            </tr>
          ))}
          <tr className="font-semibold bg-muted/20">
            <td className={TD}>Total</td>
            <td className={TD}>{fmt(tot.biz)}</td>
            <td className={TD}>{fmt(tot.samples)}</td>
            <td className={TD}>{fmt(tot.tests)}</td>
            <td className={TD}>{f1(tot.biz ? tot.tests / tot.biz : 0)}</td>
            <td className={TD}>{fmt(tot.hplc)}</td>
            <td className={TD}>{fmt(tot.ster)}</td>
            <td className={TD}>{fmt(tot.endo)}</td>
            <td className={TD}>{fmt(tot.bacw)}</td>
            <td className={TD}>{fmt(tot.hm)}</td>
            <td className={TD}>{f1(pct(tot.ster, tot.samples))}%</td>
            <td className={TD}>{fmt(tot.vials)}</td>
            <td className={TD}>{fmt(tot.bench_vials)}</td>
            <td className={TD}>{fmt(tot.fp)}</td>
            <td className={TD}>{fmt(tot.coa)}</td>
            <td className={TD}>{f1(tot.biz ? tot.coa / tot.biz : 0)}</td>
            <td className={TD}>{fmt(tot.acoa)}</td>
          </tr>
        </tbody>
      </table>
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

const CHART = 'h-[300px]'
const CHART_SM = 'h-[240px]'

// ─── Page ─────────────────────────────────────────────────────────────────────

/** Debounce a text input so the Order # box doesn't refetch per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

// Chip look mirrors the Vial Status board's lane chips (its neutral-violet
// fallback — the report has no catalog role colours to borrow).
const CHIP_ON =
  'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300'
const CHIP_OFF =
  'bg-transparent text-muted-foreground border-border hover:bg-muted/40'

export function ThroughputReport() {
  const [range, setRange] = useState<RangeKey>('90')
  const [hideTestOrders, setHideTestOrders] = useState(true)
  const [department, setDepartment] = useState('')
  const [family, setFamily] = useState('')
  const [client, setClient] = useState('')
  const [orderInput, setOrderInput] = useState('')
  const order = useDebounced(orderInput.trim(), 400)

  const query: ThroughputQuery = {
    includeTestOrders: !hideTestOrders,
    client,
    order,
    departments: department ? [department] : [],
    families: family ? [family] : [],
  }
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['reports', 'throughput', query],
    queryFn: () => getThroughput(query),
    staleTime: 60_000,
    // Filters refetch server-side; keep the last report (and its facets) on
    // screen while the next one loads so the chips never blink away.
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Lab Throughput</h1>
          <p className="text-xs text-muted-foreground">
            Tests, samples, COAs and bench load per day
            {data &&
              ` · ${shortDay(data.start)} – ${shortDay(data.today)} · lab time (${data.tz})`}
            {isFetching && data && ' · updating…'}
          </p>
        </div>
        <div className="flex rounded-md border border-border/50 overflow-hidden">
          {RANGE_KEYS.map(r => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={cn(
                'px-3 py-1 text-xs font-medium transition-colors cursor-pointer',
                range === r
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              {r === 'all' ? 'All' : `${r}d`}
            </button>
          ))}
        </div>
      </div>

      {/* Department chips — same block as the Vial Status board; the filter is
          applied server-side, so each click is a (cached, ~50 ms) refetch. */}
      <div className="flex flex-col gap-2">
        {facets && (
          <div className="flex flex-wrap items-center gap-2">
            {[
              { key: '', name: 'All departments', tests: 0 },
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
                title={
                  d.key
                    ? `${d.tests} test${d.tests === 1 ? '' : 's'}`
                    : undefined
                }
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
                tests: subChips.reduce((n, f) => n + f.tests, 0),
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
                  {f.tests}
                </span>
              </button>
            ))}
          </div>
        )}
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          <CustomerCombobox
            value={client}
            options={facets?.clients ?? []}
            onChange={setClient}
          />
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
          Failed to load throughput data
        </div>
      )}

      {data && <ReportBody data={data} range={range} scoped={scoped} />}
    </div>
  )
}

function ReportBody({
  data,
  range,
  scoped,
}: {
  data: Report
  range: RangeKey
  scoped: boolean
}) {
  const days = data.days
  // Unscoped: the four core families always hold a legend slot, the optional ones
  // (heavy metals, other) only when the data has them. Scoped: data-driven only.
  const present: FamilyKey[] = FAMILIES.map(f => f.k).filter(
    k => days.some(d => d[k] > 0) || (!scoped && CORE_FAMILIES.includes(k))
  )
  const legend = FAMILIES.filter(f => present.includes(f.k)).map(f => ({
    name: f.name,
    color: FAMILY_COLORS[f.k],
  }))
  const ranged = sliceRange(days, range)
  const months = aggregateMonths(days, data.today)
  const { last30, prev30 } = kpiWindows(days)
  const { stale, live } = staleSplit(data.backlog_now)
  const waiting = data.backlog_now.status['waiting_for_addon_results'] ?? 0

  const kTests = perBusinessDay(last30, 'tests')
  const kSamples = perBusinessDay(last30, 'samples')
  const kCoa = perBusinessDay(last30, 'coa')
  const kBench = perBusinessDay(last30, 'bench_vials')
  const kAttach = pct(sumKey(last30, 'ster'), sumKey(last30, 'samples'))
  const pAttach = pct(sumKey(prev30, 'ster'), sumKey(prev30, 'samples'))
  const peak = days.reduce<ThroughputDay | undefined>(
    (a, d) => (!a || d.tests > a.tests ? d : a),
    undefined
  )
  const partialWeek = (() => {
    const weeks = aggregateWeeks(days)
    return flowWeeks(weeks, data.today).length < weeks.length
  })()
  const ageParts = AGE_ORDER.filter(k => data.backlog_now.age[k]).map(
    k => `${k} ${fmt(data.backlog_now.age[k])}`
  )
  const statusParts = Object.entries(data.backlog_now.status)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmt(v)}`)
  const holidaysInRange = data.holidays
    .filter(h => h <= data.today)
    .map(shortDay)

  return (
    <>
      {/* KPIs — last 30 vs prior 30 calendar days, per business day */}
      <div className="grid grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard
          label="Tests / business day"
          value={f1(kTests)}
          sub={`last 30 days · ${fmt(sumKey(last30, 'tests'))} tests over ${fmt(businessDays(last30))} business days`}
          delta={pctChange(kTests, perBusinessDay(prev30, 'tests'))}
        />
        <StatCard
          label="Samples / business day"
          value={f1(kSamples)}
          sub={`${fmt(sumKey(last30, 'samples'))} samples · ${fmt(sumKey(last30, 'vials'))} vials received`}
          delta={pctChange(kSamples, perBusinessDay(prev30, 'samples'))}
        />
        <StatCard
          label="COAs published / business day"
          value={f1(kCoa)}
          sub={`${fmt(sumKey(last30, 'coa'))} primary (${fmt(sumKey(last30, 'fp'))} samples completed) + ${fmt(sumKey(last30, 'acoa'))} additional`}
          delta={pctChange(kCoa, perBusinessDay(prev30, 'coa'))}
        />
        <StatCard
          label="HPLC vials run / business day"
          value={f1(kBench)}
          sub={`${fmt(sumKey(last30, 'bench_vials'))} vials · ${fmt(sumKey(last30, 'bench_rows'))} processing runs`}
          delta={pctChange(kBench, perBusinessDay(prev30, 'bench_vials'))}
        />
        <StatCard
          label="Add-on attach rate"
          value={f1(kAttach)}
          unit="%"
          sub={`of samples ordered sterility · endotoxin ${f1(pct(sumKey(last30, 'endo'), sumKey(last30, 'samples')))}%`}
          delta={pctChange(kAttach, pAttach)}
          neutral
        />
        <StatCard
          label="Open backlog now"
          value={fmt(data.backlog_now.total)}
          sub={`${fmt(stale)} older than 30 days (stale) · ${fmt(live)} live · ${fmt(waiting)} waiting on add-ons`}
        />
      </div>

      {peak && (
        <p className="text-xs text-muted-foreground">
          Over the last 30 days the lab took in{' '}
          <b className="text-foreground">{f1(kTests)} tests</b> per business day
          ({f1(kSamples)} samples), published {f1(kCoa)} primary COAs per
          business day and ran {f1(kBench)} HPLC vials per business day. Busiest
          single day: <b className="text-foreground">{fmt(peak.tests)} tests</b>{' '}
          on {longDay(peak.d)}.
        </p>
      )}

      <Section
        title="Tests received per day, by type"
        sub="Each bar is one calendar day (lab time). A test is one HPLC panel, one sterility test (PCR or USP 71), one endotoxin test, one Bac Water panel or one heavy-metals panel ordered on a sample that arrived that day. Weekends are shaded; holidays are ticked. Follows the range selector."
      >
        <Legend items={legend} />
        <div className={CHART}>
          <DailyChart days={ranged} present={present} />
        </div>
      </Section>

      <Section
        title="Tests received per week"
        sub="ISO weeks (Mon–Sun), whole series. The number on each column is the week's total; the current week is partial."
      >
        <Legend items={legend} />
        <div className={CHART}>
          <WeeklyChart days={days} present={present} />
        </div>
      </Section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Section
          title="Intake vs output, weekly"
          sub={`Samples received against samples completed (first primary COA) in the same week. Output above intake means the lab is eating into backlog.${partialWeek ? ' The current partial week is omitted.' : ''}`}
        >
          <Legend
            items={[
              { name: 'Samples received', color: INTAKE, line: true },
              { name: 'Samples completed', color: ACCENT, line: true },
            ]}
          />
          <div className={CHART_SM}>
            <FlowChart days={days} today={data.today} />
          </div>
        </Section>
        <Section
          title="Open samples (backlog)"
          sub="Samples received but not yet published (first primary COA), end of each day. Cancelled samples excluded."
        >
          <div className={CHART_SM}>
            <BacklogChart days={days} />
          </div>
          <p className="text-xs text-muted-foreground">
            Now:{' '}
            <b className="text-foreground">
              {fmt(data.backlog_now.total)} open
            </b>
            {ageParts.length > 0 && (
              <> — by age since receipt: {ageParts.join(' · ')}</>
            )}
            {statusParts.length > 0 && (
              <>. By status: {statusParts.join(' · ')}</>
            )}
            . The {fmt(stale)} samples older than 30 days are largely abandoned
            or blocked work (see the SLA report&apos;s blocker analysis); the
            live queue is the {fmt(live)} received in the last month.
          </p>
        </Section>
      </div>

      <Section
        title="Month by month"
        sub="Volumes and per-business-day rates. Business days = working days minus lab holidays. The current month is partial."
      >
        <MonthlyTable months={months} notes={data.notes} />
      </Section>

      <Section
        title="HPLC bench: vials processed per day"
        sub="Distinct vials with an HPLC result processed each day, split by instrument. Follows the range selector. Bench work runs later than intake — evening runs land on the same lab day."
      >
        <Legend
          items={data.instruments.map((n, i) => ({
            name: n,
            color: instrumentColor(n, i),
          }))}
        />
        <div className={CHART}>
          <BenchChart days={ranged} instruments={data.instruments} />
        </div>
      </Section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Section
          title="Day-of-week profile"
          sub="Average tests received per weekday over the selected range (holidays excluded)."
        >
          <div className={CHART_SM}>
            <DowChart days={ranged} />
          </div>
        </Section>
        <Section
          title="Add-on attach rate by month"
          sub="Share of samples that ordered each add-on alongside the HPLC panel."
        >
          <Legend
            items={FAMILIES.filter(
              f => f.k === 'ster' || f.k === 'endo' || f.k === 'bacw'
            ).map(f => ({
              name: f.name,
              color: FAMILY_COLORS[f.k],
              line: true,
            }))}
          />
          <div className={CHART_SM}>
            <AttachChart months={months} />
          </div>
        </Section>
      </div>

      <Section title="Definitions & data notes">
        <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-1.5">
          <li>
            <b className="text-foreground">Test</b> = one analysis family
            ordered on a sample: the HPLC panel (identity + purity + quantity,
            incl. blend analytes — counted once per sample no matter how many
            vials or analytes), Sterility (STER-PCR, STERILITY-PCR or
            STERILITY-USP71), Endotoxin (ENDO-LAL or ENDOTOXIN-USP85LAL), the
            Heavy metals panel (lead, cadmium, mercury, arsenic — counted once
            per sample), and the Bac Water panel (benzyl alcohol assay + pH +
            fill volume — counted once per sample). Anything else (e.g. KF
            moisture) appears as &quot;Other&quot;. Source:{' '}
            <code>lims_analyses</code> de-duplicated on (sample, keyword) across
            the SENAITE mirror and native rows, so pre-June samples are
            included.
          </li>
          <li>
            <b className="text-foreground">Day</b> = the day the sample was
            received (<code>lims_samples.date_received</code>
            ), converted from UTC to {data.tz}. Receipts cluster late morning
            local; HPLC bench work runs into the evening but stays on the same
            lab day.
          </li>
          <li>
            <b className="text-foreground">Primary COAs</b> = first-party COA
            publications (<code>coa_generations</code> in the Integration
            Service, no parent generation, superseded/re-issued included,
            counted on their publish day).{' '}
            <b className="text-foreground">Samples completed</b> = a
            sample&apos;s <em>first</em> primary publication — the clean
            counterpart to samples received.{' '}
            <b className="text-foreground">Additional COAs</b> = branded copies
            for sub-clients. <b className="text-foreground">Backlog</b> =
            received, not cancelled, and no primary COA yet.
          </li>
          <li>
            <b className="text-foreground">HPLC vials run</b> = distinct vial
            labels with an <code>hplc_analyses</code> row that day, split by
            instrument; &quot;processing runs&quot; counts every row
            (re-processing included). Bench data exists from March 2026.
          </li>
          <li>
            <b className="text-foreground">Vials received</b> only exist from
            June 2026 (native check-in); earlier months show n/a.{' '}
            <b className="text-foreground">January 2026</b> is a migration
            artifact (every sample shares one receipt timestamp) and is
            excluded.
          </li>
          <li>
            Business days follow the lab calendar in Settings → Business Hours
            (holidays in range:{' '}
            {holidaysInRange.length ? holidaysInRange.join(', ') : 'none'}).
            Today ({shortDay(data.today)}) is partial, so the last bar and the
            current week/month under-count. Test orders are hidden unless the
            toggle above is unticked.
          </li>
        </ul>
      </Section>
    </>
  )
}
