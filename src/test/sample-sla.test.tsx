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

describe('useSampleSla', () => {
  it('returns null snapshot + skips /sla/status when lookup is null', async () => {
    const { result } = renderHook(() => useSampleSla(null), { wrapper })
    // No /sla/status round-trip should fire.
    await waitFor(() => {
      expect(result.current.snapshot).toBeNull()
    })
    expect(result.current.reason).toBeNull()
    expect(result.current.priority).toBeNull()
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('returns null snapshot + skips /sla/status when sample is published', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const lookup = makeLookup({ review_state: 'published' })
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.snapshot).toBeNull()
    })
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('returns null snapshot when sample has no date_received', async () => {
    fetchSlaStatusesMock.mockResolvedValue([])
    const lookup = makeLookup({ date_received: null })
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.snapshot).toBeNull()
    })
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('returns snapshot with reason for received-but-unpublished sample (default tier)', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001',
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
      expect(result.current.snapshot).not.toBeNull()
    })
    expect(result.current.snapshot?.tier.name).toBe('default')
    // No services/groups configured + no priority override → tier from default.
    expect(result.current.reason?.tierSource).toBe('default')
    expect(result.current.priority).toBe('normal')
    // Status mapped → color computable.
    expect(result.current.snapshot?.color).toBeDefined()
    // Round-trip happened once.
    expect(fetchSlaStatusesMock).toHaveBeenCalledTimes(1)
    expect(fetchSlaStatusesMock.mock.calls[0]?.[0]).toEqual([
      {
        key: 'uid-PB-001',
        received_at: '2026-01-01T09:00:00',
        target_minutes: 1440,
        business_hours_only: false,
      },
    ])
  })

  it('returns null snapshot when no tier can be resolved (no default tier)', async () => {
    // Override the default tier mock to return zero tiers.
    getSlaTiersMock.mockResolvedValue([])
    const lookup = makeLookup()
    const { result } = renderHook(() => useSampleSla(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.snapshot).toBeNull()
    // Reason should still surface — tells the tooltip to say "no tier configured".
    expect(result.current.reason?.tierSource).toBe('none')
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })
})
