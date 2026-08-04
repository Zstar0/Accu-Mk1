import { describe, expect, it } from 'vitest'
import {
  buildBulkParentRetestImpact,
  buildParentRetestImpact,
} from '@/lib/native-parent-analyses'
import type { ParentPromotionInfo } from '@/lib/api'

const promo = (keyword: string, ids: (string | null)[]): ParentPromotionInfo => ({
  keyword,
  parent_analysis_id: 1,
  promoted_at: '2026-08-01T00:00:00Z',
  sources: ids.map(sample_id => ({ sample_id, contribution_kind: 'primary' })),
})

describe('buildParentRetestImpact', () => {
  it('counts sources and collects vial ids', () => {
    expect(buildParentRetestImpact(promo('HM', ['P-1-S01', 'P-1-S02']))).toEqual({
      sourceCount: 2,
      vialIds: ['P-1-S01', 'P-1-S02'],
    })
  })
  it('null-sample_id sources count toward sourceCount but not vialIds', () => {
    expect(buildParentRetestImpact(promo('HM', ['P-1-S01', null]))).toEqual({
      sourceCount: 2,
      vialIds: ['P-1-S01'],
    })
  })
  it('fails closed on missing promotion', () => {
    expect(buildParentRetestImpact(undefined)).toEqual({ sourceCount: 0, vialIds: [] })
  })
})

describe('buildBulkParentRetestImpact', () => {
  it('aggregates across keywords and dedupes vial ids', () => {
    const map = new Map([
      ['HM', promo('HM', ['P-1-S01'])],
      ['STER', promo('STER', ['P-1-S01', 'P-1-S03'])],
    ])
    expect(buildBulkParentRetestImpact(['HM', 'STER'], map)).toEqual({
      sourceCount: 3,
      vialIds: ['P-1-S01', 'P-1-S03'],
    })
  })
  it('missing map or keywords contribute zero', () => {
    expect(buildBulkParentRetestImpact(['HM'], undefined)).toEqual({ sourceCount: 0, vialIds: [] })
  })
})
