import { describe, expect, it } from 'vitest'
import { activityVerb } from '@/components/flags/flag-activity'
import type { ActivityItem } from '@/lib/flags-api'

const base: ActivityItem = {
  id: 1,
  event_type: 'raised',
  actor_id: 7,
  from_value: null,
  to_value: null,
  created_at: '2026-07-01T00:00:00Z',
  flag: {} as ActivityItem['flag'],
}
const opts = {
  nameOf: (id: number | null) => (id === 2 ? 'Alice' : `User ${id}`),
  statusLabelOf: (slug: string) => (slug === 'blocked' ? 'Blocked' : slug),
}

describe('activityVerb', () => {
  it('raised', () => {
    expect(activityVerb({ ...base, event_type: 'raised' }, 7, opts)).toBe(
      'raised this flag'
    )
  })
  it('assigned to you when to_value is me', () => {
    const i = { ...base, event_type: 'assigned', to_value: '5' }
    expect(activityVerb(i, 5, opts)).toBe('assigned this to you')
  })
  it('assigned to a named other', () => {
    const i = { ...base, event_type: 'assigned', to_value: '2' }
    expect(activityVerb(i, 5, opts)).toBe('assigned this to Alice')
  })
  it('status change uses the resolved status label', () => {
    const i = { ...base, event_type: 'status_changed', to_value: 'blocked' }
    expect(activityVerb(i, 7, opts)).toBe('moved this to Blocked')
  })
  it('commented', () => {
    expect(activityVerb({ ...base, event_type: 'commented' }, 7, opts)).toBe(
      'commented'
    )
  })
  it('falls back for unknown types', () => {
    expect(activityVerb({ ...base, event_type: 'weird' }, 7, opts)).toBe(
      'updated this'
    )
  })
})
