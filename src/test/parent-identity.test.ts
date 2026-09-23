import { describe, expect, it } from 'vitest'

import { hasParentIdentity } from '@/lib/parent-identity'

describe('hasParentIdentity (Manage Sub-Samples gate)', () => {
  it('legacy parent with a SENAITE uid opens', () => {
    expect(hasParentIdentity({ sample_id: 'P-3097', sample_uid: 'abc123', external_lims_system: 'senaite' })).toBe(true)
  })

  it('native-born parent without a uid opens (P-5014)', () => {
    expect(hasParentIdentity({ sample_id: 'P-5014', sample_uid: null, external_lims_system: 'mk1' })).toBe(true)
  })

  it('legacy parent without a uid stays closed', () => {
    expect(hasParentIdentity({ sample_id: 'P-0001', sample_uid: null, external_lims_system: 'senaite' })).toBe(false)
  })

  it('no data or no sample id stays closed', () => {
    expect(hasParentIdentity(undefined)).toBe(false)
    expect(hasParentIdentity({ sample_id: '', sample_uid: 'x', external_lims_system: 'mk1' })).toBe(false)
  })
})
