import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import type { FlagResponse } from '@/lib/flags-api'
import type { FlagRollup } from '@/hooks/use-open-flags-by-sample'
import { useUIStore } from '@/store/ui-store'

// Drive the rollup directly — the page-wide hook is mocked so these tests cover
// the indicator's visual states + click wiring, not the fetch.
const mockHook = {
  map: new Map<string, FlagRollup>(),
  rollupForSamples: vi.fn((_ids: string[]) => EMPTY),
}
vi.mock('@/hooks/use-open-flags-by-sample', () => ({
  useOpenFlagsBySample: () => mockHook,
}))
vi.mock('@/services/flag-types', () => ({
  useFlagTypesMap: () => ({
    blocker: { label: 'Blocker', color: '#e5484d', kind: 'issue' },
    question: { label: 'Question', color: '#3b82f6', kind: 'issue' },
  }),
  // RaiseFlagButton (rendered for the unflagged indicator) reads the catalog.
  useFlagTypes: () => ({ data: [] }),
}))

const EMPTY: FlagRollup = {
  count: 0,
  flags: [],
  dominantType: null,
  dominantColor: null,
}

function f(id: number, type = 'blocker'): FlagResponse {
  return {
    id,
    entity_type: 'sample',
    entity_id: 'P-0001',
    kind: 'issue',
    type,
    status: 'open',
    title: `flag ${id}`,
    created_by: 1,
    assignee_id: null,
    created_at: '2026-06-30T12:00:00',
    updated_at: '2026-06-30T12:00:00',
    resolved_at: null,
    resolved_by: null,
  }
}

describe('FlagIndicator', () => {
  beforeEach(() => {
    mockHook.map = new Map()
    mockHook.rollupForSamples = vi.fn(() => EMPTY)
    useUIStore.setState({
      flagsFlyoutOpen: false,
      flagsThreadId: null,
      flagsEntityFilter: null,
      flagsSamplesFilter: null,
    })
  })

  it('unflagged sample → clicking opens the Raise-a-flag compose, not the flyout', async () => {
    const { FlagIndicator } = await import('@/components/flags/FlagIndicator')
    render(<FlagIndicator scope={{ kind: 'sample', sampleId: 'P-0001' }} />)

    const btn = screen.getByTestId('flag-indicator')
    expect(btn).toHaveAttribute('data-flagged', 'false')
    expect(btn).toHaveAccessibleName(/raise one/i)

    fireEvent.click(btn)
    // The raise compose opens; the scoped flyout does NOT.
    expect(await screen.findByText('Raise a flag')).toBeInTheDocument()
    expect(useUIStore.getState().flagsFlyoutOpen).toBe(false)
    expect(useUIStore.getState().flagsEntityFilter).toBeNull()
  })

  it('flagged sample → colored flag with count = dominant color, opens scoped flyout', async () => {
    mockHook.map.set('P-0001', {
      count: 3,
      flags: [f(1, 'blocker'), f(2, 'blocker'), f(3, 'question')],
      dominantType: 'blocker',
      dominantColor: '#e5484d',
    })
    const { FlagIndicator } = await import('@/components/flags/FlagIndicator')
    render(<FlagIndicator scope={{ kind: 'sample', sampleId: 'P-0001' }} />)

    const btn = screen.getByTestId('flag-indicator')
    expect(btn).toHaveAttribute('data-flagged', 'true')
    // Count badge (>1) + dominant color applied.
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(btn).toHaveStyle({ color: '#e5484d' })

    fireEvent.click(btn)
    expect(useUIStore.getState().flagsEntityFilter?.id).toBe('P-0001')
  })

  it('order scope → rolls up the samples and opens the samples-scoped flyout', async () => {
    mockHook.rollupForSamples = vi.fn(() => ({
      count: 2,
      flags: [f(1, 'blocker'), f(2, 'question')],
      dominantType: 'blocker',
      dominantColor: '#e5484d',
    }))
    const { FlagIndicator } = await import('@/components/flags/FlagIndicator')
    render(
      <FlagIndicator
        scope={{
          kind: 'order',
          orderId: '1042',
          sampleIds: ['P-0001', 'P-0002'],
          label: '#1042',
        }}
        variant="pill"
      />
    )

    const btn = screen.getByTestId('flag-indicator')
    fireEvent.click(btn)
    expect(useUIStore.getState().flagsSamplesFilter).toEqual({
      label: '#1042',
      sampleIds: ['P-0001', 'P-0002'],
    })
    expect(mockHook.rollupForSamples).toHaveBeenCalledWith(['P-0001', 'P-0002'])
  })
})
