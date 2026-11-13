import { describe, it, expect } from 'vitest'
import { dueLabel, formatDateTime } from '@/components/flags/flag-format'

const now = new Date('2026-07-09T12:00:00Z')

describe('formatDateTime', () => {
  it('shows the date, not just the clock', () => {
    const out = formatDateTime('2026-07-03T12:00:00Z', now)
    expect(out).toMatch(/Jul/)
    expect(out).toMatch(/\d:\d\d/)
    expect(out).not.toMatch(/2026/)
  })
  it('adds the year outside the current one', () =>
    expect(formatDateTime('2025-12-30T12:00:00Z', now)).toMatch(/2025/))
  it('naive timestamps are UTC', () =>
    expect(formatDateTime('2026-07-03T12:00:00', now)).toBe(
      formatDateTime('2026-07-03T12:00:00Z', now)
    ))
  it('empty', () => expect(formatDateTime('', now)).toBe(''))
})

describe('dueLabel', () => {
  it('future', () =>
    expect(dueLabel('2026-07-11T17:00:00Z', now)).toEqual({
      text: 'due in 2d',
      overdue: false,
    }))
  it('past', () =>
    expect(dueLabel('2026-07-06T17:00:00Z', now)).toEqual({
      text: 'overdue 3d',
      overdue: true,
    }))
  it('today', () =>
    expect(dueLabel('2026-07-09T17:00:00Z', now)).toEqual({
      text: 'due today',
      overdue: false,
    }))
  it('null', () => expect(dueLabel(null, now)).toBeNull())
})
