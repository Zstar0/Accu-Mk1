import { describe, it, expect } from 'vitest'
import {
  buildAllAutoFillMappings,
  round2,
} from '@/components/hplc/SenaiteResultsView'
import type { SenaiteAnalysis, HPLCAnalysisResult } from '@/lib/api'

// Shapes mirror a real slot-style blend AR (PB-0078): per-slot
// "Analyte N (Purity/Quantity)" rows plus the aggregate rows.
function analysis(over: Partial<SenaiteAnalysis>): SenaiteAnalysis {
  return {
    uid: over.title ?? 'uid',
    keyword: null,
    title: '',
    result: null,
    result_options: [],
    unit: null,
    method: null,
    method_uid: null,
    method_options: [],
    instrument: null,
    instrument_uid: null,
    instrument_options: [],
    analyst: null,
    review_state: 'unassigned',
    ...over,
  } as SenaiteAnalysis
}

function hplcResult(over: Partial<HPLCAnalysisResult>): HPLCAnalysisResult {
  return {
    purity_percent: 99,
    quantity_mg: null,
    identity_conforms: true,
    peptide_abbreviation: 'KPV',
    ...over,
  } as HPLCAnalysisResult
}

const BLEND_AR: SenaiteAnalysis[] = [
  analysis({ uid: 'a1p', keyword: 'ANALYTE-1-PUR', title: 'Analyte 1 (Purity)' }),
  analysis({ uid: 'a1q', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)' }),
  analysis({ uid: 'a2p', keyword: 'ANALYTE-2-PUR', title: 'Analyte 2 (Purity)' }),
  analysis({ uid: 'a2q', keyword: 'ANALYTE-2-QTY', title: 'Analyte 2 (Quantity)' }),
  analysis({ uid: 'blp', keyword: 'BLEND-PUR', title: 'Blend Purity' }),
  analysis({ uid: 'tot', keyword: 'PEPT-Total', title: 'Peptide Total Quantity' }),
]

describe('blend AR auto-fill — QTY rounding + slot matching', () => {
  it('total quantity is the sum of ROUNDED per-analyte values (round-then-sum)', () => {
    // 24.564 -> 24.56 and 25.234 -> 25.23; round-then-sum = 49.79.
    // Sum-then-round would give round(49.798) = "49.80" — the bug the lab
    // reported: the AR total disagreed with the per-analyte fields beside it.
    const results = [
      hplcResult({ peptide_abbreviation: 'KPV', quantity_mg: 24.564 }),
      hplcResult({ peptide_abbreviation: 'GHK-Cu', quantity_mg: 25.234 }),
    ]
    const nameMap = new Map([[1, 'KPV'], [2, 'GHK-Cu']])
    const mappings = buildAllAutoFillMappings(results, BLEND_AR, nameMap)

    const byUid = new Map(mappings.map(m => [m.analysis.uid, m.value]))
    expect(byUid.get('a1q')).toBe('24.56')
    expect(byUid.get('a2q')).toBe('25.23')
    expect(byUid.get('tot')).toBe('49.79')
  })

  it('per-analyte slot rows fill when the name map holds ABBREVIATIONS', () => {
    // The abbreviation is what HPLC results carry; a nameMap keyed by the
    // peptide NAME ("Thymosin Beta-4") never matches an abbreviation-keyed
    // result ("TB500 (Thymosin Beta 4)") — the pre-fix failure mode where
    // blend QTY fields silently did not auto-populate.
    const results = [
      hplcResult({
        peptide_abbreviation: 'TB500 (Thymosin Beta 4)',
        quantity_mg: 12.005,
      }),
    ]
    const brokenNameMap = new Map([[1, 'Thymosin Beta-4']])
    const fixedNameMap = new Map([[1, 'TB500 (Thymosin Beta 4)']])

    const broken = buildAllAutoFillMappings(results, BLEND_AR, brokenNameMap)
    expect(broken.find(m => m.analysis.uid === 'a1q')).toBeUndefined()

    const fixed = buildAllAutoFillMappings(results, BLEND_AR, fixedNameMap)
    expect(fixed.find(m => m.analysis.uid === 'a1q')?.value).toBe('12.01')
    // The aggregate total fills either way
    expect(fixed.find(m => m.analysis.uid === 'tot')?.value).toBe('12.01')
  })

  it('single-analyte samples still fill Peptide Total Quantity via the aggregate', () => {
    const results = [hplcResult({ peptide_abbreviation: 'BPC-157', quantity_mg: 13.106 })]
    const mappings = buildAllAutoFillMappings(results, BLEND_AR, new Map())
    expect(mappings.find(m => m.analysis.uid === 'tot')?.value).toBe('13.11')
  })

  it('round2 rounds half up at 2dp', () => {
    expect(round2(24.564)).toBe(24.56)
    expect(round2(24.565)).toBe(24.57)
    expect(round2(0)).toBe(0)
  })
})
