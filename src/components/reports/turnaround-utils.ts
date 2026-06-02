import type { TurnaroundSample } from '@/lib/api'

// SENAITE milestone phases (v1). Each phase is the gap between two milestone
// timestamps on a TurnaroundSample. partial_submit/partial_verify are already
// folded into submitted_at/verified_at server-side.
export type MilestoneKey =
  | 'ordered_at'
  | 'received_at'
  | 'submitted_at'
  | 'verified_at'
  | 'published_at'

export interface Phase {
  key: string
  label: string
  from: MilestoneKey
  to: MilestoneKey
}

export const PHASES: Phase[] = [
  { key: 'ordered_received', label: 'Ordered → Received', from: 'ordered_at', to: 'received_at' },
  { key: 'received_submitted', label: 'Received → Submitted', from: 'received_at', to: 'submitted_at' },
  { key: 'submitted_verified', label: 'Submitted → Verified', from: 'submitted_at', to: 'verified_at' },
  { key: 'verified_published', label: 'Verified → Published', from: 'verified_at', to: 'published_at' },
]

export type TimePeriod = '1M' | '3M' | '6M' | '1Y' | 'ALL'

export const PERIOD_DAYS: Record<TimePeriod, number | null> = {
  '1M': 30,
  '3M': 90,
  '6M': 180,
  '1Y': 365,
  ALL: null,
}

export interface PhaseStat {
  key: string
  label: string
  median: number | null // ms
  p90: number | null // ms
  n: number
}

export interface TurnaroundSummary {
  phases: PhaseStat[]
  totalMedianMs: number | null
  slowestPhaseKey: string | null
  anomalies: number // boundary pairs present but non-positive (excluded)
  cohort: number // samples that entered the pipeline (have received_at)
}

/** Linear-interpolation percentile over an ascending-sorted numeric array. q in [0,1]. */
export function percentile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null
  const idx = (sortedAsc.length - 1) * q
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  const vLo = sortedAsc[lo]
  const vHi = sortedAsc[hi]
  if (vLo === undefined || vHi === undefined) return null
  if (lo === hi) return vLo
  return vLo + (vHi - vLo) * (idx - lo)
}

/**
 * Signed duration of a phase in ms, or null if either boundary is missing.
 * Sign is preserved so callers can distinguish anomalies (<= 0) from real gaps.
 */
export function phaseDurationMs(s: TurnaroundSample, phase: Phase): number | null {
  const from = s[phase.from]
  const to = s[phase.to]
  if (!from || !to) return null
  return new Date(to).getTime() - new Date(from).getTime()
}

export function humanizeDuration(ms: number | null): string {
  if (ms == null) return '—'
  const days = ms / 86_400_000
  if (days >= 1) return `${days.toFixed(1)}d`
  const hours = ms / 3_600_000
  if (hours >= 1) return `${hours.toFixed(1)}h`
  const minutes = ms / 60_000
  if (minutes >= 1) return `${Math.round(minutes)}m`
  return `${Math.round(ms / 1000)}s`
}

export function filterByPeriod(samples: TurnaroundSample[], period: TimePeriod): TurnaroundSample[] {
  const days = PERIOD_DAYS[period]
  if (!days) return samples
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  // Cohort = samples received within the window.
  return samples.filter(s => s.received_at != null && new Date(s.received_at) >= cutoff)
}

export function aggregate(samples: TurnaroundSample[]): TurnaroundSummary {
  let anomalies = 0

  const phases: PhaseStat[] = PHASES.map(phase => {
    const durations: number[] = []
    for (const s of samples) {
      const d = phaseDurationMs(s, phase)
      if (d === null) continue // boundary missing — not an anomaly
      if (d <= 0) {
        anomalies++
        continue
      }
      durations.push(d)
    }
    durations.sort((a, b) => a - b)
    return {
      key: phase.key,
      label: phase.label,
      median: percentile(durations, 0.5),
      p90: percentile(durations, 0.9),
      n: durations.length,
    }
  })

  // End-to-end turnaround (Ordered → Published) per sample.
  const totals: number[] = []
  for (const s of samples) {
    if (s.ordered_at && s.published_at) {
      const d = new Date(s.published_at).getTime() - new Date(s.ordered_at).getTime()
      if (d > 0) totals.push(d)
    }
  }
  totals.sort((a, b) => a - b)

  const ranked = phases
    .filter(p => p.median != null)
    .sort((a, b) => (b.median ?? 0) - (a.median ?? 0))

  return {
    phases,
    totalMedianMs: percentile(totals, 0.5),
    slowestPhaseKey: ranked[0]?.key ?? null,
    anomalies,
    cohort: samples.filter(s => s.received_at != null).length,
  }
}
