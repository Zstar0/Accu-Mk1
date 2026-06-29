import type { SenaiteSample } from '@/lib/api'

export interface OrderGroup {
  orderKey: string | null
  orderLabel: string
  clientId: string | null
  samples: SenaiteSample[]
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
