import { describe, it, expect } from 'vitest'
import { toggleFilterKey, isOrderAtRisk, orderMatchesLot } from '@/components/explorer/order-filters'
import type { OrderSlaVerdict } from '@/lib/sla-resolution'
import type { ExplorerOrder, SenaiteLookupResult } from '@/lib/api'

describe('toggleFilterKey', () => {
  it('appends a key when absent', () => {
    expect(toggleFilterKey([], 'received')).toEqual(['received'])
    expect(toggleFilterKey(['pending'], 'received')).toEqual(['pending', 'received'])
  })
  it('removes a key when present', () => {
    expect(toggleFilterKey(['received'], 'received')).toEqual([])
    expect(toggleFilterKey(['pending', 'received'], 'pending')).toEqual(['received'])
  })
  it('does not mutate the input array', () => {
    const input = ['pending']
    toggleFilterKey(input, 'received')
    expect(input).toEqual(['pending'])
  })
})

describe('isOrderAtRisk', () => {
  const v = (color: OrderSlaVerdict['color']): OrderSlaVerdict => ({ color })
  it('is true for red and amber (approaching or overdue)', () => {
    expect(isOrderAtRisk(v('red'))).toBe(true)
    expect(isOrderAtRisk(v('amber'))).toBe(true)
  })
  it('is false for green/met/awaiting/loading/error', () => {
    for (const c of ['green', 'met', 'awaiting', 'loading', 'error'] as const) {
      expect(isOrderAtRisk(v(c))).toBe(false)
    }
  })
  it('is false for undefined (no verdict yet)', () => {
    expect(isOrderAtRisk(undefined)).toBe(false)
  })
})

type LookupMap = Map<
  string,
  { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
>

const makeLotOrder = (over: Partial<ExplorerOrder> = {}): ExplorerOrder =>
  ({
    id: 'u-1',
    order_id: '1001',
    order_number: '1001',
    status: 'accepted',
    payload: { samples: [{ lot_code: 'LOT-A100' }] },
    sample_results: { '1': { senaite_id: 'P-0001', status: 'created' } },
    created_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    ...over,
  }) as ExplorerOrder

const emptyMap: LookupMap = new Map()

const mapWithClientLot = (sampleId: string, clientLot: string): LookupMap =>
  new Map([
    [
      sampleId,
      {
        data: { client_lot: clientLot } as SenaiteLookupResult,
        isLoading: false,
        isError: false,
      },
    ],
  ])

describe('orderMatchesLot', () => {
  it('matches payload lot_code case-insensitively on substring', () => {
    expect(orderMatchesLot(makeLotOrder(), 'lot-a1', emptyMap)).toBe(true)
  })

  it('does not match when neither source contains the query', () => {
    expect(orderMatchesLot(makeLotOrder(), 'ZZZ', emptyMap)).toBe(false)
  })

  it('matches the loaded lookup client_lot when the payload has no lot', () => {
    const order = makeLotOrder({ payload: { samples: [{}] } })
    expect(
      orderMatchesLot(order, 'edited', mapWithClientLot('P-0001', 'LOT-EDITED'))
    ).toBe(true)
  })

  it('aligns positionally: sample_results key "2" reads payload samples[1]', () => {
    const order = makeLotOrder({
      payload: { samples: [{ lot_code: 'AAA' }, { lot_code: 'BBB' }] },
      sample_results: {
        '1': { senaite_id: 'P-0001', status: 'created' },
        '2': { senaite_id: 'P-0002', status: 'created' },
      },
    })
    expect(orderMatchesLot(order, 'bbb', emptyMap)).toBe(true)
  })

  it('empty/whitespace query matches everything (no-filter semantics)', () => {
    expect(orderMatchesLot(makeLotOrder(), '   ', emptyMap)).toBe(true)
  })

  it('order without sample_results never matches a non-empty query', () => {
    const order = makeLotOrder({ sample_results: null })
    expect(orderMatchesLot(order, 'lot', emptyMap)).toBe(false)
  })
})
