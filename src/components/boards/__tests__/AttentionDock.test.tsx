import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  flags: [] as unknown[],
  pending: vi.fn(),
  isLoading: false,
  isError: false,
}))
vi.mock('@/services/boards', () => ({
  useBoardFlags: () => ({
    data: h.flags,
    isLoading: h.isLoading,
    isError: h.isError,
  }),
}))
vi.mock('@/services/flag-types', () => ({
  useFlagTypes: () => ({
    data: [
      { slug: 'blocker', is_blocking: true },
      { slug: 'task', is_blocking: false },
    ],
  }),
}))
vi.mock('@/components/flags/FlagCard', () => ({
  FlagCard: ({ flag }: { flag: { title: string } }) => <div>{flag.title}</div>,
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(
    (sel: (s: { setPendingBoardNode: typeof h.pending }) => unknown) =>
      sel({ setPendingBoardNode: h.pending }),
    { getState: () => ({ setPendingBoardNode: h.pending }) }
  ),
}))

import { AttentionDock } from '@/components/boards/AttentionDock'

const board = {
  id: 1,
  slug: 'org',
  name: 'Org',
  kind: 'map',
  visibility: 'company',
  created_by: 1,
  default_viewport: null,
  node_count: 2,
  open_flag_count: 2,
  can_edit: true,
  created_at: '',
  updated_at: '',
  nodes: [
    {
      id: 1,
      board_id: 1,
      kind: 'note',
      label: 'Q4',
      parent_id: null,
      x: 0,
      y: 0,
      w: null,
      h: null,
      z: 0,
      entity_type: null,
      entity_id: null,
      data: null,
      version: 1,
      created_by: null,
      updated_by: null,
      created_at: '',
      updated_at: '',
    },
  ],
  edges: [],
  grants: [],
} as never
const flag = (o: object) => ({
  id: 1,
  entity_type: 'board_node',
  entity_id: '1',
  kind: 'issue',
  type: 'task',
  status: 'open',
  title: 'T',
  created_by: 1,
  assignee_id: null,
  created_at: '',
  updated_at: '2026-10-01T00:00:00Z',
  resolved_at: null,
  resolved_by: null,
  due_at: null,
  ...o,
})

describe('AttentionDock', () => {
  beforeEach(() => {
    h.pending.mockReset()
    h.isLoading = false
    h.isError = false
  })

  it('lists blocking and overdue flags, overdue first, with Locate for item anchors only', async () => {
    const user = userEvent.setup()
    h.flags = [
      flag({ id: 1, title: 'Blocker on note', type: 'blocker' }),
      flag({
        id: 2,
        title: 'Overdue on board',
        entity_type: 'board',
        entity_id: '1',
        due_at: '2020-01-01T00:00:00Z',
      }),
      flag({ id: 3, title: 'Plain task' }),
    ]
    render(<AttentionDock board={board} />)
    expect(screen.getByText(/Needs attention \(2\)/)).toBeInTheDocument()
    const titles = screen
      .getAllByText(/Blocker on note|Overdue on board/)
      .map(e => e.textContent)
    expect(titles).toEqual(['Overdue on board', 'Blocker on note'])
    expect(screen.queryByText('Plain task')).toBeNull()
    const locate = screen.getAllByRole('button', { name: 'Locate' })
    expect(locate).toHaveLength(1)
    await user.click(locate[0] as HTMLElement)
    expect(h.pending).toHaveBeenCalledWith('1')
  })

  it('says so when nothing needs attention', () => {
    h.flags = [flag({ id: 3, title: 'Plain task' })]
    render(<AttentionDock board={board} />)
    expect(screen.getByText(/Nothing needs attention/)).toBeInTheDocument()
  })

  it('renders nothing while flags load', () => {
    h.isLoading = true
    const { container } = render(<AttentionDock board={board} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an error line when flags fail to load', () => {
    h.isError = true
    render(<AttentionDock board={board} />)
    expect(screen.getByText('Could not load flags.')).toBeInTheDocument()
  })
})
