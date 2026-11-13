/**
 * HPLC calibration curve worksheet arithmetic (plan 4, Task 3): workOutSheet,
 * the browser's twin of backend/hplc_calibration.py work_out_sheet, ported
 * function for function from the Python, which ports the lab tool's calc.js
 * (tools-dennis, hplc-peptide-quant, commit 39a1afe8). Each function names the
 * calc.js function it ports, with its line.
 * backend/tests/fixtures/hplc_calibration_cases.json pins both sides.
 *
 * Inputs and results use the server's snake_case keys. Two things are Mk1's
 * own: a manual override of the net factor (net.override_factor, applied to
 * the stock in place of the computed factor) and the net_partial /
 * override_reason_missing warnings. Every number is unrounded; a value that
 * cannot be worked out is null, never NaN, never 0. Sums run left to right in
 * plain loops, as the Python does. Pure: no DOM, no fetch.
 */
import { HPLC_RUN_PARAM_DEFAULTS } from '@/lib/hplc-run-params'

// ---------------------------------------------------------------- constants

/** calc.js DEFAULTS.counterions (120): g/mol per equivalent; sodium is net of
 *  the proton it replaces. */
export const COUNTERIONS: Record<string, number> = {
  Acetate: 60.05,
  TFA: 114.02,
  HCl: 36.46,
  Iodide: 126.9,
  Sodium: 21.98,
}
/** calc.js MS_IONS (2714), the ion forms only. */
export const MS_IONS = [
  '',
  'M',
  'M+H',
  'M+2H',
  'M+3H',
  'M+4H',
  'M-H',
  'M-2H',
  'M-3H',
  'M-4H',
] as const
export const PROTON_DA = 1.00728 // calc.js 2715
export const CAL_LEVEL_TARGETS = [1000, 500, 250, 100, 10, 1] as const // calc.js 2710
export const CAL_STOCK_DILUENT_UL = 1000 // calc.js DEFAULTS.calStockDiluentUl (116)
export const CAL_MIN_STOCK_MG = 20 // calc.js DEFAULTS.calMinStockMg (121)
export const CAL_TOP_ALIQUOT_UL = 150 // calc.js DEFAULTS.calTopAliquotUl (124)
export const CAL_STOCK_AS_TOP_PCT = 5 // calc.js DEFAULTS.calStockAsTopPct (125)
const DENSITY = HPLC_RUN_PARAM_DEFAULTS.diluent_density_mg_ml
const TARGET_VOLUME_UL = HPLC_RUN_PARAM_DEFAULTS.target_volume_ul
const VOLUME_TOLERANCE_PCT = HPLC_RUN_PARAM_DEFAULTS.volume_tolerance_pct

const NET_KEYS = [
  'counterion',
  'counterion_mw',
  'equivalents',
  'free_mw',
  'stated_fw',
  'ms_mz',
  'ms_ion',
  'assay_pct',
  'water_pct',
  'assumption',
  'override_factor',
  'override_reason',
] as const
const REP_LEVEL_OWN = ['peak_area', 'purity', 'rt'] as const // calc.js CAL_REP_LEVEL_OWN (2860)
const BLOCKING: readonly CalWarningCode[] = [
  'net_assumption_missing',
  'override_reason_missing',
]

// ---------------------------------------------------------------- types

/** The net peptide block as stored. Every key optional; null = not typed. */
export interface CalNetInputs {
  counterion?: string | null
  counterion_mw?: number | null
  equivalents?: number | null
  free_mw?: number | null
  stated_fw?: number | null
  ms_mz?: number | null
  ms_ion?: string | null
  assay_pct?: number | null
  water_pct?: number | null
  assumption?: string | null
  override_factor?: number | null
  override_reason?: string | null
}

/** One dilution level as stored. */
export interface CalLevelInputs {
  target?: number | null
  vial_mg?: number | null
  vial_diluent_mg?: number | null
  vial_diluent_std_mg?: number | null
  peak_area?: number | null
  purity?: number | null
  rt?: number | null
}

/** An ORIGINAL sheet's stored inputs (`hplc_calibration_sheets.inputs`). */
export interface CalInputs {
  standard_id?: string | null
  cas?: string | null
  supplier?: string | null
  lot?: string | null
  coa_weight_mg?: number | null
  diluent_density_mg_ml?: number | null
  level_volume_ul?: number | null
  analyst?: string | null
  date?: string | null
  notes?: string | null
  net?: CalNetInputs | null
  stock?: {
    vial_mg?: number | null
    vial_standard_mg?: number | null
    vial_diluent_mg?: number | null
  } | null
  stock_as_top?: boolean | null
  top_aliquot_ul?: number | null
  levels?: CalLevelInputs[] | null
}

/** A REPLICATE sheet's stored inputs: only its own run results. */
export interface CalReplicateInputs {
  notes?: string | null
  levels?:
    | ({
        peak_area?: number | null
        purity?: number | null
        rt?: number | null
      } | null)[]
    | null
}

export type CalWarningCode =
  | 'level_cannot_be_made'
  | 'same_weight_row'
  | 'same_weight_next'
  | 'level_backwards_diluent'
  | 'level_backwards_standard'
  | 'volume_off_diluent'
  | 'volume_off_standard'
  | 'stock_not_heavier'
  | 'stock_under_min'
  | 'net_equivalents_disagree'
  | 'net_fw_mismatch'
  | 'net_fw_mismatch_no_counterion'
  | 'net_ms_mismatch'
  | 'net_kf_missing'
  | 'net_counterion_partial'
  | 'net_assumption_missing'
  | 'net_partial'
  | 'override_reason_missing'

export interface CalWarning {
  code: CalWarningCode
  level: number | null
  text: string
}

export type CalNetPart = 'assay' | 'counterion' | 'water'

export interface CalNet {
  counterion: string
  counterion_mw: number | null
  equivalents: number | null
  free_mw: number | null
  stated_fw: number | null
  assay_pct: number | null
  water_pct: number | null
  fw_basis: 'free' | 'salt' | 'mismatch' | null
  f_counterion: number | null
  factor: number | null
  counterion_applied: boolean
  assumed_fw: boolean
  ms_m: number | null
  parts_used: CalNetPart[]
}

export interface CalFit {
  slope: number | null
  intercept: number | null
  r2: number | null
  n: number
}

export interface CalLevelWorked {
  target: number | null
  problem: 'diluent' | 'standard' | null
  from_stock: boolean
  made_from_ug_ml: number | null
  planned_std_ul: number | null
  planned_diluent_ul: number | null
  actual_diluent_ul: number | null
  std_to_add_ul: number | null
  actual_std_ul: number | null
  total_ul: number | null
  actual_conc_ug_ml: number | null
  peak_area: number | null
  purity: number | null
  rt: number | null
  remaining_ul: number | null
  back_calc_ug_ml: number | null
  back_calc_dev_pct: number | null
}

export interface CalWorked {
  density: number
  level_volume_ul: number
  stock_weight_mg: number | null
  stock_diluent_to_add_ul: number | null
  stock_actual_diluent_ul: number | null
  stock_conc_as_weighed_ug_ml: number | null
  net: CalNet
  factor_applied: number | null
  factor_source: 'computed' | 'override'
  stock_net_weight_mg: number | null
  stock_conc_ug_ml: number | null
  stock_as_top: boolean
  top_aliquot_ul: number
  stock_near_top: boolean
  stock_remaining_ul: number | null
  levels: CalLevelWorked[]
  fit: CalFit
  rt_avg: number | null
  rt_rsd_pct: number | null
  range: { low: number; high: number } | null
  warnings: CalWarning[]
  blocking: CalWarningCode[]
}

// ---------------------------------------------------------------- helpers

/** calc.js num (147): a finite number, else null. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** calc.js div (154): null when either side is missing or the divisor is 0. */
function div(a: number | null, b: number | null): number | null {
  return a === null || b === null || b === 0 ? null : a / b
}

/** calc.js massToVolumeUl (160). */
function volumeUl(massMg: number | null, density: number): number | null {
  const d = div(massMg, density)
  return d === null ? null : d * 1000
}

/** calc.js fmt (5562), for warning text only. */
function fmt(v: number | null, dp = 2): string {
  if (v === null) return ''
  const t = v.toFixed(dp)
  return /^-0(\.0*)?$/.test(t) ? t.slice(1) : t
}

function text(v: unknown): string {
  return (v ? String(v) : '').trim()
}

/** calc.js volumeOff (880): [pct, over], signed, as a share of the plan. */
function volumeOff(
  planned: number | null,
  actual: number | null
): [number | null, boolean] {
  if (planned === null || actual === null || planned <= 0) return [null, false]
  const pct = ((actual - planned) / planned) * 100
  return [pct, Math.abs(pct) > VOLUME_TOLERANCE_PCT]
}

/** calc.js average (1115). */
function average(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null)
  if (v.length === 0) return null
  let s = 0
  for (const x of v) s += x
  return s / v.length
}

/** calc.js stdev (1108): the sample standard deviation. */
function stdev(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null)
  if (v.length < 2) return null
  const m = average(v) as number
  let s = 0
  for (const x of v) s += (x - m) * (x - m)
  return Math.sqrt(s / (v.length - 1))
}

// ---------------------------------------------------------------- blanks

/** calc.js blankCalSheet (2816), in Mk1's shape: six levels at
 *  CAL_LEVEL_TARGETS, every value null. */
export function blankCalInputs(): CalInputs {
  const net: CalNetInputs = {}
  for (const k of NET_KEYS) net[k] = null
  return {
    standard_id: null,
    cas: null,
    supplier: null,
    lot: null,
    coa_weight_mg: null,
    diluent_density_mg_ml: null,
    level_volume_ul: null,
    analyst: null,
    date: null,
    notes: null,
    net,
    stock: { vial_mg: null, vial_standard_mg: null, vial_diluent_mg: null },
    stock_as_top: null,
    top_aliquot_ul: null,
    levels: CAL_LEVEL_TARGETS.map(target => ({
      target,
      vial_mg: null,
      vial_diluent_mg: null,
      vial_diluent_std_mg: null,
      peak_area: null,
      purity: null,
      rt: null,
    })),
  }
}

/** calc.js duplicateCalSheet (2894): a replicate's own fields, run results blank. */
export function blankReplicateInputs(nLevels: number): CalReplicateInputs {
  const levels: CalReplicateInputs['levels'] = []
  for (let i = 0; i < nLevels; i++)
    levels.push({ peak_area: null, purity: null, rt: null })
  return { notes: null, levels }
}

// ---------------------------------------------------------------- pieces

/** calc.js msNeutralMass (2717): z x m/z minus (or plus) z protons. */
export function msNeutralMass(mz: unknown, ion: unknown): number | null {
  const v = num(mz)
  if (v === null || !ion) return null
  if (ion === 'M') return v
  const m = /^M([+-])([0-9]*)H$/.exec(String(ion))
  if (!m) return null
  const z = m[2] ? parseInt(m[2], 10) : 1
  return z * v - (m[1] === '+' ? 1 : -1) * z * PROTON_DA
}

/** calc.js linearFit (1087): centred least squares, a pair with a blank is
 *  ignored; r2 null when every y is equal. */
export function linearFit(points: [unknown, unknown][]): CalFit {
  const pts: [number, number][] = []
  for (const [x0, y0] of points) {
    const x = num(x0)
    const y = num(y0)
    if (x !== null && y !== null) pts.push([x, y])
  }
  const n = pts.length
  if (n < 2) return { slope: null, intercept: null, r2: null, n }
  let sx = 0
  let sy = 0
  for (const [x] of pts) sx += x
  for (const [, y] of pts) sy += y
  const mx = sx / n
  const my = sy / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my)
    sxx += (x - mx) * (x - mx)
    syy += (y - my) * (y - my)
  }
  if (sxx === 0) return { slope: null, intercept: null, r2: null, n }
  const slope = sxy / sxx
  return {
    slope,
    intercept: my - slope * mx,
    r2: syy === 0 ? null : (sxy * sxy) / (sxx * syy),
    n,
  }
}

type NetLine = [CalWarningCode, string]

/** calc.js netPeptide (2741), basis always net: the result and its warning
 *  lines in the source's order. */
function netWorked(net: CalNetInputs | null | undefined): [CalNet, NetLine[]] {
  const n0 = net ?? {}
  const name = text(n0.counterion)
  const hasCi = name !== '' && !/^none$/i.test(name)
  const known = Object.keys(COUNTERIONS).find(
    k => k.toLowerCase() === name.toLowerCase()
  )
  const ciMw = !hasCi
    ? 0
    : known !== undefined
      ? (COUNTERIONS[known] as number)
      : num(n0.counterion_mw)
  const n = num(n0.equivalents)
  const stated = num(n0.stated_fw)
  const freeTyped = num(n0.free_mw)
  const assumedFw = freeTyped === null && stated !== null
  const free = freeTyped !== null ? freeTyped : stated
  const assay = num(n0.assay_pct)
  const water = num(n0.water_pct)
  const warnings: NetLine[] = []
  let fwBasis: CalNet['fw_basis'] = null
  const tol = (x: number) => Math.max(1, x * 0.002)

  if (!assumedFw && free !== null && stated !== null) {
    if (Math.abs(stated - free) <= tol(free)) {
      fwBasis = 'free'
    } else if (hasCi && ciMw) {
      const kr = Math.round((stated - free) / ciMw)
      if (kr >= 1 && Math.abs(stated - (free + kr * ciMw)) <= tol(stated)) {
        fwBasis = 'salt'
        if (n !== null && Math.abs(n - kr) > 0.05)
          warnings.push([
            'net_equivalents_disagree',
            `net peptide: the stated FW says ${kr} ${name} equivalent${kr === 1 ? '' : 's'}, ` +
              `the Equivalents box says ${fmt(n, 2)}: the stated FW is used; check which is right.`,
          ])
      } else {
        fwBasis = 'mismatch'
        warnings.push([
          'net_fw_mismatch',
          'net peptide: the stated FW matches neither the free peptide nor a whole number of ' +
            'counterions: check the molecular formula and FW on the CoA (Step 1 of the net peptide check).',
        ])
      }
    } else {
      fwBasis = 'mismatch'
      warnings.push([
        'net_fw_mismatch_no_counterion',
        'net peptide: the stated FW differs from the free-peptide MW and no counterion is chosen: check the CoA.',
      ])
    }
  }
  const msM = msNeutralMass(n0.ms_mz, n0.ms_ion)
  if (
    msM !== null &&
    free !== null &&
    !(Math.abs(msM - free) <= Math.max(1.5, free * 0.001))
  )
    warnings.push([
      'net_ms_mismatch',
      'net peptide: the mass spec on the CoA does not match the free-peptide MW: check the formula ' +
        'sum and the ion form (MS reports the free peptide, never the salt).',
    ])
  // a divisor of 0 (nonsense MWs) gives null where JavaScript would give Infinity
  let fCi: number | null
  if (!hasCi) fCi = 1
  else if (fwBasis === 'salt') fCi = div(free, stated)
  else if (free !== null && n !== null && ciMw) fCi = div(free, free + n * ciMw)
  else fCi = 1
  const applied = hasCi && fCi !== null && Math.abs(fCi - 1) > 1e-12
  if (water === null)
    warnings.push([
      'net_kf_missing',
      'net peptide: Karl Fischer water not entered: the rule is KF on every reference standard ' +
        'lot; 0 % is used until it is typed.',
    ])
  if (hasCi && !applied) {
    const missing = [
      free === null ? 'free-peptide MW (or the stated FW)' : '',
      n === null && fwBasis !== 'salt' ? 'equivalents' : '',
      !ciMw ? 'counterion mass' : '',
    ]
      .filter(x => x)
      .join(', ')
    warnings.push([
      'net_counterion_partial',
      `net peptide: no ${name} correction yet (missing ${missing || 'its mass'}): the assay and ` +
        'water still apply; the stock is a little high until the counterion is in.',
    ])
  }
  if (applied && !text(n0.assumption))
    warnings.push([
      'net_assumption_missing',
      'net peptide: write the counterion assumption and its basis in words (e.g. "1H NMR, 2.1 eq" ' +
        'or "lean 2, undeclared on the CoA") before the curve is filed.',
    ])
  const factor =
    fCi === null
      ? null
      : (assay === null ? 1 : assay / 100) *
        fCi *
        (1 - (water === null ? 0 : water / 100))
  const parts: CalNetPart[] = []
  if (assay !== null) parts.push('assay')
  if (applied) parts.push('counterion')
  if (water !== null) parts.push('water')
  return [
    {
      counterion: hasCi ? name : '',
      counterion_mw: hasCi ? ciMw : 0,
      equivalents: n,
      free_mw: free,
      stated_fw: stated,
      assay_pct: assay,
      water_pct: water,
      fw_basis: fwBasis,
      f_counterion: fCi,
      factor,
      counterion_applied: applied,
      assumed_fw: assumedFw,
      ms_m: msM,
      parts_used: parts,
    },
    warnings,
  ]
}

/** calc.js netPeptide (2741), basis always net; parts_used is Mk1's (decision 16). */
export function netPeptide(net: CalNetInputs | null | undefined): CalNet {
  return netWorked(net)[0]
}

/** calc.js replicatePrep (2862) over CAL_REP_LEVEL_OWN: the original's
 *  preparation, the replicate's run results. Mutates neither argument. */
export function replicatePrep(
  original: CalInputs | null | undefined,
  replicate: CalReplicateInputs | null | undefined
): CalInputs {
  const out: CalInputs = structuredClone(original ?? {})
  const rep = replicate ?? {}
  delete out.notes
  if ('notes' in rep) out.notes = structuredClone(rep.notes ?? null)
  const repLevels = rep.levels ?? []
  const levels: CalLevelInputs[] = []
  const outLevels = out.levels ?? []
  for (let i = 0; i < outLevels.length; i++) {
    const own = (i < repLevels.length ? repLevels[i] : null) ?? {}
    const x: CalLevelInputs = { ...outLevels[i] }
    for (const f of REP_LEVEL_OWN) x[f] = own[f] ?? null
    levels.push(x)
  }
  out.levels = levels
  return out
}

/** calc.js calDuplicateWeighings (2958): [kind, level, value], same-row per
 *  level, then next-row. toFixed(6) is the source's own key. */
function duplicateWeighings(
  raw: CalLevelInputs[]
): ['same-row' | 'next-row', number, number][] {
  const out: ['same-row' | 'next-row', number, number][] = []
  const fields = ['vial_mg', 'vial_diluent_mg', 'vial_diluent_std_mg'] as const
  for (let i = 0; i < raw.length; i++) {
    const seen = new Set<string>()
    for (const f of fields) {
      const v = num(raw[i]?.[f])
      if (v === null) continue
      const k = v.toFixed(6)
      if (seen.has(k)) {
        if (!out.some(o => o[0] === 'same-row' && o[1] === i && o[2] === v))
          out.push(['same-row', i, v])
      } else {
        seen.add(k)
      }
    }
  }
  for (let i = 0; i < raw.length - 1; i++) {
    for (const f of fields) {
      const a = num(raw[i]?.[f])
      const b = num(raw[i + 1]?.[f])
      if (a !== null && b !== null && a !== 0 && a.toFixed(6) === b.toFixed(6))
        out.push(['next-row', i, a])
    }
  }
  return out
}

function levelWord(target: number | null): string {
  return `the ${fmt(target, 0)} ug/mL level`
}

// ---------------------------------------------------------------- the sheet

/** calc.js calibration (1132) and calWarnings (2996); the stock takes
 *  factor_applied (Mk1's override). Mutates nothing. */
export function workOutSheet(inputs: CalInputs | null | undefined): CalWorked {
  const inp = inputs ?? {}
  const netIn = inp.net ?? {}
  const stock = inp.stock ?? {}
  const density = num(inp.diluent_density_mg_ml) ?? DENSITY
  const vial = num(stock.vial_mg)
  const vialStd = num(stock.vial_standard_mg)
  const vialDiluent = num(stock.vial_diluent_mg)

  const stockWeight = vial === null || vialStd === null ? null : vialStd - vial
  const [net, netWarnings] = netWorked(netIn)
  const override = num(netIn.override_factor)
  const factorApplied = override !== null ? override : net.factor
  const stockNetWeight =
    stockWeight === null
      ? null
      : factorApplied === null
        ? stockWeight
        : stockWeight * factorApplied
  const stockDiluentToAdd = stockWeight === null ? null : CAL_STOCK_DILUENT_UL
  const stockActualDiluent =
    vialStd === null || vialDiluent === null
      ? null
      : volumeUl(vialDiluent - vialStd, density)
  const perMl = stockActualDiluent === null ? null : stockActualDiluent / 1000
  const stockConcAsWeighed =
    stockWeight === null ? null : div(stockWeight * 1000, perMl)
  const stockConc =
    stockNetWeight === null ? null : div(stockNetWeight * 1000, perMl)

  const raw = inp.levels ?? []
  const stockAsTop = !!inp.stock_as_top
  const topAliquot = num(inp.top_aliquot_ul) ?? CAL_TOP_ALIQUOT_UL
  const targetTotal = num(inp.level_volume_ul) ?? TARGET_VOLUME_UL
  const levels: CalLevelWorked[] = []
  let prev = stockConc
  for (let i = 0; i < raw.length; i++) {
    const L = raw[i] ?? {}
    const target = num(L.target)
    const own = {
      peak_area: num(L.peak_area),
      purity: num(L.purity),
      rt: num(L.rt),
    }
    if (i === 0 && stockAsTop) {
      levels.push({
        target,
        problem: null,
        from_stock: true,
        made_from_ug_ml: stockConc,
        planned_std_ul: null,
        planned_diluent_ul: null,
        actual_diluent_ul: null,
        std_to_add_ul: null,
        actual_std_ul: null,
        total_ul: null,
        actual_conc_ug_ml: stockConc,
        ...own,
        remaining_ul: null,
        back_calc_ug_ml: null,
        back_calc_dev_pct: null,
      })
      prev = stockConc
      continue
    }
    const lvVial = num(L.vial_mg)
    const lvDil = num(L.vial_diluent_mg)
    const lvAll = num(L.vial_diluent_std_mg)
    const plannedStd =
      target === null || prev === null || prev <= 0 || target >= prev
        ? null
        : (target * targetTotal) / prev
    const plannedDil = plannedStd === null ? null : targetTotal - plannedStd
    const actualDil =
      lvVial === null || lvDil === null
        ? null
        : volumeUl(lvDil - lvVial, density)
    const stdToAdd =
      actualDil === null || actualDil < 0 || target === null || prev === null
        ? null
        : prev <= target
          ? null
          : div(actualDil * target, prev - target)
    const actualStd =
      lvDil === null || lvAll === null ? null : volumeUl(lvAll - lvDil, density)
    const problem: CalLevelWorked['problem'] =
      actualDil !== null && actualDil < 0
        ? 'diluent'
        : actualStd !== null && actualStd <= 0
          ? 'standard'
          : null
    const total =
      actualDil === null || actualStd === null || problem
        ? null
        : actualDil + actualStd
    const actualConc =
      actualStd === null || prev === null || problem
        ? null
        : div(actualStd * prev, total)
    levels.push({
      target,
      problem,
      from_stock: false,
      made_from_ug_ml: prev,
      planned_std_ul: plannedStd,
      planned_diluent_ul: plannedDil,
      actual_diluent_ul: actualDil,
      std_to_add_ul: stdToAdd,
      actual_std_ul: actualStd,
      total_ul: total,
      actual_conc_ug_ml: actualConc,
      ...own,
      remaining_ul: null,
      back_calc_ug_ml: null,
      back_calc_dev_pct: null,
    })
    prev = actualConc
  }

  // remaining: what is left of a level after the next one is drawn from it (calc.js 1224)
  let drawn: number
  if (stockAsTop) {
    const next = levels.length > 1 ? levels[1]?.actual_std_ul : null
    drawn = topAliquot + (next ?? 0)
  } else {
    drawn = levels[0]?.actual_std_ul ?? 0
  }
  const stockRemaining =
    stockActualDiluent === null ? null : stockActualDiluent - drawn
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i] as CalLevelWorked
    if (level.from_stock) {
      level.remaining_ul = stockRemaining
      continue
    }
    const nextStd = levels[i + 1]?.actual_std_ul ?? null
    level.remaining_ul =
      level.total_ul === null ? null : level.total_ul - (nextStd ?? 0)
  }
  const top = raw.length > 0 ? num(raw[0]?.target) : null
  const stockNearTop =
    !stockAsTop && stockConc !== null && top
      ? (Math.abs(stockConc - top) / top) * 100 <= CAL_STOCK_AS_TOP_PCT
      : false

  const fit = linearFit(levels.map(L => [L.actual_conc_ug_ml, L.peak_area]))
  for (const L of levels) {
    if (fit.slope && L.peak_area !== null) {
      const back = (L.peak_area - (fit.intercept as number)) / fit.slope
      L.back_calc_ug_ml = back
      L.back_calc_dev_pct = L.actual_conc_ug_ml
        ? ((back - L.actual_conc_ug_ml) / L.actual_conc_ug_ml) * 100
        : null
    }
  }
  const rts = levels.map(L => L.rt)
  const rtAvg = average(rts)
  const rtSd = stdev(rts)
  const rtRsd = rtAvg ? (rtSd === null ? null : (rtSd / rtAvg) * 100) : null
  const fitted: number[] = []
  for (const L of levels)
    if (L.actual_conc_ug_ml !== null && L.peak_area !== null)
      fitted.push(L.actual_conc_ug_ml)
  const range =
    fitted.length > 0
      ? { low: Math.min(...fitted), high: Math.max(...fitted) }
      : null

  // calWarnings (2996), then Mk1's two
  const warnings: CalWarning[] = []
  const warn = (code: CalWarningCode, level: number | null, t: string) =>
    warnings.push({ code, level, text: t })

  for (const [kind, i, value] of duplicateWeighings(raw)) {
    if (kind === 'same-row')
      warn(
        'same_weight_row',
        i,
        `${levelWord(num(raw[i]?.target))}: the same weight ${fmt(value, 2)} mg ` +
          'in two of its weighings: "add result" pressed twice? Weigh again.'
      )
    else
      warn(
        'same_weight_next',
        i,
        `${levelWord(num(raw[i]?.target))} and ` +
          `${levelWord(num(raw[i + 1]?.target))}: the same weight ${fmt(value, 2)} mg one above the ` +
          'other: "add result" pressed twice? Check which is right.'
      )
  }
  levels.forEach((L, i) => {
    if (L.problem === 'diluent')
      warn(
        'level_backwards_diluent',
        i,
        `${levelWord(L.target)}: Step 3 weighings go backwards: "Vial, cap ` +
          'and Diluent" is less than the empty vial. Check the weights; nothing is worked out for this level ' +
          'or the ones below until they do.'
      )
    else if (L.problem === 'standard')
      warn(
        'level_backwards_standard',
        i,
        `${levelWord(L.target)}: Step 3 weighings go backwards: the last ` +
          'weight (vial, diluent + standard) is not more than the vial + diluent weight, so no standard went ' +
          'in. Check the weights; nothing is worked out for this level or the ones below until they do.'
      )
  })
  // calc.js calVolumeDeviations (2983)
  levels.forEach((L, i) => {
    if (L.problem) return
    const checks: ['diluent' | 'standard', number | null, number | null][] = [
      ['diluent', L.planned_diluent_ul, L.actual_diluent_ul],
      ['standard', L.std_to_add_ul, L.actual_std_ul],
    ]
    for (const [what, planned, actual] of checks) {
      const [pct, over] = volumeOff(planned, actual)
      if (over && pct !== null)
        warn(
          `volume_off_${what}`,
          i,
          `${levelWord(L.target)}: ${what} added is ${fmt(actual, 2)} uL ` +
            `against ${fmt(planned, 2)} planned (${pct > 0 ? '+' : ''}${fmt(pct, 1)}%, more than ` +
            `${VOLUME_TOLERANCE_PCT}% off): remake the level, or call it out.`
        )
    }
  })
  if (stockWeight !== null && stockWeight <= 0)
    warn(
      'stock_not_heavier',
      null,
      'the stock: the vial with the standard weighs no more than the empty vial: ' +
        'check the two stock weighings.'
    )
  if (stockWeight !== null && stockWeight > 0 && stockWeight < CAL_MIN_STOCK_MG)
    warn(
      'stock_under_min',
      null,
      `the stock: ${fmt(stockWeight, 2)} mg of standard is under the ` +
        `${CAL_MIN_STOCK_MG} mg minimum: weigh 25 to 50 mg and dilute (USP <41>; a weighing this small puts ` +
        '1 to 2 % into every level).'
    )
  for (const [code, t] of netWarnings) warn(code, null, t)
  const cannot = levels.findIndex(
    L =>
      !L.from_stock &&
      L.target !== null &&
      L.made_from_ug_ml !== null &&
      L.made_from_ug_ml <= L.target
  )
  if (cannot >= 0) {
    const L = levels[cannot] as CalLevelWorked
    const t =
      cannot === 0
        ? `the stock: ${fmt(L.made_from_ug_ml, 2)} ug/mL is not stronger than ${levelWord(L.target)}, ` +
          'so that level cannot be made from it: the stock needs more standard or less diluent.'
        : `${levelWord(L.target)} cannot be made from the level above it ` +
          `(${fmt(L.made_from_ug_ml, 2)} ug/mL): check that level's weighings.`
    warnings.unshift({ code: 'level_cannot_be_made', level: cannot, text: t })
  }
  const ciNotApplied = net.counterion !== '' && !net.counterion_applied
  if (net.assay_pct === null || net.water_pct === null || ciNotApplied)
    warn(
      'net_partial',
      null,
      'net peptide: the factor is partial: ' +
        [
          net.assay_pct === null ? 'assay not typed' : '',
          net.water_pct === null ? 'water not typed' : '',
          ciNotApplied ? `${net.counterion} not applied` : '',
        ]
          .filter(x => x)
          .join(', ') +
        '; only the parts typed are in it.'
    )
  if (override !== null && !text(netIn.override_reason))
    warn(
      'override_reason_missing',
      null,
      'net peptide: the factor is entered by hand: write why before the ' +
        'curve is filed.'
    )

  return {
    density,
    level_volume_ul: targetTotal,
    stock_weight_mg: stockWeight,
    stock_diluent_to_add_ul: stockDiluentToAdd,
    stock_actual_diluent_ul: stockActualDiluent,
    stock_conc_as_weighed_ug_ml: stockConcAsWeighed,
    net,
    factor_applied: factorApplied,
    factor_source: override !== null ? 'override' : 'computed',
    stock_net_weight_mg: stockNetWeight,
    stock_conc_ug_ml: stockConc,
    stock_as_top: stockAsTop,
    top_aliquot_ul: topAliquot,
    stock_near_top: stockNearTop,
    stock_remaining_ul: stockRemaining,
    levels,
    fit,
    rt_avg: rtAvg,
    rt_rsd_pct: rtRsd,
    range,
    warnings,
    blocking: warnings.map(w => w.code).filter(c => BLOCKING.includes(c)),
  }
}
