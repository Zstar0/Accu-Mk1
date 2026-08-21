/**
 * resolveAssignmentLabel (spec 4, Task 10): the sample-header "Assigned to"
 * label, catalog-driven. Was a hardcoded 4-case switch (hplc/endo/ster/xtra)
 * that fell through to `null` for hm — the SAME dead end as "no role at
 * all" — even though hm shipped as a catalog role in spec-3. Pure function,
 * unit-tested directly: SampleDetails() itself has no render-test harness in
 * this repo (it depends on ~6 nested queries), so a component render test
 * would be a disproportionate way to pin a display-string lookup.
 */
import { describe, it, expect } from 'vitest'
import { resolveAssignmentLabel } from '@/components/senaite/SampleDetails'
import type { Department, VialRoleRow } from '@/lib/api'

const DEPARTMENTS: Department[] = [
  { id: 1, name: 'Analytical', sort_order: 0, color: '#000', is_system: true, created_at: '', updated_at: '' },
  { id: 2, name: 'Microbiology', sort_order: 1, color: '#000', is_system: true, created_at: '', updated_at: '' },
  { id: 3, name: 'Heavy Metals', sort_order: 2, color: '#000', is_system: true, created_at: '', updated_at: '' },
]

const roleRow = (code: string, label: string, departmentId: number | null): VialRoleRow => ({
  id: 1, code, label, department_id: departmentId, boxable: true,
  variance_eligible: true, sort_order: 0, frozen: true, is_system: true,
})

const ROLES: VialRoleRow[] = [
  roleRow('hplc', 'HPLC', 1),
  roleRow('endo', 'Endotoxin', 2),
  roleRow('hm', 'Heavy Metals', 3),
  roleRow('xtra', 'Extras', null),
]

describe('resolveAssignmentLabel', () => {
  it('returns null when there is no current assignment', () => {
    expect(resolveAssignmentLabel(null, ROLES, DEPARTMENTS, false, false)).toBeNull()
  })

  it('returns null (not a flashed uppercased code) while the catalog is still loading', () => {
    expect(resolveAssignmentLabel('hplc', undefined, undefined, true, false)).toBeNull()
    expect(resolveAssignmentLabel('hplc', ROLES, undefined, false, true)).toBeNull()
  })

  it('hm resolves to a real "Assigned to" label — the invisibility bug this task fixes', () => {
    expect(resolveAssignmentLabel('hm', ROLES, DEPARTMENTS, false, false)).toBe('Heavy Metals — Heavy Metals')
  })

  it('formats department — role label, the deliberate em-dash display delta for hplc', () => {
    expect(resolveAssignmentLabel('hplc', ROLES, DEPARTMENTS, false, false)).toBe('Analytical — HPLC')
    expect(resolveAssignmentLabel('endo', ROLES, DEPARTMENTS, false, false)).toBe('Microbiology — Endotoxin')
  })

  it('falls back to "Extra" for a department-less role', () => {
    expect(resolveAssignmentLabel('xtra', ROLES, DEPARTMENTS, false, false)).toBe('Extra — Extras')
  })

  it('falls back to the uppercased code for a role the catalog no longer has, once loaded', () => {
    expect(resolveAssignmentLabel('zzghost', ROLES, DEPARTMENTS, false, false)).toBe('ZZGHOST')
  })
})
