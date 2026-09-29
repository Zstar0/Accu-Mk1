import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { RetestOptions } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, getRetestOptions: vi.fn(), createRetest: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { createRetest, getRetestOptions } from '@/lib/api'
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
})

describe('RetestDialog overlay v2', () => {
  it('switches tabs with fixed titles; fee radio and variance live only on Re-test', async () => {
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    expect(
      screen.getByRole('heading', { name: 'Re-test P-9001' })
    ).toBeInTheDocument()
    await user.click(retestBox(HPLC))
    expect(
      screen.getByRole('radiogroup', { name: 'Retest fee' })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Add services' }))
    expect(
      screen.getByRole('heading', { name: 'Add services to P-9001' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('radiogroup', { name: 'Retest fee' })
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Variance')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Add-ons are always billed at the listed price. Existing results are carried to the new sample.'
      )
    ).toBeInTheDocument()

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
    expect(screen.getByTestId('retest-new-sample')).toHaveTextContent(
      'New sample: re-test HPLC Purity + Identity; drop Heavy Metals, Endotoxin USP85 LAL.'
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
    expect(within(summary).getByText('$153.00')).toBeInTheDocument()
    expect(total()).toHaveTextContent('$238.00')
    expect(screen.getByLabelText('Charged $85.00')).toBeChecked()

    await user.click(screen.getByLabelText('Waived'))
    expect(total()).toHaveTextContent('$153.00')

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

  it('blocks Create with "Pricing unavailable" when the fee price is unknown, until the fee is waived', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: { ...CONTEXT, retest_fee: { price: null } },
    })
    const { user } = renderDialog()
    await screen.findByTestId(`retest-row-${HPLC}`)
    await user.click(retestBox(HPLC))
    await user.type(screen.getByLabelText('Reason (required)'), 'x')
    expect(
      screen.getByLabelText('Charged (price unavailable)')
    ).toBeInTheDocument()
    expect(total()).toHaveTextContent('Total: price unavailable')
    expect(disabledReason()).toHaveTextContent('Pricing unavailable')
    expect(
      screen.getByRole('button', { name: 'Create retest order' })
    ).toBeDisabled()
    await user.click(screen.getByLabelText('Waived'))
    expect(
      screen.getByRole('button', { name: 'Create retest order' })
    ).toBeEnabled()
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
    expect(screen.getByTestId('retest-new-sample')).toHaveTextContent(
      'New sample: carry HPLC Purity + Identity, Heavy Metals; drop Endotoxin USP85 LAL; add Rapid Sterility (PCR).'
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
    await user.click(
      screen.getByLabelText('Check in on creation (extra vial already on hand)')
    )
    await user.type(screen.getByLabelText('Reason (required)'), 'add pcr')
    await user.click(
      screen.getByRole('button', { name: 'Create add-on order' })
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

  it('renders the order card and pending retest orders above the tabs', async () => {
    const url = 'https://accumarklabs.com/checkout/order-pay/501'
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: {
        ...CONTEXT,
        pending_orders: [
          {
            order_id: 501,
            order_number: 'WP-7501',
            status: 'pending',
            total: 85,
            currency: 'USD',
            created_at: '2026-09-27T10:00:00Z',
            payment_url: url,
          },
        ],
      },
    })
    const { user } = renderDialog()
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined)
    const block = await screen.findByTestId('retest-context-block')
    expect(within(block).getByText('Order WP-3134')).toBeInTheDocument()
    expect(within(block).getByText(/Jane Doe/)).toBeInTheDocument()
    expect(within(block).getByText(/jane@example\.com/)).toBeInTheDocument()
    expect(within(block).getByText(/\$285\.00 · completed/)).toBeInTheDocument()
    expect(
      within(block).getByText('HPLC Purity + Identity')
    ).toBeInTheDocument()

    const pending = screen.getByTestId('pending-retest-order-501')
    const tablist = screen.getByRole('tablist')
    expect(
      pending.compareDocumentPosition(tablist) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(within(pending).getByText(/awaiting payment/)).toBeInTheDocument()
    await user.click(within(pending).getByText('Copy link'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url))
    const link = within(pending).getByText('Open')
    expect(link.getAttribute('href')).toBe(url)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
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
})
