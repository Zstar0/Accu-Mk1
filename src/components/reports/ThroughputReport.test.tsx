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
import {
  getThroughput,
  type ThroughputDay,
  type ThroughputReport as Report,
} from '@/lib/api'
import { ThroughputReport } from './ThroughputReport'

vi.mock('@/lib/api', () => ({
  getThroughput: vi.fn(),
}))
const mockGet = vi.mocked(getThroughput)

// jsdom has no layout, so ResponsiveContainer would hand its chart a 0×0 box.
// Give the chart a fixed size instead; the chart internals are recharts' job.
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

function day(d: string, over: Partial<ThroughputDay> = {}): ThroughputDay {
  const dt = new Date(`${d}T00:00:00Z`)
  const dow = (dt.getUTCDay() + 6) % 7
  return {
    d,
    dow,
    biz: dow < 5,
    hol: false,
    samples: 0,
    cancelled: 0,
    hplc: 0,
    ster: 0,
    endo: 0,
    bacw: 0,
    hm: 0,
    other: 0,
    tests: 0,
    vials: 0,
    retest: 0,
    clients: 0,
    coa: 0,
    acoa: 0,
    fp: 0,
    bench_rows: 0,
    bench_vials: 0,
    bench_inst: {},
    backlog: 0,
    ...over,
  }
}

function report(): Report {
  const days: ThroughputDay[] = []
  const start = new Date('2026-06-01T00:00:00Z')
  for (let i = 0; i < 100; i++) {
    const iso = new Date(start.getTime() + i * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const d = day(iso)
    if (d.biz) {
      days.push({
        ...d,
        samples: 4,
        hplc: 4,
        ster: 2,
        endo: 1,
        tests: 7,
        vials: 8,
        clients: 3,
        coa: 3,
        fp: 3,
        bench_rows: 6,
        bench_vials: 5,
        bench_inst: { '1290a': 3, '1290b': 2 },
        backlog: 10 + (i % 5),
      })
    } else {
      days.push({ ...d, backlog: 10 + (i % 5) })
    }
  }
  return {
    start: '2026-06-01',
    end: '2026-09-08',
    today: '2026-09-08',
    tz: 'America/Los_Angeles',
    generated_at: '2026-09-08T20:00:00Z',
    instruments: ['1290a', '1290b'],
    holidays: ['2026-07-03'],
    days,
    backlog_now: {
      total: 14,
      status: { sample_received: 9, waiting_for_addon_results: 5 },
      age: { '0-2d': 6, '3-7d': 3, '>30d': 5 },
    },
    filters: { client: null, order: null, departments: [], families: [] },
    facets: {
      clients: [
        { name: 'Acme Peptides', samples: 120 },
        { name: 'Beta Labs', samples: 40 },
      ],
      departments: [
        { key: 'analytical', name: 'Analytical', tests: 300 },
        { key: 'microbiology', name: 'Microbiology', tests: 200 },
        { key: 'heavy_metals', name: 'Heavy Metals', tests: 0 },
      ],
      families: [
        {
          key: 'hplc',
          name: 'HPLC panel',
          department: 'analytical',
          tests: 280,
        },
        {
          key: 'ster',
          name: 'Sterility',
          department: 'microbiology',
          tests: 130,
        },
        {
          key: 'endo',
          name: 'Endotoxin',
          department: 'microbiology',
          tests: 70,
        },
        {
          key: 'bacw',
          name: 'Bac Water panel',
          department: 'analytical',
          tests: 20,
        },
        {
          key: 'hm',
          name: 'Heavy metals',
          department: 'heavy_metals',
          tests: 0,
        },
        { key: 'other', name: 'Other', department: 'analytical', tests: 0 },
      ],
    },
    cache: { stale: false, age_seconds: 3 },
    notes: { jan_excluded: true, vials_from: '2026-06', bench_from: '2026-03' },
  }
}

function lastCall() {
  return mockGet.mock.calls[mockGet.mock.calls.length - 1]?.[0]
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ThroughputReport />
    </QueryClientProvider>
  )
}

describe('ThroughputReport', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockGet.mockResolvedValue(report())
  })

  it('renders the header, KPI cards and section headings from the report', async () => {
    renderPage()
    expect(
      screen.getByRole('heading', { name: 'Lab Throughput' })
    ).toBeInTheDocument()

    await waitFor(() =>
      expect(screen.getByText('Tests / business day')).toBeInTheDocument()
    )
    expect(screen.getByText('Samples / business day')).toBeInTheDocument()
    expect(
      screen.getByText('COAs published / business day')
    ).toBeInTheDocument()
    expect(
      screen.getByText('HPLC vials run / business day')
    ).toBeInTheDocument()
    expect(screen.getByText('Add-on attach rate')).toBeInTheDocument()
    expect(screen.getByText('Open backlog now')).toBeInTheDocument()

    expect(
      screen.getByRole('heading', { name: 'Tests received per day, by type' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Tests received per week' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Intake vs output, weekly' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Open samples (backlog)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Month by month' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: 'HPLC bench: vials processed per day',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Day-of-week profile' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Add-on attach rate by month' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Definitions & data notes' })
    ).toBeInTheDocument()
  })

  it('shows the open backlog split into stale and live', async () => {
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Open backlog now')).toBeInTheDocument()
    )
    expect(screen.getByText(/5 older than 30 days/)).toBeInTheDocument()
    expect(screen.getByText(/9 live/)).toBeInTheDocument()
  })

  it('refetches with includeTestOrders when "Hide test orders" is toggled off', async () => {
    renderPage()
    await waitFor(() =>
      expect(lastCall()).toMatchObject({ includeTestOrders: false })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Hide test orders' }))

    await waitFor(() =>
      expect(lastCall()).toMatchObject({ includeTestOrders: true })
    )
  })

  it('renders department chips from the facets and refetches with the chosen department', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Microbiology' })
      ).toBeInTheDocument()
    )
    expect(
      screen.getByRole('button', { name: 'All departments' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Heavy Metals' })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Microbiology' }))

    await waitFor(() =>
      expect(lastCall()).toMatchObject({
        departments: ['microbiology'],
        families: [],
      })
    )
    // Family sub-chips for the chosen department, with their facet counts.
    expect(
      screen.getByRole('button', { name: /^Sterility\s*130$/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^Endotoxin\s*70$/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^HPLC panel/ })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Endotoxin\s*70$/ }))
    await waitFor(() =>
      expect(lastCall()).toMatchObject({
        departments: ['microbiology'],
        families: ['endo'],
      })
    )
  })

  it('filters the customers from the facets as you type and refetches with the chosen one', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Customer' })
      ).toBeInTheDocument()
    )
    const box = screen.getByRole('combobox', { name: 'Customer' })
    // The box is on screen before the data; its options arrive with the facets.
    fireEvent.focus(box)
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: /Acme Peptides/ })
      ).toBeInTheDocument()
    )

    // Typing narrows the list without refetching.
    const before = mockGet.mock.calls.length
    fireEvent.change(box, { target: { value: 'beta' } })
    expect(
      screen.queryByRole('option', { name: /Acme Peptides/ })
    ).not.toBeInTheDocument()
    expect(mockGet.mock.calls).toHaveLength(before)

    fireEvent.click(screen.getByRole('option', { name: /Beta Labs/ }))

    await waitFor(() =>
      expect(lastCall()).toMatchObject({ client: 'Beta Labs' })
    )
    expect(box).toHaveValue('Beta Labs')
  })

  it('clears the customer box along with the other filters', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Customer' })
      ).toBeInTheDocument()
    )
    const box = screen.getByRole('combobox', { name: 'Customer' })
    fireEvent.focus(box)
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: /Beta Labs/ })
      ).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('option', { name: /Beta Labs/ }))
    await waitFor(() =>
      expect(lastCall()).toMatchObject({ client: 'Beta Labs' })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    // Back to the unscoped report: the box empties and the Clear button goes.
    await waitFor(() => expect(box).toHaveValue(''))
    expect(
      screen.queryByRole('button', { name: 'Clear filters' })
    ).not.toBeInTheDocument()
  })

  it('refetches with the order number typed into the Order # box', async () => {
    renderPage()
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Order #')).toBeInTheDocument()
    )

    fireEvent.change(screen.getByPlaceholderText('Order #'), {
      target: { value: '3271' },
    })

    await waitFor(() => expect(lastCall()).toMatchObject({ order: '3271' }))
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

  it('lists every month in the monthly table with the partial month flagged', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: 'Month by month' })
      ).toBeInTheDocument()
    )
    const table = within(screen.getByRole('table', { name: 'Month by month' }))
    const labels = table.getAllByRole('row').map(r => r.textContent ?? '')
    expect(labels.some(t => t.startsWith('Jun 2026'))).toBe(true)
    expect(labels.some(t => t.startsWith('Jul 2026'))).toBe(true)
    expect(labels.some(t => t.startsWith('Aug 2026'))).toBe(true)
    expect(labels.some(t => t.startsWith('Sep 2026(to date)'))).toBe(true)
    expect(labels.some(t => t.startsWith('Total'))).toBe(true)
  })

  it('shows the Heavy metals family in the legend only when the data has it', async () => {
    const withHm = report()
    const base = withHm.days[10]
    if (!base) throw new Error('fixture has no day 10')
    withHm.days[10] = { ...base, hm: 1, tests: base.tests + 1 }
    mockGet.mockResolvedValue(withHm)
    renderPage()
    await waitFor(() =>
      expect(screen.getAllByText('Heavy metals').length).toBeGreaterThan(0)
    )
    expect(screen.queryByText('Other')).not.toBeInTheDocument()
  })

  it('shows the error state when the request fails', async () => {
    mockGet.mockRejectedValue(new Error('Throughput failed: 503'))
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByText('Failed to load throughput data')
      ).toBeInTheDocument()
    )
  })
})
