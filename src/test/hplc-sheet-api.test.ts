import { describe, it, expect, vi, afterEach } from 'vitest'
import { patchHplcRow, updateWorksheetItem } from '@/lib/api'

vi.mock('@/store/auth-store', () => ({ getAuthToken: () => 'tok' }))

function stubFetch(body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
afterEach(() => vi.unstubAllGlobals())

const initOf = (fn: { mock: { calls: unknown[][] } }) =>
  (fn.mock.calls.at(-1) as [string, RequestInit])[1]

describe('the HPLC sheet saves pass an abort signal to fetch', () => {
  it('patchHplcRow sends the signal it is given', async () => {
    const fn = stubFetch({ item_id: 311, hplc_prep: {} })
    const signal = new AbortController().signal
    await patchHplcRow(7, 311, { hplc_prep: { stock_vial_mg: 1 } }, { signal })
    expect(initOf(fn).signal).toBe(signal)
  })

  it('updateWorksheetItem sends the signal it is given', async () => {
    const fn = stubFetch({ status: 'ok', item_id: 311 })
    const signal = new AbortController().signal
    await updateWorksheetItem(7, 311, { instrument_id: 3 }, { signal })
    expect(initOf(fn).signal).toBe(signal)
  })

  it('updateWorksheetItem called the old way sends no signal', async () => {
    const fn = stubFetch({ status: 'ok', item_id: 311 })
    await updateWorksheetItem(7, 311, { instrument_id: 3 })
    expect('signal' in initOf(fn)).toBe(false)
  })
})
