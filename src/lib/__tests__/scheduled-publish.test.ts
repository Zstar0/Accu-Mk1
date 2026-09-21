import { describe, expect, it } from 'vitest'
import {
  isParkedSchedule,
  labDate,
  localInputToIso,
  toLocalInputValue,
} from '@/lib/scheduled-publish'
import type { ScheduledPublish } from '@/lib/api'

describe('scheduled-publish helpers', () => {
  it('round-trips a datetime-local value through ISO UTC', () => {
    const iso = localInputToIso('2026-09-19T10:30') ?? ''
    expect(iso.endsWith('Z')).toBe(true)
    expect(toLocalInputValue(iso)).toBe('2026-09-19T10:30')
    expect(localInputToIso('')).toBeNull()
    expect(localInputToIso('garbage')).toBeNull()
    expect(toLocalInputValue('garbage')).toBe('')
  })

  it('previews the lab date in the lab timezone, not the browser one', () => {
    // 05:30Z on the 20th is still the 19th in Los Angeles.
    expect(labDate('2026-09-20T05:30:00Z', 'America/Los_Angeles')).toBe(
      '09/19/2026'
    )
    expect(labDate('2026-09-20T12:30:00Z', 'America/Los_Angeles')).toBe(
      '09/20/2026'
    )
    expect(labDate('nope', 'America/Los_Angeles')).toBe('')
  })

  it('parks only pending and firing schedules', () => {
    const base: ScheduledPublish = {
      id: 1,
      sample_id: 'P-1',
      scheduled_at: '2026-09-19T17:00:00Z',
      pdf_date: '09/19/2026',
      status: 'pending',
      created_by_user_id: 1,
      created_at: '2026-09-17T22:00:00Z',
      fired_at: null,
      last_error: null,
    }
    expect(isParkedSchedule(base)).toBe(true)
    expect(isParkedSchedule({ ...base, status: 'firing' })).toBe(true)
    expect(isParkedSchedule({ ...base, status: 'failed' })).toBe(false)
    expect(isParkedSchedule(null)).toBe(false)
    expect(isParkedSchedule(undefined)).toBe(false)
  })
})
