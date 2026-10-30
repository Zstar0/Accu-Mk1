import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@/test/test-utils'
import type { FlagDetailResponse } from '@/lib/flags-api'

// suite-scaling contention headroom: see 2026-07-12 workflow-state-system gate report
vi.setConfig({ testTimeout: 15000 })

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? '-' : `User ${id}`,
  initialsForUser: () => 'U',
  avatarColor: () => '#888',
  avatarUrlForUser: () => null,
}))
vi.mock('@/lib/flags-api', async orig => ({
  ...(await orig()),
  fetchFlagAttachmentUrl: vi.fn().mockResolvedValue('blob:x'),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
const useFlag = vi.fn()
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  const stub = () => ({ mutate: vi.fn(), isPending: false })
  return {
    ...actual,
    useFlag: (...a: unknown[]) => useFlag(...a),
    useChangeStatus: stub,
    useAssignFlag: stub,
    useAddComment: stub,
    useAddWatcher: stub,
    useRemoveWatcher: stub,
    useSetDue: stub,
    useAddReaction: stub,
    useRemoveReaction: stub,
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
    due_at: null,
    comments: [],
    events: [],
    watchers: [],
    entity_links: [],
    flag_links: [],
  }
}

describe('Copy link to a flag', () => {
  const writeText = vi.fn()
  beforeEach(() => {
    toast.success.mockReset()
    toast.error.mockReset()
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    useFlag.mockReturnValue({
      data: detail(),
      isLoading: false,
      isError: false,
    })
  })

  it('copies the Tasks-page deep link for this flag', async () => {
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy link to this flag' })
    )
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/#tasks/overview?flag=7`
      )
    )
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Link copied')
    )
  })

  it('shows the link when the clipboard write fails', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy link to this flag' })
    )
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        `Couldn't copy. Link: ${window.location.origin}/#tasks/overview?flag=7`
      )
    )
  })
})
