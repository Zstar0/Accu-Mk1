import type { AnalyteTrendCoa } from '@/lib/api'

export const TEST_KEYS = [
  'purity',
  'identity',
  'endo',
  'sterility',
  'hm',
  'assay',
] as const
export type TestKey = (typeof TEST_KEYS)[number]

export const TEST_LABELS: Record<TestKey, string> = {
  purity: 'Purity',
  identity: 'Identity',
  endo: 'Endotoxin',
  sterility: 'Sterility',
  hm: 'Heavy Metals',
  assay: 'Assays',
}

/** Trend windows: last 90 days vs the 90 before that. */
export const TREND_WINDOW_DAYS = 90
/** Below this many tests in either window a trend is noise (1 fail in 2 = 50%). */
export const TREND_MIN_N = 5
/** A trend this many percentage points up is called out as "rising". */
export const RISING_PP = 10
// Flat ±20% band for "qty off" (Handler 2026-10-05: ±10% flagged 52% of prod
// COAs; ±20% keeps 74% inside). ponytail: per-product if the lab sets one.
export const QTY_FLAG_PCT = 20

const DAY_MS = 86_400_000

export type Outcome = boolean | null

/** true = passed, false = failed, null = not tested on this COA. */
export function outcome(c: AnalyteTrendCoa, k: TestKey): Outcome {
  switch (k) {
    case 'purity':
      return c.purity_ok
    case 'identity':
      return c.identity_ok
    case 'endo':
      return c.endo
    case 'sterility':
      return c.sterility
    case 'hm':
      return c.hm
    case 'assay': {
      const v = c.tests.map(t => t.ok).filter((o): o is boolean => o != null)
      return v.length ? v.every(Boolean) : null
    }
  }
}

export const isFailed = (c: AnalyteTrendCoa) => c.overall === 'FAILED'

/** Which tests failed. 'other' when the COA failed on something not tracked here. */
export function failedTests(c: AnalyteTrendCoa): (TestKey | 'other')[] {
  const keys: (TestKey | 'other')[] = TEST_KEYS.filter(
    k => outcome(c, k) === false
  )
  if (isFailed(c) && keys.length === 0) keys.push('other')
  return keys
}

/** Measured vs declared, percent. null when either side is unknown. */
export function qtyDeltaPct(c: AnalyteTrendCoa): number | null {
  if (c.qty == null || !c.qty_declared) return null
  return ((c.qty - c.qty_declared) / c.qty_declared) * 100
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  const hi = s[m] ?? NaN
  return s.length % 2 ? hi : ((s[m - 1] ?? NaN) + hi) / 2
}

export const ts = (c: AnalyteTrendCoa) =>
  c.published_at ? Date.parse(c.published_at) : NaN

export function since(
  coas: AnalyteTrendCoa[],
  days: number | null,
  now: number
): AnalyteTrendCoa[] {
  if (days == null) return coas
  const cutoff = now - days * DAY_MS
  return coas.filter(c => ts(c) >= cutoff)
}

// ─── Lab-time dates ──────────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string, opts: Intl.DateTimeFormatOptions, locale = 'en-US') {
  const key = `${locale}|${tz}|${JSON.stringify(opts)}`
  let f = fmtCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts })
    fmtCache.set(key, f)
  }
  return f
}

/** YYYY-MM-DD of the instant in the lab's zone (the grouping key for "same day"). */
export function labDay(t: number, tz: string): string {
  return fmt(
    tz,
    { year: 'numeric', month: '2-digit', day: '2-digit' },
    'en-CA'
  ).format(t)
}

export const labDate = (t: number, tz: string) =>
  fmt(tz, { month: 'short', day: 'numeric', year: 'numeric' }).format(t)

export const labTick = (t: number, tz: string) =>
  fmt(tz, { month: 'numeric', day: 'numeric', year: '2-digit' }).format(t)

export const labDateTime = (t: number, tz: string) =>
  fmt(tz, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(t)

// ─── Spec ────────────────────────────────────────────────────────────────────

/** Lower bound from a purity spec like "≥98%", ">= 98.0 %", "NLT 98%". */
export function parseMinSpec(spec: string | null): number | null {
  if (!spec || !/(≥|>=|>|NLT|min)/i.test(spec)) return null
  const m = spec.match(/(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}

/** The most common purity floor across the COAs (specs can change over time). */
export function commonMinSpec(coas: AnalyteTrendCoa[]): number | null {
  const counts = new Map<number, number>()
  for (const c of coas) {
    const v = parseMinSpec(c.purity_spec)
    if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best: number | null = null
  let n = 0
  for (const [v, k] of counts) if (k > n) [best, n] = [v, k]
  return best
}

// ─── Matrix ──────────────────────────────────────────────────────────────────

export interface Tally {
  tested: number
  failed: number
}

export interface Cell extends Tally {
  recent: Tally
  prior: Tally
}

export interface ProductRow {
  product: string
  is_blend: boolean
  total: number
  failed: number
  last: number
  cells: Record<TestKey, Cell>
  qty: { n: number; median: number | null; flagged: number }
}

const tally = (): Tally => ({ tested: 0, failed: 0 })

export const rate = (t: Tally) => (t.tested ? t.failed / t.tested : 0)

/** Fail-rate change in percentage points, recent vs prior window; null if too few tests. */
export function trendPP(cell: Cell): number | null {
  if (cell.recent.tested < TREND_MIN_N || cell.prior.tested < TREND_MIN_N)
    return null
  return (rate(cell.recent) - rate(cell.prior)) * 100
}

/**
 * Per-product rollup. Counts cover `days` (null = all time); the trend windows
 * are always the last 90 days vs the prior 90, independent of the period.
 */
export function buildMatrix(
  coas: AnalyteTrendCoa[],
  now: number,
  days: number | null
): ProductRow[] {
  const cutoff = days == null ? -Infinity : now - days * DAY_MS
  const recentFrom = now - TREND_WINDOW_DAYS * DAY_MS
  const priorFrom = now - 2 * TREND_WINDOW_DAYS * DAY_MS
  const rows = new Map<string, ProductRow & { deltas: number[] }>()

  for (const c of coas) {
    let r = rows.get(c.product)
    if (!r) {
      r = {
        product: c.product,
        is_blend: c.is_blend,
        total: 0,
        failed: 0,
        last: 0,
        cells: Object.fromEntries(
          TEST_KEYS.map(k => [
            k,
            { ...tally(), recent: tally(), prior: tally() },
          ])
        ) as Record<TestKey, Cell>,
        qty: { n: 0, median: null, flagged: 0 },
        deltas: [],
      }
      rows.set(c.product, r)
    }
    const t = ts(c)
    const inPeriod = t >= cutoff
    if (inPeriod) {
      r.total++
      if (isFailed(c)) r.failed++
      r.last = Math.max(r.last, t || 0)
      const d = qtyDeltaPct(c)
      if (d != null) r.deltas.push(d)
    }
    for (const k of TEST_KEYS) {
      const o = outcome(c, k)
      if (o == null) continue
      const cell = r.cells[k]
      const win =
        t >= recentFrom ? cell.recent : t >= priorFrom ? cell.prior : null
      for (const bucket of [inPeriod ? cell : null, win]) {
        if (!bucket) continue
        bucket.tested++
        if (!o) bucket.failed++
      }
    }
  }

  return [...rows.values()]
    .filter(r => r.total > 0)
    .map(({ deltas, ...r }) => ({
      ...r,
      qty: {
        n: deltas.length,
        median: median(deltas),
        flagged: deltas.filter(d => Math.abs(d) > QTY_FLAG_PCT).length,
      },
    }))
}

export interface RisingItem {
  product: string
  is_blend: boolean
  test: TestKey
  recent: Tally
  prior: Tally
  pp: number
}

/** Product × test pairs whose fail rate rose by RISING_PP or more, biggest first. */
export function risingFailures(rows: ProductRow[]): RisingItem[] {
  const out: RisingItem[] = []
  for (const r of rows)
    for (const k of TEST_KEYS) {
      const pp = trendPP(r.cells[k])
      if (pp != null && pp >= RISING_PP)
        out.push({
          product: r.product,
          is_blend: r.is_blend,
          test: k,
          recent: r.cells[k].recent,
          prior: r.cells[k].prior,
          pp,
        })
    }
  return out.sort((a, b) => b.pp - a.pp)
}

// ─── Periods ──────────────────────────────────────────────────────────────────

export const PERIODS = [
  { key: '90d', label: '90D', days: 90 },
  { key: '6m', label: '6M', days: 182 },
  { key: '1y', label: '1Y', days: 365 },
  { key: 'all', label: 'All', days: null },
] as const
export type PeriodKey = (typeof PERIODS)[number]['key']
export const periodDays = (k: PeriodKey) =>
  PERIODS.find(p => p.key === k)?.days ?? null
