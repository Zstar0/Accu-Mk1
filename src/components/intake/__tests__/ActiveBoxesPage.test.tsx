import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveBoxesPage } from '../ActiveBoxesPage'
import { listActiveBoxes, closeBox } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  listActiveBoxes: vi.fn(),
  closeBox: vi.fn(),
}))
const mockList = vi.mocked(listActiveBoxes)
const mockClose = vi.mocked(closeBox)

const box = {
  id: 13,
  order_key: 'WP-3267',
  box_number: 1,
  role: 'hplc' as const,
  label_code: 'WP-3267-1',
  vial_count: 2,
  printed_at: null,
  created_at: '2026-07-01T12:00:00',
  stored_at: null,
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ActiveBoxesPage />
    </QueryClientProvider>,
  )
}

describe('ActiveBoxesPage', () => {
  beforeEach(() => {
    mockList.mockReset()
    mockClose.mockReset()
  })

  it('renders active boxes with label, order, and vial count', async () => {
    mockList.mockResolvedValue([box])
    renderPage()
    expect(await screen.findByText('WP-3267-1')).toBeInTheDocument()
    expect(screen.getByText('WP-3267')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('Close asks for confirmation, then calls closeBox with the box id', async () => {
    mockList.mockResolvedValue([box])
    mockClose.mockResolvedValue({ ...box, vial_count: 0, stored_at: '2026-07-01T13:00:00' })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /close/i }))
    // Confirm dialog: closeBox NOT called yet.
    expect(mockClose).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /return vials|confirm/i }))
    await waitFor(() => expect(mockClose).toHaveBeenCalledWith(13))
  })

  it('shows the empty state when no boxes are active', async () => {
    mockList.mockResolvedValue([])
    renderPage()
    expect(await screen.findByText(/no active boxes/i)).toBeInTheDocument()
  })
})
