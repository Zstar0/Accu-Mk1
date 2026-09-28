import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  patch: vi.fn(),
  remove: vi.fn(),
  flags: [
    {
      id: 5,
      title: 'Plan Q4',
      status: 'open',
      type: 'task',
      kind: 'issue',
      entity_type: 'board_node',
      entity_id: '1',
    },
  ],
}))
vi.mock('@/hooks/use-flags', () => ({
  useEntityFlags: () => ({ data: h.flags, isLoading: false }),
}))
vi.mock('@/components/flags/FlagCard', () => ({
  FlagCard: ({ flag }: { flag: { title: string } }) => <div>{flag.title}</div>,
}))
vi.mock('@/components/flags/RaiseFlagButton', () => ({
  RaiseFlagButton: ({ targetLabel }: { targetLabel?: string }) => (
    <button>Raise flag on {targetLabel}</button>
  ),
}))
vi.mock('@/services/boards', () => ({
  usePatchNode: () => ({ mutate: h.patch, isPending: false }),
  useDeleteNode: () => ({ mutate: h.remove, isPending: false }),
  useBoardsForEntity: () => ({ data: [], isLoading: false }),
}))
vi.mock('@/services/groups', () => ({
  useDirectoryUsers: () => ({ data: [], isLoading: false }),
}))
vi.mock('@/components/boards/DocumentPreviewFrame', () => ({
  DocumentPreviewFrame: () => <div>preview</div>,
}))

import { BoardSidePanel } from '@/components/boards/BoardSidePanel'
import type { BoardDetail } from '@/lib/api-boards'

const node = (o: Partial<BoardDetail['nodes'][number]>) => ({
  id: 1,
  board_id: 1,
  kind: 'frame' as const,
  label: 'Marketing',
  parent_id: null,
  x: 0,
  y: 0,
  w: null,
  h: null,
  z: 0,
  entity_type: null,
  entity_id: null,
  data: { color: 'purple' },
  version: 2,
  created_by: null,
  updated_by: null,
  created_at: '',
  updated_at: '',
  ...o,
})
const board = (canEdit: boolean, nodes = [node({})]): BoardDetail => ({
  id: 1,
  slug: 'org',
  name: 'Org',
  kind: 'map',
  visibility: 'restricted',
  created_by: 1,
  default_viewport: null,
  node_count: nodes.length,
  can_edit: canEdit,
  created_at: '',
  updated_at: '',
  nodes,
  edges: [],
  grants: [
    { group_id: 1, group_slug: 'exec', group_name: 'Exec', can_edit: true },
  ],
})

describe('BoardSidePanel', () => {
  beforeEach(() => {
    h.patch.mockReset()
    h.remove.mockReset()
  })

  it('editor sees flags, raise button with the restricted hint, and can rename', async () => {
    const user = userEvent.setup()
    render(
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      <BoardSidePanel board={board(true)} selectedId={1} onClose={() => {}} />
    )
    expect(screen.getByText('Plan Q4')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Raise flag on Marketing' })
    ).toBeInTheDocument()
    expect(screen.getByText(/Visible to Exec and admins/)).toBeInTheDocument()
    const label = screen.getByLabelText('Label')
    await user.clear(label)
    await user.type(label, 'Marketing team')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(h.patch).toHaveBeenCalledWith(
      { id: 1, data: { version: 2, label: 'Marketing team' } },
      expect.anything()
    )
  })

  it('viewer sees a read-only panel (Review Focus 3)', () => {
    render(
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      <BoardSidePanel board={board(false)} selectedId={1} onClose={() => {}} />
    )
    expect(screen.getByText('Marketing')).toBeInTheDocument()
    expect(screen.queryByLabelText('Label')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Raise flag/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Delete node' })
    ).not.toBeInTheDocument()
  })

  it('note editor saves markdown with the version', async () => {
    const user = userEvent.setup()
    const n = node({
      id: 3,
      kind: 'note',
      label: 'Q4',
      data: { markdown: 'old' },
      version: 7,
    })
    render(
      <BoardSidePanel
        board={board(true, [n])}
        selectedId={3}
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        onClose={() => {}}
      />
    )
    const ta = screen.getByLabelText('Markdown')
    await user.clear(ta)
    await user.type(ta, 'new text')
    await user.click(screen.getByRole('button', { name: 'Save note' }))
    expect(h.patch).toHaveBeenCalledWith(
      { id: 3, data: { version: 7, data: { markdown: 'new text' } } },
      expect.anything()
    )
  })

  it('delete asks the mutation with the node id', async () => {
    render(
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      <BoardSidePanel board={board(true)} selectedId={1} onClose={() => {}} />
    )
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Delete node' }))
    expect(h.remove).toHaveBeenCalledWith(1, expect.anything())
  })

  it('link save keeps the description (M2)', async () => {
    const user = userEvent.setup()
    const n = node({
      id: 4,
      kind: 'link',
      label: 'Site',
      data: { url: 'https://a.example', description: 'keep me' },
      version: 5,
    })
    render(
      <BoardSidePanel
        board={board(true, [n])}
        selectedId={4}
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        onClose={() => {}}
      />
    )
    const input = screen.getByLabelText('URL')
    await user.clear(input)
    await user.type(input, 'https://b.example')
    await user.click(input.nextElementSibling as HTMLElement)
    expect(h.patch).toHaveBeenCalledWith(
      {
        id: 4,
        data: {
          version: 5,
          data: { url: 'https://b.example', description: 'keep me' },
        },
      },
      expect.anything()
    )
  })
})
