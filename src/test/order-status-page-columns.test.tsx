import { describe, it, expect } from 'vitest'
import {
  COL_ANALYSIS_STATES,
  getAnalysisServicesForCol,
} from '@/components/OrderStatusPage'
import type { SenaiteAnalysis } from '@/lib/api'

// No prior unit coverage existed for COL_ANALYSIS_STATES or
// getAnalysisServicesForCol — both were module-private. This file is new,
// added alongside exporting them, to pin the board-column classification of
// 'parent_to_verify' (promoted parent awaiting sign-off) rows.
describe('COL_ANALYSIS_STATES / getAnalysisServicesForCol — to_verify column', () => {
  it('includes parent_to_verify in the to_verify column state list', () => {
    expect(COL_ANALYSIS_STATES.to_verify).toContain('parent_to_verify')
  })

  it('a parent_to_verify analysis surfaces under the to_verify column, not dropped from the board', () => {
    const analyses = [
      { title: 'Heavy Metals', review_state: 'parent_to_verify' } as unknown as SenaiteAnalysis,
    ]
    expect(getAnalysisServicesForCol(analyses, 'to_verify')).toEqual(['Heavy Metals'])
  })
})
