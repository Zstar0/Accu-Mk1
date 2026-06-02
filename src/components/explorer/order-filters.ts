import type { OrderSlaVerdict } from '@/lib/sla-resolution'

/** Toggle a key in a filter-key array: remove it if present, append it if
 *  absent. Pure — never mutates the input. Drives multi-select stage filters. */
export function toggleFilterKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]
}

/** An order is "at risk" when its SLA verdict is approaching the target (amber)
 *  or overdue (red). green / met / awaiting / loading / error / no-verdict are
 *  not at risk. Drives the "SLA at-risk" filter toggle. */
export function isOrderAtRisk(verdict: OrderSlaVerdict | undefined): boolean {
  return verdict?.color === 'red' || verdict?.color === 'amber'
}
