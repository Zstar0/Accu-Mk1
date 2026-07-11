import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  EntityLinkPicker,
  FlagLinkPicker,
} from '@/components/flags/flag-link-pickers'

const api = vi.hoisted(() => ({
  entitySearch: vi.fn(),
  addEntityLink: vi.fn().mockResolvedValue({ id: 1 }),
  searchFlags: vi.fn(),
  addFlagLink: vi.fn().mockResolvedValue({ id: 2 }),
}))
vi.mock('@/lib/flags-api', async orig => ({ ...(await orig()), ...api }))

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

const flagHit = (over: { flag_id: number; title: string; type?: string }) => ({
  snippet: '',
  matched_in: ['title'],
  status: 'open',
  type: 'blocker',
  ...over,
})

describe('EntityLinkPicker', () => {
  it('searches the scoped type and links the picked entity', async () => {
    api.entitySearch.mockResolvedValue([
      { entity_id: '42', label: 'PB-0102-S01' },
    ])
    render(wrap(<EntityLinkPicker flagId={5} />))
    fireEvent.click(screen.getByRole('button', { name: /item/i }))
    fireEvent.change(screen.getByPlaceholderText('search…'), {
      target: { value: 'PB' },
    })
    // onMouseDown (not click) is the mention-picker idiom — click would blur first.
    fireEvent.mouseDown(await screen.findByText('PB-0102-S01'))
    await waitFor(() =>
      expect(api.addEntityLink).toHaveBeenCalledWith(5, 'sub_sample', '42')
    )
  })
})

describe('FlagLinkPicker', () => {
  it('links the picked flag and excludes the current flag from results', async () => {
    api.searchFlags.mockResolvedValue([
      flagHit({ flag_id: 5, title: 'self', type: 'task' }), // the current flag
      flagHit({ flag_id: 12, title: 'Pump seal' }),
    ])
    render(wrap(<FlagLinkPicker flagId={5} />))
    fireEvent.click(screen.getByRole('button', { name: /flag/i }))
    fireEvent.change(screen.getByPlaceholderText('search flags…'), {
      target: { value: 'pump' },
    })
    expect(await screen.findByText(/Pump seal/)).toBeInTheDocument()
    expect(screen.queryByText('self')).not.toBeInTheDocument()
    fireEvent.mouseDown(screen.getByText(/Pump seal/))
    await waitFor(() => expect(api.addFlagLink).toHaveBeenCalledWith(5, 12))
  })
})
