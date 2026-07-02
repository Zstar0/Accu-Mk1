import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, fireEvent, waitFor } from '@/test/test-utils'
import type { FlagResponse } from '@/lib/flags-api'
import { useUIStore } from '@/store/ui-store'

// Mock the user directory so cards don't hit the network.
vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? 'Unassigned' : `User ${id}`,
  initialsForUser: () => 'U',
  avatarColor: () => '#888888',
}))

// Mock the data hooks — these tests guard wiring, not the network.
const useFlagsList = vi.fn()
const useEntityFlags = vi.fn((..._args: unknown[]) => ({
  data: [] as FlagResponse[],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}))
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useFlagsList: (...args: unknown[]) => useFlagsList(...args),
    useEntityFlags: (...args: unknown[]) => useEntityFlags(...args),
    useFlag: () => ({ data: undefined, isLoading: true, isError: false }),
    useCreateFlag: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

function flag(id: number, title: string): FlagResponse {
  return {
    id,
    entity_type: 'sub_sample',
    entity_id: String(id),
    kind: 'issue',
    type: 'blocker',
    status: 'open',
    title,
    created_by: 1,
    assignee_id: 1,
    created_at: '2026-06-30T12:00:00',
    updated_at: '2026-06-30T12:00:00',
    resolved_at: null,
    resolved_by: null,
  }
}

describe('FlagsFlyout', () => {
  beforeEach(() => {
    useFlagsList.mockReset()
    useFlagsList.mockReturnValue({
      data: [flag(1, 'Crashed out — needs re-prep'), flag(2, 'Photo missing')],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    useUIStore.setState({
      flagsFlyoutOpen: true,
      flagsThreadId: null,
      flagsEntityFilter: null,
    })
  })

  it('renders the cards for the default (assigned) tab', async () => {
    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)

    expect(
      await screen.findByText('Crashed out — needs re-prep')
    ).toBeInTheDocument()
    expect(screen.getByText('Photo missing')).toBeInTheDocument()
    // Default tab drives the list query.
    expect(useFlagsList).toHaveBeenCalledWith('assigned')
  })

  it('switches the list query when another tab is clicked', async () => {
    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)

    await userEvent.click(await screen.findByRole('tab', { name: 'All open' }))

    await waitFor(() =>
      expect(useFlagsList).toHaveBeenLastCalledWith('all_open')
    )
  })

  it('opens a thread when a card is clicked', async () => {
    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)

    fireEvent.click(await screen.findByText('Crashed out — needs re-prep'))

    expect(useUIStore.getState().flagsThreadId).toBe(1)
  })

  it('renders the resolved entity chip and navigates on chip click', async () => {
    const f = flag(1, 'Crashed out — needs re-prep')
    f.entity = {
      entity_type: 'sub_sample',
      entity_id: '1',
      label: 'P-0071-S01',
      sample_id: 'P-0071',
      analyses: ['PEPT-Total', 'HPLC-PUR'],
      lot: null,
      deep_link: { kind: 'sample', id: 'P-0071' },
    }
    useFlagsList.mockReturnValue({
      data: [f],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })

    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)

    // Resolved label on the entity chip (table view).
    const chipLabel = await screen.findByText('P-0071-S01')

    // Clicking the chip deep-links via the resolved deep_link (vial → parent
    // sample), and does NOT open the thread.
    fireEvent.click(chipLabel)
    expect(useUIStore.getState().sampleDetailsTargetId).toBe('P-0071')
    expect(useUIStore.getState().flagsThreadId).toBeNull()
  })

  it('samples (order) scope filters the all_open list, labels the header, and clears back to tabs', async () => {
    const inOrder = flag(1, 'On P-0001')
    inOrder.entity = {
      entity_type: 'sample',
      entity_id: 'P-0001',
      label: 'P-0001',
      sample_id: 'P-0001',
      analyses: [],
      lot: null,
      deep_link: { kind: 'sample', id: 'P-0001' },
    }
    const elsewhere = flag(2, 'On some other sample')
    elsewhere.entity = {
      entity_type: 'sample',
      entity_id: 'P-9999',
      label: 'P-9999',
      sample_id: 'P-9999',
      analyses: [],
      lot: null,
      deep_link: { kind: 'sample', id: 'P-9999' },
    }
    // The flyout reads useFlagsList('all_open') for the samples scope.
    useFlagsList.mockReturnValue({
      data: [inOrder, elsewhere],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    useUIStore.setState({
      flagsFlyoutOpen: true,
      flagsThreadId: null,
      flagsEntityFilter: null,
      flagsSamplesFilter: { label: '#1042', sampleIds: ['P-0001'] },
    })

    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)

    // Order-scoped header label; tabs hidden.
    expect(await screen.findByText('Flags · #1042')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'All open' })).toBeNull()
    // Only the in-order sample's flag is listed.
    expect(screen.getByText('On P-0001')).toBeInTheDocument()
    expect(screen.queryByText('On some other sample')).toBeNull()

    // Clearing the order filter returns to the tabs.
    fireEvent.click(screen.getByRole('button', { name: /clear order filter/i }))
    expect(useUIStore.getState().flagsSamplesFilter).toBeNull()
  })

  it('samples scope with no matching flags shows a prominent +New flag empty state', async () => {
    useFlagsList.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    useUIStore.setState({
      flagsFlyoutOpen: true,
      flagsThreadId: null,
      flagsEntityFilter: null,
      flagsSamplesFilter: { label: '#1042', sampleIds: ['P-0001', 'P-0002'] },
    })

    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)

    expect(
      await screen.findByText(/no flags on #1042 yet — raise one/i)
    ).toBeInTheDocument()
    // The empty state offers a working raise affordance (order → sample picker).
    expect(
      screen.getAllByRole('button', { name: /raise a flag/i }).length
    ).toBeGreaterThan(0)
  })

  it('entity-filter mode shows a labeled chip + entity list and can clear back to tabs', async () => {
    const f = flag(1, 'Crashed out — needs re-prep')
    f.entity = {
      entity_type: 'sample',
      entity_id: 'P-0071',
      label: 'P-0071',
      sample_id: 'P-0071',
      analyses: [],
      lot: null,
      deep_link: { kind: 'sample', id: 'P-0071' },
    }
    useEntityFlags.mockReturnValue({
      data: [f],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    useUIStore.setState({
      flagsFlyoutOpen: true,
      flagsThreadId: null,
      flagsEntityFilter: {
        type: 'sample',
        id: 'P-0071',
        includeDescendants: true,
      },
    })

    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)

    // Header chip uses the resolved label; the tabs are not shown.
    expect(await screen.findByText('Flags on P-0071')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'All open' })).toBeNull()
    // Entity-filtered list drives the visible cards.
    expect(useEntityFlags).toHaveBeenCalled()
    expect(screen.getByText('Crashed out — needs re-prep')).toBeInTheDocument()

    // Clearing the filter returns to the tabs.
    fireEvent.click(
      screen.getByRole('button', { name: /clear entity filter/i })
    )
    expect(useUIStore.getState().flagsEntityFilter).toBeNull()
  })
})

describe('FlagsFlyout context-aware Add Flag', () => {
  beforeEach(() => {
    useFlagsList.mockReset()
    useFlagsList.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    useUIStore.setState({
      flagsFlyoutOpen: true,
      flagsThreadId: null,
      flagsEntityFilter: null,
      flagsSamplesFilter: null,
      activeFlagEntityStack: [],
    })
  })

  it('hides Add Flag when no entity page is active', async () => {
    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)
    await screen.findByRole('tab', { name: 'Assigned to me' })
    expect(
      screen.queryByRole('button', { name: /add flag/i })
    ).not.toBeInTheDocument()
  })

  it('shows Add Flag preset to the active entity (no manual id form)', async () => {
    useUIStore.setState({
      activeFlagEntityStack: [
        { type: 'sample', id: 'P-0071', label: 'P-0071' },
      ],
    })
    const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
    render(<FlagsFlyout />)

    await userEvent.click(
      await screen.findByRole('button', { name: /add flag/i })
    )
    // Compose targets the page entity: label line present, no raw-id input.
    expect(await screen.findByText('on P-0071')).toBeInTheDocument()
    expect(screen.queryByText('Entity id')).not.toBeInTheDocument()
  })
})
