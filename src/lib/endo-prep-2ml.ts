/**
 * Endotoxin (LAL) 2 mL prep: the bench steps, the cartridge check, the result
 * scaled to the vial, the verdict and the value for Accu-Mk1.
 *
 * Ported from tools-dennis/tools/endotoxin-log/calc.js at 5ef2a62 (the "2 mL
 * prep" block, Dennis 2026-10-08 to 2026-10-09). The arithmetic, its order and
 * its rounding are his. What differs, all required by
 * docs/superpowers/specs/2026-10-10-endo-worksheet-v2-design.md:
 * - A cartridge is its sensitivity (lambda, EU/mL) from the consumables
 *   catalog. The caller resolves the row's lambda (spec 4.3, including bac
 *   water's 0.01) and passes the method's allowed lambdas for `needs`.
 * - The standard total dilution and the reconstitution water come from the
 *   method's run parameters (ctx.params), never module constants (spec 4.4).
 * - A row's method rule (slice 5) arrives resolved on `rule` (matching and
 *   the lock are endo-prep-rules.ts): per field, a typed value beats the
 *   rule, which beats the standard.
 * - A reading whose reader test failed spike recovery or CV is 'invalid'.
 * Pure: no DOM, no fetch, no storage. Stock worksheets keep endo-prep.ts.
 */
import { DEFAULT_DILUTION, fmt, isBacWater } from '@/lib/endo-prep'
import type { EndoPrepRule } from '@/lib/endo-prep-rules'

export type EndoForm = 'powder' | 'liquid' | 'bac'
export type EndoVerdict = 'pass' | 'fail' | 'inconclusive' | 'invalid' | null

export interface EndoRunParams {
  stdTotalDilution: number
  reconWaterMl: number
  spikeRecoveryMinPct: number
  spikeRecoveryMaxPct: number
  cvLimitPct: number
}

/** Dennis's values; a method's run_parameters.endotoxin overrides any of them. */
export const ENDO_RUN_PARAM_DEFAULTS: EndoRunParams = {
  stdTotalDilution: 250,
  reconWaterMl: 2,
  spikeRecoveryMinPct: 50,
  spikeRecoveryMaxPct: 200,
  cvLimitPct: 25,
}

/** A row's own step values; a null field means "the standard". */
export interface EndoStepOverride {
  sampleUl: number | null
  ratio?: number | null
}

/** The reader's record for one test, stored as worksheet_items.result_reader. */
export interface EndoReaderRecord {
  test_id: string
  /** The reading exactly as the reader exported it (Task 15 compares a typed reading to it). */
  result: string
  reader: string | null
  slot: number | null
  operator: string | null
  tested_at: string | null
  temp_start: number | null
  temp_end: number | null
  software: string | null
  cartridge_lot: string | null
  cartridge_expiry: string | null
  cartridge_range: string | null
  spike_level: number | null
  recovery: number | null
  rec_min: number | null
  rec_max: number | null
  sample_cv: number | null
  spike_cv: number | null
  cv_limit: number | null
  reader_pass: boolean | null
  valid: boolean
  why: string[]
  file_name: string
}

export interface EndoSample {
  sampleId: string
  identity: string
  sampleType: string | null
  weightMg: number | null
  form: EndoForm | null
  waterMl: number | null
  totalDilution: number | null
  steps:
    | [
        EndoStepOverride | null,
        EndoStepOverride | null,
        EndoStepOverride | null,
      ]
    | null
  /** The row's resolved cartridge sensitivity, EU/mL (spec 4.3). */
  lambda: number | null
  reading: string | null
  reader: EndoReaderRecord | null
  /** The method rule the row runs under (slice 5): its lock, else the live
   *  match; null or absent for none. Its total and step 1 ratio sit between
   *  the row's own values and the standard. */
  rule?: EndoPrepRule | null
}

export interface EndoCtx {
  params: EndoRunParams
  allowedLambdas: number[]
}

/**
 * 350 EU per vial, flat (Dennis 2026-10-08): USP <85> K = 5 EU/kg x 70 kg with
 * the whole vial as one dose. The worksheet's working limit, not the COA spec.
 */
export const LIMIT_EU_PER_VIAL = 350
/** Bac water: 0.25 EU/mL of the water itself, the USP limit for WFI. */
export const BW_LIMIT_EU_PER_ML = 0.25
/** Bac water goes into the cartridge 20x, as on stock runs (LAL SOP). */
export const BW_DILUTION = DEFAULT_DILUTION
/** Bac water runs on the 0.01 unless its row says otherwise (caller, 4.3). */
export const BW_LAMBDA = 0.01
/** Every step is made in a 1.5 mL tube. */
export const TUBE_UL = 1500

export const FORMS: [EndoForm, string][] = [
  ['powder', 'Lyophilized'],
  ['liquid', 'Liquid (reconstituted)'],
  ['bac', 'Bacteriostatic water'],
]

/** Step 1 is 1:10 in Tris as standard; step 3 is 1:2 in BG600, fixed. */
const STEP1_RATIO = 10
const STEP3_RATIO = 2

export interface EndoStepDef {
  sampleUl: number
  ratio?: number
  byRatio?: boolean
  derived?: boolean
  fixed?: boolean
  diluent: string
}

/**
 * The bench steps from the vial solution to the cartridge (Dennis
 * 2026-10-08). Step 1 is ratio-driven (Tris first, per the BT103 insert);
 * step 2's ratio is derived from the row's total; step 3 is fixed at 1:2 so
 * BG600 is half of what goes on the cartridge. The sample volumes are
 * suggestions; a row types its own when it needs to.
 */
export const DILUTION_STEPS: readonly [EndoStepDef, EndoStepDef, EndoStepDef] =
  [
    {
      sampleUl: 20,
      ratio: STEP1_RATIO,
      byRatio: true,
      diluent: '0.1 M Tris (BT103)',
    },
    { sampleUl: 20, derived: true, diluent: 'LAL reagent water' },
    {
      sampleUl: 125,
      ratio: STEP3_RATIO,
      fixed: true,
      diluent: 'beta-glucan blocker (BG600)',
    },
  ]

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6
const r9 = (x: number): number => Math.round(x * 1e9) / 1e9

/** A finite number, else null: a half-filled row renders blank, never NaN. */
function fin(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function lambdaOf(s: EndoSample): number | null {
  const l = fin(s.lambda)
  return l !== null && l > 0 ? l : null
}

/** Least sensitive first: `needs` is the first cartridge a prep is valid on. */
function leastSensitiveFirst(ctx: EndoCtx): number[] {
  return ctx.allowedLambdas
    .filter(l => Number.isFinite(l) && l > 0)
    .sort((a, b) => b - a)
}

/* ---------------- form and water ---------------- */

/** Spec 4.2's one shared rule: BW- id, or the sample type or identity says so. */
export function isBacWaterSample(
  s: Pick<EndoSample, 'sampleId' | 'identity' | 'sampleType'>
): boolean {
  return isBacWater(s.sampleId, s.sampleType, s.identity)
}

/** A form set on the row wins; without one, bac water reads as bac. */
export function formOf(s: EndoSample): EndoForm {
  if (s.form === 'powder' || s.form === 'liquid' || s.form === 'bac')
    return s.form
  return isBacWaterSample(s) ? 'bac' : 'powder'
}

/**
 * The water in the vial: the row's own volume when > 0, else the method's
 * reconstitution water (2 mL). A liquid vial uses the customer's water as
 * typed and has none until it is typed. null for bac water.
 */
export function waterOf(s: EndoSample, ctx: EndoCtx): number | null {
  const form = formOf(s)
  if (form === 'bac') return null
  const own = fin(s.waterMl)
  if (own !== null && own > 0) return own
  // Powder only (Handler 2026-10-26): a liquid vial arrived reconstituted, so
  // its volume is what the customer sent, not a prep choice. Neither the
  // rule's water nor the standard may be put in one. Mirrors the server's
  // effective_values.
  if (form === 'liquid') return null
  return ruleWaterOf(s) ?? ctx.params.reconWaterMl
}

/* ---------------- limits ---------------- */

/** 350 / declared mg; null for bac water or without a (positive) weight. */
export function limitPerMg(s: EndoSample): number | null {
  if (formOf(s) === 'bac') return null
  const w = fin(s.weightMg)
  return w === null || w <= 0 ? null : LIMIT_EU_PER_VIAL / w
}

/** 350, flat, whatever the mass; null for bac water. */
export function limitPerVial(s: EndoSample): number | null {
  return formOf(s) === 'bac' ? null : LIMIT_EU_PER_VIAL
}

/**
 * Minimum valid concentration on the cartridge, lambda / (350 / mg), rounded
 * to 9 dp so 0.05 x 140 / 350 is exactly 0.02.
 */
export function mvcFor(lambda: number | null, s: EndoSample): number | null {
  if (lambda === null || !(lambda > 0)) return null
  const lpm = limitPerMg(s)
  return lpm === null ? null : r9(lambda / lpm)
}

/* ---------------- the bench steps ---------------- */

/** The rule's total when it sets one (> 0), else null. */
function ruleTotalOf(s: EndoSample): number | null {
  const r = fin(s.rule?.total_dilution)
  return r !== null && r > 0 ? r : null
}

/** The rule's reconstitution water when it sets one (> 0), else null. */
function ruleWaterOf(s: EndoSample): number | null {
  const r = fin(s.rule?.recon_water_ml)
  return r !== null && r > 0 ? r : null
}

/** The rule's step 1 ratio when it sets one (>= 1), else null. */
function ruleRatioOf(s: EndoSample): number | null {
  const r = fin(s.rule?.step1_ratio)
  return r !== null && r >= 1 ? r : null
}

function totalOf(s: EndoSample, ctx: EndoCtx): number {
  const own = fin(s.totalDilution)
  if (own !== null && own > 0) return own
  return ruleTotalOf(s) ?? ctx.params.stdTotalDilution
}

/** The row's desired total: its own when > 0, else its rule's, else the
 *  method's. Bac: null. */
export function targetDilutionOf(s: EndoSample, ctx: EndoCtx): number | null {
  return formOf(s) === 'bac' ? null : totalOf(s, ctx)
}

/** (sample + diluent) / sample; null without a sample volume or diluent. */
export function stepFactor(st: {
  sampleUl: number | null
  diluentUl: number | null
}): number | null {
  const { sampleUl, diluentUl } = st
  return sampleUl !== null &&
    sampleUl > 0 &&
    diluentUl !== null &&
    Number.isFinite(diluentUl) &&
    diluentUl >= 0
    ? (sampleUl + diluentUl) / sampleUl
    : null
}

/** A standard step as volumes at the method's total: 20 + 180, 20 + 230, 125 + 125. */
export function stdStep(
  st: EndoStepDef,
  params: EndoRunParams
): { sampleUl: number; diluentUl: number; ratio: number } {
  const r = st.derived
    ? params.stdTotalDilution / (STEP1_RATIO * STEP3_RATIO)
    : (st.ratio ?? 1)
  return { sampleUl: st.sampleUl, diluentUl: st.sampleUl * (r - 1), ratio: r }
}

export interface EndoStepPlan {
  index: 0 | 1 | 2
  sampleUl: number | null
  ratio: number | null
  diluentUl: number | null
  totalUl: number | null
  running: number | null
  own: boolean
  /** The ratio came from the row's rule (step 1 its ratio; step 2 derived
   *  from a ruled total or a ruled step 1), not typed and not the standard. */
  ruled: boolean
  fits: boolean
  diluent: string
}

/**
 * The row's three steps with its own values applied and step 2's ratio derived
 * from the total. A ratio below 1:1 gives no diluent (no such step); `running`
 * is the dilution so far, null for a step that cannot be made. [] for bac
 * water, whose prep is one straight 20x (calcEndoPrep in endo-prep.ts).
 */
export function stepsOf(s: EndoSample, ctx: EndoCtx): EndoStepPlan[] {
  if (formOf(s) === 'bac') return []
  const own = s.steps ?? [null, null, null]
  const target = totalOf(s, ctx)
  const typedR1 = fin(own[0]?.ratio)
  // The rule's ratio is this row's standard (Dennis's r1Std): typing it is
  // not a value set by hand.
  const ruleR1 = ruleRatioOf(s)
  const r1Std = ruleR1 ?? STEP1_RATIO
  const r1 = typedR1 ?? r1Std
  const step1Ruled = ruleR1 !== null && (typedR1 === null || typedR1 === r1Std)
  const ownTotal = fin(s.totalDilution)
  const totalRuled =
    !(ownTotal !== null && ownTotal > 0) && ruleTotalOf(s) !== null
  const out: EndoStepPlan[] = []
  let running = 1
  DILUTION_STEPS.forEach((def, i) => {
    const sampleUl = fin(own[i]?.sampleUl) ?? def.sampleUl
    const ratio = def.byRatio
      ? r1
      : def.derived
        ? r6(target / (r1 * STEP3_RATIO))
        : STEP3_RATIO
    const diluentUl = ratio >= 1 ? r6(sampleUl * (ratio - 1)) : null
    const totalUl =
      diluentUl !== null && Number.isFinite(diluentUl)
        ? sampleUl + diluentUl
        : null
    const factor = stepFactor({ sampleUl, diluentUl })
    if (factor !== null) running = r6(running * factor)
    out.push({
      index: i as 0 | 1 | 2,
      sampleUl,
      ratio,
      diluentUl,
      totalUl,
      running: factor === null ? null : running,
      own:
        sampleUl !== def.sampleUl ||
        (!!def.byRatio && typedR1 !== null && typedR1 !== r1Std),
      ruled: def.byRatio
        ? step1Ruled
        : !!def.derived && (totalRuled || step1Ruled),
      fits: totalUl !== null && totalUl <= TUBE_UL,
      diluent: def.diluent,
    })
  })
  return out
}

/**
 * The factor from the vial solution to the cartridge: the product of the
 * steps, equal to the desired total whenever every step can be made. null for
 * bac water, or when a step has no sample volume or a ratio below 1:1.
 */
export function vialDilutionOf(s: EndoSample, ctx: EndoCtx): number | null {
  if (formOf(s) === 'bac') return null
  let f = 1
  for (const st of stepsOf(s, ctx)) {
    const k = stepFactor(st)
    if (k === null) return null
    f *= k
  }
  return r6(f)
}

/**
 * target: the desired total; total: what the steps make (null when they
 * cannot); fits: every step fits its tube; standard: the method's total and
 * no step set by hand or by a rule. Bac water: no steps, its 20x as target
 * and total.
 */
export function dilutionPlan(
  s: EndoSample,
  ctx: EndoCtx
): {
  steps: EndoStepPlan[]
  target: number
  total: number | null
  fits: boolean
  standard: boolean
} {
  if (formOf(s) === 'bac')
    return {
      steps: [],
      target: BW_DILUTION,
      total: BW_DILUTION,
      fits: true,
      standard: true,
    }
  const steps = stepsOf(s, ctx)
  const target = totalOf(s, ctx)
  return {
    steps,
    target,
    total: vialDilutionOf(s, ctx),
    fits: steps.every(st => st.fits),
    standard:
      target === ctx.params.stdTotalDilution &&
      steps.every(st => !st.own && !st.ruled),
  }
}

/* ---------------- the cartridge check ---------------- */

export interface EndoCheck {
  lambda: number | null
  water: number | null
  dilution: number | null
  loaded: number | null
  mvd: number | null
  mvc: number | null
  valid: boolean | null
  needs: number | null
  floorShown: number | null
  floorVial: number | null
  failAt: number | null
  lod: number | null
  loqVial: number | null
  loqMl: number | null
}

/**
 * loaded mg / water / N on the cartridge; mvd (350 / water) / lambda; mvc;
 * valid loaded >= mvc; needs the least sensitive allowed cartridge it is valid
 * on; floorShown lambda (the MCS factor is 1, so the reading is per mL of the
 * step 3 tube); floorVial and loqVial lambda x N x water; failAt the displayed
 * reading that equals 350 per vial; lod lambda. Bac water: its 20x, floor and
 * loqMl lambda x 20 (EU/mL of the water), failAt 0.25, valid when that floor
 * is under 0.25.
 */
export function prep2Check(s: EndoSample, ctx: EndoCtx): EndoCheck {
  const lambda = lambdaOf(s)
  const bac = formOf(s) === 'bac'
  const none: EndoCheck = {
    lambda,
    water: null,
    dilution: bac ? BW_DILUTION : null,
    loaded: null,
    mvd: null,
    mvc: null,
    valid: null,
    needs: null,
    floorShown: null,
    floorVial: null,
    failAt: null,
    lod: null,
    loqVial: null,
    loqMl: null,
  }
  if (bac) {
    const floorOn = (l: number): number => r6(l * BW_DILUTION)
    const needs =
      leastSensitiveFirst(ctx).find(l => floorOn(l) <= BW_LIMIT_EU_PER_ML) ??
      null
    if (lambda === null) return { ...none, needs, failAt: BW_LIMIT_EU_PER_ML }
    return {
      ...none,
      needs,
      failAt: BW_LIMIT_EU_PER_ML,
      valid: floorOn(lambda) <= BW_LIMIT_EU_PER_ML,
      floorShown: floorOn(lambda),
      lod: lambda,
      loqMl: floorOn(lambda),
    }
  }
  const n = vialDilutionOf(s, ctx)
  const ml = waterOf(s, ctx)
  if (n === null) return { ...none, water: ml } // the steps cannot be made as typed
  if (ml === null) return { ...none, dilution: n } // a liquid with no volume yet
  const w = fin(s.weightMg)
  const loaded = w === null ? null : r9(w / ml / n)
  const judgeable = loaded !== null && limitPerMg(s) !== null
  const validOn = (l: number): boolean => {
    const m = mvcFor(l, s)
    return m !== null && loaded !== null && loaded >= m
  }
  const needs = judgeable
    ? (leastSensitiveFirst(ctx).find(validOn) ?? null)
    : null
  const out: EndoCheck = {
    ...none,
    water: ml,
    dilution: n,
    loaded,
    needs,
    failAt: r6(LIMIT_EU_PER_VIAL / (ml * n)),
  }
  if (lambda === null) return out
  return {
    ...out,
    mvd: r6(LIMIT_EU_PER_VIAL / ml / lambda),
    mvc: mvcFor(lambda, s),
    valid: judgeable ? validOn(lambda) : null,
    floorShown: lambda,
    floorVial: r6(lambda * n * ml),
    lod: lambda,
    loqVial: r6(lambda * n * ml),
  }
}

/* ---------------- results ---------------- */

/**
 * The reading as the instrument shows it: "0.8", "0", "<0.05" ("< 0.05" and
 * padding are fine). null for blank or anything else, including "<0", which
 * says nothing (spec 3.7), and for more than 40 characters once trimmed (the
 * column's width, as on the server). The "<" is carried through every derived
 * value.
 */
export function parseReading(
  text: string | null
): { lt: boolean; value: number } | null {
  const t = (text ?? '').trim()
  if (t.length > 40) return null // result_reading is varchar(40); the server's parse_reading refuses longer
  const m = /^(<)?(\d*\.?\d+)$/.exec(t.replace(/\s+/g, ''))
  if (!m) return null
  const lt = m[1] === '<'
  const value = Number(m[2])
  return lt && value <= 0 ? null : { lt, value }
}

function judgeResult(lt: boolean, euPerVial: number): EndoVerdict {
  if (euPerVial <= LIMIT_EU_PER_VIAL) return 'pass'
  return lt ? 'inconclusive' : 'fail'
}

/** Bac water: the reading itself against 0.25 EU/mL. */
export function judgeWater(lt: boolean, euPerMl: number): EndoVerdict {
  if (euPerMl <= BW_LIMIT_EU_PER_ML) return 'pass'
  return lt ? 'inconclusive' : 'fail'
}

export interface EndoResult {
  lt: boolean | null
  value: number | null
  euPerMlVial: number | null
  euPerVial: number | null
  euPerMg: number | null
  limitPerVial: number | null
  limitPerMl: number | null
  verdict: EndoVerdict
  expectedFloor: number | null
  floorMismatch: boolean
}

function prep2ResultRaw(s: EndoSample, ctx: EndoCtx): EndoResult {
  const p = parseReading(s.reading)
  const bac = formOf(s) === 'bac'
  const none: EndoResult = {
    lt: false,
    value: null,
    euPerMlVial: null,
    euPerVial: null,
    euPerMg: null,
    limitPerVial: limitPerVial(s),
    limitPerMl: bac ? BW_LIMIT_EU_PER_ML : null,
    verdict: null,
    expectedFloor: null,
    floorMismatch: false,
  }
  if (!p) return none
  const k = prep2Check(s, ctx)
  const out: EndoResult = {
    ...none,
    lt: p.lt,
    value: p.value,
    expectedFloor: k.floorShown,
  }
  if (p.lt && k.floorShown !== null && Math.abs(p.value - k.floorShown) > 1e-9)
    out.floorMismatch = true
  if (bac) {
    // the reading is EU/mL of the bac water (the instrument applies the 20x)
    out.verdict = judgeWater(p.lt, p.value)
    return out
  }
  if (k.dilution === null || k.water === null) return out // nothing to scale by
  const euPerMlVial = r9(p.value * k.dilution)
  const euPerVial = r9(euPerMlVial * k.water)
  const w = fin(s.weightMg)
  return {
    ...out,
    euPerMlVial,
    euPerVial,
    euPerMg: w ? euPerVial / w : null,
    verdict: judgeResult(p.lt, euPerVial),
  }
}

/**
 * The reading scaled to the vial: x the row's total = EU/mL of the vial, x the
 * water = EU per vial, / mg = EU/mg; the verdict on EU per vial. A reading
 * whose reader test failed spike recovery or CV is 'invalid' whatever its
 * number (USP <85>); the numbers still show.
 */
export function prep2Result(s: EndoSample, ctx: EndoCtx): EndoResult {
  const out = prep2ResultRaw(s, ctx)
  if (s.reader && !s.reader.valid && out.value !== null) out.verdict = 'invalid'
  return out
}

/** "<2.5" style: the "<" kept, 3 decimals. */
export function fmtEu(lt: boolean, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return ''
  return (lt ? '<' : '') + fmt(v)
}

/** Concentrations on the cartridge: two significant figures below 0.01. */
export function fmtConc(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return ''
  return v >= 0.01 ? fmt(v) : String(Number(v.toPrecision(2)))
}

/**
 * The value for Accu-Mk1 (Dennis 2026-10-09): EU per vial for peptides, the
 * reading itself in EU/mL for bac water, the "<" kept. null until there is a
 * number, and for an invalid test (rerun, never reported).
 */
export function mk1Value(
  s: EndoSample,
  ctx: EndoCtx
): { value: string; unit: 'EU/vial' | 'EU/mL'; verdict: EndoVerdict } | null {
  const rs = prep2Result(s, ctx)
  if (rs.verdict === 'invalid') return null
  const lt = rs.lt === true
  if (formOf(s) === 'bac')
    return rs.value === null
      ? null
      : { value: fmtEu(lt, rs.value), unit: 'EU/mL', verdict: rs.verdict }
  return rs.euPerVial === null
    ? null
    : { value: fmtEu(lt, rs.euPerVial), unit: 'EU/vial', verdict: rs.verdict }
}

/* ---------------- order ---------------- */

/**
 * The total a row is grouped and ordered under (Box 2 and the 2 mL bench
 * sheet): its target as shown (fmt) when the steps can make it, else null;
 * null for bac water. The target, not the product of the steps: r6 on step
 * 2's ratio leaves the product a hair off (1:15 at 1:250 makes 249.99999,
 * 1:999 at 1:3000 makes 3000.000996), which must neither split a group nor
 * reorder the rows inside it.
 */
export function groupTotalOf(s: EndoSample, ctx: EndoCtx): number | null {
  if (formOf(s) === 'bac' || vialDilutionOf(s, ctx) === null) return null
  return Number(fmt(totalOf(s, ctx)))
}

/**
 * Box 2 and the 2 mL bench sheet order (Dennis 2026-10-09): grouped by total,
 * ascending; ties keep the order given (bench order); a total the steps
 * cannot make after the numbers; bac water last.
 */
export function orderByTotal<T>(
  rows: T[],
  sampleOf: (r: T) => EndoSample,
  ctx: EndoCtx
): T[] {
  return rows
    .map((r, i) => {
      const s = sampleOf(r)
      const total = groupTotalOf(s, ctx)
      const group = formOf(s) === 'bac' ? 2 : total === null ? 1 : 0
      return { r, i, group, total: total ?? 0 }
    })
    .sort((a, b) => a.group - b.group || a.total - b.total || a.i - b.i)
    .map(x => x.r)
}
