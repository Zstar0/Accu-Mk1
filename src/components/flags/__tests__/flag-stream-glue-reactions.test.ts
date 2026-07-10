import { describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))
// Stub the query client so the glue's blanket invalidate needs no provider.
vi.mock('@tanstack/react-query', async orig => ({
  ...((await orig()) as object),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
const markUnseen = vi.fn()
vi.mock('@/components/flags/use-flag-unseen', () => ({
  useFlagUnseen: {
    getState: () => ({
      markUnseen,
      acknowledge: vi.fn(),
      clearJustOpened: vi.fn(),
    }),
  },
}))
let handler: (e: unknown) => void
vi.mock('@/lib/flag-stream', () => ({
  useFlagStream: (cb: (e: unknown) => void) => {
    handler = cb
  },
}))

describe('stream glue ignores comment_reaction', () => {
  it('does not toast or mark unseen on a reaction event', async () => {
    const { useFlagStreamGlue } =
      await import('@/components/flags/use-flag-stream-glue')
    const { renderHook } = await import('@testing-library/react')
    renderHook(() => useFlagStreamGlue())
    handler({
      event_type: 'comment_reaction',
      flag_id: 7,
      comment_id: 3,
      actor_id: 1,
      details: {},
      event_id: null,
      flag: {
        id: 7,
        title: 't',
        type: 'blocker',
        kind: 'issue',
        status: 'open',
        entity_type: 'sub_sample',
        entity_id: '1',
        assignee_id: 42,
        created_by: 42,
      },
    })
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(markUnseen).not.toHaveBeenCalled()
  })
})
