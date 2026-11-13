/**
 * HPLC prep worksheet arithmetic (plan 3, Task 4): computeRow, the browser's
 * twin of backend/hplc_prep.py compute_row, ported line for line from the
 * Python, which ports the lab tool's calc.js (tools-dennis, hplc-peptide-quant,
 * commit 39a1afe8). Each helper is named after the calc.js function it ports,
 * with its line. backend/tests/fixtures/hplc_prep_cases.json pins both sides.
 *
 * Targets, leads, the diluent and the floor come from plan 2's rules by
 * peptide id (hplc-prep-rules). Every number is unrounded; a value that cannot
 * be worked out is null, never 0. Pure: no DOM, no fetch.
 */
import {
  componentTarget,
  matchRule,
  pickLead,
  rowDiluent,
  rowFloor,
  type ComponentTarget,
  type HplcPrepRule,
  type LeadPick,
} from '@/lib/hplc-prep-rules'
import type { HPLC_RUN_PARAM_DEFAULTS } from '@/lib/hplc-run-params'

// ---------------------------------------------------------------- types

export type HplcPrepForm = 'powder' | 'liquid' | 'bac' | 'capsule'

/** The thirteen method constants (hplcRunParamsFrom's result). */
export type HplcRunParams = Record<keyof typeof HPLC_RUN_PARAM_DEFAULTS, number>

/** What the rule functions read: a snapshot line or a served one. */
type RuleLine = Omit<
  HplcPrepRule,
  | 'peptide_name'
  | 'peptide_is_blend'
  | 'lead_component_name'
  | 'default_instrument_name'
  | 'updated_at'
>

/** One autosampler vial's typed inputs (`hplc_prep.vials[n]`). */
export interface HplcPrepVialInputs {
  lead_id?: number | null
  target_ug_ml?: number | null
  target_volume_ul?: number | null
  vial_mg?: number | null
  vial_diluent_mg?: number | null
  vial_all_mg?: number | null
  int_target_ug_ml?: number | null
  int_volume_ul?: number | null
  int_vial_mg?: number | null
  int_vial_diluent_mg?: number | null
  int_vial_all_mg?: number | null
}

/** One blend component's typed inputs (`hplc_prep.components[peptide_id]`). */
export interface HplcPrepComponentInputs {
  mg?: number | null
  vial?: number | null
  target?: number | null
}

/**
 * `worksheet_items.hplc_prep`, what a tech typed on one row. Every key is
 * optional (missing = not typed). A null is a PATCH's "remove this key"; the
 * stored shape never holds one, and computeRow reads a null as not typed.
 */
export interface HplcPrepInputs {
  declared_mg?: number | null
  declared_volume_ml?: number | null
  capsules?: number | null
  diluent?: string | null
  /** Shown only; changes no output (the tool only displays it). */
  diluent_ul?: number | null
  /** true, false, or absent (by the rule). */
  two_step?: boolean | null
  /** bac: the vial emptied and dried, weighed second. */
  stock_vial_mg?: number | null
  /** bac: the vial full as received, weighed first. */
  stock_vial_diluent_mg?: number | null
  components?: Record<string, HplcPrepComponentInputs | null> | null
  vials?: Record<string, HplcPrepVialInputs | null> | null
}

/** One component of the row facts. */
export interface HplcRowFactsComponent {
  peptide_id: number
  declared_mg: number | null
  vial: number | null
  name?: string | null
  abbreviation?: string | null
}

/** The row facts computeRow reads. */
export interface HplcRowFacts {
  declared_mg: number | null
  /** null: a Pen, a Nasal Spray; no HPLC prep maths. */
  form: HplcPrepForm | null
  peptide_id: number | null
  components: HplcRowFactsComponent[]
}

export type HplcWarningCode =
  | 'declared'
  | 'stock_backwards'
  | 'step3a_diluent'
  | 'step3a_stock'
  | 'step3_diluent'
  | 'step3_stock'
  | 'volume_off'
  | 'below_floor'
  | 'capsule_over_neat'
  | 'capsule_no_count'
  | 'split_mismatch'

export interface HplcWarning {
  code: HplcWarningCode
  vial: number | null
  peptide_id: number | null
  text: string
}

export interface HplcDilutionPlan {
  stock_vol_ul: number | null
  diluent_vol_ul: number | null
  stock_half_ul: number | null
  diluent_half_ul: number | null
}

export interface HplcDilutionActual {
  actual_diluent_ul: number | null
  actual_stock_ul: number | null
  actual_total_ul: number | null
  actual_conc_ug_ml: number | null
  dilution_factor: number | null
  /** A weighing lower than the one before it; nothing is worked out then. */
  problem: 'diluent' | 'stock' | null
}

export interface HplcVolumeOff {
  diluent: boolean
  stock: boolean
}

export interface HplcIntermediate {
  target_ug_ml: number | null
  volume_ul: number
  target_defaulted: boolean
  plan: HplcDilutionPlan
  actual: HplcDilutionActual
  weighed: boolean
  conc_for_final: number | null
  off: HplcVolumeOff
}

export interface HplcVialTarget {
  value: number
  source: 'typed' | 'component' | 'bac' | ComponentTarget['source']
  typed: boolean
}

export interface HplcVialComputed {
  vial: number
  component_ids: number[]
  lead: LeadPick
  target: HplcVialTarget
  target_volume_ul: number
  stock_conc_ug_ml: number | null
  two_step: boolean
  neat: boolean
  /** Non-null exactly when two_step. */
  intermediate: HplcIntermediate | null
  stock_for_final: number | null
  plan: HplcDilutionPlan
  actual: HplcDilutionActual
  dilution_factor_total: number | null
  off: HplcVolumeOff
}

export interface HplcComponentTargetShown {
  value: number
  source: 'typed' | ComponentTarget['source']
  rule_id: number | null
  typed: boolean
}

export interface HplcComponentComputed {
  peptide_id: number
  declared_mg: number | null
  vial: number
  lead: boolean
  target: HplcComponentTargetShown
  stock_conc_ug_ml: number | null
  planned_final_ug_ml: number | null
  actual_final_ug_ml: number | null
  below_floor: boolean
}

/** Everything the sheet shows for one row. On a row with no form every
 *  value is null and the lists are empty. */
export interface HplcRowComputed {
  form: HplcPrepForm | null
  declared_total_mg: number | null
  diluent: { diluent: string | null; rule_id: number | null; typed: boolean }
  stock: {
    total_diluent_ml: number | null
    problem: 'declared' | 'diluent' | null
  }
  capsule_diluent_ul: number | null
  floor_ug_ml: number | null
  components: HplcComponentComputed[]
  vials: HplcVialComputed[]
  warnings: HplcWarning[]
}

// ---------------------------------------------------------------- helpers

const MAX_VIALS = 7 // calc.js VIAL_LETTERS 'ABCDEFG'

/** The edge: a missing key, null, NaN or a non-number all read as null. */
function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

function div(a: number | null, b: number | null): number | null {
  // calc.js div (154): null when either side is missing or the divisor is 0
  return a === null || b === null || b === 0 ? null : a / b
}

function volumeUl(massMg: number | null, density: number): number | null {
  // calc.js massToVolumeUl (160)
  const d = div(massMg, density)
  return d === null ? null : d * 1000
}

function positive(v: number | null): number | null {
  return v !== null && v > 0 ? v : null
}

function bacVolumeMl(
  massMg: number | null,
  params: HplcRunParams
): number | null {
  // calc.js bacVolumeMl (282)
  const rw = params.diluent_density_mg_ml
  const rba = params.benzyl_alcohol_density_mg_ml
  if (massMg === null || massMg <= 0 || rw <= 0) return null
  const c = params.bac_stock_ug_ml / 1000
  return massMg / rw / (1 - c / rba + c / rw)
}

function bacDeclaredMg(
  inputs: HplcPrepInputs,
  params: HplcRunParams
): number | null {
  // calc.js bacInput (295): a bac row's declared weight is worked out from its two weighings
  const full = num(inputs.stock_vial_diluent_mg)
  const emptied = num(inputs.stock_vial_mg)
  const vol =
    full === null || emptied === null
      ? null
      : bacVolumeMl(full - emptied, params)
  return vol === null || vol <= 0 ? null : (vol * params.bac_stock_ug_ml) / 1000
}

function declaredTotalMg(
  form: HplcPrepForm,
  declared: number | null,
  capsules: number | null
): number | null {
  // calc.js declaredTotalMg (247): per capsule x capsules for a capsule row
  if (form !== 'capsule') return declared
  return declared === null || capsules === null || capsules <= 0
    ? null
    : declared * capsules
}

function stockPrep(
  form: HplcPrepForm,
  declared: number | null,
  inputs: HplcPrepInputs,
  params: HplcRunParams
): [number | null, number | null, 'declared' | 'diluent' | null] {
  // calc.js stockPrep (182): the stock's volume (mL), its concentration, and its problem
  const density = params.diluent_density_mg_ml
  const vial = num(inputs.stock_vial_mg)
  const vialDiluent = num(inputs.stock_vial_diluent_mg)
  const liquid = form === 'liquid'
  const bac = form === 'bac'
  let totalMl: number | null
  if (liquid) totalMl = positive(num(inputs.declared_volume_ml))
  else if (vial === null || vialDiluent === null) totalMl = null
  else if (bac && vialDiluent - vial > 0)
    totalMl = bacVolumeMl(vialDiluent - vial, params)
  else totalMl = div(vialDiluent - vial, density)
  let problem: 'declared' | 'diluent' | null = null
  if (!bac && declared !== null && declared <= 0) problem = 'declared'
  else if (!liquid && totalMl !== null && totalMl <= 0) problem = 'diluent'
  let conc: number | null
  if (bac) conc = problem !== null ? null : params.bac_stock_ug_ml
  else
    conc =
      declared === null || problem !== null
        ? null
        : div(declared * 1000, totalMl)
  return [totalMl, conc, problem]
}

function dilutionPlan(
  target: number | null,
  volume: number | null,
  stock: number | null
): HplcDilutionPlan {
  // calc.js dilutionPlan (315): C1V1 = C2V2, each volume also in halves
  const stockVol =
    target === null || volume === null ? null : div(target * volume, stock)
  const diluentVol =
    stockVol === null || volume === null ? null : volume - stockVol
  return {
    stock_vol_ul: stockVol,
    diluent_vol_ul: diluentVol,
    stock_half_ul: stockVol === null ? null : stockVol / 2,
    diluent_half_ul: diluentVol === null ? null : diluentVol / 2,
  }
}

function dilutionActual(
  vial: number | null,
  vialDiluent: number | null,
  vialAll: number | null,
  stock: number | null,
  density: number
): HplcDilutionActual {
  // calc.js dilutionActual (341): a weighing lower than the one before it is flagged, never
  // computed from (diluent < 0, stock <= 0)
  const diluentUl =
    vial === null || vialDiluent === null
      ? null
      : volumeUl(vialDiluent - vial, density)
  const stockUl =
    vialDiluent === null || vialAll === null
      ? null
      : volumeUl(vialAll - vialDiluent, density)
  let problem: 'diluent' | 'stock' | null = null
  if (diluentUl !== null && diluentUl < 0) problem = 'diluent'
  else if (stockUl !== null && stockUl <= 0) problem = 'stock'
  const total =
    diluentUl === null || stockUl === null || problem !== null
      ? null
      : diluentUl + stockUl
  const conc =
    stock === null || stockUl === null || problem !== null
      ? null
      : div(stock * stockUl, total)
  return {
    actual_diluent_ul: diluentUl,
    actual_stock_ul: stockUl,
    actual_total_ul: total,
    actual_conc_ug_ml: conc,
    dilution_factor: problem !== null ? null : div(total, stockUl),
    problem,
  }
}

function volumeOff(
  planned: number | null,
  actual: number | null,
  params: HplcRunParams
): boolean {
  // calc.js volumeOff (880): past the tolerance, as a share of the plan
  if (planned === null || actual === null || planned <= 0) return false
  return (
    Math.abs(((actual - planned) / planned) * 100) > params.volume_tolerance_pct
  )
}

function off(
  plan: HplcDilutionPlan,
  actual: HplcDilutionActual,
  params: HplcRunParams
): HplcVolumeOff {
  return {
    diluent: volumeOff(plan.diluent_vol_ul, actual.actual_diluent_ul, params),
    stock: volumeOff(plan.stock_vol_ul, actual.actual_stock_ul, params),
  }
}

function needsTwoStep(
  twoStep: boolean | null,
  leadMg: number | null,
  params: HplcRunParams
): boolean {
  // calc.js needsTwoStep (1020): the row's yes / no, else declared >= the threshold
  if (twoStep !== null) return twoStep
  return leadMg !== null && leadMg >= params.two_step_threshold_mg
}

function intermediateTarget(
  stock: number | null,
  target: number | null,
  fixed: number
): number | null {
  // calc.js intermediateTarget (1038)
  if (stock !== null && (stock <= 0 || stock <= fixed)) return null
  if (target !== null && target >= fixed) return null
  return fixed
}

function intermediateStep(
  v: HplcPrepVialInputs,
  stock: number | null,
  target: number | null,
  params: HplcRunParams
): HplcIntermediate {
  // calc.js intermediateStep (1064): Step 3 dilutes from the actual once weighed, else the target
  const typedTarget = positive(num(v.int_target_ug_ml))
  const typedVolume = positive(num(v.int_volume_ul))
  const intTarget =
    typedTarget !== null
      ? typedTarget
      : intermediateTarget(stock, target, params.intermediate_target_ug_ml)
  const volume =
    typedVolume !== null ? typedVolume : params.intermediate_volume_ul
  const plan = dilutionPlan(intTarget, volume, stock)
  const actual = dilutionActual(
    num(v.int_vial_mg),
    num(v.int_vial_diluent_mg),
    num(v.int_vial_all_mg),
    stock,
    params.diluent_density_mg_ml
  )
  const weighed = actual.actual_conc_ug_ml !== null
  return {
    target_ug_ml: intTarget,
    volume_ul: volume,
    target_defaulted: typedTarget === null,
    plan,
    actual,
    weighed,
    conc_for_final: weighed ? actual.actual_conc_ug_ml : intTarget,
    off: off(plan, actual, params),
  }
}

interface SampleComponent {
  peptide_id: number
  declared_mg: number | null
  vial: number
  typed_target: number | null
}

function sampleComponents(
  facts: HplcRowFacts,
  inputs: HplcPrepInputs,
  declared: number | null,
  isBlend: boolean
): SampleComponent[] {
  // calc.js sampleComponents (763) and sampleVials (820): weights, vials, typed targets
  const own = inputs.components ?? {}
  const out: SampleComponent[] = []
  for (const c of facts.components) {
    const mine = own[String(c.peptide_id)] ?? {}
    let mg: number | null
    let vial: number
    if (isBlend) {
      const typedMg = num(mine.mg)
      mg = positive(typedMg !== null ? typedMg : num(c.declared_mg))
      const factsVial = num(c.vial)
      const typedVial = num(mine.vial)
      // Python's `c.get("vial") or 1`: a missing or 0 vial is vial 1
      const v =
        typedVial !== null
          ? typedVial
          : factsVial === null || factsVial === 0
            ? 1
            : factsVial
      vial = Number.isInteger(v) && v >= 1 && v <= MAX_VIALS ? v : 1
    } else {
      mg = declared
      vial = 1
    }
    out.push({
      peptide_id: c.peptide_id,
      declared_mg: mg,
      vial,
      typed_target: positive(num(mine.target)),
    })
  }
  return out
}

function splitMismatch(
  comps: SampleComponent[],
  declared: number | null
): boolean {
  // calc.js sampleComponents (788): every share typed and their sum off the declared by 0.005
  const weighed = comps.flatMap(c =>
    c.declared_mg !== null ? [c.declared_mg] : []
  )
  return (
    weighed.length === comps.length &&
    declared !== null &&
    Math.abs(weighed.reduce((a, b) => a + b, 0) - declared) > 0.005
  )
}

function vialTarget(
  v: HplcPrepVialInputs,
  lead: SampleComponent,
  rule: ComponentTarget,
  isBlend: boolean,
  bac: boolean,
  params: HplcRunParams
): HplcVialTarget {
  // calc.js computeRun vial loop (1842): typed on the vial, else the lead's typed own target,
  // else the rule (a bac row with no rule: the bac target)
  const typed = positive(num(v.target_ug_ml))
  if (typed !== null) return { value: typed, source: 'typed', typed: true }
  if (isBlend && lead.typed_target !== null)
    return { value: lead.typed_target, source: 'component', typed: false }
  if (bac && rule.source === 'default')
    return { value: params.bac_target_ug_ml, source: 'bac', typed: false }
  return { value: rule.value, source: rule.source, typed: false }
}

// ---------------------------------------------------------------- computeRow

/**
 * Everything the sheet shows for one row: the stock, each autosampler vial's
 * plan and actual, each component's finals, and the warnings. calc.js
 * computeRun (1792), its per-sample block. Throws, as the Python does, on a
 * row with a form and no components.
 */
export function computeRow(
  facts: HplcRowFacts,
  inputsIn: HplcPrepInputs | null | undefined,
  rules: RuleLine[],
  params: HplcRunParams
): HplcRowComputed {
  const inputs = inputsIn ?? {}
  const form = facts.form ?? null
  const density = params.diluent_density_mg_ml
  const defaultTarget = params.default_target_ug_ml
  if (form === null) {
    // a Pen, a Nasal Spray: no HPLC prep maths
    return {
      form: null,
      declared_total_mg: null,
      diluent: { diluent: null, rule_id: null, typed: false },
      stock: { total_diluent_ml: null, problem: null },
      capsule_diluent_ul: null,
      floor_ug_ml: null,
      components: [],
      vials: [],
      warnings: [],
    }
  }
  const typedDeclared = num(inputs.declared_mg)
  let declared = typedDeclared !== null ? typedDeclared : num(facts.declared_mg)
  let twoStep: boolean | null =
    typeof inputs.two_step === 'boolean' ? inputs.two_step : null
  if (form === 'bac') {
    // calc.js bacInput (295)
    declared = bacDeclaredMg(inputs, params)
    twoStep = twoStep === true
  }
  const totalMg = declaredTotalMg(form, declared, num(inputs.capsules))
  const [totalMl, rowStock, stockProblem] = stockPrep(
    form,
    totalMg,
    inputs,
    params
  )
  const bac = form === 'bac'
  const neat = form === 'capsule'

  const stockOf = (mg: number | null): number | null => {
    // computeRun stockOf (1813)
    if (bac) return stockProblem !== null ? null : rowStock
    return mg === null || stockProblem !== null ? null : div(mg * 1000, totalMl)
  }

  const isBlend = facts.components.length > 1
  const comps = sampleComponents(facts, inputs, declared, isBlend)
  const rowRule = matchRule(rules, {
    peptideId: num(facts.peptide_id),
    weightMg: totalMg,
  })
  const leadView = comps.map(c => ({
    peptide_id: c.peptide_id,
    declared_mg: c.declared_mg,
  }))
  const typedDiluent = (
    typeof inputs.diluent === 'string' ? inputs.diluent : ''
  ).trim()
  const diluent = typedDiluent
    ? { diluent: typedDiluent, rule_id: null, typed: true }
    : { ...rowDiluent(rules, { rowRule, components: leadView }), typed: false }
  const floor = rowFloor(rowRule, { default: params.floor_ug_ml })
  const targets = new Map<number, ComponentTarget>()
  for (const c of comps)
    targets.set(
      c.peptide_id,
      componentTarget(rules, {
        peptideId: c.peptide_id,
        weightMg: c.declared_mg,
        inBlend: isBlend,
        default: defaultTarget,
      })
    )
  const targetOf = (id: number): ComponentTarget => {
    const t = targets.get(id)
    if (t === undefined)
      throw new Error(`computeRow: no target for peptide ${id}`)
    return t
  }
  const vialInputs = inputs.vials ?? {}

  const vials: HplcVialComputed[] = []
  for (const n of [...new Set(comps.map(c => c.vial))].sort((a, b) => a - b)) {
    const inVial = comps.filter(c => c.vial === n)
    const v = vialInputs[String(n)] ?? {}
    const lead = pickLead(
      rules,
      inVial.map(c => ({
        peptide_id: c.peptide_id,
        declared_mg: c.declared_mg,
      })),
      { rowRule, chosenId: num(v.lead_id) }
    )
    const leadC = inVial.find(c => c.peptide_id === lead?.peptide_id)
    if (lead === null || leadC === undefined)
      throw new Error(`computeRow: vial ${n} has no lead`)
    const leadMg =
      isBlend && leadC.declared_mg !== null ? leadC.declared_mg : totalMg
    const stock = stockOf(leadMg)
    const steps2 = !neat && needsTwoStep(twoStep, leadMg, params)
    const target = vialTarget(
      v,
      leadC,
      targetOf(leadC.peptide_id),
      isBlend,
      bac,
      params
    )
    const typedVolume = num(v.target_volume_ul)
    const volume = typedVolume !== null ? typedVolume : params.target_volume_ul
    const inter = steps2
      ? intermediateStep(v, stock, target.value, params)
      : null
    const forFinal = inter !== null ? inter.conc_for_final : stock
    const plan = dilutionPlan(neat ? forFinal : target.value, volume, forFinal)
    let vialDiluent = num(v.vial_diluent_mg)
    if (neat && vialDiluent === null && num(v.vial_mg) !== null)
      vialDiluent = num(v.vial_mg) // a capsule is neat: a blank "+ diluent" is the empty vial
    const actual = dilutionActual(
      num(v.vial_mg),
      vialDiluent,
      num(v.vial_all_mg),
      forFinal,
      density
    )
    let factor: number | null
    if (inter !== null) {
      const a = inter.actual.dilution_factor
      const b = actual.dilution_factor
      factor = a !== null && b !== null ? a * b : null
    } else {
      factor = actual.dilution_factor
    }
    vials.push({
      vial: n,
      component_ids: inVial.map(c => c.peptide_id),
      lead,
      target,
      target_volume_ul: volume,
      stock_conc_ug_ml: stock,
      two_step: steps2,
      neat,
      intermediate: inter,
      stock_for_final: forFinal,
      plan,
      actual,
      dilution_factor_total: factor,
      off: off(plan, actual, params),
    })
  }
  const vial0 = vials[0]
  if (vial0 === undefined)
    throw new Error('computeRow: a row with a form has no components')

  // computeRun component loop (1873): each at its vial lead's x (its stock / the lead's stock)
  const byVial = new Map(vials.map(v => [v.vial, v]))
  const components: HplcComponentComputed[] = []
  for (const c of comps) {
    const v = byVial.get(c.vial)
    if (v === undefined) throw new Error(`computeRow: no vial ${c.vial}`)
    const stock = isBlend ? stockOf(c.declared_mg) : vial0.stock_conc_ug_ml
    const leadStock = v.stock_conc_ug_ml
    const ratio =
      stock === null || leadStock === null || leadStock === 0
        ? null
        : stock / leadStock
    const planned = ratio === null ? null : v.target.value * ratio
    const conc = v.actual.actual_conc_ug_ml
    const isLead = v.lead.peptide_id === c.peptide_id
    const rule = targetOf(c.peptide_id)
    const target: HplcComponentTargetShown =
      c.typed_target !== null
        ? { value: c.typed_target, source: 'typed', rule_id: null, typed: true }
        : { ...rule, typed: false }
    components.push({
      peptide_id: c.peptide_id,
      declared_mg: c.declared_mg,
      vial: c.vial,
      lead: isLead,
      target,
      stock_conc_ug_ml: stock,
      planned_final_ug_ml: planned,
      actual_final_ug_ml: ratio === null || conc === null ? null : conc * ratio,
      below_floor: !isLead && planned !== null && planned < floor,
    })
  }

  let capsuleDiluent: number | null = null
  if (neat) {
    // computeRun capsuleDiluentUl (1907): the water that takes the stock to the target
    const t = vial0.target.value
    capsuleDiluent = totalMg !== null && t > 0 ? (totalMg * 1e6) / t : null
  }

  return {
    form,
    declared_total_mg: totalMg,
    diluent,
    stock: { total_diluent_ml: totalMl, problem: stockProblem },
    capsule_diluent_ul: capsuleDiluent,
    floor_ug_ml: floor,
    components,
    vials,
    warnings: warnings(
      form,
      stockProblem,
      vials,
      components,
      inputs,
      comps,
      declared,
      isBlend,
      vial0.stock_conc_ug_ml,
      floor,
      params
    ),
  }
}

/** Python's `{x:g}` for the plain values these texts show. */
const g = (x: number): string => String(x)

function warnings(
  form: HplcPrepForm,
  stockProblem: 'declared' | 'diluent' | null,
  vials: HplcVialComputed[],
  components: HplcComponentComputed[],
  inputs: HplcPrepInputs,
  comps: SampleComponent[],
  declared: number | null,
  isBlend: boolean,
  rowStock: number | null,
  floor: number,
  params: HplcRunParams
): HplcWarning[] {
  // calc.js weighingWarnings (2004), volumeWarnings (917), capsuleWarnings (4048) and the
  // summary's capsuleNoCount, belowFloor and the split. Order: the stock; per vial Step 3a then
  // Step 3; volume_off per vial (Step 3 stock, diluent, Step 3a stock, diluent); below_floor;
  // capsule_no_count; capsule_over_neat; split_mismatch.
  const out: HplcWarning[] = []
  const warn = (
    code: HplcWarningCode,
    text: string,
    vial: number | null = null,
    peptideId: number | null = null
  ): void => {
    out.push({ code, vial, peptide_id: peptideId, text })
  }

  if (stockProblem === 'declared')
    warn(
      'declared',
      'The declared peptide weight must be more than 0 mg. No stock is worked out.'
    )
  if (stockProblem === 'diluent')
    warn(
      'stock_backwards',
      'Step 2 weighings go backwards: the vial and septum + diluent is not ' +
        'more than the empty vial. Check the two weights; no stock is worked out until they do.'
    )
  const weighing = {
    diluent: 'the vial + diluent weight is less than the empty vial',
    stock:
      'the last weight (vial, diluent + stock) is not more than the vial + diluent ' +
      'weight, so no stock went in',
  }
  for (const v of vials) {
    const steps: ['3a' | '3', 'step3a' | 'step3', HplcDilutionActual][] = []
    if (v.two_step && v.intermediate !== null)
      steps.push(['3a', 'step3a', v.intermediate.actual])
    steps.push(['3', 'step3', v.actual])
    for (const [label, code, actual] of steps) {
      if (actual.problem !== null)
        warn(
          `${code}_${actual.problem}`,
          `Vial ${v.vial}, Step ${label}: ${weighing[actual.problem]}. ` +
            'Check the weights; no concentration is worked out.',
          v.vial
        )
    }
  }
  const tol = params.volume_tolerance_pct
  for (const v of vials) {
    const checks: [
      string,
      'stock' | 'diluent',
      HplcDilutionPlan,
      HplcDilutionActual,
    ][] = [
      ['final vial', 'stock', v.plan, v.actual],
      ['final vial', 'diluent', v.plan, v.actual],
    ]
    if (v.two_step && v.intermediate !== null) {
      const i = v.intermediate
      checks.push(
        ['intermediate', 'stock', i.plan, i.actual],
        ['intermediate', 'diluent', i.plan, i.actual]
      )
    }
    for (const [where, what, plan, actual] of checks) {
      const planned = what === 'stock' ? plan.stock_vol_ul : plan.diluent_vol_ul
      const got =
        what === 'stock' ? actual.actual_stock_ul : actual.actual_diluent_ul
      if (planned !== null && got !== null && volumeOff(planned, got, params))
        warn(
          'volume_off',
          `Vial ${v.vial}: the ${what} added to the ${where} is ${got.toFixed(2)} uL ` +
            `against ${planned.toFixed(2)} uL planned, more than ${g(tol)}% off. ` +
            'Remake the vial, or call it out.',
          v.vial
        )
    }
  }
  for (const c of components) {
    if (c.below_floor && c.planned_final_ug_ml !== null)
      warn(
        'below_floor',
        `This peptide lands at ${c.planned_final_ug_ml.toFixed(2)} ug/mL in vial ${c.vial}, ` +
          `under the ${g(floor)} ug/mL floor. Consider giving it its own vial.`,
        c.vial,
        c.peptide_id
      )
  }
  const capsules = num(inputs.capsules)
  if (form === 'capsule' && !(capsules !== null && capsules > 0))
    warn(
      'capsule_no_count',
      'Type how many capsules went into the stock. Nothing is planned until then.'
    )
  if (
    form === 'capsule' &&
    rowStock !== null &&
    rowStock > params.capsule_neat_max_ug_ml
  )
    warn(
      'capsule_over_neat',
      `The capsule stock is ${rowStock.toFixed(2)} ug/mL. It is injected neat, so it must be ` +
        `${g(params.capsule_neat_max_ug_ml)} ug/mL or lower: add water.`
    )
  if (isBlend && splitMismatch(comps, declared))
    warn(
      'split_mismatch',
      "The components' weights do not add up to the declared weight. Check the split."
    )
  return out
}

// ---------------------------------------------------------------- mergeHplcPrep

type Plain = Record<string, unknown>

const isPlain = (x: unknown): x is Plain =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

function mergeObject(stored: Plain, patch: Plain): Plain {
  const out: Plain = {}
  for (const key of new Set([...Object.keys(stored), ...Object.keys(patch)])) {
    // sent = present and not undefined (JSON.stringify drops undefined, so the
    // server never sees it); only an explicit null removes
    const sent = Object.hasOwn(patch, key) && patch[key] !== undefined
    const value = sent ? patch[key] : stored[key]
    if (value === null || value === undefined) continue
    if (sent && isPlain(value)) {
      const base = stored[key]
      const merged = mergeObject(isPlain(base) ? base : {}, value)
      if (Object.keys(merged).length > 0) out[key] = merged
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * The PATCH route's merge, so an optimistic update shows what the server
 * will store: a key sent replaces, a key sent as null is removed, a key not
 * sent stays; nested objects merge the same way, and an object left empty is
 * removed. Returns a new object ({} when nothing is left); never mutates.
 */
export function mergeHplcPrep(
  stored: HplcPrepInputs | null | undefined,
  patch: HplcPrepInputs
): HplcPrepInputs {
  return mergeObject(
    isPlain(stored) ? stored : {},
    patch as Plain
  ) as HplcPrepInputs
}
