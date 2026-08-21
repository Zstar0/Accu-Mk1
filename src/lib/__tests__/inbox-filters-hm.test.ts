import { test, expect } from 'vitest'
import { itemBench, itemRoleBadges } from '@/lib/inbox-filters'

// Real itemRoleBadges signature is a single object arg
// ({ department_name, analyses }) — see inbox-filters.ts:44-61 — not the
// positional (bench, analyses) shape sketched in the task brief.

test('Heavy Metals department resolves to the hm bench', () => {
  expect(itemBench('Heavy Metals')).toBe('hm')
})

test('hm bench badges as hm', () => {
  expect(itemRoleBadges({ department_name: 'Heavy Metals', analyses: [] })).toEqual(['hm'])
})
