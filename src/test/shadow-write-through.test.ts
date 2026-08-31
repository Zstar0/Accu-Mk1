/**
 * Shadow write-through: a row's uid is its WRITE AUTHORITY.
 *
 * In mk1 read mode the registry is the read surface for parent analyses, so a
 * SENAITE-owned line reaches the UI only as a shadow row. The backend now
 * serializes those rows under their own SENAITE uid, which is what keeps the
 * client routing their writes at the SENAITE wizard endpoints instead of the
 * Mk1 ones — the difference between the lab being able to enter a Bac Water
 * result (or retest a legacy line) and the 2026-08-29 outage, where every such
 * write hit the Mk1 tier/state guards and died.
 *
 * These pin the routing contract itself. No client code changed for it: the
 * `mk1:` prefix branch already existed, and that is exactly the point — the
 * fix is that shadow rows stop claiming a native identity they cannot honour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAnalysisResult, transitionAnalysis } from '@/lib/api'

const SENAITE_UID = 'a1b2c3d4e5f67890a1b2c3d4e5f67890'

function stubFetch(body: unknown = { success: true }) {
  const spy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

function calledUrl(spy: ReturnType<typeof vi.fn>): string {
  const call = spy.mock.calls[0]
  if (!call) throw new Error('fetch was never called')
  return String(call[0])
}

describe('shadow rows route their writes to SENAITE', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('result entry on a SENAITE-uid row hits the wizard result endpoint', async () => {
    const spy = stubFetch()
    await setAnalysisResult(SENAITE_UID, '6.85')
    const url = calledUrl(spy)
    expect(url).toContain(`/wizard/senaite/analyses/${SENAITE_UID}/result`)
    expect(url).not.toContain('/api/lims-analyses/')
  })

  it('a transition on a SENAITE-uid row hits the wizard transition endpoint', async () => {
    const spy = stubFetch()
    await transitionAnalysis(SENAITE_UID, 'retest')
    const url = calledUrl(spy)
    expect(url).toContain(`/wizard/senaite/analyses/${SENAITE_UID}/transition`)
    expect(url).not.toContain('/api/lims-analyses/')
  })

  it('native rows are unaffected — mk1: still routes to the Mk1 endpoints', async () => {
    const resultSpy = stubFetch({ id: 7, review_state: 'to_be_verified' })
    await setAnalysisResult('mk1:7', '12.0')
    expect(calledUrl(resultSpy)).toContain('/api/lims-analyses/7/transitions')
    vi.unstubAllGlobals()

    const transitionSpy = stubFetch({ id: 7, review_state: 'verified' })
    await transitionAnalysis('mk1:7', 'verify')
    expect(calledUrl(transitionSpy)).toContain('/api/lims-analyses/7/transitions')
  })

  it('the uid is sent verbatim — never re-derived or normalized', async () => {
    // The backend hands back SENAITE's own uid; mangling it here would
    // address a different line (or none).
    const spy = stubFetch()
    await setAnalysisResult(SENAITE_UID, '1.0')
    expect(calledUrl(spy)).toContain(SENAITE_UID)
  })
})
