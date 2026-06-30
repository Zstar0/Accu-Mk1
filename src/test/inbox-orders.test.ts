import { describe, it, expect } from 'vitest'
import {
  customerDetailHash,
  enrichOrderGroups,
  groupSamplesByOrder,
} from '@/lib/inbox-orders'
import type { ExplorerOrder, SenaiteSample } from '@/lib/api'

function s(id: string, order: string | null, client = 'RTD'): SenaiteSample {
  return { uid: id, id, client_order_number: order, client_id: client } as SenaiteSample
}

const grp = (orderKey: string | null) => ({
  orderKey,
  orderLabel: orderKey ?? 'No order',
  clientId: 'acme',
  samples: [],
})

const ord = (order_number: string, customer_id: number | null = 7) =>
  ({ order_number, customer_id, created_at: '2026-06-24T00:00:00Z' } as unknown as ExplorerOrder)

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

describe('enrichOrderGroups', () => {
  it('matches a group to its ExplorerOrder by order_number', () => {
    const r = enrichOrderGroups([grp('WP-1042')], [ord('WP-1042')])[0]!
    expect(r.order?.order_number).toBe('WP-1042')
  })
  it('leaves order null when no ExplorerOrder matches', () => {
    const r = enrichOrderGroups([grp('WP-9999')], [ord('WP-1042')])[0]!
    expect(r.order).toBeNull()
  })
  it('leaves order null for the No-order group', () => {
    const r = enrichOrderGroups([grp(null)], [ord('WP-1042')])[0]!
    expect(r.order).toBeNull()
  })
})

describe('customerDetailHash', () => {
  it('builds a customer deep-link hash when customer_id is set', () => {
    expect(customerDetailHash(7)).toBe('#accumark-tools/customer-detail?id=7')
  })
  it('falls back to the customers list when customer_id is null', () => {
    expect(customerDetailHash(null)).toBe('#accumark-tools/customers')
  })
})
