import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () =>
    new Map([
      [7, { id: 7, email: 'a@x', first_name: 'Ann', last_name: 'Lee' }],
    ]),
  nameForUser: (_m: unknown, id: number | null) =>
    id === 7 ? 'Ann Lee' : `User ${id}`,
}))
const api = vi.hoisted(() => ({
  addReaction: vi.fn().mockResolvedValue([]),
  removeReaction: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/flags-api', async orig => ({ ...(await orig()), ...api }))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('FlagReactions', () => {
  beforeEach(() => {
    api.addReaction.mockClear()
    api.removeReaction.mockClear()
  })

  it('renders existing reaction pills with counts', async () => {
    const { FlagReactions } = await import('@/components/flags/FlagReactions')
    render(
      wrap(
        <FlagReactions
          commentId={3}
          flagId={7}
          currentUserId={9}
          reactions={[{ emoji: '👍', count: 2, user_ids: [7, 8] }]}
        />
      )
    )
    expect(await screen.findByText('2')).toBeInTheDocument()
    // The curated hover bar also contains 👍, so target the pill by aria-label.
    expect(screen.getByRole('button', { name: '👍 2' })).toBeInTheDocument()
  })

  it('clicking a curated emoji adds my reaction', async () => {
    const { FlagReactions } = await import('@/components/flags/FlagReactions')
    render(
      wrap(
        <FlagReactions
          commentId={3}
          flagId={7}
          currentUserId={9}
          reactions={[]}
        />
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'React 🎉' }))
    await waitFor(() => expect(api.addReaction).toHaveBeenCalledWith(3, '🎉'))
  })

  it('clicking a pill I already reacted to removes it', async () => {
    const { FlagReactions } = await import('@/components/flags/FlagReactions')
    render(
      wrap(
        <FlagReactions
          commentId={3}
          flagId={7}
          currentUserId={7}
          reactions={[{ emoji: '👍', count: 1, user_ids: [7] }]}
        />
      )
    )
    fireEvent.click(screen.getByRole('button', { name: /👍 1/ }))
    await waitFor(() =>
      expect(api.removeReaction).toHaveBeenCalledWith(3, '👍')
    )
  })
})
