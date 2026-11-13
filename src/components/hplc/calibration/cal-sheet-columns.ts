/**
 * The calibration curve worksheet's columns and fields, as data: the lab
 * tool's own labels, tooltips and decimal places (tools-dennis
 * hplc-peptide-quant cal.js STOCK_COLS, DIL_COLS, PEAK_COLS and
 * calibration.html Steps 1 and 1b), with the micro sign written "u", long
 * dashes and the minus sign written plainly. Each `key` is the input key it
 * writes (typed columns) or the worked-out key it shows (computed columns).
 */
import type { SheetColumn } from '@/components/hplc/prep/hplc-sheet-columns'

export type StockKey =
  | 'vial_mg'
  | 'vial_standard_mg'
  | 'stock_weight_mg'
  | 'stock_diluent_to_add_ul'
  | 'vial_diluent_mg'
  | 'stock_actual_diluent_ul'
  | 'stock_conc_as_weighed_ug_ml'
  | 'stock_net_weight_mg'
  | 'stock_conc_ug_ml'

export const STOCK_COLUMNS: SheetColumn<StockKey>[] = [
  {
    key: 'vial_mg',
    kind: 'input',
    label: 'Stock Vial + cap (mg)',
    title: 'The empty stock vial and its cap',
  },
  {
    key: 'vial_standard_mg',
    kind: 'input',
    label: 'Stock Vial + cap + Standard (mg)',
    title: 'The stock vial and cap with the standard in it',
  },
  {
    key: 'stock_weight_mg',
    kind: 'computed',
    dp: 2,
    label: 'Stock weight (mg)',
    title:
      'Vial + cap + standard - vial + cap (the workbook typed this; here it is worked out)',
  },
  {
    key: 'stock_diluent_to_add_ul',
    kind: 'computed',
    dp: 0,
    label: 'Diluent to add (uL)',
    title:
      '1 mL to start. Add more only if the standard does not dissolve: a stronger stock is better than a weak one. The stock is worked out from what actually went in.',
  },
  {
    key: 'vial_diluent_mg',
    kind: 'input',
    label: 'Stock Vial + cap + Standard + Diluent (mg)',
    title: 'Weighed after the diluent (including any added to dissolve it)',
  },
  {
    key: 'stock_actual_diluent_ul',
    kind: 'computed',
    dp: 2,
    label: 'Actual Diluent (uL)',
    title: '(Vial + standard + diluent - vial + standard) ÷ density × 1000',
  },
  {
    key: 'stock_conc_as_weighed_ug_ml',
    kind: 'computed',
    dp: 2,
    label: 'Stock, as weighed (ug/mL)',
    title:
      'Stock weight × 1000 ÷ the actual diluent in mL, before the net peptide correction',
  },
  {
    key: 'stock_net_weight_mg',
    kind: 'computed',
    dp: 4,
    label: 'Net peptide weight (mg)',
    title:
      'The adjusted weight: stock weight × the net factor from Step 1b, the free peptide in the vial once the counterion, water and assay come off',
  },
  {
    key: 'stock_conc_ug_ml',
    kind: 'computed',
    dp: 2,
    label: 'Stock, net peptide (ug/mL)',
    title:
      'Net peptide weight × 1000 ÷ the actual diluent in mL: what the first level is made from (as weighed when no correction applies)',
  },
]

export type DilutionKey =
  | 'target'
  | 'planned_diluent_ul'
  | 'vial_mg'
  | 'vial_diluent_mg'
  | 'actual_diluent_ul'
  | 'std_to_add_ul'
  | 'vial_diluent_std_mg'
  | 'actual_std_ul'
  | 'total_ul'
  | 'actual_conc_ug_ml'
  | 'remaining_ul'

export const DILUTION_COLUMNS: SheetColumn<DilutionKey>[] = [
  {
    key: 'target',
    kind: 'input',
    label: 'Target (ug/mL)',
    title: 'The concentration this level is made to',
  },
  {
    key: 'planned_diluent_ul',
    kind: 'computed',
    dp: 2,
    label: 'Planned Diluent (uL)',
    title:
      'Level volume - the standard it needs (target × level volume ÷ the level above): what to add before weighing',
  },
  {
    key: 'vial_mg',
    kind: 'input',
    label: 'Vial and cap (mg)',
    title: 'The empty vial and cap',
  },
  {
    key: 'vial_diluent_mg',
    kind: 'input',
    label: 'Vial, cap and Diluent (mg)',
    title: 'Weighed after the diluent',
  },
  {
    key: 'actual_diluent_ul',
    kind: 'computed',
    dp: 2,
    label: 'Actual Diluent (uL)',
    title: '(Vial + diluent - vial) ÷ density × 1000',
  },
  {
    key: 'std_to_add_ul',
    kind: 'computed',
    dp: 2,
    label: 'Std to add (uL)',
    title:
      'The standard (from the level above) that turns the diluent actually in the vial into the target: diluent × target ÷ (level above - target)',
  },
  {
    key: 'vial_diluent_std_mg',
    kind: 'input',
    label: 'Vial, cap, Diluent and Std (mg)',
    title: 'Weighed after the standard',
  },
  {
    key: 'actual_std_ul',
    kind: 'computed',
    dp: 2,
    label: 'Actual Std (uL)',
    title: '(Vial + diluent + standard - vial + diluent) ÷ density × 1000',
  },
  {
    key: 'total_ul',
    kind: 'computed',
    dp: 2,
    label: 'Total (uL)',
    title: 'Actual standard + actual diluent',
  },
  {
    key: 'actual_conc_ug_ml',
    kind: 'computed',
    dp: 4,
    label: 'Actual (ug/mL)',
    title:
      'Actual standard × the level above ÷ total: the concentration the curve uses',
  },
  {
    key: 'remaining_ul',
    kind: 'computed',
    dp: 2,
    label: 'Remaining (uL)',
    title: 'What is left of this level after the next one is drawn from it',
  },
]

export type PeakKey =
  | 'target'
  | 'actual_conc_ug_ml'
  | 'peak_area'
  | 'purity'
  | 'rt'
  | 'back_calc_ug_ml'
  | 'back_calc_dev_pct'

export const PEAK_COLUMNS: SheetColumn<PeakKey>[] = [
  { key: 'target', kind: 'computed', dp: 0, label: 'Target (ug/mL)' },
  {
    key: 'actual_conc_ug_ml',
    kind: 'computed',
    dp: 4,
    label: 'Actual (ug/mL)',
    title: 'From Step 3',
  },
  {
    key: 'peak_area',
    kind: 'input',
    label: 'Peak Area',
    title: 'From the run',
  },
  { key: 'purity', kind: 'input', label: 'Purity (%)', title: 'From the run' },
  {
    key: 'rt',
    kind: 'input',
    label: 'RT (min)',
    title: 'Retention time, from the run',
  },
  {
    key: 'back_calc_ug_ml',
    kind: 'computed',
    dp: 4,
    label: 'Back-calc (ug/mL)',
    title:
      '(Peak area - intercept) ÷ slope: this level read back off its own curve',
  },
  {
    key: 'back_calc_dev_pct',
    kind: 'computed',
    dp: 2,
    label: 'Deviation (%)',
    title:
      'Back-calc against the actual concentration: which level pulls the line',
  },
]

/** A Step 1 or Step 1b field. `key` is the input key (under `net` for the
 *  net block). `number` boxes commit through the page's number box. */
export interface CalField<K extends string = string> {
  key: K
  label: string
  kind: 'text' | 'number' | 'select' | 'date'
  title?: string
  placeholder?: string
}

export type Step1Key =
  | 'peptide_id'
  | 'instrument_id'
  | 'standard_id'
  | 'cas'
  | 'supplier'
  | 'lot'
  | 'coa_weight_mg'
  | 'diluent_density_mg_ml'
  | 'level_volume_ul'

export const STEP1_FIELDS: CalField<Step1Key>[] = [
  {
    key: 'peptide_id',
    kind: 'select',
    label: 'Compound',
    title:
      'The peptide this standard is. The curve is filed under it; a blend has no curve of its own.',
  },
  {
    key: 'instrument_id',
    kind: 'select',
    label: 'Instrument',
    title: 'The instrument that runs the levels. A curve belongs to it.',
  },
  {
    key: 'standard_id',
    kind: 'text',
    label: 'LIMS Sample # / Standard',
    placeholder: 'P-',
  },
  { key: 'cas', kind: 'text', label: 'CAS number' },
  { key: 'supplier', kind: 'text', label: 'Standard Supplier' },
  { key: 'lot', kind: 'text', label: 'Lot #' },
  { key: 'coa_weight_mg', kind: 'number', label: 'Weight from COA (mg)' },
  {
    key: 'diluent_density_mg_ml',
    kind: 'number',
    label: 'Diluent density (mg/mL)',
    placeholder: '997.1',
  },
  {
    key: 'level_volume_ul',
    kind: 'number',
    label: 'Level volume (uL)',
    placeholder: '1500',
    title:
      'The volume each level is made up to: the planned diluent is this minus the standard it needs',
  },
]

export type NetKey =
  | 'counterion'
  | 'counterion_mw'
  | 'equivalents'
  | 'free_mw'
  | 'stated_fw'
  | 'ms_mz'
  | 'ms_ion'
  | 'assay_pct'
  | 'water_pct'
  | 'assumption'
  | 'override_factor'
  | 'override_reason'

export const NET_FIELDS: CalField<NetKey>[] = [
  {
    key: 'counterion',
    kind: 'select',
    label: 'Counterion',
    title:
      "From the CoA: acetate, TFA, ... (the masses are the Lab rules' Counterions table). None for a free base.",
  },
  {
    key: 'counterion_mw',
    kind: 'number',
    label: 'Counterion mass (g/mol per eq)',
  },
  {
    key: 'equivalents',
    kind: 'number',
    label: 'Equivalents (n)',
    placeholder: 'e.g. 2 or 2.1',
    title:
      'How many counterions ride with each peptide: measured (NMR, IC) or a lean from the basic sites (Lys, Arg, free N-terminus, about one each). Not needed when the stated FW is the salt.',
  },
  {
    key: 'free_mw',
    kind: 'number',
    label: 'Free-peptide MW (g/mol)',
    title: 'The molecular formula summed by hand',
  },
  {
    key: 'stated_fw',
    kind: 'number',
    label: 'Stated FW on the CoA (g/mol)',
    title:
      'As printed. The sheet compares it with the free-peptide MW: equal = the counterion sits outside it; free + n counterions = the FW is the salt, nothing further is applied',
  },
  {
    key: 'ms_mz',
    kind: 'number',
    label: 'Mass spec on the CoA (m/z)',
    placeholder: 'e.g. 1603.1',
    title:
      'The m/z the CoA reports. MS sees the free peptide (the counterion is gone), so the neutral mass it gives must match the free-peptide MW: a check, not an input to the factor.',
  },
  {
    key: 'ms_ion',
    kind: 'select',
    label: 'Ion',
    title:
      'The ion form the CoA writes: [M+H]+, [M-3H]3- ... The sheet turns the m/z back into the neutral mass.',
  },
  {
    key: 'assay_pct',
    kind: 'number',
    label: 'CoA assay (%)',
    placeholder: '100',
  },
  {
    key: 'water_pct',
    kind: 'number',
    label: 'Water, Karl Fischer (%)',
    placeholder: 'KF on every lot',
    title:
      'Measured on this lot. Lyophilized peptides carry 3 to 10 %; it multiplies with the counterion correction.',
  },
  {
    key: 'assumption',
    kind: 'text',
    label: 'Counterion assumption, in words',
    placeholder: 'e.g. 1H NMR 2.1 eq, or: lean 2, undeclared on the CoA',
    title:
      'Written down, not implied by a formula: how the equivalents were measured, or the reasoning behind the lean',
  },
  {
    key: 'override_factor',
    kind: 'number',
    label: 'Use a different factor',
    title:
      'Mk1 only: a net factor entered by hand, used for the stock in place of the one worked out above. Leave it blank to use the worked-out factor.',
  },
  {
    key: 'override_reason',
    kind: 'text',
    label: 'Why',
    title:
      'Mk1 only: why the factor is entered by hand. The curve cannot be filed without it.',
  },
]

/** The Ion select's choices: calc.js MS_IONS with its own labels. */
export const MS_ION_LABELS: Record<string, string> = {
  '': '-',
  M: 'M (neutral mass)',
  'M+H': '[M+H]+',
  'M+2H': '[M+2H]2+',
  'M+3H': '[M+3H]3+',
  'M+4H': '[M+4H]4+',
  'M-H': '[M-H]-',
  'M-2H': '[M-2H]2-',
  'M-3H': '[M-3H]3-',
  'M-4H': '[M-4H]4-',
}

/** Bounds the server enforces (task-4-report "Bounds as enforced"), by input
 *  key, with the sentence a box shows instead of sending a 400. */
export interface CalBound {
  min?: number
  minOpen?: boolean
  max?: number
  maxOpen?: boolean
  say: string
}
const WEIGHING: CalBound = {
  min: 0,
  max: 1e9,
  say: 'a balance reading is between 0 and 1,000,000,000 mg',
}
const TINY: CalBound = {
  min: 1e-6,
  max: 1e12,
  say: 'must be at least 0.000001',
}
const ONE: CalBound = { min: 1, max: 1e12, say: 'must be at least 1' }
const MAGNITUDE: CalBound = {
  min: -1e12,
  max: 1e12,
  say: 'that number is far too large',
}
export const CAL_BOUNDS: Record<string, CalBound> = {
  coa_weight_mg: WEIGHING,
  vial_mg: WEIGHING,
  vial_standard_mg: WEIGHING,
  vial_diluent_mg: WEIGHING,
  vial_diluent_std_mg: WEIGHING,
  target: TINY,
  diluent_density_mg_ml: TINY,
  level_volume_ul: TINY,
  top_aliquot_ul: TINY,
  free_mw: ONE,
  stated_fw: ONE,
  counterion_mw: ONE,
  ms_mz: ONE,
  equivalents: { min: 0.01, max: 100, say: 'must be from 0.01 to 100' },
  override_factor: {
    min: 0,
    minOpen: true,
    max: 2,
    say: 'must be more than 0 and no more than 2',
  },
  assay_pct: {
    min: 0,
    minOpen: true,
    max: 150,
    say: 'must be more than 0 and no more than 150',
  },
  water_pct: {
    min: 0,
    max: 100,
    maxOpen: true,
    say: 'must be 0 or more and less than 100',
  },
  peak_area: MAGNITUDE,
  purity: MAGNITUDE,
  rt: MAGNITUDE,
}

/** Why a typed number is refused (null: it is taken). */
export function refusalOf(key: string, v: number): string | null {
  if (!Number.isFinite(v)) return 'type a number'
  const b = CAL_BOUNDS[key] ?? MAGNITUDE
  if (b.min !== undefined && (b.minOpen ? v <= b.min : v < b.min)) return b.say
  if (b.max !== undefined && (b.maxOpen ? v >= b.max : v > b.max)) return b.say
  return null
}
