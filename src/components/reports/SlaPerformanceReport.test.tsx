import { cloneElement, type ReactElement } from 'react'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Recharts from 'recharts'
import { getSlaPerformance, type SlaPerfReport as Report } from '@/lib/api'
import { SlaPerformanceReport } from './SlaPerformanceReport'

vi.mock('@/lib/api', () => ({ getSlaPerformance: vi.fn() }))
const mockGet = vi.mocked(getSlaPerformance)

// jsdom has no layout, so ResponsiveContainer would hand its chart a 0x0 box.
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof Recharts>()
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: ReactElement<{ width?: number; height?: number }>
    }) => cloneElement(children, { width: 800, height: 300 }),
  }
})

function stats(over: Partial<Report['overall']> = {}): Report['overall'] {
  return {
    n: 100,
    ontime: 60,
    late: 40,
    rate: 60,
    med: 21,
    p75: 26,
    p90: 34,
    max: 90,
    ...over,
  }
}

function report(): Report {
  return {
    start: '2026-02-01',
    today: '2026-09-09',
    tz: 'America/Los_Angeles',
    generated_at: '2026-09-09T18:00:00Z',
    target_bh: 24,
    targets: [{ name: 'Standard', bh: 24, samples: 1681 }],
    totals: { samples: 3056, delivered: 2735, open: 320, cancelled: 1 },
    overall: stats(),
    kpi: {
      last30: stats({
        n: 870,
        ontime: 420,
        late: 450,
        rate: 48.3,
        med: 24.4,
        p90: 36.5,
      }),
      prev30: stats({
        n: 766,
        ontime: 562,
        late: 204,
        rate: 73.4,
        med: 19.6,
        p90: 37.2,
      }),
    },
    months: [
      {
        m: '2026-07',
        label: 'Jul 2026',
        received: 702,
        delivered: 691,
        open: 11,
        ontime: 530,
        late: 161,
        open_late: 11,
        rate_delivered: 76.7,
        rate_received: 75.5,
        med: 19.3,
        p90: 29.9,
      },
      {
        m: '2026-08',
        label: 'Aug 2026',
        received: 872,
        delivered: 852,
        open: 20,
        ontime: 465,
        late: 387,
        open_late: 20,
        rate_delivered: 54.6,
        rate_received: 53.3,
        med: 23.5,
        p90: 35.8,
      },
      {
        m: '2026-09',
        label: 'Sep 2026',
        received: 303,
        delivered: 145,
        open: 158,
        ontime: 71,
        late: 74,
        open_late: 31,
        rate_delivered: 49,
        rate_received: 23.4,
        med: 24.4,
        p90: 35.2,
      },
    ],
    curve: {
      all: [
        { bh: 24, n: 100, cum_pct: 55 },
        { bh: 48, n: 50, cum_pct: 92 },
      ],
      recent: [
        { bh: 24, n: 120, cum_pct: 60.5 },
        { bh: 48, n: 60, cum_pct: 95 },
      ],
      recent_n: 2034,
      within_target: 60.5,
    },
    stages: {
      n: 1815,
      coverage: 66.4,
      bench_med: 21,
      bench_p90: 36.5,
      lag_med: 0.2,
      lag_p90: 5.1,
      lag_share: 8.1,
      lag_over_day: 64,
      by_month: [
        { m: '2026-07', label: 'Jul 2026', n: 638, bench: 18.7, lag: 0.4 },
        { m: '2026-08', label: 'Aug 2026', n: 823, bench: 22.1, lag: 0.1 },
      ],
    },
    gating: {
      mixed: 776,
      late_mixed: 375,
      families: [
        {
          k: 'hplc',
          name: 'HPLC panel',
          department: 'analytical',
          n: 1746,
          med: 19.1,
          p90: 32.1,
          over_target: 420,
          over_pct: 24.1,
          gated: 260,
          gated_late: 152,
          gated_late_pct: 40.5,
        },
        {
          k: 'ster',
          name: 'Sterility',
          department: 'microbiology',
          n: 734,
          med: 19.8,
          p90: 37.1,
          over_target: 214,
          over_pct: 29.2,
          gated: 325,
          gated_late: 146,
          gated_late_pct: 38.9,
        },
      ],
      trend: [
        {
          m: '2026-07',
          label: 'Jul 2026',
          n: 261,
          late_total: 87,
          wait: 6,
          hplc: 16.1,
          hplc_n: 261,
          hplc_gate: 120,
          hplc_gate_late: 65,
          ster: 16.7,
          ster_n: 200,
          ster_gate: 40,
          ster_gate_late: 7,
        },
        {
          m: '2026-08',
          label: 'Aug 2026',
          n: 323,
          late_total: 199,
          wait: 8,
          hplc: 20,
          hplc_n: 323,
          hplc_gate: 100,
          hplc_gate_late: 52,
          ster: 22.2,
          ster_n: 260,
          ster_gate: 160,
          ster_gate_late: 94,
        },
      ],
      wait_med: 8,
      wait_p90: 16,
      wait_n: 460,
      wait_over_day: 158,
      min_late_for_trend: 5,
    },
    at_risk: {
      total: 320,
      late: 193,
      buckets: [
        { label: 'Already past target', n: 193 },
        { label: 'Under 4 hours left', n: 30 },
        { label: '4 to 8 hours left', n: 4 },
        { label: '8 or more hours left', n: 93 },
      ],
      status: { sample_received: 288, verified: 23 },
      rows: [
        {
          sid: 'P-0661',
          client: 'Acme Peptides',
          order: 'WP-1',
          status: 'sample_received',
          received: '2026-04-20',
          bh: 678.8,
          over: 654.8,
          families: ['hplc'],
        },
        {
          sid: 'P-2522',
          client: 'Beta Labs',
          order: 'WP-2',
          status: 'sample_received',
          received: '2026-09-08',
          bh: 23.9,
          over: -0.1,
          families: ['hplc', 'ster'],
        },
      ],
    },
    filters: { client: null, order: null, departments: [], families: [] },
    facets: {
      clients: [
        { name: 'Acme Peptides', samples: 120 },
        { name: 'Beta Labs', samples: 40 },
      ],
      departments: [
        { key: 'analytical', name: 'Analytical', samples: 300 },
        { key: 'microbiology', name: 'Microbiology', samples: 200 },
        { key: 'heavy_metals', name: 'Heavy Metals', samples: 0 },
      ],
      families: [
        {
          key: 'hplc',
          name: 'HPLC panel',
          department: 'analytical',
          samples: 280,
        },
        {
          key: 'ster',
          name: 'Sterility',
          department: 'microbiology',
          samples: 130,
        },
        {
          key: 'endo',
          name: 'Endotoxin',
          department: 'microbiology',
          samples: 70,
        },
      ],
    },
    cache: { stale: false, age_seconds: 3 },
    notes: {},
  }
}

function lastCall() {
  return mockGet.mock.calls[mockGet.mock.calls.length - 1]?.[0]
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SlaPerformanceReport />
    </QueryClientProvider>
  )
}

describe('SlaPerformanceReport', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockGet.mockResolvedValue(report())
  })

  it('renders the KPI row and every section heading', async () => {
    renderPage()
    expect(
      screen.getByRole('heading', { name: 'SLA Performance' })
    ).toBeInTheDocument()

    await waitFor(() =>
      expect(screen.getByText('On time, last 30 days')).toBeInTheDocument()
    )
    expect(screen.getByText('Median turnaround')).toBeInTheDocument()
    expect(screen.getByText('Open past target')).toBeInTheDocument()

    for (const name of [
      'Every sample received, by month',
      'How much is delivered by when',
      'Which department holds the COA',
      'Where the time goes',
      'Open work right now',
      'Definitions & data notes',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    }
  })

  it('shows the on-time rate and its fall against the prior window', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('48.3')).toBeInTheDocument())
    expect(screen.getByText('420 of 870 delivered')).toBeInTheDocument()
    expect(screen.getByText(/-25\.1 vs prior 30 days/)).toBeInTheDocument()
  })

  it('names the department that finished last on most late samples', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByText(
          /Sterility finished last on 47\.2% of late samples in Aug 2026/
        )
      ).toBeInTheDocument()
    )
  })

  it('lists each department with its own receipt-to-done timing', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: 'Departments' })
      ).toBeInTheDocument()
    )
    const rows = within(screen.getByRole('table', { name: 'Departments' }))
      .getAllByRole('row')
      .map(r => r.textContent ?? '')
    expect(rows.some(t => t.includes('Sterility') && t.includes('19.8'))).toBe(
      true
    )
    expect(rows.some(t => t.includes('HPLC panel') && t.includes('19.1'))).toBe(
      true
    )
  })

  it('shows the cohort table with the honest of-received rate', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: 'Cohorts by receipt month' })
      ).toBeInTheDocument()
    )
    const rows = within(
      screen.getByRole('table', { name: 'Cohorts by receipt month' })
    )
      .getAllByRole('row')
      .map(r => r.textContent ?? '')
    expect(
      rows.some(t => t.startsWith('Aug 2026') && t.includes('53.3%'))
    ).toBe(true)
    expect(rows.some(t => t.includes('Sep 2026(to date)'))).toBe(true)
  })

  it('lists the oldest open samples with how far past target they are', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: 'Oldest open samples' })
      ).toBeInTheDocument()
    )
    const table = within(
      screen.getByRole('table', { name: 'Oldest open samples' })
    )
    expect(table.getByText('P-0661')).toBeInTheDocument()
    expect(table.getByText('+654.8 over')).toBeInTheDocument()
    expect(table.getByText('0.1 left')).toBeInTheDocument()
  })

  it('refetches with includeTestOrders when the toggle is switched off', async () => {
    renderPage()
    await waitFor(() =>
      expect(lastCall()).toMatchObject({ includeTestOrders: false })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Hide test orders' }))
    await waitFor(() =>
      expect(lastCall()).toMatchObject({ includeTestOrders: true })
    )
  })

  it('refetches with the chosen department and offers its family sub-chips', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Microbiology' })
      ).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Microbiology' }))
    await waitFor(() =>
      expect(lastCall()).toMatchObject({
        departments: ['microbiology'],
        families: [],
      })
    )
    expect(
      screen.getByRole('button', { name: /^Sterility\s*130$/ })
    ).toBeInTheDocument()
  })

  it('refetches with the chosen customer', async () => {
    renderPage()
    const select = await screen.findByRole('combobox', { name: 'Customer' })
    // Options arrive with the facets; changing before then would be a no-op.
    await waitFor(() =>
      expect(
        within(select).getByRole('option', { name: /Beta Labs/ })
      ).toBeInTheDocument()
    )
    fireEvent.change(select, { target: { value: 'Beta Labs' } })
    await waitFor(() =>
      expect(lastCall()).toMatchObject({ client: 'Beta Labs' })
    )
  })

  it('says so when a selection has nothing to attribute', async () => {
    const empty = report()
    empty.gating = { ...empty.gating, late_mixed: 0, trend: [], families: [] }
    mockGet.mockResolvedValue(empty)
    renderPage()
    await waitFor(() =>
      expect(screen.getByText(/nothing to attribute/)).toBeInTheDocument()
    )
  })

  it('warns when the server served stale cached rows', async () => {
    const stale = report()
    stale.cache = { stale: true, age_seconds: 95 }
    mockGet.mockResolvedValue(stale)
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByText(/Integration Service unreachable/)
      ).toBeInTheDocument()
    )
  })

  it('shows the error state when the request fails', async () => {
    mockGet.mockRejectedValue(new Error('SLA performance failed: 503'))
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByText('Failed to load SLA performance data')
      ).toBeInTheDocument()
    )
  })
})
