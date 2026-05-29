import { describe, it, expect } from 'vitest'
import { formatMinutes, formatTarget } from '@/lib/sla-format'

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
