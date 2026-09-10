import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  lookupSenaiteSample: vi.fn(),
}))

import { lookupSenaiteSample } from '@/lib/api'
import { useParentSampleDetails } from '@/components/intake/ReceiveWizard/useParentSampleDetails'

const lookup = vi.mocked(lookupSenaiteSample)

function detailsFixture(sampleId: string) {
  return {
    sample_id: sampleId,
    client: `Client ${sampleId}`,
    registry_pk: 1,
    explicit_priority_key: null,
    priority: null,
  } as unknown as Awaited<ReturnType<typeof lookupSenaiteSample>>
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Nothing awaits the rejection except the hook's own catch; keep node quiet.
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

describe('useParentSampleDetails', () => {
  beforeEach(() => {
    lookup.mockReset()
  })

  it('keeps the last good details when a refresh fails and reports refreshError', async () => {
    const good = detailsFixture('PB-1')
    lookup.mockResolvedValueOnce(good)

    const { result } = renderHook(() => useParentSampleDetails('PB-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.details).toBe(good)

    lookup.mockRejectedValueOnce(new Error('SENAITE 503'))
    await act(async () => {
      result.current.refresh()
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.refreshError).toBe('SENAITE 503'))
    // The destructive behaviour this guards against: details nulled, error set,
    // panel replaced by the banner with no retry.
    expect(result.current.details).toBe(good)
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)

    // A subsequent successful refresh clears the warning.
    const fresher = detailsFixture('PB-1')
    lookup.mockResolvedValueOnce(fresher)
    await act(async () => {
      result.current.refresh()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.details).toBe(fresher))
    expect(result.current.refreshError).toBeNull()
  })

  it('discards a late refresh result for a previous parentSampleId', async () => {
    const aDetails = detailsFixture('PB-A')
    const bDetails = detailsFixture('PB-B')
    const lateA = deferred<typeof aDetails>()

    // First call (A mount) resolves immediately; the refresh for A is deferred
    // so it can land after the hook has moved on to B.
    lookup
      .mockResolvedValueOnce(aDetails)
      .mockReturnValueOnce(lateA.promise)
      .mockResolvedValue(bDetails)

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useParentSampleDetails(id),
      { initialProps: { id: 'PB-A' } }
    )
    await waitFor(() => expect(result.current.details).toBe(aDetails))

    await act(async () => {
      result.current.refresh()
      await Promise.resolve()
    })

    rerender({ id: 'PB-B' })
    await waitFor(() => expect(result.current.details).toBe(bDetails))

    // The stale A refresh now fails — it must not touch B's state.
    await act(async () => {
      lateA.reject(new Error('stale A failure'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.details).toBe(bDetails)
    expect(result.current.refreshError).toBeNull()
    expect(result.current.error).toBeNull()
  })
})
