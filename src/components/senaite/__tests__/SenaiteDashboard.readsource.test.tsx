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
    // The refresh is slim (catalog-only, arg 6) and merges review_state ONLY:
    // analytes are registry-owned now (Replace dual-writes lims_samples), so
    // the refreshed item's extra analyte must NOT appear.
    expect(getSenaite.mock.calls[0]![5]).toBe(true)
    expect(screen.queryByText('DSIP - Purity (HPLC)')).not.toBeInTheDocument()
  })

  it('mk1 mode: hide-test filter works off the registry client_id alone — no SENAITE refresh needed', async () => {
    vi.spyOn(api, 'getSenaiteStatus').mockResolvedValue({ enabled: true })
    vi.spyOn(api, 'getSettings').mockResolvedValue([
      { key: 'registry_read_source', value: '{"samples_list":"mk1"}' } as api.Setting,
    ])
    vi.spyOn(api, 'fetchSampleAggregates').mockResolvedValue({ aggregates: {} })
    // /registry/samples now returns client_title (the email form) as client_id
    // (parity with /senaite/samples' getClientTitle), so hide-test matches on
    // the fast render itself.
    const emailItem: api.SenaiteSample = {
      ...registryItem,
      id: 'P-2',
      client_id: 'forrest@valenceanalytical.com',
    }
    const getRegistry = vi.spyOn(api, 'getRegistrySamples').mockResolvedValue({
      items: [emailItem],
      total: 1,
      b_start: 0,
    })
    // The refresh never resolves — proving the fast render filters unaided.
    vi.spyOn(api, 'getSenaiteSamples').mockReturnValue(new Promise(() => {}))

    renderDashboard()

    await waitFor(() => expect(getRegistry).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText(/Read from Accu-Mk1/i)).toBeInTheDocument()
    )
    expect(screen.queryByText('P-2')).not.toBeInTheDocument()
  })

  it('mk1 mode: SENAITE refresh merges only review_state — client_id and analytes stay registry-native', async () => {
    vi.spyOn(api, 'getSenaiteStatus').mockResolvedValue({ enabled: true })
    vi.spyOn(api, 'getSettings').mockResolvedValue([
      { key: 'registry_read_source', value: '{"samples_list":"mk1"}' } as api.Setting,
    ])
    vi.spyOn(api, 'fetchSampleAggregates').mockResolvedValue({ aggregates: {} })
    vi.spyOn(api, 'getRegistrySamples').mockResolvedValue({
      items: [registryItem], // client_id 'acme' — not a test client
      total: 1,
      b_start: 0,
    })
    // The refresh reports the TEST client for the same row; if client_id were
    // still merged, hide-test (on by default) would drop the row after refresh.
    const getSenaite = vi.spyOn(api, 'getSenaiteSamples').mockResolvedValue({
      items: [{ ...refreshedItem, client_id: 'forrest@valenceanalytical.com' }],
      total: 1,
      b_start: 0,
    })

    renderDashboard()

    await waitFor(() => expect(getSenaite).toHaveBeenCalled())
    // review_state DID merge (Due → Registered)…
    await waitFor(() => expect(screen.getByText('Registered')).toBeInTheDocument())
    // …but client_id did not: the row survives hide-test.
    expect(screen.getByText('P-1')).toBeInTheDocument()
    // …and analytes did not merge either (registry-owned).
    expect(screen.queryByText('DSIP - Purity (HPLC)')).not.toBeInTheDocument()
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
    // SENAITE mode never asks for the slim payload — it needs full hydration.
    expect(getSenaite.mock.calls[0]![5]).toBeUndefined()
  })

  it('mk1 mode: State column header carries the SENAITE provenance glyph', async () => {
    vi.spyOn(api, 'getSenaiteStatus').mockResolvedValue({ enabled: true })
    vi.spyOn(api, 'getSettings').mockResolvedValue([
      { key: 'registry_read_source', value: '{"samples_list":"mk1"}' } as api.Setting,
    ])
    vi.spyOn(api, 'fetchSampleAggregates').mockResolvedValue({ aggregates: {} })
    vi.spyOn(api, 'getRegistrySamples').mockResolvedValue({
      items: [registryItem], total: 1, b_start: 0,
    })
    vi.spyOn(api, 'getSenaiteSamples').mockResolvedValue({
      items: [refreshedItem], total: 1, b_start: 0,
    })

    renderDashboard()

    await waitFor(() =>
      expect(screen.getAllByLabelText('State: live from SENAITE').length).toBeGreaterThan(0)
    )
  })

  it('senaite mode: no provenance glyph anywhere', async () => {
    vi.spyOn(api, 'getSenaiteStatus').mockResolvedValue({ enabled: true })
    vi.spyOn(api, 'getSettings').mockResolvedValue([])
    vi.spyOn(api, 'fetchSampleAggregates').mockResolvedValue({ aggregates: {} })
    vi.spyOn(api, 'getRegistrySamples').mockResolvedValue({ items: [], total: 0, b_start: 0 })
    const getSenaite = vi.spyOn(api, 'getSenaiteSamples').mockResolvedValue({
      items: [registryItem], total: 1, b_start: 0,
    })

    renderDashboard()

    await waitFor(() => expect(getSenaite).toHaveBeenCalled())
    expect(screen.queryByLabelText('State: live from SENAITE')).not.toBeInTheDocument()
  })
})
