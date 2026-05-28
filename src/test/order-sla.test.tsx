import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'
import type {
  ExplorerOrder,
  SenaiteLookupResult,
  SlaStatusRequestItem,
  SlaStatusResultItem,
} from '@/lib/api'

const fetchSlaStatusesMock = vi.fn<(items: SlaStatusRequestItem[]) => Promise<SlaStatusResultItem[]>>()
const samplePrioritiesLookupMock = vi.fn<(uids: string[]) => Promise<{ sample_uid: string; priority: 'normal' | 'high' | 'expedited' }[]>>()
const getAnalysisServicesMock = vi.fn().mockResolvedValue([])
const getServiceGroupsMock = vi.fn().mockResolvedValue([])
const getSlaTiersMock = vi.fn().mockResolvedValue([])
const getSlaPriorityTiersMock = vi.fn().mockResolvedValue([])

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api')
  return {
    ...actual,
    fetchSlaStatuses: (items: SlaStatusRequestItem[]) => fetchSlaStatusesMock(items),
    samplePrioritiesLookup: (uids: string[]) => samplePrioritiesLookupMock(uids),
    getAnalysisServices: () => getAnalysisServicesMock(),
    getServiceGroups: () => getServiceGroupsMock(),
    getSlaTiers: () => getSlaTiersMock(),
    getSlaPriorityTiers: () => getSlaPriorityTiersMock(),
  }
})

const { useOrderSlaStatuses } = await import('@/services/order-sla')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeOrder(overrides: Partial<ExplorerOrder> = {}): ExplorerOrder {
  return {
    id: 'order-uuid-1',
    order_id: '12345',
    order_number: '12345',
    status: 'pending',
    samples_expected: 1,
    samples_delivered: 0,
    error_message: null,
    payload: null,
    sample_results: null,
    created_at: '2026-01-01T00:00:00',
    updated_at: '2026-01-01T00:00:00',
    completed_at: null,
    wp_order_status: 'processing',
    ...overrides,
  }
}

function makeLookup(
  sample_uid: string,
  date_received: string | null,
  review_state: string | null
): SenaiteLookupResult {
  return {
    sample_id: sample_uid,
    sample_uid,
    client_sample_id: null,
    client: null,
    sample_type: null,
    date_received,
    date_sampled: null,
    client_lot: null,
    review_state,
    declared_weight_mg: null,
    remarks: [],
    analyses: [],
    attachments: [],
  } as unknown as SenaiteLookupResult
}

beforeEach(() => {
  fetchSlaStatusesMock.mockReset()
  samplePrioritiesLookupMock.mockReset().mockResolvedValue([])
  getAnalysisServicesMock.mockClear()
  getServiceGroupsMock.mockClear()
  getSlaTiersMock.mockReset().mockResolvedValue([
    {
      id: 1,
      name: 'default',
      target_minutes: 1440,
      business_hours_only: false,
      is_default: true,
      amber_threshold_percent: 80,
      created_at: '2026-01-01T00:00:00',
      updated_at: '2026-01-01T00:00:00',
    },
  ])
  getSlaPriorityTiersMock.mockClear()
})

describe('useOrderSlaStatuses', () => {
  it('builds one /sla/status batch item per received-but-unpublished sample, keyed by sample_uid', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const orders = [
      makeOrder({
        order_id: 'O1',
        sample_results: { '1': { senaite_id: 'PB-001', status: 'ok' } } as never,
      }),
    ]
    const lookupMap = new Map<string, { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }>([
      ['PB-001', { data: makeLookup('PB-001-uid', '2026-01-01T09:00:00', 'sample_received'), isLoading: false, isError: false }],
    ])
    renderHook(() => useOrderSlaStatuses(orders, lookupMap), { wrapper })
    await waitFor(() => {
      expect(fetchSlaStatusesMock).toHaveBeenCalled()
    })
    const firstCall = fetchSlaStatusesMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const passed = firstCall?.[0] ?? []
    expect(passed).toHaveLength(1)
    const item = passed[0]
    expect(item).toBeDefined()
    expect(item?.key).toBe('PB-001-uid')
    expect(item?.received_at).toBe('2026-01-01T09:00:00')
  })

  it('queryKey is stable across reorderings of the same UID set (hits cache)', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const lookupA = makeLookup('uid-A', '2026-01-01T09:00:00', 'sample_received')
    const lookupB = makeLookup('uid-B', '2026-01-01T10:00:00', 'sample_received')
    const lookupMap = new Map([
      ['SA', { data: lookupA, isLoading: false, isError: false }],
      ['SB', { data: lookupB, isLoading: false, isError: false }],
    ])
    const orders1 = [
      makeOrder({ order_id: 'O1', sample_results: { '1': { senaite_id: 'SA', status: 'ok' }, '2': { senaite_id: 'SB', status: 'ok' } } as never }),
    ]
    const orders2 = [
      makeOrder({ order_id: 'O1', sample_results: { '1': { senaite_id: 'SB', status: 'ok' }, '2': { senaite_id: 'SA', status: 'ok' } } as never }),
    ]
    // Single QueryClient so the cache is shared across rerenders.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrap = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { rerender } = renderHook(
      ({ orders }: { orders: ExplorerOrder[] }) => useOrderSlaStatuses(orders, lookupMap),
      { wrapper: wrap, initialProps: { orders: orders1 } }
    )
    await waitFor(() => expect(fetchSlaStatusesMock).toHaveBeenCalledTimes(1))
    rerender({ orders: orders2 })
    // Give React Query a beat to fire any refetch — there should be none.
    await new Promise(r => setTimeout(r, 50))
    expect(fetchSlaStatusesMock).toHaveBeenCalledTimes(1)
  })

  it('isError surfaces when /sla/status fails', async () => {
    fetchSlaStatusesMock.mockRejectedValue(new Error('boom'))
    const orders = [
      makeOrder({
        order_id: 'O1',
        sample_results: { '1': { senaite_id: 'PB-001', status: 'ok' } } as never,
      }),
    ]
    const lookupMap = new Map([
      ['PB-001', { data: makeLookup('PB-001-uid', '2026-01-01T09:00:00', 'sample_received'), isLoading: false, isError: false }],
    ])
    const { result } = renderHook(() => useOrderSlaStatuses(orders, lookupMap), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  it('orders with sample_results=null yield an awaiting verdict (not eternal loading)', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const orders = [
      makeOrder({ order_id: 'OFAILED', sample_results: null }),
    ]
    const lookupMap = new Map<
      string,
      { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
    >()
    const { result } = renderHook(
      () => useOrderSlaStatuses(orders, lookupMap),
      { wrapper }
    )
    await waitFor(() => {
      expect(result.current.verdictByOrderId.has('OFAILED')).toBe(true)
    })
    expect(result.current.verdictByOrderId.get('OFAILED')?.color).toBe('awaiting')
  })
})
