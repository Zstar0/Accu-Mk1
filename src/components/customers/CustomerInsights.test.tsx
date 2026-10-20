import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cloneElement, type ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Recharts from 'recharts'
import * as api from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { CustomerInsights } from './CustomerInsights'
import { row } from './insights-test-fixtures'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api')
  return {
    ...actual,
    getCustomerSummary: vi.fn(),
    getCustomerCohorts: vi.fn(),
    getCustomerAtRisk: vi.fn(),
    getCustomerChurnSignals: vi.fn(),
    getCustomerTouchpoints: vi.fn(),
    getCustomerList: vi.fn(),
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

const EMPTY_LIST: api.CustomerListResponse = {
  tz: 'America/Los_Angeles',
  synced_at: null,
  total: 0,
  page: 1,
  page_size: 25,
  rows: [],
}
const listOf = (total: number, rows: api.CustomerListResponse['rows']) => ({
  ...EMPTY_LIST,
  total,
  rows,
})
const CRM_OK: api.CrmTouch = {
  state: 'ok',
  at: '2026-10-12T15:00:00Z',
  type: 'email',
  direction: 'outbound',
  who: 'Scott',
  title: 'Checking in',
  preview: '',
  lead_name: 'Halcyon',
  lead_url: null,
  stale: false,
  reason: null,
}
const CRM_ONLY: api.TouchpointsResponse = {
  crm_visible: true,
  support_visible: false,
  rows: { 'wc:1': { crm: CRM_OK, support: null } },
}

function setup({
  riskFails = false,
  onOpen = vi.fn(),
  list = EMPTY_LIST,
  touch = CRM_ONLY,
}: {
  riskFails?: boolean
  onOpen?: (key: string, tab?: 'crm' | 'support') => void
  list?: api.CustomerListResponse
  touch?: api.TouchpointsResponse
} = {}) {
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
    product_prices: [
      {
        product: 'Endotoxin Addon',
        units: 160,
        avg_price: '117.09',
        revenue: '18734.40',
        customers: 52,
        free_units: 3,
        list_price: '135.00',
        discount_pct: 0.1327,
      },
    ],
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
        rep: 'Scott Joseph',
        period_spend: '12400.00',
        prior_spend: '42000.00',
        delta_pct: -0.71,
        lifetime: '96110.00',
        orders: 31,
        samples: 142,
        usual_gap_days: 9,
        last_order_at: '2026-08-21T15:00:00Z',
        first_order_at: '2026-03-02T15:00:00Z',
        testing_orders: 29,
        top_tests: ['HPLC'],
        status: 'at_risk',
        monthly: [],
        spend_12m: '84210.00',
        overdue: 5.2,
      },
    ],
  })
  vi.mocked(api.getCustomerChurnSignals).mockResolvedValue({
    tz: 'America/Los_Angeles',
    synced_at: null,
    window_days: 60,
    buckets: [
      { signal: 'conformance', group: 'all_pass', orders: 120, returned: 0.61 },
      { signal: 'conformance', group: 'any_fail', orders: 14, returned: 0.36 },
    ],
  })
  vi.mocked(api.getCustomerTouchpoints).mockResolvedValue(touch)
  vi.mocked(api.getCustomerList).mockResolvedValue(list)
  if (riskFails)
    vi.mocked(api.getCustomerAtRisk).mockRejectedValue(new Error('boom'))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CustomerInsights onOpenCustomer={onOpen} />
    </QueryClientProvider>
  )
}

describe('CustomerInsights', () => {
  beforeEach(() => {
    useUIStore.setState({
      insightsView: {
        tab: 'at-risk',
        period: '90d',
        cohort: null,
        month: null,
      },
    })
  })

  it('renders KPIs, at-risk row and freshness line', async () => {
    setup()
    expect(await screen.findByText('$1.07M')).toBeInTheDocument()
    expect(screen.getByText('24.0%')).toBeInTheDocument()
    expect(
      await screen.findByText('Halcyon Research Supply')
    ).toBeInTheDocument()
    expect(screen.getByText('5.2× gap')).toBeInTheDocument()
    expect(screen.getByText(/orders synced/i)).toBeInTheDocument()
    expect(
      await screen.findByText('Got a non-conforming COA')
    ).toBeInTheDocument()
    expect(screen.getByText('n = 14')).toBeInTheDocument()
    expect(screen.getByText(/Correlation, not proof/)).toBeInTheDocument()
    const priceRow = screen.getByText('Endotoxin Addon').closest('tr')
    expect(priceRow).toHaveTextContent('$117.09')
    expect(priceRow).toHaveTextContent('-13%')
    expect(priceRow).toHaveTextContent('$135.00')
    expect(
      screen.getByText('Halcyon Research Supply').closest('tr')
    ).toHaveTextContent('Scott Joseph')
    for (const h of [
      'First order → comes back? (all time)',
      'Add-on attach rate (all time)',
      'Revenue concentration (all time)',
    ])
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument()
  })

  it('shows an error with Retry, and a plain At risk tab label, when at-risk fails', async () => {
    setup({ riskFails: true })
    expect(
      await screen.findByText(/Failed to load at-risk customers/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'At risk' })).toBeInTheDocument()
  })

  it('shows Last support and not Last CRM to a support-only reader', async () => {
    setup({
      touch: {
        crm_visible: false,
        support_visible: true,
        rows: {
          'wc:1': {
            crm: null,
            support: {
              state: 'ok',
              at: '2026-10-10T15:00:00Z',
              thread_id: 'th_1',
              title: 'COA question',
              status: 'done',
              waiting_since: null,
              plain_url: null,
              open_count: 0,
              stale: false,
              reason: null,
            },
          },
        },
      },
    })
    expect(
      await screen.findByRole('columnheader', { name: 'Last support' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Last CRM' })).toBeNull()
  })

  it('fetches touches only for the visible tab', async () => {
    vi.mocked(api.getCustomerTouchpoints).mockClear()
    setup({
      list: listOf(1, [row({ key: 'wc:2243', name: 'Zackary Smith' })]),
    })
    // The New customers page has loaded (its count is on the tab) while At risk shows.
    expect(
      await screen.findByRole('tab', { name: 'New customers (1)' })
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(vi.mocked(api.getCustomerTouchpoints)).toHaveBeenCalledWith([
        'wc:1',
      ])
    )
    expect(vi.mocked(api.getCustomerTouchpoints)).not.toHaveBeenCalledWith([
      'wc:2243',
    ])
    await userEvent.click(screen.getByRole('tab', { name: /New customers/ }))
    await waitFor(() =>
      expect(vi.mocked(api.getCustomerTouchpoints)).toHaveBeenCalledWith([
        'wc:2243',
      ])
    )
  })

  it('has three tabs, shows the CRM touch on the at-risk row and opens the CRM tab from it', async () => {
    const onOpen = vi.fn()
    setup({ onOpen })
    expect(
      await screen.findByRole('tab', { name: /At risk/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: /New customers/ })
    ).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Cohorts/ })).toBeInTheDocument()
    const row = (await screen.findByText('Halcyon Research Supply')).closest(
      'tr'
    ) as HTMLElement
    expect(row).toHaveTextContent('Oct 12')
    expect(
      screen.getByRole('columnheader', { name: 'Last CRM' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('columnheader', { name: 'Last support' })
    ).toBeNull()
    await userEvent.click(within(row).getByRole('button'))
    expect(onOpen).toHaveBeenCalledWith('wc:1', 'crm')
    await userEvent.click(within(row).getByText('Halcyon Research Supply'))
    expect(onOpen).toHaveBeenLastCalledWith('wc:1')
  })

  it('New customers tab queries new_only with the period and the launch switch', async () => {
    setup({ list: listOf(1, [row({ key: 'wc:2243', name: 'Zackary Smith' })]) })
    await userEvent.click(
      await screen.findByRole('tab', { name: /New customers/ })
    )
    expect(await screen.findByText('Zackary Smith')).toBeInTheDocument()
    expect(vi.mocked(api.getCustomerList)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        new_only: true,
        period: '90d',
        exclude_launch_accounts: false,
        sort: 'lifetime',
        dir: 'desc',
        page: 1,
        page_size: 25,
      })
    )
    expect(
      screen.getByText(
        'First testing order in this period, ranked by lifetime spend'
      )
    ).toBeInTheDocument()
  })

  it('resets New customers paging when the period or launch switch changes', async () => {
    setup({
      list: listOf(60, [row({ key: 'wc:2243', name: 'Zackary Smith' })]),
    })
    await userEvent.click(
      await screen.findByRole('tab', { name: /New customers/ })
    )
    await screen.findByText('Zackary Smith')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() =>
      expect(vi.mocked(api.getCustomerList)).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 })
      )
    )
    const reset = expect.objectContaining({
      page: 1,
      sort: 'lifetime',
      dir: 'desc',
    })
    await userEvent.click(screen.getByRole('button', { name: '30D' }))
    await waitFor(() =>
      expect(vi.mocked(api.getCustomerList)).toHaveBeenLastCalledWith(
        expect.objectContaining({ period: '30d', page: 1 })
      )
    )
    await userEvent.click(screen.getByRole('button', { name: '90D' }))
    await waitFor(() =>
      expect(vi.mocked(api.getCustomerList)).toHaveBeenLastCalledWith(reset)
    )
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(
      screen.getByRole('switch', { name: 'Exclude launch accounts' })
    )
    await waitFor(() =>
      expect(vi.mocked(api.getCustomerList)).toHaveBeenLastCalledWith(
        expect.objectContaining({ exclude_launch_accounts: true, page: 1 })
      )
    )
  })

  it('Cohorts tab shows the grid, drills into members with the right query, and keeps the selection in the store', async () => {
    setup({ list: listOf(41, [row({ key: 'wc:9', name: 'Member One' })]) })
    await userEvent.click(await screen.findByRole('tab', { name: /Cohorts/ }))
    expect(await screen.findByText('12.9%')).toBeInTheDocument()
    expect(
      screen.getByText('Pick a cohort to see its customers')
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: /2026-08 M1 12\.9%/ })
    )
    expect(await screen.findByText('Member One')).toBeInTheDocument()
    expect(
      screen.getByText('2026-08 cohort · came back in M1 (2026-09) · 41 of 163')
    ).toBeInTheDocument()
    expect(vi.mocked(api.getCustomerList)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cohort: '2026-08',
        returned_in: '2026-09',
        exclude_launch_accounts: true,
        period: 'all',
        sort: 'lifetime',
        dir: 'desc',
      })
    )
    expect(useUIStore.getState().insightsView).toMatchObject({
      tab: 'cohorts',
      cohort: '2026-08',
      month: 'M1',
    })
  })
})
