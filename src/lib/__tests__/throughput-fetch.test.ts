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
  filters: { client: null, order: null, departments: [], families: [] },
  facets: { clients: [], departments: [], families: [] },
  cache: { stale: false, age_seconds: 0 },
  notes: { jan_excluded: true, vials_from: '2026-06', bench_from: '2026-03' },
}

function stubFetch() {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => report })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function calledUrl(fetchMock: ReturnType<typeof vi.fn>) {
  return String(fetchMock.mock.calls[0]?.[0])
}

describe('getThroughput', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('hits /reports/throughput with no query string by default', async () => {
    const fetchMock = stubFetch()
    const out = await getThroughput({})
    expect(out).toEqual(report)
    expect(calledUrl(fetchMock)).toMatch(/\/reports\/throughput$/)
  })

  it('adds include_test_orders=true when asked', async () => {
    const fetchMock = stubFetch()
    await getThroughput({ includeTestOrders: true })
    expect(calledUrl(fetchMock)).toMatch(
      /\/reports\/throughput\?include_test_orders=true$/
    )
  })

  it('serialises client, order, repeated department and family params', async () => {
    const fetchMock = stubFetch()
    await getThroughput({
      client: 'Acme Peptides',
      order: '3271',
      departments: ['microbiology', 'heavy_metals'],
      families: ['ster'],
    })
    const url = new URL(calledUrl(fetchMock), 'http://x')
    expect(url.searchParams.get('client')).toBe('Acme Peptides')
    expect(url.searchParams.get('order')).toBe('3271')
    expect(url.searchParams.getAll('department')).toEqual([
      'microbiology',
      'heavy_metals',
    ])
    expect(url.searchParams.getAll('family')).toEqual(['ster'])
    expect(url.searchParams.has('include_test_orders')).toBe(false)
  })

  it('omits blank client and order values', async () => {
    const fetchMock = stubFetch()
    await getThroughput({ client: '  ', order: '' })
    expect(calledUrl(fetchMock)).toMatch(/\/reports\/throughput$/)
  })

  it('throws with the status on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    )
    await expect(getThroughput({})).rejects.toThrow('Throughput failed: 503')
  })
})
