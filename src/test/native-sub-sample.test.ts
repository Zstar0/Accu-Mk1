import { describe, it, expect } from 'vitest'
import { buildNativeSubSampleLookup } from '@/lib/native-sub-sample'
import type { SubSample, ParentSampleSummary } from '@/lib/api'

const sub: SubSample = {
  id: 5,
  sample_id: 'P-0143-S02',
  parent_sample_id: 'P-0143',
  vial_sequence: 2,
  received_at: '2026-06-04T02:00:00',
  received_by_user_id: 1,
  photo_external_uid: 'mk1://photo.jpg',
  remarks: null,
  assignment_role: 'ster',
  external_lims_uid: 'mk1://1d6466957a6c40eb89c567a521ed9e56',
}

const parent: ParentSampleSummary = {
  sample_id: 'P-0143',
  external_lims_uid: 'parent-uid',
  peptide_name: 'BPC-157',
  status: 'sample_received',
  sub_sample_count: 3,
  last_synced_at: '2026-06-04T02:00:00',
  assignment_role: 'hplc',
  container_mode: false,
}

describe('buildNativeSubSampleLookup', () => {
  it('maps a native vial into a complete SenaiteLookupResult shape', () => {
    const r = buildNativeSubSampleLookup(sub, parent)
    expect(r.sample_id).toBe('P-0143-S02')
    expect(r.sample_uid).toBe('mk1://1d6466957a6c40eb89c567a521ed9e56')
    expect(r.date_received).toBe('2026-06-04T02:00:00')
    // SENAITE-only fields are blank (we never call SENAITE for a native vial)
    expect(r.client).toBeNull()
    expect(r.contact).toBeNull()
    expect(r.declared_weight_mg).toBeNull()
    // arrays must be present (the page maps over them)
    expect(r.analyses).toEqual([]) // filled by the Phase 3 Mk1 swap
    expect(r.analytes).toEqual([])
    expect(r.profiles).toEqual([])
    expect(r.attachments).toEqual([])
    expect(r.remarks).toEqual([])
    expect(r.published_coa).toBeNull()
    // coa is a non-nullable object — must be fully present
    expect(r.coa).toBeDefined()
    expect(r.coa.verification_code).toBeNull()
  })

  it('derives review_state from the vial own received_at, not the parent cache', () => {
    // A vial that exists with received_at was physically checked in — it is
    // received regardless of the parent's (possibly stale) cached status.
    // Container parents are stamped pre-received at lazy first-touch and the
    // cache is never refreshed, so borrowing parent.status shows "Due" on
    // vials that are sitting in the lab (PB-0077 bug).
    const staleParent = { ...parent, status: 'sample_due' }
    const r = buildNativeSubSampleLookup(sub, staleParent)
    expect(r.review_state).toBe('sample_received')
  })

  it('falls back to the parent status when the vial has no received_at', () => {
    // The SubSample type declares received_at non-nullable, but the runtime
    // guard stays defensive — cast to exercise the fallback branch.
    const unreceived = { ...sub, received_at: null } as unknown as SubSample
    const r = buildNativeSubSampleLookup(unreceived, { ...parent, status: 'sample_due' })
    expect(r.review_state).toBe('sample_due')
  })

  it('carries the parent status through as the vial review_state', () => {
    const r = buildNativeSubSampleLookup(sub, parent)
    expect(r.review_state).toBe('sample_received')
  })
})
