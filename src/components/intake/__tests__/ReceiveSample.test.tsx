import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ReceiveSample } from '@/components/intake/ReceiveSample'
import { getRegistrySamples, getSetting } from '@/lib/api'

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

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    // Native inbox (receive-page SENAITE flip): the due list reads the
    // registry, not SENAITE — no status gate to mock anymore.
    getRegistrySamples: vi.fn().mockResolvedValue({
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

// Registry-shaped sample factory for the pagination / search / expand suite.
function mkSample(i: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    uid: `u${i}`,
    id: `P-${i}`,
    client_order_number: `WP-${1000 + i}`,
    client_id: 'acme',
    sample_type: 'Peptide',
    review_state: 'sample_due',
    date_sampled: null,
    client_lot: null,
    analytes: [],
    ...over,
  }
}

describe('ReceiveSample — full due list (pagination past 200)', () => {
  it('keeps fetching pages until the whole due list is loaded', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => mkSample(i))
    const page2 = [mkSample(200), mkSample(201)]
    vi.mocked(getRegistrySamples).mockClear()
    vi.mocked(getRegistrySamples)
      .mockResolvedValueOnce({ items: page1, total: 202, b_start: 0 } as never)
      .mockResolvedValueOnce({
        items: page2,
        total: 202,
        b_start: 200,
      } as never)
    renderPage()

    // An order that only exists on the SECOND page must render — this is the
    // exact failure that hid order 6344 (position ~235 of 326) in prod.
    expect(await screen.findByText('WP-1201')).toBeInTheDocument()
    expect(vi.mocked(getRegistrySamples)).toHaveBeenCalledWith(
      'sample_due',
      200,
      0
    )
    expect(vi.mocked(getRegistrySamples)).toHaveBeenCalledWith(
      'sample_due',
      200,
      200
    )
  })
})

describe('ReceiveSample — search axes + sort + expand', () => {
  const richSamples = [
    mkSample(10, {
      client_order_number: 'WP-2001',
      client_id: 'alpha@x.com',
      analytes: ['BPC-157 - Identity (HPLC)'],
      analyte_details: [
        { name: 'BPC-157 - Identity (HPLC)', declared_quantity: '10 mg' },
      ],
      client_lot: 'LOT-AAA',
    }),
    mkSample(11, {
      client_order_number: 'WP-2002',
      client_id: 'beta@y.com',
      analytes: ['Semax - Identity (HPLC)'],
      client_lot: 'LOT-BBB',
    }),
    mkSample(12, {
      client_order_number: 'WP-2003',
      client_id: 'gamma@z.com',
      analytes: ['NAD+ - Identity (HPLC)'],
      client_lot: 'LOT-CCC',
    }),
  ]

  function renderRich() {
    vi.mocked(getRegistrySamples).mockClear()
    vi.mocked(getRegistrySamples).mockResolvedValue({
      items: richSamples,
      total: 3,
      b_start: 0,
    } as never)
    return renderPage()
  }

  it('filters by partial order number', async () => {
    renderRich()
    await screen.findByText('WP-2001')
    fireEvent.change(screen.getByLabelText('Search by order number'), {
      target: { value: '2002' },
    })
    expect(screen.queryByText('WP-2001')).toBeNull()
    expect(screen.getByText('WP-2002')).toBeInTheDocument()
    expect(screen.queryByText('WP-2003')).toBeNull()
  })

  it('filters by client email', async () => {
    renderRich()
    await screen.findByText('WP-2001')
    fireEvent.change(screen.getByLabelText('Search by client or email'), {
      target: { value: 'gamma@' },
    })
    expect(screen.queryByText('WP-2001')).toBeNull()
    expect(screen.getByText('WP-2003')).toBeInTheDocument()
  })

  it('filters by analyte and lot, AND-combined', async () => {
    renderRich()
    await screen.findByText('WP-2001')
    fireEvent.change(screen.getByLabelText('Search by analyte'), {
      target: { value: 'semax' },
    })
    expect(screen.getByText('WP-2002')).toBeInTheDocument()
    expect(screen.queryByText('WP-2001')).toBeNull()
    // A lot from a DIFFERENT sample must AND to zero rows.
    fireEvent.change(screen.getByLabelText('Search by lot number'), {
      target: { value: 'LOT-CCC' },
    })
    expect(screen.queryByText('WP-2002')).toBeNull()
    expect(
      screen.getByText('No orders match the current search')
    ).toBeInTheDocument()
  })

  it('sorts by Order # on header click', async () => {
    renderRich()
    await screen.findByText('WP-2001')
    const header = screen.getByText('Order #')
    fireEvent.click(header) // asc
    fireEvent.click(header) // desc
    const rows = screen.getAllByTestId('order-list-row')
    expect(rows[0]!.textContent).toContain('WP-2003')
  })

  it('expand shows sample id, analytes, lot and declared qty', async () => {
    renderRich()
    await screen.findByText('WP-2001')
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand WP-2001' })
    )
    const detail = screen.getByTestId('order-detail-row')
    expect(detail.textContent).toContain('P-10')
    expect(detail.textContent).toContain('BPC-157 - Identity (HPLC)')
    expect(detail.textContent).toContain('LOT-AAA')
    expect(detail.textContent).toContain('10 mg')
  })
})
