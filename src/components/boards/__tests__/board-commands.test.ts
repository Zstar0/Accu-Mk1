import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ slug: 'org', pending: vi.fn() }))
vi.mock('@/store/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      boardTargetSlug: h.slug,
      setPendingBoardNode: h.pending,
    }),
  },
}))

import { boardNodeCommands } from '@/components/boards/board-commands'

const board = {
  slug: 'org',
  nodes: [
    { id: 1, kind: 'frame', label: 'Marketing', context: null },
    { id: 2, kind: 'entity', label: 'P-1', context: { label: 'Sample P-1' } },
  ],
} as never

const ctx = { openPreferences: vi.fn(), showToast: vi.fn() }

describe('boardNodeCommands', () => {
  it('one command per item, labelled by context when present, jumping through the pending node', () => {
    const cmds = boardNodeCommands(board)
    expect(cmds.map(c => [c.id, c.label, c.group])).toEqual([
      ['board:org:node:1', 'Marketing', 'board'],
      ['board:org:node:2', 'Sample P-1', 'board'],
    ])
    cmds[0]?.execute(ctx)
    expect(h.pending).toHaveBeenCalledWith('1')
  })
  it('is only available while that board is open', () => {
    const [cmd] = boardNodeCommands(board)
    expect(cmd?.isAvailable?.(ctx)).toBe(true)
    h.slug = 'other'
    expect(cmd?.isAvailable?.(ctx)).toBe(false)
  })
})
