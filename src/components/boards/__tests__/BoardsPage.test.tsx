import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'standard',
  boards: [
    {
      id: 1,
      slug: 'org',
      name: 'Org chart',
      kind: 'org',
      visibility: 'company',
      created_by: 1,
      default_viewport: null,
      node_count: 12,
      can_edit: true,
      created_at: '',
      updated_at: '',
    },
    {
      id: 2,
      slug: 'exec',
      name: 'Exec map',
      kind: 'map',
      visibility: 'restricted',
      created_by: 1,
      default_viewport: null,
      node_count: 3,
      can_edit: false,
      created_at: '',
      updated_at: '',
    },
  ],
  create: vi.fn(),
  remove: vi.fn(),
  replace: vi.fn(),
  navigateToBoard: vi.fn(),
}))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) =>
    sel({ user: { role: h.role } }),
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: (
    sel: (s: { navigateToBoard: typeof h.navigateToBoard }) => unknown
  ) => sel({ navigateToBoard: h.navigateToBoard }),
}))
vi.mock('@/services/boards', () => ({
  useBoards: () => ({ data: h.boards, isLoading: false, isError: false }),
  useBoard: () => ({
    data: {
      id: 1,
      slug: 'org',
      name: 'Org chart',
      kind: 'org',
      visibility: 'company',
      created_by: 1,
      default_viewport: null,
      node_count: 12,
      can_edit: true,
      created_at: '',
      updated_at: '',
      nodes: [],
      edges: [],
      grants: [
        { group_id: 1, group_slug: 'exec', group_name: 'Exec', can_edit: true },
      ],
    },
    isLoading: false,
  }),
  useCreateBoard: () => ({ mutate: h.create, isPending: false }),
  useDeleteBoard: () => ({ mutate: h.remove, isPending: false }),
  useReplaceGrants: () => ({ mutate: h.replace, isPending: false }),
}))
vi.mock('@/services/groups', () => ({
  useGroups: () => ({
    data: [
      {
        id: 1,
        slug: 'exec',
        name: 'Exec',
        description: null,
        is_active: true,
        member_count: 3,
        created_at: '',
      },
      {
        id: 2,
        slug: 'ops',
        name: 'Ops',
        description: null,
        is_active: true,
        member_count: 5,
        created_at: '',
      },
    ],
    isLoading: false,
  }),
}))

import { BoardsPage } from '@/components/boards/BoardsPage'

describe('BoardsPage', () => {
  beforeEach(() => {
    h.role = 'admin'
    h.create.mockReset()
    h.remove.mockReset()
    h.replace.mockReset()
    h.navigateToBoard.mockReset()
  })

  it('lists boards with kind, visibility and node count, and opens one', async () => {
    render(<BoardsPage />)
    expect(screen.getByText('Org chart')).toBeInTheDocument()
    expect(screen.getByText('Exec map')).toBeInTheDocument()
    const execCard = screen
      .getByText('Exec map')
      .closest('.rounded-lg') as HTMLElement
    expect(within(execCard).getByText('restricted')).toBeInTheDocument()
    expect(screen.getByText('12 items')).toBeInTheDocument()
    await userEvent
      .setup()
      .click(screen.getAllByRole('button', { name: 'Open' })[0] as HTMLElement)
    expect(h.navigateToBoard).toHaveBeenCalledWith('org')
  })

  it('admin can create a board', async () => {
    const user = userEvent.setup()
    render(<BoardsPage />)
    await user.type(screen.getByLabelText('Slug'), 'company-map')
    await user.type(screen.getByLabelText('Name'), 'Company map')
    await user.click(screen.getByRole('button', { name: 'Create board' }))
    expect(h.create).toHaveBeenCalledWith(
      {
        slug: 'company-map',
        name: 'Company map',
        kind: 'map',
        visibility: 'company',
      },
      expect.anything()
    )
  })

  it('non-admin sees no create form, share or delete', () => {
    h.role = 'standard'
    render(<BoardsPage />)
    expect(screen.queryByLabelText('Slug')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Delete' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Share' })
    ).not.toBeInTheDocument()
  })

  it('admin can open the share dialog', async () => {
    const user = userEvent.setup()
    render(<BoardsPage />)
    await user.click(
      screen.getAllByRole('button', { name: 'Share' })[0] as HTMLElement
    )
    expect(await screen.findByText('Share board')).toBeInTheDocument()
  })

  it('admin delete requires confirmation before the mutation runs', async () => {
    const user = userEvent.setup()
    render(<BoardsPage />)
    await user.click(
      screen.getAllByRole('button', { name: 'Delete' })[0] as HTMLElement
    )
    expect(h.remove).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(h.remove).toHaveBeenCalledWith('org', expect.anything())
  })

  it('saving the share dialog unchanged keeps the existing grant', async () => {
    const user = userEvent.setup()
    render(<BoardsPage />)
    await user.click(
      screen.getAllByRole('button', { name: 'Share' })[0] as HTMLElement
    )
    await screen.findByText('Share board')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(h.replace).toHaveBeenCalledWith(
      [{ group_id: 1, can_edit: true }],
      expect.anything()
    )
  })
})
