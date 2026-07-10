import { describe, it, expect } from 'vitest'
import { dueLabel } from '@/components/flags/flag-format'

const now = new Date('2026-07-09T12:00:00Z')

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
