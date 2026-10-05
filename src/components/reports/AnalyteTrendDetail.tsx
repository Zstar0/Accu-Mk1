import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import type { AnalyteTrendCoa } from '@/lib/api'
import { getWordpressUrl } from '@/lib/api-profiles'
import { Button } from '@/components/ui/button'
import { SampleIdBadge } from '@/components/samples/SampleIdBadge'
import {
  QTY_FLAG_PCT,
  TEST_KEYS,
  TEST_LABELS,
  commonMinSpec,
  failedTests,
  isFailed,
  labDate,
  labDateTime,
  labDay,
  labTick,
  median,
  outcome,
  qtyDeltaPct,
  since,
  ts,
  PERIODS,
  periodDays,
  type Outcome,
  type PeriodKey,
  type TestKey,
} from './analyte-trends-utils'

const GRID = '#374151'
const TICK = '#9ca3af'
const PASS = '#34d399'
const FAIL = '#f87171'
const OTHER = '#fbbf24'

function accuverifyUrl(code: string): string {
  return `${getWordpressUrl()}/accuverify/?accuverify_code=${encodeURIComponent(code)}`
}

const FAIL_LABEL: Record<TestKey | 'other', string> = {
  ...TEST_LABELS,
  other: 'Other',
}

export function FailChips({ coa }: { coa: AnalyteTrendCoa }) {
  if (!isFailed(coa) && failedTests(coa).length === 0)
    return <span className="text-emerald-400">Conforms</span>
  return (
    <span className="inline-flex flex-wrap gap-1">
      {failedTests(coa).map(k => (
        <span
          key={k}
          className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
        >
          {FAIL_LABEL[k]} ✗
        </span>
      ))}
    </span>
  )
}

function Verdict({ o }: { o: Outcome }) {
  if (o == null) return <span className="text-muted-foreground/30">·</span>
  return o ? (
    <span className="text-emerald-400">Pass</span>
  ) : (
    <span className="text-red-400 font-medium">Fail</span>
  )
}

export function PeriodPicker({
  value,
  onChange,
}: {
  value: PeriodKey
  onChange: (k: PeriodKey) => void
}) {
  return (
    <div className="flex rounded-md border border-border/50 overflow-hidden">
      {PERIODS.map(p => (
        <button
          key={p.key}
          type="button"
          aria-pressed={value === p.key}
          onClick={() => onChange(p.key)}
          className={cn(
            'px-3 py-1 text-xs font-medium transition-colors cursor-pointer',
            value === p.key
              ? 'bg-primary text-primary-foreground'
              : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

// ─── Charts ──────────────────────────────────────────────────────────────────

interface Point {
  t: number
  y: number
  coa: AnalyteTrendCoa
  /** Did THIS metric fail (red), or did the COA fail on something else (amber)? */
  ownOk: Outcome
}

const pointColor = (p: Point) =>
  p.ownOk === false ? FAIL : isFailed(p.coa) ? OTHER : PASS

function DayTooltip({
  active,
  payload,
  points,
  tz,
  format,
}: {
  active?: boolean
  payload?: { payload: Point }[]
  points: Point[]
  tz: string
  format: (p: Point) => string
}) {
  const hovered = payload?.[0]?.payload
  if (!active || !hovered) return null
  // Every result from the hovered point's lab day, not just the one under the cursor.
  const day = labDay(hovered.t, tz)
  const same = points.filter(p => labDay(p.t, tz) === day)
  return (
    <div className="rounded-md border border-border/50 bg-popover px-3 py-2 text-xs shadow-lg font-mono max-w-sm">
      <div className="font-semibold text-foreground border-b border-border/40 pb-1 mb-1">
        {labDate(hovered.t, tz)}
        {same.length > 1 && (
          <span className="text-muted-foreground font-normal">
            {' '}
            · {same.length} results
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {same.map(p => (
          <div
            key={p.coa.code}
            className={cn(
              'grid grid-cols-[auto_auto_1fr] items-center gap-x-2',
              p === hovered && 'text-foreground'
            )}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: pointColor(p) }}
            />
            <span>{p.coa.sample_id}</span>
            <span className="text-right">{format(p)}</span>
            {failedTests(p.coa).length > 0 && (
              <span className="col-start-2 col-span-2 text-red-300">
                {failedTests(p.coa)
                  .map(k => FAIL_LABEL[k])
                  .join(', ')}{' '}
                failed
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="text-muted-foreground mt-1 pt-1 border-t border-border/40">
        Click a point to find it in the table
      </div>
    </div>
  )
}

function TrendChart({
  title,
  subtitle,
  points,
  tz,
  format,
  yTick,
  refLine,
  band,
  onPick,
}: {
  title: string
  subtitle?: string
  points: Point[]
  tz: string
  format: (p: Point) => string
  yTick: (v: number) => string
  refLine?: { y: number; label: string }
  band?: [number, number]
  onPick: (code: string) => void
}) {
  const yDomain = useMemo(() => {
    const ys = points.map(p => p.y)
    if (refLine) ys.push(refLine.y)
    if (band) ys.push(...band)
    const lo = Math.min(...ys)
    const hi = Math.max(...ys)
    const pad = Math.max((hi - lo) * 0.12, 0.5)
    return [Math.floor((lo - pad) * 10) / 10, Math.ceil((hi + pad) * 10) / 10]
  }, [points, refLine, band])

  return (
    <div className="rounded-lg border border-border/50 bg-card/30 p-3">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && (
          <div className="text-[11px] text-muted-foreground">{subtitle}</div>
        )}
      </div>
      {points.length === 0 ? (
        <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
          No results in this period
        </div>
      ) : (
        <div className="h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={GRID}
                opacity={0.5}
                vertical={false}
              />
              <XAxis
                type="number"
                dataKey="t"
                scale="time"
                domain={['dataMin', 'dataMax']}
                padding={{ left: 12, right: 12 }}
                tick={{ fontSize: 10, fill: TICK }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => labTick(v, tz)}
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={yDomain}
                tick={{ fontSize: 10, fill: TICK }}
                tickLine={false}
                axisLine={false}
                tickFormatter={yTick}
                width={52}
              />
              {band && (
                <ReferenceArea
                  y1={band[0]}
                  y2={band[1]}
                  fill={PASS}
                  fillOpacity={0.06}
                />
              )}
              {refLine && (
                <ReferenceLine
                  y={refLine.y}
                  stroke={PASS}
                  strokeDasharray="3 3"
                  strokeOpacity={0.6}
                  label={{
                    value: refLine.label,
                    position: 'insideBottomLeft',
                    fontSize: 10,
                    fill: PASS,
                  }}
                />
              )}
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={<DayTooltip points={points} tz={tz} format={format} />}
              />
              <Scatter
                data={points}
                isAnimationActive={false}
                className="cursor-pointer"
                onClick={(e: unknown) => {
                  const p = (e as { payload?: Point })?.payload
                  if (p) onPick(p.coa.code)
                }}
                shape={(props: unknown) => {
                  const { cx, cy, payload } = props as {
                    cx?: number
                    cy?: number
                    payload: Point
                  }
                  if (cx == null || cy == null) return <g />
                  return (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={4.5}
                      fill={pointColor(payload)}
                      stroke="#0a0a0a"
                      strokeWidth={1.5}
                    />
                  )
                }}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function Legend() {
  const dot = (c: string) => (
    <span
      className="h-2 w-2 rounded-full inline-block"
      style={{ background: c }}
    />
  )
  return (
    <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        {dot(PASS)} COA conforms
      </span>
      <span className="inline-flex items-center gap-1.5">
        {dot(FAIL)} This result failed
      </span>
      <span className="inline-flex items-center gap-1.5">
        {dot(OTHER)} COA failed on another test
      </span>
    </div>
  )
}

// ─── Detail view ─────────────────────────────────────────────────────────────

type Filter = 'all' | 'failed' | TestKey

export function AnalyteTrendDetail({
  product,
  coas,
  tz,
  initialTest,
  initialPeriod,
  now,
  onBack,
}: {
  product: string
  coas: AnalyteTrendCoa[]
  tz: string
  initialTest: TestKey | null
  initialPeriod: PeriodKey
  now: number
  onBack: () => void
}) {
  const [period, setPeriod] = useState<PeriodKey>(initialPeriod)
  const [filter, setFilter] = useState<Filter>(initialTest ?? 'all')
  const [picked, setPicked] = useState<string | null>(null)

  const inPeriod = useMemo(
    () => since(coas, periodDays(period), now).sort((a, b) => ts(a) - ts(b)),
    [coas, period, now]
  )
  const rows = useMemo(() => {
    if (filter === 'all') return inPeriod
    if (filter === 'failed') return inPeriod.filter(isFailed)
    return inPeriod.filter(c => outcome(c, filter) != null)
  }, [inPeriod, filter])

  const generic = coas.some(c => c.tests.length > 0)
  const testsPresent = TEST_KEYS.filter(k =>
    coas.some(c => outcome(c, k) != null)
  )
  const addonCols = (['endo', 'sterility', 'hm'] as const).filter(k =>
    testsPresent.includes(k)
  )
  const assayNames = useMemo(
    () => [...new Set(coas.flatMap(c => c.tests.map(t => t.name)))],
    [coas]
  )

  useEffect(() => {
    if (picked)
      document
        .getElementById(`coa-row-${picked}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [picked])

  const pick = (code: string) => {
    if (!rows.some(r => r.code === code)) setFilter('all')
    setPicked(code)
  }

  const failed = inPeriod.filter(isFailed).length
  const purities = inPeriod
    .map(c => c.purity)
    .filter((v): v is number => v != null)
  const deltas = inPeriod.map(qtyDeltaPct).filter((v): v is number => v != null)
  const spec = commonMinSpec(inPeriod)
  const medDelta = median(deltas)

  const chartSource = filter === 'all' ? inPeriod : rows
  const purityPoints: Point[] = chartSource.flatMap(c =>
    c.purity != null && !Number.isNaN(ts(c))
      ? [{ t: ts(c), y: c.purity, coa: c, ownOk: c.purity_ok }]
      : []
  )
  const qtyPoints: Point[] = chartSource.flatMap(c => {
    const d = qtyDeltaPct(c)
    return d != null && !Number.isNaN(ts(c))
      ? [{ t: ts(c), y: d, coa: c, ownOk: Math.abs(d) <= QTY_FLAG_PCT }]
      : []
  })

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-auto">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onBack}
            aria-label="Back to Analyte Trends"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold">{product}</h1>
            <p className="text-xs text-muted-foreground">
              {inPeriod.length} published COA{inPeriod.length === 1 ? '' : 's'}{' '}
              · lab time ({tz})
            </p>
          </div>
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
        <span>
          <span className="text-muted-foreground mr-1.5">Non-conforming</span>
          <span
            className={cn(
              'font-mono font-semibold',
              failed ? 'text-red-400' : 'text-foreground'
            )}
          >
            {failed}/{inPeriod.length}
          </span>
        </span>
        {purities.length > 0 && (
          <span>
            <span className="text-muted-foreground mr-1.5">Purity avg</span>
            <span className="font-mono font-semibold">
              {(purities.reduce((a, b) => a + b, 0) / purities.length).toFixed(
                2
              )}
              %
            </span>
            <span className="text-muted-foreground ml-1.5">
              min {Math.min(...purities).toFixed(2)}%
            </span>
          </span>
        )}
        {medDelta != null && (
          <span>
            <span className="text-muted-foreground mr-1.5">Qty Δ median</span>
            <span className="font-mono font-semibold">
              {medDelta >= 0 ? '+' : ''}
              {medDelta.toFixed(1)}%
            </span>
          </span>
        )}
        {testsPresent
          .filter(k => k !== 'purity')
          .map(k => {
            const tested = inPeriod.filter(c => outcome(c, k) != null)
            const f = tested.filter(c => outcome(c, k) === false).length
            return (
              <span key={k}>
                <span className="text-muted-foreground mr-1.5">
                  {TEST_LABELS[k]}
                </span>
                <span
                  className={cn(
                    'font-mono',
                    f ? 'text-red-400 font-semibold' : ''
                  )}
                >
                  {f}/{tested.length} failed
                </span>
              </span>
            )
          })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {(['all', 'failed', ...testsPresent] as Filter[]).map(f => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full border px-3 py-0.5 text-xs font-medium transition-colors cursor-pointer',
              filter === f
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border/60 text-muted-foreground hover:text-foreground'
            )}
          >
            {f === 'all'
              ? 'All'
              : f === 'failed'
                ? 'Non-conforming'
                : `Tested: ${TEST_LABELS[f]}`}
          </button>
        ))}
        <div className="flex-1" />
        <Legend />
      </div>

      {generic ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {assayNames.map(name => {
            const pts: Point[] = chartSource.flatMap(c => {
              const t = c.tests.find(x => x.name === name)
              return t && t.value != null && !Number.isNaN(ts(c))
                ? [{ t: ts(c), y: t.value, coa: c, ownOk: t.ok }]
                : []
            })
            const unit =
              coas.flatMap(c => c.tests).find(t => t.name === name)?.unit ?? ''
            const spec = coas
              .flatMap(c => c.tests)
              .find(t => t.name === name && t.spec)?.spec
            return (
              <TrendChart
                key={name}
                title={name}
                subtitle={spec ? `Spec ${spec}` : undefined}
                points={pts}
                tz={tz}
                format={p => `${p.y} ${unit}`.trim()}
                yTick={v => `${v}`}
                onPick={pick}
              />
            )
          })}
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          <TrendChart
            title="Purity"
            subtitle={spec != null ? `Spec ≥ ${spec}%` : undefined}
            points={purityPoints}
            tz={tz}
            format={p => `${p.y.toFixed(2)}%`}
            yTick={v => `${v}%`}
            refLine={
              spec != null ? { y: spec, label: `${spec}% spec` } : undefined
            }
            onPick={pick}
          />
          <TrendChart
            title="Quantity vs declared"
            subtitle={`Measured mass vs order declaration · ±${QTY_FLAG_PCT}% band`}
            points={qtyPoints}
            tz={tz}
            format={p =>
              `${p.coa.qty?.toFixed(2)} / ${p.coa.qty_declared} mg (${p.y >= 0 ? '+' : ''}${p.y.toFixed(1)}%)`
            }
            yTick={v => `${v > 0 ? '+' : ''}${v}%`}
            refLine={{ y: 0, label: 'declared' }}
            band={[-QTY_FLAG_PCT, QTY_FLAG_PCT]}
            onPick={pick}
          />
        </div>
      )}

      <div className="rounded-lg border border-border/50 bg-card/30 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/30 text-muted-foreground">
              <th className="text-left py-1.5 px-3 font-medium">Published</th>
              <th className="text-left py-1.5 px-3 font-medium">Sample</th>
              <th className="text-left py-1.5 px-3 font-medium">Lot</th>
              <th className="text-left py-1.5 px-3 font-medium">Code</th>
              {generic ? (
                assayNames.map(n => (
                  <th key={n} className="text-right py-1.5 px-3 font-medium">
                    {n}
                  </th>
                ))
              ) : (
                <>
                  <th className="text-right py-1.5 px-3 font-medium">Purity</th>
                  <th className="text-center py-1.5 px-3 font-medium">
                    Identity
                  </th>
                  <th className="text-right py-1.5 px-3 font-medium">
                    Qty (meas / decl)
                  </th>
                </>
              )}
              {addonCols.map(k => (
                <th key={k} className="text-center py-1.5 px-3 font-medium">
                  {TEST_LABELS[k]}
                </th>
              ))}
              <th className="text-left py-1.5 px-3 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map(c => {
              const d = qtyDeltaPct(c)
              const t = ts(c)
              return (
                <tr
                  key={c.code}
                  id={`coa-row-${c.code}`}
                  onClick={() => setPicked(c.code)}
                  className={cn(
                    'border-b border-border/20 hover:bg-muted/30',
                    picked === c.code &&
                      'bg-primary/15 ring-1 ring-inset ring-primary/50'
                  )}
                >
                  <td
                    className="py-1.5 px-3 tabular-nums whitespace-nowrap"
                    title={Number.isNaN(t) ? undefined : labDateTime(t, tz)}
                  >
                    {Number.isNaN(t) ? '' : labDate(t, tz)}
                  </td>
                  <td className="py-1.5 px-3">
                    <SampleIdBadge id={c.sample_id} />
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground">{c.lot}</td>
                  <td className="py-1.5 px-3 font-mono">
                    <a
                      href={accuverifyUrl(c.code)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-400/30"
                    >
                      {c.code}
                    </a>
                  </td>
                  {generic ? (
                    assayNames.map(n => {
                      const x = c.tests.find(tt => tt.name === n)
                      return (
                        <td
                          key={n}
                          className={cn(
                            'py-1.5 px-3 text-right font-mono',
                            x?.ok === false && 'text-red-400 font-medium'
                          )}
                        >
                          {x?.value != null
                            ? `${x.value} ${x.unit}`.trim()
                            : ''}
                        </td>
                      )
                    })
                  ) : (
                    <>
                      <td
                        className={cn(
                          'py-1.5 px-3 text-right font-mono',
                          c.purity_ok === false && 'text-red-400 font-medium'
                        )}
                      >
                        {c.purity != null ? `${c.purity.toFixed(2)}%` : ''}
                      </td>
                      <td className="py-1.5 px-3 text-center">
                        <Verdict o={c.identity_ok} />
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">
                        {c.qty != null && (
                          <>
                            {c.qty.toFixed(2)}
                            {c.qty_declared != null &&
                              ` / ${c.qty_declared}`}{' '}
                            mg
                            {d != null && (
                              <span
                                className={cn(
                                  'ml-1.5',
                                  Math.abs(d) > QTY_FLAG_PCT
                                    ? 'text-red-400'
                                    : 'text-muted-foreground'
                                )}
                              >
                                {d >= 0 ? '+' : ''}
                                {d.toFixed(1)}%
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    </>
                  )}
                  {addonCols.map(k => (
                    <td key={k} className="py-1.5 px-3 text-center">
                      <Verdict o={outcome(c, k)} />
                    </td>
                  ))}
                  <td className="py-1.5 px-3">
                    <FailChips coa={c} />
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={20}
                  className="py-8 text-center text-muted-foreground"
                >
                  No COAs match this filter in the selected period
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
