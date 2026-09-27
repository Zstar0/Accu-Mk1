import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRetest, getRetestOptions } from '@/lib/api'

vi.mock('@/store/auth-store', () => ({ getAuthToken: () => 'tok' }))

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
afterEach(() => vi.unstubAllGlobals())

describe('retest api', () => {
  it('getRetestOptions hits /api/samples/{id}/retest-options with auth', async () => {
    const fn = stubFetch(200, {
      sample_id: 'P-1',
      profiles: [],
      addons: [],
      variance: { point_price: null, allowed: false },
      prices_available: false,
      status: null,
      order_number: null,
    })
    const out = await getRetestOptions('P-1')
    expect(out.sample_id).toBe('P-1')
    expect(fn.mock.calls).toHaveLength(1)
    const [url, init] = fn.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/samples\/P-1\/retest-options$/)
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok',
    })
  })
  it('createRetest posts the body and returns WP json', async () => {
    const fn = stubFetch(200, {
      order_number: 'WP-7920',
      payment_url: 'https://x',
    })
    const body = {
      retest: ['hplc-purity-identity'],
      carry: ['heavy_metals'],
      add: null,
      auto_checkin: true,
      fee: 'paid' as const,
      reason: 'r',
    }
    const out = await createRetest('P-1', body)
    expect(out.order_number).toBe('WP-7920')
    expect(fn.mock.calls).toHaveLength(1)
    const [, init] = fn.mock.calls[0]
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual(body)
  })
  it('createRetest surfaces the server detail on 400', async () => {
    stubFetch(400, {
      detail:
        "every profile on P-1 must be retested or carried; missing: ['heavy_metals']",
    })
    await expect(
      createRetest('P-1', {
        retest: ['x'],
        carry: [],
        add: null,
        auto_checkin: false,
        fee: 'free',
        reason: 'r',
      })
    ).rejects.toThrow(/heavy_metals/)
  })
  it('createRetest falls back to a status message when detail is absent', async () => {
    stubFetch(502, {})
    await expect(
      createRetest('P-1', {
        retest: ['x'],
        carry: [],
        add: null,
        auto_checkin: false,
        fee: 'free',
        reason: 'r',
      })
    ).rejects.toThrow(/502/)
  })
})
