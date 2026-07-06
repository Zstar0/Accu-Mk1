import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveBoxesPage } from '../ActiveBoxesPage'
import { closeBox, getSenaiteSamples, listActiveBoxes } from '@/lib/api'
import { toast } from 'sonner'

vi.mock('@/lib/api', () => ({
  listActiveBoxes: vi.fn(),
  closeBox: vi.fn(),
  getSenaiteSamples: vi.fn(),
}))
const mockList = vi.mocked(listActiveBoxes)
const mockClose = vi.mocked(closeBox)
const mockSamples = vi.mocked(getSenaiteSamples)

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

// The vial-row sample button navigates via useUIStore.getState().navigateToSample.
// The hook is selector-aware so the deep-link effect reads boxesSearchTarget: null
// (no incoming target) instead of undefined.
const { mockNavigateToSample } = vi.hoisted(() => ({ mockNavigateToSample: vi.fn() }))
vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(
    vi.fn((selector?: (s: { boxesSearchTarget: string | null }) => unknown) =>
      selector ? selector({ boxesSearchTarget: null }) : undefined
    ),
    {
      getState: () => ({ navigateToSample: mockNavigateToSample }),
      setState: vi.fn(),
    }
  ),
}))

// Stub the heavy session shell with a sentinel echoing the order it was handed
// and the landing tab, so we can assert what a box-label click opened.
vi.mock('@/components/intake/OrderReceiveSession', () => ({
  OrderReceiveSession: ({
    orders,
    initialPhase,
  }: {
    orders: { orderKey: string | null }[]
    initialPhase?: string
  }) => (
    <div data-testid="session" data-initial-phase={initialPhase}>
      {orders[0]?.orderKey}
    </div>
  ),
}))

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
  vials: [
    { sample_id: 'P-0141-S01', parent_sample_id: 'P-0141', assignment_role: 'hplc', vial_sequence: 1 },
  ],
}

const orderSample = {
  uid: 'u1',
  id: 'P-1',
  title: 'P-1',
  client_id: 'acme',
  client_order_number: 'WP-3267',
  date_created: null,
  date_received: null,
  date_sampled: null,
  review_state: 'sample_received',
  sample_type: 'Peptide',
  contact: null,
  verification_code: null,
  analytes: [],
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
    mockSamples.mockReset()
    vi.mocked(toast.error).mockClear()
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

  it('clicking a box label fetches the order and opens the session on Boxing', async () => {
    mockList.mockResolvedValue([box])
    mockSamples.mockResolvedValue({ items: [orderSample], total: 1, b_start: 0 })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'WP-3267-1' }))
    await waitFor(() =>
      expect(mockSamples).toHaveBeenCalledWith(undefined, 200, 0, 'WP-3267', 'order_number'),
    )
    const session = await screen.findByTestId('session')
    expect(session).toHaveTextContent('WP-3267')
    expect(session.dataset.initialPhase).toBe('boxing')
  })

  it('no matching samples: session does not open and a notice is raised', async () => {
    mockList.mockResolvedValue([box])
    // Fuzzy search returns something, but nothing exactly on this order.
    mockSamples.mockResolvedValue({
      items: [{ ...orderSample, client_order_number: 'WP-32670' }],
      total: 1,
      b_start: 0,
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'WP-3267-1' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('No order session available for WP-3267'),
    )
    expect(screen.queryByTestId('session')).toBeNull()
  })

  it('expand chevron reveals the vials inside the box', async () => {
    mockList.mockResolvedValue([box])
    renderPage()
    await screen.findByText('WP-3267-1')
    // Collapsed by default — the vial is hidden until the chevron is clicked.
    expect(screen.queryByText('P-0141-S01')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand WP-3267-1' }))
    expect(screen.getByText('P-0141-S01')).toBeInTheDocument()
  })

  it('Sample ID search keeps matching boxes, auto-expands them, and hides the rest', async () => {
    mockList.mockResolvedValue([box])
    renderPage()
    await screen.findByText('WP-3267-1')
    fireEvent.change(screen.getByLabelText('Sample ID'), { target: { value: 'P-0141-S01' } })
    // Box stays visible and is auto-expanded so the matching vial shows.
    expect(screen.getByText('WP-3267-1')).toBeInTheDocument()
    expect(screen.getByText('P-0141-S01')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Sample ID'), { target: { value: 'P-9999-S01' } })
    expect(screen.queryByText('WP-3267-1')).toBeNull()
    expect(screen.getByText(/no boxes match your search/i)).toBeInTheDocument()
  })

  it('Order # search filters boxes by their order key', async () => {
    mockList.mockResolvedValue([box])
    renderPage()
    await screen.findByText('WP-3267-1')
    fireEvent.change(screen.getByLabelText('Order #'), { target: { value: 'WP-9999' } })
    expect(screen.queryByText('WP-3267-1')).toBeNull()
    expect(screen.getByText(/no boxes match your search/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Order #'), { target: { value: 'WP-3267' } })
    expect(screen.getByText('WP-3267-1')).toBeInTheDocument()
  })

  it('renders the coming-soon Location placeholder', async () => {
    mockList.mockResolvedValue([box])
    renderPage()
    await screen.findByText('WP-3267-1')
    expect(screen.getByText('Location')).toBeInTheDocument()
    expect(screen.getByText('Coming soon')).toBeInTheDocument()
  })
})
