import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import type { FlagDetailResponse } from '@/lib/flags-api'
import { FlagLinkChips } from '@/components/flags/FlagLinkChips'

function detail(over: Partial<FlagDetailResponse>): FlagDetailResponse {
  return {
    id: 5,
    entity_type: null,
    entity_id: null,
    kind: 'issue',
    type: 'task',
    status: 'open',
    title: 'parent',
    created_by: 1,
    assignee_id: null,
    created_at: '',
    updated_at: '',
    resolved_at: null,
    resolved_by: null,
    due_at: null,
    comments: [],
    events: [],
    watchers: [],
    entity_links: [],
    flag_links: [],
    ...over,
  }
}

describe('FlagLinkChips', () => {
  beforeEach(() =>
    useUIStore.setState({ flagsThreadId: null, flagsFlyoutOpen: false })
  )

  it('renders entity + flag link labels and opens the linked thread on click', () => {
    render(
      <FlagLinkChips
        flagId={5}
        currentFlag={detail({
          entity_links: [
            {
              id: 1,
              entity_type: 'sub_sample',
              entity_id: '77',
              entity: {
                entity_type: 'sub_sample',
                entity_id: '77',
                label: 'PB-0077-S01',
                sample_id: 'PB-0077',
                analyses: [],
                lot: null,
                deep_link: { kind: 'sample', id: 'PB-0077' },
              },
            },
          ],
          flag_links: [
            { id: 2, flag_id: 12, title: 'Pump seal', status: 'open', type: 'blocker' },
          ],
        })}
      />
    )
    expect(screen.getByText('PB-0077-S01')).toBeInTheDocument()
    expect(screen.getByText(/Pump seal/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Pump seal/))
    expect(useUIStore.getState().flagsThreadId).toBe(12)
  })
})
