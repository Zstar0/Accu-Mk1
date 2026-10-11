/**
 * Glue between a worksheet as GET /worksheets/{id} serves it and the 2 mL
 * maths (src/lib/endo-prep-2ml.ts), resolved as spec 2026-10-10 sections 4.2
 * to 4.4 say: the run parameters, the allowed cartridges and each row's
 * sample with its cartridge. Pure, so the page, its three boxes and the paper
 * resolve the same cartridge and the same numbers.
 */
import type {
  ConsumableType,
  EndoMethodInfo,
  EndoRunParamsWire,
  WorksheetListItem,
} from '@/lib/api'
import { CARTRIDGE_UL, fmt } from '@/lib/endo-prep'
import {
  BW_DILUTION,
  BW_LAMBDA,
  BW_LIMIT_EU_PER_ML,
  ENDO_RUN_PARAM_DEFAULTS,
  dilutionPlan,
  fmtConc,
  formOf,
  groupTotalOf,
  type EndoCheck,
  type EndoCtx,
  type EndoRunParams,
  type EndoSample,
  type EndoStepOverride,
  type EndoStepPlan,
} from '@/lib/endo-prep-2ml'
import { endoIdentityFor, type WorksheetItemRow } from '@/lib/endo-worksheet'

export type { WorksheetItemRow }
/** The contract's name for a worksheet as the API serves it. */
export type WorksheetRow = WorksheetListItem

/** A cartridge the run may use. */
export interface EndoCartridgeOption {
  id: number
  name: string
  sensitivity_eu_ml: number
  is_default: boolean
}

/** A resolved cartridge: its type and its sensitivity (lambda, EU/mL). */
export interface EndoCartridgeRef {
  id: number
  sensitivity: number
}

/** One endo row on the page, in Box 1 order. */
export interface EndoRow {
  item: WorksheetItemRow
  /** The Box 1 row number, 1-based. */
  n: number
  /** The row as the maths reads it; `sample.lambda` is `cartridge`'s. */
  sample: EndoSample
  /** The row's cartridge: its own pick, else `inherited`. Its id goes with
   *  every reading saved on the row (spec 9). */
  cartridge: EndoCartridgeRef | null
  /** What the row gets without a pick of its own: bac water's 0.01, else
   *  the run cartridge. */
  inherited: EndoCartridgeRef | null
}

const sameLambda = (a: number, b: number) => Math.abs(a - b) < 1e-9

/** The method's endotoxin run parameters, each falling back to Dennis's (4.4). */
export function runParamsFrom(method: EndoMethodInfo | null): EndoRunParams {
  const p: Partial<EndoRunParamsWire> = method?.run_parameters?.endotoxin ?? {}
  const d = ENDO_RUN_PARAM_DEFAULTS
  return {
    stdTotalDilution: p.std_total_dilution ?? d.stdTotalDilution,
    reconWaterMl: p.recon_water_ml ?? d.reconWaterMl,
    spikeRecoveryMinPct: p.spike_recovery_min_pct ?? d.spikeRecoveryMinPct,
    spikeRecoveryMaxPct: p.spike_recovery_max_pct ?? d.spikeRecoveryMaxPct,
    cvLimitPct: p.cv_limit_pct ?? d.cvLimitPct,
  }
}

/**
 * The allowed cartridges (4.3), least sensitive first: the method's active
 * ones; with no method, or a method that links none (lead decision
 * 2026-10-10, as the server's cartridge_ids_allowed_by), every active endo
 * cartridge in `catalog`, with no default. Retired
 * types never appear here; a run or row that used one still resolves it from
 * its serialized sensitivity.
 */
export function allowedCartridges(
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoCartridgeOption[] {
  const linked = ws.endo_method?.cartridges ?? []
  const list: EndoCartridgeOption[] = linked.length
    ? linked
        .filter(c => c.active)
        .map(c => ({
          id: c.id,
          name: c.name,
          sensitivity_eu_ml: c.sensitivity_eu_ml,
          is_default: c.is_default,
        }))
    : catalog
        .filter(c => c.kind === 'endo_cartridge' && c.active)
        .map(c => ({
          id: c.id,
          name: c.name,
          sensitivity_eu_ml: Number(c.specs.sensitivity_eu_ml),
          is_default: false,
        }))
  return list
    .filter(
      c => Number.isFinite(c.sensitivity_eu_ml) && c.sensitivity_eu_ml > 0
    )
    .sort((a, b) => b.sensitivity_eu_ml - a.sensitivity_eu_ml)
}

/** The maths' context for this worksheet (contract name). */
export function endoCtxFor(
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoCtx {
  return {
    params: runParamsFrom(ws.endo_method ?? null),
    allowedLambdas: allowedCartridges(ws, catalog).map(
      c => c.sensitivity_eu_ml
    ),
  }
}

/** A cartridge id as a reference: the allowed list's sensitivity, else the
 *  serialized one (a retired type, or one outside the list). */
function refFor(
  id: number,
  serialized: number | null | undefined,
  allowed: EndoCartridgeOption[]
): EndoCartridgeRef | null {
  const sensitivity =
    allowed.find(c => c.id === id)?.sensitivity_eu_ml ?? serialized ?? null
  return sensitivity == null ? null : { id, sensitivity }
}

/** The run cartridge (4.3): the worksheet's pick, else the method default, else none. */
export function runCartridgeFor(
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoCartridgeRef | null {
  const allowed = allowedCartridges(ws, catalog)
  if (ws.cartridge_type_id != null)
    return refFor(ws.cartridge_type_id, ws.cartridge_sensitivity_eu_ml, allowed)
  const fallback = allowed.find(c => c.is_default)
  return fallback
    ? { id: fallback.id, sensitivity: fallback.sensitivity_eu_ml }
    : null
}

/** Stored steps ([[ul, ratio] | null, [ul] | null, [ul] | null]) as the maths' overrides. */
function stepsFrom(wire: WorksheetItemRow['prep_steps']): EndoSample['steps'] {
  if (!wire || wire.length !== 3) return null
  const step = (
    s: (number | null)[] | null | undefined,
    withRatio: boolean
  ): EndoStepOverride | null =>
    s
      ? withRatio
        ? { sampleUl: s[0] ?? null, ratio: s[1] ?? null }
        : { sampleUl: s[0] ?? null }
      : null
  return [step(wire[0], true), step(wire[1], false), step(wire[2], false)]
}

function resolveRow(
  item: WorksheetItemRow,
  ws: WorksheetRow,
  catalog: ConsumableType[]
): Pick<EndoRow, 'sample' | 'cartridge' | 'inherited'> {
  const allowed = allowedCartridges(ws, catalog)
  const base: EndoSample = {
    sampleId: item.sample_id,
    identity: endoIdentityFor(item),
    sampleType: item.sample_type ?? null,
    weightMg: item.prep_weight_mg ?? item.declared_weight_mg ?? null,
    form: item.prep_form ?? null,
    waterMl: item.prep_water_ml ?? null,
    totalDilution: item.prep_total_dilution ?? null,
    steps: stepsFrom(item.prep_steps),
    lambda: null,
    reading: item.result_reading ?? null,
    reader: item.result_reader ?? null,
  }
  // Bac water runs on the allowed 0.01 unless its row says otherwise
  // (Dennis, 2026-10-09; spec 4.3).
  const bacType =
    formOf(base) === 'bac'
      ? allowed.find(c => sameLambda(c.sensitivity_eu_ml, BW_LAMBDA))
      : undefined
  const inherited = bacType
    ? { id: bacType.id, sensitivity: bacType.sensitivity_eu_ml }
    : runCartridgeFor(ws, catalog)
  const cartridge =
    item.cartridge_type_id != null
      ? refFor(
          item.cartridge_type_id,
          item.cartridge_sensitivity_eu_ml,
          allowed
        )
      : inherited
  return {
    sample: { ...base, lambda: cartridge?.sensitivity ?? null },
    cartridge,
    inherited,
  }
}

/** The row as the 2 mL maths reads it (4.2, 4.3). `catalog` is the allowed
 *  list's source when no method resolves. */
export function endoSampleFor(
  item: WorksheetItemRow,
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoSample {
  return resolveRow(item, ws, catalog).sample
}

/** The page's rows, numbered in the order given (Box 1's bench order). */
export function endoRowsFor(
  ordered: WorksheetItemRow[],
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoRow[] {
  return ordered.map((item, i) => ({
    item,
    n: i + 1,
    ...resolveRow(item, ws, catalog),
  }))
}

/** Dennis's fmtConc lives with the maths (Task 8); re-exported here so the
 *  page imports every worksheet helper from one place. */
export { fmtConc }

/** The line under Box 1's cartridge when the prep cannot read the limit
 *  (Dennis's cartridgeVerdict2): amber when another cartridge would do,
 *  red when none would. */
export function cartridgeNote(
  k: EndoCheck,
  bac: boolean
): { text: string; tone: 'warn' | 'crit' } | null {
  if (k.lambda == null || k.valid !== false) return null
  const why = bac
    ? `floor ${fmt(k.floorShown)} > ${fmt(BW_LIMIT_EU_PER_ML)} limit`
    : `${fmtConc(k.loaded)} mg/mL loaded < MVC ${fmtConc(k.mvc)}`
  if (k.needs != null)
    return { text: `${why} · needs ${fmt(k.needs)}`, tone: 'warn' }
  return { text: bac ? why : `${why} · no valid cartridge`, tone: 'crit' }
}

/** The cartridge cell's worked line on hover (Dennis's cartridgeTitle2). */
export function cartridgeTitle(k: EndoCheck, bac: boolean): string {
  if (bac) {
    const floor =
      k.floorShown != null
        ? ` · a clean run reads < ${fmt(k.floorShown)} (λ ${fmt(k.lod)} × ${fmt(k.dilution)})`
        : ''
    return `Bac water: ${fmt(k.dilution)}× into the cartridge · limit ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL${floor}`
  }
  if (k.water == null) return ''
  if (k.dilution == null)
    return `${fmt(k.water)} mL in the vial · the dilution steps cannot be made as typed (see Sample dilution)`
  const parts = [
    `${fmt(k.water)} mL in the vial · 1:${fmt(k.dilution)} into the cartridge${
      k.mvd != null ? ` of 1:${fmt(k.mvd)} allowed` : ''
    }`,
  ]
  if (k.loaded != null) parts.push(`loaded ${fmtConc(k.loaded)} mg/mL`)
  if (k.floorShown != null)
    parts.push(
      `a clean run reads < ${fmt(k.floorShown)} on the MCS (< ${fmt(k.floorVial)} EU/vial)`
    )
  if (k.failAt != null) parts.push(`a reading above ${fmt(k.failAt)} fails`)
  return parts.join(' · ')
}

/** Bac water's single step: 50 uL made to 1000 uL with LAL water (its 20x). */
export const BW_SAMPLE_UL = CARTRIDGE_UL / BW_DILUTION
export const BW_LAL_UL = CARTRIDGE_UL - BW_SAMPLE_UL

const STANDARD_SAMPLE: EndoSample = {
  sampleId: '',
  identity: '',
  sampleType: null,
  weightMg: null,
  form: 'powder',
  waterMl: null,
  totalDilution: null,
  steps: null,
  lambda: null,
  reading: null,
  reader: null,
}

/**
 * The method's standard steps (20 + 180, 20 + 230, 125 + 125 at 1:250 with
 * Dennis's values). A row's steps are compared with these to show a value
 * set by hand on screen and to box a non-standard step on paper.
 */
export function standardSteps(ctx: EndoCtx): EndoStepPlan[] {
  return dilutionPlan(STANDARD_SAMPLE, ctx).steps
}

/**
 * The total a row is grouped under, on the key orderByTotal sorts by
 * (groupTotalOf): the target as shown, 'x' for a total the steps cannot
 * make, 'bac' for bac water. Box 2 and the 2 mL bench sheet draw a rule
 * where this changes.
 */
export function totalGroupKey(s: EndoSample, ctx: EndoCtx): string {
  if (formOf(s) === 'bac') return 'bac'
  const total = groupTotalOf(s, ctx)
  return total === null ? 'x' : fmt(total)
}
