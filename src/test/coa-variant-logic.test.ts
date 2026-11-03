import { describe, it, expect } from 'vitest'
import type { AnalysisServiceSpecRecord } from '@/lib/api'
import type {
  ProfileCoaVariant,
  ProfileCoaVariantFields,
} from '@/lib/api-profile-coa-variants'
import {
  buildPreview,
  draftErrors,
  draftFromVariant,
  draftToWire,
  guardMessage,
  heldNote,
  isDraftDirty,
  memberRuleStatus,
  newDraft,
  overrideLine,
  setChoice,
  summaryLine,
  type CoaDefaults,
  type MemberRules,
  type RuleStatus,
} from '@/components/hplc/coa-variant-logic'

const DEFAULTS: CoaDefaults = {
  name: 'Heavy Metals',
  coa_section_title: null,
  coa_basis_note: 'Basis: USP<232>',
  coa_method_text: 'MP-AES',
  coa_prep_text: 'Hot block digestion',
  coa_footnotes: [{ label: 'Basis:', text: 'Limits per USP<232>.' }],
}
const NASAL = newDraft(4, 'Nasal Spray')
const allNull: ProfileCoaVariantFields = {
  coa_section_title: null,
  coa_basis_note: null,
  coa_method_text: null,
  coa_prep_text: null,
  coa_footnotes: null,
}
const baseVariant: ProfileCoaVariant = {
  ...allNull,
  id: 1,
  analysis_profile_id: 2,
  sample_form_id: 4,
  sample_form_name: 'Nasal Spray',
  active: true,
  updated_at: null,
}
const rule = (over: Partial<AnalysisServiceSpecRecord>) =>
  ({
    sample_form_id: 4,
    peptide_id: null,
    rule_kind: 'informational',
    ...over,
  }) as AnalysisServiceSpecRecord
const member = (
  name: string,
  rules: AnalysisServiceSpecRecord[] | undefined,
  failed = false
): MemberRules => ({ serviceId: name.length, name, rules, failed })

describe('wire mapping', () => {
  it('maps default to null, off to empty, custom to trimmed text', () => {
    let d = setChoice(NASAL, 'coa_basis_note', 'off', DEFAULTS)
    d = setChoice(d, 'coa_footnotes', 'off', DEFAULTS)
    d = setChoice(d, 'coa_prep_text', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_prep_text: '  Diluted  ' } }
    expect(draftToWire(d)).toEqual({
      coa_section_title: null,
      coa_basis_note: '',
      coa_method_text: null,
      coa_prep_text: 'Diluted',
      coa_footnotes: [],
    })
  })
  it('reads null, empty and text back into choices', () => {
    const d = draftFromVariant({
      ...baseVariant,
      coa_basis_note: '',
      coa_prep_text: 'Diluted',
      coa_footnotes: [],
    })
    expect(d.choices).toMatchObject({
      coa_section_title: 'default',
      coa_basis_note: 'off',
      coa_prep_text: 'custom',
      coa_footnotes: 'off',
    })
    expect(d.texts.coa_prep_text).toBe('Diluted')
  })
  it('prefills the first Custom from the saved Default and keeps typed text across switches', () => {
    let d = setChoice(NASAL, 'coa_prep_text', 'custom', DEFAULTS)
    expect(d.texts.coa_prep_text).toBe('Hot block digestion')
    d = { ...d, texts: { ...d.texts, coa_prep_text: 'Typed' } }
    d = setChoice(
      setChoice(d, 'coa_prep_text', 'off', DEFAULTS),
      'coa_prep_text',
      'custom',
      DEFAULTS
    )
    expect(d.texts.coa_prep_text).toBe('Typed')
  })
  it('prefills a custom title from the profile name when the Default title is blank', () => {
    expect(
      setChoice(NASAL, 'coa_section_title', 'custom', DEFAULTS).texts
        .coa_section_title
    ).toBe('Heavy Metals')
  })
  it('prefills custom footnotes with a copy of the Default rows', () => {
    const d = setChoice(NASAL, 'coa_footnotes', 'custom', DEFAULTS)
    expect(d.footnotes).toEqual(DEFAULTS.coa_footnotes)
    expect(d.footnotes).not.toBe(DEFAULTS.coa_footnotes)
  })
})

describe('draftErrors', () => {
  it('blocks blank Custom text, with its message', () => {
    let d = setChoice(NASAL, 'coa_prep_text', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_prep_text: '   ' } }
    expect(draftErrors(d)).toEqual({
      coa_prep_text: 'Type the text, or choose Leave off',
    })
  })
  it('has its own message for the title', () => {
    let d = setChoice(NASAL, 'coa_section_title', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_section_title: '' } }
    expect(draftErrors(d)).toEqual({
      coa_section_title: 'Type the title, or choose Same as default',
    })
  })
  it('blocks Custom footnotes with no filled-in rows', () => {
    const d = {
      ...setChoice(NASAL, 'coa_footnotes', 'custom', DEFAULTS),
      footnotes: [{ label: ' ', text: '' }],
    }
    expect(draftErrors(d)).toEqual({
      coa_footnotes: 'Type the text, or choose Leave off',
    })
  })
  it('lets a half-filled footnote through for the backend to reject, as the Default does', () => {
    const d = {
      ...setChoice(NASAL, 'coa_footnotes', 'custom', DEFAULTS),
      footnotes: [{ label: 'a', text: '' }],
    }
    expect(draftErrors(d)).toEqual({})
    expect(draftToWire(d).coa_footnotes).toEqual([{ label: 'a', text: '' }])
  })
})

describe('isDraftDirty', () => {
  it('is clean for an untouched new card', () =>
    expect(isDraftDirty(NASAL, null)).toBe(false))
  it('is clean after flipping a choice and back', () => {
    const d = setChoice(
      setChoice(NASAL, 'coa_prep_text', 'off', DEFAULTS),
      'coa_prep_text',
      'default',
      DEFAULTS
    )
    expect(isDraftDirty(d, null)).toBe(false)
  })
  it('is dirty against the saved row', () => {
    const saved = { ...baseVariant, coa_prep_text: 'Diluted' }
    expect(isDraftDirty(draftFromVariant(saved), saved)).toBe(false)
    expect(
      isDraftDirty(
        setChoice(draftFromVariant(saved), 'coa_prep_text', 'off', DEFAULTS),
        saved
      )
    ).toBe(true)
  })
  // The column is JSONB, which stores keys shortest first, so saved rows come back text before label.
  it('is clean when saved footnotes come back with their keys reordered', () => {
    const saved = { ...baseVariant, coa_footnotes: [{ text: 'T', label: 'L' }] }
    expect(isDraftDirty(draftFromVariant(saved), saved)).toBe(false)
  })
})

describe('summary lines', () => {
  it('summarizes the card', () => {
    expect(
      summaryLine({ ...allNull, coa_basis_note: '', coa_prep_text: 'x' })
    ).toBe('Overrides: basis note left off, prep custom')
    expect(summaryLine(allNull)).toBe('Same as default (no changes yet)')
  })
  it('names what a form overrides, for the Default block', () => {
    const v = {
      ...baseVariant,
      coa_basis_note: '',
      coa_prep_text: 'x',
      coa_footnotes: [],
    }
    expect(overrideLine(v)).toBe(
      'Nasal Spray overrides basis note, prep and footnotes'
    )
    expect(overrideLine(baseVariant)).toBeNull()
  })
})

describe('guard line', () => {
  it('is green only when every call worked and every member has a rule', () => {
    const s = memberRuleStatus(
      4,
      [
        member('Arsenic', [rule({})]),
        member('Lead', [rule({ rule_kind: 'range' })]),
      ],
      false
    )
    expect(s).toMatchObject({
      kind: 'ok',
      count: 2,
      peptideRule: false,
      allReportOnly: false,
    })
    expect(guardMessage(s, 'Nasal Spray')).toBe(
      "All 2 services have a Nasal Spray rule, so this version's basis note and footnotes print."
    )
  })
  it('counts one service in the singular', () => {
    expect(
      guardMessage(
        memberRuleStatus(4, [member('Arsenic', [rule({})])], false),
        'Nasal Spray'
      )
    ).toBe(
      "The 1 service has a Nasal Spray rule, so this version's basis note and footnotes print."
    )
  })
  it('is never green on a failed call or with no members', () => {
    const failed = memberRuleStatus(
      4,
      [member('Arsenic', [rule({})]), member('Lead', undefined, true)],
      false
    )
    expect(failed.kind).toBe('unknown')
    expect(memberRuleStatus(4, [], false).kind).toBe('unknown')
    expect(guardMessage(failed, 'Nasal Spray')).toBe(
      'Could not confirm the Nasal Spray rules.'
    )
  })
  it('says it is checking while anything loads', () => {
    expect(
      memberRuleStatus(4, [member('Arsenic', undefined)], false).kind
    ).toBe('loading')
    expect(memberRuleStatus(4, [], true).kind).toBe('loading')
    expect(guardMessage({ kind: 'loading' }, 'Nasal Spray')).toBe(
      'Checking the Nasal Spray rules...'
    )
  })
  it('does not count another form or a peptide row as a rule, and names who is missing', () => {
    const s = memberRuleStatus(
      4,
      [
        member('Arsenic', [rule({ sample_form_id: 9 })]),
        member('Lead', [rule({})]),
      ],
      false
    )
    expect(s).toMatchObject({ kind: 'held', missing: [{ name: 'Arsenic' }] })
    expect(guardMessage(s, 'Nasal Spray')).toBe(
      'Arsenic has no Nasal Spray rule, so it is judged on its general limits. A Nasal Spray COA that includes it keeps the Default basis note and footnotes. Title, method and prep still use this version.'
    )
    expect(heldNote(s)).toBe(
      'Held: the Default prints on a COA that includes Arsenic'
    )
  })
  it('words several missing services', () => {
    const s = memberRuleStatus(
      4,
      [member('Arsenic', []), member('Lead', [])],
      false
    )
    expect(guardMessage(s, 'Nasal Spray')).toBe(
      'Arsenic and Lead have no Nasal Spray rule, so they are judged on their general limits. A Nasal Spray COA that includes any of them keeps the Default basis note and footnotes. Title, method and prep still use this version.'
    )
    expect(heldNote(s)).toBe(
      'Held: the Default prints on a COA that includes Arsenic or Lead'
    )
  })
  it('is report only when every form row is informational, whatever another form files', () => {
    const s = memberRuleStatus(
      4,
      [
        member('Arsenic', [
          rule({}),
          rule({ sample_form_id: 9, rule_kind: 'range' }),
        ]),
        member('Lead', [rule({})]),
      ],
      false
    )
    expect(s).toMatchObject({ kind: 'ok', allReportOnly: true })
  })
  it('is not report only when a member has one range form row', () => {
    const s = memberRuleStatus(
      4,
      [
        member('Arsenic', [rule({}), rule({ rule_kind: 'range' })]),
        member('Lead', [rule({})]),
      ],
      false
    )
    expect(s).toMatchObject({ kind: 'ok', allReportOnly: false })
  })
  it('adds the peptide sentence to either line, only when a member has a peptide rule', () => {
    const s = memberRuleStatus(
      4,
      [
        member('Arsenic', [
          rule({}),
          rule({ sample_form_id: null, peptide_id: 7 }),
        ]),
      ],
      false
    )
    expect(guardMessage(s, 'Nasal Spray')).toMatch(
      / A peptide-specific rule also keeps the Default basis note and footnotes\.$/
    )
  })
})

describe('buildPreview', () => {
  const ok = {
    kind: 'ok',
    count: 2,
    peptideRule: false,
    allReportOnly: false,
  } as const
  const held: RuleStatus = {
    kind: 'held',
    missing: [{ serviceId: 1, name: 'Arsenic' }],
    peptideRule: false,
  }
  const off = setChoice(
    setChoice(NASAL, 'coa_basis_note', 'off', DEFAULTS),
    'coa_footnotes',
    'off',
    DEFAULTS
  )

  it('tags Default, the form name, and what is missing', () => {
    const p = buildPreview(off, DEFAULTS, ok)
    expect(p.title).toMatchObject({ text: 'Heavy Metals', tag: 'Default' })
    expect(p.prep).toMatchObject({
      text: 'Hot block digestion',
      tag: 'Default',
    })
    expect(p.basis).toMatchObject({
      text: null,
      missing: 'no basis note',
      tag: 'Nasal Spray',
    })
    expect(p.footnotes).toEqual({ items: [], tag: 'Nasal Spray' })
  })
  it('holds the limit fields back with Default, held, but not prep', () => {
    let d = setChoice(off, 'coa_prep_text', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_prep_text: 'Diluted' } }
    const p = buildPreview(d, DEFAULTS, held)
    expect(p.basis).toMatchObject({
      text: 'Basis: USP<232>',
      tag: 'Default, held',
    })
    expect(p.footnotes).toEqual({
      items: DEFAULTS.coa_footnotes,
      tag: 'Default, held',
    })
    expect(p.prep).toMatchObject({ text: 'Diluted', tag: 'Nasal Spray' })
  })
  it('follows the 1.55.0 hide for a basis note on Same as default', () => {
    const p = buildPreview(NASAL, DEFAULTS, { ...ok, allReportOnly: true })
    expect(p.basis).toMatchObject({
      text: null,
      missing: 'no basis note',
      tag: 'Default, hidden: every row is report only',
    })
    expect(buildPreview(NASAL, DEFAULTS, ok).basis).toMatchObject({
      text: 'Basis: USP<232>',
      tag: 'Default',
    })
  })
  it('notes a macro, which prints as typed', () => {
    let d = setChoice(NASAL, 'coa_prep_text', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_prep_text: '[LOD {lod}.]' } }
    const p = buildPreview(d, DEFAULTS, ok)
    expect(p.prep.text).toBe('[LOD {lod}.]')
    expect(p.macroNote).toBe(true)
    expect(buildPreview(NASAL, DEFAULTS, ok).macroNote).toBe(false)
  })
  it('does not note a macro in a custom title, which is never filled', () => {
    let d = setChoice(NASAL, 'coa_section_title', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_section_title: 'Metals {lod}' } }
    const p = buildPreview(d, DEFAULTS, ok)
    expect(p.title.text).toBe('Metals {lod}')
    expect(p.macroNote).toBe(false)
  })
})
