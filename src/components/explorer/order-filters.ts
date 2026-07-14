import type { OrderSlaVerdict } from '@/lib/sla-resolution'
import type { ExplorerOrder, SenaiteLookupResult } from '@/lib/api'

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

/** True when any of the order's samples matches the lot query — against the
 *  payload's customer-entered `lot_code` (instant; present on the fetched
 *  order, positionally aligned with sample_results keys) OR the sample's
 *  loaded SENAITE `client_lot` (authoritative, lab-editable; refines as
 *  lookups arrive). Case-insensitive substring. Empty/whitespace query =
 *  no filter (matches). */
export function orderMatchesLot(
  order: ExplorerOrder,
  query: string,
  sampleLookupMap: Map<
    string,
    { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
  >
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (!order.sample_results) return false
  const payloadSamples = (
    order.payload as { samples?: { lot_code?: string }[] } | null | undefined
  )?.samples
  return Object.entries(order.sample_results).some(([key, v]) => {
    const idx = parseInt(key, 10) - 1
    const payloadLot = Number.isNaN(idx)
      ? undefined
      : payloadSamples?.[idx]?.lot_code
    if (payloadLot?.toLowerCase().includes(q)) return true
    if (!v.senaite_id) return false
    const clientLot = sampleLookupMap.get(v.senaite_id)?.data?.client_lot
    return clientLot?.toLowerCase().includes(q) ?? false
  })
}
