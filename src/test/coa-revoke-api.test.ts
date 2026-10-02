import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCoaRevokePreview, revokeCoaGeneration } from '@/lib/api'

// The wrappers must hit the Mk1 proxy paths with the exact body the backend
// expects; revoked_by is NOT sent from the browser.

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('revoke API client', () => {
  it('getCoaRevokePreview GETs the preview route', async () => {
    const fetchMock = stubFetch({ target: { generation_id: 'g1' }, others: [] })
    const out = await getCoaRevokePreview('g1')
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toMatch(
      /\/explorer\/coa-generations\/g1\/revoke-preview$/
    )
    expect(init?.method ?? 'GET').toBe('GET')
    expect(out.others).toEqual([])
  })

  it('revokeCoaGeneration POSTs reason, include_codes and notify_customer (no revoked_by)', async () => {
    const fetchMock = stubFetch({
      revoked: [],
      skipped: [],
      wp_notified: true,
      wp_error: null,
    })
    await revokeCoaGeneration('g1', 'Lot recalled', ['ACOA-0002'])
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toMatch(/\/explorer\/coa-generations\/g1\/revoke$/)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: 'Lot recalled',
      include_codes: ['ACOA-0002'],
      notify_customer: true,
    })
  })

  it('revokeCoaGeneration defaults include_codes to an empty list and notify_customer to true', async () => {
    const fetchMock = stubFetch({
      revoked: [],
      skipped: [],
      wp_notified: true,
      wp_error: null,
    })
    await revokeCoaGeneration('g1', 'r')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      reason: 'r',
      include_codes: [],
      notify_customer: true,
    })
  })

  it('revokeCoaGeneration can switch the customer email off', async () => {
    const fetchMock = stubFetch({
      revoked: [],
      skipped: [],
      wp_notified: true,
      wp_error: null,
    })
    await revokeCoaGeneration('g1', 'r', [], false)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      reason: 'r',
      include_codes: [],
      notify_customer: false,
    })
  })
})
