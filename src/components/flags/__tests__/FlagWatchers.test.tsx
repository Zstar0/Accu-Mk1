import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@/test/test-utils'

// Spy the REST calls; FlagWatchers drives them through the shared
// useAddWatcher/useRemoveWatcher hooks, so mocking flags-api still catches them.
const api = vi.hoisted(() => ({
  addWatcher: vi.fn().mockResolvedValue({ ok: true }),
  removeWatcher: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/flags-api', async orig => ({
  ...((await orig()) as object),
  ...api,
}))
vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? 'Unassigned' : `User ${id}`,
  initialsForUser: () => 'U',
  avatarColor: () => '#888888',
}))

describe('FlagWatchers', () => {
  beforeEach(() => {
    api.addWatcher.mockClear()
    api.removeWatcher.mockClear()
  })

  it('shows watcher count and self watch toggle', async () => {
    const { FlagWatchers } = await import('@/components/flags/FlagWatchers')
    render(
      <FlagWatchers
        flagId={1}
        currentUserId={9}
        watchers={[{ user_id: 7, added_at: '', added_by: null }]}
      />
    )
    expect(await screen.findByText(/1 watching/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^watch$/i }))
    await waitFor(() => expect(api.addWatcher).toHaveBeenCalledWith(1, 9))
  })

  it('unwatch when already watching', async () => {
    const { FlagWatchers } = await import('@/components/flags/FlagWatchers')
    render(
      <FlagWatchers
        flagId={1}
        currentUserId={7}
        watchers={[{ user_id: 7, added_at: '', added_by: null }]}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /unwatch/i }))
    await waitFor(() => expect(api.removeWatcher).toHaveBeenCalledWith(1, 7))
  })
})
