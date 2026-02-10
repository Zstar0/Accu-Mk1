import { useMemo } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'

export interface ChromatogramTrace {
  /** Injection or standard name (e.g. "Inj 1", "Std_1000") */
  name: string
  /** Downsampled [time, absorbance] pairs */
  points: [number, number][]
}

interface ChromatogramChartProps {
  traces: ChromatogramTrace[]
  /** Optional peak retention times to mark with vertical lines */
  peakRTs?: number[]
}

// Colors for overlaid traces — visually distinct on dark backgrounds
const TRACE_COLORS = [
  '#60a5fa', // blue-400
  '#f472b6', // pink-400
  '#34d399', // emerald-400
  '#fbbf24', // amber-400
  '#a78bfa', // violet-400
  '#fb923c', // orange-400
  '#22d3ee', // cyan-400
  '#f87171', // red-400
]

const CHART_SLATE = '#94a3b8'
const CHART_GRID = '#334155'

/**
 * Downsample a chromatogram to `targetPoints` using largest-triangle-three-buckets
 * for a visually accurate representation that preserves peaks.
 */
export function downsampleLTTB(
  data: [number, number][],
  targetPoints: number
): [number, number][] {
  if (data.length <= targetPoints) return data

  const sampled: [number, number][] = []
  const bucketSize = (data.length - 2) / (targetPoints - 2)

  // Always include first point
  sampled.push(data[0]!)

  let prevIndex = 0
  for (let i = 1; i < targetPoints - 1; i++) {
    const avgStart = Math.floor((i + 0) * bucketSize) + 1
    const avgEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, data.length)
    const nextStart = Math.floor((i + 1) * bucketSize) + 1
    const nextEnd = Math.min(
      Math.floor((i + 2) * bucketSize) + 1,
      data.length
    )

    // Average of next bucket
    let avgX = 0,
      avgY = 0,
      count = 0
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += data[j]![0]
      avgY += data[j]![1]
      count++
    }
    if (count > 0) {
      avgX /= count
      avgY /= count
    }

    // Find point in current bucket with largest triangle area
    let maxArea = -1
    let maxIndex = avgStart
    const prev = data[prevIndex]!
    const px = prev[0], py = prev[1]

    for (let j = avgStart; j < avgEnd; j++) {
      const pt = data[j]!
      const area = Math.abs(
        (px - avgX) * (pt[1] - py) - (px - pt[0]) * (avgY - py)
      )
      if (area > maxArea) {
        maxArea = area
        maxIndex = j
      }
    }

    sampled.push(data[maxIndex]!)
    prevIndex = maxIndex
  }

  // Always include last point
  sampled.push(data[data.length - 1]!)
  return sampled
}

/**
 * Parse a chromatogram CSV string into [time, absorbance] pairs.
 * Format: each line is "time,absorbance" with no header.
 */
export function parseChromatogramCsv(csv: string): [number, number][] {
  const points: [number, number][] = []
  const lines = csv.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const comma = trimmed.indexOf(',')
    if (comma < 0) continue
    const t = parseFloat(trimmed.substring(0, comma))
    const v = parseFloat(trimmed.substring(comma + 1))
    if (!isNaN(t) && !isNaN(v)) {
      points.push([t, v])
    }
  }
  return points
}

export function ChromatogramChart({
  traces,
  peakRTs,
}: ChromatogramChartProps) {
  // Merge all traces into unified data keyed by time bucket
  const { chartData, yMin, yMax } = useMemo(() => {
    if (traces.length === 0) return { chartData: [], yMin: 0, yMax: 1 }

    // Use the first trace's time points as the x-axis
    const primary = traces[0]!
    let minY = Infinity
    let maxY = -Infinity

    // Build a map from time → { t, trace0, trace1, ... }
    const data = primary.points.map(([t, v]) => {
      const row: Record<string, number> = { t }
      row[primary.name] = v
      if (v < minY) minY = v
      if (v > maxY) maxY = v
      return row
    })

    // For additional traces, find nearest time match
    for (let ti = 1; ti < traces.length; ti++) {
      const trace = traces[ti]!
      let pi = 0
      for (const row of data) {
        const t = row.t!
        // Advance pointer to nearest time
        while (
          pi < trace.points.length - 1 &&
          Math.abs(trace.points[pi + 1]![0] - t) <
            Math.abs(trace.points[pi]![0] - t)
        ) {
          pi++
        }
        const v = trace.points[pi]?.[1] ?? 0
        row[trace.name] = v
        if (v < minY) minY = v
        if (v > maxY) maxY = v
      }
    }

    // Add 5% padding
    const range = maxY - minY || 1
    return {
      chartData: data,
      yMin: Math.floor(minY - range * 0.05),
      yMax: Math.ceil(maxY + range * 0.05),
    }
  }, [traces])

  if (traces.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Chromatogram</CardTitle>
        <CardDescription>
          {traces.length} trace{traces.length !== 1 ? 's' : ''} overlaid
          {' '}&middot; DAD1A signal
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 12, bottom: 20, left: 12 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={CHART_GRID}
                vertical={false}
              />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tick={{ fontSize: 10, fill: CHART_SLATE }}
                axisLine={{ stroke: CHART_GRID }}
                tickLine={{ stroke: CHART_GRID }}
                tickFormatter={(v: number) => v.toFixed(1)}
                label={{
                  value: 'Time (min)',
                  position: 'insideBottom',
                  offset: -12,
                  style: { fontSize: 10, fill: CHART_SLATE },
                }}
              />
              <YAxis
                domain={[yMin, yMax]}
                tick={{ fontSize: 10, fill: CHART_SLATE }}
                axisLine={{ stroke: CHART_GRID }}
                tickLine={{ stroke: CHART_GRID }}
                tickFormatter={(v: number) =>
                  v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(1)
                }
                label={{
                  value: 'mAU',
                  angle: -90,
                  position: 'insideLeft',
                  offset: 5,
                  style: { fontSize: 10, fill: CHART_SLATE },
                }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1e293b',
                  border: '1px solid #475569',
                  borderRadius: 6,
                  fontSize: 11,
                }}
                labelStyle={{ color: CHART_SLATE }}
                itemStyle={{ color: '#e2e8f0' }}
                labelFormatter={(v) => `${Number(v).toFixed(3)} min`}
                formatter={(value) => [Number(value).toFixed(2), 'mAU']}
              />
              {/* Peak RT reference lines */}
              {peakRTs?.map((rt, i) => (
                <ReferenceLine
                  key={i}
                  x={rt}
                  stroke="#475569"
                  strokeDasharray="2 4"
                  strokeWidth={1}
                />
              ))}
              {/* Trace lines */}
              {traces.map((trace, i) => (
                <Line
                  key={trace.name}
                  dataKey={trace.name}
                  stroke={TRACE_COLORS[i % TRACE_COLORS.length]}
                  strokeWidth={1.5}
                  dot={false}
                  type="monotone"
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
