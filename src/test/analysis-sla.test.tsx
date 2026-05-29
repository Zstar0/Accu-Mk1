import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'
import type {
  SenaiteLookupResult,
  SlaStatusRequestItem,
  SlaStatusResultItem,
} from '@/lib/api'

const fetchSlaStatusesMock =
  vi.fn<(items: SlaStatusRequestItem[]) => Promise<SlaStatusResultItem[]>>()
const samplePrioritiesLookupMock =
  vi.fn<(uids: string[]) => Promise<{ sample_uid: string; priority: 'normal' | 'high' | 'expedited' }[]>>()
const getAnalysisServicesMock = vi.fn()
const getServiceGroupsMock = vi.fn()
const getSlaTiersMock = vi.fn()
const getSlaPriorityTiersMock = vi.fn()

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

const { useAnalysisSlaMap } = await import('@/services/analysis-sla')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const DEFAULT_TIER = {
  id: 1,
  name: 'Default',
  target_minutes: 1440,
  business_hours_only: false,
  is_default: true,
  amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
}
const HPLC_TIER = {
  id: 2,
  name: 'HPLC fast',
  target_minutes: 240,
  business_hours_only: false,
  is_default: false,
  amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
}

function makeLookup(overrides: Partial<SenaiteLookupResult> = {}): SenaiteLookupResult {
  return {
    sample_id: 'PB-001',
    sample_uid: 'uid-PB-001',
    client_sample_id: null,
    client: null,
    sample_type: null,
    date_received: '2026-01-01T09:00:00',
    date_sampled: null,
    client_lot: null,
    review_state: 'sample_received',
    declared_weight_mg: null,
    remarks: [],
    analyses: [],
    attachments: [],
    ...overrides,
  } as unknown as SenaiteLookupResult
}

beforeEach(() => {
  fetchSlaStatusesMock.mockReset().mockResolvedValue([])
  samplePrioritiesLookupMock.mockReset().mockResolvedValue([])
  getAnalysisServicesMock.mockReset().mockResolvedValue([
    { id: 10, keyword: 'identity_hplc', title: 'Identity (HPLC)' },
    { id: 11, keyword: 'purity_hplc',   title: 'Purity (HPLC)' },
    { id: 12, keyword: 'orphan_kw',     title: 'Orphan service' },
  ])
  getServiceGroupsMock.mockReset().mockResolvedValue([
    { id: 100, name: 'HPLC', sla_tier_id: 2, member_ids: [10, 11] },
  ])
  getSlaTiersMock.mockReset().mockResolvedValue([DEFAULT_TIER, HPLC_TIER])
  getSlaPriorityTiersMock.mockReset().mockResolvedValue([])
})

describe('useAnalysisSlaMap', () => {
  it('returns empty byKeyword when lookup is null', async () => {
    const { result } = renderHook(() => useAnalysisSlaMap(null), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.size).toBe(0)
    })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.priority).toBeNull()
  })

  it('returns empty byKeyword when sample has no date_received', async () => {
    const lookup = makeLookup({ date_received: null })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.size).toBe(0)
    })
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('maps each keyword to the snapshot for its resolved group', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|100',
        status: { elapsed_minutes: 60, remaining_minutes: 180, target_minutes: 240, breached: false },
      },
    ])
    const lookup = makeLookup({
      analyses: [
        { keyword: 'identity_hplc' } as never,
        { keyword: 'purity_hplc' } as never,
      ],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.byKeyword.size).toBe(2)
    expect(result.current.byKeyword.get('identity_hplc')?.tier.id).toBe(2)
    expect(result.current.byKeyword.get('purity_hplc')?.tier.id).toBe(2)
  })

  it('unmapped keyword falls through to default-tier snapshot when default exists', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|100',
        status: { elapsed_minutes: 30, remaining_minutes: 210, target_minutes: 240, breached: false },
      },
      {
        key: 'uid-PB-001|no-group',
        status: { elapsed_minutes: 30, remaining_minutes: 1410, target_minutes: 1440, breached: false },
      },
    ])
    const lookup = makeLookup({
      analyses: [
        { keyword: 'identity_hplc' } as never,
        { keyword: 'orphan_kw' } as never,
      ],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.size).toBe(2)
    })
    expect(result.current.byKeyword.get('identity_hplc')?.tier.id).toBe(2)
    expect(result.current.byKeyword.get('orphan_kw')?.tier.id).toBe(1)
  })

  it('unmapped keyword with NO default tier produces no entry', async () => {
    getSlaTiersMock.mockResolvedValue([HPLC_TIER]) // no default
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|100',
        status: { elapsed_minutes: 30, remaining_minutes: 210, target_minutes: 240, breached: false },
      },
    ])
    const lookup = makeLookup({
      analyses: [
        { keyword: 'identity_hplc' } as never,
        { keyword: 'orphan_kw' } as never,
      ],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.has('identity_hplc')).toBe(true)
    })
    expect(result.current.byKeyword.has('orphan_kw')).toBe(false)
  })

  it('null keyword on an analysis produces no entry', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|no-group',
        status: { elapsed_minutes: 30, remaining_minutes: 1410, target_minutes: 1440, breached: false },
      },
    ])
    const lookup = makeLookup({
      analyses: [{ keyword: null } as never],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.byKeyword.size).toBe(0)
  })

  it('forwards isPublished and priority from useSampleSla', async () => {
    samplePrioritiesLookupMock.mockResolvedValue([
      { sample_uid: 'uid-PB-001', priority: 'expedited' },
    ])
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|100',
        status: { elapsed_minutes: 600, remaining_minutes: -360, target_minutes: 240, breached: true },
      },
    ])
    const lookup = makeLookup({
      review_state: 'published',
      // @ts-expect-error -- partial shape for test
      published_coa: { published_date: '2026-01-01T19:00:00' },
      analyses: [{ keyword: 'identity_hplc' } as never],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.size).toBe(1)
    })
    expect(result.current.isPublished).toBe(true)
    expect(result.current.priority).toBe('expedited')
  })
})
