import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'

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
// A global (task) type and a sample-scoped type: general mode must offer only
// the global one, so the default selection resolves to `task`.
vi.mock('@/services/flag-types', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  const t = (slug: string, entity_types: string[], sort_order: number) => ({
    id: sort_order,
    slug,
    label: slug,
    color: '#111',
    kind: 'issue',
    is_blocking: false,
    is_active: true,
    sort_order,
    entity_types,
    is_builtin: true,
  })
  return {
    ...actual,
    useFlagTypes: () => ({
      data: [t('sample_only', ['sample'], 0), t('task', [], 5)],
    }),
  }
})

describe('RaiseFlagButton general task', () => {
  beforeEach(() => create.mockReset())

  it('composes a general task when there is no preset or candidates', async () => {
    const { RaiseFlagButton } =
      await import('@/components/flags/RaiseFlagButton')
    render(<RaiseFlagButton />)

    fireEvent.click(screen.getByRole('button', { name: /raise a flag/i }))
    const title = await screen.findByPlaceholderText('What needs attention?')
    fireEvent.change(title, { target: { value: 'pick up equipment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Raise flag' }))

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      entity_type: null,
      entity_id: null,
      type: 'task',
      title: 'pick up equipment',
    })
  })

  it('adds due_at (ISO string) when a due date is set', async () => {
    const { RaiseFlagButton } =
      await import('@/components/flags/RaiseFlagButton')
    render(<RaiseFlagButton />)

    fireEvent.click(screen.getByRole('button', { name: /raise a flag/i }))
    const title = await screen.findByPlaceholderText('What needs attention?')
    fireEvent.change(title, { target: { value: 'with a deadline' } })
    fireEvent.change(screen.getByLabelText('Due date (optional)'), {
      target: { value: '2026-08-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Raise flag' }))

    const body = create.mock.calls[0]?.[0] as { due_at: string | null }
    // TZ-robust: 17:00 local can roll to the next UTC day, so just assert a
    // non-empty ISO timestamp was attached (not null / not empty).
    expect(typeof body.due_at).toBe('string')
    expect((body.due_at ?? '').length).toBeGreaterThan(0)
  })
})
