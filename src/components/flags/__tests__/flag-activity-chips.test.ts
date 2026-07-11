import { describe, expect, it } from 'vitest'
import { filterActivity } from '@/components/flags/flag-activity'
import type { ActivityItem } from '@/lib/flags-api'

const item = (id: number, relevance: string[]): ActivityItem => ({
  id,
  event_type: 'commented',
  actor_id: 1,
  from_value: null,
  to_value: null,
  created_at: '',
  relevance,
  flag: {} as never,
})

describe('filterActivity', () => {
  const items = [
    item(1, ['actor']),
    item(2, ['assigned']),
    item(3, ['raised', 'watching']),
    item(4, ['mentioned']),
  ]
  it('all passes everything', () =>
    expect(filterActivity(items, 'all')).toHaveLength(4))
  it('actor', () =>
    expect(filterActivity(items, 'actor').map(i => i.id)).toEqual([1]))
  it('mine = assigned ∪ raised', () =>
    expect(filterActivity(items, 'mine').map(i => i.id)).toEqual([2, 3]))
  it('watching', () =>
    expect(filterActivity(items, 'watching').map(i => i.id)).toEqual([3]))
  it('mentioned', () =>
    expect(filterActivity(items, 'mentioned').map(i => i.id)).toEqual([4]))
})
