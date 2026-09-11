import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'

// Fixture mirrors the shape backend/main.py actually emits for a
// priority_audit line: `label` and `description` carry the same text, the
// actor display name lives in details.by (NOT an email), and the free-text
// note rides both on `note` and details.note.
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    getSampleActivity: vi.fn(async (sampleId: string) => ({
      sample_id: sampleId,
      count: 1,
      events: [
        {
          timestamp: '2026-09-09T17:00:00',
          event: 'priority_changed',
          label: 'Priority: Inherit → High (Ada Lovelace)',
          description: 'Priority: Inherit → High (Ada Lovelace)',
          type: 'priority',
          details: {
            level: 'sample',
            entity_id: '512',
            old_key: null,
            new_key: 'high',
            source: 'manual',
            note: 'VIP',
            user_id: 5,
            by: 'Ada Lovelace',
          },
          user_id: 5,
          note: 'VIP',
          source: 'priority_audit',
        },
      ],
    })),
  }
})
vi.mock('@/lib/auth-api', () => ({ getUserDirectory: vi.fn(async () => []) }))

import { SampleActivityLog } from '@/components/senaite/SampleActivityLog'

describe('SampleActivityLog priority lines', () => {
  it('renders a priority_audit event with its description, note and marker', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    // The Sheet renders through a portal, so query document.body, not the
    // render container.
    render(
      <QueryClientProvider client={qc}>
        <SampleActivityLog open onClose={vi.fn()} sampleId="PB-0512" />
      </QueryClientProvider>
    )

    // Primary text: the derived description, verbatim.
    expect(
      await screen.findByText('Priority: Inherit → High (Ada Lovelace)')
    ).toBeInTheDocument()

    // The note renders in the muted detail line.
    expect(screen.getByText('VIP')).toBeInTheDocument()

    // Row marker is the lucide ArrowUpNarrowWide, not the default • glyph.
    expect(
      document.body.querySelector('[data-testid="priority-audit-marker"] svg')
    ).not.toBeNull()

    // The actor is already inside the description; it must NOT also be
    // rendered as an @mention (details.by is a display name, not an email).
    expect(screen.queryByText('@Ada Lovelace')).toBeNull()
  })
})
