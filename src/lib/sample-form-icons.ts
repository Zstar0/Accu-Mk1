/** Keys of the dosage-form icon set, in picker order; mirrors FormIcon in
 *  backend/sample_forms/routes.py. Labels live in en.json
 *  (`preferences.sampleForms.icon.<key>`), drawings in
 *  components/common/SampleFormIcon.tsx. */
export const SAMPLE_FORM_ICONS = [
  'powder_vial',
  'liquid_vial',
  'pen',
  'nasal_spray',
  'capsule',
  'tablet',
  'syringe',
  'other',
] as const
export type SampleFormIconKey = (typeof SAMPLE_FORM_ICONS)[number]

/** The drawable key for a stored icon: null, or a key this build does not know
 *  (a newer build added it), falls back to the generic one. */
export const iconKey = (icon: string | null | undefined): SampleFormIconKey =>
  (SAMPLE_FORM_ICONS as readonly string[]).includes(icon ?? '')
    ? (icon as SampleFormIconKey)
    : 'other'
