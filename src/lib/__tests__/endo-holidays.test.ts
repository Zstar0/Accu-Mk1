import { describe, it, expect } from 'vitest'
import {
  holidaysBetween,
  labDate,
  labTime,
  type LabCalendar,
} from '@/lib/endo-prep'

const cal: LabCalendar = {
  timezone: 'America/Los_Angeles',
  workingDays: [0, 1, 2, 3, 4],
  holidays: new Map([
    ['2026-05-25', 'Memorial Day'],
    ['2026-09-07', 'Labor Day'],
  ]),
}

describe('holidaysBetween', () => {
  it('names the lab holidays that fall after received and up to the due date', () => {
    expect(holidaysBetween('2026-09-04', '2026-09-10', cal)).toEqual([
      { iso: '2026-09-07', name: 'Labor Day' },
    ])
    expect(holidaysBetween('2026-09-11', '2026-09-16', cal)).toEqual([])
    expect(holidaysBetween(null, '2026-09-16', cal)).toEqual([])
    expect(holidaysBetween('2026-09-16', null, cal)).toEqual([])
  })
})

describe('labDate (kept after the SLA switch)', () => {
  it('reads an SLA due_at in the lab time zone', () => {
    // 2026-09-17T00:30Z is still the evening of the 16th in Los Angeles.
    expect(labDate('2026-09-17T00:30:00Z', cal)).toBe('2026-09-16')
  })
})

describe('labTime', () => {
  it('gives the clock time in the lab zone, for zoned and naive-UTC stamps alike', () => {
    // 23:30 UTC on Sep 17 is 4:30 PM the same day in Los Angeles (PDT).
    expect(labTime('2026-09-17T23:30:00Z', cal)).toBe('4:30 PM')
    expect(labTime('2026-09-17T23:30:00', cal)).toBe('4:30 PM')
  })

  it('has no time to show for a bare date or nothing at all', () => {
    expect(labTime('2026-09-17', cal)).toBeNull()
    expect(labTime(null, cal)).toBeNull()
    expect(labTime('not a date', cal)).toBeNull()
  })
})
