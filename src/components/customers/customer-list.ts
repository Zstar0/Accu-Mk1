import type { CustomerRow as InsightRow, ExplorerCustomer } from '@/lib/api'

/** One Customers-list row: the explorer customer plus its 90d insight (if any). */
export interface ListRow {
  customer: ExplorerCustomer
  insight?: InsightRow
}

export type SortKey =
  | 'name'
  | 'email'
  | 'total_orders'
  | 'outstanding_orders'
  | 'total_coas'
  | 'most_recent_order_at'
  | 'period_spend'
  | 'delta_pct'
  | 'lifetime'
  | 'samples'
  | 'usual_gap_days'
  | 'rep'
  | 'status'

export interface ListSort {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** '' = any; UNASSIGNED = no rep; NO_INSIGHT = no paid orders in the insight set. */
export interface ListFilters {
  status: string
  rep: string
}

export const UNASSIGNED = '__unassigned__'
export const NO_INSIGHT = '__none__'

export const customerKey = (c: ExplorerCustomer): string =>
  c.customer_id !== null
    ? `wc:${c.customer_id}`
    : `email:${c.email.toLowerCase()}`

function sortValue(r: ListRow, key: SortKey): string | number | null {
  const c = r.customer
  const i = r.insight
  switch (key) {
    case 'name':
      return c.customer_id !== null ? c.display_name.toLowerCase() : null
    case 'email':
      return c.email.toLowerCase()
    case 'total_orders':
    case 'outstanding_orders':
    case 'total_coas':
      return c[key]
    case 'most_recent_order_at':
      return c.most_recent_order_at
    case 'period_spend':
    case 'lifetime':
      return i ? Number(i[key]) : null
    case 'delta_pct':
    case 'usual_gap_days':
      return i?.[key] ?? null
    case 'samples':
      return i ? i.samples : null
    case 'rep':
      return i?.rep?.toLowerCase() ?? null
    case 'status':
      return i?.status ?? null
  }
}

/** Filter then sort. Rows with no value for the sort key always go last. */
export function sortAndFilter(
  rows: ListRow[],
  sort: ListSort,
  filters: ListFilters
): ListRow[] {
  const kept = rows.filter(r => {
    if (filters.status) {
      const s = r.insight?.status ?? NO_INSIGHT
      if (s !== filters.status) return false
    }
    if (filters.rep) {
      const rep = r.insight?.rep ?? UNASSIGNED
      if (rep !== filters.rep) return false
    }
    return true
  })
  const sign = sort.dir === 'asc' ? 1 : -1
  return kept
    .map(r => ({ r, v: sortValue(r, sort.key) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return 0
      if (a.v === null) return 1
      if (b.v === null) return -1
      return a.v < b.v ? -sign : a.v > b.v ? sign : 0
    })
    .map(x => x.r)
}
