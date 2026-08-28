import { test, expect } from 'vitest'
import {
  buildInboxSlaSubjects,
  departmentToGroupId,
  inboxVialSlaKey,
  vialSlaDepartments,
} from '@/lib/inbox-sla'
import type { InboxVialItem, ServiceGroup } from '@/lib/api'

const group = (over: Partial<ServiceGroup>): ServiceGroup => ({
  id: 0,
  name: '',
  description: null,
  color: 'zinc',
  sort_order: 0,
  is_default: false,
  sla_tier_id: null,
  department_id: null,
  member_count: 0,
  member_ids: [],
  created_at: '',
  updated_at: '',
  ...over,
})

const vial = (over: Partial<InboxVialItem>): InboxVialItem =>
  ({
    uid: 'uid-1',
    sample_id: 'PB-0001-S01',
    is_parent: false,
    parent_sample_id: 'PB-0001',
    assignment_role: 'hplc',
    vial_sequence: 1,
    vial_total: 1,
    title: '',
    client_id: null,
    client_order_number: null,
    date_received: '2026-08-24T12:12:00Z',
    review_state: 'sample_received',
    priority: 'normal',
    assignment_summary: '',
    analyses: [],
    ...over,
  }) as InboxVialItem

const analysis = (group_id: number) =>
  ({
    uid: null,
    title: 'A',
    keyword: null,
    peptide_name: null,
    method: null,
    review_state: null,
    group_id,
    group_name: '',
    group_color: 'zinc',
  }) as InboxVialItem['analyses'][number]

test('departmentToGroupId: first group per department wins, null departments skipped', () => {
  const map = departmentToGroupId([
    group({ id: 1, name: 'Core HPLC', department_id: 1 }),
    group({ id: 2, name: 'Microbiology', department_id: 2 }),
    group({ id: 9, name: 'Endotoxin (legacy)', department_id: 2 }),
    group({ id: 5, name: 'No dept', department_id: null }),
  ])
  expect(map.get(1)).toBe(1)
  expect(map.get(2)).toBe(2) // not 9 — first in response order wins
  expect(map.size).toBe(2)
})

test('vialSlaDepartments: distinct, first-seen order, keeps the 0 legacy bucket', () => {
  const v = vial({
    analyses: [analysis(1), analysis(1), analysis(0), analysis(3)],
  })
  expect(vialSlaDepartments(v)).toEqual([1, 0, 3])
})

test('buildInboxSlaSubjects: one subject per (vial, department); unowned departments fall to null group', () => {
  const deptToGroup = new Map([
    [1, 1],
    [2, 2],
  ])
  const subjects = buildInboxSlaSubjects(
    [
      vial({
        uid: 'u1',
        priority: 'high',
        analyses: [analysis(1), analysis(2)],
      }),
      // hm-under-Analytical era: dept 3 owns no group -> default tier
      vial({ uid: 'u2', analyses: [analysis(3)] }),
    ],
    deptToGroup
  )
  expect(subjects).toEqual([
    {
      key: inboxVialSlaKey('u1', 1),
      priority: 'high',
      groupId: 1,
      receivedAt: '2026-08-24T12:12:00Z',
    },
    {
      key: inboxVialSlaKey('u1', 2),
      priority: 'high',
      groupId: 2,
      receivedAt: '2026-08-24T12:12:00Z',
    },
    {
      key: inboxVialSlaKey('u2', 3),
      priority: 'normal',
      groupId: null,
      receivedAt: '2026-08-24T12:12:00Z',
    },
  ])
})

test('buildInboxSlaSubjects: vials without a received date are skipped', () => {
  const subjects = buildInboxSlaSubjects(
    [vial({ uid: 'u3', date_received: null, analyses: [analysis(1)] })],
    new Map()
  )
  expect(subjects).toEqual([])
})
