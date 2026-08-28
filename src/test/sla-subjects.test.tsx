import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'
import type { SlaStatusRequestItem, SlaStatusResultItem } from '@/lib/api'

const fetchSlaStatusesMock =
  vi.fn<(items: SlaStatusRequestItem[]) => Promise<SlaStatusResultItem[]>>()
const getServiceGroupsMock = vi.fn()
const getSlaTiersMock = vi.fn()
const getSlaPriorityTiersMock = vi.fn()
const getAnalysisServicesMock = vi.fn()
const getAnalysisProfilesMock = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api')
  return {
    ...actual,
    fetchSlaStatuses: (items: SlaStatusRequestItem[]) =>
      fetchSlaStatusesMock(items),
    getServiceGroups: () => getServiceGroupsMock(),
    getSlaTiers: () => getSlaTiersMock(),
    getSlaPriorityTiers: () => getSlaPriorityTiersMock(),
    getAnalysisServices: () => getAnalysisServicesMock(),
    getAnalysisProfiles: () => getAnalysisProfilesMock(),
  }
})

const { useSlaForSubjects, pickWorstSnapshot } =
  await import('@/services/sla-subjects')
import type { SlaSubject, SlaSubjectSnapshot } from '@/services/sla-subjects'

function Wrapper({ children }: { children: React.ReactNode }) {
  const [qc] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  )
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
const RUSH_TIER = {
  id: 3,
  name: 'Rush',
  target_minutes: 120,
  business_hours_only: false,
  is_default: false,
  amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
}

beforeEach(() => {
  fetchSlaStatusesMock.mockReset().mockResolvedValue([])
  getServiceGroupsMock
    .mockReset()
    .mockResolvedValue([
      { id: 100, name: 'HPLC', sla_tier_id: 2, member_ids: [10, 11] },
    ])
  getSlaTiersMock
    .mockReset()
    .mockResolvedValue([DEFAULT_TIER, HPLC_TIER, RUSH_TIER])
  getSlaPriorityTiersMock.mockReset().mockResolvedValue([])
  // Task 11 catalogs — defaults are empty so keyword-less tests (and any
  // pre-profile test) resolve exactly as before the profile step existed.
  getAnalysisServicesMock.mockReset().mockResolvedValue([])
  getAnalysisProfilesMock.mockReset().mockResolvedValue([])
})

function snap(over: Partial<SlaSubjectSnapshot>): SlaSubjectSnapshot {
  return {
    key: 'k',
    status: {
      elapsed_minutes: 60,
      remaining_minutes: 180,
      target_minutes: 240,
      breached: false,
    },
    color: 'green',
    tier: HPLC_TIER,
    priority: 'normal',
    groupId: 100,
    isFrozen: false,
    ...over,
  } as SlaSubjectSnapshot
}

describe('useSlaForSubjects', () => {
  it('returns empty byKey + no fetch for empty subjects', async () => {
    const { result } = renderHook(() => useSlaForSubjects([]), {
      wrapper: Wrapper,
    })
    await waitFor(() => {
      expect(result.current.byKey.size).toBe(0)
      expect(result.current.isLoading).toBe(false)
    })
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('resolves a subject to its group own tier', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 's1',
        status: {
          elapsed_minutes: 60,
          remaining_minutes: 180,
          target_minutes: 240,
          breached: false,
        },
      },
    ])
    const subjects: SlaSubject[] = [
      {
        key: 's1',
        priority: 'normal',
        groupId: 100,
        receivedAt: '2026-01-01T09:00:00',
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.byKey.size).toBe(1))
    expect(result.current.byKey.get('s1')?.tier.id).toBe(2)
    expect(result.current.byKey.get('s1')?.groupName).toBe('HPLC')
  })

  it('global priority override beats the group tier', async () => {
    getSlaPriorityTiersMock.mockResolvedValue([
      { priority: 'expedited', sla_tier_id: 3, service_group_id: null },
    ])
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 's1',
        status: {
          elapsed_minutes: 10,
          remaining_minutes: 110,
          target_minutes: 120,
          breached: false,
        },
      },
    ])
    const subjects: SlaSubject[] = [
      {
        key: 's1',
        priority: 'expedited',
        groupId: 100,
        receivedAt: '2026-01-01T09:00:00',
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.byKey.size).toBe(1))
    expect(result.current.byKey.get('s1')?.tier.id).toBe(3) // RUSH, not HPLC
  })

  it('per-(priority, group) override beats the global override', async () => {
    getSlaPriorityTiersMock.mockResolvedValue([
      { priority: 'expedited', sla_tier_id: 3, service_group_id: null }, // global → RUSH
      { priority: 'expedited', sla_tier_id: 1, service_group_id: 100 }, // per-group → DEFAULT
    ])
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 's1',
        status: {
          elapsed_minutes: 10,
          remaining_minutes: 1430,
          target_minutes: 1440,
          breached: false,
        },
      },
    ])
    const subjects: SlaSubject[] = [
      {
        key: 's1',
        priority: 'expedited',
        groupId: 100,
        receivedAt: '2026-01-01T09:00:00',
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.byKey.size).toBe(1))
    expect(result.current.byKey.get('s1')?.tier.id).toBe(1) // per-group DEFAULT wins
  })

  it('null groupId resolves the default tier; no default → no snapshot', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 's1',
        status: {
          elapsed_minutes: 10,
          remaining_minutes: 1430,
          target_minutes: 1440,
          breached: false,
        },
      },
    ])
    const subjects: SlaSubject[] = [
      {
        key: 's1',
        priority: 'normal',
        groupId: null,
        receivedAt: '2026-01-01T09:00:00',
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.byKey.get('s1')?.tier.id).toBe(1))

    // No default tier configured → subject yields no snapshot.
    getSlaTiersMock.mockResolvedValue([HPLC_TIER]) // no is_default
    const { result: r2 } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(r2.current.isLoading).toBe(false))
    expect(r2.current.byKey.has('s1')).toBe(false)
  })

  it('null receivedAt → no batch item, no snapshot', async () => {
    const subjects: SlaSubject[] = [
      { key: 's1', priority: 'normal', groupId: 100, receivedAt: null },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.byKey.has('s1')).toBe(false)
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('completedAt sets now_override and marks snapshot frozen', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 's1',
        status: {
          elapsed_minutes: 200,
          remaining_minutes: 40,
          target_minutes: 240,
          breached: false,
        },
      },
    ])
    const subjects: SlaSubject[] = [
      {
        key: 's1',
        priority: 'normal',
        groupId: 100,
        receivedAt: '2026-01-01T09:00:00',
        completedAt: '2026-01-01T12:20:00',
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.byKey.size).toBe(1))
    expect(result.current.byKey.get('s1')?.isFrozen).toBe(true)
    const sentItems = fetchSlaStatusesMock.mock.calls[0]?.[0]
    expect(sentItems?.[0]?.now_override).toBe('2026-01-01T12:20:00')
  })
})

describe('pickWorstSnapshot', () => {
  it('returns null for empty array', () => {
    expect(pickWorstSnapshot([])).toBeNull()
  })

  it('ranks live-red over frozen-missed over live-amber over live-green over frozen-met', () => {
    const liveRed = snap({
      key: 'red',
      color: 'red',
      status: {
        elapsed_minutes: 300,
        remaining_minutes: -60,
        target_minutes: 240,
        breached: true,
      },
    })
    const frozenMissed = snap({
      key: 'fm',
      isFrozen: true,
      color: 'red',
      status: {
        elapsed_minutes: 300,
        remaining_minutes: -60,
        target_minutes: 240,
        breached: true,
      },
    })
    const liveAmber = snap({
      key: 'amb',
      color: 'amber',
      status: {
        elapsed_minutes: 210,
        remaining_minutes: 30,
        target_minutes: 240,
        breached: false,
      },
    })
    const liveGreen = snap({ key: 'grn', color: 'green' })
    const frozenMet = snap({
      key: 'met',
      isFrozen: true,
      color: 'green',
      status: {
        elapsed_minutes: 100,
        remaining_minutes: 140,
        target_minutes: 240,
        breached: false,
      },
    })

    expect(
      pickWorstSnapshot([
        frozenMet,
        liveGreen,
        liveAmber,
        frozenMissed,
        liveRed,
      ])?.key
    ).toBe('red')
    expect(
      pickWorstSnapshot([frozenMet, liveGreen, liveAmber, frozenMissed])?.key
    ).toBe('fm')
    expect(pickWorstSnapshot([frozenMet, liveGreen, liveAmber])?.key).toBe(
      'amb'
    )
    expect(pickWorstSnapshot([frozenMet, liveGreen])?.key).toBe('grn')
    expect(pickWorstSnapshot([frozenMet])?.key).toBe('met')
  })

  it('breaks live-red ties by most-over (lowest remaining_minutes)', () => {
    const a = snap({
      key: 'a',
      color: 'red',
      status: {
        elapsed_minutes: 300,
        remaining_minutes: -60,
        target_minutes: 240,
        breached: true,
      },
    })
    const b = snap({
      key: 'b',
      color: 'red',
      status: {
        elapsed_minutes: 360,
        remaining_minutes: -120,
        target_minutes: 240,
        breached: true,
      },
    })
    expect(pickWorstSnapshot([a, b])?.key).toBe('b')
  })

  it('breaks live-amber ties by least percent remaining', () => {
    // 'a': 90/120 = 75% remaining; 'b': 30/240 = 12.5% remaining → b is closer to breach
    const a = snap({
      key: 'a',
      color: 'amber',
      status: {
        elapsed_minutes: 30,
        remaining_minutes: 90,
        target_minutes: 120,
        breached: false,
      },
    })
    const b = snap({
      key: 'b',
      color: 'amber',
      status: {
        elapsed_minutes: 210,
        remaining_minutes: 30,
        target_minutes: 240,
        breached: false,
      },
    })
    expect(pickWorstSnapshot([a, b])?.key).toBe('b')
  })
})

// ── Profile-SLA precedence step (Task 11 wiring, 2026-08-27) ────────────────
// The subject resolver was profile-blind: worksheet/inbox surfaces resolved
// usp71 items to the 24h group/default tier while Order Status resolved the
// profile's 14-day tier. Subjects now optionally carry analysis keywords;
// precedence must stay in lockstep with sla-resolution's resolveSampleTier:
// priority > profile > group > default.

describe('useSlaForSubjects — profile tier step', () => {
  const USP71_TIER = {
    id: 4,
    name: 'USP71',
    target_minutes: 6720,
    business_hours_only: false,
    is_default: false,
    amber_threshold_percent: 20,
    created_at: '2026-01-01T00:00:00',
    updated_at: '2026-01-01T00:00:00',
  }

  function seedProfileCatalogs() {
    getSlaTiersMock.mockResolvedValue([
      DEFAULT_TIER,
      HPLC_TIER,
      RUSH_TIER,
      USP71_TIER,
    ])
    getAnalysisServicesMock.mockResolvedValue([
      { id: 50, keyword: 'STER-USP71' },
      { id: 51, keyword: 'HPLC-PUR' },
    ])
    getAnalysisProfilesMock.mockResolvedValue([
      {
        id: 8,
        key: 'sterility-usp71',
        name: 'Sterility USP 71',
        active: true,
        sla_tier_id: 4,
        member_service_ids: [50],
      },
    ])
    fetchSlaStatusesMock.mockImplementation(
      async (items: SlaStatusRequestItem[]) =>
        items.map(i => ({
          key: i.key,
          status: {
            elapsed_minutes: 60,
            remaining_minutes: i.target_minutes - 60,
            target_minutes: i.target_minutes,
            breached: false,
          },
        }))
    )
  }

  it('a tiered profile covering a subject keyword beats the group tier', async () => {
    seedProfileCatalogs()
    const subjects: SlaSubject[] = [
      {
        key: 'usp71-vial',
        priority: 'normal',
        groupId: 100,
        receivedAt: '2026-08-24T12:00:00Z',
        keywords: ['STER-USP71'],
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const s = result.current.byKey.get('usp71-vial')
    expect(s?.tier.name).toBe('USP71')
    expect(s?.status.target_minutes).toBe(6720)
    expect(s?.reason?.tierSource).toBe('profile')
    expect(s?.reason?.profileName).toBe('Sterility USP 71')
  })

  it('keywords outside any tiered profile keep the group tier (source=group)', async () => {
    seedProfileCatalogs()
    const subjects: SlaSubject[] = [
      {
        key: 'hplc-vial',
        priority: 'normal',
        groupId: 100,
        receivedAt: '2026-08-24T12:00:00Z',
        keywords: ['HPLC-PUR'],
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const s = result.current.byKey.get('hplc-vial')
    expect(s?.tier.name).toBe('HPLC fast')
    expect(s?.reason?.tierSource).toBe('group')
  })

  it('a priority override still beats the profile tier (lockstep chain)', async () => {
    seedProfileCatalogs()
    getSlaPriorityTiersMock.mockResolvedValue([
      { id: 1, priority: 'high', sla_tier_id: 3, service_group_id: null },
    ])
    const subjects: SlaSubject[] = [
      {
        key: 'rush-usp71',
        priority: 'high',
        groupId: 100,
        receivedAt: '2026-08-24T12:00:00Z',
        keywords: ['STER-USP71'],
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const s = result.current.byKey.get('rush-usp71')
    expect(s?.tier.name).toBe('Rush')
    expect(s?.reason?.tierSource).toBe('priority')
  })

  it('fails open to group resolution when the profile catalogs error', async () => {
    seedProfileCatalogs()
    getAnalysisProfilesMock.mockRejectedValue(new Error('boom'))
    const subjects: SlaSubject[] = [
      {
        key: 'degraded',
        priority: 'normal',
        groupId: 100,
        receivedAt: '2026-08-24T12:00:00Z',
        keywords: ['STER-USP71'],
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await waitFor(() => expect(result.current.byKey.size).toBe(1))
    const s = result.current.byKey.get('degraded')
    expect(result.current.isError).toBe(false)
    expect(s?.tier.name).toBe('HPLC fast')
  })

  it('keyword-less subjects never wait on the profile catalogs', async () => {
    // Catalog fetches hang forever — a keyword-less subject must still resolve.
    getAnalysisServicesMock.mockImplementation(() => new Promise(() => {}))
    getAnalysisProfilesMock.mockImplementation(() => new Promise(() => {}))
    fetchSlaStatusesMock.mockImplementation(
      async (items: SlaStatusRequestItem[]) =>
        items.map(i => ({
          key: i.key,
          status: {
            elapsed_minutes: 60,
            remaining_minutes: i.target_minutes - 60,
            target_minutes: i.target_minutes,
            breached: false,
          },
        }))
    )
    const subjects: SlaSubject[] = [
      {
        key: 'plain',
        priority: 'normal',
        groupId: 100,
        receivedAt: '2026-08-24T12:00:00Z',
      },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.byKey.get('plain')?.tier.name).toBe('HPLC fast')
  })
})
