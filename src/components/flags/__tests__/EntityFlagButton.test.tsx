import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import type { FlagResponse } from '@/lib/flags-api'
import { useUIStore } from '@/store/ui-store'

// Mock the user directory so the reused RaiseFlagButton compose doesn't hit the
// network when the unflagged affordance opens.
vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? 'Unassigned' : `User ${id}`,
}))

// Mock the data hook — these tests drive the three visual states directly.
const useEntityFlags = vi.fn()
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useEntityFlags: (...args: unknown[]) => useEntityFlags(...args),
    useCreateFlag: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

function f(id: number, type = 'blocker', status = 'open'): FlagResponse {
  return {
    id,
    entity_type: 'sub_sample',
    entity_id: String(id),
    kind: 'issue',
    type,
    status,
    title: `flag ${id}`,
    created_by: 1,
    assignee_id: null,
    created_at: '2026-06-30T12:00:00',
    updated_at: '2026-06-30T12:00:00',
    resolved_at: null,
    resolved_by: null,
  }
}

describe('EntityFlagButton', () => {
  beforeEach(() => {
    useEntityFlags.mockReset()
    useUIStore.setState({
      flagsFlyoutOpen: false,
      flagsThreadId: null,
      flagsEntityFilter: null,
    })
  })

  it('unflagged → outline affordance that opens the raise compose', async () => {
    useEntityFlags.mockReturnValue({ data: [] })
    const { EntityFlagButton } =
      await import('@/components/flags/EntityFlagButton')
    render(<EntityFlagButton entityType="sample" entityId="P-0071" />)

    const btn = screen.getByRole('button', {
      name: /raise a flag on this item/i,
    })
    expect(btn).toHaveTextContent('Flag')

    fireEvent.click(btn)
    // The reused compose popover opens.
    expect(await screen.findByText('Raise a flag')).toBeInTheDocument()
  })

  it('one open flag → colored pill that opens that thread', async () => {
    useEntityFlags.mockReturnValue({ data: [f(7, 'blocker', 'open')] })
    const { EntityFlagButton } =
      await import('@/components/flags/EntityFlagButton')
    render(<EntityFlagButton entityType="sub_sample" entityId="42" />)

    const btn = screen.getByRole('button', { name: /open it/i })
    fireEvent.click(btn)
    expect(useUIStore.getState().flagsThreadId).toBe(7)
  })

  it('several open flags → pill with count that opens the filtered flyout', async () => {
    useEntityFlags.mockReturnValue({
      data: [f(1, 'critical'), f(2, 'blocker'), f(3, 'question')],
    })
    const { EntityFlagButton } =
      await import('@/components/flags/EntityFlagButton')
    render(
      <EntityFlagButton
        entityType="sample"
        entityId="P-0071"
        includeDescendants
        size="lg"
      />
    )

    // Count badge.
    expect(screen.getByText('3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /view all/i }))
    expect(useUIStore.getState().flagsEntityFilter).toEqual({
      type: 'sample',
      id: 'P-0071',
      includeDescendants: true,
    })
    expect(useUIStore.getState().flagsFlyoutOpen).toBe(true)
    expect(useUIStore.getState().flagsThreadId).toBeNull()
  })
})
