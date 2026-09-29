import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, getRetestOptions: vi.fn(), createRetest: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { createRetest, getRetestOptions } from '@/lib/api'
import {
  RetestDialog,
  retestDelta,
  buildRetestBody,
} from '@/components/senaite/RetestDialog'

const OPTIONS = {
  sample_id: 'P-9001',
  status: 'published',
  order_number: 'WP-3134',
  profiles: [
    {
      key: 'hplc-purity-identity',
      name: 'HPLC Purity + Identity',
      carry_eligible: true,
      state: 'published',
    },
    {
      key: 'heavy_metals',
      name: 'Heavy Metals',
      carry_eligible: true,
      state: 'published',
    },
    {
      key: 'endotoxin-usp85-lal',
      name: 'Endotoxin USP85 LAL',
      carry_eligible: false,
      state: 'parent_to_verify',
    },
  ],
  addons: [
    {
      key: 'rapid-sterility-pcr',
      name: 'Rapid Sterility Screening (PCR)',
      wp_type: 'sterility_pcr',
      price: 230,
      vials: 1,
    },
    {
      key: 'fentanyl',
      name: 'Fentanyl Screening',
      wp_type: null,
      price: null,
      vials: 0,
    },
  ],
  variance: { point_price: 76.5, allowed: true },
  prices_available: true,
  context: {
    order: {
      number: 'WP-3134',
      placed_at: '2026-09-20T10:00:00Z',
      customer_name: 'Jane Doe',
      customer_email: 'jane@example.com',
      total: 285,
      currency: 'USD',
      status: 'processing',
      lines: [{ key: 'hplc', label: 'HPLC Purity + Identity', price: 85 }],
    },
    retest_fee: { price: 85 },
    pending_orders: [],
  },
}

function renderDialog(onCreated = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <RetestDialog
        open
        sampleId="P-9001"
        onClose={onClose}
        onCreated={onCreated}
      />
    </QueryClientProvider>
  )
  return { onClose, onCreated }
}

beforeEach(() => {
  vi.mocked(getRetestOptions).mockResolvedValue(OPTIONS)
  vi.mocked(createRetest).mockReset()
})

describe('RetestDialog', () => {
  it('defaults eligible profiles to Carry, locks ineligible ones to Retest, lists only WP-sellable add-ons', async () => {
    renderDialog()
    const hm = await screen.findByTestId('retest-row-heavy_metals')
    expect(within(hm).getByRole('button', { name: 'Carry' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const endo = screen.getByTestId('retest-row-endotoxin-usp85-lal')
    expect(
      within(endo).getByRole('button', { name: 'Retest' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(within(endo).getByRole('button', { name: 'Carry' })).toBeDisabled()
    expect(
      screen.getByText(/Rapid Sterility Screening \(PCR\)/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/Fentanyl Screening/)).not.toBeInTheDocument()
    expect(screen.getByText(/\$230\.00/)).toBeInTheDocument()
  })

  it('gates Create on a reason and something to do; hides Fee when nothing is retested', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      profiles: OPTIONS.profiles.filter(p => p.carry_eligible),
    })
    renderDialog()
    const create = await screen.findByRole('button', { name: /^create/i })
    expect(create).toBeDisabled()
    expect(screen.queryByText(/^fee$/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: 'customer asked' },
    })
    expect(create).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/Rapid Sterility Screening/))
    expect(create).toBeEnabled()
    expect(screen.getByText(/Delta/)).toHaveTextContent('$230.00')
  })

  it('variance needs an HPLC profile set to Retest and prices the replicates', async () => {
    renderDialog()
    const variance = await screen.findByLabelText(/^variance$/i)
    expect(variance).toBeDisabled()
    const hplc = screen.getByTestId('retest-row-hplc-purity-identity')
    fireEvent.click(within(hplc).getByRole('button', { name: 'Retest' }))
    expect(variance).toBeEnabled()
    fireEvent.click(variance)
    // (3 - 1) * 76.5 variance + $85 retest fee (endo is forced to Retest,
    // and Fee defaults to Paid)
    expect(screen.getByText(/Delta/)).toHaveTextContent('$238.00')
    expect(screen.getByText(/^fee$/i)).toBeInTheDocument()
  })

  it('drops variance when HPLC is set back to Carry after ticking it', async () => {
    vi.mocked(createRetest).mockResolvedValue({
      order_number: 'WP-7920',
      payment_url: 'https://pay',
    })
    renderDialog()
    const hplc = await screen.findByTestId('retest-row-hplc-purity-identity')
    fireEvent.click(within(hplc).getByRole('button', { name: 'Retest' }))
    const variance = screen.getByLabelText(/^variance$/i)
    fireEvent.click(variance)
    fireEvent.click(screen.getByLabelText(/Rapid Sterility Screening/))
    // 230 (addon) + 153 (variance) + 85 (retest fee, endo forced to Retest)
    expect(screen.getByText(/Delta/)).toHaveTextContent('$468.00')

    fireEvent.click(within(hplc).getByRole('button', { name: 'Carry' }))
    expect(variance).toBeDisabled()
    expect(variance).toBeChecked()
    // 230 (addon) + 85 (retest fee, endo still forced to Retest)
    expect(screen.getByText(/Delta/)).toHaveTextContent('$315.00')

    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: 'carry check' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create/i }))
    await waitFor(() =>
      expect(createRetest).toHaveBeenCalledWith(
        'P-9001',
        expect.objectContaining({
          add: expect.objectContaining({ variance_points: 0 }),
        })
      )
    )
  })

  it('submits the spec shape and closes on success', async () => {
    vi.mocked(createRetest).mockResolvedValue({
      order_number: 'WP-7920',
      payment_url: 'https://pay',
    })
    const { onClose, onCreated } = renderDialog()
    const hplc = await screen.findByTestId('retest-row-hplc-purity-identity')
    fireEvent.click(within(hplc).getByRole('button', { name: 'Retest' }))
    fireEvent.click(screen.getByLabelText(/Rapid Sterility Screening/))
    fireEvent.change(screen.getByLabelText(/ship vials/i), {
      target: { value: '2' },
    })
    fireEvent.click(screen.getByLabelText(/free/i))
    fireEvent.click(screen.getByLabelText(/auto check-in/i))
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: 'purity re-run' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create/i }))
    await waitFor(() =>
      expect(createRetest).toHaveBeenCalledWith('P-9001', {
        retest: ['hplc-purity-identity', 'endotoxin-usp85-lal'],
        carry: ['heavy_metals'],
        add: {
          profiles: ['rapid-sterility-pcr'],
          variance_points: 0,
          additional_vials: 2,
        },
        auto_checkin: true,
        fee: 'free',
        reason: 'purity re-run',
      })
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onCreated).toHaveBeenCalledWith({
      order_number: 'WP-7920',
      payment_url: 'https://pay',
    })
  })

  it('stays open on a server error', async () => {
    vi.mocked(createRetest).mockRejectedValue(
      new Error('Integration Service returned 502')
    )
    const { onClose } = renderDialog()
    const hplc = await screen.findByTestId('retest-row-hplc-purity-identity')
    fireEvent.click(within(hplc).getByRole('button', { name: 'Retest' }))
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: 'x' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create/i }))
    await waitFor(() => expect(createRetest).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows "price unavailable" instead of numbers when IS has no prices', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      prices_available: false,
      variance: { point_price: null, allowed: true },
      addons: [
        {
          ...(OPTIONS.addons[0] as (typeof OPTIONS.addons)[number]),
          price: null,
        },
      ],
    })
    renderDialog()
    expect(await screen.findAllByText(/price unavailable/i)).not.toHaveLength(0)
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument()
  })

  it('renders the order/customer context block at the top', async () => {
    renderDialog()
    const block = await screen.findByTestId('retest-context-block')
    expect(within(block).getByText(/Order WP-3134/)).toBeInTheDocument()
    expect(within(block).getByText(/Jane Doe/)).toBeInTheDocument()
    expect(within(block).getByText(/jane@example.com/)).toBeInTheDocument()
    expect(within(block).getByText(/\$285\.00/)).toBeInTheDocument()
    expect(
      within(block).getByText(/HPLC Purity \+ Identity: \$85\.00/)
    ).toBeInTheDocument()
  })

  it('renders pending retest orders from context and copies the payment link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: {
        ...OPTIONS.context,
        pending_orders: [
          {
            order_id: 501,
            order_number: 'WP-7501',
            status: 'pending',
            total: 85,
            currency: 'USD',
            created_at: '2026-09-27T10:00:00Z',
            payment_url: 'https://accumarklabs.com/checkout/order-pay/501',
          },
        ],
      },
    })
    renderDialog()
    const row = await screen.findByTestId('pending-retest-order-501')
    expect(within(row).getByText(/Order WP-7501/)).toBeInTheDocument()
    expect(within(row).getByText(/\$85\.00/)).toBeInTheDocument()
    expect(within(row).getByText(/awaiting payment/)).toBeInTheDocument()
    fireEvent.click(within(row).getByText('Copy link'))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'https://accumarklabs.com/checkout/order-pay/501'
      )
    )
    const link = within(row).getByText('Open') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(
      'https://accumarklabs.com/checkout/order-pay/501'
    )
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it('does not render a pending orders section when context.pending_orders is empty', async () => {
    renderDialog()
    await screen.findByTestId('retest-context-block')
    expect(screen.queryByText(/Pending retest orders/)).not.toBeInTheDocument()
  })

  it('shows the fee amount on the Paid label and adds it to Delta only when Paid is selected', async () => {
    renderDialog()
    await screen.findByTestId('retest-context-block')
    // endo is carry_eligible: false, so it defaults to Retest and Fee
    // defaults to Paid: the $85 fee is already in the delta.
    expect(screen.getByLabelText(/Paid \(\$85\.00\)/)).toBeInTheDocument()
    expect(screen.getByText(/Delta/)).toHaveTextContent('$85.00')
    fireEvent.click(screen.getByLabelText(/^free$/i))
    expect(screen.getByText(/Delta/)).toHaveTextContent('$0.00')
  })

  it('shows Customer info unavailable but still applies the fee when the sample has no linked order', async () => {
    // context is present (retest_fee is known from IS) but order is null,
    // e.g. the sample is not yet on a WP order.
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: { order: null, retest_fee: { price: 85 }, pending_orders: [] },
    })
    renderDialog()
    const block = await screen.findByTestId('retest-context-block')
    expect(
      within(block).getByText(/Customer info unavailable/)
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Customer and pricing unavailable/)
    ).not.toBeInTheDocument()
    // endo defaults to Retest, Fee defaults to Paid: the $85 fee still
    // applies even though there is no order to show.
    expect(screen.getByText(/Delta/)).toHaveTextContent('$85.00')
  })

  it('shows a quiet unavailable line when order context is missing', async () => {
    // Mirrors the real API contract: context is null exactly when IS was
    // unreachable, so prices_available is false too.
    vi.mocked(getRetestOptions).mockResolvedValue({
      ...OPTIONS,
      context: null,
      prices_available: false,
    })
    renderDialog()
    expect(
      await screen.findByText(/Customer and pricing unavailable/)
    ).toBeInTheDocument()
    expect(screen.queryByTestId('retest-context-block')).not.toBeInTheDocument()
    expect(screen.getByText(/Delta/)).toHaveTextContent('price unavailable')
  })

  it('resets the form on reopen for the same sample', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const onClose = vi.fn()
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <RetestDialog open sampleId="P-9001" onClose={onClose} />
      </QueryClientProvider>
    )
    fireEvent.change(await screen.findByLabelText(/reason/i), {
      target: { value: 'customer asked' },
    })
    fireEvent.click(screen.getByLabelText(/Rapid Sterility Screening/))
    expect(screen.getByLabelText(/reason/i)).toHaveValue('customer asked')

    rerender(
      <QueryClientProvider client={qc}>
        <RetestDialog open={false} sampleId="P-9001" onClose={onClose} />
      </QueryClientProvider>
    )
    rerender(
      <QueryClientProvider client={qc}>
        <RetestDialog open sampleId="P-9001" onClose={onClose} />
      </QueryClientProvider>
    )

    expect(await screen.findByLabelText(/reason/i)).toHaveValue('')
    expect(screen.getByRole('button', { name: /^create/i })).toBeDisabled()
  })
})

describe('retestDelta', () => {
  it('sums add-on prices and variance replicates, null when a price is missing', () => {
    expect(
      retestDelta({
        addons: [{ key: 'a', name: 'a', wp_type: 'x', price: 200, vials: 1 }],
        variancePoints: 3,
        pointPrice: 76.5,
      })
    ).toBe(353)
    expect(
      retestDelta({ addons: [], variancePoints: 0, pointPrice: null })
    ).toBe(0)
    expect(
      retestDelta({
        addons: [{ key: 'a', name: 'a', wp_type: 'x', price: null, vials: 1 }],
        variancePoints: 0,
        pointPrice: null,
      })
    ).toBeNull()
    expect(
      retestDelta({ addons: [], variancePoints: 3, pointPrice: null })
    ).toBeNull()
  })

  it('adds the retest fee when given, is null when the fee applies but its price is unknown, and is left out when omitted', () => {
    expect(
      retestDelta({
        addons: [],
        variancePoints: 0,
        pointPrice: null,
        retestFeePrice: 85,
      })
    ).toBe(85)
    expect(
      retestDelta({
        addons: [],
        variancePoints: 0,
        pointPrice: null,
        retestFeePrice: null,
      })
    ).toBeNull()
    expect(
      retestDelta({ addons: [], variancePoints: 0, pointPrice: null })
    ).toBe(0)
  })
})

describe('buildRetestBody', () => {
  it('zeroes out-of-range variance points (e.g. 11) even when ticked with HPLC on Retest', () => {
    const state = {
      toggles: {
        'hplc-purity-identity': true,
        heavy_metals: false,
        'endotoxin-usp85-lal': false,
      },
      addons: {},
      varianceTicked: true,
      variancePoints: 11,
      shipVials: 0,
      fee: 'paid' as const,
      autoCheckin: false,
      reason: 'x',
    }
    const body = buildRetestBody(state, OPTIONS)
    expect(body.add?.variance_points ?? 0).toBe(0)
  })
})
