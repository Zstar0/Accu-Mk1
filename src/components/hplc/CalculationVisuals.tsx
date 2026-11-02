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
  // Set when a problem stopped the mass (see PROBLEM_COPY).
  error?: string
  individual_areas: number[]
  avg_main_peak_area: number
  // Null when the concentration itself overflowed (error "quantity_not_finite").
  concentration_ug_ml: number | null
  // Absent under a weighing problem: they need a dilution factor and a stock volume.
  undiluted_concentration_ug_ml?: number
  mass_ug?: number
  stock_volume_ml?: number
  dilution_factor?: number
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
  // A mass is null when a weighing is not a finite number, and the stock vial's is
  // null for a liquid row (never weighed). The engine never stores NaN or infinity.
  diluent_mass_mg: number | null
  // Null when the diluent density is missing (problem "no_density"): a volume needs it.
  diluent_vol_ul: number | null
  sample_mass_mg: number | null
  sample_vol_ul: number | null
  total_vol_ul: number | null
  // Null when a weighing problem means they cannot be determined.
  dilution_factor: number | null
  stock_mass_mg: number | null
  stock_volume_ml: number | null
  problem?: string | null
  // The prep form that produced the row. Absent on a trace stored before the engine
  // wrote it, which means "not known to be liquid", not "powder": see stockMassText.
  form?: string
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

// ── Weighing problems ──────────────────────────────────────────

const NOT_DETERMINED = 'not determined'

// What the engine's `problem` codes mean in the lab (calculate_dilution_factor and
// calculate_quantity), weighing codes, configuration codes and the quantity's own. The
// label before each sentence names what is undetermined; the sentence says what to
// check. A requirement, never a claim about what a weighing equals: every code also
// fires, more rarely, when the arithmetic overflowed on weighings that were all
// positive and finite.
//
// A vial is named by what was done to it ("before and after adding diluent"), not by a
// field label: the wizard and the flyout label the same weighing differently ("Vial +
// Cap", "Vial + cap + peptide", "Stock vial empty"), and this panel is reached from both.
//
// `dilution_incomplete` is deliberately NOT here. It is unreachable on any dilution the
// engine builds; it exists so the quantity gate fails closed if an engine invariant is
// ever broken. If it ever shows, the raw code is the right thing to print, so do not
// add copy that makes it look like an ordinary weighing problem.
const PROBLEM_COPY: Record<string, string> = {
  stock_diluent:
    "The stock vial's weighings before and after adding diluent need checking: both must be entered, and the one after must be heavier.",
  diluent:
    "The dilution vial's weighings before and after adding diluent need checking: both must be entered, and the one after must not be lighter.",
  stock:
    "The dilution vial's weighings before and after adding the sample need checking: both must be entered, and the one after must be heavier.",
  intermediate_unweighed:
    "The intermediate vial's three weighings need checking: all must be entered.",
  intermediate_diluent:
    "The intermediate vial's weighings before and after adding diluent need checking: the one after must not be lighter.",
  intermediate_stock:
    "The intermediate vial's weighings before and after adding the sample need checking: the one after must be heavier.",
  // Configuration, not the balance: the fix is in the data.
  no_density:
    'The calibration curve has no usable diluent density. This is not a weighing problem: the density needs setting on the curve.',
  no_declared_volume:
    'This liquid sample has no usable declared volume. This is not a weighing problem: the volume declared with the sample needs recording (it is taken as declared, not measured).',
  // Only ever the quantity panel's reason, never the dilution panel's.
  quantity_not_finite:
    'A value in the calculation is too large to represent. Check the dilution vial weighings, the peak areas and the calibration curve; if those look right, this needs looking at.',
}

function problemCopy(code: string): string {
  return PROBLEM_COPY[code] ?? code
}

function fixed(v: number | null | undefined, dp: number, unit = ''): string {
  return v == null ? NOT_DETERMINED : `${v.toFixed(dp)}${unit}`
}

const NOT_APPLICABLE = 'not applicable'

// A liquid prep never weighs its stock vial, so its stock mass does not exist; it is not
// a weighing that went missing. The trace says which form produced the row, so this reads
// that rather than guessing from which values are null. A trace without the key is not
// known to be liquid (a row stored before the engine wrote it can be any form), so it
// keeps the existing "not determined": an old trace must not start claiming a
// measurement is inapplicable.
function stockMassText(trace: DilutionTrace): string {
  if (trace.form === 'liquid' && trace.stock_mass_mg == null) {
    return NOT_APPLICABLE
  }
  return fixed(trace.stock_mass_mg, 2, ' mg')
}

// What the dilution panel could not work out, named from the trace's own values rather
// than from the problem code, so a code added later cannot get a wrong label. Each
// problem nulls only what it touches (calculate_dilution_factor): a stock problem keeps
// the dilution factor, a final dilution-leg problem keeps the stock volume, and an
// intermediate problem nulls neither of the two printed values but the total factor,
// which is not printed. So neither null under a problem means the total.
function undeterminedLabel(trace: DilutionTrace): string {
  const names: string[] = []
  if (trace.dilution_factor == null) names.push('dilution factor')
  if (trace.stock_volume_ml == null) names.push('stock volume')
  const label = names.length > 0 ? names.join(' and ') : 'total dilution factor'
  return label.charAt(0).toUpperCase() + label.slice(1)
}

// ── Chart colors (explicit for dark-mode visibility) ──────────

const CHART_BLUE = '#60a5fa'       // bright blue, bars, primary data
const CHART_AMBER = '#fbbf24'      // amber, accent, sample point
const CHART_SLATE = '#94a3b8'      // slate-400, axis text, labels
const CHART_GRID = '#334155'        // slate-700, grid lines
const CHART_AVG_LINE = '#f97316'   // orange, average/reference lines

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
  const maxConc = Math.max((sampleConc ?? 0) * 1.2, 200)
  const lineData = [
    { conc: 0, fit: intercept },
    { conc: maxConc, fit: slope * maxConc + intercept },
  ]

  const samplePoint =
    sampleConc == null ? [] : [{ conc: sampleConc, area: sampleArea }]

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
                  value: 'Concentration (µg/mL)',
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
                labelFormatter={(label) => `Conc: ${Number(label).toFixed(2)} µg/mL`}
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
            <span>{fixed(trace.concentration_ug_ml, 2, ' µg/mL')}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Undiluted = Conc &times; DF ({fixed(trace.dilution_factor, 2, '\u00d7')})</span>
            <span>{fixed(trace.undiluted_concentration_ug_ml, 2, ' µg/mL')}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-1 font-semibold">
            <span>Mass = Undiluted &times; Stock ({fixed(trace.stock_volume_ml, 4, ' mL')}) / 1000</span>
            <span>{fixed(trace.quantity_mg, 2, ' mg')}</span>
          </div>
        </div>
        {trace.error && (
          <p className="mt-2 text-xs text-amber-400">
            Mass {NOT_DETERMINED}. {problemCopy(trace.error)}
          </p>
        )}
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
    ['Diluent mass', fixed(trace.diluent_mass_mg, 2, ' mg'), fixed(trace.diluent_vol_ul, 1, ' µL')],
    ['Sample mass', fixed(trace.sample_mass_mg, 2, ' mg'), fixed(trace.sample_vol_ul, 1, ' µL')],
    ['Total volume', '', fixed(trace.total_vol_ul, 1, ' µL')],
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
              <span className="text-sm font-bold tabular-nums text-blue-400">{fixed(trace.dilution_factor, 2, '\u00d7')}</span>
            </div>
          </div>

          {/* Stock vial */}
          <div>
            <p className="mb-2 text-xs font-medium text-slate-400">Stock Vial</p>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Diluent mass</span>
                <span className="font-mono">{stockMassText(trace)}</span>
              </div>
              <div className="flex items-baseline justify-between rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-1.5">
                <span className="text-slate-400">Stock Volume</span>
                <span className="text-sm font-bold tabular-nums text-blue-400">{fixed(trace.stock_volume_ml, 4, ' mL')}</span>
              </div>
            </div>
            <p className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
              DF = (diluent + sample) / sample<br />
              Stock vol = mass / density<br />
              (liquid: the declared volume; bac water: density corrected)
            </p>
          </div>
        </div>
        {trace.problem && (
          <p className="mt-3 text-xs text-amber-400">
            {undeterminedLabel(trace)} {NOT_DETERMINED}. {problemCopy(trace.problem)}
          </p>
        )}
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
    <div className="flex flex-col gap-4">
      {isDilutionTrace(parsed.dilution) && (
        <DilutionBreakdown trace={parsed.dilution} />
      )}
      {isQuantityTrace(parsed.quantity) && (
        <QuantityChart trace={parsed.quantity} />
      )}
      {isPurityTrace(parsed.purity) && (
        <PurityChart trace={parsed.purity} />
      )}
      {isIdentityTrace(parsed.identity) && (
        <IdentityVisual trace={parsed.identity} />
      )}
    </div>
  )
}
