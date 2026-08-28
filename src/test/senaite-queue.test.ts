import { describe, it, expect, vi, beforeEach } from 'vitest'

// v1.11.5: mk1-source lookups bypass the serialized SENAITE queue (the
// queue exists only to protect single-threaded Zope; riding it made a
// 372-sample Order Status board take ~60s). senaite-source lookups must
// STAY strictly serialized.

const lookupMock = vi.fn()
vi.mock('@/lib/api', () => ({
  lookupSenaiteSample: (...args: unknown[]) => lookupMock(...args),
}))

const { enqueueSenaiteLookup } =
  await import('@/components/explorer/senaite-queue')

function deferred() {
  let resolve!: (v: unknown) => void
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  lookupMock.mockReset()
})

describe('enqueueSenaiteLookup', () => {
  it('mk1 lookups run concurrently (queue bypassed)', async () => {
    const gateA = deferred()
    const gateB = deferred()
    lookupMock
      .mockReturnValueOnce(gateA.promise)
      .mockReturnValueOnce(gateB.promise)

    const a = enqueueSenaiteLookup('P-0001', 'mk1')
    const b = enqueueSenaiteLookup('P-0002', 'mk1')
    // BOTH fired without waiting for the first to settle.
    expect(lookupMock).toHaveBeenCalledTimes(2)

    gateA.resolve('a')
    gateB.resolve('b')
    expect(await a).toBe('a')
    expect(await b).toBe('b')
  })

  it('senaite lookups stay strictly serialized', async () => {
    const first = deferred()
    lookupMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce('b')

    const a = enqueueSenaiteLookup('P-0001', 'senaite')
    const b = enqueueSenaiteLookup('P-0002', 'senaite')
    // Second must NOT fire while the first is in flight.
    await Promise.resolve()
    expect(lookupMock).toHaveBeenCalledTimes(1)

    first.resolve('a')
    expect(await a).toBe('a')
    expect(await b).toBe('b')
    expect(lookupMock).toHaveBeenCalledTimes(2)
  })

  it('a failed senaite lookup does not wedge the queue', async () => {
    lookupMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok')
    await expect(enqueueSenaiteLookup('P-0001', 'senaite')).rejects.toThrow(
      'boom'
    )
    expect(await enqueueSenaiteLookup('P-0002', 'senaite')).toBe('ok')
  })
})
