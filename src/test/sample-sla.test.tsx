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

const { useSampleSla } = await import('@/services/sample-sla')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
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
  fetchSlaStatusesMock.mockReset()
  samplePrioritiesLookupMock.mockReset().mockResolvedValue([])
  getAnalysisServicesMock.mockClear().mockResolvedValue([])
  getServiceGroupsMock.mockClear().mockResolvedValue([])
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
  getSlaPriorityTiersMock.mockClear().mockResolvedValue([])
})

describe('useSampleSla', () => {
  it('returns empty snapshots + skips /sla/status when lookup is null', async () => {
    const { result } = renderHook(() => useSampleSla(null), { wrapper })
    await waitFor(() => {
      expect(result.current.snapshots).toEqual([])
    })
    expect(result.current.priority).toBeNull()
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('skips /sla/status when sample is published but has no published_date (defensive)', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const lookup = makeLookup({ review_state: 'published' })
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    // No published_coa.published_date → isPublished should be false.
    expect(result.current.isPublished).toBe(false)
  })

  it('flows through for published samples with published_date and passes now_override on each batch item', async () => {
    // Multi-tier reshape: composite key `${uid}|${groupKey}`. Empty analyses
    // → NO_GROUP_KEY bucket → 'no-group' suffix.
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|no-group',
        status: {
          target_minutes: 1440,
          elapsed_minutes: 1680, // 28h
          remaining_minutes: -240,
          breached: true,
        },
      },
    ])
    const lookup = makeLookup({
      review_state: 'published',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      published_coa: { published_date: '2026-01-02T13:00:00' } as any,
    })
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.snapshots.length).toBeGreaterThan(0)
    })
    expect(result.current.isPublished).toBe(true)
    expect(fetchSlaStatusesMock).toHaveBeenCalledTimes(1)
    const sent = fetchSlaStatusesMock.mock.calls[0]?.[0]
    expect(sent?.[0]?.now_override).toBe('2026-01-02T13:00:00')
  })

  it('omits now_override for non-published (live) samples', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|no-group',
        status: {
          target_minutes: 1440,
          elapsed_minutes: 60,
          remaining_minutes: 1380,
          breached: false,
        },
      },
    ])
    const lookup = makeLookup() // default review_state = sample_received
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.snapshots.length).toBeGreaterThan(0)
    })
    expect(result.current.isPublished).toBe(false)
    const sent = fetchSlaStatusesMock.mock.calls[0]?.[0]
    expect(sent?.[0]?.now_override).toBeUndefined()
  })

  it('returns empty snapshots when sample has no date_received', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const lookup = makeLookup({ date_received: null })
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.snapshots).toEqual([])
    })
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('returns a single default-tier snapshot for a received sample with no analyses', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|no-group',
        status: {
          target_minutes: 1440,
          elapsed_minutes: 120,
          remaining_minutes: 1320,
          breached: false,
        },
      },
    ])
    const lookup = makeLookup()
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.snapshots.length).toBe(1)
    })
    const snapshot = result.current.snapshots[0]
    expect(snapshot?.tier.name).toBe('default')
    expect(snapshot?.groupKey).toBe('no-group')
    // No services/groups configured → tier from default.
    expect(snapshot?.reason.tierSource).toBe('default')
    expect(result.current.priority).toBe('normal')
    // Status mapped → color computable.
    expect(snapshot?.color).toBeDefined()
    // Round-trip happened once.
    expect(fetchSlaStatusesMock).toHaveBeenCalledTimes(1)
    expect(fetchSlaStatusesMock.mock.calls[0]?.[0]).toEqual([
      {
        key: 'uid-PB-001|no-group',
        received_at: '2026-01-01T09:00:00',
        target_minutes: 1440,
        business_hours_only: false,
      },
    ])
  })

  it('returns empty snapshots when no tier can be resolved (no default tier)', async () => {
    // Override the default tier mock to return zero tiers.
    getSlaTiersMock.mockResolvedValue([])
    const lookup = makeLookup()
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.snapshots).toEqual([])
    // No batch fires because all perGroup entries have null tier.
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('returns one snapshot per service group when the sample spans multiple groups (multi-tier)', async () => {
    // HPLC 24h + Sterility 7d tiers
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
    fetchSlaStatusesMock.mockResolvedValue([
      { key: 'uid-PB-001|10', status: { target_minutes: 1440, elapsed_minutes: 2880, remaining_minutes: -1440, breached: true } },
      { key: 'uid-PB-001|11', status: { target_minutes: 10080, elapsed_minutes: 100, remaining_minutes: 9980, breached: false } },
    ])
    const lookup = makeLookup({
      analyses: [
        { keyword: 'kw_hplc' } as never,
        { keyword: 'kw_sterility' } as never,
      ],
    })
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.snapshots.length).toBe(2)
    })
    const byGroup = new Map(result.current.snapshots.map(s => [s.groupKey, s]))
    expect(byGroup.get(10)?.tier.id).toBe(hplcTier.id)
    expect(byGroup.get(10)?.groupName).toBe('HPLC')
    expect(byGroup.get(10)?.color).toBe('red') // breached
    expect(byGroup.get(11)?.tier.id).toBe(sterTier.id)
    expect(byGroup.get(11)?.groupName).toBe('Sterility')
    expect(byGroup.get(11)?.color).toBe('green') // on-track
  })
})
