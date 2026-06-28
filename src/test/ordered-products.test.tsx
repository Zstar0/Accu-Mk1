import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getOrderedProducts, OrderedProductsError } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OrderedProducts } from '@/components/senaite/OrderedProducts'
import * as api from '@/lib/api'

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

// ─── OrderedProducts component tests ──────────────────────────────────────────

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}
const noVials = { parent: null, sub_samples: [] } as unknown as api.SubSampleListResponse

it('renders product chips', async () => {
  vi.spyOn(api, 'getOrderedProducts').mockResolvedValue({
    sample_id: 'P-1', wp_order_number: 'WP-1',
    products: [{ key: 'core', label: 'Core HPLC', is_addon: false, fulfillment_role: null, fulfillment_dim: 'role' }],
  })
  wrap(<OrderedProducts sampleId="P-1" subData={noVials} />)
  expect(await screen.findByText('Core HPLC')).toBeInTheDocument()
})

it('404 shows quiet empty, not an error', async () => {
  vi.spyOn(api, 'getOrderedProducts').mockRejectedValue(new api.OrderedProductsError(404, null))
  wrap(<OrderedProducts sampleId="P-1" subData={noVials} />)
  expect(await screen.findByText(/no linked order/i)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
})

it('non-404 error shows copy + retry', async () => {
  vi.spyOn(api, 'getOrderedProducts').mockRejectedValue(
    new api.OrderedProductsError(502, { message: 'IS down' }))
  wrap(<OrderedProducts sampleId="P-1" subData={noVials} />)
  expect(await screen.findByText(/couldn't load ordered products/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
})
