import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getExplorerOrders } from '@/lib/api'

// v1.11.2: the Order Status page's base fetch is only the newest 200 orders,
// so its Order ID filter could never find an older order (prod report: 5739).
// getExplorerOrders now forwards the same four IS search axes as the
// customer-scoped sibling — these tests pin the wire param names and the
// per-axis 2-char gate (the IS contract from Phase 30).

const fetchSpy = vi.fn()

beforeEach(() => {
  fetchSpy.mockReset().mockResolvedValue({
    ok: true,
    json: async () => [],
  } as unknown as Response)
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function requestedUrl(): URL {
  const call = fetchSpy.mock.calls[0]
  return new URL(String(call?.[0]))
}

describe('getExplorerOrders search axes', () => {
  it('forwards axes >=2 chars under the IS wire names', async () => {
    await getExplorerOrders(undefined, 200, 0, undefined, {
      order_number: '5739',
      sample_id: 'P-21',
      analyte: 'reta',
      lot: 'LT',
    })
    const url = requestedUrl()
    expect(url.searchParams.get('search_order_number')).toBe('5739')
    expect(url.searchParams.get('search_sample_id')).toBe('P-21')
    expect(url.searchParams.get('search_analyte')).toBe('reta')
    expect(url.searchParams.get('search_lot')).toBe('LT')
  })

  it('gates each axis independently at 2 chars', async () => {
    await getExplorerOrders(undefined, 200, 0, undefined, {
      order_number: '5',
      sample_id: 'P-2120',
      analyte: '',
    })
    const url = requestedUrl()
    expect(url.searchParams.get('search_order_number')).toBeNull()
    expect(url.searchParams.get('search_sample_id')).toBe('P-2120')
    expect(url.searchParams.get('search_analyte')).toBeNull()
    expect(url.searchParams.get('search_lot')).toBeNull()
  })

  it('omits every axis param when no axes are passed (legacy call shape)', async () => {
    await getExplorerOrders(undefined, 200, 0)
    const url = requestedUrl()
    for (const p of [
      'search_order_number',
      'search_sample_id',
      'search_analyte',
      'search_lot',
    ]) {
      expect(url.searchParams.get(p)).toBeNull()
    }
    expect(url.searchParams.get('limit')).toBe('200')
  })
})
