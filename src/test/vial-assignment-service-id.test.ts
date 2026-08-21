/** buildVialAssignmentMap tier 0 — service-id identity (S3).
 *
 *  On mk1-origin rows the analysis_service FK is the identity and the stored
 *  keyword is a display-only alias: a catalog re-label leaves the row's stored
 *  keyword behind, so parent and vial rows for the SAME service can carry
 *  different keyword strings. Tier 0 joins them on the id the backend now ships
 *  (`analysis_service_id`, see _serialize_senaite_shape_rows). SENAITE rows
 *  carry no id and keep today's exact-keyword behavior — tier 1.
 *
 *  Fixture idiom mirrors src/lib/__tests__/vial-assignment.test.ts: a full
 *  factory rather than a partial cast, so a mistyped field is a compile error.
 */
import { describe, it, expect } from 'vitest'
import type { SenaiteAnalysis } from '@/lib/api'
import { buildVialAssignmentMap, type VialInput } from '@/lib/vial-assignment'

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

const vial = (sampleId: string, label: string, analyses: SenaiteAnalysis[]): VialInput =>
  ({ sampleId, label, analyses })

describe('service-id tier 0', () => {
  it('matches parent to vial by analysis_service_id when keywords differ (drift)', () => {
    const parent = [an({ keyword: 'PUR_OLD', title: 'BPC-157 - Purity', analysis_service_id: 42 })]
    const vials = [vial('P-1-S02', 'Vial 3', [
      an({ uid: 'mk1:10', keyword: 'PUR_NEW', analysis_service_id: 42 }),
    ])]
    // Result map stays keyed by the PARENT row's keyword (consumer contract).
    const a = buildVialAssignmentMap(parent, vials).get('PUR_OLD')
    expect(a?.matches.map(m => m.vialSampleId)).toEqual(['P-1-S02'])
    expect(a?.matches[0]?.mk1Analysis.uid).toBe('mk1:10')
    expect(a?.editable).toBe(true)
  })

  it('falls back to exact keyword when service ids are absent (senaite rows)', () => {
    const parent = [an({ keyword: 'HPLC-PUR', title: 'Peptide Purity (HPLC)' })]
    const vials = [vial('P-1-S02', 'Vial 3', [an({ uid: 'sen-1', keyword: 'HPLC-PUR' })])]
    const a = buildVialAssignmentMap(parent, vials).get('HPLC-PUR')
    expect(a?.matches.map(m => m.vialSampleId)).toEqual(['P-1-S02'])
    expect(a?.editable).toBe(true)
  })

  it('falls through to keyword when the parent has an id no vial carries', () => {
    // Native parent row, SENAITE-shaped vial rows (no ids): tier 0 finds
    // nothing and must not short-circuit the rest of the ladder.
    const parent = [an({ keyword: 'HPLC-PUR', title: 'Peptide Purity (HPLC)', analysis_service_id: 42 })]
    const vials = [vial('P-1-S02', 'Vial 3', [an({ uid: 'sen-1', keyword: 'HPLC-PUR' })])]
    expect(buildVialAssignmentMap(parent, vials).get('HPLC-PUR')?.editable).toBe(true)
  })

  it('does not cross-match different service ids sharing a keyword', () => {
    // Two vials carry the same keyword string; only one is the parent's
    // service. Under exact-keyword alone both matched and the row went
    // non-editable — tier 0 keeps it to the id-equal vial.
    const parent = [an({ keyword: 'PUR_X', title: 'Purity', analysis_service_id: 42 })]
    const vials = [
      vial('P-1-S02', 'Vial 3', [an({ uid: 'mk1:20', keyword: 'PUR_X', analysis_service_id: 43 })]),
      vial('P-1-S03', 'Vial 4', [an({ uid: 'mk1:21', keyword: 'PUR_X', analysis_service_id: 42 })]),
    ]
    const a = buildVialAssignmentMap(parent, vials).get('PUR_X')
    expect(a?.matches.map(m => m.vialSampleId)).toEqual(['P-1-S03'])
    expect(a?.matches[0]?.mk1Analysis.uid).toBe('mk1:21')
    expect(a?.editable).toBe(true)
  })

  it('tier 0 honors the live-row rules: drops dead rows, prefers non-retested', () => {
    const parent = [an({ keyword: 'PUR_OLD', title: 'Purity', analysis_service_id: 42 })]
    const vials = [vial('P-1-S02', 'Vial 3', [
      an({ uid: 'mk1:30', keyword: 'PUR_NEW', analysis_service_id: 42, review_state: 'retracted' }),
      an({ uid: 'mk1:31', keyword: 'PUR_NEW', analysis_service_id: 42, retested: true }),
      an({ uid: 'mk1:32', keyword: 'PUR_NEW', analysis_service_id: 42, review_state: 'verified' }),
    ])]
    const a = buildVialAssignmentMap(parent, vials).get('PUR_OLD')
    expect(a?.matches).toHaveLength(1)
    expect(a?.matches[0]?.mk1Analysis.uid).toBe('mk1:32')
  })

  it('one service on two vials → both matches, not editable', () => {
    const parent = [an({ keyword: 'STER-PCR', title: 'Sterility', analysis_service_id: 55 })]
    const vials = [
      vial('P-1-S02', 'Vial 3', [an({ uid: 'mk1:40', keyword: 'STER-A', analysis_service_id: 55 })]),
      vial('P-1-S03', 'Vial 4', [an({ uid: 'mk1:41', keyword: 'STER-B', analysis_service_id: 55 })]),
    ]
    const a = buildVialAssignmentMap(parent, vials).get('STER-PCR')
    expect(a?.matches.map(m => m.vialSampleId)).toEqual(['P-1-S02', 'P-1-S03'])
    expect(a?.editable).toBe(false)
  })
})
