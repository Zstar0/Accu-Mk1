import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { SenaiteLookupResult } from '@/lib/api'
import type * as PriorityApi from '@/lib/api-priorities'

// Selector-callable ui-store mock (same shape as src/test/sample-card.test.tsx).
vi.mock('@/store/ui-store', () => {
  const state = { navigateToSample: vi.fn() }
  const useUIStore = <T,>(selector: (s: typeof state) => T): T =>
    selector(state)
  useUIStore.getState = () => state
  return { useUIStore }
})

vi.mock('@/lib/api-profiles', () => ({
  getActiveEnvironmentName: vi.fn().mockReturnValue('test-env'),
  API_PROFILE_CHANGED_EVENT: 'api-profile-changed',
}))

// The normal render branch mounts FlagIndicator -> RaiseFlagButton ->
// useFlagUsers, whose queryFn is getWorksheetUsers.
vi.mock('@/lib/api', () => ({
  lookupSenaiteSample: vi.fn(),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
}))

// Spread the real module so every other named export services/priorities
// imports (assignPriority, patchPriority, ...) still resolves.
vi.mock('@/lib/api-priorities', async importOriginal => ({
  ...(await importOriginal<typeof PriorityApi>()),
  getPriorities: vi.fn(async () => [
    {
      key: 'expedited',
      name: 'Expedited',
      rank: 20,
      icon: 'chevrons-up',
      color: 'red',
      pulse: true,
      is_default: false,
      is_active: true,
      sla_tier_id: null,
    },
    {
      key: 'default',
      name: 'Default',
      rank: 0,
      icon: 'minus',
      color: 'zinc',
      pulse: false,
      is_default: true,
      is_active: true,
      sla_tier_id: null,
    },
  ]),
}))

const { SampleCard } = await import('@/components/explorer/SampleCard')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeLookup(
  overrides: Partial<SenaiteLookupResult> = {}
): SenaiteLookupResult {
  return {
    sample_id: 'PB-0512',
    sample_uid: null,
    client: null,
    contact: null,
    sample_type: null,
    date_received: null,
    date_sampled: null,
    profiles: [],
    client_order_number: null,
    client_sample_id: null,
    client_lot: null,
    review_state: 'sample_received',
    declared_weight_mg: null,
    analytes: [],
    coa: {
      has_coa: false,
      file_count: 0,
      has_download_warnings: false,
    } as never,
    remarks: [],
    analyses: [],
    attachments: [],
    published_coa: null,
    senaite_url: null,
    cached_at: null,
    ...overrides,
  }
}

describe('SampleCard priority glyph', () => {
  it('draws the glyph from the inline priority shape without any extra request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(
      <SampleCard
        sampleId="PB-0512"
        lookup={makeLookup({
          priority: {
            key: 'expedited',
            rank: 20,
            source_level: 'order',
            source_id: '3291',
          },
        })}
        isLoading={false}
        isError={false}
      />,
      { wrapper }
    )
    expect(
      await screen.findByRole('img', { name: 'Expedited via order 3291' })
    ).toBeInTheDocument()
    expect(
      fetchSpy.mock.calls.filter(([u]) =>
        String(u).includes('/priorities/resolve')
      )
    ).toHaveLength(0)
  })

  it('renders no glyph when the row resolves to the default priority', async () => {
    render(
      <SampleCard
        sampleId="PB-0513"
        lookup={makeLookup({
          sample_id: 'PB-0513',
          priority: {
            key: 'default',
            rank: 0,
            source_level: 'default',
            source_id: null,
          },
        })}
        isLoading={false}
        isError={false}
      />,
      { wrapper }
    )
    expect(await screen.findByText('PB-0513')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })
})
