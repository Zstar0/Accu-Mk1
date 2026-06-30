import { describe, it, expect } from 'vitest'
import { computeProductCompletion } from '@/lib/product-completion'
import type {
  OrderedProduct, ParentPromotionInfo, SenaiteAnalysis, VarianceSetResponse,
} from '@/lib/api'

const prod = (key: string): OrderedProduct => ({
  key, label: key, is_addon: false, fulfillment_role: null, fulfillment_dim: 'role',
})
const ana = (keyword: string, group: string | null, retested = false): SenaiteAnalysis =>
  ({ keyword, service_group_name: group, retested } as unknown as SenaiteAnalysis)
const promo = (keyword: string, vials: string[]): [string, ParentPromotionInfo] => [
  keyword,
  {
    keyword, parent_analysis_id: 1, promoted_at: '',
    sources: vials.map(v => ({ sample_id: v, contribution_kind: 'chosen' })),
  } as ParentPromotionInfo,
]

function ctx(opts: {
  analyses?: SenaiteAnalysis[]
  promos?: [string, ParentPromotionInfo][]
  varianceSet?: Partial<VarianceSetResponse>
}) {
  return {
    analyses: opts.analyses ?? [],
    promotionsByKeyword: new Map(opts.promos ?? []),
    varianceSet: opts.varianceSet as VarianceSetResponse | undefined,
  }
}

describe('computeProductCompletion', () => {
  it('returns null for products with no completion rule', () => {
    expect(computeProductCompletion(prod('somethingelse'), ctx({}))).toBeNull()
  })

  it('variance: met when locked, lists the in-set vials', () => {
    const r = computeProductCompletion(prod('variance'), ctx({
      varianceSet: { locked: true, vials: [
        { sample_id: 'P-1-S02', in_variance_set: true },
        { sample_id: 'P-1-S03', in_variance_set: true },
        { sample_id: 'P-1-S04', in_variance_set: false },
      ] as VarianceSetResponse['vials'] },
    }))
    expect(r).toEqual({ met: true, vials: ['P-1-S02', 'P-1-S03'] })
  })

  it('variance: not met when unlocked (no vials listed)', () => {
    const r = computeProductCompletion(prod('variance'), ctx({
      varianceSet: { locked: false, vials: [] as VarianceSetResponse['vials'] },
    }))
    expect(r).toEqual({ met: false, vials: [] })
  })

  it('endotoxin: met when ENDO-LAL is promoted, lists contributing vial', () => {
    const r = computeProductCompletion(prod('endotoxin'), ctx({
      analyses: [ana('ENDO-LAL', 'Endotoxin')],
      promos: [promo('ENDO-LAL', ['P-1-S02'])],
    }))
    expect(r).toEqual({ met: true, vials: ['P-1-S02'] })
  })

  it('endotoxin: not met when the analysis exists but is not promoted', () => {
    const r = computeProductCompletion(prod('endotoxin'), ctx({
      analyses: [ana('ENDO-LAL', 'Endotoxin')], promos: [],
    }))
    expect(r).toEqual({ met: false, vials: [] })
  })

  it('hplc: met only when EVERY hplc-family analysis is promoted', () => {
    const analyses = [
      ana('HPLC-PUR', 'Analytics'), ana('ID_BPC', null),
      ana('ENDO-LAL', 'Endotoxin'), ana('STER-PCR', 'Microbiology'),
    ]
    // only one hplc-family promoted -> not met
    expect(
      computeProductCompletion(prod('core'), ctx({ analyses, promos: [promo('HPLC-PUR', ['P-1-S01'])] }))!.met,
    ).toBe(false)
    // both hplc-family promoted -> met; vials unioned; endo/ster ignored
    const r = computeProductCompletion(prod('core'), ctx({
      analyses, promos: [promo('HPLC-PUR', ['P-1-S01']), promo('ID_BPC', ['P-1-S01', 'P-1-S05'])],
    }))!
    expect(r.met).toBe(true)
    expect([...r.vials].sort()).toEqual(['P-1-S01', 'P-1-S05'])
  })

  it('accushield (bundle): met only when EVERY component — HPLC + Endo + Sterility — is promoted', () => {
    const analyses = [
      ana('HPLC-PUR', 'Analytics'), ana('ID_BPC', null),
      ana('ENDO-LAL', 'Endotoxin'), ana('STER-PCR', 'Microbiology'),
    ]
    // all HPLC-family promoted but endo/ster NOT -> NOT met (unlike core, which
    // would be met here — AccuShield is Core + Endotoxin + Sterility)
    expect(
      computeProductCompletion(prod('accushield'), ctx({
        analyses, promos: [promo('HPLC-PUR', ['P-1-S01']), promo('ID_BPC', ['P-1-S01'])],
      }))!.met,
    ).toBe(false)
    // every component promoted -> met; vials unioned across all groups
    const r = computeProductCompletion(prod('accushield'), ctx({
      analyses, promos: [
        promo('HPLC-PUR', ['P-1-S01']), promo('ID_BPC', ['P-1-S01']),
        promo('ENDO-LAL', ['P-1-S02']), promo('STER-PCR', ['P-1-S03']),
      ],
    }))!
    expect(r.met).toBe(true)
    expect([...r.vials].sort()).toEqual(['P-1-S01', 'P-1-S02', 'P-1-S03'])
  })

  it('core stays HPLC-only: met on HPLC even with endo/ster unpromoted (NOT a bundle)', () => {
    const analyses = [ana('HPLC-PUR', 'Analytics'), ana('ENDO-LAL', 'Endotoxin')]
    expect(
      computeProductCompletion(prod('core'), ctx({ analyses, promos: [promo('HPLC-PUR', ['P-1-S01'])] }))!.met,
    ).toBe(true)
  })

  it('endotoxin: met when ENDO-LAL is promoted even though prod groups it under Microbiology', () => {
    // Repro of the P-0965 prod bug: prod has only 'Core HPLC' + 'Microbiology'
    // service groups (no 'Endotoxin' group); ENDO-LAL lives in 'Microbiology'.
    // Endotoxin must be identified by keyword, not group name.
    const r = computeProductCompletion(prod('endotoxin'), ctx({
      analyses: [ana('ENDO-LAL', 'Microbiology'), ana('STER-PCR', 'Microbiology')],
      promos: [promo('ENDO-LAL', ['P-0965-S02'])], // sterility NOT promoted
    }))
    expect(r).toEqual({ met: true, vials: ['P-0965-S02'] })
  })

  it('sterility: endotoxin sharing the Microbiology group does NOT satisfy it', () => {
    const r = computeProductCompletion(prod('sterility_pcr'), ctx({
      analyses: [ana('ENDO-LAL', 'Microbiology'), ana('STER-PCR', 'Microbiology')],
      promos: [promo('ENDO-LAL', ['P-0965-S02'])], // only endo promoted
    }))
    expect(r!.met).toBe(false)
  })

  it('sterility: met when STER-PCR is promoted, regardless of endotoxin state', () => {
    const r = computeProductCompletion(prod('sterility_pcr'), ctx({
      analyses: [ana('ENDO-LAL', 'Microbiology'), ana('STER-PCR', 'Microbiology')],
      promos: [promo('STER-PCR', ['P-0965-S03'])], // endo NOT promoted
    }))
    expect(r).toEqual({ met: true, vials: ['P-0965-S03'] })
  })

  it('hplc: not met when no hplc-family analyses exist', () => {
    expect(
      computeProductCompletion(prod('hplcpurity_identity'), ctx({ analyses: [ana('ENDO-LAL', 'Endotoxin')] }))!.met,
    ).toBe(false)
  })

  it('excludes retested (superseded) analyses from the hplc requirement', () => {
    const analyses = [ana('HPLC-PUR', 'Analytics'), ana('HPLC-PUR', 'Analytics', true)]
    const r = computeProductCompletion(prod('core'), ctx({ analyses, promos: [promo('HPLC-PUR', ['P-1-S01'])] }))!
    expect(r.met).toBe(true)
  })
})
