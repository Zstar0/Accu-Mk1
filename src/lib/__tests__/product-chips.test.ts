import { describe, it, expect } from 'vitest'
import {
  buildProductsBySampleId,
  productsFromPayloadServices,
} from '@/lib/product-chips'
import type { AnalysisProfile, ExplorerOrder } from '@/lib/api'

const profile = (over: Partial<AnalysisProfile>): AnalysisProfile =>
  ({
    id: 0,
    key: '',
    name: '',
    description: null,
    is_addon: false,
    vials_required: 1,
    fulfillment_role: null,
    fulfillment_dim: 'role',
    sort_order: 0,
    active: true,
    coa_section_title: null,
    coa_archetype: null,
    coa_sort_order: 0,
    coa_basis_note: null,
    coa_method_text: null,
    coa_prep_text: null,
    coa_footnotes: null,
    member_ids: [],
    ...over,
  }) as AnalysisProfile

const PROFILES = [
  profile({
    id: 1,
    key: 'hplcpurity_identity',
    name: 'HPLC',
    fulfillment_role: 'hplc',
    sort_order: 0,
  }),
  profile({
    id: 3,
    key: 'endotoxin',
    name: 'Endotoxin',
    fulfillment_role: 'endo',
    is_addon: true,
    sort_order: 2,
  }),
  profile({
    id: 5,
    key: 'variance',
    name: 'Variance HPLC',
    fulfillment_role: 'variance',
    fulfillment_dim: 'kind',
    is_addon: true,
    sort_order: 4,
  }),
  profile({
    id: 7,
    key: 'heavy_metals',
    name: 'Heavy Metals',
    fulfillment_role: 'hm',
    is_addon: true,
    sort_order: 6,
  }),
]

describe('productsFromPayloadServices', () => {
  it('maps true service keys to catalog products in sort order', () => {
    const out = productsFromPayloadServices(
      { hplcpurity_identity: true, endotoxin: true, heavy_metals: false },
      PROFILES
    )
    expect(out.map(p => p.key)).toEqual(['hplcpurity_identity', 'endotoxin'])
    expect(out[0]?.label).toBe('HPLC')
    expect(out[0]?.fulfillment_role).toBe('hplc')
    expect(out[1]?.is_addon).toBe(true)
  })

  it('unknown wire keys (residualsolvents) are skipped', () => {
    const out = productsFromPayloadServices(
      { residualsolvents: true, hplcpurity_identity: true },
      PROFILES
    )
    expect(out.map(p => p.key)).toEqual(['hplcpurity_identity'])
  })

  it('samplevariance boolean OR variance object selects the variance profile', () => {
    for (const services of [
      { samplevariance: true },
      { variance: { hplcpurity_identity: 2 } },
    ]) {
      const out = productsFromPayloadServices(services, PROFILES)
      expect(out.map(p => p.key)).toEqual(['variance'])
    }
    expect(productsFromPayloadServices({ variance: null }, PROFILES)).toEqual(
      []
    )
  })
})

describe('buildProductsBySampleId', () => {
  it('aligns sample_results slots to payload.samples positionally', () => {
    const orders = [
      {
        id: 'x',
        order_id: 6918,
        sample_results: {
          '1': { senaite_id: 'P-9001', status: 'created' },
          '2': { senaite_id: 'P-9002', status: 'created' },
        },
        payload: {
          samples: [
            { services: { hplcpurity_identity: true } },
            { services: { hplcpurity_identity: true, heavy_metals: true } },
          ],
        },
      },
    ] as unknown as ExplorerOrder[]
    const map = buildProductsBySampleId(orders, PROFILES)
    expect(map.get('P-9001')?.map(p => p.key)).toEqual(['hplcpurity_identity'])
    expect(map.get('P-9002')?.map(p => p.key)).toEqual([
      'hplcpurity_identity',
      'heavy_metals',
    ])
  })

  it('missing payload or empty profiles yields an empty map', () => {
    const orders = [
      {
        id: 'x',
        order_id: 1,
        sample_results: { '1': { senaite_id: 'P-1' } },
        payload: null,
      },
    ] as unknown as ExplorerOrder[]
    expect(buildProductsBySampleId(orders, PROFILES).size).toBe(0)
    expect(buildProductsBySampleId([], []).size).toBe(0)
  })
})
