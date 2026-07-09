import { describe, it, expect } from 'vitest'
import type { FlagResponse, EntityContext } from '@/lib/flags-api'
import {
  filterFlags,
  EMPTY_FLAG_FILTER,
  type FlagFilterState,
} from '@/components/flags/flag-filter'

function flag(
  over: Partial<FlagResponse> & { entity?: EntityContext | null } = {}
): FlagResponse {
  return {
    id: 1,
    entity_type: 'sample',
    entity_id: 'P-0001',
    kind: 'issue',
    type: 'blocker',
    status: 'open',
    title: 'Crashed out — needs re-prep',
    created_by: 1,
    assignee_id: 1,
    created_at: '2026-06-30T12:00:00',
    updated_at: '2026-06-30T12:00:00',
    resolved_at: null,
    resolved_by: null,
    ...over,
  }
}

const filter = (over: Partial<FlagFilterState>): FlagFilterState => ({
  ...EMPTY_FLAG_FILTER,
  ...over,
})

describe('filterFlags', () => {
  it('returns the list unchanged when all filters are empty', () => {
    const flags = [flag({ id: 1 }), flag({ id: 2 })]
    expect(filterFlags(flags, EMPTY_FLAG_FILTER)).toBe(flags)
  })

  it('matches text against the title (case-insensitive)', () => {
    const flags = [
      flag({ id: 1, title: 'Photo missing' }),
      flag({ id: 2, title: 'Crashed out' }),
    ]
    const out = filterFlags(flags, filter({ text: 'PHOTO' }))
    expect(out.map(f => f.id)).toEqual([1])
  })

  it('matches text against the sample id from entity context', () => {
    const flags = [
      flag({
        id: 1,
        title: 'A',
        entity_type: 'sub_sample',
        entity_id: '99',
        entity: {
          entity_type: 'sub_sample',
          entity_id: '99',
          label: 'P-0071-S01',
          sample_id: 'P-0071',
          analyses: [],
          lot: null,
          deep_link: { kind: 'sample', id: 'P-0071' },
        },
      }),
      flag({ id: 2, title: 'B', entity_id: 'P-9999' }),
    ]
    const out = filterFlags(flags, filter({ text: 'p-0071' }))
    expect(out.map(f => f.id)).toEqual([1])
  })

  it('falls back to entity label then entity_id for the sample token', () => {
    const flags = [
      flag({
        id: 1,
        title: 'A',
        entity: {
          entity_type: 'sample',
          entity_id: 'P-0001',
          label: 'Batch-Alpha',
          sample_id: null,
          analyses: [],
          lot: null,
          deep_link: { kind: 'sample', id: 'P-0001' },
        },
      }),
      flag({ id: 2, title: 'B', entity_id: 'W-0500', entity: null }),
    ]
    expect(
      filterFlags(flags, filter({ text: 'batch' })).map(f => f.id)
    ).toEqual([1])
    expect(
      filterFlags(flags, filter({ text: 'w-0500' })).map(f => f.id)
    ).toEqual([2])
  })

  it('filters by status', () => {
    const flags = [
      flag({ id: 1, status: 'open' }),
      flag({ id: 2, status: 'blocked' }),
      flag({ id: 3, status: 'resolved' }),
    ]
    expect(
      filterFlags(flags, filter({ status: 'blocked' })).map(f => f.id)
    ).toEqual([2])
  })

  it("'all_open' keeps open/in_progress/blocked, drops resolved/closed", () => {
    const flags = [
      flag({ id: 1, status: 'open' }),
      flag({ id: 2, status: 'in_progress' }),
      flag({ id: 3, status: 'blocked' }),
      flag({ id: 4, status: 'resolved' }),
      flag({ id: 5, status: 'closed' }),
    ]
    expect(
      filterFlags(flags, filter({ status: 'all_open' })).map(f => f.id)
    ).toEqual([1, 2, 3])
  })

  it('filters by entity type', () => {
    const flags = [
      flag({ id: 1, entity_type: 'sample' }),
      flag({ id: 2, entity_type: 'sub_sample' }),
      flag({ id: 3, entity_type: 'worksheet' }),
    ]
    expect(
      filterFlags(flags, filter({ entityType: 'worksheet' })).map(f => f.id)
    ).toEqual([3])
  })

  it('filters by flag type', () => {
    const flags = [
      flag({ id: 1, type: 'blocker' }),
      flag({ id: 2, type: 'question' }),
      flag({ id: 3, type: 'critical' }),
    ]
    expect(
      filterFlags(flags, filter({ type: 'question' })).map(f => f.id)
    ).toEqual([2])
  })

  it('combines text + status + entity type (all must match)', () => {
    const flags = [
      flag({
        id: 1,
        title: 'prep issue',
        status: 'open',
        entity_type: 'sample',
      }),
      flag({
        id: 2,
        title: 'prep issue',
        status: 'blocked',
        entity_type: 'sample',
      }),
      flag({
        id: 3,
        title: 'prep issue',
        status: 'open',
        entity_type: 'worksheet',
      }),
    ]
    const out = filterFlags(
      flags,
      filter({ text: 'prep', status: 'open', entityType: 'sample' })
    )
    expect(out.map(f => f.id)).toEqual([1])
  })

  it('returns an empty array when nothing matches', () => {
    const flags = [flag({ id: 1, title: 'A' })]
    expect(filterFlags(flags, filter({ text: 'zzz' }))).toEqual([])
  })
})
