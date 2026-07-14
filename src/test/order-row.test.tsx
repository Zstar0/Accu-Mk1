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
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
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

  it('renders_sla_cell_with_provided_verdict_color', () => {
    const order = makeOrder({ order_id: '88001' })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={
          new Map<
            string,
            { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
          >()
        }
        activeAnalysisStates={[]}
        slaVerdict={{ color: 'green' }}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('green')
  })

  it('renders_sla_cell_loading_when_verdict_absent', () => {
    const order = makeOrder({ order_id: '88002' })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={
          new Map<
            string,
            { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
          >()
        }
        activeAnalysisStates={[]}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('loading')
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

// D1 — timing cell. OrderRow shows two stacked durations: "Order" (since the
// order was placed) and "Lab" (outstanding = time since the lab received a
// sample). Lab is intentionally uncolored (SLA color is D2) and reads
// "Awaiting sample" when nothing is received yet.
describe('OrderRow — timing cell (D1)', () => {
  it('shows "Awaiting sample" for outstanding when no sample is received', () => {
    const order = makeOrder({ sample_results: null })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={new Map()}
        activeAnalysisStates={[]}
      />
    )
    expect(screen.getByTestId('order-outstanding')).toHaveTextContent(
      'Awaiting sample'
    )
    // "Since order" value is still shown (created ~1h ago by default).
    expect(screen.getByTestId('order-time-since-order')).toBeInTheDocument()
  })

  it('shows time-since-received as the outstanding value, uncolored', () => {
    const order = makeOrderWithSamples([
      { senaite_id: 'P-1', status: 'created' },
    ])
    const map = new Map<
      string,
      { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
    >([
      [
        'P-1',
        {
          data: {
            date_received: new Date(
              Date.now() - (3 * 60 + 5) * 60_000
            ).toISOString(), // ~3h ago
            analyses: [],
            review_state: 'received',
          } as unknown as SenaiteLookupResult,
          isLoading: false,
          isError: false,
        },
      ],
    ])
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={map}
        activeAnalysisStates={[]}
      />
    )
    const outstanding = screen.getByTestId('order-outstanding')
    expect(outstanding).toHaveTextContent('3h')
    // Outstanding is deliberately uncolored (color/SLA is a later sub-project).
    expect(outstanding.className).toContain('text-muted-foreground')
    expect(outstanding.className).not.toMatch(/text-(green|yellow)-600/)
  })
})

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

// D2 follow-on — OrderRow forwards per-sample SLA snapshots (keyed by senaiteId)
// to each SampleCard so the in-row sample timer uses the real tier-resolved
// indicator instead of the legacy hardcoded 24/48h. Verifies prop plumbing by
// asserting the SampleSlaIndicator surfaces with the correct data-sla-color.
// Multi-tier reshape: map values are now arrays (one snapshot per service
// group); OrderRow forwards the first element to SampleCard until the
// multi-row indicator UI lands.
describe('OrderRow — sampleSlaStatusesMap plumbing (D2 follow-on)', () => {
  it('forwards the first snapshot to each SampleCard when sampleSlaStatusesMap is provided', async () => {
    const order = makeOrder({
      sample_results: {
        '1': { senaite_id: 'BW-0010', status: 'created' },
      } as ExplorerOrder['sample_results'],
    })
    const lookup: SenaiteLookupResult = {
      sample_id: 'BW-0010',
      sample_uid: 'uid-bw-0010',
      client: null,
      contact: null,
      sample_type: null,
      date_received: '2026-05-01T00:00:00Z',
      date_sampled: null,
      profiles: [],
      client_order_number: null,
      client_sample_id: null,
      client_lot: null,
      review_state: 'verified',
      declared_weight_mg: null,
      analytes: [],
      coa: {
        has_coa: false,
        file_count: 0,
        has_download_warnings: false,
      } as never,
      remarks: [],
      analyses: [],
      attachments: [],
      published_coa: null,
      senaite_url: null,
      cached_at: null,
    }
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={
          new Map([['BW-0010', { data: lookup, isLoading: false, isError: false }]])
        }
        activeAnalysisStates={[]}
        sampleSlaStatusesMap={
          new Map([
            [
              'BW-0010',
              [
                {
                  groupKey: 'no-group' as const,
                  color: 'red',
                  status: {
                    target_minutes: 1440,
                    elapsed_minutes: 2880,
                    remaining_minutes: -1440,
                    breached: true,
                  },
                  tier: {
                    id: 1,
                    name: 'Standard',
                    target_minutes: 1440,
                    business_hours_only: false,
                    is_default: true,
                    amber_threshold_percent: 20,
                    created_at: '2026-01-01T00:00:00',
                    updated_at: '2026-01-01T00:00:00',
                  },
                  reason: { tierSource: 'default', unmappedKeywords: [] },
                  priority: 'normal',
                },
              ],
            ],
          ])
        }
      />
    )
    const indicator = await screen.findByTestId('sample-sla-indicator')
    expect(indicator.getAttribute('data-sla-color')).toBe('red')
  })

  it('renders no indicator when sampleSlaStatusesMap is omitted (no legacy 24/48h timer)', async () => {
    const order = makeOrder({
      sample_results: {
        '1': { senaite_id: 'BW-0011', status: 'created' },
      } as ExplorerOrder['sample_results'],
    })
    const lookup: SenaiteLookupResult = {
      sample_id: 'BW-0011',
      sample_uid: 'uid-bw-0011',
      client: null,
      contact: null,
      sample_type: null,
      date_received: '2026-05-01T00:00:00Z',
      date_sampled: null,
      profiles: [],
      client_order_number: null,
      client_sample_id: null,
      client_lot: null,
      review_state: 'verified',
      declared_weight_mg: null,
      analytes: [],
      coa: {
        has_coa: false,
        file_count: 0,
        has_download_warnings: false,
      } as never,
      remarks: [],
      analyses: [],
      attachments: [],
      published_coa: null,
      senaite_url: null,
      cached_at: null,
    }
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp"
        sampleLookupMap={
          new Map([['BW-0011', { data: lookup, isLoading: false, isError: false }]])
        }
        activeAnalysisStates={[]}
      />
    )
    await screen.findByTestId('sample-card-BW-0011')
    expect(screen.queryByTestId('sample-sla-indicator')).toBeNull()
  })
})

// Lot pass-through — payload.samples[i].lot_code reaches the SampleCard lot
// row via the same positional alignment used for the analyte (key "1" →
// samples[0]). Payload-sourced, so it renders even while the SENAITE lookup
// is loading (empty sampleLookupMap ⇒ loading branch).
describe('OrderRow — lot pass-through', () => {
  const emptyMap = new Map<
    string,
    { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
  >()

  it('passes payload lot_code positionally to each SampleCard', () => {
    const order = makeOrder({
      sample_results: {
        '1': { senaite_id: 'P-0001', status: 'created' },
        '2': { senaite_id: 'P-0002', status: 'created' },
      },
      payload: {
        billing: { email: 'forrestp@outlook.com' },
        samples: [
          { sample_identity: 'BPC-157', lot_code: 'LOT-A100' },
          { sample_identity: 'GHRP-6', lot_code: 'LOT-B200' },
        ],
      },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={emptyMap}
        activeAnalysisStates={[]}
      />
    )
    expect(screen.getByTestId('sample-card-lot-P-0001')).toHaveTextContent(
      'Lot: LOT-A100'
    )
    expect(screen.getByTestId('sample-card-lot-P-0002')).toHaveTextContent(
      'Lot: LOT-B200'
    )
  })

  it('omits the lot row when the payload sample has no lot_code', () => {
    const order = makeOrder({
      sample_results: { '1': { senaite_id: 'P-0003', status: 'created' } },
      payload: {
        billing: { email: 'forrestp@outlook.com' },
        samples: [{ sample_identity: 'NAD+' }],
      },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={emptyMap}
        activeAnalysisStates={[]}
      />
    )
    expect(screen.queryByTestId('sample-card-lot-P-0003')).toBeNull()
  })

  it('renders the lot line on the failed-sample inline card', () => {
    const order = makeOrder({
      sample_results: { '1': { senaite_id: '', status: 'failed' } },
      payload: {
        billing: { email: 'forrestp@outlook.com' },
        samples: [{ sample_identity: 'BPC-157', lot_code: 'LOT-F500' }],
      },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={emptyMap}
        activeAnalysisStates={[]}
      />
    )
    // The lot line is composed of multiple inline elements (HighlightMatch
    // segments), so match on the row container's textContent via its title.
    expect(screen.getByTitle('LOT-F500')).toHaveTextContent('Lot: LOT-F500')
    expect(screen.getByText('Failed to create in SENAITE')).toBeInTheDocument()
  })
})
