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

// The page only selects navigateToReceiveBoxing off the ui-store; mirror the
// canonical selector-driven mock (AppSidebar.test.tsx) with just that slot.
const navigateToReceiveBoxing = vi.fn()
interface MockUIState {
  navigateToReceiveBoxing: (orderKey: string) => void
}
vi.mock('@/store/ui-store', () => {
  const state = (): MockUIState => ({ navigateToReceiveBoxing })
  const useUIStore = <T,>(selector: (s: MockUIState) => T): T =>
    selector(state())
  ;(useUIStore as unknown as { getState: () => MockUIState }).getState = state
  return { useUIStore }
})

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
    navigateToReceiveBoxing.mockClear()
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

  it('order group header links to the WP order admin page', async () => {
    mockList.mockResolvedValue([box])
    renderPage()
    const link = await screen.findByRole('link', { name: 'WP-3267' })
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining('wc-orders&action=edit&id=3267'),
    )
    expect(screen.getByText('1 box')).toBeInTheDocument()
  })

  it('clicking a box label deep-links into the order receive session', async () => {
    mockList.mockResolvedValue([box])
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'WP-3267-1' }))
    expect(navigateToReceiveBoxing).toHaveBeenCalledWith('WP-3267')
  })

  it('renders the coming-soon Location placeholder', async () => {
    mockList.mockResolvedValue([box])
    renderPage()
    await screen.findByText('WP-3267-1')
    expect(screen.getByText('Location')).toBeInTheDocument()
    expect(screen.getByText('Coming soon')).toBeInTheDocument()
  })
})
