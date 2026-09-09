import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSlaPerformance } from '@/lib/api'

const report = {
  start: '2026-02-01',
  today: '2026-09-09',
  tz: 'America/Los_Angeles',
  generated_at: '2026-09-09T16:00:00Z',
  target_bh: 24,
  targets: [],
  totals: { samples: 0, delivered: 0, open: 0, cancelled: 0 },
  overall: {
    n: 0,
    ontime: 0,
    late: 0,
    rate: 0,
    med: 0,
    p75: 0,
    p90: 0,
    max: 0,
  },
  kpi: {
    last30: {
      n: 0,
      ontime: 0,
      late: 0,
      rate: 0,
      med: 0,
      p75: 0,
      p90: 0,
      max: 0,
    },
    prev30: {
      n: 0,
      ontime: 0,
      late: 0,
      rate: 0,
      med: 0,
      p75: 0,
      p90: 0,
      max: 0,
    },
  },
  months: [],
  curve: { all: [], recent: [], recent_n: 0, within_target: 0 },
  stages: {
    n: 0,
    coverage: 0,
    bench_med: 0,
    bench_p90: 0,
    lag_med: 0,
    lag_p90: 0,
    lag_share: 0,
    lag_over_day: 0,
    by_month: [],
  },
  gating: {
    mixed: 0,
    late_mixed: 0,
    families: [],
    trend: [],
    wait_med: 0,
    wait_p90: 0,
    wait_n: 0,
    wait_over_day: 0,
    min_late_for_trend: 5,
  },
  at_risk: { total: 0, late: 0, buckets: [], status: {}, rows: [] },
  filters: { client: null, order: null, departments: [], families: [] },
  facets: { clients: [], departments: [], families: [] },
  cache: { stale: false, age_seconds: 0 },
  notes: {},
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

describe('getSlaPerformance', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('hits /reports/sla-performance with no query string by default', async () => {
    const fetchMock = stubFetch()
    const out = await getSlaPerformance({})
    expect(out).toEqual(report)
    expect(calledUrl(fetchMock)).toMatch(/\/reports\/sla-performance$/)
  })

  it('sends the test-order toggle only when it is on', async () => {
    const on = stubFetch()
    await getSlaPerformance({ includeTestOrders: true })
    expect(calledUrl(on)).toContain('include_test_orders=true')

    vi.restoreAllMocks()
    const off = stubFetch()
    await getSlaPerformance({ includeTestOrders: false })
    expect(calledUrl(off)).not.toContain('include_test_orders')
  })

  it('repeats department and family for each selected value', async () => {
    const fetchMock = stubFetch()
    await getSlaPerformance({
      departments: ['microbiology'],
      families: ['ster', 'endo'],
    })
    const url = calledUrl(fetchMock)
    expect(url).toContain('department=microbiology')
    expect(url).toContain('family=ster')
    expect(url).toContain('family=endo')
  })

  it('trims the customer and order and drops them when empty', async () => {
    const withValues = stubFetch()
    await getSlaPerformance({ client: '  Acme Peptides ', order: ' 3271 ' })
    const url = calledUrl(withValues)
    expect(url).toContain('client=Acme+Peptides')
    expect(url).toContain('order=3271')

    vi.restoreAllMocks()
    const blank = stubFetch()
    await getSlaPerformance({ client: '   ', order: '' })
    expect(calledUrl(blank)).toMatch(/\/reports\/sla-performance$/)
  })

  it('throws with the status code when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    )
    await expect(getSlaPerformance({})).rejects.toThrow(
      'SLA performance failed: 503'
    )
  })
})
