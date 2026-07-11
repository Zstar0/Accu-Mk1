import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WatchStateButton } from '@/components/flags/WatchStateButton'

const api = vi.hoisted(() => ({
  armWatch: vi.fn().mockResolvedValue({ id: 9 }),
}))
vi.mock('@/lib/flags-api', async orig => ({ ...(await orig()), ...api }))
vi.mock('@/lib/api', async orig => ({
  ...(await orig()),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
}))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('WatchStateButton', () => {
  it('arms a standalone create_flag watch (no watch_flag_id)', async () => {
    render(
      wrap(
        <WatchStateButton
          entityType="sample"
          entityId="PB-0102"
          targetLabel="PB-0102"
        />
      )
    )
    fireEvent.click(
      screen.getByRole('button', { name: /watch for state change/i })
    )
    fireEvent.change(await screen.findByPlaceholderText('received'), {
      target: { value: 'received' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^arm$/i }))
    await waitFor(() =>
      expect(api.armWatch).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'sample',
          entity_id: 'PB-0102',
          condition: { field: 'state', equals: 'received' },
          action: expect.objectContaining({
            kind: 'create_flag',
            type: 'task',
          }),
        })
      )
    )
    const body = api.armWatch.mock.calls[0]?.[0]
    expect(body).toBeTruthy()
    expect(body?.watch_flag_id ?? null).toBeFalsy()
  })
})
