/**
 * Why an HPLC worksheet row cannot be promoted yet: the browser's copy of
 * promote_reasons in backend/worksheets_hplc_promote.py, ported line for
 * line, same sentences, same order, so the Promote button can say why it is
 * off before anyone presses it. The server stays the authority: it also
 * refuses a completed worksheet, a single peptide that is a catalog blend,
 * and a curve whose diluent density differs from the sheet's, and its 409
 * reasons are shown as returned. backend/tests/fixtures/
 * hplc_promote_reason_cases.json pins both sides. Pure.
 */
import type { HplcSheetRow } from '@/lib/api'
import {
  vialLetter,
  type HplcRowComputed,
  type HplcVialComputed,
} from '@/lib/hplc-prep'

// Process HPLC's own figures (backend/calculations/hplc_processor.py), not the
// method's: the check below is that the method's agree with them.
const MAX_CAPSULES = 1000
const BAC_STOCK_UG_ML = 9000
const BENZYL_ALCOHOL_DENSITY = 1034.72

export const REASON_COMPLETED =
  'the worksheet is completed; a completed worksheet promotes nothing'
const REASON_RIDER =
  'this vial rides the run with another sample; it has no prep of its own'
const REASON_NO_FORM = 'this form has no HPLC prep in Mk1'
const REASON_NO_INSTRUMENT =
  "pick the instrument first: a curve is checked against the run's instrument, " +
  'and a prep without one cannot be checked'
const REASON_DECLARED =
  'type the declared weight: the stock concentration is worked out from it'
const REASON_DECLARED_BLEND =
  "type the blend's declared total weight: the prep records it as the sample's declared " +
  'weight, and the split is checked against it'
const REASON_DECLARED_ZERO = 'the declared weight must be more than 0 mg'
const REASON_CAPSULE_COUNT = 'type how many capsules went into the stock'
const REASON_LIQUID_VOLUME =
  "type the declared volume: a liquid's stock volume is the volume the customer declared"
const REASON_STOCK_PAIR =
  'weigh the stock vial: Step 2 needs both of its weighings'
const REASON_STOCK_BACKWARDS =
  'Step 2: the vial and septum + diluent is not more than the empty vial; ' +
  'check the two weights'
const REASON_SOLO_BLEND =
  "the sample names a catalog blend as one peptide; record the blend's components " +
  'on the sample so each one is quantified on its own curve'
const REASON_CAPSULE_BLEND =
  'A blend in capsules cannot be promoted from the sheet yet: its component concentrations ' +
  'are being corrected in the working-out. Prep this one in the wizard.'
const FORM_PROBLEM = 'no HPLC prep for this sample form'
const FLAGGED = {
  diluent: 'the vial + diluent weight is less than the empty vial',
  stock:
    'the last weight (vial, diluent + stock) is not more than the vial + diluent ' +
    'weight, so no stock went in',
} as const
type Names = readonly (readonly [string, string])[]
const FINAL: Names = [
  ['vial_mg', 'the empty vial'],
  ['vial_diluent_mg', 'the vial + diluent'],
  ['vial_all_mg', 'the vial with diluent + stock'],
]
const INTERMEDIATE: Names = [
  ['int_vial_mg', 'the empty intermediate vial'],
  ['int_vial_diluent_mg', 'the intermediate vial + diluent'],
  ['int_vial_all_mg', 'the intermediate vial with diluent + stock'],
]

const and = (words: string[]) =>
  words.length === 1
    ? (words[0] as string)
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`

const missing = (
  weighed: Record<string, unknown>,
  names: Names,
  skip: readonly string[]
) =>
  names
    .filter(([key]) => !skip.includes(key) && weighed[key] == null)
    .map(([, label]) => label)

// The server's num(): the shortest text that reads back as the same number,
// an integer without ".0". JavaScript's String(x) prints the same from 1e-4
// up to 1e16.
const g = (x: number) => String(x)

// The server's two_places(): the float's exact value at two decimals, a tie
// rounded up, which is toFixed(2).
const two = (x: number) => x.toFixed(2)

// _above: strictly above, past float noise, and by enough to print differently
const above = (target: number | null, source: number | null) =>
  target != null &&
  source != null &&
  target > source * (1 + 1e-9) &&
  two(target) !== two(source)

/** _above_the_stock: a target above what its step dilutes from. A capsule is
 *  injected neat, so it is never a reason. */
function aboveTheStock(v: HplcVialComputed): string[] {
  if (v.neat) return []
  const out: string[] = []
  const letter = vialLetter(v.vial)
  const inter = v.two_step ? v.intermediate : null
  if (inter && above(inter.target_ug_ml, v.stock_conc_ug_ml))
    out.push(
      `Vial ${letter}, Step 3a: the intermediate target, ${two(inter.target_ug_ml as number)} ug/mL, ` +
        `is above the stock it is diluted from, ${two(v.stock_conc_ug_ml as number)} ug/mL; lower it ` +
        'or check Step 2'
    )
  if (above(v.target.value, v.stock_for_final)) {
    const target = two(v.target.value)
    const source = two(v.stock_for_final as number)
    out.push(
      inter
        ? `Vial ${letter}, Step 3: the target, ${target} ug/mL, is above the intermediate it is ` +
            `diluted from, ${source} ug/mL; lower the target or check Step 3a`
        : `Vial ${letter}: the target, ${target} ug/mL, is above the stock it is diluted from, ` +
            `${source} ug/mL; lower the target or check Step 2`
    )
  }
  return out
}

/**
 * Every reason the row cannot be promoted, all at once, in the order the
 * sheet is worked (empty: it can be). `computed` is computeRow's answer, or
 * null when the row cannot be computed. The floor and the other note
 * warnings are never a reason. `peptide_is_blend` is read when present, as
 * the server's is; the sheet does not serve it.
 */
export function promoteReasons(
  row: HplcSheetRow & { peptide_is_blend?: boolean },
  computed: HplcRowComputed | null,
  blendCap: number
): string[] {
  if (row.rider_only) return [REASON_RIDER]
  const reasons = row.form === null ? [REASON_NO_FORM] : []
  reasons.push(...row.problems.filter(p => p !== FORM_PROBLEM))
  if (row.peptide_is_blend && !row.is_blend) reasons.push(REASON_SOLO_BLEND)
  const n = row.components.length
  if (n > blendCap)
    reasons.push(
      `this blend has ${n} components and the cap is ${blendCap}; ` +
        'a partial blend is never filed'
    )
  if (row.form === 'capsule' && row.is_blend) reasons.push(REASON_CAPSULE_BLEND)
  if (row.instrument_id == null) reasons.push(REASON_NO_INSTRUMENT)
  if (computed === null) return reasons

  const inputs = row.hplc_prep ?? {}
  const form = computed.form
  const declared = inputs.declared_mg ?? row.declared_mg
  if (form !== 'bac' && declared == null)
    reasons.push(row.is_blend ? REASON_DECLARED_BLEND : REASON_DECLARED)
  if (form === 'capsule') {
    const count = inputs.capsules
    if (count == null) reasons.push(REASON_CAPSULE_COUNT)
    else if (count > MAX_CAPSULES)
      reasons.push(
        `a stock of ${g(count)} capsules is more than Process HPLC takes ` +
          `(${g(MAX_CAPSULES)}); check the count`
      )
  }
  const p = row.params
  if (
    form === 'bac' &&
    (p.bac_stock_ug_ml !== BAC_STOCK_UG_ML ||
      p.benzyl_alcohol_density_mg_ml !== BENZYL_ALCOHOL_DENSITY)
  )
    reasons.push(
      `this method's bac water figures (${g(p.bac_stock_ug_ml)} ug/mL stock, benzyl ` +
        `alcohol at ${g(p.benzyl_alcohol_density_mg_ml)} mg/mL) are not the ones Process ` +
        `HPLC uses (${g(BAC_STOCK_UG_ML)} ug/mL, ${g(BENZYL_ALCOHOL_DENSITY)} mg/mL); have the method ` +
        'checked before a bac row is promoted'
    )
  if (form === 'liquid' && !((inputs.declared_volume_ml ?? 0) > 0))
    reasons.push(REASON_LIQUID_VOLUME)
  if (form !== 'liquid') {
    if (inputs.stock_vial_mg == null || inputs.stock_vial_diluent_mg == null)
      reasons.push(REASON_STOCK_PAIR)
    else if (computed.stock.problem === 'diluent')
      reasons.push(REASON_STOCK_BACKWARDS)
  }
  if (computed.stock.problem === 'declared') reasons.push(REASON_DECLARED_ZERO)

  const weighedVials = inputs.vials ?? {}
  for (const v of computed.vials) {
    const weighed = (weighedVials[String(v.vial)] ?? {}) as Record<
      string,
      unknown
    >
    const steps = [
      ...(v.two_step && v.intermediate
        ? [['3a', INTERMEDIATE, [], v.intermediate.actual] as const]
        : []),
      ['3', FINAL, v.neat ? ['vial_diluent_mg'] : [], v.actual] as const,
    ]
    for (const [label, names, skip, actual] of steps) {
      const gone = missing(weighed, names, skip)
      if (gone.length)
        reasons.push(
          `Vial ${vialLetter(v.vial)}, Step ${label}: weigh ${and(gone)}`
        )
      else if (actual.problem)
        reasons.push(
          `Vial ${vialLetter(v.vial)}, Step ${label}: ${FLAGGED[actual.problem]}; ` +
            'check the weights'
        )
    }
    reasons.push(...aboveTheStock(v))
  }
  if (row.is_blend) {
    const names = new Map(
      row.components.map(c => [c.peptide_id, c.abbreviation || c.name])
    )
    for (const c of computed.components)
      if (c.declared_mg == null)
        reasons.push(
          `type the weight of ${names.get(c.peptide_id)} in the blend split (Step 2b)`
        )
  }

  // The backstop: whatever the list above missed, a prep never leaves
  // without the numbers Process HPLC works from.
  if (!reasons.length) {
    if (computed.stock.total_diluent_ml == null)
      reasons.push(
        'the stock volume cannot be worked out from these numbers; check Step 2'
      )
    for (const v of computed.vials)
      if (v.dilution_factor_total == null || v.stock_conc_ug_ml == null)
        reasons.push(
          `Vial ${vialLetter(v.vial)} cannot be worked out from these numbers; check the row`
        )
  }
  return reasons
}
