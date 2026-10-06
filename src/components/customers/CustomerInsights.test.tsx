import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cloneElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type * as Recharts from 'recharts'
import * as api from '@/lib/api'
import { CustomerInsights } from './CustomerInsights'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api')
  return {
    ...actual,
    getCustomerSummary: vi.fn(),
    getCustomerCohorts: vi.fn(),
    getCustomerAtRisk: vi.fn(),
  }
})
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof Recharts>()
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: ReactElement<{ width?: number; height?: number }>
    }) => cloneElement(children, { width: 800, height: 240 }),
  }
})

const k = <T,>(value: T, prior: T | null = null) => ({ value, prior })

function setup() {
  vi.mocked(api.getCustomerSummary).mockResolvedValue({
    tz: 'America/Los_Angeles',
    synced_at: '2026-10-05T18:00:00Z',
    kpis: {
      active_customers: k(412, 378),
      revenue: k('1070000.00', '1010000.00'),
      paid_orders: k(1893, 1705),
      aov: k('566.00', '590.00'),
      repeat_rate: k(0.24, 0.271),
      median_days_to_second: k(10, 10),
    },
    revenue_by_month: [
      { month: '2026-09', new: '132000.00', returning: '234000.00' },
    ],
    concentration: {
      top10_share: 0.41,
      top_decile_share: 0.858,
      repeat_share: 0.882,
      median_ltv: '125.00',
      mean_ltv: '1861.00',
      customers: 782,
    },
    attach: [{ test: 'Endotoxin', new: 0.12, returning: 0.68 }],
    first_order: [{ kind: 'accutry50', customers: 273, repeat_rate: 0.14 }],
  })
  vi.mocked(api.getCustomerCohorts).mockResolvedValue({
    tz: 'America/Los_Angeles',
    synced_at: null,
    months: ['M1', 'M2'],
    rows: [{ cohort: '2026-08', size: 163, cells: [0.129, null] }],
  })
  vi.mocked(api.getCustomerAtRisk).mockResolvedValue({
    tz: 'America/Los_Angeles',
    synced_at: null,
    rows: [
      {
        key: 'wc:1',
        name: 'Halcyon Research Supply',
        email: 'ops@h.example',
        company: null,
        period_spend: '12400.00',
        prior_spend: '42000.00',
        delta_pct: -0.71,
        lifetime: '96110.00',
        orders: 31,
        samples: 142,
        usual_gap_days: 9,
        last_order_at: '2026-08-21T15:00:00Z',
        top_tests: ['HPLC'],
        status: 'at_risk',
        monthly: [],
        spend_12m: '84210.00',
        overdue: 5.2,
      },
    ],
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CustomerInsights onOpenCustomer={vi.fn()} />
    </QueryClientProvider>
  )
}

describe('CustomerInsights', () => {
  it('renders KPIs, cohort cell, at-risk row and freshness line', async () => {
    setup()
    expect(await screen.findByText('$1.07M')).toBeInTheDocument()
    expect(screen.getByText('24.0%')).toBeInTheDocument()
    expect(await screen.findByText('12.9%')).toBeInTheDocument()
    expect(
      await screen.findByText('Halcyon Research Supply')
    ).toBeInTheDocument()
    expect(screen.getByText('5.2× gap')).toBeInTheDocument()
    expect(screen.getByText(/orders synced/i)).toBeInTheDocument()
  })
})
