import { describe, it, expect } from 'vitest'
import {
  computePrimaryAnalysisUids,
  patchAnalysisInList,
} from '@/components/senaite/vial-quicklook-helpers'
import type { SenaiteAnalysis } from '@/lib/api'

const mkAnalysis = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({
    uid: 'mk1:1',
    keyword: 'ENDO',
    title: 'Endotoxin',
    result: '',
    review_state: 'unassigned',
    service_group_name: 'Microbiology',
    ...over,
  }) as SenaiteAnalysis

describe('computePrimaryAnalysisUids', () => {
  const analyses = [
    mkAnalysis({ uid: 'mk1:1', keyword: 'ENDO', service_group_name: 'Microbiology' }),
    mkAnalysis({ uid: 'mk1:2', keyword: 'STER-PCR', service_group_name: 'Microbiology' }),
    mkAnalysis({ uid: 'mk1:3', keyword: 'PUR-HPLC', service_group_name: 'Analytics' }),
  ]

  it('hplc role marks Analytics-group analyses primary', () => {
    expect(computePrimaryAnalysisUids(analyses, 'hplc')).toEqual(new Set(['mk1:3']))
  })

  it('endo role marks ENDO-prefixed keywords primary', () => {
    expect(computePrimaryAnalysisUids(analyses, 'endo')).toEqual(new Set(['mk1:1']))
  })

  it('ster role marks STER-prefixed keywords primary', () => {
    expect(computePrimaryAnalysisUids(analyses, 'ster')).toEqual(new Set(['mk1:2']))
  })

  it('xtra and null roles mark nothing primary', () => {
    expect(computePrimaryAnalysisUids(analyses, 'xtra').size).toBe(0)
    expect(computePrimaryAnalysisUids(analyses, null).size).toBe(0)
  })

  it('skips analyses without a uid', () => {
    const noUid = [mkAnalysis({ uid: undefined as unknown as string, keyword: 'ENDO' })]
    expect(computePrimaryAnalysisUids(noUid, 'endo').size).toBe(0)
  })
})

describe('patchAnalysisInList', () => {
  it('patches result and review_state on the matching uid only', () => {
    const list = [
      mkAnalysis({ uid: 'mk1:1', result: '', review_state: 'unassigned' }),
      mkAnalysis({ uid: 'mk1:2', result: '5.0', review_state: 'to_be_verified' }),
    ]
    const out = patchAnalysisInList(list, 'mk1:1', '9.9', 'to_be_verified')
    expect(out[0]).toMatchObject({ result: '9.9', review_state: 'to_be_verified' })
    expect(out[1]).toBe(list[1]) // untouched rows keep identity
  })

  it('keeps the existing review_state when newReviewState is undefined', () => {
    const list = [mkAnalysis({ uid: 'mk1:1', review_state: 'unassigned' })]
    const out = patchAnalysisInList(list, 'mk1:1', '1.0', undefined)
    expect(out[0]).toMatchObject({ result: '1.0', review_state: 'unassigned' })
  })

  it('keeps the existing review_state when newReviewState is null', () => {
    const list = [mkAnalysis({ uid: 'mk1:1', review_state: 'unassigned' })]
    const out = patchAnalysisInList(list, 'mk1:1', '1.0', null)
    expect(out[0]).toMatchObject({ result: '1.0', review_state: 'unassigned' })
  })
})
