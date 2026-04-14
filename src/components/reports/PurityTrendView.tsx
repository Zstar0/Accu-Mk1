import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Loader2,
  XCircle,
  TrendingUp,
  TrendingDown,
} from 'lucide-react'
import {
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Area,
  ComposedChart,
} from 'recharts'
import { cn } from '@/lib/utils'
import { getReportsPurityTrend } from '@/lib/api'
import type { PurityTrendPoint } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { getWordpressUrl } from '@/lib/api-profiles'

function accuverifyUrl(code: string): string {
  return `${getWordpressUrl()}/accuverify/?accuverify_code=${encodeURIComponent(code)}`
}

type TimePeriod = '1M' | '3M' | '6M' | '1Y' | 'ALL'

const PERIOD_DAYS: Record<TimePeriod, number | null> = {
  '1M': 30,
  '3M': 90,
  '6M': 180,
  '1Y': 365,
  ALL: null,
}

function filterByPeriod(data: PurityTrendPoint[], period: TimePeriod): PurityTrendPoint[] {
  const days = PERIOD_DAYS[period]
  if (!days) return data
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  return data.filter(d => new Date(d.date) >= cutoff)
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: PurityTrendPoint }> }) {
  if (!active || !payload?.length || !payload[0]) return null
  const d = payload[0].payload
  return (
    <div className="rounded-md border border-border/50 bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-foreground mb-1">{d.date}</div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="text-muted-foreground">Purity</span>
        <span className="font-mono font-semibold text-right">{d.purity_percent.toFixed(2)}%</span>
        <span className="text-muted-foreground">Sample</span>
        <span className="font-mono text-right">{d.sample_id}</span>
        <span className="text-muted-foreground">Code</span>
        <a
          href={accuverifyUrl(d.verification_code)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-blue-400 text-right hover:text-blue-300 underline underline-offset-2 decoration-blue-400/30 hover:decoration-blue-300/60"
          onClick={e => e.stopPropagation()}
        >
          {d.verification_code}
        </a>
        <span className="text-muted-foreground">Status</span>
        <span className={cn('text-right font-medium', d.conforms ? 'text-emerald-400' : 'text-red-400')}>
          {d.conforms ? 'Conforms' : 'Non-conforming'}
        </span>
      </div>
    </div>
  )
}

export function PurityTrendView({
  analyteName,
  isBlend = false,
  onBack,
}: {
  analyteName: string
  isBlend?: boolean
  onBack: () => void
}) {
  const [period, setPeriod] = useState<TimePeriod>('ALL')

  const { data: rawData, isLoading, error } = useQuery({
    queryKey: ['reports', 'purity-trend', analyteName, isBlend],
    queryFn: () => getReportsPurityTrend(analyteName, isBlend),
    staleTime: 60_000,
  })

  const filteredData = useMemo(() => {
    if (!rawData) return []
    return filterByPeriod(rawData, period)
  }, [rawData, period])

  const stats = useMemo(() => {
    if (!filteredData.length) return null
    const values = filteredData.map(d => d.purity_percent)
    const avg = values.reduce((s, v) => s + v, 0) / values.length
    const min = Math.min(...values)
    const max = Math.max(...values)
    const latest = values[values.length - 1]!
    const previous = values.length > 1 ? values[values.length - 2]! : latest
    const delta = latest - previous
    const conforming = filteredData.filter(d => d.conforms === true).length
    const total = filteredData.length
    return { avg, min, max, latest, delta, conforming, total }
  }, [filteredData])

  // Chart domain — keep tight around data
  const yDomain = useMemo(() => {
    if (!filteredData.length) return [90, 100]
    const values = filteredData.map(d => d.purity_percent)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const padding = Math.max((max - min) * 0.15, 1)
    return [Math.floor(min - padding), Math.min(Math.ceil(max + padding), 100.5)]
  }, [filteredData])

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-lg font-semibold">{analyteName}</h1>
          <p className="text-xs text-muted-foreground">Purity trend over time</p>
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
          Failed to load purity data
        </div>
      )}

      {stats && (
        <>
          {/* Period selector + stats row */}
          <div className="flex items-center gap-4">
            {/* Time period buttons */}
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

            <div className="flex-1" />

            {/* Key stats */}
            <div className="flex items-center gap-6 text-xs">
              <div>
                <span className="text-muted-foreground mr-1.5">Latest</span>
                <span className="font-mono font-semibold text-foreground">{stats.latest.toFixed(2)}%</span>
                {stats.delta !== 0 && (
                  <span className={cn('ml-1.5 inline-flex items-center gap-0.5',
                    stats.delta > 0 ? 'text-emerald-400' : 'text-red-400'
                  )}>
                    {stats.delta > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {stats.delta > 0 ? '+' : ''}{stats.delta.toFixed(2)}%
                  </span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground mr-1.5">Avg</span>
                <span className="font-mono font-semibold">{stats.avg.toFixed(2)}%</span>
              </div>
              <div>
                <span className="text-muted-foreground mr-1.5">Range</span>
                <span className="font-mono">{stats.min.toFixed(1)}–{stats.max.toFixed(1)}%</span>
              </div>
              <div>
                <span className="text-muted-foreground mr-1.5">Conform</span>
                <span className="font-mono text-emerald-400">{stats.conforming}</span>
                <span className="text-muted-foreground">/{stats.total}</span>
              </div>
            </div>
          </div>

          {/* Chart */}
          <div className="rounded-lg border border-border/50 bg-card/30 p-3 flex-1 min-h-[350px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={filteredData} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                <defs>
                  <linearGradient id="purityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#374151"
                  opacity={0.5}
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: string) => {
                    const d = new Date(v)
                    return `${d.getMonth() + 1}/${d.getDate()}`
                  }}
                />
                <YAxis
                  domain={yDomain}
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  width={45}
                />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine
                  y={stats.avg}
                  stroke="#6b7280"
                  strokeDasharray="6 4"
                  strokeOpacity={0.7}
                  label={{
                    value: `Avg ${stats.avg.toFixed(1)}%`,
                    position: 'right',
                    fontSize: 10,
                    fill: '#9ca3af',
                  }}
                />
                <ReferenceLine
                  y={98}
                  stroke="#34d399"
                  strokeDasharray="3 3"
                  strokeOpacity={0.5}
                  label={{
                    value: '98% spec',
                    position: 'left',
                    fontSize: 10,
                    fill: '#34d399',
                    opacity: 0.7,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="purity_percent"
                  fill="url(#purityGradient)"
                  stroke="none"
                />
                <Line
                  type="monotone"
                  dataKey="purity_percent"
                  stroke="#60a5fa"
                  strokeWidth={2}
                  dot={(props: Record<string, unknown>) => {
                    const cx = props.cx as number
                    const cy = props.cy as number
                    const payload = props.payload as PurityTrendPoint
                    if (cx == null || cy == null) return <></>
                    const color = payload.conforms ? '#34d399' : '#f87171'
                    return (
                      <circle
                        key={`${payload.verification_code}`}
                        cx={cx}
                        cy={cy}
                        r={4}
                        fill={color}
                        stroke="#0a0a0a"
                        strokeWidth={2}
                      />
                    )
                  }}
                  activeDot={{ r: 6, strokeWidth: 2, stroke: '#0a0a0a', fill: '#60a5fa' }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Data table */}
          <div className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/30 text-muted-foreground">
                  <th className="text-left py-1.5 px-3 font-medium">Date</th>
                  <th className="text-left py-1.5 px-3 font-medium">Sample</th>
                  <th className="text-left py-1.5 px-3 font-medium">Code</th>
                  <th className="text-right py-1.5 px-3 font-medium">Purity</th>
                  <th className="text-center py-1.5 px-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {[...filteredData].reverse().map(d => (
                  <tr key={d.verification_code} className="border-b border-border/20 hover:bg-muted/30">
                    <td className="py-1.5 px-3 tabular-nums">{d.date}</td>
                    <td className="py-1.5 px-3 font-mono">{d.sample_id}</td>
                    <td className="py-1.5 px-3 font-mono">
                      <a
                        href={accuverifyUrl(d.verification_code)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-400/30 hover:decoration-blue-300/60"
                      >
                        {d.verification_code}
                      </a>
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono font-medium">{d.purity_percent.toFixed(2)}%</td>
                    <td className="py-1.5 px-3 text-center">
                      {d.conforms ? (
                        <span className="text-emerald-400">Conforms</span>
                      ) : (
                        <span className="text-red-400">Non-conforming</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rawData && rawData.length === 0 && (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
          No purity data available for {analyteName}
        </div>
      )}
    </div>
  )
}
