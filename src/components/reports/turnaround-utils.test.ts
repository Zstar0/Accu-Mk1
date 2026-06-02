import { describe, it, expect } from 'vitest'
import type { TurnaroundSample } from '@/lib/api'
import {
  percentile,
  phaseDurationMs,
  humanizeDuration,
  aggregate,
  filterByPeriod,
  PHASES,
} from './turnaround-utils'

const DAY = 86_400_000

function mk(over: Partial<TurnaroundSample>): TurnaroundSample {
  return {
    sample_id: 'S',
    ordered_at: null,
    received_at: null,
    submitted_at: null,
    verified_at: null,
    published_at: null,
    is_test_order: false,
    ...over,
  }
}

describe('turnaround-utils', () => {
  describe('percentile', () => {
    it('handles empty and single', () => {
      expect(percentile([], 0.5)).toBeNull()
      expect(percentile([5], 0.5)).toBe(5)
    })
    it('linear-interpolates', () => {
      expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6)
      expect(percentile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 6)
    })
  })

  describe('phaseDurationMs', () => {
    const orderedReceived = PHASES[0] // ordered_at → received_at
    if (!orderedReceived) throw new Error('PHASES[0] missing')
    it('returns null when a boundary is missing', () => {
      expect(phaseDurationMs(mk({ ordered_at: '2026-01-01T00:00:00Z' }), orderedReceived)).toBeNull()
    })
    it('returns signed ms (negative preserved)', () => {
      const pos = mk({ ordered_at: '2026-01-01T00:00:00Z', received_at: '2026-01-02T00:00:00Z' })
      expect(phaseDurationMs(pos, orderedReceived)).toBe(DAY)
      const neg = mk({ ordered_at: '2026-01-02T00:00:00Z', received_at: '2026-01-01T00:00:00Z' })
      expect(phaseDurationMs(neg, orderedReceived)).toBe(-DAY)
    })
  })

  describe('humanizeDuration', () => {
    it('formats by magnitude', () => {
      expect(humanizeDuration(null)).toBe('—')
      expect(humanizeDuration(2 * DAY)).toBe('2.0d')
      expect(humanizeDuration(5 * 3_600_000)).toBe('5.0h')
      expect(humanizeDuration(30 * 60_000)).toBe('30m')
      expect(humanizeDuration(45 * 1000)).toBe('45s')
    })
  })

  describe('aggregate', () => {
    it('computes per-phase stats, slowest phase, total, cohort', () => {
      const s1 = mk({
        sample_id: 'A',
        ordered_at: '2026-01-01T00:00:00Z',
        received_at: '2026-01-01T12:00:00Z', // ordered→received 0.5d
        submitted_at: '2026-01-03T00:00:00Z', // received→submitted 1.5d
        verified_at: '2026-01-07T00:00:00Z', // submitted→verified 4d
        published_at: '2026-01-08T00:00:00Z', // verified→published 1d
      })
      const s2 = mk({
        sample_id: 'B',
        received_at: '2026-02-01T00:00:00Z',
        submitted_at: '2026-02-02T00:00:00Z', // received→submitted 1d
      })
      const summary = aggregate([s1, s2])
      const byKey = Object.fromEntries(summary.phases.map(p => [p.key, p]))

      expect(byKey.ordered_received?.n).toBe(1)
      expect(byKey.ordered_received?.median).toBeCloseTo(0.5 * DAY, 6)

      expect(byKey.received_submitted?.n).toBe(2)
      expect(byKey.received_submitted?.median).toBeCloseTo(1.25 * DAY, 6) // mid of 1d & 1.5d

      expect(byKey.submitted_verified?.n).toBe(1)
      expect(byKey.submitted_verified?.median).toBeCloseTo(4 * DAY, 6)

      expect(summary.slowestPhaseKey).toBe('submitted_verified')
      expect(summary.totalMedianMs).toBeCloseTo(7 * DAY, 6) // s1 ordered→published
      expect(summary.cohort).toBe(2)
      expect(summary.anomalies).toBe(0)
    })

    it('counts out-of-order boundaries as anomalies and excludes them', () => {
      const bad = mk({
        sample_id: 'C',
        received_at: '2026-03-02T00:00:00Z',
        submitted_at: '2026-03-01T00:00:00Z', // negative
      })
      const summary = aggregate([bad])
      const recSub = summary.phases.find(p => p.key === 'received_submitted')
      expect(recSub?.n).toBe(0)
      expect(recSub?.median).toBeNull()
      expect(summary.anomalies).toBe(1)
    })
  })

  describe('filterByPeriod', () => {
    it('ALL returns everything', () => {
      const rows = [mk({ received_at: '2020-01-01T00:00:00Z' }), mk({ received_at: null })]
      expect(filterByPeriod(rows, 'ALL')).toHaveLength(2)
    })
    it('windowed period keeps only recently-received samples', () => {
      const now = Date.now()
      const recent = mk({ sample_id: 'recent', received_at: new Date(now - 5 * DAY).toISOString() })
      const old = mk({ sample_id: 'old', received_at: new Date(now - 100 * DAY).toISOString() })
      const out = filterByPeriod([recent, old], '1M')
      expect(out.map(s => s.sample_id)).toEqual(['recent'])
    })
  })
})
