import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import type { FlagResponse, EntityContext } from '@/lib/flags-api'
import { useUIStore } from '@/store/ui-store'
import { FlagTable } from '@/components/flags/FlagTable'

// Keep the user directory off the network.
vi.mock('@/components/flags/flag-users', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useFlagUsers: () => new Map(),
    nameForUser: (_m: unknown, id: number | null) =>
      id == null ? 'Unassigned' : `User ${id}`,
    initialsForUser: () => 'U',
  }
})

function flag(
  over: Partial<FlagResponse> & { entity?: EntityContext | null } = {}
): FlagResponse {
  return {
    id: 1,
    entity_type: 'sub_sample',
    entity_id: '90001',
    kind: 'issue',
    type: 'blocker',
    status: 'open',
    title: 'Crashed out — needs re-prep',
    created_by: 1,
    assignee_id: 1,
    created_at: '2026-06-30T12:00:00',
    updated_at: '2026-06-30T12:00:00',
    resolved_at: null,
    resolved_by: null,
    due_at: null,
    ...over,
  }
}

describe('FlagTable', () => {
  beforeEach(() => {
    useUIStore.setState({ flagsThreadId: null })
  })

  it('renders a header row with every column label', () => {
    render(<FlagTable flags={[flag()]} />)
    for (const label of [
      'Item',
      'Type',
      'Title',
      'Assignee',
      'Status',
      'Age',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('renders one row per flag with its title', () => {
    render(
      <FlagTable
        flags={[
          flag({ id: 1, title: 'Crashed out — needs re-prep' }),
          flag({ id: 2, title: 'Photo missing' }),
        ]}
      />
    )
    expect(screen.getByText('Crashed out — needs re-prep')).toBeInTheDocument()
    expect(screen.getByText('Photo missing')).toBeInTheDocument()
  })

  it('shares ONE fixed column template across the header and every row (alignment)', () => {
    const { container } = render(
      <FlagTable flags={[flag({ id: 1 }), flag({ id: 2 })]} />
    )
    const rows = container.querySelectorAll('[role="row"]')
    expect(rows.length).toBe(3) // header + 2 data rows
    const templates = new Set(
      Array.from(rows).flatMap(r =>
        Array.from(r.classList).filter(c => c.startsWith('grid-cols-'))
      )
    )
    // Exactly one distinct grid-template → columns line up regardless of content.
    expect(templates.size).toBe(1)
  })

  it('opens the thread when a row is clicked', () => {
    render(<FlagTable flags={[flag({ id: 7 })]} />)
    fireEvent.click(screen.getByText('Crashed out — needs re-prep'))
    expect(useUIStore.getState().flagsThreadId).toBe(7)
  })

  it('paints the unread accent only for rows in unreadIds', () => {
    const { container } = render(
      <FlagTable
        flags={[flag({ id: 1 }), flag({ id: 2 })]}
        unreadIds={new Set([1])}
      />
    )
    const unreadBars = container.querySelectorAll('[style*="--flag-unread"]')
    // Exactly the one unread row's accent uses the dedicated color.
    expect(unreadBars.length).toBe(1)
  })

  it('deep-links (not open-thread) when the entity chip is clicked', () => {
    const navigateToSample = vi.fn()
    useUIStore.setState({ navigateToSample, flagsThreadId: null })
    render(
      <FlagTable
        flags={[
          flag({
            id: 9,
            entity: {
              entity_type: 'sub_sample',
              entity_id: '90001',
              label: 'Vial 90001',
              sample_id: 'P-0071',
              analyses: ['PEPT-Total'],
              lot: null,
              deep_link: { kind: 'sample', id: 'P-0071' },
            },
          }),
        ]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Vial 90001/ }))
    expect(navigateToSample).toHaveBeenCalledWith('P-0071')
    expect(useUIStore.getState().flagsThreadId).toBeNull()
  })
})
