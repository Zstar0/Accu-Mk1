import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { RetestOptions, RetestOrder } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    getRetestOptions: vi.fn(),
    createRetest: vi.fn(),
    createAddonOrder: vi.fn(),
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { toast } from 'sonner'
import { createAddonOrder, createRetest, getRetestOptions } from '@/lib/api'
import { RetestDialog } from '@/components/senaite/RetestDialog'

const HPLC = 'hplc-purity-identity'
const HM = 'heavy_metals'
const ENDO = 'endotoxin-usp85-lal'

const CONTEXT: NonNullable<RetestOptions['context']> = {
  order: {
    number: 'WP-3134',
    placed_at: '2026-09-20T10:00:00Z',
    customer_name: 'Jane Doe',
    customer_email: 'jane@example.com',
    total: 285,
    currency: 'USD',
    status: 'completed',
    lines: [{ key: 'hplc', label: 'HPLC Purity + Identity', price: 85 }],
  },
  retest_fee: { price: 85 },
  pending_orders: [],
}

const PAY_URL = 'https://accumarklabs.com/checkout/order-pay/3278'
const ORDERS: [RetestOrder, RetestOrder] = [
  {
    order_id: 3278,
    order_number: '3278',
    status: 'pending',
    total: 230,
    currency: 'USD',
    created_at: '2026-09-28T10:00:00Z',
    paid_at: null,
    payment_url: PAY_URL,
    kind: 'addon',
    sample_id: null,
    sample_status: null,
  },
  {
    order_id: 3277,
    order_number: '3277',
    status: 'processing',
    total: 85,
    currency: 'USD',
    created_at: '2026-09-27T10:00:00Z',
    paid_at: '2026-09-27T11:00:00Z',
    payment_url: null,
    kind: 'retest',
    sample_id: 'P-9002',
    sample_status: 'received',
  },
]

const OPTIONS: RetestOptions = {
  sample_id: 'P-9001',
  status: 'published',
  order_number: 'WP-3134',
  profiles: [
    {
      key: HPLC,
      name: 'HPLC Purity + Identity',
      carry_eligible: true,
      state: 'published',
      verified_at: '2026-09-20T10:00:00Z',
      state_label: 'Verified 9/20',
    },
    {
      key: HM,
      name: 'Heavy Metals',
      carry_eligible: true,
      state: 'published',
      verified_at: '2026-09-20T10:00:00Z',
      state_label: 'Verified 9/20',
    },
    {
      key: ENDO,
      name: 'Endotoxin USP85 LAL',
      carry_eligible: false,
      state: 'parent_to_verify',
      verified_at: null,
      state_label: 'Not verified',
    },
  ],
  addons: [
    {
      key: 'rapid-sterility-pcr',
      name: 'Rapid Sterility (PCR)',
      wp_type: 'sterility_pcr',
      price: 230,
      vials: 1,
      sellable: true,
    },
    {
      key: 'mystery',
      name: 'Mystery Assay',
      wp_type: null,
      price: null,
      vials: 0,
      sellable: false,
    },
  ],
  variance: { point_price: 76.5, allowed: true },
  prices_available: true,
  context: CONTEXT,
}

function dialogTree(open: boolean, onClose = vi.fn(), onCreated = vi.fn()) {
  return (
    <RetestDialog
      open={open}
      sampleId="P-9001"
      onClose={onClose}
      onCreated={onCreated}
    />
  )
}

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  const onCreated = vi.fn()
  const utils = render(
    <QueryClientProvider client={qc}>
      {dialogTree(true, onClose, onCreated)}
    </QueryClientProvider>
  )
  const rerenderOpen = (open: boolean) =>
    utils.rerender(
      <QueryClientProvider client={qc}>
        {dialogTree(open, onClose, onCreated)}
      </QueryClientProvider>
    )
  return { onClose, onCreated, rerenderOpen, user: userEvent.setup() }
}

const row = (key: string) => screen.getByTestId(`retest-row-${key}`)
const retestBox = (key: string) =>
  within(row(key)).getByRole('checkbox', { name: /^Re-test / })
const carryBox = (key: string) =>
  within(row(key)).getByRole('checkbox', { name: /^Carry results / })
const total = () => screen.getByTestId('retest-summary-total')
const disabledReason = () => screen.queryByTestId('retest-disabled-reason')

beforeEach(() => {
  vi.mocked(getRetestOptions).mockResolvedValue(OPTIONS)
  vi.mocked(createRetest).mockReset()
  vi.mocked(createAddonOrder).mockReset()
})

describe('RetestDialog overlay v2', () => {
  it('switches tabs with fixed titles; Billing on both tabs, variance only on Re-test', async () => {
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    expect(
      screen.getByRole('heading', { name: 'Re-test P-9001' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: 'Billing' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Charged')).toBeChecked()
    expect(screen.getByLabelText('Waived (whole order free)')).not.toBeChecked()

    await user.click(screen.getByRole('tab', { name: 'Add services' }))
    expect(
      screen.getByRole('heading', { name: 'Add services to P-9001' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: 'Billing' })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Variance')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Add-ons are billed at the listed price unless Billing is Waived. Existing results are carried to the new sample.'
      )
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Orders' }))
    expect(
      screen.queryByRole('radiogroup', { name: 'Billing' })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Re-test' }))
    expect(
      screen.getByRole('heading', { name: 'Re-test P-9001' })
    ).toBeInTheDocument()
  })

  it('defaults Carry on verified rows, disables it on unverified ones, and keeps Re-test and Carry exclusive', async () => {
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    expect(carryBox(HPLC)).toBeChecked()
    expect(carryBox(HM)).toBeChecked()
    expect(retestBox(HM)).not.toBeChecked()
    expect(carryBox(ENDO)).toBeDisabled()
    expect(carryBox(ENDO)).not.toBeChecked()
    expect(
      within(row(ENDO)).getByText('cannot carry: not verified')
    ).toBeInTheDocument()
    expect(within(row(ENDO)).getByText('Not verified')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Rows not re-tested are carried as verified results linked to this sample. Untick Carry to leave a result off the new sample.'
      )
    ).toBeInTheDocument()

    await user.click(retestBox(HM))
    expect(retestBox(HM)).toBeChecked()
    expect(carryBox(HM)).not.toBeChecked()
    await user.click(carryBox(HM))
    expect(carryBox(HM)).toBeChecked()
    expect(retestBox(HM)).not.toBeChecked()
  })

  it('Re-test tab: unticked Carry becomes drop, add.profiles stays empty', async () => {
    vi.mocked(createRetest).mockResolvedValue({ order_number: 'WP-7920' })
    const { user, onClose } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    expect(disabledReason()).toHaveTextContent('Tick at least one Re-test')

    await user.click(retestBox(HPLC))
    await user.click(carryBox(HM))
    const outcome = screen.getByTestId('retest-outcome')
    expect(outcome).toHaveTextContent(
      'Creates a WooCommerce retest order for Jane Doe against order WP-3134 ($85.00).'
    )
    expect(outcome).toHaveTextContent(
      'Once paid: a new sample is created with HPLC Purity + Identity re-tested; Heavy Metals, Endotoxin USP85 LAL dropped.'
    )
    expect(outcome).toHaveTextContent(
      'P-9001 is unchanged and stays linked to the new sample.'
    )
    expect(outcome).toHaveTextContent(
      'The customer is emailed an invoice with the payment link.'
    )
    expect(disabledReason()).toHaveTextContent('Enter a reason')
    await user.type(screen.getByLabelText('Reason (required)'), 'purity re-run')
    expect(disabledReason()).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Create retest order' })
    )
    await waitFor(() =>
      expect(createRetest).toHaveBeenCalledWith('P-9001', {
        retest: [HPLC],
        carry: [],
        drop: [HM, ENDO],
        add: { profiles: [], variance_points: 0, additional_vials: 0 },
        auto_checkin: false,
        fee: 'paid',
        reason: 'purity re-run',
      })
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('itemises the retest fee and variance (points minus one) and totals them', async () => {
    vi.mocked(createRetest).mockResolvedValue({ order_number: 'WP-7920' })
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    const variance = screen.getByLabelText('Variance')
    expect(variance).toBeDisabled()
    expect(screen.getByText('Requires an HPLC re-test')).toBeInTheDocument()

    await user.click(retestBox(HPLC))
    expect(variance).toBeEnabled()
    expect(
      screen.queryByText('Requires an HPLC re-test')
    ).not.toBeInTheDocument()
    await user.click(variance)

    const summary = screen.getByTestId('retest-summary')
    expect(
      within(summary).getByText('Retest fee (HPLC Purity + Identity)')
    ).toBeInTheDocument()
    expect(within(summary).getByText('$85.00')).toBeInTheDocument()
    expect(within(summary).getByText('Variance, 3 points')).toBeInTheDocument()
    expect(screen.getByTestId('retest-outcome')).toHaveTextContent(
      'Once paid: a new sample is created with HPLC Purity + Identity re-tested (variance, 3 points); Heavy Metals carried as verified results; Endotoxin USP85 LAL dropped.'
    )
    expect(within(summary).getByText('$153.00')).toBeInTheDocument()
    expect(total()).toHaveTextContent('$238.00')
    expect(screen.getByLabelText('Charged')).toBeChecked()

    await user.click(screen.getByLabelText('Waived (whole order free)'))
    expect(
      within(summary).getByText('$0.00 (waived $85.00)')
    ).toBeInTheDocument()
    expect(
      within(summary).getByText('$0.00 (waived $153.00)')
    ).toBeInTheDocument()
    expect(total()).toHaveTextContent('Total$0.00 (waived)')

    await user.type(screen.getByLabelText('Reason (required)'), 'variance')
    await user.click(
      screen.getByRole('button', { name: 'Create retest order' })
    )
    await waitFor(() =>
      expect(createRetest).toHaveBeenCalledWith(
        'P-9001',
        expect.objectContaining({
          fee: 'free',
          add: { profiles: [], variance_points: 3, additional_vials: 0 },
        })
      )
    )
  })

  it('hides the variance row when the sample has no HPLC profile', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      profiles: OPTIONS.profiles.filter(p => p.key !== HPLC),
    })
    renderDialog()
    await screen.findByTestId(`retest-row-${HM}`)
    expect(screen.queryByLabelText('Variance')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Requires an HPLC re-test')
    ).not.toBeInTheDocument()
  })

  it('blocks Create with "Pricing unavailable" when the fee price is unknown, until Billing is Waived', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: { ...CONTEXT, retest_fee: { price: null } },
    })
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(retestBox(HPLC))
    await user.type(screen.getByLabelText('Reason (required)'), 'x')
    expect(total()).toHaveTextContent('Total: price unavailable')
    expect(disabledReason()).toHaveTextContent('Pricing unavailable')
    expect(
      screen.getByRole('button', { name: 'Create retest order' })
    ).toBeDisabled()
    await user.click(screen.getByLabelText('Waived (whole order free)'))
    expect(total()).toHaveTextContent('Total$0.00 (waived)')
    expect(disabledReason()).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create retest order' })
    ).toBeEnabled()
  })

  it('Add services tab: Waived sends fee "free" and zeroes every line, extra vials included', async () => {
    vi.mocked(createRetest).mockResolvedValue({ order_number: 'WP-7930' })
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(screen.getByRole('tab', { name: 'Add services' }))
    await user.click(
      screen.getByRole('checkbox', { name: 'Rapid Sterility (PCR)' })
    )
    await user.click(screen.getByRole('button', { name: 'More options' }))
    await user.clear(screen.getByLabelText('Extra vials to ship'))
    await user.type(screen.getByLabelText('Extra vials to ship'), '1')
    await user.click(screen.getByLabelText('Waived (whole order free)'))

    const summary = screen.getByTestId('retest-summary')
    expect(
      within(summary).getByText('$0.00 (waived $230.00)')
    ).toBeInTheDocument()
    // Extra vials line and the Total both read $0.00 (waived).
    expect(within(summary).getAllByText('$0.00 (waived)')).toHaveLength(2)
    expect(total()).toHaveTextContent('Total$0.00 (waived)')

    await user.type(screen.getByLabelText('Reason (required)'), 'goodwill')
    await user.click(
      screen.getByRole('button', { name: 'Create add-on order (new sample)' })
    )
    await waitFor(() =>
      expect(createRetest).toHaveBeenCalledWith(
        'P-9001',
        expect.objectContaining({
          retest: [],
          fee: 'free',
          add: {
            profiles: ['rapid-sterility-pcr'],
            variance_points: 0,
            additional_vials: 1,
          },
        })
      )
    )
  })

  it('Add services tab: Waived with a price unavailable still enables Create once a service is ticked', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      addons: OPTIONS.addons.map(a => ({ ...a, price: null })),
      prices_available: false,
    })
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(screen.getByRole('tab', { name: 'Add services' }))
    await user.type(screen.getByLabelText('Reason (required)'), 'x')
    await user.click(screen.getByLabelText('Waived (whole order free)'))
    expect(disabledReason()).toHaveTextContent('Tick at least one service')
    await user.click(
      screen.getByRole('checkbox', { name: 'Rapid Sterility (PCR)' })
    )
    expect(disabledReason()).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create add-on order (new sample)' })
    ).toBeEnabled()

    await user.click(screen.getByLabelText('Charged'))
    expect(disabledReason()).toHaveTextContent('Pricing unavailable')
    expect(
      screen.getByRole('button', { name: 'Create add-on order (new sample)' })
    ).toBeDisabled()
  })

  it('Add services tab: retest is empty, carry is every eligible profile, ineligible ones drop', async () => {
    vi.mocked(createRetest).mockResolvedValue({ order_number: 'WP-7921' })
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(screen.getByRole('tab', { name: 'Add services' }))
    expect(disabledReason()).toHaveTextContent('Tick at least one service')

    const mystery = screen.getByTestId('addon-row-mystery')
    expect(within(mystery).getByRole('checkbox')).toBeDisabled()
    expect(within(mystery).getByText('not sold post-order')).toBeInTheDocument()

    await user.click(
      screen.getByRole('checkbox', { name: 'Rapid Sterility (PCR)' })
    )
    expect(total()).toHaveTextContent('$230.00')
    const outcome = screen.getByTestId('retest-outcome')
    expect(outcome).toHaveTextContent(
      'Creates a WooCommerce add-on order for Jane Doe against order WP-3134 ($230.00).'
    )
    expect(outcome).toHaveTextContent(
      'Once paid: a new sample is created with Rapid Sterility (PCR); HPLC Purity + Identity, Heavy Metals carried from P-9001; Endotoxin USP85 LAL dropped (not verified).'
    )

    expect(
      screen.queryByLabelText('Extra vials to ship')
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More options' }))
    expect(
      screen.getByText('added to the order at the per-vial price, no test')
    ).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Extra vials to ship'))
    await user.type(screen.getByLabelText('Extra vials to ship'), '2')
    const summary = screen.getByTestId('retest-summary')
    expect(
      within(summary).getByText('Extra vials, 2: price set by the shop')
    ).toBeInTheDocument()
    expect(total()).toHaveTextContent('Total (excluding extra vials)$230.00')
    await user.click(
      screen.getByLabelText('Check in on creation (extra vial already on hand)')
    )
    await user.type(screen.getByLabelText('Reason (required)'), 'add pcr')
    await user.click(
      screen.getByRole('button', { name: 'Create add-on order (new sample)' })
    )
    await waitFor(() =>
      expect(createRetest).toHaveBeenCalledWith('P-9001', {
        retest: [],
        carry: [HPLC, HM],
        drop: [ENDO],
        add: {
          profiles: ['rapid-sterility-pcr'],
          variance_points: 0,
          additional_vials: 2,
        },
        auto_checkin: true,
        fee: 'paid',
        reason: 'add pcr',
      })
    )
  })

  it('sends only the active tab half: add-ons ticked on Add services are not sent from Re-test', async () => {
    vi.mocked(createRetest).mockResolvedValue({ order_number: 'WP-7922' })
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(screen.getByRole('tab', { name: 'Add services' }))
    await user.click(
      screen.getByRole('checkbox', { name: 'Rapid Sterility (PCR)' })
    )
    await user.click(screen.getByRole('tab', { name: 'Re-test' }))
    await user.click(retestBox(HPLC))
    await user.type(screen.getByLabelText('Reason (required)'), 'x')
    await user.click(
      screen.getByRole('button', { name: 'Create retest order' })
    )
    await waitFor(() =>
      expect(createRetest).toHaveBeenCalledWith(
        'P-9001',
        expect.objectContaining({
          retest: [HPLC],
          add: { profiles: [], variance_points: 0, additional_vials: 0 },
        })
      )
    )
  })

  it('renders the order card above the tabs without the pending orders list', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: {
        ...CONTEXT,
        pending_orders: [
          {
            order_id: 7501,
            order_number: '7501',
            status: 'pending',
            total: 85,
            currency: 'USD',
            created_at: '2026-09-27T10:00:00Z',
            payment_url: 'https://pay/7501',
          },
        ],
      },
    })
    const { user } = renderDialog()
    const block = await screen.findByTestId('retest-context-block')
    expect(within(block).getByText('Order WP-3134')).toBeInTheDocument()
    expect(within(block).getByText(/Jane Doe/)).toBeInTheDocument()
    expect(within(block).getByText(/jane@example\.com/)).toBeInTheDocument()
    expect(within(block).getByText(/\$285\.00 · completed/)).toBeInTheDocument()
    expect(
      within(block).getByText('HPLC Purity + Identity')
    ).toBeInTheDocument()
    expect(within(block).queryByText(/7501/)).not.toBeInTheDocument()
    expect(within(block).queryByText('Copy link')).not.toBeInTheDocument()

    // Older WordPress (no retest_orders): pending orders still reach the Orders tab.
    await user.click(screen.getByRole('tab', { name: 'Orders (1)' }))
    const fallback = screen.getByTestId('retest-order-7501')
    expect(within(fallback).getByText('Copy link')).toBeInTheDocument()
    expect(within(fallback).getByText('not yet')).toBeInTheDocument()
  })

  it('Orders tab lists orders newest first with sample link, kind and copy action', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: { ...CONTEXT, orders: ORDERS },
    })
    const { user } = renderDialog()
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined)
    await user.click(await screen.findByRole('tab', { name: 'Orders (1)' }))
    const rows = screen.getAllByTestId(/^retest-order-/)
    expect(rows.map(r => r.dataset.testid)).toEqual([
      'retest-order-3278',
      'retest-order-3277',
    ])
    const [pendingRow, paidRow] = rows as [HTMLElement, HTMLElement]
    expect(within(pendingRow).getByText('Add-on')).toBeInTheDocument()
    expect(within(pendingRow).getByText('not yet')).toBeInTheDocument()
    expect(within(pendingRow).getByText('$230.00')).toBeInTheDocument()
    await user.click(within(pendingRow).getByText('Copy link'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PAY_URL))
    const open = within(pendingRow).getByText('Open')
    expect(open.getAttribute('href')).toBe(PAY_URL)
    expect(open.getAttribute('target')).toBe('_blank')
    expect(open.getAttribute('rel')).toBe('noreferrer')

    expect(within(paidRow).getByText('Retest')).toBeInTheDocument()
    expect(
      within(paidRow).getByRole('link', { name: 'P-9002' })
    ).toHaveAttribute('href', '#senaite/sample-details?id=P-9002')
    expect(within(paidRow).queryByText('Copy link')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Create / })
    ).not.toBeInTheDocument()
  })

  it('Orders tab shows the empty state and no badge or strip when nothing is unpaid', async () => {
    const { user } = renderDialog()
    await user.click(await screen.findByRole('tab', { name: 'Orders' }))
    expect(
      screen.getByText('No retest orders for this sample yet.')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('retest-unpaid-strip')).not.toBeInTheDocument()
  })

  it('amber strip names unpaid orders above the tabs and View opens the Orders tab', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: {
        ...CONTEXT,
        orders: [
          { ...ORDERS[0], order_id: 3278, order_number: '3278' },
          { ...ORDERS[0], order_id: 3277, order_number: '3277' },
        ],
      },
    })
    const { user } = renderDialog()
    const strip = await screen.findByTestId('retest-unpaid-strip')
    expect(strip).toHaveAttribute('role', 'status')
    expect(strip).toHaveTextContent('2 unpaid retest orders: 3278, 3277 ·')
    expect(
      strip.compareDocumentPosition(screen.getByRole('tablist')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Orders (2)' })).toBeInTheDocument()
    await user.click(within(strip).getByRole('button', { name: 'View' }))
    expect(screen.getByRole('tab', { name: 'Orders (2)' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('retest-order-3277')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Re-test P-9001' })
    ).toBeInTheDocument()
  })

  it('toasts Copy failed when the clipboard rejects', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: { ...CONTEXT, orders: ORDERS },
    })
    const { user } = renderDialog()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('denied')
    )
    await user.click(await screen.findByRole('tab', { name: 'Orders (1)' }))
    await user.click(
      within(screen.getByTestId('retest-order-3278')).getByText('Copy link')
    )
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Copy failed'))
  })

  it('clamps variance points to 2..10', async () => {
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(retestBox(HPLC))
    await user.click(screen.getByLabelText('Variance'))
    const points = screen.getByLabelText('Variance points')
    expect(points).toHaveAttribute('min', '2')
    expect(points).toHaveAttribute('max', '10')
    fireEvent.change(points, { target: { value: '15' } })
    expect(points).toHaveValue(10)
    expect(screen.getByText('Variance, 10 points')).toBeInTheDocument()
    fireEvent.change(points, { target: { value: '1' } })
    expect(points).toHaveValue(2)
    expect(disabledReason()).toHaveTextContent('Enter a reason')
  })

  it('clicking the 44 px target cell toggles the checkbox inside it', async () => {
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    const box = retestBox(HPLC)
    const target = box.closest('label')
    expect(target).not.toBeNull()
    await user.click(target as HTMLElement)
    expect(box).toBeChecked()
  })

  it('shows a quiet unavailable line when order context is missing', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: null,
      prices_available: false,
    })
    renderDialog()
    expect(
      await screen.findByText('Customer and pricing unavailable')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('retest-context-block')).not.toBeInTheDocument()
  })

  it('stays open on a server error', async () => {
    vi.mocked(createRetest).mockRejectedValue(new Error('IS returned 502'))
    const { user, onClose } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(retestBox(HPLC))
    await user.type(screen.getByLabelText('Reason (required)'), 'x')
    await user.click(
      screen.getByRole('button', { name: 'Create retest order' })
    )
    await waitFor(() => expect(createRetest).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('resets tab and form on reopen for the same sample', async () => {
    const { user, rerenderOpen } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.type(screen.getByLabelText('Reason (required)'), 'asked')
    await user.click(screen.getByRole('tab', { name: 'Add services' }))
    expect(
      screen.getByRole('heading', { name: 'Add services to P-9001' })
    ).toBeInTheDocument()

    rerenderOpen(false)
    rerenderOpen(true)

    expect(
      await screen.findByRole('heading', { name: 'Re-test P-9001' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Reason (required)')).toHaveValue('')
  })

  it('published original (flag missing or true): new-sample copy and label', async () => {
    for (const flag of [undefined, true]) {
      vi.mocked(getRetestOptions).mockResolvedValue({
        ...OPTIONS,
        original_published: flag,
      })
      const qc = new QueryClient()
      const { unmount } = render(
        <QueryClientProvider client={qc}>
          {dialogTree(true)}
        </QueryClientProvider>
      )
      const user = userEvent.setup()
      await screen.findByTestId(`retest-row-${HPLC}`)
      await user.click(screen.getByRole('tab', { name: 'Add services' }))
      expect(screen.getByTestId('addon-mode')).toHaveTextContent(
        'P-9001 is published: a new sample is created with the existing results carried.'
      )
      expect(
        screen.getByRole('button', { name: 'Create add-on order (new sample)' })
      ).toBeInTheDocument()
      unmount()
    }
  })

  it('in-progress original: same-sample copy, label, no New sample line, addon-order body', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      status: 'received',
      original_published: false,
    })
    vi.mocked(createAddonOrder).mockResolvedValue({
      order_id: 8611,
      order_number: '8611',
      status: 'pending',
      payment_url: 'https://pay/8611',
      total: 230,
    })
    const { user, onClose } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(screen.getByRole('tab', { name: 'Add services' }))
    expect(screen.getByTestId('addon-mode')).toHaveTextContent(
      'P-9001 is in progress: the selected services are added to this sample once the order is paid (or at once if waived).'
    )
    expect(
      screen.getByText(
        'Add-ons are billed at the listed price unless Billing is Waived.'
      )
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole('checkbox', { name: 'Rapid Sterility (PCR)' })
    )
    const outcome = screen.getByTestId('retest-outcome')
    expect(outcome).toHaveTextContent(
      'Once paid: Rapid Sterility (PCR) added to P-9001; needs 1 more vial from the customer.'
    )
    expect(outcome).toHaveTextContent(
      'No new sample; P-9001 keeps its current results.'
    )
    expect(outcome).toHaveTextContent(
      'No payment email is sent; copy the payment link from the Orders tab.'
    )
    expect(outcome).not.toHaveTextContent('new sample is created')
    const summary = screen.getByTestId('retest-summary')
    expect(
      within(summary).getByText('Rapid Sterility (PCR)')
    ).toBeInTheDocument()
    expect(total()).toHaveTextContent('$230.00')

    await user.click(screen.getByRole('button', { name: 'More options' }))
    expect(
      screen.queryByLabelText(
        'Check in on creation (extra vial already on hand)'
      )
    ).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText('Extra vials to ship'))
    await user.type(screen.getByLabelText('Extra vials to ship'), '1')
    await user.click(screen.getByLabelText('Waived (whole order free)'))
    expect(outcome).toHaveTextContent('($0.00, waived $230.00)')
    expect(outcome).toHaveTextContent(
      'At once: Rapid Sterility (PCR) added to P-9001; needs 2 more vials from the customer.'
    )
    expect(outcome).toHaveTextContent('No payment is needed.')
    await user.type(screen.getByLabelText('Reason (required)'), 'add usp71')
    await user.click(
      screen.getByRole('button', { name: 'Add services to P-9001' })
    )
    await waitFor(() =>
      expect(createAddonOrder).toHaveBeenCalledWith('P-9001', {
        profiles: ['rapid-sterility-pcr'],
        variance_points: 0,
        additional_vials: 1,
        fee: 'free',
        reason: 'add usp71',
      })
    )
    expect(createRetest).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('in-progress original: the Re-test tab still creates a retest order', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      original_published: false,
    })
    vi.mocked(createRetest).mockResolvedValue({ order_number: 'WP-1' })
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(retestBox(HPLC))
    await user.type(screen.getByLabelText('Reason (required)'), 'x')
    await user.click(
      screen.getByRole('button', { name: 'Create retest order' })
    )
    await waitFor(() => expect(createRetest).toHaveBeenCalled())
    expect(createAddonOrder).not.toHaveBeenCalled()
  })

  it('Orders tab: same-sample add-on rows read "same sample", then "applied"', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      original_published: false,
      context: {
        ...CONTEXT,
        orders: [
          { ...ORDERS[0], same_sample: true, applied: false },
          {
            ...ORDERS[0],
            order_id: 3279,
            order_number: '3279',
            status: 'completed',
            payment_url: null,
            same_sample: true,
            applied: true,
          },
        ],
      },
    })
    const { user } = renderDialog()
    await user.click(await screen.findByRole('tab', { name: 'Orders (1)' }))
    const waiting = screen.getByTestId('retest-order-3278')
    expect(within(waiting).getByText('Add-on')).toBeInTheDocument()
    expect(within(waiting).getByText('same sample')).toBeInTheDocument()
    expect(within(waiting).queryByText('not yet')).not.toBeInTheDocument()
    const applied = screen.getByTestId('retest-order-3279')
    expect(within(applied).getByText('applied')).toBeInTheDocument()
    expect(within(applied).queryByRole('link')).not.toBeInTheDocument()
  })
})
