import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCustomerTouchpoints } from '@/lib/api'

describe('getCustomerTouchpoints', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('repeats keys and returns the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        crm_visible: true,
        support_visible: false,
        rows: {},
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const body = await getCustomerTouchpoints(['wc:1', 'email:g@x.com'])
    expect(body.crm_visible).toBe(true)
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('/reports/customers/touchpoints?')
    expect(url).toContain('keys=wc%3A1')
    expect(url).toContain('keys=email%3Ag%40x.com')
  })
})
