import { describe, it, expect } from 'vitest'
import { parentHasVariance, subIsVarianceMember } from '@/components/senaite/SenaiteDashboard'
import type { ParentAggregate, SubSample } from '@/lib/api'

const agg = (variance?: ParentAggregate['variance']): ParentAggregate =>
  ({ vial_count: 2, parent_role: 'hplc', variance }) as ParentAggregate

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
