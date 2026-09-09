/**
 * Pure helpers for the SLA Performance report.
 *
 * The backend (`GET /reports/sla-performance`) already returns finished
 * aggregates — cohorts, the delivery curve, the stage split and the department
 * gating cut — because the gating cut alone needs a verified timestamp per
 * (sample, family). What is left here is presentation: reading a family's
 * numbers out of the free-form gating trend rows, picking a month that can
 * carry a claim, and formatting business hours.
 */

import type {
  SlaPerfGating,
  SlaPerfGatingMonth,
  SlaPerfMonth,
  SlaPerfStats,
} from '@/lib/api'

export type {
  SlaPerfGating,
  SlaPerfGatingFamily,
  SlaPerfGatingMonth,
  SlaPerfMonth,
  SlaPerfReport,
  SlaPerfStats,
} from '@/lib/api'

/** Families that can gate a COA, in reading order. Mirrors the engine. */
export const GATING_FAMILIES = ['hplc', 'ster', 'endo', 'bacw', 'hm'] as const
export type GatingFamilyKey = (typeof GATING_FAMILIES)[number]

export const FAMILY_LABELS: Record<GatingFamilyKey, string> = {
  hplc: 'HPLC panel',
  ster: 'Sterility',
  endo: 'Endotoxin',
  bacw: 'Bac Water panel',
  hm: 'Heavy metals',
}

/** Hardcoded like the sibling reports' palettes — these are report colours, not
 *  theme tokens. Shared with the Lab Throughput family colours on purpose. */
export const FAMILY_COLORS: Record<GatingFamilyKey, string> = {
  hplc: '#1FA3BE',
  ster: '#d95926',
  endo: '#9085e9',
  bacw: '#c98500',
  hm: '#f472b6',
}

/** A gating trend row carries per-family keys (`ster`, `ster_gate_late`, …) as
 *  data. These readers keep the `unknown` indexing in one place. */
export function trendNumber(row: SlaPerfGatingMonth, key: string): number {
  const v = row[key]
  return typeof v === 'number' ? v : 0
}

export function trendMedian(
  row: SlaPerfGatingMonth,
  family: string
): number | null {
  const v = row[family]
  return typeof v === 'number' ? v : null
}

/** Share of that month's late samples this family finished last on. */
export function gateShare(row: SlaPerfGatingMonth, family: string): number {
  if (!row.late_total) return 0
  return (trendNumber(row, `${family}_gate_late`) / row.late_total) * 100
}

/**
 * The newest month whose claim is worth making.
 *
 * The current month is always partial, and once the report is scoped to one
 * customer it can hold two or three late samples — which is noise, not a
 * bottleneck. Fall back to the newest month only when nothing clears the bar.
 */
export function readableMonth(
  trend: SlaPerfGatingMonth[],
  minLate: number
): SlaPerfGatingMonth | null {
  if (trend.length === 0) return null
  const solid = trend.filter(t => t.late_total >= minLate)
  return solid[solid.length - 1] ?? trend[trend.length - 1] ?? null
}

/**
 * The family that finished last most often in a month, or null if none did.
 *
 * Pass `thin` (the families the engine flagged as having too few timed samples)
 * and a thin winner returns null rather than being named. The runner-up is not
 * promoted in its place: if the department that actually gated the most work
 * cannot carry a claim, there is no claim to make, and saying "sterility led"
 * while heavy metals quietly gated more would be its own distortion.
 */
export function leadingFamily(
  row: SlaPerfGatingMonth | null,
  thin?: ReadonlySet<string>
): GatingFamilyKey | null {
  if (!row || !row.late_total) return null
  let best: GatingFamilyKey | null = null
  let bestN = 0
  for (const f of GATING_FAMILIES) {
    const n = trendNumber(row, `${f}_gate_late`)
    if (n > bestN) {
      best = f
      bestN = n
    }
  }
  if (best && thin?.has(best)) return null
  return best
}

/** Families with enough timed samples in the trend to draw a line for. */
export function chartableFamilies(
  trend: SlaPerfGatingMonth[],
  minN = 3
): GatingFamilyKey[] {
  return GATING_FAMILIES.filter(f =>
    trend.some(t => trendNumber(t, `${f}_n`) >= minN)
  )
}

/** Percentage-point change, or null when there is nothing to compare against. */
export function deltaPoints(
  current: SlaPerfStats,
  previous: SlaPerfStats
): number | null {
  if (previous.n === 0) return null
  return Math.round((current.rate - previous.rate) * 10) / 10
}

/** "21.3 bh" — business hours, one decimal, trailing zero dropped. */
export function bh(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} bh`
}

export function pct(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`
}

/** Cohort months that actually received work, oldest first. */
export function cohortsWithWork(months: SlaPerfMonth[]): SlaPerfMonth[] {
  return months.filter(m => m.received > 0)
}

/** The strongest and weakest complete cohort, ignoring the partial month. */
export function bestAndWorst(
  months: SlaPerfMonth[],
  today: string
): { best: SlaPerfMonth | null; worst: SlaPerfMonth | null } {
  const complete = months.filter(
    m => m.m !== today.slice(0, 7) && m.received > 0
  )
  const pool = complete.length > 0 ? complete : months
  if (pool.length === 0) return { best: null, worst: null }
  let best = pool[0] ?? null
  let worst = pool[0] ?? null
  for (const m of pool) {
    if (best && m.rate_received > best.rate_received) best = m
    if (worst && m.rate_received < worst.rate_received) worst = m
  }
  return { best, worst }
}

/** Open work older than the last two receipt months is stale, not in progress. */
export function staleOpen(months: SlaPerfMonth[]): number {
  return months
    .slice(0, Math.max(0, months.length - 2))
    .reduce((n, m) => n + m.open, 0)
}

/** Does the gating section have enough to say anything at all? */
export function hasGatingSignal(gating: SlaPerfGating): boolean {
  return gating.late_mixed > 0 && gating.trend.length > 0
}
