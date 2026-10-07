import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'standard',
  groups: [
    {
      id: 1,
      slug: 'exec',
      name: 'Exec',
      description: null,
      is_active: true,
      member_count: 2,
      created_at: '2026-09-26T00:00:00',
    },
    {
      id: 2,
      slug: 'lab',
      name: 'Lab',
      description: 'Bench staff',
      is_active: false,
      member_count: 0,
      created_at: '2026-09-26T00:00:00',
    },
  ],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) =>
      o?.count !== undefined ? `${k}:${o.count}` : k,
  }),
}))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) =>
    sel({ user: { role: h.role } }),
}))
vi.mock('@/services/groups', () => ({
  useGroups: () => ({ data: h.groups, isLoading: false, isError: false }),
  useCreateGroup: () => ({ mutate: h.create, isPending: false }),
  useUpdateGroup: () => ({ mutate: h.update, isPending: false }),
  useDeleteGroup: () => ({ mutate: h.remove, isPending: false }),
  useGroupMembers: () => ({ data: [10], isLoading: false }),
  useReplaceGroupMembers: () => ({ mutate: h.replace, isPending: false }),
  useDirectoryUsers: () => ({
    data: [
      { id: 10, email: 'e@x.t', first_name: 'Ed', last_name: 'Itor' },
      { id: 11, email: 'v@x.t', first_name: null, last_name: null },
    ],
    isLoading: false,
  }),
}))

import { GroupsPane } from '@/components/preferences/panes/GroupsPane'

describe('GroupsPane', () => {
  beforeEach(() => {
    h.role = 'admin'
    h.create.mockReset()
    h.update.mockReset()
    h.remove.mockReset()
    h.replace.mockReset()
  })

  it('lists groups with slug, activity and member count', () => {
    render(<GroupsPane />)
    expect(screen.getByText('exec')).toBeInTheDocument()
    expect(screen.getByText('lab')).toBeInTheDocument()
    expect(
      screen.getByText('preferences.groups.memberCount:2')
    ).toBeInTheDocument()
    expect(screen.getByText('preferences.groups.inactive')).toBeInTheDocument()
  })

  it('admin can add a group and delete only an empty one', async () => {
    const user = userEvent.setup()
    render(<GroupsPane />)
    await user.type(
      screen.getByLabelText('preferences.groups.newSlug'),
      'front-desk'
    )
    await user.type(
      screen.getByLabelText('preferences.groups.newName'),
      'Front desk'
    )
    await user.click(
      screen.getByRole('button', { name: /preferences.groups.add/ })
    )
    expect(h.create).toHaveBeenCalledWith(
      { slug: 'front-desk', name: 'Front desk', description: null },
      expect.anything()
    )
    const deletes = screen.getAllByRole('button', {
      name: 'preferences.groups.delete',
    })
    expect(deletes).toHaveLength(1) // only `lab` (0 members) offers Delete
    await user.click(deletes[0] as HTMLElement)
    expect(h.remove).toHaveBeenCalledWith(2)
  })

  it('admin edits members through the directory checklist', async () => {
    const user = userEvent.setup()
    render(<GroupsPane />)
    await user.click(
      screen.getAllByRole('button', {
        name: 'preferences.groups.members',
      })[0] as HTMLElement
    )
    const ed = screen.getByRole('checkbox', { name: /Ed Itor/ })
    const v = screen.getByRole('checkbox', { name: /v@x.t/ })
    expect(ed).toBeChecked()
    expect(v).not.toBeChecked()
    await user.click(v)
    await user.click(
      screen.getByRole('button', { name: 'preferences.groups.saveMembers' })
    )
    expect(h.replace).toHaveBeenCalledWith(
      { id: 1, userIds: [10, 11] },
      expect.anything()
    )
    expect(
      screen.getByText('preferences.groups.membersHint')
    ).toBeInTheDocument()
  })

  it('non-admin sees the list read-only', () => {
    h.role = 'standard'
    render(<GroupsPane />)
    expect(screen.getByText('preferences.groups.readOnly')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('preferences.groups.newSlug')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'preferences.groups.delete' })
    ).not.toBeInTheDocument()
  })
})
