import { describe, expect, it } from 'vitest'

import type { CustomerRow as InsightRow, ExplorerCustomer } from '@/lib/api'
import {
  NO_INSIGHT,
  UNASSIGNED,
  sortAndFilter,
  type ListRow,
} from './customer-list'

const cust = (
  id: number | null,
  name: string,
  orders: number
): ExplorerCustomer => ({
  customer_id: id,
  email: `${name.toLowerCase()}@x.example`,
  display_name: name,
  company_name: null,
  total_orders: orders,
  outstanding_orders: 0,
  total_coas: 0,
  most_recent_order_at: null,
})

const ins = (
  key: string,
  spend: string,
  status: string,
  rep: string | null
): InsightRow => ({
  key,
  name: key,
  email: null,
  company: null,
  rep,
  period_spend: spend,
  prior_spend: '0.00',
  delta_pct: null,
  lifetime: spend,
  orders: 1,
  samples: 1,
  usual_gap_days: null,
  last_order_at: null,
  top_tests: [],
  status,
  monthly: [],
})

const rows: ListRow[] = [
  {
    customer: cust(1, 'Alpha', 3),
    insight: ins('wc:1', '900.00', 'growing', 'Scott'),
  },
  {
    customer: cust(2, 'Bravo', 9),
    insight: ins('wc:2', '100.00', 'at_risk', null),
  },
  { customer: cust(3, 'Charlie', 1) },
  {
    customer: cust(null, 'guest', 5),
    insight: ins('email:guest@x.example', '50.00', 'at_risk', 'Scott'),
  },
]
const names = (rs: ListRow[]) => rs.map(r => r.customer.email.split('@')[0])

describe('sortAndFilter', () => {
  it('sorts numerically by insight money, rows without a value last in both directions', () => {
    const none = { status: '', rep: '' }
    expect(
      names(sortAndFilter(rows, { key: 'period_spend', dir: 'desc' }, none))
    ).toEqual(['alpha', 'bravo', 'guest', 'charlie'])
    expect(
      names(sortAndFilter(rows, { key: 'period_spend', dir: 'asc' }, none))
    ).toEqual(['guest', 'bravo', 'alpha', 'charlie'])
    expect(
      names(sortAndFilter(rows, { key: 'total_orders', dir: 'desc' }, none))
    ).toEqual(['bravo', 'guest', 'alpha', 'charlie'])
    // guests have no display name: last
    expect(
      names(sortAndFilter(rows, { key: 'name', dir: 'asc' }, none))
    ).toEqual(['alpha', 'bravo', 'charlie', 'guest'])
  })

  it('filters by status, rep, unassigned and no-insight', () => {
    const s = { key: 'email' as const, dir: 'asc' as const }
    expect(
      names(sortAndFilter(rows, s, { status: 'at_risk', rep: '' }))
    ).toEqual(['bravo', 'guest'])
    expect(
      names(sortAndFilter(rows, s, { status: 'at_risk', rep: 'Scott' }))
    ).toEqual(['guest'])
    expect(
      names(sortAndFilter(rows, s, { status: '', rep: UNASSIGNED }))
    ).toEqual(['bravo', 'charlie'])
    expect(
      names(sortAndFilter(rows, s, { status: NO_INSIGHT, rep: '' }))
    ).toEqual(['charlie'])
  })
})
