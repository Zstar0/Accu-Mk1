import { describe, expect, it } from 'vitest'

import {
  aggregateMonths,
  aggregateWeeks,
  businessDays,
  dowProfile,
  flowWeeks,
  isoWeekKey,
  kpiWindows,
  pctChange,
  perBusinessDay,
  sliceRange,
  staleSplit,
  sumKey,
  type ThroughputDay,
} from './throughput-utils'

function day(d: string, over: Partial<ThroughputDay> = {}): ThroughputDay {
  const dt = new Date(`${d}T00:00:00Z`)
  const dow = (dt.getUTCDay() + 6) % 7
  return {
    d,
    dow,
    biz: dow < 5,
    hol: false,
    samples: 0,
    cancelled: 0,
    hplc: 0,
    ster: 0,
    endo: 0,
    bacw: 0,
    other: 0,
    tests: 0,
    vials: 0,
    retest: 0,
    clients: 0,
    coa: 0,
    acoa: 0,
    fp: 0,
    bench_rows: 0,
    bench_vials: 0,
    bench_inst: {},
    backlog: 0,
    ...over,
  }
}

function series(
  from: string,
  n: number,
  fill: (i: number, d: string) => Partial<ThroughputDay> = () => ({})
) {
  const out: ThroughputDay[] = []
  const start = new Date(`${from}T00:00:00Z`)
  for (let i = 0; i < n; i++) {
    const dt = new Date(start.getTime() + i * 86_400_000)
    const iso = dt.toISOString().slice(0, 10)
    out.push(day(iso, fill(i, iso)))
  }
  return out
}

describe('isoWeekKey', () => {
  it('returns the ISO year-week for a date', () => {
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01') // Thursday
    expect(isoWeekKey('2026-07-06')).toBe('2026-W28') // Monday
  })

  it('assigns early January to the previous ISO year when it belongs there', () => {
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53') // Friday, 2026 is a 53-week year
  })
})

describe('sliceRange', () => {
  const days = series('2026-02-01', 100)

  it('keeps the last N days for a numeric range', () => {
    const out = sliceRange(days, '30')
    expect(out).toHaveLength(30)
    expect(out[0]?.d).toBe(days[70]?.d)
  })

  it('returns everything for "all"', () => {
    expect(sliceRange(days, 'all')).toHaveLength(100)
  })
})

describe('business-day rates', () => {
  // Mon 2026-07-06 .. Sun 2026-07-12 with Friday a holiday
  const week = series('2026-07-06', 7, i => ({
    tests: 10,
    samples: 4,
    ...(i === 4 ? { hol: true, biz: false } : {}),
  }))

  it('counts business days (weekday, not holiday)', () => {
    expect(businessDays(week)).toBe(4)
  })

  it('sums a key over the range', () => {
    expect(sumKey(week, 'tests')).toBe(70)
  })

  it('divides the sum by business days', () => {
    expect(perBusinessDay(week, 'tests')).toBe(17.5)
  })

  it('is zero when the range has no business days', () => {
    const weekend = series('2026-07-11', 2)
    expect(perBusinessDay(weekend, 'tests')).toBe(0)
  })
})

describe('kpiWindows', () => {
  it('splits the last 30 days from the prior 30', () => {
    const days = series('2026-02-01', 100)
    const { last30, prev30 } = kpiWindows(days)
    expect(last30).toHaveLength(30)
    expect(prev30).toHaveLength(30)
    expect(last30[0]?.d).toBe(days[70]?.d)
    expect(prev30[0]?.d).toBe(days[40]?.d)
    expect(prev30[29]?.d).toBe(days[69]?.d)
  })

  it('tolerates a series shorter than 60 days', () => {
    const { last30, prev30 } = kpiWindows(series('2026-02-01', 40))
    expect(last30).toHaveLength(30)
    expect(prev30).toHaveLength(10)
  })
})

describe('pctChange', () => {
  it('returns the percentage change', () => {
    expect(pctChange(110, 100)).toBe(10)
  })

  it('returns null when there is no prior value', () => {
    expect(pctChange(5, 0)).toBeNull()
  })
})

describe('aggregateMonths', () => {
  const days = series('2026-06-29', 10, (_, d) => ({
    samples: 2,
    tests: 3,
    ster: 1,
    coa: 1,
    ...(d === '2026-07-02' ? { hol: true, biz: false } : {}),
  }))
  const months = aggregateMonths(days, '2026-07-08')

  it('groups days by calendar month in order', () => {
    expect(months.map(m => m.m)).toEqual(['2026-06', '2026-07'])
    expect(months[0]?.label).toBe('Jun 2026')
  })

  it('flags the month containing today as partial', () => {
    expect(months[0]?.full).toBe(true)
    expect(months[1]?.full).toBe(false)
  })

  it('computes totals, business days and per-business-day rates', () => {
    const jul = months[1]
    expect(jul?.days).toBe(8)
    expect(jul?.biz).toBe(5) // Wed 1, Fri 3, Mon 6, Tue 7, Wed 8 (Thu 2 is a holiday)
    expect(jul?.tests).toBe(24)
    expect(jul?.tpb).toBe(4.8)
    expect(jul?.cpb).toBe(1.6)
  })

  it('computes add-on attach percentages of samples', () => {
    expect(months[1]?.ster_pct).toBe(50)
    expect(months[1]?.endo_pct).toBe(0)
  })
})

describe('aggregateWeeks', () => {
  // Sat 2026-07-04 .. Tue 2026-07-14
  const days = series('2026-07-04', 11, i => ({
    tests: 1,
    samples: 1,
    fp: i % 2,
    backlog: i,
  }))
  const weeks = aggregateWeeks(days)

  it('groups by ISO week with start and end dates', () => {
    expect(weeks.map(w => w.w)).toEqual(['2026-W27', '2026-W28', '2026-W29'])
    expect(weeks[1]?.start).toBe('2026-07-06')
    expect(weeks[1]?.end).toBe('2026-07-12')
  })

  it('sums counts and carries the end-of-week backlog', () => {
    expect(weeks[1]?.tests).toBe(7)
    expect(weeks[1]?.biz).toBe(5)
    expect(weeks[1]?.backlog).toBe(8)
  })
})

describe('flowWeeks', () => {
  const days = series('2026-07-06', 9) // Mon 6 .. Tue 14
  const weeks = aggregateWeeks(days)

  it('omits the current partial week', () => {
    expect(flowWeeks(weeks, '2026-07-14').map(w => w.w)).toEqual(['2026-W28'])
  })

  it('keeps the last week when it is complete', () => {
    const full = aggregateWeeks(series('2026-07-06', 7))
    expect(flowWeeks(full, '2026-07-12').map(w => w.w)).toEqual(['2026-W28'])
  })
})

describe('dowProfile', () => {
  it('averages per weekday and skips holidays', () => {
    const days = series('2026-07-06', 14, i => ({
      tests: i === 0 ? 10 : i === 7 ? 20 : 4,
      samples: 1,
      coa: 2,
      ...(i === 1 ? { hol: true, biz: false } : {}),
    }))
    const rows = dowProfile(days)
    expect(rows).toHaveLength(7)
    expect(rows[0]).toMatchObject({
      dow: 'Mon',
      n: 2,
      avgTests: 15,
      avgSamples: 1,
      avgCoa: 2,
    })
    expect(rows[1]).toMatchObject({ dow: 'Tue', n: 1, avgTests: 4 })
  })
})

describe('staleSplit', () => {
  it('splits the open backlog into stale (>30d) and live', () => {
    expect(
      staleSplit({
        total: 254,
        status: {},
        age: { '>30d': 134, '0-2d': 100, '3-7d': 20 },
      })
    ).toEqual({
      stale: 134,
      live: 120,
    })
  })
})
