import { describe, it, expect } from 'vitest'
import {
  businessDayMinutes,
  formatMinutes,
  formatTarget,
  tierUnits,
} from '@/lib/sla-format'

describe('formatTarget', () => {
  it('renders sub-hour as minutes', () => {
    expect(formatTarget(30)).toBe('30m')
    expect(formatTarget(45)).toBe('45m')
  })

  it('renders whole hours below 24h without a day suffix', () => {
    expect(formatTarget(60)).toBe('1h')
    expect(formatTarget(240)).toBe('4h')
    expect(formatTarget(1380)).toBe('23h')
  })

  it('appends day equivalent at exactly 24h', () => {
    expect(formatTarget(1440)).toBe('24h (1d)')
  })

  it('appends day equivalent for multi-day targets', () => {
    expect(formatTarget(2880)).toBe('48h (2d)')
    expect(formatTarget(4320)).toBe('72h (3d)')
    expect(formatTarget(20160)).toBe('336h (14d)')
  })

  it('handles partial-day targets above 24h', () => {
    // 1500 min = 25h (whole hour) → base is hours form.
    expect(formatTarget(1500)).toBe('25h (1d 1h)')
    // 1620 min = 27h (whole hour) → "27h (1d 3h)".
    expect(formatTarget(1620)).toBe('27h (1d 3h)')
    // 1485 min = 24h 45m (not a whole hour) → base falls back to minutes form.
    expect(formatTarget(1485)).toBe('1485m (1d 1h)')
  })
})

describe('formatMinutes', () => {
  it('renders minutes under an hour', () => {
    expect(formatMinutes(30)).toBe('30m')
    expect(formatMinutes(-30)).toBe('30m') // absolute value
  })

  it('renders fractional hours under a day', () => {
    expect(formatMinutes(90)).toBe('1.5h')
    expect(formatMinutes(60)).toBe('1h')
  })

  it('renders days + hours for ≥24h', () => {
    expect(formatMinutes(1440)).toBe('1d')
    expect(formatMinutes(2880)).toBe('2d')
    expect(formatMinutes(1500)).toBe('1d 1h')
  })
})

// Business-hours tiers count only the lab's open window, so their "day" is a
// business day (open..close, 8h on prod), not 24h, and their units say so:
// bh / bd. Reported 2026-09-21: a 48 business-hour target read "48h (2d)"
// when it is six business days.
describe('business units', () => {
  const BIZ = { dayMinutes: 480, business: true } // 09:00-17:00
  const CAL = { dayMinutes: 1440, business: false }

  it('businessDayMinutes reads the open..close window', () => {
    expect(
      businessDayMinutes({ open_time: '09:00:00', close_time: '17:00:00' })
    ).toBe(480)
    expect(
      businessDayMinutes({ open_time: '08:00:00', close_time: '17:00:00' })
    ).toBe(540)
    expect(
      businessDayMinutes({ open_time: '08:30', close_time: '16:00' })
    ).toBe(450)
  })

  it('businessDayMinutes is undefined for a missing or inverted window', () => {
    expect(businessDayMinutes(null)).toBeUndefined()
    expect(businessDayMinutes(undefined)).toBeUndefined()
    expect(
      businessDayMinutes({ open_time: '17:00:00', close_time: '09:00:00' })
    ).toBeUndefined()
    expect(
      businessDayMinutes({ open_time: 'junk', close_time: '17:00:00' })
    ).toBeUndefined()
  })

  it('tierUnits: business tiers are bh/bd at the configured day, others are calendar', () => {
    expect(tierUnits({ business_hours_only: true, day_minutes: 480 })).toEqual(
      BIZ
    )
    expect(tierUnits({ business_hours_only: false, day_minutes: 480 })).toEqual(
      CAL
    )
    expect(tierUnits(null)).toEqual(CAL)
    // business tier, day length not known yet: still bh, never rolls to days
    const unknown = tierUnits({ business_hours_only: true })
    expect(unknown.business).toBe(true)
    expect(formatMinutes(2592, unknown)).toBe('43.2bh')
    expect(formatTarget(2880, unknown)).toBe('48bh')
  })

  it('formatTarget sizes the day part in business days with bh/bd units', () => {
    expect(formatTarget(1920, BIZ)).toBe('32bh (4bd)')
    expect(formatTarget(1440, BIZ)).toBe('24bh (3bd)')
    expect(formatTarget(2880, BIZ)).toBe('48bh (6bd)')
    expect(formatTarget(6720, BIZ)).toBe('112bh (14bd)')
    expect(formatTarget(240, BIZ)).toBe('4bh') // under one business day
    expect(formatTarget(1200, BIZ)).toBe('20bh (2bd 4bh)')
  })

  it('formatMinutes rolls over at the business day, not at 24h', () => {
    expect(formatMinutes(288, BIZ)).toBe('4.8bh')
    expect(formatMinutes(45, BIZ)).toBe('45m') // minutes are minutes
    expect(formatMinutes(480, BIZ)).toBe('1bd')
    expect(formatMinutes(2592, BIZ)).toBe('5bd 3bh') // the reported sample: 43.2 bh elapsed
    expect(formatMinutes(-1152, BIZ)).toBe('2bd 3bh')
  })

  it('calendar tiers are unchanged', () => {
    expect(formatMinutes(288, CAL)).toBe('4.8h')
    expect(formatMinutes(2592, CAL)).toBe('1d 19h')
    expect(formatTarget(2880, CAL)).toBe('48h (2d)')
    expect(formatTarget(2880)).toBe('48h (2d)')
  })

  it('never prints a full day as hours (rounding carry)', () => {
    expect(formatMinutes(480 + 455, BIZ)).toBe('2bd') // 1bd 7.6bh rounds up to 2bd, not "1bd 8bh"
    expect(formatMinutes(1440 + 1425)).toBe('2d') // same carry on 24h days
  })
})
