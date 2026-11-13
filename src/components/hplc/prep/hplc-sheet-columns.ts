/**
 * The HPLC prep sheet's columns, as data: the lab tool's own labels, tooltips
 * and decimal places (tools-dennis hplc-peptide-quant app.js, STEP1 for Step
 * 2 and STEP2 for Step 3), with the micro sign written "u", long dashes and
 * the minus sign written plainly, and nothing it built for typing numbers
 * into Accu-Mk1. Each `key` names the cell the sheet renders for it.
 */

export interface SheetColumn<K extends string = string> {
  key: K
  label: string
  title?: string
  /** Decimal places of a computed cell. */
  dp?: number
  /** Shown only when a row on the sheet needs it. */
  only?: 'liquid' | 'capsule'
  kind: 'text' | 'input' | 'select' | 'computed'
}

export const STEP2_TITLE = 'Peptide sample stock preparation'
export const STEP2_SUB =
  'What is in the customer sample vial and which instrument. Weigh that vial with its septum, add the diluent, weigh again.'
export const STEP3_TITLE = 'Peptide dilution into the autosampler vial'
export const STEP3_SUB =
  'Add diluent and stock each in two halves; weigh after each. A two-step sample dilutes from its intermediate vial. A blend split across vials has one row per vial, each from the same stock.'

export const FORM_LABELS: Record<string, string> = {
  powder: 'Lyophilized Powder',
  liquid: 'Liquid (Reconstituted)',
  bac: 'Bacteriostatic Water',
  capsule: 'Capsule',
}

export type Step2Key =
  | 'sample_id'
  | 'identity'
  | 'declared_mg'
  | 'form'
  | 'declared_volume_ml'
  | 'capsules'
  | 'instrument'
  | 'diluent'
  | 'stock_vial_mg'
  | 'diluent_ul'
  | 'stock_vial_diluent_mg'
  | 'total_diluent_ml'
  | 'stock_conc'
  | 'two_step'

export const STEP2_COLUMNS: SheetColumn<Step2Key>[] = [
  { key: 'sample_id', kind: 'text', label: 'Sample ID' },
  {
    key: 'identity',
    kind: 'text',
    label: 'Sample Identity',
    title:
      'What the sample is, as Accu-Mk1 names it. A blend lists its peptides joined with " + " ("BPC-157 + TB500"), or is a nickname from the Lab rules → Blend shorthand ("KLOW" = its four peptides); Step 2b then asks for each one\'s weight.',
  },
  {
    key: 'declared_mg',
    kind: 'input',
    label: 'Declared Peptide Wt (mg)',
    title:
      "What the order declares is in the vial. For a blend this is the whole vial; the stock is worked from the lead component's share in Step 2b.",
  },
  {
    key: 'form',
    kind: 'select',
    label: 'Form',
    title:
      "How the vial arrived. Lyophilized powder (the usual) is weighed and dissolved here in Step 2. Liquid (reconstituted) means the customer's declared volume is the stock: type it in the next box; the weighing boxes switch off. Bacteriostatic water: weigh the vial full ((1) the left weighing box), then emptied and dried ((2) the right box); the stock is 9000 ug/mL (0.9% benzyl alcohol) and the declared weight is worked out. Capsule (2026-10-21): the declared weight is per capsule and Capsules used says how many went in; empty the capsules into a vial, cap it and weigh (the left weighing box), add water and weigh again (the right box): the difference is the water added, worked out as for a powder.",
  },
  {
    key: 'declared_volume_ml',
    kind: 'input',
    only: 'liquid',
    label: 'Declared Liquid Vol (mL)',
    title:
      'For a liquid vial only: the volume the customer declares, taken as is, the vial is never weighed as a check (that is the disclaimer).',
  },
  {
    key: 'capsules',
    kind: 'input',
    only: 'capsule',
    label: 'Capsules used',
    title:
      'For a capsule row only: how many capsules were emptied to make this stock. The Declared Peptide Wt is per capsule, so the peptide in the stock = declared × capsules.',
  },
  {
    key: 'instrument',
    kind: 'select',
    label: 'Instrument',
    title: 'Which Agilent 1290 this vial runs on',
  },
  {
    key: 'diluent',
    kind: 'select',
    label: 'Diluent',
    title:
      'What the stock (and its dilutions) are made in. Water, unless a peptide in the Sample Identity is listed under Lab rules → Diluent by peptide (GHK-Cu, GLOW and KLOW take water + 0.1% TFA). Pick one to use another for this row; the first choice goes back to the rule.',
  },
  {
    key: 'stock_vial_mg',
    kind: 'input',
    label: 'Wt Customer Sample vial and Septum (mg)',
  },
  { key: 'diluent_ul', kind: 'input', label: 'Diluent to add (uL)' },
  {
    key: 'stock_vial_diluent_mg',
    kind: 'input',
    label: 'Wt Customer Sample vial and Septum + Diluent (mg)',
  },
  {
    key: 'total_diluent_ml',
    kind: 'computed',
    dp: 4,
    label: 'Total Diluent added (mL)',
    title:
      '(Wt Customer Sample vial and Septum + Diluent - Wt Customer Sample vial and Septum) ÷ Diluent density. For a pre-dissolved vial: the Declared Liquid Vol, as declared.',
  },
  {
    key: 'stock_conc',
    kind: 'computed',
    dp: 2,
    label: 'Peptide Stock Conc (ug/mL)',
    title:
      "Declared Peptide Wt × 1000 ÷ Total Diluent added. For a blend: the lead component's weight (Step 2b) × 1000 ÷ Total Diluent added.",
  },
  {
    key: 'two_step',
    kind: 'select',
    label: '2-step dilution',
    title:
      "Auto: on when the declared weight is 500 mg or more (there is a limit to how much diluent the vial takes); for a blend, decided per dilution vial on its lead's weight. Set yes or no to override for every vial of this row.",
  },
]

export type Step3Key =
  | 'sample_id'
  | 'identity'
  | 'diluent'
  | 'stock_for_final'
  | 'target_ug_ml'
  | 'target_volume_ul'
  | 'vial_mg'
  | 'diluent_vol_ul'
  | 'diluent_half_ul'
  | 'vial_diluent_mg'
  | 'stock_vol_ul'
  | 'stock_half_ul'
  | 'vial_all_mg'
  | 'actual_diluent_ul'
  | 'actual_stock_ul'
  | 'actual_total_ul'
  | 'actual_conc_ug_ml'
  | 'dilution_factor_total'

export const STEP3_COLUMNS: SheetColumn<Step3Key>[] = [
  { key: 'sample_id', kind: 'text', label: 'Sample ID' },
  {
    key: 'identity',
    kind: 'text',
    label: 'Sample Identity',
    title:
      'Copied from Step 2, change it there. A blend split across vials also says which peptides this vial holds.',
  },
  {
    key: 'diluent',
    kind: 'text',
    label: 'Diluent',
    title:
      'From Step 2: what the stock and this dilution are made in (Water, or water + 0.1% TFA for GHK by the Lab rules; a row can pick its own there).',
  },
  {
    key: 'stock_for_final',
    kind: 'computed',
    dp: 2,
    label: 'Diluting from (ug/mL)',
    title:
      'The stock this row dilutes: Peptide Stock Conc from Step 2, or for a two-step sample the Actual Intermediate Conc from Step 3a (its target until it is weighed)',
  },
  { key: 'target_ug_ml', kind: 'input', label: 'Target Conc (ug/mL)' },
  { key: 'target_volume_ul', kind: 'input', label: 'Target Total Vol (uL)' },
  { key: 'vial_mg', kind: 'input', label: 'Wt Autosampler vial and cap (mg)' },
  {
    key: 'diluent_vol_ul',
    kind: 'computed',
    dp: 2,
    label: 'Diluent Vol to Add (uL), total',
    title: 'Target Total Vol - Stock Vol to Add',
  },
  {
    key: 'diluent_half_ul',
    kind: 'computed',
    dp: 2,
    label: 'half',
    title: 'Half of Diluent Vol to Add: the diluent goes in as two halves',
  },
  {
    key: 'vial_diluent_mg',
    kind: 'input',
    label: 'Wt Autosampler vial and cap + Diluent (mg)',
  },
  {
    key: 'stock_vol_ul',
    kind: 'computed',
    dp: 2,
    label: 'Stock Vol to Add (uL), total',
    title: 'Target Conc × Target Total Vol ÷ Diluting from',
  },
  {
    key: 'stock_half_ul',
    kind: 'computed',
    dp: 2,
    label: 'half',
    title: 'Half of Stock Vol to Add: the stock goes in as two halves',
  },
  {
    key: 'vial_all_mg',
    kind: 'input',
    label: 'Wt of Vial, cap, Diluent + Sample (mg)',
  },
  {
    key: 'actual_diluent_ul',
    kind: 'computed',
    dp: 2,
    label: 'Actual Diluent Volume added (uL)',
    title:
      '(Wt Autosampler vial and cap + Diluent - Wt Autosampler vial and cap) ÷ Diluent density × 1000',
  },
  {
    key: 'actual_stock_ul',
    kind: 'computed',
    dp: 2,
    label: 'Actual Stock Vol added (uL)',
    title:
      '(Wt of Vial, cap, Diluent + Sample - Wt Autosampler vial and cap + Diluent) ÷ Diluent density × 1000',
  },
  {
    key: 'actual_total_ul',
    kind: 'computed',
    dp: 2,
    label: 'Actual Total Volume (uL)',
    title: 'Actual Stock Vol added + Actual Diluent Volume added',
  },
  {
    key: 'actual_conc_ug_ml',
    kind: 'computed',
    dp: 2,
    label: 'Actual Conc (ug/mL)',
    title: 'Diluting from × Actual Stock Vol added ÷ Actual Total Volume',
  },
  {
    key: 'dilution_factor_total',
    kind: 'computed',
    dp: 4,
    label: 'Total Dilution Factor',
    title:
      "Stock → final vial. One step: Actual Total Volume ÷ Actual Stock Vol added. Two steps: that, times the intermediate step's own factor.",
  },
]
