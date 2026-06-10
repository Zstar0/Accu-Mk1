import { describe, it, expect } from 'vitest'
import type { SenaiteAnalysis } from '@/lib/api'
import { isIdentityAnalysis, buildVialAssignmentMap } from '@/lib/vial-assignment'

// Minimal SenaiteAnalysis factory — only fields the join reads.
function an(partial: Partial<SenaiteAnalysis>): SenaiteAnalysis {
  return {
    uid: null, keyword: null, title: '', result: null, result_options: [], unit: null,
    method: null, method_uid: null, method_options: [], instrument: null,
    instrument_uid: null, instrument_options: [], analyst: null, due_date: null,
    review_state: 'unassigned', sort_key: null, captured: null, retested: false,
    service_group_id: null, service_group_name: null,
    ...partial,
  } as SenaiteAnalysis
}

const vial = (sampleId: string, label: string, analyses: SenaiteAnalysis[]) =>
  ({ sampleId, label, analyses })

describe('isIdentityAnalysis', () => {
  it('matches generic HPLC-ID and per-peptide ID_* keywords', () => {
    expect(isIdentityAnalysis({ keyword: 'HPLC-ID', title: 'Peptide ID (HPLC)' })).toBe(true)
    expect(isIdentityAnalysis({ keyword: 'ID_BPC157', title: 'BPC-157 - Identity (HPLC)' })).toBe(true)
  })
  it('matches by title when keyword is absent', () => {
    expect(isIdentityAnalysis({ keyword: null, title: 'Foo - Identity (HPLC)' })).toBe(true)
  })
  it('is false for non-identity analyses', () => {
    expect(isIdentityAnalysis({ keyword: 'HPLC-PUR', title: 'Peptide Purity (HPLC)' })).toBe(false)
    expect(isIdentityAnalysis({ keyword: 'ENDO-LAL', title: 'Endotoxin' })).toBe(false)
  })
})

describe('buildVialAssignmentMap', () => {
  it('exact keyword match → single editable assignment', () => {
    const parent = [an({ keyword: 'HPLC-PUR', title: 'Peptide Purity (HPLC)' })]
    const vials = [vial('P-1-S02', 'Vial 3', [an({ uid: 'mk1:10', keyword: 'HPLC-PUR' })])]
    const map = buildVialAssignmentMap(parent, vials)
    const a = map.get('HPLC-PUR')!
    expect(a.matches.map(m => m.vialSampleId)).toEqual(['P-1-S02'])
    expect(a.matches[0]!.vialLabel).toBe('Vial 3')
    expect(a.editable).toBe(true)
  })

  it('one keyword on two vials → both matches, not editable', () => {
    const parent = [an({ keyword: 'STER-PCR', title: 'Rapid Sterility Screening (PCR)' })]
    const vials = [
      vial('P-1-S02', 'Vial 3', [an({ uid: 'mk1:20', keyword: 'STER-PCR' })]),
      vial('P-1-S03', 'Vial 4', [an({ uid: 'mk1:21', keyword: 'STER-PCR' })]),
    ]
    const a = buildVialAssignmentMap(parent, vials).get('STER-PCR')!
    expect(a.matches.map(m => m.vialSampleId)).toEqual(['P-1-S02', 'P-1-S03'])
    expect(a.editable).toBe(false)
  })

  it('identity bridge: ID_BPC157 (parent) ↔ HPLC-ID (vial) in a single-peptide family', () => {
    const parent = [an({ keyword: 'ID_BPC157', title: 'BPC-157 - Identity (HPLC)' })]
    const vials = [vial('P-1-S02', 'Vial 3', [an({ uid: 'mk1:30', keyword: 'HPLC-ID', title: 'Peptide ID (HPLC)' })])]
    const a = buildVialAssignmentMap(parent, vials).get('ID_BPC157')!
    expect(a.matches.map(m => m.vialSampleId)).toEqual(['P-1-S02'])
    expect(a.editable).toBe(true)
  })

  it('identity NOT bridged when the parent has 2+ identity analyses (multi-peptide)', () => {
    const parent = [
      an({ keyword: 'ID_BPC157', title: 'BPC-157 - Identity (HPLC)' }),
      an({ keyword: 'ID_TB500', title: 'TB-500 - Identity (HPLC)' }),
    ]
    const vials = [vial('P-1-S02', 'Vial 3', [an({ uid: 'mk1:30', keyword: 'HPLC-ID' })])]
    const map = buildVialAssignmentMap(parent, vials)
    expect(map.get('ID_BPC157')).toBeUndefined()
    expect(map.get('ID_TB500')).toBeUndefined()
  })

  it('no vial carries the keyword → keyword absent from the map', () => {
    const parent = [an({ keyword: 'PEPT-Total', title: 'Peptide Total Quantity' })]
    const vials = [vial('P-1-S02', 'Vial 3', [an({ uid: 'mk1:40', keyword: 'HPLC-PUR' })])]
    expect(buildVialAssignmentMap(parent, vials).get('PEPT-Total')).toBeUndefined()
  })

  it('excludes retracted/rejected vial rows; prefers the live (non-retested) row', () => {
    const parent = [an({ keyword: 'HPLC-PUR', title: 'Peptide Purity (HPLC)' })]
    const vials = [vial('P-1-S02', 'Vial 3', [
      an({ uid: 'mk1:50', keyword: 'HPLC-PUR', review_state: 'retracted' }),
      an({ uid: 'mk1:51', keyword: 'HPLC-PUR', review_state: 'verified', retested: false }),
    ])]
    const a = buildVialAssignmentMap(parent, vials).get('HPLC-PUR')!
    expect(a.matches).toHaveLength(1)
    expect(a.matches[0]!.mk1Analysis.uid).toBe('mk1:51')
  })

  it('returns an empty map when there are no vials', () => {
    const parent = [an({ keyword: 'HPLC-PUR', title: 'Peptide Purity (HPLC)' })]
    expect(buildVialAssignmentMap(parent, []).size).toBe(0)
  })

  it('mixed parent: identity bridges and a non-identity row matches exactly', () => {
    const parent = [
      an({ keyword: 'ID_BPC157', title: 'BPC-157 - Identity (HPLC)' }),
      an({ keyword: 'HPLC-PUR', title: 'Peptide Purity (HPLC)' }),
    ]
    const vials = [vial('P-1-S02', 'Vial 3', [
      an({ uid: 'mk1:60', keyword: 'HPLC-ID' }),
      an({ uid: 'mk1:61', keyword: 'HPLC-PUR' }),
    ])]
    const map = buildVialAssignmentMap(parent, vials)
    expect(map.get('ID_BPC157')!.matches[0]!.mk1Analysis.uid).toBe('mk1:60')
    expect(map.get('HPLC-PUR')!.matches[0]!.mk1Analysis.uid).toBe('mk1:61')
  })
})
