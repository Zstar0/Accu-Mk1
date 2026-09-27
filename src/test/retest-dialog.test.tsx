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
import { RetestDialog, retestDelta } from '@/components/senaite/RetestDialog'

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
    expect(screen.getByText(/Delta/)).toHaveTextContent('$153.00') // (3 - 1) * 76.5
    expect(screen.getByText(/^fee$/i)).toBeInTheDocument()
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
})
