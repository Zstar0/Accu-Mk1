import { describe, expect, it } from 'vitest'

import { fieldEditKey, hasParentIdentity } from '@/lib/parent-identity'

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

describe('fieldEditKey (inline field editor key)', () => {
  it('legacy parent posts its SENAITE uid', () => {
    expect(fieldEditKey({ sample_id: 'P-3097', sample_uid: 'abc123', external_lims_system: 'senaite' })).toBe('abc123')
  })

  it('native-born parent posts its sample_id in place of the uid (P-5178)', () => {
    expect(fieldEditKey({ sample_id: 'P-5178', sample_uid: null, external_lims_system: 'mk1' })).toBe('P-5178')
  })

  it('legacy parent without a uid, or no data, posts nothing', () => {
    expect(fieldEditKey({ sample_id: 'P-0001', sample_uid: null, external_lims_system: 'senaite' })).toBe('')
    expect(fieldEditKey(null)).toBe('')
  })
})
