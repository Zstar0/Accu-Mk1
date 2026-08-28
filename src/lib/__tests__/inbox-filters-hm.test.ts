import { test, expect } from 'vitest'
import { itemBench, itemRoleBadges } from '@/lib/inbox-filters'

// Real itemRoleBadges signature is a single object arg
// ({ department_name, analyses }) — see inbox-filters.ts:44-61 — not the
// positional (bench, analyses) shape sketched in the task brief.

test('Heavy Metals department resolves to the hm bench', () => {
  expect(itemBench('Heavy Metals')).toBe('hm')
})

test('hm bench badges as hm', () => {
  expect(
    itemRoleBadges({ department_name: 'Heavy Metals', analyses: [] })
  ).toEqual(['hm'])
})

// Role-passthrough (2026-08-27, prod PB-0463-S04): under the
// hm-under-Analytical catalog state the item's department says Analytical,
// so the bench-derived badge said hplc. The vial's own assignment_role wins.

test('assignment_role wins over the department bench (hm under Analytical)', () => {
  expect(
    itemRoleBadges({
      department_name: 'Analytical',
      analyses: [],
      assignment_role: 'hm',
    })
  ).toEqual(['hm'])
})

test('role-less items (parent claims) keep the department bench', () => {
  expect(
    itemRoleBadges({
      department_name: 'Analytical',
      analyses: [],
      assignment_role: null,
    })
  ).toEqual(['hplc'])
})
