import { describe, it, expect } from 'vitest'
import {
  familyPriorityRank,
  groupInboxFamilies,
  familyDragItems,
  familyDateReceived,
  varianceParentIds,
} from '@/lib/inbox-families'
import type { InboxVialItem } from '@/lib/api'

function vial(over: Partial<InboxVialItem>): InboxVialItem {
  return {
    uid: 'u1',
    sample_id: 'P-0001-S01',
    is_parent: false,
    parent_sample_id: 'P-0001',
    assignment_role: 'hplc',
    vial_sequence: 1,
    vial_total: 2,
    container_mode: true,
    title: '',
    client_id: null,
    client_order_number: null,
    date_received: '2026-06-10T12:00:00+00:00',
    review_state: 'sample_received',
    priority: 'normal',
    assignment_summary: '',
    analyses: [
      {
        uid: 'a1', title: 'Peptide Purity (HPLC)', keyword: 'HPLC-PUR',
        peptide_name: 'BPC-157', method: null, review_state: 'unassigned',
        group_id: 1, group_name: 'Analytics', group_color: 'sky',
      },
    ],
    ...over,
  } as InboxVialItem
}

describe('groupInboxFamilies', () => {
  it('groups vials by parent and orders vials by sequence (parent row first)', () => {
    const fams = groupInboxFamilies([
      vial({ uid: 'b2', parent_sample_id: 'P-02', sample_id: 'P-02-S02', vial_sequence: 2 }),
      vial({ uid: 'b1', parent_sample_id: 'P-02', sample_id: 'P-02-S01', vial_sequence: 1 }),
      vial({ uid: 'p3', parent_sample_id: 'P-03', sample_id: 'P-03', is_parent: true, vial_sequence: 0 }),
    ])
    expect(fams.map(f => f.parentSampleId)).toEqual(['P-02', 'P-03'])
    expect(fams[0]!.vials.map(v => v.sample_id)).toEqual(['P-02-S01', 'P-02-S02'])
  })

  it('a mixed-priority family stays together, ranked by its most urgent vial', () => {
    // Ordering reads the CATALOG RANK off `priority_effective`, not the legacy
    // string. Parent ids are chosen so alphabetical tie-break would give the
    // opposite order — only the rank can produce the expected one.
    const eff = (key: string, rank: number) => ({
      key,
      rank,
      source_level: 'vial' as const,
      source_id: null,
    })
    const fams = groupInboxFamilies([
      vial({
        uid: 'b1',
        parent_sample_id: 'P-0B',
        sample_id: 'P-0B-S01',
        priority_effective: eff('default', 0),
      }),
      vial({
        uid: 'a1',
        parent_sample_id: 'P-0A',
        sample_id: 'P-0A-S01',
        priority_effective: eff('high', 10),
      }),
      vial({
        uid: 'b2',
        parent_sample_id: 'P-0B',
        sample_id: 'P-0B-S02',
        vial_sequence: 2,
        priority_effective: eff('expedited', 20),
      }),
    ])
    // P-0B ranks 20 (its most urgent vial) and so sorts before P-0A (10).
    expect(fams.map(f => f.parentSampleId)).toEqual(['P-0B', 'P-0A'])
    expect(fams[0]!.vials).toHaveLength(2)
  })

  it('a below-default family sorts AFTER a default one and keeps its negative rank', () => {
    // An admin-created priority may rank BELOW the catalog default. Parent ids
    // are chosen so the alphabetical tie-break gives the OPPOSITE order — the
    // assertion can only pass if the negative rank survives (a Math.max(0, ...)
    // clamp makes both families rank 0 and yields ['P-0A', 'P-0B']).
    const low = {
      key: 'low',
      rank: -10,
      source_level: 'vial' as const,
      source_id: null,
    }
    const lowVials = [
      vial({
        uid: 'a1',
        parent_sample_id: 'P-0A',
        sample_id: 'P-0A-S01',
        priority_effective: low,
      }),
      vial({
        uid: 'a2',
        parent_sample_id: 'P-0A',
        sample_id: 'P-0A-S02',
        vial_sequence: 2,
        priority_effective: low,
      }),
    ]
    const defaultVials = [
      vial({
        uid: 'b1',
        parent_sample_id: 'P-0B',
        sample_id: 'P-0B-S01',
        priority_effective: {
          key: 'default',
          rank: 0,
          source_level: 'default' as const,
          source_id: null,
        },
      }),
    ]
    expect(familyPriorityRank(lowVials)).toBe(-10)
    const fams = groupInboxFamilies([...lowVials, ...defaultVials])
    expect(fams.map(f => f.parentSampleId)).toEqual(['P-0B', 'P-0A'])
  })

  it('equal-priority families sort by parent id', () => {
    const fams = groupInboxFamilies([
      vial({ uid: 'z', parent_sample_id: 'P-09' }),
      vial({ uid: 'a', parent_sample_id: 'P-01' }),
    ])
    expect(fams.map(f => f.parentSampleId)).toEqual(['P-01', 'P-09'])
  })
})

describe('familyDragItems', () => {
  it('builds one DragData per vial, identical to the single-vial drag shape', () => {
    const items = familyDragItems([vial({ uid: 'u9', sample_id: 'P-09-S01' })])
    expect(items).toEqual([
      {
        sampleUid: 'u9',
        sampleId: 'P-09-S01',
        // The inbox's `group_id` carries department identity as of S2 — the
        // payload names it for what it is, and consumers send it as
        // `department_id`.
        departmentId: 1,
        groupName: 'Analytics',
        dateReceived: '2026-06-10T12:00:00+00:00',
        analyses: [
          { title: 'Peptide Purity (HPLC)', keyword: 'HPLC-PUR', peptide_name: 'BPC-157', method: null },
        ],
      },
    ])
  })
})

describe('familyDateReceived', () => {
  it('returns the earliest date in the family', () => {
    const d = familyDateReceived([
      vial({ date_received: '2026-06-11T09:00:00+00:00' }),
      vial({ uid: 'u2', date_received: '2026-06-09T08:00:00+00:00' }),
      vial({ uid: 'u3', date_received: null }),
    ])
    expect(d).toBe('2026-06-09T08:00:00+00:00')
  })

  it('returns null when no vial has a date', () => {
    expect(familyDateReceived([vial({ date_received: null })])).toBeNull()
  })
})

describe('varianceParentIds', () => {
  it('collects parents whose aggregate flags variance subs', () => {
    const set = varianceParentIds({
      'P-01': { has_variance_subs: true },
      'P-02': { has_variance_subs: false },
      'P-03': { has_variance_subs: true },
    })
    expect(set.has('P-01')).toBe(true)
    expect(set.has('P-03')).toBe(true)
    expect(set.has('P-02')).toBe(false)
    expect(set.size).toBe(2)
  })

  it('treats a missing flag as no variance', () => {
    const set = varianceParentIds({ 'P-09': {} })
    expect(set.has('P-09')).toBe(false)
    expect(set.size).toBe(0)
  })

  it('returns an empty set for an empty map', () => {
    expect(varianceParentIds({}).size).toBe(0)
  })
})
