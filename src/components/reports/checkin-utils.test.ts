import { describe, it, expect } from 'vitest'
import type { CheckInRecord } from '@/lib/api'
import {
  localHour,
  isOffHours,
  bucketByHour,
  bucketByDay,
  computeSummary,
  filterByPeriod,
  minutesToLabel,
  formatHourLabel,
} from './checkin-utils'

// Build a record at a given *local* wall-clock time. Constructing from a local
// Date and reading it back in local time keeps these tests independent of the
// machine timezone (the helpers bucket in browser-local time by design).
function rec(
  uid: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi = 0,
  over: Partial<CheckInRecord> = {}
): CheckInRecord {
  return {
    sample_id: `S-${uid}`,
    sample_uid: uid,
    date_received: new Date(y, mo, d, h, mi).toISOString(),
    product_label: null,
    priority: 'normal',
    is_test_order: false,
    ...over,
  }
}

describe('checkin-utils', () => {
  describe('localHour', () => {
    it('returns the local wall-clock hour', () => {
      expect(localHour(new Date(2026, 0, 15, 14, 30).toISOString())).toBe(14)
      expect(localHour(new Date(2026, 0, 15, 0, 5).toISOString())).toBe(0)
    })
  })

  describe('isOffHours', () => {
    it('flags hours outside 9–17 (end-exclusive)', () => {
      expect(isOffHours(8)).toBe(true)
      expect(isOffHours(9)).toBe(false)
      expect(isOffHours(16)).toBe(false)
      expect(isOffHours(17)).toBe(true)
      expect(isOffHours(23)).toBe(true)
    })
  })

  describe('formatHourLabel / minutesToLabel', () => {
    it('formats 12-hour labels', () => {
      expect(formatHourLabel(0)).toBe('12 AM')
      expect(formatHourLabel(9)).toBe('9 AM')
      expect(formatHourLabel(14)).toBe('2 PM')
      expect(minutesToLabel(null)).toBe('—')
      expect(minutesToLabel(0)).toBe('12:00 AM')
      expect(minutesToLabel(630)).toBe('10:30 AM')
      expect(minutesToLabel(870)).toBe('2:30 PM')
    })
  })

  describe('bucketByHour', () => {
    it('produces 24 buckets with counts and off-hours flags', () => {
      const records = [
        rec('a', 2026, 0, 15, 10, 0),
        rec('b', 2026, 0, 15, 10, 45),
        rec('c', 2026, 0, 16, 20, 0), // off-hours
      ]
      const buckets = bucketByHour(records)
      expect(buckets).toHaveLength(24)
      expect(buckets[10]).toEqual({ hour: 10, count: 2, offHours: false })
      expect(buckets[20]).toEqual({ hour: 20, count: 1, offHours: true })
      expect(buckets[11]?.count).toBe(0)
    })
  })

  describe('bucketByDay', () => {
    it('groups by local day, sorted ascending', () => {
      const records = [
        rec('a', 2026, 0, 16, 9),
        rec('b', 2026, 0, 15, 9),
        rec('c', 2026, 0, 15, 14),
      ]
      const buckets = bucketByDay(records)
      expect(buckets.map(b => b.day)).toEqual(['2026-01-15', '2026-01-16'])
      expect(buckets[0]?.count).toBe(2)
      expect(buckets[1]?.count).toBe(1)
    })
  })

  describe('computeSummary', () => {
    it('returns null-ish summary for no records', () => {
      const s = computeSummary([])
      expect(s).toEqual({
        total: 0,
        avgMinutes: null,
        avgLabel: '—',
        busiestHour: null,
        busiestWeekday: null,
      })
    })

    it('computes total, average time of day, busiest hour and weekday', () => {
      // 2026-01-15 is a Thursday.
      const records = [
        rec('a', 2026, 0, 15, 10, 0), // 600 min, hour 10, Thu
        rec('b', 2026, 0, 15, 10, 30), // 630 min, hour 10, Thu
        rec('c', 2026, 0, 16, 14, 0), // 840 min, hour 14, Fri
      ]
      const s = computeSummary(records)
      expect(s.total).toBe(3)
      expect(s.avgMinutes).toBeCloseTo((600 + 630 + 840) / 3, 5)
      expect(s.busiestHour).toBe(10)
      expect(s.busiestWeekday).toBe('Thu')
    })
  })

  describe('filterByPeriod', () => {
    it('ALL returns every record', () => {
      const records = [rec('a', 2020, 0, 1, 10), rec('b', 2026, 0, 1, 10)]
      expect(filterByPeriod(records, 'ALL')).toHaveLength(2)
    })

    it('excludes records older than the window', () => {
      const now = new Date()
      const recent = {
        ...rec('recent', 2000, 0, 1, 10),
        date_received: new Date(now.getTime() - 5 * 86_400_000).toISOString(),
      }
      const old = {
        ...rec('old', 2000, 0, 1, 10),
        date_received: new Date(now.getTime() - 100 * 86_400_000).toISOString(),
      }
      const out = filterByPeriod([recent, old], '1M')
      expect(out.map(r => r.sample_uid)).toEqual(['recent'])
    })
  })
})
