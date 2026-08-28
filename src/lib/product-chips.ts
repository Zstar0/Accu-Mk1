// Product-chip derivation for order-payload samples (v1.11.8).
//
// The Order Status page shows product chips without any per-sample fetch:
// `order.payload.samples[i].services` is a boolean map of profile wire keys
// written at checkout, and the analysis-profiles catalog supplies the label,
// add-on flag, and fulfillment_role (which drives the role-catalog color —
// the same source the boxing lanes and RoleBadge use). Positional contract:
// sample_results key "1" ↔ payload.samples[0], same as analyte/lot.

import type { AnalysisProfile, ExplorerOrder, OrderedProduct } from '@/lib/api'

/** The wire's `services` map for one payload sample. `variance` rides as an
 *  object (per-profile vial counts) or null; `samplevariance` is the boolean
 *  alias for the same selection — either signals the variance profile. */
export type PayloadSampleServices = Record<
  string,
  boolean | Record<string, number> | null | undefined
>

/** Resolve one payload sample's `services` map to display products, in
 *  catalog sort order. Keys with no matching profile (e.g. the unsold
 *  `residualsolvents`) are skipped — chips stay catalog-truthful. */
export function productsFromPayloadServices(
  services: PayloadSampleServices | null | undefined,
  profiles: AnalysisProfile[]
): OrderedProduct[] {
  if (!services) return []
  const varianceSelected =
    services['samplevariance'] === true ||
    (typeof services['variance'] === 'object' && services['variance'] !== null)
  const out: OrderedProduct[] = []
  for (const p of [...profiles].sort((a, b) => a.sort_order - b.sort_order)) {
    const selected =
      p.key === 'variance' ? varianceSelected : services[p.key] === true
    if (!selected) continue
    out.push({
      key: p.key,
      label: p.name,
      is_addon: p.is_addon,
      fulfillment_role: p.fulfillment_role,
      fulfillment_dim: p.fulfillment_dim,
    })
  }
  return out
}

/** senaite_id -> products for every sample of every order, from the orders'
 *  own payloads. One pass; orders without payload samples contribute
 *  nothing (their cards just render no chips). */
export function buildProductsBySampleId(
  orders: ExplorerOrder[],
  profiles: AnalysisProfile[]
): Map<string, OrderedProduct[]> {
  const map = new Map<string, OrderedProduct[]>()
  if (profiles.length === 0) return map
  for (const order of orders) {
    if (!order.sample_results) continue
    const payloadSamples = (
      order.payload as
        | { samples?: { services?: PayloadSampleServices }[] }
        | null
        | undefined
    )?.samples
    if (!payloadSamples) continue
    for (const [slotKey, entry] of Object.entries(order.sample_results)) {
      if (!entry.senaite_id) continue
      const slotIdx = parseInt(slotKey, 10) - 1
      if (Number.isNaN(slotIdx)) continue
      const products = productsFromPayloadServices(
        payloadSamples[slotIdx]?.services,
        profiles
      )
      if (products.length > 0) map.set(entry.senaite_id, products)
    }
  }
  return map
}
