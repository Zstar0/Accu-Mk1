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

  // "For me" = notifications I received: events NOT authored by me (no 'actor')
  // that involve my flags/mentions (assigned|raised|watching|mentioned).
  it('forme excludes my own actions but keeps events others did on my flags', () => {
    const set = [
      item(1, ['actor']), // my own action → excluded
      item(2, ['assigned']), // someone assigned me → included
      item(3, ['raised', 'watching']), // on a flag I raised/watch → included
      item(4, ['mentioned']), // I was mentioned → included
      item(5, ['actor', 'assigned']), // I did it (even on my flag) → excluded
      item(6, ['watching']), // change on a flag I watch → included
    ]
    expect(filterActivity(set, 'forme').map(i => i.id)).toEqual([2, 3, 4, 6])
  })
})
