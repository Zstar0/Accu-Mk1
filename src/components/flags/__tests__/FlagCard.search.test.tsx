import { render, screen } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { FlagCard } from '@/components/flags/FlagCard'
import type { FlagResponse } from '@/lib/flags-api'

vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? 'Unassigned' : `User ${id}`,
  initialsForUser: () => 'U',
  avatarColor: () => '#888888',
}))

const flag = (): FlagResponse =>
  ({
    id: 1,
    entity_type: 'sample',
    entity_id: 'P-1',
    kind: 'issue',
    type: 'blocker',
    status: 'open',
    title: 'Pump seal',
    created_by: 1,
    assignee_id: null,
    created_at: '',
    updated_at: '2026-07-09T00:00:00',
    resolved_at: null,
    resolved_by: null,
    due_at: null,
    entity: null,
  }) as FlagResponse

describe('FlagCard search snippet', () => {
  it('shows the badge + snippet when a comment matched', () => {
    render(
      <FlagCard
        flag={flag()}
        search={{ snippet: '…cloudy precipitate settled…' }}
      />
    )
    expect(screen.getByText(/matched in comments/i)).toBeInTheDocument()
    expect(screen.getByText(/cloudy precipitate settled/)).toBeInTheDocument()
  })

  it('renders no snippet affordance without the search prop', () => {
    render(<FlagCard flag={flag()} />)
    expect(screen.queryByText(/matched in comments/i)).toBeNull()
  })
})
