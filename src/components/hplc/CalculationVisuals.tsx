import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  ComposedChart,
  Scatter,
  Line,
} from 'recharts'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// ── Type guards for trace sub-objects ──────────────────────────

interface PurityTrace {
  purity_percent: number | null
  individual_values: number[]
  injection_names: string[]
  rsd_percent: number | null
}

interface QuantityTrace {
  quantity_mg: number | null
  individual_areas: number[]
  avg_main_peak_area: number
  concentration_ug_ml: number
  undiluted_concentration_ug_ml: number
  mass_ug: number
  stock_volume_ml: number
  dilution_factor: number
  calibration_slope: number
  calibration_intercept: number
}

interface IdentityTrace {
  conforms: boolean | null
  sample_rt: number
  reference_rt: number
  rt_delta: number
  rt_tolerance: number
  individual_rts: number[]
}

interface DilutionTrace {
  diluent_mass_mg: number
  diluent_vol_ul: number
  sample_mass_mg: number
  sample_vol_ul: number
  total_vol_ul: number
  dilution_factor: number
  stock_mass_mg: number
  stock_volume_ml: number
}

interface CalculationTrace {
  purity?: PurityTrace
  quantity?: QuantityTrace
  identity?: IdentityTrace
  dilution?: DilutionTrace
}

function isPurityTrace(v: unknown): v is PurityTrace {
  return (
    typeof v === 'object' &&
    v !== null &&
    'individual_values' in v &&
    Array.isArray((v as PurityTrace).individual_values)
  )
}

function isQuantityTrace(v: unknown): v is QuantityTrace {
  return (
    typeof v === 'object' &&
    v !== null &&
    'calibration_slope' in v &&
    'avg_main_peak_area' in v
  )
}

function isIdentityTrace(v: unknown): v is IdentityTrace {
  return (
    typeof v === 'object' &&
    v !== null &&
    'sample_rt' in v &&
    'reference_rt' in v &&
    'rt_tolerance' in v
  )
}

function isDilutionTrace(v: unknown): v is DilutionTrace {
  return (
    typeof v === 'object' &&
    v !== null &&
    'dilution_factor' in v &&
    'diluent_vol_ul' in v
  )
}

// ── Chart colors (explicit for dark-mode visibility) ──────────

const CHART_BLUE = '#60a5fa'       // bright blue — bars, primary data
const CHART_AMBER = '#fbbf24'      // amber — accent, sample point
const CHART_SLATE = '#94a3b8'      // slate-400 — axis text, labels
const CHART_GRID = '#334155'        // slate-700 — grid lines
const CHART_AVG_LINE = '#f97316'   // orange — average/reference lines

// ── Purity Bar Chart ───────────────────────────────────────────

function PurityChart({ trace }: { trace: PurityTrace }) {
  const data = trace.individual_values.map((val, i) => ({
    name: trace.injection_names[i] || `Inj ${i + 1}`,
    purity: val,
  }))

  const avg = trace.purity_percent ?? 0
  const yMin = Math.floor(Math.min(...trace.individual_values, avg) - 1)
  const yMax = Math.ceil(Math.max(...trace.individual_values, avg) + 0.5)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Purity per Injection
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Average: <span className="font-medium text-foreground">{avg.toFixed(2)}%</span>
          {trace.rsd_percent != null && (
            <> &middot; RSD: {trace.rsd_percent.toFixed(2)}%</>
          )}
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[180px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: CHART_SLATE }}
                axisLine={{ stroke: CHART_GRID }}
                tickLine={{ stroke: CHART_GRID }}
              />
              <YAxis
                domain={[yMin, yMax]}
                tick={{ fontSize: 11, fill: CHART_SLATE }}
                tickFormatter={(v: number) => `${v}%`}
                axisLine={{ stroke: CHART_GRID }}
                tickLine={{ stroke: CHART_GRID }}
              />
              <Tooltip
                formatter={(value) => [`${Number(value).toFixed(4)}%`, 'Area%']}
                contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: 6 }}
                labelStyle={{ color: CHART_SLATE }}
                itemStyle={{ color: '#e2e8f0' }}
              />
              <ReferenceLine
                y={avg}
                stroke={CHART_AVG_LINE}
                strokeDasharray="5 3"
                strokeWidth={2}
                label={{
                  value: `Avg ${avg.toFixed(2)}%`,
                  position: 'right',
                  style: { fontSize: 10, fill: CHART_AVG_LINE },
                }}
              />
              <Bar
                dataKey="purity"
                fill={CHART_BLUE}
                radius={[4, 4, 0, 0]}
                maxBarSize={60}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Quantity: Sample on Calibration Curve ───────────────────────

function QuantityChart({ trace }: { trace: QuantityTrace }) {
  // Regression line endpoints
  const sampleConc = trace.concentration_ug_ml
  const sampleArea = trace.avg_main_peak_area
  const { calibration_slope: slope, calibration_intercept: intercept } = trace

  // Extend line from 0 to a bit past the sample
  const maxConc = Math.max(sampleConc * 1.2, 200)
  const lineData = [
    { conc: 0, fit: intercept },
    { conc: maxConc, fit: slope * maxConc + intercept },
  ]

  const samplePoint = [{ conc: sampleConc, area: sampleArea }]

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Sample on Calibration Curve
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Area = {slope.toFixed(4)} &times; Conc + {intercept.toFixed(4)}
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[200px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart margin={{ top: 8, right: 20, bottom: 20, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
              <XAxis
                dataKey="conc"
                type="number"
                tick={{ fontSize: 11, fill: CHART_SLATE }}
                axisLine={{ stroke: CHART_GRID }}
                tickLine={{ stroke: CHART_GRID }}
                label={{
                  value: 'Concentration (ug/mL)',
                  position: 'insideBottom',
                  offset: -10,
                  style: { fontSize: 10, fill: CHART_SLATE },
                }}
              />
              <YAxis
                dataKey="area"
                type="number"
                tick={{ fontSize: 11, fill: CHART_SLATE }}
                axisLine={{ stroke: CHART_GRID }}
                tickLine={{ stroke: CHART_GRID }}
                label={{
                  value: 'Peak Area',
                  angle: -90,
                  position: 'insideLeft',
                  offset: -5,
                  style: { fontSize: 10, fill: CHART_SLATE },
                }}
              />
              <Tooltip
                formatter={(value, name) => [
                  Number(value).toFixed(2),
                  name === 'area' ? 'Sample Area' : 'Calibration',
                ]}
                labelFormatter={(label) => `Conc: ${Number(label).toFixed(2)} ug/mL`}
                contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: 6 }}
                labelStyle={{ color: CHART_SLATE }}
                itemStyle={{ color: '#e2e8f0' }}
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
              <Scatter
                data={samplePoint}
                dataKey="area"
                fill={CHART_AMBER}
                stroke="#ffffff"
                strokeWidth={1}
                r={8}
                shape="diamond"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {/* Step-by-step formula */}
        <div className="mt-3 space-y-1 rounded-md bg-muted/50 p-3 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Avg Area</span>
            <span>{trace.avg_main_peak_area.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Conc = (Area - {intercept.toFixed(2)}) / {slope.toFixed(4)}</span>
            <span>{trace.concentration_ug_ml.toFixed(2)} ug/mL</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Undiluted = Conc &times; DF ({trace.dilution_factor.toFixed(2)}&times;)</span>
            <span>{trace.undiluted_concentration_ug_ml.toFixed(2)} ug/mL</span>
          </div>
          <div className="flex justify-between border-t border-border pt-1 font-semibold">
            <span>Mass = Undiluted &times; Stock ({trace.stock_volume_ml.toFixed(4)} mL) / 1000</span>
            <span>{trace.quantity_mg?.toFixed(2)} mg</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Identity: RT Tolerance Window ──────────────────────────────

function IdentityVisual({ trace }: { trace: IdentityTrace }) {
  const { sample_rt, reference_rt, rt_tolerance, rt_delta, individual_rts, conforms } = trace
  const lo = reference_rt - rt_tolerance
  const hi = reference_rt + rt_tolerance

  // Normalized positions (0-100%) within the tolerance window
  const range = hi - lo
  const refPct = 50 // reference is always center
  const samplePct = ((sample_rt - lo) / range) * 100

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Identity &mdash; Retention Time Match
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Reference: {reference_rt.toFixed(3)} min &middot; Tolerance: &plusmn;{rt_tolerance} min
        </p>
      </CardHeader>
      <CardContent>
        {/* Tolerance band visualization */}
        <div className="relative mx-auto mt-2 w-full max-w-md">
          {/* Labels */}
          <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
            <span>{lo.toFixed(3)}</span>
            <span>Reference: {reference_rt.toFixed(3)}</span>
            <span>{hi.toFixed(3)}</span>
          </div>

          {/* Band */}
          <div className="relative h-10 w-full rounded-md bg-slate-800 overflow-hidden border border-slate-600">
            {/* Green tolerance zone */}
            <div className="absolute inset-0 bg-green-500/20 rounded-md" />

            {/* Center reference line */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-slate-400"
              style={{ left: `${refPct}%` }}
            />

            {/* Sample marker */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2"
              style={{ left: `${Math.max(2, Math.min(98, samplePct))}%` }}
            >
              <div
                className={`h-7 w-7 rounded-full border-2 flex items-center justify-center text-[11px] font-bold shadow-lg ${
                  conforms
                    ? 'bg-green-500 border-green-300 text-white'
                    : 'bg-red-500 border-red-300 text-white'
                }`}
              >
                S
              </div>
            </div>
          </div>

          {/* Delta label */}
          <div className="mt-2 text-center text-xs">
            <span className="text-muted-foreground">Delta: </span>
            <span className={`font-medium ${conforms ? 'text-green-400' : 'text-red-400'}`}>
              {rt_delta.toFixed(4)} min
            </span>
            <span className="text-muted-foreground">
              {' '}({conforms ? 'within' : 'exceeds'} &plusmn;{rt_tolerance} tolerance)
            </span>
          </div>
        </div>

        {/* Individual RTs */}
        {individual_rts.length > 1 && (
          <div className="mt-3 flex gap-4 justify-center text-xs text-muted-foreground">
            {individual_rts.map((rt, i) => (
              <span key={i}>
                Inj {i + 1}: <span className="font-mono text-foreground">{rt.toFixed(4)}</span> min
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Dilution Breakdown ─────────────────────────────────────────

function DilutionBreakdown({ trace }: { trace: DilutionTrace }) {
  const rows: [string, string, string][] = [
    ['Diluent mass', `${trace.diluent_mass_mg.toFixed(2)} mg`, `${trace.diluent_vol_ul.toFixed(1)} uL`],
    ['Sample mass', `${trace.sample_mass_mg.toFixed(2)} mg`, `${trace.sample_vol_ul.toFixed(1)} uL`],
    ['Total volume', '', `${trace.total_vol_ul.toFixed(1)} uL`],
  ]

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Dilution &amp; Stock Prep
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {/* Dilution vial */}
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Dilution Vial</p>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="pb-1 text-left font-medium">Component</th>
                  <th className="pb-1 text-right font-medium">Mass</th>
                  <th className="pb-1 text-right font-medium">Volume</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map(([label, mass, vol]) => (
                  <tr key={label} className="border-b last:border-0">
                    <td className="py-1 font-sans text-muted-foreground">{label}</td>
                    <td className="py-1 text-right">{mass}</td>
                    <td className="py-1 text-right">{vol}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex items-baseline justify-between rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-1.5">
              <span className="text-xs text-slate-400">Dilution Factor</span>
              <span className="text-sm font-bold tabular-nums text-blue-400">{trace.dilution_factor.toFixed(2)}&times;</span>
            </div>
          </div>

          {/* Stock vial */}
          <div>
            <p className="mb-2 text-xs font-medium text-slate-400">Stock Vial</p>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Diluent mass</span>
                <span className="font-mono">{trace.stock_mass_mg.toFixed(2)} mg</span>
              </div>
              <div className="flex items-baseline justify-between rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-1.5">
                <span className="text-slate-400">Stock Volume</span>
                <span className="text-sm font-bold tabular-nums text-blue-400">{trace.stock_volume_ml.toFixed(4)} mL</span>
              </div>
            </div>
            <p className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
              DF = (diluent + sample) / sample<br />
              Stock vol = mass / 1000
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Main export ────────────────────────────────────────────────

interface CalculationVisualsProps {
  trace: Record<string, unknown>
}

export function CalculationVisuals({ trace }: CalculationVisualsProps) {
  const parsed = trace as unknown as CalculationTrace

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {isPurityTrace(parsed.purity) && (
        <PurityChart trace={parsed.purity} />
      )}
      {isQuantityTrace(parsed.quantity) && (
        <QuantityChart trace={parsed.quantity} />
      )}
      {isIdentityTrace(parsed.identity) && (
        <IdentityVisual trace={parsed.identity} />
      )}
      {isDilutionTrace(parsed.dilution) && (
        <DilutionBreakdown trace={parsed.dilution} />
      )}
    </div>
  )
}
