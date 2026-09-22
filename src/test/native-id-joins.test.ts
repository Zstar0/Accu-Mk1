/**
 * Three joins that used something weaker than an id now use the id:
 *   1. SLA: a row resolves its service through its own FK, not its keyword.
 *   2. Vial page -> parent row: promoted_to_parent_id only, no keyword guess.
 *   (3. the parent retest route: backend test_parent_retest_by_row_id.py and
 *       the wire assertion in native-parent-analyses.test.tsx.)
 */
import { describe, it, expect } from 'vitest'
import {
  buildKeywordToServiceIdMap,
  resolveSampleTier,
  serviceIdOfAnalysis,
} from '@/lib/sla-resolution'
import { resolvePromotedSourceParentState } from '@/lib/native-parent-analyses'
import type { AnalysisServiceRecord, SenaiteAnalysis, SlaTier } from '@/lib/api'

const svc = (id: number, keyword: string, origin: 'mk1' | 'senaite') =>
  ({ id, keyword, origin }) as AnalysisServiceRecord

const tier = (id: number, target_minutes: number) =>
  ({ id, name: `t${id}`, target_minutes }) as SlaTier

describe('SLA resolves a row through its own service FK', () => {
  // Two services share a keyword across origins. The partial unique index
  // only covers origin='mk1', so this shape is legal.
  const services = [svc(10, 'PURITY', 'mk1'), svc(99, 'PURITY', 'senaite')]
  const kwMap = buildKeywordToServiceIdMap(services)

  it('keyword alone is last-writer-wins (the hazard)', () => {
    expect(kwMap.get('PURITY')).toBe(99)
  })

  it("the row's analysis_service_id wins over the keyword", () => {
    expect(
      serviceIdOfAnalysis({ analysis_service_id: 10, keyword: 'PURITY' }, kwMap)
    ).toBe(10)
  })

  it('a row with no FK (SENAITE-sourced) still resolves by keyword', () => {
    expect(serviceIdOfAnalysis({ keyword: 'PURITY' }, kwMap)).toBe(99)
    expect(serviceIdOfAnalysis({ keyword: 'NOPE' }, kwMap)).toBeUndefined()
  })

  it('the sample tier follows the FK, not the colliding keyword', () => {
    const fast = tier(2, 240)
    const slow = tier(3, 6720)
    const serviceToGroupTier = new Map([[10, fast], [99, slow]])
    const native = { keyword: 'PURITY', analysis_service_id: 10 } as SenaiteAnalysis
    const got = resolveSampleTier(
      { analyses: [native], priority: null },
      kwMap, serviceToGroupTier, new Map(), tier(1, 1440)
    )
    expect(got?.id).toBe(2)
  })
})

describe('vial row -> its parent row', () => {
  const parent = (id: number, review_state: string) =>
    ({ uid: `mk1:${id}`, keyword: 'HPLC-PURITY', review_state }) as SenaiteAnalysis
  const rows = [parent(11, 'published'), parent(12, 'verified')]

  it('joins on promoted_to_parent_id', () => {
    expect(resolvePromotedSourceParentState(rows, 'HPLC-PURITY', 11)).toBe('published')
  })

  it('an id that is not in the list fails closed, never a keyword guess', () => {
    expect(resolvePromotedSourceParentState(rows, 'HPLC-PURITY', 999)).toBeNull()
  })

  it('no id at all (a caller with only a keyword) keeps keyword-newest', () => {
    expect(resolvePromotedSourceParentState(rows, 'HPLC-PURITY')).toBe('verified')
  })
})
