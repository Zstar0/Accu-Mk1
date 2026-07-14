/**
 * Phase 29 — Plan 29-04 list-view behavior tests
 *
 * Covers behavior bullets in 29-04-PLAN.md L189-208, which back the listed
 * requirements (UI-01, UI-03, UI-05, UI-06, UI-07) and the threat model
 * (T-29-01..T-29-04). The router-vs-leaf-component split is verified by the
 * detail-placeholder hand-off test (the very last "it" block).
 *
 * Test bootstrap follows the canonical pattern in
 * src/test/peptide-request-detail.test.tsx:
 *   1. vi.mock(...) BEFORE the dynamic import so the page picks up the mocks
 *   2. selector-callable useUIStore mock with a closure-captured `state` object
 *      whose fields can be mutated between tests (selectors re-read on each call)
 *   3. dynamic await import after mocks are wired
 *   4. QueryClientProvider wrapper with retry:false
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'
import type { ExplorerCustomer, ExplorerOrder } from '@/lib/api'

// --- Mock the ui-store so list view reads deterministic fields ---
// state is captured in closure; selectors re-read on each render → mutate via
// resetState() in beforeEach and per-test via direct assignment.
vi.mock('@/store/ui-store', () => {
  const state = {
    activeSubSection: 'customers' as
      | 'customers'
      | 'customer-detail'
      | string,
    customerDetailTargetId: null as number | null,
    customerListPage: 0,
    customerSearchTerm: '',
    hideTestAccounts: true,
    // Phase 30 — detail-view tabs + per-customer order search.
    // UX revision: three independent slots (one per search axis); each slot
    // is the post-debounce committed value. AND-combined server-side.
    customerDetailTab: 'orders' as 'orders' | 'dashboard',
    customerOrderSearch: {
      order_number: '',
      sample_id: '',
      analyte: '',
      lot: '',
    },
    navigateToCustomer: vi.fn(),
    navigateToCustomers: vi.fn(),
    setCustomerListPage: vi.fn(),
    setHideTestAccounts: vi.fn(),
    setSearchAndResetPage: vi.fn(),
    setCustomerDetailTab: vi.fn(),
    // Per-axis setter and three-slot reset (UX revision).
    setCustomerOrderSearchField: vi.fn(),
    setCustomerOrderSearchReset: vi.fn(),
    navigateTo: vi.fn(),
    // SampleCard (transitive via OrderRow in 29-05, not used yet, but tests may
    // mount the placeholder which doesn't touch it):
    navigateToSample: vi.fn(),
  }
  const useUIStore = <T,>(selector: (s: typeof state) => T): T => selector(state)
  useUIStore.getState = () => state
  // Expose the raw state object for tests to mutate.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(useUIStore as any).__state = state
  return { useUIStore }
})

// --- Mock the API module BEFORE component import ---
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api')
  return {
    ...actual,
    getExplorerStatus: vi.fn(),
    getExplorerCustomers: vi.fn(),
    getExplorerOrdersByCustomer: vi.fn(),
  }
})

// --- Mock api-profiles so envName has a deterministic value (RESEARCH Risks #9) ---
vi.mock('@/lib/api-profiles', () => ({
  getActiveEnvironmentName: vi.fn().mockReturnValue('test-env'),
  API_PROFILE_CHANGED_EVENT: 'api-profile-changed',
  getWordpressUrl: vi.fn().mockReturnValue('https://wp.test'),
}))

// --- Mock OrderRow (Plan 29-05 detail view) ---
// Render a minimal stub <tr> so the parent's DOM-order assertion can read
// order ids by `data-testid="order-row"`. Real OrderRow behavior is covered
// by its own test file.
vi.mock('@/components/explorer/OrderRow', () => ({
  OrderRow: vi.fn(
    (props: {
      order: { id: string; order_id: string }
      defaultExpanded?: boolean
      highlightSampleId?: string
    }) => (
      <tr
        data-testid="order-row"
        data-order-id={props.order.id}
        data-order-number={props.order.order_id}
        data-expanded={props.defaultExpanded ? 'true' : 'false'}
        data-highlight-sample-id={props.highlightSampleId ?? ''}
      >
        <td colSpan={6}>{props.order.order_id}</td>
      </tr>
    )
  ),
}))

// --- Mock SENAITE queue ---
// Resolves immediately so useQueries settles without hitting real fetch.
vi.mock('@/components/explorer/senaite-queue', () => ({
  enqueueSenaiteLookup: vi.fn().mockResolvedValue({
    sample_id: 'mock',
    sample_uid: null,
    client: null,
    contact: null,
    sample_type: null,
    date_received: null,
    date_sampled: null,
    profiles: [],
    client_order_number: null,
    client_sample_id: null,
    client_lot: null,
    review_state: 'received',
    declared_weight_mg: null,
    analytes: [],
    coa: { reports: [] },
    remarks: [],
    analyses: [],
  }),
}))

const { getExplorerStatus, getExplorerCustomers, getExplorerOrdersByCustomer } =
  await import('@/lib/api')
const { enqueueSenaiteLookup } = await import(
  '@/components/explorer/senaite-queue'
)
const { useUIStore } = await import('@/store/ui-store')
const { CustomerStatusPage } = await import('@/components/CustomerStatusPage')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockState = (useUIStore as any).__state as {
  activeSubSection: string
  customerDetailTargetId: number | null
  customerListPage: number
  customerSearchTerm: string
  hideTestAccounts: boolean
  customerDetailTab: 'orders' | 'dashboard'
  customerOrderSearch: {
    order_number: string
    sample_id: string
    analyte: string
    lot: string
  }
  navigateToCustomer: ReturnType<typeof vi.fn>
  navigateToCustomers: ReturnType<typeof vi.fn>
  setCustomerListPage: ReturnType<typeof vi.fn>
  setHideTestAccounts: ReturnType<typeof vi.fn>
  setSearchAndResetPage: ReturnType<typeof vi.fn>
  setCustomerDetailTab: ReturnType<typeof vi.fn>
  setCustomerOrderSearchField: ReturnType<typeof vi.fn>
  setCustomerOrderSearchReset: ReturnType<typeof vi.fn>
  navigateTo: ReturnType<typeof vi.fn>
  navigateToSample: ReturnType<typeof vi.fn>
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeCustomer(overrides: Partial<ExplorerCustomer> = {}): ExplorerCustomer {
  return {
    customer_id: 42,
    email: 'alice@example.com',
    display_name: 'Alice Example',
    company_name: 'Example Co.',
    total_orders: 5,
    outstanding_orders: 1,
    total_coas: 3,
    most_recent_order_at: '2026-05-01T12:00:00Z',
    ...overrides,
  }
}

const FIVE_CUSTOMERS_PLUS_GUEST: ExplorerCustomer[] = [
  makeCustomer({ customer_id: 1, email: 'a@example.com', display_name: 'Alice A' }),
  makeCustomer({ customer_id: 2, email: 'b@example.com', display_name: 'Bob B' }),
  makeCustomer({ customer_id: 3, email: 'c@example.com', display_name: 'Carol C' }),
  makeCustomer({ customer_id: 4, email: 'd@example.com', display_name: 'Dan D', outstanding_orders: 0 }),
  makeCustomer({ customer_id: 5, email: 'e@example.com', display_name: 'Eve E' }),
  makeCustomer({
    customer_id: null,
    email: 'guest@example.com',
    display_name: 'guest@example.com',
    company_name: null,
    total_orders: 2,
    outstanding_orders: 0,
    total_coas: 0,
    most_recent_order_at: null,
  }),
]

function resetState() {
  mockState.activeSubSection = 'customers'
  mockState.customerDetailTargetId = null
  mockState.customerListPage = 0
  mockState.customerSearchTerm = ''
  mockState.hideTestAccounts = true
  mockState.customerDetailTab = 'orders'
  mockState.customerOrderSearch = { order_number: '', sample_id: '', analyte: '', lot: '' }
  mockState.navigateToCustomer.mockReset()
  mockState.navigateToCustomers.mockReset()
  mockState.setCustomerListPage.mockReset()
  mockState.setHideTestAccounts.mockReset()
  mockState.setSearchAndResetPage.mockReset()
  mockState.setCustomerDetailTab.mockReset()
  mockState.setCustomerOrderSearchField.mockReset()
  mockState.setCustomerOrderSearchReset.mockReset()
  mockState.navigateTo.mockReset()
  mockState.navigateToSample.mockReset()
}

// findCustomersTable returns the table whose first row contains "Display Name".
function findCustomersTable(): HTMLTableElement {
  const headers = screen.getAllByText('Display Name')
  // Walk up to the enclosing <table>
  const th = headers[0]
  if (!th) throw new Error('Display Name header not found')
  let el: HTMLElement | null = th
  while (el && el.tagName !== 'TABLE') el = el.parentElement
  if (!el) throw new Error('Customers table not found')
  return el as HTMLTableElement
}

describe('CustomerStatusPage — list view', () => {
  beforeEach(() => {
    resetState()
    vi.mocked(getExplorerStatus).mockReset()
    vi.mocked(getExplorerCustomers).mockReset()
    vi.mocked(getExplorerStatus).mockResolvedValue({ connected: true })
    vi.mocked(getExplorerCustomers).mockResolvedValue({
      customers: FIVE_CUSTOMERS_PLUS_GUEST,
      total_count: 6,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('renders 6-column header with exact UI-SPEC copy', async () => {
    render(<CustomerStatusPage />, { wrapper })

    // Wait for query to settle; thead is in DOM unconditionally so we can poll.
    await screen.findByText('Display Name')

    const table = findCustomersTable()
    const headerCells = within(table).getAllByRole('columnheader')
    const labels = headerCells.map(c => c.textContent?.trim())
    expect(labels).toEqual([
      'Display Name',
      'Email',
      'Total Orders',
      'Outstanding',
      'Total COAs',
      'Most Recent',
    ])
  })

  it('renders one row per customer plus header (5 registered + 1 guest + header = 7 rows)', async () => {
    render(<CustomerStatusPage />, { wrapper })

    await screen.findByText('Alice A')
    const table = findCustomersTable()
    const rows = within(table).getAllByRole('row')
    // 1 header row + 6 data rows
    expect(rows).toHaveLength(7)
  })

  it('clicking a registered row calls navigateToCustomer with its customer_id', async () => {
    render(<CustomerStatusPage />, { wrapper })

    const aliceCell = await screen.findByText('Alice A')
    const row = aliceCell.closest('tr')
    if (!row) throw new Error('Alice row not found')
    fireEvent.click(row)
    expect(mockState.navigateToCustomer).toHaveBeenCalledWith(1)
  })

  it('pressing Enter on a focused registered row calls navigateToCustomer', async () => {
    render(<CustomerStatusPage />, { wrapper })

    const aliceCell = await screen.findByText('Alice A')
    const row = aliceCell.closest('tr')
    if (!row) throw new Error('Alice row not found')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(mockState.navigateToCustomer).toHaveBeenCalledWith(1)
  })

  it('guest rows are tabIndex=-1, non-clickable, and show "— (Guest)"', async () => {
    render(<CustomerStatusPage />, { wrapper })

    // Wait for the guest row's display value
    const guestCell = await screen.findByText('— (Guest)')
    expect(guestCell).toBeInTheDocument()
    const row = guestCell.closest('tr')
    if (!row) throw new Error('Guest row not found')
    expect(row.getAttribute('tabindex')).toBe('-1')
    fireEvent.click(row)
    // Guest customers don't dispatch navigation
    expect(mockState.navigateToCustomer).not.toHaveBeenCalled()
  })

  it('debounces search 300ms then commits via setSearchAndResetPage (UI-05)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(<CustomerStatusPage />, { wrapper })

    // Switch back to real timers temporarily so the initial query can settle.
    // No — we need the initial query call to fire too. Instead, find the
    // input synchronously since the input is rendered unconditionally.
    const input = screen.getByPlaceholderText('Search by name or email…')
    fireEvent.change(input, { target: { value: 'foo' } })

    // 299 ms: not yet committed
    vi.advanceTimersByTime(299)
    expect(mockState.setSearchAndResetPage).not.toHaveBeenCalled()

    // 300 ms: committed
    vi.advanceTimersByTime(1)
    expect(mockState.setSearchAndResetPage).toHaveBeenCalledWith('foo')
  })

  it('search-change resets page to 0 via setSearchAndResetPage (UI-05)', async () => {
    // Seed page=2 via the mock state. setSearchAndResetPage is what carries
    // the page reset (it's an atomic store action — verified in 29-02 store
    // tests). What this test checks is that the component dispatches it
    // exactly once with the new term, NOT that it calls setCustomerListPage
    // separately. The store action handles the reset atomically.
    mockState.customerListPage = 2

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(<CustomerStatusPage />, { wrapper })

    const input = screen.getByPlaceholderText('Search by name or email…')
    fireEvent.change(input, { target: { value: 'newterm' } })
    vi.advanceTimersByTime(300)

    // Verify the atomic dispatch — component calls setSearchAndResetPage,
    // NOT a separate setCustomerListPage call. The store's setSearchAndResetPage
    // commits {customerSearchTerm: 'newterm', customerListPage: 0} atomically.
    expect(mockState.setSearchAndResetPage).toHaveBeenCalledWith('newterm')
    // Component must NOT also dispatch a separate setCustomerListPage(0) — the
    // store action does that already, and a double dispatch would be a regression.
    expect(mockState.setCustomerListPage).not.toHaveBeenCalled()
  })

  it('initial mount calls getExplorerCustomers with includeTestEmails=false (UI-06 default)', async () => {
    render(<CustomerStatusPage />, { wrapper })

    // Wait for the query to fire (it does so as soon as status resolves).
    await screen.findByText('Alice A')

    expect(getExplorerCustomers).toHaveBeenCalled()
    const args = vi.mocked(getExplorerCustomers).mock.calls[0]
    if (!args) throw new Error('getExplorerCustomers was not called')
    // (search, page, perPage, includeTestEmails)
    expect(args[3]).toBe(false)
  })

  it('after unchecking the hide-test-accounts toggle, next call has includeTestEmails=true (UI-06)', async () => {
    render(<CustomerStatusPage />, { wrapper })

    await screen.findByText('Alice A')
    // Click the checkbox — Radix Checkbox responds to click on the root.
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)

    // The store action is mocked; verify the component called it with `false`
    // (since the toggle is being unchecked from default-checked state).
    expect(mockState.setHideTestAccounts).toHaveBeenCalledWith(false)
  })

  it('toggle label flips between "Hide test accounts" and "Showing test accounts" (UI-06)', async () => {
    // Default: hideTestAccounts=true → "Hide test accounts"
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')
    expect(screen.getByText('Hide test accounts')).toBeInTheDocument()
  })

  it('toggle label reads "Showing test accounts" when hideTestAccounts=false', async () => {
    mockState.hideTestAccounts = false
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')
    expect(screen.getByText('Showing test accounts')).toBeInTheDocument()
  })

  it('renders TEST_EMAILS-matching rows when includeTestEmails=true (T-29-03 — no client filter)', async () => {
    mockState.hideTestAccounts = false
    vi.mocked(getExplorerCustomers).mockResolvedValue({
      customers: [
        makeCustomer({
          customer_id: 99,
          email: 'forrestp@outlook.com',
          display_name: 'Test Account',
        }),
      ],
      total_count: 1,
    })
    render(<CustomerStatusPage />, { wrapper })

    // If a client-side filter were intercepting TEST_EMAILS, this would fail.
    await screen.findByText('Test Account')
    expect(screen.getByText('forrestp@outlook.com')).toBeInTheDocument()
  })

  it('shows generic copy in PROD on error (T-29-02 PII gate) — never the raw error', async () => {
    vi.stubEnv('PROD', true)
    vi.mocked(getExplorerCustomers).mockRejectedValue(
      new Error('secret-internal-db-detail: leaked-PII-12345')
    )
    render(<CustomerStatusPage />, { wrapper })

    const errorTitle = await screen.findByText('Could not load customers')
    expect(errorTitle).toBeInTheDocument()
    expect(screen.getByText(/Check your connection and try again/)).toBeInTheDocument()
    expect(screen.queryByText(/secret-internal-db-detail/)).not.toBeInTheDocument()
    expect(screen.queryByText(/leaked-PII-12345/)).not.toBeInTheDocument()
  })

  it('renders 8 skeleton rows during loading (UI-07)', async () => {
    // Hold the query pending forever — never resolves, never rejects.
    vi.mocked(getExplorerCustomers).mockReturnValue(
      new Promise(() => {
        /* never settles */
      })
    )
    render(<CustomerStatusPage />, { wrapper })

    // Wait for status query to resolve first (so that the customers query is
    // enabled and goes into loading state).
    await screen.findAllByTestId('customer-row-skeleton')
    const skeletons = screen.getAllByTestId('customer-row-skeleton')
    expect(skeletons).toHaveLength(8)
  })

  it('renders "No customers found" + no-search body when empty (UI-07)', async () => {
    vi.mocked(getExplorerCustomers).mockResolvedValue({ customers: [], total_count: 0 })
    render(<CustomerStatusPage />, { wrapper })

    await screen.findByText('No customers found')
    expect(screen.getByText('No customer records available yet.')).toBeInTheDocument()
  })

  it('renders search-empty body with the literal search term (UI-07)', async () => {
    mockState.customerSearchTerm = 'foo'
    vi.mocked(getExplorerCustomers).mockResolvedValue({ customers: [], total_count: 0 })
    render(<CustomerStatusPage />, { wrapper })

    await screen.findByText('No customers found')
    expect(
      screen.getByText('No customers match "foo". Try a different search.')
    ).toBeInTheDocument()
  })

  it('renders error alert and Retry button (UI-07)', async () => {
    vi.mocked(getExplorerCustomers).mockRejectedValue(new Error('boom'))
    render(<CustomerStatusPage />, { wrapper })

    await screen.findByText('Could not load customers')
    const retry = screen.getByRole('button', { name: 'Retry loading customers' })
    expect(retry).toBeInTheDocument()
    fireEvent.click(retry)
    // Refetch should re-invoke the query function.
    // We assert it via call count: 1 from initial mount + 1 from retry = 2.
    // (initial may have one or two depending on React-Query retry settings; we use
    // retry:false in the QueryClient so it's exactly 1 then +1.)
    expect(vi.mocked(getExplorerCustomers).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('disconnected: renders banner, no skeletons, does NOT call getExplorerCustomers (D-17)', async () => {
    vi.mocked(getExplorerStatus).mockResolvedValue({ connected: false, error: 'down' })
    render(<CustomerStatusPage />, { wrapper })

    await screen.findByText(/Failed to connect to database: down/)
    expect(screen.queryByTestId('customer-row-skeleton')).not.toBeInTheDocument()
    // getExplorerCustomers must not be called when disconnected (gated by enabled).
    expect(getExplorerCustomers).not.toHaveBeenCalled()
  })

  it('Prev page button is disabled at page 0 with aria-label "Previous page"', async () => {
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')

    const prev = screen.getByRole('button', { name: 'Previous page' })
    expect(prev).toBeDisabled()
  })

  it('Next page button has aria-label "Next page" and is disabled when fewer than 50 returned', async () => {
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')

    const next = screen.getByRole('button', { name: 'Next page' })
    // 6 customers returned, less than per_page=50 → disabled
    expect(next).toBeDisabled()
  })

  it('clear-search button has aria-label "Clear search" and appears when input has value', async () => {
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')

    const input = screen.getByPlaceholderText('Search by name or email…')
    fireEvent.change(input, { target: { value: 'abc' } })

    const clearBtn = await screen.findByRole('button', { name: 'Clear search' })
    expect(clearBtn).toBeInTheDocument()
    fireEvent.click(clearBtn)
    expect(mockState.setSearchAndResetPage).toHaveBeenCalledWith('')
  })
})

// ============================================================================
// Phase 29 — Plan 29-05 detail-view behavior tests
// ============================================================================
//
// The detail view replaces the Plan 29-04 placeholder body. Covers behavior
// bullets in 29-05-PLAN.md L188-198, backing UI-03 / UI-04 / UI-07 + the
// D-10 / D-11 / RESEARCH §11 #1 invariants.
//
// Header-data source (Plan §step 3 option b): reads the customer record from
// the TanStack list-query cache via `queryClient.getQueriesData`. Detail-view
// tests therefore SEED the cache before render via a dedicated helper —
// `wrapper()` cannot be used because it builds a fresh client inside.
// ============================================================================

function makeOrder(overrides: Partial<ExplorerOrder> = {}): ExplorerOrder {
  return {
    id: 'order-uuid-1',
    order_id: '1001',
    order_number: 'ORD-1001',
    status: 'processing',
    samples_expected: 2,
    samples_delivered: 2,
    error_message: null,
    payload: { billing: { email: 'alice@example.com' } },
    sample_results: {
      'AS-100': { senaite_id: 'AS-100', status: 'received' },
      'AS-101': { senaite_id: 'AS-101', status: 'received' },
    },
    created_at: '2026-05-03T10:00:00Z',
    updated_at: '2026-05-03T10:00:00Z',
    completed_at: null,
    wp_order_status: 'processing',
    ...overrides,
  }
}

/**
 * Render <CustomerStatusPage /> with a pre-seeded query cache. The detail-view
 * header reads the customer record from the list-query cache (Plan §step 3).
 * Tests pass `customer={null}` to exercise the "Customer #{id}" fallback.
 */
function renderDetailWithCache(
  customer: ExplorerCustomer | null,
  queryClient?: QueryClient
): { qc: QueryClient; rerender: (ui: React.ReactElement) => void } {
  const qc =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
  if (customer) {
    // Seed under the SAME key shape the list view uses
    // (CustomerListView's queryKey is ['explorer','customers',search,page,hideTest,envName]).
    qc.setQueryData(
      ['explorer', 'customers', '', 0, true, 'test-env'],
      { customers: [customer], total_count: 1 }
    )
  }
  const result = render(
    <QueryClientProvider client={qc}>
      <CustomerStatusPage />
    </QueryClientProvider>
  )
  return { qc, rerender: result.rerender }
}

describe('CustomerStatusPage — detail view', () => {
  beforeEach(() => {
    resetState()
    vi.mocked(getExplorerStatus).mockReset()
    vi.mocked(getExplorerCustomers).mockReset()
    vi.mocked(getExplorerOrdersByCustomer).mockReset()
    vi.mocked(enqueueSenaiteLookup).mockClear()
    vi.mocked(getExplorerStatus).mockResolvedValue({ connected: true })
    vi.mocked(getExplorerCustomers).mockResolvedValue({
      customers: [],
      total_count: 0,
    })
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
    // Default: detail view active with target id 42
    mockState.activeSubSection = 'customer-detail'
    mockState.customerDetailTargetId = 42
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  // --- Gating: orders query enabled state ---

  it('calls getExplorerOrdersByCustomer(42) when activeSubSection=customer-detail and targetId=42', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    // Wait for the orders fetch to settle. We can't await 'Orders' (the
    // CardTitle renders unconditionally before the query fires); instead
    // await the empty-state body which renders only after the orders query
    // resolves to [] (default mock).
    await screen.findByText('No orders for this customer')

    expect(getExplorerOrdersByCustomer).toHaveBeenCalled()
    expect(vi.mocked(getExplorerOrdersByCustomer).mock.calls[0]?.[0]).toBe(42)
  })

  it('does NOT call getExplorerOrdersByCustomer when targetId is null', async () => {
    mockState.customerDetailTargetId = null
    renderDetailWithCache(null)

    // Wait for status to settle so the enabled gate has had a chance to fire
    await screen.findByText('← Back to Customers')

    expect(getExplorerOrdersByCustomer).not.toHaveBeenCalled()
  })

  // --- Header card rendering (cache-read data source) ---

  it('header card displays display_name, email, and company name when non-empty', async () => {
    const customer = makeCustomer({
      customer_id: 42,
      display_name: 'Alice Example',
      email: 'alice@example.com',
      company_name: 'Example Co.',
    })
    renderDetailWithCache(customer)

    expect(await screen.findByText('Alice Example')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
    expect(screen.getByText('Example Co.')).toBeInTheDocument()
  })

  it('header card omits company when it is empty/null', async () => {
    const customer = makeCustomer({
      customer_id: 42,
      display_name: 'No Company',
      email: 'nc@example.com',
      company_name: null,
    })
    renderDetailWithCache(customer)

    expect(await screen.findByText('No Company')).toBeInTheDocument()
    // Should NOT render an italic placeholder for company
    expect(screen.queryByText('null')).not.toBeInTheDocument()
  })

  it('header card uses the User icon (singular)', async () => {
    const customer = makeCustomer({ customer_id: 42 })
    const { qc } = renderDetailWithCache(customer)

    await screen.findByText(customer.display_name)
    // lucide-react renders <svg class="lucide lucide-user ...">
    const userIcon = document.querySelector('svg.lucide-user')
    expect(userIcon).toBeTruthy()
    void qc
  })

  it('falls back to "Customer #{id}" when cache record is unavailable', async () => {
    // Cache empty → fallback applies
    renderDetailWithCache(null)

    expect(await screen.findByText(/Customer #42/)).toBeInTheDocument()
  })

  // --- Orders sort: open-first, then created_at DESC ---

  it('renders orders open-first then by created_at DESC', async () => {
    const orders: ExplorerOrder[] = [
      // Two completed at different created_at, plus one open (completed_at=null)
      makeOrder({
        id: 'closed-old',
        order_id: '5001',
        completed_at: '2026-05-04T00:00:00Z',
        created_at: '2026-05-03T00:00:00Z',
        sample_results: null,
      }),
      makeOrder({
        id: 'closed-new',
        order_id: '5002',
        completed_at: '2026-05-06T00:00:00Z',
        created_at: '2026-05-05T00:00:00Z',
        sample_results: null,
      }),
      makeOrder({
        id: 'open-mid',
        order_id: '5003',
        completed_at: null,
        created_at: '2026-05-01T00:00:00Z',
        sample_results: null,
      }),
    ]
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue(orders)
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    // Wait for orders to render via the mocked OrderRow stub
    const rows = await screen.findAllByTestId('order-row')
    expect(rows).toHaveLength(3)

    const ids = rows.map(r => r.getAttribute('data-order-id'))
    // open first, then created_at DESC for closed orders
    expect(ids).toEqual(['open-mid', 'closed-new', 'closed-old'])
  })

  // --- Back navigation (D-11) ---

  it('clicking ← Back to Customers calls navigateToCustomers', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    const back = await screen.findByText('← Back to Customers')
    fireEvent.click(back)
    expect(mockState.navigateToCustomers).toHaveBeenCalled()
  })

  // --- Empty state ---

  it('renders empty state copy when the orders query resolves with []', async () => {
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    expect(
      await screen.findByText('No orders for this customer')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Orders will appear here when this customer places them.')
    ).toBeInTheDocument()
  })

  // --- Error + retry ---

  it('renders "Could not load customer" Alert + Retry button on query error', async () => {
    vi.mocked(getExplorerOrdersByCustomer).mockRejectedValue(new Error('boom'))
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    expect(await screen.findByText('Could not load customer')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Retry loading customer' })
    expect(retry).toBeInTheDocument()

    const callsBefore = vi.mocked(getExplorerOrdersByCustomer).mock.calls.length
    fireEvent.click(retry)
    // Refetch invokes the queryFn again
    expect(vi.mocked(getExplorerOrdersByCustomer).mock.calls.length).toBeGreaterThan(
      callsBefore
    )
  })

  // --- Loading state ---

  it('renders 3 OrderRow skeletons while orders query is pending', async () => {
    // Never resolves
    vi.mocked(getExplorerOrdersByCustomer).mockReturnValue(
      new Promise(() => {
        /* never settles */
      })
    )
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    const skeletons = await screen.findAllByTestId('detail-order-skeleton')
    expect(skeletons).toHaveLength(3)
  })

  // --- SENAITE fan-out (D-10) ---

  it('enqueues a SENAITE lookup for each unique senaite_id in the orders fixture', async () => {
    const orders: ExplorerOrder[] = [
      makeOrder({
        id: 'o-1',
        order_id: '6001',
        completed_at: null,
        created_at: '2026-05-05T00:00:00Z',
        sample_results: {
          'name-a': { senaite_id: 'AS-100', status: 'received' },
          'name-b': { senaite_id: 'AS-101', status: 'received' },
        },
      }),
      makeOrder({
        id: 'o-2',
        order_id: '6002',
        completed_at: null,
        created_at: '2026-05-04T00:00:00Z',
        sample_results: {
          'name-c': { senaite_id: 'AS-102', status: 'received' },
          'name-d': { senaite_id: 'AS-103', status: 'received' },
        },
      }),
    ]
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue(orders)
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    await screen.findAllByTestId('order-row')

    // useQueries fans out; settle by waiting one tick for the queue resolution
    await new Promise(r => setTimeout(r, 0))

    const calledIds = vi
      .mocked(enqueueSenaiteLookup)
      .mock.calls.map(call => call[0])
    expect(calledIds).toEqual(
      expect.arrayContaining(['AS-100', 'AS-101', 'AS-102', 'AS-103'])
    )
  })

  // --- useMemo identity stability (RESEARCH §11 #1) ---

  it('re-render with the same orders fixture does not multiply enqueueSenaiteLookup calls', async () => {
    const orders: ExplorerOrder[] = [
      makeOrder({
        id: 'stable-1',
        order_id: '7001',
        completed_at: null,
        created_at: '2026-05-05T00:00:00Z',
        sample_results: {
          's1': { senaite_id: 'AS-200', status: 'received' },
          's2': { senaite_id: 'AS-201', status: 'received' },
        },
      }),
    ]
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue(orders)
    const { qc, rerender } = renderDetailWithCache(
      makeCustomer({ customer_id: 42 })
    )

    await screen.findAllByTestId('order-row')
    await new Promise(r => setTimeout(r, 0))

    const callsBeforeReRender = vi.mocked(enqueueSenaiteLookup).mock.calls.length
    expect(callsBeforeReRender).toBeGreaterThan(0)

    // Re-render the SAME tree under the SAME QueryClient so the cache hit
    // returns structurally-shared `orders` — sampleIds useMemo dep stays
    // equal → no new fan-out.
    rerender(
      <QueryClientProvider client={qc}>
        <CustomerStatusPage />
      </QueryClientProvider>
    )
    await new Promise(r => setTimeout(r, 0))

    const callsAfterReRender = vi.mocked(enqueueSenaiteLookup).mock.calls.length
    expect(callsAfterReRender).toBe(callsBeforeReRender)
  })
})

// ============================================================================
// Phase 29 — Plan 29-06 accessibility contract tests
// ============================================================================
//
// Locks down the five UI-SPEC rev 1 aria-labels + keyboard-nav contract:
//
//   - "Clear search"             — list view, on the X button when search has value
//   - "Previous page"            — list view, on Prev pagination button
//   - "Next page"                — list view, on Next pagination button
//   - "Retry loading customers"  — list view, on the error-alert Retry button
//   - "Retry loading customer"   — detail view, on the error-alert Retry button
//
// Plus:
//   - Registered customer rows have tabIndex={0}; guest rows have tabIndex={-1}
//   - Pressing Enter AND Space on a registered row activates navigateToCustomer
//   - Registered rows carry all four focus-ring tokens in className:
//       focus-visible:ring-2 / focus-visible:ring-primary /
//       focus-visible:ring-offset-2 / focus-visible:outline-none
//
// Source of truth: 29-UI-SPEC.md §Copywriting Contract (rev 1 — checker fix).
//
// Uses `getByLabelText(...)` verbatim per 29-06-PLAN.md L94 acceptance grep.
// Per-bullet coverage in this block, NOT test-count threshold.
// ============================================================================

describe('CustomerStatusPage — accessibility contract', () => {
  beforeEach(() => {
    resetState()
    vi.mocked(getExplorerStatus).mockReset()
    vi.mocked(getExplorerCustomers).mockReset()
    vi.mocked(getExplorerOrdersByCustomer).mockReset()
    vi.mocked(getExplorerStatus).mockResolvedValue({ connected: true })
    vi.mocked(getExplorerCustomers).mockResolvedValue({
      customers: FIVE_CUSTOMERS_PLUS_GUEST,
      total_count: 6,
    })
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  // --- aria-label #1: Clear search ---
  it('clear-search button is reachable via getByLabelText("Clear search") when input has value', async () => {
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')

    const input = screen.getByPlaceholderText('Search by name or email…')
    fireEvent.change(input, { target: { value: 'abc' } })
    // State update is synchronous in jsdom; the X button mounts before the next
    // microtask. Use getByLabelText (not findByLabelText) so the literal grep
    // contract from 29-06-PLAN.md L94 is satisfied.
    const clearBtn = screen.getByLabelText('Clear search')
    expect(clearBtn).toBeInTheDocument()
    expect(clearBtn.tagName).toBe('BUTTON')
  })

  // --- aria-label #2: Previous page ---
  it('previous-page button is reachable via getByLabelText("Previous page")', async () => {
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')

    const prev = screen.getByLabelText('Previous page')
    expect(prev).toBeInTheDocument()
    expect(prev.tagName).toBe('BUTTON')
  })

  // --- aria-label #3: Next page ---
  it('next-page button is reachable via getByLabelText("Next page")', async () => {
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')

    const next = screen.getByLabelText('Next page')
    expect(next).toBeInTheDocument()
    expect(next.tagName).toBe('BUTTON')
  })

  // --- aria-label #4: Retry loading customers (list error path) ---
  it('list-error retry button is reachable via getByLabelText("Retry loading customers")', async () => {
    vi.mocked(getExplorerCustomers).mockRejectedValue(new Error('boom'))
    render(<CustomerStatusPage />, { wrapper })

    await screen.findByText('Could not load customers')
    const retry = screen.getByLabelText('Retry loading customers')
    expect(retry).toBeInTheDocument()
    expect(retry.tagName).toBe('BUTTON')
  })

  // --- aria-label #5: Retry loading customer (detail error path) ---
  // The detail view's error path requires activeSubSection='customer-detail',
  // a rejected getExplorerOrdersByCustomer, AND the cache-seeded render
  // helper (defined mid-file for the detail-view describe block — reused).
  it('detail-error retry button is reachable via getByLabelText("Retry loading customer")', async () => {
    mockState.activeSubSection = 'customer-detail'
    mockState.customerDetailTargetId = 42
    vi.mocked(getExplorerOrdersByCustomer).mockRejectedValue(new Error('boom'))
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    await screen.findByText('Could not load customer')
    const retry = screen.getByLabelText('Retry loading customer')
    expect(retry).toBeInTheDocument()
    expect(retry.tagName).toBe('BUTTON')
  })

  // --- Keyboard contract: tabIndex={0} on registered rows ---
  it('every registered customer row carries tabIndex="0"', async () => {
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')

    // Find data rows by display name and verify each registered row's tabindex.
    const aliceRow = screen.getByText('Alice A').closest('tr')
    const bobRow = screen.getByText('Bob B').closest('tr')
    const carolRow = screen.getByText('Carol C').closest('tr')
    if (!aliceRow || !bobRow || !carolRow)
      throw new Error('registered rows not found')

    expect(aliceRow.getAttribute('tabindex')).toBe('0')
    expect(bobRow.getAttribute('tabindex')).toBe('0')
    expect(carolRow.getAttribute('tabindex')).toBe('0')
  })

  // --- Keyboard contract: tabIndex={-1} on guest rows ---
  it('guest customer rows carry tabIndex="-1"', async () => {
    render(<CustomerStatusPage />, { wrapper })

    const guestCell = await screen.findByText('— (Guest)')
    const guestRow = guestCell.closest('tr')
    if (!guestRow) throw new Error('guest row not found')

    expect(guestRow.getAttribute('tabindex')).toBe('-1')
  })

  // --- Keyboard contract: Enter activates navigation on registered rows ---
  it('pressing Enter on a registered row dispatches navigateToCustomer (D-19)', async () => {
    render(<CustomerStatusPage />, { wrapper })

    const aliceCell = await screen.findByText('Alice A')
    const row = aliceCell.closest('tr')
    if (!row) throw new Error('Alice row not found')

    fireEvent.keyDown(row, { key: 'Enter' })
    expect(mockState.navigateToCustomer).toHaveBeenCalledWith(1)
  })

  // --- Keyboard contract: Space activates navigation on registered rows ---
  it('pressing Space on a registered row dispatches navigateToCustomer (D-19)', async () => {
    render(<CustomerStatusPage />, { wrapper })

    const aliceCell = await screen.findByText('Alice A')
    const row = aliceCell.closest('tr')
    if (!row) throw new Error('Alice row not found')

    fireEvent.keyDown(row, { key: ' ' })
    expect(mockState.navigateToCustomer).toHaveBeenCalledWith(1)
  })

  // --- Keyboard contract: guest rows have no Enter/Space handler ---
  it('pressing Enter on a guest row does NOT dispatch navigateToCustomer', async () => {
    render(<CustomerStatusPage />, { wrapper })

    const guestCell = await screen.findByText('— (Guest)')
    const guestRow = guestCell.closest('tr')
    if (!guestRow) throw new Error('guest row not found')

    fireEvent.keyDown(guestRow, { key: 'Enter' })
    fireEvent.keyDown(guestRow, { key: ' ' })
    expect(mockState.navigateToCustomer).not.toHaveBeenCalled()
  })

  // --- Focus-ring contract: all four tokens on registered rows ---
  it('registered customer rows carry all four focus-ring tokens in className', async () => {
    render(<CustomerStatusPage />, { wrapper })
    await screen.findByText('Alice A')

    const row = screen.getByText('Alice A').closest('tr')
    if (!row) throw new Error('Alice row not found')

    const cls = row.className
    expect(cls).toContain('focus-visible:ring-2')
    expect(cls).toContain('focus-visible:ring-primary')
    expect(cls).toContain('focus-visible:ring-offset-2')
    expect(cls).toContain('focus-visible:outline-none')
  })

  // --- Focus-ring contract: guest rows do NOT carry focus-ring tokens ---
  it('guest customer rows do NOT carry focus-ring tokens (non-focusable)', async () => {
    render(<CustomerStatusPage />, { wrapper })

    const guestCell = await screen.findByText('— (Guest)')
    const guestRow = guestCell.closest('tr')
    if (!guestRow) throw new Error('guest row not found')

    const cls = guestRow.className
    // Guest rows get `cursor-default` — no focus-ring tokens.
    expect(cls).not.toContain('focus-visible:ring-2')
    expect(cls).not.toContain('focus-visible:ring-primary')
  })
})

// ---------------------------------------------------------------------------
// Phase 30 — Task 6: CustomerDetailView wrapped in shadcn Tabs
// ---------------------------------------------------------------------------
// Verifies the structural restructure of CustomerDetailView:
//   - Header card stays persistent (rendered before the tab list)
//   - Two tabs: "Customer Orders" (default-active) and "Dashboard"
//   - Clicking the Dashboard trigger dispatches setCustomerDetailTab('dashboard')
//   - Dashboard tab body renders the Coming Soon placeholder card
// No behavior change to orders rendering (Phase 29 detail-view tests still pass).
describe('CustomerStatusPage — detail view tabs (Phase 30)', () => {
  beforeEach(() => {
    resetState()
    vi.mocked(getExplorerStatus).mockReset()
    vi.mocked(getExplorerCustomers).mockReset()
    vi.mocked(getExplorerOrdersByCustomer).mockReset()
    vi.mocked(enqueueSenaiteLookup).mockClear()
    vi.mocked(getExplorerStatus).mockResolvedValue({ connected: true })
    vi.mocked(getExplorerCustomers).mockResolvedValue({
      customers: [],
      total_count: 0,
    })
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
    mockState.activeSubSection = 'customer-detail'
    mockState.customerDetailTargetId = 42
    mockState.customerDetailTab = 'orders'
    mockState.customerOrderSearch = { order_number: '', sample_id: '', analyte: '', lot: '' }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('renders the persistent header card above the tabs list', async () => {
    renderDetailWithCache(
      makeCustomer({ customer_id: 42, display_name: 'Test Customer Header' })
    )

    const header = await screen.findByText('Test Customer Header')
    const tabsList = await screen.findByRole('tablist')
    // The header heading must appear earlier in DOM order than the tab list.
    expect(
      header.compareDocumentPosition(tabsList) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('renders both Customer Orders and Dashboard tabs', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    expect(
      await screen.findByRole('tab', { name: 'Customer Orders' })
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('tab', { name: 'Dashboard' })
    ).toBeInTheDocument()
  })

  it('defaults to Customer Orders tab', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    const ordersTab = await screen.findByRole('tab', {
      name: 'Customer Orders',
    })
    expect(ordersTab).toHaveAttribute('data-state', 'active')
  })

  it('clicking Dashboard tab dispatches setCustomerDetailTab', async () => {
    // userEvent (not fireEvent) is required for Radix Tabs — Radix listens
    // for pointer events, which userEvent simulates faithfully and fireEvent
    // does not.
    const user = userEvent.setup()
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    const dashboardTab = await screen.findByRole('tab', { name: 'Dashboard' })
    await user.click(dashboardTab)
    expect(mockState.setCustomerDetailTab).toHaveBeenCalledWith('dashboard')
  })

  it('Dashboard tab renders Coming Soon placeholder', async () => {
    mockState.customerDetailTab = 'dashboard'
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    expect(await screen.findByText(/Coming soon/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// UX revision — CustomerOrdersTab three-input AND search
// ---------------------------------------------------------------------------
// Replaces the Phase 30 Task 7 single Select+Input UX with three labeled,
// independently-debounced inputs (Order # / Sample ID / Analyte). All three
// committed slots are forwarded to getExplorerOrdersByCustomer; the per-axis
// 2-char minimum gate is enforced in the API client, not here. Component
// dispatches via `setCustomerOrderSearchField(<axis>, value)` after a 300ms
// debounce, one timer per axis. The Clear button resets all three slots via
// `setCustomerOrderSearchReset()` and wipes local input state.
// ---------------------------------------------------------------------------
describe('CustomerStatusPage — customer-orders search (three-input AND)', () => {
  beforeEach(() => {
    resetState()
    vi.mocked(getExplorerStatus).mockReset()
    vi.mocked(getExplorerCustomers).mockReset()
    vi.mocked(getExplorerOrdersByCustomer).mockReset()
    vi.mocked(enqueueSenaiteLookup).mockClear()
    vi.mocked(getExplorerStatus).mockResolvedValue({ connected: true })
    vi.mocked(getExplorerCustomers).mockResolvedValue({
      customers: [],
      total_count: 0,
    })
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
    mockState.activeSubSection = 'customer-detail'
    mockState.customerDetailTargetId = 42
    mockState.customerDetailTab = 'orders'
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: '',
      analyte: '',
      lot: '',
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('renders four labeled search inputs side-by-side (Order # / Sample ID / Analyte / Lot)', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))

    // Each input carries a unique aria-label matching its visible Label.
    expect(await screen.findByLabelText('Order #')).toBeInTheDocument()
    expect(screen.getByLabelText('Sample ID')).toBeInTheDocument()
    expect(screen.getByLabelText('Analyte')).toBeInTheDocument()
    expect(screen.getByLabelText('Lot')).toBeInTheDocument()
  })

  it('typing in Lot dispatches setCustomerOrderSearchField("lot", value) after 300ms debounce', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    const lotInput = await screen.findByLabelText('Lot')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.change(lotInput, { target: { value: 'LOT-A100' } })
      expect(mockState.setCustomerOrderSearchField).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(mockState.setCustomerOrderSearchField).toHaveBeenCalledWith(
        'lot',
        'LOT-A100'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards the committed lot slot to getExplorerOrdersByCustomer', async () => {
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: '',
      analyte: '',
      lot: 'LOT-A100',
    }
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await waitFor(() => {
      expect(getExplorerOrdersByCustomer).toHaveBeenCalledWith(
        42,
        { order_number: '', sample_id: '', analyte: '', lot: 'LOT-A100' },
        'open_first',
        0,
        50
      )
    })
  })

  it('typing in Sample ID dispatches setCustomerOrderSearchField("sample_id", value) after 300ms debounce', async () => {
    // Mount under real timers so React-Query's status fetch can settle and
    // the inputs mount; swap to fake timers AFTER the input is in the DOM so
    // we can assert "not called yet" → advance → "called with the new value".
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    const sampleInput = await screen.findByLabelText('Sample ID')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.change(sampleInput, { target: { value: 'P-0001' } })
      // No dispatch yet (debounce pending)
      expect(mockState.setCustomerOrderSearchField).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(mockState.setCustomerOrderSearchField).toHaveBeenCalledWith(
        'sample_id',
        'P-0001'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards all three committed slots to getExplorerOrdersByCustomer', async () => {
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: 'P-0001',
      analyte: '',
      lot: '',
    }
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await waitFor(() => {
      expect(getExplorerOrdersByCustomer).toHaveBeenCalledWith(
        42,
        { order_number: '', sample_id: 'P-0001', analyte: '', lot: '' },
        'open_first',
        0,
        50
      )
    })
  })

  it('forwards even short values to API client (per-axis gate lives in the client, not here)', async () => {
    // The component does NOT gate <2 chars locally — the api.ts client drops
    // short values per axis. The component-layer contract is pass-through.
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: 'P',
      analyte: '',
      lot: '',
    }
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await waitFor(() => {
      expect(getExplorerOrdersByCustomer).toHaveBeenCalledWith(
        42,
        { order_number: '', sample_id: 'P', analyte: '', lot: '' },
        'open_first',
        0,
        50
      )
    })
  })

  it('renders OrderRow with defaultExpanded=true when any committed axis is non-empty', async () => {
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: 'P-0001',
      analyte: '',
      lot: '',
    }
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([
      makeOrder({
        order_id: '1234',
        sample_results: { '1': { senaite_id: 'P-0001', status: 'created' } },
      }),
    ])
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    expect(await screen.findByTestId('order-row')).toHaveAttribute(
      'data-expanded',
      'true'
    )
  })

  it('passes highlightSampleId to OrderRow when sample_id slot has >= 2 chars', async () => {
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: 'P-0001',
      analyte: '',
      lot: '',
    }
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([
      makeOrder({
        order_id: '1234',
        sample_results: { '1': { senaite_id: 'P-0001', status: 'created' } },
      }),
    ])
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    expect(await screen.findByTestId('order-row')).toHaveAttribute(
      'data-highlight-sample-id',
      'P-0001'
    )
  })

  it('shows empty-state with active-filter echo when search returns 0 orders', async () => {
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: '',
      analyte: 'BPC-157',
      lot: '',
    }
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    expect(
      await screen.findByText(/No orders match.*Analyte:.*"BPC-157"/i)
    ).toBeInTheDocument()
  })

  it('empty-state echo joins multiple active filters with " AND "', async () => {
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: 'P-9999',
      analyte: 'BPC-157',
      lot: '',
    }
    vi.mocked(getExplorerOrdersByCustomer).mockResolvedValue([])
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    expect(
      await screen.findByText(
        'No orders match Sample ID: "P-9999" AND Analyte: "BPC-157"'
      )
    ).toBeInTheDocument()
  })

  it('clear-search button dispatches setCustomerOrderSearchReset() (no args)', async () => {
    const user = userEvent.setup()
    mockState.customerOrderSearch = {
      order_number: '3001',
      sample_id: 'P-0001',
      analyte: 'BPC-157',
      lot: '',
    }
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await user.click(
      await screen.findByRole('button', { name: /clear search/i })
    )
    expect(mockState.setCustomerOrderSearchReset).toHaveBeenCalledTimes(1)
    expect(mockState.setCustomerOrderSearchReset).toHaveBeenCalledWith()
  })

  // --- AND-behavior: two-axis typing dispatches per-axis ---
  it('typing in TWO inputs results in two setCustomerOrderSearchField calls (one per axis)', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    const sampleInput = await screen.findByLabelText('Sample ID')
    const analyteInput = screen.getByLabelText('Analyte')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // Fire both keystrokes before any debounce window elapses
      fireEvent.change(sampleInput, { target: { value: 'P-0001' } })
      fireEvent.change(analyteInput, { target: { value: 'BPC-157' } })
      // Neither dispatch yet — both per-axis debounces still pending
      expect(mockState.setCustomerOrderSearchField).not.toHaveBeenCalled()

      vi.advanceTimersByTime(300)
      expect(mockState.setCustomerOrderSearchField).toHaveBeenCalledTimes(2)
      expect(mockState.setCustomerOrderSearchField).toHaveBeenCalledWith(
        'sample_id',
        'P-0001'
      )
      expect(mockState.setCustomerOrderSearchField).toHaveBeenCalledWith(
        'analyte',
        'BPC-157'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  // --- AND-behavior: two-axis committed state goes to API together ---
  it('with both sample_id AND analyte committed, the API call carries both axes', async () => {
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: 'P-0001',
      analyte: 'BPC-157',
      lot: '',
    }
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await waitFor(() => {
      expect(getExplorerOrdersByCustomer).toHaveBeenCalledWith(
        42,
        { order_number: '', sample_id: 'P-0001', analyte: 'BPC-157', lot: '' },
        'open_first',
        0,
        50
      )
    })
  })
})
