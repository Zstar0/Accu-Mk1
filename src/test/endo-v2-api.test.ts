import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createInstrument,
  importReaderResults,
  listConsumables,
  putMethodConsumables,
  updateConsumable,
  updateInstrument,
  updateMethod,
  updateWorksheet,
  updateWorksheetItem,
} from '@/lib/api'

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

function lastCall(fn: { mock: { calls: unknown[][] } }) {
  const call = fn.mock.calls.at(-1)
  if (!call) throw new Error('expected a fetch call')
  const [url, init] = call as [string, RequestInit]
  return {
    url: String(url),
    init,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  }
}

describe('endo v2 api client', () => {
  it('listConsumables sends the kind and active filters', async () => {
    const fn = stubFetch(200, [])
    await listConsumables({ kind: 'endo_cartridge', active: true })
    expect(lastCall(fn).url).toMatch(
      /\/consumables\?kind=endo_cartridge&active=true$/
    )
  })

  it('updateConsumable PATCHes only the fields it is given', async () => {
    const fn = stubFetch(200, {})
    await updateConsumable(4, { name: 'Endosafe 0.05', active: false })
    const { url, init, body } = lastCall(fn)
    expect(url).toMatch(/\/consumables\/4$/)
    expect(init.method).toBe('PATCH')
    expect(body).toEqual({ name: 'Endosafe 0.05', active: false })
  })

  it('putMethodConsumables replaces the whole set', async () => {
    const fn = stubFetch(200, [])
    await putMethodConsumables(7, [{ consumable_type_id: 1, is_default: true }])
    const { url, init, body } = lastCall(fn)
    expect(url).toMatch(/\/hplc\/methods\/7\/consumables$/)
    expect(init.method).toBe('PUT')
    expect(body).toEqual([{ consumable_type_id: 1, is_default: true }])
  })

  it('updateWorksheet carries the run fields', async () => {
    const fn = stubFetch(200, {})
    await updateWorksheet(5, { endo_prep: 'stock', cartridge_type_id: null })
    expect(lastCall(fn).body).toEqual({
      endo_prep: 'stock',
      cartridge_type_id: null,
    })
  })

  it.each([
    [
      'updateWorksheetItem',
      () => updateWorksheetItem(5, 9, { result_reading: '0.8' }),
    ],
    [
      'importReaderResults',
      () => importReaderResults(5, { file_name: 'x.csv', tests: [] }),
    ],
    ['updateWorksheet', () => updateWorksheet(5, { endo_prep: '2ml' })],
    [
      'updateMethod',
      () =>
        updateMethod(7, {
          run_parameters: { endotoxin: { cv_limit_pct: 30 } },
        }),
    ],
  ])('%s surfaces the server reason', async (_name, call) => {
    stubFetch(409, { detail: 'Worksheet 5 is completed' })
    await expect(call()).rejects.toThrow('Worksheet 5 is completed')
  })
})

describe('instrument create and update errors', () => {
  it.each([
    ['createInstrument', () => createInstrument({ name: 'Reader' })],
    [
      'updateInstrument',
      () => updateInstrument(1, { serial_number: 'NX-1001' }),
    ],
  ])('%s surfaces the server reason', async (_name, call) => {
    const detail = "serial number 'NX-1001' is already on 'Nexgen-MCS'"
    stubFetch(409, { detail })
    await expect(call()).rejects.toThrow(detail)
  })

  // pydantic's 422 detail is an array: the fallback, never [object Object].
  it.each([
    [
      'createInstrument',
      () => createInstrument({ name: 'Reader' }),
      'Create instrument failed: 422',
    ],
    [
      'updateInstrument',
      () => updateInstrument(1, { serial_number: 'x'.repeat(101) }),
      'Update instrument failed: 422',
    ],
  ])('%s reads a 422 array detail as the fallback', async (_n, call, msg) => {
    stubFetch(422, {
      detail: [
        {
          loc: ['body', 'serial_number'],
          msg: 'String should have at most 100 characters',
          type: 'string_too_long',
        },
      ],
    })
    await expect(call()).rejects.toThrow(msg)
    await expect(call()).rejects.not.toThrow('[object Object]')
  })
})
