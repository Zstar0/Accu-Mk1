/**
 * lockVarianceSet error surfacing: the backend's 409 detail NAMES the exact
 * unfinished rows ("variance series incomplete — ... P-2423-S01:HPLC-PUR"),
 * but the api layer used to throw the bare status ("lockVarianceSet failed:
 * 409"), so the toast told the lab nothing actionable (P-2423 incident,
 * 2026-09-02). These pin that the structured detail.message reaches the
 * caller, with the bare-status text kept as the no-body fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lockVarianceSet, unlockVarianceSet } from '@/lib/api'

function stubFetch(status: number, body?: unknown) {
  const spy = vi.fn().mockResolvedValue(
    body === undefined
      ? new Response('', { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lockVarianceSet error surfacing', () => {
  it('surfaces the 409 series-incomplete detail message verbatim', async () => {
    const message =
      'variance series incomplete — these analyses must be run and signed off ' +
      '(promoted or variance-verified) before locking: P-2423-S01:HPLC-PUR'
    stubFetch(409, { detail: { code: 'variance_series_incomplete', message } })
    await expect(lockVarianceSet('P-2423')).rejects.toThrow(message)
  })

  it('keeps the 422 too-few-vials message', async () => {
    stubFetch(422, {
      detail: { code: 'variance_too_few_vials', message: 'need >=2 selected vials, have 1' },
    })
    await expect(lockVarianceSet('P-2423')).rejects.toThrow('need >=2 selected vials, have 1')
  })

  it('falls back to the status text when the body is empty', async () => {
    stubFetch(500)
    await expect(lockVarianceSet('P-2423')).rejects.toThrow('lockVarianceSet failed: 500')
  })

  it('surfaces unlock error detail too', async () => {
    stubFetch(409, { detail: 'variance set is not locked' })
    await expect(unlockVarianceSet('P-2423')).rejects.toThrow('variance set is not locked')
  })
})
