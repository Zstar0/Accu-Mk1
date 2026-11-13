import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import type { ActivityItem, FlagResponse } from '@/lib/flags-api'
import { useUIStore } from '@/store/ui-store'
import { FlagActivityRow } from '@/components/flags/FlagActivityRow'

// Keep the user directory off the network.
vi.mock('@/components/flags/flag-users', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useFlagUsers: () => new Map(),
    nameForUser: (_m: unknown, id: number | null) =>
      id == null ? 'Unassigned' : `User ${id}`,
    initialsForUser: () => 'U',
  }
})

const ITEM: ActivityItem = {
  id: 1,
  event_type: 'commented',
  actor_id: 2,
  from_value: null,
  to_value: null,
  created_at: '2026-06-30T12:00:00',
  relevance: [],
  flag: {
    id: 7,
    entity_type: 'sub_sample',
    entity_id: '90001',
    kind: 'issue',
    type: 'blocker',
    status: 'open',
    title: 'Re-prep vial',
    created_by: 1,
    assignee_id: 1,
    created_at: '2026-06-30T12:00:00',
    updated_at: '2026-06-30T12:00:00',
    resolved_at: null,
    resolved_by: null,
    due_at: null,
  } as FlagResponse,
}

describe('FlagActivityRow', () => {
  beforeEach(() => {
    useUIStore.setState({
      flagsFlyoutOpen: false,
      flagsThreadId: null,
      flagsThreadReturnTo: null,
    })
  })

  it('a click opens the thread with no return marker by default', () => {
    render(<FlagActivityRow item={ITEM} />)
    fireEvent.click(screen.getByRole('button'))
    expect(useUIStore.getState().flagsThreadId).toBe(7)
    expect(useUIStore.getState().flagsThreadReturnTo).toBeNull()
  })

  it('returnTo="page" marks the thread to return to the page', () => {
    render(<FlagActivityRow item={ITEM} returnTo="page" />)
    fireEvent.click(screen.getByRole('button'))
    expect(useUIStore.getState().flagsThreadId).toBe(7)
    expect(useUIStore.getState().flagsThreadReturnTo).toBe('page')
  })

  it('Enter opens with the same marker as a click', () => {
    render(<FlagActivityRow item={ITEM} returnTo="page" />)
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' })
    expect(useUIStore.getState().flagsThreadReturnTo).toBe('page')
  })
})
