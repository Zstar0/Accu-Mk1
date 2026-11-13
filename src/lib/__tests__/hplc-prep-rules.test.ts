import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_DILUENT,
  HPLC_DILUENTS,
  bandText,
  componentTarget,
  matchRule,
  pickLead,
  rowDiluent,
  rowFloor,
  rowInstrument,
  ruleTag,
  ruleText,
  type HplcPrepComponent,
  type HplcPrepRule,
} from '@/lib/hplc-prep-rules'

// The shared matcher fixture (Task 2): pytest runs the same cases against
// backend/hplc_prep_rules.py. Read at run time, not imported, so the
// production `tsc` (whose Docker context has no backend/) never resolves a
// path outside src. Its lines carry the fifteen snapshot keys only.
type Snapshot = Omit<
  HplcPrepRule,
  | 'peptide_name'
  | 'peptide_is_blend'
  | 'lead_component_name'
  | 'default_instrument_name'
  | 'updated_at'
>
interface FixtureCase {
  name: string
  fn: string
  rules: string
  query: {
    peptide_id?: number | null
    weight_mg?: number | null
    in_blend?: boolean
    default?: number
    components?: HplcPrepComponent[]
    row_rule_id?: number | null
    chosen_id?: number | null
  }
  expect: unknown
}
const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../backend/tests/fixtures/hplc_prep_rule_cases.json'
    ),
    'utf8'
  )
) as { rule_sets: Record<string, Snapshot[]>; cases: FixtureCase[] }

/** One case through the function its fn names, as the Python test's _run_case
 *  does: row_rule_id resolves to that rule's snapshot in the case's set. */
function runCase(c: FixtureCase): unknown {
  const rules = fixture.rule_sets[c.rules] ?? []
  const q = c.query
  const rowRule =
    q.row_rule_id == null
      ? null
      : (rules.find(r => r.id === q.row_rule_id) ?? null)
  const components = q.components ?? []
  switch (c.fn) {
    case 'match_rule':
      return (
        matchRule(rules, {
          peptideId: q.peptide_id ?? null,
          weightMg: q.weight_mg ?? null,
        })?.id ?? null
      )
    case 'component_target':
      return componentTarget(rules, {
        peptideId: q.peptide_id ?? null,
        weightMg: q.weight_mg ?? null,
        inBlend: q.in_blend ?? false,
        default: q.default ?? NaN,
      })
    case 'pick_lead':
      return pickLead(rules, components, {
        rowRule,
        chosenId: q.chosen_id ?? null,
      })
    case 'row_diluent':
      return rowDiluent(rules, { rowRule, components })
    case 'row_instrument':
      return rowInstrument(rules, { rowRule, components })
    case 'row_floor':
      return rowFloor(rowRule, { default: q.default ?? NaN })
    default:
      throw new Error(`unknown fn ${c.fn}`)
  }
}

describe('the shared HPLC prep rule fixture', () => {
  it.each(fixture.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(runCase(c)).toEqual(c.expect)
  })

  it('covers every function', () => {
    expect(new Set(fixture.cases.map(c => c.fn))).toEqual(
      new Set([
        'match_rule',
        'component_target',
        'pick_lead',
        'row_diluent',
        'row_instrument',
        'row_floor',
      ])
    )
  })

  it('matchRule returns the snapshot itself, not a copy', () => {
    const rules = fixture.rule_sets.main ?? []
    expect(matchRule(rules, { peptideId: 4, weightMg: 5 })).toBe(rules[3])
  })
})

describe('constants and page helpers', () => {
  it('carries the diluents the backend does', () => {
    expect(HPLC_DILUENTS).toEqual(['Water', 'Water + 0.1% TFA'])
    expect(DEFAULT_DILUENT).toBe('Water')
  })

  const line: HplcPrepRule = {
    id: 3,
    peptide_id: 12,
    min_mg: 5,
    max_mg: 10,
    target_conc_ug_ml: 250,
    blend_target_conc_ug_ml: null,
    lead_component_id: 5,
    lead_priority: null,
    floor_ug_ml: 40,
    diluent: 'Water + 0.1% TFA',
    default_instrument_id: 3,
    status: 'trial',
    note: null,
    sort_order: 1,
    active: true,
    peptide_name: 'Blend X',
    peptide_is_blend: true,
    lead_component_name: 'BPC-157',
    default_instrument_name: '1290B',
    updated_at: null,
  }

  it('words a band as the endo page does', () => {
    expect(bandText(line)).toBe('above 5 up to 10 mg')
    expect(bandText({ min_mg: null, max_mg: null })).toBe('any weight')
  })

  it('words a line from the fields it sets', () => {
    expect(ruleText(line)).toBe(
      'Blend X above 5 up to 10 mg · target 250 ug/mL, lead BPC-157, ' +
        'Water + 0.1% TFA, floor 40 ug/mL, on 1290B'
    )
    expect(
      ruleText({
        ...line,
        peptide_name: 'GHK-Cu',
        min_mg: null,
        max_mg: null,
        target_conc_ug_ml: null,
        blend_target_conc_ug_ml: 350,
        lead_component_id: null,
        lead_priority: 2,
        floor_ug_ml: null,
        diluent: null,
        default_instrument_id: null,
      })
    ).toBe('GHK-Cu any weight · 350 ug/mL in a blend, lead priority 2')
    expect(
      ruleText({
        ...line,
        target_conc_ug_ml: null,
        lead_component_id: null,
        floor_ug_ml: null,
        diluent: null,
        default_instrument_id: null,
      })
    ).toBe('Blend X above 5 up to 10 mg · the standard')
  })

  it('tags a trial line', () => {
    expect(ruleTag(line)).toBe('rule (trial)')
    expect(ruleTag({ status: 'validated' })).toBe('rule')
  })
})
