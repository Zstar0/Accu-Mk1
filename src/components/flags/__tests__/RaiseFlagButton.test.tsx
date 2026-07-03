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
    // …and no manual entity fields either.
    expect(screen.queryByText('Entity id')).toBeNull()

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
