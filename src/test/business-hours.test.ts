import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSlaStatuses, type SlaStatusRequestItem } from '@/lib/api'

afterEach(() => vi.restoreAllMocks())

describe('fetchSlaStatuses', () => {
  it('POSTs items and returns the items array', async () => {
    const items: SlaStatusRequestItem[] = [
      { key: 'a', received_at: null, target_minutes: 60, business_hours_only: false },
    ]
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [{ key: 'a', status: null }] }), { status: 200 }),
    )
    const result = await fetchSlaStatuses(items)
    expect(result).toEqual([{ key: 'a', status: null }])
    const [, init] = mock.mock.calls[0]!
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ items })
  })

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(fetchSlaStatuses([])).rejects.toThrow()
  })
})
