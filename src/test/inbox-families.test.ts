import { describe, it, expect } from 'vitest'
import {
  groupInboxFamilies,
  familyDragItems,
  familyDateReceived,
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
    const fams = groupInboxFamilies([
      vial({ uid: 'a1', parent_sample_id: 'P-0A', sample_id: 'P-0A-S01', priority: 'normal' }),
      vial({ uid: 'b1', parent_sample_id: 'P-0B', sample_id: 'P-0B-S01', priority: 'high' }),
      vial({ uid: 'a2', parent_sample_id: 'P-0A', sample_id: 'P-0A-S02', vial_sequence: 2, priority: 'expedited' }),
    ])
    // P-0A ranks expedited (its best vial) and so sorts before P-0B (high)
    expect(fams.map(f => f.parentSampleId)).toEqual(['P-0A', 'P-0B'])
    expect(fams[0]!.vials).toHaveLength(2)
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
        groupId: 1,
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
