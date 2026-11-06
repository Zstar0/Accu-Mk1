import { describe, expect, it } from 'vitest'
import { groupAnalysesByTitle } from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

const a = (over: Partial<SenaiteAnalysis>) => over as SenaiteAnalysis

describe('groupAnalysesByTitle', () => {
  it('keeps a native retest chain nested after a relabel changed the title (P-5866)', () => {
    const old = a({ uid: 'mk1:66716', title: 'TB500 (Thymosin Beta 4) - Purity (HPLC)', analysis_service_id: 294, slot: 1, retested: true })
    const cur = a({ uid: 'mk1:67883', title: 'TB500 (17-23 Fragment) - Purity (HPLC)', analysis_service_id: 294, slot: 1, retested: false })
    const groups = groupAnalysesByTitle([old, cur])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.current.uid).toBe('mk1:67883')
    expect(groups[0]!.history.map(h => h.uid)).toEqual(['mk1:66716'])
  })

  it('keeps blend slots apart and slot-less rows on the title key', () => {
    const s1 = a({ uid: '1', title: 'BPC-157 - Purity (HPLC)', analysis_service_id: 294, slot: 1 })
    const s2 = a({ uid: '2', title: 'TB-500 - Purity (HPLC)', analysis_service_id: 294, slot: 2 })
    const legacyA = a({ uid: '3', title: 'Endotoxin', analysis_service_id: 10, slot: null })
    const legacyB = a({ uid: '4', title: 'Endotoxin', analysis_service_id: 10, slot: null })
    const groups = groupAnalysesByTitle([s1, s2, legacyA, legacyB])
    expect(groups.map(g => g.current.uid)).toEqual(['1', '2', '4'])
  })
})
