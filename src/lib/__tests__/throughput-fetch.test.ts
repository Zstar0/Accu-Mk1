import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getThroughput } from '@/lib/api'

const report = {
  start: '2026-02-01',
  end: '2026-09-09',
  today: '2026-09-09',
  tz: 'America/Los_Angeles',
  generated_at: '2026-09-09T16:00:00Z',
  instruments: [],
  holidays: [],
  days: [],
  backlog_now: { total: 0, status: {}, age: {} },
  notes: { jan_excluded: true, vials_from: '2026-06', bench_from: '2026-03' },
}

describe('getThroughput', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('hits /reports/throughput without the test-order flag by default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => report })
    vi.stubGlobal('fetch', fetchMock)

    const out = await getThroughput()

    expect(out).toEqual(report)
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toMatch(/\/reports\/throughput$/)
  })

  it('adds include_test_orders=true when asked', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => report })
    vi.stubGlobal('fetch', fetchMock)

    await getThroughput(true)

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toMatch(/\/reports\/throughput\?include_test_orders=true$/)
  })

  it('throws with the status on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    )

    await expect(getThroughput()).rejects.toThrow('Throughput failed: 503')
  })
})
