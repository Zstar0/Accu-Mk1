import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cloneElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type * as Recharts from 'recharts'
import * as api from '@/lib/api'
import type { CustomerDossier } from '@/lib/api'
import { CustomerDashboard } from './CustomerDashboard'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api')
  return { ...actual, getCustomerDossier: vi.fn() }
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

function dossier(over: Partial<CustomerDossier['kpis']> = {}): CustomerDossier {
  return {
    tz: 'America/Los_Angeles',
    synced_at: null,
    identity: {
      key: 'wc:1188',
      name: 'Halcyon Research Supply',
      email: 'ops@h.example',
      company: 'Halcyon',
      wc_id: 1188,
      since: '2026-03-04T18:00:00Z',
    },
    kpis: {
      lifetime: '96110.00',
      rank: 3,
      customers: 782,
      orders: 31,
      avg_order: '3100.00',
      samples: 142,
      samples_per_order: 4.6,
      usual_gap_days: 9,
      gap_iqr: [6, 14],
      nonconforming_rate: 0.07,
      lab_nonconforming_rate: 0.103,
      on_time_rate: 0.83,
      lab_on_time_rate: 0.91,
      ...over,
    },
    status: 'at_risk',
    days_since_last: 45.2,
    overdue: 5.2,
    spend_delta_pct: -0.71,
    monthly: [
      { month: '2026-08', spend: '12000.00', samples: 40 },
      { month: '2026-09', spend: '4000.00', samples: 12 },
    ],
    order_dates: ['2026-08-12T18:00:00Z', '2026-08-21T18:00:00Z'],
    test_mix: [{ test: 'Endotoxin', share: 0.74, all_share: 0.31 }],
    analytes: [{ product: 'Retatrutide', coas: 21, pass_rate: 0.81 }],
    recent: [
      {
        order_number: '8642',
        paid_at: '2026-08-21T18:00:00Z',
        coas: 6,
        failed: 1,
        sla: 'late',
      },
      {
        order_number: '8580',
        paid_at: '2026-08-12T18:00:00Z',
        coas: 4,
        failed: 0,
        sla: null,
      },
    ],
    orders: [],
  }
}

function setup(value: CustomerDossier | null, onOpenAnalyte = vi.fn()) {
  vi.mocked(api.getCustomerDossier).mockResolvedValue(value)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CustomerDashboard customerKey="wc:1188" onOpenAnalyte={onOpenAnalyte} />
    </QueryClientProvider>
  )
  return onOpenAnalyte
}

describe('CustomerDashboard', () => {
  it('renders the at-risk banner, KPIs, analytes and the experience chips', async () => {
    const onOpenAnalyte = setup(dossier())
    expect(
      await screen.findByText(
        /No order in 45 days · usually orders every 9 days · 5.2× overdue/
      )
    ).toBeInTheDocument()
    expect(screen.getByText('$96,110')).toBeInTheDocument()
    expect(screen.getByText(/#3 of 782/)).toBeInTheDocument()
    const row = screen
      .getByRole('button', { name: 'Retatrutide' })
      .closest('tr')
    expect(row).toHaveTextContent('81%')
    expect(screen.getByText('late')).toBeInTheDocument()
    expect(screen.getByText('1 fail')).toBeInTheDocument()
    expect(screen.getByText('83%')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retatrutide' }))
    expect(onOpenAnalyte).toHaveBeenCalledWith('Retatrutide')
    expect(api.getCustomerDossier).toHaveBeenCalledWith('wc:1188')
  })

  it('shows n/a on-time and blank SLA chips when SLA data is unavailable', async () => {
    const d = dossier({ on_time_rate: null, lab_on_time_rate: null })
    d.recent = d.recent.map(r => ({ ...r, sla: null }))
    setup(d)
    const tile = (await screen.findByText('COAs on time')).parentElement
    expect(tile).toHaveTextContent('n/a')
    expect(screen.queryByText('on time')).not.toBeInTheDocument()
    expect(screen.queryByText('late')).not.toBeInTheDocument()
  })

  it('renders the empty state for a customer with no paid orders (404)', async () => {
    setup(null)
    expect(
      await screen.findByText('No paid orders for this customer yet')
    ).toBeInTheDocument()
  })
})
