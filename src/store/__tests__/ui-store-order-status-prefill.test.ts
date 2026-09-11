import { describe, it, expect } from 'vitest'
import { useUIStore } from '@/store/ui-store'

describe('ui-store order status prefill (header quick nav)', () => {
  it('navigateToOrderStatus lands on Order Status with a consume-once prefill', () => {
    const before = useUIStore.getState().navigationKey
    useUIStore.getState().navigateToOrderStatus('5812')
    const s = useUIStore.getState()
    expect(s.activeSection).toBe('accumark-tools')
    expect(s.activeSubSection).toBe('order-status')
    expect(s.orderStatusPrefill).toEqual({ orderId: '5812' })
    expect(s.navigationKey).toBe(before + 1)
    expect(s.consumeOrderStatusPrefill()).toEqual({ orderId: '5812' })
    expect(useUIStore.getState().orderStatusPrefill).toBeNull()
    expect(s.consumeOrderStatusPrefill()).toBeNull()
  })
})
