import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ReceiveSample } from '@/components/intake/ReceiveSample'
import { getSetting } from '@/lib/api'

// Stub the heavy session shell with a sentinel that echoes the flattened sample
// ids it was handed, so we can assert which orders a Process click opened.
vi.mock('@/components/intake/OrderReceiveSession', () => ({
  OrderReceiveSession: ({
    orders,
  }: {
    orders: { samples: { id: string }[] }[]
  }) => (
    <div data-testid="session">
      {orders
        .flatMap(o => o.samples)
        .map(s => (
          <span key={s.id} data-testid="session-sample">
            {s.id}
          </span>
        ))}
    </div>
  ),
}))

// The SLA cell pulls in i18n + tooltip; replace it with a sentinel.
vi.mock('@/components/explorer/OrderSlaCell', () => ({
  OrderSlaCell: () => <span data-testid="sla-cell" />,
}))

// Page-level SLA + lookup hooks hit the backend; stub to stable empty shapes.
vi.mock('@/services/order-sla', () => ({
  useOrderSlaStatuses: () => ({ verdictByOrderId: new Map() }),
}))
vi.mock('@/services/senaite-lookup-map', () => ({
  useSenaiteLookupMap: () => ({ sampleLookupMap: new Map() }),
}))

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getSenaiteStatus: vi.fn().mockResolvedValue({ enabled: true }),
    getSenaiteSamples: vi.fn().mockResolvedValue({
      items: [
        {
          uid: 'u1',
          id: 'P-1',
          client_order_number: 'WP-1042',
          client_id: 'acme',
          sample_type: 'Peptide',
          review_state: 'sample_due',
          date_sampled: null,
        },
        {
          uid: 'u2',
          id: 'P-2',
          client_order_number: 'WP-1043',
          client_id: 'acme',
          sample_type: 'Peptide',
          review_state: 'sample_due',
          date_sampled: null,
        },
        {
          uid: 'u3',
          id: 'P-3',
          client_order_number: 'WP-1099',
          client_id: 'acme',
          sample_type: 'Peptide',
          review_state: 'sample_due',
          date_sampled: null,
        },
      ],
    }),
    getExplorerOrders: vi.fn().mockResolvedValue([
      {
        order_number: 'WP-1042',
        order_id: 1,
        customer_id: 7,
        created_at: '2026-06-24T00:00:00Z',
        payload: {},
      },
      {
        order_number: 'WP-1043',
        order_id: 2,
        customer_id: 8,
        created_at: '2026-06-24T00:00:00Z',
        payload: {},
      },
      {
        order_number: 'WP-1099',
        order_id: 3,
        customer_id: 9,
        created_at: '2026-06-24T00:00:00Z',
        payload: {},
      },
    ]),
    getOrderBoxLabelSummary: vi
      .fn()
      .mockResolvedValue({ counts: { hplc: 0, endo: 0, ster: 0 } }),
    listSubSamples: vi
      .fn()
      .mockResolvedValue({ parent: { sub_sample_count: 0 } }),
    // Multi-order check-in flag. Default resolves 'true' (set per-test in
    // beforeEach) so the selection/combine suite keeps its checkboxes; the
    // gating suite overrides it to reject (missing key) or resolve 'false'.
    getSetting: vi.fn(),
  }
})

// The multi-order UI is now opt-in. Default every test to the flag ON so the
// existing selection/combine suite behaves as before; gating tests override.
beforeEach(() => {
  vi.mocked(getSetting).mockReset()
  vi.mocked(getSetting).mockResolvedValue({
    key: 'checkin_multi_order_enabled',
    value: 'true',
  } as Awaited<ReturnType<typeof getSetting>>)
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(<ReceiveSample />, { wrapper })
}

async function rowCheckbox(orderLabel: string) {
  return screen.findByRole('checkbox', { name: `Select ${orderLabel}` })
}

describe('ReceiveSample — order selection + combine', () => {
  it('checking two rows then Process on one opens a combined session', async () => {
    renderPage()
    fireEvent.click(await rowCheckbox('WP-1042'))
    fireEvent.click(await rowCheckbox('WP-1043'))

    // Process the WP-1042 row (first of the three row buttons).
    const processButtons = screen.getAllByRole('button', { name: 'Process' })
    fireEvent.click(processButtons[0]!)

    await waitFor(() =>
      expect(screen.getByTestId('session')).toBeInTheDocument()
    )
    const ids = screen
      .getAllByTestId('session-sample')
      .map(n => n.textContent)
    expect(ids).toContain('P-1')
    expect(ids).toContain('P-2')
    expect(ids).not.toContain('P-3')
  })

  it('Process on an unchecked row opens just that order', async () => {
    renderPage()
    // Wait for rows, then process WP-1099 (third row) without checking anything.
    await rowCheckbox('WP-1099')
    const processButtons = screen.getAllByRole('button', { name: 'Process' })
    fireEvent.click(processButtons[2]!)

    await waitFor(() =>
      expect(screen.getByTestId('session')).toBeInTheDocument()
    )
    const ids = screen
      .getAllByTestId('session-sample')
      .map(n => n.textContent)
    expect(ids).toEqual(['P-3'])
  })

  it('selection bar shows the count and Clear empties it', async () => {
    renderPage()
    fireEvent.click(await rowCheckbox('WP-1042'))
    fireEvent.click(await rowCheckbox('WP-1043'))

    expect(screen.getByText('2 orders selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() =>
      expect(screen.queryByText(/orders selected/)).toBeNull()
    )
  })
})

describe('ReceiveSample — multi-order check-in flag gating', () => {
  it('hides checkboxes and the combine bar by default (missing setting key)', async () => {
    vi.mocked(getSetting).mockRejectedValue(new Error('404'))
    renderPage()

    // Wait for the By-Order rows to render so absence assertions are meaningful.
    await waitFor(() =>
      expect(screen.getAllByTestId('order-list-row').length).toBeGreaterThan(0)
    )
    expect(
      screen.queryByRole('checkbox', { name: /^Select / })
    ).toBeNull()
    expect(screen.queryByText('Process together')).toBeNull()
  })

  it('hides checkboxes when the setting resolves to "false"', async () => {
    vi.mocked(getSetting).mockResolvedValue({
      key: 'checkin_multi_order_enabled',
      value: 'false',
    } as Awaited<ReturnType<typeof getSetting>>)
    renderPage()

    await waitFor(() =>
      expect(screen.getAllByTestId('order-list-row').length).toBeGreaterThan(0)
    )
    expect(
      screen.queryByRole('checkbox', { name: /^Select / })
    ).toBeNull()
    expect(screen.queryByText('Process together')).toBeNull()
  })

  it('renders row checkboxes when the setting resolves to "true"', async () => {
    // beforeEach already resolves 'true'; assert the checkboxes appear.
    renderPage()
    expect(await rowCheckbox('WP-1042')).toBeInTheDocument()
  })
})
