import { afterEach, describe, expect, it, vi } from 'vitest'
import { supportAction } from './api-support'

describe('supportAction', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs JSON to the action path and returns the detail', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: null }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await supportAction('wc:1', 'th_b', 'status', { status: 'done' })
    expect(out).toEqual({ detail: null })
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: string; headers: Record<string, string> },
    ]
    expect(String(url)).toContain('/support/customers/wc%3A1/threads/th_b/status')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ status: 'done' })
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('surfaces the error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: { code: 'duplicate_reply' } }), { status: 409 })
      )
    )
    await expect(
      supportAction('wc:1', 'th_b', 'reply', { markdown: 'hi' })
    ).rejects.toMatchObject({ status: 409, code: 'duplicate_reply' })
  })
})
