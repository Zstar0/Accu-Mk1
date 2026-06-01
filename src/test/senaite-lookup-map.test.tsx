import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { ExplorerOrder, SenaiteLookupResult } from '@/lib/api'

const enqueueSenaiteLookupMock = vi.fn<(id: string) => Promise<SenaiteLookupResult>>()

vi.mock('@/components/explorer/senaite-queue', () => ({
  enqueueSenaiteLookup: (id: string) => enqueueSenaiteLookupMock(id),
}))

const { useSenaiteLookupMap } = await import('@/services/senaite-lookup-map')

function Wrapper({ children }: { children: React.ReactNode }) {
  const [qc] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } })
  )
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeLookup(sampleId: string): SenaiteLookupResult {
  return {
    sample_id: sampleId,
    sample_uid: `uid-${sampleId}`,
    review_state: 'sample_received',
    date_received: '2026-01-01T09:00:00',
    analyses: [],
  } as unknown as SenaiteLookupResult
}

/** Minimal ExplorerOrder with the only fields the hook reads. */
function makeOrder(
  orderId: string,
  sampleResults: Record<string, { senaite_id: string | null; status?: string }> | null
): ExplorerOrder {
  return {
    order_id: orderId,
    sample_results: sampleResults,
  } as unknown as ExplorerOrder
}

beforeEach(() => {
  enqueueSenaiteLookupMock.mockReset().mockImplementation((id: string) => Promise.resolve(makeLookup(id)))
})

describe('useSenaiteLookupMap', () => {
  it('returns empty map + ids and isLoading false for empty orders', async () => {
    const { result } = renderHook(() => useSenaiteLookupMap([]), { wrapper: Wrapper })
    await waitFor(() => {
      expect(result.current.sampleIds).toEqual([])
      expect(result.current.sampleLookupMap.size).toBe(0)
      expect(result.current.isLoading).toBe(false)
    })
    expect(enqueueSenaiteLookupMock).not.toHaveBeenCalled()
  })

  it('collects unique senaite_ids, skipping failed and null entries', async () => {
    const orders = [
      makeOrder('o1', {
        a: { senaite_id: 'PB-001', status: 'ok' },
        b: { senaite_id: 'PB-002', status: 'failed' }, // skipped: failed
        c: { senaite_id: null, status: 'ok' },         // skipped: null id
      }),
      makeOrder('o2', { d: { senaite_id: 'PB-003', status: 'ok' } }),
      makeOrder('o3', null), // no sample_results
    ]
    const { result } = renderHook(() => useSenaiteLookupMap(orders), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.sampleIds.length).toBe(2))
    expect(result.current.sampleIds).toEqual(['PB-001', 'PB-003'])
  })

  it('dedupes the same senaite_id across multiple orders', async () => {
    const orders = [
      makeOrder('o1', { a: { senaite_id: 'PB-001', status: 'ok' } }),
      makeOrder('o2', { b: { senaite_id: 'PB-001', status: 'ok' } }), // dupe
    ]
    const { result } = renderHook(() => useSenaiteLookupMap(orders), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.sampleIds).toEqual(['PB-001']))
  })

  it('builds a map carrying data/isLoading/isError per id', async () => {
    const orders = [makeOrder('o1', { a: { senaite_id: 'PB-001', status: 'ok' } })]
    const { result } = renderHook(() => useSenaiteLookupMap(orders), { wrapper: Wrapper })
    await waitFor(() => {
      const entry = result.current.sampleLookupMap.get('PB-001')
      expect(entry?.data?.sample_uid).toBe('uid-PB-001')
      expect(entry?.isError).toBe(false)
    })
    expect(result.current.isLoading).toBe(false)
  })

  it('isError aggregates true when a lookup rejects', async () => {
    enqueueSenaiteLookupMock.mockReset().mockRejectedValue(new Error('zope down'))
    const orders = [makeOrder('o1', { a: { senaite_id: 'PB-001', status: 'ok' } })]
    const { result } = renderHook(() => useSenaiteLookupMap(orders), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3000 })
    expect(result.current.sampleLookupMap.get('PB-001')?.isError).toBe(true)
  })
})
