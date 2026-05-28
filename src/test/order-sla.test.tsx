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
  it('builds one /sla/status batch item per (sample_uid, group_key) bucket', async () => {
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
    // Multi-tier reshape: the key is now `${sample_uid}|${groupKey}`. Lookup
    // with no analyses → no-group bucket → key suffix '|no-group'.
    expect(item?.key).toBe('PB-001-uid|no-group')
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

  it('omits orders from verdictByOrderId while any sample lookup is still loading (cold-load flicker fix)', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const orders = [
      makeOrder({
        order_id: 'O1',
        sample_results: { '1': { senaite_id: 'PB-001', status: 'ok' } } as never,
      }),
    ]
    // Lookup map entry is in flight: isLoading=true, data=undefined.
    const loadingMap = new Map<
      string,
      { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
    >([
      ['PB-001', { data: undefined, isLoading: true, isError: false }],
    ])
    const { result } = renderHook(
      () => useOrderSlaStatuses(orders, loadingMap),
      { wrapper }
    )
    // With the fix, the order is absent from verdictByOrderId during load so
    // OrderSlaCell shows "…" instead of flashing "—Awaiting sample".
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.verdictByOrderId.has('O1')).toBe(false)
  })

  it('transitions from omitted (loading) to a real verdict once the sample lookup resolves', async () => {
    // Multi-tier reshape: batch keys are `${sample_uid}|${groupKey}`. With no
    // analyses, the sample falls into the NO_GROUP_KEY bucket → 'no-group' suffix.
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'PB-002-uid|no-group',
        status: { target_minutes: 1440, elapsed_minutes: 100, remaining_minutes: 1340, breached: false },
      },
    ])
    const orders = [
      makeOrder({
        order_id: 'O2',
        sample_results: { '1': { senaite_id: 'PB-002', status: 'ok' } } as never,
      }),
    ]
    const loadingMap = new Map<
      string,
      { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
    >([
      ['PB-002', { data: undefined, isLoading: true, isError: false }],
    ])
    const resolvedMap = new Map<
      string,
      { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
    >([
      ['PB-002', {
        data: makeLookup('PB-002-uid', '2026-01-01T09:00:00', 'sample_received'),
        isLoading: false,
        isError: false,
      }],
    ])
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrap = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(
      ({ map }: { map: typeof loadingMap }) => useOrderSlaStatuses(orders, map),
      { wrapper: wrap, initialProps: { map: loadingMap } }
    )
    // First render: loading → no verdict
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.verdictByOrderId.has('O2')).toBe(false)
    // Sample resolves
    rerender({ map: resolvedMap })
    await waitFor(() =>
      expect(result.current.verdictByOrderId.get('O2')?.color).not.toBe(
        'awaiting'
      )
    )
  })

  it('sample with analyses spanning HPLC + Sterility groups yields two snapshots (multi-tier)', async () => {
    // Tiers: default 24h, HPLC 24h, Sterility 7d
    const hplcTier = {
      id: 2, name: 'HPLC', target_minutes: 1440, business_hours_only: false,
      is_default: false, amber_threshold_percent: 20,
      created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
    }
    const sterTier = {
      id: 3, name: 'Sterility', target_minutes: 10080, business_hours_only: false,
      is_default: false, amber_threshold_percent: 20,
      created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
    }
    getSlaTiersMock.mockResolvedValue([
      {
        id: 1, name: 'default', target_minutes: 1440, business_hours_only: false,
        is_default: true, amber_threshold_percent: 80,
        created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
      },
      hplcTier, sterTier,
    ])
    getAnalysisServicesMock.mockResolvedValue([
      { id: 100, keyword: 'kw_hplc' },
      { id: 200, keyword: 'kw_sterility' },
    ])
    getServiceGroupsMock.mockResolvedValue([
      { id: 10, name: 'HPLC', sla_tier_id: hplcTier.id, member_ids: [100] },
      { id: 11, name: 'Sterility', sla_tier_id: sterTier.id, member_ids: [200] },
    ])

    // /sla/status returns one status per (sample_uid, group) composite key —
    // HPLC breached, Sterility on-track.
    fetchSlaStatusesMock.mockResolvedValue([
      { key: 'uid-PB-001|10', status: { target_minutes: 1440, elapsed_minutes: 2880, remaining_minutes: -1440, breached: true } },
      { key: 'uid-PB-001|11', status: { target_minutes: 10080, elapsed_minutes: 100, remaining_minutes: 9980, breached: false } },
    ])

    const lookup = {
      ...makeLookup('uid-PB-001', '2026-01-01T09:00:00', 'sample_received'),
      analyses: [
        { keyword: 'kw_hplc' } as never,
        { keyword: 'kw_sterility' } as never,
      ],
    } as SenaiteLookupResult
    const lookupMap = new Map([
      ['PB-001', { data: lookup, isLoading: false, isError: false }],
    ])
    const orders = [
      makeOrder({
        order_id: 'OMT',
        sample_results: { '1': { senaite_id: 'PB-001', status: 'ok' } } as never,
      }),
    ]

    const { result } = renderHook(
      () => useOrderSlaStatuses(orders, lookupMap),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.sampleStatusesBySampleId.get('PB-001')?.length).toBe(2)
    })
    const snapshots = result.current.sampleStatusesBySampleId.get('PB-001') ?? []
    const byGroup = new Map(snapshots.map(s => [s.groupKey, s]))
    expect(byGroup.get(10)?.tier.id).toBe(hplcTier.id)
    expect(byGroup.get(10)?.color).toBe('red') // breached
    expect(byGroup.get(10)?.groupName).toBe('HPLC')
    expect(byGroup.get(11)?.tier.id).toBe(sterTier.id)
    expect(byGroup.get(11)?.color).toBe('green') // on-track
    expect(byGroup.get(11)?.groupName).toBe('Sterility')
    // Order verdict aggregates worst color across (sample, group) cells → red.
    expect(result.current.verdictByOrderId.get('OMT')?.color).toBe('red')
    expect(result.current.verdictByOrderId.get('OMT')?.drivingSampleId).toBe('PB-001')
  })

  it('keeps previous verdicts during refetch when sampleUids set grows (no flicker)', async () => {
    // Multi-tier reshape: batch keys are `${sample_uid}|${groupKey}`. No
    // analyses → NO_GROUP_KEY bucket → 'no-group' suffix on each key.
    fetchSlaStatusesMock.mockResolvedValue([
      { key: 'uid-A|no-group', status: { target_minutes: 1440, elapsed_minutes: 60, remaining_minutes: 1380, breached: false } },
    ])
    const lookupA = makeLookup('uid-A', '2026-01-01T09:00:00', 'sample_received')
    const lookupB = makeLookup('uid-B', '2026-01-01T10:00:00', 'sample_received')
    const initialMap = new Map([
      ['SA', { data: lookupA, isLoading: false, isError: false }],
    ])
    const growingMap = new Map([
      ['SA', { data: lookupA, isLoading: false, isError: false }],
      ['SB', { data: lookupB, isLoading: false, isError: false }],
    ])
    const orders = [
      makeOrder({ order_id: 'O1', sample_results: { '1': { senaite_id: 'SA', status: 'ok' }, '2': { senaite_id: 'SB', status: 'ok' } } as never }),
    ]
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrap = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(
      ({ map }: { map: typeof initialMap }) => useOrderSlaStatuses(orders, map),
      { wrapper: wrap, initialProps: { map: initialMap } }
    )
    // Wait for the first fetch + aggregation to land
    await waitFor(() => expect(result.current.verdictByOrderId.get('O1')?.drivingSampleId).toBe('SA'))
    expect(result.current.isLoading).toBe(false)
    // Now simulate a NEW sample resolving (sampleLookupMap grows)
    rerender({ map: growingMap })
    // Without keepPreviousData: isLoading flips to true during refetch.
    // With keepPreviousData: isLoading stays false (we have placeholder data).
    expect(result.current.isLoading).toBe(false)
  })
})
