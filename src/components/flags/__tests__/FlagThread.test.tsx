import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import type { FlagDetailResponse } from '@/lib/flags-api'

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? 'Unassigned' : `User ${id}`,
  initialsForUser: () => 'U',
  avatarColor: () => '#888888',
}))

const addCommentMutate = vi.fn()
const useFlag = vi.fn()
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  const stub = () => ({ mutate: vi.fn(), isPending: false })
  return {
    ...actual,
    useFlag: (...args: unknown[]) => useFlag(...args),
    useChangeStatus: stub,
    useAssignFlag: stub,
    useAddComment: () => ({ mutate: addCommentMutate, isPending: false }),
    useAddWatcher: stub,
    useRemoveWatcher: stub,
  }
})

function detail(): FlagDetailResponse {
  return {
    id: 7,
    entity_type: 'sub_sample',
    entity_id: '1023',
    kind: 'issue',
    type: 'blocker',
    status: 'in_progress',
    title: 'Crashed out — needs re-prep',
    created_by: 1,
    assignee_id: 2,
    created_at: '2026-06-30T15:42:00Z',
    updated_at: '2026-06-30T15:50:00Z',
    resolved_at: null,
    resolved_by: null,
    due_at: null,
    comments: [
      {
        id: 11,
        flag_id: 7,
        author_id: 1,
        body: 'cloudy after reconstitution',
        audience: 'internal',
        mentions: [],
        created_at: '2026-06-30T15:43:00Z',
        edited_at: null,
      },
      {
        id: 12,
        flag_id: 7,
        author_id: 2,
        body: 'scheduling a re-prep tomorrow',
        audience: 'internal',
        mentions: [],
        created_at: '2026-06-30T15:50:00Z',
        edited_at: null,
      },
    ],
    events: [
      {
        id: 1,
        actor_id: 1,
        event_type: 'raised',
        from_value: null,
        to_value: null,
        details: null,
        created_at: '2026-06-30T15:42:00Z',
      },
      {
        id: 2,
        actor_id: 1,
        event_type: 'assigned',
        from_value: null,
        to_value: '2',
        details: null,
        created_at: '2026-06-30T15:45:00Z',
      },
    ],
    watchers: [],
    entity_links: [],
    flag_links: [],
  }
}

describe('FlagThread', () => {
  beforeEach(() => {
    addCommentMutate.mockReset()
    useFlag.mockReset()
    useFlag.mockReturnValue({
      data: detail(),
      isLoading: false,
      isError: false,
    })
  })

  it('interleaves audit events and comments in time order', async () => {
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)

    const text = document.body.textContent ?? ''
    const iRaised = text.indexOf('raised this')
    const iComment1 = text.indexOf('cloudy after reconstitution')
    // "Assigned to User 2" — the full event text, to avoid colliding with the
    // "Assigned to me" breadcrumb label.
    const iAssigned = text.indexOf('Assigned to User 2')
    const iComment2 = text.indexOf('scheduling a re-prep tomorrow')

    // raised (15:42) < comment1 (15:43) < assigned (15:45) < comment2 (15:50)
    expect(iRaised).toBeGreaterThanOrEqual(0)
    expect(iRaised).toBeLessThan(iComment1)
    expect(iComment1).toBeLessThan(iAssigned)
    expect(iAssigned).toBeLessThan(iComment2)
  })

  it('submits a comment on Enter', async () => {
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)

    const input = screen.getByPlaceholderText(/Write a comment/)
    fireEvent.change(input, { target: { value: 'on it' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(addCommentMutate).toHaveBeenCalledWith({
      body: 'on it',
      mentionIds: [],
    })
  })
})
