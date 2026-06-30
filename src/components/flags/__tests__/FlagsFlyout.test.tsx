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
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useFlagsList: (...args: unknown[]) => useFlagsList(...args),
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
    useUIStore.setState({ flagsFlyoutOpen: true, flagsThreadId: null })
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

  it('renders resolved entity context (Sample ID + analytes) and navigates on chip click', async () => {
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

    // Resolved label on the chip + secondary context line.
    const chipLabel = await screen.findByText('P-0071-S01')
    expect(screen.getByText('P-0071')).toBeInTheDocument()
    expect(screen.getByText('PEPT-Total, HPLC-PUR')).toBeInTheDocument()

    // Clicking the chip deep-links via the resolved deep_link (vial → parent
    // sample), and does NOT open the thread.
    fireEvent.click(chipLabel)
    expect(useUIStore.getState().sampleDetailsTargetId).toBe('P-0071')
    expect(useUIStore.getState().flagsThreadId).toBeNull()
  })
})
