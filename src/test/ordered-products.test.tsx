import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getOrderedProducts, OrderedProductsError } from '@/lib/api'

// Ensure OrderedProductsError type is recognized by TypeScript
void OrderedProductsError

describe('getOrderedProducts', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns products on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ sample_id: 'P-1', wp_order_number: 'WP-1', products: [] }),
    }))
    const res = await getOrderedProducts('P-1')
    expect(res.wp_order_number).toBe('WP-1')
  })

  it('throws OrderedProductsError carrying status + detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 502,
      json: async () => ({ detail: { message: 'IS down' } }),
    }))
    await expect(getOrderedProducts('P-1')).rejects.toMatchObject({
      name: 'OrderedProductsError', status: 502,
    })
  })
})
