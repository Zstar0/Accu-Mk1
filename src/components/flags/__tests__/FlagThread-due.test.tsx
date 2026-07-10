import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import type { FlagDetailResponse } from '@/lib/flags-api'

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? '—' : `User ${id}`,
  initialsForUser: () => 'U',
  avatarColor: () => '#888',
  avatarUrlForUser: () => null,
}))
vi.mock('@/lib/flags-api', async orig => ({
  ...(await orig()),
  fetchFlagAttachmentUrl: vi.fn().mockResolvedValue('blob:x'),
}))
const setDueMutate = vi.fn()
const useFlag = vi.fn()
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  const stub = () => ({ mutate: vi.fn(), isPending: false })
  return {
    ...actual,
    useFlag: (...a: unknown[]) => useFlag(...a),
    useChangeStatus: stub,
    useAssignFlag: stub,
    useAddComment: () => ({ mutate: vi.fn(), isPending: false }),
    useAddWatcher: stub,
    useRemoveWatcher: stub,
    useAddReaction: stub,
    useRemoveReaction: stub,
    useSetDue: () => ({ mutate: setDueMutate, isPending: false }),
  }
})

function detail(): FlagDetailResponse {
  return {
    id: 7,
    entity_type: 'sub_sample',
    entity_id: '1',
    kind: 'issue',
    type: 'blocker',
    status: 'in_progress',
    title: 't',
    created_by: 1,
    assignee_id: 2,
    created_at: '',
    updated_at: '',
    resolved_at: null,
    resolved_by: null,
    due_at: '2026-07-15T17:00:00Z',
    comments: [],
    events: [],
    watchers: [],
    entity_links: [],
    flag_links: [],
  }
}

describe('FlagThread due-date editor', () => {
  beforeEach(() => {
    setDueMutate.mockReset()
    useFlag.mockReturnValue({
      data: detail(),
      isLoading: false,
      isError: false,
    })
  })

  it('shows the current due date and edits it', async () => {
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)
    const dueInput = screen.getByLabelText('Due date') as HTMLInputElement
    expect(dueInput.value).toBe('2026-07-15')
    fireEvent.change(dueInput, { target: { value: '2026-07-20' } })
    expect(setDueMutate).toHaveBeenCalledTimes(1)
    expect(typeof setDueMutate.mock.calls[0]?.[0]).toBe('string')
  })

  it('clears the due date', async () => {
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)
    fireEvent.click(screen.getByRole('button', { name: /clear/i }))
    expect(setDueMutate).toHaveBeenCalledWith(null)
  })
})
