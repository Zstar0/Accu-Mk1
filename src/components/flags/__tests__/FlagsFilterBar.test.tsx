import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { FlagsFilterBar } from '@/components/flags/FlagsFilterBar'
import { EMPTY_FLAG_FILTER } from '@/components/flags/flag-filter'

// Directory resolves client-side; stub it so the bar renders without a network
// round-trip (mirrors the FlagThread test's flag-users mock idiom).
vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () => new Map(),
  nameForUser: (_m: unknown, id: number | null) =>
    id == null ? 'Unassigned' : `User ${id}`,
}))

describe('FlagsFilterBar', () => {
  it('renders the assignee select by default', () => {
    render(<FlagsFilterBar value={EMPTY_FLAG_FILTER} onChange={() => {}} />)
    expect(screen.getByLabelText('Filter by assignee')).toBeInTheDocument()
  })

  it('hides the assignee select when showAssignee=false', () => {
    render(
      <FlagsFilterBar
        value={EMPTY_FLAG_FILTER}
        onChange={() => {}}
        showAssignee={false}
      />
    )
    expect(screen.queryByLabelText('Filter by assignee')).toBeNull()
  })
})
