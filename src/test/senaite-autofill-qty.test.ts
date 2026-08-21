import { describe, it, expect, vi } from 'vitest'
import {
  buildAllAutoFillMappings,
  runRetractRefill,
  round2,
} from '@/components/hplc/SenaiteResultsView'
import type { SenaiteAnalysis, HPLCAnalysisResult, SenaiteLookupResult } from '@/lib/api'

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

describe('second-run recovery — lock classification + retract & refill', () => {
  const results = [hplcResult({ peptide_abbreviation: 'KPV', quantity_mg: 24.564, purity_percent: 98.5 })]
  const nameMap = new Map([[1, 'KPV']])

  it('classifies submitted rows as lock=submitted, verified as lock=verified, and never matches retracted rows', () => {
    const ar = [
      analysis({ uid: 'q-sub', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)', review_state: 'to_be_verified' }),
      analysis({ uid: 'p-ver', keyword: 'ANALYTE-1-PUR', title: 'Analyte 1 (Purity)', review_state: 'verified' }),
      analysis({ uid: 'q-old', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)', review_state: 'retracted' }),
    ]
    const mappings = buildAllAutoFillMappings(results, ar, nameMap)
    const byUid = new Map(mappings.map(m => [m.analysis.uid, m]))
    expect(byUid.get('q-sub')?.lock).toBe('submitted')
    expect(byUid.get('q-sub')?.value).toBe('24.56')
    expect(byUid.get('p-ver')?.lock).toBe('verified')
    expect(byUid.has('q-old')).toBe(false)
  })

  it('fillable rows carry no lock', () => {
    const ar = [analysis({ uid: 'q1', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)' })]
    const mappings = buildAllAutoFillMappings(results, ar, nameMap)
    expect(mappings[0]?.lock).toBeUndefined()
  })

  it('runRetractRefill: retracts, finds the fresh copy by keyword, fills it with the run-2 value', async () => {
    const locked = buildAllAutoFillMappings(
      results,
      [analysis({ uid: 'old-q', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)', review_state: 'to_be_verified', result: '24.10' })],
      nameMap
    )
    expect(locked[0]?.lock).toBe('submitted')

    const retract = vi.fn().mockResolvedValue({ success: true })
    const refill = vi.fn().mockResolvedValue({ success: true })
    // Post-retract AR: old row retracted, fresh copy born UNASSIGNED still
    // carrying the run-1 value (real SENAITE behavior, proven on PB-0157).
    const relookup = vi.fn().mockResolvedValue({
      analyses: [
        analysis({ uid: 'old-q', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)', review_state: 'retracted', result: '24.10' }),
        analysis({ uid: 'new-q', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)', review_state: 'unassigned', result: '24.10' }),
      ],
    } as SenaiteLookupResult)

    const out = await runRetractRefill(locked, { retract, refill, relookup })

    expect(retract).toHaveBeenCalledWith('old-q')
    expect(refill).toHaveBeenCalledWith('new-q', '24.56')
    expect(out.get('old-q')).toBe('success')
  })

  it('runRetractRefill: a silently-rejected retract errors that row and never fills it', async () => {
    const locked = buildAllAutoFillMappings(
      results,
      [analysis({ uid: 'old-q', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)', review_state: 'to_be_verified' })],
      nameMap
    )
    const retract = vi.fn().mockResolvedValue({ success: false, message: 'silently rejected' })
    const refill = vi.fn()
    const relookup = vi.fn()

    const out = await runRetractRefill(locked, { retract, refill, relookup })
    expect(out.get('old-q')).toBe('error')
    expect(refill).not.toHaveBeenCalled()
    expect(relookup).not.toHaveBeenCalled()
  })

  it('runRetractRefill: retract landed but no fresh copy appears -> row errors', async () => {
    const locked = buildAllAutoFillMappings(
      results,
      [analysis({ uid: 'old-q', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)', review_state: 'to_be_verified' })],
      nameMap
    )
    const retract = vi.fn().mockResolvedValue({ success: true })
    const refill = vi.fn()
    const relookup = vi.fn().mockResolvedValue({
      analyses: [
        analysis({ uid: 'old-q', keyword: 'ANALYTE-1-QTY', title: 'Analyte 1 (Quantity)', review_state: 'retracted' }),
      ],
    } as SenaiteLookupResult)

    const out = await runRetractRefill(locked, { retract, refill, relookup })
    expect(out.get('old-q')).toBe('error')
    expect(refill).not.toHaveBeenCalled()
  })
})
