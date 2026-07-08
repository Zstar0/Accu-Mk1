import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SenaiteDashboard } from '@/components/senaite/SenaiteDashboard'
import * as api from '@/lib/api'

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SenaiteDashboard />
    </QueryClientProvider>
  )
}

// 'sample_due'/'sample_registered' are picked because their STATE_LABELS text
// ("Due"/"Registered") doesn't collide with any TABS label — several review
// states (e.g. "Received", "Verified") double as tab-trigger text, which
// would make getByText ambiguous.
const registryItem: api.SenaiteSample = {
  uid: 'U1',
  id: 'P-1',
  title: 'P-1',
  client_id: 'acme',
  client_order_number: 'WP-1',
  date_created: '2026-07-01T00:00:00',
  date_received: null,
  date_sampled: null,
  review_state: 'sample_due',
  sample_type: 'Peptide',
  contact: 'Acme',
  verification_code: 'AAAA-BBBB',
  analytes: ['DSIP - Identity (HPLC)'],
}

const refreshedItem: api.SenaiteSample = {
  ...registryItem,
  review_state: 'sample_registered',
  analytes: ['DSIP - Identity (HPLC)', 'DSIP - Purity (HPLC)'],
}

beforeEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('SenaiteDashboard read source', () => {
  it('mk1 mode: fast registry render + one batched SENAITE refresh merged by id', async () => {
    vi.spyOn(api, 'getSenaiteStatus').mockResolvedValue({ enabled: true })
    vi.spyOn(api, 'getSettings').mockResolvedValue([
      { key: 'registry_read_source', value: '{"samples_list":"mk1"}' } as api.Setting,
    ])
    vi.spyOn(api, 'fetchSampleAggregates').mockResolvedValue({ aggregates: {} })
    const getRegistry = vi.spyOn(api, 'getRegistrySamples').mockResolvedValue({
      items: [registryItem],
      total: 1,
      b_start: 0,
    })
    const getSenaite = vi.spyOn(api, 'getSenaiteSamples').mockResolvedValue({
      items: [refreshedItem],
      total: 1,
      b_start: 0,
    })

    renderDashboard()

    await waitFor(() => expect(getRegistry).toHaveBeenCalled())
    await waitFor(() => expect(getSenaite).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText(/Read from Accu-Mk1/i)).toBeInTheDocument()
    )
    // The registry-sourced row's review_state is overwritten in place once
    // the single batched SENAITE refresh resolves.
    await waitFor(() => expect(screen.getByText('Registered')).toBeInTheDocument())
  })

  it('senaite mode: only getSenaiteSamples is called — no registry fetch', async () => {
    vi.spyOn(api, 'getSenaiteStatus').mockResolvedValue({ enabled: true })
    vi.spyOn(api, 'getSettings').mockResolvedValue([])
    vi.spyOn(api, 'fetchSampleAggregates').mockResolvedValue({ aggregates: {} })
    const getRegistry = vi.spyOn(api, 'getRegistrySamples').mockResolvedValue({
      items: [],
      total: 0,
      b_start: 0,
    })
    const getSenaite = vi.spyOn(api, 'getSenaiteSamples').mockResolvedValue({
      items: [registryItem],
      total: 1,
      b_start: 0,
    })

    renderDashboard()

    await waitFor(() => expect(getSenaite).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText(/Read from SENAITE/i)).toBeInTheDocument()
    )
    expect(getRegistry).not.toHaveBeenCalled()
  })
})
