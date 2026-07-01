import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { OrderReceiveSession } from '@/components/intake/OrderReceiveSession'
import type { OrderGroup } from '@/lib/inbox-orders'
import type { SenaiteSample } from '@/lib/api'

// Boxing is now an order-scoped tab inside the wizard, not a session stage.
// Capture the props the session hands the wizard so we can assert it passes the
// active order's boxing scope; render the sample id so the rail is testable.
const receiveWizardProps: Array<{
  boxing?: { orderKey: string; sampleIds: string[] }
}> = []
vi.mock('@/components/intake/ReceiveWizard/ReceiveWizard', () => ({
  ReceiveWizard: (props: {
    boxing?: { orderKey: string; sampleIds: string[] }
  }) => {
    receiveWizardProps.push(props)
    return <div data-testid="receive-wizard" />
  },
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
  beforeEach(() => {
    receiveWizardProps.length = 0
  })

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

  it('hands the wizard the active order’s boxing scope (order-scoped tab)', () => {
    renderSession(twoOrders)
    // No standalone boxing stage anymore — no rail Boxing button.
    expect(screen.queryByRole('button', { name: /Boxing/i })).not.toBeInTheDocument()
    // The wizard mounts for the active sample (P-1101, first order) and gets
    // that order's whole scope for its Boxing tab.
    const last = receiveWizardProps[receiveWizardProps.length - 1]
    expect(last?.boxing?.orderKey).toBe('WP-1042')
    expect(last?.boxing?.sampleIds).toEqual(['P-1101', 'P-1102'])
  })

  it('uses a single-order header for length 1', () => {
    renderSession([order('WP-1042', ['P-1101'])])
    expect(screen.getAllByText(/Receive WP-1042/).length).toBeGreaterThan(0)
  })
})
