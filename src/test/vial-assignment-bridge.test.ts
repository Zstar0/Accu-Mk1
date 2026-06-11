/** buildVialAssignmentMap join bridges. The parent blend AR carries GENERIC
 *  per-analyte keywords (ANALYTE-{n}-PUR/QTY); HPLC vial mirrors carry the
 *  TRANSLATED per-substance keywords (PUR_<X>/QTY_<X>, titles
 *  "{Peptide} - Purity|Quantity" — seeder contract). The analyte bridge joins
 *  them via the slot→peptide map (analyteNameMap), mirroring the seeder's
 *  slot translation. Surfaced by the container-parent model, where the
 *  overlay is the parent→vial navigation pre-promote (PB-0077). */
import { describe, it, expect } from 'vitest'
import { buildVialAssignmentMap, type VialInput } from '@/lib/vial-assignment'
import type { SenaiteAnalysis } from '@/lib/api'

const pa = (keyword: string, title: string): SenaiteAnalysis =>
  ({ uid: `sen-${keyword}`, keyword, title, review_state: 'unassigned' }) as SenaiteAnalysis

const va = (keyword: string, title: string): SenaiteAnalysis =>
  ({ uid: `mk1:${keyword}`, keyword, title, review_state: 'unassigned' }) as SenaiteAnalysis

const vial = (sampleId: string, analyses: SenaiteAnalysis[]): VialInput => ({
  sampleId,
  label: 'Vial 1',
  analyses,
  assignmentRole: 'hplc',
  assignmentKind: 'core',
})

const ANALYTES = new Map<number, string>([
  [1, 'GHK-Cu'],
  [2, 'BPC-157'],
  [3, 'TB500 (Thymosin Beta 4)'],
])

describe('analyte bridge (ANALYTE-{n}-PUR/QTY ↔ PUR_/QTY_<X>)', () => {
  const vials = [
    vial('PB-0077-S01', [
      va('PUR_GHKCU', 'GHK-Cu - Purity'),
      va('QTY_GHKCU', 'GHK-Cu - Quantity'),
      va('PUR_BPC157', 'BPC-157 - Purity'),
      va('PUR_TB500BETA4', 'TB500 (Thymosin Beta 4) - Purity'),
      va('BLEND-PUR', 'Blend Purity'),
    ]),
  ]

  it('joins a generic parent analyte row to the slot peptide vial row', () => {
    const map = buildVialAssignmentMap(
      [pa('ANALYTE-1-PUR', 'Analyte 1 (Purity)')], vials, ANALYTES)
    expect(map.get('ANALYTE-1-PUR')?.matches[0]?.vialSampleId).toBe('PB-0077-S01')
    expect(map.get('ANALYTE-1-PUR')?.matches[0]?.mk1Analysis.keyword).toBe('PUR_GHKCU')
  })

  it('matches category exactly — QTY parent row never joins a PUR vial row', () => {
    const map = buildVialAssignmentMap(
      [pa('ANALYTE-2-QTY', 'Analyte 2 (Quantity)')], vials, ANALYTES)
    expect(map.get('ANALYTE-2-QTY')).toBeUndefined() // S01 has no QTY_BPC157 row
  })

  it('anchors on the slot peptide — parenthesized names join their own row', () => {
    const map = buildVialAssignmentMap(
      [pa('ANALYTE-3-PUR', 'Analyte 3 (Purity)')], vials, ANALYTES)
    expect(map.get('ANALYTE-3-PUR')?.matches[0]?.mk1Analysis.keyword).toBe('PUR_TB500BETA4')
  })

  it('no analyte map -> no bridge (back-compat for callers without it)', () => {
    const map = buildVialAssignmentMap(
      [pa('ANALYTE-1-PUR', 'Analyte 1 (Purity)')], vials)
    expect(map.get('ANALYTE-1-PUR')).toBeUndefined()
  })

  it('empty slot -> skipped (mirrors the seeder skip_empty_slot)', () => {
    const map = buildVialAssignmentMap(
      [pa('ANALYTE-4-PUR', 'Analyte 4 (Purity)')], vials, ANALYTES)
    expect(map.get('ANALYTE-4-PUR')).toBeUndefined()
  })

  it('exact keyword match still wins first (unchanged behavior)', () => {
    const map = buildVialAssignmentMap(
      [pa('BLEND-PUR', 'Blend Purity')], vials, ANALYTES)
    expect(map.get('BLEND-PUR')?.matches[0]?.mk1Analysis.keyword).toBe('BLEND-PUR')
  })
})
