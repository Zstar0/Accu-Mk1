import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { ExplorerOrder, SenaiteLookupResult, WooOrder } from '@/lib/api'

// Selector-callable ui-store mock — required by SampleCard (transitive child).
const navigateToSampleMock = vi.fn()
vi.mock('@/store/ui-store', () => {
  const state = {
    navigateToSample: navigateToSampleMock,
  }
  const useUIStore = <T,>(selector: (s: typeof state) => T): T =>
    selector(state)
  useUIStore.getState = () => state
  return { useUIStore }
})

vi.mock('@/lib/api-profiles', () => ({
  getActiveEnvironmentName: vi.fn().mockReturnValue('test-env'),
  API_PROFILE_CHANGED_EVENT: 'api-profile-changed',
}))

const getWooOrderMock = vi.fn()
vi.mock('@/lib/api', () => ({
  lookupSenaiteSample: vi.fn(),
  getWooOrder: getWooOrderMock,
}))

const { OrderRow } = await import('@/components/explorer/OrderRow')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeOrder(overrides: Partial<ExplorerOrder> = {}): ExplorerOrder {
  return {
    id: 'order-uuid-1',
    order_id: '12345',
    order_number: '12345',
    status: 'pending',
    samples_expected: 1,
    samples_delivered: 0,
    error_message: null,
    payload: {
      billing: { email: 'forrestp@outlook.com' },
    },
    sample_results: null,
    created_at: new Date(Date.now() - 60 * 60_000).toISOString(), // 1h ago
    updated_at: new Date().toISOString(),
    completed_at: null,
    wp_order_status: 'processing',
    ...overrides,
  }
}

// Render a <tr> inside a <table><tbody> wrapper to avoid validateDOMNesting
// warnings (advisor guidance).
function renderRow(row: React.ReactNode) {
  return render(
    <table>
      <tbody>{row}</tbody>
    </table>,
    { wrapper }
  )
}

describe('OrderRow', () => {
  it('renders_order_id_cell_with_external_wp_admin_link', () => {
    const order = makeOrder({ order_id: '99001' })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={
          new Map<
            string,
            {
              data?: SenaiteLookupResult
              isLoading: boolean
              isError: boolean
            }
          >()
        }
        activeAnalysisStates={[]}
      />
    )
    // Order id text in the row
    expect(screen.getByText('99001')).toBeInTheDocument()
    // External link href contains the wp-admin path + order_id
    const link = screen.getByRole('link', { name: /99001/ })
    expect(link.getAttribute('href')).toContain('/wp-admin/post.php?post=')
    expect(link.getAttribute('href')).toContain('99001')
  })

  it('renders_processing_time_with_yellow_color_when_completed_at_is_null', () => {
    const order = makeOrder({ completed_at: null })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={
          new Map<
            string,
            {
              data?: SenaiteLookupResult
              isLoading: boolean
              isError: boolean
            }
          >()
        }
        activeAnalysisStates={[]}
      />
    )
    // The processing-time <span> has class text-yellow-600 when not completed
    const yellowSpan = document.querySelector('.text-yellow-600')
    expect(yellowSpan).not.toBeNull()
    const greenSpan = document.querySelector('.text-green-600')
    expect(greenSpan).toBeNull()
  })

  it('renders_email_from_payload_billing', () => {
    const order = makeOrder({
      payload: { billing: { email: 'forrestp@outlook.com' } },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={
          new Map<
            string,
            {
              data?: SenaiteLookupResult
              isLoading: boolean
              isError: boolean
            }
          >()
        }
        activeAnalysisStates={[]}
      />
    )
    expect(screen.getByText('forrestp@outlook.com')).toBeInTheDocument()
  })

  it('renders_no_samples_label_when_sample_results_is_null', () => {
    const order = makeOrder({ sample_results: null })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={
          new Map<
            string,
            {
              data?: SenaiteLookupResult
              isLoading: boolean
              isError: boolean
            }
          >()
        }
        activeAnalysisStates={[]}
      />
    )
    expect(screen.getByText('No samples')).toBeInTheDocument()
  })
})

// Phase 30 — search-result rendering props on OrderRow.
//
// DEVIATION FROM PLAN: The plan's Step 1 Test 1 expected "samples not visible
// when defaultExpanded is undefined", premised on a pre-existing expand/collapse
// mechanism in OrderRow. No such mechanism exists — samples are always rendered
// inline. Introducing expand/collapse would be a UX regression on the existing
// /explorer/orders page and is out of scope for prop-plumbing.
//
// We accept `defaultExpanded` as a prop for semantic intent (Task 7 passes it
// when a search is active) but it is currently a no-op at this layer. The
// useful prop is `highlightSampleId`, which adds the ring highlight on the
// matching SampleCard. Test 1 is inverted to assert the actual preserved
// behavior: samples remain visible regardless of `defaultExpanded`.
describe('OrderRow — search-result props (Phase 30)', () => {
  it('renders samples by default (defaultExpanded undefined preserves current behavior)', async () => {
    const order = makeOrderWithSamples([
      { senaite_id: 'P-0001', status: 'created' },
    ])
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
      />
    )
    // Sample cards are visible without explicit expansion (always-on layout).
    expect(await screen.findByTestId('sample-card-P-0001')).toBeInTheDocument()
  })

  it('renders pre-expanded when defaultExpanded=true (semantic; samples already visible)', async () => {
    const order = makeOrderWithSamples([
      { senaite_id: 'P-0001', status: 'created' },
    ])
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
        defaultExpanded={true}
      />
    )
    expect(await screen.findByTestId('sample-card-P-0001')).toBeInTheDocument()
  })

  it('applies ring-2 ring-primary class to SampleCard with matching highlightSampleId', async () => {
    const order = makeOrderWithSamples([
      { senaite_id: 'P-0001', status: 'created' },
      { senaite_id: 'P-0002', status: 'created' },
    ])
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
        defaultExpanded={true}
        highlightSampleId="P-0001"
      />
    )

    const highlighted = await screen.findByTestId('sample-card-P-0001')
    expect(highlighted.className).toMatch(/ring-2/)
    expect(highlighted.className).toMatch(/ring-primary/)

    const notHighlighted = await screen.findByTestId('sample-card-P-0002')
    expect(notHighlighted.className).not.toMatch(/ring-2/)
  })
})

// Build an ExplorerOrder with the given samples wired into sample_results.
// Mirrors the shape used elsewhere in the test suite — sample keys are
// stringified positional indexes (1, 2, ...) and values carry senaite_id +
// integration status only.
function makeOrderWithSamples(
  samples: { senaite_id: string; status: string }[]
): ExplorerOrder {
  const sample_results: Record<string, { senaite_id: string; status: string }> =
    {}
  samples.forEach((s, i) => {
    sample_results[String(i + 1)] = s
  })
  return makeOrder({
    sample_results: sample_results as ExplorerOrder['sample_results'],
  })
}

// Phase 31 — analyte plumbing. OrderRow extracts payload.samples[i].sample_identity
// and forwards it to SampleCard as the `analyte` prop. The integer key in
// sample_results ("1", "2", ...) is the 1-based positional index into
// payload.samples. We cover happy path, legacy orders without payload.samples,
// and the integration-failed (no senaite_id) branch which renders a different
// destructive card outside of SampleCard.
describe('OrderRow — analyte plumbing (Phase 31)', () => {
  it('passes payload.samples[i].sample_identity to the matching SampleCard by position', async () => {
    const order = makeOrder({
      sample_results: {
        '1': { senaite_id: 'P-0001', status: 'created' },
        '2': { senaite_id: 'P-0002', status: 'created' },
      } as ExplorerOrder['sample_results'],
      payload: {
        billing: { email: 'forrestp@outlook.com' },
        samples: [
          { sample_identity: 'BPC-157' },
          { sample_identity: 'GHRP-6 5mg' },
        ],
      },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
      />
    )
    const card1 = await screen.findByTestId('sample-card-P-0001')
    expect(within(card1).getByText('BPC-157')).toBeInTheDocument()
    const card2 = await screen.findByTestId('sample-card-P-0002')
    expect(within(card2).getByText('GHRP-6 5mg')).toBeInTheDocument()
  })

  it('renders SampleCards without analyte when payload.samples is absent (legacy orders)', async () => {
    const order = makeOrder({
      sample_results: {
        '1': { senaite_id: 'P-0001', status: 'created' },
      } as ExplorerOrder['sample_results'],
      payload: { billing: { email: 'forrestp@outlook.com' } },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
      />
    )
    expect(await screen.findByTestId('sample-card-P-0001')).toBeInTheDocument()
    // No analyte sub-row should be rendered for this card.
    expect(
      screen.queryByTestId('sample-card-analyte-P-0001')
    ).not.toBeInTheDocument()
  })

  it('passes a trimmed analyte (whitespace-only sample_identity collapses to undefined)', async () => {
    const order = makeOrder({
      sample_results: {
        '1': { senaite_id: 'P-0001', status: 'created' },
        '2': { senaite_id: 'P-0002', status: 'created' },
      } as ExplorerOrder['sample_results'],
      payload: {
        billing: { email: 'forrestp@outlook.com' },
        samples: [{ sample_identity: '   ' }, { sample_identity: '  KPV  ' }],
      },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
      />
    )
    // Whitespace-only -> sub-row omitted.
    expect(
      screen.queryByTestId('sample-card-analyte-P-0001')
    ).not.toBeInTheDocument()
    // Trimmed value rendered exactly (no leading/trailing whitespace).
    const card2 = await screen.findByTestId('sample-card-P-0002')
    expect(within(card2).getByText('KPV')).toBeInTheDocument()
  })

  it('renders the analyte on the integration-failed destructive card too', () => {
    const order = makeOrder({
      sample_results: {
        '1': { senaite_id: '', status: 'failed' },
      } as ExplorerOrder['sample_results'],
      payload: {
        billing: { email: 'forrestp@outlook.com' },
        samples: [{ sample_identity: 'Tirzepatide' }],
      },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
      />
    )
    expect(screen.getByText('Failed to create in SENAITE')).toBeInTheDocument()
    expect(screen.getByText('Tirzepatide')).toBeInTheDocument()
  })
})

// Option A — live WooCommerce finance disclosure (customer-detail only).
// OrderRow gains an opt-in `showFinance` chevron that lazily fetches the full
// WC order via getWooOrder when expanded. Off by default so the shared
// /explorer OrderStatusPage view is untouched.
function makeWooOrder(overrides: Partial<WooOrder> = {}): WooOrder {
  return {
    id: 12345,
    number: '12345',
    status: 'completed',
    date_created: '2026-05-12T03:52:51',
    date_paid: '2026-05-12T03:53:10',
    currency: 'USD',
    currency_symbol: '&#36;',
    discount_total: '25.00',
    discount_tax: '0.00',
    shipping_total: '0.00',
    cart_tax: '0.00',
    total: '225.00',
    total_tax: '0.00',
    billing: {
      first_name: 'Forrest',
      last_name: 'Parker',
      company: 'ftest2',
      address_1: '3602 Hillside Dr.',
      city: 'Dallas',
      state: 'TX',
      postcode: '75213',
      country: 'US',
      email: 'forrestp@outlook.com',
      phone: '3233335888',
    },
    payment_method_title: 'Stripe',
    customer_note: '',
    line_items: [
      {
        id: 1,
        name: 'HPLC Purity & Identity',
        product_id: 100,
        quantity: 1,
        subtotal: '250.00',
        total: '250.00',
        sku: 'HPLC',
        price: 250,
      },
    ],
    shipping_lines: [],
    coupon_lines: [
      { id: 9, code: 'SUMMER25', discount: '25.00', discount_tax: '0.00' },
    ],
    tax_lines: [],
    ...overrides,
  }
}

describe('OrderRow — finance disclosure (Option A)', () => {
  beforeEach(() => {
    getWooOrderMock.mockReset()
  })

  it('does not render the finance toggle when showFinance is absent', () => {
    renderRow(
      <OrderRow
        order={makeOrder({ order_id: '3241' })}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
      />
    )
    expect(
      screen.queryByRole('button', { name: /finance details/i })
    ).not.toBeInTheDocument()
    expect(getWooOrderMock).not.toHaveBeenCalled()
  })

  it('shows toggle but does not fetch until expanded (lazy)', () => {
    getWooOrderMock.mockResolvedValue(makeWooOrder())
    renderRow(
      <OrderRow
        order={makeOrder({ order_id: '3241' })}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
        showFinance
      />
    )
    // Chevron present, but no fetch and no detail row yet.
    expect(
      screen.getByRole('button', { name: /show finance details/i })
    ).toBeInTheDocument()
    expect(screen.queryByTestId('order-finance-row')).not.toBeInTheDocument()
    expect(getWooOrderMock).not.toHaveBeenCalled()
  })

  it('expands to fetch and render finance totals + coupon code', async () => {
    getWooOrderMock.mockResolvedValue(makeWooOrder())
    renderRow(
      <OrderRow
        order={makeOrder({ order_id: '3241' })}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
        showFinance
      />
    )
    fireEvent.click(
      screen.getByRole('button', { name: /show finance details/i })
    )
    // Fetch fires with the WP order id; finance row mounts.
    await waitFor(() => expect(getWooOrderMock).toHaveBeenCalledWith('3241'))
    expect(await screen.findByTestId('order-finance-row')).toBeInTheDocument()
    // Total + decoded currency symbol (&#36; -> $).
    expect(await screen.findByText('$225.00')).toBeInTheDocument()
    // $250.00 appears twice: the single line-item total AND the computed
    // subtotal (one line item, so they're equal).
    expect(screen.getAllByText('$250.00')).toHaveLength(2)
    // Discount shown negative with the coupon code badge.
    expect(screen.getByText('−$25.00')).toBeInTheDocument()
    expect(screen.getByText('SUMMER25')).toBeInTheDocument()
    // Payment method surfaced.
    expect(screen.getByText(/Stripe/)).toBeInTheDocument()
  })

  it('renders an error state when the WC fetch rejects', async () => {
    getWooOrderMock.mockRejectedValue(new Error('boom'))
    renderRow(
      <OrderRow
        order={makeOrder({ order_id: '3241' })}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
        showFinance
      />
    )
    fireEvent.click(
      screen.getByRole('button', { name: /show finance details/i })
    )
    expect(
      await screen.findByText(/Couldn't load finance details/i)
    ).toBeInTheDocument()
  })
})
