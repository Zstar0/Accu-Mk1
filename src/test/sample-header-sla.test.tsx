import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

const { SampleHeaderSla } = await import('@/components/senaite/SampleHeaderSla')

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

describe('SampleHeaderSla', () => {
  it('renders nothing when lookup is null', () => {
    const { container } = render(
      <SampleHeaderSla lookup={null} />,
      { wrapper }
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when sample has no date_received', () => {
    const lookup = makeLookup({ date_received: null })
    const { container } = render(<SampleHeaderSla lookup={lookup} />, { wrapper })
    expect(container.firstChild).toBeNull()
  })

  it('renders "took Xh" + met color for published sample within SLA', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|no-group',
        status: {
          target_minutes: 1440,
          elapsed_minutes: 1200,
          remaining_minutes: 240,
          breached: false,
        },
      },
    ])
    const lookup = makeLookup({
      review_state: 'published',
      published_coa: {
        published_date: '2026-01-01T22:00:00',
        publisher: 'tester',
        report_path: '/tmp/report.pdf',
      },
    } as unknown as Partial<SenaiteLookupResult>)
    render(<SampleHeaderSla lookup={lookup} />, { wrapper })
    await waitFor(() => {
      const el = screen.queryByTestId('sample-header-sla')
      expect(el?.getAttribute('data-sla-color')).toBe('met')
    })
    const el = screen.getByTestId('sample-header-sla')
    // i18n returns the key when no instance, so the text matches either the
    // rendered English "took" or the raw key "publishedTook".
    expect(el.textContent ?? '').toMatch(/took|publishedTook/i)
  })

  it('renders "took Xh" + missed color for published sample over SLA', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|no-group',
        status: {
          target_minutes: 1440,
          elapsed_minutes: 1920,
          remaining_minutes: -480,
          breached: true,
        },
      },
    ])
    const lookup = makeLookup({
      review_state: 'published',
      published_coa: {
        published_date: '2026-01-02T17:00:00',
        publisher: 'tester',
        report_path: '/tmp/report.pdf',
      },
    } as unknown as Partial<SenaiteLookupResult>)
    render(<SampleHeaderSla lookup={lookup} />, { wrapper })
    await waitFor(() => {
      const el = screen.queryByTestId('sample-header-sla')
      expect(el?.getAttribute('data-sla-color')).toBe('missed')
    })
    const el = screen.getByTestId('sample-header-sla')
    expect(el.textContent ?? '').toMatch(/took|publishedTook/i)
  })

  it('renders loading state while queries are in-flight', async () => {
    // fetchSlaStatusesMock returns a never-resolving promise to keep us in loading.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    fetchSlaStatusesMock.mockImplementation(() => new Promise(() => {}))
    const lookup = makeLookup()
    render(<SampleHeaderSla lookup={lookup} />, { wrapper })
    await waitFor(() => {
      const el = screen.queryByTestId('sample-header-sla')
      expect(el?.getAttribute('data-sla-color')).toBe('loading')
    })
  })

  it('renders green-ish indicator with breakdown tooltip trigger when status resolves', async () => {
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
    render(<SampleHeaderSla lookup={lookup} />, { wrapper })
    // Wait for the loading state to clear before asserting on color — all 5
    // upstream queries (tiers/groups/services/prio overrides/priorities) plus
    // the /sla/status call must settle for the snapshot to surface.
    await waitFor(() => {
      const el = screen.getByTestId('sample-header-sla')
      expect(el.getAttribute('data-sla-color')).not.toBe('loading')
    })
    const el = screen.getByTestId('sample-header-sla')
    // amber_threshold_percent=80 means 1320/1440=91.7% remaining → over threshold → green.
    expect(el.getAttribute('data-sla-color')).toBe('green')
  })

  it('renders red color and "over" text when sample is breached', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|no-group',
        status: {
          target_minutes: 1440,
          elapsed_minutes: 1700,
          remaining_minutes: -260,
          breached: true,
        },
      },
    ])
    const lookup = makeLookup()
    render(<SampleHeaderSla lookup={lookup} />, { wrapper })
    await waitFor(() => {
      const el = screen.queryByTestId('sample-header-sla')
      expect(el?.getAttribute('data-sla-color')).toBe('red')
    })
    const el = screen.getByTestId('sample-header-sla')
    // i18n returns the key when no instance, so we accept "over" in either form.
    expect(el.textContent ?? '').toMatch(/over|sla\.over/i)
  })

  // Multi-tier follow-on — when the sample's analyses span multiple groups,
  // the header shows one indicator span per group, worst-color first, each
  // labeled with the group name.
  it('renders one indicator per service group with worst-color first when sample spans multiple groups', async () => {
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
    // HPLC breached (red), Sterility on-track (green).
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
    render(<SampleHeaderSla lookup={lookup} />, { wrapper })
    await waitFor(() => {
      const els = screen.queryAllByTestId('sample-header-sla')
      expect(els.length).toBe(2)
    })
    const els = screen.getAllByTestId('sample-header-sla')
    // Red comes first (worst).
    expect(els[0]?.getAttribute('data-sla-color')).toBe('red')
    expect(els[0]?.getAttribute('data-group-key')).toBe('10')
    expect(els[0]?.textContent ?? '').toContain('HPLC')
    // Green second.
    expect(els[1]?.getAttribute('data-sla-color')).toBe('green')
    expect(els[1]?.getAttribute('data-group-key')).toBe('11')
    expect(els[1]?.textContent ?? '').toContain('Sterility')
  })

  it('single-group sample renders ONE unlabeled span (preserves legacy compact display)', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|no-group',
        status: { target_minutes: 1440, elapsed_minutes: 120, remaining_minutes: 1320, breached: false },
      },
    ])
    const lookup = makeLookup() // empty analyses → NO_GROUP_KEY default tier
    render(<SampleHeaderSla lookup={lookup} />, { wrapper })
    await waitFor(() => {
      expect(screen.queryAllByTestId('sample-header-sla').length).toBe(1)
    })
    const el = screen.getByTestId('sample-header-sla')
    // No "HPLC:" or "Sterility:" prefix — single-tier samples render without
    // a group label.
    expect(el.textContent ?? '').not.toContain(':')
  })
})
