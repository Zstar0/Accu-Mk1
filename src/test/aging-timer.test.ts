import { describe, it, expect } from 'vitest'
import { parseReceivedAtMs, formatAge } from '@/components/hplc/AgingTimer'

describe('parseReceivedAtMs', () => {
  it('treats a timezone-less ISO string as UTC (API contract is UTC)', () => {
    // A naive ISO string must NOT be read as browser-local — that is the bug
    // that made a just-created order show a negative age (~ -5h in CDT).
    expect(parseReceivedAtMs('2026-06-26T18:00:00')).toBe(Date.UTC(2026, 5, 26, 18, 0, 0))
  })

  it('respects an explicit trailing Z', () => {
    expect(parseReceivedAtMs('2026-06-26T18:00:00Z')).toBe(Date.UTC(2026, 5, 26, 18, 0, 0))
  })

  it('respects an explicit numeric offset', () => {
    expect(parseReceivedAtMs('2026-06-26T13:00:00-05:00')).toBe(Date.UTC(2026, 5, 26, 18, 0, 0))
  })
})

describe('formatAge', () => {
  it('clamps a negative age to 0 (never renders "-5h -59m")', () => {
    expect(formatAge(-5 * 3_600_000)).toBe('0h 0m')
  })

  it('formats sub-day ages as Xh Ym', () => {
    expect(formatAge(2 * 3_600_000 + 30 * 60_000)).toBe('2h 30m')
  })

  it('formats multi-day ages as Xd Yh', () => {
    expect(formatAge((26 * 3_600 + 0) * 1_000)).toBe('1d 2h')
  })
})
