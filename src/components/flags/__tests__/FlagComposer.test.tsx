import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@/test/test-utils'
import type { FlagDetailResponse } from '@/lib/flags-api'

// suite-scaling contention headroom — see 2026-07-12 workflow-state-system gate report
vi.setConfig({ testTimeout: 15000 })

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? '—' : `User ${id}`,
  initialsForUser: () => 'U',
  avatarColor: () => '#888',
  avatarUrlForUser: () => null,
}))
const addFlagAttachment = vi.hoisted(() => vi.fn())
vi.mock('@/lib/flags-api', async orig => ({
  ...(await orig()),
  addFlagAttachment,
  fetchFlagAttachmentUrl: vi.fn().mockResolvedValue('blob:x'),
}))
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

describe('FlagComposer', () => {
  beforeEach(() => {
    addFlagAttachment.mockReset().mockResolvedValue({ id: 99 })
    useFlag.mockReturnValue({
      data: detail(),
      isLoading: false,
      isError: false,
    })
  })

  it('bold toolbar button wraps the selection in **', async () => {
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)
    const ta = screen.getByPlaceholderText(
      /Write a comment/
    ) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'word' } })
    ta.setSelectionRange(0, 4)
    fireEvent.click(screen.getByRole('button', { name: /bold/i }))
    expect(ta.value).toBe('**word**')
  })

  it('pasting an image uploads it and inserts an attachment token', async () => {
    const { FlagThread } = await import('@/components/flags/FlagThread')
    render(<FlagThread flagId={7} tabLabel="Assigned to me" />)
    const ta = screen.getByPlaceholderText(
      /Write a comment/
    ) as HTMLTextAreaElement
    const file = new File([new Uint8Array([1, 2, 3])], 'p.png', {
      type: 'image/png',
    })
    fireEvent.paste(ta, { clipboardData: { files: [file], items: [] } })
    await waitFor(() => expect(addFlagAttachment).toHaveBeenCalledWith(7, file))
    await waitFor(() => expect(ta.value).toContain('{attachment:99}'))
  })
})
