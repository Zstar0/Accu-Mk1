import { describe, it, expect } from 'vitest'
import { toggleFilterKey, isOrderAtRisk } from '@/components/explorer/order-filters'
import type { OrderSlaVerdict } from '@/lib/sla-resolution'

describe('toggleFilterKey', () => {
  it('appends a key when absent', () => {
    expect(toggleFilterKey([], 'received')).toEqual(['received'])
    expect(toggleFilterKey(['pending'], 'received')).toEqual(['pending', 'received'])
  })
  it('removes a key when present', () => {
    expect(toggleFilterKey(['received'], 'received')).toEqual([])
    expect(toggleFilterKey(['pending', 'received'], 'pending')).toEqual(['received'])
  })
  it('does not mutate the input array', () => {
    const input = ['pending']
    toggleFilterKey(input, 'received')
    expect(input).toEqual(['pending'])
  })
})

describe('isOrderAtRisk', () => {
  const v = (color: OrderSlaVerdict['color']): OrderSlaVerdict => ({ color })
  it('is true for red and amber (approaching or overdue)', () => {
    expect(isOrderAtRisk(v('red'))).toBe(true)
    expect(isOrderAtRisk(v('amber'))).toBe(true)
  })
  it('is false for green/met/awaiting/loading/error', () => {
    for (const c of ['green', 'met', 'awaiting', 'loading', 'error'] as const) {
      expect(isOrderAtRisk(v(c))).toBe(false)
    }
  })
  it('is false for undefined (no verdict yet)', () => {
    expect(isOrderAtRisk(undefined)).toBe(false)
  })
})
