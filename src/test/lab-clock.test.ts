import { describe, it, expect } from 'vitest'
import { labClockState } from '@/lib/lab-clock'
import type { BusinessHoursConfig } from '@/lib/api'

// Prod config: 09:00-17:00 Pacific, Mon-Fri.
const cfg: BusinessHoursConfig = {
  open_time: '09:00:00',
  close_time: '17:00:00',
  timezone: 'America/Los_Angeles',
  working_days: [0, 1, 2, 3, 4],
}
const none = new Set<string>()
// September 2026 is PDT (UTC-7). Sep 21 is a Monday.
const pt = (iso: string) => new Date(`${iso}-07:00`)

describe('labClockState', () => {
  it('is open inside the window on a working day', () => {
    const s = labClockState(pt('2026-09-21T13:49:00'), cfg, none)
    expect(s).toEqual({ paused: false, reason: 'open', resumesAt: null })
  })

  it('pauses after close and resumes at the next open', () => {
    const s = labClockState(pt('2026-09-21T19:17:00'), cfg, none)
    expect(s.paused).toBe(true)
    expect(s.reason).toBe('after_close')
    expect(s.resumesAt?.toISOString()).toBe(
      pt('2026-09-22T09:00:00').toISOString()
    )
  })

  it('pauses before open and resumes the same morning', () => {
    const s = labClockState(pt('2026-09-22T07:30:00'), cfg, none)
    expect(s.reason).toBe('before_open')
    expect(s.resumesAt?.toISOString()).toBe(
      pt('2026-09-22T09:00:00').toISOString()
    )
  })

  it('a Friday evening resumes Monday morning', () => {
    const s = labClockState(pt('2026-09-18T18:00:00'), cfg, none)
    expect(s.reason).toBe('after_close')
    expect(s.resumesAt?.toISOString()).toBe(
      pt('2026-09-21T09:00:00').toISOString()
    )
  })

  it('a weekend is a closed day', () => {
    const s = labClockState(pt('2026-09-19T12:00:00'), cfg, none)
    expect(s.reason).toBe('closed_day')
    expect(s.resumesAt?.toISOString()).toBe(
      pt('2026-09-21T09:00:00').toISOString()
    )
  })

  it('a lab holiday pauses the whole day and is skipped when resuming', () => {
    const holidays = new Set(['2026-09-22'])
    const onTheDay = labClockState(pt('2026-09-22T11:00:00'), cfg, holidays)
    expect(onTheDay.reason).toBe('holiday')
    expect(onTheDay.resumesAt?.toISOString()).toBe(
      pt('2026-09-23T09:00:00').toISOString()
    )
    const nightBefore = labClockState(pt('2026-09-21T19:00:00'), cfg, holidays)
    expect(nightBefore.resumesAt?.toISOString()).toBe(
      pt('2026-09-23T09:00:00').toISOString()
    )
  })

  it('judges on the lab clock, not the viewer clock', () => {
    // 4:30 PM Pacific = 6:30 PM Central. The lab is open.
    const s = labClockState(new Date('2026-09-21T23:30:00Z'), cfg, none)
    expect(s.paused).toBe(false)
  })

  it('follows a changed open time', () => {
    const early = { ...cfg, open_time: '08:00:00' }
    const s = labClockState(pt('2026-09-22T08:30:00'), early, none)
    expect(s.paused).toBe(false)
  })

  it('never resumes when no working day exists', () => {
    const s = labClockState(
      pt('2026-09-21T19:00:00'),
      { ...cfg, working_days: [] },
      none
    )
    expect(s.paused).toBe(true)
    expect(s.resumesAt).toBeNull()
  })
})
