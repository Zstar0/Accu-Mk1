import type { ExplorerOrder, SenaiteSample } from '@/lib/api'

export interface OrderGroup {
  orderKey: string | null
  orderLabel: string
  clientId: string | null
  samples: SenaiteSample[]
}

export interface EnrichedOrderGroup extends OrderGroup {
  order: ExplorerOrder | null
}

// Integration `order_submissions` store `order_number` as the bare number
// (e.g. "3267"), but the SENAITE `client_order_number` used as a group's
// `orderKey` carries a "WP-" prefix (e.g. "WP-3267"). Normalize both sides by
// stripping a leading case-insensitive "WP-" before matching (a no-op if the
// value is already bare).
const stripWp = (s: string): string => s.replace(/^WP-/i, '')

/**
 * Join order groups to their `ExplorerOrder` by `order_number`. Groups with no
 * order key (the "No order" bucket) or no matching order get `order: null`.
 */
export function enrichOrderGroups(
  groups: OrderGroup[],
  orders: ExplorerOrder[],
): EnrichedOrderGroup[] {
  const byNumber = new Map(orders.map(o => [stripWp(o.order_number), o]))
  return groups.map(g => ({
    ...g,
    order: g.orderKey ? (byNumber.get(stripWp(g.orderKey)) ?? null) : null,
  }))
}

/**
 * Build a navigation hash to a customer: the customer-detail deep link when an
 * id is set, else the customers list. Mirrors the `accumark-tools/customer-detail`
 * route in `src/lib/hash-navigation.ts`.
 */
export function customerDetailHash(customerId: number | null): string {
  return customerId != null
    ? `#accumark-tools/customer-detail?id=${encodeURIComponent(String(customerId))}`
    : '#accumark-tools/customers'
}

export function groupSamplesByOrder(samples: SenaiteSample[]): OrderGroup[] {
  const byOrder = new Map<string | null, SenaiteSample[]>()
  for (const sample of samples) {
    const key = sample.client_order_number || null
    const list = byOrder.get(key)
    if (list) list.push(sample)
    else byOrder.set(key, [sample])
  }
  const groups: OrderGroup[] = Array.from(byOrder.entries()).map(([orderKey, group]) => ({
    orderKey,
    orderLabel: orderKey ?? 'No order',
    clientId: group[0]?.client_id ?? null,
    samples: group,
  }))
  groups.sort((a, b) => {
    if ((a.orderKey === null) !== (b.orderKey === null)) return a.orderKey === null ? 1 : -1
    return (a.orderKey ?? '').localeCompare(b.orderKey ?? '', undefined, { numeric: true })
  })
  return groups
}
