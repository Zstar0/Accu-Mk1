/** Everything the profile editor decides about a form's COA text version, as
 *  pure functions. The components only draw what these return. */
import type { AnalysisProfile, AnalysisServiceSpecRecord } from '@/lib/api'
import type {
  ProfileCoaVariant,
  ProfileCoaVariantFields,
} from '@/lib/api-profile-coa-variants'

export type CoaField = keyof ProfileCoaVariantFields
export type CoaTextField = Exclude<CoaField, 'coa_footnotes'>
export type FieldChoice = 'default' | 'custom' | 'off'
export interface Footnote {
  label: string
  text: string
}
export type CoaDefaults = Pick<AnalysisProfile, 'name' | CoaField>

export interface VariantDraft {
  variantId: number | null
  formId: number
  formName: string
  choices: Record<CoaField, FieldChoice>
  /** null = never prefilled or typed */
  texts: Record<CoaTextField, string | null>
  footnotes: Footnote[] | null
}

/** In print order. `short` feeds the summary lines. */
export const COA_FIELD_ROWS: {
  field: CoaField
  label: string
  short: string
  limits: boolean
  canLeaveOff: boolean
}[] = [
  {
    field: 'coa_section_title',
    label: 'Section title',
    short: 'title',
    limits: false,
    canLeaveOff: false,
  },
  {
    field: 'coa_basis_note',
    label: 'Basis note',
    short: 'basis note',
    limits: true,
    canLeaveOff: true,
  },
  {
    field: 'coa_method_text',
    label: 'Method',
    short: 'method',
    limits: false,
    canLeaveOff: true,
  },
  {
    field: 'coa_prep_text',
    label: 'Sample prep',
    short: 'prep',
    limits: false,
    canLeaveOff: true,
  },
  {
    field: 'coa_footnotes',
    label: 'Footnotes',
    short: 'footnotes',
    limits: true,
    canLeaveOff: true,
  },
]

export const COA_MACRO_HINT =
  'Macros: {lod}. Wrap optional text in [ ], for example [LOD {lod}.]'
export const UNSAVED_VERSION_PROMPT =
  'You have unsaved COA text for a sample form. Leave without saving it?'

export function newDraft(formId: number, formName: string): VariantDraft {
  return {
    variantId: null,
    formId,
    formName,
    choices: {
      coa_section_title: 'default',
      coa_basis_note: 'default',
      coa_method_text: 'default',
      coa_prep_text: 'default',
      coa_footnotes: 'default',
    },
    texts: {
      coa_section_title: null,
      coa_basis_note: null,
      coa_method_text: null,
      coa_prep_text: null,
    },
    footnotes: null,
  }
}

function choiceOf(value: string | Footnote[] | null): FieldChoice {
  if (value === null) return 'default'
  return value.length === 0 ? 'off' : 'custom'
}

// Also fixes the key order: the column is JSONB, which hands keys back in its
// own order, not the order they were sent in.
const copyRows = (rows: Footnote[]): Footnote[] =>
  rows.map(({ label, text }) => ({ label, text }))

export function draftFromVariant(v: ProfileCoaVariant): VariantDraft {
  return {
    variantId: v.id,
    formId: v.sample_form_id,
    formName: v.sample_form_name,
    choices: {
      coa_section_title: choiceOf(v.coa_section_title),
      coa_basis_note: choiceOf(v.coa_basis_note),
      coa_method_text: choiceOf(v.coa_method_text),
      coa_prep_text: choiceOf(v.coa_prep_text),
      coa_footnotes: choiceOf(v.coa_footnotes),
    },
    // Leave off is not typed text, so a later Custom still prefills.
    texts: {
      coa_section_title: v.coa_section_title || null,
      coa_basis_note: v.coa_basis_note || null,
      coa_method_text: v.coa_method_text || null,
      coa_prep_text: v.coa_prep_text || null,
    },
    footnotes: v.coa_footnotes?.length ? copyRows(v.coa_footnotes) : null,
  }
}

/** The first Custom prefills from the saved Default. After that the typed text
 *  stays, whichever choice the field moves through. */
export function setChoice(
  d: VariantDraft,
  field: CoaField,
  choice: FieldChoice,
  defaults: CoaDefaults
): VariantDraft {
  const next = { ...d, choices: { ...d.choices, [field]: choice } }
  if (choice !== 'custom') return next
  if (field === 'coa_footnotes') {
    return d.footnotes === null
      ? { ...next, footnotes: copyRows(defaults.coa_footnotes ?? []) }
      : next
  }
  if (d.texts[field] !== null) return next
  const prefill =
    field === 'coa_section_title'
      ? defaults.coa_section_title || defaults.name
      : (defaults[field] ?? '')
  return { ...next, texts: { ...d.texts, [field]: prefill } }
}

// Same cleaning as handleSave in AnalysisProfilesPage: drop rows blank on both
// sides, and keep a half-filled row so the backend's 400 reaches the admin.
const cleanFootnotes = (rows: Footnote[] | null): Footnote[] =>
  (rows ?? [])
    .filter(row => row.label.trim() !== '' || row.text.trim() !== '')
    .map(row => ({ label: row.label.trim(), text: row.text.trim() }))

export function draftToWire(d: VariantDraft): ProfileCoaVariantFields {
  const text = (field: CoaTextField): string | null => {
    if (d.choices[field] === 'default') return null
    return d.choices[field] === 'off' ? '' : (d.texts[field] ?? '').trim()
  }
  return {
    coa_section_title: text('coa_section_title'),
    coa_basis_note: text('coa_basis_note'),
    coa_method_text: text('coa_method_text'),
    coa_prep_text: text('coa_prep_text'),
    coa_footnotes:
      d.choices.coa_footnotes === 'default'
        ? null
        : d.choices.coa_footnotes === 'off'
          ? []
          : cleanFootnotes(d.footnotes),
  }
}

/** A blank Custom would go out as '' or [], which means Leave off, so it blocks Save. */
export function draftErrors(
  d: VariantDraft
): Partial<Record<CoaField, string>> {
  const wire = draftToWire(d)
  const errors: Partial<Record<CoaField, string>> = {}
  for (const { field } of COA_FIELD_ROWS) {
    if (d.choices[field] === 'custom' && wire[field]?.length === 0) {
      errors[field] =
        field === 'coa_section_title'
          ? 'Type the title, or choose Same as default'
          : 'Type the text, or choose Leave off'
    }
  }
  return errors
}

const wireKey = (w: ProfileCoaVariantFields | null): string =>
  JSON.stringify(
    COA_FIELD_ROWS.map(({ field }) => {
      const value = w?.[field] ?? null
      return Array.isArray(value) ? copyRows(value) : value
    })
  )

export function isDraftDirty(
  d: VariantDraft,
  saved: ProfileCoaVariant | null
): boolean {
  return wireKey(draftToWire(d)) !== wireKey(saved)
}

export function summaryLine(w: ProfileCoaVariantFields): string {
  const parts = COA_FIELD_ROWS.filter(({ field }) => w[field] !== null).map(
    ({ field, short }) =>
      `${short} ${choiceOf(w[field]) === 'off' ? 'left off' : 'custom'}`
  )
  return parts.length
    ? `Overrides: ${parts.join(', ')}`
    : 'Same as default (no changes yet)'
}

/** "a", "a and b", "a, b and c". */
function wordList(words: string[], conjunction: 'and' | 'or'): string {
  const last = words.at(-1) ?? ''
  return words.length > 1
    ? `${words.slice(0, -1).join(', ')} ${conjunction} ${last}`
    : last
}

export function overrideLine(v: ProfileCoaVariant): string | null {
  const shorts = COA_FIELD_ROWS.filter(({ field }) => v[field] !== null).map(
    ({ short }) => short
  )
  return shorts.length
    ? `${v.sample_form_name} overrides ${wordList(shorts, 'and')}`
    : null
}

export interface MemberRules {
  serviceId: number
  name: string
  rules: AnalysisServiceSpecRecord[] | undefined
  failed: boolean
}
export type RuleStatus =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'ok'; count: number; peptideRule: boolean; allReportOnly: boolean }
  | {
      kind: 'held'
      missing: { serviceId: number; name: string }[]
      peptideRule: boolean
    }

export function memberRuleStatus(
  formId: number,
  members: MemberRules[],
  membersLoading: boolean
): RuleStatus {
  if (members.some(m => m.failed)) return { kind: 'unknown' }
  if (membersLoading || members.some(m => m.rules === undefined)) {
    return { kind: 'loading' }
  }
  if (members.length === 0) return { kind: 'unknown' }

  const formRows = (m: MemberRules) =>
    (m.rules ?? []).filter(
      r => r.sample_form_id === formId && r.peptide_id == null
    )
  const peptideRule = members.some(m =>
    m.rules?.some(r => r.peptide_id != null)
  )
  const missing = members
    .filter(m => formRows(m).length === 0)
    .map(({ serviceId, name }) => ({ serviceId, name }))
  if (missing.length > 0) return { kind: 'held', missing, peptideRule }
  return {
    kind: 'ok',
    count: members.length,
    peptideRule,
    allReportOnly: members.every(m =>
      formRows(m).every(r => r.rule_kind === 'informational')
    ),
  }
}

export function guardMessage(status: RuleStatus, formName: string): string {
  if (status.kind === 'loading') return `Checking the ${formName} rules...`
  if (status.kind === 'unknown') {
    return `Could not confirm the ${formName} rules.`
  }
  const peptide = status.peptideRule
    ? ' A peptide-specific rule also keeps the Default basis note and footnotes.'
    : ''
  if (status.kind === 'ok') {
    const who =
      status.count === 1
        ? 'The 1 service has'
        : `All ${status.count} services have`
    return `${who} a ${formName} rule, so this version's basis note and footnotes print.${peptide}`
  }
  const names = wordList(
    status.missing.map(m => m.name),
    'and'
  )
  const opening =
    status.missing.length === 1
      ? `${names} has no ${formName} rule, so it is judged on its general limits. A ${formName} COA that includes it keeps`
      : `${names} have no ${formName} rule, so they are judged on their general limits. A ${formName} COA that includes any of them keeps`
  return `${opening} the Default basis note and footnotes. Title, method and prep still use this version.${peptide}`
}

export function heldNote(status: RuleStatus): string | null {
  if (status.kind !== 'held') return null
  const names = wordList(
    status.missing.map(m => m.name),
    'or'
  )
  return `Held: the Default prints on a COA that includes ${names}`
}

export interface PreviewPiece {
  text: string | null
  missing: string
  tag: string
}
export interface CoaPreview {
  title: PreviewPiece
  basis: PreviewPiece
  method: PreviewPiece
  prep: PreviewPiece
  footnotes: { items: Footnote[]; tag: string }
  macroNote: boolean
}

/** What Save would print. Assumes every member is on the COA, so its held state
 *  matches the guard line. While the rules are loading or unknown it shows the
 *  choice, and the guard line carries the warning. */
export function buildPreview(
  d: VariantDraft,
  defaults: CoaDefaults,
  status: RuleStatus
): CoaPreview {
  const wire = draftToWire(d)
  const piece = (
    own: string | null,
    fallback: string | null,
    missing: string
  ): PreviewPiece =>
    own === null
      ? { text: fallback || null, missing, tag: 'Default' }
      : { text: own || null, missing, tag: d.formName }

  const title: PreviewPiece = wire.coa_section_title
    ? { text: wire.coa_section_title, missing: '', tag: d.formName }
    : {
        text: defaults.coa_section_title || defaults.name,
        missing: '',
        tag: 'Default',
      }

  const noBasis = 'no basis note'
  let basis = piece(wire.coa_basis_note, defaults.coa_basis_note, noBasis)
  if (wire.coa_basis_note !== null && status.kind === 'held') {
    basis = {
      text: defaults.coa_basis_note || null,
      missing: noBasis,
      tag: 'Default, held',
    }
  } else if (
    wire.coa_basis_note === null &&
    status.kind === 'ok' &&
    status.allReportOnly
  ) {
    // The 1.55.0 hide. A version's own basis note overrides it, so only Same as default follows it.
    basis = {
      text: null,
      missing: noBasis,
      tag: 'Default, hidden: every row is report only',
    }
  }

  const defaultNotes = defaults.coa_footnotes ?? []
  let footnotes = { items: wire.coa_footnotes ?? [], tag: d.formName }
  if (wire.coa_footnotes === null) {
    footnotes = { items: defaultNotes, tag: 'Default' }
  } else if (status.kind === 'held') {
    footnotes = { items: defaultNotes, tag: 'Default, held' }
  }

  const method = piece(
    wire.coa_method_text,
    defaults.coa_method_text,
    'no method line'
  )
  const prep = piece(wire.coa_prep_text, defaults.coa_prep_text, 'no prep line')
  const shown = [
    title.text,
    basis.text,
    method.text,
    prep.text,
    ...footnotes.items.flatMap(row => [row.label, row.text]),
  ]
  return {
    title,
    basis,
    method,
    prep,
    footnotes,
    macroNote: shown.some(text => text?.includes('{lod}')),
  }
}
