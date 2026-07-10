import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'

// Mock the user directory + create mutation so the compose doesn't hit the net.
vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? 'Unassigned' : `User ${id}`,
}))
const create = vi.fn()
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useCreateFlag: () => ({ mutate: create, isPending: false }),
  }
})
// Two active types scoped to the sample entity.
vi.mock('@/services/flag-types', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useFlagTypes: () => ({
      data: [
        {
          id: 1,
          slug: 'blocker',
          label: 'Blocker',
          color: '#e5484d',
          kind: 'issue',
          is_blocking: true,
          is_active: true,
          sort_order: 0,
          entity_types: [],
          is_builtin: true,
        },
      ],
    }),
  }
})
// Active item kinds offered in the anchor selector.
vi.mock('@/services/item-kinds', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useItemKinds: () => ({
      data: [
        {
          id: 1,
          slug: 'general_task',
          label: 'General Task',
          color: '#6b7280',
          is_active: true,
          is_builtin: true,
          sort_order: 0,
        },
        {
          id: 2,
          slug: 'purchase_task',
          label: 'Purchase Task',
          color: '#111111',
          is_active: true,
          is_builtin: false,
          sort_order: 1,
        },
      ],
    }),
  }
})

describe('RaiseFlagButton candidates (order sample picker)', () => {
  beforeEach(() => create.mockReset())

  it('shows a "Which sample?" select when given >1 candidate', async () => {
    const { RaiseFlagButton } =
      await import('@/components/flags/RaiseFlagButton')
    render(
      <RaiseFlagButton
        candidates={[
          { entityType: 'sample', entityId: 'P-0001', label: 'P-0001' },
          { entityType: 'sample', entityId: 'P-0002', label: 'P-0002' },
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /raise a flag/i }))
    expect(await screen.findByText('Which sample?')).toBeInTheDocument()
  })

  it('skips the picker and prefills when given exactly one candidate', async () => {
    const { RaiseFlagButton } =
      await import('@/components/flags/RaiseFlagButton')
    render(
      <RaiseFlagButton
        candidates={[
          { entityType: 'sample', entityId: 'P-0001', label: 'P-0001' },
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /raise a flag/i }))
    const title = await screen.findByPlaceholderText('What needs attention?')
    // No picker — single candidate is prefilled.
    expect(screen.queryByText('Which sample?')).toBeNull()
    // …and no manual item fields either.
    expect(screen.queryByText('Item id')).toBeNull()

    fireEvent.change(title, { target: { value: 'Needs re-prep' } })
    fireEvent.click(screen.getByRole('button', { name: 'Raise flag' }))

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      entity_type: 'sample',
      entity_id: 'P-0001',
      title: 'Needs re-prep',
    })
  })
})

describe('RaiseFlagButton item kinds (general-task anchor)', () => {
  beforeEach(() => create.mockReset())

  it('defaults a generic compose to the General Task kind and posts its slug', async () => {
    const { RaiseFlagButton } =
      await import('@/components/flags/RaiseFlagButton')
    render(<RaiseFlagButton />)

    fireEvent.click(screen.getByRole('button', { name: /raise a flag/i }))
    const title = await screen.findByPlaceholderText('What needs attention?')
    // No manual id form by default — the anchor is a kind.
    expect(screen.queryByText('Item id')).toBeNull()

    fireEvent.change(title, { target: { value: 'Sweep the bench' } })
    fireEvent.click(screen.getByRole('button', { name: 'Raise flag' }))

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      entity_type: 'general_task',
      entity_id: null,
      title: 'Sweep the bench',
    })
  })
})
