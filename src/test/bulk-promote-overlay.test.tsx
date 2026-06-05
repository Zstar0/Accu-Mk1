import { describe, it, expect } from 'vitest'
import {
  isPromotable,
  visibleRowTransitions,
  deriveBulkActions,
  deriveBulkPromoteBlockers,
} from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

const base: Partial<SenaiteAnalysis> = {
  title: 'Rapid Sterility Screening (PCR)',
  keyword: 'STER-PCR',
  result: '11',
}

function mk(overrides: Partial<SenaiteAnalysis>): SenaiteAnalysis {
  return { ...base, ...overrides } as SenaiteAnalysis
}

const promotable = mk({ uid: 'mk1:820', review_state: 'to_be_verified', promoted_to_parent_id: null })
const senaiteTbv = mk({ uid: 'a8c27e69bfa84ff1bf16a3e370a44456', review_state: 'to_be_verified' })

describe('isPromotable', () => {
  it('true for mk1 uid + to_be_verified + unpromoted', () => {
    expect(isPromotable(promotable)).toBe(true)
  })
  it('false for SENAITE uid', () => {
    expect(isPromotable(senaiteTbv)).toBe(false)
  })
  it('false for wrong state', () => {
    expect(isPromotable(mk({ uid: 'mk1:820', review_state: 'verified' }))).toBe(false)
  })
  it('false when already promoted', () => {
    expect(
      isPromotable(mk({ uid: 'mk1:820', review_state: 'to_be_verified', promoted_to_parent_id: 1260 })),
    ).toBe(false)
  })
})

describe('visibleRowTransitions', () => {
  it('drops verify on a promotable row, keeps escape hatches', () => {
    const t = visibleRowTransitions(promotable)
    expect(t).not.toContain('verify')
    expect(t).toContain('retract')
  })
  it('keeps verify on a SENAITE to_be_verified row', () => {
    expect(visibleRowTransitions(senaiteTbv)).toContain('verify')
  })
  it('still gates submit on having a result', () => {
    const unsubmitted = mk({ uid: 'mk1:9', review_state: 'unassigned', result: null })
    expect(visibleRowTransitions(unsubmitted)).not.toContain('submit')
  })
})

describe('deriveBulkActions', () => {
  it('all-promotable selection: no verify, showPromote true', () => {
    const r = deriveBulkActions([promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO' })])
    expect(r.actions).not.toContain('verify')
    expect(r.showPromote).toBe(true)
  })
  it('mixed selection (promotable + SENAITE): no verify, no promote', () => {
    const r = deriveBulkActions([promotable, senaiteTbv])
    expect(r.actions).not.toContain('verify')
    expect(r.showPromote).toBe(false)
  })
  it('pure SENAITE selection keeps verify', () => {
    const r = deriveBulkActions([senaiteTbv])
    expect(r.actions).toContain('verify')
    expect(r.showPromote).toBe(false)
  })
  it('empty selection: nothing', () => {
    const r = deriveBulkActions([])
    expect(r.actions).toEqual([])
    expect(r.showPromote).toBe(false)
  })
})

describe('deriveBulkPromoteBlockers', () => {
  it('no blockers for distinct keywords with results', () => {
    expect(
      deriveBulkPromoteBlockers([promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO' })]),
    ).toEqual([])
  })
  it('flags missing result', () => {
    const blockers = deriveBulkPromoteBlockers([mk({ uid: 'mk1:9', review_state: 'to_be_verified', result: null })])
    expect(blockers.some(b => b.includes('no result'))).toBe(true)
  })
  it('flags duplicate keywords', () => {
    const blockers = deriveBulkPromoteBlockers([
      promotable,
      mk({ uid: 'mk1:9', review_state: 'to_be_verified', keyword: 'STER-PCR' }),
    ])
    expect(blockers.some(b => b.includes('STER-PCR'))).toBe(true)
  })
})
