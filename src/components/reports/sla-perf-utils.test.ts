import { describe, expect, it } from 'vitest'

import {
  bestAndWorst,
  bh,
  chartableFamilies,
  cohortsWithWork,
  deltaPoints,
  gateShare,
  hasGatingSignal,
  leadingFamily,
  pct,
  readableMonth,
  staleOpen,
  trendMedian,
  trendNumber,
  type SlaPerfGating,
  type SlaPerfGatingMonth,
  type SlaPerfMonth,
  type SlaPerfStats,
} from './sla-perf-utils'

function month(m: string, over: Partial<SlaPerfMonth> = {}): SlaPerfMonth {
  return {
    m,
    label: m,
    received: 10,
    delivered: 10,
    open: 0,
    ontime: 8,
    late: 2,
    open_late: 0,
    rate_delivered: 80,
    rate_received: 80,
    med: 20,
    p90: 30,
    ...over,
  }
}

function trend(
  m: string,
  over: Record<string, number | null> = {}
): SlaPerfGatingMonth {
  return {
    m,
    label: m,
    n: 10,
    late_total: 10,
    wait: null,
    ...over,
  } as SlaPerfGatingMonth
}

function stats(over: Partial<SlaPerfStats> = {}): SlaPerfStats {
  return {
    n: 10,
    ontime: 8,
    late: 2,
    rate: 80,
    med: 20,
    p75: 25,
    p90: 30,
    max: 40,
    ...over,
  }
}

describe('trend readers', () => {
  it('reads a numeric key and treats a missing one as zero', () => {
    const row = trend('2026-08', { ster_gate_late: 9 })
    expect(trendNumber(row, 'ster_gate_late')).toBe(9)
    expect(trendNumber(row, 'endo_gate_late')).toBe(0)
  })

  it('distinguishes a missing median from a zero one', () => {
    const row = trend('2026-08', { ster: 0, endo: null })
    expect(trendMedian(row, 'ster')).toBe(0)
    expect(trendMedian(row, 'endo')).toBeNull()
    expect(trendMedian(row, 'hplc')).toBeNull()
  })
})

describe('gateShare', () => {
  it("is the share of that month's late samples the family finished last on", () => {
    expect(gateShare(trend('2026-08', { ster_gate_late: 5 }), 'ster')).toBe(50)
  })

  it('is zero when the month has no late samples', () => {
    expect(
      gateShare(trend('2026-08', { late_total: 0, ster_gate_late: 0 }), 'ster')
    ).toBe(0)
  })
})

describe('readableMonth', () => {
  const rows = [
    trend('2026-07', { late_total: 20 }),
    trend('2026-08', { late_total: 17 }),
    trend('2026-09', { late_total: 3 }), // partial month, too thin to read
  ]

  it('skips a newest month that is too thin to carry a claim', () => {
    expect(readableMonth(rows, 5)?.m).toBe('2026-08')
  })

  it('falls back to the newest month when nothing clears the bar', () => {
    const thin = [
      trend('2026-08', { late_total: 1 }),
      trend('2026-09', { late_total: 2 }),
    ]
    expect(readableMonth(thin, 5)?.m).toBe('2026-09')
  })

  it('returns null for an empty trend', () => {
    expect(readableMonth([], 5)).toBeNull()
  })
})

describe('leadingFamily', () => {
  it('names the family that finished last most often', () => {
    const row = trend('2026-08', {
      ster_gate_late: 9,
      hplc_gate_late: 6,
      endo_gate_late: 2,
    })
    expect(leadingFamily(row)).toBe('ster')
  })

  it('is null when nothing was late that month', () => {
    expect(leadingFamily(trend('2026-08', { late_total: 0 }))).toBeNull()
    expect(leadingFamily(null)).toBeNull()
  })

  it('refuses to name a department that has too few timed samples', () => {
    // A customer-scoped month can clear the late-sample floor while the family
    // that gated most of it ran five samples all year. Naming it would make the
    // headline contradict the "too few" marker on its own table row.
    const row = trend('2026-08', { hm_gate_late: 4, ster_gate_late: 3 })
    expect(leadingFamily(row)).toBe('hm')
    expect(leadingFamily(row, new Set(['hm']))).toBeNull()
  })

  it('still names a solid leader when some other department is thin', () => {
    const row = trend('2026-08', { ster_gate_late: 6, hm_gate_late: 2 })
    expect(leadingFamily(row, new Set(['hm']))).toBe('ster')
  })
})

describe('chartableFamilies', () => {
  it('keeps only families with enough timed samples to draw', () => {
    const rows = [
      trend('2026-07', { hplc_n: 40, ster_n: 30, hm_n: 1 }),
      trend('2026-08', { hplc_n: 50, ster_n: 35, hm_n: 2 }),
    ]
    expect(chartableFamilies(rows)).toEqual(['hplc', 'ster'])
  })
})

describe('deltaPoints', () => {
  it('returns the percentage-point change', () => {
    expect(deltaPoints(stats({ rate: 48.3 }), stats({ rate: 73.4 }))).toBe(
      -25.1
    )
  })

  it('returns null when there is no prior window', () => {
    expect(deltaPoints(stats(), stats({ n: 0 }))).toBeNull()
  })
})

describe('formatting', () => {
  it('drops a trailing zero from business hours', () => {
    expect(bh(24)).toBe('24 bh')
    expect(bh(21.34)).toBe('21.3 bh')
  })

  it('formats percentages the same way', () => {
    expect(pct(50)).toBe('50%')
    expect(pct(48.34)).toBe('48.3%')
  })
})

describe('cohorts', () => {
  it('drops months that received nothing', () => {
    expect(
      cohortsWithWork([
        month('2026-07'),
        month('2026-08', { received: 0 }),
      ]).map(m => m.m)
    ).toEqual(['2026-07'])
  })

  it('picks the best and worst complete cohort, ignoring the partial month', () => {
    const months = [
      month('2026-07', { rate_received: 76 }),
      month('2026-08', { rate_received: 54 }),
      month('2026-09', { rate_received: 23 }), // partial
    ]
    const { best, worst } = bestAndWorst(months, '2026-09-09')
    expect(best?.m).toBe('2026-07')
    expect(worst?.m).toBe('2026-08')
  })

  it('falls back to the partial month when it is the only one', () => {
    const { best } = bestAndWorst(
      [month('2026-09', { rate_received: 23 })],
      '2026-09-09'
    )
    expect(best?.m).toBe('2026-09')
  })

  it('counts open work older than the last two months as stale', () => {
    const months = [
      month('2026-06', { open: 8 }),
      month('2026-07', { open: 4 }),
      month('2026-08', { open: 20 }),
      month('2026-09', { open: 158 }),
    ]
    expect(staleOpen(months)).toBe(12)
  })
})

describe('hasGatingSignal', () => {
  const base: SlaPerfGating = {
    mixed: 0,
    late_mixed: 0,
    families: [],
    trend: [],
    wait_med: 0,
    wait_p90: 0,
    wait_n: 0,
    wait_over_day: 0,
    min_late_for_trend: 5,
    min_timed_for_family: 20,
  }

  it('is false with no late mixed samples', () => {
    expect(hasGatingSignal(base)).toBe(false)
  })

  it('is true once there is a late mixed sample and a trend row', () => {
    expect(
      hasGatingSignal({ ...base, late_mixed: 3, trend: [trend('2026-08')] })
    ).toBe(true)
  })
})
