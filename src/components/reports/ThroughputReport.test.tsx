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
    notes: { jan_excluded: true, vials_from: '2026-06', bench_from: '2026-03' },
  }
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

  it('refetches with include_test_orders when "Hide test orders" is unticked', async () => {
    renderPage()
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(false))

    fireEvent.click(screen.getByRole('checkbox', { name: /hide test orders/i }))

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(true))
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
