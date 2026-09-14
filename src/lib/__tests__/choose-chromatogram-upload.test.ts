import { describe, it, expect } from 'vitest'
import { chooseChromatogramUpload } from '@/lib/api'

// Regression test for the dead-branch bug: native-born parents
// (external_lims_system === 'mk1') always have sample_uid === null, so a
// gate that checks sample_uid truthiness first never reaches the native
// upload path. chooseChromatogramUpload must check external_lims_system
// BEFORE falling back to sample_uid.
describe('chooseChromatogramUpload', () => {
  it('routes native-born data (sample_uid: null) to the native upload', () => {
    const target = chooseChromatogramUpload({
      external_lims_system: 'mk1',
      sample_uid: null,
    })
    expect(target).toEqual({ kind: 'native' })
  })

  it('routes SENAITE-born data (real sample_uid, no external_lims_system) to the SENAITE upload', () => {
    const target = chooseChromatogramUpload({
      external_lims_system: null,
      sample_uid: 'abc-uid',
    })
    expect(target).toEqual({ kind: 'senaite', sampleUid: 'abc-uid' })
  })

  it('returns null when neither a native flag nor a sample_uid is present', () => {
    const target = chooseChromatogramUpload({
      external_lims_system: null,
      sample_uid: null,
    })
    expect(target).toBeNull()
  })
})
