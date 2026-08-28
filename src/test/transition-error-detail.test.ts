/**
 * Regression pin for the "[object Object]" transition toast (PB-0486):
 * FastAPI error bodies carry `detail` as a STRUCTURED dict
 * ({code, message, ...}), and `new Error(dict)` stringifies it to
 * "[object Object]". transitionAnalysis must surface the dict's message —
 * on both the mk1 and the SENAITE branch — falling back to a JSON dump so
 * no error shape ever becomes unreadable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transitionAnalysis } from '@/lib/api'

function stubFetchWith(body: unknown, status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  )
}

describe('transitionAnalysis error surfaces', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mk1 branch: structured 409 detail surfaces its message, not [object Object]', async () => {
    stubFetchWith(
      {
        detail: {
          code: 'invalid_transition',
          message: "parent retest requires the parent row to be 'verified'",
        },
      },
      409
    )
    await expect(transitionAnalysis('mk1:7', 'retest')).rejects.toThrow(
      "parent retest requires the parent row to be 'verified'"
    )
  })

  it('mk1 branch: string detail passes through unchanged', async () => {
    stubFetchWith({ detail: 'plain string detail' }, 409)
    await expect(transitionAnalysis('mk1:7', 'retest')).rejects.toThrow(
      'plain string detail'
    )
  })

  it('mk1 branch: message-less dict detail falls back to JSON, never [object Object]', async () => {
    stubFetchWith({ detail: { code: 'tier_mismatch' } }, 409)
    await expect(transitionAnalysis('mk1:7', 'retest')).rejects.toThrow(
      '"code":"tier_mismatch"'
    )
  })

  it('senaite branch: structured detail surfaces its message too', async () => {
    stubFetchWith({ detail: { message: 'senaite says no' } }, 409)
    await expect(transitionAnalysis('uid-abc', 'retest')).rejects.toThrow(
      'senaite says no'
    )
  })
})
