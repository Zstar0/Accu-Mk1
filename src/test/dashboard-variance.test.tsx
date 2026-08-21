import { describe, it, expect } from 'vitest'
import {
  parentHasVariance,
  parentShowsVariance,
  subIsVarianceMember,
} from '@/components/senaite/SenaiteDashboard'
import { roleGlyph } from '@/lib/role-display'
import type { ParentAggregate, SubSample, VialRoleRow } from '@/lib/api'

function role(
  overrides: Partial<VialRoleRow> & Pick<VialRoleRow, 'code' | 'label'>
): VialRoleRow {
  return {
    id: overrides.code.length,
    department_id: null,
    boxable: false,
    variance_eligible: false,
    sort_order: 0,
    frozen: false,
    is_system: true,
    color: null,
    short_label: null,
    badge_glyph: null,
    ...overrides,
  }
}

// The catalog default: the legacy five roles plus an auto-minted role with
// no seeded short_label/badge_glyph faces (the usp71 idiom) — parity with
// role-display.test.tsx / role-badge.test.tsx.
const ROLES: VialRoleRow[] = [
  role({ code: 'hplc', label: 'HPLC', short_label: 'HPLC', badge_glyph: 'H' }),
  role({ code: 'endo', label: 'Endotoxin', short_label: 'ENDO', badge_glyph: 'E' }),
  role({ code: 'ster', label: 'Sterility', short_label: 'PCR', badge_glyph: 'P' }),
  role({ code: 'xtra', label: 'Extra', short_label: 'XTRA', badge_glyph: 'X' }),
  role({ code: 'hm', label: 'Heavy Metals', short_label: 'HM', badge_glyph: 'M' }),
  role({ code: 'usp71', label: 'USP <71> Sterility', short_label: null, badge_glyph: null }),
]

const agg = (
  variance?: ParentAggregate['variance'],
  has_variance_subs?: boolean,
): ParentAggregate =>
  ({ vial_count: 2, parent_role: 'hplc', variance, has_variance_subs }) as ParentAggregate

const sub = (
  role: SubSample['assignment_role'] | 'unassigned',
  kind: SubSample['assignment_kind'] = null,
): SubSample =>
  ({ id: 1, sample_id: 'P-1-S01', parent_sample_id: 'P-1', vial_sequence: 1,
     received_at: '', received_by_user_id: null, photo_external_uid: null,
     remarks: null, assignment_role: role, assignment_kind: kind }) as SubSample

describe('parentHasVariance (paid-replicates map: purchased n - 1)', () => {
  it('true when any bucket has a paid replicate', () => {
    expect(parentHasVariance(agg({ hplc: 1, endo: 0, ster: 0 }))).toBe(true)
    expect(parentHasVariance(agg({ hplc: 0, endo: 2, ster: 0 }))).toBe(true)
  })
  it('false for all-zero, undefined variance, or undefined agg', () => {
    expect(parentHasVariance(agg({ hplc: 0, endo: 0, ster: 0 }))).toBe(false)
    expect(parentHasVariance(agg(undefined))).toBe(false)
    expect(parentHasVariance(undefined)).toBe(false)
  })
})

describe('parentShowsVariance (entitlement OR assigned variance subs)', () => {
  it('true when the parent has variance entitlement (no assigned subs)', () => {
    expect(parentShowsVariance(agg({ hplc: 1, endo: 0, ster: 0 }, false))).toBe(true)
  })
  it('true when a variance sub is assigned (no entitlement override)', () => {
    expect(parentShowsVariance(agg({ hplc: 0, endo: 0, ster: 0 }, true))).toBe(true)
    expect(parentShowsVariance(agg(undefined, true))).toBe(true)
  })
  it('false when neither entitlement nor assigned variance subs', () => {
    expect(parentShowsVariance(agg({ hplc: 0, endo: 0, ster: 0 }, false))).toBe(false)
    expect(parentShowsVariance(agg(undefined, undefined))).toBe(false)
    expect(parentShowsVariance(undefined)).toBe(false)
  })
})

describe('roleGlyph — single-glyph convention over a seeded catalog (the "HM HM" fix)', () => {
  it('hm resolves to a single glyph (M), not the duplicated "HM" (spec 4, Task 10)', () => {
    expect(roleGlyph('hm', ROLES)).toBe('M')
  })

  it('every catalog role, including the auto-minted usp71, resolves to exactly one character', () => {
    for (const r of ROLES) {
      expect(roleGlyph(r.code, ROLES)).toHaveLength(1)
    }
  })
})

describe('subIsVarianceMember (kind-based)', () => {
  it('true when the sub is assigned to a variance bucket', () => {
    expect(subIsVarianceMember(sub('hplc', 'variance'))).toBe(true)
    expect(subIsVarianceMember(sub('endo', 'variance'))).toBe(true)
  })
  it('false for a core sub, kindless sub, or xtra', () => {
    expect(subIsVarianceMember(sub('hplc', 'core'))).toBe(false)
    expect(subIsVarianceMember(sub('hplc', null))).toBe(false)
    expect(subIsVarianceMember(sub('xtra', null))).toBe(false)
    expect(subIsVarianceMember(sub('unassigned'))).toBe(false)
    expect(subIsVarianceMember(sub(null))).toBe(false)
  })
})
