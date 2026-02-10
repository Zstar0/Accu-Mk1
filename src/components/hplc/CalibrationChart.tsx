import {
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Line,
  ComposedChart,
  ResponsiveContainer,
} from 'recharts'

// Explicit colors for dark-mode visibility
const CHART_BLUE = '#60a5fa'
const CHART_SLATE = '#94a3b8'
const CHART_GRID = '#334155'

interface CalibrationChartProps {
  concentrations: number[]
  areas: number[]
  slope: number
  intercept: number
}

export function CalibrationChart({
  concentrations,
  areas,
  slope,
  intercept,
}: CalibrationChartProps) {
  // Scatter data points
  const scatterData = concentrations.map((conc, i) => ({
    conc,
    area: areas[i],
  }))

  // Regression line: two endpoints spanning the data range
  const minConc = Math.min(...concentrations)
  const maxConc = Math.max(...concentrations)
  const lineData = [
    { conc: minConc, fit: slope * minConc + intercept },
    { conc: maxConc, fit: slope * maxConc + intercept },
  ]

  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart margin={{ top: 10, right: 20, bottom: 20, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
          <XAxis
            dataKey="conc"
            type="number"
            name="Concentration"
            unit=" µg/mL"
            tick={{ fontSize: 11, fill: CHART_SLATE }}
            axisLine={{ stroke: CHART_GRID }}
            tickLine={{ stroke: CHART_GRID }}
            label={{
              value: 'Concentration (µg/mL)',
              position: 'insideBottom',
              offset: -10,
              style: { fontSize: 11, fill: CHART_SLATE },
            }}
          />
          <YAxis
            dataKey="area"
            type="number"
            name="Area"
            tick={{ fontSize: 11, fill: CHART_SLATE }}
            axisLine={{ stroke: CHART_GRID }}
            tickLine={{ stroke: CHART_GRID }}
            label={{
              value: 'Peak Area',
              angle: -90,
              position: 'insideLeft',
              offset: -5,
              style: { fontSize: 11, fill: CHART_SLATE },
            }}
          />
          <Tooltip
            formatter={(value, name) => [
              typeof value === 'number' ? value.toFixed(2) : String(value ?? ''),
              name === 'area' ? 'Area' : 'Fit',
            ]}
            labelFormatter={label =>
              `Conc: ${typeof label === 'number' ? label.toFixed(2) : String(label)}`
            }
            contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: 6 }}
            labelStyle={{ color: CHART_SLATE }}
            itemStyle={{ color: '#e2e8f0' }}
          />
          <Scatter
            data={scatterData}
            dataKey="area"
            fill={CHART_BLUE}
            stroke="#ffffff"
            strokeWidth={1}
            r={5}
          />
          <Line
            data={lineData}
            dataKey="fit"
            stroke={CHART_SLATE}
            strokeWidth={2}
            strokeDasharray="6 3"
            dot={false}
            type="linear"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
