import { describe, it, expect } from 'vitest'
import { isHplcAnalyteService } from '@/lib/hplc-analyte-services'

describe('isHplcAnalyteService', () => {
  it.each([
    'ID_BPC157', 'ID_TB500BETA4', 'HPLC-ID', 'BLEND-IDENT', 'ANALYTE-2-IDENT',  // identity
    'ANALYTE-2-PUR', 'PUR_TB500BETA4', 'BLEND-PUR', 'HPLC-PUR',                 // purity
    'ANALYTE-2-QTY', 'QTY_TB500BETA4', 'PEPT-Total',                           // quantity
  ])('hides HPLC analyte service %s', kw => {
    expect(isHplcAnalyteService(kw)).toBe(true)
  })

  it.each([
    'ENDO-LAL', 'STER-PCR', 'KF', 'SOME-OTHER', '', null, undefined,
  ])('keeps non-HPLC-analyte service %s', kw => {
    expect(isHplcAnalyteService(kw as string | null | undefined)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isHplcAnalyteService('id_bpc157')).toBe(true)
    expect(isHplcAnalyteService('analyte-3-qty')).toBe(true)
  })
})
