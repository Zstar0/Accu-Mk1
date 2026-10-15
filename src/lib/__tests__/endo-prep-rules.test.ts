import { describe, it, expect } from 'vitest'
// The shared matcher fixture (Task 1): pytest runs the same cases against
// backend/endo_prep_rules.py match_rule.
import fixture from '../../../backend/tests/fixtures/endo_prep_rule_cases.json'
import {
  bandText,
  matchRule,
  rowRule,
  ruleTag,
  ruleText,
  type EndoPrepRule,
  type PrepRuleLock,
} from '@/lib/endo-prep-rules'
import {
  ENDO_RUN_PARAM_DEFAULTS,
  dilutionPlan,
  mk1Value,
  prep2Check,
  targetDilutionOf,
  type EndoCtx,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { endoRowsFor, endoSampleFor } from '@/lib/endo-worksheet-2ml'
import {
  endoItem,
  endoWorksheet,
} from '@/components/hplc/endo/__tests__/endo-fixtures'

// The JSON's status is a plain string to the compiler.
const RULE_SETS = fixture.rule_sets as unknown as Record<string, EndoPrepRule[]>

function rule(over: Partial<EndoPrepRule> = {}): EndoPrepRule {
  return {
    id: 1,
    peptide_id: 7,
    min_mg: null,
    max_mg: null,
    total_dilution: null,
    step1_ratio: null,
    cartridge_type_id: null,
    status: 'trial',
    note: null,
    sort_order: 1,
    active: true,
    ...over,
  }
}

function lock(r: EndoPrepRule | null): PrepRuleLock {
  return {
    rule: r,
    locked_at: '2026-10-14T15:00:00Z',
    locked_by: 'print',
    user_id: 5,
  }
}

describe('matchRule: the shared fixture', () => {
  it.each(fixture.cases)('$name', c => {
    const rules = RULE_SETS[c.rules]
    if (!rules) throw new Error(`no rule set ${c.rules}`)
    const q = c.query
    expect(
      matchRule(rules, {
        peptideId: q.peptide_id,
        weightMg: q.weight_mg,
        isBac: q.is_bac,
        endoPrep: q.endo_prep,
        rulesOff: q.rules_off,
      })?.id ?? null
    ).toBe(c.expect)
  })
})

describe('rowRule', () => {
  const live = [rule({ id: 1, total_dilution: 300 })]
  const q = { peptideId: 7, weightMg: 10, isBac: false, endoPrep: '2ml' }

  it('follows the live match until the row is locked', () => {
    expect(rowRule({}, live, q)?.id).toBe(1)
  })

  it('keeps the locked line, never the live one (Review Focus 1)', () => {
    const old = rule({ id: 1, total_dilution: 400 })
    expect(rowRule({ prep_rule: lock(old) }, live, q)).toEqual(old)
  })

  it('a row locked to the standard stays on it while a rule matches', () => {
    expect(rowRule({ prep_rule: lock(null) }, live, q)).toBeNull()
  })

  it('a row read before it was locked reads the standard, as the server does (final review I1)', () => {
    const read = {
      result_reading: '<0.05',
      result_entered_at: '2026-10-01T09:00:00Z',
    }
    expect(rowRule(read, live, q)).toBeNull()
    expect(
      rowRule({ result_entered_at: '2026-10-01T09:00:00Z' }, live, q)
    ).toBeNull()
    // a lock still wins
    const old = rule({ id: 1, total_dilution: 400 })
    expect(rowRule({ ...read, prep_rule: lock(old) }, live, q)).toEqual(old)
  })

  it('an optimistic first reading, not yet stamped by the server, follows the live match', () => {
    // use-worksheet-drawer merges result_reading alone until the save settles.
    const optimistic = { result_reading: '0.8', result_entered_at: null }
    expect(rowRule(optimistic, live, q)?.id).toBe(1)
  })

  it('a "no rule" row has none, locked or not', () => {
    expect(rowRule({ prep_rules_off: true }, live, q)).toBeNull()
    expect(
      rowRule(
        { prep_rules_off: true, prep_rule: lock(live[0] ?? null) },
        live,
        q
      )
    ).toBeNull()
  })
})

describe('the rule as the lab reads it', () => {
  it('names the band and the values it sets', () => {
    expect(bandText(rule())).toBe('any weight')
    expect(bandText(rule({ max_mg: 30 }))).toBe('up to 30 mg')
    expect(bandText(rule({ min_mg: 30 }))).toBe('above 30 mg')
    expect(bandText(rule({ min_mg: 10, max_mg: 30 }))).toBe(
      'above 10 up to 30 mg'
    )
    expect(
      ruleText(
        rule({ min_mg: 30, total_dilution: 300, cartridge_type_id: 4 }),
        'Retatrutide',
        id => (id === 4 ? '0.01 cartridge' : '?')
      )
    ).toBe('Retatrutide above 30 mg · 1:300 total, 0.01 cartridge')
    expect(ruleText(rule({ max_mg: 30 }), 'Retatrutide')).toBe(
      'Retatrutide up to 30 mg · the standard'
    )
    expect(ruleTag(rule())).toBe('rule (trial)')
    expect(ruleTag(rule({ status: 'validated' }))).toBe('rule')
  })
})

describe('the rule tier in the prep maths: typed > rule > standard, per field', () => {
  const ctx: EndoCtx = {
    params: ENDO_RUN_PARAM_DEFAULTS,
    allowedLambdas: [0.05, 0.01],
  }
  const s = (o: Partial<EndoSample> = {}): EndoSample => ({
    sampleId: 'P-1',
    identity: 'Retatrutide',
    sampleType: null,
    weightMg: 10,
    form: null,
    waterMl: null,
    totalDilution: null,
    steps: null,
    lambda: 0.05,
    reading: null,
    reader: null,
    ...o,
  })

  it('total: the typed one, else the rule, else the standard', () => {
    const r300 = rule({ total_dilution: 300 })
    expect(targetDilutionOf(s(), ctx)).toBe(250)
    expect(targetDilutionOf(s({ rule: r300 }), ctx)).toBe(300)
    expect(targetDilutionOf(s({ rule: r300, totalDilution: 400 }), ctx)).toBe(
      400
    )
    // a rule that leaves the total alone
    expect(targetDilutionOf(s({ rule: rule({ step1_ratio: 5 }) }), ctx)).toBe(
      250
    )
  })

  it('step 1 ratio: the typed one, else the rule, else 1:10; step 2 is derived', () => {
    const r5 = rule({ step1_ratio: 5 })
    const ruled = dilutionPlan(s({ rule: r5 }), ctx)
    expect(
      ruled.steps.map(st => [st.ratio, st.own, st.ruled, st.diluentUl])
    ).toEqual([
      [5, false, true, 80],
      [25, false, true, 480],
      [2, false, false, 125],
    ])
    expect(ruled.total).toBe(250)
    // a ruled step is not the standard, but it was not set by hand either
    expect(ruled.standard).toBe(false)
    const typed = dilutionPlan(
      s({ rule: r5, steps: [{ sampleUl: 20, ratio: 8 }, null, null] }),
      ctx
    )
    expect(typed.steps.map(st => [st.ratio, st.own, st.ruled])).toEqual([
      [8, true, false],
      [15.625, false, false],
      [2, false, false],
    ])
    // typing the method's 1:10 over a rule's 1:5 is a value set by hand
    expect(
      dilutionPlan(
        s({ rule: r5, steps: [{ sampleUl: 20, ratio: 10 }, null, null] }),
        ctx
      ).steps[0]?.own
    ).toBe(true)
  })

  it('a typed total beside a ruled step 1 ratio, field by field', () => {
    const p = dilutionPlan(
      s({
        rule: rule({ total_dilution: 300, step1_ratio: 5 }),
        totalDilution: 400,
      }),
      ctx
    )
    expect(p.target).toBe(400)
    expect(p.steps.map(st => [st.ratio, st.ruled])).toEqual([
      [5, true],
      [40, true],
      [2, false],
    ])
  })

  it('a ruled total moves the LOQ and the EU per vial', () => {
    const r300 = rule({ total_dilution: 300 })
    // 0.05 x 250 x 2 mL = 25 on the standard; 0.05 x 300 x 2 = 30 under the rule
    expect(prep2Check(s(), ctx).loqVial).toBe(25)
    expect(prep2Check(s({ rule: r300 }), ctx).loqVial).toBe(30)
    expect(mk1Value(s({ reading: '<0.05' }), ctx)?.value).toBe('<25')
    expect(mk1Value(s({ rule: r300, reading: '<0.05' }), ctx)?.value).toBe(
      '<30'
    )
    expect(mk1Value(s({ rule: r300, reading: '0.8' }), ctx)).toEqual({
      value: '480',
      unit: 'EU/vial',
      verdict: 'fail',
    })
  })
})

describe('rows resolve their rule and its cartridge', () => {
  // endoWorksheet: run cartridge 3 (0.05, the method default); the method
  // allows 3 and 4 (0.01). endoItem: Retatrutide, 10 mg declared.
  const pep = (over: Partial<WorksheetItemRow> = {}) =>
    endoItem({ sample_peptide_id: 7, ...over })

  it('the rule reaches an unlocked row on a 2 mL worksheet', () => {
    const s = endoSampleFor(
      pep(),
      endoWorksheet([]),
      [],
      [rule({ total_dilution: 300 })]
    )
    expect(s.rule?.id).toBe(1)
    expect(
      targetDilutionOf(s, {
        params: ENDO_RUN_PARAM_DEFAULTS,
        allowedLambdas: [],
      })
    ).toBe(300)
  })

  it('cartridge: typed, then the rule when the method allows it, then the run', () => {
    const ws = endoWorksheet([])
    const r4 = [rule({ cartridge_type_id: 4 })]
    const [ruled, typed] = endoRowsFor(
      [pep(), pep({ cartridge_type_id: 3, cartridge_sensitivity_eu_ml: 0.05 })],
      ws,
      [],
      r4
    )
    expect([
      ruled?.cartridge?.id,
      ruled?.sample.lambda,
      ruled?.ruleCartridge,
    ]).toEqual([4, 0.01, true])
    expect([typed?.cartridge?.id, typed?.inherited?.id]).toEqual([3, 4])
    // a cartridge the method does not allow is passed over
    const [off] = endoRowsFor(
      [pep()],
      ws,
      [],
      [rule({ cartridge_type_id: 99 })]
    )
    expect([off?.cartridge?.id, off?.ruleCartridge]).toEqual([3, false])
  })

  it('bac water, a stock worksheet and a blend are never ruled', () => {
    const r = [rule({ total_dilution: 300 })]
    const bw = pep({
      sample_id: 'BW-0114-S02',
      sample_identity: 'Bacteriostatic Water',
      sample_type: 'Bacteriostatic Water',
    })
    expect(endoSampleFor(bw, endoWorksheet([]), [], r).rule).toBeNull()
    expect(
      endoSampleFor(pep(), endoWorksheet([], { endo_prep: 'stock' }), [], r)
        .rule
    ).toBeNull()
    expect(
      endoSampleFor(pep({ sample_peptide_id: null }), endoWorksheet([]), [], r)
        .rule
    ).toBeNull()
    // locked while it was powder, then set to bac: still never ruled, as the
    // server's row_rule (A.0 item 8)
    expect(
      endoSampleFor(
        pep({
          prep_form: 'bac',
          prep_rule: lock(rule({ total_dilution: 300 })),
        }),
        endoWorksheet([]),
        [],
        r
      ).rule
    ).toBeNull()
  })

  it('a locked row keeps its line when the live rule changes', () => {
    const locked = pep({ prep_rule: lock(rule({ total_dilution: 400 })) })
    const s = endoSampleFor(
      locked,
      endoWorksheet([]),
      [],
      [rule({ total_dilution: 300 })]
    )
    expect(s.rule?.total_dilution).toBe(400)
  })

  it('with no rules every row resolves as before', () => {
    const items = [pep(), pep({ prep_total_dilution: 300 })]
    const ws = endoWorksheet(items)
    expect(endoRowsFor(items, ws, [], [])).toEqual(endoRowsFor(items, ws))
    expect(
      endoRowsFor(items, ws).map(r => [r.sample.rule, r.ruleCartridge])
    ).toEqual([
      [null, false],
      [null, false],
    ])
  })
})
