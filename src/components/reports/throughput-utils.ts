/**
 * Pure helpers for the Lab Throughput report.
 *
 * The backend (`GET /reports/throughput`) returns one row per calendar day in the
 * lab timezone; everything here rolls those rows up client-side (weeks, months,
 * KPI windows, day-of-week profile). No React, no dates-in-local-time: every day
 * is an ISO `YYYY-MM-DD` string and is parsed as UTC midnight so weekday maths
 * cannot drift with the browser's timezone.
 */

import type {
  ThroughputBacklogNow,
  ThroughputDay,
  ThroughputReport,
} from '@/lib/api'

export type { ThroughputBacklogNow, ThroughputDay, ThroughputReport }

export type RangeKey = '30' | '60' | '90' | '180' | 'all'
export const RANGE_KEYS: RangeKey[] = ['30', '60', '90', '180', 'all']

export type SumKey =
  | 'samples'
  | 'cancelled'
  | 'hplc'
  | 'ster'
  | 'endo'
  | 'bacw'
  | 'hm'
  | 'other'
  | 'tests'
  | 'vials'
  | 'retest'
  | 'coa'
  | 'acoa'
  | 'fp'
  | 'bench_rows'
  | 'bench_vials'

const SUM_KEYS: SumKey[] = [
  'samples',
  'cancelled',
  'hplc',
  'ster',
  'endo',
  'bacw',
  'hm',
  'other',
  'tests',
  'vials',
  'retest',
  'coa',
  'acoa',
  'fp',
  'bench_rows',
  'bench_vials',
]

export const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]
export const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const DAY_MS = 86_400_000

/** Parse an ISO day as UTC midnight (browser-timezone-proof). */
export function parseDay(d: string): Date {
  const [y = 1970, m = 1, dd = 1] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dd))
}

/** "6 Jul" */
export function shortDay(d: string): string {
  const dt = parseDay(d)
  return `${dt.getUTCDate()} ${MONTHS_SHORT[dt.getUTCMonth()]}`
}

/** "Mon 6 Jul 2026" */
export function longDay(d: string): string {
  const dt = parseDay(d)
  return `${DOW_SHORT[(dt.getUTCDay() + 6) % 7]} ${dt.getUTCDate()} ${MONTHS_SHORT[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`
}

/** "Jul 2026" from "2026-07". */
export function monthLabel(ym: string): string {
  return `${MONTHS_SHORT[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`
}

/** ISO 8601 week key, e.g. "2026-W28". */
export function isoWeekKey(d: string): string {
  const dt = parseDay(d)
  const dayIdx = (dt.getUTCDay() + 6) % 7 // Mon=0
  // Thursday of this week decides the ISO year.
  dt.setUTCDate(dt.getUTCDate() - dayIdx + 3)
  const isoYear = dt.getUTCFullYear()
  const jan4 = new Date(Date.UTC(isoYear, 0, 4))
  const week =
    1 +
    Math.round(
      ((dt.getTime() - jan4.getTime()) / DAY_MS -
        3 +
        ((jan4.getUTCDay() + 6) % 7)) /
        7
    )
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

export function sliceRange(
  days: ThroughputDay[],
  range: RangeKey
): ThroughputDay[] {
  if (range === 'all') return days
  return days.slice(Math.max(0, days.length - Number(range)))
}

export function businessDays(days: ThroughputDay[]): number {
  return days.reduce((n, d) => n + (d.biz ? 1 : 0), 0)
}

export function sumKey(days: ThroughputDay[], key: SumKey): number {
  return days.reduce((n, d) => n + (d[key] || 0), 0)
}

export function perBusinessDay(days: ThroughputDay[], key: SumKey): number {
  const biz = businessDays(days)
  return biz ? sumKey(days, key) / biz : 0
}

/** Percentage with one decimal; 0 when the denominator is 0. */
export function pct(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0
}

/** Percentage change from `prev` to `cur`; null when there is no prior value. */
export function pctChange(cur: number, prev: number): number | null {
  return prev > 0 ? ((cur - prev) / prev) * 100 : null
}

export function kpiWindows(days: ThroughputDay[]): {
  last30: ThroughputDay[]
  prev30: ThroughputDay[]
} {
  const n = days.length
  return {
    last30: days.slice(Math.max(0, n - 30)),
    prev30: days.slice(Math.max(0, n - 60), Math.max(0, n - 30)),
  }
}

type Sums = Record<SumKey, number>

function emptySums(): Sums {
  const s = {} as Sums
  for (const k of SUM_KEYS) s[k] = 0
  return s
}

function addSums(target: Sums, d: ThroughputDay) {
  for (const k of SUM_KEYS) target[k] += d[k] || 0
}

export interface MonthAgg extends Sums {
  m: string // "2026-07"
  label: string // "Jul 2026"
  days: number
  biz: number
  full: boolean
  tpb: number // tests per business day
  spb: number // samples per business day
  cpb: number // primary COAs per business day
  bpb: number // HPLC vials run per business day
  ster_pct: number
  endo_pct: number
  bacw_pct: number
}

export function aggregateMonths(
  days: ThroughputDay[],
  today: string
): MonthAgg[] {
  const byMonth = new Map<string, MonthAgg>()
  for (const d of days) {
    const m = d.d.slice(0, 7)
    let agg = byMonth.get(m)
    if (!agg) {
      agg = {
        ...emptySums(),
        m,
        label: monthLabel(m),
        days: 0,
        biz: 0,
        full: m !== today.slice(0, 7),
        tpb: 0,
        spb: 0,
        cpb: 0,
        bpb: 0,
        ster_pct: 0,
        endo_pct: 0,
        bacw_pct: 0,
      }
      byMonth.set(m, agg)
    }
    agg.days += 1
    if (d.biz) agg.biz += 1
    addSums(agg, d)
  }
  const list = [...byMonth.values()].sort((a, b) => (a.m < b.m ? -1 : 1))
  for (const o of list) {
    o.tpb = o.biz ? o.tests / o.biz : 0
    o.spb = o.biz ? o.samples / o.biz : 0
    o.cpb = o.biz ? o.coa / o.biz : 0
    o.bpb = o.biz ? o.bench_vials / o.biz : 0
    o.ster_pct = pct(o.ster, o.samples)
    o.endo_pct = pct(o.endo, o.samples)
    o.bacw_pct = pct(o.bacw, o.samples)
  }
  return list
}

export interface WeekAgg extends Sums {
  w: string // "2026-W28"
  start: string
  end: string
  biz: number
  backlog: number // end-of-week
}

export function aggregateWeeks(days: ThroughputDay[]): WeekAgg[] {
  const byWeek = new Map<string, WeekAgg>()
  for (const d of days) {
    const w = isoWeekKey(d.d)
    let agg = byWeek.get(w)
    if (!agg) {
      agg = { ...emptySums(), w, start: d.d, end: d.d, biz: 0, backlog: 0 }
      byWeek.set(w, agg)
    }
    agg.end = d.d
    if (d.biz) agg.biz += 1
    addSums(agg, d)
    agg.backlog = d.backlog
  }
  return [...byWeek.values()].sort((a, b) => (a.w < b.w ? -1 : 1))
}

/** Weeks for the intake-vs-output chart: the current partial week is omitted. */
export function flowWeeks(weeks: WeekAgg[], today: string): WeekAgg[] {
  const last = weeks[weeks.length - 1]
  if (!last) return weeks
  const partial = last.end === today && parseDay(today).getUTCDay() !== 0
  return partial ? weeks.slice(0, -1) : weeks
}

export interface DowRow {
  dow: string
  n: number
  avgTests: number
  avgSamples: number
  avgCoa: number
}

/** Average per weekday over the range; holidays are skipped. */
export function dowProfile(days: ThroughputDay[]): DowRow[] {
  const empty = () => ({ n: 0, t: 0, s: 0, c: 0 })
  const acc = DOW_SHORT.map(empty)
  for (const d of days) {
    if (d.hol) continue
    const a = acc[d.dow]
    if (!a) continue
    a.n += 1
    a.t += d.tests
    a.s += d.samples
    a.c += d.coa
  }
  return DOW_SHORT.map((dow, i) => {
    const a = acc[i] ?? empty()
    return {
      dow,
      n: a.n,
      avgTests: a.n ? a.t / a.n : 0,
      avgSamples: a.n ? a.s / a.n : 0,
      avgCoa: a.n ? a.c / a.n : 0,
    }
  })
}

export const STALE_AGE_KEY = '>30d'
export const AGE_ORDER = ['0-2d', '3-7d', '8-14d', '15-30d', STALE_AGE_KEY]

export function staleSplit(backlog: ThroughputBacklogNow): {
  stale: number
  live: number
} {
  const stale = backlog.age[STALE_AGE_KEY] || 0
  return { stale, live: backlog.total - stale }
}
