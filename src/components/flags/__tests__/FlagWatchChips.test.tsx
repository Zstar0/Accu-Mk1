import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FlagWatchChips } from '@/components/flags/FlagWatchChips'

const api = vi.hoisted(() => ({
  listWatches: vi.fn(),
  armWatch: vi.fn().mockResolvedValue({ id: 5 }),
  cancelWatch: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/flags-api', async orig => ({ ...(await orig()), ...api }))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('FlagWatchChips', () => {
  it('renders nothing for an unwatchable anchor', () => {
    api.listWatches.mockResolvedValue([])
    const { container } = render(
      wrap(<FlagWatchChips flagId={1} entityType="sub_sample" entityId="9" />)
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists an armed watch and cancels it', async () => {
    api.listWatches.mockResolvedValue([
      {
        id: 5,
        entity_type: 'sample',
        entity_id: 'PB-0102',
        status: 'armed',
        condition: { field: 'state', equals: 'received' },
        action: { kind: 'comment', flag_id: 1 },
        watch_flag_id: 1,
        created_by: 1,
        created_at: '',
        fired_at: null,
      },
    ])
    render(
      wrap(<FlagWatchChips flagId={1} entityType="sample" entityId="PB-0102" />)
    )
    expect(await screen.findByText(/received/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /cancel watch/i }))
    await waitFor(() => expect(api.cancelWatch).toHaveBeenCalledWith(5))
  })

  it('arms a comment-on-fire watch tied to this flag', async () => {
    api.listWatches.mockResolvedValue([])
    render(
      wrap(<FlagWatchChips flagId={1} entityType="sample" entityId="PB-0102" />)
    )
    fireEvent.click(
      await screen.findByRole('button', { name: /watch for state/i })
    )
    fireEvent.change(screen.getByPlaceholderText('received'), {
      target: { value: 'received' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^arm$/i }))
    await waitFor(() =>
      expect(api.armWatch).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'sample',
          entity_id: 'PB-0102',
          watch_flag_id: 1,
          condition: { field: 'state', equals: 'received' },
          action: expect.objectContaining({ kind: 'comment', flag_id: 1 }),
        })
      )
    )
  })
})
