/**
 * Native blends carry one row PER analyte slot under ONE generic keyword and
 * ONE service (HPLC-PURITY x3). Keyword, and service id alone, are therefore
 * not identities. These pin the two maps that used to collapse across slots.
 * Row shapes mirror real `priority` stack data (PB-1001: service 230, slots
 * 1-3 on both tiers; P-5007: a single, slot 1).
 */
import { describe, it, expect } from 'vitest'
import {
  buildVialAssignmentMap,
  vialAssignmentKey,
  type VialInput,
} from '@/lib/vial-assignment'
import {
  isLockedByParent,
  parentLineStateKey,
} from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

const PURITY_SERVICE = 230

const row = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({
    keyword: 'HPLC-PURITY',
    analysis_service_id: PURITY_SERVICE,
    review_state: 'to_be_verified',
    retested: false,
    title: '',
    ...over,
  }) as SenaiteAnalysis

const vial = (analyses: SenaiteAnalysis[]): VialInput => ({
  sampleId: 'PB-1001-S01',
  label: 'Vial 1',
  analyses,
  assignmentRole: 'hplc',
  assignmentKind: 'core',
  varianceLocked: false,
})

describe('vial assignment map on a native blend', () => {
  const parents = [1, 2, 3].map(slot => row({ uid: `mk1:${3784 + slot}`, slot }))
  const vialRows = [1, 2, 3].map(slot =>
    row({ uid: `mk1:${3769 + slot}`, slot, result: `99.${slot}` })
  )

  it("each parent slot joins ITS OWN slot's vial row", () => {
    const map = buildVialAssignmentMap(parents, [vial(vialRows)])
    for (const [i, p] of parents.entries()) {
      const match = map.get(vialAssignmentKey(p))?.matches[0]?.mk1Analysis
      // The overlay row is where a parent-row method/instrument edit is
      // written, so the wrong slot here is a write to the wrong analysis.
      expect(match?.uid).toBe(vialRows[i]!.uid)
      expect(match?.slot).toBe(i + 1)
    }
    expect(map.size).toBe(3)
  })

  it('a slot with no vial row gets no entry, never a sibling by keyword', () => {
    const map = buildVialAssignmentMap(parents, [vial([vialRows[0]!])])
    expect(map.get(vialAssignmentKey(parents[0]!))).toBeDefined()
    expect(map.get(vialAssignmentKey(parents[1]!))).toBeUndefined()
    expect(map.get(vialAssignmentKey(parents[2]!))).toBeUndefined()
  })

  it('a native single (one slot) joins as before', () => {
    const parent = row({ uid: 'mk1:3753', slot: 1 })
    const v = row({ uid: 'mk1:3726', slot: 1 })
    const map = buildVialAssignmentMap([parent], [vial([v])])
    expect(map.get(vialAssignmentKey(parent))?.matches[0]?.mk1Analysis.uid).toBe('mk1:3726')
  })

  it('a slot-less native row (blend aggregate) still joins on service id', () => {
    const parent = row({ uid: 'mk1:3780', keyword: 'HPLC-BLEND-PURITY', analysis_service_id: 232, slot: null })
    const v = row({ uid: 'mk1:3778', keyword: 'HPLC-BLEND-PURITY', analysis_service_id: 232, slot: null })
    const map = buildVialAssignmentMap([parent], [vial([v])])
    expect(map.get(vialAssignmentKey(parent))?.matches[0]?.mk1Analysis.uid).toBe('mk1:3778')
  })
})

describe('parent lock map on a native blend', () => {
  it('keys a per-slot row by (service, slot) and a slot-less row by keyword', () => {
    expect(parentLineStateKey(row({ slot: 2 }))).toBe('svc:230:2')
    expect(parentLineStateKey(row({ slot: null, keyword: 'ENDO-LAL' }))).toBe('ENDO-LAL')
    expect(
      parentLineStateKey(row({ slot: 1, analysis_service_id: null, keyword: 'ID_X' }))
    ).toBe('ID_X')
  })

  it("one verified slot no longer locks the other slots' vial rows", () => {
    // Slot 1 verified; slot 2 was retested from the parent, so its parent
    // row is gone and its fresh vial row must stay promotable.
    const states = { 'svc:230:1': 'verified', 'svc:230:3': 'verified' }
    expect(isLockedByParent(row({ slot: 1 }), states)).toBe(true)
    expect(isLockedByParent(row({ slot: 2 }), states)).toBe(false)
    expect(isLockedByParent(row({ slot: 3 }), states)).toBe(true)
  })

  it('legacy slot-less rows lock by keyword exactly as before', () => {
    const states = { 'ENDO-LAL': 'verified' }
    const endo = row({ slot: null, keyword: 'ENDO-LAL', analysis_service_id: 12 })
    expect(isLockedByParent(endo, states)).toBe(true)
  })
})
