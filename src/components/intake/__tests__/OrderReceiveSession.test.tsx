import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { OrderReceiveSession } from '@/components/intake/OrderReceiveSession'
import type { OrderGroup } from '@/lib/inbox-orders'
import type { SenaiteSample } from '@/lib/api'

// BoxStep pulls in dnd-kit + the boxing queries — replace it with a sentinel
// that echoes the order key it was handed so we can assert one section per
// order with the right scope.
vi.mock('@/components/intake/ReceiveWizard/BoxStep', () => ({
  BoxStep: ({ orderKey }: { orderKey: string }) => (
    <div data-testid="box-step">{orderKey}</div>
  ),
}))

// The receive wizard mounts for the active (non-boxing) sample; stub it so the
// rail/boxing structure is what's under test, not the wizard internals.
vi.mock('@/components/intake/ReceiveWizard/ReceiveWizard', () => ({
  ReceiveWizard: () => <div data-testid="receive-wizard" />,
}))

// Per-sample header/rail enrichment hits the backend; stub to a stable empty
// shape so rows render without a real SENAITE lookup.
vi.mock('@/components/intake/ReceiveWizard/useParentSampleDetails', () => ({
  useParentSampleDetails: () => ({ details: null, loading: false }),
}))

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listSubSamples: vi
      .fn()
      .mockResolvedValue({ parent: { sub_sample_count: 0 } }),
  }
})

const sample = (id: string): SenaiteSample =>
  ({ id, uid: `uid-${id}` }) as unknown as SenaiteSample

const order = (
  orderKey: string,
  sampleIds: string[]
): OrderGroup => ({
  orderKey,
  orderLabel: orderKey,
  clientId: 'acme',
  samples: sampleIds.map(sample),
})

function renderSession(orders: OrderGroup[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(
    <OrderReceiveSession orders={orders} onClose={vi.fn()} />,
    { wrapper }
  )
}

describe('OrderReceiveSession (orders[])', () => {
  const twoOrders = [
    order('WP-1042', ['P-1101', 'P-1102']),
    order('WP-1043', ['P-1108']),
  ]

  it('renders a rail separator per order and every sample', () => {
    renderSession(twoOrders)
    // Both order labels appear as rail separators.
    expect(screen.getByText('WP-1042')).toBeInTheDocument()
    expect(screen.getByText('WP-1043')).toBeInTheDocument()
    // Every sample across both orders renders in the rail. (P-1101 is also the
    // active sample, so it surfaces in the header too — hence getAllByText.)
    expect(screen.getAllByText('P-1101').length).toBeGreaterThan(0)
    expect(screen.getByText('P-1102')).toBeInTheDocument()
    expect(screen.getByText('P-1108')).toBeInTheDocument()
  })

  it('uses an N-orders header for a combined session', () => {
    renderSession(twoOrders)
    // Appears in both the visually-hidden DialogTitle and the visible header.
    expect(screen.getAllByText('Receive 2 orders').length).toBeGreaterThan(0)
  })

  it('renders one BoxStep section per order on the boxing stage', () => {
    renderSession(twoOrders)
    fireEvent.click(screen.getByRole('button', { name: /Boxing/i }))
    const sections = screen.getAllByTestId('box-step')
    expect(sections).toHaveLength(2)
    expect(sections.map(s => s.textContent)).toEqual(['WP-1042', 'WP-1043'])
  })

  it('uses a single-order header for length 1', () => {
    renderSession([order('WP-1042', ['P-1101'])])
    expect(screen.getAllByText(/Receive WP-1042/).length).toBeGreaterThan(0)
  })
})
