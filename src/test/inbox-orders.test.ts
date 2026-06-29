import { describe, it, expect } from 'vitest'
import { groupSamplesByOrder } from '@/lib/inbox-orders'
import type { SenaiteSample } from '@/lib/api'

function s(id: string, order: string | null, client = 'RTD'): SenaiteSample {
  return { uid: id, id, client_order_number: order, client_id: client } as SenaiteSample
}

describe('groupSamplesByOrder', () => {
  it('groups samples sharing an order number', () => {
    const groups = groupSamplesByOrder([
      s('P-0500', 'WP-20066'),
      s('P-0501', 'WP-20066'),
      s('P-0502', 'WP-20071'),
    ])
    expect(groups).toHaveLength(2)
    const wp66 = groups.find(g => g.orderKey === 'WP-20066')!
    expect(wp66.samples.map(x => x.id)).toEqual(['P-0500', 'P-0501'])
    expect(wp66.orderLabel).toBe('WP-20066')
  })

  it('collapses order-less samples into a single "No order" group sorted last', () => {
    const groups = groupSamplesByOrder([s('P-0600', null), s('P-0700', 'WP-20066')])
    const last = groups[groups.length - 1]!
    expect(last.orderKey).toBeNull()
    expect(last.orderLabel).toBe('No order')
  })
})
