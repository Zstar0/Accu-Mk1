import { describe, it, expect } from 'vitest'
import {
  retestChipFor,
  isCarriedPromotion,
  carriedSourceLabel,
  carriedHplcVials,
} from '@/lib/retest-chips'

const info = {
  is_retest: true,
  retest: ['hplc-purity-identity'],
  add: ['rapid-sterility-pcr'],
}

describe('retestChipFor', () => {
  it('flags ordered rows of retested and added profiles', () => {
    expect(
      retestChipFor(
        { provenance: 'ordered', profile_section_key: 'hplc-purity-identity' },
        info
      )
    ).toBe('retesting')
    expect(
      retestChipFor(
        { provenance: 'ordered', profile_section_key: 'rapid-sterility-pcr' },
        info
      )
    ).toBe('added')
  })
  it('flags the native HPLC placeholders when the spec names the legacy alias', () => {
    expect(
      retestChipFor(
        { provenance: 'ordered', profile_section_key: 'hplc-purity-identity' },
        { is_retest: true, retest: ['hplcpurity_identity'], add: [] }
      )
    ).toBe('retesting')
  })
  it('never flags canonical rows, other profiles, or non-retest samples', () => {
    expect(
      retestChipFor(
        {
          provenance: 'canonical',
          profile_section_key: 'hplc-purity-identity',
        },
        info
      )
    ).toBeNull()
    expect(
      retestChipFor(
        { provenance: 'ordered', profile_section_key: 'heavy_metals' },
        info
      )
    ).toBeNull()
    expect(
      retestChipFor(
        { provenance: 'ordered', profile_section_key: 'hplc-purity-identity' },
        { is_retest: false }
      )
    ).toBeNull()
    expect(
      retestChipFor({ provenance: 'ordered', profile_section_key: null }, info)
    ).toBeNull()
    expect(
      retestChipFor(
        { provenance: 'ordered', profile_section_key: 'hplc-purity-identity' },
        null
      )
    ).toBeNull()
  })
})

describe('carried promotions', () => {
  const carried = {
    sources: [
      {
        sample_id: 'P-9001-S02',
        contribution_kind: 'carried',
        parent_sample_id: 'P-9001',
      },
    ],
  }
  it('detects carried links', () => {
    expect(isCarriedPromotion(carried)).toBe(true)
    expect(
      isCarriedPromotion({
        sources: [{ sample_id: 'P-1-S01', contribution_kind: 'chosen' }],
      })
    ).toBe(false)
    expect(isCarriedPromotion(undefined)).toBe(false)
  })
  it('labels the vial, else the parent sample, else "original"', () => {
    expect(carriedSourceLabel(carried)).toBe('P-9001-S02')
    expect(
      carriedSourceLabel({
        sources: [
          {
            sample_id: null,
            contribution_kind: 'carried',
            parent_sample_id: 'P-9001',
          },
        ],
      })
    ).toBe('P-9001')
    expect(
      carriedSourceLabel({
        sources: [{ sample_id: null, contribution_kind: 'carried' }],
      })
    ).toBe('original')
  })
})

describe('carriedHplcVials', () => {
  const info = { sample_id: 'PB-1179', carried_hplc_vials: ['PB-1141-S01'] }

  it('names the vial behind the carried HPLC on the retest', () => {
    expect(carriedHplcVials('PB-1179', info)).toEqual(['PB-1141-S01'])
  })

  it('names every vial when HPLC came from more than one, so none is picked', () => {
    expect(
      carriedHplcVials('PB-1179', {
        sample_id: 'PB-1179',
        carried_hplc_vials: ['PB-1141-S01', 'PB-1141-S04'],
      })
    ).toEqual(['PB-1141-S01', 'PB-1141-S04'])
  })

  it('is empty when HPLC was not carried, so the sample reads its own prep', () => {
    expect(carriedHplcVials('PB-1179', { sample_id: 'PB-1179' })).toEqual([])
    expect(
      carriedHplcVials('PB-1179', {
        sample_id: 'PB-1179',
        carried_hplc_vials: [],
      })
    ).toEqual([])
    expect(carriedHplcVials('PB-1179', null)).toEqual([])
  })

  it('ignores info still loaded from the sample the user just left', () => {
    expect(carriedHplcVials('P-0001', info)).toEqual([])
  })
})
